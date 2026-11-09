# hermes-worker

MCP bridge that lets Antigravity dispatch implementation, refactor, test and audit tasks to
Hermes Agent, with guardrails and review built in.

## Build

```bash
pnpm install
pnpm run build     # emits dist/
pnpm test          # node --test against tests/*.test.ts
```

`pnpm run start` serves the built server over stdio; `pnpm run dev` runs it from source.

## Tools

| Tool | Purpose |
|---|---|
| `hermes_dispatch` | Run a task on Hermes inside a worktree branched from local `HEAD`. Returns the diff, session id, tool summary, DeepSeek reasoning and any staged memory writes. |
| `hermes_pending_writes` | `list` / `preview` / `diagnose` / `salvage` / `approve` / `reject` against Hermes' `write_approval` queue. |
| `hermes_inspect_memory` | `MEMORY.md` / `USER.md` contents, entry counts and character usage, gate state, queue depth. |
| `hermes_worktree_action` | `apply` a run's diff with `git apply --3way`, or `discard` it. Either way the worktree and temporary branch are removed. |
| `hermes_list_sessions` | Recent Hermes sessions, optionally scoped to a project path. |

## How a dispatch runs

1. The prompt is scanned for credentials; anything that looks like a token or private key aborts
   before git is touched.
2. The Antigravity workspace is resolved to a Hermes project (provisioned with
   `hermes project create` when absent).
3. `git worktree add -b hermes/agy-<runId> <repo>/.worktrees/agy-<runId> HEAD` — `.worktrees/` is
   recorded in `.git/info/exclude`, never in the tracked `.gitignore`.
4. The caller's uncommitted work is ported into that worktree and committed as
   `[AGY-BASE] Working tree baseline snapshot`: tracked changes as a `git diff HEAD --binary` patch,
   untracked files copied (skipping `.git`, `.worktrees`, `node_modules` and blocked secret paths).
   The dispatch's `baseSha` is that baseline commit, so `git diff <baseSha>` reports strictly what
   Hermes changed and never re-reports the caller's in-progress edits.
5. `hermes chat --query-file … --format stream-json --in <worktree> -c <title> --create-if-missing
   --yolo --source cli --provider clinepass --model cline-pass/deepseek-v4.1-flash-1017 --reasoning high`
   runs the turn on the shared gateway, so Desktop streams it live. Model, reasoning and provider
   are pinned defaults; the caller can override model/reasoning per dispatch.
6. If cline pass is refused (quota exhausted), the dispatch fails closed: `success: false`,
   `modelFallback: true`, and a `warning` naming the fallback model. No diff is produced and no
   worktree is kept for review — Antigravity never sees fallback-model output presented as cline
   pass work.
7. Modified files are checked against the guardrails. A violation destroys the worktree; an empty
   run cleans up after itself; otherwise the worktree is kept for review.
8. The session's `cwd` / `git_repo_root` are re-anchored to the repository root so the thread stays
   resumable after the worktree is pruned. The same read reports the model that actually answered:
   Hermes falls back (429 from the pinned provider) without failing the run, so `model`,
   `provider` and `modelFallback` are returned and a downgraded run also carries a `warning`.

`--source cli`, not `antigravity`: the gateway only admits its own surface vocabulary
(`cli`, `tui`, `gui`, `acp`, `tool`, `oneshot`) and refuses anything else, while `oneshot` would
hide the session from Desktop pickers.

## Watching a run

Every dispatch appends a human-readable tail to `<RUN_STATE_DIR>/<runId>.log` as Hermes emits
events — `[Hermes:Tool]`, `[Hermes:Exec]`, `[Hermes:Result]`, `[Hermes:Step]`. Running the
`waitCommand` from a `status: 'running'` answer streams those lines live, then prints a telemetry
block and one sentinel line:

```
[Hermes Worker] Tailing run 20261108234625-4u18...
[Hermes:Step] Planning the change
[Hermes:Tool] terminal (pnpm test)
[Hermes:Exec] pnpm test
[Hermes:Result] c1 -> 67 tests passing
============================================================
[Hermes Dispatch Telemetry] (Status: SUCCESS)
- Run ID: 20261108234625-4u18
- Duration: 22.4s
- Tools Called: 2
- Subagents Spawned: 1
- Tokens Used: 140 (input: 111, output: 22, cache: 7)
============================================================
<<<HERMES_DISPATCH_COMPLETE:20261108234625-4u18>>>
1 file(s) changed on hermes/agy-20261108234625-4u18 in 22.4s. Apply with hermes_worktree_action. [session: sess-1] [tokens: 140]
```

The sentinel is emitted on every path — success, failure, timeout and crash — so a caller can tail
the command instead of guessing a timeout. `<<<HERMES_DISPATCH_FAILED:<runId>>>` replaces the
`COMPLETE` form when the run did not succeed. Both the log and the state file are pruned when the
wait CLI finishes.

## Requirements

- Node 26 (uses `node:sqlite`).
- A local Hermes install (`HERMES_HOME`, default `%LOCALAPPDATA%\hermes`). The interpreter is
  discovered from the PM dependency environment and probed for `tools.write_approval`; override
  with `HERMES_PYTHON`.

## Registering with Antigravity

Add to `.gemini/config/mcp_config.json`:

```json
{
  "mcpServers": {
    "hermes-worker": {
      "command": "node",
      "args": ["D:\\Code\\OtterBoops\\hermes-worker\\dist\\index.js"]
    }
  }
}
```

`scripts/mcp-probe.mjs` performs a handshake, lists the tools and calls the read-only ones:

```bash
node scripts/mcp-probe.mjs D:/Code/OtterBoops/hermes-worker/dist/index.js D:/Code/OtterBoops/hermes-worker
```
