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
import { hermesHome, resolveHermesPython } from "../src/hermes-paths.js";

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
  writeRaw: (id: string, raw: string) => void;
}

interface SandboxOptions {
  entries?: string[];
  limits?: { memory: number; user: number };
}

/**
 * The probe resolves against the real install, which is gone once HERMES_HOME moves. Resolve it
 * once with the real env and then pin HERMES_PYTHON so every sandbox stays independently runnable.
 */
let resolvedPythonPath: string | null = null;

const interpreterPath = async (): Promise<string> => {
  resolvedPythonPath ??= await resolveHermesPython();
  return resolvedPythonPath;
};

const makeSandbox = async (t: TestContext, options: SandboxOptions = {}): Promise<Sandbox> => {
  const python = await interpreterPath();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-worker-home-"));
  const memories = path.join(home, "memories");
  const pending = path.join(home, "pending", "memory");
  fs.mkdirSync(memories, { recursive: true });
  fs.mkdirSync(pending, { recursive: true });
  fs.mkdirSync(path.join(home, "pending", "skills"), { recursive: true });

  const memoryFile = path.join(memories, "MEMORY.md");
  fs.writeFileSync(memoryFile, (options.entries ?? [ALPHA, BETA, GAMMA]).join(DELIMITER), "utf8");
  fs.writeFileSync(path.join(memories, "USER.md"), "User profile entry.", "utf8");
  if (options.limits) {
    fs.writeFileSync(
      path.join(home, "config.yaml"),
      `memory:\n  memory_char_limit: ${options.limits.memory}\n  user_char_limit: ${options.limits.user}\n`,
      "utf8",
    );
  }

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

  const writeRaw = (id: string, raw: string): void => {
    fs.writeFileSync(path.join(pending, `${id}.json`), raw, "utf8");
  };

  return { home, memoryFile, write, writeRaw };
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
  const sandbox = await makeSandbox(t);
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
  assert.deepEqual(aaa.ops.map((op) => op.status), ["VALID", "REDUNDANT_NOOP", "REBINDABLE"]);
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
  const sandbox = await makeSandbox(t);
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
  const sandbox = await makeSandbox(t);
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
  const sandbox = await makeSandbox(t);
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
  const sandbox = await makeSandbox(t);
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

  await assert.rejects(
    managePendingWrites({ action: "salvage", subsystem: "skills", id: "all" }),
    /salvage only rewrites memory/,
  );
});

test("snapshot plus collect isolates the records a run created", async (t) => {
  const sandbox = await makeSandbox(t);
  seedRecords(sandbox);
  const before = snapshotPendingIds();
  assert.deepEqual([...before.memory].sort(), ["aaa11111", "bbb22222", "ccc33333"]);
  assert.equal(before.skills.size, 0);

  sandbox.write("ddd44444", {
    action: "add",
    target: "memory",
    content: "Epsilon topic: staged during the run.",
  });

  const created = await collectNewPendingWrites(before, 200);
  assert.equal(created.length, 1);
  assert.equal(created[0].id, "ddd44444");
  assert.equal(created[0].subsystem, "memory");
  assert.equal(created[0].ops?.[0].action, "add");
});

test("pending ids that are not bare tokens are rejected before anything spawns", async (t) => {
  const sandbox = await makeSandbox(t);
  seedRecords(sandbox);
  const pendingDir = path.join(sandbox.home, "pending", "memory");
  const listing = fs.readdirSync(pendingDir).sort();

  const started = Date.now();
  await assert.rejects(
    managePendingWrites({ action: "approve", subsystem: "memory", id: "../../etc/passwd" }),
    (error: Error) => {
      assert.match(error.message, /Invalid pending id '\.\.\/\.\.\/etc\/passwd'/);
      assert.match(error.message, /for approve/);
      assert.doesNotMatch(error.message, /Hermes bridge/, "must not reach the bridge at all");
      return true;
    },
  );
  await assert.rejects(
    managePendingWrites({ action: "diagnose", subsystem: "memory", id: "../x" }),
    /Invalid pending id '\.\.\/x'/,
  );
  await assert.rejects(managePendingWrites({ action: "salvage", id: "..%2Fx" }), /Invalid pending id/);

  assert.ok(Date.now() - started < 5_000);
  assert.deepEqual(fs.readdirSync(pendingDir).sort(), listing, "no file may be created or consumed");
  assert.equal(fs.existsSync(path.join(sandbox.home, "etc")), false);
  assert.equal(fs.existsSync(path.join(path.dirname(sandbox.home), "passwd")), false);
});

