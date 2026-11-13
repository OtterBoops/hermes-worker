import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { run } from "../src/exec.js";
import {
  RUN_STATE_DIR,
  formatDispatchSentinel,
  readRunState,
  runLogPath,
  runStatePath,
  writeRunState,
} from "../src/run-registry.js";
import { renderTelemetryTable, readTokens, type Telemetry } from "../src/wait.js";
import {
  NOISY_RESULT_TOOLS,
  createStreamFormatter,
  formatStreamLine,
} from "../src/run-log.js";

const D = "\u00b7";

const baseTelemetry = (overrides: Partial<Telemetry> = {}): Telemetry => ({
  runId: "20261108234625-4u18",
  status: "SUCCESS",
  durationSeconds: "22.4",
  toolsCalled: 2,
  subagentsSpawned: 1,
  tokens: { input: 0, output: 0, cacheRead: 0, reasoning: 0, cacheWrite: 0, total: 0 },
  model: "",
  provider: "",
  modelFallback: false,
  costUsd: null,
  clinepass: null,
  agyQuota: null,
  ...overrides,
});

const toolUse = (id: string, name: string, input: unknown): string =>
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name, input }] },
  });

const toolResult = (id: string, content: string): string =>
  JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, content }] },
  });

test("the telemetry table is byte-exact for a fully populated record", () => {
  const table = renderTelemetryTable(
    baseTelemetry({
      tokens: { input: 111, output: 22, cacheRead: 7, reasoning: 0, cacheWrite: 3, total: 140 },
      model: "cline-pass/deepseek-v4.1-flash-1017",
      provider: "clinepass",
      costUsd: 0.000312,
      clinepass: `ok ${D} 7 requests ${D} last ok 18:38`,
      agyQuota: `gemini-weekly 16% @ 2026-11-14T10:12:32Z ${D} gemini-5h 70% @ 2026-11-13T19:14:19Z`,
    }),
  );

  assert.deepEqual(table, [
    "[Hermes Dispatch Telemetry] SUCCESS",
    "| field | value |",
    "| --- | --- |",
    "| run | 20261108234625-4u18 |",
    "| duration | 22.4s |",
    "| tools | 2 |",
    "| subagents | 1 |",
    "| model | cline-pass/deepseek-v4.1-flash-1017 (clinepass) |",
    `| tokens | input 111 ${D} output 22 ${D} cache_read 7 ${D} reasoning 0 ${D} total 140 |`,
    "| cost_usd | 0.000312 |",
    `| clinepass | ok ${D} 7 requests ${D} last ok 18:38 |`,
    `| agy_quota | gemini-weekly 16% @ 2026-11-14T10:12:32Z ${D} gemini-5h 70% @ 2026-11-13T19:14:19Z |`,
  ]);
});

test("a minimal record omits every optional row and keeps no legacy bullets", () => {
  const table = renderTelemetryTable(
    baseTelemetry({ runId: "run-min", durationSeconds: "0.0", toolsCalled: 0, subagentsSpawned: 0 }),
  );

  assert.deepEqual(table, [
    "[Hermes Dispatch Telemetry] SUCCESS",
    "| field | value |",
    "| --- | --- |",
    "| run | run-min |",
    "| duration | 0.0s |",
    "| tools | 0 |",
    "| subagents | 0 |",
    `| tokens | input 0 ${D} output 0 ${D} cache_read 0 ${D} reasoning 0 ${D} total 0 |`,
  ]);
  assert.equal(table.some((line) => line.startsWith("- ")), false, "no hyphen bullets remain");
  assert.equal(table.some((line) => /^=+$/.test(line)), false, "no rule separators remain");
  assert.equal(table.some((line) => /unavailable|n\/a/i.test(line)), false, "absent data prints no row");
});

test("FALLBACK and a half-known model still render one model row", () => {
  const table = renderTelemetryTable(baseTelemetry({ model: "m", modelFallback: true }));
  assert.ok(table.includes("| model | m (unknown) FALLBACK |"));
  assert.equal(table.filter((line) => line.startsWith("| model |")).length, 1);
});

test("a reported total wins and reasoning or cache_write never inflate it", () => {
  const reported = readTokens({ input: 10, output: 5, cache_read: 2, total: 999 });
  assert.equal(reported.total, 999);

  const derived = readTokens({
    input: 10,
    output: 5,
    cache_read: 2,
    reasoning_tokens: 4,
    cache_write_tokens: 3,
  });
  assert.equal(derived.total, 17, "total is input + output + cache_read, never the subsets");
  assert.equal(derived.reasoning, 4);
  assert.equal(derived.cacheWrite, 3);

  const table = renderTelemetryTable(
    baseTelemetry({
      tokens: { input: 10, output: 5, cacheRead: 2, reasoning: 4, cacheWrite: 3, total: 17 },
    }),
  );
  assert.ok(table.includes(`| tokens | input 10 ${D} output 5 ${D} cache_read 2 ${D} reasoning 4 ${D} total 17 |`));
});

test("a pipe and a newline in a value stay escaped on one row", () => {
  const table = renderTelemetryTable(baseTelemetry({ clinepass: "a | forged\n| row |" }));
  const clinepass = table.filter((line) => line.startsWith("| clinepass |"));
  assert.deepEqual(clinepass, ["| clinepass | a \\| forged \\| row \\| |"]);
  for (const line of table) {
    assert.equal(line.includes("\n"), false, "every rendered line is single-line");
  }
});

