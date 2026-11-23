import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT_GRACE_MS, isWindows, killProcessTree, run, runGit } from "./exec.js";
import {
  BLOCKED_DIRECTORY_SEGMENTS,
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
import {
  normalizeForCompare,
  resolveAntigravityProject,
  type ResolvedProject,
} from "./project-binding.js";
import { runBridge, type SubagentActivity } from "./python-bridge.js";
import { createStreamFormatter, createSubagentFormatter, openRunLog, type RunLog } from "./run-log.js";
import {
  RUN_ID_PATTERN,
  clearConversationSession,
  clearRunState,
  isPidAlive,
  isRunAbandoned,
  listActiveRuns,
  pruneStaleRuns,
  readConversationSession,
  readRunState,
  runLogPath,
  writeConversationSession,
  writeRunState,
  type ConversationSessionRecord,
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
  /** Return the diff body; a caller that only wants the file list turns it off. */
  includeDiff?: boolean;
  runId?: string;
  /** Continue this Hermes session instead of resolving or creating one. */
  resumeSessionId?: string;
  /** Ignore the session remembered for this conversation and start a fresh one. */
  newSession?: boolean;
  /** Compactions a session may accumulate before the dispatch rotates to a fresh one. */
  maxCompacts?: number;
  /** Shell command run in the checkout after every turn; a non-zero exit feeds the next turn. */
  verifyCommand?: string;
  /** Turn budget for the verify loop, clamped to 1..10. Ignored without verifyCommand. */
  maxTurns?: number;
  /** Compaction probe, replaced in tests so rotation is driven without a live session store. */
  sessionProbe?: (sessionId: string, repoRoot: string) => Promise<SessionAfterRun>;
}

/** Pinned so a dispatch is reproducible regardless of what Hermes' config was last set to. */
export const DEFAULT_MODEL = "deepseek-v4.1-flash";
export const DEFAULT_REASONING = "high";
export const DEFAULT_TIMEOUT_SECONDS = 900;
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
  /** The checkout the run executed in: there is no worktree, Hermes edits the real tree. */
  repoRoot: string;
  /** The run handle hermes_worktree_action takes: `agy-<runId>`. */
  runHandle: string;
  /** The tree the run started from and the tree it left behind: the review boundary. */
  baselineTreeSha: string;
  afterTreeSha: string | null;
  modifiedFiles: string[];
  diff: string;
  diffTruncated: boolean;
  /** True when the diff body was withheld on request. */
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
  /** True when the run's changes are still in the checkout for review or for the next turn. */
  changesKept: boolean;
  /** Turns this dispatch ran: more than one only when a verifyCommand drove another turn. */
  turns: number;
  /** Exit status of the last verifyCommand run; null when no command was configured. */
  verifyExitCode: number | null;
  /** True when the last verifyCommand was killed at its timeout instead of finishing. */
  verifyTimedOut: boolean;
  /** True when the session hit maxCompacts and the dispatch continued in a fresh one. */
  sessionRotated: boolean;
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
  repoRoot: string;
  runHandle: string;
  baselineTreeSha: string;
  waitCommand: string;
  message: string;
}

export type DispatchOutcome = DispatchResult | RunningDispatchResult;

const MAX_DIFF_CHARS = 400_000;
const BRANCH_PATTERN = /^hermes\/agy-[A-Za-z0-9_-]+$/;
/** `Skipped patch 'x'` is git's refusal and always starts a line; a filename may contain the words. */
const SKIPPED_PATCH = /^\s*Skipped patch/m;
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

const CANCEL_QUIESCE_MS = 5_000;
const CANCEL_POLL_MS = 50;

/**
 * Kills every child the run names until the record names none. A cancel can land between a turn's
 * exit and the verification spawn, so one kill is not proof the loop has stopped: a revert that
 * starts while the next process is still coming deletes a checkout that process then writes into.
 * Bounded, because a process that will not die has to be reported rather than waited on forever.
 */
const quiesceRunChildren = async (runId: string): Promise<{ quiet: boolean; killed: number }> => {
  const deadline = Date.now() + CANCEL_QUIESCE_MS;
  let quietReads = 0;
  let killed = 0;

  while (Date.now() < deadline) {
    const pid = readRunState(runId)?.childPid;
    if (typeof pid === "number" && Number.isFinite(pid) && pid > 0 && pid !== process.pid && isPidAlive(pid)) {
      quietReads = 0;
      killed += 1;
      await stopChildProcess(pid);
      // Re-read at once: the loop may already have published the next child's pid.
      continue;
    }
    quietReads += 1;
    // Two quiet reads one poll apart: nothing is about to name a process the revert would race.
    if (quietReads >= 2) return { quiet: true, killed };
    await sleep(CANCEL_POLL_MS);
  }

  return { quiet: false, killed };
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
  const activePaths = active
    .map((run) => run.worktreePath)
    .filter((value): value is string => typeof value === "string" && value.length > 0);

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
  /** `delegate_task` calls with no result yet: subagents can only be live inside that window. */
  delegations: Set<string>;
}

/**
 * Calls only, never results: a result's payload is the run log's job, and copying 200 characters of
 * every read into the returned result bills the caller for output nothing reads.
 */
const DELEGATE_TOOL = "delegate_task";

