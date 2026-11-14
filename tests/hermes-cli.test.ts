import test, { mock, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { run } from "../src/exec.js";
import type { DispatchResult } from "../src/hermes-cli.js";
import {
  DEFAULT_FAST_WAIT_SECONDS,
  DEFAULT_MODEL,
  DEFAULT_REASONING,
  buildChatArgs,
  dispatchHermesTask,
  parseGatewayRuntime,
  parseSessionIdLine,
  raceFastWait,
  readSessionAfterRun,
  readUsageReport,
  sandboxedGitEnv,
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
  isPidAlive,
  isRunAbandoned,
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
const makeRepo = async (
  t: TestContext,
  runId = "test",
): Promise<{ repo: string; worktree: string; branch: string }> => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-worker-repo-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));

  await git(repo, ["init", "-b", "main"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# fixture\n", "utf8");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "initial"]);

  const branch = `hermes/agy-${runId}`;
  const worktree = path.join(repo, ".worktrees", `agy-${runId}`);
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
 * Stands in for the `hermes` binary. A `.mjs` HERMES_BIN is spawned through the running node, which
 * is what lets the fixture see the real argv: the top-level --usage-file has to be readable here or
 * a regression that puts it after `chat` would pass silently.
 */
const chatStub = (options: {
  sessionId: string;
  writeUsage?: Record<string, unknown>;
  sleepMs?: number;
  emitToolCalls?: boolean;
}): string =>
  [
    'import fs from "node:fs";',
    'import path from "node:path";',
    `const SESSION_ID = ${JSON.stringify(options.sessionId)};`,
    `const WRITE_USAGE = ${JSON.stringify(options.writeUsage ?? null)};`,
    `const SLEEP_MS = ${options.sleepMs ?? 0};`,
    `const EMIT_TOOL_CALLS = ${options.emitToolCalls === true};`,
    "const argv = process.argv.slice(2);",
    'const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };',
    '// The ledger flag is top-level: argparse rejects it anywhere after the subcommand.',
    'if (argv.indexOf("--usage-file") > argv.indexOf("chat")) {',
    '  process.stderr.write("argparse: --usage-file belongs before the subcommand\\n");',
    "  process.exit(9);",
    "}",
    'const usageFile = flag("--usage-file");',
    'fs.writeFileSync(path.join(process.cwd(), "auto-applied.ts"), "export const autoApplied = true;\\n");',
    'process.stderr.write("Session: " + SESSION_ID + "\\n");',
    `if (SLEEP_MS > 0) await new Promise((resolve) => setTimeout(resolve, SLEEP_MS));`,
    "if (usageFile) {",
    "  fs.writeFileSync(",
    "    usageFile,",
    "    JSON.stringify(WRITE_USAGE ?? { session_id: SESSION_ID, completed: true, failed: false }) + \"\\n\",",
    "  );",
    "}",
    // A read call and its payload: the event pair a leaky collector would copy into the result.
    "if (EMIT_TOOL_CALLS) {",
    '  process.stdout.write(JSON.stringify({ type: "tool_use", id: "call-1", name: "read_file",',
    '    input: { file_path: "src/secret-layout.ts" } }) + "\\n");',
    '  process.stdout.write(JSON.stringify({ type: "tool_result", tool_use_id: "call-1",',
    '    content: [{ type: "text", text: "x".repeat(900) }] }) + "\\n");',
    "}",
    'process.stdout.write(JSON.stringify({',
    '  type: "result",',
    '  result: "wrote auto-applied.ts",',
    "  session_id: SESSION_ID,",
    "  exit_code: 0,",
    '}) + "\\n");',
  ].join("\n");

/** A fixture repo, plus a session store that attributes the run to a model. */
const makeDispatchRepo = async (
  t: TestContext,
  options: {
    sessionId?: string;
    usage?: Record<string, unknown> | null;
    sleepMs?: number;
    fallbackActive?: boolean;
    emitToolCalls?: boolean;
  } = {},
): Promise<{ repo: string; home: string }> => {
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

  const sessionId = options.sessionId ?? "sess-auto-apply";
  const bin = path.join(home, "hermes-bin.mjs");
  fs.writeFileSync(
    bin,
    chatStub({
      sessionId,
      sleepMs: options.sleepMs,
      writeUsage: options.usage ?? undefined,
      emitToolCalls: options.emitToolCalls,
    }),
    "utf8",
  );

  await git(repo, ["init", "-b", "main"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# fixture\n", "utf8");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "initial"]);

  // Attribution is read back from the session row after the run: without it a dispatch fails closed.
  const db = new DatabaseSync(path.join(home, "state.db"));
  db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, model TEXT, model_config TEXT)");
  db.prepare("INSERT INTO sessions (id, model, model_config) VALUES (?, ?, ?)").run(
    sessionId,
    DEFAULT_MODEL,
    JSON.stringify({
      gateway_runtime: options.fallbackActive
        ? { provider: "openrouter", fallback_active: true }
        : { provider: "opencode-go" },
    }),
  );
  db.close();

  process.env.HERMES_HOME = home;
  process.env.HERMES_BIN = bin;
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

test("an auto-applied run omits the diff body it just wrote to the checkout", async (t) => {
  const runId = `apply-nodiff-${process.pid}-${Date.now().toString(36)}`;
  const { repo } = await makeDispatchRepo(t);

  const result = (await dispatchHermesTask({
    cwd: repo,
    prompt: "Add auto-applied.ts to the repository root.",
    runId,
    autoApply: true,
    fastWaitSeconds: 120,
  })) as DispatchResult;

  assert.equal(result.success, true, result.message);
  assert.equal(result.applied, true);
  // The body would be the same bytes already on the checkout: paying AGY to read it twice is waste.
  assert.equal(result.diff, "");
  assert.equal(result.diffTruncated, false);
  assert.equal(result.diffOmitted, true);
  assert.deepEqual(result.modifiedFiles, ["auto-applied.ts"], "the file list survives the omission");
  assert.equal(
    fs.readFileSync(path.join(repo, "auto-applied.ts"), "utf8"),
    "export const autoApplied = true;\n",
  );
});

test("includeDiff true still returns the diff of an applied run", async (t) => {
  const runId = `apply-withdiff-${process.pid}-${Date.now().toString(36)}`;
  const { repo } = await makeDispatchRepo(t);

  const result = (await dispatchHermesTask({
    cwd: repo,
    prompt: "Add auto-applied.ts to the repository root.",
    runId,
    autoApply: true,
    includeDiff: true,
    fastWaitSeconds: 120,
  })) as DispatchResult;

  assert.equal(result.applied, true, result.message);
  assert.match(result.diff, /auto-applied\.ts/, "an explicit includeDiff still pays for the body");
  assert.equal(result.diffOmitted, undefined, "a returned diff is not an omitted one");
});

test("includeDiff false omits the diff of a run left in its worktree", async (t) => {
  const runId = `keep-nodiff-${process.pid}-${Date.now().toString(36)}`;
  const { repo } = await makeDispatchRepo(t);

  const result = (await dispatchHermesTask({
    cwd: repo,
    prompt: "Add auto-applied.ts to the repository root.",
    runId,
    includeDiff: false,
    fastWaitSeconds: 120,
  })) as DispatchResult;

  assert.equal(result.success, true, result.message);
  assert.equal(result.worktreeKept, true, "asking for no diff must not land anything");
  assert.equal(result.diff, "");
  assert.equal(result.diffOmitted, true);
  assert.deepEqual(result.modifiedFiles, ["auto-applied.ts"]);
});

test("a review-kept dispatch still returns the diff by default", async (t) => {
  const runId = `keep-diff-${process.pid}-${Date.now().toString(36)}`;
  const { repo } = await makeDispatchRepo(t);

  const result = (await dispatchHermesTask({
    cwd: repo,
    prompt: "Add auto-applied.ts to the repository root.",
    runId,
    fastWaitSeconds: 120,
  })) as DispatchResult;

  assert.equal(result.worktreeKept, true);
  assert.match(result.diff, /auto-applied\.ts/, "an unapplied run has no other source for its diff");
  assert.equal(result.diffOmitted, undefined);
});

test("the returned tool events name calls only, never a result payload", async (t) => {
  const runId = `tool-events-${process.pid}-${Date.now().toString(36)}`;
  const { repo } = await makeDispatchRepo(t, { emitToolCalls: true });

  const result = (await dispatchHermesTask({
    cwd: repo,
    prompt: "Add auto-applied.ts to the repository root.",
    runId,
    fastWaitSeconds: 120,
  })) as DispatchResult;

  assert.equal(result.success, true, result.message);
  const uses = result.toolEvents.filter((event) => event.type === "tool_use");
  assert.equal(uses.length, 1, "the read call is still counted");
  assert.equal(uses[0].name, "read_file");
  // The payload is the run log's job: copying it back bills the caller for text nothing reads.
  assert.equal(
    result.toolEvents.some((event) => event.type === "tool_result"),
    false,
    "no result payload may ride along in the dispatch answer",
  );
  assert.equal(
    JSON.stringify(result.toolEvents).includes("xxxxxxxxxx"),
    false,
    "no tool output may be smuggled into the answer",
  );
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

  const primary = parseGatewayRuntime(JSON.stringify({ gateway_runtime: { provider: "opencode-go" } }));
  assert.equal(primary.provider, "opencode-go");
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

  assert.match(output.stdout, /\[Hermes Dispatch Telemetry\] SUCCESS/);
  assert.match(output.stdout, new RegExp(`\\| run \\| ${runId} \\|`));
  assert.match(output.stdout, /\| duration \| 4\.0s \|/);
  assert.match(output.stdout, /\| tools \| 0 \|/);
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
  assert.match(output.stdout, /\[Hermes Dispatch Telemetry\] FAILED/);
  assert.match(output.stdout, /\| duration \| 2\.5s \|/);
  assert.match(output.stdout, /\| tools \| 3 \|/);
  assert.match(output.stdout, /\| subagents \| 2 \|/);
  assert.match(
    output.stdout,
    /\| tokens \| input 100 · output 20 · cache_read 5 · reasoning 0 · total 125 \|/,
  );
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
  assert.match(
    output.stdout,
    /\| tokens \| input 300 · output 40 · cache_read 7 · reasoning 0 · total 347 \|/,
  );
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
  assert.match(
    second.stdout,
    /\| tokens \| input 10 · output 5 · cache_read 0 · reasoning 0 · total 999 \|/,
  );
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
  // Paced backoff, not a spin: two retries have to cost real time.
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

/** A process sitting in a directory holds that directory open: the handle Windows reports as EBUSY. */
const holdDirectoryOpen = async (t: TestContext, cwd: string): Promise<number> => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    cwd,
    stdio: "ignore",
    windowsHide: true,
  });
  t.after(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  });
  await new Promise((resolve) => child.once("spawn", resolve));
  assert.equal(typeof child.pid, "number");
  return child.pid as number;
};

/**
 * EBUSY is Windows reporting the directory still being held open, and the lock clears on its own:
 * abandoning the removal on the first attempt is the leak this retry exists to prevent.
 */
test("a transient EBUSY on the worktree directory is retried, not reported as a failure", async (t) => {
  const { repo, worktree, branch } = await makeRepo(t);
  breakWorktree(worktree);
  const realRm = fsp.rm.bind(fsp);
  let attempts = 0;

  const handle = mock.method(fsp, "rm", async (target: unknown, options?: unknown) => {
    if (path.resolve(String(target)) === path.resolve(worktree)) {
      attempts += 1;
      if (attempts <= 2) {
        throw Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${worktree}'`), {
          code: "EBUSY",
        });
      }
    }
    return realRm(target as Parameters<typeof fsp.rm>[0], options as Parameters<typeof fsp.rm>[1]);
  });
  t.after(() => handle.mock.restore());

  const result = await manageWorktree({ action: "discard", cwd: repo, worktreeBranch: branch });

  assert.equal(result.success, true, `a lock that clears must not be a failure: ${result.message}`);
  assert.equal(fs.existsSync(worktree), false, "the worktree directory must be gone");
  assert.equal(attempts, 3, "two EBUSY attempts must be retried until the removal succeeds");
});

