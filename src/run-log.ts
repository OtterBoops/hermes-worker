import fs from "node:fs";
import path from "node:path";

/**
 * Turns the stream-json event tree into the human-readable lines that `<runId>.log` carries.
 * The events are nested (an `assistant` message wraps its `tool_use` blocks), so every rule here
 * is reached through a depth-limited walk rather than assumed to sit at the top level.
 */
const TEXT_LIMIT = 120;
const INPUT_LIMIT = 160;
const STEP_LIMIT = 200;
const WALK_DEPTH = 6;

/** Tools whose input carries a shell command, so the command is worth its own line. */
const EXEC_TOOLS = new Set(["terminal", "exec", "bash", "shell", "run_command", "run_shell"]);

/**
 * Read-only exploration whose payload its own [Hermes:Tool] line already names: repeating it costs a
 * caller input tokens and tells it nothing. Anything whose output is worth reading stays out.
 */
export const NOISY_RESULT_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "search_files",
  "grep",
  "glob",
  "list_dir",
  "ls",
  "web_search",
  "web_extract",
  "skill_view",
  "skills_list",
  "skills_search",
  "todo_list",
  "hermes_list_sessions",
  "hermes_inspect_memory",
]);

/** The correlation map is a cache, not a transcript: unbounded it would hold a whole run's tool ids. */
const MAX_TRACKED_TOOLS = 256;

const TOOL_PREFIX = "[Hermes:Tool] ";

export const flatten = (value: string): string => value.replace(/\s+/g, " ").trim();

const clip = (value: string, limit: number): string => {
  const flat = flatten(value);
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
};

/**
 * Text of a tool_result payload: a bare string, a block array, or an object carrying a known text
 * field. Recursion keeps the block-array shape working for whatever `??` fallback was picked.
 */
const textOfContent = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => textOfContent(part))
      .filter(Boolean)
      .join(" ");
  }
  if (!content || typeof content !== "object") return "";
  const record = content as Record<string, unknown>;
  for (const key of ["text", "output", "result", "stdout", "stderr"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
};

/** The most task-relevant scalar in a tool input, never the whole JSON blob. */
const summariseInput = (input: unknown): string => {
  if (typeof input === "string") return clip(input, INPUT_LIMIT);
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  const record = input as Record<string, unknown>;
  for (const key of ["command", "file_path", "path", "pattern", "prompt", "query", "url", "skill"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return clip(value, INPUT_LIMIT);
  }
  const entries = Object.entries(record)
    .filter(([, value]) => typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    .slice(0, 3)
    .map(([key, value]) => `${key}=${String(value)}`);
  return clip(entries.join(" "), INPUT_LIMIT);
};

const commandOfInput = (input: unknown): string | null => {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const command = (input as Record<string, unknown>).command;
  return typeof command === "string" && command.trim() ? clip(command, INPUT_LIMIT) : null;
};

/** The first payload that actually carries something: `content: []` must not shadow `output`. */
const firstPresent = (record: Record<string, unknown>, keys: string[]): unknown => {
  for (const key of keys) {
    const value = record[key];
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && !value.trim()) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    return value;
  }
  return undefined;
};

/** What the walk saw besides its lines, so a caller can correlate a result back to its tool. */
interface Trace {
  uses: { id: string; name: string }[];
  results: { id: string; line: number }[];
}

const newTrace = (): Trace => ({ uses: [], results: [] });

const walk = (node: unknown, lines: string[], depth = 0, trace?: Trace): void => {
  if (!node || typeof node !== "object" || depth > WALK_DEPTH) return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, lines, depth + 1, trace);
    return;
  }
  const record = node as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";

  if (type === "tool_use") {
    const name = String(record.name ?? "tool");
    const summary = summariseInput(record.input);
    lines.push(`[Hermes:Tool] ${name}${summary ? ` (${summary})` : ""}`);
    if (trace && record.id !== undefined && record.id !== null) {
      trace.uses.push({ id: String(record.id), name });
    }
    if (EXEC_TOOLS.has(name)) {
      const command = commandOfInput(record.input);
      if (command) lines.push(`[Hermes:Exec] ${command}`);
    }
  } else if (type === "tool_result") {
    const id = String(record.tool_use_id ?? record.name ?? "result");
    // A tool_result carries its payload under any of these depending on the tool's transport.
    const raw = firstPresent(record, ["content", "output", "result", "text"]);
    const output = clip(textOfContent(raw), TEXT_LIMIT);
    if (trace && record.tool_use_id !== undefined && record.tool_use_id !== null) {
      trace.results.push({ id, line: lines.length });
    }
    lines.push(`[Hermes:Result] ${id}${output ? ` -> ${output}` : ""}`);
  } else if (type === "text" && typeof record.text === "string" && record.text.trim()) {
    lines.push(`[Hermes:Step] ${clip(record.text, STEP_LIMIT)}`);
  }

  // A leaf the rule above already rendered must not be descended into: a tool_result's content is
  // a `text` block that would otherwise be reported a second time as a step.
  if (type === "tool_use" || type === "tool_result" || type === "text") return;

  for (const [key, value] of Object.entries(record)) {
    if (key === "text") continue;
    if (value && typeof value === "object") walk(value, lines, depth + 1, trace);
  }
};