const collectToolEvents = (node: unknown, sink: ToolEvent[], delegations: Set<string>, depth = 0): void => {
  if (!node || typeof node !== "object" || depth > 6) return;
  if (Array.isArray(node)) {
    for (const item of node) collectToolEvents(item, sink, delegations, depth + 1);
    return;
  }
  const record = node as Record<string, unknown>;
  if (record.type === "tool_use") {
    const name = String(record.name ?? "tool");
    sink.push({ type: "tool_use", name, detail: String(record.id ?? "") });
    if (name === DELEGATE_TOOL) delegations.add(String(record.id ?? "delegate"));
  } else if (record.type === "tool_result") {
    const id = record.tool_use_id;
    if (typeof id === "string") delegations.delete(id);
  }
  for (const value of Object.values(record)) {
    if (value && typeof value === "object") collectToolEvents(value, sink, delegations, depth + 1);
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
  collectToolEvents(event, state.toolEvents, state.delegations);
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
  /** The checkout Hermes works in: `--in` places the session, so it only travels on create. */
  repoRoot: string;
  sessionName: string;
  model?: string;
  reasoning?: string;
  skills?: string[];
  /** The per-run usage ledger. A top-level flag, so it cannot travel with the chat arguments. */
  usageFile?: string;
  /** Resume this session instead of creating one. */
  resumeSessionId?: string;
}

export const buildChatArgs = (options: ChatArgsOptions): string[] => {
  // Before `chat`: argparse rejects --usage-file as an unknown chat argument after the subcommand.
  const usage = options.usageFile ? ["--usage-file", options.usageFile] : [];
  const stream = ["--query-file", options.promptFile, "--format", "stream-json"];
  // The gateway only admits its own SURFACES labels (cli, tui, gui, acp, tool, oneshot): an invented
  // label is refused. `oneshot` would hide the session from Desktop pickers, so the explicit `cli`
  // label is what keeps a dispatch visible and resumable.
  const surface = ["--yolo", "--source", "cli"];

  if (options.resumeSessionId) {
    // A resumed session already owns its model, provider, skills and cwd. Repeating them asks the
    // gateway to re-pin a session whose model it cannot change, and `--in` would re-anchor its cwd.
    return [
      ...usage,
      "chat",
      ...stream,
      "--resume",
      options.resumeSessionId,
      ...surface,
    ];
  }

  const args = [
    ...usage,
    "chat",
    ...stream,
    "--in",
    options.repoRoot,
    "-c",
    options.sessionName,
    "--create-if-missing",
    ...surface,
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

const DEFAULT_SUBAGENT_POLL_MS = 3000;
const SUBAGENT_POLL_TIMEOUT_MS = 15_000;
/** A bridge that cannot answer three times running will not start answering on the fourth. */
const SUBAGENT_MAX_FAILURES = 3;

export type SubagentActivityReader = (
  parentSessionId: string,
  sinceMessageId: number | null,
  sinceStartedAt: number | null,
) => Promise<SubagentActivity>;

const readSubagentActivity: SubagentActivityReader = (parentSessionId, sinceMessageId, sinceStartedAt) =>
  runBridge<SubagentActivity>(
    {
      op: "subagent_activity",
      parentSessionId,
      sinceMessageId: sinceMessageId ?? undefined,
      sinceStartedAt: sinceStartedAt ?? undefined,
    },
    { timeoutMs: SUBAGENT_POLL_TIMEOUT_MS },
  );

export interface SubagentPollerOptions {
  /** The run's current session: null until the child has printed one. */
  parentSessionId: () => string | null;
  /** Formatted lines plus whether they carried news, which is what keeps a run's timer alive. */
  onActivity: (lines: string[], active: boolean) => void;
  pollMs?: number;
  /** Injected by tests; production reads the session store through the bridge. */
  read?: SubagentActivityReader;
}

export interface SubagentPoller {
  /** Arm or pause: paused is not ended, so re-arming later continues the same cursor. */
  setActive: (active: boolean) => void;
  stop: () => void;
  poll: () => Promise<void>;
}

/**
 * Polls the session store for the children of one parent while a `delegate_task` call is open.
 *
 * The store is only ever read through the Python bridge: workers hold no `node:sqlite` reader, so
 * there is one place where the schema is known. A poll in flight is never overlapped, and a poller
 * left armed after its run settles would leak both a timer and a Python process per tick.
 */
export const createSubagentPoller = (options: SubagentPollerOptions): SubagentPoller => {
  const pollMs = options.pollMs ?? DEFAULT_SUBAGENT_POLL_MS;
  const read = options.read ?? readSubagentActivity;
  const format = createSubagentFormatter();
  // The run began here, before its child exists: any earlier subagent belongs to an earlier turn.
  const beganAt = Date.now() / 1000;
  let cursor: number | null = null;
  let timer: NodeJS.Timeout | null = null;
  let active = false;
  let inFlight = false;
  let flushPending = false;
  let stopped = false;
  let failures = 0;

  const schedule = (): void => {
    if (stopped || timer !== null || !active || pollMs <= 0) return;
    if (failures >= SUBAGENT_MAX_FAILURES || !options.parentSessionId()) return;
    timer = setTimeout(() => {
      timer = null;
      void poll().finally(schedule);
    }, pollMs);
    // The poller must never be the reason the process outlives its run.
    if (typeof timer.unref === "function") timer.unref();
  };

  const poll = async (): Promise<void> => {
    if (stopped || inFlight) return;
    const parentSessionId = options.parentSessionId();
    if (!parentSessionId) return;
    inFlight = true;
    try {
      const activity = await read(parentSessionId, cursor, beganAt);
      // A settle raced this poll: its lines belong to a run that has already been reported.
      if (stopped) return;
      if (typeof activity?.cursor === "number" && Number.isFinite(activity.cursor)) cursor = activity.cursor;
      failures = 0;
      const batch = format(activity);
      if (batch.lines.length > 0 || batch.active) options.onActivity(batch.lines, batch.active);
    } catch {
      // A tail is a convenience: a bridge that cannot answer must never fail the dispatch.
      failures += 1;
    } finally {
      inFlight = false;
      // The flush a deactivation asked for while this poll held the lock.
      if (flushPending && !stopped) {
        flushPending = false;
        void poll();
      }
    }
  };

  return {
    setActive: (next: boolean): void => {
      if (stopped) return;
      const wasActive = active;
      active = next;
      if (next) {
        schedule();
        return;
      }
      if (timer !== null) clearTimeout(timer);
      timer = null;
      // One last read on the way out: the children finish as their parent's call returns.
      if (wasActive) {
        if (inFlight) flushPending = true;
        else void poll();
      }
    },
    stop: (): void => {
      stopped = true;
      active = false;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
    poll,
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
  /** Subagent poll interval; the default only matters where a `delegate_task` call is open. */
  subagentPollMs?: number;
  /** Injected by tests; production reads the session store through the bridge. */
  subagentReadActivity?: SubagentActivityReader;
}

export const execHermes = (options: ExecHermesOptions): Promise<HermesRun> =>
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
      delegations: new Set<string>(),
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
    let settled = false;
    let exitCode: number | null = null;
    let graceTimer: NodeJS.Timeout | null = null;
    // The gateway writes gateway_runtime as turn 1 gets under way, so a single probe can land
    // before the row exists. A few bounded probes cover that window without polling forever.
    let fallbackProbes = 0;
    let probeInFlight = false;
    let turnOneSeen = false;
    let abortedFallback = false;

    // Inactivity timer rather than a hard wall-clock cap: reset on every stdout/stderr chunk so
    // long active runs never get killed mid-flight, while silent subagent waits still get the full
    // timeoutSeconds window before a genuinely wedged process is reaped.
    let timer: NodeJS.Timeout | null = null;
    const resetTimer = (): void => {
      if (settled) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        if (child.pid && isWindows) {
          spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
        } else {
          child.kill("SIGKILL");
        }
      }, timeoutSeconds * 1000);
    };
    resetTimer();

    // Subagents are silent on this run's own stream, so a `delegate_task` window would otherwise
    // look like a wedged process and be killed mid-flight.
    const subagents = createSubagentPoller({
      parentSessionId: () => state.sessionId,
      onActivity: (lines, active) => {
        if (lines.length > 0) log?.write(lines);
        if (active) resetTimer();
      },
      pollMs: options.subagentPollMs,
      read: options.subagentReadActivity,
    });

    /**
     * The pinned model is a contract, not a preference: a turn already answered by the fallback
     * means the diff cannot be reviewed, so continuing spends quota on output that will be thrown
     * away. Probed only until turn 1 produces something, then never again.
     *
     * The probe reads the session store through the bridge, so it is asynchronous: the authoritative
     * check is the post-run attribution, and this only ever ends a run early when it wins the race.
     */
    const abortOnFallback = (): void => {
      if (abortedFallback || turnOneSeen || probeInFlight || !state.sessionId || fallbackProbes >= 3) return;
      fallbackProbes += 1;
      probeInFlight = true;
      const sessionId = state.sessionId;
      void readSessionAfterRun(sessionId, repoRoot)
        .then((session) => {
          if (abortedFallback || !session.fallbackActive) return;
          abortedFallback = true;
          killProcessTree(child.pid);
        })
        .catch(() => undefined)
        .finally(() => {
          probeInFlight = false;
        });
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
      resetTimer();
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
        subagents.setActive(state.delegations.size > 0);
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      resetTimer();
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

    const settle = (code: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      subagents.stop();
      if (graceTimer !== null) clearTimeout(graceTimer);
      graceTimer = null;
      if (buffer.trim()) {
        const previous = state.sessionId;
        ingestStreamLine(buffer, state);
        log?.write(format(buffer));
        if (state.sessionId && state.sessionId !== previous) onSessionId?.(state.sessionId);
      }
      resolve({ state, timedOut, spawnError, stderr, code, childPid: child.pid ?? null, abortedFallback });
    };

    // A detached grandchild that inherited the pipes keeps 'close' from ever firing, so the run
    // would outlive its own timeout: exit is the proof the child itself is done.
    child.on("exit", (code: number | null) => {
      exitCode = code;
      if (settled) return;
      graceTimer = setTimeout(() => settle(code), EXIT_GRACE_MS);
    });

    child.on("close", (code: number | null) => settle(code ?? exitCode));
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
  /** The session a reader must continue from: a compaction advances it past the requested id. */
  tipSessionId: string;
  /** How many times the session has been compacted; the rollover budget counts these. */
  compactionCount: number;
  /** The summary the last compaction wrote, which is the only memory of the pre-compaction turns. */
  compactionSummary: string | null;
  /** The last assistant message, used as the handoff when no compaction summary exists. */
  lastAssistantSummary: string | null;
}

const sessionText = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const normaliseSessionInfo = (sessionId: string, info: unknown): SessionAfterRun => {
  const record = (info && typeof info === "object" ? info : {}) as Record<string, unknown>;
  const compactions = record.compactionCount;
  return {
    reasoning: sessionText(record.reasoning),
    model: sessionText(record.model),
    provider: sessionText(record.provider),
    fallbackActive: record.fallbackActive === true,
    known: record.known === true,
    tipSessionId: sessionText(record.tipSessionId) ?? sessionId,
    compactionCount:
      typeof compactions === "number" && Number.isFinite(compactions) && compactions > 0
        ? Math.floor(compactions)
        : 0,
    compactionSummary: sessionText(record.compactionSummary),
    lastAssistantSummary: sessionText(record.lastAssistantSummary),
  };
};

/**
 * The session row, read through Hermes' own Python: `state.db` belongs to the gateway and a second
 * sqlite reader in this process is a schema coupling that breaks on every migration. An absent or
 * unreadable store degrades to an unknown attribution rather than failing the run.
 */
export const readSessionAfterRun = async (sessionId: string, repoRoot: string): Promise<SessionAfterRun> => {
  const unknown: SessionAfterRun = {
    reasoning: null,
    model: null,
    provider: null,
    fallbackActive: false,
    known: false,
    tipSessionId: sessionId,
    compactionCount: 0,
    compactionSummary: null,
    lastAssistantSummary: null,
  };
  // Never ask the bridge for a store that does not exist: its own fallback would open the gateway,
  // and a read-write sqlite handle would leave an empty `state.db` behind that every reader after
  // it has to treat as present.
  if (!sessionId || !fs.existsSync(stateDbPath())) return unknown;
  try {
    const info = await runBridge<unknown>({ op: "session_info", sessionId, repoRoot }, { timeoutMs: 30_000 });
    return normaliseSessionInfo(sessionId, info);
  } catch {
    return unknown;
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

interface HookFile {
  /** mtime, size and the content digest: a rewrite that puts the mtime back still changes the bytes. */
  signature: string;
  /** The bytes to put back. A hook is executable code, so a revert restores it rather than drops it. */
  content: Buffer | null;
  mode: number;
}

type HooksSnapshot = Map<string, HookFile>;

/**
 * mtime alone misses a rewrite inside one tick and a rewrite that puts the mtime back, and this
 * guard has to fail closed: the bytes are part of the key alongside the stat a hook cannot fake.
 * The same read keeps the bytes, because the revert has nothing else to restore from.
 */
const readHookFile = (absolute: string): HookFile => {
  try {
    const stat = fs.statSync(absolute);
    const content = fs.readFileSync(absolute);
    return {
      signature: `${stat.mtimeMs}:${stat.size}:${createHash("sha1").update(content).digest("hex")}`,
      content,
      mode: stat.mode & 0o777,
    };
  } catch {
    // Unreadable is not unchanged, and there are no bytes to put back: it can only be compared.
    return { signature: "0", content: null, mode: 0o644 };
  }
};

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
      snapshot.set(relative, readHookFile(absolute));
    }
  };
  walk(hooksDir, "", 0);
  return snapshot;
};

const changedHooks = (before: HooksSnapshot, after: HooksSnapshot): string[] => {
  const changes = new Set<string>();
  for (const [name, entry] of after) {
    if (before.get(name)?.signature !== entry.signature) changes.add(name);
  }
  for (const name of before.keys()) {
    if (!after.has(name)) changes.add(name);
  }
  return [...changes];
};

/**
 * `.git` is in neither snapshot, so a hook the run rewrote is a change no tree restore can reach:
 * the baseline bytes are written back and a hook the run added is deleted. A rewrite left in place
 * executes on the caller's next git command, which is why this is not best-effort.
 */
const restoreHooks = (hooksDir: string, before: HooksSnapshot, after: HooksSnapshot): string[] => {
  const failures: string[] = [];

  for (const relative of after.keys()) {
    if (before.has(relative)) continue;
    try {
      fs.rmSync(path.join(hooksDir, relative), { force: true, recursive: true });
    } catch (error) {
      failures.push(`${relative} (${errorMessage(error)})`);
    }
  }

  for (const [relative, entry] of before) {
    if (after.get(relative)?.signature === entry.signature) continue;
    if (entry.content === null) {
      failures.push(`${relative} (no baseline bytes were readable)`);
      continue;
    }
    const target = path.join(hooksDir, relative);
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, entry.content);
      fs.chmodSync(target, entry.mode);
    } catch (error) {
      failures.push(`${relative} (${errorMessage(error)})`);
    }
  }

  return failures;
};

