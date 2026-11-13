import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isWindows, run } from "./exec.js";
import { hermesHome } from "./hermes-paths.js";
import { isPidAlive } from "./run-registry.js";

export interface ClinePassKey {
  label: string;
  source: string;
  status: string;
  requestCount: number;
  lastStatusAt: string | null;
  lastErrorCode: string | null;
  lastErrorReason: string | null;
  cooldownUntil: string | null;
}

export interface ClinePassPool {
  keys: ClinePassKey[];
  ok: number;
  failing: number;
  requested: number;
}

export interface QuotaBucket {
  bucketId: string;
  group: string;
  window: string;
  remainingFraction: number;
  resetTime: string | null;
}

export interface AntigravityQuota {
  buckets: QuotaBucket[];
  source: "env" | "daemon" | "process";
}

export interface QuotaProbeOptions {
  authPath?: string;
  hubDir?: string;
  endpointUrl?: string;
  csrfToken?: string;
  timeoutMs?: number;
}

/** Middle dot, so every segment is one fixed separator apart regardless of which ones survive. */
const SEPARATOR = " \u00b7 ";

type Json = Record<string, unknown>;

/** JSON.parse returns any; every field below is read defensively because auth.json is edited by hand. */
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asText = (value: unknown, fallback: string): string =>
  typeof value === "string" ? value : fallback;

const asNullableText = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const asNumber = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

interface RankedKey {
  priority: number;
  key: ClinePassKey;
}

/** Only the fields the table renders are copied: `secret_fingerprint` must never reach a caller. */
const readClinePassEntries = (authPath: string): RankedKey[] | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(authPath, "utf8"));
  } catch {
    return null;
  }
  const pool = isRecord(parsed) && isRecord(parsed.credential_pool) ? parsed.credential_pool.clinepass : null;
  if (!Array.isArray(pool)) return null;
  return pool.filter(isRecord).map((record) => ({
    priority: asNumber(record.priority),
    key: {
      label: asText(record.label, ""),
      source: asText(record.source, ""),
      status: asText(record.last_status, ""),
      requestCount: asNumber(record.request_count),
      lastStatusAt: asNullableText(record.last_status_at),
      lastErrorCode: asNullableText(record.last_error_code),
      lastErrorReason: asNullableText(record.last_error_reason),
      cooldownUntil: asNullableText(record.last_error_reset_at),
    },
  }));
};

export const readClinePassPool = (options: QuotaProbeOptions = {}): ClinePassPool | null => {
  const entries = readClinePassEntries(options.authPath ?? path.join(hermesHome(), "auth.json"));
  if (!entries) return null;
  // priority is a sort key only: carrying it into the returned records would outlive the ordering.
  const keys = entries
    .sort((a, b) => a.priority - b.priority || a.key.label.localeCompare(b.key.label))
    .map((entry) => entry.key);
  const ok = keys.filter((key) => key.status === "ok").length;
  return {
    keys,
    ok,
    failing: keys.length - ok,
    requested: keys.reduce((total, key) => total + key.requestCount, 0),
  };
};