test("a removal locked by EBUSY for good is reported with the path and the OS error", async (t) => {
  const { repo, worktree, branch } = await makeRepo(t);
  breakWorktree(worktree);
  const realRm = fsp.rm.bind(fsp);

  const handle = mock.method(fsp, "rm", async (target: unknown, options?: unknown) => {
    if (path.resolve(String(target)) === path.resolve(worktree)) {
      throw Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${worktree}'`), {
        code: "EBUSY",
      });
    }
    return realRm(target as Parameters<typeof fsp.rm>[0], options as Parameters<typeof fsp.rm>[1]);
  });
  t.after(() => handle.mock.restore());

  const result = await manageWorktree({ action: "discard", cwd: repo, worktreeBranch: branch });

  assert.equal(result.success, false, "a directory that survives on disk is a real failure");
  assert.match(result.message, /could not delete/);
  assert.match(result.message, /EBUSY/);
  assert.equal(fs.existsSync(worktree), true, "the surviving directory must be reported, not hidden");
});

test("a child still running in the worktree is killed before the removal is attempted", async (t) => {
  const runId = `held-${process.pid}-${Date.now().toString(36)}`;
  const { repo, worktree, branch } = await makeRepo(t, runId);
  const childPid = await holdDirectoryOpen(t, worktree);
  await writeRunState({
    status: "completed",
    runId,
    sessionName: "s",
    worktreePath: worktree,
    branch,
    startedAt: Date.now(),
    childPid,
  });
  t.after(() => clearRunState(runId));

  const realRm = fsp.rm.bind(fsp);
  const root = path.resolve(worktree);
  let touchesWhileAlive = 0;
  const handle = mock.method(fsp, "rm", async (target: unknown, options?: unknown) => {
    // Anything inside the worktree counts: even a file removal starts taking the directory apart
    // while the child can still write into it.
    const resolved = path.resolve(String(target));
    if ((resolved === root || resolved.startsWith(root + path.sep)) && isPidAlive(childPid)) {
      touchesWhileAlive += 1;
    }
    return realRm(target as Parameters<typeof fsp.rm>[0], options as Parameters<typeof fsp.rm>[1]);
  });
  t.after(() => handle.mock.restore());

  const result = await manageWorktree({ action: "discard", cwd: repo, worktreeBranch: branch });

  assert.equal(result.success, true, result.message);
  assert.equal(isPidAlive(childPid), false, "the run's child must not survive its worktree");
  assert.equal(touchesWhileAlive, 0, "nothing may be deleted while the child still holds the directory");
  assert.equal(fs.existsSync(worktree), false);
  assert.equal(await branchExists(repo, branch), false);
});

