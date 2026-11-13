import { spawn, type ChildProcess } from "node:child_process";

export const isWindows = process.platform === "win32";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** 16MB per stream: a runaway command must not be able to exhaust the host's memory. */
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const TRUNCATION_MARKER = "[output truncated at 16MB]";
const EXIT_GRACE_MS = 200;
const KILL_FALLBACK_MS = 500;

interface Capture {
  text: string;
  bytes: number;
  truncated: boolean;
}

const newCapture = (): Capture => ({ text: "", bytes: 0, truncated: false });

const append = (capture: Capture, chunk: string): void => {
  if (capture.truncated) return;
  const chunkBytes = Buffer.byteLength(chunk, "utf8");
  if (capture.bytes + chunkBytes <= MAX_BUFFER_BYTES) {
    capture.text += chunk;
    capture.bytes += chunkBytes;
    return;
  }
  const room = MAX_BUFFER_BYTES - capture.bytes;
  if (room > 0) capture.text += Buffer.from(chunk, "utf8").subarray(0, room).toString("utf8");
  capture.bytes = MAX_BUFFER_BYTES;
  capture.truncated = true;
  capture.text += `\n${TRUNCATION_MARKER}`;
};

/**
 * `taskkill /T` is the only kill that reaches a detached grandchild tree on Windows. Exported on its
 * own because a run's child can outlive the handle that spawned it: cancelling only has the pid.
 */
export const killProcessTree = (pid: number | null | undefined): void => {
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) return;
  if (isWindows) {
    try {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
        detached: true,
      });
      killer.on("error", () => {});
      killer.unref();
      return;
    } catch {
      // fall through to the direct kill
    }
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
};

const killTree = (child: ChildProcess, pid: number | undefined): void => {
  if (pid !== undefined) {
    killProcessTree(pid);
    return;
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // already gone
  }
};

/**
 * Run a command to completion. Never throws on a non-zero exit: the caller decides what a
 * failure means. `windowsHide` keeps the console window from flashing on every git/python call.
 * Settles on 'exit' with a short grace window, because a surviving detached grandchild that
 * inherited the pipes keeps 'close' from ever firing.
 */
export const run = (
  file: string,
  args: string[],
  options: RunOptions = {},
): Promise<RunResult> =>
  new Promise((resolve) => {
    const stdout = newCapture();
    const stderr = newCapture();
    let timedOut = false;
    let settled = false;
    let exitCode: number | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;
    let graceTimer: NodeJS.Timeout | null = null;
    let fallbackTimer: NodeJS.Timeout | null = null;

    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const settle = (code: number | null, error?: string): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (graceTimer) clearTimeout(graceTimer);
      if (fallbackTimer) clearTimeout(fallbackTimer);
      timeoutTimer = graceTimer = fallbackTimer = null;
      resolve({
        code,
        stdout: stdout.text,
        stderr: stderr.text,
        timedOut,
        ...(error === undefined ? {} : { error }),
      });
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => append(stdout, chunk));
    child.stderr?.on("data", (chunk: string) => append(stderr, chunk));

    if (options.timeoutMs) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        killTree(child, child.pid);
        fallbackTimer = setTimeout(() => settle(exitCode), KILL_FALLBACK_MS);
      }, options.timeoutMs);
    }

    child.on("error", (error: Error) => settle(null, error.message));
    child.on("exit", (code: number | null) => {
      exitCode = code;
      if (settled) return;
      graceTimer = setTimeout(() => settle(code), EXIT_GRACE_MS);
    });
    child.on("close", (code: number | null) => settle(code ?? exitCode));
  });

export interface GitResult extends RunResult {
  ok: boolean;
}

export const runGit = async (
  cwd: string,
  args: string[],
  options: Pick<RunOptions, "env"> = {},
): Promise<GitResult> => {
  const result = await run("git", args, { cwd, env: options.env, timeoutMs: 120_000 });
  return { ...result, ok: result.code === 0 };
};

export const gitOrThrow = async (cwd: string, args: string[]): Promise<string> => {
  const result = await runGit(cwd, args);
  if (!result.ok) {
    throw new Error(`git ${args.join(" ")} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout.trim();
};
