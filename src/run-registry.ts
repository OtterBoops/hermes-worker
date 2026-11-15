import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** One definition of the on-disk run contract, shared by the dispatch path and the wait CLI. */
export const RUN_STATE_DIR = path.join(os.tmpdir(), "hermes-worker-runs");

export const RUN_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export type RunStatus = "running" | "completed";

export interface RunState {
  status: RunStatus;
  runId: string;
  sessionName: string;
  startedAt: number;
  result?: unknown;
  /** The dispatcher's own pid: the only field that can tell a crashed run from a slow one. */
  workerPid?: number;
  /** The runner child's pid, for diagnostics only: the worker outlives it by design. */
  childPid?: number;
  sessionId?: string | null;
  /** The checkout the run executed in; every snapshot run has one and no worktree. */
  repoRoot?: string;
  /** The working tree the run started from, and the root of the conversation it belongs to. */
  baselineTreeSha?: string;
  initialTreeSha?: string;
  conversationId?: string;
  /** Legacy only: records written while dispatches ran in `.worktrees/agy-*` checkouts. */
  worktreePath?: string;
  branch?: string;
}

export const runStatePath = (runId: string): string => path.join(RUN_STATE_DIR, `${runId}.json`);

/** The live tail the dispatch writes and the wait CLI streams to its own stdout. */
export const runLogPath = (runId: string): string => path.join(RUN_STATE_DIR, `${runId}.log`);

/**
 * Callers tail a background command's stdout, so a run that ends without one of these lines is
 * indistinguishable from a hang. The run id travels inside the sentinel so concurrent runs cannot
 * be mistaken for each other.
 */
export const HERMES_DISPATCH_SENTINEL_PREFIX = "<<<HERMES_DISPATCH_COMPLETE:";
export const HERMES_DISPATCH_FAILED_PREFIX = "<<<HERMES_DISPATCH_FAILED:";

export const formatDispatchSentinel = (runId: string): string =>
  `${HERMES_DISPATCH_SENTINEL_PREFIX}${runId}>>>`;

export const formatFailedSentinel = (runId: string): string =>
  `${HERMES_DISPATCH_FAILED_PREFIX}${runId}>>>`;

/** A crashed dispatch never reaches clearRunState, so its files would otherwise stay in tmpdir forever. */
const STALE_RUN_ENTRY = /\.(json|tmp|log)$/;

/** The conversation map is a shared record, not a run: pruning it would forget every live thread. */
export const CONVERSATION_SESSIONS_FILE = "conversation-sessions.json";

/** Age is not evidence of death: a record whose worker pid still answers must survive every prune. */
const holdsLiveWorker = (entry: string): boolean => {
  if (!entry.endsWith(".json")) return false;
  const state = readRunState(entry.slice(0, -".json".length));
  return state !== null && state.status === "running" && isPidAlive(state.workerPid);
};

export const pruneStaleRuns = async (maxAgeMs: number = 24 * 60 * 60 * 1000): Promise<number> => {
  let entries: string[];
  try {
    entries = await fsp.readdir(RUN_STATE_DIR);
  } catch {
    return 0;
  }

  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const entry of entries) {
    if (!STALE_RUN_ENTRY.test(entry)) continue;
    // The conversation map outlives every run it describes: it is state, not litter.
    if (entry === CONVERSATION_SESSIONS_FILE) continue;
    const target = path.join(RUN_STATE_DIR, entry);
    try {
      const stat = await fsp.stat(target);
      if (!stat.isFile() || stat.mtimeMs > cutoff) continue;
      if (holdsLiveWorker(entry)) continue;
      await fsp.unlink(target);
      removed += 1;
    } catch {
      // A vanished or already-reclaimed entry is the desired end state, not an error.
    }
  }
  return removed;
};

/** A Windows replace can be refused while another writer holds the target: retry, never lose the record. */
const renameIntoPlace = async (temp: string, target: string): Promise<void> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fsp.rename(temp, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5 * (attempt + 1)));
    }
  }
};

