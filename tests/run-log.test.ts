import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createStreamFormatter,
  createSubagentFormatter,
  formatStreamEvent,
  formatStreamLine,
  openRunLog,
  shortSubagentId,
} from "../src/run-log.js";
import type { SubagentActivity, SubagentChildActivity } from "../src/python-bridge.js";

const tmpDir = (prefix: string): string => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const toolUse = (id: string, name: string, input: Record<string, unknown>): string =>
  JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
  });

const toolResult = (id: string, content: string): string =>
  JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] },
  });

test("a noisy result does not swallow the next identical tool line", () => {
  const format = createStreamFormatter();

  assert.deepEqual(format(toolUse("t1", "read_file", { file_path: "src/a.ts" })), [
    "[Hermes:Tool] read_file (src/a.ts)",
  ]);
  assert.deepEqual(format(toolResult("t1", "export const a = 1;")), [], "read_file output is suppressed");

  // The same file read again in a later turn is a real second event, not a duplicate line.
  assert.deepEqual(
    format(toolUse("t2", "read_file", { file_path: "src/a.ts" })),
    ["[Hermes:Tool] read_file (src/a.ts)"],
    "a read that follows a suppressed result must still be reported",
  );
});

test("two identical tool lines with nothing between them are still collapsed", () => {
  const format = createStreamFormatter();

  assert.deepEqual(format(toolUse("t1", "read_file", { file_path: "src/a.ts" })), [
    "[Hermes:Tool] read_file (src/a.ts)",
  ]);
  assert.deepEqual(format(toolUse("t1", "read_file", { file_path: "src/a.ts" })), []);
  assert.deepEqual(format(toolUse("t1", "read_file", { file_path: "src/a.ts" })), []);
});

test("a suppressed result keeps the lines around it intact", () => {
  const format = createStreamFormatter();

  format(toolUse("t1", "read_file", { file_path: "src/a.ts" }));
  // One event carrying both the (noisy) result and the next tool call: the index math must not
  // shift the tool line onto the suppressed slot.
  const mixed = JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: "file body" },
        { type: "tool_use", id: "t2", name: "search_files", input: { pattern: "widget" } },
      ],
    },
  });
  assert.deepEqual(format(mixed), ["[Hermes:Tool] search_files (widget)"]);
});

test("the formatter renders a result whose tool it never saw", () => {
  const format = createStreamFormatter();
  assert.deepEqual(format(toolResult("unknown-id", "some output")), [
    "[Hermes:Result] unknown-id -> some output",
  ]);
});

test("an exec tool gets its own command line", () => {
  const format = createStreamFormatter();
  assert.deepEqual(format(toolUse("t1", "terminal", { command: "pnpm run test" })), [
    "[Hermes:Tool] terminal (pnpm run test)",
    "[Hermes:Exec] pnpm run test",
  ]);
});

test("nested tool blocks survive the walk and non-JSON lines are kept", () => {
  const lines = formatStreamEvent({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Looking at the worker." },
        { type: "tool_use", id: "t9", name: "read_file", input: { file_path: "src/run-log.ts" } },
      ],
    },
  });
  assert.deepEqual(lines, [
    "[Hermes:Step] Looking at the worker.",
    "[Hermes:Tool] read_file (src/run-log.ts)",
  ]);

  assert.deepEqual(formatStreamLine("ImportError: no module named x"), [
    "[Hermes:Output] ImportError: no module named x",
  ]);
  assert.deepEqual(formatStreamLine("{ truncated json"), ["[Hermes:Output] { truncated json"]);
  assert.deepEqual(formatStreamLine("   "), []);
});

test("openRunLog writes every line and close is idempotent", async () => {
  const dir = tmpDir("hermes-runlog-");
  const logPath = path.join(dir, "nested", "run.log");
  const log = openRunLog(logPath);

  log.write(["[Hermes:Tool] read_file (src/a.ts)"]);
  log.write(["[Hermes:Step] done", "[Hermes:Result] t1 -> ok"]);
  await Promise.all([log.close(), log.close()]);

  const written = fs.readFileSync(logPath, "utf8");
  assert.equal(
    written,
    "[Hermes:Tool] read_file (src/a.ts)\n[Hermes:Step] done\n[Hermes:Result] t1 -> ok\n",
  );

  log.write(["[Hermes:Step] after close"]);
  assert.equal(fs.readFileSync(logPath, "utf8"), written, "a write after close is dropped");
  await log.close();

  fs.rmSync(dir, { recursive: true, force: true });
});

