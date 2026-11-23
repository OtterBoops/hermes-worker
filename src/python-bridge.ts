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
import sqlite3
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


def op_projects_list(_request):
    from hermes_cli import projects_db as pdb

    db_path = pdb.projects_db_path()
    if not db_path.exists():
        return {"projects": []}

    rows_out = []
    with pdb.connect_closing(db_path) as conn:
        try:
            projects = pdb.list_projects(conn)
            for raw_proj in projects:
                proj = raw_proj.to_dict() if hasattr(raw_proj, "to_dict") else raw_proj
                if proj.get("archived"):
                    continue
                folders = [f.get("path") for f in (proj.get("folders") or []) if f.get("path")]
                rows_out.append({
                    "id": proj["id"],
                    "slug": proj["slug"],
                    "name": proj["name"],
                    "primary_path": proj.get("primary_path"),
                    "folders": folders,
                })
        except sqlite3.OperationalError as exc:
            if "no such column" not in str(exc).lower() and "no such table" not in str(exc).lower():
                raise
            # The fallback covers the schema that lacks the column: selecting it again would raise
            # the very error this branch exists for.
            cur = conn.execute(
                "SELECT id, slug, name, primary_path FROM projects"
            )
            by_id = {}
            for row in cur.fetchall():
                pid = row["id"] if isinstance(row, sqlite3.Row) else row[0]
                slug = row["slug"] if isinstance(row, sqlite3.Row) else row[1]
                name = row["name"] if isinstance(row, sqlite3.Row) else row[2]
                primary_path = row["primary_path"] if isinstance(row, sqlite3.Row) else row[3]
                by_id[pid] = {
                    "id": pid,
                    "slug": slug,
                    "name": name,
                    "primary_path": primary_path,
                    "folders": [],
                }
            try:
                fcur = conn.execute("SELECT project_id, path FROM project_folders")
                for frow in fcur.fetchall():
                    pid = frow["project_id"] if isinstance(frow, sqlite3.Row) else frow[0]
                    fpath = frow["path"] if isinstance(frow, sqlite3.Row) else frow[1]
                    if pid in by_id and fpath:
                        by_id[pid]["folders"].append(fpath)
            except sqlite3.OperationalError:
                pass
            rows_out = list(by_id.values())
    return {"projects": rows_out}


def _parse_gateway_runtime(model_config_raw):
    if not model_config_raw:
        return None, False
    try:
        parsed = json.loads(model_config_raw) if isinstance(model_config_raw, str) else model_config_raw
    except Exception:
        return None, False
    if not isinstance(parsed, dict):
        return None, False
    runtime = parsed.get("gateway_runtime")
    if not isinstance(runtime, dict):
        return None, False
    provider = runtime.get("provider")
    return (provider if isinstance(provider, str) else None), (runtime.get("fallback_active") is True)


def _try_gateway_session_info(session_id):
    try:
        import asyncio
        from hermes_cli.gateway_runtime import attachable, discover_gateway_endpoint
        from hermes_cli.gateway_client import connect_gateway

        discovery = discover_gateway_endpoint(get_hermes_home(), timeout=0.6)
        if not attachable(discovery) or discovery.endpoint is None:
            return None, None

        async def _query():
            async with connect_gateway(discovery.endpoint) as client:
                info = await client.rpc("session.info", session_id=session_id)
                transcript = None
                try:
                    transcript = await client.rpc("session.transcript", session_id=session_id, order="latest", limit=20)
                except Exception:
                    pass
                return info, transcript

        return asyncio.run(asyncio.wait_for(_query(), timeout=4.0))
    except Exception:
        return None, None