/** A rename is atomic on NTFS and POSIX alike, so a poller never reads a half-written record. */
export const writeRunState = async (state: RunState): Promise<void> => {
  await fsp.mkdir(RUN_STATE_DIR, { recursive: true });
  const target = runStatePath(state.runId);
  // A shared temp name lets two writers interleave their bytes into one unparseable record.
  const temp = `${target}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(state), "utf8");
  try {
    await renameIntoPlace(temp, target);
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
};

export const readRunState = (runId: string): RunState | null => {
  if (!RUN_ID_PATTERN.test(runId)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(runStatePath(runId), "utf8")) as Partial<RunState> | null;
    if (!parsed || typeof parsed !== "object") return null;
    // Only the shape this module writes is a record: anything else crashes or misleads its readers.
    if (parsed.status !== "running" && parsed.status !== "completed") return null;
    if (parsed.runId !== runId) return null;
    for (const field of [
      "sessionName",
      "worktreePath",
      "branch",
      "repoRoot",
      "baselineTreeSha",
      "initialTreeSha",
      "conversationId",
    ] as const) {
      if (parsed[field] !== undefined && typeof parsed[field] !== "string") return null;
    }
    return parsed as RunState;
  } catch {
    return null;
  }
};

/**
 * A pid is the only evidence a run is still being driven: signalling 0 probes for existence without
 * touching the process. EPERM means it exists but belongs to another user, so treating that as dead
 * would abandon a perfectly live run that merely runs under a different account.
 */
export const isPidAlive = (pid: number | null | undefined): boolean => {
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === "EPERM";
  }
};

/**
 * A record written before liveness existed carries no pid, so an absent pid must mean live: reading
 * a missing pid as dead would drop every in-flight run out of the status listing and prune its worktree.
 */
export const isRunAbandoned = (state: RunState): boolean =>
  state.status === "running" && typeof state.workerPid === "number" && !isPidAlive(state.workerPid);

/**
 * Synchronous because the caller is a status render, and an await between the listing and the
 * records would let a run finish midway and report itself as still active.
 */
export const listActiveRuns = (): RunState[] => {
  let entries: string[];
  try {
    entries = fs.readdirSync(RUN_STATE_DIR);
  } catch {
    // No record has ever been written, or tmpdir was reclaimed: no runs, not an error.
    return [];
  }

  const active: RunState[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    // The conversation map is not a run record: readRunState would reject it anyway, but naming it
    // here keeps a map of every thread out of the per-run loop.
    if (entry === CONVERSATION_SESSIONS_FILE) continue;
    const state = readRunState(entry.slice(0, -".json".length));
    // An abandoned record is still `running` on disk but no process will ever complete it, so it
    // must not keep a worktree alive in the status listing.
    if (state?.status === "running" && !isRunAbandoned(state)) active.push(state);
  }

  // Newest first, so a status listing is stable regardless of readdir order. startedAt is coerced
  // because readRunState only guarantees `status`, and a NaN comparator leaves the order arbitrary.
  const startedAt = (state: RunState): number =>
    typeof state.startedAt === "number" && Number.isFinite(state.startedAt) ? state.startedAt : 0;
  return active.sort((a, b) => startedAt(b) - startedAt(a) || a.runId.localeCompare(b.runId));
};

/** The log is part of the run's state: leaving it behind leaks a full transcript into tmpdir. */
export const clearRunState = async (runId: string): Promise<void> => {
  // Unvalidated, the id would resolve outside the state dir and delete a file this module never wrote.
  if (!RUN_ID_PATTERN.test(runId)) return;
  const statePath = runStatePath(runId);
  await fsp.rm(statePath, { force: true });
  await fsp.rm(`${statePath}.tmp`, { force: true });
  await fsp.rm(runLogPath(runId), { force: true });
  // Each write leaves its own temp name behind if its rename lost the race against this removal.
  const prefix = `${runId}.json.`;
  try {
    for (const entry of await fsp.readdir(RUN_STATE_DIR)) {
      if (entry.startsWith(prefix) && entry.endsWith(".tmp")) {
        await fsp.rm(path.join(RUN_STATE_DIR, entry), { force: true });
      }
    }
  } catch {
    // No state directory left to sweep.
  }
};

/**
 * The thread <-> repository <-> session binding a second dispatch on the same conversation
 * resumes from. It is a cache of what the last turn left behind, so losing it costs context and
 * never correctness: every field is re-derived from the checkout when it is missing.
 */
export interface ConversationSessionRecord {
  conversationId: string;
  repoRoot: string;
  sessionId: string;
  /** The tree the conversation started from: the origin for its cumulative file list. */
  initialTreeSha: string;
  /** The tree the last turn ended on: the baseline for the next turn's delta. */
  lastAfterTreeSha: string;
  updatedAt: number;
}

/** Case- and separator-insensitive, so one repository is one record on every platform. */
const windowsPaths = process.platform === "win32";

const conversationPathKey = (value: string): string => {
  const normal = (windowsPaths ? value.replace(/\//g, "\\").toLowerCase() : value).replace(/[\\/]+$/, "");
  return normal || value;
};

const conversationSessionsPath = (): string => path.join(RUN_STATE_DIR, CONVERSATION_SESSIONS_FILE);

const isConversationRecord = (value: unknown): value is ConversationSessionRecord => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  for (const field of ["conversationId", "repoRoot", "sessionId", "initialTreeSha", "lastAfterTreeSha"] as const) {
    if (typeof record[field] !== "string" || !record[field]) return false;
  }
  return true;
};

/** An unreadable map is an empty one: a corrupted cache must not fail the dispatch that reads it. */
const readConversationRecords = async (): Promise<ConversationSessionRecord[]> => {
  let raw: string;
  try {
    raw = await fsp.readFile(conversationSessionsPath(), "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    const records = Array.isArray(parsed)
      ? parsed
      : (parsed as { records?: unknown } | null)?.records;
    return Array.isArray(records) ? records.filter(isConversationRecord) : [];
  } catch {
    return [];
  }
};

const writeConversationRecords = async (records: ConversationSessionRecord[]): Promise<void> => {
  await fsp.mkdir(RUN_STATE_DIR, { recursive: true });
  const target = conversationSessionsPath();
  // A shared temp name lets two dispatches interleave their bytes into one unparseable map.
  const temp = `${target}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  await fsp.writeFile(temp, JSON.stringify({ version: 1, records }, null, 2), "utf8");
  try {
    await renameIntoPlace(temp, target);
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
};

/** Without a repoRoot the lookup is conversation-wide: callers that know the checkout pass it. */
export const readConversationSession = async (
  conversationId: string,
  repoRoot?: string,
): Promise<ConversationSessionRecord | null> => {
  if (!conversationId) return null;
  const key = repoRoot ? conversationPathKey(repoRoot) : null;
  const records = await readConversationRecords();
  const matches = records.filter((record) => record.conversationId === conversationId);
  if (key === null) return matches[0] ?? null;
  return matches.find((record) => conversationPathKey(record.repoRoot) === key) ?? null;
};

/** A lock left behind by a holder that died must not stop every later write. */
export const CONVERSATION_LOCK_FILE = "conversation-sessions.lock";
const LOCK_POLL_MS = 10;
const LOCK_WAIT_MS = 2_000;
/** A pid is the proof of a live holder; age only decides it when the file names none. */
const LOCK_STALE_MS = 30_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const conversationLockPath = (): string => path.join(RUN_STATE_DIR, CONVERSATION_LOCK_FILE);

const releaseConversationLock = async (): Promise<void> => {
  await fsp.rm(conversationLockPath(), { force: true }).catch(() => undefined);
};

/**
 * A holder that crashed leaves its lock behind. The pid it wrote is the proof: an id that no longer
 * answers means the section it was protecting died with it, and waiting would stall every write.
 */
const lockIsAbandoned = async (): Promise<boolean> => {
  let owner: string;
  let mtimeMs: number;
  try {
    owner = await fsp.readFile(conversationLockPath(), "utf8");
    mtimeMs = (await fsp.stat(conversationLockPath())).mtimeMs;
  } catch {
    // Gone between the failed create and this read: its holder released it, so try the create again.
    return true;
  }
  const pid = Number.parseInt(owner.trim(), 10);
  if (Number.isFinite(pid) && pid > 0) return !isPidAlive(pid);
  // A lock whose owner has not written its pid yet is only old, never abandoned.
  return Date.now() - mtimeMs > LOCK_STALE_MS;
};

/**
 * The map is one shared file, so two writers that read the same base each write back a file without
 * the other's record: the last rename wins and the peer record is silently gone. `wx` is an atomic
 * create on NTFS and POSIX alike, which is what makes a bare lock file safe without a lock daemon.
 */
const withConversationLock = async <T>(work: () => Promise<T>): Promise<T> => {
  await fsp.mkdir(RUN_STATE_DIR, { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  let owned = false;

  for (;;) {
    try {
      const handle = await fsp.open(conversationLockPath(), "wx");
      try {
        await handle.writeFile(String(process.pid), "utf8");
      } finally {
        await handle.close();
      }
      owned = true;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await lockIsAbandoned()) {
        await releaseConversationLock();
        continue;
      }
      if (Date.now() > deadline) {
        // Refusing the write would lose the caller's binding outright, and the section being waited
        // on is a read plus one rename: a holder still inside it this long is stuck, not busy.
        break;
      }
      await sleep(LOCK_POLL_MS);
    }
  }

  try {
    return await work();
  } finally {
    // Only the process that took the lock releases it: a timed-out waiter owns nothing here.
    if (owned) await releaseConversationLock();
  }
};

/**
 * Every mutation is a read-modify-write of that one file, so they queue here as well as on disk: the
 * two dispatches of a multi-turn conversation run in this process, and a queued write cannot read a
 * base its predecessor is about to replace.
 */
let conversationQueue: Promise<unknown> = Promise.resolve();

const mutateConversationMap = <T>(work: () => Promise<T>): Promise<T> => {
  const next = conversationQueue.then(() => withConversationLock(work));
  // A mutation that threw must not poison every write behind it.
  conversationQueue = next.catch(() => undefined);
  return next;
};

export const writeConversationSession = async (record: ConversationSessionRecord): Promise<void> => {
  const key = conversationPathKey(record.repoRoot);
  await mutateConversationMap(async () => {
    const records = await readConversationRecords();
    const kept = records.filter(
      (candidate) =>
        candidate.conversationId !== record.conversationId || conversationPathKey(candidate.repoRoot) !== key,
    );
    await writeConversationRecords([...kept, record]);
  });
};

/** A discarded or cancelled run leaves the checkout at its start tree: the binding no longer holds. */
export const clearConversationSession = async (conversationId: string, repoRoot?: string): Promise<void> => {
  if (!conversationId) return;
  const key = repoRoot ? conversationPathKey(repoRoot) : null;
  await mutateConversationMap(async () => {
    const records = await readConversationRecords();
    const kept = records.filter(
      (candidate) =>
        candidate.conversationId !== conversationId ||
        (key !== null && conversationPathKey(candidate.repoRoot) !== key),
    );
    // Nothing to drop is a no-op: a write here would rewrite a map that already says what it must.
    if (kept.length === records.length) return;
    await writeConversationRecords(kept).catch(() => undefined);
  });
};