/** The hooks dir a linked worktree shares with its repository, before any sandbox overrides it. */
/**
 * A `core.hooksPath` in the caller's own environment answers with the sandbox directory this worker
 * points its children at, so the guard would watch an empty dir while the repository's hooks were
 * rewritten. The repository's own config still decides the path; only the environment override goes.
 */
const withoutGitConfigEnv = (base: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const env = { ...base };
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/i.test(key)) delete env[key];
  }
  return env;
};

export const resolveHooksDir = async (repoRoot: string): Promise<string | null> => {
  const result = await runGit(repoRoot, ["rev-parse", "--git-path", "hooks"], {
    env: withoutGitConfigEnv(process.env),
  });
  if (!result.ok) return null;
  const raw = result.stdout.trim();
  if (!raw) return null;
  return path.isAbsolute(raw) ? raw : path.resolve(repoRoot, raw);
};

/** The one blocked-path rule: the violation scan and the revert that follows it must agree. */
const isBlockedRelativePath = (posix: string): boolean => {
  const segments = posix.split("/").filter(Boolean);
  // An ignored directory is listed as the directory alone, so every segment of it is a directory.
  const directories = posix.endsWith("/") ? segments : segments.slice(0, -1);
  // The same precedence validateModifiedFiles uses: a blocked directory wins over the exemption.
  if (BLOCKED_DIRECTORY_SEGMENTS.some((pattern) => directories.some((directory) => pattern.test(directory)))) {
    return true;
  }
  // Basename, like validateModifiedFiles: a nested `docs/.env.example` is the same template.
  if (ENV_TEMPLATE.test(path.posix.basename(posix))) return false;
  return BLOCKED_PATH_PATTERNS.some((pattern) => pattern.test(posix));
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
    if (!isBlockedRelativePath(file.replace(/\\/g, "/"))) continue;
    // `!!` is ignored: an excluded .env never reaches the diff, so it has to be named here.
    violations.add(code === "!!" ? `ignored secret file: ${file}` : file);
  }
  return [...violations];
};

/** One spelling for every repo-relative path this file compares, whichever listing produced it. */
const posixPaths = (paths: Iterable<string>): string[] => [...paths].map((path) => path.replace(/\\/g, "/"));

/** The paths of a `-z` porcelain listing, which rows carry as `XY<space>path`. */
const statusPaths = (entries: Iterable<string>): string[] =>
  posixPaths([...entries].filter((entry) => entry.length > 3).map((entry) => entry.slice(3)));

/**
 * The blocked paths a run wrote, split by what a revert can still do about them. Both snapshots
 * refuse these paths, so no tree diff names them and the revert works from the listings instead: one
 * the run created is deleted, and one that was already in the checkout is named because its bytes
 * are in neither tree and a revert cannot bring them back.
 */
const splitBlockedChanges = (
  repoRoot: string,
  entries: string[],
  existing: Set<string>,
): { created: string[]; unrestorable: string[] } => {
  const created: string[] = [];
  const unrestorable: string[] = [];
  for (const posix of statusPaths(entries)) {
    if (!isBlockedRelativePath(posix)) continue;
    if (existing.has(posix)) {
      unrestorable.push(posix);
      continue;
    }
    const absolute = path.resolve(repoRoot, posix);
    // A status entry is repository-relative, but a delete driven by one must still not escape it.
    if (isInsidePath(repoRoot, absolute)) created.push(absolute);
  }
  return { created, unrestorable };
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
  // A blocked directory is blocked whole: the name patterns alone miss `.env/local`.
  const directories = segments.slice(0, -1);
  if (BLOCKED_DIRECTORY_SEGMENTS.some((pattern) => directories.some((dir) => pattern.test(dir)))) return true;
  const base = segments[segments.length - 1] ?? "";
  if (ENV_TEMPLATE.test(base)) return false;
  return BLOCKED_PATH_PATTERNS.some((pattern) => pattern.test(posix));
};

/** A throwaway index keeps every snapshot off the caller's own `.git/index`. */
const tempIndexPath = (kind: string): string =>
  path.join(
    os.tmpdir(),
    `hermes-worker-${kind}-${process.pid}-${Math.random().toString(36).slice(2, 10)}.index`,
  );

const tempIndexEnv = (indexFile: string): NodeJS.ProcessEnv => ({ ...process.env, GIT_INDEX_FILE: indexFile });

/** git takes pathspecs on argv, and Windows caps a command line: a big revert travels in batches. */
const MAX_PATHSPEC_ARGS = 100;

const chunked = <T>(items: T[], size: number): T[][] => {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) batches.push(items.slice(index, index + size));
  return batches;
};

/** `:(literal)` so a path holding `*`, `?` or `[` is a name and never a pattern. */
const literalPaths = (files: string[]): string[] => files.map((file) => `:(literal)${file}`);

export interface TreeSnapshot {
  treeSha: string;
  /** Paths the snapshot refused to carry. They are blocked, not absent. */
  skipped: string[];
}

/**
 * The checkout's working tree as a git tree object, built in a throwaway index: the caller's own
 * `.git/index` is never touched, and a staged addition, an unstaged edit, a deletion and an
 * untracked file all appear in the tree. That is what makes `<baseline> <after>` the review
 * boundary — no worktree, no commit, nothing written to the repository.
 */
