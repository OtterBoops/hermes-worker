# Implementation Plan & Technical Specification: `hermes-worker` MCP Bridge

## 1. Objective & Scope

Build a standalone TypeScript Model Context Protocol (MCP) server at `D:\Code\OtterBoops\hermes-worker` targeting **Node 26** (`v26.13.0`, ES2024, native `node:sqlite`).

`hermes-worker` enables **Antigravity** (the Brain & Review Gatekeeper) to dispatch code implementation, refactoring, test generation, and codebase auditing tasks to **Hermes Agent** (`cline-pass/deepseek-v4.1-flash-1017`), while preserving:
1. **Strict Security Guardrails**: Zero access to `.env*`, credentials, keys, or remote homelab infrastructure (`hl`, `ottbox`, Arcane, Cloudflare). Local workstation Docker (`docker run`, `docker compose` for local tests) is permitted.
2. **1:1 Project Auto-Binding**: Automatic resolution between Antigravity projects (`~/.gemini/config/projects/*.json` + `conversation_summaries.db`) and Hermes projects (`C:\Users\Otter\AppData\Local\hermes\projects.db`), auto-provisioning in Hermes if missing.
3. **Bridge-Managed Git Worktrees**: Isolated worktrees under `<repo>/.worktrees/agy-<short_id>` branched strictly from local `HEAD`, keeping `.worktrees/` in `<repo>/.git/info/exclude` so tracked `.gitignore` is never dirtied.
4. **Canonical `write_approval` & Staged Batch Salvage Engine**: Full integration with `C:\Users\Otter\AppData\Local\hermes\pending\{memory,skills}\*.json` (`list`, `preview`, `diagnose`, `salvage`, `approve`, `reject`) via Hermes' bundled Python runtime and `MemoryStore`.

> **Boundary Note for Hermes Implementer**: Implement and test all files inside `D:\Code\OtterBoops\hermes-worker`. Do **NOT** modify `C:\Users\Otter\.gemini\config\mcp_config.json`—Antigravity will perform the final MCP registration after reviewing your implementation and test suite.

---

## 2. Environment & Canonical Paths on This Host

- **Node Runtime**: Node `v26.13.0` (`node:sqlite` `DatabaseSync` built-in, `node:test` built-in).
- **Package Manager**: `pnpm` (`12.18.0`).
- **Hermes Root (`HERMES_HOME`)**: `C:\Users\Otter\AppData\Local\hermes` (overrideable via `process.env.HERMES_HOME`).
- **Hermes CLI Binary**: `C:\Users\Otter\AppData\Local\hermes\bin\hermes.exe`.
- **Hermes Bundled Python**: `C:\Users\Otter\AppData\Local\hermes\tools\python-3.14.9+20261021-win32-x64\python.exe` (or discovered dynamically via `tools/python-*/python.exe` under `HERMES_HOME`).
- **Hermes Agent Python Root**: `C:\Users\Otter\AppData\Local\hermes\hermes-agent`.
- **Hermes Databases**:
  - `C:\Users\Otter\AppData\Local\hermes\projects.db` (tables: `projects`, `project_folders`)
  - `C:\Users\Otter\AppData\Local\hermes\state.db` (tables: `sessions`, `messages`)
- **Hermes Pending Approval Queue**:
  - `C:\Users\Otter\AppData\Local\hermes\pending\memory\*.json`
  - `C:\Users\Otter\AppData\Local\hermes\pending\skills\*.json`
- **Antigravity Metadata**:
  - Projects dir: `C:\Users\Otter\.gemini\config\projects\*.json`
  - Summaries DB: `C:\Users\Otter\.gemini\antigravity\conversation_summaries.db`

---

## 3. Critical Architectural Findings (From Codebase Audit)

1. **Why Bridge-Managed Worktrees Replace Hermes' `--worktree` Flag**:
   - Hermes' native `--worktree` (`hermes_cli/worktree_ops.py:_resolve_worktree_base`) branches from `origin/<upstream>` before falling back to local `HEAD`, meaning unpushed local commits in the user's repo are missed. It also appends `.worktrees/` to the repo's tracked `.gitignore`.
   - Instead, `hermes-worker` manages the worktree directly:
     - Adds `.worktrees/` to `<repo>/.git/info/exclude` (never touching tracked `.gitignore`).
     - Records `baseSha = git rev-parse HEAD`.
     - Runs `git worktree add -b hermes/agy-<runId> "<repo>/.worktrees/agy-<runId>" HEAD`.
     - Because `<repo>/.worktrees/agy-<runId>` is inside `<repo>`, Hermes' `projects_db.py:project_for_path` (`target.startswith(stem + os.sep)`) automatically binds the session to the parent Hermes project in Hermes Desktop!
     - After `hermes.exe` exits, runs `git add -N .` inside the worktree so untracked new files are visible to `git diff`, then captures `git diff <baseSha>` and `git diff --name-only <baseSha>`.
     - Re-stamps `UPDATE sessions SET cwd = ?, git_repo_root = ? WHERE id = ?` in `state.db` to `<repo>` so the session in Hermes Desktop remains resumable even after the `.worktrees/agy-<runId>` directory is later pruned.