test("the header carries the FAILED status", () => {
  const table = renderTelemetryTable(baseTelemetry({ status: "FAILED" }));
  assert.equal(table[0], "[Hermes Dispatch Telemetry] FAILED");
});

test("the formatter drops a noisy result but keeps a tool with readable output", () => {
  const format = createStreamFormatter();

  assert.deepEqual(format(toolUse("t1", "read_file", { file_path: "src/a.ts" })), [
    "[Hermes:Tool] read_file (src/a.ts)",
  ]);
  assert.deepEqual(format(toolResult("t1", "export const a = 1;")), []);

  assert.deepEqual(format(toolUse("t2", "terminal", { command: "pnpm test" })), [
    "[Hermes:Tool] terminal (pnpm test)",
    "[Hermes:Exec] pnpm test",
  ]);
  assert.deepEqual(format(toolResult("t2", "67 passing")), ["[Hermes:Result] t2 -> 67 passing"]);
});

test("an uncorrelated result still renders, exactly as the legacy path would", () => {
  const format = createStreamFormatter();
  const line = toolResult("never-seen", "some output");
  assert.deepEqual(format(line), formatStreamLine(line));
  assert.deepEqual(format(line), ["[Hermes:Result] never-seen -> some output"]);
});

test("a repeated identical tool line collapses into nothing", () => {
  const format = createStreamFormatter();
  const read = toolUse("t1", "read_file", { file_path: "src/a.ts" });

  assert.deepEqual(format(read), ["[Hermes:Tool] read_file (src/a.ts)"]);
  assert.deepEqual(format(toolUse("t2", "read_file", { file_path: "src/a.ts" })), []);
  assert.deepEqual(format(toolUse("t3", "read_file", { file_path: "src/b.ts" })), [
    "[Hermes:Tool] read_file (src/b.ts)",
  ]);
});

test("the correlation map stays bounded, so the oldest id is simply unknown", () => {
  const format = createStreamFormatter();
  for (let index = 0; index < 300; index += 1) {
    format(toolUse(`id-${index}`, "read_file", { file_path: `file-${index}.ts` }));
  }

  assert.deepEqual(format(toolResult("id-0", "dropped from the map")), [
    "[Hermes:Result] id-0 -> dropped from the map",
  ]);
  assert.deepEqual(format(toolResult("id-299", "still correlated")), []);
});

test("NOISY_RESULT_TOOLS covers exploration and never the tools with readable output", () => {
  for (const name of ["read_file", "search_files", "grep", "web_extract", "skill_view", "todo_list"]) {
    assert.equal(NOISY_RESULT_TOOLS.has(name), true, `${name} should be lean`);
  }
  for (const name of ["terminal", "write_file", "patch", "delegate_task", "task"]) {
    assert.equal(NOISY_RESULT_TOOLS.has(name), false, `${name} output is worth reading`);
  }
});

test("the wait CLI renders the table, emits its sentinel and consumes the state", async (t) => {
  const runId = `test-table-${process.pid}-${Date.now().toString(36)}`;
  const statePath = runStatePath(runId);
  const logPath = runLogPath(runId);
  fs.mkdirSync(RUN_STATE_DIR, { recursive: true });
  t.after(() => {
    fs.rmSync(statePath, { force: true });
    fs.rmSync(logPath, { force: true });
  });

  await writeRunState({
    status: "completed",
    runId,
    sessionName: "s",
    worktreePath: "w",
    branch: "hermes/agy-telemetry",
    startedAt: Date.now() - 4_000,
    result: {
      success: true,
      runId,
      message: "done",
      durationMs: 4_000,
      model: "cline-pass/deepseek-v4.1-flash-1017",
      provider: "clinepass",
      toolEvents: [
        { type: "tool_use", name: "read_file" },
        { type: "tool_use", name: "delegate_task" },
      ],
      tokens: { input: 111, output: 22, cache_read: 7, total: 140 },
    },
  });

  const output = await run(process.execPath, ["--import", "tsx", "src/wait.ts", runId], {
    cwd: path.resolve(import.meta.dirname, ".."),
    timeoutMs: 30_000,
  });

  assert.equal(output.code, 0, output.stderr);
  const lines = output.stdout.split(/\r?\n/);
  assert.ok(lines.includes("[Hermes Dispatch Telemetry] SUCCESS"), output.stdout);
  assert.ok(lines.includes("| field | value |"));
  assert.ok(lines.includes("| --- | --- |"));
  assert.ok(lines.includes(`| run | ${runId} |`));
  assert.ok(lines.includes("| duration | 4.0s |"));
  assert.ok(lines.includes("| tools | 2 |"));
  assert.ok(lines.includes("| subagents | 1 |"));
  assert.ok(lines.includes("| model | cline-pass/deepseek-v4.1-flash-1017 (clinepass) |"));
  assert.ok(
    lines.includes(`| tokens | input 111 ${D} output 22 ${D} cache_read 7 ${D} reasoning 0 ${D} total 140 |`),
    output.stdout,
  );
  assert.equal(lines.some((line) => line.startsWith("- Run ID:")), false, "the legacy bullets are gone");
  assert.ok(output.stdout.includes(formatDispatchSentinel(runId)), "the sentinel must name the run");
  assert.equal(readRunState(runId), null, "the callback consumes the state file");
});
