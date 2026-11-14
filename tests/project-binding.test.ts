import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isWindows, run } from "../src/exec.js";
import {
  fileUriToPath,
  isAncestor,
  normalizeForCompare,
  resolveAntigravityProject,
} from "../src/project-binding.js";
import { projectsDbPath } from "../src/hermes-paths.js";

test("decodes Antigravity workspace URIs into filesystem paths", () => {
  assert.equal(fileUriToPath("file:///d%3A/Code/OtterBoops/agylity"), "D:\\Code\\OtterBoops\\agylity");
  assert.equal(fileUriToPath("file:///d%3A/Code/Otterooni/ottr.space"), "D:\\Code\\Otterooni\\ottr.space");
  assert.equal(fileUriToPath("file:///C%3A/Users/Otter"), "C:\\Users\\Otter");
});

/** A machine without the project row is a fixture absence, not a resolver failure. */
const projectExists = (id: string): boolean => {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(projectsDbPath(), { readOnly: true });
    const row = db.prepare("SELECT 1 AS present FROM projects WHERE id = ?").get(id);
    return Boolean(row);
  } catch {
    return false;
  } finally {
    db?.close();
  }
};

test("binds D:\\Code\\OtterBoops\\agylity to the agylity Hermes project", async () => {
  if (!projectExists("p_505dc8d1")) return;
  const resolved = await resolveAntigravityProject({ cwd: "D:\\Code\\OtterBoops\\agylity" });
  assert.equal(resolved.hermesProjectId, "p_505dc8d1");
  assert.equal(resolved.hermesProjectSlug, "agylity");
  assert.equal(resolved.provisioned, false);
  assert.equal(resolved.repoRoot, "D:\\Code\\OtterBoops\\agylity");
});

test("binds D:\\Code\\OtterBoops\\compose to the ottbox Hermes project", async () => {
  if (!projectExists("p_bd26f85f")) return;
  const resolved = await resolveAntigravityProject({ cwd: "D:\\Code\\OtterBoops\\compose" });
  assert.equal(resolved.hermesProjectId, "p_bd26f85f");
  assert.equal(resolved.hermesProjectSlug, "ottbox");
});

test("binds D:\\Code\\OtterBoops\\hermes-worker to its own project", async () => {
  if (!projectExists("p_f52dbfd9")) return;
  const resolved = await resolveAntigravityProject({ cwd: "D:\\Code\\OtterBoops\\hermes-worker" });
  assert.equal(resolved.hermesProjectId, "p_f52dbfd9");
  assert.equal(resolved.hermesProjectSlug, "hermes-worker");
});

test("a subdirectory resolves to the owning project and its repository root", async () => {
  if (!projectExists("p_f52dbfd9")) return;
  const resolved = await resolveAntigravityProject({
    cwd: "D:\\Code\\OtterBoops\\hermes-worker\\src",
  });
  assert.equal(resolved.hermesProjectId, "p_f52dbfd9");
  assert.equal(resolved.repoRoot, "D:\\Code\\OtterBoops\\hermes-worker");
});

test("a call with no project evidence is rejected instead of guessed", async () => {
  await assert.rejects(resolveAntigravityProject({}), /Could not determine a repository root/);
});

test("the agylity workspace JSON is matched by folder, not by name", async () => {
  if (!fs.existsSync(fileUriToPath("file:///C%3A/Users/Otter/.gemini/config/projects"))) return;
  if (!projectExists("p_505dc8d1")) return;
  const resolved = await resolveAntigravityProject({ cwd: "D:\\Code\\OtterBoops\\agylity" });
  assert.ok(resolved.antigravityProjectId, "the agylity workspace should have a project JSON");
  assert.equal(resolved.antigravityProjectName, "agylity");
});

test("UNC workspace URIs keep their authority as a share", () => {
  assert.equal(fileUriToPath("file://server/share/path"), "\\\\server\\share\\path");
  assert.equal(fileUriToPath("file://server/share/path/"), "\\\\server\\share\\path");
  assert.equal(fileUriToPath("file:///d%3A/Code/OtterBoops/agylity"), "D:\\Code\\OtterBoops\\agylity");
  // A drive-letter authority is a path, not a host.
  assert.equal(fileUriToPath("file://C%3A/Users/Otter"), "C:\\Users\\Otter");
});

