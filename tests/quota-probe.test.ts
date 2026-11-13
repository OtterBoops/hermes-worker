import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import {
  formatOpenCodeQuota,
  formatProviderPool,
  formatQuota,
  probeAntigravityQuota,
  probeOpenCodeQuota,
  readProviderPool,
  type OpenCodeQuota,
  type ProviderPool,
  type QuotaBucket,
} from "../src/quota-probe.js";

const SEPARATOR = " \u00b7 ";
const QUOTA_PATH = "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary";
/** Beyond pid_max on POSIX and absent on Windows: neither platform can hand out a live one. */
const DEAD_PID = 2_147_483_646;
const FINGERPRINT = "sha256:9f2c-do-not-leak";

interface Sandbox {
  dir: string;
  authPath: string;
  hubDir: string;
}

const sandbox = (t: TestContext): Sandbox => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-quota-probe-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hubDir = path.join(dir, "daemon");
  fs.mkdirSync(hubDir, { recursive: true });
  return { dir, authPath: path.join(dir, "auth.json"), hubDir };
};

/** A key record as auth.json stores it: every secret-bearing field is present so leaks are detectable. */
const keyRecord = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  id: "k-1",
  label: "OPENCODE_GO_API_KEY",
  auth_type: "api_key",
  priority: 0,
  source: "env:OPENCODE_GO_API_KEY",
  last_status: "ok",
  last_status_at: null,
  last_error_code: null,
  last_error_reason: null,
  last_error_message: null,
  last_error_reset_at: null,
  base_url: "https://opencode.ai/zen/go/v1",
  request_count: 0,
  secret_fingerprint: FINGERPRINT,
  ...overrides,
});

const writeAuth = (authPath: string, pool: unknown): void => {
  fs.writeFileSync(
    authPath,
    JSON.stringify({
      version: 3,
      providers: { hermes: { api_key_fingerprint: FINGERPRINT } },
      credential_pool: { clinepass: pool },
      updated_at: "2026-11-13T09:00:00Z",
      active_provider: "opencode-go",
    }),
    "utf8",
  );
};

test("readProviderPool folds the pool into counts without leaking the fingerprint", (t) => {
  const { authPath } = sandbox(t);
  writeAuth(authPath, [
    keyRecord({ id: "k-2", label: "OPENCODE_GO_API_KEY_2", priority: 1, last_status_at: "2026-11-13T09:42:00Z", request_count: 5 }),
    keyRecord({
      id: "k-1",
      priority: 0,
      last_status: "error",
      last_error_code: "quota_exhausted",
      last_error_reset_at: "2026-11-13T14:30:00Z",
      request_count: 2,
    }),
  ]);

  const pool = readProviderPool("clinepass", { authPath });
  assert.ok(pool);
  assert.equal(pool.keys.length, 2);
  assert.equal(pool.ok, 1);
  assert.equal(pool.failing, 1);
  assert.equal(pool.requested, 7);
  // Priority ascending, not the file order: the failing key was written second but outranks the first.
  assert.deepEqual(
    pool.keys.map((key) => key.label),
    ["OPENCODE_GO_API_KEY", "OPENCODE_GO_API_KEY_2"],
  );
  assert.deepEqual(pool.keys[0], {
    label: "OPENCODE_GO_API_KEY",
    source: "env:OPENCODE_GO_API_KEY",
    status: "error",
    requestCount: 2,
    lastStatusAt: null,
    lastErrorCode: "quota_exhausted",
    lastErrorReason: null,
    cooldownUntil: "2026-11-13T14:30:00Z",
  });
  assert.equal(JSON.stringify(pool).includes(FINGERPRINT), false, "a fingerprint must never reach a caller");
});

test("readProviderPool returns null for a missing or malformed auth.json", (t) => {
  const { dir, authPath } = sandbox(t);
  assert.equal(readProviderPool("clinepass", { authPath }), null);

  fs.writeFileSync(authPath, "{ not json", "utf8");
  assert.equal(readProviderPool("clinepass", { authPath }), null);

  fs.writeFileSync(authPath, JSON.stringify({ credential_pool: { clinepass: "nope" } }), "utf8");
  assert.equal(readProviderPool("clinepass", { authPath }), null);

  fs.writeFileSync(authPath, JSON.stringify({ credential_pool: { openrouter: [] } }), "utf8");
  assert.equal(readProviderPool("clinepass", { authPath }), null);

  assert.equal(readProviderPool("clinepass", { authPath: path.join(dir, "absent", "auth.json") }), null);
});

