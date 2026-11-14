import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { isWindows, killProcessTree, runGit } from "./exec.js";
import {
  BLOCKED_PATH_PATTERNS,
  injectWorkerBoundary,
  scanPromptForSecrets,
  validateModifiedFiles,
} from "./guardrails.js";
import { hermesCommand, hermesExe, stateDbPath } from "./hermes-paths.js";
import {
  collectNewPendingWrites,
  snapshotPendingIds,
  type PendingRecord,
} from "./memory-manager.js";
import { resolveAntigravityProject, type ResolvedProject } from "./project-binding.js";
import { createStreamFormatter, openRunLog, type RunLog } from "./run-log.js";
import {
  RUN_ID_PATTERN,
  clearRunState,
  isPidAlive,
  listActiveRuns,
  readRunState,
  runLogPath,
  writeRunState,
  type RunState,
} from "./run-registry.js";

export interface DispatchOptions {
  prompt: string;
  cwd?: string;
  conversationId?: string;
  project?: string;
  sessionName?: string;
  model?: string;
  reasoning?: string;
  skills?: string[];
  timeoutSeconds?: number;
  /** How long the tool call may block before it answers with a running descriptor. */
  fastWaitSeconds?: number;
  /** Land a clean worktree diff on the caller's checkout instead of leaving it for review. */
  autoApply?: boolean;
  /** Return the diff body even when autoApply already wrote it to the checkout. */
  includeDiff?: boolean;
  runId?: string;
}

/** Pinned so a dispatch is reproducible regardless of what Hermes' config was last set to. */
export const DEFAULT_MODEL = "deepseek-v4.1-flash";
export const DEFAULT_REASONING = "high";
export const DEFAULT_TIMEOUT_SECONDS = 1800;
export const DEFAULT_FAST_WAIT_SECONDS = 1;

export interface ToolEvent {
  type: string;
  name?: string;
  detail?: string;
}

export interface DispatchResult {
  /** Present on every answer: `running` means the run outlived the fast-wait window. */
  status?: "completed" | "running";
  runId: string;
  success: boolean;
  sessionId: string | null;
  sessionName: string;
  project: ResolvedProject | null;
  worktreePath: string | null;
  branch: string | null;
  baseSha: string | null;
  modifiedFiles: string[];
  diff: string;
  diffTruncated: boolean;
  /** True when the diff body was withheld because autoApply already landed it on the checkout. */
  diffOmitted?: boolean;
  summary: string;
  reasoning: string | null;
  /** What actually answered, which is not always what was requested: Hermes falls back on 429. */
  model: string | null;
  provider: string | null;
  /** True when the Go allowance was refused and a different model answered. Treated as a hard failure —
   * the dispatch never silently lands on a fallback model. */
  modelFallback: boolean;
  warning: string | null;
  toolEvents: ToolEvent[];
  tokens: Record<string, unknown> | null;
  /** Billed cost from the native ledger; null when the run reported none, never 0 for an unknown. */
  costUsd?: number | null;
  durationMs: number | null;
  exitCode: number | null;
  error: string | null;
  timedOut: boolean;
  securityViolation: boolean;
  violations: string[];
  pendingWrites: PendingRecord[];
  worktreeKept: boolean;
  /** True only when autoApply landed the diff on the caller's checkout. */
  applied?: boolean;
  /** True when the fallback model answered turn 1 and the child was killed before it could finish. */
  abortedFallback: boolean;
  /** True when hermes_worktree_action cancelled the run while it was executing. */
  cancelled: boolean;
  message: string;
}

/** The answer to a call whose run is still going: nothing was killed and nothing was cleaned up. */
export interface RunningDispatchResult {
  status: "running";
  success: true;
  runId: string;
  sessionId: string | null;
  sessionName: string;
  project: ResolvedProject | null;
  worktreePath: string;
  branch: string;
  baseSha: string;
  waitCommand: string;
  message: string;
}

export type DispatchOutcome = DispatchResult | RunningDispatchResult;

const MAX_DIFF_CHARS = 400_000;
const BRANCH_PATTERN = /^hermes\/agy-[A-Za-z0-9_-]+$/;
/** `.env` itself is secret, `.env.example` is the documented template. */
const ENV_TEMPLATE = /^\.env\.(example|template)$/i;

const truncateTitle = (prompt: string, limit: number): string => {
  const flat = prompt.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
};

