import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CONVERSATION_SESSIONS_FILE,
  RUN_STATE_DIR,
  clearConversationSession,
  clearRunState,
  listActiveRuns,
  pruneStaleRuns,
  readConversationSession,
  readRunState,
  runLogPath,
  runStatePath,
  writeConversationSession,
  writeRunState,
  type ConversationSessionRecord,
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

  // The count is global to a directory every test process prunes, so only the outcomes are this
  // test's to assert.
  await pruneStaleRuns(60 * 60 * 1000);

  assert.equal(fs.existsSync(runStatePath(liveId)), true, "a live worker's record is the only evidence its run exists");
  assert.equal(readRunState(liveId)?.workerPid, process.pid, "the surviving record is still readable");
  assert.equal(fs.existsSync(runStatePath(deadId)), false, "an abandoned record must still be reaped");
  assert.equal(fs.existsSync(runStatePath(doneId)), false, "a finished record must still be reaped");
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

const conversationsPath = (): string => path.join(RUN_STATE_DIR, CONVERSATION_SESSIONS_FILE);

const conversationRecord = (
  conversationId: string,
  repoRoot: string,
  overrides: Partial<ConversationSessionRecord> = {},
): ConversationSessionRecord => ({
  conversationId,
  repoRoot,
  sessionId: `sess-${conversationId}`,
  initialTreeSha: "a".repeat(40),
  lastAfterTreeSha: "b".repeat(40),
  updatedAt: Date.now(),
  ...overrides,
});

/** Reads the map the way the module writes it, so a test can assert on its on-disk shape. */
const readMap = (): { version: number; records: ConversationSessionRecord[] } =>
  JSON.parse(fs.readFileSync(conversationsPath(), "utf8")) as {
    version: number;
    records: ConversationSessionRecord[];
  };

test("a conversation session round-trips, and a rewrite replaces the same conversation and repo", async (t) => {
  const conversationId = uniqueId("conv-roundtrip");
  const repoRoot = path.join(os.tmpdir(), `hermes-conv-repo-${process.pid}`);
  fs.mkdirSync(RUN_STATE_DIR, { recursive: true });
  t.after(async () => clearConversationSession(conversationId));

  const first = conversationRecord(conversationId, repoRoot, { sessionId: "sess-first" });
  await writeConversationSession(first);
  assert.deepEqual(await readConversationSession(conversationId, repoRoot), first);

  const second = conversationRecord(conversationId, repoRoot, {
    sessionId: "sess-second",
    lastAfterTreeSha: "c".repeat(40),
    updatedAt: first.updatedAt + 1_000,
  });
  await writeConversationSession(second);
  assert.deepEqual(
    await readConversationSession(conversationId, repoRoot),
    second,
    "the newest turn's binding is the one a resumed dispatch resumes from",
  );

  const map = readMap();
  assert.equal(map.version, 1, "the map carries an explicit version");
  const mine = map.records.filter((record) => record.conversationId === conversationId);
  assert.equal(mine.length, 1, "a second write for the same pair replaces instead of appending");
  assert.equal(mine[0]?.sessionId, "sess-second");
});

test("two conversations across two repositories keep four independent records", async (t) => {
  const firstConversation = uniqueId("conv-multi-a");
  const secondConversation = uniqueId("conv-multi-b");
  const repoOne = path.join(os.tmpdir(), "hermes-conv-one");
  const repoTwo = path.join(os.tmpdir(), "hermes-conv-two");
  fs.mkdirSync(RUN_STATE_DIR, { recursive: true });
  t.after(async () => {
    await clearConversationSession(firstConversation);
    await clearConversationSession(secondConversation);
  });

  const records = [
    conversationRecord(firstConversation, repoOne, { sessionId: "a-one" }),
    conversationRecord(firstConversation, repoTwo, { sessionId: "a-two" }),
    conversationRecord(secondConversation, repoOne, { sessionId: "b-one" }),
    conversationRecord(secondConversation, repoTwo, { sessionId: "b-two" }),
  ];
  for (const record of records) await writeConversationSession(record);

  for (const record of records) {
    const found = await readConversationSession(record.conversationId, record.repoRoot);
    assert.equal(
      found?.sessionId,
      record.sessionId,
      `${record.conversationId} on ${record.repoRoot} must keep its own session`,
    );
  }

  // Without a repoRoot the lookup is conversation-wide: it answers for the thread, not the checkout.
  const wide = await readConversationSession(firstConversation);
  assert.equal(wide?.conversationId, firstConversation);
  assert.ok(
    wide?.sessionId === "a-one" || wide?.sessionId === "a-two",
    "a conversation-wide read returns one of that conversation's records",
  );
});

test("repoRoot matching ignores case and trailing separators exactly as the platform does", async (t) => {
  const windows = process.platform === "win32";
  const conversationId = uniqueId("conv-pathkey");
  // Purely string-compared by the registry, so the shape only has to be a path on this platform.
  const written = windows ? "D:\\HermesConv\\MixedCase\\" : "/tmp/hermes-conv/MixedCase/";
  const separatorVariant = windows ? "D:/HermesConv/MixedCase" : "/tmp/hermes-conv/MixedCase";
  const caseVariant = windows ? "d:\\hermesconv\\mixedcase" : "/tmp/hermes-conv/mixedcase";
  fs.mkdirSync(RUN_STATE_DIR, { recursive: true });
  t.after(async () => clearConversationSession(conversationId, written));

  await writeConversationSession(conversationRecord(conversationId, written, { sessionId: "sess-path" }));

  assert.equal(
    (await readConversationSession(conversationId, separatorVariant))?.sessionId,
    "sess-path",
    "a trailing separator or the other separator form must not split one repository into two records",
  );
  assert.equal((await readConversationSession(conversationId, written))?.sessionId, "sess-path");

  // Windows folds case, POSIX does not: the record has to follow the rule the code actually applies.
  assert.equal(
    (await readConversationSession(conversationId, caseVariant))?.sessionId ?? null,
    windows ? "sess-path" : null,
    `case folding must follow the platform (${process.platform})`,
  );
});

