import test, { mock, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { run } from "../src/exec.js";
import type { DispatchResult } from "../src/hermes-cli.js";
import {
  DEFAULT_FAST_WAIT_SECONDS,
  DEFAULT_MODEL,
  DEFAULT_REASONING,
  buildChatArgs,
  dispatchHermesTask,
  parseGatewayRuntime,
  raceFastWait,
  readSessionAfterRun,
  listHermesSessions,
  manageWorktree,
  pruneOrphanWorktrees,
  runMetadata,
  snapshotCallerWorkingTree,
} from "../src/hermes-cli.js";
import {
  HERMES_DISPATCH_FAILED_PREFIX,
  HERMES_DISPATCH_SENTINEL_PREFIX,
  RUN_STATE_DIR,
  clearRunState,
  formatDispatchSentinel,
  formatFailedSentinel,
  listActiveRuns,
  pruneStaleRuns,
  readRunState,
  runLogPath,
  runStatePath,
  writeRunState,
} from "../src/run-registry.js";
import { formatStreamLine, openRunLog } from "../src/run-log.js";

const GIT_IDENTITY = {
  ...process.env,
  GIT_AUTHOR_NAME: "hermes-worker test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "hermes-worker test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
};

const git = async (cwd: string, args: string[]): Promise<string> => {
  const result = await run("git", args, { cwd, env: GIT_IDENTITY, timeoutMs: 60_000 });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr || result.stdout}`);
  return result.stdout;
};

/** A throwaway repository with one commit and a bridge-style worktree, mirroring a dispatch. */
const makeRepo = async (t: TestContext): Promise<{ repo: string; worktree: string; branch: string }> => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-worker-repo-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));

  await git(repo, ["init", "-b", "main"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# fixture\n", "utf8");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "initial"]);

  const branch = "hermes/agy-test";
  const worktree = path.join(repo, ".worktrees", "agy-test");
  fs.mkdirSync(path.join(repo, ".worktrees"), { recursive: true });
  await git(repo, ["worktree", "add", "-b", branch, worktree, "HEAD"]);
  // `.worktrees/` is excluded in production so a bridge worktree never appears in a diff.
  fs.appendFileSync(path.join(repo, ".git", "info", "exclude"), "/.worktrees/\n", "utf8");
  return { repo, worktree, branch };
};

const branchExists = async (repo: string, branch: string): Promise<boolean> =>
  (await git(repo, ["branch", "--list", branch])).trim() !== "";

test("a dirty caller checkout is ported into the worktree as one baseline commit", async (t) => {
  const { repo, worktree } = await makeRepo(t);
  const headSha = (await git(repo, ["rev-parse", "HEAD"])).trim();

  // Tracked modification, a staged addition and an untracked file: all three must travel.
  fs.writeFileSync(path.join(repo, "README.md"), "# fixture\n\nedited-in-progress\n", "utf8");
  fs.writeFileSync(path.join(repo, "staged.ts"), "export const staged = 1;\n", "utf8");
  await git(repo, ["add", "staged.ts"]);
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "new-component.tsx"), "export const NewComponent = () => null;\n", "utf8");

  // A binary modification goes through the same patch, which is why `--binary` matters.
  const bytes = Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x42]);
  fs.writeFileSync(path.join(repo, "asset.bin"), bytes);

  const snapshot = await snapshotCallerWorkingTree(repo, worktree, headSha);
  assert.notEqual(snapshot.baseSha, headSha, "a ported checkout must move the baseline off HEAD");
  assert.equal(snapshot.ported, 4, `expected 4 ported paths, skipped: ${snapshot.skipped.join(", ")}`);

  assert.equal(fs.readFileSync(path.join(worktree, "README.md"), "utf8"), "# fixture\n\nedited-in-progress\n");
  assert.equal(fs.readFileSync(path.join(worktree, "staged.ts"), "utf8"), "export const staged = 1;\n");
  assert.equal(
    fs.readFileSync(path.join(worktree, "src", "new-component.tsx"), "utf8"),
    "export const NewComponent = () => null;\n",
  );
  assert.deepEqual([...fs.readFileSync(path.join(worktree, "asset.bin"))], [...bytes]);

  // Exactly one commit, and it is the baseline: `git diff <base>..HEAD` then shows only new work.
  const log = await git(worktree, ["log", "--format=%s", `${headSha}..HEAD`]);
  assert.deepEqual(log.trim().split("\n"), ["[AGY-BASE] Working tree baseline snapshot"]);
  assert.equal((await git(worktree, ["rev-parse", "HEAD"])).trim(), snapshot.baseSha);

  // The caller's own checkout keeps its dirty state: the port never commits or reverts anything.
  assert.match(await git(repo, ["status", "--porcelain"]), /README\.md/);
  assert.equal((await git(repo, ["rev-parse", "HEAD"])).trim(), headSha);
});

test("a clean caller checkout leaves the baseline on HEAD and makes no commit", async (t) => {
  const { repo, worktree } = await makeRepo(t);
  const headSha = (await git(repo, ["rev-parse", "HEAD"])).trim();

  const snapshot = await snapshotCallerWorkingTree(repo, worktree, headSha);
  assert.equal(snapshot.baseSha, headSha);
  assert.equal(snapshot.ported, 0);
  assert.equal((await git(worktree, ["rev-parse", "HEAD"])).trim(), headSha);
});

test("the baseline port skips secrets, node_modules and stacked worktrees", async (t) => {
  const { repo, worktree } = await makeRepo(t);
  const headSha = (await git(repo, ["rev-parse", "HEAD"])).trim();

  fs.writeFileSync(path.join(repo, ".env"), "SECRET=nope\n", "utf8");
  fs.writeFileSync(path.join(repo, ".env.example"), "SECRET=\n", "utf8");
  fs.mkdirSync(path.join(repo, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(repo, "node_modules", "pkg", "index.js"), "module.exports = 1;\n", "utf8");
  fs.writeFileSync(path.join(repo, "keep.ts"), "export const keep = 1;\n", "utf8");

  const snapshot = await snapshotCallerWorkingTree(repo, worktree, headSha);
  assert.ok(snapshot.skipped.includes(".env"), "a .env must never be ported into a worktree");
  assert.equal(fs.existsSync(path.join(worktree, ".env")), false);
  assert.equal(fs.existsSync(path.join(worktree, "node_modules")), false);
  assert.equal(fs.existsSync(path.join(worktree, ".env.example")), true, "the template is reviewable");
  assert.equal(fs.existsSync(path.join(worktree, "keep.ts")), true);
  // A skipped secret must not prevent the baseline commit for everything else.
  assert.notEqual(snapshot.baseSha, headSha);
  assert.equal((await git(worktree, ["status", "--porcelain"])), "" , "the port is fully committed");
});

test("apply lands the worktree diff on the checkout and leaves no worktree behind", async (t) => {
  const { repo, worktree, branch } = await makeRepo(t);
  fs.writeFileSync(path.join(worktree, "feature.ts"), "export const feature = () => 42;\n", "utf8");
  fs.writeFileSync(path.join(repo, "README.md"), "# fixture\n\nlocal note\n", "utf8");

  const result = await manageWorktree({ action: "apply", cwd: repo, worktreeBranch: branch });
  assert.equal(result.success, true, result.message);

  assert.equal(fs.existsSync(path.join(repo, "feature.ts")), true, "the new file should be applied");
  assert.equal(fs.existsSync(worktree), false, "the worktree directory should be gone");
  assert.equal(fs.readFileSync(path.join(repo, "README.md"), "utf8"), "# fixture\n\nlocal note\n");

  assert.equal(await branchExists(repo, branch), false);

  const worktrees = await git(repo, ["worktree", "list", "--porcelain"]);
  assert.equal(worktrees.includes(branch), false);
});

test("apply diffs from the baseline commit, so a dirty caller does not block it", async (t) => {
  const { repo, worktree, branch } = await makeRepo(t);
  const headSha = (await git(repo, ["rev-parse", "HEAD"])).trim();

  // A caller with real uncommitted work: the baseline ports it, so `merge-base` sits BELOW it.
  fs.writeFileSync(path.join(repo, "README.md"), "# fixture\n\ncaller work in progress\n", "utf8");
  const snapshot = await snapshotCallerWorkingTree(repo, worktree, headSha);
  assert.notEqual(snapshot.baseSha, headSha, "the caller's edit must move the baseline off HEAD");

  fs.writeFileSync(path.join(worktree, "feature.ts"), "export const feature = () => 42;\n", "utf8");
  await git(worktree, ["add", "."]);
  await git(worktree, ["commit", "-m", "the run's own work"]);

  const result = await manageWorktree({ action: "apply", cwd: repo, worktreeBranch: branch });
  assert.equal(result.success, true, result.message);
  assert.equal(fs.existsSync(path.join(repo, "feature.ts")), true);
  // The caller's own uncommitted edit is not the run's to apply, and must survive untouched.
  assert.equal(
    fs.readFileSync(path.join(repo, "README.md"), "utf8"),
    "# fixture\n\ncaller work in progress\n",
  );
  assert.equal(fs.existsSync(worktree), false);
});

test("a tracked secret edited by the caller is never ported into the baseline", async (t) => {
  const { repo, worktree } = await makeRepo(t);

  // `.env` is tracked here, so it arrives as a tracked modification rather than an untracked file.
  fs.writeFileSync(path.join(repo, ".env"), "SECRET=placeholder\n", "utf8");
  await git(repo, ["add", ".env"]);
  await git(repo, ["commit", "-m", "track a placeholder env"]);
  const trackedHead = (await git(repo, ["rev-parse", "HEAD"])).trim();
  await git(worktree, ["reset", "--hard", trackedHead]);

  fs.writeFileSync(path.join(repo, ".env"), "SECRET=real-production-token\n", "utf8");
  fs.writeFileSync(path.join(repo, "app.ts"), "export const app = 1;\n", "utf8");

  const snapshot = await snapshotCallerWorkingTree(repo, worktree, trackedHead);
  assert.ok(snapshot.skipped.includes(".env"), "a tracked .env edit must be skipped, not ported");
  assert.equal(
    fs.readFileSync(path.join(worktree, ".env"), "utf8"),
    "SECRET=placeholder\n",
    "the worktree must keep the committed placeholder, never the caller's secret",
  );
  assert.equal(fs.existsSync(path.join(worktree, "app.ts")), true, "other edits still travel");
  assert.notEqual(snapshot.baseSha, trackedHead);

  // The secret must not be readable from the baseline commit git recorded.
  const committed = await git(worktree, ["show", `${snapshot.baseSha}:.env`]);
  assert.equal(committed, "SECRET=placeholder\n");
});

test("discard removes the worktree and branch without touching the checkout", async (t) => {
  const { repo, worktree, branch } = await makeRepo(t);
  fs.writeFileSync(path.join(worktree, "abandoned.ts"), "export const abandoned = true;\n", "utf8");

  const result = await manageWorktree({ action: "discard", cwd: repo, worktreeBranch: branch });
  assert.equal(result.success, true, result.message);
  assert.equal(fs.existsSync(path.join(repo, "abandoned.ts")), false);
  assert.equal(fs.existsSync(worktree), false);
  assert.equal(await branchExists(repo, branch), false);
});

test("apply on an unknown branch reports instead of guessing", async (t) => {
  const { repo } = await makeRepo(t);
  const result = await manageWorktree({ action: "apply", cwd: repo, worktreeBranch: "hermes/agy-missing" });
  assert.equal(result.success, false);
  assert.match(result.message, /No worktree for branch/);
});

test("manageWorktree refuses any branch it did not create, and deletes nothing", async (t) => {
  const { repo, branch } = await makeRepo(t);
  await git(repo, ["branch", "hermes/other"]);
  const head = (await git(repo, ["rev-parse", "HEAD"])).trim();
  await git(repo, ["branch", "committed-ref"]);

  for (const forbidden of ["main", "hermes/other", "committed-ref"]) {
    for (const action of ["apply", "discard"] as const) {
      const result = await manageWorktree({ action, cwd: repo, worktreeBranch: forbidden });
      assert.equal(result.success, false, `${action} ${forbidden} must be refused`);
      assert.match(result.message, /Refusing to touch branch/);
    }
  }

  assert.equal(await branchExists(repo, "main"), true, "main must survive");
  assert.equal(await branchExists(repo, "hermes/other"), true, "a foreign hermes/ branch must survive");
  assert.equal(await branchExists(repo, "committed-ref"), true);
  assert.equal(await branchExists(repo, branch), true, "the bridge worktree was never touched");
  assert.equal((await git(repo, ["rev-parse", "main"])).trim(), head);
});

test("a dispatch carrying a credential is refused before any git work happens", async (t) => {
  const { repo } = await makeRepo(t);
  const before = await git(repo, ["worktree", "list", "--porcelain"]);
  const branchesBefore = await git(repo, ["branch", "--list"]);

  await assert.rejects(
    dispatchHermesTask({ cwd: repo, prompt: `use ghp_${"c".repeat(36)} to push` }),
    /Refused to dispatch: prompt contains what looks like a GitHub personal access token/,
  );

  assert.equal(await git(repo, ["worktree", "list", "--porcelain"]), before, "no worktree may be created");
  assert.equal(await git(repo, ["branch", "--list"]), branchesBefore, "no branch may be created");
});

/**
 * Stands in for the `hermes` binary: HERMES_BIN is this Node binary and a committed, extensionless
 * `chat` script makes Node treat the dispatch argv as a script run from the worktree it is spawned in.
 */
const CHAT_STUB = [
  'const fs = require("node:fs");',
  'const path = require("node:path");',
  'fs.writeFileSync(path.join(process.cwd(), "auto-applied.ts"), "export const autoApplied = true;\\n");',
  'process.stdout.write(JSON.stringify({',
  '  type: "result",',
  '  result: "wrote auto-applied.ts",',
  '  session_id: "sess-auto-apply",',
  '  exit_code: 0,',
  '}) + "\\n");',
].join("\n");

/** A fixture repo that carries the stub, plus a session store that attributes the run to a model. */
const makeDispatchRepo = async (t: TestContext): Promise<{ repo: string; home: string }> => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-worker-dispatch-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-worker-dispatch-home-"));
  const previousHome = process.env.HERMES_HOME;
  const previousBin = process.env.HERMES_BIN;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = previousHome;
    if (previousBin === undefined) delete process.env.HERMES_BIN;
    else process.env.HERMES_BIN = previousBin;
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  await git(repo, ["init", "-b", "main"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# fixture\n", "utf8");
  fs.writeFileSync(path.join(repo, "chat"), CHAT_STUB, "utf8");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "initial"]);

  // Attribution is read back from the session row after the run: without it a dispatch fails closed.
  const db = new DatabaseSync(path.join(home, "state.db"));
  db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, model TEXT, model_config TEXT)");
  db.prepare("INSERT INTO sessions (id, model, model_config) VALUES (?, ?, ?)").run(
    "sess-auto-apply",
    DEFAULT_MODEL,
    JSON.stringify({ gateway_runtime: { provider: "clinepass" } }),
  );
  db.close();

  process.env.HERMES_HOME = home;
  process.env.HERMES_BIN = process.execPath;
  return { repo, home };
};

test("autoApply lands the run on the checkout and reports applied", async (t) => {
  const runId = `apply-${process.pid}-${Date.now().toString(36)}`;
  const { repo } = await makeDispatchRepo(t);

  const outcome = await dispatchHermesTask({
    cwd: repo,
    prompt: "Add auto-applied.ts to the repository root.",
    runId,
    autoApply: true,
    fastWaitSeconds: 120,
  });

  assert.ok(!("waitCommand" in outcome), "the call waited for the run instead of answering running");
  const result = outcome as DispatchResult;

  assert.equal(result.success, true, result.message);
  assert.equal(result.applied, true, result.message);
  assert.equal(result.worktreeKept, false, "an applied run leaves no worktree behind");

  assert.equal(
    fs.readFileSync(path.join(repo, "auto-applied.ts"), "utf8"),
    "export const autoApplied = true;\n",
    "the diff must land on the caller's checkout",
  );
  assert.equal(await branchExists(repo, `hermes/agy-${runId}`), false, "the branch is removed");
  assert.equal(fs.existsSync(path.join(repo, ".worktrees", `agy-${runId}`)), false);
});

test("without autoApply the diff stays in the worktree for review", async (t) => {
  const runId = `keep-${process.pid}-${Date.now().toString(36)}`;
  const { repo } = await makeDispatchRepo(t);

  const outcome = await dispatchHermesTask({
    cwd: repo,
    prompt: "Add auto-applied.ts to the repository root.",
    runId,
    fastWaitSeconds: 120,
  });
  const result = outcome as DispatchResult;

  assert.equal(result.success, true, result.message);
  assert.equal(result.applied, undefined, "apply is opt-in");
  assert.equal(result.worktreeKept, true);
  assert.equal(fs.existsSync(path.join(repo, "auto-applied.ts")), false, "the checkout is untouched");
  assert.equal(await branchExists(repo, `hermes/agy-${runId}`), true);
});

test("the fast-wait default keeps a dispatch call short", () => {
  assert.equal(DEFAULT_FAST_WAIT_SECONDS, 1);
});

test("the dispatch argv pins the model, the reasoning effort and a supported source", () => {
  const args = buildChatArgs({
    promptFile: "C:\\Temp\\prompt.txt",
    worktreePath: "C:\\repo\\.worktrees\\agy-x",
    sessionName: "[AGY] test",
  });
  const flag = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };

  assert.equal(flag("--model"), DEFAULT_MODEL);
  assert.equal(flag("--reasoning"), DEFAULT_REASONING);
  assert.equal(flag("--format"), "stream-json");
  assert.equal(flag("--query-file"), "C:\\Temp\\prompt.txt");
  assert.equal(flag("--in"), "C:\\repo\\.worktrees\\agy-x");
  assert.equal(flag("--source"), "cli", "the gateway refuses any source outside its SURFACES list");
  assert.ok(args.includes("--create-if-missing"));
  assert.ok(args.includes("--yolo"));
  assert.equal(args.includes("--worktree"), false, "--in already places Hermes in our worktree");
});

test("caller overrides win over the pinned defaults", () => {
  const args = buildChatArgs({
    promptFile: "p.txt",
    worktreePath: "w",
    sessionName: "s",
    model: "openrouter/free",
    reasoning: "low",
    skills: ["github", "docx"],
  });
  assert.equal(args[args.indexOf("--model") + 1], "openrouter/free");
  assert.equal(args[args.indexOf("--reasoning") + 1], "low");
  assert.equal(args[args.indexOf("--skills") + 1], "github,docx");
});

test("a silently downgraded model is detectable in the session row", () => {
  const fallback = parseGatewayRuntime(
    JSON.stringify({
      _usage_anchor: { prompt_tokens: 1 },
      gateway_runtime: { provider: "openrouter", base_url: "https://openrouter.ai/api/v1/", fallback_active: true },
    }),
  );
  assert.equal(fallback.provider, "openrouter");
  assert.equal(fallback.fallbackActive, true);

  const primary = parseGatewayRuntime(JSON.stringify({ gateway_runtime: { provider: "clinepass" } }));
  assert.equal(primary.provider, "clinepass");
  assert.equal(primary.fallbackActive, false);

  assert.deepEqual(parseGatewayRuntime(null), { provider: null, fallbackActive: false });
  assert.deepEqual(parseGatewayRuntime("{not json"), { provider: null, fallbackActive: false });
});

test("a binary file round-trips byte for byte through the patch", async (t) => {
  const { repo, worktree, branch } = await makeRepo(t);
  // NUL, latin-1 high bytes and CRLF: none of it survives a text patch.
  const bytes = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0xe9, 0x0d, 0x0a, 0x7f, 0x00, 0x42]);
  fs.writeFileSync(path.join(worktree, "asset.bin"), bytes);

  const result = await manageWorktree({ action: "apply", cwd: repo, worktreeBranch: branch });
  assert.equal(result.success, true, result.message);
  const applied = fs.readFileSync(path.join(repo, "asset.bin"));
  assert.deepEqual([...applied], [...bytes], "--binary must carry the exact bytes");
});

test("apply works when cwd is a subdirectory of the repository", async (t) => {
  const { repo, worktree, branch } = await makeRepo(t);
  const nested = path.join(repo, "src", "deep");
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, "keep.ts"), "export const keep = 1;\n", "utf8");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "nested"]);
  fs.writeFileSync(path.join(worktree, "landed.ts"), "export const landed = true;\n", "utf8");

  const result = await manageWorktree({ action: "apply", cwd: nested, worktreeBranch: branch });
  assert.equal(result.success, true, result.message);
  assert.equal(fs.existsSync(path.join(repo, "landed.ts")), true, "the patch must land at the repo root");
  assert.equal(fs.existsSync(path.join(nested, "landed.ts")), false);
});

test("a quoted unicode filename is captured intact, and a rename into .env is refused", async (t) => {
  const { repo, worktree, branch } = await makeRepo(t);
  const unicode = "naïve file ünïcode.ts";
  fs.writeFileSync(path.join(worktree, unicode), "export const ünïcode = 1;\n", "utf8");

  // Rename a tracked file to .env: --no-renames surfaces that as a delete plus a blocked add.
  fs.renameSync(path.join(worktree, "README.md"), path.join(worktree, ".env"));

  const result = await manageWorktree({ action: "apply", cwd: repo, worktreeBranch: branch });
  assert.equal(result.success, false);
  assert.match(result.message, /Refused to apply/);
  assert.match(result.message, /\.env/);

  // The refusal destroys the worktree: nothing is left to apply from and no branch survives.
  assert.equal(fs.existsSync(worktree), false, "the worktree must be destroyed");
  assert.equal(await branchExists(repo, branch), false, "the branch must be destroyed");
  assert.equal(fs.existsSync(path.join(repo, unicode)), false, "nothing may land on the checkout");
  assert.equal(fs.existsSync(path.join(repo, ".env")), false);
  assert.equal(fs.readFileSync(path.join(repo, "README.md"), "utf8"), "# fixture\n");
});

test("an ignored .env is a violation even though git diff cannot see it", async (t) => {
  const { repo, worktree, branch } = await makeRepo(t);
  fs.appendFileSync(path.join(repo, ".git", "info", "exclude"), ".env\n", "utf8");
  fs.writeFileSync(path.join(worktree, "innocuous.ts"), "export const innocent = true;\n", "utf8");
  fs.writeFileSync(path.join(worktree, ".env"), "SECRET=please-do-not-land\n", "utf8");

  const result = await manageWorktree({ action: "apply", cwd: repo, worktreeBranch: branch });
  assert.equal(result.success, false, "an excluded secret must block the apply");
  assert.match(result.message, /Refused to apply/);
  assert.match(result.message, /\.env/);
  assert.equal(fs.existsSync(path.join(repo, ".env")), false, "the ignored file must never be applied");
  assert.equal(fs.existsSync(path.join(repo, "innocuous.ts")), false);
  assert.equal(await branchExists(repo, branch), false);
});

test("a filename derived from the porcelain listing is blocked, not the name-only diff", async (t) => {
  // The name-only diff cannot report an ignored path, so this is the defence-in-depth path.
  const { repo } = await makeRepo(t);
  const verdict = await run(
    "git",
    ["-c", "core.quotePath=false", "status", "--porcelain=v1", "-z", "--ignored", "--no-renames"],
    { cwd: repo, env: GIT_IDENTITY, timeoutMs: 60_000 },
  );
  assert.equal(verdict.code, 0);
});

test("a conflicting apply fails, keeps the worktree and leaves the patch for inspection", async (t) => {
  const { repo, worktree, branch } = await makeRepo(t);
  fs.writeFileSync(path.join(worktree, "README.md"), "# fixture\n\nhermes edit\n", "utf8");
  await git(worktree, ["add", "."]);
  await git(worktree, ["commit", "-m", "hermes edit"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# fixture\n\ncaller edit\n", "utf8");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "caller edit"]);

  const result = await manageWorktree({ action: "apply", cwd: repo, worktreeBranch: branch });
  assert.equal(result.success, false, "a conflicting patch must not report success");
  assert.match(result.message, /git apply failed/);
  assert.notEqual(result.patchPath, undefined, "the patch must be kept for inspection");
  assert.equal(fs.existsSync(worktree), true, "a failed apply keeps the worktree");
  assert.equal(await branchExists(repo, branch), true);
});

test("raceFastWait reports a timeout without leaving a timer behind", async () => {
  let settled = false;
  const pending = new Promise<string>((resolve) => {
    setTimeout(() => {
      settled = true;
      resolve("late");
    }, 5_000).unref();
  });

  const raced = await raceFastWait(pending, 0.05);
  assert.equal(raced.done, false);
  assert.equal(settled, false, "the slow promise must not have resolved");

  const immediate = await raceFastWait(Promise.resolve(42), 30);
  assert.deepEqual(immediate, { done: true, value: 42 });
});

test("pruneStaleRuns removes only run files past the age cutoff", async (t) => {
  const stamp = `${process.pid}-${Date.now().toString(36)}`;
  const staleId = `test-stale-${stamp}`;
  const freshId = `test-fresh-${stamp}`;
  const staleLog = runLogPath(staleId);
  const freshState = runStatePath(freshId);
  const staleTmp = `${runStatePath(staleId)}.tmp`;
  const unrelated = path.join(RUN_STATE_DIR, `keep-${stamp}.txt`);
  fs.mkdirSync(RUN_STATE_DIR, { recursive: true });
  fs.writeFileSync(staleTmp, "partial", "utf8");
  fs.writeFileSync(staleLog, "abandoned\n", "utf8");
  fs.writeFileSync(freshState, "{}", "utf8");
  fs.writeFileSync(unrelated, "not a run artifact", "utf8");
  t.after(() => {
    for (const file of [staleTmp, staleLog, freshState, unrelated]) fs.rmSync(file, { force: true });
  });

  const eightHoursAgo = new Date(Date.now() - 8 * 60 * 60 * 1000);
  fs.utimesSync(staleTmp, eightHoursAgo, eightHoursAgo);
  fs.utimesSync(staleLog, eightHoursAgo, eightHoursAgo);

  const removed = await pruneStaleRuns(60 * 60 * 1000);
  assert.ok(removed >= 2, `the two backdated artifacts must be pruned, removed ${removed}`);
  assert.equal(fs.existsSync(staleTmp), false, "a stale .tmp must be removed");
  assert.equal(fs.existsSync(staleLog), false, "a stale .log must be removed");
  assert.equal(fs.existsSync(freshState), true, "a fresh state file must survive");
  assert.equal(fs.existsSync(unrelated), true, "a non-run suffix must never be touched");
});

test("listActiveRuns reports only the records still running, newest first", async (t) => {
  const stamp = `${process.pid}-${Date.now().toString(36)}`;
  const newer = `active-new-${stamp}`;
  const older = `active-old-${stamp}`;
  const finished = `active-done-${stamp}`;
  const corrupt = `active-bad-${stamp}`;
  fs.mkdirSync(RUN_STATE_DIR, { recursive: true });
  const logNoise = runLogPath(newer);
  t.after(() => {
    for (const runId of [newer, older, finished, corrupt]) fs.rmSync(runStatePath(runId), { force: true });
    fs.rmSync(logNoise, { force: true });
  });

  await writeRunState({
    status: "running",
    runId: older,
    sessionName: "s",
    worktreePath: "w",
    branch: "hermes/agy-old",
    startedAt: 1_000,
  });
  await writeRunState({
    status: "running",
    runId: newer,
    sessionName: "s",
    worktreePath: "w",
    branch: "hermes/agy-new",
    startedAt: 2_000,
  });
  await writeRunState({
    status: "completed",
    runId: finished,
    sessionName: "s",
    worktreePath: "w",
    branch: "hermes/agy-done",
    startedAt: 3_000,
    result: { success: true },
  });
  // A run killed mid-write leaves a truncated record: it must be skipped, not thrown on.
  fs.writeFileSync(runStatePath(corrupt), '{"status":"running"', "utf8");
  fs.writeFileSync(logNoise, "[Hermes:Tool] not a state record\n", "utf8");

  const listed = listActiveRuns().filter((state) => state.runId.endsWith(stamp));
  assert.deepEqual(
    listed.map((state) => state.runId),
    [newer, older],
    `only running records, newest first; got ${JSON.stringify(listed.map((state) => state.runId))}`,
  );
  assert.equal(listed[0].branch, "hermes/agy-new", "the whole record is returned, not just the id");
  assert.equal(listed[0].status, "running");
});

test("wait.js polls the run registry, streams the log tail and reports the result", async (t) => {
  const runId = `test-${process.pid}-${Date.now().toString(36)}`;
  const statePath = runStatePath(runId);
  const logPath = runLogPath(runId);
  const result = { success: true, runId, message: "done", durationMs: 4_000 };
  fs.mkdirSync(RUN_STATE_DIR, { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({ status: "running", runId, result: undefined }), "utf8");
  t.after(() => {
    fs.rmSync(statePath, { force: true });
    fs.rmSync(logPath, { force: true });
  });

  const child = run(
    process.execPath,
    ["--import", "tsx", "src/wait.ts", runId],
    { cwd: path.resolve(import.meta.dirname, ".."), timeoutMs: 20_000 },
  );

  // One tick for the poller to open the (not yet existing) log, then the dispatch starts writing.
  await new Promise((resolve) => setTimeout(resolve, 400));
  const log = openRunLog(logPath);
  log.write(["[Hermes:Tool] terminal (pnpm test)"]);
  await new Promise((resolve) => setTimeout(resolve, 700));
  log.write(["[Hermes:Result] call-1 -> 67 passing"]);
  await log.close();

  await writeRunState({
    status: "completed",
    runId,
    sessionName: "s",
    worktreePath: "w",
    branch: "hermes/agy-x",
    startedAt: Date.now() - 4_000,
    result,
  });

  const output = await child;
  assert.equal(output.code, 0, output.stderr);
  assert.match(output.stdout, new RegExp(`\\[Hermes Worker\\] Tailing run ${runId}`));

  // Both lines must reach stdout, and the first one only because the tail was live rather than
  // read once at exit.
  assert.match(output.stdout, /\[Hermes:Tool\] terminal \(pnpm test\)/);
  assert.match(output.stdout, /\[Hermes:Result\] call-1 -> 67 passing/);
  assert.ok(
    output.stdout.indexOf("[Hermes:Tool]") < output.stdout.indexOf("Telemetry"),
    "the tail must be flushed before the summary",
  );

  assert.match(output.stdout, /\[Hermes Dispatch Telemetry\] \(Status: SUCCESS\)/);
  assert.match(output.stdout, new RegExp(`- Run ID: ${runId}`));
  assert.match(output.stdout, /- Duration: 4\.0s/);
  assert.match(output.stdout, /- Tools Called: 0/);
  assert.match(output.stdout, /<<<HERMES_DISPATCH_COMPLETE:/);

  assert.ok(output.stdout.includes(formatDispatchSentinel(runId)), "the sentinel must name the run");
  assert.equal(
    output.stdout.includes(HERMES_DISPATCH_FAILED_PREFIX),
    false,
    "a successful run must not emit the failure sentinel",
  );

  // The result message is emitted after the sentinel; large raw JSON is suppressed.
  assert.match(output.stdout, /done/);
  assert.equal(output.stdout.includes('{\n  "success"'), false, "large raw JSON must not be emitted");

  assert.equal(readRunState(runId), null, "the callback consumes the state file");
  assert.equal(fs.existsSync(logPath), false, "the log is pruned with the state file");
});

test("wait.js emits the failure telemetry and sentinel, then exits 1", async (t) => {
  const runId = `test-fail-${process.pid}-${Date.now().toString(36)}`;
  const statePath = runStatePath(runId);
  const result = {
    success: false,
    message: "boom",
    durationMs: 2_500,
    toolEvents: [
      { type: "tool_use", name: "read_file" },
      { type: "tool_use", name: "delegate_task" },
      { type: "tool_use", name: "delegate_task" },
      { type: "tool_result", name: "r" },
    ],
    tokens: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5 },
  };
  await writeRunState({
    status: "completed",
    runId,
    sessionName: "s",
    worktreePath: "w",
    branch: "hermes/agy-x",
    startedAt: Date.now(),
    result,
  });
  t.after(() => fs.rmSync(statePath, { force: true }));

  const output = await run(process.execPath, ["--import", "tsx", "src/wait.ts", runId], {
    cwd: path.resolve(import.meta.dirname, ".."),
    timeoutMs: 20_000,
  });
  assert.equal(output.code, 1);
  assert.match(output.stdout, /\(Status: FAILED\)/);
  assert.match(output.stdout, /- Duration: 2\.5s/);
  assert.match(output.stdout, /- Tools Called: 3/);
  assert.match(output.stdout, /- Subagents Spawned: 2/);
  assert.match(output.stdout, /- Tokens Used: 125 \(input: 100, output: 20, cache: 5\)/);
  assert.ok(output.stdout.includes(formatFailedSentinel(runId)));
  assert.match(output.stdout, /boom/);
  assert.equal(output.stdout.includes('{\n  "success"'), false, "large raw JSON must not be emitted");
});

test("wait.js streams log bytes that were already on disk before it started", async (t) => {
  const runId = `test-prelog-${process.pid}-${Date.now().toString(36)}`;
  const logPath = runLogPath(runId);
  fs.mkdirSync(RUN_STATE_DIR, { recursive: true });
  fs.writeFileSync(logPath, "[Hermes:Tool] written-before-the-tail\n", "utf8");
  t.after(() => clearRunState(runId));

  await writeRunState({
    status: "completed",
    runId,
    sessionName: "s",
    worktreePath: "w",
    branch: "hermes/agy-x",
    startedAt: Date.now(),
    result: { success: true, durationMs: 1_000 },
  });

  const output = await run(process.execPath, ["--import", "tsx", "src/wait.ts", runId], {
    cwd: path.resolve(import.meta.dirname, ".."),
    timeoutMs: 20_000,
  });
  assert.equal(output.code, 0, output.stderr);
  assert.match(output.stdout, /\[Hermes:Tool\] written-before-the-tail/);
  // The tail is drained ahead of the summary even though the run was already finished on start.
  assert.ok(output.stdout.indexOf("written-before-the-tail") < output.stdout.indexOf("Telemetry"));
});

test("wait.js reads Hermes' bare usage keys and emits the assistant summary", async (t) => {
  const runId = `test-bare-${process.pid}-${Date.now().toString(36)}`;
  const statePath = runStatePath(runId);
  const result = {
    success: true,
    durationMs: 1_000,
    summary: "Rewrote the token lookup and the run log renderer.",
    message: "2 file(s) changed on hermes/agy-x.",
    tokens: { input: 300, output: 40, cache_read: 7 },
  };
  await writeRunState({
    status: "completed",
    runId,
    sessionName: "s",
    worktreePath: "w",
    branch: "hermes/agy-x",
    startedAt: Date.now(),
    result,
  });
  t.after(() => fs.rmSync(statePath, { force: true }));

  const output = await run(process.execPath, ["--import", "tsx", "src/wait.ts", runId], {
    cwd: path.resolve(import.meta.dirname, ".."),
    timeoutMs: 20_000,
  });
  assert.equal(output.code, 0, output.stderr);
  assert.match(output.stdout, /- Tokens Used: 347 \(input: 300, output: 40, cache: 7\)/);
  assert.match(output.stdout, /\[Hermes Summary\]\nRewrote the token lookup and the run log renderer\./);
  // The summary is the agent's own words, so it must land ahead of the dispatch verdict.
  assert.ok(
    output.stdout.indexOf("[Hermes Summary]") < output.stdout.indexOf("2 file(s) changed"),
    "the summary must precede the dispatch message",
  );
  // A reported total wins over the sum of its parts.
  await writeRunState({
    status: "completed",
    runId,
    sessionName: "s",
    worktreePath: "w",
    branch: "hermes/agy-x",
    startedAt: Date.now(),
    result: { success: true, durationMs: 1_000, tokens: { total: 999, input: 10, output: 5 } },
  });
  const second = await run(process.execPath, ["--import", "tsx", "src/wait.ts", runId], {
    cwd: path.resolve(import.meta.dirname, ".."),
    timeoutMs: 20_000,
  });
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /- Tokens Used: 999 \(input: 10, output: 5, cache: 0\)/);
  assert.equal(
    second.stdout.includes("[Hermes Summary]"),
    false,
    "a run without a summary must not print an empty header",
  );
});

test("formatStreamLine renders a tool_result payload carried as an object or a bare field", () => {
  // Hermes reports tool output under `output` as often as under `content`.
  const output = formatStreamLine(
    JSON.stringify({ type: "tool_result", tool_use_id: "call-9", output: "Tests: 12 passed" }),
  );
  assert.deepEqual(output, ["[Hermes:Result] call-9 -> Tests: 12 passed"]);

  const nested = formatStreamLine(
    JSON.stringify({
      type: "tool_result",
      tool_use_id: "call-10",
      content: { stdout: "built in 1.2s", stderr: "" },
    }),
  );
  assert.deepEqual(nested, ["[Hermes:Result] call-10 -> built in 1.2s"]);

  const resultField = formatStreamLine(
    JSON.stringify({ type: "tool_result", tool_use_id: "call-11", result: { result: "ok" } }),
  );
  assert.deepEqual(resultField, ["[Hermes:Result] call-11 -> ok"]);

  const stderrOnly = formatStreamLine(
    JSON.stringify({ type: "tool_result", tool_use_id: "call-12", content: { stderr: "ENOENT" } }),
  );
  assert.deepEqual(stderrOnly, ["[Hermes:Result] call-12 -> ENOENT"]);

  // An object with no recognised text field stays silent rather than printing [object Object].
  const opaque = formatStreamLine(
    JSON.stringify({ type: "tool_result", tool_use_id: "call-13", content: { exit_code: 0 } }),
  );
  assert.deepEqual(opaque, ["[Hermes:Result] call-13"]);

  // An empty content array must not shadow a populated `output` next to it.
  const shadowed = formatStreamLine(
    JSON.stringify({ type: "tool_result", tool_use_id: "call-14", content: [], output: "fell through" }),
  );
  assert.deepEqual(shadowed, ["[Hermes:Result] call-14 -> fell through"]);
});

test("runMetadata sums Hermes' bare token keys", () => {
  const bare = runMetadata({
    durationMs: 1_000,
    sessionId: null,
    tokens: { input: 50, output: 10, cache_read: 5 },
  });
  assert.equal(bare.brackets, " [tokens: 65]");

  // `total` short-circuits the parts, exactly as `total_tokens` does.
  const explicit = runMetadata({ durationMs: 0, sessionId: null, tokens: { total: 500, input: 1 } });
  assert.equal(explicit.brackets, " [tokens: 500]");
});

test("formatStreamLine renders each event type as one readable line", () => {
  const tool = formatStreamLine(
    JSON.stringify({
      type: "tool_use",
      name: "read_file",
      input: { file_path: "src/wait.ts", offset: 1 },
    }),
  );
  assert.deepEqual(tool, ["[Hermes:Tool] read_file (src/wait.ts)"]);

  const exec = formatStreamLine(
    JSON.stringify({ type: "tool_use", name: "terminal", input: { command: "pnpm test 2>&1" } }),
  );
  assert.deepEqual(exec, ["[Hermes:Tool] terminal (pnpm test 2>&1)", "[Hermes:Exec] pnpm test 2>&1"]);

  const result = formatStreamLine(
    JSON.stringify({
      type: "tool_result",
      tool_use_id: "call-7",
      content: [{ type: "text", text: "x".repeat(400) }],
    }),
  );
  assert.equal(result.length, 1);
  assert.match(result[0], /^\[Hermes:Result\] call-7 -> x+/);
  assert.ok(result[0].length <= "[Hermes:Result] call-7 -> ".length + 120, "output is clipped to 120");

  const step = formatStreamLine(JSON.stringify({ type: "text", text: "Reading the test suite" }));
  assert.deepEqual(step, ["[Hermes:Step] Reading the test suite"]);

  // A nested assistant message must still surface its tool_use block.
  const nested = formatStreamLine(
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "grep", input: { pattern: "TODO" } }] },
    }),
  );
  assert.deepEqual(nested, ["[Hermes:Tool] grep (TODO)"]);

  assert.deepEqual(formatStreamLine(""), []);
  assert.deepEqual(formatStreamLine("{not json"), ["[Hermes:Output] {not json"]);
});

test("the run log is written and flushed in order", async (t) => {
  const runId = `test-log-${process.pid}-${Date.now().toString(36)}`;
  const logPath = runLogPath(runId);
  t.after(() => fs.rmSync(logPath, { force: true }));

  const log = openRunLog(logPath);
  log.write(["[Hermes:Tool] a"]);
  log.write(["[Hermes:Tool] b", "[Hermes:Exec] c"]);
  await log.close();

  assert.equal(fs.readFileSync(logPath, "utf8"), "[Hermes:Tool] a\n[Hermes:Tool] b\n[Hermes:Exec] c\n");
  // A second close must not throw: the pipeline closes in `finally` on every path.
  await log.close();

  await writeRunState({
    status: "completed",
    runId,
    sessionName: "s",
    worktreePath: "w",
    branch: "hermes/agy-x",
    startedAt: Date.now(),
    result: { success: true },
  });
  await clearRunState(runId);
  assert.equal(fs.existsSync(logPath), false, "clearRunState prunes the log with the state file");
  assert.equal(fs.existsSync(runStatePath(runId)), false);
});

test("sentinel helpers name the run and use the documented prefixes", () => {
  assert.equal(HERMES_DISPATCH_SENTINEL_PREFIX, "<<<HERMES_DISPATCH_COMPLETE:");
  assert.equal(HERMES_DISPATCH_FAILED_PREFIX, "<<<HERMES_DISPATCH_FAILED:");
  assert.equal(formatDispatchSentinel("abc-123"), "<<<HERMES_DISPATCH_COMPLETE:abc-123>>>");
  assert.equal(formatFailedSentinel("abc-123"), "<<<HERMES_DISPATCH_FAILED:abc-123>>>");
});

test("wait.js refuses a path-traversing run id", async () => {
  const output = await run(process.execPath, ["--import", "tsx", "src/wait.ts", "../../evil"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    timeoutMs: 20_000,
  });
  assert.notEqual(output.code, 0);
  assert.match(output.stderr, /invalid run id/);
});

test("listHermesSessions reads the session store", () => {
  const sessions = listHermesSessions({ limit: 5 });
  for (const session of sessions) {
    assert.equal(typeof session.id, "string");
    assert.equal(typeof session.started_at, "number");
  }
});

test("listHermesSessions scopes to a cwd prefix without treating it as a pattern", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-worker-home-"));
  const previous = process.env.HERMES_HOME;
  process.env.HERMES_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const db = new DatabaseSync(path.join(home, "state.db"));
  db.exec(
    `CREATE TABLE sessions (
       id TEXT PRIMARY KEY, title TEXT, model TEXT, started_at INTEGER,
       message_count INTEGER, tool_call_count INTEGER, cwd TEXT, git_repo_root TEXT
     )`,
  );
  const insert = db.prepare(
    "INSERT INTO sessions (id, title, model, started_at, message_count, tool_call_count, cwd, git_repo_root) VALUES (?,?,?,?,?,?,?,?)",
  );
  const root = path.join(home, "proj_50%off");
  insert.run("exact", "t", "m", 5, 0, 0, root, root);
  insert.run("child", "t", "m", 4, 0, 0, path.join(root, "sub"), null);
  // `_` and `%` are LIKE wildcards: unescaped, both of these would match.
  insert.run("wildcard-underscore", "t", "m", 3, 0, 0, path.join(home, "projX50Xoff", "sub"), null);
  insert.run("wildcard-percent", "t", "m", 2, 0, 0, path.join(home, "proj_50anything", "sub"), null);
  insert.run("unrelated", "t", "m", 1, 0, 0, path.join(home, "other"), null);
  db.close();

  const rows = listHermesSessions({ cwd: root, limit: 50 });
  assert.deepEqual(
    rows.map((row) => row.id).sort(),
    ["child", "exact"],
    `LIKE escaping must keep the prefix literal, got ${JSON.stringify(rows.map((row) => row.id))}`,
  );
});

test("runMetadata appends duration, session and tokens without leaving empty segments", () => {
  const full = runMetadata({
    durationMs: 12_345,
    sessionId: "sess-1",
    tokens: { total_tokens: 987 },
  });
  assert.equal(full.duration, " in 12.3s");
  assert.equal(full.brackets, " [session: sess-1] [tokens: 987]");

  // Absent everything: no leading space, no empty brackets.
  assert.deepEqual(runMetadata({ durationMs: null, sessionId: null, tokens: null }), {
    duration: "",
    brackets: "",
  });

  // A usage record without total_tokens still reports, summed across its parts.
  const summed = runMetadata({
    durationMs: 0,
    sessionId: null,
    tokens: { input_tokens: 100, output_tokens: 20 },
  });
  assert.equal(summed.duration, " in 0.0s");
  assert.equal(summed.brackets, " [tokens: 120]");

  // A zeroed or empty usage record is no count at all.
  assert.equal(
    runMetadata({ durationMs: null, sessionId: "s", tokens: { input_tokens: 0 } }).brackets,
    " [session: s]",
  );
});

/** A worktree as a crashed dispatch leaves it: a directory on disk that no run record owns. */
const makeOrphan = (repo: string, runId: string): string => {
  const target = path.join(repo, ".worktrees", `agy-${runId}`);
  fs.mkdirSync(path.join(target, "src"), { recursive: true });
  fs.writeFileSync(path.join(target, "src", "leftover.ts"), "export const leftover = 1;\n", "utf8");
  return target;
};

/**
 * Windows holds a directory handle open briefly after its process exits, so an rm lands on EPERM
 * and a single attempt leaks the directory. The helper must retry rather than surrender.
 */
/**
 * Windows holds a directory handle open briefly after its process exits, so an rm lands on EPERM
 * and a single attempt leaks the directory. The helper must retry rather than surrender.
 *
 * A worktree missing its `.git` file is the cheapest way to make git refuse the removal, which is
 * what pushes the cleanup onto the disk sweep the mock is watching.
 */
const breakWorktree = (worktree: string): void => {
  fs.rmSync(path.join(worktree, ".git"));
};

test("a transient EPERM on the worktree directory is retried, not reported as a failure", async (t) => {
  const { repo, worktree, branch } = await makeRepo(t);
  breakWorktree(worktree);
  const realRm = fsp.rm.bind(fsp);
  let attempts = 0;

  const handle = mock.method(fsp, "rm", async (target: unknown, options?: unknown) => {
    // Only the worktree path fails: the branch's own bookkeeping and the test's cleanup stay real.
    if (path.resolve(String(target)) === path.resolve(worktree)) {
      attempts += 1;
      if (attempts <= 2) {
        throw Object.assign(new Error(`EPERM: operation not permitted, rmdir '${worktree}'`), {
          code: "EPERM",
        });
      }
    }
    return realRm(target as Parameters<typeof fsp.rm>[0], options as Parameters<typeof fsp.rm>[1]);
  });
  t.after(() => handle.mock.restore());

  const startedAt = Date.now();
  const result = await manageWorktree({ action: "discard", cwd: repo, worktreeBranch: branch });
  const elapsed = Date.now() - startedAt;

  assert.equal(result.success, true, `a lock that clears must not be a failure: ${result.message}`);
  assert.equal(fs.existsSync(worktree), false, "the worktree directory must be gone");
  assert.equal(attempts, 3, "two EPERM attempts must be retried until the removal succeeds");
  // 150ms then 300ms of backoff: proves the retries are paced, not spun.
  assert.ok(elapsed >= 400, `retries must back off, took ${elapsed}ms`);
  assert.equal(await branchExists(repo, branch), false);
});

test("a removal that never clears is reported with the path and the OS error", async (t) => {
  const { repo, worktree, branch } = await makeRepo(t);
  breakWorktree(worktree);
  const realRm = fsp.rm.bind(fsp);

  const handle = mock.method(fsp, "rm", async (target: unknown, options?: unknown) => {
    if (path.resolve(String(target)) === path.resolve(worktree)) {
      throw Object.assign(new Error(`EPERM: operation not permitted, rmdir '${worktree}'`), {
        code: "EPERM",
      });
    }
    return realRm(target as Parameters<typeof fsp.rm>[0], options as Parameters<typeof fsp.rm>[1]);
  });
  t.after(() => handle.mock.restore());

  const result = await manageWorktree({ action: "discard", cwd: repo, worktreeBranch: branch });

  assert.equal(result.success, false, "a directory that survives on disk is a real failure");
  assert.match(result.message, /could not delete/);
  assert.match(result.message, /EPERM/);
  assert.equal(fs.existsSync(worktree), true, "the surviving directory must be reported, not hidden");
});

/**
 * git validates the worktree's own `.git` file before it removes anything, so a damaged worktree is
 * refused outright with the directory left behind. Sweeping it and pruning the admin record is the
 * same end state, so the run must not report a cleanup failure for it.
 */
test("a worktree git refuses to remove is still a clean removal once the directory is gone", async (t) => {
  const { repo, worktree, branch } = await makeRepo(t);
  breakWorktree(worktree);

  const refused = await run("git", ["worktree", "remove", "--force", worktree], {
    cwd: repo,
    env: GIT_IDENTITY,
    timeoutMs: 60_000,
  });
  assert.notEqual(refused.code, 0, "the fixture must reproduce git's refusal");
  assert.equal(fs.existsSync(worktree), true, "git refuses without removing anything");

  const result = await manageWorktree({ action: "discard", cwd: repo, worktreeBranch: branch });

  assert.equal(result.success, true, `git's refusal alone must not be a failure: ${result.message}`);
  assert.equal(fs.existsSync(worktree), false, "the damaged directory must be swept from disk");
  assert.equal(await branchExists(repo, branch), false);

  const registered = await git(repo, ["worktree", "list", "--porcelain"]);
  assert.equal(registered.includes(worktree.replace(/\\/g, "/")), false, "the admin record must be pruned");
});

