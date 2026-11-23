#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { dispatchHermesTask, listHermesSessions, manageWorktree, pruneOrphanWorktrees } from "./hermes-cli.js";
import { inspectMemory, managePendingWrites } from "./memory-manager.js";

const server = new McpServer({ name: "hermes-worker", version: "1.0.0" });

const json = (value: unknown): { content: Array<{ type: "text"; text: string }>; isError?: boolean } => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
});

/** Every failure has to reach the caller as readable text: a thrown handler is opaque to Antigravity. */
const guard = <A>(handler: (args: A) => Promise<unknown> | unknown) => async (args: A) => {
  try {
    return json(await handler(args));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...json({ success: false, error: message }), isError: true };
  }
};

server.registerTool(
  "hermes_dispatch",
  {
    title: "Dispatch a task to Hermes Agent",
    description:
      "Run an implementation, refactor, test-generation or audit task on Hermes directly in the " +
      "repository checkout Antigravity has open. Hermes edits the real working tree, so its changes " +
      "are visible immediately: the bridge records the tree before and after the run, returns the " +
      "session id, tool summary, memory/skill writes and the diff of exactly what the run changed, " +
      "and reverts them with hermes_worktree_action action=discard. Uncommitted work in the checkout " +
      "is part of the baseline, so the diff covers only Hermes' work. " +
      "Multi-turn: pass the same conversationId to continue the previous turn's Hermes session, " +
      "which is resumed rather than restarted and is told what changed under it since that turn; " +
      "pass resumeSessionId to continue a specific session, or newSession to start a fresh one. A " +
      "session that has been compacted maxCompacts times is rotated into a fresh session carrying a " +
      "handoff note instead of being resumed forever. With verifyCommand set, the command runs in " +
      "the checkout after every turn and a failing exit is fed back as the next turn's task. " +
      "A status of 'running' is a normal answer, not an error: the run outlived fastWaitSeconds, " +
      "nothing was killed, and running waitCommand as a background command streams the run's log " +
      "live, then prints a telemetry table (duration, tools, subagents, model, tokens, cost), one " +
      "sentinel line ('<<<HERMES_DISPATCH_COMPLETE:<runId>>>', or " +
      "'<<<HERMES_DISPATCH_FAILED:<runId>>>' when the run did not succeed) and the result message. " +
      "The run is pinned to deepseek-v4.1-flash via the opencode-go provider; if the Go allowance is " +
      "exhausted, the dispatch fails closed (success: false, modelFallback: true) and the checkout is " +
      "reverted instead of silently landing on a fallback model.",
    inputSchema: {
      prompt: z
        .string()
        .describe(
          "The full task specification for Hermes. Do NOT paste the [WORKER OPERATIONAL " +
            "BOUNDARY] block into it: the bridge prepends the boundary itself and a prompt that " +
            "already carries it is passed through unchanged. Write the objective, the files, the " +
            "acceptance criteria and the verification command. Split multi-file work into " +
            "workstreams and tell Hermes to fan them out with parallel delegate_task subagents, " +
            "giving each subagent strictly disjoint file paths.",
        ),
      cwd: z.string().optional().describe("Repository path the task belongs to (defaults to the bound project)."),
      conversationId: z
        .string()
        .optional()
        .describe(
          "Antigravity conversation id: resolves the project, and continues the Hermes session the " +
            "previous turn of this conversation left behind.",
        ),
      project: z.string().optional().describe("Antigravity project name or id."),
      sessionName: z.string().optional().describe("Thread title in Hermes; auto-generated when omitted."),
      resumeSessionId: z
        .string()
        .optional()
        .describe(
          "Continue this Hermes session instead of resolving one from the conversation. Ignored " +
            "when it has to be rotated for compactions.",
        ),
      newSession: z
        .boolean()
        .optional()
        .describe("Start a fresh session even when this conversation already has one remembered."),
      maxCompacts: z
        .number()
        .int()
        .min(0)
        .max(20)
        .optional()
        .describe(
          "Compactions a session may accumulate before the dispatch rotates into a fresh one " +
            "(default 2, or HERMES_MAX_COMPACTS).",
        ),
      verifyCommand: z
        .string()
        .optional()
        .describe(
          "Command run in the checkout after every turn (e.g. 'pnpm run build && pnpm test'). A " +
            "non-zero exit is fed back to the same session as the next turn's task.",
        ),
      maxTurns: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe("Turn budget for the verifyCommand loop (default 3, clamped to 1..10)."),
      model: z
        .string()
        .optional()
        .describe("Model override for a new session. Defaults to deepseek-v4.1-flash."),
      reasoning: z
        .string()
        .optional()
        .describe("Reasoning effort (none|minimal|low|medium|high). Defaults to high."),
      skills: z.array(z.string()).optional().describe("Skills to preload when the session is created."),
      timeoutSeconds: z
        .number()
        .int()
        .min(30)
        .max(7200)
        .optional()
        .describe("Inactivity timeout for each Hermes turn, reset on parent or subagent activity (default 900s)."),
      fastWaitSeconds: z
        .number()
        .min(1)
        .max(7200)
        .optional()
        .describe(
          "How long this call blocks before returning a running descriptor with a waitCommand " +
            "(default 1s). The run keeps going either way.",
        ),
      includeDiff: z
        .boolean()
        .optional()
        .describe(
          "Return the diff body (default true). The changes are in the checkout either way; turn " +
            "this off when only the file list is needed.",
        ),
    },
  },
  guard(async (args) => dispatchHermesTask(args)),
);

