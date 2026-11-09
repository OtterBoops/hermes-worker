#!/usr/bin/env node
import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import {
  RUN_ID_PATTERN,
  clearRunState,
  formatDispatchSentinel,
  formatFailedSentinel,
  readRunState,
  runLogPath,
  type RunState,
} from "./run-registry.js";

const POLL_MS = 500;
const MAX_WAIT_MS = 2 * 60 * 60 * 1000;
const RULE = "=".repeat(60);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Live tail of the run log. Position is tracked in bytes and decoded through a StringDecoder so a
 * read boundary that lands mid-codepoint emits nothing rather than half a character.
 */
class LogTail {
  private offset = 0;
  private readonly decoder = new StringDecoder("utf8");
  private handle: number | null = null;

  constructor(private readonly file: string) {}

  /** Writes whatever is new to `out`; a missing log is simply nothing to tail yet. */
  pump(out: NodeJS.WriteStream): void {
    let size: number;
    try {
      if (this.handle === null) {
        if (!fs.existsSync(this.file)) return;
        this.handle = fs.openSync(this.file, "r");
      }
      size = fs.fstatSync(this.handle).size;
    } catch {
      return;
    }
    if (size <= this.offset) return;

    const chunk = Buffer.alloc(size - this.offset);
    let read = 0;
    try {
      read = fs.readSync(this.handle, chunk, 0, chunk.length, this.offset);
    } catch {
      return;
    }
    this.offset += read;
    const text = this.decoder.write(chunk.subarray(0, read));
    if (text) out.write(text);
  }

  close(): void {
    const trailing = this.decoder.end();
    if (trailing) process.stdout.write(trailing);
    if (this.handle !== null) {
      try {
        fs.closeSync(this.handle);
      } catch {
        // already gone
      }
      this.handle = null;
    }
  }
}

interface Telemetry {
  runId: string;
  status: "SUCCESS" | "FAILED";
  durationSeconds: string;
  toolsCalled: number;
  subagentsSpawned: number;
  tokens: { total: number; input: number; output: number; cacheRead: number };
}

const asNumber = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const firstNumber = (record: Record<string, unknown>, keys: string[]): number => {
  for (const key of keys) {
    const value = asNumber(record[key]);
    if (value !== 0) return value;
  }
  return 0;
};

/** Read across the token vocabularies in use: Anthropic-style and OpenAI-style usage records. */
const readTokens = (raw: unknown): Telemetry["tokens"] => {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const input = firstNumber(record, ["input_tokens", "prompt_tokens"]);
  const output = firstNumber(record, ["output_tokens", "completion_tokens"]);
  const cacheRead = firstNumber(record, [
    "cache_read_input_tokens",
    "cache_read_tokens",
    "cached_tokens",
    "prompt_cache_hit_tokens",
  ]);
  const total = firstNumber(record, ["total_tokens"]) || input + output + cacheRead;
  return { total, input, output, cacheRead };
};

interface ResultShape {
  success?: unknown;
  timedOut?: unknown;
  durationMs?: unknown;
  toolEvents?: unknown;
  tokens?: unknown;
}

const countToolCalls = (events: unknown, name: string | null): number =>
  Array.isArray(events)
    ? events.filter((event) => {
        if (!event || typeof event !== "object") return false;
        const record = event as { type?: unknown; name?: unknown };
        if (record.type !== "tool_use") return false;
        return name === null || record.name === name;
      }).length
    : 0;

const buildTelemetry = (runId: string, state: RunState | null): Telemetry => {
  const result = (state?.result ?? null) as ResultShape | null;
  const success = result?.success === true && result?.timedOut !== true;
  const durationMs = asNumber(result?.durationMs) || Math.max(0, Date.now() - asNumber(state?.startedAt));
  return {
    runId,
    status: success ? "SUCCESS" : "FAILED",
    durationSeconds: (durationMs / 1000).toFixed(1),
    toolsCalled: countToolCalls(result?.toolEvents, null),
    subagentsSpawned: countToolCalls(result?.toolEvents, "delegate_task"),
    tokens: readTokens(result?.tokens),
  };
};

/** The rule-delimited block a caller parses; the sentinel lines below it are the terminator. */
const emitTelemetry = (telemetry: Telemetry): void => {
  const { tokens } = telemetry;
  process.stdout.write(
    `${[
      RULE,
      `[Hermes Dispatch Telemetry] (Status: ${telemetry.status})`,
      `- Run ID: ${telemetry.runId}`,
      `- Duration: ${telemetry.durationSeconds}s`,
      `- Tools Called: ${telemetry.toolsCalled}`,
      `- Subagents Spawned: ${telemetry.subagentsSpawned}`,
      `- Tokens Used: ${tokens.total} (input: ${tokens.input}, output: ${tokens.output}, cache: ${tokens.cacheRead})`,
      RULE,
    ].join("\n")}\n`,
  );
};

/** A crashed runner leaves no state file at all: that is a failure, not a reason to hang. */
const finish = async (runId: string, state: RunState): Promise<void> => {
  const result = state.result as { success?: unknown } | null | undefined;
  const telemetry = buildTelemetry(runId, state);
  emitTelemetry(telemetry);
  // Exactly one sentinel, and its kind is the verdict: a caller parses the line rather than
  // re-deriving success from the JSON that follows it.
  process.stdout.write(
    telemetry.status === "SUCCESS" ? `${formatDispatchSentinel(runId)}\n` : `${formatFailedSentinel(runId)}\n`,
  );
  process.stdout.write(`${JSON.stringify(state.result ?? null, null, 2)}\n`);

  // Awaited, not fire-and-forget: the process exits as soon as this returns, and a pending rm
  // would leave the log and the state file behind.
  await clearRunState(runId).catch(() => undefined);
  process.exitCode = result?.success === true ? 0 : 1;
};

/** Callback half of a dispatch: tail the run live, then report it behind a sentinel. */
const main = async (): Promise<void> => {
  const runId = process.argv[2] ?? "";
  if (!RUN_ID_PATTERN.test(runId)) {
    process.stderr.write(
      `wait: invalid run id '${runId}'. Expected the runId reported by hermes_dispatch ([A-Za-z0-9_-]).\n`,
    );
    process.exit(1);
  }

  process.stdout.write(`[Hermes Worker] Tailing run ${runId}...\n`);

  const tail = new LogTail(runLogPath(runId));
  const deadline = Date.now() + MAX_WAIT_MS;

  for (;;) {
    const state = readRunState(runId);
    tail.pump(process.stdout);

    if (state?.status === "completed") {
      // The dispatch closes the stream before publishing, so one final drain has everything.
      tail.close();
      await finish(runId, state);
      return;
    }

    if (Date.now() > deadline) {
      tail.close();
      emitTelemetry(buildTelemetry(runId, state));
      process.stdout.write(`${formatFailedSentinel(runId)}\n`);
      process.stderr.write(
        `wait: run '${runId}' was still running after 2h. The runner may have died; check the worktree.\n`,
      );
      process.exitCode = 1;
      return;
    }

    await sleep(POLL_MS);
  }
};

/**
 * The last line of defence: whatever goes wrong, a caller tailing this process still gets a
 * sentinel instead of waiting out its own timeout.
 */
main().catch((error: unknown) => {
  const runId = process.argv[2] ?? "";
  process.stderr.write(`wait: ${error instanceof Error ? error.message : String(error)}\n`);
  if (RUN_ID_PATTERN.test(runId)) {
    emitTelemetry(buildTelemetry(runId, null));
    process.stdout.write(`${formatFailedSentinel(runId)}\n`);
  }
  process.exit(1);
});
