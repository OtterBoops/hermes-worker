import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { isWindows, run } from "./exec.js";

/** Windows installs under %LOCALAPPDATA%; POSIX under ~/.hermes. HERMES_HOME always wins. */
export const hermesHome = (): string => {
  const override = process.env.HERMES_HOME?.trim();
  if (override) return path.resolve(override);
  if (isWindows) {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    return path.join(localAppData, "hermes");
  }
  return path.join(os.homedir(), ".hermes");
};

export const hermesAgentRoot = (): string => path.join(hermesHome(), "hermes-agent");

export const hermesExe = (): string => {
  const override = process.env.HERMES_BIN?.trim();
  if (override) return override;
  return path.join(hermesHome(), "bin", isWindows ? "hermes.exe" : "hermes");
};

/**
 * Windows cannot exec a `.js` entrypoint, and the shipped `hermes.cmd` wrapper is refused by
 * spawn without a shell, so a script-shaped HERMES_BIN (source checkout, test double) is handed to
 * the running node instead. An `.exe` bin is spawned as itself.
 */
export const hermesCommand = (): { file: string; prefixArgs: string[] } => {
  const bin = hermesExe();
  return /\.[cm]?js$/i.test(bin) ? { file: process.execPath, prefixArgs: [bin] } : { file: bin, prefixArgs: [] };
};

export const projectsDbPath = (): string => path.join(hermesHome(), "projects.db");
export const stateDbPath = (): string => path.join(hermesHome(), "state.db");
export const pendingDir = (subsystem: "memory" | "skills"): string =>
  path.join(hermesHome(), "pending", subsystem);
export const memoriesDir = (): string => path.join(hermesHome(), "memories");

export const antigravityConfigDir = (): string => path.join(os.homedir(), ".gemini", "config", "projects");
export const antigravitySummariesDb = (): string =>
  path.join(os.homedir(), ".gemini", "antigravity", "conversation_summaries.db");

const exists = (candidate: string): boolean => {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
};

const listDirs = (parent: string): string[] => {
  try {
    return fs
      .readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(parent, entry.name));
  } catch {
    return [];
  }
};

const byMtimeDesc = (a: string, b: string): number => {
  try {
    return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
  } catch {
    return 0;
  }
};

/**
 * Hermes ships a dependency venv per PM generation plus a bare store interpreter. Only the
 * venv carries the third-party wheels (ruamel, requests, ...), so candidates are probed in
 * that order and the first one that can import `tools.write_approval` wins.
 */
export const pythonCandidates = (): string[] => {
  const candidates: string[] = [];
  const explicit = process.env.HERMES_PYTHON?.trim();
  if (explicit) candidates.push(explicit);

  const installs = listDirs(path.join(hermesHome(), "installs"));
  const venvPy = isWindows ? ["venv", "Scripts", "python.exe"] : ["venv", "bin", "python3"];
  const venvPythons = installs
    .flatMap((install) => listDirs(path.join(install, "environments")))
    .map((env) => path.join(env, ...venvPy))
    .filter(exists)
    .sort(byMtimeDesc);
  candidates.push(...venvPythons);

  const storePython = isWindows ? ["python.exe"] : ["bin", "python3"];
  const storePythons = listDirs(path.join(hermesHome(), "tools"))
    .filter((dir) => /python/i.test(path.basename(dir)))
    .map((dir) => path.join(dir, ...storePython))
    .filter(exists)
    .sort(byMtimeDesc);
  candidates.push(...storePythons);

  return [...new Set(candidates)];
};

const PROBE = [
  "import sys, pathlib",
  "root = pathlib.Path(sys.argv[1])",
  "sys.path.insert(0, str(root))",
  "try:",
  "    import tools.write_approval",
  "except ImportError:",
  "    from pm.environments import activate_dependencies",
  "    activate_dependencies(root)",
  "    import tools.write_approval",
  "print('HERMES_PY_OK')",
].join("\n");

const PYTHON_FLAGS = ["-I", "-X", "utf8"];

const cacheKey = (): string => `${hermesHome()}|${process.env.HERMES_PYTHON ?? ""}`;

const resolvedPython = new Map<string, string>();
const inFlightProbes = new Map<string, Promise<string>>();

const probePython = async (): Promise<string> => {
  const root = hermesAgentRoot();
  const env = {
    ...process.env,
    HERMES_HOME: hermesHome(),
    HERMES_AGENT_ROOT: root,
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
  };

  for (const candidate of pythonCandidates()) {
    const result = await run(candidate, [...PYTHON_FLAGS, "-c", PROBE, root], {
      env,
      timeoutMs: 90_000,
    });
    if (result.code === 0 && result.stdout.includes("HERMES_PY_OK")) return candidate;
  }
  throw new Error(
    `No Hermes Python interpreter could import tools.write_approval. Looked at: ${pythonCandidates().join(", ") || "(none)"}`,
  );
};

/**
 * Memoised per (HERMES_HOME, HERMES_PYTHON) and re-validated on every hit: a Hermes update can
 * delete the venv out from under a long-lived MCP process. Concurrent callers share one probe.
 */
export const resolveHermesPython = async (): Promise<string> => {
  const key = cacheKey();
  const cached = resolvedPython.get(key);
  if (cached) {
    if (exists(cached)) return cached;
    resolvedPython.delete(key);
  }

  let probe = inFlightProbes.get(key);
  if (!probe) {
    probe = probePython().then((interpreter) => {
      resolvedPython.set(key, interpreter);
      return interpreter;
    });
    inFlightProbes.set(key, probe);
    // A rejected promise must never stay cached, and the cleanup copy must not be an unhandled rejection.
    probe.catch(() => {}).finally(() => inFlightProbes.delete(key));
  }
  return probe;
};