const makeRunId = (): string => {
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${suffix}`;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const tokenNumber = (record: Record<string, unknown>, keys: string[]): number => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return 0;
};

/**
 * Total across the bare (Hermes stream-json), Anthropic- and OpenAI-shaped usage records the
 * stream can carry.
 */
const totalTokens = (tokens: Record<string, unknown> | null): number | null => {
  if (!tokens) return null;
  const reported = tokenNumber(tokens, ["total", "total_tokens"]);
  if (reported > 0) return reported;
  // reasoning is a subset of output and cache_write is billed input: summing either double-counts.
  const sum =
    tokenNumber(tokens, ["input", "input_tokens", "prompt_tokens"]) +
    tokenNumber(tokens, ["output", "output_tokens", "completion_tokens"]) +
    tokenNumber(tokens, [
      "cache_read",
      "cache_read_input_tokens",
      "cache_read_tokens",
      "cached_tokens",
      "prompt_cache_hit_tokens",
    ]);
  return sum > 0 ? sum : null;
};

/** Runtime metadata for a finished run; each segment is omitted rather than left empty. */
export const runMetadata = (
  result: Pick<DispatchResult, "durationMs" | "sessionId" | "tokens">,
): { duration: string; brackets: string } => {
  const duration =
    typeof result.durationMs === "number" && Number.isFinite(result.durationMs)
      ? ` in ${(result.durationMs / 1000).toFixed(1)}s`
      : "";
  const brackets = [
    result.sessionId ? `[session: ${result.sessionId}]` : "",
    totalTokens(result.tokens) !== null ? `[tokens: ${totalTokens(result.tokens)}]` : "",
  ]
    .filter((part) => part.length > 0)
    .join(" ");
  return { duration, brackets: brackets ? ` ${brackets}` : "" };
};

/**
 * Verdict of a fast-wait race: `done: false` means the run is still going and the caller gets a
 * running descriptor instead of a result. The timer is always cleared so no handle is left behind.
 */
export const raceFastWait = async <T>(
  completion: Promise<T>,
  fastWaitSeconds: number,
): Promise<{ done: true; value: T } | { done: false }> => {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race<{ done: true; value: T } | { done: false }>([
      completion.then((value) => ({ done: true as const, value })),
      new Promise<{ done: false }>((resolve) => {
        timer = setTimeout(() => resolve({ done: false }), Math.max(0, fastWaitSeconds) * 1000);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
};

/**
 * `.worktrees/` goes into .git/info/exclude, never the tracked .gitignore: a dirty .gitignore
 * would show up in every diff the bridge captures.
 */
const ensureWorktreesExcluded = async (repoRoot: string): Promise<void> => {
  const result = await runGit(repoRoot, ["rev-parse", "--git-path", "info/exclude"]);
  if (!result.ok) throw new Error(`Not a git repository: ${repoRoot}`);
  const raw = result.stdout.trim();
  const excludePath = path.isAbsolute(raw) ? raw : path.resolve(repoRoot, raw);
  await fsp.mkdir(path.dirname(excludePath), { recursive: true });

  let current = "";
  try {
    current = await fsp.readFile(excludePath, "utf8");
  } catch {
    current = "";
  }
  const present = current
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line === ".worktrees" || line === ".worktrees/" || line === "/.worktrees/");
  if (present) return;

  const separator = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  await fsp.appendFile(excludePath, `${separator}/.worktrees/\n`, "utf8");
};

const normalisePath = (value: string): string => {
  const resolved = path.resolve(value).replace(/[\\/]+$/, "");
  return isWindows ? resolved.toLowerCase() : resolved;
};

const samePath = (left: string, right: string): boolean =>
  normalisePath(left) === normalisePath(right);

const isInsidePath = (root: string, target: string): boolean => {
  const normalRoot = normalisePath(root);
  const normalTarget = normalisePath(target);
  return normalTarget === normalRoot || normalTarget.startsWith(normalRoot + path.sep);
};

interface WorktreeEntry {
  path: string;
  branch: string | null;
  locked: boolean;
}

const listWorktrees = async (repoRoot: string): Promise<WorktreeEntry[]> => {
  const result = await runGit(repoRoot, ["worktree", "list", "--porcelain"]);
  if (!result.ok) return [];
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: line.slice("worktree ".length).trim(), branch: null, locked: false };
    } else if (line.startsWith("branch ") && current) {
      current.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    } else if (line === "locked" || line.startsWith("locked ")) {
      if (current) current.locked = true;
    }
  }
  if (current) entries.push(current);
  return entries;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A cancellation is a terminal record written by another process, so it is read, not remembered. */
const isRunCancelled = (runId: string): boolean => {
  const state = readRunState(runId);
  const result = state?.result;
  return Boolean(result && typeof result === "object" && (result as { cancelled?: unknown }).cancelled === true);
};

const REMOVE_MAX_RETRIES = 5;
const REMOVE_RETRY_DELAY_MS = 200;
const REMOVE_MAX_DELAY_MS = 2_000;
const CHILD_EXIT_WAIT_ATTEMPTS = 20;
const CHILD_EXIT_WAIT_MS = 100;

/**
 * A live child keeps its worktree directory open, so a removal that races it fails EBUSY on Windows
 * until the process exits. Killing is not enough on its own: the caller must also wait, or the child
 * writes into a directory the next line deletes.
 */
const stopChildProcess = async (pid: number | null | undefined): Promise<boolean> => {
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0 || pid === process.pid) return false;
  if (!isPidAlive(pid)) return false;
  killProcessTree(pid);
  for (let attempt = 0; attempt < CHILD_EXIT_WAIT_ATTEMPTS && isPidAlive(pid); attempt += 1) await sleep(CHILD_EXIT_WAIT_MS);
  return !isPidAlive(pid);
};

/**
 * Windows keeps a directory handle open for a moment after the process that owned it exits, so a
 * single removal attempt fails EPERM/EBUSY and the directory leaks on disk. Retry with backoff.
 */
const removeDirectory = async (
  target: string,
  options: { maxRetries?: number; retryDelay?: number } = {},
): Promise<{ ok: boolean; error?: string }> => {
  const maxRetries = options.maxRetries ?? REMOVE_MAX_RETRIES;
  const retryDelay = options.retryDelay ?? REMOVE_RETRY_DELAY_MS;
  let lastError: string | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (!fs.existsSync(target)) return { ok: true };
    try {
      // The backoff here is the whole strategy: a nested retry would multiply it by the attempt count.
      await fsp.rm(target, { recursive: true, force: true, maxRetries: 0 });
    } catch (error) {
      lastError = errorMessage(error);
    }
    if (!fs.existsSync(target)) return { ok: true };
    if (attempt < maxRetries) await sleep(Math.min(retryDelay * 2 ** attempt, REMOVE_MAX_DELAY_MS));
  }

  return { ok: false, error: lastError ?? `${target} could not be removed` };
};

/**
 * Removal is idempotent and reports only what it could not achieve: a locked worktree is unlocked
 * first, a directory git refuses to remove is swept from disk and pruned, and a branch git no
 * longer knows is tolerated. A path gone from disk with no registration left is a clean removal
 * however it got there, so git's refusal alone is never recorded as a failure.
 */
const removeWorktree = async (
  repoRoot: string,
  worktreePath: string,
  branch: string,
): Promise<{ ok: boolean; error?: string }> => {
  const errors: string[] = [];
  const entry = (await listWorktrees(repoRoot)).find((candidate) => samePath(candidate.path, worktreePath));

  if (entry?.locked) {
    const unlocked = await runGit(repoRoot, ["worktree", "unlock", worktreePath]);
    if (!unlocked.ok && !/not locked/i.test(unlocked.stderr)) {
      errors.push(`git worktree unlock failed: ${(unlocked.stderr || unlocked.stdout).trim()}`);
    }
  }

  // git validates the worktree's own `.git` file before removing anything, so a damaged or
  // half-deleted worktree is refused with the directory left in place. Deleting it ourselves and
  // pruning the admin record reaches the same end state, which is what actually matters here.
  if (fs.existsSync(worktreePath)) {
    await runGit(repoRoot, ["worktree", "remove", "--force", worktreePath]);
  }
  if (fs.existsSync(worktreePath)) {
    const swept = await removeDirectory(worktreePath);
    if (!swept.ok) errors.push(`could not delete ${worktreePath}: ${swept.error}`);
  }

  // Pruned before the branch: git refuses `branch -D` while a registration still points at it.
  if (!fs.existsSync(worktreePath)) {
    const stillRegistered = (await listWorktrees(repoRoot)).some((candidate) =>
      samePath(candidate.path, worktreePath),
    );
    if (stillRegistered) {
      await runGit(repoRoot, ["worktree", "prune"]);
      const afterPrune = (await listWorktrees(repoRoot)).some((candidate) =>
        samePath(candidate.path, worktreePath),
      );
      if (afterPrune) errors.push(`git worktree prune left ${worktreePath} registered`);
    }
  }

  const deleted = await runGit(repoRoot, ["branch", "-D", branch]);
  if (!deleted.ok && !/not found/i.test(`${deleted.stderr}${deleted.stdout}`)) {
    errors.push(`git branch -D ${branch} failed: ${(deleted.stderr || deleted.stdout).trim()}`);
  }

  return errors.length > 0 ? { ok: false, error: errors[0] } : { ok: true };
};

/**
 * Orphaned worktrees are what a crashed or interrupted bridge leaves behind: a directory on disk
 * that no run owns. A running run's worktree is never touched, and neither is its branch — the
 * branch may hold the only copy of work that has not been reviewed yet.
 */
export const pruneOrphanWorktrees = async (repoRoot: string): Promise<number> => {
  // Resolved rather than assumed: a call from a subdirectory must still sweep the root the
  // worktrees hang off, and resolving the root itself is a no-op.
  const topLevel = await runGit(repoRoot, ["rev-parse", "--show-toplevel"]);
  if (!topLevel.ok) return 0;
  const root = path.resolve(topLevel.stdout.trim());
  const worktreesRoot = path.join(root, ".worktrees");
  let entries: string[];
  try {
    entries = await fsp.readdir(worktreesRoot);
  } catch {
    // Never dispatched from this repository, or the directory was already swept.
    return 0;
  }

  const active = listActiveRuns();
  const activeIds = new Set(active.map((run) => run.runId));
  const activePaths = active.map((run) => run.worktreePath).filter((value) => Boolean(value));

  let removed = 0;
  for (const entry of entries) {
    if (!entry.startsWith("agy-")) continue;
    const target = path.join(worktreesRoot, entry);
    if (activeIds.has(entry.slice("agy-".length))) continue;
    if (activePaths.some((activePath) => samePath(activePath, target))) continue;

    let stat: Awaited<ReturnType<typeof fsp.lstat>>;
    try {
      stat = await fsp.lstat(target);
    } catch {
      continue;
    }
    // lstat, then reject links: rm -r follows a junction and would delete outside the tree.
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;

    // A crashed run can leave its child behind, and the sweep is the last caller that will ever
    // reap it: the directory stays EBUSY for as long as that process holds it.
    const abandoned = readRunState(entry.slice("agy-".length));
    if (abandoned && typeof abandoned.worktreePath === "string" && samePath(abandoned.worktreePath, target)) {
      await stopChildProcess(abandoned.childPid);
    }

    const swept = await removeDirectory(target);
    if (swept.ok) removed += 1;
  }

  // A registration whose directory is already gone is the same leak with nothing left to delete.
  const staleRegistration = (await listWorktrees(root)).some(
    (candidate) =>
      isInsidePath(worktreesRoot, candidate.path) &&
      path.basename(candidate.path).startsWith("agy-") &&
      !fs.existsSync(candidate.path),
  );
  if (removed > 0 || staleRegistration) await runGit(root, ["worktree", "prune"]);

  return removed;
};

/** Cleanup that must never mask the failure it is cleaning up after. */
const destroyWorktree = async (repoRoot: string, worktreePath: string, branch: string): Promise<void> => {
  await removeWorktree(repoRoot, worktreePath, branch).catch(() => undefined);
};

const splitNul = (value: string): string[] => value.split("\0").filter((entry) => entry.length > 0);

interface StreamState {
  sessionId: string | null;
  text: string;
  toolEvents: ToolEvent[];
  tokens: Record<string, unknown> | null;
  exitCode: number | null;
  durationMs: number | null;
  isError: boolean;
  error: string | null;
}

/**
 * Calls only, never results: a result's payload is the run log's job, and copying 200 characters of
 * every read into the returned result bills the caller for output nothing reads.
 */
const collectToolEvents = (node: unknown, sink: ToolEvent[], depth = 0): void => {
  if (!node || typeof node !== "object" || depth > 6) return;
  if (Array.isArray(node)) {
    for (const item of node) collectToolEvents(item, sink, depth + 1);
    return;
  }
  const record = node as Record<string, unknown>;
  if (record.type === "tool_use") {
    sink.push({
      type: "tool_use",
      name: String(record.name ?? "tool"),
      detail: String(record.id ?? ""),
    });
  }
  for (const value of Object.values(record)) {
    if (value && typeof value === "object") collectToolEvents(value, sink, depth + 1);
  }
};

const ingestStreamLine = (line: string, state: StreamState): void => {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return;
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return;
  }
  const type = String(event.type ?? "");
  const sessionId = event.session_id ?? event.sessionId;
  if (typeof sessionId === "string" && sessionId) state.sessionId = sessionId;

  if (type === "result") {
    const text = event.result ?? event.text ?? event.response;
    if (typeof text === "string" && text) state.text = text;
    const usage = event.usage ?? event.tokens;
    if (usage && typeof usage === "object") state.tokens = usage as Record<string, unknown>;
    if (typeof event.exit_code === "number") state.exitCode = event.exit_code;
    if (typeof event.duration_ms === "number") state.durationMs = event.duration_ms;
    if (event.is_error === true) state.isError = true;
    if (typeof event.error === "string" && event.error) state.error = event.error;
  }
  collectToolEvents(event, state.toolEvents);
};

interface HermesRun {
  state: StreamState;
  timedOut: boolean;
  spawnError: string | null;
  stderr: string;
  code: number | null;
  childPid: number | null;
  /** Turn 1 was already answered by the fallback model, so the child was killed before it wrote more. */
  abortedFallback: boolean;
}

export interface ChatArgsOptions {
  promptFile: string;
  worktreePath: string;
  sessionName: string;
  model?: string;
  reasoning?: string;
  skills?: string[];
  /** The per-run usage ledger. A top-level flag, so it cannot travel with the chat arguments. */
  usageFile?: string;
}

export const buildChatArgs = (options: ChatArgsOptions): string[] => {
  const args = [
    // Before `chat`: argparse rejects --usage-file as an unknown chat argument after the subcommand.
    ...(options.usageFile ? ["--usage-file", options.usageFile] : []),
    "chat",
    "--query-file",
    options.promptFile,
    "--format",
    "stream-json",
    "--in",
    options.worktreePath,
    "-c",
    options.sessionName,
    "--create-if-missing",
    "--yolo",
    // The gateway only admits its own SURFACES labels (cli, tui, gui, acp, tool, oneshot):
    // an invented label is refused. `oneshot` would hide the session from Desktop pickers,
    // so the explicit `cli` label is what keeps a dispatch visible and resumable.
    "--source",
    "cli",
    "--provider",
    "opencode-go",
    "--model",
    options.model || DEFAULT_MODEL,
    "--reasoning",
    options.reasoning || DEFAULT_REASONING,
  ];
  // No --run-budget: the gateway CLI refuses it outright (exit 2, "Unsupported gateway CLI
  // options") and points at agent.run_budget_seconds. The process timeout in execHermes
  // is the only budget a dispatch actually gets.
  if (options.skills?.length) args.push("--skills", options.skills.join(","));
  return args;
};

/**
 * GIT_CONFIG_* is the documented way to set git config for one process tree: the value applies to
 * every git the child spawns and dies with it. `git config core.hooksPath` instead mutates the
 * caller's repository, so a crash leaves their hooks silently disabled, and two concurrent
 * dispatches fight over the single setting.
 */
export const sandboxedGitEnv = (
  base: NodeJS.ProcessEnv,
  emptyHooksDir: string,
  repoRoot: string,
): NodeJS.ProcessEnv => {
  const pathKey = Object.keys(base).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  const binDir = path.join(repoRoot, "node_modules", ".bin");
  const currentPath = base[pathKey] ?? "";
  return {
    ...base,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: emptyHooksDir,
    // A repo-local binary (tsc, tsx) is only on PATH through here: a bare `pnpm run build` inside
    // the worktree would otherwise resolve nothing and report a spurious command-not-found.
    [pathKey]: currentPath ? `${binDir}${path.delimiter}${currentPath}` : binDir,
  };
};

interface ExecHermesOptions {
  args: string[];
  cwd: string;
  timeoutSeconds: number;
  /** The worktree's repository root, needed to read the session row for the turn-1 fallback check. */
  repoRoot: string;
  /** Layered child environment: hook sandboxing and the repo-local bin directory ride here. */
  env: NodeJS.ProcessEnv;
  onSessionId?: (sessionId: string) => void;
  onChildPid?: (pid: number) => void;
  /** `log` receives every formatted line as the child emits it, which is what makes the run tailable. */
  log?: RunLog;
}

const execHermes = (options: ExecHermesOptions): Promise<HermesRun> =>
  new Promise((resolve) => {
    const { args, cwd, timeoutSeconds, repoRoot, env, onSessionId, onChildPid, log } = options;
    // One formatter per run: correlating a result to its tool needs the ids this run has seen.
    const format = createStreamFormatter();
    const state: StreamState = {
      sessionId: null,
      text: "",
      toolEvents: [],
      tokens: null,
      exitCode: null,
      durationMs: null,
      isError: false,
      error: null,
    };

    const command = hermesCommand();
    const child = spawn(command.file, [...command.prefixArgs, ...args], {
      cwd,
      windowsHide: true,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (child.pid) onChildPid?.(child.pid);

    let buffer = "";
    let stderr = "";
    let stderrBuffer = "";
    let timedOut = false;
    let spawnError: string | null = null;
    // The gateway writes gateway_runtime as turn 1 gets under way, so a single probe can land
    // before the row exists. A few bounded probes cover that window without polling forever.
    let fallbackProbes = 0;
    let turnOneSeen = false;
    let abortedFallback = false;

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid && isWindows) {
        spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      } else {
        child.kill("SIGKILL");
      }
    }, timeoutSeconds * 1000);

    /**
     * The pinned model is a contract, not a preference: a turn already answered by the fallback
     * means the diff cannot be reviewed, so continuing spends quota on output that will be thrown
     * away. Probed only until turn 1 produces something, then never again.
     */
    const abortOnFallback = (): void => {
      if (abortedFallback || turnOneSeen || !state.sessionId || fallbackProbes >= 3) return;
      fallbackProbes += 1;
      if (!readSessionAfterRun(state.sessionId, repoRoot).fallbackActive) return;
      abortedFallback = true;
      killProcessTree(child.pid);
    };

    const readSessionLine = (line: string): void => {
      const sessionId = parseSessionIdLine(line);
      if (!sessionId) return;
      // The stream's own id wins: a compaction can advance the row past the one printed at start.
      if (!state.sessionId) state.sessionId = sessionId;
      onSessionId?.(state.sessionId);
      abortOnFallback();
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const previous = state.sessionId;
        ingestStreamLine(line, state);
        log?.write(format(line));
        if (state.sessionId && state.sessionId !== previous) onSessionId?.(state.sessionId);
        abortOnFallback();
        // The turn has produced its first step: any fallback it was going to report is on disk.
        if (state.toolEvents.length > 0 || state.text) turnOneSeen = true;
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 40_000) stderr = stderr.slice(-40_000);
      stderrBuffer += chunk;
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() ?? "";
      for (const line of lines) readSessionLine(line);
    });

    child.on("error", (error: Error) => {
      spawnError = error.message;
    });

    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (buffer.trim()) {
        const previous = state.sessionId;
        ingestStreamLine(buffer, state);
        log?.write(format(buffer));
        if (state.sessionId && state.sessionId !== previous) onSessionId?.(state.sessionId);
      }
      resolve({ state, timedOut, spawnError, stderr, code, childPid: child.pid ?? null, abortedFallback });
    });
  });

export interface GatewayRuntime {
  provider: string | null;
  fallbackActive: boolean;
}

interface GatewayRuntimeDetail extends GatewayRuntime {
  /** True only when model_config is JSON carrying a gateway_runtime object. */
  parsed: boolean;
}

const parseGatewayRuntimeDetail = (modelConfig: string | null | undefined): GatewayRuntimeDetail => {
  try {
    const parsed = JSON.parse(modelConfig ?? "") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { provider: null, fallbackActive: false, parsed: false };
    }
    const runtime = (parsed as { gateway_runtime?: unknown }).gateway_runtime;
    if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) {
      return { provider: null, fallbackActive: false, parsed: false };
    }
    const record = runtime as Record<string, unknown>;
    return {
      provider: typeof record.provider === "string" ? record.provider : null,
      fallbackActive: record.fallback_active === true,
      parsed: true,
    };
  } catch {
    return { provider: null, fallbackActive: false, parsed: false };
  }
};

export const parseGatewayRuntime = (modelConfig: string | null | undefined): GatewayRuntime => {
  const detail = parseGatewayRuntimeDetail(modelConfig);
  return { provider: detail.provider, fallbackActive: detail.fallbackActive };
};

interface SessionAfterRun {
  reasoning: string | null;
  model: string | null;
  provider: string | null;
  fallbackActive: boolean;
  /** False when the row is missing or model_config carries no gateway_runtime record. */
  known: boolean;
}

export const readSessionAfterRun = (sessionId: string, repoRoot: string): SessionAfterRun => {
  const unknown: SessionAfterRun = {
    reasoning: null,
    model: null,
    provider: null,
    fallbackActive: false,
    known: false,
  };
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(stateDbPath());
    db.exec("PRAGMA busy_timeout = 3000");
  } catch {
    db?.close();
    return unknown;
  }

  try {
    // Re-anchoring is a convenience for Desktop: a read-only or locked DB must not cost us the
    // model attribution below, so the write gets its own failure domain.
    try {
      db.prepare("UPDATE sessions SET cwd = ?, git_repo_root = ? WHERE id = ?").run(
        repoRoot,
        repoRoot,
        sessionId,
      );
    } catch {
      // Attribution is still readable without it.
    }

    let session: { model?: string | null; model_config?: string | null } | undefined;
    try {
      session = db
        .prepare("SELECT model, model_config FROM sessions WHERE id = ?")
        .get(sessionId) as { model?: string | null; model_config?: string | null } | undefined;
    } catch {
      return unknown;
    }
    if (!session) return unknown;

    let reasoning: string | null = null;
    try {
      const message = db
        .prepare(
          `SELECT reasoning, reasoning_content FROM messages
            WHERE session_id = ? AND role = 'assistant'
            ORDER BY id DESC LIMIT 1`,
        )
        .get(sessionId) as { reasoning?: string | null; reasoning_content?: string | null } | undefined;
      reasoning = message?.reasoning_content ?? message?.reasoning ?? null;
    } catch {
      reasoning = null;
    }

    const runtime = parseGatewayRuntimeDetail(session.model_config);
    return {
      reasoning,
      model: session.model ?? null,
      provider: runtime.provider,
      fallbackActive: runtime.fallbackActive,
      // A row that names its model is an attribution, whether or not Hermes also wrote a routing
      // record: only a minority of sessions carry gateway_runtime at all.
      known: typeof session.model === "string" && session.model.trim().length > 0,
    };
  } catch {
    return unknown;
  } finally {
    db?.close();
  }
};

/**
 * The native usage ledger `hermes --usage-file` writes, which is the only source that names the
 * model actually billed for the turn: `state.db` is written by the gateway and can be missing or
 * stale for a run that is still settling. Every field is optional because a failed run writes a
 * partial report (costs null, tokens zero) rather than no file at all.
 */
export interface UsageReport {
  model: string | null;
  provider: string | null;
  sessionId: string | null;
  tokens: Record<string, number> | null;
  /** Null when the ledger named no cost: a coerced 0 would claim the run was free. */
  costUsd: number | null;
  /** How the ledger derived the cost (estimated/reported/unknown), null when it said nothing. */
  costSource: string | null;
  failed: boolean;
  failure: string | null;
}

const usageText = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const usageNumber = (record: Record<string, unknown>, key: string): number => {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
};

/** Kept separate from usageNumber: a missing cost has to stay null, not become a free run. */
const usageCost = (record: Record<string, unknown>, key: string): number | null => {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
};

/**
 * The ledger echoes whatever the provider named itself, sometimes without the `provider/` prefix the
 * dispatch was configured with. Comparing the bare model id keeps a spelling difference from being
 * read as a fallback, which is a hard failure, while a genuinely different model still shows up.
 */
const sameModelId = (left: string, right: string): boolean => {
  const bare = (value: string): string => value.trim().toLowerCase().split("/").pop() ?? "";
  return left.trim().toLowerCase() === right.trim().toLowerCase() || bare(left) === bare(right);
};

/** Null when the run wrote no ledger: an absent report is not an attribution of "unknown model". */
export const readUsageReport = (usageFile: string | null | undefined): UsageReport | null => {
  if (!usageFile) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(usageFile, "utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const record = parsed as Record<string, unknown>;
  // Hermes reports bare underscore keys; the camelCase and Anthropic spellings are accepted so a
  // provider-side report shape still lands in the same buckets.
  // Spelled the way the telemetry readers already read a stream usage record: a camelCase key here
  // would merge into the result and then vanish from every total that counts cache tokens.
  const tokens = {
    input: usageNumber(record, "input_tokens") || usageNumber(record, "input"),
    output: usageNumber(record, "output_tokens") || usageNumber(record, "output"),
    cache_read: usageNumber(record, "cache_read_tokens") || usageNumber(record, "cache_read"),
    // Reasoning is billed inside output, so it is reported beside it and never added to the total.
    reasoning: usageNumber(record, "reasoning_tokens") || usageNumber(record, "reasoning"),
    // Cache writes are billed as input; the Anthropic spelling is what a provider-side report uses.
    cache_write:
      usageNumber(record, "cache_write_tokens") ||
      usageNumber(record, "cache_write") ||
      usageNumber(record, "cache_creation_input_tokens"),
    total: usageNumber(record, "total_tokens") || usageNumber(record, "total"),
  };
  // Every bucket counts here: a run that reports only reasoning or cache-write tokens was not free.
  const anyTokens = Object.values(tokens).some((count) => count > 0);

  return {
    model: usageText(record.model),
    provider: usageText(record.provider),
    sessionId: usageText(record.session_id),
    tokens: anyTokens ? tokens : null,
    costUsd: usageCost(record, "estimated_cost_usd"),
    costSource: usageText(record.cost_source),
    failed: record.failed === true,
    failure: usageText(record.failure),
  };
};

/**
 * `hermes chat` prints its durable session id on stderr at session.create, long before the stream
 * emits its first event. Reading it here gives the run an id to report while it is still running;
 * the stream's own id wins later because a compaction can advance it.
 */
export const SESSION_LINE_PATTERN = /^Session: ([^\s]+)$/;

export const parseSessionIdLine = (line: string): string | null => {
  const match = SESSION_LINE_PATTERN.exec(line.trim());
  return match ? match[1] : null;
};

type HooksSnapshot = Map<string, number>;

const snapshotHooks = (hooksDir: string): HooksSnapshot => {
  const snapshot: HooksSnapshot = new Map();
  const walk = (dir: string, prefix: string, depth: number): void => {
    if (depth > 2) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute, relative, depth + 1);
        continue;
      }
      try {
        snapshot.set(relative, fs.statSync(absolute).mtimeMs);
      } catch {
        snapshot.set(relative, 0);
      }
    }
  };
  walk(hooksDir, "", 0);
  return snapshot;
};

const changedHooks = (before: HooksSnapshot, after: HooksSnapshot): string[] => {
  const changes = new Set<string>();
  for (const [name, mtime] of after) {
    if (before.get(name) !== mtime) changes.add(name);
  }
  for (const name of before.keys()) {
    if (!after.has(name)) changes.add(name);
  }
  return [...changes];
};

/** The hooks dir a linked worktree shares with its repository, before any sandbox overrides it. */
const resolveHooksDir = async (repoRoot: string): Promise<string | null> => {
  const result = await runGit(repoRoot, ["rev-parse", "--git-path", "hooks"]);
  if (!result.ok) return null;
  const raw = result.stdout.trim();
  if (!raw) return null;
  return path.isAbsolute(raw) ? raw : path.resolve(repoRoot, raw);
};

/**
 * A diff cannot see an ignored file at all, so the porcelain listing is the only place an
 * excluded .env can be caught. Renames are disabled so a move into or out of a blocked name
 * shows up as a delete plus an add.
 */
const secretViolations = (porcelain: string, alreadyBlocked: Set<string>): string[] => {
  const violations = new Set<string>(alreadyBlocked);
  for (const entry of splitNul(porcelain)) {
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const file = entry.slice(3);
    if (!file) continue;
    if (ENV_TEMPLATE.test(file)) continue;
    if (!BLOCKED_PATH_PATTERNS.some((pattern) => pattern.test(file.replace(/\\/g, "/")))) continue;
    // `!!` is ignored: an excluded .env never reaches the diff, so it has to be named here.
    violations.add(code === "!!" ? `ignored secret file: ${file}` : file);
  }
  return [...violations];
};

/**
 * Files a baseline port never carries into the worktree: `.worktrees` would nest the bridge's own
 * checkouts, and `node_modules` is regenerable bulk that only slows the copy down.
 */
const BASELINE_SKIP_SEGMENTS = new Set([".git", ".worktrees", "node_modules"]);

const isBlockedBaselinePath = (relative: string): boolean => {
  const posix = relative.replace(/\\/g, "/");
  const segments = posix.split("/").filter(Boolean);
  if (segments.some((segment) => BASELINE_SKIP_SEGMENTS.has(segment))) return true;
  const base = segments[segments.length - 1] ?? "";
  if (ENV_TEMPLATE.test(base)) return false;
  return BLOCKED_PATH_PATTERNS.some((pattern) => pattern.test(posix));
};

/**
 * Ports the caller's uncommitted work into a fresh worktree so Hermes can see in-progress files
 * (a half-written component, an untracked test) without ever committing them to the caller's
 * checkout. Tracked changes travel as a binary diff; untracked files are copied because no diff
 * can express a file git has never seen. Returns the baseline commit SHA, or the original HEAD
 * SHA when there was nothing to port.
 */
export const snapshotCallerWorkingTree = async (
  repoRoot: string,
  worktreePath: string,
  headSha: string,
): Promise<{ baseSha: string; ported: number; skipped: string[] }> => {
  const status = await runGit(repoRoot, [
    "-c",
    "core.quotePath=false",
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "-z",
    "--no-renames",
  ]);
  if (!status.ok) {
    throw new Error(`git status failed in ${repoRoot}: ${(status.stderr || status.stdout).trim()}`);
  }

  const entries = splitNul(status.stdout);
  const tracked: string[] = [];
  const untracked: string[] = [];
  for (const entry of entries) {
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const file = entry.slice(3);
    if (!file) continue;
    if (code === "??") untracked.push(file);
    else if (code !== "!!") tracked.push(file);
  }

  if (tracked.length === 0 && untracked.length === 0) {
    return { baseSha: headSha, ported: 0, skipped: [] };
  }

  const skipped: string[] = [];
  // A blocked path is blocked as a tracked edit too: porting it would commit the caller's real
  // .env into the worktree, where no diff (and so no guardrail) can see it again.
  const trackedAllowed: string[] = [];
  for (const file of tracked) {
    if (isBlockedBaselinePath(file)) skipped.push(file);
    else trackedAllowed.push(file);
  }

  if (trackedAllowed.length > 0) {
    const diff = await runGit(repoRoot, [
      "-c",
      "core.quotePath=false",
      "diff",
      "HEAD",
      "--binary",
      "--no-renames",
      // Excluded by literal pathspec rather than filtered afterwards: the excluded hunk must never
      // be written to a patch file, even transiently.
      ...tracked
        .filter((file) => isBlockedBaselinePath(file))
        .map((file) => `:(exclude,literal)${file}`),
    ]);
    if (!diff.ok) {
      throw new Error(`git diff HEAD failed in ${repoRoot}: ${(diff.stderr || diff.stdout).trim()}`);
    }
    if (diff.stdout.trim()) {
      const patchFile = path.join(os.tmpdir(), `hermes-baseline-${path.basename(worktreePath)}.patch`);
      try {
        await fsp.writeFile(patchFile, diff.stdout, "utf8");
        // `--3way` is wrong here: the worktree is branched from HEAD, so the patch is exact.
        const applied = await runGit(worktreePath, ["apply", "--binary", "--whitespace=nowarn", patchFile]);
        if (!applied.ok || /Skipped patch/i.test(`${applied.stdout}${applied.stderr}`)) {
          throw new Error(
            `git apply of the caller's tracked changes failed: ${(applied.stderr || applied.stdout).trim()}`,
          );
        }
      } finally {
        await fsp.rm(patchFile, { force: true }).catch(() => undefined);
      }
    }
  }

  const skippedUntracked: string[] = [];
  let ported = trackedAllowed.length;
  for (const file of untracked) {
    if (isBlockedBaselinePath(file)) {
      skippedUntracked.push(file);
      continue;
    }
    const source = path.join(repoRoot, file);
    const target = path.join(worktreePath, file);
    try {
      const stat = await fsp.lstat(source);
      // A container worktree may hold a junction that resolves outside the repo: never follow it.
      if (!stat.isFile()) {
        skippedUntracked.push(file);
        continue;
      }
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.copyFile(source, target);
      ported += 1;
    } catch {
      skippedUntracked.push(file);
    }
  }
  skipped.push(...skippedUntracked);

  if (ported === 0) return { baseSha: headSha, ported: 0, skipped };

  const staged = await runGit(worktreePath, ["add", "-A"]);
  if (!staged.ok) {
    throw new Error(`git add -A failed in the worktree: ${(staged.stderr || staged.stdout).trim()}`);
  }
  const committed = await runGit(worktreePath, [
    "commit",
    "-m",
    BASELINE_COMMIT_SUBJECT,
    "--allow-empty",
  ]);
  if (!committed.ok) {
    throw new Error(`baseline commit failed: ${(committed.stderr || committed.stdout).trim()}`);
  }
  const head = await runGit(worktreePath, ["rev-parse", "HEAD"]);
  if (!head.ok) {
    throw new Error(`could not read the baseline commit: ${(head.stderr || head.stdout).trim()}`);
  }
  return { baseSha: head.stdout.trim(), ported, skipped };
};