test("legacy shapes classify without inventing conflicts", async (t) => {
  const sandbox = await makeSandbox(t);
  sandbox.write("leg66666", {
    action: "batch",
    target: "memory",
    operations: [
      {
        action: "replace",
        old_text: "self-hosted runner",
        new_text: "legacy replaced span",
        matched_entry: BETA,
      },
      { action: "add", content: "   " },
      { action: "remove", old_text: "Alpha topic", matched_entry: "Alpha topic: stale copy." },
      { action: "remove", old_text: "Zeta topic", matched_entry: "Zeta topic: already gone." },
      {
        action: "patch",
        old_text: "theme tokens are registered",
        new_text: "theme tokens live on html",
        matched_entry: GAMMA,
      },
    ],
  });

  const diagnosis = (await managePendingWrites({
    action: "diagnose",
    subsystem: "memory",
  })) as Extract<PendingWritesResult, { action: "diagnose" }> & Diagnosis;
  const record = diagnosis.records.find((entry) => entry.id === "leg66666");
  assert.ok(record);
  assert.deepEqual(
    record.ops.map((op) => op.status),
    ["VALID", "CONFLICT", "CONFLICT", "REDUNDANT_NOOP", "VALID"],
  );
  assert.equal(record.ops[0].content, "legacy replaced span", "new_text is a legacy content field");
  assert.equal(record.ops[1].detail, "add requires content");
  assert.equal(record.ops[2].detail, "entry changed since staged; refusing to rebind remove");
  assert.equal(record.ops[3].detail, "entry already removed");
  assert.equal(record.ops[4].content, "theme tokens live on html");
});

/** A near-full store: the add alone overflows, the paired remove frees more than the add costs. */
const NET_BUDGET_LIMIT = 200;
const nearEntry = `Keep topic: ${"y".repeat(40)}`;
const staleEntry = `Stale topic: ${"x".repeat(90)}`;
const freshEntry = `Fresh topic: ${"z".repeat(90)}`;

const seedNetBudgetRecord = (sandbox: Sandbox): void => {
  sandbox.write("fed77777", {
    action: "batch",
    target: "memory",
    operations: [
      { action: "add", content: freshEntry },
      { action: "remove", old_text: "Stale topic", matched_entry: staleEntry },
    ],
  });
};

test("an add+remove batch that nets within budget is VALID and survives salvage", async (t) => {
  const sandbox = await makeSandbox(t, {
    entries: [nearEntry, staleEntry],
    limits: { memory: NET_BUDGET_LIMIT, user: 100 },
  });
  seedNetBudgetRecord(sandbox);

  const live = [nearEntry, staleEntry].join(DELIMITER).length;
  assert.ok(live + DELIMITER.length + freshEntry.length > NET_BUDGET_LIMIT, "the add alone must overflow");
  assert.ok([nearEntry, freshEntry].join(DELIMITER).length <= NET_BUDGET_LIMIT, "the batch must net inside");

  const diagnosis = (await managePendingWrites({
    action: "diagnose",
    subsystem: "memory",
  })) as Extract<PendingWritesResult, { action: "diagnose" }> & Diagnosis;
  const record = diagnosis.records.find((entry) => entry.id === "fed77777");
  assert.ok(record);
  assert.deepEqual(record.ops.map((op) => op.status), ["VALID", "VALID"]);

  const salvage = (await managePendingWrites({ action: "salvage", id: "fed77777" })) as {
    outcomes: SalvageOutcome[];
  };
  const outcome = salvage.outcomes[0];
  assert.equal(outcome.kept, 2, "both ops must be kept");
  assert.equal(outcome.dropped, 0);

  const kept = JSON.parse(
    fs.readFileSync(path.join(sandbox.home, "pending", "memory", "fed77777.json"), "utf8"),
  ) as { payload: { operations: Array<Record<string, unknown>> } };
  assert.deepEqual(
    kept.payload.operations.map((op) => op.action),
    ["add", "remove"],
  );
  assert.equal(kept.payload.operations[1].matched_entry, staleEntry);
});

test("collectNewPendingWrites gathers records staged 80ms apart", async (t) => {
  const sandbox = await makeSandbox(t);
  const before = snapshotPendingIds();

  const staging = (async () => {
    sandbox.write("abc11111", { action: "add", target: "memory", content: "Sibling one." });
    await new Promise((resolve) => setTimeout(resolve, 80));
    sandbox.write("abc22222", { action: "add", target: "memory", content: "Sibling two." });
  })();

  const created = await collectNewPendingWrites(before, 1_000);
  await staging;

  assert.deepEqual(created.map((record) => record.id).sort(), ["abc11111", "abc22222"]);
});

