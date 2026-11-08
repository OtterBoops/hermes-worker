import fs from "node:fs";
import path from "node:path";
import { isWindows } from "./exec.js";

/**
 * Directory segments no dispatch may touch. Evaluated before the template exemption, so
 * `.ssh/.env.example` is a violation even though its basename is a reviewable template.
 */
export const BLOCKED_DIRECTORY_SEGMENTS: RegExp[] = [
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
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return true;
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

export const WORKER_BOUNDARY = [
  "[WORKER OPERATIONAL BOUNDARY]",
  "- You are executing inside an isolated Git worktree managed by Antigravity.",
  "- DO NOT read, create, or modify .env files, API keys, credentials, or files outside this repository root.",
  "- DO NOT invoke remote homelab or SSH commands (hl, ottbox, ssh, arcane, cloudflare).",
  "- Local workstation testing (including local Docker Desktop containers, node/pnpm/cargo/pytest test runners) is PERMITTED.",
  "- SUBAGENT PARALLELISM (`delegate_task`): Actively spawn parallel subagents via `delegate_task(tasks=[...])` (up to 3 concurrent children) whenever a task spans 2+ independent modules, test suites, or audit targets. Assign strictly disjoint file paths to each child so concurrent subagents never write to the same file simultaneously in this shared worktree; perform shared entrypoint integration in the parent agent.",
  "- When delegate_task subagents return verified results, synthesize and integrate them directly without re-running their scratch experiments in the parent session.",
  "- Do not invoke the `hermes` skill or `hermes-worker` MCP tools from inside this worker session (prevents recursive delegation).",
  "- Do not run `git push` or switch branches; leave your changes in the current worktree for Antigravity to review.",
  "[TASK SPECIFICATION]",
].join("\n");

export const injectWorkerBoundary = (prompt: string): string => `${WORKER_BOUNDARY}\n\n${prompt}`;
