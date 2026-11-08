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

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * The background-review fork writes its pending record in a daemon thread that can outlive the
 * CLI process teardown, so an empty read right after exit is not proof there was no write.
 */
export const collectNewPendingWrites = (
  before: { memory: Set<string>; skills: Set<string> },
  deadlineMs = 1500,
): PendingRecord[] => {
  const started = Date.now();
  const collect = (subsystem: Subsystem, known: Set<string>): PendingRecord[] =>
    listPendingFiles(subsystem)
      .filter((file) => !known.has(path.basename(file, ".json")))
      .map(readRecord)
      .filter((record): record is PendingRecord => record !== null);

  let memory = collect("memory", before.memory);
  let skills = collect("skills", before.skills);
  while (memory.length === 0 && skills.length === 0 && Date.now() - started < deadlineMs) {
    sleepSync(150);
    memory = collect("memory", before.memory);
    skills = collect("skills", before.skills);
  }
  return [...memory, ...skills];
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
      if (params.action === "preview" && params.id) request.id = params.id;
      const result = await runBridge<{ subsystem: string; count: number; records: PendingRecord[] }>(request);
      return { action: params.action, ...result };
    }
    case "diagnose": {
      if (subsystem === "all") {
        throw new Error("diagnose requires subsystem 'memory' or 'skills'");
      }
      const result = await runBridge<Diagnosis>({ op: "diagnose", subsystem, id: params.id });
      return { action: "diagnose", subsystem, ...result };
    }
    case "salvage": {
      const id = params.id ?? "all";
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
        id: params.id,
      });
      return { action: params.action, ...result };
    }
    default:
      throw new Error(`unknown pending action '${params.action satisfies never}'`);
  }
};
