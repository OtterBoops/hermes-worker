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
    // Executable git machinery: a hook or config written here runs on the caller's next git call.
    ".git/config",
    ".git/hooks/pre-commit",
    "sub/.git/config",
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

test("a traversal that stays inside the repository is allowed", () => {
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

test("blocks absolute paths that resolve outside the repository", () => {
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

test("the boundary asks for targeted test filters and one full run", () => {
  assert.ok(
    WORKER_BOUNDARY.includes(
      "Local workstation testing (local containers, node/pnpm/cargo/pytest runners) is encouraged. " +
        "Iterate using targeted test filters (e.g. --test-name-pattern or single test file) during " +
        "development; run the full test suite strictly once before declaring completion.",
    ),
  );
});

test("the boundary encourages parallel subagents for multi-file, paired and audit work", () => {
  assert.ok(WORKER_BOUNDARY.includes("spawn parallel subagents by default"));
  assert.ok(WORKER_BOUNDARY.includes("touches 2+ files"));
  assert.ok(WORKER_BOUNDARY.includes("pairs implementation with test authoring"));
  assert.ok(WORKER_BOUNDARY.includes("audits multiple areas"));
  assert.ok(WORKER_BOUNDARY.includes("strictly disjoint file paths"));
  assert.ok(WORKER_BOUNDARY.includes("perform shared entrypoint and integration work in the parent agent"));
  assert.ok(
    !WORKER_BOUNDARY.includes("Reserve `delegate_task` strictly for large tasks"),
    "the old size reservation must be gone",
  );
  assert.ok(
    !WORKER_BOUNDARY.includes("execute directly in the parent session"),
    "the old small-patch opt-out must be gone",
  );
});

test("injectWorkerBoundary is idempotent on an already-guarded prompt", () => {
  const prompt = "Add a /health endpoint to the worker.";

  // Byte-identical on a prompt that starts with the full block.
  const guarded = injectWorkerBoundary(prompt);
  assert.equal(injectWorkerBoundary(guarded), guarded);

  // A prompt that only names the block is not a guarded one: quoting the marker must not skip the
  // contract.
  const midText = `Retry the failed job. Reuse the [WORKER OPERATIONAL BOUNDARY] block from the parent run.`;
  assert.ok(injectWorkerBoundary(midText).startsWith("[WORKER OPERATIONAL BOUNDARY]\n- "));
  assert.ok(injectWorkerBoundary(midText).endsWith(midText));

  // A double injection still carries exactly one boundary block.
  const twice = injectWorkerBoundary(injectWorkerBoundary(prompt));
  assert.equal(twice.split("[WORKER OPERATIONAL BOUNDARY]").length, 2);
  assert.equal(twice.split("[TASK SPECIFICATION]").length, 2);
  assert.equal(twice.split(prompt).length, 2);
});

test("injectWorkerBoundary tells the parent to integrate verified subagent results", () => {
  assert.ok(
    WORKER_BOUNDARY.includes(
      "When delegate_task subagents return verified results, synthesize and integrate them directly without re-running their scratch experiments in the parent session.",
    ),
  );
});

test("WORKER_BOUNDARY confines the worker to the repository checkout it runs in", () => {
  assert.ok(
    WORKER_BOUNDARY.includes(
      "You are executing directly in the repository checkout that Antigravity has open, not in a copy of it",
    ),
    "the worker edits the checkout the user is looking at, not a copy of it",
  );
  assert.ok(
    !/worktree/i.test(WORKER_BOUNDARY),
    "a snapshot run edits the checkout itself, so the contract must not promise a worktree",
  );
  assert.ok(
    WORKER_BOUNDARY.includes(
      "Operate strictly within the current working directory (the repository root)",
    ),
  );
  assert.ok(
    WORKER_BOUNDARY.includes("All file reads, edits, and terminal commands must use relative paths within cwd"),
  );
  assert.ok(WORKER_BOUNDARY.includes("Never navigate up to, reference, or mutate files outside this repository"));
  assert.ok(
    WORKER_BOUNDARY.includes("limit them strictly to system temp ($TMPDIR or os.tmpdir())"),
  );
  assert.ok(
    WORKER_BOUNDARY.includes(
      "never touch or create files in $LOCALAPPDATA, user profile directories, or outside temp",
    ),
  );
  assert.ok(
    WORKER_BOUNDARY.includes("Leave your changes uncommitted in the checkout for Antigravity to review"),
  );
  assert.ok(
    WORKER_BOUNDARY.includes(
      "no git commit, no git push, no branch switching, and no `git checkout --`/`git reset` that would revert work you did not write yourself",
    ),
    "the run must leave a reviewable diff and must not revert the user's own work",
  );
  assert.ok(WORKER_BOUNDARY.includes("do not touch .env files, credentials, or remote infrastructure"));
  assert.ok(
    !WORKER_BOUNDARY.includes("the active worktree checkout"),
    "the old worktree confinement wording must be gone",
  );
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
    [`sk-svcacct-${"x".repeat(30)}`, "OpenAI service account or admin key"],
    [`sk-admin-${"x".repeat(30)}`, "OpenAI service account or admin key"],
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

test("a junction or symlink inside the repository cannot smuggle files out of it", (t) => {
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
  assert.equal(verdict.valid, false, "a file reached through the junction is outside the repository");

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

test("a symlink that stays inside the repository is not an escape", (t) => {
  const inside = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-guard-inner-link-"));
  t.after(() => fs.rmSync(inside, { recursive: true, force: true }));
  fs.mkdirSync(path.join(inside, "real"), { recursive: true });
  fs.writeFileSync(path.join(inside, "real", "file.ts"), "export const x = 1;\n", "utf8");

  const alias = path.join(inside, "alias");
  if (!linkDirectory(path.join(inside, "real"), alias)) return;

  assert.equal(
    validateModifiedFiles([path.join("alias", "file.ts")], inside).valid,
    true,
    "a link whose target is inside the repository must not be a violation",
  );
  assert.equal(validateModifiedFiles([path.join("alias", "new.ts")], inside).valid, true);
});

test("a colon is only an alternate-data-stream hazard on Windows", () => {
  const verdict = validateModifiedFiles(["docs/notes:1.md"], repo);
  // Windows forbids ':' in a filename, so it can only be an ADS or drive-relative escape there.
  assert.equal(verdict.valid, process.platform !== "win32");
});