/** The subject identifies the review boundary; apply reads it back to find where the run started. */
export const BASELINE_COMMIT_SUBJECT = "[AGY-BASE] Working tree baseline snapshot";

/**
 * The newest baseline commit between the branch point and the run's tip, or null when the caller
 * was clean and the run branched straight from HEAD. `git log` is newest-first, so a stacked
 * baseline (a second dispatch on an already-ported tree) resolves to the most recent one.
 */
const resolveBaselineSha = async (
  repoRoot: string,
  mergeBase: string,
  branch: string,
): Promise<string | null> => {
  const found = await runGit(repoRoot, [
    "log",
    "--format=%H",
    "--fixed-strings",
    `--grep=${BASELINE_COMMIT_SUBJECT}`,
    `${mergeBase}..${branch}`,
  ]);
  if (!found.ok) return null;
  const first = found.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return first ?? null;
};

/**
 * One dispatch: guard the prompt, bind the project, run Hermes inside a fresh worktree branched
 * from local HEAD, then firewall whatever it produced before Antigravity ever sees it. The run
 * answers with a running descriptor when it outlives the fast-wait window; the pipeline keeps
 * going and publishes its result through the run registry.
 */
export const dispatchHermesTask = async (options: DispatchOptions): Promise<DispatchOutcome> => {
  const scan = scanPromptForSecrets(options.prompt);
  if (!scan.safe) {
    throw new Error(`Refused to dispatch: ${scan.reason}. Remove the credential and retry.`);
  }

  const project = await resolveAntigravityProject({
    cwd: options.cwd,
    conversationId: options.conversationId,
    project: options.project,
  });
  const repoRoot = project.repoRoot;

  const verified = await runGit(repoRoot, ["rev-parse", "--verify", "HEAD"]);
  if (!verified.ok) {
    throw new Error(`${repoRoot} has no commits: an isolated worktree needs a HEAD to branch from.`);
  }
  const baseSha = verified.stdout.trim();

  const runId = options.runId ?? makeRunId();
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(`Refused to dispatch: '${runId}' is not a valid run id ([A-Za-z0-9_-]).`);
  }
  const branch = `hermes/agy-${runId}`;
  const worktreePath = path.join(repoRoot, ".worktrees", `agy-${runId}`);
  const sessionName = options.sessionName ?? `[AGY] ${truncateTitle(options.prompt, 48)}`;
  const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const fastWaitSeconds = options.fastWaitSeconds ?? DEFAULT_FAST_WAIT_SECONDS;
  const startedAt = Date.now();

  await ensureWorktreesExcluded(repoRoot);

  // Hooks are executable code inside the review boundary: a hook left behind by the worker would
  // run on the caller's next git call. The sandbox travels in the child's environment and diffing
  // the real hooks dir afterwards catches anything a hook wrote despite it.
  const hooksDir = await resolveHooksDir(repoRoot);
  const hooksBefore = hooksDir ? snapshotHooks(hooksDir) : null;
  const emptyHooksDir = path.join(os.tmpdir(), "hermes-worker-empty-hooks", runId);
  const usageFile = path.join(os.tmpdir(), `hermes-usage-${runId}.json`);

  // A run id that already owns a branch or a directory is a collision, not something to clean up:
  // `branch -D` on it would destroy an earlier run this dispatch never created.
  const collision = await runGit(repoRoot, ["branch", "--list", branch]);
  if (collision.ok && collision.stdout.trim()) {
    throw new Error(`Refused to dispatch: branch '${branch}' already exists. Pass a different runId.`);
  }
  if (fs.existsSync(worktreePath)) {
    throw new Error(`Refused to dispatch: ${worktreePath} already exists. Pass a different runId.`);
  }

  await fsp.mkdir(emptyHooksDir, { recursive: true }).catch(() => undefined);

  const created = await runGit(repoRoot, ["worktree", "add", "-b", branch, worktreePath, "HEAD"], {
    // No hook -- sandboxed one -- may run against the caller's repository during setup, so the
    // worktree's own creation carries the same environment as the run itself.
    env: sandboxedGitEnv(process.env, emptyHooksDir, repoRoot),
  });
  if (!created.ok) {
    // M11: a failed `worktree add` can still have registered the directory before refusing.
    await destroyWorktree(repoRoot, worktreePath, branch);
    throw new Error(`git worktree add failed: ${(created.stderr || created.stdout).trim()}`);
  }

  // The baseline commit is made before Hermes runs, so a caller's pre-commit hook is ordinary git
  // behaviour rather than a hole in the review boundary; the hook diff below still guards the
  // caller against anything Hermes does afterwards.
  let baselineSha = baseSha;
  let baselinePorted = 0;
  let baselineSkipped: string[] = [];
  try {
    const snapshot = await snapshotCallerWorkingTree(repoRoot, worktreePath, baseSha);
    baselineSha = snapshot.baseSha;
    baselinePorted = snapshot.ported;
    baselineSkipped = snapshot.skipped;
  } catch (error) {
    await destroyWorktree(repoRoot, worktreePath, branch);
    throw error;
  }

  const guarded = injectWorkerBoundary(options.prompt);
  const promptFile = path.join(os.tmpdir(), `hermes-prompt-${runId}.txt`);
  const before = snapshotPendingIds();
  const live: { sessionId: string | null; childPid: number | null } = {
    sessionId: null,
    childPid: null,
  };

  const result: DispatchResult = {
    runId,
    success: false,
    sessionId: null,
    sessionName,
    project,
    worktreePath,
    branch,
    baseSha: baselineSha,
    modifiedFiles: [],
    diff: "",
    diffTruncated: false,
    summary: "",
    reasoning: null,
    model: null,
    provider: null,
    modelFallback: false,
    warning: null,
    toolEvents: [],
    tokens: null,
    durationMs: null,
    exitCode: null,
    error: null,
    timedOut: false,
    securityViolation: false,
    violations: [],
    pendingWrites: [],
    worktreeKept: false,
    abortedFallback: false,
    cancelled: false,
    message: "",
  };

  let runLog: RunLog | null = null;
  const runPipeline = async (): Promise<DispatchResult> => {
    try {
      await fsp.writeFile(promptFile, guarded, "utf8");

      const args = buildChatArgs({
        promptFile,
        worktreePath,
        sessionName,
        model: options.model,
        reasoning: options.reasoning,
        skills: options.skills,
        usageFile,
      });

      runLog = openRunLog(runLogPath(runId));
      const execution = await execHermes({
        args,
        cwd: worktreePath,
        timeoutSeconds,
        repoRoot,
        env: sandboxedGitEnv(process.env, emptyHooksDir, repoRoot),
        onSessionId: (sessionId) => {
          live.sessionId = sessionId;
          result.sessionId = sessionId;
          // Published mid-run so a waiter can name the session while it is still going.
          void publish({ ...runningState(), sessionId });
        },
        onChildPid: (pid) => {
          live.childPid = pid;
          void publish({ ...runningState(), childPid: pid });
        },
        log: runLog,
      });
      result.abortedFallback = execution.abortedFallback;
      if (isRunCancelled(runId)) {
        result.cancelled = true;
        result.success = false;
        result.worktreeKept = false;
        result.message = "Cancelled while executing: the child was killed and the worktree removed.";
        return result;
      }
      result.timedOut = execution.timedOut;
      result.exitCode = execution.state.exitCode ?? execution.code;
      result.sessionId = execution.state.sessionId;
      result.summary = execution.state.text;
      result.toolEvents = execution.state.toolEvents;
      result.tokens = execution.state.tokens;
      result.durationMs = execution.state.durationMs;

      result.error = execution.state.error;
      if (execution.abortedFallback) {
        result.modelFallback = true;
        result.warning =
          `Aborted after turn 1: the fallback model answered instead of ${options.model || DEFAULT_MODEL}.`;
        result.message = `Dispatch refused: Go allowance exhausted, the fallback model answered turn 1. No changes are reviewable.`;
      }
      // A missing exit status is not success, and a stream code of 0 must not mask a non-zero
      // process code (or the other way round).
      const codes = [execution.state.exitCode, execution.code].filter(
        (code): code is number => typeof code === "number",
      );
      const exitFailed = codes.length === 0 || codes.some((code) => code !== 0);
      const failed =
        Boolean(execution.spawnError) || execution.timedOut || execution.state.isError || exitFailed;

      if (execution.spawnError) {
        result.message = `Could not start ${hermesExe()}: ${execution.spawnError}`;
      } else if (execution.timedOut) {
        result.message = `Hermes exceeded ${timeoutSeconds}s and was killed.`;
      } else if (failed) {
        result.message = `Hermes exited ${result.exitCode}${execution.state.error ? `: ${execution.state.error}` : ""}.`;
      }

      if (hooksDir && hooksBefore) {
        const touched = changedHooks(hooksBefore, snapshotHooks(hooksDir));
        if (touched.length > 0) {
          result.securityViolation = true;
          result.success = false;
          result.violations = touched.map((hook) => `git hook changed: ${hook}`);
          await destroyWorktree(repoRoot, worktreePath, branch);
          result.message = `Security violation: git hooks changed during the run (${touched.join(", ")}) — worktree destroyed.`;
          return result;
        }
      }

      const staged = await runGit(worktreePath, ["-c", "core.quotePath=false", "add", "-N", "."]);
      if (!staged.ok) {
        throw new Error(`git add -N failed: ${(staged.stderr || staged.stdout).trim()}`);
      }

      const nameOnly = await runGit(worktreePath, [
        "-c",
        "core.quotePath=false",
        "diff",
        "--name-only",
        "--no-renames",
        "-z",
        baselineSha,
      ]);
      if (!nameOnly.ok) {
        throw new Error(`git diff --name-only failed: ${(nameOnly.stderr || nameOnly.stdout).trim()}`);
      }
      result.modifiedFiles = splitNul(nameOnly.stdout);

      const porcelain = await runGit(worktreePath, [
        "-c",
        "core.quotePath=false",
        "status",
        "--porcelain=v1",
        "-z",
        "--ignored",
        "--no-renames",
      ]);
      if (!porcelain.ok) {
        throw new Error(`git status failed: ${(porcelain.stderr || porcelain.stdout).trim()}`);
      }
      const violations = secretViolations(
        porcelain.stdout,
        new Set(validateModifiedFiles(result.modifiedFiles, worktreePath).violations),
      );

      const diff = await runGit(worktreePath, [
        "-c",
        "core.quotePath=false",
        "diff",
        "--binary",
        "--no-renames",
        baselineSha,
      ]);
      if (!diff.ok) {
        throw new Error(`git diff failed: ${(diff.stderr || diff.stdout).trim()}`);
      }
      result.diff = diff.stdout;
      if (result.diff.length > MAX_DIFF_CHARS) {
        result.diff = `${result.diff.slice(0, MAX_DIFF_CHARS)}\n\n[diff truncated at ${MAX_DIFF_CHARS} chars]`;
        result.diffTruncated = true;
      }
      result.violations = violations;

      // The native usage ledger is authoritative for the turn that was billed; state.db is only a
      // fallback because the gateway writes it asynchronously and a settling run can be missing.
      const usage = readUsageReport(usageFile);
      const session = result.sessionId ? readSessionAfterRun(result.sessionId, repoRoot) : null;
      if (session) result.reasoning = session.reasoning;
      if (usage?.tokens) result.tokens = { ...(result.tokens ?? {}), ...usage.tokens };
      // A present ledger carries a verdict on cost even when that verdict is "unknown" (null).
      if (usage) result.costUsd = usage.costUsd;

      let attributionUnknown = false;
      const attributedModel = usage?.model ?? session?.model ?? null;
      const attributedProvider = usage?.provider ?? session?.provider ?? null;
      result.model = attributedModel;
      result.provider = attributedProvider;

      const requestedModel = options.model || DEFAULT_MODEL;
      // A fallback is either explicit in the session's routing record, or proven by the ledger
      // naming a model nobody asked for. An absent ledger proves nothing in either direction.
      const fallbackProven =
        session?.fallbackActive === true ||
        (usage !== null && usage.model !== null && !sameModelId(usage.model, requestedModel));
      if (!result.abortedFallback) result.modelFallback = fallbackProven;

      if (result.modelFallback) {
        result.warning =
          result.warning ??
          `Ran on ${attributedModel ?? "unknown"} (${attributedProvider ?? "unknown"}) instead of ${requestedModel}: ` +
            "the requested model was refused by its provider.";
        result.message = `Dispatch refused: Go allowance exhausted, ran on fallback ${attributedModel ?? "unknown"}. No changes are reviewable.`;
      } else if (usage === null && !session?.known) {
        attributionUnknown = true;
      }

      if (usage?.failed && usage.failure) result.error = result.error ?? usage.failure;

      if (result.modelFallback) {
        result.diff = "";
        result.diffTruncated = false;
        result.modifiedFiles = [];
        result.worktreeKept = false;
        result.success = false;
        await destroyWorktree(repoRoot, worktreePath, branch);
        return result;
      }

      // An unprovable attribution is a failure, not a pass: success would claim the pinned model
      // answered when nothing on disk says so.
      const attributionFailed = attributionUnknown && !failed;
      if (attributionFailed) {
        result.warning = result.sessionId
          ? `Could not verify which model answered session ${result.sessionId}: the session row is missing or names no model.`
          : "Could not verify which model answered: Hermes never reported a session id.";
        result.message = `Dispatch unverified: ${result.warning} No fallback is reported because none can be proven.`;
      }

      if (violations.length > 0) {
        result.securityViolation = true;
        result.success = false;
        await destroyWorktree(repoRoot, worktreePath, branch);
        result.message = `Security violation: ${violations.join(", ")} — worktree destroyed.`;
        return result;
      }

      if (result.modifiedFiles.length === 0) {
        await destroyWorktree(repoRoot, worktreePath, branch);
        result.success = !failed && !attributionFailed;
        result.message =
          result.message || "No files were modified; the worktree and branch were cleaned up.";
        return result;
      }

      result.worktreeKept = true;
      result.success = !failed && !attributionFailed;
      const metadata = runMetadata(result);
      result.message =
        result.message ||
        `${result.modifiedFiles.length} file(s) changed on ${branch}${metadata.duration}. Apply with hermes_worktree_action.` +
          (baselinePorted > 0
            ? ` ${baselinePorted} uncommitted caller file(s) were ported into the baseline commit.`
            : "") +
          (baselineSkipped.length > 0
            ? ` Skipped from the baseline: ${baselineSkipped.join(", ")}.`
            : "") +
          metadata.brackets;
      return result;
    } catch (error) {
      // M12: a throw anywhere after the worktree exists must not leave a branch or a directory.
      await destroyWorktree(repoRoot, worktreePath, branch);
      result.success = false;
      result.worktreeKept = false;
      result.error = errorMessage(error);
      result.message = `Dispatch failed: ${result.error}`;
      return result;
    } finally {
      // Closed before the state file is published: the wait CLI flushes what is on disk when it
      // sees `completed`, so an unclosed stream would truncate the tail.
      await runLog?.close().catch(() => undefined);
      await fsp.rm(promptFile, { force: true }).catch(() => undefined);
      await fsp.rm(emptyHooksDir, { recursive: true, force: true }).catch(() => undefined);
      await fsp.rm(usageFile, { force: true }).catch(() => undefined);
      try {
        result.pendingWrites = await collectNewPendingWrites(before);
      } catch {
        result.pendingWrites = [];
      }
    }
  };

  // State writes go through one queue: the `running` record can never land after the completion
  // record and resurrect a finished run.
  let stateQueue: Promise<void> = Promise.resolve();
  const publish = (state: RunState): Promise<void> => {
    stateQueue = stateQueue.then(() => writeRunState(state).catch(() => undefined));
    return stateQueue;
  };

  /**
   * Every `running` record carries the dispatcher's pid: without it a waiter cannot tell a crashed
   * run from a slow one and hangs until its own deadline. The child pid and session id are added by
   * the callbacks below as soon as the spawn and the first stderr line report them.
   */
  const runningState = (): RunState => ({
    status: "running",
    runId,
    sessionName,
    worktreePath,
    branch,
    startedAt,
    workerPid: process.pid,
    childPid: live.childPid ?? undefined,
    sessionId: live.sessionId,
  });

  const completion: Promise<DispatchResult> = (async () => {
    const settled = await runPipeline().catch(
      // runPipeline already converts its own throws, so this only guards the wrapper itself.
      (error: unknown): DispatchResult => ({
        ...result,
        status: "completed",
        success: false,
        error: errorMessage(error),
        message: `Dispatch failed: ${errorMessage(error)}`,
      }),
    );
    if (
      options.autoApply === true &&
      settled.success &&
      settled.worktreeKept &&
      !settled.securityViolation &&
      !settled.cancelled &&
      settled.branch
    ) {
      const applied = await manageWorktree({
        action: "apply",
        cwd: repoRoot,
        worktreeBranch: settled.branch,
        activeRunId: runId,
      });
      if (applied.success) {
        settled.applied = true;
        settled.worktreeKept = false;
        settled.message = `Applied ${settled.modifiedFiles.length} file(s) to ${repoRoot} and removed worktree branch.`;
      } else {
        settled.message = `${settled.message} (Auto-apply failed: ${applied.message})`;
      }
    }
    // Read after the apply attempt: an applied diff is billed twice if it is also sent back.
    const keepDiff = options.includeDiff ?? !settled.applied;
    if (!keepDiff) {
      settled.diff = "";
      settled.diffTruncated = false;
      settled.diffOmitted = true;
    }
    settled.status = "completed";
    // A cancelled run already has its terminal record, and the waiter that wrote it owns it: writing
    // again would resurrect a file that the waiter has just consumed.
    if (!settled.cancelled) {
      await publish({
        ...runningState(),
        status: "completed",
        result: settled,
      });
    }
    return settled;
  })();

  await publish(runningState());

  const raced = await raceFastWait(completion, fastWaitSeconds);
  if (raced.done) {
    // Nobody was handed a waitCommand, so the record nobody will read is litter in tmpdir.
    await clearRunState(runId).catch(() => undefined);
    return raced.value;
  }

  const waitJs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "wait.js");
  return {
    status: "running",
    success: true,
    runId,
    sessionId: live.sessionId,
    sessionName,
    project,
    worktreePath,
    branch,
    baseSha: baselineSha,
    waitCommand: `node "${waitJs}" "${runId}"`,
    message:
      `Hermes is still running after ${fastWaitSeconds}s. Execute waitCommand as a background ` +
      "command to receive a completion callback when the run finishes.",
  };
};