def op_session_info(request):
    session_id = request.get("sessionId")
    if not session_id or not isinstance(session_id, str):
        raise ValueError("session_info requires sessionId")
    repo_root = request.get("repoRoot")

    out = {
        "reasoning": None,
        "model": None,
        "provider": None,
        "fallbackActive": False,
        "known": False,
        "tipSessionId": session_id,
        "compactionCount": 0,
        # A handoff has no carrier table a read-only probe can reach, so the caller falls back to
        # lastAssistantSummary; this field stays null by design.
        "compactionSummary": None,
        "lastAssistantSummary": None,
    }

    gw_info, gw_transcript = _try_gateway_session_info(session_id)
    if isinstance(gw_info, dict):
        sess = gw_info.get("session") if isinstance(gw_info.get("session"), dict) else gw_info
        model = sess.get("model")
        if isinstance(model, str) and model.strip():
            out["model"] = model
            out["known"] = True
        provider, fallback = _parse_gateway_runtime(sess.get("model_config"))
        if provider:
            out["provider"] = provider
        if fallback:
            out["fallbackActive"] = True
        if isinstance(sess.get("tip_session_id"), str) and sess.get("tip_session_id"):
            out["tipSessionId"] = sess["tip_session_id"]

    if isinstance(gw_transcript, dict):
        msgs = gw_transcript.get("messages") or []
        for msg in reversed(msgs):
            if isinstance(msg, dict) and msg.get("role") == "assistant":
                r = msg.get("reasoning_content") or msg.get("reasoning")
                if isinstance(r, str) and r:
                    out["reasoning"] = r
                content = msg.get("content")
                if isinstance(content, str) and content.strip():
                    out["lastAssistantSummary"] = content.strip()[:1500]
                break

    db_path = get_hermes_home() / "state.db"
    if not db_path.exists():
        return out

    if repo_root and isinstance(repo_root, str):
        try:
            wconn = sqlite3.connect(str(db_path), timeout=3.0)
            try:
                wconn.execute("UPDATE sessions SET cwd = ?, git_repo_root = ? WHERE id = ?", (repo_root, repo_root, session_id))
                wconn.commit()
            finally:
                wconn.close()
        except Exception:
            pass

    try:
        from hermes_state import SessionDB

        db = SessionDB(db_path=db_path, read_only=True)
    except Exception:
        return out

    try:
        conn = db._conn
        try:
            row = conn.execute("SELECT model, model_config FROM sessions WHERE id = ?", (session_id,)).fetchone()
        except sqlite3.Error:
            row = None

        if row is not None:
            model_val = row["model"] if isinstance(row, sqlite3.Row) else row[0]
            mc_val = row["model_config"] if isinstance(row, sqlite3.Row) else row[1]
            if isinstance(model_val, str) and model_val.strip():
                out["model"] = out["model"] or model_val
                out["known"] = True
            provider, fallback = _parse_gateway_runtime(mc_val)
            if provider and not out["provider"]:
                out["provider"] = provider
            if fallback:
                out["fallbackActive"] = True

        # Follow parent_session_id chain forward/backward to count compactions and find tip
        try:
            # The chain is a list of session ids, root first: the tail is the live tip.
            chain = db.get_compression_chain(session_id)
            if isinstance(chain, list) and len(chain) > 0:
                out["compactionCount"] = max(0, len(chain) - 1)
                tip = chain[-1]
                if isinstance(tip, str) and tip:
                    out["tipSessionId"] = tip
        except Exception:
            pass

        tip_id = out["tipSessionId"] or session_id
        try:
            msg_row = conn.execute(
                "SELECT reasoning, reasoning_content, content FROM messages "
                "WHERE session_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1",
                (tip_id,),
            ).fetchone()
            if msg_row is not None:
                r = (msg_row["reasoning_content"] if isinstance(msg_row, sqlite3.Row) else msg_row[1]) or (
                    msg_row["reasoning"] if isinstance(msg_row, sqlite3.Row) else msg_row[0]
                )
                if r and not out["reasoning"]:
                    out["reasoning"] = r
                c = msg_row["content"] if isinstance(msg_row, sqlite3.Row) else msg_row[2]
                if isinstance(c, str) and c.strip() and not out["lastAssistantSummary"]:
                    out["lastAssistantSummary"] = c.strip()[:1500]
        except sqlite3.Error:
            pass
    finally:
        try:
            db.close()
        except Exception:
            pass

    return out


SUBAGENT_CHILD_LIMIT = 100
SUBAGENT_MESSAGE_LIMIT = 200
SUBAGENT_PREVIEW_CHARS = 240


def _flat(value, limit):
    """One line, clipped: a worker tail is read line by line, so embedded newlines must go."""
    text = re.sub(r"\s+", " ", value or "").strip()
    return text if len(text) <= limit else text[: limit - 1] + "\u2026"


