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
      await fsp.unlink(target);
      removed += 1;
    } catch {
      // A vanished or already-reclaimed entry is the desired end state, not an error.
    }
  }
  return removed;
};

/** A rename is atomic on NTFS and POSIX alike, so a poller never reads a half-written record. */
export const writeRunState = async (state: RunState): Promise<void> => {
  void pruneStaleRuns().catch(() => undefined);
  await fsp.mkdir(RUN_STATE_DIR, { recursive: true });
  const target = runStatePath(state.runId);
  await fsp.writeFile(`${target}.tmp`, JSON.stringify(state), "utf8");
  await fsp.rename(`${target}.tmp`, target);
};

export const readRunState = (runId: string): RunState | null => {
  if (!RUN_ID_PATTERN.test(runId)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(runStatePath(runId), "utf8")) as RunState;
    return parsed && typeof parsed === "object" && typeof parsed.status === "string" ? parsed : null;
  } catch {
    return null;
  }
};

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
    if (state?.status === "running") active.push(state);
  }

  // Newest first, so a status listing is stable regardless of readdir order. startedAt is coerced
  // because readRunState only guarantees `status`, and a NaN comparator leaves the order arbitrary.
  const startedAt = (state: RunState): number =>
    typeof state.startedAt === "number" && Number.isFinite(state.startedAt) ? state.startedAt : 0;
  return active.sort((a, b) => startedAt(b) - startedAt(a) || a.runId.localeCompare(b.runId));
};

/** The log is part of the run's state: leaving it behind leaks a full transcript into tmpdir. */
export const clearRunState = async (runId: string): Promise<void> => {
  await fsp.rm(runStatePath(runId), { force: true });
  await fsp.rm(`${runStatePath(runId)}.tmp`, { force: true });
  await fsp.rm(runLogPath(runId), { force: true });
};