/**
 * Apply lands the worktree's diff on the caller's checkout; discard throws it away. Both leave
 * the repository with no bridge worktree and no temporary branch behind.
 */
export const manageWorktree = async (options: {
  action: "apply" | "discard" | "cancel";
  cwd: string;
  worktreeBranch: string;
  /** The run that is itself calling this after finishing; its state file still says `running`. */
  activeRunId?: string;
}): Promise<{ success: boolean; message: string; patchPath?: string }> => {
  // Anything else is a user branch: `branch -D` on it would destroy work this bridge never made.
  const branchMatch = options.worktreeBranch.match(/^hermes\/agy-([A-Za-z0-9_-]+)$/);
  if (!branchMatch) {
    return {
      success: false,
      message:
        `Refusing to touch branch '${options.worktreeBranch}': only hermes/agy-<runId> branches ` +
        "created by hermes_dispatch are managed here.",
    };
  }

  const runId = branchMatch[1];
  const activeRun = readRunState(runId);

  // Cancel is the only action allowed to interrupt a live run: it kills the tree, settles the run
  // record, then removes the worktree through the same path discard uses.
  if (options.action === "cancel") {
    // Only the child is killed. `workerPid` is this very bridge process, whose own liveness the
    // record reports: signalling it would take the MCP server down with the run.
    const childPid = activeRun?.childPid;
    const hadChild = typeof childPid === "number" && Number.isFinite(childPid) && childPid > 0;

    // Published before the kill, never after: the pipeline notices its own cancellation by reading
    // this record when the child's close event lands, and a record written afterwards would arrive
    // too late to stop it from diffing a worktree this call is about to delete.
    if (activeRun) {
      await writeRunState({
        ...activeRun,
        status: "completed",
        result: {
          success: false,
          cancelled: true,
          message: hadChild
            ? `Cancelled: killed the run's process tree (pid ${childPid}).`
            : "Cancelled: the run had no live child process.",
          timedOut: false,
        },
      }).catch(() => undefined);
    }

    if (hadChild) await stopChildProcess(childPid);
  }

  // Refuse to touch a worktree whose Hermes process/session is actively executing. A run that is
  // applying its own result names itself here: it cannot be mid-execution by definition.
  if (
    options.action !== "cancel" &&
    activeRun &&
    activeRun.status === "running" &&
    options.activeRunId !== runId
  ) {
    return {
      success: false,
      message:
        `Refusing to ${options.action} '${options.worktreeBranch}': Hermes run '${runId}' ` +
        "is still actively executing. Wait for the run to finish, or cancel it.",
    };
  }

  // A call from a subdirectory must still act on the repository root the worktree hangs off.
  const topLevel = await runGit(options.cwd, ["rev-parse", "--show-toplevel"]);
  if (!topLevel.ok) {
    return {
      success: false,
      message: `${options.cwd} is not a git repository: ${(topLevel.stderr || topLevel.stdout).trim()}`,
    };
  }
  const repoRoot = path.resolve(topLevel.stdout.trim());
  const worktreesRoot = path.join(repoRoot, ".worktrees");

  const entries = await listWorktrees(repoRoot);
  const target = entries.find((entry) => entry.branch === options.worktreeBranch);
  if (!target) {
    return {
      // A cancel that killed a live run has already achieved its purpose; a missing worktree is only
      // a failure when the caller expected one to be there to act on.
      success: options.action === "cancel",
      message:
        options.action === "cancel"
          ? `Cancelled run '${runId}'; no worktree for '${options.worktreeBranch}' was left under ${repoRoot}.`
          : `No worktree for branch '${options.worktreeBranch}' under ${repoRoot}.`,
    };
  }
  if (!isInsidePath(worktreesRoot, target.path)) {
    return {
      success: false,
      message: `Refusing to touch '${target.path}': it is outside ${worktreesRoot}.`,
    };
  }

  // Removal needs the directory to itself. A child still recorded for this run holds it open, so a
  // Windows rm lands on EBUSY until that process exits. The pid is trusted only when the record
  // names this worktree, because an abandoned record's pid may since have been recycled.
  if (
    options.action !== "cancel" &&
    activeRun &&
    typeof activeRun.worktreePath === "string" &&
    samePath(activeRun.worktreePath, target.path)
  ) {
    await stopChildProcess(activeRun.childPid);
  }

  const cleanup = async (): Promise<string | null> => {
    const removed = await removeWorktree(repoRoot, target.path, options.worktreeBranch);
    return removed.ok ? null : (removed.error ?? "worktree cleanup failed");
  };

  if (options.action === "discard" || options.action === "cancel") {
    const cleanupError = await cleanup();
    const verb = options.action === "cancel" ? "Cancelled and discarded" : "Discarded";
    return cleanupError
      ? { success: false, message: `${verb} the worktree but ${cleanupError}.` }
      : { success: true, message: `${verb} worktree and branch '${options.worktreeBranch}'.` };
  }

  // `merge-base` is the branch point, which is caller HEAD — it sits BELOW the baseline commit,
  // so diffing from it re-emits the caller's uncommitted work and the patch collides with their
  // dirty tree. The baseline commit is the review boundary: everything the caller already had.
  const mergeBase = await runGit(repoRoot, ["merge-base", options.worktreeBranch, "HEAD"]);
  if (!mergeBase.ok) {
    return {
      success: false,
      message: `Could not find a merge base for '${options.worktreeBranch}': ${mergeBase.stderr.trim()}`,
    };
  }
  const baseSha = (await resolveBaselineSha(repoRoot, mergeBase.stdout.trim(), options.worktreeBranch)) ?? mergeBase.stdout.trim();

  const staged = await runGit(target.path, ["-c", "core.quotePath=false", "add", "-N", "."]);
  if (!staged.ok) {
    return { success: false, message: `git add -N failed: ${(staged.stderr || staged.stdout).trim()}` };
  }

  const nameOnly = await runGit(target.path, [
    "-c",
    "core.quotePath=false",
    "diff",
    "--name-only",
    "--no-renames",
    "-z",
    baseSha,
  ]);
  if (!nameOnly.ok) {
    return { success: false, message: `git diff --name-only failed: ${(nameOnly.stderr || nameOnly.stdout).trim()}` };
  }
  const modifiedFiles = splitNul(nameOnly.stdout);

  const porcelain = await runGit(target.path, [
    "-c",
    "core.quotePath=false",
    "status",
    "--porcelain=v1",
    "-z",
    "--ignored",
    "--no-renames",
  ]);
  if (!porcelain.ok) {
    return { success: false, message: `git status failed: ${(porcelain.stderr || porcelain.stdout).trim()}` };
  }

  // Re-checked at apply time: the worktree outlives the dispatch, so what was clean then may not be now.
  const violations = secretViolations(
    porcelain.stdout,
    new Set(validateModifiedFiles(modifiedFiles, target.path).violations),
  );
  if (violations.length > 0) {
    const cleanupError = await cleanup();
    return {
      success: false,
      message:
        `Refused to apply '${options.worktreeBranch}': ${violations.join(", ")}. ` +
        (cleanupError
          ? `The worktree was not fully removed: ${cleanupError}.`
          : "The worktree and branch were destroyed."),
    };
  }

  const diff = await runGit(target.path, [
    "-c",
    "core.quotePath=false",
    "diff",
    "--binary",
    "--no-renames",
    baseSha,
  ]);
  if (!diff.ok) {
    return { success: false, message: `git diff failed: ${(diff.stderr || diff.stdout).trim()}` };
  }
  if (!diff.stdout.trim()) {
    const cleanupError = await cleanup();
    return {
      success: true,
      message:
        `No changes to apply on '${options.worktreeBranch}'; worktree removed.` +
        (cleanupError ? ` (${cleanupError})` : ""),
    };
  }

  const patchDir = path.join(repoRoot, ".worktrees");
  await fsp.mkdir(patchDir, { recursive: true });
  const patchPath = path.join(patchDir, `${options.worktreeBranch.replace(/[\\/]/g, "-")}.patch`);
  await fsp.writeFile(patchPath, diff.stdout, "utf8");

  // `git apply --3way` implies `--index`, which fails with "does not match index" when the caller
  // has uncommitted/unstaged edits in any of the patched files. Try `--3way` first; if rejected by
  // the index mismatch, fall back to applying directly to the working tree.
  let applied = await runGit(repoRoot, ["apply", "--3way", "--binary", patchPath]);
  if (!applied.ok && /does not match index/i.test(`${applied.stdout}${applied.stderr}`)) {
    applied = await runGit(repoRoot, ["apply", "--binary", patchPath]);
  }
  // A skipped hunk still exits 0: `Skipped patch 'x'` on either stream is a refusal, not a success.
  if (!applied.ok || /Skipped patch/i.test(`${applied.stdout}${applied.stderr}`)) {
    return {
      success: false,
      message:
        `git apply failed: ${(applied.stderr || applied.stdout).trim()}. ` +
        `The patch is at ${patchPath} and the worktree was kept.`,
      patchPath,
    };
  }

  const cleanupError = await cleanup();
  await fsp.rm(patchPath, { force: true });
  return {
    success: true,
    message:
      `Applied '${options.worktreeBranch}' to ${repoRoot}; worktree removed.` +
      (cleanupError ? ` (${cleanupError})` : ""),
    patchPath,
  };
};

