import path from "node:path";
import { isWindows } from "./exec.js";

/**
 * Paths no dispatch may touch. Matched against the repo-relative path with `/` separators,
 * so a pattern only has to describe a filename or a directory segment.
 */
export const BLOCKED_PATH_PATTERNS: RegExp[] = [
  /(^|\/)\.env($|\.)/i,
  /\.(pem|key|pfx|p12|kdbx)$/i,
  /(^|\/)id_(rsa|ed25519|ecdsa)/i,
  /(^|\/)\.ssh(\/|$)/i,
  /(^|\/)\.gemini(\/|$)/i,
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
 * Every file the worker touched must live inside the worktree and must not be a secret store.
 * A path that resolves outside `repoRoot` is a violation even when no pattern matches it.
 */
export const validateModifiedFiles = (files: string[], repoRoot: string): ModificationVerdict => {
  const violations: string[] = [];
  const root = path.resolve(repoRoot);

  for (const file of files) {
    if (!file.trim()) continue;
    const absolute = path.resolve(root, file);
    const relative = toPosix(path.relative(root, absolute));
    const base = path.posix.basename(relative);

    if (!isInside(root, absolute) || relative.startsWith("../") || path.isAbsolute(relative)) {
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
  "- Do not invoke the `hermes` skill or `hermes-worker` MCP tools from inside this worker session (prevents recursive delegation).",
  "- Do not run `git push` or switch branches; leave your changes in the current worktree for Antigravity to review.",
  "[TASK SPECIFICATION]",
].join("\n");

export const injectWorkerBoundary = (prompt: string): string => `${WORKER_BOUNDARY}\n\n${prompt}`;
