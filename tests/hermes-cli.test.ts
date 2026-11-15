import test, { mock, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { isWindows, run } from "../src/exec.js";
import {
  BASELINE_COMMIT_SUBJECT,
  DEFAULT_FAST_WAIT_SECONDS,
  DEFAULT_MAX_COMPACTS,
  DEFAULT_MODEL,
  DEFAULT_REASONING,
  buildChatArgs,
  captureWorkingTreeSnapshot,
  diffTreeSnapshots,
  dispatchHermesTask,
  listHermesSessions,
  manageWorktree,
  parseGatewayRuntime,
  parseSessionIdLine,
  priorSessionHandoffPrompt,
  pruneOrphanWorktrees,
  raceFastWait,
  readSessionAfterRun,
  readUsageReport,
  restoreWorkingTreeSnapshot,
  runMetadata,
  runVerifyCommand,
  sandboxedGitEnv,
  verificationRetryPrompt,
  workspaceDeltaPrompt,
} from "../src/hermes-cli.js";
import type { DispatchOptions, DispatchResult } from "../src/hermes-cli.js";
import {
  HERMES_DISPATCH_FAILED_PREFIX,
  HERMES_DISPATCH_SENTINEL_PREFIX,
  RUN_STATE_DIR,
  clearConversationSession,
  clearRunState,
  formatDispatchSentinel,
  formatFailedSentinel,
  isPidAlive,
  isRunAbandoned,
  listActiveRuns,
  pruneStaleRuns,
  readConversationSession,
  readRunState,
  runLogPath,
  runStatePath,
  writeConversationSession,
  writeRunState,
} from "../src/run-registry.js";
import { formatStreamLine, openRunLog } from "../src/run-log.js";
import { makeBridgeHome } from "./bridge-home.js";

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

const headTreeSha = async (repo: string): Promise<string> =>
  (await git(repo, ["rev-parse", "HEAD^{tree}"])).trim();

/** The commit a checkout is on: no dispatch may move it. */
const headSha = async (repo: string): Promise<string> => (await git(repo, ["rev-parse", "HEAD"])).trim();

/** A throwaway repository with one commit — the checkout a dispatch now executes in. */
const makeRepo = async (t: TestContext): Promise<{ repo: string }> => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-worker-repo-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));

  await git(repo, ["init", "-b", "main"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# fixture\n", "utf8");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "initial"]);
  return { repo };
};

/**
 * A repository plus the `.worktrees/agy-*` checkout an older worker created. Nothing in the current
 * dispatch path makes one of these, so this fixture exists only for the legacy `manageWorktree`
 * compatibility surface and the orphan sweep.
 */
const makeLegacyRepo = async (
  t: TestContext,
  runId = "test",
): Promise<{ repo: string; worktree: string; branch: string }> => {
  const { repo } = await makeRepo(t);
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

// ---------------------------------------------------------------------------------------------
// Tree snapshots: the review boundary that replaced the worktree
// ---------------------------------------------------------------------------------------------

test("a working-tree snapshot carries staged, unstaged, untracked and deleted paths", async (t) => {
  const { repo } = await makeRepo(t);
  fs.writeFileSync(path.join(repo, "gone.ts"), "export const gone = 1;\n", "utf8");
  await git(repo, ["add", "gone.ts"]);
  await git(repo, ["commit", "-m", "track a file to delete"]);
  const head = await headSha(repo);

  // Every shape of uncommitted work at once: an unstaged edit, a staged addition, an untracked
  // file, a tracked deletion and a binary — exactly what the caller's dirty checkout holds.
  fs.writeFileSync(path.join(repo, "README.md"), "# fixture\n\nedited-in-progress\n", "utf8");
  fs.writeFileSync(path.join(repo, "staged.ts"), "export const staged = 1;\n", "utf8");
  await git(repo, ["add", "staged.ts"]);
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "new.ts"), "export const NewOne = () => null;\n", "utf8");
  fs.rmSync(path.join(repo, "gone.ts"));
  fs.writeFileSync(path.join(repo, "asset.bin"), Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x42]));

  const indexPath = path.join(repo, ".git", "index");
  const indexBefore = fs.readFileSync(indexPath);
  const statusBefore = await git(repo, ["status", "--porcelain"]);
  const snapshot = await captureWorkingTreeSnapshot(repo);

  // The throwaway GIT_INDEX_FILE is the whole trick: the caller's index is neither read nor written.
  assert.equal(
    fs.readFileSync(indexPath).equals(indexBefore),
    true,
    "the snapshot must not touch the caller's .git/index",
  );
  assert.equal(await git(repo, ["status", "--porcelain"]), statusBefore, "the checkout is left as it was");
  assert.equal(await headSha(repo), head, "a snapshot commits nothing");

  const entries = (await git(repo, ["ls-tree", "-r", "--name-only", snapshot.treeSha]))
    .trim()
    .split("\n")
    .filter(Boolean);
  assert.deepEqual(
    entries.sort(),
    ["README.md", "asset.bin", "src/new.ts", "staged.ts"],
    `the snapshot must carry the whole working tree; got ${JSON.stringify(entries)}`,
  );
  assert.deepEqual(snapshot.skipped, [], "nothing here is blocked");

  // The tree really is the worktree's bytes, not HEAD's: that is what makes the diff the run's work.
  assert.equal(
    await git(repo, ["show", `${snapshot.treeSha}:README.md`]),
    "# fixture\n\nedited-in-progress\n",
  );
});

test("a clean checkout snapshots to the committed tree", async (t) => {
  const { repo } = await makeRepo(t);
  const snapshot = await captureWorkingTreeSnapshot(repo);
  assert.equal(snapshot.treeSha, await headTreeSha(repo), "a clean tree must snapshot to HEAD's tree");
  assert.deepEqual(snapshot.skipped, []);
});

test("a snapshot is the working tree, so an edit that lives only in the index is not carried", async (t) => {
  const { repo } = await makeRepo(t);

  // The index is not the review boundary: `git add -A` re-stages from the working tree, so a blob
  // that exists only as a staged entry would vanish from the tree the run is diffed against. The
  // working file is what the run will actually see, and that is what the snapshot records.
  fs.writeFileSync(path.join(repo, "README.md"), "# fixture\n\nstaged only\n", "utf8");
  await git(repo, ["add", "README.md"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# fixture\n", "utf8");

  const snapshot = await captureWorkingTreeSnapshot(repo);
  assert.equal(snapshot.treeSha, await headTreeSha(repo), "the working file matches HEAD, so the tree does");
  assert.equal(await git(repo, ["show", `${snapshot.treeSha}:README.md`]), "# fixture\n");

  // The staged blob is untouched: the snapshot works through a throwaway index file.
  assert.match(await git(repo, ["diff", "--cached", "--name-only"]), /README\.md/);
  assert.equal(await git(repo, ["show", ":README.md"]), "# fixture\n\nstaged only\n");
});

test("the snapshot refuses blocked paths but leaves them on disk", async (t) => {
  const { repo } = await makeRepo(t);
  fs.writeFileSync(path.join(repo, ".env"), "SECRET=nope\n", "utf8");
  fs.writeFileSync(path.join(repo, ".env.example"), "SECRET=\n", "utf8");
  fs.mkdirSync(path.join(repo, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(repo, "node_modules", "pkg", "index.js"), "module.exports = 1;\n", "utf8");
  fs.writeFileSync(path.join(repo, "keep.ts"), "export const keep = 1;\n", "utf8");

  const snapshot = await captureWorkingTreeSnapshot(repo);
  assert.ok(snapshot.skipped.includes(".env"), `a .env must never enter the tree: ${snapshot.skipped}`);
  assert.equal(snapshot.skipped.includes(".env.example"), false, "the template is reviewable");

  const entries = (await git(repo, ["ls-tree", "-r", "--name-only", snapshot.treeSha]))
    .trim()
    .split("\n")
    .filter(Boolean);
  assert.equal(entries.includes(".env"), false, "the secret is not in the tree that travels back");
  assert.equal(
    entries.some((entry) => entry.startsWith("node_modules/")),
    false,
    "regenerable bulk is skipped",
  );
  assert.deepEqual(entries.sort(), [".env.example", "README.md", "keep.ts"]);

  // Refused from the tree, never from the disk: the run still sees the file it may need to read.
  assert.equal(fs.existsSync(path.join(repo, ".env")), true, "skipping is not deleting");
});

test("a file under a blocked directory is skipped as a path, not just by name", async (t) => {
  const { repo } = await makeRepo(t);
  fs.mkdirSync(path.join(repo, ".env"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".env", "local"), "SECRET=do-not-carry\n", "utf8");
  fs.writeFileSync(path.join(repo, "keep.ts"), "export const keep = 1;\n", "utf8");

  const snapshot = await captureWorkingTreeSnapshot(repo);
  assert.ok(
    snapshot.skipped.includes(".env/local"),
    `a blocked directory is skipped whole: ${JSON.stringify(snapshot.skipped)}`,
  );
  const entries = (await git(repo, ["ls-tree", "-r", "--name-only", snapshot.treeSha]))
    .trim()
    .split("\n")
    .filter(Boolean);
  assert.equal(entries.some((entry) => entry.startsWith(".env/")), false);
  assert.equal(entries.includes("keep.ts"), true);
});

test("a tracked secret edited by the caller never enters the snapshot", async (t) => {
  const { repo } = await makeRepo(t);

  // `.env` is tracked here, so it is a tracked modification rather than an untracked file.
  fs.writeFileSync(path.join(repo, ".env"), "SECRET=placeholder\n", "utf8");
  await git(repo, ["add", ".env"]);
  await git(repo, ["commit", "-m", "track a placeholder env"]);

  fs.writeFileSync(path.join(repo, ".env"), "SECRET=real-production-token\n", "utf8");
  fs.writeFileSync(path.join(repo, "app.ts"), "export const app = 1;\n", "utf8");

  const snapshot = await captureWorkingTreeSnapshot(repo);
  assert.ok(snapshot.skipped.includes(".env"), "a tracked .env edit must be skipped, not carried");
  const entries = (await git(repo, ["ls-tree", "-r", "--name-only", snapshot.treeSha]))
    .trim()
    .split("\n")
    .filter(Boolean);
  assert.equal(entries.includes(".env"), false, "the secret must not be readable from the tree");
  assert.equal(entries.includes("app.ts"), true, "other edits still travel");
});

test("restoring a snapshot is scoped to the run's own paths", async (t) => {
  const { repo } = await makeRepo(t);
  fs.writeFileSync(path.join(repo, "tracked.ts"), "export const tracked = 1;\n", "utf8");
  fs.writeFileSync(path.join(repo, "untouched.ts"), "export const untouched = 1;\n", "utf8");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "track two files"]);

  // An uncommitted caller edit: it belongs to the user, so it must survive a rollback.
  fs.writeFileSync(path.join(repo, "README.md"), "# fixture\n\ncaller note\n", "utf8");
  const baseline = await captureWorkingTreeSnapshot(repo);

  // What a run does to the checkout: add files, modify tracked.ts, and then the user edits a file
  // the run never touched while the run is still going.
  fs.writeFileSync(path.join(repo, "added.ts"), "export const added = 1;\n", "utf8");
  fs.mkdirSync(path.join(repo, "newdir", "deep"), { recursive: true });
  fs.writeFileSync(path.join(repo, "newdir", "deep", "file.ts"), "export const deep = 1;\n", "utf8");
  fs.writeFileSync(path.join(repo, "tracked.ts"), "export const tracked = 2;\n", "utf8");
  const after = await captureWorkingTreeSnapshot(repo);

  const diff = await diffTreeSnapshots(repo, baseline.treeSha, after.treeSha);
  assert.match(diff, /^diff --git a\/added\.ts b\/added\.ts$/m);
  assert.match(diff, /^\+export const tracked = 2;$/m);

  const restored = await restoreWorkingTreeSnapshot(repo, baseline.treeSha, after.treeSha);
  // git reports tree paths with `/` on every platform, whatever the checkout's separator is.
  assert.deepEqual(restored.deleted.sort(), ["added.ts", "newdir/deep/file.ts"]);
  assert.deepEqual(restored.restored.sort(), ["tracked.ts"]);
  assert.equal(fs.existsSync(path.join(repo, "added.ts")), false, "a file the run added is deleted");
  assert.equal(fs.existsSync(path.join(repo, "newdir")), false, "the directory it created goes with it");
  assert.equal(fs.readFileSync(path.join(repo, "tracked.ts"), "utf8"), "export const tracked = 1;\n");
  assert.equal(
    fs.readFileSync(path.join(repo, "README.md"), "utf8"),
    "# fixture\n\ncaller note\n",
    "an edit the run never made is not the rollback's business",
  );
  assert.equal(
    fs.readFileSync(path.join(repo, "untouched.ts"), "utf8"),
    "export const untouched = 1;\n",
  );
});

test("restoring a snapshot brings back a file the run deleted", async (t) => {
  const { repo } = await makeRepo(t);
  fs.writeFileSync(path.join(repo, "doomed.ts"), "export const doomed = 1;\n", "utf8");
  await git(repo, ["add", "doomed.ts"]);
  await git(repo, ["commit", "-m", "track doomed"]);

  const baseline = await captureWorkingTreeSnapshot(repo);
  fs.rmSync(path.join(repo, "doomed.ts"));
  const after = await captureWorkingTreeSnapshot(repo);

  const restored = await restoreWorkingTreeSnapshot(repo, baseline.treeSha, after.treeSha);
  assert.deepEqual(restored.restored, ["doomed.ts"]);
  assert.equal(fs.readFileSync(path.join(repo, "doomed.ts"), "utf8"), "export const doomed = 1;\n");
});

test("an identical pair of trees diffs and restores to nothing", async (t) => {
  const { repo } = await makeRepo(t);
  const baseline = await captureWorkingTreeSnapshot(repo);
  assert.equal(await diffTreeSnapshots(repo, baseline.treeSha, baseline.treeSha), "");
  assert.deepEqual(await restoreWorkingTreeSnapshot(repo, baseline.treeSha, baseline.treeSha), {
    restored: [],
    deleted: [],
  });
  assert.equal(await diffTreeSnapshots(repo, "", baseline.treeSha), "", "a missing tree is no diff");
});

test("a binary change round-trips through the tree diff byte for byte", async (t) => {
  const { repo } = await makeRepo(t);
  const baseline = await captureWorkingTreeSnapshot(repo);
  // NUL, latin-1 high bytes and CRLF: none of it survives a text patch.
  const bytes = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0xe9, 0x0d, 0x0a, 0x7f, 0x00, 0x42]);
  fs.writeFileSync(path.join(repo, "asset.bin"), bytes);
  const after = await captureWorkingTreeSnapshot(repo);

  const patch = await diffTreeSnapshots(repo, baseline.treeSha, after.treeSha);
  assert.match(patch, /^GIT binary patch$/m, "--binary must carry the exact bytes");
  assert.match(patch, /^diff --git a\/asset\.bin b\/asset\.bin$/m);

  // The patch is the review artifact, so it has to be applyable: revert the file, then re-apply.
  const patchFile = path.join(os.tmpdir(), `diff-${process.pid}-${Date.now().toString(36)}.patch`);
  fs.writeFileSync(patchFile, patch, "utf8");
  t.after(() => fs.rmSync(patchFile, { force: true }));
  await restoreWorkingTreeSnapshot(repo, baseline.treeSha, after.treeSha);
  assert.equal(fs.existsSync(path.join(repo, "asset.bin")), false, "the revert removes the binary file");

  await git(repo, ["apply", "--binary", patchFile]);
  assert.deepEqual([...fs.readFileSync(path.join(repo, "asset.bin"))], [...bytes]);
});

