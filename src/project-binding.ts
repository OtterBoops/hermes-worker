import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { run, runGit, isWindows } from "./exec.js";
import {
  antigravityConfigDir,
  antigravitySummariesDb,
  hermesAgentRoot,
  hermesCommand,
  hermesHome,
  projectsDbPath,
} from "./hermes-paths.js";
import { runBridge } from "./python-bridge.js";

export interface AntigravityProject {
  id: string;
  name: string;
  folders: string[];
}

export interface ResolvedProject {
  repoRoot: string;
  antigravityProjectId: string | null;
  antigravityProjectName: string | null;
  hermesProjectId: string | null;
  hermesProjectSlug: string | null;
  hermesProjectName: string | null;
  provisioned: boolean;
}

export interface ResolveOptions {
  cwd?: string;
  conversationId?: string;
  project?: string;
  allowProvision?: boolean;
}

/**
 * `file:///d%3A/Code/x` -> `D:\Code\x`. Antigravity percent-encodes the drive colon, so a raw
 * URL left undecoded never matches a filesystem path. A URI with an authority is a UNC share.
 */
export const fileUriToPath = (uri: string): string => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    throw new Error(`Workspace folder URI is not valid percent-encoding: ${uri}`);
  }
  const stripped = decoded.replace(/^file:\/\//i, "");

  // `file://server/share/x` keeps an authority; `file:///d:/x` leaves a leading slash instead.
  // A drive-letter authority (`file://C:/x`) is not a host, so it falls through to the drive path below.
  if (/^file:\/\/[^/]/i.test(decoded) && !/^file:\/\/[a-z]:(\/|$)/i.test(decoded)) {
    const [authority, ...segments] = stripped.split("/");
    const rest = segments.filter((segment) => segment.length > 0);
    if (!isWindows) return `//${[authority, ...rest].join("/")}`;
    const tail = rest.join("\\");
    return tail ? `\\\\${authority}\\${tail}` : `\\\\${authority}`;
  }

  let rest = stripped;
  if (/^\/[a-z]:(\/|$)/i.test(rest)) rest = rest.slice(1);
  if (/^[a-z]:(\/|$)/i.test(rest)) {
    const drive = rest[0].toUpperCase();
    const tail = rest.slice(2).replace(/\/+$/, "").replace(/\//g, "\\");
    // `D:` alone is drive-relative (it means the shell's cwd on D:), so a bare drive must keep its root.
    return tail ? `${drive}:${tail}` : `${drive}:\\`;
  }
  if (/^\/\//.test(rest)) return rest.replace(/\//g, "\\");
  return isWindows ? rest.replace(/\//g, "\\") : rest;
};

/** Case- and separator-insensitive form used for every path comparison. */
export const normalizeForCompare = (value: string): string => {
  const normal = isWindows ? value.replace(/\//g, "\\").toLowerCase() : value.replace(/\/+/g, "/");
  const trimmed = normal.replace(/[\\/]+$/, "");
  // A filesystem root must keep its separator, or "/" normalises to "" and stops being an ancestor.
  return trimmed || normal;
};

export const isAncestor = (folder: string, target: string): boolean => {
  if (target === folder) return true;
  const prefix = /[\\/]$/.test(folder) ? folder : folder + (isWindows ? "\\" : "/");
  return target.startsWith(prefix);
};

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
};

export const loadAntigravityProjects = (): AntigravityProject[] => {
  const dir = antigravityConfigDir();
  if (!fs.existsSync(dir)) return [];
  const projects: AntigravityProject[] = [];

  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const raw = readJson(path.join(dir, file));
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    const resources = (record.projectResources as { resources?: unknown[] } | undefined)?.resources;
    const folders: string[] = [];
    for (const resource of Array.isArray(resources) ? resources : []) {
      const item = resource as Record<string, unknown>;
      const gitFolder = item.gitFolder as { folderUri?: string } | undefined;
      const uri = gitFolder?.folderUri ?? (item.folderUri as string | undefined);
      if (typeof uri !== "string" || !uri.trim()) continue;
      try {
        folders.push(fileUriToPath(uri));
      } catch {
        // One malformed folderUri must not hide every other workspace.
      }
    }
    projects.push({
      id: String(record.id ?? ""),
      name: String(record.name ?? ""),
      folders,
    });
  }
  return projects;
};

const conversationProjectId = (conversationId: string): string | null => {
  const dbPath = antigravitySummariesDb();
  if (!fs.existsSync(dbPath)) return null;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db
      .prepare("SELECT project_id FROM conversation_summaries WHERE conversation_id = ?")
      .get(conversationId) as { project_id?: string } | undefined;
    const id = row?.project_id?.trim();
    return id ? id : null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
};

interface HermesProjectRow {
  id: string;
  slug: string;
  name: string;
  path: string;
}

interface BridgeProjectEntry {
  id: string;
  slug: string;
  name: string;
  primary_path?: string | null;
  folders?: string[];
}

/** A present-but-unreadable store fails the dispatch closed: guessing would provision a duplicate. */
const loadHermesProjects = async (): Promise<HermesProjectRow[]> => {
  const dbPath = projectsDbPath();
  if (!fs.existsSync(dbPath)) return [];
  try {
    const response = await runBridge<{ projects: BridgeProjectEntry[] }>({ op: "projects_list" });
    const seen = new Set<string>();
    const projects: HermesProjectRow[] = [];
    const add = (row: { id: string; slug: string; name: string }, rawPath: string | null | undefined): void => {
      if (!rawPath) return;
      const normal = normalizeForCompare(rawPath);
      const key = `${row.id}\u0000${normal}`;
      if (seen.has(key)) return;
      seen.add(key);
      projects.push({ id: row.id, slug: row.slug, name: row.name, path: normal });
    };

    for (const row of response.projects ?? []) {
      for (const folderPath of row.folders ?? []) add(row, folderPath);
      add(row, row.primary_path);
    }

    return projects;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read Hermes projects from ${dbPath}: ${detail}`);
  }
};

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    // The cap can land on a separator, so the truncation must not leave a trailing hyphen behind.
    .replace(/-+$/, "");

/** Segment count, so a deeper workspace folder outranks one that is merely longer in characters. */
const pathDepth = (folder: string): number =>
  folder.split(/[\\/]+/).filter((segment) => segment.length > 0).length;

/** The deepest folder of `project` that contains `target`, which is the most specific workspace match. */
const deepestWorkspaceFolder = (project: AntigravityProject, target: string): string | undefined =>
  project.folders
    .filter((folder) => isAncestor(normalizeForCompare(folder), target))
    .sort(
      (a, b) =>
        pathDepth(normalizeForCompare(b)) - pathDepth(normalizeForCompare(a)) ||
        a.localeCompare(b),
    )[0];

const provisionHermesProject = async (name: string, repoRoot: string, slug: string): Promise<void> => {
  // hermesCommand(), not hermesExe(): a script-shaped HERMES_BIN cannot be spawned as itself.
  const command = hermesCommand();
  const result = await run(
    command.file,
    [...command.prefixArgs, "project", "create", name, repoRoot, "--slug", slug],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        HERMES_HOME: hermesHome(),
        HERMES_AGENT_ROOT: hermesAgentRoot(),
      },
      timeoutMs: 120_000,
    },
  );
  if (result.code !== 0) {
    throw new Error(
      `hermes project create failed (${result.code}): ${(result.stderr || result.stdout).trim()}`,
    );
  }
};

/** Deepest folder wins; equal-length claims are ordered by id so the same store always answers the same. */
const bestPathMatch = (projects: HermesProjectRow[], target: string): HermesProjectRow | undefined =>
  projects
    .filter((project) => isAncestor(project.path, target))
    .sort((a, b) => b.path.length - a.path.length || a.id.localeCompare(b.id))[0];

/** A subdirectory, worktree or bare cwd must still resolve to the repository it belongs to. */
const gitToplevel = async (candidate: string): Promise<string> => {
  const result = await runGit(candidate, ["rev-parse", "--show-toplevel"]);
  const toplevel = result.stdout.trim();
  if (!result.ok || !toplevel) {
    throw new Error(
      `Could not determine a repository root: ${candidate} is not inside a git repository.`,
    );
  }
  return path.resolve(toplevel);
};

/**
 * 1:1 binding between the Antigravity workspace and a Hermes project. The Hermes side is
 * provisioned when absent: a session that lands outside a project is invisible in Desktop.
 */
export const resolveAntigravityProject = async (options: ResolveOptions = {}): Promise<ResolvedProject> => {
  const projects = loadAntigravityProjects();
  const cwd = options.cwd ? path.resolve(options.cwd) : null;

  let selected: AntigravityProject | null = null;

  if (options.conversationId) {
    const projectId = conversationProjectId(options.conversationId);
    if (projectId) {
      selected = projects.find((project) => project.id === projectId) ?? null;
    }
  }
  if (!selected && options.project) {
    const needle = options.project.trim().toLowerCase();
    selected =
      projects.find((project) => project.id.toLowerCase() === needle) ??
      projects.find((project) => project.name.toLowerCase() === needle) ??
      null;
  }
  if (!selected && cwd) {
    const normalCwd = normalizeForCompare(cwd);
    const ranked = projects
      .map((project) => ({ project, folder: deepestWorkspaceFolder(project, normalCwd) ?? "" }))
      .filter((entry) => entry.folder.length > 0)
      // Most specific workspace first; the id makes an exact tie the same answer on every run.
      .sort(
        (a, b) =>
          pathDepth(normalizeForCompare(b.folder)) - pathDepth(normalizeForCompare(a.folder)) ||
          b.folder.length - a.folder.length ||
          a.project.id.localeCompare(b.project.id),
      );
    selected = ranked[0]?.project ?? null;
  }

  // A worktree must branch from the repository root, never from the subdirectory the call came from.
  const owningFolder = cwd && selected
    ? deepestWorkspaceFolder(selected, normalizeForCompare(cwd))
    : undefined;
  const candidate = owningFolder
    ? path.resolve(owningFolder)
    : (cwd ?? (selected?.folders[0] ? path.resolve(selected.folders[0]) : null));
  if (!candidate) {
    throw new Error(
      "Could not determine a repository root: pass cwd, or a conversationId/project that has a workspace folder attached.",
    );
  }

  const repoRoot = await gitToplevel(candidate);
  const target = normalizeForCompare(repoRoot);
  const hermesProjects = await loadHermesProjects();

  // Path only: the same basename or slug in an unrelated directory is a different project.
  const byPath = bestPathMatch(hermesProjects, target);

  if (byPath) {
    return {
      repoRoot,
      antigravityProjectId: selected?.id ?? null,
      antigravityProjectName: selected?.name ?? null,
      hermesProjectId: byPath.id,
      hermesProjectSlug: byPath.slug,
      hermesProjectName: byPath.name,
      provisioned: false,
    };
  }

  const mayProvision = selected !== null || options.allowProvision === true;
  if (!mayProvision) {
    return {
      repoRoot,
      antigravityProjectId: null,
      antigravityProjectName: null,
      hermesProjectId: null,
      hermesProjectSlug: null,
      hermesProjectName: null,
      provisioned: false,
    };
  }

  const projectName = selected?.name ?? path.basename(repoRoot);
  const slug = slugify(projectName) || slugify(path.basename(repoRoot)) || "project";
  await provisionHermesProject(projectName, repoRoot, slug);

  const created = bestPathMatch(await loadHermesProjects(), target);
  if (!created) {
    throw new Error(`Provisioned Hermes project "${slug}" but could not find it in ${projectsDbPath()}.`);
  }

  return {
    repoRoot,
    antigravityProjectId: selected?.id ?? null,
    antigravityProjectName: selected?.name ?? null,
    hermesProjectId: created.id,
    hermesProjectSlug: created.slug,
    hermesProjectName: created.name,
    provisioned: true,
  };
};