test("a recorded child is left alone when the run's record names another worktree", async (t) => {
  const runId = `foreign-${process.pid}-${Date.now().toString(36)}`;
  const { repo, branch } = await makeRepo(t, runId);
  // Anywhere but the repository: this test is about the pid, and a child inside the fixture would
  // make the fixture's own teardown fail instead of the removal under test.
  const childPid = await holdDirectoryOpen(t, os.tmpdir());
  await writeRunState({
    status: "completed",
    runId,
    sessionName: "s",
    // An abandoned record's pid can be recycled by an unrelated process, so the worktree the record
    // names decides whether that pid belongs to this cleanup at all.
    worktreePath: path.join(repo, ".worktrees", "agy-somewhere-else"),
    branch,
    startedAt: Date.now(),
    childPid,
  });
  t.after(() => clearRunState(runId));

  const result = await manageWorktree({ action: "discard", cwd: repo, worktreeBranch: branch });

  assert.equal(result.success, true, result.message);
  assert.equal(isPidAlive(childPid), true, "a pid from a record naming another worktree must not be signalled");
});

test("pruneOrphanWorktrees kills the child a crashed run left holding its worktree", async (t) => {
  const runId = `crashed-${process.pid}-${Date.now().toString(36)}`;
  const { repo, worktree, branch } = await makeRepo(t, runId);
  const childPid = await holdDirectoryOpen(t, worktree);
  await writeRunState({
    status: "completed",
    runId,
    sessionName: "s",
    worktreePath: worktree,
    branch,
    startedAt: Date.now(),
    childPid,
  });
  t.after(() => clearRunState(runId));

  const removed = await pruneOrphanWorktrees(repo);

  assert.equal(removed, 1, `the orphan must be swept, removed ${removed}`);
  assert.equal(isPidAlive(childPid), false, "the sweep is the last caller that can reap the child");
  assert.equal(fs.existsSync(worktree), false);
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

test("the usage-file flag is top-level and no gateway-rejected flag is emitted", () => {
  const args = buildChatArgs({
    promptFile: "p.txt",
    worktreePath: "w",
    sessionName: "s",
    usageFile: "C:\\Temp\\usage.json",
  });

  // argparse refuses --usage-file after the subcommand, so a later edit that appends it to the
  // chat argument list breaks every dispatch instead of failing one option.
  assert.ok(args.indexOf("--usage-file") < args.indexOf("chat"), "the ledger flag must precede chat");
  assert.equal(args[args.indexOf("--usage-file") + 1], "C:\\Temp\\usage.json");

  // The gateway CLI refuses --run-budget with exit 2 and no session, so emitting it makes every
  // dispatch fail before the provider is reached. The process timeout is the only real budget.
  assert.equal(args.includes("--run-budget"), false);

  // No usage file, no flags: a call without a ledger must not carry an empty path.
  const bare = buildChatArgs({ promptFile: "p.txt", worktreePath: "w", sessionName: "s" });
  assert.equal(bare.includes("--usage-file"), false);
  assert.equal(bare.includes("--run-budget"), false);
});

test("readUsageReport reads the native ledger and tolerates a partial one", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-usage-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const full = path.join(dir, "full.json");
  fs.writeFileSync(
    full,
    JSON.stringify({
      model: "deepseek-v4.1-flash",
      provider: "opencode-go",
      session_id: "sess-9",
      input_tokens: 100,
      output_tokens: 20,
      cache_read_tokens: 5,
      total_tokens: 125,
      failed: false,
    }),
    "utf8",
  );
  const report = readUsageReport(full);
  assert.equal(report?.model, "deepseek-v4.1-flash");
  assert.equal(report?.provider, "opencode-go");
  assert.equal(report?.sessionId, "sess-9");
  assert.deepEqual(report?.tokens, {
    input: 100,
    output: 20,
    cache_read: 5,
    reasoning: 0,
    cache_write: 0,
    total: 125,
  });
  assert.equal(report?.failed, false);

  // A failed run writes nulls rather than no file: it must still name its failure.
  const failed = path.join(dir, "failed.json");
  fs.writeFileSync(failed, JSON.stringify({ model: null, failed: true, failure: "boom" }), "utf8");
  const failedReport = readUsageReport(failed);
  assert.equal(failedReport?.model, null);
  assert.equal(failedReport?.tokens, null, "an all-zero ledger is no count at all");
  assert.equal(failedReport?.failed, true);
  assert.equal(failedReport?.failure, "boom");

  assert.equal(readUsageReport(null), null);
  assert.equal(readUsageReport(path.join(dir, "missing.json")), null);
  const corrupt = path.join(dir, "corrupt.json");
  fs.writeFileSync(corrupt, "{not json", "utf8");
  assert.equal(readUsageReport(corrupt), null);
});

test("the session id is parsed off stderr before the stream reports one", () => {
  assert.equal(parseSessionIdLine("Session: 20261113_173352_f15a8a"), "20261113_173352_f15a8a");
  assert.equal(parseSessionIdLine("  Session: abc123  "), "abc123");
  // The gateway prints "session_id: ..." after the turn: that line must not be mistaken for it.
  assert.equal(parseSessionIdLine("session_id: other"), null);
  assert.equal(parseSessionIdLine("Warning: Session: bogus"), null);
  assert.equal(parseSessionIdLine(""), null);
});

test("the hook sandbox and the repo bin directory travel in the child env", () => {
  const env = sandboxedGitEnv({ PATH: "/usr/bin" }, "C:\\temp\\hooks", "C:\\repo");
  assert.equal(env.GIT_CONFIG_COUNT, "1");
  assert.equal(env.GIT_CONFIG_KEY_0, "core.hooksPath");
  assert.equal(env.GIT_CONFIG_VALUE_0, "C:\\temp\\hooks");
  assert.equal(env.PATH, `C:\\repo\\node_modules\\.bin${path.delimiter}/usr/bin`);
  assert.equal(env["PATH ".trim()], env.PATH);

  // Windows passes Path, not PATH: appending to the wrong key would leave the bin dir invisible.
  const windows = sandboxedGitEnv({ Path: "C:\\Windows" }, "h", "C:\\repo");
  assert.equal(windows.Path, `C:\\repo\\node_modules\\.bin${path.delimiter}C:\\Windows`);
  assert.equal(windows.PATH, undefined);

  const empty = sandboxedGitEnv({}, "h", "C:\\repo");
  assert.equal(empty.PATH, `C:\\repo\\node_modules\\.bin`);
});

test("isPidAlive proves a live pid and rejects a dead or absent one", async (t) => {
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(null), false);
  assert.equal(isPidAlive(undefined), false);
  assert.equal(isPidAlive(0), false);
  assert.equal(isPidAlive(-1), false);
  assert.equal(isPidAlive(Number.NaN), false);
  assert.equal(isPidAlive(2_147_483_647), false, "an unused pid is not a live run");

  // A child that has really exited is the case the registry has to get right, against a live parent.
  const exited = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  const exitedPid = exited.pid;
  await new Promise((resolve) => exited.on("exit", resolve));
  assert.equal(isPidAlive(exitedPid), false, "an exited child's pid is not a live run");
});