export const captureWorkingTreeSnapshot = async (repoRoot: string): Promise<TreeSnapshot> => {
  const indexFile = tempIndexPath("snapshot");
  const env = tempIndexEnv(indexFile);
  try {
    // Over an absent index this stages the whole working tree, not a delta against HEAD.
    const staged = await runGit(repoRoot, ["-c", "core.quotePath=false", "add", "-A", "--", "."], { env });
    if (!staged.ok) {
      throw new Error(`git add -A failed in ${repoRoot}: ${(staged.stderr || staged.stdout).trim()}`);
    }

    const listed = await runGit(repoRoot, ["-c", "core.quotePath=false", "ls-files", "-z", "--cached"], { env });
    if (!listed.ok) {
      throw new Error(`git ls-files failed in ${repoRoot}: ${(listed.stderr || listed.stdout).trim()}`);
    }
    const skipped = splitNul(listed.stdout).filter(isBlockedBaselinePath);
    for (const batch of chunked(skipped, MAX_PATHSPEC_ARGS)) {
      // Dropped from the snapshot's index, never from disk: the run still sees the file, the tree
      // that travels back to Antigravity never does.
      const excluded = await runGit(
        repoRoot,
        ["rm", "--cached", "-q", "--ignore-unmatch", "--", ...literalPaths(batch)],
        { env },
      );
      if (!excluded.ok) {
        throw new Error(`excluding blocked paths failed: ${(excluded.stderr || excluded.stdout).trim()}`);
      }
    }

    const tree = await runGit(repoRoot, ["write-tree"], { env });
    if (!tree.ok) {
      throw new Error(`git write-tree failed in ${repoRoot}: ${(tree.stderr || tree.stdout).trim()}`);
    }
    return { treeSha: tree.stdout.trim(), skipped };
  } finally {
    await fsp.rm(indexFile, { force: true }).catch(() => undefined);
  }
};

