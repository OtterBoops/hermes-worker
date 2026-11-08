import fs from "node:fs";
import path from "node:path";
import { pendingDir } from "./hermes-paths.js";
import { runBridge, type BridgeRequest } from "./python-bridge.js";

export interface MemoryStoreStatus {
  path: string;
  filename: string;
  entries: number;
  char_count: number;
  char_limit: number;
  text: string;
}

export interface MemoryInspection {
  hermes_home: string;
  generated_at: number;
  memory: MemoryStoreStatus;
  user: MemoryStoreStatus;
  pending: { memory: number; skills: number };
  write_approval: { memory: boolean; skills: boolean };
}

export type Subsystem = "memory" | "skills";

const SUBSYSTEMS: readonly Subsystem[] = ["memory", "skills"] as const;

export interface PendingOperation {
  action: string;
  old_text?: string | null;
  content?: string | null;
  matched_entry?: string | null;
  name?: string | null;
  file_path?: string | null;
}

export interface PendingRecord {
  id: string;
  subsystem: string;
  action: string;
  origin: string;
  summary: string;
  created_at: number;
  target?: string;
  ops?: PendingOperation[];
  preview?: string;
}

export type OpStatus = "VALID" | "REDUNDANT_NOOP" | "REBINDABLE" | "CONFLICT";

export interface DiagnosedOperation extends PendingOperation {
  index: number;
  status: OpStatus;
  detail: string;
  rebind_to: string | null;
}

export interface DiagnosisRecord {
  id: string;
  subsystem: string;
  origin: string;
  summary: string;
  created_at: number;
  target: string;
  ops: DiagnosedOperation[];
  note?: string;
}

export interface Diagnosis {
  records: DiagnosisRecord[];
  counts: Record<OpStatus, number>;
  usage: Record<string, { entries: number; char_count: number; char_limit: number }>;
}

export interface SalvageOutcome {
  id: string;
  outcome: "rewritten" | "unchanged" | "auto_pruned_redundant";
  kept: number;
  dropped: number;
  unresolvable_ops: DiagnosedOperation[];
  message: string;
}

export type PendingWritesResult =
  | { action: "list" | "preview"; subsystem: string; count: number; records: PendingRecord[] }
  | ({ action: "diagnose"; subsystem: string } & Diagnosis)
  | { action: "salvage"; id: string; outcomes: SalvageOutcome[] }
  | { action: "approve" | "reject"; output: string; pending_remaining: number };

export const inspectMemory = (): Promise<MemoryInspection> =>
  runBridge<MemoryInspection>({ op: "inspect" }, { timeoutMs: 180_000 });

const listPendingFiles = (subsystem: Subsystem): string[] => {
  try {
    return fs
      .readdirSync(pendingDir(subsystem))
      .filter((file) => file.endsWith(".json"))
      .map((file) => path.join(pendingDir(subsystem), file));
  } catch {
    return [];
  }
};

/** Cheap id set taken before a dispatch, so the run's own staged writes can be isolated. */
export const snapshotPendingIds = (): { memory: Set<string>; skills: Set<string> } => ({
  memory: new Set(listPendingFiles("memory").map((file) => path.basename(file, ".json"))),
  skills: new Set(listPendingFiles("skills").map((file) => path.basename(file, ".json"))),
});

const readRecord = (file: string): PendingRecord | null => {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
    const payload = (raw.payload ?? {}) as Record<string, unknown>;
    const operations = Array.isArray(payload.operations)
      ? (payload.operations as PendingOperation[])
      : [payload as unknown as PendingOperation];
    return {
      id: String(raw.id ?? path.basename(file, ".json")),
      subsystem: String(raw.subsystem ?? path.basename(path.dirname(file))),
      action: String(payload.action ?? raw.action ?? ""),
      origin: String(raw.origin ?? "foreground"),
      summary: String(raw.summary ?? ""),
      created_at: Number(raw.created_at ?? 0),
      target: String(payload.target ?? "memory"),
      ops: operations.map((op) => ({
        action: String(op.action ?? ""),
        old_text: (op.old_text as string | undefined) ?? null,
        content: (op.content as string | undefined) ?? null,
        matched_entry: (op.matched_entry as string | undefined) ?? null,
        name: (op.name as string | undefined) ?? null,
        file_path: (op.file_path as string | undefined) ?? null,
      })),
    };
  } catch {
    return null;
  }
};