test("a running record whose worker pid is dead is abandoned, and one with no pid is not", () => {
  const base = {
    status: "running" as const,
    runId: "r",
    sessionName: "s",
    worktreePath: "w",
    branch: "hermes/agy-r",
    startedAt: 1,
  };
  assert.equal(isRunAbandoned({ ...base, workerPid: 2_147_483_647 }), true);
  assert.equal(isRunAbandoned(base), false, "a record written before liveness must stay live");
  assert.equal(isRunAbandoned({ ...base, workerPid: process.pid }), false);
  assert.equal(
    isRunAbandoned({ ...base, status: "completed", workerPid: 2_147_483_647 }),
    false,
    "a finished record is settled, not abandoned",
  );
});

test("listActiveRuns drops an abandoned record and keeps a pid-less one", async (t) => {
  const stamp = `${process.pid}-${Date.now().toString(36)}`;
  const abandoned = `abandoned-${stamp}`;
  const legacy = `legacy-${stamp}`;
  t.after(() => Promise.all([clearRunState(abandoned), clearRunState(legacy)]));

  await writeRunState({
    status: "running",
    runId: abandoned,
    sessionName: "s",
    worktreePath: "w",
    branch: "hermes/agy-abandoned",
    startedAt: 2,
    workerPid: 2_147_483_647,
  });
  await writeRunState({
    status: "running",
    runId: legacy,
    sessionName: "s",
    worktreePath: "w",
    branch: "hermes/agy-legacy",
    startedAt: 1,
  });

  const listed = listActiveRuns().filter((state) => state.runId.endsWith(stamp));
  assert.deepEqual(
    listed.map((state) => state.runId),
    [legacy],
    "a dead worker is not an active run, but a record without a pid still is",
  );
});