test("a corrupt pending record neither stalls collection nor appears in results", async (t) => {
  const sandbox = await makeSandbox(t);
  const before = snapshotPendingIds();
  sandbox.writeRaw("bad00000", "{ this is not json");

  const staging = new Promise<void>((resolve) => {
    setTimeout(() => {
      sandbox.write("abc33333", { action: "add", target: "memory", content: "Recovered record." });
      resolve();
    }, 120);
  });

  const started = Date.now();
  const created = await collectNewPendingWrites(before, 1_500);
  await staging;
  const elapsed = Date.now() - started;

  assert.deepEqual(created.map((record) => record.id), ["abc33333"]);
  assert.ok(elapsed < 1_000, `a corrupt file must not hold the poll open (took ${elapsed}ms)`);

  const quietBefore = snapshotPendingIds();
  sandbox.writeRaw("bad00001", "{{ truncated");
  const quietStarted = Date.now();
  const none = await collectNewPendingWrites(quietBefore, 250);
  const quietElapsed = Date.now() - quietStarted;
  assert.deepEqual(none, []);
  assert.ok(quietElapsed < 1_500, `deadline must bound the wait (took ${quietElapsed}ms)`);
});

test("a legacy new_text record is collected with its real content", async (t) => {
  const sandbox = await makeSandbox(t);
  const before = snapshotPendingIds();
  sandbox.write("leg77777", {
    action: "batch",
    target: "memory",
    operations: [
      {
        action: "patch",
        old_text: "self-hosted runner",
        new_text: "legacy replaced span",
        matched_entry: BETA,
      },
    ],
  });

  const created = await collectNewPendingWrites(before, 400);
  assert.equal(created.length, 1);
  assert.equal(
    created[0].ops?.[0].content,
    "legacy replaced span",
    "new_text is the content of a legacy patch record",
  );
  assert.equal(created[0].ops?.[0].old_text, "self-hosted runner");
});

test("one malformed operation does not discard the whole staged record", async (t) => {
  const sandbox = await makeSandbox(t);
  const before = snapshotPendingIds();
  sandbox.writeRaw(
    "mix00001",
    JSON.stringify({
      id: "mix00001",
      subsystem: "memory",
      origin: "background_review",
      summary: "record with a junk operation",
      created_at: 1_700_000_900,
      payload: {
        action: "batch",
        target: "memory",
        operations: [{ action: "add", content: "Survivor entry." }, null, "not-an-operation", 7],
      },
    }),
  );

  const created = await collectNewPendingWrites(before, 400);
  assert.equal(created.length, 1, "the record itself is readable");
  assert.equal(created[0].ops?.length, 1, "only the well-formed operation survives");
  assert.equal(created[0].ops?.[0].content, "Survivor entry.");
});

test("a net-budget batch approves even though one op alone would overflow", async (t) => {
  const sandbox = await makeSandbox(t, {
    entries: [nearEntry, staleEntry],
    limits: { memory: NET_BUDGET_LIMIT, user: 100 },
  });
  seedNetBudgetRecord(sandbox);

  const approved = await managePendingWrites({ action: "approve", subsystem: "memory", id: "fed77777" });
  assert.ok("output" in approved);
  assert.match(approved.output, /Approved 1 memory write/);

  const memory = fs.readFileSync(sandbox.memoryFile, "utf8");
  assert.ok(memory.includes(freshEntry), "the added entry landed");
  assert.equal(memory.includes(staleEntry), false, "the stale entry was removed");
  assert.ok(memory.length <= NET_BUDGET_LIMIT, `final state must fit the limit (${memory.length})`);
});

test("a destructive op without content is a CONFLICT even when it is pinned", async (t) => {
  const sandbox = await makeSandbox(t);
  sandbox.write("noc00001", {
    action: "batch",
    target: "memory",
    operations: [
      // MemoryStore refuses an empty patch/new_content, so a pinned pin must not hide it.
      { action: "patch", old_text: "self-hosted runner", matched_entry: BETA },
      { action: "replace", old_text: "theme tokens", content: "   ", matched_entry: GAMMA },
    ],
  });

  const diagnosis = (await managePendingWrites({
    action: "diagnose",
    subsystem: "memory",
  })) as Extract<PendingWritesResult, { action: "diagnose" }> & Diagnosis;
  const record = diagnosis.records.find((entry) => entry.id === "noc00001");
  assert.ok(record);
  assert.deepEqual(record.ops.map((op) => op.status), ["CONFLICT", "CONFLICT"]);
  assert.equal(record.ops[0].detail, "patch requires content");
  assert.equal(record.ops[1].detail, "replace requires content");
});