2. **Why `--query-file <path> --format stream-json` is Mandatory**:
   - In `hermes_cli/main.py:1689`, `stream_json_requested(args)` routes `hermes chat` through `launch_gateway_chat(args)` on the **persistent local Hermes Gateway daemon**.
   - This gives two major benefits:
     1. **Live Streaming in Hermes Desktop**: Hermes Desktop shares the local gateway daemon and streams the turn live.
     2. **Uninterrupted `bg-review`**: The post-turn `background_review` thread (`run_agent.py:820`, `daemon=True`) runs inside the persistent gateway process rather than getting killed when the CLI client exits.
   - Using `--query-file <tempFile>` avoids all Windows `cmd.exe`/PowerShell argument quoting bugs on multi-line prompts.
   - Do **NOT** pass `--worktree` to `hermes.exe` (since `--in "<worktreePath>"` already places Hermes inside our bridge-managed worktree).
   - Do **NOT** pass `--source tool` (which hides sessions from Hermes Desktop); pass `--source antigravity` (or omit `--source` to keep default `cli`).

3. **Zod v4 Invariant**:
   - If using Zod v4 (`zod@^4.6.7`), access validation errors strictly via `result.error.issues` (never `result.error.errors`).

---

## 4. Package Structure & File Specifications

```text
D:\Code\OtterBoops\hermes-worker\
├── package.json
├── tsconfig.json
├── PLAN.md
├── src\
│   ├── index.ts
│   ├── guardrails.ts
│   ├── project-binding.ts
│   ├── hermes-cli.ts
│   └── memory-manager.ts
└── tests\
    ├── guardrails.test.ts
    ├── project-binding.test.ts
    └── memory-manager.test.ts
```

---

### 4.1 `package.json` & `tsconfig.json`

#### `package.json`
```json
{
  "name": "hermes-worker",
  "version": "1.0.0",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsx src/index.ts",
    "test": "node --import tsx --test tests/*.test.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.27.1",
    "zod": "^3.24.2"
  },
  "devDependencies": {
    "@types/node": "^22.13.0",
    "tsx": "^4.19.2",
    "typescript": "^5.8.2"
  }
}
```
*(Note: Keep `zod` compatible with `@modelcontextprotocol/sdk` peer requirements; support `.issues` on ZodError).*

#### `tsconfig.json`
```json
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true
  },
  "include": ["src/**/*"]
}
```

---

### 4.2 `src/guardrails.ts` — Security Firewall & Boundary Injector

Exports:
1. `BLOCKED_PATH_PATTERNS: RegExp[]`
   - Blocks any relative or absolute path matching:
     - `(^|[\\/])\.env($|\.)` (`.env`, `.env.local`, `.env.production`, etc., except `.env.example` / `.env.template` if explicitly desired—better yet, block all `.env*` except `.env.example`)
     - `\.(pem|key|pfx|p12|kdbx)$`
     - `(^|[\\/])id_(rsa|ed25519|ecdsa)`
     - `(^|[\\/])\.ssh([\\/]|$)`
     - `(^|[\\/])\.gemini([\\/]|$)`
     - `mcp_config\.json$`
     - `(^|[\\/])credentials\.json$`
2. `validateModifiedFiles(files: string[], repoRoot: string): { valid: boolean; violations: string[] }`
   - Normalizes each path, checks for `..` traversal escaping `repoRoot`, and tests against `BLOCKED_PATH_PATTERNS`.
   - If any file violates the rules, returns `valid: false` with the list of offending paths.
3. `scanPromptForSecrets(prompt: string): { safe: boolean; reason?: string }`
   - Rejects prompts containing raw private keys (`-----BEGIN .* PRIVATE KEY-----`), GitHub PATs (`ghp_[A-Za-z0-9]{30,}`, `github_pat_`), OpenRouter keys (`sk-or-v1-[a-f0-9]{40,}`), or Anthropic/OpenAI keys (`sk-ant-`, `sk-proj-`).
