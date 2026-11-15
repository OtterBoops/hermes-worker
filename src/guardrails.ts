import fs from "node:fs";
import path from "node:path";
import { isWindows } from "./exec.js";

/**
 * Directory segments no dispatch may touch. Evaluated before the template exemption, so
 * `.ssh/.env.example` is a violation even though its basename is a reviewable template.
 */
export const BLOCKED_DIRECTORY_SEGMENTS: RegExp[] = [
  // `.git` is the checkout's own machinery: a config or hook written there executes on the caller's
  // next git command and a tree-object revert cannot undo it.
  /^\.git$/i,
  /^\.ssh$/i,
  /^\.gemini$/i,
  /^\.aws$/i,
  /^\.docker$/i,
  /^\.kube$/i,
  /^\.gnupg$/i,
  /^\.env([.]|$)/i,
];

/**
 * Paths no dispatch may touch. Matched against the repo-relative path with `/` separators,
 * so a pattern only has to describe a filename or a directory segment.
 */
export const BLOCKED_PATH_PATTERNS: RegExp[] = [
  /(^|\/)\.git(\/|$)/i,
  /(^|\/)\.env($|\.)/i,
  /\.(pem|key|pfx|p12|kdbx)$/i,
  /(^|\/)id_(rsa|dsa|ed25519|ecdsa)/i,
  /(^|\/)\.ssh(\/|$)/i,
  /(^|\/)\.gemini(\/|$)/i,
  /(^|\/)\.aws(\/|$)/i,
  /(^|\/)\.docker(\/|$)/i,
  /(^|\/)\.kube(\/|$)/i,
  /(^|\/)\.gnupg(\/|$)/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.pgpass$/i,
  /(^|\/)\.git-credentials$/i,
  /(^|\/)\.htpasswd$/i,
  /\.(p8|jks|keystore)$/i,
  /(^|\/)service-account[^/]*\.json$/i,
  /\.tfstate$/i,
  /mcp_config\.json$/i,
  /(^|\/)credentials\.json$/i,
];

/** `.env` itself is secret, `.env.example` is not: the documented template is reviewable. */
const ENV_TEMPLATES = new Set([".env.example", ".env.template"]);

export interface ModificationVerdict {
  valid: boolean;
  violations: string[];
}

const toPosix = (value: string): string => value.replace(/\\/g, "/");

const comparisons = isWindows
  ? (value: string) => value.toLowerCase()
  : (value: string) => value;

const isInside = (root: string, target: string): boolean => {
  const normalRoot = comparisons(path.resolve(root)).replace(/[\\/]+$/, "");
  const normalTarget = comparisons(path.resolve(target));
  return normalTarget === normalRoot || normalTarget.startsWith(normalRoot + path.sep);
};

/**
 * A colon in a repo-relative path is an NTFS alternate data stream (`file.txt:secret.txt`) or a
 * drive-relative path, and it defeats the patterns below: `.env:stream` is not `.env`. POSIX
 * forbids nothing here, so a legitimate filename containing ':' must not be refused.
 */
const hasAlternateDataStream = (relative: string): boolean => isWindows && relative.includes(":");

const isMissing = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
};

/**
 * A junction or symlink in any component escapes the worktree even when the string stays
 * contained, so the physical path is checked too. Unreadable existing paths fail closed.
 */
const physicalEscape = (root: string, target: string, realRoot: string): boolean => {
  const components = path.relative(root, target).split(path.sep).filter(Boolean);
  let current = root;
  for (const component of components) {
    current = path.join(current, component);
    let isLink: boolean;
    try {
      isLink = fs.lstatSync(current).isSymbolicLink();
    } catch (error) {
      if (!isMissing(error)) return true;
      break;
    }
    // A link is only an escape when what it resolves to leaves the worktree.
    if (!isLink) continue;
    try {
      if (!isInside(realRoot, fs.realpathSync(current))) return true;
    } catch (error) {
      if (!isMissing(error)) return true;
    }
  }

  // Files the run just created may not exist yet: fall back to the nearest existing ancestor.
  let existing = target;
  for (;;) {
    try {
      return !isInside(realRoot, fs.realpathSync(existing));
    } catch (error) {
      if (!isMissing(error)) return true;
      const parent = path.dirname(existing);
      if (parent === existing) return false;
      existing = parent;
    }
  }
};

/**
 * Every file the worker touched must live inside the worktree and must not be a secret store.
 * A path that resolves outside `repoRoot` is a violation even when no pattern matches it.
 */
export const validateModifiedFiles = (files: string[], repoRoot: string): ModificationVerdict => {
  const violations: string[] = [];
  const root = path.resolve(repoRoot);

  let realRoot: string | null = null;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    realRoot = null;
  }

  for (const file of files) {
    if (!file.trim()) continue;
    const absolute = path.resolve(root, file);
    const relative = toPosix(path.relative(root, absolute));
    const base = path.posix.basename(relative);

    if (!isInside(root, absolute) || relative.startsWith("../") || path.isAbsolute(relative)) {
      violations.push(file);
      continue;
    }

    if (hasAlternateDataStream(relative)) {
      violations.push(file);
      continue;
    }

    const segments = relative.split("/").filter((segment) => segment && segment !== ".");
    const directories = segments.slice(0, -1);
    if (BLOCKED_DIRECTORY_SEGMENTS.some((pattern) => directories.some((dir) => pattern.test(dir)))) {
      violations.push(file);
      continue;
    }
    // Physical escape is checked before the template exemption so a symlinked template cannot skip it.
    if (realRoot && physicalEscape(root, absolute, realRoot)) {
      violations.push(file);
      continue;
    }
    if (ENV_TEMPLATES.has(base.toLowerCase())) continue;
    if (BLOCKED_PATH_PATTERNS.some((pattern) => pattern.test(relative))) {
      violations.push(file);
    }
  }

  return { valid: violations.length === 0, violations };
};

