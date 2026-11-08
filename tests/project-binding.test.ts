import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileUriToPath, resolveAntigravityProject } from "../src/project-binding.js";
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
