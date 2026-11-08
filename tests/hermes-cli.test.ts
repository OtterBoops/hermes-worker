import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { run } from "../src/exec.js";
import {
  DEFAULT_MODEL,
  DEFAULT_REASONING,
  buildChatArgs,
  dispatchHermesTask,
  parseGatewayRuntime,
  raceFastWait,
  readSessionAfterRun,
  listHermesSessions,
  manageWorktree,
} from "../src/hermes-cli.js";
import { RUN_STATE_DIR, readRunState, runStatePath, writeRunState } from "../src/run-registry.js";

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

test("wait.js polls the run registry and reports the completed result", async (t) => {
  const runId = `test-${process.pid}-${Date.now().toString(36)}`;
  const statePath = runStatePath(runId);
  const result = { success: true, runId, message: "done" };
  fs.mkdirSync(RUN_STATE_DIR, { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({ status: "running", runId, result: undefined }), "utf8");
  t.after(() => fs.rmSync(statePath, { force: true }));

  const child = run(
    process.execPath,
    ["--import", "tsx", "src/wait.ts", runId],
    { cwd: path.resolve(import.meta.dirname, ".."), timeoutMs: 20_000 },
  );

  // Give the poller one tick, then publish the completion the way a dispatch would.
  await new Promise((resolve) => setTimeout(resolve, 400));
  await writeRunState({
    status: "completed",
    runId,
    sessionName: "s",
    worktreePath: "w",
    branch: "hermes/agy-x",
    startedAt: Date.now(),
    result,
  });

  const output = await child;
  assert.equal(output.code, 0, output.stderr);
  assert.deepEqual(JSON.parse(output.stdout), result);
  assert.equal(readRunState(runId), null, "the callback consumes the state file");
});

test("wait.js exits 1 when the run failed", async (t) => {
  const runId = `test-fail-${process.pid}-${Date.now().toString(36)}`;
  await writeRunState({
    status: "completed",
    runId,
    sessionName: "s",
    worktreePath: "w",
    branch: "hermes/agy-x",
    startedAt: Date.now(),
    result: { success: false, message: "boom" },
  });
  t.after(() => fs.rmSync(runStatePath(runId), { force: true }));

  const output = await run(process.execPath, ["--import", "tsx", "src/wait.ts", runId], {
    cwd: path.resolve(import.meta.dirname, ".."),
    timeoutMs: 20_000,
  });
  assert.equal(output.code, 1);
  assert.equal(JSON.parse(output.stdout).success, false);
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