test("a directory already deleted from disk removes without error", async (t) => {
  const { repo, worktree, branch } = await makeRepo(t);
  fs.rmSync(worktree, { recursive: true, force: true });

  const result = await manageWorktree({ action: "discard", cwd: repo, worktreeBranch: branch });

  assert.equal(result.success, true, result.message);
  assert.equal(await branchExists(repo, branch), false);
  assert.equal(
    (await git(repo, ["worktree", "list", "--porcelain"])).includes(worktree.replace(/\\/g, "/")),
    false,
  );
});

test("pruneOrphanWorktrees sweeps agy-* directories that no running run owns", async (t) => {
  const { repo } = await makeRepo(t);
  const stamp = `${process.pid}-${Date.now().toString(36)}`;
  const activeId = `test-keep-${stamp}`;
  const finishedId = `test-done-${stamp}`;
  const strayId = `test-stray-${stamp}`;
  const foreign = path.join(repo, ".worktrees", "not-a-run");

  const worktreesRoot = path.join(repo, ".worktrees");
  const activePath = path.join(worktreesRoot, `agy-${activeId}`);
  const finishedPath = path.join(worktreesRoot, `agy-${finishedId}`);
  const strayPath = path.join(worktreesRoot, `agy-${strayId}`);

  await git(repo, ["worktree", "add", "-b", `hermes/agy-${activeId}`, activePath, "HEAD"]);
  await git(repo, ["worktree", "add", "-b", `hermes/agy-${finishedId}`, finishedPath, "HEAD"]);
  // A crashed dispatch: the directory survives with no run record pointing at it.
  fs.mkdirSync(strayPath, { recursive: true });
  fs.writeFileSync(path.join(strayPath, "leftover.ts"), "export const leftover = 1;\n", "utf8");
  fs.mkdirSync(foreign, { recursive: true });

  await writeRunState({
    status: "running",
    runId: activeId,
    sessionName: "s",
    worktreePath: activePath,
    branch: `hermes/agy-${activeId}`,
    startedAt: Date.now(),
  });
  t.after(() => clearRunState(activeId));

  const removed = await pruneOrphanWorktrees(repo);

  // Three orphans: the fixture's own worktree, the finished run's registered one and the stray.
  // The active run's worktree and the directory that is not a bridge worktree both survive.
  assert.equal(removed, 3, `expected every unowned agy-* directory to go, removed ${removed}`);
  assert.equal(fs.existsSync(activePath), true, "a running run's worktree must never be swept");
  assert.equal(fs.existsSync(finishedPath), false, "a worktree with no running run is an orphan");
  assert.equal(fs.existsSync(strayPath), false, "a directory with no run record is an orphan");
  assert.equal(fs.existsSync(foreign), true, "only agy-* directories belong to the bridge");

  // git prints porcelain paths with forward slashes on every platform.
  const slashed = (value: string): string => value.replace(/\\/g, "/");
  const registered = await git(repo, ["worktree", "list", "--porcelain"]);
  assert.equal(registered.includes(slashed(finishedPath)), false, "the swept worktree's record must be pruned");
  assert.equal(registered.includes(slashed(activePath)), true, "the active worktree must stay registered");
  assert.equal(fs.readFileSync(path.join(activePath, "README.md"), "utf8"), "# fixture\n");
  // The branch is the only surviving copy of the swept work: the sweep must never delete it.
  assert.equal(await branchExists(repo, `hermes/agy-${finishedId}`), true);
  assert.equal(await branchExists(repo, `hermes/agy-${activeId}`), true);
});

test("pruneOrphanWorktrees sweeps the repository root when called from a subdirectory", async (t) => {
  const { repo } = await makeRepo(t);
  const stray = path.join(repo, ".worktrees", `agy-test-stray-${process.pid}-${Date.now().toString(36)}`);
  fs.mkdirSync(stray, { recursive: true });
  const nested = path.join(repo, "src", "deep");
  fs.mkdirSync(nested, { recursive: true });

  const removed = await pruneOrphanWorktrees(nested);

  // The stray plus the fixture's own worktree, both found from above the caller's cwd.
  assert.equal(removed, 2, `expected the sweep to run at the repo root, removed ${removed}`);
  assert.equal(fs.existsSync(stray), false);
});

test("pruneOrphanWorktrees is a no-op on a repository that never dispatched", async (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-worker-repo-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  await git(repo, ["init", "-b", "main"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# fixture\n", "utf8");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "initial"]);

  assert.equal(await pruneOrphanWorktrees(repo), 0);
});
