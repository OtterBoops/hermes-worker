import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { run } from "./exec.js";
import { hermesAgentRoot, hermesHome, resolveHermesPython } from "./hermes-paths.js";

/**
 * Runs inside Hermes' own Python so memory/skill writes go through the same MemoryStore,
 * write-approval gate and pending store as the CLI. Request in a file, response in a file:
 * stdout carries import noise and must not be parsed.
 */
const BRIDGE_SCRIPT = String.raw`
import json
import os
import re
import sys
import time
import traceback
from pathlib import Path

ROOT = Path(os.environ.get("HERMES_AGENT_ROOT") or "").resolve()
sys.path.insert(0, str(ROOT))
try:
    import tools.write_approval  # noqa: F401
except ImportError:
    from pm.environments import activate_dependencies

    activate_dependencies(ROOT)
    sys.path.insert(0, str(ROOT))

from hermes_constants import get_hermes_home
from hermes_cli.write_approval_commands import handle_pending_subcommand
from tools import write_approval as wa
from tools.memory_tool import load_on_disk_store
from tools.memory_tool_store import (
    ENTRY_DELIMITER,
    _find_unique_match,
    _patch_entry,
)
from utils import atomic_json_write

SUBSYSTEMS = ("memory", "skills")
ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")
DESTRUCTIVE = ("patch", "replace", "remove")


def _check_subsystem(value, allow_all=False):
    if value is not None and value not in SUBSYSTEMS and not (allow_all and value == "all"):
        raise ValueError("unknown subsystem '{}'".format(value))
    return value


def _check_id(value):
    """A pending id becomes a filename component: 'all' or one bare token, never a path."""
    if value is None or value == "":
        return value
    if str(value) == "all" or ID_PATTERN.match(str(value)):
        return str(value)
    raise ValueError("invalid pending id '{}'".format(value))


def _ops(payload):
    if (payload.get("action") or "") == "batch":
        return [op for op in (payload.get("operations") or []) if isinstance(op, dict)]
    return [payload]


def _safe_record_id(rec):
    """An id read back from disk becomes a filename component here, so it is re-validated."""
    value = rec.get("id") if isinstance(rec, dict) else None
    if isinstance(value, str) and value != "all" and ID_PATTERN.match(value):
        return value
    return None


def _unreadable(subsystem, rec, exc):
    """A record that cannot be described is still reported, because the operator can reject it."""
    record = rec if isinstance(rec, dict) else {}
    ident, created, origin = record.get("id"), record.get("created_at"), record.get("origin")
    return {
        "id": ident if isinstance(ident, str) else "",
        "subsystem": subsystem,
        "action": "",
        "origin": origin if isinstance(origin, str) else "unknown",
        "summary": "unreadable pending record: {}: {}".format(type(exc).__name__, exc),
        "created_at": created if isinstance(created, (int, float)) else 0,
        "target": "memory",
        "ops": [],
        "preview": "(this record could not be read; reject it by id)",
    }


def _content_of(op):
    """MemoryStore writes 'new_text' on legacy patch records; both fields mean the same here."""
    return op.get("content") or op.get("new_text") or ""


def _working(store):
    return {"memory": list(store.memory_entries), "user": list(store.user_entries)}


def _limits(store):
    return {"memory": store.memory_char_limit, "user": store.user_char_limit}


def _entries_and_limit(store, target):
    """Fresh (entries, limit) for *target*, or (None, None) for a target no store backs."""
    limits = _limits(store)
    if target not in limits:
        return None, None
    return list(_working(store)[target]), limits[target]


def _over_budget(entries, limit):
    return "would put memory at {:,}/{:,} chars".format(len(ENTRY_DELIMITER.join(entries)), limit)


def _walk(ops, working, budget):
    """Classify the ops in order, applying each accepted op so op N+1 is judged against the
    state op N would produce. *budget* None skips the char check (the projection pass)."""
    entries = list(working)
    results = []
    for index, op in enumerate(ops):
        action = (op.get("action") or "").lower()
        old_text = op.get("old_text") or ""
        content = _content_of(op)
        matched = op.get("matched_entry")
        status, detail, rebind_to = "VALID", "", None
        idx = entries.index(matched) if matched and matched in entries else None
        stale = bool(matched) and idx is None

        if action == "add":
            stripped = content.strip()
            if not stripped:
                status, detail = "CONFLICT", "add requires content"
            elif stripped in [entry.strip() for entry in entries]:
                status, detail = "REDUNDANT_NOOP", "entry already present"
            elif budget is not None and len(ENTRY_DELIMITER.join(entries + [stripped])) > budget:
                status, detail = "CONFLICT", _over_budget(entries + [stripped], budget)
            else:
                entries.append(stripped)
        elif action in DESTRUCTIVE:
            if not old_text.strip():
                status, detail = "CONFLICT", "{} requires old_text".format(action)
            elif action != "remove" and not content.strip():
                # Checked before the pin: a pinned entry must not turn an empty patch into a deletion.
                status, detail = "CONFLICT", "{} requires content".format(action)
            elif idx is not None:
                pass
            elif action != "remove" and content.strip() in [e.strip() for e in entries]:
                status, detail = "REDUNDANT_NOOP", "patched text already present"
            else:
                ridx, ambiguous = _find_unique_match(entries, old_text.strip())
                if ambiguous:
                    status, detail = "CONFLICT", "old_text matches more than one entry"
                elif ridx is None:
                    status, detail = (
                        ("REDUNDANT_NOOP", "entry already removed")
                        if action == "remove"
                        else ("CONFLICT", "no entry matches old_text")
                    )
                elif action == "remove" and stale:
                    # A remove must never silently delete an entry nobody reviewed.
                    status, detail = "CONFLICT", "entry changed since staged; refusing to rebind remove"
                else:
                    status, detail, rebind_to = "REBINDABLE", "unique match found; will re-pin matched_entry", entries[ridx]
                    idx = ridx
        else:
            status, detail = "CONFLICT", "unsupported action '{}'".format(action)

        if status in ("VALID", "REBINDABLE") and action in DESTRUCTIVE:
            entry = entries[idx]
            if action == "remove":
                entries.pop(idx)
            else:
                patched, error, _failure = _patch_entry(entry, old_text, content)
                if error:
                    status, detail, rebind_to = "CONFLICT", error, None
                elif budget is not None and len(
                    ENTRY_DELIMITER.join(entries[:idx] + [patched] + entries[idx + 1:])
                ) > budget:
                    status, detail, rebind_to = (
                        "CONFLICT",
                        _over_budget(entries[:idx] + [patched] + entries[idx + 1:], budget),
                        None,
                    )
                else:
                    entries[idx] = patched

        results.append({
            "index": index,
            "action": action,
            "old_text": old_text,
            "content": content,
            "matched_entry": matched,
            "status": status,
            "detail": detail,
            "rebind_to": rebind_to,
        })
    return results, entries


def _classify_ops(ops, working, limit):
    """The char budget is judged on the PROJECTED FINAL STATE of the batch: an add+remove pair
    that nets inside the limit must not be rejected for its transient peak."""
    projected, final = _walk(ops, working, None)
    if len(ENTRY_DELIMITER.join(final)) <= limit:
        return projected
    results, _final = _walk(ops, working, limit)
    return results


def _memory_preview(ops):
    lines = []
    for i, op in enumerate(ops):
        lines.append("[{}] {}".format(i + 1, op.get("action")))
        if op.get("old_text"):
            lines.append("    old_text: {}".format(op["old_text"]))
        if op.get("matched_entry"):
            lines.append("    pinned:   {}".format(op["matched_entry"]))
        if op.get("content"):
            lines.append("    content:  {}".format(op["content"]))
    return "\n".join(lines) or "(empty batch)"


def _describe(rec):
    payload = rec.get("payload")
    if not isinstance(payload, dict):
        raise ValueError("pending record has no payload object")
    subsystem = rec.get("subsystem") or "memory"
    item = {
        "id": rec.get("id"),
        "subsystem": subsystem,
        "action": payload.get("action") or rec.get("action"),
        "origin": rec.get("origin"),
        "summary": rec.get("summary"),
        "created_at": rec.get("created_at"),
        "target": payload.get("target") or "memory",
        "ops": [],
    }
    if subsystem == "memory":
        item["ops"] = [
            {
                "action": op.get("action"),
                "old_text": op.get("old_text"),
                "content": _content_of(op),
                "matched_entry": op.get("matched_entry"),
            }
            for op in _ops(payload)
        ]
        item["preview"] = _memory_preview(item["ops"])
    else:
        item["ops"] = [
            {"action": op.get("action"), "name": op.get("name"), "file_path": op.get("file_path")}
            for op in _ops(payload)
        ]
        item["preview"] = wa.skill_pending_diff(rec)
    return item


def op_inspect(_request):
    store = load_on_disk_store()
    out = {
        "hermes_home": str(get_hermes_home()),
        "generated_at": time.time(),
        "pending": {},
        "write_approval": {},
    }
    for target, filename in (("memory", "MEMORY.md"), ("user", "USER.md")):
        entries = store._entries_for(target)
        out[target] = {
            "path": str(store._path_for(target)),
            "filename": filename,
            "entries": len(entries),
            "char_count": store._char_count(target),
            "char_limit": store._char_limit(target),
            "text": ENTRY_DELIMITER.join(entries),
        }
    for subsystem in SUBSYSTEMS:
        out["pending"][subsystem] = len(wa.list_pending(subsystem))
        out["write_approval"][subsystem] = wa.write_approval_enabled(subsystem)
    return out


def op_pending(request):
    requested = _check_subsystem(request.get("subsystem") or "all", allow_all=True)
    requested = requested or "all"
    subsystems = SUBSYSTEMS if requested == "all" else (requested,)
    only_id = _check_id(request.get("id"))
    records = []
    for subsystem in subsystems:
        for rec in wa.list_pending(subsystem):
            if only_id and rec.get("id") != only_id:
                continue
            try:
                records.append(_describe(rec))
            except Exception as exc:  # one unreadable record must not fail the whole listing
                records.append(_unreadable(subsystem, rec, exc))
    return {"subsystem": requested, "count": len(records), "records": records}


def _diagnose_one(store, subsystem, rec):
    payload = rec.get("payload")
    if not isinstance(payload, dict):
        raise ValueError("pending record has no payload object")
    target = payload.get("target") or "memory"
    item = {
        "id": rec.get("id"),
        "subsystem": subsystem,
        "origin": rec.get("origin"),
        "summary": rec.get("summary"),
        "created_at": rec.get("created_at"),
        "target": target,
        "ops": [],
    }
    if subsystem != "memory":
        item["note"] = "skill records are classified by their diff; approve or reject directly"
        return item, []
    # Fresh per record: each one is judged against live state, not against a copy mutated by
    # an earlier record.
    entries, limit = _entries_and_limit(store, target)
    if entries is None:
        item["note"] = "unknown target '{}'; record is not approvable".format(target)
        return item, []
    ops = _classify_ops(_ops(payload), entries, limit)
    item["ops"] = ops
    return item, [result["status"] for result in ops]


def _diagnose_records(store, subsystem, only_id):
    limits = _limits(store)
    records = []
    counts = {"VALID": 0, "REDUNDANT_NOOP": 0, "REBINDABLE": 0, "CONFLICT": 0}
    for rec in wa.list_pending(subsystem):
        if only_id and rec.get("id") != only_id:
            continue
        try:
            item, statuses = _diagnose_one(store, subsystem, rec)
        except Exception as exc:  # one unreadable record must not fail the whole diagnosis
            item, statuses = _unreadable(subsystem, rec, exc), []
            item.pop("preview")
            item["note"] = "unreadable record; reject it by id"
        records.append(item)
        for status in statuses:
            counts[status] = counts.get(status, 0) + 1

    usage = {}
    for target in limits:
        entries = _working(store)[target]
        usage[target] = {
            "entries": len(entries),
            "char_count": len(ENTRY_DELIMITER.join(entries)),
            "char_limit": limits.get(target),
        }
    return {"records": records, "counts": counts, "usage": usage}


def op_diagnose(request):
    subsystem = _check_subsystem(request.get("subsystem") or "memory") or "memory"
    only_id = _check_id(request.get("id"))
    store = load_on_disk_store()
    return _diagnose_records(store, subsystem, only_id)


def op_salvage(request):
    subsystem = _check_subsystem(request.get("subsystem") or "memory")
    if subsystem == "skills":
        # Salvage rewrites MEMORY batches only; a skill record has no ops to re-pin.
        raise ValueError("salvage only handles subsystem 'memory'")
    store = load_on_disk_store()
    target_id = _check_id(request.get("id") or "all") or "all"
    outcomes = []

    for rec in wa.list_pending("memory"):
        if target_id != "all" and rec.get("id") != target_id:
            continue
        record_id = _safe_record_id(rec)
        if record_id is None:
            outcomes.append({
                "id": rec.get("id") if isinstance(rec.get("id"), str) else "",
                "outcome": "unchanged",
                "kept": 0,
                "dropped": 0,
                "unresolvable_ops": [],
                "message": "record id is not a bare token; the record was left in place",
            })
            continue
        payload = rec.get("payload")
        if not isinstance(payload, dict):
            payload = {}
        target = payload.get("target") or "memory"
        entries, limit = _entries_and_limit(store, target)
        if entries is None:
            outcomes.append({
                "id": rec.get("id"),
                "outcome": "unchanged",
                "kept": 0,
                "dropped": 0,
                "unresolvable_ops": [],
                "message": "unknown target '{}'; the record was left in place".format(target),
            })
            continue
        ops = _ops(payload)
        results = _classify_ops(ops, entries, limit)

        kept, dropped, unresolvable = [], [], []
        for op, result in zip(ops, results):
            if result["status"] == "REDUNDANT_NOOP":
                dropped.append(result)
            elif result["status"] == "CONFLICT":
                unresolvable.append(result)
            else:
                patched = dict(op)
                if result["status"] == "REBINDABLE" and result["rebind_to"]:
                    patched["matched_entry"] = result["rebind_to"]
                kept.append(patched)

        if not kept and dropped:
            wa.discard_pending("memory", record_id)
            outcomes.append({
                "id": rec.get("id"),
                "outcome": "auto_pruned_redundant",
                "kept": 0,
                "dropped": len(dropped),
                "unresolvable_ops": [],
                "message": "every operation was already reflected in memory; record discarded",
            })
            continue

        if not kept:
            outcomes.append({
                "id": rec.get("id"),
                "outcome": "unchanged",
                "kept": 0,
                "dropped": 0,
                "unresolvable_ops": unresolvable,
                "message": "no approvable operation; the record was left in place",
            })
            continue

        if (payload.get("action") or "") == "batch":
            new_payload = dict(payload)
            new_payload["operations"] = kept
        else:
            new_payload = dict(kept[0])
            if "target" in payload:
                new_payload["target"] = payload["target"]

        changed = new_payload != payload
        if changed:
            updated = dict(rec)
            updated["payload"] = new_payload
            atomic_json_write(wa._pending_path("memory", record_id), updated)

        outcomes.append({
            "id": rec.get("id"),
            "outcome": "rewritten" if changed else "unchanged",
            "kept": len(kept),
            "dropped": len(dropped),
            "unresolvable_ops": unresolvable,
            "message": "record is now approvable" if changed else "record already approvable",
        })

    return {"id": target_id, "outcomes": outcomes}


def _after(subsystem, text):
    return {
        "output": text,
        "pending_remaining": len(wa.list_pending(subsystem)),
    }


def op_approve(request):
    subsystem = _check_subsystem(request.get("subsystem") or "memory") or "memory"
    pending_id = _check_id(request.get("id"))
    if not pending_id:
        raise ValueError("approve requires an id (or 'all')")
    store = load_on_disk_store() if subsystem == "memory" else None
    text = handle_pending_subcommand(subsystem, ["approve", pending_id], memory_store=store)
    return _after(subsystem, text or "")


def op_reject(request):
    subsystem = _check_subsystem(request.get("subsystem") or "memory") or "memory"
    pending_id = _check_id(request.get("id"))
    if not pending_id:
        raise ValueError("reject requires an id (or 'all')")
    text = handle_pending_subcommand(subsystem, ["reject", pending_id])
    return _after(subsystem, text or "")


HANDLERS = {
    "inspect": op_inspect,
    "pending": op_pending,
    "diagnose": op_diagnose,
    "salvage": op_salvage,
    "approve": op_approve,
    "reject": op_reject,
}


def main():
    request_path = Path(sys.argv[1])
    response_path = Path(sys.argv[2])
    record = {}

    try:
        request = json.loads(request_path.read_text(encoding="utf-8-sig"))
        handler = HANDLERS.get(request.get("op"))
        if handler is None:
            raise ValueError("unknown op '{}'".format(request.get("op")))
        record = {"ok": True, "result": handler(request)}
    except Exception as exc:  # structured failure beats a non-zero exit the caller cannot read
        record = {
            "ok": False,
            "error": "{}: {}".format(type(exc).__name__, exc),
            "traceback": traceback.format_exc(),
        }

    atomic_json_write(response_path, record, default=str)


main()
`;