const localClock = (timestamp: string): string => {
  const at = new Date(timestamp);
  const hours = String(at.getHours()).padStart(2, "0");
  const minutes = String(at.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
};

/** Newest wins because the segment answers "when did the pool last work", not "when did any key". */
const newestStatus = (keys: ClinePassKey[]): string | null => {
  let newest: { at: number; clock: string } | null = null;
  for (const key of keys) {
    if (!key.lastStatusAt) continue;
    const at = new Date(key.lastStatusAt).getTime();
    if (Number.isNaN(at) || (newest && newest.at >= at)) continue;
    newest = { at, clock: localClock(key.lastStatusAt) };
  }
  return newest?.clock ?? null;
};

export const formatClinePass = (pool: ClinePassPool | null): string | null => {
  if (!pool || pool.keys.length === 0) return null;
  const failing = pool.keys.filter((key) => key.status !== "ok");
  if (failing.length === 0) {
    const segments = ["ok", `${pool.requested} requests`];
    const lastOk = newestStatus(pool.keys);
    if (lastOk) segments.push(`last ok ${lastOk}`);
    return segments.join(SEPARATOR);
  }
  const first = failing[0];
  const segments = [
    `${pool.keys.length} keys`,
    `${failing.length} failing`,
    `${first.label} ${first.lastErrorReason ?? first.lastErrorCode ?? first.status}`,
  ];
  if (first.cooldownUntil) segments.push(`until ${first.cooldownUntil}`);
  return segments.join(SEPARATOR);
};

/** resetTime is echoed verbatim: reformatting it would hide the window the server actually reported. */
const renderBucket = (bucket: QuotaBucket): string => {
  const head = `${bucket.bucketId} ${Math.round(bucket.remainingFraction * 100)}%`;
  return bucket.resetTime ? `${head} @ ${bucket.resetTime}` : head;
};

export const formatQuota = (quota: AntigravityQuota | null): string | null => {
  if (!quota || quota.buckets.length === 0) return null;
  const tightest = [...quota.buckets]
    .sort((a, b) => a.remainingFraction - b.remainingFraction || a.bucketId.localeCompare(b.bucketId))
    .slice(0, 2);
  return tightest.map(renderBucket).join(SEPARATOR);
};

const QUOTA_METHOD = "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary";
const DEFAULT_TIMEOUT_MS = 600;
/** A discovery spawn started with less than this left is killed at the deadline having read nothing. */
const DISCOVERY_MIN_BUDGET_MS = 400;

const parseQuotaBody = (payload: unknown): QuotaBucket[] | null => {
  const groups = isRecord(payload) && isRecord(payload.response) ? payload.response.groups : null;
  if (!Array.isArray(groups)) return null;
  const buckets: QuotaBucket[] = [];
  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group.buckets)) continue;
    const name = asText(group.displayName, "");
    for (const bucket of group.buckets) {
      if (!isRecord(bucket)) continue;
      const bucketId = asText(bucket.bucketId, "");
      if (!bucketId) continue;
      buckets.push({
        bucketId,
        group: name,
        window: asText(bucket.window, ""),
        remainingFraction: asNumber(bucket.remainingFraction),
        resetTime: asNullableText(bucket.resetTime),
      });
    }
  }
  return buckets.length > 0 ? buckets : null;
};

/**
 * The signal is the whole budget, not a per-request cap: three layers that each waited a full
 * timeout would let the telemetry table stall for three times what its caller allowed.
 */
const fetchQuota = async (
  baseUrl: string,
  csrfToken: string,
  budgetMs: number,
): Promise<QuotaBucket[] | null> => {
  if (budgetMs <= 0) return null;
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}${QUOTA_METHOD}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
        "x-codeium-csrf-token": csrfToken,
      },
      body: "{}",
      signal: AbortSignal.timeout(budgetMs),
    });
    if (!response.ok) return null;
    return parseQuotaBody(await response.json());
  } catch {
    return null;
  }
};

interface HubDescriptor {
  pid: number;
  httpPort: number;
  csrfToken: string;
}

const HUB_FILE = /^hub_.*\.json$/;

/** A daemon that crashed leaves its descriptor behind, so the pid is what decides, not the file. */
const readHubDescriptors = (dir: string): HubDescriptor[] => {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((name) => HUB_FILE.test(name));
  } catch {
    return [];
  }
  const live: Array<{ mtimeMs: number; hub: HubDescriptor }> = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const record: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!isRecord(record)) continue;
      const pid = asNumber(record.pid);
      const httpPort = asNumber(record.httpPort);
      const csrfToken = asText(record.csrfToken, "");
      if (!csrfToken || httpPort <= 0 || !isPidAlive(pid)) continue;
      live.push({ mtimeMs: fs.statSync(file).mtimeMs, hub: { pid, httpPort, csrfToken } });
    } catch {
      // A descriptor caught mid-write fails JSON.parse, which is exactly the outcome wanted here.
    }
  }
  return live.sort((a, b) => b.mtimeMs - a.mtimeMs).map((entry) => entry.hub);
};

const hubDirOf = (options: QuotaProbeOptions): string =>
  options.hubDir ?? path.join(os.homedir(), ".gemini", "antigravity", "daemon");

/** One PowerShell spawn: two spawns would cost more than the budget the probe is allowed. */
const POWERSHELL_DISCOVERY = [
  "$p = Get-CimInstance Win32_Process -Filter \"Name = 'language_server.exe'\" | Where-Object { $_.CommandLine -match '--csrf_token' } | Select-Object -First 1",
  "if (-not $p) { exit 0 }",
  "$token = [regex]::Match($p.CommandLine, '--csrf_token[= ]+([^ ]+)').Groups[1].Value",
  "if (-not $token) { exit 0 }",
  "Write-Output ('CSRF=' + $token)",
  "$ports = @()",
  "foreach ($line in (netstat -ano)) {",
  "  if ($line -notmatch '^\\s*TCP\\s+\\S+:(\\d+)\\s') { continue }",
  "  $port = $Matches[1]",
  "  if (($line -split '\\s+') -notcontains ([string]$p.ProcessId)) { continue }",
  "  $ports += $port",
  "}",
  "if ($ports.Count -gt 0) { Write-Output ('PORTS=' + ($ports -join ',')) }",
].join("\n");