test("a malformed percent-escape is an error, not a silently raw string", () => {
  assert.throws(() => fileUriToPath("file:///d%3A/bad%ZZ"), /percent-encoding/);
});

test("a drive-root workspace URI keeps the root separator instead of going drive-relative", () => {
  // `D:` is the process's current directory on D:, not the root, so it must never come back bare.
  assert.equal(fileUriToPath("file:///d:"), "D:\\");
  assert.equal(fileUriToPath("file:///d:/"), "D:\\");
  assert.equal(fileUriToPath("file:///d%3A"), "D:\\");
  assert.equal(fileUriToPath("file:///d%3A/"), "D:\\");
  if (isWindows) assert.equal(path.resolve(fileUriToPath("file:///d%3A")), path.resolve("D:\\"));
});

test("normalizeForCompare keeps a filesystem root, and the root is an ancestor of everything under it", () => {
  const root = isWindows ? "\\" : "/";
  const parent = isWindows ? "D:\\Code\\" : "/code/";
  const child = isWindows ? "D:/Code/proj" : "/code/proj";
  assert.equal(normalizeForCompare(root), root);
  assert.equal(normalizeForCompare(parent), isWindows ? "d:\\code" : "/code");
  assert.equal(isAncestor(normalizeForCompare(parent), normalizeForCompare(child)), true);
  assert.equal(isAncestor(root, isWindows ? "\\code" : "/code"), true);
  // A sibling that merely shares a prefix is not a child.
  assert.equal(
    isAncestor(normalizeForCompare(isWindows ? "D:\\alpha" : "/alpha"), normalizeForCompare(isWindows ? "D:\\alpha2" : "/alpha2")),
    false,
  );
});

/** Identity so git can commit inside a throwaway repository without a global config. */
const GIT_IDENTITY = {
  ...process.env,
  GIT_AUTHOR_NAME: "hermes-worker test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "hermes-worker test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
};