/** Zero or more log lines for one NDJSON event; an unrecognised event is silently skipped. */
export const formatStreamEvent = (event: unknown): string[] => {
  if (!event || typeof event !== "object") return [];
  const lines: string[] = [];
  walk(event, lines);
  return lines;
};

/** A non-JSON line on the stream is the child's own noise, kept so the tail stays faithful. */
export const formatStreamLine = (line: string): string[] => {
  const trimmed = line.trim();
  if (!trimmed) return [];
  if (!trimmed.startsWith("{")) return [`[Hermes:Output] ${clip(trimmed, STEP_LIMIT)}`];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [`[Hermes:Output] ${clip(trimmed, STEP_LIMIT)}`];
  }
  return formatStreamEvent(parsed);
};

/**
 * Only a stateful formatter can classify a result, because a tool_result event carries the
 * tool_use_id alone; an id it never saw must render as-is rather than be guessed at and dropped.
 */
export const createStreamFormatter = (): ((line: string) => string[]) => {
  const names = new Map<string, string>();
  let previousLine: string | null = null;

  /** Re-inserting on every hit makes insertion order the recency order, so the first key is stalest. */
  const remember = (id: string, name: string): void => {
    names.delete(id);
    names.set(id, name);
    while (names.size > MAX_TRACKED_TOOLS) {
      const oldest = names.keys().next();
      if (oldest.done) break;
      names.delete(oldest.value);
    }
  };

  return (line: string): string[] => {
    let body: string[];
    try {
      const trimmed = line.trim();
      if (!trimmed) return [];
      let event: unknown = null;
      if (trimmed.startsWith("{")) {
        try {
          event = JSON.parse(trimmed);
        } catch {
          event = null;
        }
      }
      if (!event || typeof event !== "object") {
        previousLine = `[Hermes:Output] ${clip(trimmed, STEP_LIMIT)}`;
        return [previousLine];
      }
      const trace = newTrace();
      body = [];
      walk(event, body, 0, trace);
      for (const use of trace.uses) remember(use.id, use.name);
      for (const result of trace.results) {
        const name = names.get(result.id);
        if (name !== undefined && NOISY_RESULT_TOOLS.has(name)) body[result.line] = "";
      }
    } catch {
      // An event this formatter cannot read still renders exactly as the legacy path would.
      return formatStreamLine(line);
    }

    const emitted: string[] = [];
    for (const entry of body) {
      // Adjacency is the whole signal: the same read twice in a row says nothing the first did not.
      if (entry === "") {
        // A suppressed line still separates the lines around it, so it ends a duplicate run.
        previousLine = null;
        continue;
      }
      if (entry === previousLine && entry.startsWith(TOOL_PREFIX)) continue;
      emitted.push(entry);
      previousLine = entry;
    }
    return emitted;
  };
};

export interface RunLog {
  write: (lines: string[]) => void;
  close: () => Promise<void>;
}

/**
 * Append-only sink for the live tail. Writes are buffered by the stream and awaited on close, so
 * a tail reader never sees a torn line and the child's exit cannot leave data unflushed.
 */
export const openRunLog = (logPath: string): RunLog => {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const stream = fs.createWriteStream(logPath, { flags: "w", encoding: "utf8" });
  // A failed log write must never take the dispatch down with it: the run's own state is the
  // source of truth and the tail is a convenience.
  stream.on("error", () => undefined);
  let closed = false;

  return {
    write: (lines: string[]): void => {
      if (closed || lines.length === 0) return;
      stream.write(`${lines.join("\n")}\n`);
    },
    close: async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve) => {
        stream.end(() => resolve());
      });
    },
  };
};