export interface BridgeRequest {
  op: "inspect" | "pending" | "diagnose" | "salvage" | "approve" | "reject";
  subsystem?: "memory" | "skills" | "all";
  id?: string;
}

const SUBSYSTEMS = new Set(["memory", "skills", "all"]);
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * A pending id is a filename component on the Python side, so a traversal id must never reach a
 * spawned process. Validated here as well as there: defence in depth, and the error names the value.
 */
const validateRequest = (request: BridgeRequest): void => {
  if (request.subsystem !== undefined && !SUBSYSTEMS.has(request.subsystem)) {
    throw new Error(`Unknown subsystem '${String(request.subsystem)}' (expected memory, skills or all)`);
  }
  if (request.id !== undefined && request.id !== "all" && !ID_PATTERN.test(request.id)) {
    throw new Error(`Invalid pending id '${request.id}' (expected 'all' or [A-Za-z0-9_-]+)`);
  }
};

const bridgeEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  HERMES_HOME: hermesHome(),
  HERMES_AGENT_ROOT: hermesAgentRoot(),
  PYTHONIOENCODING: "utf-8",
  PYTHONUTF8: "1",
});

let scriptPathPromise: Promise<string> | null = null;

/**
 * The script is written once per process into a private mkdtemp dir: a predictable shared name
 * would let any local user pre-create or read it. A scratch cleaner can delete os.tmpdir() under a
 * long-lived server, so a missing file is rebuilt instead of failing every call from then on.
 */