const git = async (cwd: string, args: string[]): Promise<void> => {
  const result = await run("git", args, { cwd, env: GIT_IDENTITY, timeoutMs: 60_000 });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr || result.stdout}`);
};

/** A one-commit repository under the OS temp dir (or at `at`), so no real project can be involved. */
const makeTempRepo = async (t: TestContext, at?: string): Promise<string> => {
  const repo = at ?? fs.mkdtempSync(path.join(os.tmpdir(), "hermes-bind-repo-"));
  fs.mkdirSync(repo, { recursive: true });
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "core.autocrlf", "false"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# fixture\n", "utf8");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "initial"]);
  return fs.realpathSync(repo);
};

interface SeedRow {
  id: string;
  slug: string;
  name: string;
  folderPath?: string;
  primaryPath?: string;
}

const previousHome = process.env.HERMES_HOME;

/** Minimal projects.db: only the columns the resolver reads. */
const makeTempHome = (t: TestContext, rows: SeedRow[]): string => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-bind-home-"));
  t.after(() => {
    if (previousHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(path.join(home, "projects.db"));
    db.exec(
      `CREATE TABLE projects (id TEXT PRIMARY KEY, slug TEXT, name TEXT, primary_path TEXT, archived INTEGER);
       CREATE TABLE project_folders (project_id TEXT, path TEXT);`,
    );
    for (const row of rows) {
      db.prepare(
        "INSERT INTO projects (id, slug, name, primary_path, archived) VALUES (?, ?, ?, ?, 0)",
      ).run(row.id, row.slug, row.name, row.primaryPath ?? null);
      if (row.folderPath) {
        db.prepare("INSERT INTO project_folders (project_id, path) VALUES (?, ?)").run(
          row.id,
          row.folderPath,
        );
      }
    }
  } finally {
    db?.close();
  }

  process.env.HERMES_HOME = home;
  return home;
};

test("a temp repo binds to the Hermes project that owns its folder", async (t) => {
  const repo = await makeTempRepo(t);
  makeTempHome(t, [
    { id: "p_temp_root", slug: "temp-root", name: "Temp Root", folderPath: repo, primaryPath: repo },
    { id: "p_other", slug: "other", name: "Other", folderPath: path.join(os.tmpdir(), "nowhere-else") },
  ]);

  const resolved = await resolveAntigravityProject({ cwd: repo });
  assert.equal(resolved.hermesProjectId, "p_temp_root");
  assert.equal(resolved.hermesProjectSlug, "temp-root");
  assert.equal(resolved.hermesProjectName, "Temp Root");
  assert.equal(resolved.provisioned, false);
  assert.equal(normalizeForCompare(resolved.repoRoot), normalizeForCompare(repo));
});

test("primary_path binds when the project has no folder row", async (t) => {
  const repo = await makeTempRepo(t);
  makeTempHome(t, [{ id: "p_primary", slug: "primary-only", name: "Primary", primaryPath: repo }]);

  const resolved = await resolveAntigravityProject({ cwd: repo });
  assert.equal(resolved.hermesProjectId, "p_primary");
  assert.equal(resolved.provisioned, false);
});

test("a subdirectory cwd resolves to the git toplevel", async (t) => {
  const repo = await makeTempRepo(t);
  makeTempHome(t, [{ id: "p_temp_root", slug: "temp-root", name: "Temp Root", folderPath: repo }]);
  const nested = path.join(repo, "src", "deep", "nest");
  fs.mkdirSync(nested, { recursive: true });

  const resolved = await resolveAntigravityProject({ cwd: nested });
  assert.equal(normalizeForCompare(resolved.repoRoot), normalizeForCompare(repo));
  assert.equal(resolved.hermesProjectId, "p_temp_root");
});

test("a matching slug or name never binds an unrelated directory", async (t) => {
  const repo = await makeTempRepo(t);
  const basename = path.basename(repo);
  makeTempHome(t, [
    {
      id: "p_unrelated",
      slug: basename.toLowerCase(),
      name: basename,
      folderPath: path.join(os.tmpdir(), "some-other-checkout"),
      primaryPath: path.join(os.tmpdir(), "some-other-checkout"),
    },
  ]);

  const resolved = await resolveAntigravityProject({ cwd: repo });
  assert.equal(resolved.hermesProjectId, null, "a same-named project elsewhere must not bind");
  assert.equal(resolved.hermesProjectSlug, null);
  assert.equal(resolved.provisioned, false);
  assert.equal(normalizeForCompare(resolved.repoRoot), normalizeForCompare(repo));
});

test("a non-git directory is rejected instead of provisioned", async (t) => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-bind-plain-"));
  t.after(() => fs.rmSync(plain, { recursive: true, force: true }));
  makeTempHome(t, []);

  // Guard the fixture: on a machine whose temp dir sits inside a repository this case is moot.
  const probe = await run("git", ["rev-parse", "--show-toplevel"], { cwd: plain, timeoutMs: 30_000 });
  if (probe.code === 0) return;

  await assert.rejects(
    resolveAntigravityProject({ cwd: plain }),
    /Could not determine a repository root.*not inside a git repository/s,
  );
});

test("a corrupt projects.db fails the resolution closed", async (t) => {
  const repo = await makeTempRepo(t);
  const home = makeTempHome(t, []);
  fs.writeFileSync(path.join(home, "projects.db"), "this is not a sqlite database\n", "utf8");

  await assert.rejects(resolveAntigravityProject({ cwd: repo }), /Could not read Hermes projects/);
});

test("an absent projects.db is an empty project list, not a failure", async (t) => {
  const repo = await makeTempRepo(t);
  makeTempHome(t, []);

  const resolved = await resolveAntigravityProject({ cwd: repo });
  assert.equal(resolved.hermesProjectId, null);
  assert.equal(resolved.provisioned, false);
  assert.equal(normalizeForCompare(resolved.repoRoot), normalizeForCompare(repo));
});

/**
 * Stands in for `hermes project create`. HERMES_BIN is this Node binary and the extensionless
 * script named `project` makes Node treat the bridge's `project create ...` argv as a script run.
 */
const STUB = [
  'const fs = require("node:fs");',
  'const path = require("node:path");',
  'const { DatabaseSync } = require("node:sqlite");',
  // argv[0] is node, argv[1] this script, so the command starts at index 2.
  'const args = process.argv.slice(3);',
  'const [name, target, flag, slug] = args;',
  'const record = { name, target, flag, slug, cwd: process.cwd(), home: process.env.HERMES_HOME, root: process.env.HERMES_AGENT_ROOT };',
  'fs.writeFileSync(path.join(__dirname, "stub-ran.json"), JSON.stringify(record));',
  'if (process.argv[2] !== "create" || flag !== "--slug" || !slug || !name) process.exit(5);',
  'if (path.resolve(process.cwd()) !== path.resolve(target)) process.exit(3);',
  'if (!record.home || !record.root) process.exit(4);',
  'const db = new DatabaseSync(path.join(record.home, "projects.db"));',
  'db.prepare("INSERT INTO projects (id, slug, name, primary_path, archived) VALUES (?, ?, ?, ?, 0)").run("p_new", slug, name, target);',
  'db.prepare("INSERT INTO project_folders (project_id, path) VALUES (?, ?)").run("p_new", target);',
  "db.close();",
].join("\n");

const installStub = (t: TestContext, repo: string): void => {
  fs.writeFileSync(path.join(repo, "project"), STUB, "utf8");
  const previousBin = process.env.HERMES_BIN;
  t.after(() => {
    if (previousBin === undefined) delete process.env.HERMES_BIN;
    else process.env.HERMES_BIN = previousBin;
  });
  process.env.HERMES_BIN = process.execPath;
};

test("provisioning is explicit, anchored at the repo and reads back by path", async (t) => {
  const repo = await makeTempRepo(t);
  const home = makeTempHome(t, []);
  installStub(t, repo);

  const resolved = await resolveAntigravityProject({ cwd: repo, allowProvision: true });
  assert.equal(resolved.provisioned, true);
  assert.equal(resolved.hermesProjectId, "p_new");
  assert.equal(normalizeForCompare(resolved.repoRoot), normalizeForCompare(repo));

  const record = JSON.parse(fs.readFileSync(path.join(repo, "stub-ran.json"), "utf8")) as {
    cwd: string;
    home: string;
    root: string;
  };
  assert.equal(normalizeForCompare(record.cwd), normalizeForCompare(repo), "create runs at the repo");
  assert.equal(normalizeForCompare(record.home), normalizeForCompare(home), "HERMES_HOME is explicit");
  assert.equal(
    normalizeForCompare(record.root),
    normalizeForCompare(path.join(home, "hermes-agent")),
    "HERMES_AGENT_ROOT is explicit",
  );
});

test("without Antigravity evidence and without allowProvision nothing is created", async (t) => {
  const repo = await makeTempRepo(t);
  const home = makeTempHome(t, []);
  installStub(t, repo);

  const resolved = await resolveAntigravityProject({ cwd: repo });
  assert.equal(resolved.provisioned, false);
  assert.equal(fs.existsSync(path.join(repo, "stub-ran.json")), false, "hermes must not be spawned");

  const db = new DatabaseSync(path.join(home, "projects.db"), { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM projects").get()?.["n"], 0);
  } finally {
    db.close();
  }
});

/** Antigravity writes the drive colon percent-encoded, so the fixture does too. */
const folderUri = (folder: string): string =>
  `file:///${folder.replace(/\\/g, "/").replace(":", "%3A")}`;