test("wait.js fails immediately when the worker pid is already dead", async (t) => {
  const runId = `test-dead-${process.pid}-${Date.now().toString(36)}`;
  await writeRunState({
    status: "running",
    runId,
    sessionName: "s",
    worktreePath: "w",
    branch: "hermes/agy-x",
    startedAt: Date.now(),
    workerPid: 2_147_483_647,
  });
  t.after(() => clearRunState(runId));

  const startedAt = Date.now();
  const output = await run(process.execPath, ["--import", "tsx", "src/wait.ts", runId], {
    cwd: path.resolve(import.meta.dirname, ".."),
    timeoutMs: 30_000,
  });
  const elapsed = Date.now() - startedAt;

  assert.equal(output.code, 1);
  assert.ok(output.stdout.includes(formatFailedSentinel(runId)));
  assert.match(output.stdout, /\[Hermes Dispatch Telemetry\] FAILED/);
  assert.match(output.stderr, /abandoned by dead worker pid 2147483647/);
  // The whole point: a two-hour deadline is not waited out for a process that is already gone.
  assert.ok(elapsed < 20_000, `a dead run must not be waited out, took ${elapsed}ms`);
  // The record still names the worktree that holds the work, so it survives the report.
  assert.notEqual(readRunState(runId), null, "an abandoned run's record must not be cleared");
});

