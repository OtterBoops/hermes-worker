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
    _normalize_for_match,
    _patch_entry,
)
from utils import atomic_json_write

SUBSYSTEMS = ("memory", "skills")


def _ops(payload):
    if (payload.get("action") or "") == "batch":
        return [op for op in (payload.get("operations") or []) if isinstance(op, dict)]
    return [payload]


def _content_of(op):
    value = op.get("content")
    return value if value is not None else (op.get("new_text") or "")


def _present(entries, needle):
    needle = (needle or "").strip()
    if not needle:
        return False
    if any(needle in entry for entry in entries):
        return True
    folded = _normalize_for_match(needle)
    if not any(ch.isalnum() for ch in folded):
        return False
    return any(folded in _normalize_for_match(entry) for entry in entries)


def _working(store):
    return {"memory": list(store.memory_entries), "user": list(store.user_entries)}


def _limits(store):
    return {"memory": store.memory_char_limit, "user": store.user_char_limit}


def _classify_ops(ops, working, limit):
    """Classify every op against the live entries, applying each accepted op in turn so the
    next one is judged against the state the approval would actually produce."""
    results = []
    for index, op in enumerate(ops):
        action = (op.get("action") or "").lower()
        old_text = op.get("old_text") or ""
        content = _content_of(op)
        matched = op.get("matched_entry")
        status, detail, rebind_to = "VALID", "", None
        idx = working.index(matched) if matched and matched in working else None

        if action == "add":
            if content.strip() and content.strip() in [entry.strip() for entry in working]:
                status, detail = "REDUNDANT_NOOP", "entry already present"
            else:
                total = len(ENTRY_DELIMITER.join(working + [content]))
                if total > limit:
                    status, detail = "CONFLICT", "would put memory at {:,}/{:,} chars".format(total, limit)
                else:
                    working.append(content)
        elif action in ("patch", "remove"):
            if action == "patch" and not old_text.strip():
                status, detail = "CONFLICT", "patch requires old_text"
            elif idx is not None:
                pass
            elif action == "remove" and not _present(working, old_text):
                status, detail = "REDUNDANT_NOOP", "entry already removed"
            elif action == "patch" and content.strip() and content.strip() in [e.strip() for e in working]:
                status, detail = "REDUNDANT_NOOP", "patched text already present"
            else:
                ridx, ambiguous = _find_unique_match(working, old_text.strip())
                if ambiguous:
                    status, detail = "CONFLICT", "old_text matches more than one entry"
                elif ridx is None:
                    status, detail = "CONFLICT", "no entry matches old_text"
                else:
                    status, detail, rebind_to = "REBINDABLE", "unique match found; will re-pin matched_entry", working[ridx]
                    idx = ridx
        else:
            status, detail = "CONFLICT", "unsupported action '{}'".format(action)

        if status in ("VALID", "REBINDABLE") and action in ("patch", "remove"):
            entry = working[idx]
            if action == "remove":
                working.pop(idx)
            else:
                patched, error, _failure = _patch_entry(entry, old_text, content)
                if error:
                    status, detail, rebind_to = "CONFLICT", error, None
                else:
                    working[idx] = patched

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
    payload = rec.get("payload") or {}
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
    requested = request.get("subsystem") or "all"
    subsystems = SUBSYSTEMS if requested == "all" else (requested,)
    only_id = request.get("id")
    records = []
    for subsystem in subsystems:
        if subsystem not in SUBSYSTEMS:
            raise ValueError("unknown subsystem '{}'".format(subsystem))
        for rec in wa.list_pending(subsystem):
            if only_id and rec.get("id") != only_id:
                continue
            records.append(_describe(rec))
    return {"subsystem": requested, "count": len(records), "records": records}


