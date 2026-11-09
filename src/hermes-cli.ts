import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { isWindows, runGit } from "./exec.js";
import {
  BLOCKED_PATH_PATTERNS,
  injectWorkerBoundary,
  scanPromptForSecrets,
  validateModifiedFiles,
} from "./guardrails.js";
import { hermesExe, stateDbPath } from "./hermes-paths.js";
import {
  collectNewPendingWrites,
  snapshotPendingIds,
  type PendingRecord,
} from "./memory-manager.js";
import { resolveAntigravityProject, type ResolvedProject } from "./project-binding.js";
import { formatStreamLine, openRunLog, type RunLog } from "./run-log.js";
import {
  RUN_ID_PATTERN,
  clearRunState,
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
  runId?: string;
}

/** Pinned so a dispatch is reproducible regardless of what Hermes' config was last set to. */
export const DEFAULT_MODEL = "cline-pass/deepseek-v4.1-flash-1017";
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
  summary: string;
  reasoning: string | null;
  /** What actually answered, which is not always what was requested: Hermes falls back on 429. */
  model: string | null;
  provider: string | null;
  /** True when cline pass was refused and a different model answered. Treated as a hard failure —
   * the dispatch never silently lands on a fallback model. */
  modelFallback: boolean;
  warning: string | null;
  toolEvents: ToolEvent[];
  tokens: Record<string, unknown> | null;
  durationMs: number | null;
  exitCode: number | null;
  error: string | null;
  timedOut: boolean;
  securityViolation: boolean;
  violations: string[];
  pendingWrites: PendingRecord[];
  worktreeKept: boolean;
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

/**
 * Removal is idempotent and reports the first real failure: a locked worktree is unlocked first,
 * an already-deleted directory is not an error, and a branch git no longer knows is tolerated.
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

  const removed = await runGit(repoRoot, ["worktree", "remove", "--force", worktreePath]);
  if (!removed.ok) {
    // A half-registered worktree still has to go: drop the directory, then let prune fix the admin data.
    await fsp.rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
    await runGit(repoRoot, ["worktree", "prune"]);
    if (fs.existsSync(worktreePath)) {
      errors.push(`git worktree remove failed: ${(removed.stderr || removed.stdout).trim()}`);
    }
  }

  const deleted = await runGit(repoRoot, ["branch", "-D", branch]);
  if (!deleted.ok && !/not found/i.test(`${deleted.stderr}${deleted.stdout}`)) {
    errors.push(`git branch -D ${branch} failed: ${(deleted.stderr || deleted.stdout).trim()}`);
  }

  return errors.length > 0 ? { ok: false, error: errors[0] } : { ok: true };
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

const collectToolEvents = (node: unknown, sink: ToolEvent[], depth = 0): void => {
  if (!node || typeof node !== "object" || depth > 6) return;
  if (Array.isArray(node)) {
    for (const item of node) collectToolEvents(item, sink, depth + 1);
    return;
  }
  const record = node as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";
  if (type === "tool_use") {
    sink.push({
      type,
      name: String(record.name ?? "tool"),
      detail: String(record.id ?? ""),
    });
  } else if (type === "tool_result") {
    const content = record.content;
    const text = Array.isArray(content)
      ? content
          .map((part) => (part && typeof part === "object" ? String((part as Record<string, unknown>).text ?? "") : ""))
          .join(" ")
      : typeof content === "string"
        ? content
        : "";
    sink.push({
      type,
      name: String(record.tool_use_id ?? "result"),
      detail: text.slice(0, 200),
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
}

export interface ChatArgsOptions {
  promptFile: string;
  worktreePath: string;
  sessionName: string;
  model?: string;
  reasoning?: string;
  skills?: string[];
}

export const buildChatArgs = (options: ChatArgsOptions): string[] => {
  const args = [
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
    "clinepass",
    "--model",
    options.model || DEFAULT_MODEL,
    "--reasoning",
    options.reasoning || DEFAULT_REASONING,
  ];
  if (options.skills?.length) args.push("--skills", options.skills.join(","));
  return args;
};

/**
 * `log` receives every formatted line as the child emits it, which is what makes the run tailable
 * live: the stream is flushed per event rather than at exit.
 */