const POLL_INTERVAL_MS = 100;
const QUIET_WINDOW_MS = 150;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const newFiles = (subsystem: Subsystem, known: Set<string>, inspected: Set<string>): string[] =>
  listPendingFiles(subsystem).filter((file) => {
    const id = path.basename(file, ".json");
    return !known.has(id) && !inspected.has(id);
  });

/**
 * The background-review fork writes its pending record in a daemon thread that can outlive the
 * CLI process teardown, so an empty read right after exit is not proof there was no write.
 * Polls without blocking the loop, then keeps listening for one quiet window so siblings staged a
 * moment later land in the same collection. A corrupt file is inspected once and never retried.
 */
export const collectNewPendingWrites = async (
  before: { memory: Set<string>; skills: Set<string> },
  deadlineMs = 1500,
): Promise<PendingRecord[]> => {
  const started = Date.now();
  const inspected: Record<Subsystem, Set<string>> = { memory: new Set(), skills: new Set() };
  const found: Record<Subsystem, Map<string, PendingRecord>> = { memory: new Map(), skills: new Map() };
  const elapsed = (): number => Date.now() - started;

  const harvest = (): number => {
    let added = 0;
    for (const subsystem of SUBSYSTEMS) {
      for (const file of newFiles(subsystem, before[subsystem], inspected[subsystem])) {
        const id = path.basename(file, ".json");
        inspected[subsystem].add(id);
        const record = readRecord(file);
        // Unparseable is not activity: it must not extend the wait, and it is not reported.
        if (!record) continue;
        found[subsystem].set(id, record);
        added += 1;
      }
    }
    return added;
  };

  const total = (): number => found.memory.size + found.skills.size;

  harvest();
  while (total() === 0 && elapsed() < deadlineMs) {
    await sleep(POLL_INTERVAL_MS);
    harvest();
  }
  while (total() > 0 && elapsed() < deadlineMs) {
    const seen = total();
    await sleep(QUIET_WINDOW_MS);
    harvest();
    if (total() === seen) break;
  }

  return [...found.memory.values(), ...found.skills.values()];
};

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** A pending id reaches a filename on the Python side: validate before spawning anything. */
const assertPendingId = (id: string, action: string): string => {
  if (id !== "all" && !ID_PATTERN.test(id)) {
    throw new Error(`Invalid pending id '${id}' for ${action} (expected 'all' or [A-Za-z0-9_-]+)`);
  }
  return id;
};

/**
 * One entry point for the canonical write_approval surface: list, preview, diagnose, salvage,
 * approve and reject all go through Hermes' own pending store and MemoryStore.
 */
export const managePendingWrites = async (params: {
  action: "list" | "preview" | "diagnose" | "salvage" | "approve" | "reject";
  subsystem?: Subsystem | "all";
  id?: string;
}): Promise<PendingWritesResult> => {
  const subsystem = params.subsystem ?? "all";

  switch (params.action) {
    case "list":
    case "preview": {
      const request: BridgeRequest = { op: "pending", subsystem };
      if (params.action === "preview" && params.id) request.id = assertPendingId(params.id, "preview");
      const result = await runBridge<{ subsystem: string; count: number; records: PendingRecord[] }>(request);
      return { action: params.action, ...result };
    }
    case "diagnose": {
      if (subsystem === "all") {
        throw new Error("diagnose requires subsystem 'memory' or 'skills'");
      }
      const result = await runBridge<Diagnosis>({
        op: "diagnose",
        subsystem,
        ...(params.id === undefined ? {} : { id: assertPendingId(params.id, "diagnose") }),
      });
      return { action: "diagnose", subsystem, ...result };
    }
    case "salvage": {
      const id = assertPendingId(params.id ?? "all", "salvage");
      if (subsystem === "skills") {
        throw new Error("salvage only rewrites memory batches; use subsystem 'memory'");
      }
      const result = await runBridge<{ id: string; outcomes: SalvageOutcome[] }>({
        op: "salvage",
        subsystem: "memory",
        id,
      });
      return { action: "salvage", id: result.id, outcomes: result.outcomes };
    }
    case "approve":
    case "reject": {
      if (!params.id) throw new Error(`${params.action} requires an id (or 'all')`);
      if (subsystem === "all") throw new Error(`${params.action} requires subsystem 'memory' or 'skills'`);
      const result = await runBridge<{ output: string; pending_remaining: number }>({
        op: params.action,
        subsystem,
        id: assertPendingId(params.id, params.action),
      });
      return { action: params.action, ...result };
    }
    default:
      throw new Error(`unknown pending action '${params.action satisfies never}'`);
  }
};