const writeWorkspace = (configDir: string, name: string, folders: string[]): void => {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, `${name}.json`),
    JSON.stringify({
      id: `ws-${name}`,
      name,
      projectResources: { resources: folders.map((folder) => ({ gitFolder: { folderUri: folderUri(folder) } })) },
    }),
    "utf8",
  );
};

/** Antigravity's config dir hangs off the home directory, and os.homedir() follows these variables. */
const withFakeHome = (t: TestContext): string => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hermes-bind-profile-")));
  const previousProfile = process.env.USERPROFILE;
  const previousHome = process.env.HOME;
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  t.after(() => {
    if (previousProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousProfile;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });
  return home;
};

test("the deepest matching workspace folder wins over a workspace with a longer folder name", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hermes-bind-ws-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repoRoot = await makeTempRepo(t, path.join(root, "repo"));
  const shallow = path.join(repoRoot, "a");
  const deep = path.join(shallow, "b");
  const cwd = path.join(deep, "src");
  fs.mkdirSync(cwd, { recursive: true });

  const configDir = path.join(withFakeHome(t), ".gemini", "config", "projects");
  // `wide` only reaches the cwd through the shallow folder; its second folder is just longer.
  writeWorkspace(configDir, "wide", [shallow, path.join(root, "z".repeat(80))]);
  writeWorkspace(configDir, "narrow", [deep]);
  makeTempHome(t, [{ id: "p_ws", slug: "ws", name: "Ws", folderPath: repoRoot }]);

  const resolved = await resolveAntigravityProject({ cwd });
  assert.equal(resolved.antigravityProjectName, "narrow", "the deeper folder is the specific workspace");
  assert.equal(resolved.antigravityProjectId, "ws-narrow");
  assert.equal(resolved.hermesProjectId, "p_ws");
  assert.equal(normalizeForCompare(resolved.repoRoot), normalizeForCompare(repoRoot));
});