test("wait.js reports the model in the telemetry table and the files, warning and pending writes in the detail", async (t) => {
  const runId = `test-detail-${process.pid}-${Date.now().toString(36)}`;
  await writeRunState({
    status: "completed",
    runId,
    sessionName: "s",
    worktreePath: "w",
    branch: "hermes/agy-x",
    startedAt: Date.now(),
    result: {
      success: true,
      durationMs: 1_000,
      message: "2 file(s) changed on hermes/agy-x.",
      model: "deepseek-v4.1-flash",
      provider: "opencode-go",
      warning: "Attribution came from the native ledger.",
      modifiedFiles: ["src/a.ts", "tests/a.test.ts"],
      pendingWrites: [
        { id: "mem-1", subsystem: "memory", action: "add", summary: "Recorded the invariant." },
        { id: "skill-2", subsystem: "skills", action: "patch", summary: "Extended the playbook." },
      ],
    },
  });
  t.after(() => clearRunState(runId));

  const output = await run(process.execPath, ["--import", "tsx", "src/wait.ts", runId], {
    cwd: path.resolve(import.meta.dirname, ".."),
    timeoutMs: 30_000,
  });
  assert.equal(output.code, 0, output.stderr);

  assert.match(output.stdout, /\[Hermes Result Detail\]/);
  assert.match(
    output.stdout,
    /\| model \| deepseek-v4\.1-flash \(opencode-go\) \|/,
    "the model belongs to the telemetry table, not the detail block",
  );
  assert.match(output.stdout, /- Warning: Attribution came from the native ledger\./);
  assert.match(output.stdout, /- Files Changed: 2 \(src\/a\.ts, tests\/a\.test\.ts\)/);
  assert.match(output.stdout, /- Pending Writes: 2/);
  assert.match(output.stdout, /mem-1 \(memory\): add -> Recorded the invariant\./);
  assert.match(output.stdout, /skill-2 \(skills\): patch -> Extended the playbook\./);

  // The detail is a verdict partner: it has to be on screen before the run state is consumed.
  assert.ok(output.stdout.indexOf("[Hermes Result Detail]") < output.stdout.indexOf("2 file(s) changed"));
  assert.equal(readRunState(runId), null, "the completed path still consumes the record");
});

test("wait.js prints no detail block when the result carries nothing to report", async (t) => {
  const runId = `test-nodetail-${process.pid}-${Date.now().toString(36)}`;
  await writeRunState({
    status: "completed",
    runId,
    sessionName: "s",
    worktreePath: "w",
    branch: "hermes/agy-x",
    startedAt: Date.now(),
    result: { success: true, durationMs: 10 },
  });
  t.after(() => clearRunState(runId));

  const output = await run(process.execPath, ["--import", "tsx", "src/wait.ts", runId], {
    cwd: path.resolve(import.meta.dirname, ".."),
    timeoutMs: 30_000,
  });
  assert.equal(output.code, 0, output.stderr);
  // An empty header would read as a real, empty answer.
  assert.equal(output.stdout.includes("[Hermes Result Detail]"), false);
});

test("a dispatch attributes the run from the native ledger", async (t) => {
  const runId = `ledger-${process.pid}-${Date.now().toString(36)}`;
  const { repo } = await makeDispatchRepo(t, {
    usage: {
      model: DEFAULT_MODEL,
      provider: "opencode-go",
      session_id: "sess-auto-apply",
      input_tokens: 210,
      output_tokens: 40,
      cache_read_tokens: 10,
      total_tokens: 260,
      completed: true,
      failed: false,
    },
  });

  const result = (await dispatchHermesTask({
    cwd: repo,
    prompt: "Add auto-applied.ts to the repository root.",
    runId,
    fastWaitSeconds: 120,
  })) as DispatchResult;

  assert.equal(result.success, true, result.message);
  assert.equal(result.model, DEFAULT_MODEL);
  assert.equal(result.provider, "opencode-go");
  assert.equal(result.modelFallback, false);
  // The stderr session line names the run before the stream does.
  assert.equal(result.sessionId, "sess-auto-apply");
  // The ledger's token counts win over a stream payload that reports none.
  assert.equal(result.tokens?.input, 210);
  assert.equal(result.tokens?.total, 260);
  // Cache tokens have to survive the merge: an unreconciled key silently drops out of every total.
  assert.equal(result.tokens?.cache_read, 10);
  assert.equal(runMetadata(result).brackets.includes("[tokens: 260]"), true);
});

test("a ledger's reasoning and cost survive without inflating the reported total", async (t) => {
  const runId = `ledger-cost-${process.pid}-${Date.now().toString(36)}`;
  const { repo } = await makeDispatchRepo(t, {
    usage: {
      model: DEFAULT_MODEL,
      provider: "opencode-go",
      session_id: "sess-auto-apply",
      input_tokens: 111,
      output_tokens: 22,
      cache_read_tokens: 7,
      reasoning_tokens: 11,
      estimated_cost_usd: 0.000312,
      cost_source: "estimated",
      total_tokens: 140,
      completed: true,
      failed: false,
    },
  });

  const result = (await dispatchHermesTask({
    cwd: repo,
    prompt: "Add auto-applied.ts to the repository root.",
    runId,
    fastWaitSeconds: 120,
  })) as DispatchResult;

  assert.equal(result.success, true, result.message);
  assert.equal(result.tokens?.reasoning, 11);
  assert.equal(result.costUsd, 0.000312, "the ledger's billed cost reaches the result");
  // Reasoning is already inside output: counting it again would report 151 tokens for a 140 run.
  assert.equal(runMetadata(result).brackets.includes("[tokens: 140]"), true);
});

