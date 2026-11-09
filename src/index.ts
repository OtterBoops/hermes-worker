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
      "Run an implementation, refactor, test-generation or audit task on Hermes inside an isolated " +
      "git worktree branched from local HEAD. Returns the diff, session id, tool summary and any " +
      "memory/skill writes Hermes staged. Nothing is committed to your checkout; land it with " +
      "hermes_worktree_action. A status of 'running' is a normal answer, not an error: the run " +
      "outlived fastWaitSeconds, nothing was killed, and running waitCommand as a background " +
      "command streams the run's log live, then prints a telemetry block, one sentinel line " +
      "('<<<HERMES_DISPATCH_COMPLETE:<runId>>>', or '<<<HERMES_DISPATCH_FAILED:<runId>>>' when " +
      "the run did not succeed) and the result message. Uncommitted caller changes are ported into " +
      "the worktree as a baseline commit, so the diff covers only Hermes' work. The run is pinned " +
      "to cline-pass/deepseek-v4.1-flash-1017 via the " +
      "clinepass provider; if cline pass is refused (quota exhausted), the dispatch fails closed " +
      "(success: false, modelFallback: true) instead of silently landing on a fallback model.",
    inputSchema: {
      prompt: z.string().describe("The full task specification for Hermes."),
      cwd: z.string().optional().describe("Repository path the task belongs to (defaults to the bound project)."),
      conversationId: z.string().optional().describe("Antigravity conversation id, used to resolve the project."),
      project: z.string().optional().describe("Antigravity project name or id."),
      sessionName: z.string().optional().describe("Thread title in Hermes; auto-generated when omitted."),
      model: z
        .string()
        .optional()
        .describe("Model override. Defaults to cline-pass/deepseek-v4.1-flash-1017."),
      reasoning: z
        .string()
        .optional()
        .describe("Reasoning effort (none|minimal|low|medium|high). Defaults to high."),
      skills: z.array(z.string()).optional().describe("Skills to preload for the run."),
      timeoutSeconds: z
        .number()
        .int()
        .min(30)
        .max(7200)
        .optional()
        .describe("Wall-clock budget for the Hermes run (default 1800s)."),
      fastWaitSeconds: z
        .number()
        .min(1)
        .max(7200)
        .optional()
        .describe(
          "How long this call blocks before returning a running descriptor with a waitCommand " +
            "(default 1s). The run keeps going either way.",
        ),
      autoApply: z
        .boolean()
        .optional()
        .describe(
          "When true, automatically apply a clean worktree diff to cwd and remove the worktree " +
            "branch on successful completion.",
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
    title: "Apply or discard a bridge worktree",
    description:
      "Land a Hermes run on your working checkout (apply) or throw it away (discard). Apply patches " +
      "with git apply --3way and then removes the temporary worktree and branch.",
    inputSchema: {
      action: z.enum(["apply", "discard"]),
      cwd: z.string().describe("Repository root."),
      worktreeBranch: z.string().describe("Branch name reported by hermes_dispatch."),
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
      "admin records. A crashed or interrupted dispatch leaves one behind; a running run's worktree " +
      "and its branch are never touched. Returns the number of directories removed.",
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
  guard(async (args) => ({ sessions: listHermesSessions(args) })),
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