def _subagent_children(conn, scope, args):
    rows = conn.execute(
        "SELECT id, title, started_at, ended_at, end_reason, message_count, tool_call_count "
        "FROM sessions WHERE {} ORDER BY started_at DESC LIMIT ?".format(scope),
        tuple(args) + (SUBAGENT_CHILD_LIMIT,),
    ).fetchall()
    out = []
    for row in rows:
        out.append({
            "id": row["id"],
            "title": row["title"],
            "startedAt": row["started_at"],
            "done": row["ended_at"] is not None,
            "endReason": row["end_reason"],
            "messageCount": row["message_count"] or 0,
            "toolCallCount": row["tool_call_count"] or 0,
        })
    return out


def op_subagent_activity(request):
    """Child sessions and their new messages under one parent, as a read-only poll.

    sinceStartedAt scopes the children to the turn that is running: a resumed parent carries the
    children of every earlier turn in the same store, and replaying those would both flood the tail
    and keep resetting an inactivity timer on work that finished long ago.
    """
    parent = request.get("parentSessionId")
    if not isinstance(parent, str) or not parent:
        raise ValueError("subagent_activity requires parentSessionId")
    raw_since = request.get("sinceMessageId")
    try:
        since_id = None if raw_since is None else int(raw_since)
    except (TypeError, ValueError):
        since_id = None
    raw_started = request.get("sinceStartedAt")
    try:
        since_started_at = None if raw_started is None else float(raw_started)
    except (TypeError, ValueError):
        since_started_at = None

    scope = "parent_session_id = ? AND source = 'subagent'"
    scope_args = [parent]
    if since_started_at is not None:
        # A row without a start time cannot be placed in time, and hiding it is worse than showing it.
        scope += " AND (started_at IS NULL OR started_at >= ?)"
        scope_args.append(since_started_at)

    out = {
        "parentSessionId": parent,
        "baseline": since_id is None,
        "cursor": 0 if since_id is None else since_id,
        "children": [],
        "messages": [],
    }

    db_path = get_hermes_home() / "state.db"
    # A worker on a machine that never ran Hermes has no store: an empty poll is the answer.
    if not db_path.exists():
        return out

    conn = None
    try:
        conn = sqlite3.connect("file:{}?mode=ro".format(db_path.as_posix()), uri=True, timeout=3.0)
        conn.row_factory = sqlite3.Row
        out["children"] = _subagent_children(conn, scope, scope_args)
        children = "SELECT id FROM sessions WHERE {}".format(scope)
        if since_id is None:
            row = conn.execute(
                "SELECT MAX(id) AS tip FROM messages WHERE session_id IN ({})".format(children),
                tuple(scope_args),
            ).fetchone()
            tip = row["tip"] if row is not None else None
            out["cursor"] = int(tip) if tip is not None else 0
            return out
        rows = conn.execute(
            "SELECT id, session_id, role, tool_name, content FROM messages "
            "WHERE id > ? AND session_id IN ({}) ORDER BY id LIMIT ?".format(children),
            tuple([since_id] + scope_args + [SUBAGENT_MESSAGE_LIMIT]),
        ).fetchall()
        for row in rows:
            out["messages"].append({
                "id": row["id"],
                "sessionId": row["session_id"],
                "role": row["role"],
                "toolName": row["tool_name"],
                "preview": _flat(row["content"], SUBAGENT_PREVIEW_CHARS),
            })
            out["cursor"] = int(row["id"])
        return out
    except sqlite3.Error:
        # An older schema or a locked store is a quiet poll, never a reason to fail a dispatch.
        return out
    finally:
        if conn is not None:
            conn.close()


