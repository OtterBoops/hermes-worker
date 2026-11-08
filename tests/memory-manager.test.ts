import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  collectNewPendingWrites,
  inspectMemory,
  managePendingWrites,
  snapshotPendingIds,
  type Diagnosis,
  type PendingWritesResult,
  type SalvageOutcome,
} from "../src/memory-manager.js";
import { hermesHome } from "../src/hermes-paths.js";

const DELIMITER = "\n§\n";

const ALPHA = "Alpha topic: the widget lives in src/widget.ts and is covered by tests.";
const BETA = "Beta topic: deployment uses a self-hosted runner named ottbox.";
const GAMMA = "Gamma topic: theme tokens are registered on html.";

/** Run first: the interpreter probe resolves against the real install before HERMES_HOME moves. */
test("inspectMemory reports the live stores and the pending queue", async () => {
  const inspected = await inspectMemory();

  assert.ok(inspected.memory.path.toLowerCase().endsWith("memory.md"));
  assert.ok(inspected.user.path.toLowerCase().endsWith("user.md"));
  assert.ok(inspected.memory.entries > 0, "MEMORY.md should have entries");
  assert.ok(inspected.memory.char_count > 0);
  assert.ok(inspected.memory.char_count <= inspected.memory.char_limit);
  assert.ok(Number.isInteger(inspected.pending.memory) && inspected.pending.memory >= 0);
  assert.ok(Number.isInteger(inspected.pending.skills) && inspected.pending.skills >= 0);
  assert.equal(typeof inspected.write_approval.memory, "boolean");

  // The limits come from config.yaml, not from MemoryStore's 2200/1375 defaults.
  const configPath = path.join(hermesHome(), "config.yaml");
  if (fs.existsSync(configPath)) {
    const config = fs.readFileSync(configPath, "utf8");
    const configured = /^\s*memory_char_limit:\s*(\d+)/m.exec(config);
    if (configured) assert.equal(inspected.memory.char_limit, Number(configured[1]));
    const userLimit = /^\s*user_char_limit:\s*(\d+)/m.exec(config);
    if (userLimit) assert.equal(inspected.user.char_limit, Number(userLimit[1]));
  }
});

interface Sandbox {
  home: string;
  memoryFile: string;
  write: (id: string, payload: Record<string, unknown>) => void;
}

const makeSandbox = (t: TestContext): Sandbox => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-worker-home-"));
  const memories = path.join(home, "memories");
  const pending = path.join(home, "pending", "memory");
  fs.mkdirSync(memories, { recursive: true });
  fs.mkdirSync(pending, { recursive: true });

  const memoryFile = path.join(memories, "MEMORY.md");
  fs.writeFileSync(memoryFile, [ALPHA, BETA, GAMMA].join(DELIMITER), "utf8");
  fs.writeFileSync(path.join(memories, "USER.md"), "User profile entry.", "utf8");

  const previousHome = process.env.HERMES_HOME;
  process.env.HERMES_HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const write = (id: string, payload: Record<string, unknown>): void => {
    fs.writeFileSync(
      path.join(pending, `${id}.json`),
      JSON.stringify(
        {
          id,
          subsystem: "memory",
          action: payload.action ?? "batch",
          summary: `test record ${id}`,
          origin: "background_review",
          created_at: 1_700_000_000 + id.charCodeAt(0),
          payload,
        },
        null,
        2,
      ),
      "utf8",
    );
  };

  return { home, memoryFile, write };
};

const seedRecords = (sandbox: Sandbox): void => {
  sandbox.write("aaa11111", {
    action: "batch",
    target: "memory",
    operations: [
      { action: "add", content: "Delta topic: the queue is a file-backed pending store." },
      {
        action: "remove",
        old_text: "Zeta topic",
        matched_entry: "Zeta topic: already gone from memory.",
      },
      {
        action: "patch",
        old_text: "deployment uses a self-hosted runner",
        content: "deployment runs behind Caddy",
        matched_entry: "Beta topic: stale copy of this entry.",
      },
    ],
  });
  sandbox.write("bbb22222", {
    action: "batch",
    target: "memory",
    operations: [
      {
        action: "patch",
        old_text: "no such phrase anywhere in memory",
        content: "replacement",
        matched_entry: "phantom entry that is not present",
      },
    ],
  });
  sandbox.write("ccc33333", {
    action: "batch",
    target: "memory",
    operations: [{ action: "add", content: ALPHA }],
  });
};