const SECRET_PROBES: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /-----BEGIN[A-Z ]*PRIVATE KEY-----/, reason: "raw private key block" },
  { pattern: /\bghp_[A-Za-z0-9]{30,}/, reason: "GitHub personal access token (ghp_)" },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/, reason: "GitHub fine-grained token (github_pat_)" },
  { pattern: /\bsk-or-v1-[a-f0-9]{40,}/, reason: "OpenRouter API key" },
  { pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/, reason: "Anthropic API key" },
  { pattern: /\bsk-proj-[A-Za-z0-9_-]{20,}/, reason: "OpenAI project key" },
  { pattern: /\bsk-(svcacct|admin)-[A-Za-z0-9_-]{20,}/, reason: "OpenAI service account or admin key" },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}/, reason: "GitHub app, user, refresh or server token" },
  { pattern: /\bglpat-[A-Za-z0-9_-]{20,}/, reason: "GitLab personal access token" },
  { pattern: /\bAKIA[0-9A-Z]{16}/, reason: "AWS access key id" },
  { pattern: /\bAIza[0-9A-Za-z_-]{35}/, reason: "Google API key" },
  { pattern: /\bxox[abprs]-[A-Za-z0-9-]+/, reason: "Slack token" },
  { pattern: /\bsk_live_[0-9a-zA-Z]{24,}/, reason: "Stripe live secret key" },
  { pattern: /\bhf_[A-Za-z0-9]{34,}/, reason: "HuggingFace access token" },
  { pattern: /\bnpm_[A-Za-z0-9]{36}/, reason: "npm publish token" },
  // Deliberately last: the specific sk- providers above must win the reason.
  { pattern: /\bsk-[A-Za-z0-9]{32,}/, reason: "generic API secret key (sk-)" },
];

export interface PromptScan {
  safe: boolean;
  reason?: string;
}

/** A credential pasted into the task would be forwarded to the model unchanged, so refuse it. */
export const scanPromptForSecrets = (prompt: string): PromptScan => {
  for (const probe of SECRET_PROBES) {
    if (probe.pattern.test(prompt)) {
      return { safe: false, reason: `prompt contains what looks like a ${probe.reason}` };
    }
  }
  return { safe: true };
};

const BOUNDARY_MARKER = "[WORKER OPERATIONAL BOUNDARY]";

export const WORKER_BOUNDARY = [
  BOUNDARY_MARKER,
  "- You are executing directly in the repository checkout that Antigravity has open, not in a copy of it: your edits land where the user will see them the moment the run finishes.",
  "- Stay focused within this repository root; do not touch .env files, credentials, or remote infrastructure.",
  "- Operate strictly within the current working directory (the repository root). All file reads, edits, and terminal commands must use relative paths within cwd. Never navigate up to, reference, or mutate files outside this repository. If temporary probe fixtures are required for testing, limit them strictly to system temp ($TMPDIR or os.tmpdir()); never touch or create files in $LOCALAPPDATA, user profile directories, or outside temp.",
  "- Local workstation testing (local containers, node/pnpm/cargo/pytest runners) is encouraged. "
    + "Iterate using targeted test filters (e.g. --test-name-pattern or single test file) during development; "
    + "run the full test suite strictly once before declaring completion.",
  "- SUBAGENT PARALLELISM (`delegate_task`): spawn parallel subagents by default. Delegate whenever a task touches 2+ files, pairs implementation with test authoring, or audits multiple areas; the parent session coordinates instead of serializing the work.",
  "- Assign each subagent strictly disjoint file paths so concurrent children never write the same file; perform shared entrypoint and integration work in the parent agent.",
  "- When delegate_task subagents return verified results, synthesize and integrate them directly without re-running their scratch experiments in the parent session.",
  "- Do not invoke the `hermes` skill or `hermes-worker` MCP tools from inside this worker session (prevents recursive delegation).",
  "- Leave your changes uncommitted in the checkout for Antigravity to review: no git commit, no git push, no branch switching, and no `git checkout --`/`git reset` that would revert work you did not write yourself.",
  "[TASK SPECIFICATION]",
].join("\n");

/**
 * Idempotent because a guarded prompt can be forwarded into another worker: re-prepending would
 * stack a second contract whose subagent rules disagree with the first. Only a boundary at the head
 * of the prompt is one this function added; a prompt that merely names the block must still be
 * guarded, or quoting the marker would be a way to run without a contract.
 */
export const injectWorkerBoundary = (prompt: string): string =>
  prompt.trimStart().startsWith(BOUNDARY_MARKER) ? prompt : `${WORKER_BOUNDARY}\n\n${prompt}`;