4. `injectWorkerBoundary(prompt: string): string`
   - Prepends a concise, non-bypassable operational contract:
     ```text
     [WORKER OPERATIONAL BOUNDARY]
     - You are executing inside an isolated Git worktree managed by Antigravity.
     - DO NOT read, create, or modify .env files, API keys, credentials, or files outside this repository root.
     - DO NOT invoke remote homelab or SSH commands (hl, ottbox, ssh, arcane, cloudflare).
     - Local workstation testing (including local Docker Desktop containers, node/pnpm/cargo/pytest test runners) is PERMITTED.
     - Do not run `git push` or switch branches; leave your changes in the current worktree for Antigravity to review.
     [TASK SPECIFICATION]
     ```

---

### 4.3 `src/project-binding.ts` — 1:1 AGY $\leftrightarrow$ Hermes Project Resolver

Uses Node 26 `import { DatabaseSync } from "node:sqlite"` (with `{ readOnly: true }` when reading).

Exports:
1. `resolveAntigravityProject(options: { cwd?: string; conversationId?: string; project?: string }): Promise<ResolvedProject>`
   - **Step 1**: Determine the target Antigravity project and workspace folder:
     - Loads all `~/.gemini/config/projects/*.json` files. Parses `id`, `name`, and `projectResources.resources[].gitFolder.folderUri` (converting `file:///d%3A/Code/...` -> `D:\Code\...`).
     - If `options.conversationId` is provided, queries `SELECT project_id FROM conversation_summaries WHERE conversation_id = ?` in `~/.gemini/antigravity/conversation_summaries.db` and matches `project_id` to the loaded project JSON.
     - If `options.project` is provided, matches by project `name` or `id` (case-insensitive).
     - If `options.cwd` is provided, finds the project whose `folderUri` matches or is an ancestor of `options.cwd` (or uses `options.cwd` directly as the repo path if no AGY project JSON has a `folderUri` attached).
   - **Step 2**: Resolve or Auto-Provision the 1:1 Hermes Project in `C:\Users\Otter\AppData\Local\hermes\projects.db`:
     - Queries `projects` (`id, slug, name, primary_path`) and `project_folders` (`project_id, path`) in `projects.db`.
     - Matches by normalized filesystem path (`os.path.normcase`-equivalent: lowercase, backslashes normalized, trailing slash stripped) where `target === folder || target.startsWith(folder + "\\")`.
     - Fallback match by slug/name (`project.name.toLowerCase()`).
     - **Auto-Provisioning**: If no matching project exists in `projects.db` and we have a valid `repoPath`, spawns `hermes.exe project create "<projectName>" "<repoPath>" --slug "<slug>"` so the 1:1 binding is guaranteed!

---

### 4.4 `src/memory-manager.ts` — Canonical `write_approval` & Batch Salvage Engine

Integrates directly with Hermes' Python runtime (`C:\Users\Otter\AppData\Local\hermes\tools\python-*\python.exe` + `hermes_bootstrap`) so all memory/skill operations respect `tools/write_approval.py`, `hermes_cli/write_approval_commands.py`, and `tools/memory_tool_store.py:MemoryStore`.

Exports:
1. `inspectMemory(): Promise<MemoryInspection>`
   - Returns current contents, entry counts, and character usage (`char_count` vs `char_limit` `40000`/`16000`) of `MEMORY.md` and `USER.md`, plus counts of staged files in `pending/memory/*.json` and `pending/skills/*.json`.
2. `snapshotPendingIds(): { memory: Set<string>; skills: Set<string> }`
   - Fast synchronous directory scan of `pending/memory/*.json` and `pending/skills/*.json` before a dispatch run.
3. `collectNewPendingWrites(before: { memory: Set<string>; skills: Set<string> }): PendingRecord[]`
   - Reads any newly created `<id>.json` files after a dispatch run (waiting up to 1.5s if `bg-review` is finishing its write).
