import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { killProcessTree, run } from "../src/exec.js";
import { isPidAlive } from "../src/run-registry.js";

const TRUNCATION_MARKER = "[output truncated at 16MB]";
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitForDeath = async (pid: number, budgetMs: number): Promise<boolean> => {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await sleep(50);
  }
  return !isPidAlive(pid);
};

test("a truncation cut never fabricates a replacement character", async () => {
  // 6M euro signs are 18MB of 3-byte codepoints: the 16MB byte cap always lands inside one of them.
  const result = await run(process.execPath, ["-e", 'process.stdout.write("€".repeat(6000000))']);
  assert.equal(result.code, 0);
  assert.ok(result.stdout.length > 0);
  assert.equal(
    result.stdout.includes("\uFFFD"),
    false,
    "a byte cap that splits a codepoint emits U+FFFD instead of dropping the partial character",
  );
  assert.ok(result.stdout.endsWith(TRUNCATION_MARKER), "the truncation is marked");
  const kept = Buffer.byteLength(result.stdout, "utf8") - Buffer.byteLength(`\n${TRUNCATION_MARKER}`, "utf8");
  assert.ok(kept <= MAX_BUFFER_BYTES, `kept ${kept} bytes, cap is ${MAX_BUFFER_BYTES}`);
  assert.ok(kept > MAX_BUFFER_BYTES - 4, "the cap is filled, not abandoned early");
});

test("killProcessTree still kills the child when taskkill cannot be spawned", async (t) => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  t.after(() => {
    try {
      process.kill(child.pid as number, "SIGKILL");
    } catch {
      // already gone
    }
  });
  assert.ok(child.pid);
  await sleep(300);

  // A host whose PATH cannot resolve taskkill is the case where the error handler is the only kill.
  const savedPath = process.env.PATH;
  const savedPathExt = process.env.PATHEXT;
  process.env.PATH = "C:\\hermes-worker-no-such-dir";
  try {
    killProcessTree(child.pid);
  } finally {
    process.env.PATH = savedPath;
    process.env.PATHEXT = savedPathExt;
  }

  assert.equal(await waitForDeath(child.pid, 5_000), true, "a failed taskkill spawn must not read as a kill");
});

test("run accepts a multibyte stream split across chunk boundaries", async () => {
  const result = await run(process.execPath, ["-e", 'process.stdout.write("héllo wörld ✓".repeat(1000))']);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "héllo wörld ✓".repeat(1000));
});

test("run settles on a spawn error and clears the timeout it armed", async () => {
  const started = Date.now();
  const result = await run("hermes-worker-no-such-binary", [], { timeoutMs: 60_000 });
  const elapsed = Date.now() - started;
  assert.equal(result.code, null);
  assert.equal(result.timedOut, false);
  assert.match(result.error ?? "", /ENOENT/);
  assert.ok(elapsed < 5_000, `settled after ${elapsed}ms: a spawn error leaves no timeout pending`);
});

test("run reports timedOut even when the child ignores termination", async () => {
  const started = Date.now();
  const result = await run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 300 });
  const elapsed = Date.now() - started;
  assert.equal(result.timedOut, true);
  assert.equal(result.error, undefined, "a timeout is a timeout, not a spawn failure");
  assert.ok(elapsed < 10_000, `settled after ${elapsed}ms instead of waiting for a close that never comes`);
});

test("run captures the whole stdout of a child that exits immediately", async () => {
  const size = 8 * 1024 * 1024;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await run(process.execPath, ["-e", `process.stdout.write("x".repeat(${size}))`]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout.length, size, `the exit grace window dropped output on attempt ${attempt}`);
  }
});

test("run keeps stderr and a non-zero exit without throwing", async () => {
  const result = await run(process.execPath, [
    "-e",
    'process.stdout.write("out"); process.stderr.write("boom"); process.exit(3)',
  ]);
  assert.equal(result.code, 3);
  assert.equal(result.stdout, "out");
  assert.equal(result.stderr, "boom");
  assert.equal(result.timedOut, false);
  assert.equal(result.error, undefined);
});
