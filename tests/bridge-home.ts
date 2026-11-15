import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { hermesAgentRoot, hermesHome, resolveHermesPython } from "../src/hermes-paths.js";

export interface BridgeHome {
  /** The throwaway HERMES_HOME: `state.db`, `projects.db` and friends live here. */
  home: string;
  /**
   * False when this machine has no Hermes install the bridge could import. A test that needs the
   * bridge returns early on it: an absent install is a fixture absence, not a failure.
   */
  available: boolean;
}

/** `fs.symlinkSync` needs no elevation for a junction on Windows. */
const linkDirectory = (target: string, link: string): boolean => {
  try {
    fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  }
};

/**
 * A HERMES_HOME whose bridge can actually run: the real agent root is linked in and the real
 * interpreter is pinned, so the databases under test are throwaway while the code reading them
 * through `runBridge` is Hermes' own. That is the point of these fixtures — the bridge is what the
 * worker uses in production, so a test that stubs it out tests nothing.
 *
 * Restores the process environment and removes the home afterwards, dropping the link first: a
 * recursive delete must never be handed a junction into the user's real Hermes install.
 */
export const makeBridgeHome = async (t: TestContext): Promise<BridgeHome> => {
  const previousHome = process.env.HERMES_HOME;
  const previousPython = process.env.HERMES_PYTHON;

  // Resolved before HERMES_HOME moves: this probe looks inside the real install.
  let python: string | null = null;
  try {
    python = await resolveHermesPython();
  } catch {
    python = null;
  }

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-worker-home-"));
  const agentLink = path.join(home, "hermes-agent");
  const available = python !== null && linkDirectory(hermesAgentRoot(), agentLink);

  t.after(() => {
    // Unlink before the recursive removal: unlinking a junction removes the link, never the target.
    try {
      fs.unlinkSync(agentLink);
    } catch {
      // Never linked, or already gone.
    }
    if (previousHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = previousHome;
    if (previousPython === undefined) delete process.env.HERMES_PYTHON;
    else process.env.HERMES_PYTHON = previousPython;
    fs.rmSync(home, { recursive: true, force: true });
  });

  process.env.HERMES_HOME = home;
  if (python) process.env.HERMES_PYTHON = python;
  return { home, available };
};

/** The real Hermes home, so a test can say why a bridge fixture was skipped. */
export const realHermesHome = (): string => hermesHome();
