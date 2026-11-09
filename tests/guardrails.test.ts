import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BLOCKED_PATH_PATTERNS,
  WORKER_BOUNDARY,
  injectWorkerBoundary,
  scanPromptForSecrets,
  validateModifiedFiles,
} from "../src/guardrails.js";

const repo = "D:\\Code\\OtterBoops\\hermes-worker";

/** A junction needs no admin on Windows; POSIX uses a plain directory symlink. */
const linkDirectory = (target: string, link: string): boolean => {
  try {
    fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  }
};

test("blocks secret stores and traversal, but not ordinary repo files", () => {
  const blocked = [
    ".env",
    ".env.local",
    "config/.env.production",
    "certs/server.key",
    ".gemini/config/mcp_config.json",
    "../outside.ts",
  ];
  for (const file of blocked) {
    const verdict = validateModifiedFiles([file], repo);
    assert.equal(verdict.valid, false, `${file} should be blocked`);
    assert.ok(verdict.violations.includes(file), `${file} should be reported as a violation`);
  }
});

test("allows the documented templates and normal source files", () => {
  const allowed = [
    "src/index.ts",
    "Dockerfile",
    "compose.yaml",
    "tests/app.test.ts",
    ".env.example",
    ".env.template",
    "docs/keys-are-not-committed.md",
  ];
  const verdict = validateModifiedFiles(allowed, repo);
  assert.deepEqual(verdict.violations, []);
  assert.equal(verdict.valid, true);
});

test("a traversal that stays inside the worktree is allowed", () => {
  const verdict = validateModifiedFiles(["src/../src/index.ts"], repo);
  assert.equal(verdict.valid, true);
});

test("blocks Windows alternate data stream syntax", () => {
  const blocked = [
    "file.txt:secret.txt",
    "src/file.txt:secret.txt",
    "dir::$INDEX_ALLOCATION",
    ".env:stream",
    ".env::$DATA",
  ];
  for (const file of blocked) {
    const verdict = validateModifiedFiles([file], repo);
    assert.equal(verdict.valid, false, `${file} should be blocked`);
    assert.ok(verdict.violations.includes(file), `${file} should be reported as a violation`);
  }

  const ordinary = validateModifiedFiles(["src/index.ts", "docs/file.txt"], repo);
  assert.deepEqual(ordinary.violations, [], "a path without a colon must stay allowed");
  assert.equal(ordinary.valid, true);
});

test("blocks absolute paths that resolve outside the worktree", () => {
  const verdict = validateModifiedFiles(["D:\\Windows\\System32\\drivers\\etc\\hosts"], repo);
  assert.equal(verdict.valid, false);
  assert.deepEqual(verdict.violations, ["D:\\Windows\\System32\\drivers\\etc\\hosts"]);
});

test("pattern list covers the documented credential shapes", () => {
  const probes = [
    ".env",
    "server.pem",
    "id_ed25519",
    "id_ed25519.pub",
    ".ssh/config",
    ".gemini/config/mcp_config.json",
    "credentials.json",
  ];
  for (const probe of probes) {
    assert.ok(
      BLOCKED_PATH_PATTERNS.some((pattern) => pattern.test(probe)),
      `${probe} should match a blocked pattern`,
    );
  }
});

test("scanPromptForSecrets catches tokens and private keys", () => {
  const cases = [
    `use this token ghp_${"a".repeat(36)} please`,
    `openrouter sk-or-v1-${"b".repeat(40)}`,
    "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----",
  ];
  for (const prompt of cases) {
    const scan = scanPromptForSecrets(prompt);
    assert.equal(scan.safe, false, `should reject: ${prompt.slice(0, 30)}`);
    assert.ok(scan.reason && scan.reason.length > 0);
  }
});

test("scanPromptForSecrets passes ordinary task text", () => {
  const scan = scanPromptForSecrets(
    "Refactor src/guardrails.ts so validateModifiedFiles reports every offending path. Run pnpm test.",
  );
  assert.equal(scan.safe, true);
  assert.equal(scan.reason, undefined);
});

test("injectWorkerBoundary prepends the contract and keeps the prompt intact", () => {
  const prompt = "Add a /health endpoint to the worker.";
  const guarded = injectWorkerBoundary(prompt);
  assert.ok(guarded.startsWith("[WORKER OPERATIONAL BOUNDARY]\n"));
  assert.ok(guarded.includes("SUBAGENT PARALLELISM (`delegate_task`)"));
  assert.ok(guarded.includes("prevents recursive delegation"));
  assert.ok(guarded.includes("[TASK SPECIFICATION]"));
  assert.ok(guarded.trimEnd().endsWith(prompt));
  assert.equal(guarded.split(prompt).length, 2);
});

test("injectWorkerBoundary tells the parent to integrate verified subagent results", () => {
  assert.ok(
    WORKER_BOUNDARY.includes(
      "When delegate_task subagents return verified results, synthesize and integrate them directly without re-running their scratch experiments in the parent session.",
    ),
  );
});

test("WORKER_BOUNDARY confines the worker to its own worktree checkout", () => {
  assert.ok(WORKER_BOUNDARY.includes("the active worktree checkout"));
  assert.ok(WORKER_BOUNDARY.includes("must use relative paths within cwd"));
  assert.ok(WORKER_BOUNDARY.includes("Never navigate up to, reference, or mutate files in the parent checkout"));
});