// ---------------------------------------------------------------------------------------------
// The Hermes stand-in
// ---------------------------------------------------------------------------------------------

interface StubPayload {
  /** Written by the first invocation; the marker is what makes the next one differ. */
  first: { file: string; content: string };
  later: { file: string; content: string };
  marker: string;
}

interface StubOptions {
  sessionId: string;
  /** The native usage ledger. `undefined` writes one naming DEFAULT_MODEL; `null` writes none. */
  writeUsage?: Record<string, unknown> | null;
  sleepMs?: number;
  emitToolCalls?: boolean;
  /** Leaves a detached grandchild holding the inherited stream pipes, which keeps 'close' away. */
  leakStdoutMs?: number;
  /** Rewrites a hook before restoring its mtime: only the content changes. */
  mutateHook?: boolean;
  /** Writes `auto-applied.ts` into the checkout, as a real run would. Default true. */
  writeAutoApplied?: boolean;
  /** Exits non-zero after emitting its result, the way a crashed turn does. */
  exitCode?: number;
  payload?: StubPayload;
  /** Appends `{ argv, prompt }` per invocation. The prompt file is deleted when the turn ends. */
  argvLog?: string;
}

/**
 * Stands in for the `hermes` binary. A `.mjs` HERMES_BIN is spawned through the running node, which
 * is what lets the fixture see the real argv: the top-level --usage-file has to be readable here or
 * a regression that puts it after `chat` would pass silently.
 */
const chatStub = (options: StubOptions): string =>
  [
    'import fs from "node:fs";',
    'import os from "node:os";',
    'import path from "node:path";',
    'import { spawn } from "node:child_process";',
    `const SESSION_ID = ${JSON.stringify(options.sessionId)};`,
    `const WRITE_USAGE = ${JSON.stringify(options.writeUsage ?? null)};`,
    `const SLEEP_MS = ${options.sleepMs ?? 0};`,
    `const EMIT_TOOL_CALLS = ${options.emitToolCalls === true};`,
    `const LEAK_MS = ${options.leakStdoutMs ?? 0};`,
    `const MUTATE_HOOK = ${options.mutateHook === true};`,
    `const WRITE_AUTO = ${options.writeAutoApplied !== false};`,
    `const EXIT_CODE = ${options.exitCode ?? 0};`,
    `const PAYLOAD = ${JSON.stringify(options.payload ?? null)};`,
    `const ARGV_LOG = ${JSON.stringify(options.argvLog ?? null)};`,
    "const argv = process.argv.slice(2);",
    'const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };',
    '// The ledger flag is top-level: argparse rejects it anywhere after the subcommand.',
    'if (argv.indexOf("--usage-file") > argv.indexOf("chat")) {',
    '  process.stderr.write("argparse: --usage-file belongs before the subcommand\\n");',
    "  process.exit(9);",
    "}",
    'const usageFile = flag("--usage-file");',
    'const queryFile = flag("--query-file");',
    "// Read before anything else: the dispatch deletes the prompt file when the turn ends.",
    "if (ARGV_LOG) {",
    "  let prompt = null;",
    '  try { prompt = queryFile ? fs.readFileSync(queryFile, "utf8") : null; } catch {}',
    '  fs.appendFileSync(ARGV_LOG, JSON.stringify({ argv, prompt }) + "\\n");',
    "}",
    "// A gated payload is what makes a second invocation observably different from the first.",
    "if (PAYLOAD) {",
    "  const first = !fs.existsSync(PAYLOAD.marker);",
    "  const write = first ? PAYLOAD.first : PAYLOAD.later;",
    "  fs.writeFileSync(path.join(process.cwd(), write.file), write.content);",
    '  if (first) fs.writeFileSync(PAYLOAD.marker, "1");',
    "} else if (WRITE_AUTO) {",
    '  fs.writeFileSync(path.join(process.cwd(), "auto-applied.ts"), "export const autoApplied = true;\\n");',
    "}",
    'process.stderr.write("Session: " + SESSION_ID + "\\n");',
    "// A detached grandchild inherits the pipe handles: 'close' on this child can never fire.",
    "if (LEAK_MS > 0) {",
    '  const leaked = spawn(process.execPath, ["-e", "setTimeout(() => {}, " + LEAK_MS + ")"], {',
    '    stdio: "inherit", detached: true, windowsHide: true, cwd: os.tmpdir(),',
    "  });",
    "  leaked.unref();",
    "  if (process.env.HCLI_LEAK_PID_FILE) {",
    "    fs.writeFileSync(process.env.HCLI_LEAK_PID_FILE, String(leaked.pid));",
    "  }",
    "}",
    "// Same mtime, different bytes: only a content hash can see this rewrite.",
    "if (MUTATE_HOOK && process.env.HCLI_HOOK_FILE) {",
    "  const hookFile = process.env.HCLI_HOOK_FILE;",
    "  const before = fs.statSync(hookFile);",
    '  fs.writeFileSync(hookFile, "#!/bin/sh\\\\necho pwned\\\\n");',
    "  fs.utimesSync(hookFile, before.atime, before.mtime);",
    "}",
    // A hook that did not exist before the run: the revert has to delete it, not restore it.
    "if (MUTATE_HOOK && process.env.HCLI_HOOK_ADD_FILE) {",
    '  fs.writeFileSync(process.env.HCLI_HOOK_ADD_FILE, "#!/bin/sh\\\\necho added\\\\n");',
    "}",
    "if (SLEEP_MS > 0) await new Promise((resolve) => setTimeout(resolve, SLEEP_MS));",
    "if (usageFile && WRITE_USAGE) {",
    '  fs.writeFileSync(usageFile, JSON.stringify(WRITE_USAGE) + "\\n");',
    "}",
    "// A read call and its payload: the event pair a leaky collector would copy into the result.",
    "if (EMIT_TOOL_CALLS) {",
    '  process.stdout.write(JSON.stringify({ type: "tool_use", id: "call-1", name: "read_file",',
    '    input: { file_path: "src/secret-layout.ts" } }) + "\\n");',
    '  process.stdout.write(JSON.stringify({ type: "tool_result", tool_use_id: "call-1",',
    '    content: [{ type: "text", text: "x".repeat(900) }] }) + "\\n");',
    "}",
    "process.stdout.write(JSON.stringify({",
    '  type: "result",',
    '  result: "wrote the requested file",',
    "  session_id: SESSION_ID,",
    "  exit_code: EXIT_CODE,",
    '}) + "\\n");',
    "// A crashed turn still writes its ledger and its stream: the exit code is the verdict.",
    "if (EXIT_CODE !== 0) process.exit(EXIT_CODE);",
  ].join("\n");

interface StubCall {
  argv: string[];
  prompt: string | null;
}

const readStubCalls = (callsPath: string): StubCall[] => {
  if (!fs.existsSync(callsPath)) return [];
  return fs
    .readFileSync(callsPath, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as StubCall);
};

const flagOf = (argv: string[], name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};

/**
 * A fixture repository plus a bare HERMES_HOME holding the chat stub. Attribution comes from the
 * native usage ledger the stub writes, never from a `state.db`: `readSessionAfterRun` reads through
 * Hermes' own Python, and a bare temp home has no interpreter — exactly as production degrades.
 */
