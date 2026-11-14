import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  RUN_STATE_DIR,
  clearRunState,
  listActiveRuns,
  pruneStaleRuns,
  readRunState,
  runLogPath,
  runStatePath,
  writeRunState,
  type RunState,
} from "../src/run-registry.js";

/** Every id this suite creates is unique to the process and to the run, so no cleanup can cross runs. */
const uniqueId = (tag: string): string =>
  `${tag}-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const DEAD_PID = 2_147_483_647;

const backdate = (file: string, hours: number): void => {
  const stamp = new Date(Date.now() - hours * 60 * 60 * 1000);
  fs.utimesSync(file, stamp, stamp);
};

const tempFilesFor = (runId: string): string[] => {
  const prefix = `${runId}.json.`;
  return fs.readdirSync(RUN_STATE_DIR).filter((entry) => entry.startsWith(prefix) && entry.endsWith(".tmp"));
};

const runningState = (runId: string, overrides: Partial<RunState> = {}): RunState => ({
  status: "running",
  runId,
  sessionName: "s",
  worktreePath: "w",
  branch: "hermes/agy-x",
  startedAt: 1_000,
  ...overrides,
});

test("pruneStaleRuns never removes a record whose worker pid still answers", async (t) => {
  const liveId = uniqueId("prune-live");
  const deadId = uniqueId("prune-dead");
  const doneId = uniqueId("prune-done");
  fs.mkdirSync(RUN_STATE_DIR, { recursive: true });
  t.after(async () => {
    for (const runId of [liveId, deadId, doneId]) await clearRunState(runId);
  });

  await writeRunState(runningState(liveId, { workerPid: process.pid }));
  await writeRunState(runningState(deadId, { workerPid: DEAD_PID }));
  await writeRunState({ ...runningState(doneId), status: "completed", result: { success: true } });
  for (const runId of [liveId, deadId, doneId]) backdate(runStatePath(runId), 48);

  const removed = await pruneStaleRuns(60 * 60 * 1000);

  assert.equal(fs.existsSync(runStatePath(liveId)), true, "a live worker's record is the only evidence its run exists");
  assert.equal(readRunState(liveId)?.workerPid, process.pid, "the surviving record is still readable");
  assert.equal(fs.existsSync(runStatePath(deadId)), false, "an abandoned record must still be reaped");
  assert.equal(fs.existsSync(runStatePath(doneId)), false, "a finished record must still be reaped");
  assert.ok(removed >= 2, `removed ${removed} records, expected at least the two dead ones`);
});

test("readRunState rejects a record that does not name its own run and status", (t) => {
  const noId = uniqueId("bad-noid");
  const wrongId = uniqueId("bad-wrongid");
  const badStatus = uniqueId("bad-status");
  const badPath = uniqueId("bad-path");
  fs.mkdirSync(RUN_STATE_DIR, { recursive: true });
  t.after(() => {
    for (const runId of [noId, wrongId, badStatus, badPath]) fs.rmSync(runStatePath(runId), { force: true });
  });

  fs.writeFileSync(runStatePath(noId), JSON.stringify({ status: "running" }), "utf8");
  fs.writeFileSync(runStatePath(wrongId), JSON.stringify(runningState("someone-else")), "utf8");
  fs.writeFileSync(runStatePath(badStatus), JSON.stringify({ ...runningState(badStatus), status: "halfway" }), "utf8");
  fs.writeFileSync(runStatePath(badPath), JSON.stringify({ ...runningState(badPath), worktreePath: 42 }), "utf8");

  for (const runId of [noId, wrongId, badStatus, badPath]) {
    assert.equal(readRunState(runId), null, `${runId} must not be read as a record`);
    assert.equal(listActiveRuns().some((state) => state.runId === runId), false, `${runId} must not be listed`);
  }
  assert.equal(
    listActiveRuns().some((state) => typeof state.runId !== "string"),
    false,
    "a listed record always names itself",
  );
  // Two unreadable records sharing a missing startedAt used to reach the sort comparator and throw.
  assert.doesNotThrow(() => listActiveRuns());
});

test("concurrent writes to one run never leave a partial record", async (t) => {
  const runId = uniqueId("race");
  fs.mkdirSync(RUN_STATE_DIR, { recursive: true });
  t.after(() => clearRunState(runId));

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const big = {
      ...runningState(runId),
      status: "completed" as const,
      result: { payload: "x".repeat(20_000) },
    };
    const small = runningState(runId);
    await assert.doesNotReject(
      () => Promise.all([writeRunState(big), writeRunState(small)]),
      `concurrent writes must not fail on attempt ${attempt}`,
    );
    const raw = fs.readFileSync(runStatePath(runId), "utf8");
    const parsed = JSON.parse(raw) as RunState;
    assert.equal(parsed.runId, runId);
    assert.ok(parsed.status === "completed" || parsed.status === "running");
  }
  assert.deepEqual(tempFilesFor(runId), [], "no write may leave its temp behind");
});

test("clearRunState removes every artifact the run owns and nothing else", async (t) => {
  const runId = uniqueId("clear");
  const keeper = uniqueId("clear-keeper");
  fs.mkdirSync(RUN_STATE_DIR, { recursive: true });
  t.after(async () => {
    await clearRunState(runId);
    await clearRunState(keeper);
  });

  await writeRunState(runningState(runId, { workerPid: process.pid }));
  await writeRunState({ ...runningState(keeper), status: "completed", result: { success: true } });
  fs.writeFileSync(`${runStatePath(runId)}.tmp`, "legacy temp", "utf8");
  fs.writeFileSync(path.join(RUN_STATE_DIR, `${runId}.json.${process.pid}.abc123.tmp`), "stray", "utf8");
  fs.writeFileSync(runLogPath(runId), "log\n", "utf8");

  await clearRunState(runId);
  await clearRunState(runId);

  assert.equal(fs.existsSync(runStatePath(runId)), false, "the record is gone");
  assert.equal(fs.existsSync(runLogPath(runId)), false, "the log is gone");
  assert.equal(fs.existsSync(`${runStatePath(runId)}.tmp`), false, "a legacy temp is gone");
  assert.deepEqual(tempFilesFor(runId), [], "no per-write temp survives");
  assert.equal(readRunState(keeper)?.status, "completed", "another run's record is untouched");
});

test("clearRunState refuses an id that resolves outside the state directory", async (t) => {
  const name = uniqueId("victim");
  const victim = path.join(os.tmpdir(), `${name}.json`);
  fs.writeFileSync(victim, "not a run record", "utf8");
  t.after(() => fs.rmSync(victim, { force: true }));

  await clearRunState(`../${name}`);

  assert.equal(fs.existsSync(victim), true, "an id with a separator must never become a path to delete");
});

test("listActiveRuns sorts a malformed startedAt instead of returning arbitrary order", async (t) => {
  const noStamp = uniqueId("sort-none");
  const stamped = uniqueId("sort-stamp");
  fs.mkdirSync(RUN_STATE_DIR, { recursive: true });
  t.after(async () => {
    await clearRunState(noStamp);
    await clearRunState(stamped);
  });

  await fsp.mkdir(RUN_STATE_DIR, { recursive: true });
  const { status, runId, sessionName, worktreePath, branch } = runningState(noStamp);
  await fsp.writeFile(
    runStatePath(noStamp),
    JSON.stringify({ status, runId, sessionName, worktreePath, branch, workerPid: process.pid }),
    "utf8",
  );
  await writeRunState(runningState(stamped, { startedAt: Date.now(), workerPid: process.pid }));

  const listed = listActiveRuns().map((state) => state.runId);
  assert.ok(listed.indexOf(stamped) < listed.indexOf(noStamp), "a record without a start time sorts last");
});