const execHermes = (
  args: string[],
  cwd: string,
  timeoutSeconds: number,
  onSessionId?: (sessionId: string) => void,
  log?: RunLog,
): Promise<HermesRun> =>
  new Promise((resolve) => {
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

    const child = spawn(hermesExe(), args, {
      cwd,
      windowsHide: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let buffer = "";
    let stderr = "";
    let timedOut = false;
    let spawnError: string | null = null;

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid && isWindows) {
        spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      } else {
        child.kill("SIGKILL");
      }
    }, timeoutSeconds * 1000);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const previous = state.sessionId;
        ingestStreamLine(line, state);
        log?.write(formatStreamLine(line));
        if (state.sessionId && state.sessionId !== previous) onSessionId?.(state.sessionId);
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 40_000) stderr = stderr.slice(-40_000);
    });

    child.on("error", (error: Error) => {
      spawnError = error.message;
    });

    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (buffer.trim()) {
        const previous = state.sessionId;
        ingestStreamLine(buffer, state);
        log?.write(formatStreamLine(buffer));
        if (state.sessionId && state.sessionId !== previous) onSessionId?.(state.sessionId);
      }
      resolve({ state, timedOut, spawnError, stderr, code });
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
  // run on the caller's next git call. Point git at an empty dir and diff the real one afterwards.
  const hooksDir = await resolveHooksDir(repoRoot);
  const hooksBefore = hooksDir ? snapshotHooks(hooksDir) : null;
  const emptyHooksDir = path.join(os.tmpdir(), "hermes-worker-empty-hooks", runId);
  let previousHooksPath: string | null = null;
  let hooksSandboxed = false;

  const restoreHooks = async (): Promise<void> => {
    if (!hooksSandboxed) return;
    hooksSandboxed = false;
    // Only undo our own sandbox: a concurrent dispatch may already own the setting.
    const live = await runGit(repoRoot, ["config", "--get", "core.hooksPath"]);
    const current = live.ok ? live.stdout.trim() : "";
    if (current && !samePath(current, emptyHooksDir)) return;
    if (previousHooksPath) {
      await runGit(repoRoot, ["config", "core.hooksPath", previousHooksPath]);
    } else {
      await runGit(repoRoot, ["config", "--unset", "core.hooksPath"]);
    }
  };

  const clearEmptyHooks = async (): Promise<void> => {
    await fsp.rm(emptyHooksDir, { recursive: true, force: true }).catch(() => undefined);
  };

  // A run id that already owns a branch or a directory is a collision, not something to clean up:
  // `branch -D` on it would destroy an earlier run this dispatch never created.
  const collision = await runGit(repoRoot, ["branch", "--list", branch]);
  if (collision.ok && collision.stdout.trim()) {
    throw new Error(`Refused to dispatch: branch '${branch}' already exists. Pass a different runId.`);
  }
  if (fs.existsSync(worktreePath)) {
    throw new Error(`Refused to dispatch: ${worktreePath} already exists. Pass a different runId.`);
  }

  const created = await runGit(repoRoot, ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);
  if (!created.ok) {
    // M11: a failed `worktree add` can still have registered the directory before refusing.
    await destroyWorktree(repoRoot, worktreePath, branch);
    throw new Error(`git worktree add failed: ${(created.stderr || created.stdout).trim()}`);
  }

  // The baseline commit is made before Hermes runs, so a caller's pre-commit hook is ordinary git
  // behaviour rather than a hole in the review boundary; the hook sandbox below still guards the
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

  try {
    await fsp.mkdir(emptyHooksDir, { recursive: true });
    const current = await runGit(repoRoot, ["config", "--get", "core.hooksPath"]);
    previousHooksPath = current.ok ? current.stdout.trim() || null : null;
    const sandboxed = await runGit(repoRoot, ["config", "core.hooksPath", emptyHooksDir]);
    if (!sandboxed.ok) {
      throw new Error(`Could not disable git hooks in ${repoRoot}: ${(sandboxed.stderr || sandboxed.stdout).trim()}`);
    }
    hooksSandboxed = true;
  } catch (error) {
    await restoreHooks();
    await clearEmptyHooks();
    await destroyWorktree(repoRoot, worktreePath, branch);
    throw error;
  }

  const guarded = injectWorkerBoundary(options.prompt);
  const promptFile = path.join(os.tmpdir(), `hermes-prompt-${runId}.txt`);
  const before = snapshotPendingIds();
  const live: { sessionId: string | null } = { sessionId: null };

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
      });

      runLog = openRunLog(runLogPath(runId));
      const execution = await execHermes(
        args,
        worktreePath,
        timeoutSeconds,
        (sessionId) => {
          live.sessionId = sessionId;
          result.sessionId = sessionId;
        },
        runLog,
      );
      result.timedOut = execution.timedOut;
      result.exitCode = execution.state.exitCode ?? execution.code;
      result.sessionId = execution.state.sessionId;
      result.summary = execution.state.text;
      result.toolEvents = execution.state.toolEvents;
      result.tokens = execution.state.tokens;
      result.durationMs = execution.state.durationMs;

      result.error = execution.state.error;
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

      let attributionUnknown = false;
      if (result.sessionId) {
        const session = readSessionAfterRun(result.sessionId, repoRoot);
        result.reasoning = session.reasoning;
        result.model = session.model;
        result.provider = session.provider;
        result.modelFallback = session.fallbackActive;
        if (session.fallbackActive) {
          result.warning =
            `Ran on the fallback model ${session.model ?? "unknown"} (${session.provider ?? "unknown"}): ` +
            "the requested model was refused by its provider.";
          result.message = `Dispatch refused: cline pass exhausted, ran on fallback ${session.model ?? "unknown"}. No changes are reviewable.`;
        } else if (!session.known) {
          attributionUnknown = true;
        }
      } else {
        attributionUnknown = true;
      }

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
      await restoreHooks();
      await clearEmptyHooks();
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
    settled.status = "completed";
    // The state file is the callback channel; a tmpdir failure must not lose the result itself.
    await publish({
      status: "completed",
      runId,
      sessionName,
      worktreePath,
      branch,
      startedAt,
      result: settled,
    });
    return settled;
  })();

  await publish({
    status: "running",
    runId,
    sessionName,
    worktreePath,
    branch,
    startedAt,
  });

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
  action: "apply" | "discard";
  cwd: string;
  worktreeBranch: string;
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

  // Refuse to touch a worktree whose Hermes process/session is actively executing.
  const activeRun = readRunState(branchMatch[1]);
  if (activeRun && activeRun.status === "running") {
    return {
      success: false,
      message:
        `Refusing to ${options.action} '${options.worktreeBranch}': Hermes run '${branchMatch[1]}' ` +
        "is still actively executing. Wait for the run to finish before managing the worktree.",
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
      success: false,
      message: `No worktree for branch '${options.worktreeBranch}' under ${repoRoot}.`,
    };
  }
  if (!isInsidePath(worktreesRoot, target.path)) {
    return {
      success: false,
      message: `Refusing to touch '${target.path}': it is outside ${worktreesRoot}.`,
    };
  }

  const cleanup = async (): Promise<string | null> => {
    const removed = await removeWorktree(repoRoot, target.path, options.worktreeBranch);
    return removed.ok ? null : (removed.error ?? "worktree cleanup failed");
  };

  if (options.action === "discard") {
    const cleanupError = await cleanup();
    return cleanupError
      ? { success: false, message: `Discarded the worktree but ${cleanupError}.` }
      : { success: true, message: `Discarded worktree and branch '${options.worktreeBranch}'.` };
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
