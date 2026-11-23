import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runBridge, type SubagentActivity } from "../src/python-bridge.js";
import { managePendingWrites, type PendingWritesResult, type SalvageOutcome } from "../src/memory-manager.js";
import { resolveHermesPython } from "../src/hermes-paths.js";
import { DatabaseSync } from "node:sqlite";
import { makeBridgeHome } from "./bridge-home.js";

const DELIMITER = "\n§\n";
const ALPHA = "Alpha topic: the widget lives in src/widget.ts and is covered by tests.";
const BETA = "Beta topic: deployment uses a self-hosted runner named ottbox.";

interface Sandbox {
  home: string;
  pending: string;
  write: (id: string, payload: Record<string, unknown>) => void;
  writeRaw: (id: string, raw: string) => void;
}

/**
 * The interpreter probe resolves against the real install, which is gone once HERMES_HOME moves, so
 * it runs once with the real env and is then pinned through HERMES_PYTHON.
 */
let resolvedPythonPath: string | null = null;

const interpreterPath = async (): Promise<string> => {
  resolvedPythonPath ??= await resolveHermesPython();
  return resolvedPythonPath;
};

const makeSandbox = async (t: TestContext): Promise<Sandbox> => {
  const python = await interpreterPath();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-bridge-home-"));
  const memories = path.join(home, "memories");
  const pending = path.join(home, "pending", "memory");
  fs.mkdirSync(memories, { recursive: true });
  fs.mkdirSync(pending, { recursive: true });
  fs.mkdirSync(path.join(home, "pending", "skills"), { recursive: true });
  fs.writeFileSync(path.join(memories, "MEMORY.md"), [ALPHA, BETA].join(DELIMITER), "utf8");
  fs.writeFileSync(path.join(memories, "USER.md"), "User profile entry.", "utf8");

  const previousHome = process.env.HERMES_HOME;
  const previousPython = process.env.HERMES_PYTHON;
  process.env.HERMES_PYTHON = python;
  process.env.HERMES_HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = previousHome;
    if (previousPython === undefined) delete process.env.HERMES_PYTHON;
    else process.env.HERMES_PYTHON = previousPython;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const write = (id: string, payload: Record<string, unknown>): void => {
    fs.writeFileSync(
      path.join(pending, `${id}.json`),
      JSON.stringify({
        id,
        subsystem: "memory",
        action: payload.action ?? "batch",
        summary: `test record ${id}`,
        origin: "background_review",
        created_at: 1_700_000_000,
        payload,
      }),
      "utf8",
    );
  };

  const writeRaw = (id: string, raw: string): void => {
    fs.writeFileSync(path.join(pending, `${id}.json`), raw, "utf8");
  };

  return { home, pending, write, writeRaw };
};

const withPrivateTmp = (t: TestContext): string => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-bridge-tmp-"));
  const previous = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  process.env.TMPDIR = scratch;
  process.env.TEMP = scratch;
  process.env.TMP = scratch;
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  return scratch;
};

test("the bridge script is rewritten after its temp dir disappears", async (t) => {
  const scratch = withPrivateTmp(t);
  const sandbox = await makeSandbox(t);

  const first = await runBridge<{ hermes_home: string }>({ op: "inspect" });
  assert.equal(path.resolve(first.hermes_home), path.resolve(sandbox.home));

  const scriptDirs = fs.readdirSync(scratch).filter((name) => name.startsWith("hermes-worker-script-"));
  assert.equal(scriptDirs.length, 1, "the bridge script lives in its own temp dir");
  fs.rmSync(path.join(scratch, scriptDirs[0]), { recursive: true, force: true });

  // A scratch cleaner can delete os.tmpdir() contents under a long-lived MCP process.
  const second = await runBridge<{ hermes_home: string }>({ op: "inspect" });
  assert.equal(path.resolve(second.hermes_home), path.resolve(sandbox.home));
});

test("a timeout is reported as a timeout, not as a non-zero exit", async (t) => {
  await makeSandbox(t);
  await assert.rejects(
    runBridge({ op: "inspect" }, { timeoutMs: 1 }),
    (error: Error) => {
      assert.match(error.message, /timed out after 1ms/);
      assert.doesNotMatch(error.message, /exited/);
      return true;
    },
  );
});