4. `managePendingWrites(params: { action: "list" | "preview" | "diagnose" | "salvage" | "approve" | "reject"; subsystem?: "memory" | "skills" | "all"; id?: string }): Promise<PendingWritesResult>`
   - **`list` / `preview`**: Returns all pending records with their `id`, `subsystem`, `origin`, `summary`, `created_at`, and per-operation previews (including pinned `matched_entry` before-text vs proposed `content`, or unified diff for skills via `wa.skill_pending_diff`).
   - **`diagnose` (Dry-Run Sequential & Live Classification)**:
     - Evaluates every operation $i$ of every pending memory batch against the live `MemoryStore` (and sequentially across the queue), classifying each op as:
       - `VALID`: `matched_entry` exists in working entries (or `add` is within budget).
       - `REDUNDANT_NOOP`:
         - `action === "remove"` where `matched_entry` is absent AND `old_text.trim()` does not appear in working entries (already removed).
         - `action === "patch"` where `matched_entry` is absent AND `content.trim()` already appears in working entries (patch already applied).
         - `action === "add"` where `content.trim()` is already an exact entry in working entries.
       - `REBINDABLE`:
         - `action in ("patch", "remove")` where `matched_entry` is absent, **but** `_find_unique_match(working, old_text.trim())` returns a single unambiguous index `(idx !== null && !ambiguous)`.
       - `CONFLICT`:
         - Unresolvable `old_text` (0 matches on a `patch`, or `ambiguous` multiple matches, or `over_budget`).
   - **`salvage`**:
     - For the target `id` (or `"all"`):
       - Strips `REDUNDANT_NOOP` ops.
       - Re-pins `REBINDABLE` ops by updating `op.matched_entry = working[idx]`.
       - If all ops in a record were `REDUNDANT_NOOP`, discards the record via `wa.discard_pending("memory", id)` and reports it as `auto_pruned_redundant`.
       - If some ops are `VALID`/`REBINDABLE` and some are `CONFLICT`, rewrites `<id>.json` via `atomic_json_write` with the valid/rebound operations so the record is immediately approvable, and returns the split-out `CONFLICT` ops in `unresolvable_ops`.
   - **`approve`**:
     - Calls `handle_pending_subcommand(subsystem, ["approve", id], memory_store=load_on_disk_store())` via Hermes' Python runtime.
   - **`reject`**:
     - Calls `handle_pending_subcommand(subsystem, ["reject", id])`.

---

### 4.5 `src/hermes-cli.ts` — Worktree Lifecycle & Gateway JSONL Runner

Exports:
1. `dispatchHermesTask(options: DispatchOptions): Promise<DispatchResult>`
   - **Step 1 (Guardrails)**: Runs `scanPromptForSecrets(options.prompt)`. If unsafe, throws immediately. Prepends `injectWorkerBoundary(options.prompt)`.
   - **Step 2 (Project Binding)**: Calls `resolveAntigravityProject(...)` to get `repoRoot` and Hermes project metadata.
   - **Step 3 (Worktree Creation)**:
     - Ensures `.worktrees/` is present in `<repoRoot>/.git/info/exclude`.
     - Captures `baseSha = git rev-parse HEAD` in `repoRoot`.
     - Creates isolated worktree:
       - `runId = "<timestamp>-<random4>"`
       - `branchName = "hermes/agy-" + runId`
       - `worktreePath = path.join(repoRoot, ".worktrees", "agy-" + runId)`
       - Executes `git worktree add -b <branchName> "<worktreePath>" HEAD`.
   - **Step 4 (Pending Snapshot & Prompt File)**:
     - Calls `snapshotPendingIds()`.
     - Writes guarded prompt to a temporary file in `os.tmpdir()` (`hermes-prompt-<runId>.txt`) and cleans it up in `finally`.
   - **Step 5 (Subprocess Execution)**:
     - Thread title: `sessionName = options.sessionName || "[AGY] " + truncateTitle(options.prompt, 48)`.
     - Spawns `hermes.exe` with `windowsHide: true`:
       ```text
       chat --query-file <tempPromptFile> --format stream-json --in <worktreePath> -c <sessionName> --create-if-missing --yolo --source antigravity
       ```
       *(plus `--model <options.model>` if specified, `--skills <options.skills.join(",")>` if specified).*
     - Parses newline-delimited JSON objects on `stdout`:
       - Captures `session_id` from `type === "system" && subtype === "init"` or `type === "result"`.
       - Accumulates `tool_use` and `tool_result` summaries.
       - Captures final `text`, `exit_code`, `tokens`, and `duration_ms` from `type === "result"`.
     - Enforces timeout (`timeoutSeconds`, default `300`s); on timeout, kills process tree via `taskkill /PID <pid> /T /F`.
   - **Step 6 (Diff & Output Firewall)**:
     - Inside `worktreePath`: runs `git add -N .`, then `git diff --name-only <baseSha>` and `git diff <baseSha>`.
     - Passes modified file list to `validateModifiedFiles(modifiedFiles, worktreePath)`.
     - **Fail-Closed Check**: If `validateModifiedFiles` returns `valid: false`, immediately destroys the worktree (`git worktree remove --force "<worktreePath>"` and `git branch -D <branchName>`), and returns `{ success: false, security_violation: true, violations }`.
     - If no files were modified (`modifiedFiles.length === 0`), automatically cleans up the empty worktree and branch so clean read-only/audit runs leave zero worktree clutter behind!
   - **Step 7 (Session CWD Re-Anchoing & Reasoning Fetch)**:
     - Opens `C:\Users\Otter\AppData\Local\hermes\state.db` via `DatabaseSync`:
       - Updates `UPDATE sessions SET cwd = ?, git_repo_root = ? WHERE id = ?` with `repoRoot` so Hermes Desktop always anchors the session to the main project root.
       - Queries `SELECT reasoning, reasoning_content FROM messages WHERE session_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1` to extract DeepSeek's chain-of-thought reasoning.
   - **Step 8 (New Pending Memory/Skill Writes)**:
     - Calls `collectNewPendingWrites(beforeSnapshot)` and returns the full structured `DispatchResult`.

