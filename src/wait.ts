#!/usr/bin/env node
import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import {
  RUN_ID_PATTERN,
  clearRunState,
  formatDispatchSentinel,
  formatFailedSentinel,
  isRunAbandoned,
  readRunState,
  runLogPath,
  runStatePath,
  type RunState,
} from "./run-registry.js";

const POLL_MS = 500;
const MAX_WAIT_MS = 2 * 60 * 60 * 1000;
/** A pending-write queue is a work backlog, not a report: cap the listing so the answer stays scannable. */
const MAX_PENDING_LINES = 10;
/** U+00B7 between token segments: the row stays one line so a caller can parse it as one field. */
const DOT = "\u00b7";
const PROBE_TIMEOUT_MS = 600;
/** Hard ceiling on the quota wait: the report is the product, the pool is decoration. */
const PROBE_BUDGET_MS = 700;
/** The dispatcher publishes the record before it hands out waitCommand, so an absent one is a dead run. */
const MISSING_RECORD_GRACE_MS = 3_000;

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

export interface Telemetry {
  runId: string;
  status: "SUCCESS" | "FAILED";
  /** Null when nothing recorded a start: an absent duration omits the row rather than inventing one. */
  durationSeconds: string | null;
  toolsCalled: number;
  subagentsSpawned: number;
  tokens: {
    total: number;
    input: number;
    output: number;
    cacheRead: number;
    reasoning: number;
    cacheWrite: number;
  };
  model: string;
  provider: string;
  modelFallback: boolean;
  costUsd: number | null;
  /** Pre-formatted by the probe module: the table never re-derives their wording. */
  opencode: string | null;
  agyQuota: string | null;
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

/**
 * Read across the token vocabularies in use: Hermes' bare keys, Anthropic-style and OpenAI-style.
 * `reasoning` is a subset of `output` and `cacheWrite` is billed input, so neither may be folded
 * into `total`: they are the same tokens counted a second time.
 */
export const readTokens = (raw: unknown): Telemetry["tokens"] => {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const input = firstNumber(record, ["input", "input_tokens", "prompt_tokens"]);
  const output = firstNumber(record, ["output", "output_tokens", "completion_tokens"]);
  const cacheRead = firstNumber(record, [
    "cache_read",
    "cache_read_input_tokens",
    "cache_read_tokens",
    "cached_tokens",
    "prompt_cache_hit_tokens",
  ]);
  const reasoning = firstNumber(record, ["reasoning_tokens", "reasoning"]);
  const cacheWrite = firstNumber(record, [
    "cache_write_tokens",
    "cache_write",
    "cache_creation_input_tokens",
  ]);
  // A reported total outranks the parts, and only its absence makes the sum the best evidence.
  const total = firstNumber(record, ["total", "total_tokens"]) || input + output + cacheRead;
  return { total, input, output, cacheRead, reasoning, cacheWrite };
};

interface ResultShape {
  success?: unknown;
  timedOut?: unknown;
  durationMs?: unknown;
  toolEvents?: unknown;
  tokens?: unknown;
  message?: unknown;
  summary?: unknown;
  model?: unknown;
  provider?: unknown;
  modelFallback?: unknown;
  estimatedCostUsd?: unknown;
  estimated_cost_usd?: unknown;
  costUsd?: unknown;
  warning?: unknown;
  modifiedFiles?: unknown;
  pendingWrites?: unknown;
}

/** Detail lines are single-line by contract: a newline inside a value would forge extra report lines. */
const asText = (value: unknown): string =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";

/** A pipe inside a value would split one table row into two, so it is escaped instead of flattened. */
const asCell = (value: unknown): string => asText(value).replace(/\|/g, "\\|");

const clipText = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}...`;

const countToolCalls = (events: unknown, name: string | null): number =>
  Array.isArray(events)
    ? events.filter((event) => {
        if (!event || typeof event !== "object") return false;
        const record = event as { type?: unknown; name?: unknown };
        if (record.type !== "tool_use") return false;
        return name === null || record.name === name;
      }).length
    : 0;

/** A negative or non-finite cost is not a price, and printing one would be a fabricated number. */
const asCost = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

const readCost = (result: ResultShape | null): number | null => {
  const tokens =
    result?.tokens && typeof result.tokens === "object"
      ? (result.tokens as Record<string, unknown>)
      : {};
  return (
    asCost(tokens.estimated_cost_usd) ??
    asCost(result?.estimatedCostUsd) ??
    asCost(result?.estimated_cost_usd) ??
    // The dispatch hoists the ledger's cost off `tokens` into a typed field; both spellings report.
    asCost(result?.costUsd)
  );
};

const formatCost = (cost: number): string => {
  const fixed = cost.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  // A real price under the sixth decimal must not round into a fabricated free run.
  return fixed === "0" && cost > 0 ? cost.toExponential() : fixed;
};

/**
 * An absent timing is no measurement: Date.now() - 0 would report 1.7 billion seconds as fact.
 */
const readDurationMs = (result: ResultShape | null, state: RunState | null): number | null => {
  const reported = result?.durationMs;
  if (typeof reported === "number" && Number.isFinite(reported) && reported >= 0) return reported;
  const startedAt = asNumber(state?.startedAt);
  return startedAt > 0 ? Math.max(0, Date.now() - startedAt) : null;
};

const buildTelemetry = (runId: string, state: RunState | null): Telemetry => {
  const result = (state?.result ?? null) as ResultShape | null;
  const success = result?.success === true && result?.timedOut !== true;
  const durationMs = readDurationMs(result, state);
  return {
    runId,
    status: success ? "SUCCESS" : "FAILED",
    durationSeconds: durationMs === null ? null : (durationMs / 1000).toFixed(1),
    toolsCalled: countToolCalls(result?.toolEvents, null),
    subagentsSpawned: countToolCalls(result?.toolEvents, "delegate_task"),
    tokens: readTokens(result?.tokens),
    model: asText(result?.model),
    provider: asText(result?.provider),
    modelFallback: result?.modelFallback === true,
    costUsd: readCost(result),
    opencode: null,
    agyQuota: null,
  };
};

/**
 * The table is the entire report body, so every row is written here and nowhere else: a caller
 * parses these lines field by field and a second writer would drift out of step.
 */
export const renderTelemetryTable = (telemetry: Telemetry): string[] => {
  const row = (field: string, value: string): string => `| ${field} | ${asCell(value)} |`;
  const { tokens } = telemetry;
  const lines = [
    `[Hermes Dispatch Telemetry] ${telemetry.status}`,
    "| field | value |",
    "| --- | --- |",
    row("run", telemetry.runId),
  ];

  if (telemetry.durationSeconds !== null) {
    lines.push(row("duration", `${telemetry.durationSeconds}s`));
  }

  lines.push(
    row("tools", String(telemetry.toolsCalled)),
    row("subagents", String(telemetry.subagentsSpawned)),
  );

  const model = asText(telemetry.model);
  const provider = asText(telemetry.provider);
  if (model || provider) {
    const fallback = telemetry.modelFallback ? " FALLBACK" : "";
    lines.push(row("model", `${model || "unknown"} (${provider || "unknown"})${fallback}`));
  }

  lines.push(
    row(
      "tokens",
      [
        `input ${tokens.input}`,
        `output ${tokens.output}`,
        `cache_read ${tokens.cacheRead}`,
        `reasoning ${tokens.reasoning}`,
        `total ${tokens.total}`,
      ].join(` ${DOT} `),
    ),
  );

  const cost = asCost(telemetry.costUsd);
  if (cost !== null) lines.push(row("cost_usd", formatCost(cost)));

  // An absent probe value omits its row: "unavailable" reads as a measurement and is not one.
  const opencode = asText(telemetry.opencode);
  if (opencode) lines.push(row("opencode", opencode));

  const agyQuota = asText(telemetry.agyQuota);
  if (agyQuota) lines.push(row("agy_quota", agyQuota));

  return lines;
};

const writeTelemetry = (telemetry: Telemetry): void => {
  // The blank line separates the table from the sentinel a caller parses next.
  process.stdout.write(`${renderTelemetryTable(telemetry).join("\n")}\n\n`);
};

interface QuotaCells {
  opencode: string | null;
  agyQuota: string | null;
}

/** Only the members this file calls: a probe module with extra or renamed helpers still reports. */
interface QuotaProbeModule {
  readProviderPool?: (provider: string, options?: { timeoutMs?: number }) => unknown;
  probeOpenCodeQuota?: (options?: { timeoutMs?: number }) => unknown;
  probeAntigravityQuota?: (options?: { timeoutMs?: number }) => unknown;
  formatProviderPool?: (pool: unknown) => unknown;
  formatOpenCodeQuota?: (quota: unknown) => unknown;
  formatQuota?: (quota: unknown) => unknown;
}

const formatCell = (
  format: ((value: unknown) => unknown) | undefined,
  value: unknown,
): string | null => {
  if (typeof format !== "function") return null;
  try {
    const text = format(value);
    return typeof text === "string" && text.trim() !== "" ? text.trim() : null;
  } catch {
    return null;
  }
};

/**
 * Quota is decoration on the report, so a missing, broken or hanging probe module must read as no
 * data: the specifier is dynamic and every failure settles into the same empty shape.
 */
const readQuotaCells = async (): Promise<QuotaCells> => {
  const empty = (): QuotaCells => ({ opencode: null, agyQuota: null });
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<QuotaCells>((resolve) => {
    timer = setTimeout(() => resolve(empty()), PROBE_BUDGET_MS);
    timer.unref();
  });

  const work = (async (): Promise<QuotaCells> => {
    const specifier = "./quota-probe.js";
    const probe = (await import(specifier)) as QuotaProbeModule;
    const [pool, quota, opencode] = await Promise.allSettled([
      Promise.resolve(probe.readProviderPool?.("opencode-go")),
      Promise.resolve(probe.probeAntigravityQuota?.({ timeoutMs: PROBE_TIMEOUT_MS })),
      Promise.resolve(probe.probeOpenCodeQuota?.({ timeoutMs: PROBE_TIMEOUT_MS })),
    ]);
    // The live window beats the local pool file: a stale credential row says nothing about
    // how much allowance is actually left, so the HTTP probe is preferred when it answers.
    const opencodeCell =
      opencode.status === "fulfilled" ? formatCell(probe.formatOpenCodeQuota, opencode.value) : null;
    return {
      opencode:
        opencodeCell ?? (pool.status === "fulfilled" ? formatCell(probe.formatProviderPool, pool.value) : null),
      agyQuota: quota.status === "fulfilled" ? formatCell(probe.formatQuota, quota.value) : null,
    };
  })().catch(empty);

  const cells = await Promise.race([work, budget]);
  if (timer !== undefined) clearTimeout(timer);
  return cells;
};

/** Probing lives on this path rather than at each call site, so every exit renders the same rows. */
const emitTelemetry = async (telemetry: Telemetry): Promise<void> => {
  const cells = await readQuotaCells().catch(
    (): QuotaCells => ({ opencode: null, agyQuota: null }),
  );
  writeTelemetry({ ...telemetry, ...cells });
};

/**
 * The detail block is optional by construction: a result with no warning, no files and no pending
 * writes must print nothing at all, because an empty header reads as a real, empty answer.
 */
const buildDetailBlock = (result: ResultShape | null | undefined): string[] => {
  const lines: string[] = [];

  const warning = asText(result?.warning);
  if (warning) lines.push(`- Warning: ${clipText(warning, 500)}`);

  const files = Array.isArray(result?.modifiedFiles)
    ? result.modifiedFiles.map(asText).filter((name) => name !== "")
    : [];
  if (files.length > 0) {
    // The count stays exact while the list is clipped: a giant change set must not flood the stream.
    lines.push(`- Files Changed: ${files.length} (${clipText(files.join(", "), 400)})`);
  }

  const writes = Array.isArray(result?.pendingWrites) ? result.pendingWrites : [];
  if (writes.length > 0) {
    lines.push(`- Pending Writes: ${writes.length}`);
    for (const entry of writes.slice(0, MAX_PENDING_LINES)) {
      const record = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
      const id = asText(record.id) || "?";
      const subsystem = asText(record.subsystem);
      const action = asText(record.action);
      const summary = asText(record.summary);
      const head = subsystem ? `${id} (${subsystem})` : id;
      const tail = [action, summary].filter((part) => part !== "").join(" -> ");
      lines.push(`  - ${clipText(tail ? `${head}: ${tail}` : head, 300)}`);
    }
    if (writes.length > MAX_PENDING_LINES) {
      lines.push(`  - ... ${writes.length - MAX_PENDING_LINES} more`);
    }
  }

  return lines.length > 0 ? ["", "[Hermes Result Detail]", ...lines] : [];
};

/** A crashed runner leaves no state file at all: that is a failure, not a reason to hang. */
const finish = async (runId: string, state: RunState): Promise<void> => {
  const result = state.result as ResultShape | null | undefined;
  const telemetry = buildTelemetry(runId, state);
  await emitTelemetry(telemetry);
  // Exactly one sentinel, and its kind is the verdict: a caller parses the line rather than
  // re-deriving success from a large JSON payload.
  process.stdout.write(
    telemetry.status === "SUCCESS" ? `${formatDispatchSentinel(runId)}\n` : `${formatFailedSentinel(runId)}\n`,
  );
  // The summary is what the run actually said; the message is only the dispatch's verdict on it.
  if (typeof result?.summary === "string" && result.summary.trim()) {
    process.stdout.write(`\n[Hermes Summary]\n${result.summary.trim()}\n`);
  }
  const detail = buildDetailBlock(result);
  if (detail.length > 0) process.stdout.write(`${detail.join("\n")}\n`);
  if (typeof result?.message === "string" && result.message.trim()) {
    process.stdout.write(`${result.message.trim()}\n`);
  }

  // Awaited, not fire-and-forget: the process exits as soon as this returns, and a pending rm
  // would leave the log and the state file behind.
  await clearRunState(runId).catch(() => undefined);
  // Derived from the same verdict the sentinel carries: two derivations let the exit code contradict it.
  process.exitCode = telemetry.status === "SUCCESS" ? 0 : 1;
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
  let missingSince: number | null = null;

  for (;;) {
    const state = readRunState(runId);
    tail.pump(process.stdout);

    if (state?.status === "completed") {
      // The dispatch closes the stream before publishing, so one final drain has everything.
      tail.close();
      await finish(runId, state);
      return;
    }

    if (!state) {
      missingSince ??= Date.now();
      // A record is published before waitCommand exists, so a missing one is a dead run, not a slow one.
      if (Date.now() - missingSince > MISSING_RECORD_GRACE_MS) {
        tail.close();
        await emitTelemetry(buildTelemetry(runId, null));
        process.stdout.write(`${formatFailedSentinel(runId)}\n`);
        process.stderr.write(
          `wait: no run record for '${runId}' (${runStatePath(runId)}). The dispatcher writes it before the wait command is handed out, so the run id is wrong or the run never started.\n`,
        );
        process.exitCode = 1;
        return;
      }
    } else {
      missingSince = null;
    }

    // A dead worker is an immediate verdict: waiting out the deadline for a process that can never
    // publish a result hangs the caller for two hours on a run that is already over.
    if (state && isRunAbandoned(state)) {
      tail.close();
      await emitTelemetry(buildTelemetry(runId, state));
      process.stdout.write(`${formatFailedSentinel(runId)}\n`);
      // The record still names the worktree holding the work, so it is deliberately not cleared.
      process.stderr.write(
        `wait: run '${runId}' was abandoned by dead worker pid ${state.workerPid}; check the worktree and the run log.\n`,
      );
      process.exitCode = 1;
      return;
    }

    if (Date.now() > deadline) {
      tail.close();
      await emitTelemetry(buildTelemetry(runId, state));
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
 * sentinel instead of waiting out its own timeout. No probe here, because a crash path must not wait.
 */
const crash = (error: unknown): void => {
  const runId = process.argv[2] ?? "";
  process.stderr.write(`wait: ${error instanceof Error ? error.message : String(error)}\n`);
  if (RUN_ID_PATTERN.test(runId)) {
    writeTelemetry(buildTelemetry(runId, null));
    process.stdout.write(`${formatFailedSentinel(runId)}\n`);
  }
  process.exit(1);
};

/** An imported module must not tail a run: the CLI contract is that invoking this file is the trigger. */
const invokedDirectly = (): boolean => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (invokedDirectly()) main().catch(crash);
