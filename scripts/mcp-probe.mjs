// MCP stdio probe: initialize, list tools, call hermes_inspect_memory, then exit.
import { spawn } from "node:child_process";

const server = spawn(process.execPath, [process.argv[2]], { stdio: ["pipe", "pipe", "pipe"] });

let buffer = "";
const pending = new Map();
const stderr = [];

const send = (payload) => server.stdin.write(`${JSON.stringify(payload)}\n`);

const call = (id, method, params) =>
  new Promise((resolve) => {
    pending.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });

// A stray banner or log line on stdout must not kill the probe mid-handshake.
const parse = (line) => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

server.stdout.setEncoding("utf8");
server.stdout.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = parse(line);
    if (!message) continue;
    const resolve = pending.get(message.id);
    if (resolve) {
      pending.delete(message.id);
      resolve(message);
    }
  }
});
server.stderr.setEncoding("utf8");
server.stderr.on("data", (chunk) => stderr.push(chunk));

const timeout = setTimeout(() => {
  console.log("TIMEOUT", stderr.join(""));
  server.kill();
  process.exit(1);
}, 120_000);

const init = await call(1, "initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "probe", version: "0" },
});
console.log("server:", JSON.stringify(init.result?.serverInfo));
send({ jsonrpc: "2.0", method: "notifications/initialized" });

const tools = await call(2, "tools/list", {});
console.log("tools:", tools.result?.tools.map((t) => t.name).join(", "));

const inspected = await call(3, "tools/call", { name: "hermes_inspect_memory", arguments: {} });
const text = inspected.result?.content?.[0]?.text ?? "";
const parsed = JSON.parse(text);
console.log("inspect:", {
  memory: `${parsed.memory.char_count}/${parsed.memory.char_limit}`,
  user: `${parsed.user.char_count}/${parsed.user.char_limit}`,
  pending: parsed.pending,
  isError: inspected.result?.isError ?? false,
});

const sessions = await call(4, "tools/call", {
  name: "hermes_list_sessions",
  arguments: { cwd: "D:\\Code\\OtterBoops\\hermes-worker", limit: 3 },
});
const sessionPayload = JSON.parse(sessions.result?.content?.[0]?.text ?? "{}");
console.log("sessions:", sessionPayload.sessions?.length, sessionPayload.sessions?.[0]?.title ?? "");

const diagnosed = await call(5, "tools/call", {
  name: "hermes_pending_writes",
  arguments: { action: "diagnose", subsystem: "memory" },
});
const diagnosis = JSON.parse(diagnosed.result?.content?.[0]?.text ?? "{}");
console.log("diagnose:", diagnosis.records?.length ?? 0, "records", diagnosis.counts ?? {});

const rejected = await call(6, "tools/call", {
  name: "hermes_worktree_action",
  arguments: { action: "apply", cwd: process.argv[3], worktreeBranch: "hermes/agy-none" },
});
console.log("worktree guard:", rejected.result?.isError === true, JSON.parse(rejected.result?.content?.[0]?.text ?? "{}").success);

clearTimeout(timeout);
send({ jsonrpc: "2.0", id: 7, method: "shutdown" });
server.stdin.end();
setTimeout(() => {
  server.kill();
  process.exit(0);
}, 500);