/** Names only, NUL-separated: a path may hold any byte git does not quote away. */
const gitDiffNames = async (
  repoRoot: string,
  filter: string[],
  from: string,
  to: string,
): Promise<string[]> => {
  if (!from || !to || from === to) return [];
  const result = await runGit(repoRoot, [
    "-c",
    "core.quotePath=false",
    "diff",
    ...filter,
    "--name-only",
    "--no-renames",
    "-z",
    from,
    to,
  ]);
  if (!result.ok) {
    throw new Error(`git diff --name-only ${from} ${to} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return splitNul(result.stdout);
};

/** The binary patch between two trees: the review artifact, and the only thing `git apply` can read. */
export const diffTreeSnapshots = async (
  repoRoot: string,
  baselineTreeSha: string,
  afterTreeSha: string,
): Promise<string> => {
  if (!baselineTreeSha || !afterTreeSha || baselineTreeSha === afterTreeSha) return "";
  const result = await runGit(repoRoot, [
    "-c",
    "core.quotePath=false",
    "diff",
    "--binary",
    "--no-renames",
    baselineTreeSha,
    afterTreeSha,
  ]);
  if (!result.ok) {
    throw new Error(`git diff ${baselineTreeSha} ${afterTreeSha} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
};

/**
 * Puts the checkout back to `baselineTreeSha` for everything `afterTreeSha` changed: files the run
 * added are deleted, files it modified or deleted are restored from the baseline tree. Scoped to
 * the run's own change set, so an edit the user makes while the run is going survives a rollback.
 * Writing the restore through a throwaway index also means the caller's staged work is untouched.
 */
export const restoreWorkingTreeSnapshot = async (
  repoRoot: string,
  baselineTreeSha: string,
  afterTreeSha: string,
): Promise<{ restored: string[]; deleted: string[] }> => {
  if (!baselineTreeSha || !afterTreeSha || baselineTreeSha === afterTreeSha) {
    return { restored: [], deleted: [] };
  }
  const added = await gitDiffNames(repoRoot, ["--diff-filter=A"], baselineTreeSha, afterTreeSha);
  const changed = await gitDiffNames(repoRoot, ["--diff-filter=MD"], baselineTreeSha, afterTreeSha);

  const deleted: string[] = [];
  // Deepest first: a file created inside a directory the baseline holds as a file would otherwise
  // leave a non-empty directory where git expects to write a blob.
  for (const relative of added.sort((left, right) => right.length - left.length)) {
    const target = path.resolve(repoRoot, relative);
    // A tree entry cannot escape the repository; a delete driven by one must not try.
    if (!isInsidePath(repoRoot, target)) continue;
    await fsp.rm(target, { force: true }).catch(() => undefined);
    deleted.push(relative);
    // A directory the run created is part of its work too: rmdir refuses the moment it is not empty.
    let parent = path.dirname(target);
    while (isInsidePath(repoRoot, parent) && !samePath(parent, repoRoot)) {
      try {
        await fsp.rmdir(parent);
      } catch {
        break;
      }
      parent = path.dirname(parent);
    }
  }

  if (changed.length === 0) return { restored: [], deleted };

  const indexFile = tempIndexPath("restore");
  const env = tempIndexEnv(indexFile);
  try {
    for (const batch of chunked(changed, MAX_PATHSPEC_ARGS)) {
      const restored = await runGit(repoRoot, ["checkout", baselineTreeSha, "--", ...literalPaths(batch)], { env });
      if (!restored.ok) {
        throw new Error(
          `restoring ${batch.length} path(s) from ${baselineTreeSha} failed: ${(restored.stderr || restored.stdout).trim()}`,
        );
      }
    }
  } finally {
    await fsp.rm(indexFile, { force: true }).catch(() => undefined);
  }
  return { restored: changed, deleted };
};

/**
 * The porcelain listing, ignored entries included: a diff cannot see an excluded file at all, so
 * this is the only place a `.env` Hermes wrote can be caught. Callers compare two listings and keep
 * what appeared during the run, because the checkout's own ignored files are not the run's work.
 */
const statusEntries = async (repoRoot: string): Promise<string[]> => {
  const result = await runGit(repoRoot, [
    "-c",
    "core.quotePath=false",
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "-z",
    "--ignored",
    "--no-renames",
  ]);
  if (!result.ok) {
    throw new Error(`git status failed in ${repoRoot}: ${(result.stderr || result.stdout).trim()}`);
  }
  return splitNul(result.stdout);
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

/** A compacted session is still resumable, so the rollover budget bounds context, not failures. */
export const DEFAULT_MAX_COMPACTS = 2;

/** One turn unless a verifyCommand needs help; the ceiling stops a broken command looping forever. */
const DEFAULT_VERIFY_TURNS = 3;
const MAX_VERIFY_TURNS = 10;

/** Long enough for a real build and test pass, short enough that a hung command is not the run. */
const VERIFY_TIMEOUT_MS = 15 * 60 * 1000;

/** The environment's value, then the built-in: a malformed or absent setting is never a refusal. */
const resolveMaxCompacts = (requested: number | undefined): number => {
  const raw = requested ?? process.env.HERMES_MAX_COMPACTS?.trim();
  if (raw === undefined || raw === "") return DEFAULT_MAX_COMPACTS;
  const candidate = Number(raw);
  if (!Number.isFinite(candidate) || candidate < 0) return DEFAULT_MAX_COMPACTS;
  return Math.floor(candidate);
};

const resolveMaxTurns = (options: DispatchOptions): number => {
  if (!options.verifyCommand) return 1;
  const requested = options.maxTurns ?? DEFAULT_VERIFY_TURNS;
  if (!Number.isFinite(requested)) return DEFAULT_VERIFY_TURNS;
  return Math.min(Math.max(Math.floor(requested), 1), MAX_VERIFY_TURNS);
};

const truncateText = (value: string, limit: number): string =>
  value.length <= limit ? value : `${value.slice(0, limit)}\n…[truncated at ${limit} chars]`;

/** A rotated session needs a name no earlier turn used, or `-c` would resume the one it replaces. */
const rotatedSessionName = (base: string, turn: number): string => {
  const suffix = ` (cont. ${turn})`;
  const flat = base.replace(/\s+/g, " ").trim();
  const room = Math.max(12, 60 - suffix.length);
  return `${flat.length > room ? `${flat.slice(0, room - 1)}…` : flat}${suffix}`;
};

/** A delta prompt is a pointer, not a listing: past this many paths the shape of the change is lost. */
const MAX_DELTA_FILES = 200;

/**
 * Turn 2+ of one conversation: the checkout already carries the previous turn's work, so the new
 * prompt names what moved under the agent since it last looked. Without it a resumed session keeps
 * reasoning about files as they were and re-reads or reverts them.
 */
export const workspaceDeltaPrompt = (
  files: string[],
  limit: number = MAX_DELTA_FILES,
): string => {
  if (files.length === 0) return "";
  const listed = files.slice(0, limit).map((file) => `- ${file}`);
  if (files.length > limit) listed.push(`- …and ${files.length - limit} more`);
  return [
    "[WORKSPACE DELTA SINCE LAST TURN]",
    "Files that changed in the checkout since your previous turn:",
    ...listed,
  ].join("\n");
};

/** What a rotated session needs to pick the task back up: the summary and the files touched. */
export const priorSessionHandoffPrompt = (input: {
  previousSessionId: string;
  compactionCount: number;
  summary: string | null;
  modifiedFiles: string[];
}): string => {
  const files = input.modifiedFiles.slice(0, 100);
  return [
    "[PRIOR SESSION HANDOFF]",
    `- previous session: ${input.previousSessionId}`,
    `- that session was compacted ${input.compactionCount} time(s); this is a fresh session continuing the same task, so its transcript is not available to you.`,
    input.summary
      ? `- where it left off: ${truncateText(input.summary, 1_500)}`
      : "- no summary of the previous session was written, so recover context from the checkout.",
    files.length > 0
      ? `- files already changed in the checkout: ${files.join(", ")}${input.modifiedFiles.length > files.length ? " …" : ""}`
      : "- no files have been changed in the checkout yet.",
  ].join("\n");
};

/** A failed verification is the next turn's brief, verbatim: the output is the reproduction. */
export const verificationRetryPrompt = (input: {
  command: string;
  exitCode: number | null;
  output: string;
  turn: number;
  maxTurns: number;
}): string =>
  [
    "[VERIFICATION FAILED]",
    `\`${input.command}\` exited ${input.exitCode ?? "unknown"} after turn ${input.turn} of ${input.maxTurns}.`,
    "The checkout is yours to fix: make the command pass, then stop.",
    "Output:",
    truncateText(input.output.trim() || "(no output)", 8_000),
  ].join("\n");

const runFailure = (execution: HermesRun): { exitCode: number | null; failed: boolean } => {
  // A missing exit status is not success, and a stream code of 0 must not mask a non-zero process
  // code (or the other way round). The reported code is the worst one either channel gave: a run
  // called a failure may never hand back exit code 0.
  const codes = [execution.state.exitCode, execution.code].filter(
    (code): code is number => typeof code === "number",
  );
  return {
    exitCode: codes.find((code) => code !== 0) ?? codes[0] ?? null,
    failed: Boolean(execution.spawnError) || execution.timedOut || execution.state.isError ||
      codes.length === 0 || codes.some((code) => code !== 0),
  };
};

/**
 * The verify command runs in the checkout, through the platform shell, with the same sandbox as the
 * run: a verification that trips a hook must not run the caller's hooks either.
 */
export const runVerifyCommand = async (
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  /** The verify shell's pid: it holds the checkout for minutes, so a cancel has to be able to kill it. */
  onChildPid?: (pid: number) => void,
): Promise<{ code: number | null; timedOut: boolean; output: string }> => {
  const shell = isWindows
    ? { file: process.env.ComSpec || "cmd.exe", args: ["/d", "/c", command] }
    : { file: "/bin/sh", args: ["-c", command] };
  const result = await run(shell.file, shell.args, {
    cwd,
    env,
    timeoutMs: VERIFY_TIMEOUT_MS,
    onSpawn: onChildPid,
  });
  const output = [result.stdout, result.stderr].filter((part) => part.trim()).join("\n");
  return {
    code: result.timedOut ? null : result.code,
    timedOut: result.timedOut,
    output: result.timedOut ? `${output}\n[verification timed out after ${VERIFY_TIMEOUT_MS}ms]`.trim() : output,
  };
};

/**
 * One dispatch: guard the prompt, bind the project, run Hermes in the checkout itself, then firewall
 * whatever it produced before Antigravity ever sees it. The run answers with a running descriptor
 * when it outlives the fast-wait window; the pipeline keeps going and publishes its result through
 * the run registry.
 *
 * Nothing is copied and nothing is committed: the review boundary is the pair of tree objects
 * (before the run, after the run), so a rejected run is reverted by restoring those paths rather
 * than by throwing a worktree away.
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

  // A subdirectory is still one repository: the tree objects that define the review boundary are
  // per checkout, so every git call below runs from the toplevel.
  const topLevel = await runGit(project.repoRoot, ["rev-parse", "--show-toplevel"]);
  if (!topLevel.ok) {
    throw new Error(
      `${project.repoRoot} is not a git repository: ${(topLevel.stderr || topLevel.stdout).trim()}`,
    );
  }
  const repoRoot = path.resolve(topLevel.stdout.trim());

  const runId = options.runId ?? makeRunId();
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(`Refused to dispatch: '${runId}' is not a valid run id ([A-Za-z0-9_-]).`);
  }
  // A crashed dispatch never reaches clearRunState, so every dispatch is what reaps the ones before
  // it: reaping from the record writer instead would delete files under a caller that never asked.
  await pruneStaleRuns().catch(() => undefined);
  const sessionName = options.sessionName ?? `[AGY] ${truncateTitle(options.prompt, 48)}`;
  const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const fastWaitSeconds = options.fastWaitSeconds ?? DEFAULT_FAST_WAIT_SECONDS;
  const startedAt = Date.now();
  const conversationId = options.conversationId?.trim() || null;
  const maxCompacts = resolveMaxCompacts(options.maxCompacts);
  const maxTurns = resolveMaxTurns(options);
  const sessionProbe = options.sessionProbe ?? readSessionAfterRun;
  const runHandle = `agy-${runId}`;

  // Hooks are executable code inside the review boundary: a hook left behind by the worker would
  // run on the caller's next git call. The sandbox travels in the child's environment and diffing
  // the real hooks dir afterwards catches anything a hook wrote despite it.
  const hooksDir = await resolveHooksDir(repoRoot);
  const hooksBefore = hooksDir ? snapshotHooks(hooksDir) : null;
  const emptyHooksDir = path.join(os.tmpdir(), "hermes-worker-empty-hooks", runId);
  const usageFile = path.join(os.tmpdir(), `hermes-usage-${runId}.json`);
  const promptFile = path.join(os.tmpdir(), `hermes-prompt-${runId}.txt`);
  const runEnv = sandboxedGitEnv(process.env, emptyHooksDir, repoRoot);
  await fsp.mkdir(emptyHooksDir, { recursive: true }).catch(() => undefined);

  // The baseline is the checkout as it stands now, as a tree object: the run edits these very files,
  // so this is the only record of what Antigravity's tree looked like before Hermes touched it.
  const baseline = await captureWorkingTreeSnapshot(repoRoot);
  const baselineTreeSha = baseline.treeSha;
  // Ignored entries are invisible to a diff, so the guard compares listings instead of trees.
  const statusBefore = new Set(await statusEntries(repoRoot));

  // Turn 2+ of one conversation continues the session the last turn left behind, and the delta
  // prompt is built from the tree that turn ended on.
  const remembered =
    conversationId && options.newSession !== true
      ? await readConversationSession(conversationId, repoRoot)
      : null;
  const resumeTarget = options.resumeSessionId?.trim() || remembered?.sessionId || null;
  const initialTreeSha = remembered?.initialTreeSha ?? baselineTreeSha;
  const previousAfterTreeSha = remembered?.lastAfterTreeSha ?? null;

  const live: { sessionId: string | null; childPid: number | null } = {
    sessionId: resumeTarget,
    childPid: null,
  };

  const result: DispatchResult = {
    runId,
    success: false,
    sessionId: resumeTarget,
    sessionName,
    project,
    repoRoot,
    runHandle,
    baselineTreeSha,
    afterTreeSha: null,
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
    changesKept: false,
    turns: 0,
    verifyExitCode: null,
    verifyTimedOut: false,
    sessionRotated: false,
    abortedFallback: false,
    cancelled: false,
    message: "",
  };

  let runLog: RunLog | null = null;
  const runPipeline = async (): Promise<DispatchResult> => {
    const before = snapshotPendingIds();
    // Turn 1's prompt: the caller's task plus the boundary, and the workspace delta when a previous
    // turn of the same conversation left changes behind.
    let promptText = injectWorkerBoundary(options.prompt);
    let turnSessionName = sessionName;
    let sessionId = resumeTarget;
    let afterTreeSha = baselineTreeSha;

    try {
      if (sessionId && previousAfterTreeSha && previousAfterTreeSha !== baselineTreeSha) {
        const delta = workspaceDeltaPrompt(
          await gitDiffNames(repoRoot, [], previousAfterTreeSha, baselineTreeSha),
        );
        if (delta) promptText = `${delta}\n\n${promptText}`;
      }

      runLog = openRunLog(runLogPath(runId));

      // The last turn's verdict: a verification retry only helps when the turn itself ran.
      let turnFailed = false;
      /** One verdict at every point a cancel is noticed: the canceller owns the revert, not this loop. */
      const cancelled = (): DispatchResult => {
        result.cancelled = true;
        result.success = false;
        result.changesKept = false;
        result.message = "Cancelled while executing: the child was killed and the checkout was reverted.";
        return result;
      };

      for (;;) {
        // Checked before every spawn: a turn started after a cancel writes into a checkout the
        // canceller is reverting, and its pid never reaches a record that is already terminal.
        if (isRunCancelled(runId)) return cancelled();
        result.turns += 1;
        if (sessionId) {
          const info = await sessionProbe(sessionId, repoRoot).catch(() => null);
          if (info && info.compactionCount >= maxCompacts) {
            // The session's own context is the budget: rotate before it is spent entirely, and hand
            // the fresh session what the old one cannot carry across.
            const handoff = priorSessionHandoffPrompt({
              previousSessionId: sessionId,
              compactionCount: info.compactionCount,
              summary: info.compactionSummary ?? info.lastAssistantSummary,
              modifiedFiles: await gitDiffNames(repoRoot, [], initialTreeSha, afterTreeSha).catch(() => []),
            });
            promptText = `${handoff}\n\n${promptText}`;
            turnSessionName = rotatedSessionName(sessionName, result.turns);
            sessionId = null;
            result.sessionRotated = true;
          } else if (info?.tipSessionId) {
            // A compaction advances the session the next turn must continue from.
            sessionId = info.tipSessionId;
          }
        }

        await fsp.writeFile(promptFile, promptText, "utf8");
        const args = buildChatArgs({
          promptFile,
          repoRoot,
          sessionName: turnSessionName,
          model: options.model,
          reasoning: options.reasoning,
          skills: options.skills,
          usageFile,
          resumeSessionId: sessionId ?? undefined,
        });

        const execution = await execHermes({
          args,
          cwd: repoRoot,
          timeoutSeconds,
          repoRoot,
          env: runEnv,
          onSessionId: (reported) => {
            live.sessionId = reported;
            result.sessionId = reported;
            // Published mid-run so a waiter can name the session while it is still going.
            void publish({ ...runningState(), sessionId: reported });
          },
          onChildPid: (pid) => void publishChildPid(pid),
          log: runLog,
        });

        // Turn 1 is the only turn whose fallback verdict is a hard failure, so it is never lost.
        result.abortedFallback = result.abortedFallback || execution.abortedFallback;
        sessionId = execution.state.sessionId ?? sessionId;
        // The child is gone, so the handle must not outlive it: a cancel reading a dead pid after the
        // OS recycled it would kill a process this run never started.
        await publishChildPid(null);
        if (isRunCancelled(runId)) return cancelled();

        turnFailed = runFailure(execution).failed;
        result.timedOut = execution.timedOut;
        result.exitCode = runFailure(execution).exitCode;
        result.summary = execution.state.text;
        result.toolEvents = execution.state.toolEvents;
        result.tokens = execution.state.tokens;
        result.durationMs = execution.state.durationMs;
        result.error = execution.state.error;

        // Captured for every turn: a rollback after a failed verification must undo that turn too.
        afterTreeSha = (await captureWorkingTreeSnapshot(repoRoot)).treeSha;
        result.afterTreeSha = afterTreeSha;

        // A turn that was killed has nothing to verify, and a 15-minute build after a 30-minute
        // timeout is not the caller's time to spend.
        if (!options.verifyCommand || result.timedOut) break;
        if (isRunCancelled(runId)) return cancelled();
        // The verification holds the checkout for minutes and is spawned here, so it is published
        // like a turn: otherwise a cancel has no handle on the one process that is still writing.
        const verification = await runVerifyCommand(
          options.verifyCommand,
          repoRoot,
          runEnv,
          (pid) => void publishChildPid(pid),
        );
        await publishChildPid(null);
        if (isRunCancelled(runId)) return cancelled();
        result.verifyExitCode = verification.code;
        result.verifyTimedOut = verification.timedOut;
        if (verification.code === 0) break;
        // A verification the clock killed is terminal: another turn would spend the same timeout
        // again, and its output is the timeout notice rather than a reproduction.
        if (verification.timedOut) {
          result.message = `Verification \`${options.verifyCommand}\` timed out after ${result.turns} turn(s).`;
          break;
        }
        // Resuming a session that just failed to produce anything would only repeat the failure.
        if (result.turns >= maxTurns || !sessionId || turnFailed) {
          result.message = `Verification \`${options.verifyCommand}\` exited ${verification.code ?? "unknown"} after ${result.turns} turn(s).`;
          break;
        }
        promptText = verificationRetryPrompt({
          command: options.verifyCommand,
          exitCode: verification.code,
          output: verification.output,
          turn: result.turns,
          maxTurns,
        });
      }

      // A verification that never passed is a failed dispatch even when every turn exited 0: the
      // caller asked for the command to hold, not for the attempt to be reported as success. A
      // timed-out verification reports no exit code, so it has to fail this verdict on its own.
      const verificationFailed =
        result.verifyTimedOut || (result.verifyExitCode !== null && result.verifyExitCode !== 0);
      const failed = turnFailed || verificationFailed;

      result.sessionId = sessionId;
      if (!result.message) {
        if (result.timedOut) result.message = `Hermes produced no output for ${timeoutSeconds}s and was killed.`;
        else if (failed) result.message = `Hermes exited ${result.exitCode ?? "unknown"}${result.error ? `: ${result.error}` : ""}.`;
      }

      // Read before the hook check: either violation ends the run, and the secrets the run created
      // are part of what the revert has to undo whatever stopped it.
      const statusAfter = await statusEntries(repoRoot);
      const writtenDuringRun = statusAfter.filter((entry) => !statusBefore.has(entry));
      // A blocked path is absent from both trees, so "was it there already" comes from the baseline
      // snapshot's skipped list and the status listing taken before the run.
      const existedBefore = new Set([...posixPaths(baseline.skipped), ...statusPaths(statusBefore)]);
      const blocked = splitBlockedChanges(repoRoot, writtenDuringRun, existedBefore);
      const unrestorable = blocked.unrestorable.length > 0
        ? ` Blocked paths the revert cannot restore: ${blocked.unrestorable.join(", ")}.`
        : "";

      if (hooksDir && hooksBefore) {
        // One read of the directory: the same listing decides the violation and what to put back.
        const hooksAfter = snapshotHooks(hooksDir);
        const touched = changedHooks(hooksBefore, hooksAfter);
        if (touched.length > 0) {
          result.securityViolation = true;
          result.success = false;
          result.violations = touched.map((hook) => `git hook changed: ${hook}`);
          // Restored by hand: `.git` is in neither snapshot, so the tree restore cannot reach it.
          const unrestored = restoreHooks(hooksDir, hooksBefore, hooksAfter);
          const reverted = await revertRun(blocked.created);
          // The checkout no longer holds this session's work, so the binding must go with it.
          await forgetConversation();
          result.message =
            `Security violation: git hooks changed during the run (${touched.join(", ")}) — changes reverted` +
            `${reverted}.` +
            (unrestored.length > 0 ? ` Hooks that could not be restored: ${unrestored.join(", ")}.` : "") +
            unrestorable;
          return result;
        }
      }

      result.modifiedFiles = await gitDiffNames(repoRoot, [], baselineTreeSha, afterTreeSha);
      const violations = secretViolations(
        writtenDuringRun.join("\0"),
        new Set(validateModifiedFiles(result.modifiedFiles, repoRoot).violations),
      );

      result.diff = await diffTreeSnapshots(repoRoot, baselineTreeSha, afterTreeSha);
      if (result.diff.length > MAX_DIFF_CHARS) {
        result.diff = `${result.diff.slice(0, MAX_DIFF_CHARS)}\n\n[diff truncated at ${MAX_DIFF_CHARS} chars]`;
        result.diffTruncated = true;
      }
      result.violations = violations;

      // The native usage ledger is authoritative for the turn that was billed; the session row is
      // only a fallback because the gateway writes it asynchronously and a settling run can be
      // missing. Both travel through Hermes' own code, never through a second sqlite reader.
      const usage = readUsageReport(usageFile);
      const sessionRow = result.sessionId ? await readSessionAfterRun(result.sessionId, repoRoot) : null;
      if (sessionRow) result.reasoning = sessionRow.reasoning;
      if (usage?.tokens) result.tokens = { ...(result.tokens ?? {}), ...usage.tokens };
      // A present ledger carries a verdict on cost even when that verdict is "unknown" (null).
      if (usage) result.costUsd = usage.costUsd;

      let attributionUnknown = false;
      const attributedModel = usage?.model ?? sessionRow?.model ?? null;
      const attributedProvider = usage?.provider ?? sessionRow?.provider ?? null;
      result.model = attributedModel;
      result.provider = attributedProvider;

      const requestedModel = options.model || DEFAULT_MODEL;
      // A fallback is either explicit in the session's routing record, or proven by the ledger
      // naming a model nobody asked for. An absent ledger proves nothing in either direction.
      const fallbackProven =
        sessionRow?.fallbackActive === true ||
        (usage !== null && usage.model !== null && !sameModelId(usage.model, requestedModel));
      if (!result.abortedFallback) result.modelFallback = fallbackProven;

      if (result.modelFallback) {
        result.warning =
          result.warning ??
          `Ran on ${attributedModel ?? "unknown"} (${attributedProvider ?? "unknown"}) instead of ${requestedModel}: ` +
            "the requested model was refused by its provider.";
        result.message = `Dispatch refused: Go allowance exhausted, ran on fallback ${attributedModel ?? "unknown"}. No changes are reviewable.`;
      } else if (usage === null && !sessionRow?.known) {
        attributionUnknown = true;
      }

      if (usage?.failed && usage.failure) result.error = result.error ?? usage.failure;

      if (result.modelFallback) {
        const reverted = await revertRun(blocked.created);
        result.success = false;
        await forgetConversation();
        result.message = `${result.message} The checkout was reverted${reverted}.`;
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
        const reverted = await revertRun(blocked.created);
        await forgetConversation();
        result.message = `Security violation: ${violations.join(", ")} — changes reverted${reverted}.${unrestorable}`;
        return result;
      }

      // The checkout is the only copy of the work: it stays where it is, whatever the verification
      // said, and the caller decides what to do with it.
      await rememberSession(sessionId, afterTreeSha);

      if (result.modifiedFiles.length === 0) {
        result.success = !failed && !attributionFailed;
        result.message = result.message || "No files were modified; the checkout was left as it was.";
        return result;
      }

      result.changesKept = true;
      result.success = !failed && !attributionFailed;
      const metadata = runMetadata(result);
      result.message =
        result.message ||
        `${result.modifiedFiles.length} file(s) changed in ${repoRoot}${metadata.duration}. Revert with ` +
          `hermes_worktree_action action=discard runHandle=${runHandle}.` +
          (baseline.skipped.length > 0 ? ` Skipped from the snapshot: ${baseline.skipped.join(", ")}.` : "") +
          metadata.brackets;
      return result;
    } catch (error) {
      result.success = false;
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

  /**
   * Nothing is deleted until the run is refused: the checkout is the only copy of its work. A blocked
   * path is in neither snapshot, so the tree cannot take back the secret the run wrote: those paths
   * are deleted by name here, or the "reverted" verdict is a claim the checkout does not support.
   */
  const revertRun = async (secretPaths: string[] = []): Promise<string> => {
    const failures: string[] = [];
    for (const target of secretPaths) {
      try {
        await fsp.rm(target, { recursive: true, force: true });
      } catch (error) {
        failures.push(`${target} could not be deleted (${errorMessage(error)})`);
      }
    }

    const after = result.afterTreeSha;
    if (after) {
      try {
        await restoreWorkingTreeSnapshot(repoRoot, baselineTreeSha, after);
        result.modifiedFiles = [];
        result.diff = "";
        result.diffTruncated = false;
        result.changesKept = false;
        // The checkout is back at the baseline: a later discard must not try to revert an after-tree
        // that no longer describes anything.
        result.afterTreeSha = baselineTreeSha;
      } catch (error) {
        failures.push(`reverting the checkout failed (${errorMessage(error)})`);
      }
    }

    return failures.length > 0 ? ` (and ${failures.join("; ")})` : "";
  };

  /**
   * The binding is what a second dispatch on the same conversation resumes from, so it is written
   * only when the run left its changes in place: a reverted run has no session worth continuing.
   */
  const rememberSession = async (sessionId: string | null, afterTreeSha: string): Promise<void> => {
    if (!conversationId || !sessionId) return;
    const record: ConversationSessionRecord = {
      conversationId,
      repoRoot,
      sessionId,
      initialTreeSha,
      lastAfterTreeSha: afterTreeSha,
      updatedAt: Date.now(),
    };
    await writeConversationSession(record).catch(() => undefined);
  };

  const forgetConversation = async (): Promise<void> => {
    if (!conversationId) return;
    await clearConversationSession(conversationId, repoRoot).catch(() => undefined);
  };

  // State writes go through one queue: the `running` record can never land after the completion
  // record and resurrect a finished run.
  let stateQueue: Promise<void> = Promise.resolve();
  const publish = (state: RunState): Promise<void> => {
    stateQueue = stateQueue.then(async () => {
      // One-way: a cancel settles the record from another process, and a queued `running` write
      // landing afterwards would restore a run a cancel has already reverted.
      if (state.status === "running" && readRunState(runId)?.status === "completed") return;
      await writeRunState(state).catch(() => undefined);
    });
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
    repoRoot,
    baselineTreeSha,
    initialTreeSha,
    conversationId: conversationId ?? undefined,
    startedAt,
    workerPid: process.pid,
    childPid: live.childPid ?? undefined,
    sessionId: live.sessionId,
  });

  /**
   * The live child handle: published at every spawn, cleared the moment that child exits. It is
   * written even into a record another process has already settled, because a cancel can only kill a
   * process it can find — the status and the result of that record are never touched here.
   */
  const publishChildPid = (pid: number | null): Promise<void> => {
    live.childPid = pid;
    stateQueue = stateQueue.then(async () => {
      const current = readRunState(runId);
      if (!current) return;
      await writeRunState({ ...current, childPid: pid ?? undefined }).catch(() => undefined);
    });
    return stateQueue;
  };

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
    // The run's changes are already in the checkout, so `includeDiff` is the only choice left: the
    // diff body is a review aid, not a delivery mechanism.
    if (options.includeDiff === false) {
      settled.diff = "";
      settled.diffTruncated = false;
      settled.diffOmitted = true;
    }
    settled.status = "completed";
    // A cancelled run already has its terminal record, and the waiter that wrote it owns it: writing
    // again would replace a file the waiter has just consumed. Anything else still settles the run,
    // because a record left at `running` keeps a waiter polling a process that has already finished.
    if (!isRunCancelled(runId)) {
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
    repoRoot,
    runHandle,
    baselineTreeSha,
    waitCommand: `node "${waitJs}" "${runId}"`,
    message:
      `Hermes is still running after ${fastWaitSeconds}s. Execute waitCommand as a background ` +
      "command to receive a completion callback when the run finishes.",
  };
};

/** The tree a run left behind, when it recorded one: the scope of everything a discard reverts. */
const recordedAfterTree = (state: RunState | null): string | null => {
  const result = state?.result;
  if (!result || typeof result !== "object") return null;
  const after = (result as { afterTreeSha?: unknown }).afterTreeSha;
  return typeof after === "string" && after ? after : null;
};

/**
 * Discard reverts the checkout to the tree the run started from; cancel stops a live run and does
 * the same. `apply` is a legacy action: a snapshot run is already in the caller's checkout, so there
 * is nothing to land, and refusing says so instead of pretending to have copied something.
 *
 * A run recorded before snapshots existed still resolves to its `.worktrees/agy-*` branch, so an
 * in-flight worktree from an older worker can still be applied or thrown away.
 */
export const manageWorktree = async (options: {
  action: "apply" | "discard" | "cancel";
  cwd: string;
  /** The run handle hermes_dispatch reported (`agy-<runId>`), or a legacy branch name. */
  runHandle?: string;
  legacyBranch?: string;
  worktreeBranch?: string;
  /** The run that is itself calling this after finishing; its state file still says `running`. */
  activeRunId?: string;
}): Promise<{ success: boolean; message: string; patchPath?: string; violations?: string[]; reverted?: string[] }> => {
  const handle = (options.runHandle ?? options.worktreeBranch ?? options.legacyBranch ?? "").trim();
  // Anything that is not a run handle is a user branch: reverting the checkout for it would destroy
  // work this bridge never made.
  const match = handle.match(/^(?:hermes\/)?(?:agy-)?([A-Za-z0-9_-]+)$/);
  if (!match) {
    return {
      success: false,
      message:
        `Refusing to touch '${handle}': expected the run handle hermes_dispatch reported ` +
        "(agy-<runId>) or a legacy hermes/agy-<runId> branch.",
    };
  }

  const runId = match[1];
  const legacyBranch = `hermes/agy-${runId}`;
  const activeRun = readRunState(runId);

  // Cancel is the only action allowed to interrupt a live run: it kills the tree and settles the run
  // record, and the revert below is what puts the checkout back.
  let killedChildren = 0;
  if (options.action === "cancel") {
    // Published before the kill, never after: the pipeline notices its own cancellation by reading
    // this record when the child's close event lands, and a record written afterwards would arrive
    // too late to stop it from spawning the next turn.
    if (activeRun) {
      // Re-read for the child handle: the pipeline may have published a verification pid since this
      // call started, and overwriting it would hide the process the kill below is aiming at.
      const settled = readRunState(runId) ?? activeRun;
      await writeRunState({
        ...settled,
        status: "completed",
        result: {
          success: false,
          cancelled: true,
          message: "Cancelled: the run's process tree was stopped.",
          timedOut: false,
        },
      }).catch(() => undefined);
    }

    // Only the children are killed. `workerPid` is this very bridge process, whose own liveness the
    // record reports: signalling it would take the MCP server down with the run.
    const quiesced = await quiesceRunChildren(runId);
    killedChildren = quiesced.killed;
    if (!quiesced.quiet) {
      // Reverting now would race the process that is still writing: the caller would be told the
      // checkout was restored while the run kept editing it.
      return {
        success: false,
        message:
          `Cancelled run '${runId}' but its process tree did not stop within ${CANCEL_QUIESCE_MS}ms; ` +
          "the checkout was left untouched. Retry the cancel once the run's child has exited.",
      };
    }
  }

  // Refuse to touch a checkout a run is actively editing. A run that is applying its own result
  // names itself here: it cannot be mid-execution by definition. A record whose worker pid no longer
  // answers is not editing anything either, and refusing it would strand the run's work forever.
  if (
    options.action !== "cancel" &&
    activeRun &&
    activeRun.status === "running" &&
    !isRunAbandoned(activeRun) &&
    options.activeRunId !== runId
  ) {
    return {
      success: false,
      message:
        `Refusing to ${options.action} '${handle}': Hermes run '${runId}' is still actively ` +
        "executing. Wait for the run to finish, or cancel it.",
    };
  }

  // A call from a subdirectory must still act on the repository root the run executed in.
  const topLevel = await runGit(options.cwd, ["rev-parse", "--show-toplevel"]);
  if (!topLevel.ok) {
    return {
      success: false,
      message: `${options.cwd} is not a git repository: ${(topLevel.stderr || topLevel.stdout).trim()}`,
    };
  }
  const repoRoot = path.resolve(topLevel.stdout.trim());

  const baselineTreeSha = activeRun?.baselineTreeSha ?? null;
  if (baselineTreeSha) {
    if (options.action === "apply") {
      return {
        success: false,
        message:
          `Nothing to apply for run '${runId}': it executed directly in ${repoRoot}, so its changes ` +
          `are already in the checkout. Use action=discard to revert them.`,
      };
    }

    // A completed run recorded the tree it ended on; a cancelled or crashed one has only what is on
    // disk now, and that is exactly what the revert has to remove. The child is reaped before the
    // snapshot: a process still writing would land its last edits after the tree was captured.
    if (typeof activeRun?.childPid === "number") await stopChildProcess(activeRun.childPid);
    const afterTreeSha = recordedAfterTree(activeRun) ?? (await captureWorkingTreeSnapshot(repoRoot)).treeSha;

    let reverted: string[];
    try {
      const restored = await restoreWorkingTreeSnapshot(repoRoot, baselineTreeSha, afterTreeSha);
      reverted = [...restored.deleted, ...restored.restored];
    } catch (error) {
      return {
        success: false,
        message: `Could not revert run '${runId}' in ${repoRoot}: ${errorMessage(error)}`,
      };
    }

    // The remembered session describes a checkout that no longer holds its work: drop the binding so
    // the next dispatch starts from what is actually there.
    if (activeRun?.conversationId) {
      await clearConversationSession(activeRun.conversationId, repoRoot).catch(() => undefined);
    }

    const verb = options.action === "cancel" ? "Cancelled" : "Discarded";
    // What was killed is part of the verdict: a cancel that found nothing is a different answer.
    const killed = options.action === "cancel" && killedChildren > 0
      ? ` Killed ${killedChildren} child process tree(s).`
      : "";
    return {
      success: true,
      reverted,
      message:
        (reverted.length === 0
          ? `${verb} run '${runId}'; ${repoRoot} already matched the tree the run started from.`
          : `${verb} run '${runId}': reverted ${reverted.length} file(s) in ${repoRoot}.`) + killed,
    };
  }

  // Legacy: a run recorded by a worker that still created `.worktrees/agy-*` checkouts.
  const worktreesRoot = path.join(repoRoot, ".worktrees");
  const entries = await listWorktrees(repoRoot);
  const target = entries.find((entry) => entry.branch === legacyBranch);
  if (!target) {
    return {
      // A cancel that killed a live run has already achieved its purpose; a missing worktree is only
      // a failure when the caller expected one to be there to act on.
      success: options.action === "cancel",
      message:
        options.action === "cancel"
          ? `Cancelled run '${runId}'; it had no checkout under ${repoRoot} to revert.`
          : `No worktree for branch '${legacyBranch}' under ${repoRoot}, and run '${runId}' recorded no snapshot to revert.`,
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
    const removed = await removeWorktree(repoRoot, target.path, legacyBranch);
    return removed.ok ? null : (removed.error ?? "worktree cleanup failed");
  };

  if (options.action === "discard" || options.action === "cancel") {
    const cleanupError = await cleanup();
    const verb = options.action === "cancel" ? "Cancelled and discarded" : "Discarded";
    return cleanupError
      ? { success: false, message: `${verb} the worktree but ${cleanupError}.` }
      : { success: true, message: `${verb} worktree and branch '${legacyBranch}'.` };
  }

  // `merge-base` is the branch point, which is caller HEAD — it sits BELOW the baseline commit,
  // so diffing from it re-emits the caller's uncommitted work and the patch collides with their
  // dirty tree. The baseline commit is the review boundary: everything the caller already had.
  const mergeBase = await runGit(repoRoot, ["merge-base", legacyBranch, "HEAD"]);
  if (!mergeBase.ok) {
    return {
      success: false,
      message: `Could not find a merge base for '${legacyBranch}': ${mergeBase.stderr.trim()}`,
    };
  }
  const baseSha = (await resolveBaselineSha(repoRoot, mergeBase.stdout.trim(), legacyBranch)) ?? mergeBase.stdout.trim();

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
      // The paths travel as a list: a caller re-splitting the message breaks on a name with ', '.
      violations,
      message:
        `Refused to apply '${legacyBranch}': ${violations.join(", ")}. ` +
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
        `No changes to apply on '${legacyBranch}'; worktree removed.` +
        (cleanupError ? ` (${cleanupError})` : ""),
    };
  }

  const patchDir = path.join(repoRoot, ".worktrees");
  await fsp.mkdir(patchDir, { recursive: true });
  const patchPath = path.join(patchDir, `${legacyBranch.replace(/[\\/]/g, "-")}.patch`);
  await fsp.writeFile(patchPath, diff.stdout, "utf8");

  // `git apply --3way` implies `--index`, which fails with "does not match index" when the caller
  // has uncommitted/unstaged edits in any of the patched files. Try `--3way` first; if rejected by
  // the index mismatch, fall back to applying directly to the working tree.
  let applied = await runGit(repoRoot, ["apply", "--3way", "--binary", patchPath]);
  const threeWay = applied.ok;
  if (!applied.ok && /does not match index/i.test(`${applied.stdout}${applied.stderr}`)) {
    applied = await runGit(repoRoot, ["apply", "--binary", patchPath]);
  }
  // A skipped hunk still exits 0: `Skipped patch 'x'` on either stream is a refusal, not a success.
  if (!applied.ok || SKIPPED_PATCH.test(`${applied.stdout}${applied.stderr}`)) {
    return {
      success: false,
      message:
        `git apply failed: ${(applied.stderr || applied.stdout).trim()}. ` +
        `The patch is at ${patchPath} and the worktree was kept.`,
      patchPath,
    };
  }
  // `--index` staged what the plain path leaves alone, so the same apply would sometimes hand the
  // caller a staged index. The run lands in the working tree either way.
  if (threeWay && modifiedFiles.length > 0) {
    await runGit(repoRoot, ["reset", "-q", "--", ...literalPaths(modifiedFiles)]);
  }

  const cleanupError = await cleanup();
  await fsp.rm(patchPath, { force: true });
  return {
    success: true,
    message:
      `Applied '${legacyBranch}' to ${repoRoot}; worktree removed.` +
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

/**
 * The session listing, read through Hermes' own Python: the schema, the LIKE escaping and the
 * case-insensitivity of a path are all Hermes' business, and a second sqlite reader here would
 * silently break on the next migration. An absent store is an empty listing, never a created one.
 */
export const listHermesSessions = async (
  options: { cwd?: string; limit?: number } = {},
): Promise<SessionSummaryRow[]> => {
  const dbPath = stateDbPath();
  // Asking the bridge would let its gateway fallback answer for a store that does not exist, and any
  // read-write handle would leave an empty `state.db` behind for every later reader.
  if (!fs.existsSync(dbPath)) return [];
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 200);
  try {
    const result = await runBridge<{ sessions?: unknown }>(
      { op: "sessions_list", cwd: options.cwd, limit },
      { timeoutMs: 60_000 },
    );
    return Array.isArray(result?.sessions) ? (result.sessions as SessionSummaryRow[]) : [];
  } catch (error) {
    // A locked or corrupt store is the caller's to act on, and a bare sqlite error is not: name it.
    throw new Error(`Could not read Hermes sessions from ${dbPath}: ${errorMessage(error)}`);
  }
};
