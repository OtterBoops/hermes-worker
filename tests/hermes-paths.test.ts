import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isWindows, run } from "../src/exec.js";
import {
  hermesCommand,
  hermesExe,
  pythonCandidates,
  readHermesEnv,
  resolveHermesPython,
} from "../src/hermes-paths.js";

/** HERMES_HOME, HERMES_BIN and HERMES_PYTHON are this module's only mutable inputs. */
const withHome = (t: TestContext): string => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-paths-"));
  const previous = {
    home: process.env.HERMES_HOME,
    bin: process.env.HERMES_BIN,
    python: process.env.HERMES_PYTHON,
  };
  process.env.HERMES_HOME = home;
  delete process.env.HERMES_BIN;
  delete process.env.HERMES_PYTHON;
  t.after(() => {
    if (previous.home === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = previous.home;
    if (previous.bin === undefined) delete process.env.HERMES_BIN;
    else process.env.HERMES_BIN = previous.bin;
    if (previous.python === undefined) delete process.env.HERMES_PYTHON;
    else process.env.HERMES_PYTHON = previous.python;
    fs.rmSync(home, { recursive: true, force: true });
  });
  return home;
};

test("readHermesEnv strips only a matched quote pair", (t) => {
  const home = withHome(t);
  fs.writeFileSync(
    path.join(home, ".env"),
    [
      "# hermes auth writes plain KEY=value lines",
      "OTHER=1",
      "OPENCODE_GO_API_KEY=oc_sk_plain",
      'QUOTED_DOUBLE="oc_sk_double"',
      "QUOTED_SINGLE='oc_sk_single'",
      "TRAILING_QUOTE=oc_sk_tail'",
      'UNTERMINATED="oc_sk_open',
      "EMPTY=",
    ].join("\n"),
    "utf8",
  );

  assert.equal(readHermesEnv("OPENCODE_GO_API_KEY"), "oc_sk_plain");
  assert.equal(readHermesEnv("QUOTED_DOUBLE"), "oc_sk_double");
  assert.equal(readHermesEnv("QUOTED_SINGLE"), "oc_sk_single");
  // A quote that has no partner is part of the value: stripping it would corrupt the key.
  assert.equal(readHermesEnv("TRAILING_QUOTE"), "oc_sk_tail'");
  assert.equal(readHermesEnv("UNTERMINATED"), '"oc_sk_open');
  assert.equal(readHermesEnv("EMPTY"), null);
  assert.equal(readHermesEnv("ABSENT"), null);
});

test("readHermesEnv returns null when there is no .env", (t) => {
  withHome(t);
  assert.equal(readHermesEnv("OPENCODE_GO_API_KEY"), null);
});

test("hermesCommand runs a script-shaped HERMES_BIN through node", (t) => {
  const home = withHome(t);
  const bin = path.join(home, "hermes-entry.js");
  fs.writeFileSync(bin, "", "utf8");
  process.env.HERMES_BIN = bin;

  // Windows cannot exec a .js entrypoint, so the running node is the interpreter.
  assert.deepEqual(hermesCommand(), { file: process.execPath, prefixArgs: [bin] });
});

test("hermesCommand spawns a native bin as itself", (t) => {
  const home = withHome(t);
  const bin = path.join(home, "hermes.exe");
  fs.writeFileSync(bin, "", "utf8");
  process.env.HERMES_BIN = bin;

  assert.deepEqual(hermesCommand(), { file: bin, prefixArgs: [] });
  assert.deepEqual(hermesCommand(), { file: hermesExe(), prefixArgs: [] });
});

test("hermesCommand sends a .cmd wrapper through the command interpreter, and it runs", async (t) => {
  if (!isWindows) return;
  const home = withHome(t);
  // A space in the path proves the spawn quoting, and a .cmd cannot be spawned without a shell.
  const dir = path.join(home, "hermes bin");
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, "hermes wrapper.cmd");
  fs.writeFileSync(bin, "@echo off\r\necho RAN=%~1 %~2\r\nexit /b 0\r\n", "utf8");
  process.env.HERMES_BIN = bin;

  const command = hermesCommand();
  assert.equal(path.basename(command.file).toLowerCase(), "cmd.exe");
  assert.deepEqual(command.prefixArgs.slice(0, 2), ["/d", "/c"]);
  assert.equal(command.prefixArgs[2], bin);

  const result = await run(command.file, [...command.prefixArgs, "project", "create"], {
    timeoutMs: 30_000,
  });
  assert.equal(result.code, 0, `the wrapper must run: ${result.error ?? result.stderr}`);
  assert.match(result.stdout, /RAN=project create/);
});

test("pythonCandidates prefers HERMES_PYTHON, then a venv interpreter, then the store", (t) => {
  const home = withHome(t);
  const venv = path.join(
    home,
    "installs",
    "install-a",
    "environments",
    "env-a",
    "venv",
    isWindows ? "Scripts" : "bin",
    isWindows ? "python.exe" : "python3",
  );
  const store = path.join(
    home,
    "tools",
    "python-3.12",
    isWindows ? "python.exe" : path.join("bin", "python3"),
  );
  fs.mkdirSync(path.dirname(venv), { recursive: true });
  fs.mkdirSync(path.dirname(store), { recursive: true });
  fs.writeFileSync(venv, "", "utf8");
  fs.writeFileSync(store, "", "utf8");

  const candidates = pythonCandidates();
  assert.deepEqual(candidates, [venv, store], "the venv carries the wheels, so it comes first");

  const explicit = path.join(home, "python-custom.exe");
  process.env.HERMES_PYTHON = explicit;
  assert.deepEqual(pythonCandidates(), [explicit, venv, store]);
});

test("a failed interpreter probe is not memoised as a failure", async (t) => {
  const home = withHome(t);
  await assert.rejects(resolveHermesPython(), /No Hermes Python interpreter/);

  // A retry sees the current environment: the earlier rejection was never cached.
  const missing = path.join(home, "nope-python.exe");
  process.env.HERMES_PYTHON = missing;
  await assert.rejects(resolveHermesPython(), /nope-python\.exe/);
});
