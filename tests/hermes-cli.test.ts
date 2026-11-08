import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/exec.js";
import {
  DEFAULT_MODEL,
  DEFAULT_REASONING,
  buildChatArgs,
  dispatchHermesTask,
  parseGatewayRuntime,
  listHermesSessions,
  manageWorktree,
} from "../src/hermes-cli.js";

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
  return { repo, worktree, branch };
};

test("apply lands the worktree diff on the checkout and leaves no worktree behind", async (t) => {
  const { repo, worktree, branch } = await makeRepo(t);
  fs.writeFileSync(path.join(worktree, "feature.ts"), "export const feature = () => 42;\n", "utf8");
  fs.writeFileSync(path.join(repo, "README.md"), "# fixture\n\nlocal note\n", "utf8");

  const result = await manageWorktree({ action: "apply", cwd: repo, worktreeBranch: branch });
  assert.equal(result.success, true, result.message);

  assert.equal(fs.existsSync(path.join(repo, "feature.ts")), true, "the new file should be applied");
  assert.equal(fs.existsSync(worktree), false, "the worktree directory should be gone");
  assert.equal(fs.readFileSync(path.join(repo, "README.md"), "utf8"), "# fixture\n\nlocal note\n");

  const branches = await git(repo, ["branch", "--list", branch]);
  assert.equal(branches.trim(), "");

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
  assert.equal((await git(repo, ["branch", "--list", branch])).trim(), "");
});

test("apply on an unknown branch reports instead of guessing", async (t) => {
  const { repo } = await makeRepo(t);
  const result = await manageWorktree({ action: "apply", cwd: repo, worktreeBranch: "hermes/agy-missing" });
  assert.equal(result.success, false);
  assert.match(result.message, /No worktree for branch/);
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

test("listHermesSessions reads the session store", () => {
  const sessions = listHermesSessions({ limit: 5 });
  for (const session of sessions) {
    assert.equal(typeof session.id, "string");
    assert.equal(typeof session.started_at, "number");
  }
  const scoped = listHermesSessions({ cwd: "D:\\Code\\OtterBoops\\hermes-worker", limit: 5 });
  for (const session of scoped) {
    assert.ok(
      (session.cwd ?? "").toLowerCase().startsWith("d:\\code\\otterboops\\hermes-worker"),
      `unexpected cwd ${session.cwd}`,
    );
  }
});
