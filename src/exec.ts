import { spawn } from "node:child_process";

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

/**
 * Run a command to completion. Never throws on a non-zero exit: the caller decides what a
 * failure means. `windowsHide` keeps the console window from flashing on every git/python call.
 */
export const run = (
  file: string,
  args: string[],
  options: RunOptions = {},
): Promise<RunResult> =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, options.timeoutMs)
      : null;

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error: Error) => {
      if (timer) clearTimeout(timer);
      resolve({ code: null, stdout, stderr, timedOut, error: error.message });
    });
    child.on("close", (code: number | null) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });

export interface GitResult extends RunResult {
  ok: boolean;
}

export const runGit = async (cwd: string, args: string[]): Promise<GitResult> => {
  const result = await run("git", args, { cwd, timeoutMs: 120_000 });
  return { ...result, ok: result.code === 0 };
};

export const gitOrThrow = async (cwd: string, args: string[]): Promise<string> => {
  const result = await runGit(cwd, args);
  if (!result.ok) {
    throw new Error(`git ${args.join(" ")} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout.trim();
};