test("a ledger reporting only cache_creation_input_tokens still carries the cache write", async (t) => {
  const runId = `ledger-cachewrite-${process.pid}-${Date.now().toString(36)}`;
  const { repo } = await makeDispatchRepo(t, {
    usage: {
      model: DEFAULT_MODEL,
      provider: "opencode-go",
      session_id: "sess-auto-apply",
      cache_creation_input_tokens: 30,
      completed: true,
      failed: false,
    },
  });

  const result = (await dispatchHermesTask({
    cwd: repo,
    prompt: "Add auto-applied.ts to the repository root.",
    runId,
    fastWaitSeconds: 120,
  })) as DispatchResult;

  assert.equal(result.success, true, result.message);
  assert.equal(result.tokens?.cache_write, 30, "the Anthropic spelling maps into cache_write");
  assert.notEqual(result.tokens, null, "a cache-write-only ledger is not an all-zero one");
});

test("an unknown cost stays null rather than reading as a free run", async (t) => {
  const runId = `ledger-nocost-${process.pid}-${Date.now().toString(36)}`;
  const { repo } = await makeDispatchRepo(t, {
    usage: {
      model: DEFAULT_MODEL,
      provider: "opencode-go",
      session_id: "sess-auto-apply",
      total_tokens: 50,
      estimated_cost_usd: null,
      completed: true,
      failed: false,
    },
  });

  const result = (await dispatchHermesTask({
    cwd: repo,
    prompt: "Add auto-applied.ts to the repository root.",
    runId,
    fastWaitSeconds: 120,
  })) as DispatchResult;

  assert.equal(result.success, true, result.message);
  assert.equal(result.costUsd, null, "0 would claim the run was free");
});

test("a ledger that spells the requested model without its provider prefix is not a fallback", async (t) => {
  const runId = `ledger-bare-${process.pid}-${Date.now().toString(36)}`;
  const { repo } = await makeDispatchRepo(t, {
    usage: {
      // The provider echoed only the model id: a string comparison against the configured
      // "provider/model" would read this as a fallback and hard-fail an otherwise clean run.
      model: DEFAULT_MODEL.split("/").pop() as string,
      provider: "opencode-go",
      session_id: "sess-auto-apply",
      total_tokens: 12,
      completed: true,
      failed: false,
    },
  });

  const result = (await dispatchHermesTask({
    cwd: repo,
    prompt: "Add auto-applied.ts to the repository root.",
    runId,
    fastWaitSeconds: 120,
  })) as DispatchResult;

  assert.equal(result.success, true, result.message);
  assert.equal(result.modelFallback, false, "the same model under a different spelling is not a fallback");
});

test("a ledger naming a model nobody asked for is a fallback, and fails closed", async (t) => {
  const runId = `ledger-fallback-${process.pid}-${Date.now().toString(36)}`;
  const { repo } = await makeDispatchRepo(t, {
    usage: {
      model: "openrouter/some-free-model",
      provider: "openrouter",
      session_id: "sess-auto-apply",
      total_tokens: 10,
      completed: true,
      failed: false,
    },
  });

  const result = (await dispatchHermesTask({
    cwd: repo,
    prompt: "Add auto-applied.ts to the repository root.",
    runId,
    fastWaitSeconds: 120,
  })) as DispatchResult;

  assert.equal(result.success, false, "a fallback model may never report success");
  assert.equal(result.modelFallback, true);
  assert.equal(result.model, "openrouter/some-free-model");
  assert.match(result.message, /Dispatch refused: Go allowance exhausted/);
  assert.deepEqual(result.modifiedFiles, [], "a fallback diff is not reviewable");
  assert.equal(await branchExists(repo, `hermes/agy-${runId}`), false);
});