2. `manageWorktree(options: { action: "apply" | "discard"; cwd: string; worktreeBranch: string }): Promise<{ success: boolean; message: string }>`
   - Resolves `worktreePath` from `git worktree list --porcelain` matching `worktreeBranch`.
   - If `action === "apply"`:
     - Inside `worktreePath`, if uncommitted changes exist, commits them to `worktreeBranch` (`git add -A && git commit -m "hermes-worker: staged changes"`), or generates a patch (`git diff <baseSha>`) and applies it cleanly to `cwd` (`git apply --3way`), then removes the worktree (`git worktree unlock` + `git worktree remove --force`) and deletes the temporary branch (`git branch -D <worktreeBranch>`).
   - If `action === "discard"`:
     - Unlocks and removes `worktreePath` (`git worktree remove --force`) and deletes `worktreeBranch` (`git branch -D <worktreeBranch>`).

---

### 4.6 `src/index.ts` — MCP Server Entrypoint

Registers the MCP server (`name: "hermes-worker"`, `version: "1.0.0"`) over `StdioServerTransport` with 5 tools:
1. `hermes_dispatch`
2. `hermes_pending_writes`
3. `hermes_inspect_memory`
4. `hermes_worktree_action`
5. `hermes_list_sessions` (queries `state.db` `sessions` table filtered by project `cwd` prefix, returning `id`, `title`, `model`, `started_at`, `message_count`, `tool_call_count`, `cwd`).

---

## 5. Verification & Test Suite Requirements (`tests/*.test.ts`)

Use Node's native test runner (`node:test` and `node:assert/strict`). Ensure all handles/DB connections close cleanly in `try ... finally` or `t.after()`.

1. **`tests/guardrails.test.ts`**:
   - Verifies `.env`, `.env.local`, `config/.env.production`, `certs/server.key`, `.gemini/config/mcp_config.json`, and `../outside.ts` are blocked by `validateModifiedFiles`.
   - Verifies normal repo files (`src/index.ts`, `Dockerfile`, `compose.yaml`, `tests/app.test.ts`) pass `validateModifiedFiles`.
   - Verifies `scanPromptForSecrets` catches `ghp_...`, `sk-or-v1-...`, and `-----BEGIN OPENSSH PRIVATE KEY-----`.
   - Verifies `injectWorkerBoundary` prepends the security contract.
2. **`tests/project-binding.test.ts`**:
   - Verifies URI normalization (`file:///d%3A/Code/OtterBoops/agylity` -> `D:\Code\OtterBoops\agylity`).
   - Verifies `resolveAntigravityProject` resolves `D:\Code\OtterBoops\agylity` to Hermes project `agylity` (`p_505dc8d1`), `D:\Code\OtterBoops\compose` to `ottbox`, and `D:\Code\OtterBoops\hermes-worker` to `hermes-worker` (`p_f52dbfd9`).
3. **`tests/memory-manager.test.ts`**:
   - Verifies `inspectMemory()` reads `MEMORY.md` and `USER.md` character counts and pending counts.
   - Verifies `managePendingWrites({ action: "diagnose", subsystem: "memory" })` runs against Hermes' `MemoryStore` and accurately classifies operations (`VALID`, `REDUNDANT_NOOP`, `REBINDABLE`, `CONFLICT`) without mutating disk during `diagnose`.
4. **Build Gate**:
   - `pnpm install`
   - `pnpm run build` (zero TypeScript errors, emits `dist/index.js`)
   - `pnpm test` (all unit and integration tests green)