def _diagnose_records(store, subsystem, only_id):
    working = _working(store)
    limits = _limits(store)
    records = []
    counts = {"VALID": 0, "REDUNDANT_NOOP": 0, "REBINDABLE": 0, "CONFLICT": 0}
    for rec in wa.list_pending(subsystem):
        if only_id and rec.get("id") != only_id:
            continue
        payload = rec.get("payload") or {}
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
        if subsystem == "memory":
            if target not in working:
                working[target] = []
            ops = _classify_ops(_ops(payload), working[target], limits[target])
            item["ops"] = ops
            for result in ops:
                counts[result["status"]] = counts.get(result["status"], 0) + 1
        else:
            item["note"] = "skill records are classified by their diff; approve or reject directly"
        records.append(item)

    usage = {}
    for target, entries in working.items():
        usage[target] = {
            "entries": len(entries),
            "char_count": len(ENTRY_DELIMITER.join(entries)),
            "char_limit": limits.get(target),
        }
    return {"records": records, "counts": counts, "usage": usage}


def op_diagnose(request):
    store = load_on_disk_store()
    subsystem = request.get("subsystem") or "memory"
    if subsystem not in SUBSYSTEMS:
        raise ValueError("unknown subsystem '{}'".format(subsystem))
    return _diagnose_records(store, subsystem, request.get("id"))


def op_salvage(request):
    store = load_on_disk_store()
    target_id = request.get("id") or "all"
    working = _working(store)
    limits = _limits(store)
    outcomes = []

    for rec in wa.list_pending("memory"):
        payload = rec.get("payload") or {}
        target = payload.get("target") or "memory"
        if target not in working:
            working[target] = []
        ops = _ops(payload)
        results = _classify_ops(ops, working[target], limits[target])
        if target_id != "all" and rec.get("id") != target_id:
            continue

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
            wa.discard_pending("memory", rec["id"])
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
            atomic_json_write(wa._pending_path("memory", rec["id"]), updated)

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
    subsystem = request.get("subsystem") or "memory"
    pending_id = request.get("id")
    if not pending_id:
        raise ValueError("approve requires an id (or 'all')")
    store = load_on_disk_store() if subsystem == "memory" else None
    text = handle_pending_subcommand(subsystem, ["approve", pending_id], memory_store=store)
    return _after(subsystem, text or "")


def op_reject(request):
    subsystem = request.get("subsystem") or "memory"
    pending_id = request.get("id")
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

    response_path.write_text(json.dumps(record, ensure_ascii=False, default=str), encoding="utf-8")


main()
`;

export interface BridgeRequest {
  op: "inspect" | "pending" | "diagnose" | "salvage" | "approve" | "reject";
  subsystem?: "memory" | "skills" | "all";
  id?: string;
}

const bridgeEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  HERMES_HOME: hermesHome(),
  HERMES_AGENT_ROOT: hermesAgentRoot(),
  PYTHONIOENCODING: "utf-8",
  PYTHONUTF8: "1",
});

let scriptPathPromise: Promise<string> | null = null;

/** The script is written once per process, into the scratch dir the host already owns. */
const ensureScript = (): Promise<string> => {
  scriptPathPromise ??= (async () => {
    const dir = path.join(os.tmpdir(), "hermes-worker");
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, "hermes_bridge.py");
    await fs.writeFile(file, BRIDGE_SCRIPT, "utf8");
    return file;
  })();
  return scriptPathPromise;
};

export const runBridge = async <T = unknown>(
  request: BridgeRequest,
  options: { timeoutMs?: number } = {},
): Promise<T> => {
  const [python, script] = await Promise.all([resolveHermesPython(), ensureScript()]);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-worker-run-"));
  const requestPath = path.join(dir, "request.json");
  const responsePath = path.join(dir, "response.json");

  try {
    await fs.writeFile(requestPath, JSON.stringify(request), "utf8");
    const result = await run(python, ["-I", script, requestPath, responsePath], {
      env: bridgeEnv(),
      timeoutMs: options.timeoutMs ?? 120_000,
    });

    let raw: string;
    try {
      raw = await fs.readFile(responsePath, "utf8");
    } catch {
      throw new Error(
        `Hermes bridge produced no response (exit ${result.code}): ${(result.stderr || result.stdout).trim()}`,
      );
    }

    const parsed = JSON.parse(raw) as
      | { ok: true; result: T }
      | { ok: false; error: string; traceback?: string };
    if (!parsed.ok) {
      throw new Error(`Hermes bridge error: ${parsed.error}${parsed.traceback ? `\n${parsed.traceback}` : ""}`);
    }
    return parsed.result;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
};

export { BRIDGE_SCRIPT };
