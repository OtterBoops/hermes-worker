import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isWindows, runGit } from "./exec.js";
import {
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
  runId?: string;
}

/** Pinned so a dispatch is reproducible regardless of what Hermes' config was last set to. */
export const DEFAULT_MODEL = "cline-pass/deepseek-v4.1-flash-1017";
export const DEFAULT_REASONING = "max";

export interface ToolEvent {
  type: string;
  name?: string;
  detail?: string;
}

export interface DispatchResult {
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

const MAX_DIFF_CHARS = 400_000;

const truncateTitle = (prompt: string, limit: number): string => {
  const flat = prompt.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
};

const makeRunId = (): string => {
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${suffix}`;
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

const removeWorktree = async (
  repoRoot: string,
  worktreePath: string,
  branch: string,
): Promise<void> => {
  await runGit(repoRoot, ["worktree", "unlock", worktreePath]);
  await runGit(repoRoot, ["worktree", "remove", "--force", worktreePath]);
  await runGit(repoRoot, ["branch", "-D", branch]);
  await runGit(repoRoot, ["worktree", "prune"]);
};

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

const execHermes = (args: string[], cwd: string, timeoutSeconds: number): Promise<HermesRun> =>
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
      for (const line of lines) ingestStreamLine(line, state);
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
      if (buffer.trim()) ingestStreamLine(buffer, state);
      resolve({ state, timedOut, spawnError, stderr, code });
    });
  });

export interface GatewayRuntime {
  provider: string | null;
  fallbackActive: boolean;
}

export const parseGatewayRuntime = (modelConfig: string | null | undefined): GatewayRuntime => {
  try {
    const parsed = JSON.parse(modelConfig ?? "{}") as { gateway_runtime?: Record<string, unknown> };
    const runtime = parsed.gateway_runtime ?? {};
    return {
      provider: typeof runtime.provider === "string" ? runtime.provider : null,
      fallbackActive: runtime.fallback_active === true,
    };
  } catch {
    return { provider: null, fallbackActive: false };
  }
};

interface SessionAfterRun {
  reasoning: string | null;
  model: string | null;
  provider: string | null;
  fallbackActive: boolean;
}

const readSessionAfterRun = (sessionId: string, repoRoot: string): SessionAfterRun => {
  const empty: SessionAfterRun = { reasoning: null, model: null, provider: null, fallbackActive: false };
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(stateDbPath());
    db.exec("PRAGMA busy_timeout = 3000");
    db.prepare("UPDATE sessions SET cwd = ?, git_repo_root = ? WHERE id = ?").run(
      repoRoot,
      repoRoot,
      sessionId,
    );
    const session = db
      .prepare("SELECT model, model_config FROM sessions WHERE id = ?")
      .get(sessionId) as { model?: string | null; model_config?: string | null } | undefined;
    const message = db
      .prepare(
        `SELECT reasoning, reasoning_content FROM messages
          WHERE session_id = ? AND role = 'assistant'
          ORDER BY id DESC LIMIT 1`,
      )
      .get(sessionId) as { reasoning?: string | null; reasoning_content?: string | null } | undefined;
    const runtime = parseGatewayRuntime(session?.model_config);
    return {
      reasoning: message?.reasoning_content ?? message?.reasoning ?? null,
      model: session?.model ?? null,
      provider: runtime.provider,
      fallbackActive: runtime.fallbackActive,
    };
  } catch {
    return empty;
  } finally {
    db?.close();
  }
};

/**
 * One dispatch: guard the prompt, bind the project, run Hermes inside a fresh worktree branched
 * from local HEAD, then firewall whatever it produced before Antigravity ever sees it.
 */
export const dispatchHermesTask = async (options: DispatchOptions): Promise<DispatchResult> => {
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
  const branch = `hermes/agy-${runId}`;
  const worktreePath = path.join(repoRoot, ".worktrees", `agy-${runId}`);
  const sessionName = options.sessionName ?? `[AGY] ${truncateTitle(options.prompt, 48)}`;

  await ensureWorktreesExcluded(repoRoot);
  const created = await runGit(repoRoot, ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);
  if (!created.ok) {
    throw new Error(`git worktree add failed: ${(created.stderr || created.stdout).trim()}`);
  }

  const guarded = injectWorkerBoundary(options.prompt);
  const promptFile = path.join(os.tmpdir(), `hermes-prompt-${runId}.txt`);
  const before = snapshotPendingIds();

  const result: DispatchResult = {
    success: false,
    sessionId: null,
    sessionName,
    project,
    worktreePath,
    branch,
    baseSha,
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

    const execution = await execHermes(args, worktreePath, options.timeoutSeconds ?? 300);
    result.timedOut = execution.timedOut;
    result.exitCode = execution.state.exitCode ?? execution.code;
    result.sessionId = execution.state.sessionId;
    result.summary = execution.state.text;
    result.toolEvents = execution.state.toolEvents;
    result.tokens = execution.state.tokens;
    result.durationMs = execution.state.durationMs;

    result.error = execution.state.error;
    const failed =
      Boolean(execution.spawnError) ||
      execution.timedOut ||
      execution.state.isError ||
      result.exitCode !== 0;

    if (execution.spawnError) {
      result.message = `Could not start ${hermesExe()}: ${execution.spawnError}`;
    } else if (execution.timedOut) {
      result.message = `Hermes exceeded ${options.timeoutSeconds ?? 300}s and was killed.`;
    } else if (failed) {
      result.message = `Hermes exited ${result.exitCode}${execution.state.error ? `: ${execution.state.error}` : ""}.`;
    }

    await runGit(worktreePath, ["add", "-N", "."]);
    const nameOnly = await runGit(worktreePath, ["diff", "--name-only", baseSha]);
    result.modifiedFiles = nameOnly.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    const diff = await runGit(worktreePath, ["diff", baseSha]);
    result.diff = diff.stdout;
    if (result.diff.length > MAX_DIFF_CHARS) {
      result.diff = `${result.diff.slice(0, MAX_DIFF_CHARS)}\n\n[diff truncated at ${MAX_DIFF_CHARS} chars]`;
      result.diffTruncated = true;
    }

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
      }
    }

    const modelFallbackFailed = Boolean(result.modelFallback);

    const verdict = validateModifiedFiles(result.modifiedFiles, worktreePath);
    result.violations = verdict.violations;

    if (!verdict.valid) {
      result.securityViolation = true;
      result.success = false;
      await removeWorktree(repoRoot, worktreePath, branch);
      result.message = `Security violation: ${verdict.violations.join(", ")} — worktree destroyed.`;
      return result;
    }

    if (result.modifiedFiles.length === 0) {
      await removeWorktree(repoRoot, worktreePath, branch);
      result.success = !failed && !modelFallbackFailed;
      result.message =
        result.message ||
        "No files were modified; the worktree and branch were cleaned up.";
      return result;
    }

    result.worktreeKept = true;
    result.success = !failed && !modelFallbackFailed;
    result.message =
      result.message ||
      `${result.modifiedFiles.length} file(s) changed on ${branch}. Apply with hermes_worktree_action.`;
    return result;
  } finally {
    await fsp.rm(promptFile, { force: true });
    result.pendingWrites = collectNewPendingWrites(before);
  }
};

interface WorktreeEntry {
  path: string;
  branch: string | null;
}

const listWorktrees = async (repoRoot: string): Promise<WorktreeEntry[]> => {
  const result = await runGit(repoRoot, ["worktree", "list", "--porcelain"]);
  if (!result.ok) return [];
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: line.slice("worktree ".length).trim(), branch: null };
    } else if (line.startsWith("branch ") && current) {
      current.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    }
  }
  if (current) entries.push(current);
  return entries;
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
  const repoRoot = path.resolve(options.cwd);
  const entries = await listWorktrees(repoRoot);
  const target = entries.find((entry) => entry.branch === options.worktreeBranch);

  if (!target) {
    return {
      success: false,
      message: `No worktree for branch '${options.worktreeBranch}' under ${repoRoot}.`,
    };
  }

  if (options.action === "discard") {
    await removeWorktree(repoRoot, target.path, options.worktreeBranch);
    return { success: true, message: `Discarded worktree and branch '${options.worktreeBranch}'.` };
  }

  const mergeBase = await runGit(repoRoot, ["merge-base", options.worktreeBranch, "HEAD"]);
  if (!mergeBase.ok) {
    return {
      success: false,
      message: `Could not find a merge base for '${options.worktreeBranch}': ${mergeBase.stderr.trim()}`,
    };
  }
  const baseSha = mergeBase.stdout.trim();

  await runGit(target.path, ["add", "-N", "."]);
  const diff = await runGit(target.path, ["diff", baseSha]);
  if (!diff.ok) {
    return { success: false, message: `git diff failed: ${diff.stderr.trim()}` };
  }
  if (!diff.stdout.trim()) {
    await removeWorktree(repoRoot, target.path, options.worktreeBranch);
    return {
      success: true,
      message: `No changes to apply on '${options.worktreeBranch}'; worktree removed.`,
    };
  }

  const patchDir = path.join(repoRoot, ".worktrees");
  await fsp.mkdir(patchDir, { recursive: true });
  const patchPath = path.join(patchDir, `${options.worktreeBranch.replace(/[\\/]/g, "-")}.patch`);
  await fsp.writeFile(patchPath, diff.stdout, "utf8");

  const applied = await runGit(repoRoot, ["apply", "--3way", patchPath]);
  if (!applied.ok) {
    return {
      success: false,
      message: `git apply failed: ${(applied.stderr || applied.stdout).trim()}. The patch is at ${patchPath} and the worktree was kept.`,
      patchPath,
    };
  }

  await removeWorktree(repoRoot, target.path, options.worktreeBranch);
  await fsp.rm(patchPath, { force: true });
  return { success: true, message: `Applied '${options.worktreeBranch}' to ${repoRoot}; worktree removed.` };
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

export const listHermesSessions = (options: { cwd?: string; limit?: number } = {}): SessionSummaryRow[] => {
  const dbPath = stateDbPath();
  if (!fs.existsSync(dbPath)) return [];
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 200);
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const columns = "id, title, model, started_at, message_count, tool_call_count, cwd";
    if (options.cwd) {
      const root = path.resolve(options.cwd).replace(/[\\/]+$/, "");
      const rows = db
        .prepare(
          `SELECT ${columns} FROM sessions
            WHERE cwd = ? OR cwd LIKE ? OR git_repo_root = ? OR git_repo_root LIKE ?
            ORDER BY started_at DESC LIMIT ?`,
        )
        .all(root, `${root}${path.sep}%`, root, `${root}${path.sep}%`, limit) as unknown as SessionSummaryRow[];
      return rows;
    }
    return db
      .prepare(`SELECT ${columns} FROM sessions ORDER BY started_at DESC LIMIT ?`)
      .all(limit) as unknown as SessionSummaryRow[];
  } catch {
    return [];
  } finally {
    db?.close();
  }
};