test("close resolves even when the log stream failed to open", async () => {
  const dir = tmpDir("hermes-runlog-fail-");
  const log = openRunLog(dir); // a directory cannot be opened for writing

  log.write(["[Hermes:Step] discarded"]);
  let timer: NodeJS.Timeout | undefined;
  const hung = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve("hung"), 2_000);
  });
  const settled = await Promise.race([log.close().then(() => "closed"), hung]);
  if (timer) clearTimeout(timer);

  assert.equal(settled, "closed", "an errored stream must not hang the dispatch");
  fs.rmSync(dir, { recursive: true, force: true });
});

const childActivity = (id: string, over: Partial<SubagentChildActivity> = {}): SubagentChildActivity => ({
  id,
  title: `Subagent: work for ${id}`,
  startedAt: 1,
  done: false,
  endReason: null,
  messageCount: 0,
  toolCallCount: 0,
  ...over,
});

const subagentActivity = (over: Partial<SubagentActivity> = {}): SubagentActivity => ({
  parentSessionId: "parent-1",
  baseline: false,
  cursor: 1,
  children: [],
  messages: [],
  ...over,
});

test("the first poll announces the children it finds, once", () => {
  const format = createSubagentFormatter();
  const children = [
    childActivity("20260101_120000_bbbbbb"),
    childActivity("20260101_120000_aaaaaa"),
  ];

  const first = format(subagentActivity({ baseline: true, children }));
  assert.deepEqual(first.lines, [
    "[Hermes:Subagent:aaaaaa] started: work for 20260101_120000_aaaaaa",
    "[Hermes:Subagent:bbbbbb] started: work for 20260101_120000_bbbbbb",
  ]);

  // Every poll repeats the whole child list, so a start is news exactly once.
  const second = format(subagentActivity({ baseline: true, children }));
  assert.deepEqual(second, { lines: [], active: false });
});

test("subagent starts, tool calls and steps are rendered oldest first", () => {
  const format = createSubagentFormatter();

  const batch = format(
    subagentActivity({
      children: [
        childActivity("20260101_120000_bbbbbb", { title: "Subagent: write the docs" }),
        childActivity("20260101_120000_aaaaaa", { title: "Subagent: audit the parser" }),
      ],
      messages: [
        { id: 1, sessionId: "20260101_120000_aaaaaa", role: "tool", toolName: "read_file", preview: "1|export" },
        { id: 2, sessionId: "20260101_120000_aaaaaa", role: "assistant", toolName: null, preview: "Found two\ncandidates." },
        { id: 3, sessionId: "20260101_120000_bbbbbb", role: "user", toolName: null, preview: "ignored" },
      ],
    }),
  );

  assert.deepEqual(batch.lines, [
    "[Hermes:Subagent:aaaaaa] started: audit the parser",
    "[Hermes:Subagent:bbbbbb] started: write the docs",
    "[Hermes:Subagent:aaaaaa] tool read_file",
    "[Hermes:Subagent:aaaaaa] step: Found two candidates.",
  ]);
  assert.equal(batch.active, true);
});

test("a repeated tool call is one line of news, and a child finishes once", () => {
  const format = createSubagentFormatter();
  const id = "20260101_120000_abc123";

  // The child is already known from the poll that announced it.
  format(subagentActivity({ baseline: true, children: [childActivity(id)] }));

  const first = format(
    subagentActivity({
      children: [childActivity(id, { toolCallCount: 1 })],
      messages: [{ id: 5, sessionId: id, role: "tool", toolName: "read_file", preview: "" }],
    }),
  );
  assert.deepEqual(first.lines, ["[Hermes:Subagent:abc123] tool read_file"]);

  const repeated = format(
    subagentActivity({
      children: [childActivity(id, { toolCallCount: 2 })],
      messages: [{ id: 6, sessionId: id, role: "tool", toolName: "read_file", preview: "" }],
    }),
  );
  assert.deepEqual(repeated.lines, [], "five reads in a row are still one line");
  assert.equal(repeated.active, true, "the run is busy even when the tail has nothing new to say");

  const finished = format(subagentActivity({ children: [childActivity(id, { done: true, toolCallCount: 7 })] }));
  assert.deepEqual(finished.lines, ["[Hermes:Subagent:abc123] finished after 7 tool calls"]);

  const again = format(subagentActivity({ children: [childActivity(id, { done: true, toolCallCount: 7 })] }));
  assert.deepEqual(again.lines, [], "a completion is reported once");
});

test("shortSubagentId keeps the tail of a session id", () => {
  assert.equal(shortSubagentId("20260101_120000_abcdef"), "abcdef");
  assert.equal(shortSubagentId("local-0123456789abcdef"), "abcdef");
});