test("diagnose classifies every operation without touching disk", async (t) => {
  const sandbox = makeSandbox(t);
  seedRecords(sandbox);

  const pendingDir = path.join(sandbox.home, "pending", "memory");
  const before = new Map(
    fs.readdirSync(pendingDir).map((file) => [file, fs.readFileSync(path.join(pendingDir, file), "utf8")]),
  );
  const memoryBefore = fs.readFileSync(sandbox.memoryFile, "utf8");

  const diagnosis = (await managePendingWrites({
    action: "diagnose",
    subsystem: "memory",
  })) as Extract<PendingWritesResult, { action: "diagnose" }> & Diagnosis;
  const byId = new Map(diagnosis.records.map((record) => [record.id, record]));

  const aaa = byId.get("aaa11111");
  assert.ok(aaa, "record aaa11111 should be diagnosed");
  assert.deepEqual(
    aaa.ops.map((op) => op.status),
    ["VALID", "REDUNDANT_NOOP", "REBINDABLE"],
  );
  assert.equal(aaa.ops[2].rebind_to, BETA, "the rebindable patch should name the live entry it will pin");

  const bbb = byId.get("bbb22222");
  assert.ok(bbb);
  assert.equal(bbb.ops[0].status, "CONFLICT");

  const ccc = byId.get("ccc33333");
  assert.ok(ccc);
  assert.equal(ccc.ops[0].status, "REDUNDANT_NOOP");

  assert.ok(diagnosis.counts.VALID >= 1);
  assert.ok(diagnosis.counts.REBINDABLE >= 1);
  assert.ok(diagnosis.counts.CONFLICT >= 1);
  assert.ok(diagnosis.counts.REDUNDANT_NOOP >= 2);

  for (const [file, content] of before) {
    assert.equal(fs.readFileSync(path.join(pendingDir, file), "utf8"), content, `${file} must not change`);
  }
  assert.equal(fs.readFileSync(sandbox.memoryFile, "utf8"), memoryBefore, "diagnose must not write memory");
});

test("salvage strips redundant ops, re-pins the rest and prunes empty records", async (t) => {
  const sandbox = makeSandbox(t);
  seedRecords(sandbox);

  const salvage = (await managePendingWrites({ action: "salvage", id: "all" })) as {
    outcomes: SalvageOutcome[];
  };
  const outcomes = new Map(salvage.outcomes.map((outcome) => [outcome.id, outcome]));

  const aaa = outcomes.get("aaa11111");
  assert.ok(aaa);
  assert.equal(aaa.outcome, "rewritten");
  assert.equal(aaa.kept, 2);
  assert.equal(aaa.dropped, 1);

  const ccc = outcomes.get("ccc33333");
  assert.ok(ccc);
  assert.equal(ccc.outcome, "auto_pruned_redundant");
  assert.equal(fs.existsSync(path.join(sandbox.home, "pending", "memory", "ccc33333.json")), false);

  const bbb = outcomes.get("bbb22222");
  assert.ok(bbb);
  assert.equal(bbb.outcome, "unchanged");
  assert.equal(bbb.unresolvable_ops.length, 1);

  const rewritten = JSON.parse(
    fs.readFileSync(path.join(sandbox.home, "pending", "memory", "aaa11111.json"), "utf8"),
  ) as { payload: { operations: Array<Record<string, unknown>> } };
  assert.equal(rewritten.payload.operations.length, 2);
  assert.equal(rewritten.payload.operations[0].action, "add");
  assert.equal(rewritten.payload.operations[1].action, "patch");
  assert.equal(rewritten.payload.operations[1].matched_entry, BETA);
});