def _escape_like(value):
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def op_sessions_list(request):
    cwd = request.get("cwd")
    raw_limit = request.get("limit")
    try:
        limit = 25 if raw_limit is None else int(raw_limit)
    except (TypeError, ValueError):
        limit = 25
    limit = min(max(limit, 1), 200)

    db_path = get_hermes_home() / "state.db"
    if not db_path.exists():
        # Try gateway if running, otherwise empty list without creating state.db
        try:
            import asyncio
            from hermes_cli.gateway_runtime import attachable, discover_gateway_endpoint
            from hermes_cli.gateway_client import connect_gateway

            discovery = discover_gateway_endpoint(get_hermes_home(), timeout=0.6)
            if attachable(discovery) and discovery.endpoint is not None:
                async def _list():
                    async with connect_gateway(discovery.endpoint) as client:
                        return await client.rpc("session.list", scope="stored", workspace=cwd, limit=limit)

                res = asyncio.run(asyncio.wait_for(_list(), timeout=4.0))
                if isinstance(res, dict) and isinstance(res.get("sessions"), list):
                    return {"sessions": res["sessions"]}
        except Exception:
            pass
        return {"sessions": []}

    uri = "file:{}?mode=ro".format(db_path.as_posix())
    conn = sqlite3.connect(uri, uri=True, timeout=3.0)
    conn.row_factory = sqlite3.Row
    try:
        columns = "id, title, model, started_at, message_count, tool_call_count, cwd"
        if cwd:
            root = os.path.abspath(cwd).rstrip("\\/")
            prefix = _escape_like(root + os.sep) + "%"
            is_win = os.name == "nt"
            eq = (lambda col: "lower({}) = lower(?)".format(col)) if is_win else (lambda col: "{} = ?".format(col))
            rows = conn.execute(
                f"SELECT {columns} FROM sessions "
                f"WHERE {eq('cwd')} OR cwd LIKE ? ESCAPE '\\' OR {eq('git_repo_root')} OR git_repo_root LIKE ? ESCAPE '\\' "
                "ORDER BY started_at DESC LIMIT ?",
                (root, prefix, root, prefix, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                f"SELECT {columns} FROM sessions ORDER BY started_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return {"sessions": [dict(r) for r in rows]}
    finally:
        conn.close()


HANDLERS = {
    "inspect": op_inspect,
    "pending": op_pending,
    "diagnose": op_diagnose,
    "salvage": op_salvage,
    "approve": op_approve,
    "reject": op_reject,
    "projects_list": op_projects_list,
    "session_info": op_session_info,
    "sessions_list": op_sessions_list,
    "subagent_activity": op_subagent_activity,
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

/** One child session of the run, as `op_subagent_activity` reports it. */
export interface SubagentChildActivity {
  id: string;
  title: string | null;
  startedAt: number | null;
  /** True once the child wrote `ended_at`: the store has no status column to ask. */
  done: boolean;
  endReason: string | null;
  messageCount: number;
  toolCallCount: number;
}

export interface SubagentMessageActivity {
  id: number;
  sessionId: string;
  role: string;
  toolName: string | null;
  /** The message text, flattened and clipped by the bridge: a tail line, not a payload. */
  preview: string | null;
}

export interface SubagentActivity {
  parentSessionId: string;
  /** True when the poll carried no cursor: it reports the children and the tip, but no messages. */
  baseline: boolean;
  /** Highest child message id seen, to pass back as `sinceMessageId` on the next poll. */
  cursor: number;
  children: SubagentChildActivity[];
  messages: SubagentMessageActivity[];
}

export interface BridgeRequest {
  op:
    | "inspect"
    | "pending"
    | "diagnose"
    | "salvage"
    | "approve"
    | "reject"
    | "projects_list"
    | "session_info"
    | "sessions_list"
    | "subagent_activity";
  subsystem?: "memory" | "skills" | "all";
  id?: string;
  sessionId?: string;
  repoRoot?: string;
  cwd?: string;
  limit?: number;
  /** `subagent_activity`: the run whose child sessions and messages are wanted. */
  parentSessionId?: string;
  /** `subagent_activity`: omit for a baseline poll that returns no messages but the cursor. */
  sinceMessageId?: number;
  /** `subagent_activity`: epoch seconds; children started before it belong to an earlier turn. */
  sinceStartedAt?: number;
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
  // A poll without a parent would scan every session's children, so it is refused here as well as
  // in Python: the cost of the mistake is a whole-store read every few seconds.
  if (request.op === "subagent_activity" && !request.parentSessionId) {
    throw new Error("subagent_activity requires parentSessionId");
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

    // A spawn failure carries its reason only on `error`: dropping it reports "exited null".
    const stderr = [result.stderr, result.stdout, result.error].filter((part) => part && part.trim()).join("\n").trim();
    if (result.timedOut) {
      throw new Error(`Hermes bridge timed out after ${options.timeoutMs ?? 120_000}ms: ${stderr}`);
    }
    if (result.code === null) {
      throw new Error(`Hermes bridge could not run: ${result.error ?? (stderr || "no exit status")}`);
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
