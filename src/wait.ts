#!/usr/bin/env node
import { readRunState, clearRunState, RUN_ID_PATTERN } from "./run-registry.js";

const POLL_MS = 500;
const MAX_WAIT_MS = 2 * 60 * 60 * 1000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Callback half of a dispatch: block until the run registry says the run finished, then report it. */
const main = async (): Promise<void> => {
  const runId = process.argv[2] ?? "";
  if (!RUN_ID_PATTERN.test(runId)) {
    process.stderr.write(
      `wait: invalid run id '${runId}'. Expected the runId reported by hermes_dispatch ([A-Za-z0-9_-]).\n`,
    );
    process.exit(1);
  }

  const deadline = Date.now() + MAX_WAIT_MS;
  for (;;) {
    const state = readRunState(runId);
    if (state?.status === "completed") {
      const result = state.result as { success?: unknown } | null | undefined;
      process.stdout.write(`${JSON.stringify(state.result ?? null, null, 2)}\n`);
      await clearRunState(runId).catch(() => undefined);
      process.exit(result?.success === true ? 0 : 1);
    }
    if (Date.now() > deadline) {
      process.stderr.write(
        `wait: run '${runId}' was still running after 2h. The runner may have died; check the worktree.\n`,
      );
      process.exit(1);
    }
    await sleep(POLL_MS);
  }
};

main().catch((error: unknown) => {
  process.stderr.write(`wait: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