test("two projects claiming the same folder bind deterministically to the lower id", async (t) => {
  const repoRoot = await makeTempRepo(t);
  makeTempHome(t, [
    { id: "p_zzz", slug: "zzz", name: "Zzz", folderPath: repoRoot },
    { id: "p_aaa", slug: "aaa", name: "Aaa", folderPath: repoRoot },
  ]);

  const resolved = await resolveAntigravityProject({ cwd: repoRoot });
  assert.equal(resolved.hermesProjectId, "p_aaa");
});

test("a slug truncated at 60 characters never ends in a separator", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hermes-bind-slug-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // 59 characters then "-b": the cap lands exactly on the separator that replaces the hyphen.
  const repoRoot = await makeTempRepo(t, path.join(root, `${"slug".padEnd(59, "a")}-b`));
  makeTempHome(t, []);
  installStub(t, repoRoot);

  const resolved = await resolveAntigravityProject({ cwd: repoRoot, allowProvision: true });
  assert.equal(resolved.provisioned, true);
  assert.equal(resolved.hermesProjectSlug?.endsWith("-"), false);
  assert.ok((resolved.hermesProjectSlug ?? "").length <= 60);
});

/** Same stand-in, reached as a script: node puts the bridge's argv at index 2. */
const JS_STUB = [
  'const fs = require("node:fs");',
  'const path = require("node:path");',
  'const { DatabaseSync } = require("node:sqlite");',
  "const [command, sub, name, target, flag, slug] = process.argv.slice(2);",
  'const record = { command, sub, name, target, flag, slug, cwd: process.cwd(), home: process.env.HERMES_HOME };',
  'fs.writeFileSync(path.join(__dirname, "js-stub-ran.json"), JSON.stringify(record));',
  'if (command !== "project" || sub !== "create" || flag !== "--slug" || !name || !slug) process.exit(5);',
  'if (path.resolve(process.cwd()) !== path.resolve(target)) process.exit(3);',
  'if (!record.home) process.exit(4);',
  'const db = new DatabaseSync(path.join(record.home, "projects.db"));',
  'db.prepare("INSERT INTO projects (id, slug, name, primary_path, archived) VALUES (?, ?, ?, ?, 0)").run("p_js", slug, name, target);',
  'db.prepare("INSERT INTO project_folders (project_id, path) VALUES (?, ?)").run("p_js", target);',
  "db.close();",
].join("\n");

test("provisioning runs a script-shaped HERMES_BIN through node", async (t) => {
  const repoRoot = await makeTempRepo(t);
  makeTempHome(t, []);
  const bin = path.join(repoRoot, "hermes-entry.js");
  fs.writeFileSync(bin, JS_STUB, "utf8");
  const previousBin = process.env.HERMES_BIN;
  t.after(() => {
    if (previousBin === undefined) delete process.env.HERMES_BIN;
    else process.env.HERMES_BIN = previousBin;
  });
  process.env.HERMES_BIN = bin;

  const resolved = await resolveAntigravityProject({ cwd: repoRoot, allowProvision: true });
  assert.equal(resolved.provisioned, true);
  assert.equal(resolved.hermesProjectId, "p_js");

  const record = JSON.parse(fs.readFileSync(path.join(repoRoot, "js-stub-ran.json"), "utf8")) as {
    name: string;
    target: string;
    cwd: string;
  };
  assert.equal(record.name, path.basename(repoRoot));
  assert.equal(normalizeForCompare(record.target), normalizeForCompare(repoRoot));
  assert.equal(normalizeForCompare(record.cwd), normalizeForCompare(repoRoot), "create runs at the repo");
});