interface DiscoveredServer {
  csrfToken: string;
  ports: number[];
}

const parseDiscoveredPorts = (raw: string): number[] =>
  raw
    .split(",")
    .map((port) => Number(port.trim()))
    .filter((port) => Number.isInteger(port) && port > 0 && port < 65_536);

const parseDiscovery = (stdout: string): DiscoveredServer | null => {
  const csrfToken = /^CSRF=(.+)$/m.exec(stdout)?.[1]?.trim() ?? "";
  const ports = parseDiscoveredPorts(/^PORTS=(.+)$/m.exec(stdout)?.[1] ?? "");
  if (!csrfToken || ports.length === 0) return null;
  return { csrfToken, ports: [...new Set(ports)] };
};

const discoverOnWindows = async (budgetMs: number): Promise<DiscoveredServer | null> => {
  const result = await run(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", POWERSHELL_DISCOVERY],
    { timeoutMs: budgetMs },
  );
  if (result.code !== 0) return null;
  return parseDiscovery(result.stdout);
};

const discoverOnPosix = async (budgetMs: number): Promise<DiscoveredServer | null> => {
  const listing = await run("pgrep", ["-af", "language_server"], { timeoutMs: budgetMs });
  const line = listing.stdout.split("\n").find((entry) => entry.includes("--csrf_token")) ?? "";
  const csrfToken = /--csrf_token[= ](\S+)/.exec(line)?.[1] ?? "";
  const pid = Number(/^(\d+)/.exec(line)?.[1] ?? 0);
  if (!csrfToken || pid <= 0) return null;

  const sockets = await run("ss", ["-ltnp"], { timeoutMs: budgetMs });
  const ports = sockets.stdout
    .split("\n")
    .filter((entry) => entry.includes(`pid=${pid}`))
    // Field 3 of an `ss -ltnp` row is the local address, and only it carries the listening port.
    .map((entry) => Number(/:(\d+)$/.exec(entry.trim().split(/\s+/)[3] ?? "")?.[1] ?? 0))
    .filter((port) => Number.isInteger(port) && port > 0 && port < 65_536);
  return ports.length > 0 ? { csrfToken, ports: [...new Set(ports)] } : null;
};

const discoverServer = async (budgetMs: number): Promise<DiscoveredServer | null> =>
  isWindows ? discoverOnWindows(budgetMs) : discoverOnPosix(budgetMs);

const tryPorts = async (
  csrfToken: string,
  ports: number[],
  remaining: () => number,
): Promise<QuotaBucket[] | null> => {
  for (const port of ports) {
    if (remaining() <= 0) return null;
    const buckets = await fetchQuota(`http://127.0.0.1:${port}`, csrfToken, remaining());
    if (buckets) return buckets;
  }
  return null;
};

const probeLayers = async (options: QuotaProbeOptions): Promise<AntigravityQuota | null> => {
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const remaining = (): number => deadline - Date.now();

  const endpointUrl = options.endpointUrl ?? process.env.ANTIGRAVITY_ENDPOINT_URL ?? "";
  if (endpointUrl) {
    const csrfToken = options.csrfToken ?? process.env.ANTIGRAVITY_CSRF_TOKEN ?? "";
    const buckets = await fetchQuota(endpointUrl, csrfToken, remaining());
    if (buckets) return { buckets, source: "env" };
  }

  for (const hub of readHubDescriptors(hubDirOf(options))) {
    if (remaining() <= 0) break;
    const buckets = await fetchQuota(`http://127.0.0.1:${hub.httpPort}`, hub.csrfToken, remaining());
    if (buckets) return { buckets, source: "daemon" };
  }

  if (remaining() < DISCOVERY_MIN_BUDGET_MS) return null;
  const discovered = await discoverServer(remaining());
  if (!discovered) return null;
  const buckets = await tryPorts(discovered.csrfToken, discovered.ports, remaining);
  return buckets ? { buckets, source: "process" } : null;
};

/**
 * Fail-open by contract: the caller renders a telemetry row, so a probe that threw or waited would
 * take the whole table down with it.
 */
export const probeAntigravityQuota = async (
  options: QuotaProbeOptions = {},
): Promise<AntigravityQuota | null> => {
  try {
    return await probeLayers(options);
  } catch {
    return null;
  }
};