export interface SessionSummaryRow {
  id: string;
  title: string | null;
  model: string | null;
  started_at: number;
  message_count: number;
  tool_call_count: number;
  cwd: string | null;
}

/** A path prefix is data, not a pattern: `%`, `_` and `\` in a Windows path must match literally. */
const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (match) => `\\${match}`);

export const listHermesSessions = (options: { cwd?: string; limit?: number } = {}): SessionSummaryRow[] => {
  const dbPath = stateDbPath();
  if (!fs.existsSync(dbPath)) return [];
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 200);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const columns = "id, title, model, started_at, message_count, tool_call_count, cwd";
    if (options.cwd) {
      const root = path.resolve(options.cwd).replace(/[\\/]+$/, "");
      const prefix = `${escapeLike(root + path.sep)}%`;
      const rows = db
        .prepare(
          `SELECT ${columns} FROM sessions
            WHERE cwd = ? OR cwd LIKE ? ESCAPE '\\' OR git_repo_root = ? OR git_repo_root LIKE ? ESCAPE '\\'
            ORDER BY started_at DESC LIMIT ?`,
        )
        .all(root, prefix, root, prefix, limit) as unknown as SessionSummaryRow[];
      return rows;
    }
    return db
      .prepare(`SELECT ${columns} FROM sessions ORDER BY started_at DESC LIMIT ?`)
      .all(limit) as unknown as SessionSummaryRow[];
  } finally {
    db.close();
  }
};