test("one unreadable record does not fail the whole listing", async (t) => {
  const sandbox = await makeSandbox(t);
  sandbox.writeRaw(
    "bad00001",
    JSON.stringify({
      id: "bad00001",
      subsystem: "memory",
      origin: "background_review",
      summary: "record with a corrupt payload",
      created_at: 1_700_000_001,
      payload: "not-an-object",
    }),
  );
  sandbox.write("ok000001", { action: "add", target: "memory", content: "A staged addition." });

  const listed = (await managePendingWrites({ action: "list", subsystem: "memory" })) as Extract<
    PendingWritesResult,
    { action: "list" | "preview" }
  >;
  assert.equal(listed.count, 2, "both records are reported");

  const bad = listed.records.find((record) => record.id === "bad00001");
  assert.ok(bad, "the unreadable record is still surfaced by id");
  assert.match(bad.summary, /unreadable/);
  assert.deepEqual(bad.ops, []);

  const ok = listed.records.find((record) => record.id === "ok000001");
  assert.ok(ok, "the readable record still lists its operations");
  assert.equal(ok.ops?.[0].content, "A staged addition.");
});

test("one unreadable record does not fail the whole diagnosis", async (t) => {
  const sandbox = await makeSandbox(t);
  sandbox.writeRaw(
    "bad00002",
    JSON.stringify({
      id: "bad00002",
      subsystem: "memory",
      origin: "background_review",
      summary: "record with a corrupt payload",
      created_at: 1_700_000_002,
      payload: ["not", "an", "object"],
    }),
  );
  sandbox.write("ok000002", { action: "add", target: "memory", content: "Another staged addition." });

  const diagnosis = await managePendingWrites({ action: "diagnose", subsystem: "memory" });
  assert.ok("counts" in diagnosis);
  assert.equal(diagnosis.records.length, 2);
  const bad = diagnosis.records.find((record) => record.id === "bad00002");
  assert.ok(bad);
  assert.match(bad.note ?? "", /unreadable/);
  assert.equal(diagnosis.counts.VALID, 1, "the readable record is still classified");
});

test("salvage never writes through a record id that is not a bare token", async (t) => {
  const sandbox = await makeSandbox(t);
  sandbox.writeRaw(
    "evil0001",
    JSON.stringify({
      id: "../escaped",
      subsystem: "memory",
      action: "batch",
      summary: "record whose id is a path",
      origin: "background_review",
      created_at: 1_700_000_003,
      payload: {
        action: "batch",
        target: "memory",
        operations: [
          {
            action: "patch",
            old_text: "self-hosted runner",
            content: "deployment runs behind Caddy",
            matched_entry: "Beta topic: stale copy of this entry.",
          },
        ],
      },
    }),
  );
  sandbox.write("good0001", {
    action: "batch",
    target: "memory",
    operations: [
      {
        action: "patch",
        old_text: "self-hosted runner",
        content: "deployment is behind Caddy",
        matched_entry: "Beta topic: stale copy of this entry.",
      },
    ],
  });

  const salvage = (await managePendingWrites({ action: "salvage", id: "all" })) as {
    outcomes: SalvageOutcome[];
  };
  assert.equal(
    fs.existsSync(path.join(sandbox.home, "pending", "escaped.json")),
    false,
    "an id read back from disk must never become a path outside the pending dir",
  );

  const skipped = salvage.outcomes.find((outcome) => outcome.id === "../escaped");
  assert.ok(skipped, "the record is reported rather than silently ignored");
  assert.equal(skipped.outcome, "unchanged");
  assert.match(skipped.message, /id/);

  const rewritten = salvage.outcomes.find((outcome) => outcome.id === "good0001");
  assert.ok(rewritten, "the rest of the batch is still salvaged");
  assert.equal(rewritten.outcome, "rewritten");
  const onDisk = JSON.parse(fs.readFileSync(path.join(sandbox.pending, "good0001.json"), "utf8")) as {
    payload: { operations: Array<Record<string, unknown>> };
  };
  assert.equal(onDisk.payload.operations[0].matched_entry, BETA);
});