test("a blocked directory beats the template allowlist", () => {
  for (const file of [".ssh/.env.example", ".gemini/.env.example", ".aws/.env.template"]) {
    const verdict = validateModifiedFiles([file], repo);
    assert.equal(verdict.valid, false, `${file} should be blocked`);
  }
  assert.equal(validateModifiedFiles([".env.example"], repo).valid, true, "the root template stays allowed");
  assert.equal(validateModifiedFiles(["docs/.env.example"], repo).valid, true, "an ordinary directory is fine");
  assert.equal(
    validateModifiedFiles([".env.example/foo.ts"], repo).valid,
    false,
    "a directory named .env.example is judged on its segments",
  );
});

test("the expanded pattern list rejects every documented credential store", () => {
  const blocked = [
    "deploy/id_rsa",
    "deploy/id_dsa",
    "deploy/id_ed25519.pub",
    "deploy/id_ecdsa",
    ".netrc",
    "home/.npmrc",
    ".pgpass",
    ".git-credentials",
    "htpasswd/.htpasswd",
    ".aws/credentials",
    ".docker/config.json",
    ".kube/config",
    ".gnupg/secring.gpg",
    "tls/client.p8",
    "android/app.jks",
    "java/cacerts.keystore",
    "gcp/service-account-production.json",
    "service-account.json",
    "infra/terraform.tfstate",
  ];
  for (const file of blocked) {
    const verdict = validateModifiedFiles([file], repo);
    assert.equal(verdict.valid, false, `${file} should be blocked`);
    assert.ok(verdict.violations.includes(file), `${file} should be reported as a violation`);
  }
});

test("every new SECRET_PROBE fires on a synthetic token", () => {
  const tokens: Array<[string, string]> = [
    [`ghp_${"x".repeat(36)}`, "GitHub personal access token"],
    [`gho_${"x".repeat(36)}`, "GitHub app, user, refresh or server token"],
    [`ghs_${"x".repeat(36)}`, "GitHub app, user, refresh or server token"],
    [`ghu_${"x".repeat(36)}`, "GitHub app, user, refresh or server token"],
    [`ghr_${"x".repeat(36)}`, "GitHub app, user, refresh or server token"],
    [`github_pat_${"x".repeat(30)}`, "GitHub fine-grained token"],
    [`sk-${"x".repeat(40)}`, "generic API secret key"],
    [`sk-or-v1-${"a".repeat(40)}`, "OpenRouter API key"],
    [`sk-ant-${"x".repeat(30)}`, "Anthropic API key"],
    [`sk-proj-${"x".repeat(30)}`, "OpenAI project key"],
    [`AKIA${"A".repeat(16)}`, "AWS access key id"],
    [`AIza${"x".repeat(35)}`, "Google API key"],
    [`xoxb-${"1".repeat(12)}-${"x".repeat(12)}`, "Slack token"],
    [`xoxp-${"1".repeat(12)}-${"x".repeat(12)}`, "Slack token"],
    [`sk_live_${"x".repeat(24)}`, "Stripe live secret key"],
    [`glpat-${"x".repeat(20)}`, "GitLab personal access token"],
    [`hf_${"x".repeat(34)}`, "HuggingFace access token"],
    [`npm_${"x".repeat(36)}`, "npm publish token"],
  ];
  for (const [token, reason] of tokens) {
    const scan = scanPromptForSecrets(`please use ${token} to publish`);
    assert.equal(scan.safe, false, `${token.slice(0, 12)} should be rejected`);
    assert.ok(scan.reason?.includes(reason), `${token.slice(0, 12)} reason was ${scan.reason}`);
  }
});

test("the generic sk- probe never masks a provider-specific reason", () => {
  const openrouter = scanPromptForSecrets(`sk-or-v1-${"a".repeat(40)}`);
  assert.ok(openrouter.reason?.includes("OpenRouter"));
  const anthropic = scanPromptForSecrets(`sk-ant-${"x".repeat(30)}`);
  assert.ok(anthropic.reason?.includes("Anthropic"));
});

test("a junction or symlink inside the worktree cannot smuggle files out of it", (t) => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-guard-outside-"));
  const inside = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-guard-inside-"));
  t.after(() => {
    fs.rmSync(outside, { recursive: true, force: true });
    fs.rmSync(inside, { recursive: true, force: true });
  });

  fs.writeFileSync(path.join(outside, "stolen.txt"), "outside\n", "utf8");
  const link = path.join(inside, "escape");
  if (!linkDirectory(outside, link)) return;

  const verdict = validateModifiedFiles([path.join("escape", "stolen.txt")], inside);
  assert.equal(verdict.valid, false, "a file reached through the junction is outside the worktree");

  const plain = validateModifiedFiles([path.join("src", "nested", "new.ts")], inside);
  assert.equal(plain.valid, true, "a legitimate new file must still pass");

  const own = validateModifiedFiles([path.join("own.txt")], inside);
  assert.equal(own.valid, true);
});

test("a repoRoot that is itself reached through a symlink still accepts its own files", (t) => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-guard-real-"));
  const holder = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-guard-link-"));
  t.after(() => {
    fs.rmSync(real, { recursive: true, force: true });
    fs.rmSync(holder, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(real, "inside.ts"), "export const x = 1;\n", "utf8");

  const alias = path.join(holder, "alias");
  if (!linkDirectory(real, alias)) return;

  assert.equal(validateModifiedFiles([path.join("inside.ts")], alias).valid, true);
  assert.equal(validateModifiedFiles([path.join(alias, "inside.ts")], alias).valid, true);
});

test("a missing repoRoot falls back to lexical containment only", () => {
  const missingRoot = path.join(os.tmpdir(), "hermes-guard-absent-root", "repo");
  assert.equal(validateModifiedFiles([path.join("src", "index.ts")], missingRoot).valid, true);
  assert.equal(validateModifiedFiles([path.join("..", "outside.ts")], missingRoot).valid, false);
});