const ensureScript = async (): Promise<string> => {
  if (scriptPathPromise) {
    try {
      const existing = await scriptPathPromise;
      await fs.access(existing);
      return existing;
    } catch {
      scriptPathPromise = null;
    }
  }
  const created = (async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-worker-script-"));
    const file = path.join(dir, "hermes_bridge.py");
    await fs.writeFile(file, BRIDGE_SCRIPT, { encoding: "utf8", mode: 0o600 });
    return file;
  })();
  scriptPathPromise = created;
  // One transient failure must not be cached for the life of the process.
  created.catch(() => {
    if (scriptPathPromise === created) scriptPathPromise = null;
  });
  return created;
};

export const runBridge = async <T = unknown>(
  request: BridgeRequest,
  options: { timeoutMs?: number } = {},
): Promise<T> => {
  validateRequest(request);
  const [python, script] = await Promise.all([resolveHermesPython(), ensureScript()]);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-worker-run-"));
  const requestPath = path.join(dir, "request.json");
  const responsePath = path.join(dir, "response.json");

  try {
    await fs.writeFile(requestPath, JSON.stringify(request), "utf8");
    // -X utf8: -I drops the environment, so PYTHONUTF8 alone would not enable UTF-8 mode.
    const result = await run(python, ["-I", "-X", "utf8", script, requestPath, responsePath], {
      env: bridgeEnv(),
      timeoutMs: options.timeoutMs ?? 120_000,
    });

    const stderr = (result.stderr || result.stdout).trim();
    if (result.timedOut) {
      throw new Error(`Hermes bridge timed out after ${options.timeoutMs ?? 120_000}ms: ${stderr}`);
    }
    if (result.code !== 0) {
      throw new Error(`Hermes bridge exited ${result.code}: ${stderr}`);
    }

    let raw: string;
    try {
      raw = await fs.readFile(responsePath, "utf8");
    } catch {
      throw new Error(`Hermes bridge produced no response (exit ${result.code}): ${stderr}`);
    }

    let parsed: { ok: true; result: T } | { ok: false; error: string; traceback?: string };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Hermes bridge returned unparseable JSON (exit ${result.code}): ${reason}: ${stderr}`);
    }
    if (!parsed.ok) {
      throw new Error(`Hermes bridge error: ${parsed.error}${parsed.traceback ? `\n${parsed.traceback}` : ""}`);
    }
    return parsed.result;
  } finally {
    // A locked Windows temp dir must not mask the real error.
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
};

export { BRIDGE_SCRIPT };