const makeDispatchRepo = async (
  t: TestContext,
  options: {
    sessionId?: string;
    usage?: Record<string, unknown> | null;
    sleepMs?: number;
    emitToolCalls?: boolean;
    leakStdoutMs?: number;
    mutateHook?: boolean;
    writeAutoApplied?: boolean;
    exitCode?: number;
    payload?: StubPayload;
  } = {},
): Promise<{ repo: string; home: string; sessionId: string; callsPath: string }> => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-worker-dispatch-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-worker-dispatch-home-"));
  const callsPath = path.join(home, "calls.jsonl");
  const previousHome = process.env.HERMES_HOME;
  const previousBin = process.env.HERMES_BIN;
  const previousPython = process.env.HERMES_PYTHON;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = previousHome;
    if (previousBin === undefined) delete process.env.HERMES_BIN;
    else process.env.HERMES_BIN = previousBin;
    if (previousPython === undefined) delete process.env.HERMES_PYTHON;
    else process.env.HERMES_PYTHON = previousPython;
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  const sessionId = options.sessionId ?? "sess-auto-apply";
  const ledger =
    options.usage === undefined
      ? { session_id: sessionId, model: DEFAULT_MODEL, provider: "opencode-go", completed: true, failed: false }
      : options.usage;
  const bin = path.join(home, "hermes-bin.mjs");
  fs.writeFileSync(
    bin,
    chatStub({
      sessionId,
      writeUsage: ledger,
      sleepMs: options.sleepMs,
      emitToolCalls: options.emitToolCalls,
      leakStdoutMs: options.leakStdoutMs,
      mutateHook: options.mutateHook,
      writeAutoApplied: options.writeAutoApplied,
      exitCode: options.exitCode,
      payload: options.payload,
      argvLog: callsPath,
    }),
    "utf8",
  );

  await git(repo, ["init", "-b", "main"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# fixture\n", "utf8");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "initial"]);

  process.env.HERMES_HOME = home;
  process.env.HERMES_BIN = bin;
  // A leaked interpreter from an earlier fixture would make every attribution probe spawn Python.
  delete process.env.HERMES_PYTHON;
  return { repo, home, sessionId, callsPath };
};

/**
 * Rewrites the fixture's stub so a payload can name a marker inside its own HERMES_HOME. The
 * template is baked in at write time, so this is the only way to give the payload a stable path.
 */
const rearmStub = (options: StubOptions): void => {
  const bin = process.env.HERMES_BIN;
  if (!bin) throw new Error("rearmStub needs a dispatch fixture");
  fs.writeFileSync(bin, chatStub(options), "utf8");
};

// ---------------------------------------------------------------------------------------------
// Dispatching into the checkout
// ---------------------------------------------------------------------------------------------

test("a dispatch edits the checkout itself and reports its tree boundary", async (t) => {
  const runId = `checkout-${process.pid}-${Date.now().toString(36)}`;
  const { repo, callsPath } = await makeDispatchRepo(t);
  const baselineExpected = await captureWorkingTreeSnapshot(repo);
  const head = await headSha(repo);

  const result = (await dispatchHermesTask({
    cwd: repo,
    prompt: "Add auto-applied.ts to the repository root.",
    runId,
    fastWaitSeconds: 120,
  })) as DispatchResult;

  assert.equal(result.success, true, result.message);
  assert.equal(result.runHandle, `agy-${runId}`);
  assert.equal(result.repoRoot, path.resolve(repo), "the answer names the checkout");
  assert.equal(result.sessionName.startsWith("[AGY] "), true);
  // The run's work is in the checkout: there is nothing to apply and no branch to keep.
  assert.equal(
    fs.readFileSync(path.join(repo, "auto-applied.ts"), "utf8"),
    "export const autoApplied = true;\n",
  );
  assert.equal(fs.existsSync(path.join(repo, ".worktrees")), false, "no worktree is created any more");
  assert.equal(await branchExists(repo, `hermes/agy-${runId}`), false, "no branch is created any more");
  assert.equal(await headSha(repo), head, "a dispatch never commits");

  // The review boundary is a pair of trees, and the baseline is the checkout as it was.
  assert.equal(result.baselineTreeSha, baselineExpected.treeSha);
  assert.equal(result.baselineTreeSha, await headTreeSha(repo), "a clean checkout baselines at HEAD's tree");
  assert.ok(result.afterTreeSha && result.afterTreeSha !== result.baselineTreeSha);
  assert.deepEqual(result.modifiedFiles, ["auto-applied.ts"]);
  assert.equal(result.changesKept, true);
  assert.match(result.diff, /^diff --git a\/auto-applied\.ts b\/auto-applied\.ts$/m);
  assert.equal(result.diffTruncated, false);
  assert.equal(result.turns, 1);
  assert.equal(result.verifyExitCode, null, "no verify command, no exit status");
  assert.equal(result.sessionRotated, false);
  assert.equal(result.cancelled, false);
  assert.equal(result.modelFallback, false);
  assert.match(result.message, /1 file\(s\) changed/);
  assert.match(result.message, /action=discard/);

  // The argv the stub saw is the create-mode form, placed in the checkout it was handed.
  const call = readStubCalls(callsPath)[0];
  assert.equal(call.argv[call.argv.indexOf("--in") + 1], result.repoRoot);
  assert.equal(call.argv.includes("--create-if-missing"), true);
  assert.equal(call.argv.includes("--resume"), false, "the first turn creates the session");
});

test("the caller's own uncommitted work is not attributed to the run", async (t) => {
  const runId = `dirty-${process.pid}-${Date.now().toString(36)}`;
  const { repo } = await makeDispatchRepo(t);
  fs.writeFileSync(path.join(repo, "README.md"), "# fixture\n\nlocal note\n", "utf8");
  fs.writeFileSync(path.join(repo, "caller.ts"), "export const caller = 1;\n", "utf8");

  const result = (await dispatchHermesTask({
    cwd: repo,
    prompt: "Add auto-applied.ts to the repository root.",
    runId,
    fastWaitSeconds: 120,
  })) as DispatchResult;

  assert.equal(result.success, true, result.message);
  // The baseline already carries the caller's work, so only the run's own file is in the diff.
  assert.notEqual(result.baselineTreeSha, await headTreeSha(repo), "the dirty checkout moved the baseline");
  assert.deepEqual(result.modifiedFiles, ["auto-applied.ts"]);
  assert.equal(
    fs.readFileSync(path.join(repo, "README.md"), "utf8"),
    "# fixture\n\nlocal note\n",
    "the caller's edit is not the run's to revert or report",
  );
  assert.equal(fs.existsSync(path.join(repo, "caller.ts")), true);
});

test("includeDiff false withholds the diff body but keeps the file list", async (t) => {
  const runId = `nodiff-${process.pid}-${Date.now().toString(36)}`;
  const { repo } = await makeDispatchRepo(t);

  const result = (await dispatchHermesTask({
    cwd: repo,
    prompt: "Add auto-applied.ts to the repository root.",
    runId,
    includeDiff: false,
    fastWaitSeconds: 120,
  })) as DispatchResult;

  assert.equal(result.success, true, result.message);
  assert.equal(result.diff, "");
  assert.equal(result.diffTruncated, false);
  assert.equal(result.diffOmitted, true);
  assert.deepEqual(result.modifiedFiles, ["auto-applied.ts"], "the file list survives the omission");
  assert.equal(result.changesKept, true, "asking for no diff must not roll anything back");
  assert.equal(fs.existsSync(path.join(repo, "auto-applied.ts")), true);

  // A returned diff is not an omitted one.
  const withDiff = (await dispatchHermesTask({
    cwd: repo,
    prompt: "Touch the same file again.",
    runId: `withdiff-${runId}`,
    includeDiff: true,
    fastWaitSeconds: 120,
  })) as DispatchResult;
  assert.equal(withDiff.diffOmitted, undefined);
});

test("a dispatch that changes nothing reports the checkout untouched", async (t) => {
  const runId = `nochange-${process.pid}-${Date.now().toString(36)}`;
  const { repo } = await makeDispatchRepo(t, { writeAutoApplied: false });

  const result = (await dispatchHermesTask({
    cwd: repo,
    prompt: "Look around but do not write anything.",
    runId,
    fastWaitSeconds: 120,
  })) as DispatchResult;

  assert.equal(result.success, true, result.message);
  assert.deepEqual(result.modifiedFiles, []);
  assert.equal(result.changesKept, false);
  assert.equal(result.afterTreeSha, result.baselineTreeSha, "no change is the same tree twice");
  assert.equal(result.diff, "");
  assert.match(result.message, /No files were modified/);
});

test("an absent ledger and an unknown session is a failed, unverified dispatch", async (t) => {
  const runId = `unverified-${process.pid}-${Date.now().toString(36)}`;
  const { repo } = await makeDispatchRepo(t, { usage: null });

  const result = (await dispatchHermesTask({
    cwd: repo,
    prompt: "Add auto-applied.ts to the repository root.",
    runId,
    fastWaitSeconds: 120,
  })) as DispatchResult;

  // Nothing on disk names a model, so success would claim the pinned one answered.
  assert.equal(result.success, false);
  assert.equal(result.model, null);
  assert.equal(result.provider, null);
  assert.equal(result.modelFallback, false, "no fallback is reported because none can be proven");
  assert.match(result.message, /Dispatch unverified/);
  assert.match(result.warning ?? "", /Could not verify which model answered/);
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
  assert.equal(JSON.stringify(result.toolEvents).includes("xxxxxxxxxx"), false);
});

test("the fast-wait default keeps a dispatch call short", () => {
  assert.equal(DEFAULT_FAST_WAIT_SECONDS, 1);
  assert.equal(DEFAULT_MAX_COMPACTS, 2, "a session may compact twice before the dispatch rotates");
});

test("a dispatch carrying a credential is refused before any work happens", async (t) => {
  const { repo } = await makeRepo(t);
  const statusBefore = await git(repo, ["status", "--porcelain"]);
  const headBefore = await headSha(repo);
  const runId = `refused-${process.pid}-${Date.now().toString(36)}`;
  t.after(() => clearRunState(runId));

  await assert.rejects(
    dispatchHermesTask({
      cwd: repo,
      runId,
      prompt: `use ghp_${"c".repeat(36)} to push`,
      fastWaitSeconds: 120,
    }),
    /Refused to dispatch: prompt contains what looks like a GitHub personal access token/,
  );

  // No trace, no snapshot and no run state: the refusal happens before the checkout is touched.
  assert.equal(await git(repo, ["status", "--porcelain"]), statusBefore, "the checkout is untouched");
  assert.equal(await headSha(repo), headBefore, "no commit and no tree object was made");
  assert.equal(fs.existsSync(path.join(repo, ".worktrees")), false);
  assert.equal(fs.existsSync(path.join(repo, "auto-applied.ts")), false);
  assert.equal(readRunState(runId), null, "a refused dispatch publishes no run state");
});

// ---------------------------------------------------------------------------------------------
// Attribution: the ledger is authoritative, the session row is the fallback
// ---------------------------------------------------------------------------------------------

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

test("a ledger naming a model nobody asked for is a fallback, and reverts the checkout", async (t) => {
  const runId = `ledger-fallback-${process.pid}-${Date.now().toString(36)}`;
  const { repo } = await makeDispatchRepo(t, {
    usage: {
      model: "openrouter/other",
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
  assert.equal(result.model, "openrouter/other");
  assert.match(result.message, /Dispatch refused: Go allowance exhausted/);
  assert.deepEqual(result.modifiedFiles, [], "a fallback diff is not reviewable");
  assert.equal(result.changesKept, false);
  assert.equal(result.diff, "");
  assert.equal(result.afterTreeSha, result.baselineTreeSha, "the revert puts the after-tree back on the baseline");
  // The checkout is reverted rather than left for review: output nobody can review must not land.
  assert.equal(fs.existsSync(path.join(repo, "auto-applied.ts")), false, "the fallback's work is reverted");
  assert.match(result.message, /checkout was reverted/);
});

test("a failed turn reports the ledger's failure and keeps its work for inspection", async (t) => {
  const runId = `ledger-failed-${process.pid}-${Date.now().toString(36)}`;
  const { repo } = await makeDispatchRepo(t, {
    exitCode: 1,
    usage: {
      model: DEFAULT_MODEL,
      provider: "opencode-go",
      session_id: "sess-auto-apply",
      failed: true,
      failure: "provider 429 after 3 retries",
    },
  });

  const result = (await dispatchHermesTask({
    cwd: repo,
    prompt: "Add auto-applied.ts to the repository root.",
    runId,
    fastWaitSeconds: 120,
  })) as DispatchResult;

  assert.equal(result.success, false, "a non-zero turn is not a success");
  assert.equal(result.error, "provider 429 after 3 retries", "the ledger's failure is the reason reported");
  assert.equal(result.exitCode, 1);
  assert.equal(result.modelFallback, false, "a failed turn is not a silent downgrade");
  // The work stays in the checkout: a failure the caller can inspect is worth more than a revert.
  assert.equal(result.changesKept, true);
  assert.equal(fs.existsSync(path.join(repo, "auto-applied.ts")), true);
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
      estimated_cost_usd: 0.5,
      cost_source: "reported",
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
  assert.equal(report?.costUsd, 0.5);
  assert.equal(report?.costSource, "reported");
  assert.equal(report?.failed, false);

  // A failed run writes nulls rather than no file: it must still name its failure.
  const failed = path.join(dir, "failed.json");
  fs.writeFileSync(failed, JSON.stringify({ model: null, failed: true, failure: "boom" }), "utf8");
  const failedReport = readUsageReport(failed);
  assert.equal(failedReport?.model, null);
  assert.equal(failedReport?.tokens, null, "an all-zero ledger is no count at all");
  assert.equal(failedReport?.failed, true);
  assert.equal(failedReport?.failure, "boom");
  assert.equal(failedReport?.costUsd, null, "an absent cost is null, never 0");

  // Zero is a real number: a free run reports 0, and a missing one reports null.
  const free = path.join(dir, "free.json");
  fs.writeFileSync(free, JSON.stringify({ model: "m", estimated_cost_usd: 0 }), "utf8");
  assert.equal(readUsageReport(free)?.costUsd, 0);

  assert.equal(readUsageReport(null), null);
  assert.equal(readUsageReport(path.join(dir, "missing.json")), null);
  const corrupt = path.join(dir, "corrupt.json");
  fs.writeFileSync(corrupt, "{not json", "utf8");
  assert.equal(readUsageReport(corrupt), null);
  const array = path.join(dir, "array.json");
  fs.writeFileSync(array, "[]", "utf8");
  assert.equal(readUsageReport(array), null, "a JSON array is not a report");
});

// ---------------------------------------------------------------------------------------------
// argv: create vs resume
// ---------------------------------------------------------------------------------------------

test("a create-mode dispatch pins the model, the reasoning effort and a supported source", () => {
  const args = buildChatArgs({
    promptFile: "C:\\Temp\\prompt.txt",
    repoRoot: "C:\\repo",
    sessionName: "[AGY] test",
    model: "openrouter/free",
    reasoning: "low",
    skills: ["github", "docx"],
    usageFile: "C:\\Temp\\usage.json",
  });

  assert.deepEqual(
    args,
    [
      "--usage-file",
      "C:\\Temp\\usage.json",
      "chat",
      "--query-file",
      "C:\\Temp\\prompt.txt",
      "--format",
      "stream-json",
      "--in",
      "C:\\repo",
      "-c",
      "[AGY] test",
      "--create-if-missing",
      "--yolo",
      "--source",
      "cli",
      "--provider",
      "opencode-go",
      "--model",
      "openrouter/free",
      "--reasoning",
      "low",
      "--skills",
      "github,docx",
    ],
    "the create argv is a contract: --in places the session in the checkout",
  );
  // The gateway refuses any source outside its SURFACES list, and a worktree flag would re-anchor cwd.
  assert.equal(args.includes("--worktree"), false);
  assert.equal(args.includes("--run-budget"), false);
});

test("a create-mode dispatch defaults the model and reasoning", () => {
  const args = buildChatArgs({ promptFile: "p.txt", repoRoot: "w", sessionName: "s" });
  assert.equal(flagOf(args, "--model"), DEFAULT_MODEL);
  assert.equal(flagOf(args, "--reasoning"), DEFAULT_REASONING);
  assert.equal(args.includes("--skills"), false, "no skills given, no skills flag");
  assert.equal(args.includes("--usage-file"), false, "no ledger given, no ledger flag");
  assert.equal(args[0], "chat", "with no ledger flag the subcommand leads");
});

test("a resume-mode dispatch carries only what a resumed session can still accept", () => {
  const args = buildChatArgs({
    promptFile: "p.txt",
    repoRoot: "C:\\repo",
    sessionName: "[AGY] test",
    model: "openrouter/free",
    reasoning: "low",
    skills: ["github"],
    usageFile: "C:\\Temp\\usage.json",
    resumeSessionId: "sess-1",
  });

  assert.deepEqual(
    args,
    [
      "--usage-file",
      "C:\\Temp\\usage.json",
      "chat",
      "--query-file",
      "p.txt",
      "--format",
      "stream-json",
      "--resume",
      "sess-1",
      "--yolo",
      "--source",
      "cli",
    ],
    "a resumed session owns its model, provider, skills and cwd",
  );
  for (const forbidden of ["--model", "--provider", "--skills", "--in", "-c", "--create-if-missing"]) {
    assert.equal(args.includes(forbidden), false, `${forbidden} would re-pin a resumed session`);
  }
});

test("the usage-file flag is top-level and no gateway-rejected flag is emitted", () => {
  const args = buildChatArgs({
    promptFile: "p.txt",
    repoRoot: "w",
    sessionName: "s",
    usageFile: "C:\\Temp\\usage.json",
  });

  // argparse refuses --usage-file after the subcommand, so a later edit that appends it to the
  // chat argument list breaks every dispatch instead of failing one option.
  assert.ok(args.indexOf("--usage-file") < args.indexOf("chat"), "the ledger flag must precede chat");
  assert.equal(flagOf(args, "--usage-file"), "C:\\Temp\\usage.json");
  // The gateway CLI refuses --run-budget with exit 2 and no session, so emitting it makes every
  // dispatch fail before the provider is reached. The process timeout is the only real budget.
  assert.equal(args.includes("--run-budget"), false);
});

// ---------------------------------------------------------------------------------------------
// Multi-turn: the conversation binding
// ---------------------------------------------------------------------------------------------

const turnPayload = (home: string): StubPayload => ({
  first: { file: "turn-1.ts", content: "export const turn = 1;\n" },
  later: { file: "turn-2.ts", content: "export const turn = 2;\n" },
  marker: path.join(home, "turn-marker"),
});

const turnStub = (sessionId: string, home: string, callsPath: string): StubOptions => ({
  sessionId,
  writeUsage: { session_id: sessionId, model: DEFAULT_MODEL, provider: "opencode-go", failed: false },
  payload: turnPayload(home),
  argvLog: callsPath,
});

test("a second turn on one conversation resumes the remembered session", async (t) => {
  const stamp = `${process.pid}-${Date.now().toString(36)}`;
  const conversationId = `conv-resume-${stamp}`;
  const { repo, home, callsPath } = await makeDispatchRepo(t, { sessionId: "sess-turn" });
  rearmStub(turnStub("sess-turn", home, callsPath));
  process.env.HERMES_HOME = home;
  t.after(() => clearConversationSession(conversationId, repo));

  const first = (await dispatchHermesTask({
    cwd: repo,
    prompt: "Create turn-1.ts.",
    conversationId,
    runId: `mt1-${stamp}`,
    fastWaitSeconds: 120,
  })) as DispatchResult;
  assert.equal(first.success, true, first.message);
  assert.deepEqual(first.modifiedFiles, ["turn-1.ts"]);

  const remembered = await readConversationSession(conversationId, repo);
  assert.equal(remembered?.sessionId, "sess-turn");
  assert.equal(remembered?.initialTreeSha, first.baselineTreeSha);
  assert.equal(remembered?.lastAfterTreeSha, first.afterTreeSha);

  const second = (await dispatchHermesTask({
    cwd: repo,
    prompt: "Now create turn-2.ts.",
    conversationId,
    runId: `mt2-${stamp}`,
    fastWaitSeconds: 120,
  })) as DispatchResult;
  assert.equal(second.success, true, second.message);
  assert.deepEqual(second.modifiedFiles, ["turn-2.ts"], "the second turn's own work only");
  assert.equal(second.baselineTreeSha, first.afterTreeSha, "the checkout carries the first turn's work");
  assert.equal(second.sessionId, "sess-turn");

  const calls = readStubCalls(callsPath);
  assert.equal(calls.length, 2);
  const resumeArgv = calls[1].argv;
  assert.equal(flagOf(resumeArgv, "--resume"), "sess-turn", "the remembered session is resumed");
  for (const forbidden of ["--model", "--provider", "-c", "--create-if-missing"]) {
    assert.equal(resumeArgv.includes(forbidden), false, `${forbidden} must not travel on a resume`);
  }
  // The checkout did not move between the turns, so there is no delta to announce.
  assert.equal(
    calls[1].prompt?.includes("[WORKSPACE DELTA SINCE LAST TURN]") ?? false,
    false,
    "an unchanged checkout needs no delta prompt",
  );
});

test("a changed checkout since the last turn is announced in the delta prompt", async (t) => {
  const stamp = `${process.pid}-${Date.now().toString(36)}`;
  const conversationId = `conv-delta-${stamp}`;
  const { repo, home, callsPath } = await makeDispatchRepo(t, { sessionId: "sess-delta" });
  rearmStub(turnStub("sess-delta", home, callsPath));
  process.env.HERMES_HOME = home;
  t.after(() => clearConversationSession(conversationId, repo));

  const first = (await dispatchHermesTask({
    cwd: repo,
    prompt: "Create turn-1.ts.",
    conversationId,
    runId: `delta1-${stamp}`,
    fastWaitSeconds: 120,
  })) as DispatchResult;
  assert.equal(first.success, true, first.message);

  // The user keeps working in the checkout while the agent is between turns.
  fs.writeFileSync(path.join(repo, "README.md"), "# fixture\n\nmoved while you were away\n", "utf8");
  fs.writeFileSync(path.join(repo, "between-turns.ts"), "export const between = 1;\n", "utf8");

  const second = (await dispatchHermesTask({
    cwd: repo,
    prompt: "Now create turn-2.ts.",
    conversationId,
    runId: `delta2-${stamp}`,
    fastWaitSeconds: 120,
  })) as DispatchResult;
  assert.equal(second.success, true, second.message);

  const prompt = readStubCalls(callsPath)[1].prompt ?? "";
  assert.equal(
    prompt.startsWith("[WORKSPACE DELTA SINCE LAST TURN]"),
    true,
    `the second turn must open with the delta, got:\n${prompt.slice(0, 400)}`,
  );
  assert.match(prompt, /- README\.md/, "the changed tracked file is named");
  assert.match(prompt, /- between-turns\.ts/, "the file that appeared is named");
  assert.match(prompt, /Now create turn-2\.ts\./, "the caller's prompt still follows the delta");
});

test("newSession ignores the remembered binding and creates a fresh session", async (t) => {
  const stamp = `${process.pid}-${Date.now().toString(36)}`;
  const conversationId = `conv-new-${stamp}`;
  const { repo, home, callsPath } = await makeDispatchRepo(t, { sessionId: "sess-fresh" });
  rearmStub(turnStub("sess-fresh", home, callsPath));
  process.env.HERMES_HOME = home;
  t.after(() => clearConversationSession(conversationId, repo));

  const first = (await dispatchHermesTask({
    cwd: repo,
    prompt: "Create turn-1.ts.",
    conversationId,
    runId: `new1-${stamp}`,
    fastWaitSeconds: 120,
  })) as DispatchResult;
  assert.equal(first.success, true, first.message);

  const second = (await dispatchHermesTask({
    cwd: repo,
    prompt: "Start over and create turn-2.ts.",
    conversationId,
    newSession: true,
    runId: `new2-${stamp}`,
    fastWaitSeconds: 120,
  })) as DispatchResult;
  assert.equal(second.success, true, second.message);

  const freshArgv = readStubCalls(callsPath)[1].argv;
  assert.equal(freshArgv.includes("--resume"), false, "a fresh session must not resume the old one");
  assert.equal(freshArgv.includes("--create-if-missing"), true);
  assert.equal(freshArgv.includes("--model"), true, "a created session is pinned to the model again");
  assert.equal(freshArgv.includes("-c"), true, "a created session is named");

  // The binding is replaced by the fresh session, not left pointing at the abandoned one. With the
  // old record ignored, the new conversation starts at this dispatch's own baseline.
  const rebound = await readConversationSession(conversationId, repo);
  assert.equal(rebound?.sessionId, "sess-fresh");
  assert.equal(rebound?.initialTreeSha, second.baselineTreeSha);
  assert.equal(rebound?.lastAfterTreeSha, second.afterTreeSha);
});

// ---------------------------------------------------------------------------------------------
// Compaction rotation
// ---------------------------------------------------------------------------------------------

type SessionProbe = NonNullable<DispatchOptions["sessionProbe"]>;

/** A probe that reports how far past the budget a session already is. */
const compactionProbe = (compactionCount: number, summary: string | null = null): SessionProbe =>
  async (sessionId) => ({
    reasoning: null,
    model: DEFAULT_MODEL,
    provider: "opencode-go",
    fallbackActive: false,
    known: true,
    tipSessionId: sessionId,
    compactionCount,
    compactionSummary: summary,
    lastAssistantSummary: null,
  });

test("a session at the compaction budget rotates into a fresh one with a handoff", async (t) => {
  const runId = `rotate-${process.pid}-${Date.now().toString(36)}`;
  const { repo, callsPath } = await makeDispatchRepo(t);

  const result = (await dispatchHermesTask({
    cwd: repo,
    prompt: "Finish the refactor.",
    resumeSessionId: "sess-compacted",
    sessionProbe: compactionProbe(2, "Refactored the loader and left the tests failing."),
    runId,
    fastWaitSeconds: 120,
  })) as DispatchResult;

  assert.equal(result.sessionRotated, true, `a compacted session must rotate: ${result.message}`);
  const argv = readStubCalls(callsPath)[0].argv;
  assert.equal(argv.includes("--resume"), false, "the compacted session must not be resumed");
  assert.equal(argv.includes("--create-if-missing"), true, "a fresh session is created");
  const name = flagOf(argv, "-c");
  assert.ok(name, "a created session needs a name");
  assert.match(name as string, /\(cont\. 1\)$/, "the rotated session needs a name no earlier turn used");

  const prompt = readStubCalls(callsPath)[0].prompt ?? "";
  assert.equal(prompt.startsWith("[PRIOR SESSION HANDOFF]"), true, `got:\n${prompt.slice(0, 400)}`);
  assert.match(prompt, /previous session: sess-compacted/);
  assert.match(prompt, /compacted 2 time\(s\)/);
  assert.match(prompt, /Refactored the loader and left the tests failing\./);
  assert.match(prompt, /Finish the refactor\./, "the caller's prompt still follows the handoff");
  assert.equal(result.success, true, result.message);
});

test("a session under the budget is resumed, and HERMES_MAX_COMPACTS sets the budget", async (t) => {
  const stamp = `${process.pid}-${Date.now().toString(36)}`;
  const previous = process.env.HERMES_MAX_COMPACTS;
  process.env.HERMES_MAX_COMPACTS = "3";
  t.after(() => {
    if (previous === undefined) delete process.env.HERMES_MAX_COMPACTS;
    else process.env.HERMES_MAX_COMPACTS = previous;
  });
  const { repo, callsPath } = await makeDispatchRepo(t);

  const under = (await dispatchHermesTask({
    cwd: repo,
    prompt: "Keep going.",
    resumeSessionId: "sess-ok",
    sessionProbe: compactionProbe(2),
    runId: `under-${stamp}`,
    fastWaitSeconds: 120,
  })) as DispatchResult;
  assert.equal(under.sessionRotated, false, "two compactions is under a budget of three");
  assert.equal(flagOf(readStubCalls(callsPath)[0].argv, "--resume"), "sess-ok");

  // The option wins over the environment.
  const over = (await dispatchHermesTask({
    cwd: repo,
    prompt: "Keep going.",
    resumeSessionId: "sess-ok",
    maxCompacts: 1,
    sessionProbe: compactionProbe(2),
    runId: `over-${stamp}`,
    fastWaitSeconds: 120,
  })) as DispatchResult;
  assert.equal(over.sessionRotated, true, "maxCompacts on the call outranks the environment");
  assert.equal(readStubCalls(callsPath)[1].argv.includes("--resume"), false);
});

// ---------------------------------------------------------------------------------------------
// The verify loop
// ---------------------------------------------------------------------------------------------

/** A verify script that fails until `out.txt` holds the expected word. */
const writeVerifyScript = (repo: string): void => {
  fs.writeFileSync(
    path.join(repo, "verify.mjs"),
    [
      'import fs from "node:fs";',
      'let got = "";',
      'try { got = fs.readFileSync(new URL("./out.txt", import.meta.url), "utf8").trim(); } catch {}',
      'if (got !== "good") {',
      '  process.stdout.write("out.txt is " + JSON.stringify(got) + ", expected \\"good\\"\\n");',
      "  process.exit(3);",
      "}",
      'process.stdout.write("verification ok\\n");',
    ].join("\n"),
    "utf8",
  );
};

const verifyPayload = (home: string): StubPayload => ({
  first: { file: "out.txt", content: "bad\n" },
  later: { file: "out.txt", content: "good\n" },
  marker: path.join(home, "verify-marker"),
});

test("a failing verify command drives another turn and the run passes once it holds", async (t) => {
  const runId = `verify-${process.pid}-${Date.now().toString(36)}`;
  const { repo, home, callsPath } = await makeDispatchRepo(t, { sessionId: "sess-verify" });
  rearmStub({
    sessionId: "sess-verify",
    writeUsage: { session_id: "sess-verify", model: DEFAULT_MODEL, provider: "opencode-go", failed: false },
    payload: verifyPayload(home),
    argvLog: callsPath,
  });
  process.env.HERMES_HOME = home;
  writeVerifyScript(repo);

  const result = (await dispatchHermesTask({
    cwd: repo,
    prompt: "Write out.txt so that the verification passes.",
    verifyCommand: "node verify.mjs",
    runId,
    fastWaitSeconds: 120,
  })) as DispatchResult;

  assert.equal(result.success, true, result.message);
  assert.equal(result.turns, 2, "the failed verification bought exactly one more turn");
  assert.equal(result.verifyExitCode, 0, "the last verification passed");
  assert.equal(result.changesKept, true);
  assert.equal(fs.readFileSync(path.join(repo, "out.txt"), "utf8"), "good\n");

  const calls = readStubCalls(callsPath);
  assert.equal(calls.length, 2);
  assert.equal(flagOf(calls[1].argv, "--resume"), "sess-verify", "the retry resumes the same session");
  const retry = calls[1].prompt ?? "";
  assert.equal(retry.startsWith("[VERIFICATION FAILED]"), true, `got:\n${retry.slice(0, 400)}`);
  assert.match(retry, /`node verify\.mjs` exited 3 after turn 1 of 3\./);
  assert.match(retry, /out\.txt is "bad", expected "good"/, "the command's output is the reproduction");
});

test("a verification that never holds fails the dispatch and leaves the work in place", async (t) => {
  const runId = `verify-stuck-${process.pid}-${Date.now().toString(36)}`;
  const { repo, home } = await makeDispatchRepo(t, { sessionId: "sess-stuck" });
  rearmStub({
    sessionId: "sess-stuck",
    writeUsage: { session_id: "sess-stuck", model: DEFAULT_MODEL, provider: "opencode-go", failed: false },
    // Every turn writes a value the command refuses, so it can never pass.
    payload: { ...verifyPayload(home), later: { file: "out.txt", content: "worse\n" } },
  });
  process.env.HERMES_HOME = home;
  writeVerifyScript(repo);

  const result = (await dispatchHermesTask({
    cwd: repo,
    prompt: "Write out.txt so that the verification passes.",
    verifyCommand: "node verify.mjs",
    maxTurns: 2,
    runId,
    fastWaitSeconds: 120,
  })) as DispatchResult;

  assert.equal(result.success, false, "a command that never passed is not a successful dispatch");
  assert.equal(result.turns, 2, "the turn budget is the ceiling");
  assert.equal(result.verifyExitCode, 3);
  assert.match(result.message, /Verification `node verify\.mjs` exited 3 after 2 turn\(s\)/);
  // The checkout is the only copy of the work: it stays for the caller to inspect.
  assert.equal(result.changesKept, true);
  assert.equal(fs.readFileSync(path.join(repo, "out.txt"), "utf8"), "worse\n");
});

test("the verify helpers render a delta, a handoff and a retry brief", () => {
  assert.equal(workspaceDeltaPrompt([]), "", "no change, no prompt");
  const delta = workspaceDeltaPrompt(["src/a.ts", "src/b.ts"]);
  assert.equal(delta.startsWith("[WORKSPACE DELTA SINCE LAST TURN]"), true);
  assert.match(delta, /- src\/a\.ts/);
  const capped = workspaceDeltaPrompt(["a", "b", "c"], 2);
  assert.match(capped, /- …and 1 more/, "a capped list says how much it withheld");

  const handoff = priorSessionHandoffPrompt({
    previousSessionId: "sess-old",
    compactionCount: 3,
    summary: "Half the loader is rewritten.",
    modifiedFiles: ["src/a.ts"],
  });
  assert.equal(handoff.startsWith("[PRIOR SESSION HANDOFF]"), true);
  assert.match(handoff, /previous session: sess-old/);
  assert.match(handoff, /compacted 3 time\(s\)/);
  assert.match(handoff, /where it left off: Half the loader is rewritten\./);
  assert.match(handoff, /files already changed in the checkout: src\/a\.ts/);
  const emptyHandoff = priorSessionHandoffPrompt({
    previousSessionId: "s",
    compactionCount: 1,
    summary: null,
    modifiedFiles: [],
  });
  assert.match(emptyHandoff, /no summary of the previous session was written/);
  assert.match(emptyHandoff, /no files have been changed in the checkout yet/);

  const retry = verificationRetryPrompt({
    command: "pnpm test",
    exitCode: 1,
    output: "1 failing\n",
    turn: 2,
    maxTurns: 3,
  });
  assert.equal(retry.startsWith("[VERIFICATION FAILED]"), true);
  assert.match(retry, /`pnpm test` exited 1 after turn 2 of 3\./);
  assert.match(retry, /Output:\n1 failing/);
  assert.match(
    verificationRetryPrompt({ command: "x", exitCode: null, output: "", turn: 1, maxTurns: 3 }),
    /exited unknown/,
    "a timed-out command has no exit status",
  );
});

test("runVerifyCommand reports the exit status and both output streams", async (t) => {
  const { repo } = await makeRepo(t);
  fs.writeFileSync(
    path.join(repo, "probe.mjs"),
    [
      'process.stdout.write("to stdout\\n");',
      'process.stderr.write("to stderr\\n");',
      "process.exit(Number(process.argv[2]));",
    ].join("\n"),
    "utf8",
  );

  const ok = await runVerifyCommand("node probe.mjs 0", repo, process.env);
  assert.equal(ok.code, 0);
  assert.match(ok.output, /to stdout/);

  const bad = await runVerifyCommand("node probe.mjs 7", repo, process.env);
  assert.equal(bad.code, 7, "a non-zero exit is the verdict");
  assert.equal(bad.timedOut, false, "a command that finished was never killed");
  assert.match(bad.output, /to stderr/, "both streams are part of the reproduction");
});

// ---------------------------------------------------------------------------------------------
// manageWorktree: snapshot runs revert, legacy worktrees still apply
// ---------------------------------------------------------------------------------------------

test("discard reverts a snapshot run to the tree it started from", async (t) => {
  const runId = `discard-${process.pid}-${Date.now().toString(36)}`;
  const { repo } = await makeDispatchRepo(t);
  t.after(() => clearRunState(runId));

  const result = (await dispatchHermesTask({
    cwd: repo,
    prompt: "Add auto-applied.ts to the repository root.",
    runId,
    fastWaitSeconds: 120,
  })) as DispatchResult;
  assert.equal(result.success, true, result.message);

  // The dispatch that answered inline cleared its record, so the run is republished exactly as the
  // pipeline writes it; discard reads the boundary back from disk, never from this process's memory.
  await writeRunState({
    status: "completed",
    runId,
    sessionName: result.sessionName,
    repoRoot: repo,
    baselineTreeSha: result.baselineTreeSha,
    startedAt: Date.now(),
    result,
  });

  const discarded = await manageWorktree({ action: "discard", cwd: repo, runHandle: `agy-${runId}` });
  assert.equal(discarded.success, true, discarded.message);
  assert.match(discarded.message, /Discarded run/);
  assert.deepEqual(discarded.reverted, ["auto-applied.ts"]);
  assert.equal(fs.existsSync(path.join(repo, "auto-applied.ts")), false, "the run's work is gone");
  assert.equal(await git(repo, ["status", "--porcelain"]), "", "the checkout is back to the baseline");
});

test("apply refuses a snapshot run, naming discard as the way to revert", async (t) => {
  const runId = `apply-snapshot-${process.pid}-${Date.now().toString(36)}`;
  const { repo } = await makeDispatchRepo(t);
  t.after(() => clearRunState(runId));

  const result = (await dispatchHermesTask({
    cwd: repo,
    prompt: "Add auto-applied.ts to the repository root.",
    runId,
    fastWaitSeconds: 120,
  })) as DispatchResult;
  await writeRunState({
    status: "completed",
    runId,
    sessionName: result.sessionName,
    repoRoot: repo,
    baselineTreeSha: result.baselineTreeSha,
    startedAt: Date.now(),
    result,
  });

  const applied = await manageWorktree({ action: "apply", cwd: repo, runHandle: `agy-${runId}` });
  assert.equal(applied.success, false);
  assert.match(applied.message, /Nothing to apply/);
  assert.match(applied.message, /already in the checkout/);
  assert.match(applied.message, /action=discard/);
  assert.equal(fs.existsSync(path.join(repo, "auto-applied.ts")), true, "a refusal must not touch anything");
});

test("manageWorktree never acts on a branch it did not create", async (t) => {
  const { repo, branch } = await makeLegacyRepo(t);
  await git(repo, ["branch", "hermes/other"]);
  const head = await headSha(repo);
  await git(repo, ["branch", "committed-ref"]);

  // A user branch resolves at most to a run id, so it can only ever match `hermes/agy-<id>`: none of
  // these exist, and nothing may be deleted for them.
  for (const forbidden of ["main", "hermes/other", "committed-ref"]) {
    for (const action of ["apply", "discard"] as const) {
      const result = await manageWorktree({ action, cwd: repo, worktreeBranch: forbidden });
      assert.equal(result.success, false, `${action} ${forbidden} must be refused`);
      assert.match(result.message, /No worktree for branch|Refusing to touch/);
    }
  }

  // A handle that is not even shaped like a run id is refused outright, with nothing read from disk.
  for (const malformed of ["../evil", "hermes/agy-x;rm", "a/b/c"]) {
    const result = await manageWorktree({ action: "discard", cwd: repo, runHandle: malformed });
    assert.equal(result.success, false);
    assert.match(result.message, /Refusing to touch/);
  }

  assert.equal(await branchExists(repo, "main"), true, "main must survive");
  assert.equal(await branchExists(repo, "hermes/other"), true, "a foreign hermes/ branch must survive");
  assert.equal(await branchExists(repo, "committed-ref"), true);
  assert.equal(await branchExists(repo, branch), true, "the bridge worktree was never touched");
  assert.equal(await headSha(repo), head);
  assert.equal(fs.existsSync(path.join(repo, ".worktrees", "agy-test")), true);
});

test("apply lands the legacy worktree diff on the checkout and leaves no worktree behind", async (t) => {
  const { repo, worktree, branch } = await makeLegacyRepo(t);
  fs.writeFileSync(path.join(worktree, "feature.ts"), "export const feature = () => 42;\n", "utf8");
  fs.writeFileSync(path.join(repo, "README.md"), "# fixture\n\nlocal note\n", "utf8");

  const result = await manageWorktree({ action: "apply", cwd: repo, worktreeBranch: branch });
  assert.equal(result.success, true, result.message);

  assert.equal(fs.existsSync(path.join(repo, "feature.ts")), true, "the new file should be applied");
  assert.equal(fs.existsSync(worktree), false, "the worktree directory should be gone");
  assert.equal(fs.readFileSync(path.join(repo, "README.md"), "utf8"), "# fixture\n\nlocal note\n");
  assert.equal(await branchExists(repo, branch), false);
  assert.equal((await git(repo, ["worktree", "list", "--porcelain"])).includes(branch), false);
});

test("apply diffs from the baseline commit, so a dirty caller does not block it", async (t) => {
  const { repo, worktree, branch } = await makeLegacyRepo(t);

  // A caller with real uncommitted work: the legacy port carried it into a baseline commit inside
  // the worktree, so `merge-base` sits BELOW it and only the run's own work is applied.
  fs.writeFileSync(path.join(repo, "README.md"), "# fixture\n\ncaller work in progress\n", "utf8");
  fs.writeFileSync(path.join(worktree, "README.md"), "# fixture\n\ncaller work in progress\n", "utf8");
  await git(worktree, ["add", "."]);
  await git(worktree, ["commit", "-m", BASELINE_COMMIT_SUBJECT]);

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

test("discard on a legacy run removes the worktree and branch without touching the checkout", async (t) => {
  const { repo, worktree, branch } = await makeLegacyRepo(t);
  fs.writeFileSync(path.join(worktree, "abandoned.ts"), "export const abandoned = true;\n", "utf8");

  const result = await manageWorktree({ action: "discard", cwd: repo, worktreeBranch: branch });
  assert.equal(result.success, true, result.message);
  assert.equal(fs.existsSync(path.join(repo, "abandoned.ts")), false);
  assert.equal(fs.existsSync(worktree), false);
  assert.equal(await branchExists(repo, branch), false);
});

test("apply on an unknown branch reports instead of guessing", async (t) => {
  const { repo } = await makeLegacyRepo(t);
  const result = await manageWorktree({ action: "apply", cwd: repo, worktreeBranch: "hermes/agy-missing" });
  assert.equal(result.success, false);
  assert.match(result.message, /No worktree for branch/);
  assert.match(result.message, /recorded no snapshot to revert/);
});

test("apply works when cwd is a subdirectory of the repository", async (t) => {
  const { repo, worktree, branch } = await makeLegacyRepo(t);
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
  const { repo, worktree, branch } = await makeLegacyRepo(t);
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
  const { repo, worktree, branch } = await makeLegacyRepo(t);
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

test("an ignored secret directory blocks the apply", async (t) => {
  const { repo, worktree, branch } = await makeLegacyRepo(t);
  fs.appendFileSync(path.join(repo, ".git", "info", "exclude"), ".env/\n", "utf8");
  fs.writeFileSync(path.join(worktree, "innocuous.ts"), "export const innocent = true;\n", "utf8");
  fs.mkdirSync(path.join(worktree, ".env"), { recursive: true });
  fs.writeFileSync(path.join(worktree, ".env", "local"), "TOKEN=please-do-not-land\n", "utf8");

  const result = await manageWorktree({ action: "apply", cwd: repo, worktreeBranch: branch });
  assert.equal(result.success, false, "a secret directory must block the apply");
  assert.match(result.message, /Refused to apply/);
  assert.match(result.message, /\.env/);
  assert.equal(fs.existsSync(path.join(repo, ".env")), false);
  assert.equal(fs.existsSync(path.join(repo, "innocuous.ts")), false);
});

test("a conflicting legacy apply fails, keeps the worktree and leaves the patch for inspection", async (t) => {
  const { repo, worktree, branch } = await makeLegacyRepo(t);
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

test("a filename that mentions a skipped patch still applies", async (t) => {
  const { repo, worktree, branch } = await makeLegacyRepo(t);
  const named = "Skipped patch notes.md";
  fs.writeFileSync(path.join(repo, named), "# notes\n", "utf8");
  await git(repo, ["add", named]);
  await git(repo, ["commit", "-m", "track the notes"]);
  await git(worktree, ["reset", "--hard", await headSha(repo)]);
  fs.writeFileSync(path.join(worktree, named), "# notes\n\nhermes edit\n", "utf8");

  const result = await manageWorktree({ action: "apply", cwd: repo, worktreeBranch: branch });
  assert.equal(result.success, true, result.message);
  assert.equal(fs.readFileSync(path.join(repo, named), "utf8"), "# notes\n\nhermes edit\n");
});

/**
 * `git apply --3way` implies `--index`, so the merge path stages what the plain path leaves
 * unstaged. The caller's index is theirs: an apply lands in the working tree either way.
 */
test("apply leaves the caller's index alone whichever git path it took", async (t) => {
  const { repo, worktree, branch } = await makeLegacyRepo(t);
  fs.writeFileSync(path.join(worktree, "README.md"), "# fixture\n\nhermes edit\n", "utf8");

  const result = await manageWorktree({ action: "apply", cwd: repo, worktreeBranch: branch });
  assert.equal(result.success, true, result.message);
  const status = await git(repo, ["status", "--porcelain"]);
  assert.match(status, /^ M README\.md$/m, `the applied file must stay unstaged, got:\n${status}`);
});

test("a binary file round-trips byte for byte through a legacy patch", async (t) => {
  const { repo, worktree, branch } = await makeLegacyRepo(t);
  const bytes = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0xe9, 0x0d, 0x0a, 0x7f, 0x00, 0x42]);
  fs.writeFileSync(path.join(worktree, "asset.bin"), bytes);

  const result = await manageWorktree({ action: "apply", cwd: repo, worktreeBranch: branch });
  assert.equal(result.success, true, result.message);
  assert.deepEqual([...fs.readFileSync(path.join(repo, "asset.bin"))], [...bytes]);
});

// ---------------------------------------------------------------------------------------------
// Removal mechanics (EPERM/EBUSY retries, child reaping) — legacy machinery, still reachable
// ---------------------------------------------------------------------------------------------

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
  const { repo, worktree, branch } = await makeLegacyRepo(t);
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
  const { repo, worktree, branch } = await makeLegacyRepo(t);
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
  const { repo, worktree, branch } = await makeLegacyRepo(t);
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
  assert.equal(
    (await git(repo, ["worktree", "list", "--porcelain"])).includes(worktree.replace(/\\/g, "/")),
    false,
    "the admin record must be pruned",
  );
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
  const { repo, worktree, branch } = await makeLegacyRepo(t);
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
  const { repo, worktree, branch } = await makeLegacyRepo(t);
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
  const { repo, worktree, branch } = await makeLegacyRepo(t, runId);
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
  const { repo, branch } = await makeLegacyRepo(t, runId);
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
  const { repo, worktree, branch } = await makeLegacyRepo(t, runId);
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
  const { repo, worktree, branch } = await makeLegacyRepo(t);
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
  const { repo } = await makeLegacyRepo(t);
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
  makeOrphan(repo, strayId);
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
  const { repo } = await makeLegacyRepo(t);
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
  const { repo } = await makeRepo(t);
  assert.equal(await pruneOrphanWorktrees(repo), 0);
});

// ---------------------------------------------------------------------------------------------
// The live run: pids, cancel, hooks, streams
// ---------------------------------------------------------------------------------------------

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
  assert.equal(outcome.runHandle, `agy-${runId}`);
  assert.equal(outcome.repoRoot, path.resolve(repo));
  assert.equal(outcome.baselineTreeSha.length, 40, "the running answer names the boundary as well");

  const state = readRunState(runId);
  assert.equal(state?.status, "running");
  assert.equal(state?.workerPid, process.pid, "the dispatcher pid is what proves the run is alive");
  assert.equal(typeof state?.childPid, "number", "the runner's pid is what cancel has to kill");
  assert.equal(state?.baselineTreeSha, outcome.baselineTreeSha);
  assert.equal(state?.initialTreeSha, outcome.baselineTreeSha);

  // Let the run finish so the fixture repo is not torn down mid-flight.
  for (let attempt = 0; attempt < 60 && readRunState(runId)?.status === "running"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(readRunState(runId)?.status, "completed");
});

test("cancel kills the run's child, settles the record and reverts the checkout", async (t) => {
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
  const cancelled = await manageWorktree({ action: "cancel", cwd: repo, runHandle: `agy-${runId}` });
  const elapsed = Date.now() - startedAt;

  assert.equal(cancelled.success, true, cancelled.message);
  assert.equal(isPidAlive(childPid), false, "the child tree must be dead");
  assert.match(cancelled.message, /Cancelled/);
  // Bounded teardown, not a 30s wait for the child's own sleep to elapse.
  assert.ok(elapsed < 20_000, `cancel must not wait out the child, took ${elapsed}ms`);
  // The revert is a tree restore, not a worktree removal: the checkout goes back to the baseline.
  assert.equal(fs.existsSync(path.join(repo, "auto-applied.ts")), false, "the killed run's work is reverted");
  assert.equal(await git(repo, ["status", "--porcelain"]), "");
  // The dispatcher itself must survive: cancel kills the child, never the bridge that reports it.
  assert.equal(isPidAlive(process.pid), true);

  // The cancelled pipeline unwinds on its own: it must not republish the run once that record has
  // already told the waiter the run is over.
  const settledRecord = readRunState(runId);
  assert.equal(settledRecord?.status, "completed");
  assert.equal((settledRecord?.result as { cancelled?: unknown } | undefined)?.cancelled, true);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const after = readRunState(runId);
  assert.equal((after?.result as { cancelled?: unknown } | undefined)?.cancelled, true);
  assert.deepEqual(after?.result, settledRecord?.result, "the pipeline must not overwrite the record");
  assert.equal(fs.existsSync(path.join(repo, "auto-applied.ts")), false);
});

/**
 * The verification command is a child of this process too, and it holds the checkout for minutes. If
 * it is not published as the run's child, a cancel kills the Hermes turn's pid instead — a process
 * that has already exited — then reverts underneath the verification. The loop also has to stop
 * spawning: without a gate it starts a retry turn into the checkout the cancel just reverted.
 */
test("cancel kills a running verification and leaves no post-cancel edit behind", async (t) => {
  const runId = `cancel-verify-${process.pid}-${Date.now().toString(36)}`;
  const { repo, callsPath } = await makeDispatchRepo(t);
  t.after(() => clearRunState(runId));

  // Relative names only: `runVerifyCommand` hands the command to `cmd /d /c`, which eats the quotes
  // around an absolute path. The probe is ignored so it is not part of the run's change set.
  const startedFile = path.join(repo, "verify-started.txt");
  const lateFile = path.join(repo, "verify-late.txt");
  const probe = path.join(repo, "verify-probe.cjs");
  fs.writeFileSync(
    probe,
    [
      'const fs = require("node:fs");',
      'fs.writeFileSync("verify-started.txt", "started");',
      // A long sleep keeps the verification running while the cancel lands, and the write after it is
      // the edit that must never reach a checkout the cancel has already reverted.
      'setTimeout(() => fs.writeFileSync("verify-late.txt", "late"), 20000);',
    ].join(String.fromCharCode(10)),
    "utf8",
  );
  fs.appendFileSync(path.join(repo, ".git", "info", "exclude"), "verify-probe.cjs\n", "utf8");

  const outcome = await dispatchHermesTask({
    cwd: repo,
    prompt: "Add auto-applied.ts to the repository root.",
    runId,
    verifyCommand: "node verify-probe.cjs",
    fastWaitSeconds: 0.5,
  });
  assert.ok("waitCommand" in outcome, "the verification keeps the run going");

  // No verification has started until the probe writes its marker, so there is nothing to cancel yet.
  for (let attempt = 0; attempt < 300 && !fs.existsSync(startedFile); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(fs.existsSync(startedFile), true, "the verification never started");

  const verifyPid = readRunState(runId)?.childPid;
  assert.equal(typeof verifyPid, "number", "the verification child has to be published as the run's child");
  assert.equal(isPidAlive(verifyPid), true, `the published child must be the live verification (pid ${verifyPid})`);

  const cancelled = await manageWorktree({ action: "cancel", cwd: repo, runHandle: `agy-${runId}` });
  assert.equal(cancelled.success, true, cancelled.message);
  assert.equal(isPidAlive(verifyPid), false, "the verification process tree must be dead before the revert");

  // Room for the unwound pipeline to finish and for any post-cancel spawn or write to show up.
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  assert.equal(fs.existsSync(lateFile), false, "a killed verification must not write after the cancel");
  assert.equal(readStubCalls(callsPath).length, 1, "a cancelled run must not start another turn");
  assert.equal(await git(repo, ["status", "--porcelain"]), "", "no post-cancel edit may survive in the checkout");
});

test("apply and discard still refuse a live run, naming cancel as the way out", async (t) => {
  const runId = `live-${process.pid}-${Date.now().toString(36)}`;
  const { repo } = await makeRepo(t);
  t.after(() => clearRunState(runId));

  await writeRunState({
    status: "running",
    runId,
    sessionName: "s",
    repoRoot: repo,
    baselineTreeSha: "tree",
    startedAt: Date.now(),
    workerPid: process.pid,
  });

  for (const action of ["apply", "discard"] as const) {
    const refused = await manageWorktree({ action, cwd: repo, runHandle: `agy-${runId}` });
    assert.equal(refused.success, false, `${action} must not touch a live run`);
    assert.match(refused.message, /still actively executing/);
    assert.match(refused.message, /cancel/);
  }
});

test("a crashed run is still discardable, because its worker pid no longer answers", async (t) => {
  const runId = `abandoned-${process.pid}-${Date.now().toString(36)}`;
  const { repo } = await makeRepo(t);
  t.after(() => clearRunState(runId));

  const baselineTreeSha = (await captureWorkingTreeSnapshot(repo)).treeSha;
  await writeRunState({
    status: "running",
    runId,
    sessionName: "s",
    repoRoot: repo,
    baselineTreeSha,
    startedAt: Date.now(),
    workerPid: 2_147_483_647,
  });
  // Work the crashed run left behind: the discard is what has to remove it.
  fs.writeFileSync(path.join(repo, "crashed-write.ts"), "export const x = 1;\n", "utf8");

  const discarded = await manageWorktree({ action: "discard", cwd: repo, runHandle: `agy-${runId}` });
  assert.equal(discarded.success, true, discarded.message);
  assert.equal(fs.existsSync(path.join(repo, "crashed-write.ts")), false, "the crashed run's work is reverted");
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

/**
 * A hook rewritten inside one mtime tick, or with its mtime restored, is a hook that changed: the
 * mtime alone cannot see it, and this guard exists to fail closed.
 */
test("a hook rewritten with its mtime restored is still a security violation, and reverts", async (t) => {
  const runId = `hookhash-${process.pid}-${Date.now().toString(36)}`;
  const { repo } = await makeDispatchRepo(t, { mutateHook: true });
  const hookFile = path.join(repo, ".git", "hooks", "pre-commit");
  fs.mkdirSync(path.dirname(hookFile), { recursive: true });
  fs.writeFileSync(hookFile, "#!/bin/sh\nexit 0\n", "utf8");

  const previousHook = process.env.HCLI_HOOK_FILE;
  process.env.HCLI_HOOK_FILE = hookFile;
  t.after(() => {
    if (previousHook === undefined) delete process.env.HCLI_HOOK_FILE;
    else process.env.HCLI_HOOK_FILE = previousHook;
  });

  // What a previous turn of this conversation left behind: the binding the next turn would resume.
  const conversationId = `conv-hook-${process.pid}-${Date.now().toString(36)}`;
  const repoRoot = path.resolve((await git(repo, ["rev-parse", "--show-toplevel"])).trim());
  // A real tree object, so resuming it costs nothing: the dispatch must read the binding, not trip
  // over a stale hash before it ever reaches the hook check.
  const seededTree = (await captureWorkingTreeSnapshot(repo)).treeSha;
  await writeConversationSession({
    conversationId,
    repoRoot,
    sessionId: "sess-hook-previous",
    initialTreeSha: seededTree,
    lastAfterTreeSha: seededTree,
    updatedAt: Date.now(),
  });
  t.after(() => clearConversationSession(conversationId));

  const result = (await dispatchHermesTask({
    cwd: repo,
    prompt: "Add auto-applied.ts to the repository root.",
    conversationId,
    runId,
    fastWaitSeconds: 120,
  })) as DispatchResult;

  assert.equal(result.securityViolation, true, `a content-only hook rewrite must be caught: ${result.message}`);
  assert.match(result.message, /git hooks changed/);
  assert.match(result.message, /reverted/);
  assert.equal(result.success, false);
  assert.equal(fs.existsSync(path.join(repo, "auto-applied.ts")), false, "a violation reverts the run's work");
  // A hook is executable code that runs on the caller's next git command, and `.git` is outside
  // both snapshots: the revert has to put the hook back or it was never reverted at all.
  assert.equal(
    fs.readFileSync(hookFile, "utf8"),
    "#!/bin/sh\nexit 0\n",
    "a rewritten hook must be restored by the revert",
  );
  // The work is gone from the checkout, so the conversation must not stay bound to its session:
  // the next turn would resume a session whose output was just reverted.
  assert.equal(
    await readConversationSession(conversationId),
    null,
    "a refused run must not leave the conversation bound to the rejected session",
  );
});

test("a hook the run created is deleted by the revert", async (t) => {
  const runId = `hookadd-${process.pid}-${Date.now().toString(36)}`;
  const { repo } = await makeDispatchRepo(t, { mutateHook: true });
  const added = path.join(repo, ".git", "hooks", "post-checkout");
  fs.mkdirSync(path.dirname(added), { recursive: true });

  const previousAdd = process.env.HCLI_HOOK_ADD_FILE;
  process.env.HCLI_HOOK_ADD_FILE = added;
  t.after(() => {
    if (previousAdd === undefined) delete process.env.HCLI_HOOK_ADD_FILE;
    else process.env.HCLI_HOOK_ADD_FILE = previousAdd;
  });

  const result = (await dispatchHermesTask({
    cwd: repo,
    prompt: "Add auto-applied.ts to the repository root.",
    runId,
    fastWaitSeconds: 120,
  })) as DispatchResult;

  assert.equal(result.securityViolation, true, result.message);
  assert.equal(result.success, false);
  // `.git` is in neither snapshot, so deleting it is the only thing that stops it running later.
  assert.equal(fs.existsSync(added), false, "a hook the run added must not survive the revert");
});

test("a secret written during the run is a violation that blocks the review", async (t) => {
  const runId = `secret-${process.pid}-${Date.now().toString(36)}`;
  const { repo, home } = await makeDispatchRepo(t, { sessionId: "sess-secret" });
  rearmStub({
    sessionId: "sess-secret",
    writeUsage: { session_id: "sess-secret", model: DEFAULT_MODEL, provider: "opencode-go", failed: false },
    payload: {
      first: { file: ".env", content: "TOKEN=please-do-not-keep\n" },
      later: { file: ".env", content: "TOKEN=please-do-not-keep\n" },
      marker: path.join(home, "secret-marker"),
    },
    writeAutoApplied: true,
  });
  process.env.HERMES_HOME = home;
  // Ignored, so the tree diff can never see it: only the status listing can catch it.
  fs.appendFileSync(path.join(repo, ".git", "info", "exclude"), ".env\n", "utf8");

  const result = (await dispatchHermesTask({
    cwd: repo,
    prompt: "Write the environment file.",
    runId,
    fastWaitSeconds: 120,
  })) as DispatchResult;

  assert.equal(result.securityViolation, true, result.message);
  assert.equal(result.success, false);
  assert.ok(
    result.violations.some((violation) => violation.includes(".env")),
    `the violation must name the file: ${JSON.stringify(result.violations)}`,
  );
  assert.match(result.message, /Security violation/);
  assert.equal(result.changesKept, false);
  // The tree-scoped revert still removes the tracked work the run did alongside the secret.
  assert.equal(fs.existsSync(path.join(repo, "auto-applied.ts")), false);
  // The secret is the thing the violation is about, and no snapshot tree can hold it: leaving it on
  // disk means the checkout still carries the credential the dispatch reported as reverted.
  assert.equal(fs.existsSync(path.join(repo, ".env")), false, "the secret must not survive the revert");
});

/**
 * A blocked path the run overwrote was in the checkout before it ran, so the revert must not delete
 * it: the file that existed is the caller's, and the dispatch has to say the bytes are not restored.
 */
test("a blocked path the run overwrote is kept and reported as unrestorable", async (t) => {
  const runId = `secretover-${process.pid}-${Date.now().toString(36)}`;
  const { repo, home } = await makeDispatchRepo(t, { sessionId: "sess-secret-over" });
  const credential = path.join(repo, "credentials.json");
  fs.writeFileSync(credential, '{"client_email":"caller@example.invalid"}\n', "utf8");
  await git(repo, ["add", "credentials.json"]);
  await git(repo, ["commit", "-m", "track a service account"]);

  rearmStub({
    sessionId: "sess-secret-over",
    writeUsage: {
      session_id: "sess-secret-over",
      model: DEFAULT_MODEL,
      provider: "opencode-go",
      failed: false,
    },
    payload: {
      first: { file: "credentials.json", content: '{"client_email":"stolen@example.invalid"}\n' },
      later: { file: "credentials.json", content: '{"client_email":"stolen@example.invalid"}\n' },
      marker: path.join(home, "secret-over-marker"),
    },
    writeAutoApplied: true,
  });
  process.env.HERMES_HOME = home;

  const result = (await dispatchHermesTask({
    cwd: repo,
    prompt: "Rewrite the service account.",
    runId,
    fastWaitSeconds: 120,
  })) as DispatchResult;

  assert.equal(result.securityViolation, true, result.message);
  // Deleting it would lose the caller's file outright: the trap this guard exists for.
  assert.equal(fs.existsSync(credential), true, "a blocked path that already existed is not the run's to delete");
  assert.match(result.message, /cannot restore: credentials\.json/);
  assert.equal(fs.existsSync(path.join(repo, "auto-applied.ts")), false, "the run's tracked work is still reverted");
});

/**
 * The revert deletes blocked paths by name, so the scope matters as much as the delete: a secret that
 * was already in the checkout is the caller's, and dropping it would be worse than the violation.
 */
test("the revert removes only the blocked paths the run created", async (t) => {
  const runId = `secretkeep-${process.pid}-${Date.now().toString(36)}`;
  const { repo, home } = await makeDispatchRepo(t, { sessionId: "sess-secret-keep" });
  rearmStub({
    sessionId: "sess-secret-keep",
    writeUsage: {
      session_id: "sess-secret-keep",
      model: DEFAULT_MODEL,
      provider: "opencode-go",
      failed: false,
    },
    payload: {
      first: { file: ".npmrc", content: "//registry.example/:_authToken=stolen\n" },
      later: { file: ".npmrc", content: "//registry.example/:_authToken=stolen\n" },
      marker: path.join(home, "secret-keep-marker"),
    },
    writeAutoApplied: true,
  });
  process.env.HERMES_HOME = home;
  fs.appendFileSync(path.join(repo, ".git", "info", "exclude"), ".env\n.npmrc\n", "utf8");
  const callerSecret = path.join(repo, ".env");
  fs.writeFileSync(callerSecret, "REAL=production-token\n", "utf8");

  const result = (await dispatchHermesTask({
    cwd: repo,
    prompt: "Write the registry credentials.",
    runId,
    fastWaitSeconds: 120,
  })) as DispatchResult;

  assert.equal(result.securityViolation, true, result.message);
  assert.equal(fs.existsSync(path.join(repo, ".npmrc")), false, "the secret the run wrote is removed");
  assert.equal(
    fs.readFileSync(callerSecret, "utf8"),
    "REAL=production-token\n",
    "a secret that was already there is not the run's to delete",
  );
});

/**
 * 'close' waits for every holder of the child's stdout/stderr pipes, so a detached grandchild that
 * inherited them can keep it away forever. The exit event is the only proof the run itself is over.
 */
test("a run whose child leaves a grandchild on the stream still settles", async (t) => {
  const runId = `leak-${process.pid}-${Date.now().toString(36)}`;
  const pidFile = path.join(os.tmpdir(), `hermes-worker-leak-${runId}.pid`);
  const previousPidFile = process.env.HCLI_LEAK_PID_FILE;
  process.env.HCLI_LEAK_PID_FILE = pidFile;
  t.after(() => {
    if (previousPidFile === undefined) delete process.env.HCLI_LEAK_PID_FILE;
    else process.env.HCLI_LEAK_PID_FILE = previousPidFile;
    try {
      const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
      if (Number.isFinite(pid) && pid > 0) process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
    fs.rmSync(pidFile, { force: true });
  });
  const { repo } = await makeDispatchRepo(t, { leakStdoutMs: 25_000 });

  const startedAt = Date.now();
  const result = (await dispatchHermesTask({
    cwd: repo,
    prompt: "Add auto-applied.ts to the repository root.",
    runId,
    fastWaitSeconds: 120,
  })) as DispatchResult;
  const elapsed = Date.now() - startedAt;

  assert.equal(result.success, true, result.message);
  assert.equal(result.changesKept, true);
  assert.ok(elapsed < 12_000, `the dispatch waited out the leaked stream handle (${elapsed}ms)`);
});

/**
 * A cancellation is a terminal record written from another process, so the dispatcher reads it
 * rather than remembering it. A `running` record queued before that write must not land after it:
 * the pipeline would then diff a checkout the cancel is reverting.
 */
test("a cancelled record is never downgraded by a late running publish", async (t) => {
  const runId = `downgrade-${process.pid}-${Date.now().toString(36)}`;
  const { repo } = await makeDispatchRepo(t, { sleepMs: 6_000 });
  t.after(() => clearRunState(runId));

  // What manageWorktree('cancel') writes: the run is settled from outside the dispatcher.
  const started = {
    status: "running" as const,
    runId,
    sessionName: "s",
    repoRoot: repo,
    baselineTreeSha: "tree",
    startedAt: Date.now(),
  };
  const terminal = {
    ...started,
    status: "completed" as const,
    result: { success: false, cancelled: true, message: "Cancelled: killed the run's process tree.", timedOut: false },
  };
  await writeRunState(started);

  const realWriteFile = fsp.writeFile.bind(fsp);
  const stateTarget = path.resolve(`${runStatePath(runId)}.tmp`);
  const handle = mock.method(fsp, "writeFile", async (target: unknown, data: unknown, options?: unknown) => {
    if (path.resolve(String(target)) === stateTarget && String(data).includes('"status":"running"')) {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
    return realWriteFile(
      target as Parameters<typeof fsp.writeFile>[0],
      data as Parameters<typeof fsp.writeFile>[1],
      options as Parameters<typeof fsp.writeFile>[2],
    );
  });
  t.after(() => handle.mock.restore());

  const dispatched = dispatchHermesTask({
    cwd: repo,
    prompt: "Add auto-applied.ts to the repository root.",
    runId,
    fastWaitSeconds: 0.2,
  });
  // The dispatch's own `running` writes are still queued when the cancel record lands.
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  await writeRunState(terminal);

  // Outlast the child, so the queued writes and the pipeline have both settled.
  await new Promise((resolve) => setTimeout(resolve, 8_000));
  const outcome = await dispatched;
  assert.equal(outcome.runId, runId);

  const after = readRunState(runId);
  assert.equal(after?.status, "completed", "a terminal record must never be downgraded to running");
  assert.equal(
    (after?.result as { cancelled?: unknown } | undefined)?.cancelled,
    true,
    "the cancel verdict must survive the queued running write",
  );
});

// ---------------------------------------------------------------------------------------------
// The run registry and the wait CLI (architecture-neutral)
// ---------------------------------------------------------------------------------------------

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

  // The count is global to a directory every test process prunes, so only the outcomes are this
  // test's to assert.
  await pruneStaleRuns(60 * 60 * 1000);
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
    repoRoot: "/repo",
    baselineTreeSha: "tree-old",
    startedAt: 1_000,
  });
  await writeRunState({
    status: "running",
    runId: newer,
    sessionName: "s",
    repoRoot: "/repo",
    baselineTreeSha: "tree-new",
    startedAt: 2_000,
  });
  await writeRunState({
    status: "completed",
    runId: finished,
    sessionName: "s",
    repoRoot: "/repo",
    baselineTreeSha: "tree-done",
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
  assert.equal(listed[0].baselineTreeSha, "tree-new", "the whole record is returned, not just the id");
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
    repoRoot: "/repo",
    baselineTreeSha: "tree",
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
    repoRoot: "/repo",
    baselineTreeSha: "tree",
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
  assert.match(output.stdout, /\| tokens \| input 100 · output 20 · cache_read 5 · reasoning 0 · total 125 \|/);
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
    repoRoot: "/repo",
    baselineTreeSha: "tree",
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
    message: "2 file(s) changed in /repo.",
    tokens: { input: 300, output: 40, cache_read: 7 },
  };
  await writeRunState({
    status: "completed",
    runId,
    sessionName: "s",
    repoRoot: "/repo",
    baselineTreeSha: "tree",
    startedAt: Date.now(),
    result,
  });
  t.after(() => fs.rmSync(statePath, { force: true }));

  const output = await run(process.execPath, ["--import", "tsx", "src/wait.ts", runId], {
    cwd: path.resolve(import.meta.dirname, ".."),
    timeoutMs: 20_000,
  });
  assert.equal(output.code, 0, output.stderr);
  assert.match(output.stdout, /\| tokens \| input 300 · output 40 · cache_read 7 · reasoning 0 · total 347 \|/);
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
    repoRoot: "/repo",
    baselineTreeSha: "tree",
    startedAt: Date.now(),
    result: { success: true, durationMs: 1_000, tokens: { total: 999, input: 10, output: 5 } },
  });
  const second = await run(process.execPath, ["--import", "tsx", "src/wait.ts", runId], {
    cwd: path.resolve(import.meta.dirname, ".."),
    timeoutMs: 20_000,
  });
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /\| tokens \| input 10 · output 5 · cache_read 0 · reasoning 0 · total 999 \|/);
  assert.equal(
    second.stdout.includes("[Hermes Summary]"),
    false,
    "a run without a summary must not print an empty header",
  );
});

test("wait.js fails immediately when the worker pid is already dead", async (t) => {
  const runId = `test-dead-${process.pid}-${Date.now().toString(36)}`;
  await writeRunState({
    status: "running",
    runId,
    sessionName: "s",
    repoRoot: "/repo",
    baselineTreeSha: "tree",
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
  // The record still names the boundary that holds the work, so it survives the report.
  assert.notEqual(readRunState(runId), null, "an abandoned run's record must not be cleared");
});

test("wait.js reports the model in the telemetry table and the files, warning and pending writes in the detail", async (t) => {
  const runId = `test-detail-${process.pid}-${Date.now().toString(36)}`;
  await writeRunState({
    status: "completed",
    runId,
    sessionName: "s",
    repoRoot: "/repo",
    baselineTreeSha: "tree",
    startedAt: Date.now(),
    result: {
      success: true,
      durationMs: 1_000,
      message: "2 file(s) changed in /repo.",
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
    repoRoot: "/repo",
    baselineTreeSha: "tree",
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

test("wait.js refuses a path-traversing run id", async () => {
  const output = await run(process.execPath, ["--import", "tsx", "src/wait.ts", "../../evil"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    timeoutMs: 20_000,
  });
  assert.notEqual(output.code, 0);
  assert.match(output.stderr, /invalid run id/);
});

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

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

test("runMetadata sums Hermes' bare token keys and pads every segment", () => {
  const bare = runMetadata({
    durationMs: 1_000,
    sessionId: null,
    tokens: { input: 50, output: 10, cache_read: 5 },
  });
  assert.equal(bare.brackets, " [tokens: 65]");

  // `total` short-circuits the parts, exactly as `total_tokens` does.
  const explicit = runMetadata({ durationMs: 0, sessionId: null, tokens: { total: 500, input: 1 } });
  assert.equal(explicit.brackets, " [tokens: 500]");

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

  // A zeroed or empty usage record is no count at all.
  assert.equal(
    runMetadata({ durationMs: null, sessionId: "s", tokens: { input_tokens: 0 } }).brackets,
    " [session: s]",
  );
});

test("the session id is parsed off stderr before the stream reports one", () => {
  assert.equal(parseSessionIdLine("Session: 20261113_173352_f15a8a"), "20261113_173352_f15a8a");
  assert.equal(parseSessionIdLine("  Session: abc123  "), "abc123");
  // The gateway prints "session_id: ..." after the turn: that line must not be mistaken for it.
  assert.equal(parseSessionIdLine("session_id: other"), null);
  assert.equal(parseSessionIdLine("Warning: Session: bogus"), null);
  assert.equal(parseSessionIdLine(""), null);
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

test("isPidAlive proves a live pid and rejects a dead or absent one", async () => {
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
    repoRoot: "/repo",
    baselineTreeSha: "tree",
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
    repoRoot: "/repo",
    baselineTreeSha: "tree-a",
    startedAt: 2,
    workerPid: 2_147_483_647,
  });
  await writeRunState({
    status: "running",
    runId: legacy,
    sessionName: "s",
    repoRoot: "/repo",
    baselineTreeSha: "tree-l",
    startedAt: 1,
  });

  const listed = listActiveRuns().filter((state) => state.runId.endsWith(stamp));
  assert.deepEqual(
    listed.map((state) => state.runId),
    [legacy],
    "a dead worker is not an active run, but a record without a pid still is",
  );
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
    repoRoot: "/repo",
    baselineTreeSha: "tree",
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

// ---------------------------------------------------------------------------------------------
// The session store: read through Hermes' own Python
// ---------------------------------------------------------------------------------------------

const SESSIONS_SCHEMA = `CREATE TABLE sessions (
  id TEXT PRIMARY KEY, title TEXT, model TEXT, started_at INTEGER,
  message_count INTEGER, tool_call_count INTEGER, cwd TEXT, git_repo_root TEXT
)`;

const seedSessions = (home: string, rows: Array<[string, string | null, number, string | null]>): void => {
  const db = new DatabaseSync(path.join(home, "state.db"));
  db.exec(SESSIONS_SCHEMA);
  const insert = db.prepare(
    "INSERT INTO sessions (id, title, model, started_at, message_count, tool_call_count, cwd, git_repo_root) VALUES (?,?,?,?,?,?,?,?)",
  );
  for (const [id, model, startedAt, cwd] of rows) insert.run(id, "t", model, startedAt, 0, 0, cwd, cwd);
  db.close();
};

test("an absent session store lists nothing and is never created", async (t) => {
  const { home, available } = await makeBridgeHome(t);
  assert.equal(fs.existsSync(path.join(home, "state.db")), false, "the fixture must start empty");

  assert.deepEqual(await listHermesSessions({ limit: 5 }), []);
  assert.equal(
    fs.existsSync(path.join(home, "state.db")),
    false,
    "a read must not leave an empty store in the user's Hermes home",
  );
  // `available` only says whether the bridge could run: an absent store short-circuits before it.
  assert.equal(typeof available, "boolean");
});

test("listHermesSessions scopes to a cwd prefix without treating it as a pattern", async (t) => {
  const { home, available } = await makeBridgeHome(t);
  if (!available) return;

  const root = path.join(home, "proj_50%off");
  seedSessions(home, [
    ["exact", "m", 5, root],
    ["child", "m", 4, path.join(root, "sub")],
    // `_` and `%` are LIKE wildcards: unescaped, both of these would match.
    ["wildcard-underscore", "m", 3, path.join(home, "projX50Xoff", "sub")],
    ["wildcard-percent", "m", 2, path.join(home, "proj_50anything", "sub")],
    ["unrelated", "m", 1, path.join(home, "other")],
  ]);

  const rows = await listHermesSessions({ cwd: root, limit: 50 });
  assert.deepEqual(
    rows.map((row) => row.id).sort(),
    ["child", "exact"],
    `LIKE escaping must keep the prefix literal, got ${JSON.stringify(rows.map((row) => row.id))}`,
  );
  // The listing carries the fields the caller renders, newest first.
  assert.equal(rows[0].id, "exact");
  assert.equal(typeof rows[0].started_at, "number");
});

test("listHermesSessions matches a differently-cased cwd on Windows only", async (t) => {
  const { home, available } = await makeBridgeHome(t);
  if (!available) return;

  const root = path.join(home, "Proj");
  seedSessions(home, [["cased", "m", 1, root.toUpperCase()]]);

  const rows = await listHermesSessions({ cwd: root, limit: 5 });
  if (!isWindows) {
    assert.deepEqual(rows.map((row) => row.id), [], "case is significant where the filesystem says so");
    return;
  }
  assert.deepEqual(
    rows.map((row) => row.id),
    ["cased"],
    "a session anchored at the same path in another case is the same repository",
  );
});

test("a corrupt session store fails with a named error instead of an opaque one", async (t) => {
  const { home } = await makeBridgeHome(t);
  fs.writeFileSync(path.join(home, "state.db"), "not a database", "utf8");

  await assert.rejects(
    listHermesSessions({ limit: 5 }),
    /Could not read Hermes sessions from/,
    "a store the bridge cannot read must name itself, not leak a sqlite error",
  );
});

test("readSessionAfterRun reads the row through the bridge and never creates a store", async (t) => {
  const { home, available } = await makeBridgeHome(t);

  // No store at all: reported as unknown, and nothing may be created for the next reader.
  const missing = await readSessionAfterRun("sess-missing", home);
  assert.equal(missing.known, false);
  assert.equal(missing.compactionCount, 0);
  assert.equal(missing.tipSessionId, "sess-missing", "the requested id is the tip when nothing says otherwise");
  assert.equal(fs.existsSync(path.join(home, "state.db")), false, "a read must not create state.db");

  if (!available) return;

  const db = new DatabaseSync(path.join(home, "state.db"));
  db.exec(SESSIONS_SCHEMA);
  db.exec("ALTER TABLE sessions ADD COLUMN model_config TEXT");
  db.prepare(
    "INSERT INTO sessions (id, title, model, started_at, message_count, tool_call_count, cwd, git_repo_root, model_config) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(
    "sess-known",
    "t",
    DEFAULT_MODEL,
    1,
    0,
    0,
    home,
    home,
    JSON.stringify({ gateway_runtime: { provider: "opencode-go" } }),
  );
  db.close();

  const known = await readSessionAfterRun("sess-known", home);
  assert.equal(known.known, true, "a row with a model is a known session");
  assert.equal(known.model, DEFAULT_MODEL);
  assert.equal(known.provider, "opencode-go");
  assert.equal(known.fallbackActive, false);
});