const poolOf = (keys: ProviderPool["keys"], requested: number): ProviderPool => ({
  keys,
  ok: keys.filter((key) => key.status === "ok").length,
  failing: keys.filter((key) => key.status !== "ok").length,
  requested,
});

const healthyKey = (label: string, requestCount: number, lastStatusAt: string | null): ProviderPool["keys"][number] => ({
  label,
  source: "env:OPENCODE_GO_API_KEY",
  status: "ok",
  requestCount,
  lastStatusAt,
  lastErrorCode: null,
  lastErrorReason: null,
  cooldownUntil: null,
});

test("formatProviderPool renders the healthy pool and drops the last-ok segment when no key has a timestamp", () => {
  // Local-clock timestamps, so the expected HH:MM holds in whatever zone the runner sits in.
  const stamped = poolOf(
    [healthyKey("OPENCODE_GO_API_KEY", 4, "2026-11-13T08:05:00"), healthyKey("OPENCODE_GO_API_KEY_2", 3, "2026-11-13T09:42:00")],
    7,
  );
  assert.equal(formatProviderPool(stamped), `ok${SEPARATOR}7 requests${SEPARATOR}last ok 09:42`);

  const unstamped = poolOf([healthyKey("OPENCODE_GO_API_KEY", 7, null)], 7);
  assert.equal(formatProviderPool(unstamped), `ok${SEPARATOR}7 requests`);

  assert.equal(formatProviderPool(null), null);
  assert.equal(formatProviderPool(poolOf([], 0)), null);
});

test("formatProviderPool renders the failing key with its code and cooldown", (t) => {
  const { authPath } = sandbox(t);
  writeAuth(authPath, [
    keyRecord({ id: "k-2", label: "OPENCODE_GO_API_KEY_2", priority: 1, last_status_at: "2026-11-13T09:42:00Z", request_count: 5 }),
    keyRecord({
      id: "k-1",
      priority: 0,
      last_status: "error",
      last_error_code: "quota_exhausted",
      last_error_reset_at: "2026-11-13T14:30:00Z",
      request_count: 2,
    }),
  ]);

  const pool = readProviderPool("clinepass", { authPath });
  assert.ok(pool);
  assert.equal(
    formatProviderPool(pool),
    `2 keys${SEPARATOR}1 failing${SEPARATOR}OPENCODE_GO_API_KEY quota_exhausted${SEPARATOR}until 2026-11-13T14:30:00Z`,
  );

  // No cooldown means the reason segment is the last one: a dangling separator would read as a bug.
  const cooling = { ...pool.keys[0], cooldownUntil: null };
  assert.equal(
    formatProviderPool(poolOf([cooling], 2)),
    `1 keys${SEPARATOR}1 failing${SEPARATOR}OPENCODE_GO_API_KEY quota_exhausted`,
  );
  // status is the final fallback when the key carries neither a reason nor a code.
  assert.equal(
    formatProviderPool(poolOf([{ ...cooling, lastErrorCode: null }], 2)),
    `1 keys${SEPARATOR}1 failing${SEPARATOR}OPENCODE_GO_API_KEY error`,
  );
  assert.equal(
    formatProviderPool(poolOf([{ ...cooling, lastErrorReason: "workspace over budget" }], 2)),
    `1 keys${SEPARATOR}1 failing${SEPARATOR}OPENCODE_GO_API_KEY workspace over budget`,
  );
  assert.equal(
    formatProviderPool(poolOf([{ ...cooling, lastErrorReason: "workspace over budget", cooldownUntil: "2026-11-13T14:30:00Z" }], 2)),
    `1 keys${SEPARATOR}1 failing${SEPARATOR}OPENCODE_GO_API_KEY workspace over budget${SEPARATOR}until 2026-11-13T14:30:00Z`,
  );
});

