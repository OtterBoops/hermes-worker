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

/** A rename is atomic on NTFS and POSIX alike, so a poller never reads a half-written record. */
export const writeRunState = async (state: RunState): Promise<void> => {
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

export const clearRunState = async (runId: string): Promise<void> => {
  await fsp.rm(runStatePath(runId), { force: true });
  await fsp.rm(`${runStatePath(runId)}.tmp`, { force: true });
};