server.registerTool(
  "hermes_pending_writes",
  {
    title: "Inspect, diagnose and settle staged memory/skill writes",
    description:
      "Work the write_approval queue: list, preview, diagnose (classify every operation against live " +
      "memory as VALID / REDUNDANT_NOOP / REBINDABLE / CONFLICT without touching disk), salvage " +
      "(strip redundant ops, re-pin rebound ops, discard empty records), approve, reject.",
    inputSchema: {
      action: z
        .enum(["list", "preview", "diagnose", "salvage", "approve", "reject"])
        .describe("Queue operation to perform."),
      subsystem: z.enum(["memory", "skills", "all"]).optional().describe("Which queue (default all for list/preview)."),
      id: z.string().optional().describe("Pending record id, or 'all' where the action supports it."),
    },
  },
  guard(async (args) => managePendingWrites(args)),
);

server.registerTool(
  "hermes_inspect_memory",
  {
    title: "Inspect Hermes memory",
    description:
      "Current MEMORY.md and USER.md contents, entry counts, character usage against the configured " +
      "limits, write_approval gate state and pending queue depth.",
    inputSchema: {},
  },
  guard(async () => inspectMemory()),
);

server.registerTool(
  "hermes_worktree_action",
  {
    title: "Revert or cancel a bridge run",
    description:
      "Work with a run hermes_dispatch reported, identified by its run handle (runHandle, " +
      "`agy-<runId>`). discard reverts the checkout to the tree the run started from: files the run " +
      "added are deleted and files it modified or deleted are restored, scoped to that run's own " +
      "changes so unrelated edits survive. cancel is the only action that interrupts a running " +
      "dispatch: it kills the run's process tree, settles the run state so no waiter hangs, then " +
      "reverts the checkout the same way. apply is legacy only — a snapshot run is already in the " +
      "caller's checkout, so it refuses with that explanation. A run recorded by an older worker " +
      "that still created a .worktrees/agy-* branch can be applied or discarded through the same " +
      "handle.",
    inputSchema: {
      action: z.enum(["apply", "discard", "cancel"]),
      cwd: z.string().describe("Repository root."),
      runHandle: z
        .string()
        .optional()
        .describe("Run handle reported by hermes_dispatch (runHandle / `agy-<runId>`)."),
      worktreeBranch: z
        .string()
        .optional()
        .describe("Legacy alias for runHandle: `hermes/agy-<runId>` from an older worker."),
    },
  },
  guard(async (args) => manageWorktree(args)),
);

server.registerTool(
  "hermes_prune_worktrees",
  {
    title: "Sweep orphaned bridge worktrees",
    description:
      "Remove every .worktrees/agy-* directory that no running run owns, then prune git's worktree " +
      "admin records. Dispatches no longer create worktrees, so this only sweeps what an older " +
      "worker left behind: a running run's worktree and its branch are never touched. Returns the " +
      "number of directories removed.",
    inputSchema: {
      cwd: z.string().describe("Repository root to sweep."),
    },
  },
  guard(async (args) => {
    const removed = await pruneOrphanWorktrees(args.cwd);
    return { success: true, removed, message: `Removed ${removed} orphaned worktree(s) under ${args.cwd}.` };
  }),
);

server.registerTool(
  "hermes_list_sessions",
  {
    title: "List Hermes sessions",
    description: "Recent Hermes sessions, filtered to a project path when cwd is given.",
    inputSchema: {
      cwd: z.string().optional().describe("Only sessions anchored at or under this path."),
      limit: z.number().int().min(1).max(200).optional(),
    },
  },
  guard(async (args) => ({ sessions: await listHermesSessions(args) })),
);

const main = async (): Promise<void> => {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the MCP channel; anything humans need to see goes to stderr.
  process.stderr.write("hermes-worker 1.0.0 listening on stdio\n");
};

main().catch((error: unknown) => {
  process.stderr.write(`hermes-worker failed to start: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