const bucket = (
  bucketId: string,
  remainingFraction: number,
  resetTime: string | null,
  window = "weekly",
  group = "Gemini Models",
): QuotaBucket => ({ bucketId, group, window, remainingFraction, resetTime });

test("formatQuota renders the two tightest buckets and omits an absent reset time", () => {
  const quota = {
    source: "daemon" as const,
    buckets: [
      bucket("gemini-weekly", 0.15905188, "2026-11-14T10:12:32Z"),
      bucket("3p-weekly", 0.82, "2026-11-14T11:00:00Z"),
      bucket("gemini-argon-wtu-weekly", 0.03, "2026-11-14T10:09:42Z"),
      bucket("gemini-5h", 0.44, null, "5h"),
      bucket("3p-5h", 0.91, null, "5h"),
    ],
  };
  assert.equal(
    formatQuota(quota),
    `gemini-argon-wtu-weekly 3% @ 2026-11-14T10:09:42Z${SEPARATOR}gemini-weekly 16% @ 2026-11-14T10:12:32Z`,
  );

  assert.equal(formatQuota({ source: "env", buckets: [bucket("gemini-5h", 0.335, null, "5h")] }), "gemini-5h 34%");

  // An exact tie is broken by bucket id, never by the order the RPC happened to list them in.
  const tied = {
    source: "env" as const,
    buckets: [bucket("zz-weekly", 0.5, null), bucket("aa-weekly", 0.5, null)],
  };
  assert.equal(formatQuota(tied), `aa-weekly 50%${SEPARATOR}zz-weekly 50%`);

  assert.equal(formatQuota(null), null);
  assert.equal(formatQuota({ source: "daemon", buckets: [] }), null);
});

const QUOTA_BODY = {
  response: {
    description: "Quota summary",
    groups: [
      {
        displayName: "Gemini Models",
        description: "Google models",
        buckets: [
          {
            bucketId: "gemini-weekly",
            displayName: "Weekly Limit Remaining",
            description: "Resets weekly",
            window: "weekly",
            remainingFraction: 0.15905188,
            resetTime: "2026-11-14T10:12:32Z",
          },
        ],
      },
      {
        displayName: "Third Party Models",
        description: "Partner models",
        buckets: [
          {
            bucketId: "3p-weekly",
            displayName: "Weekly Limit Remaining",
            description: "Resets weekly",
            window: "weekly",
            remainingFraction: 0.82,
            resetTime: "2026-11-14T11:00:00Z",
          },
        ],
      },
    ],
  },
};

interface Fixture {
  port: number;
  hits: () => number;
}

/**
 * A real loopback server, because the probe's budget behaviour lives in fetch and an in-process
 * stub would never exercise the abort path.
 */