test("readConversationSession is null for an unknown conversation and for an unreadable map", async (t) => {
  const conversationId = uniqueId("conv-unknown");
  const repoRoot = path.join(os.tmpdir(), "hermes-conv-unknown");
  fs.mkdirSync(RUN_STATE_DIR, { recursive: true });

  assert.equal(await readConversationSession(uniqueId("conv-never-written")), null);
  assert.equal(
    await readConversationSession(conversationId, repoRoot),
    null,
    "an unwritten conversation has no binding to resume from",
  );

  // The map is shared with every other test file in this run, so its previous bytes are restored.
  const previous = fs.existsSync(conversationsPath())
    ? fs.readFileSync(conversationsPath(), "utf8")
    : null;
  t.after(() => {
    if (previous === null) fs.rmSync(conversationsPath(), { force: true });
    else fs.writeFileSync(conversationsPath(), previous, "utf8");
  });

  fs.writeFileSync(conversationsPath(), "{ this is not json", "utf8");
  assert.equal(await readConversationSession(conversationId), null, "a corrupt map reads as an empty one");

  fs.writeFileSync(
    conversationsPath(),
    JSON.stringify({ version: 1, records: [{ conversationId: 42 }, null, "nope", {}] }),
    "utf8",
  );
  assert.equal(
    await readConversationSession(conversationId),
    null,
    "a shape the module would never write is dropped instead of trusted",
  );

  fs.rmSync(conversationsPath(), { force: true });
  assert.equal(await readConversationSession(conversationId), null, "an absent map is an empty one");
});

test("clearConversationSession drops one repository, or every repository without one", async (t) => {
  const conversationId = uniqueId("conv-clear");
  const otherConversation = uniqueId("conv-clear-other");
  const repoOne = path.join(os.tmpdir(), "hermes-conv-clear-one");
  const repoTwo = path.join(os.tmpdir(), "hermes-conv-clear-two");
  fs.mkdirSync(RUN_STATE_DIR, { recursive: true });
  t.after(async () => {
    await clearConversationSession(conversationId);
    await clearConversationSession(otherConversation);
  });

  await writeConversationSession(conversationRecord(conversationId, repoOne, { sessionId: "one" }));
  await writeConversationSession(conversationRecord(conversationId, repoTwo, { sessionId: "two" }));
  await writeConversationSession(conversationRecord(otherConversation, repoOne, { sessionId: "other" }));

  await clearConversationSession(conversationId, repoOne);
  assert.equal(await readConversationSession(conversationId, repoOne), null, "the cleared checkout is forgotten");
  assert.equal(
    (await readConversationSession(conversationId, repoTwo))?.sessionId,
    "two",
    "another repository of the same conversation keeps its binding",
  );
  assert.equal(
    (await readConversationSession(otherConversation, repoOne))?.sessionId,
    "other",
    "another conversation in the same repository is untouched",
  );

  await clearConversationSession(conversationId);
  assert.equal(await readConversationSession(conversationId, repoTwo), null);
  assert.equal(await readConversationSession(conversationId), null, "no repoRoot clears every record of the thread");
  assert.equal(
    (await readConversationSession(otherConversation, repoOne))?.sessionId,
    "other",
    "a conversation-wide clear stays inside its own conversation",
  );

  // Nothing to drop is a no-op, not a write: the map must survive an unmatched clear.
  const before = readMap();
  await clearConversationSession(uniqueId("conv-absent"));
  assert.deepEqual(readMap(), before);
});

test("pruneStaleRuns keeps the conversation map, and listActiveRuns never reads it as a run", async (t) => {
  const conversationId = uniqueId("conv-prune");
  const runId = uniqueId("prune-with-conversation");
  const repoRoot = path.join(os.tmpdir(), "hermes-conv-prune");
  fs.mkdirSync(RUN_STATE_DIR, { recursive: true });
  t.after(async () => {
    await clearConversationSession(conversationId);
    await clearRunState(runId);
  });

  await writeConversationSession(conversationRecord(conversationId, repoRoot, { sessionId: "sess-prune" }));
  await writeRunState(runningState(runId, { workerPid: DEAD_PID }));
  // Both entries are older than the cutoff: only the run record is litter.
  backdate(conversationsPath(), 48);
  backdate(runStatePath(runId), 48);

  const mapBefore = fs.readFileSync(conversationsPath(), "utf8");
  assert.equal(
    readRunState(CONVERSATION_SESSIONS_FILE.replace(/\.json$/, "")),
    null,
    "the map is not a record readRunState will ever accept",
  );

  await pruneStaleRuns(60 * 60 * 1000);

  assert.equal(fs.existsSync(runStatePath(runId)), false, "a stale run record is still reaped");
  assert.equal(fs.existsSync(conversationsPath()), true, "the map outlives the runs it describes");
  assert.equal(fs.readFileSync(conversationsPath(), "utf8"), mapBefore, "a prune must not rewrite the map");
  assert.equal(
    (await readConversationSession(conversationId, repoRoot))?.sessionId,
    "sess-prune",
    "the binding survives a prune even when the file is older than the cutoff",
  );
  assert.equal(
    listActiveRuns().some((state) => state.runId === CONVERSATION_SESSIONS_FILE.replace(/\.json$/, "")),
    false,
    "the map must never be listed as an active run",
  );
});