const SUBAGENT_SCHEMA = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, parent_session_id TEXT, source TEXT, title TEXT,
  started_at REAL, ended_at REAL, end_reason TEXT, message_count INTEGER, tool_call_count INTEGER
);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, tool_name TEXT, content TEXT
)`;

/** One write connection per call: the bridge opens its own read-only handle alongside. */
const seedStore = (home: string, statements: (db: DatabaseSync) => void): void => {
  const db = new DatabaseSync(path.join(home, "state.db"));
  statements(db);
  db.close();
};

test("subagent activity baselines, then reports only the children's new messages", async (t) => {
  const { home, available } = await makeBridgeHome(t);
  if (!available) return;

  seedStore(home, (db) => {
    db.exec(SUBAGENT_SCHEMA);
    const session = db.prepare(
      "INSERT INTO sessions (id, parent_session_id, source, title, started_at, ended_at, message_count, tool_call_count) VALUES (?,?,?,?,?,?,?,?)",
    );
    session.run("parent-1", null, "cli", "the run", 1, null, 2, 0);
    session.run("20260101_120000_aaaaaa", "parent-1", "subagent", "Subagent: audit the parser", 2, null, 1, 1);
    session.run("20260101_120000_bbbbbb", "parent-1", "subagent", "Subagent: write the docs", 3, 9, 1, 0);
    // A sibling run's child shares the store but not the parent: it must never be reported here.
    session.run("parent-2", null, "cli", "another run", 4, null, 1, 0);
    session.run("20260101_120000_cccccc", "parent-2", "subagent", "Subagent: unrelated", 5, null, 1, 0);

    const message = db.prepare("INSERT INTO messages (session_id, role, tool_name, content) VALUES (?,?,?,?)");
    message.run("parent-1", "assistant", null, "the parent's own step");
    message.run("20260101_120000_aaaaaa", "tool", "read_file", '{"content": "1|export"}');
  });

  const baseline = await runBridge<SubagentActivity>({ op: "subagent_activity", parentSessionId: "parent-1" });
  assert.equal(baseline.baseline, true);
  assert.deepEqual(baseline.messages, [], "a baseline replays nothing");
  assert.equal(baseline.cursor > 0, true, "the baseline still hands back a cursor to poll from");
  assert.deepEqual(
    baseline.children.map((child) => [child.id, child.done, child.toolCallCount]).sort(),
    [
      ["20260101_120000_aaaaaa", false, 1],
      ["20260101_120000_bbbbbb", true, 0],
    ],
  );

  seedStore(home, (db) => {
    const message = db.prepare("INSERT INTO messages (session_id, role, tool_name, content) VALUES (?,?,?,?)");
    message.run("20260101_120000_aaaaaa", "assistant", null, "Found\ntwo candidates.");
    message.run("20260101_120000_cccccc", "tool", "terminal", "pnpm test");
  });

  const delta = await runBridge<SubagentActivity>({
    op: "subagent_activity",
    parentSessionId: "parent-1",
    sinceMessageId: baseline.cursor,
  });
  assert.equal(delta.baseline, false);
  assert.equal(delta.messages.length, 1, "only this parent's children are polled");
  assert.equal(delta.messages[0].sessionId, "20260101_120000_aaaaaa");
  assert.equal(delta.messages[0].preview, "Found two candidates.", "a tail line cannot carry newlines");
  assert.equal(delta.cursor > baseline.cursor, true);

  const idle = await runBridge<SubagentActivity>({
    op: "subagent_activity",
    parentSessionId: "parent-1",
    sinceMessageId: delta.cursor,
  });
  assert.deepEqual(idle.messages, []);
  assert.equal(idle.cursor, delta.cursor, "an idle poll must not move the cursor");

  // A resumed parent carries every earlier turn's children in this store: only this turn's count.
  const scoped = await runBridge<SubagentActivity>({
    op: "subagent_activity",
    parentSessionId: "parent-1",
    sinceMessageId: 0,
    sinceStartedAt: 2.5,
  });
  assert.deepEqual(
    scoped.children.map((child) => child.id),
    ["20260101_120000_bbbbbb"],
    "a child that started before the turn is never replayed",
  );
});

test("subagent polling returns an empty batch when there is no session store", async (t) => {
  const { home, available } = await makeBridgeHome(t);
  if (!available) return;
  assert.equal(fs.existsSync(path.join(home, "state.db")), false, "the fixture starts empty");

  const activity = await runBridge<SubagentActivity>({ op: "subagent_activity", parentSessionId: "parent-1" });
  assert.deepEqual(activity.children, []);
  assert.deepEqual(activity.messages, []);
  assert.equal(activity.baseline, true);
  assert.equal(
    fs.existsSync(path.join(home, "state.db")),
    false,
    "a read must never create the store it could not find",
  );
});
