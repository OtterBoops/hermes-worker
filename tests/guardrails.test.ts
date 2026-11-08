import test from "node:test";
import assert from "node:assert/strict";
import {
  BLOCKED_PATH_PATTERNS,
  injectWorkerBoundary,
  scanPromptForSecrets,
  validateModifiedFiles,
} from "../src/guardrails.js";

const repo = "D:\\Code\\OtterBoops\\hermes-worker";

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
  assert.ok(guarded.includes("[TASK SPECIFICATION]"));
  assert.ok(guarded.trimEnd().endsWith(prompt));
  assert.equal(guarded.split(prompt).length, 2);
});
