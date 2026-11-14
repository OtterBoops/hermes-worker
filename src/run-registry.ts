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
  worktreePath: string;
  branch: string;
  startedAt: number;
  result?: unknown;
  /** The dispatcher's own pid: the only field that can tell a crashed run from a slow one. */
  workerPid?: number;
  /** The runner child's pid, for diagnostics only: the worker outlives it by design. */
  childPid?: number;
  sessionId?: string | null;
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
  void pruneStaleRuns().catch(() => undefined);
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
    for (const field of ["sessionName", "worktreePath", "branch"] as const) {
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