const startServer = async (
  t: TestContext,
  handler: (request: http.IncomingMessage, response: http.ServerResponse) => void,
): Promise<Fixture> => {
  let hits = 0;
  const server = http.createServer((request, response) => {
    hits += 1;
    handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const close = async (): Promise<void> => {
    // An aborted request can leave a half-open socket that `close` alone would wait on forever.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  t.after(close);
  return { port, hits: () => hits };
};

const writeHub = (hubDir: string, port: number, csrfToken: string, pid: number): void => {
  fs.writeFileSync(
    path.join(hubDir, `hub_${port}.json`),
    JSON.stringify({ pid, httpsPort: port + 1, httpPort: port, lsVersion: "2.31.2", csrfToken }),
    "utf8",
  );
};

/** The env layer wins over everything else, so a stray key on the host would mask the daemon path. */
const withoutEndpointEnv = async <T>(action: () => Promise<T>): Promise<T> => {
  const saved = process.env.ANTIGRAVITY_ENDPOINT_URL;
  delete process.env.ANTIGRAVITY_ENDPOINT_URL;
  try {
    return await action();
  } finally {
    if (saved !== undefined) process.env.ANTIGRAVITY_ENDPOINT_URL = saved;
  }
};

test("probeAntigravityQuota reads the live daemon descriptor and parses its buckets", async (t) => {
  const { hubDir } = sandbox(t);
  const csrfToken = "50db1f6b-quota-probe-fixture";
  const server = await startServer(t, (request, response) => {
    if (request.method !== "POST" || request.url !== QUOTA_PATH || request.headers["x-codeium-csrf-token"] !== csrfToken) {
      response.writeHead(403).end();
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(QUOTA_BODY));
  });
  writeHub(hubDir, server.port, csrfToken, process.pid);

  const quota = await withoutEndpointEnv(() => probeAntigravityQuota({ hubDir, timeoutMs: 2_000 }));

  assert.ok(quota);
  assert.equal(quota.source, "daemon");
  assert.deepEqual(quota.buckets, [
    {
      bucketId: "gemini-weekly",
      group: "Gemini Models",
      window: "weekly",
      remainingFraction: 0.15905188,
      resetTime: "2026-11-14T10:12:32Z",
    },
    {
      bucketId: "3p-weekly",
      group: "Third Party Models",
      window: "weekly",
      remainingFraction: 0.82,
      resetTime: "2026-11-14T11:00:00Z",
    },
  ]);
  assert.equal(formatQuota(quota), `gemini-weekly 16% @ 2026-11-14T10:12:32Z${SEPARATOR}3p-weekly 82% @ 2026-11-14T11:00:00Z`);
  assert.ok(server.hits() > 0, "the daemon layer must reach the server, not short-circuit");
});

test("probeAntigravityQuota reports the env source for an explicit endpoint", async (t) => {
  const { hubDir } = sandbox(t);
  const csrfToken = "explicit-endpoint-fixture";
  const server = await startServer(t, (request, response) => {
    if (request.headers["x-codeium-csrf-token"] !== csrfToken) {
      response.writeHead(403).end();
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(QUOTA_BODY));
  });

  const quota = await probeAntigravityQuota({
    hubDir,
    endpointUrl: `http://127.0.0.1:${server.port}`,
    csrfToken,
    timeoutMs: 2_000,
  });

  assert.equal(quota?.source, "env");
  assert.equal(quota?.buckets.length, 2);
});

test("probeAntigravityQuota resolves null against a refusing daemon and a dead pid", async (t) => {
  const { hubDir } = sandbox(t);
  const server = await startServer(t, (_request, response) => {
    response.writeHead(403).end();
  });
  writeHub(hubDir, server.port, "rejected-token", process.pid);
  // A crashed daemon's descriptor outlives it: its dead pid must stop the probe before the fetch.
  writeHub(hubDir, server.port + 1, "rejected-token", DEAD_PID);

  // Kept under the discovery floor so the host's real language server cannot answer for the fixture.
  const quota = await withoutEndpointEnv(() => probeAntigravityQuota({ hubDir, timeoutMs: 300 }));
  assert.equal(quota, null);
});

test("probeAntigravityQuota honours its budget when the server never answers", async (t) => {
  const { hubDir } = sandbox(t);
  const server = await startServer(t, () => {
    // A request nobody ever answers: only the abort can end this probe.
  });
  writeHub(hubDir, server.port, "stalled-token", process.pid);

  const startedAt = Date.now();
  const quota = await withoutEndpointEnv(() => probeAntigravityQuota({ hubDir, timeoutMs: 300 }));
  const elapsed = Date.now() - startedAt;

  assert.equal(quota, null);
  assert.ok(elapsed < 2_000, `probe should give up near its budget, took ${elapsed}ms`);
});


const OPENCODE_USAGE = {
  usage: {
    rolling: { status: "ok", percent: 0, resetsAt: "2026-11-14T01:34:49.530Z" },
    weekly: { status: "ok", percent: 12, resetsAt: "2026-11-16T00:00:00.000Z" },
    monthly: { status: "ok", percent: 47.5, resetsAt: "2026-12-13T20:26:23.000Z" },
  },
};

/** One shot then close: a lingering listener would keep the test runner's event loop alive. */
const serveOnce = async (
  t: TestContext,
  body: unknown,
  status = 200,
): Promise<string> => {
  const server = http.createServer((_req, res) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

test("probeOpenCodeQuota parses the three windows and keeps their percentages verbatim", async (t) => {
  const url = await serveOnce(t, OPENCODE_USAGE);
  const quota = await probeOpenCodeQuota({ openCodeUrl: url, openCodeKey: "oc_sk_test", timeoutMs: 2000 });
  assert.deepEqual(quota, {
    windows: [
      { window: "rolling", usedPercent: 0, resetsAt: "2026-11-14T01:34:49.530Z" },
      { window: "weekly", usedPercent: 12, resetsAt: "2026-11-16T00:00:00.000Z" },
      { window: "monthly", usedPercent: 47.5, resetsAt: "2026-12-13T20:26:23.000Z" },
    ],
  });
});

test("probeOpenCodeQuota reports no data rather than zeroes for a bad key or an unknown shape", async (t) => {
  const unauthorised = await serveOnce(t, { error: "Unauthorized" }, 401);
  assert.equal(
    await probeOpenCodeQuota({ openCodeUrl: unauthorised, openCodeKey: "oc_sk_bad" }),
    null,
  );

  const unknown = await serveOnce(t, { something: "else" });
  assert.equal(await probeOpenCodeQuota({ openCodeUrl: unknown, openCodeKey: "oc_sk_test" }), null);

  // No key at all must not reach the network.
  assert.equal(await probeOpenCodeQuota({ openCodeUrl: unauthorised, openCodeKey: "" }), null);
});

test("formatOpenCodeQuota leads with the tightest window and caps at two segments", () => {
  const quota: OpenCodeQuota = {
    windows: [
      { window: "rolling", usedPercent: 0, resetsAt: null },
      { window: "weekly", usedPercent: 12, resetsAt: null },
      { window: "monthly", usedPercent: 47.5, resetsAt: null },
    ],
  };
  // Rounded, tightest first: the window about to bite is what a dispatch reads.
  assert.equal(formatOpenCodeQuota(quota), `monthly 48%${SEPARATOR}weekly 12%`);
  assert.equal(formatOpenCodeQuota(null), null);
  assert.equal(formatOpenCodeQuota({ windows: [] }), null);
});

test("readProviderPool reads opencode-go entries by provider name", (t) => {
  const { authPath } = sandbox(t);
  fs.writeFileSync(
    authPath,
    JSON.stringify({
      version: 3,
      credential_pool: {
        "opencode-go": [keyRecord({ label: "OPENCODE_GO_API_KEY", source: "env:OPENCODE_GO_API_KEY", request_count: 4 })],
      },
    }),
    "utf8",
  );
  const pool = readProviderPool("opencode-go", { authPath });
  assert.ok(pool);
  assert.equal(pool.keys.length, 1);
  assert.equal(pool.requested, 4);
  assert.equal(JSON.stringify(pool).includes(FINGERPRINT), false);
  // The provider name is the lookup key, so a pool that only holds another provider reads as absent.
  assert.equal(readProviderPool("clinepass", { authPath }), null);
});


test("probeOpenCodeQuota falls back to Hermes' own .env when the process env is empty", async (t) => {
  // Node never loads .env: a probe that only read process.env reported null against the live
  // service even though `hermes auth` had written a working key.
  const previousHome = process.env.HERMES_HOME;
  const previousKey = process.env.OPENCODE_GO_API_KEY;
  const { dir } = sandbox(t);
  fs.writeFileSync(path.join(dir, ".env"), '# comment\nOTHER=1\nOPENCODE_GO_API_KEY=oc_sk_from_file\n', "utf8");
  process.env.HERMES_HOME = dir;
  delete process.env.OPENCODE_GO_API_KEY;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = previousHome;
    if (previousKey !== undefined) process.env.OPENCODE_GO_API_KEY = previousKey;
  });

  const seen: Array<string | undefined> = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers.authorization);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(OPENCODE_USAGE));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const quota = await probeOpenCodeQuota({ openCodeUrl: url, timeoutMs: 2000 });
  assert.ok(quota, "the .env key must be picked up");
  assert.deepEqual(seen, ["Bearer oc_sk_from_file"]);
});