test("an approved record lands in memory, a rejected one is dropped", async (t) => {
  const sandbox = makeSandbox(t);
  seedRecords(sandbox);

  await managePendingWrites({ action: "salvage", id: "all" });
  const approved = await managePendingWrites({ action: "approve", subsystem: "memory", id: "aaa11111" });

  assert.ok("output" in approved);
  assert.match(approved.output, /Approved 1 memory write/);

  const memory = fs.readFileSync(sandbox.memoryFile, "utf8");
  assert.ok(memory.includes("Delta topic: the queue is a file-backed pending store."));
  assert.ok(memory.includes("deployment runs behind Caddy"));
  assert.equal(memory.includes("deployment uses a self-hosted runner"), false);
  assert.equal(
    fs.existsSync(path.join(sandbox.home, "pending", "memory", "aaa11111.json")),
    false,
    "an applied record leaves the queue",
  );

  const rejected = await managePendingWrites({ action: "reject", subsystem: "memory", id: "bbb22222" });
  assert.ok("output" in rejected);
  assert.match(rejected.output, /Rejected/);
  assert.equal(fs.existsSync(path.join(sandbox.home, "pending", "memory", "bbb22222.json")), false);
});

test("list and preview expose the staged operations", async (t) => {
  const sandbox = makeSandbox(t);
  seedRecords(sandbox);

  const listed = await managePendingWrites({ action: "list", subsystem: "memory" });
  assert.ok("records" in listed);
  assert.equal(listed.count, 3);
  assert.ok(listed.records.every((record) => record.subsystem === "memory"));

  const preview = await managePendingWrites({ action: "preview", subsystem: "memory", id: "aaa11111" });
  assert.ok("records" in preview);
  assert.equal(preview.records.length, 1);
  assert.match(preview.records[0].preview ?? "", /old_text: deployment uses a self-hosted runner/);
});

test("skill records list, preview and reject through the same queue", async (t) => {
  const sandbox = makeSandbox(t);
  const skillsDir = path.join(sandbox.home, "pending", "skills");
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillsDir, "eee55555.json"),
    JSON.stringify({
      id: "eee55555",
      subsystem: "skills",
      action: "create",
      summary: "create skill 'probe'",
      origin: "background_review",
      created_at: 1_700_000_500,
      payload: {
        action: "create",
        name: "probe",
        content: "---\nname: probe\ndescription: fixture skill\n---\n\n# probe\n",
      },
    }),
    "utf8",
  );

  const listed = await managePendingWrites({ action: "list", subsystem: "skills" });
  assert.ok("records" in listed);
  assert.equal(listed.count, 1);
  assert.equal(listed.records[0].subsystem, "skills");
  assert.match(listed.records[0].preview ?? "", /description: fixture skill/);

  const diagnosis = (await managePendingWrites({
    action: "diagnose",
    subsystem: "skills",
  })) as Extract<PendingWritesResult, { action: "diagnose" }> & Diagnosis;
  assert.equal(diagnosis.records.length, 1);
  assert.match(diagnosis.records[0].note ?? "", /approve or reject directly/);

  const rejected = await managePendingWrites({ action: "reject", subsystem: "skills", id: "eee55555" });
  assert.ok("output" in rejected);
  assert.equal(rejected.pending_remaining, 0);
  assert.equal(fs.existsSync(path.join(skillsDir, "eee55555.json")), false);
});

test("snapshot plus collect isolates the records a run created", async (t) => {
  const sandbox = makeSandbox(t);
  seedRecords(sandbox);
  const before = snapshotPendingIds();
  assert.deepEqual([...before.memory].sort(), ["aaa11111", "bbb22222", "ccc33333"]);
  assert.equal(before.skills.size, 0);

  sandbox.write("ddd44444", {
    action: "add",
    target: "memory",
    content: "Epsilon topic: staged during the run.",
  });

  const created = collectNewPendingWrites(before, 200);
  assert.equal(created.length, 1);
  assert.equal(created[0].id, "ddd44444");
  assert.equal(created[0].subsystem, "memory");
  assert.equal(created[0].ops?.[0].action, "add");
});