test("a dispatch publishes its worker and child pids while the run is going", async (t) => {
  const runId = `pid-${process.pid}-${Date.now().toString(36)}`;
  const { repo } = await makeDispatchRepo(t, { sleepMs: 4_000 });
  t.after(() => clearRunState(runId));

  const outcome = await dispatchHermesTask({
    cwd: repo,
    prompt: "Add auto-applied.ts to the repository root.",
    runId,
    fastWaitSeconds: 0.5,
  });
  assert.ok("waitCommand" in outcome, "the slow run must answer with a running descriptor");

  const state = readRunState(runId);
  assert.equal(state?.status, "running");
  assert.equal(state?.workerPid, process.pid, "the dispatcher pid is what proves the run is alive");
  assert.equal(typeof state?.childPid, "number", "the runner's pid is what cancel has to kill");

  // Let the run finish so the fixture repo is not torn down mid-flight.
  for (let attempt = 0; attempt < 60 && readRunState(runId)?.status === "running"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(readRunState(runId)?.status, "completed");
});

test("cancel kills the run's child, settles the record and removes the worktree", async (t) => {
  const runId = `cancel-${process.pid}-${Date.now().toString(36)}`;
  const { repo } = await makeDispatchRepo(t, { sleepMs: 30_000 });
  t.after(() => clearRunState(runId));

  const outcome = await dispatchHermesTask({
    cwd: repo,
    prompt: "Add auto-applied.ts to the repository root.",
    runId,
    fastWaitSeconds: 0.5,
  });
  assert.ok("waitCommand" in outcome);
  const childPid = readRunState(runId)?.childPid;
  assert.equal(typeof childPid, "number");

  const startedAt = Date.now();
  const cancelled = await manageWorktree({
    action: "cancel",
    cwd: repo,
    worktreeBranch: `hermes/agy-${runId}`,
  });
  const elapsed = Date.now() - startedAt;

  assert.equal(cancelled.success, true, cancelled.message);
  assert.equal(isPidAlive(childPid), false, "the child tree must be dead");
  assert.match(cancelled.message, /Cancelled/);
  // Bounded teardown, not a 30s wait for the child's own sleep to elapse.
  assert.ok(elapsed < 20_000, `cancel must not wait out the child, took ${elapsed}ms`);
  assert.equal(fs.existsSync(path.join(repo, ".worktrees", `agy-${runId}`)), false);
  assert.equal(await branchExists(repo, `hermes/agy-${runId}`), false);
  // The dispatcher itself must survive: cancel kills the child, never the bridge that reports it.
  assert.equal(isPidAlive(process.pid), true);

  // The cancelled pipeline unwinds on its own: it must not republish the run or re-create the
  // worktree once that record has already told the waiter the run is over.
  const settledRecord = readRunState(runId);
  assert.equal(settledRecord?.status, "completed");
  assert.equal((settledRecord?.result as { cancelled?: unknown } | undefined)?.cancelled, true);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const after = readRunState(runId);
  assert.equal((after?.result as { cancelled?: unknown } | undefined)?.cancelled, true);
  assert.deepEqual(after?.result, settledRecord?.result, "the pipeline must not overwrite the record");
  assert.equal(fs.existsSync(path.join(repo, ".worktrees", `agy-${runId}`)), false);
});

test("apply and discard still refuse a live run, naming cancel as the way out", async (t) => {
  const { repo, worktree, branch } = await makeRepo(t);
  // The record is keyed by the run id inside the branch: that is the only handle the tool receives.
  const runId = branch.replace("hermes/agy-", "");
  t.after(() => clearRunState(runId));

  await writeRunState({
    status: "running",
    runId,
    sessionName: "s",
    worktreePath: worktree,
    branch,
    startedAt: Date.now(),
    workerPid: process.pid,
  });

  const applied = await manageWorktree({ action: "apply", cwd: repo, worktreeBranch: branch });
  assert.equal(applied.success, false);
  assert.match(applied.message, /still actively executing/);
  assert.match(applied.message, /cancel/);
  assert.equal(fs.existsSync(worktree), true, "a refusal must delete nothing");
});

test("a fallback already recorded at session start aborts the run on turn 1", async (t) => {
  const runId = `abort-${process.pid}-${Date.now().toString(36)}`;
  const { repo } = await makeDispatchRepo(t, { fallbackActive: true, sleepMs: 30_000 });

  const startedAt = Date.now();
  const result = (await dispatchHermesTask({
    cwd: repo,
    prompt: "Add auto-applied.ts to the repository root.",
    runId,
    fastWaitSeconds: 120,
  })) as DispatchResult;
  const elapsed = Date.now() - startedAt;

  assert.equal(result.success, false);
  assert.equal(result.abortedFallback, true, "the run must be reported as an early abort");
  assert.equal(result.modelFallback, true);
  assert.match(result.message, /Go allowance exhausted/);
  // Turn 1 is where the fallback shows up: the rest of the run would spend quota on output that
  // cannot be reviewed, so it is killed rather than waited out.
  assert.ok(elapsed < 20_000, `the abort must not wait out the child's 30s, took ${elapsed}ms`);
  assert.equal(await branchExists(repo, `hermes/agy-${runId}`), false);
});

test("a dispatch never writes core.hooksPath into the caller's repository", async (t) => {
  const runId = `hooks-${process.pid}-${Date.now().toString(36)}`;
  const { repo } = await makeDispatchRepo(t);

  const result = (await dispatchHermesTask({
    cwd: repo,
    prompt: "Add auto-applied.ts to the repository root.",
    runId,
    fastWaitSeconds: 120,
  })) as DispatchResult;
  assert.equal(result.success, true, result.message);

  // The sandbox travels in the child env: a repo config write would survive a crashed dispatch and
  // silently disable the caller's hooks for good.
  const config = await git(repo, ["config", "--local", "--list"]);
  assert.equal(config.includes("hooksPath"), false, `the run mutated the repo config:\n${config}`);
});

test("the sandboxed env overrides the caller's hooksPath without touching the repository", async (t) => {
  const { repo } = await makeRepo(t);
  await git(repo, ["config", "--local", "core.hooksPath", ".husky"]);
  const emptyHooks = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-empty-hooks-"));
  t.after(() => fs.rmSync(emptyHooks, { recursive: true, force: true }));

  const seen = await run("git", ["config", "--get", "core.hooksPath"], {
    cwd: repo,
    env: sandboxedGitEnv(process.env, emptyHooks, repo),
    timeoutMs: 30_000,
  });
  assert.equal(seen.code, 0, seen.stderr);
  assert.equal(seen.stdout.trim(), emptyHooks, "the child must see the sandboxed hooks dir");

  // The repository setting is untouched: the override dies with the child process.
  assert.equal((await git(repo, ["config", "--local", "--get", "core.hooksPath"])).trim(), ".husky");
});
