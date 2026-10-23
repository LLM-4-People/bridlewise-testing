// @vitest-environment node
/**
 * Mechanical enforcement: the SSE CONNECTION LIMIT (
 * -B8 / -F7 resource-exhaustion fix) + cross-cutting fixes
 * (-F9 subprocess env hygiene — subprocessEnv secret leak; -F8 normalizeIp
 * dual-stack unification).
 *
 * SSE (EventSource) connections are GETs → exempt from the request rate
 * limiter (which only applies to mutating routes). Without a separate
 * connection cap, an attacker could open unlimited long-lived SSE
 * connections → file-descriptor + memory exhaustion. enforces a
 * per-identity max-connections limit in the SSE stream owner
 * (`server/sse.ts`) at the LOWEST level — the choke point every stream
 * passes through — so no route can bypass it.
 *
 * This test pins the required invariants (dynamic discovery — * no hardcoded file lists; the server tree is walked):
 * (A) Source-level: `openSseStream` is the single owner; every
 * `server/` caller passes `{ req, db }` (no route bypasses the
 * limit by omitting the identity).
 * (B) Config: `sseMaxConnectionsPerUser` + `sseConnectionRetryAfterSeconds`
 * are configurable with sensible defaults + validation.
 * (C) Behavioral: `acquireSseConnection` rejects over the limit with a
 * typed `RateLimitError` (429 + correct `retryAfterSeconds` + code);
 * per-identity isolation (user A's connections don't count against
 * user B); the count tracks live connections.
 * (D) Cleanup: closing a stream releases the slot; a new connection
 * succeeds after a close; the slot is released on disconnect/error.
 * (E) Lowest-level: `await openSseStream(res, { req, db: adb })` throws BEFORE
 * writeHead when over the limit (the rejection never sends the SSE
 * 200 headers — the router maps the 429 instead).
 * (F) -F9: the subprocess env (subprocessEnv) is built from an allowlist —
 * secrets are dropped; allowlisted vars pass; GIT_OPTIONAL_LOCKS=0
 * always added; configurable.
 * (G) -F8: normalizeIp unifies `::1` (IPv6 loopback) with
 * `127.0.0.1` (IPv4 loopback) + strips the `::ffff:` prefix.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { join, sep } from "node:path";
import { readFileSync } from "node:fs";

import {
  openSseStream,
  acquireSseConnection,
  sseConnectionCount,
  sseConnectionIdentities,
  resetSseConnectionTracker,
  closeAllSseStreams,
  SSE_CONNECTION_CLASSES,
} from "../../server/router/sse.ts";
import { RateLimitError, ConfigError } from "../../server/kernel/errors.ts";
import { normalizeIp } from "../../server/router/rate-limiter.ts";
import { resolveServerConfig, serverConfig } from "../../server/kernel/config.ts";
import { COMMAND_ENVIRONMENT } from "../../engine/src/process/environment-projection.ts";
import { DbClient } from "../../server/db/client.ts";
import { AsyncDbClient } from "../../server/db/async-client.ts";
import { createTestUser } from "../helpers/multi-user.ts";
import { walkTs } from "../helpers/source-scan.ts";
import { callArgumentsOf } from "../helpers/function-scope.ts";
import { mockReq, createMockRes } from "../helpers/mock-http.ts";
import { createTempDir } from "../helpers/temp-dir.ts";

const SSE_PATH = join(process.cwd(), "server", "router", "sse.ts");
// THE CANONICAL SSE ROUTE IS THE SUBSCRIBER, NOT THE CONTROL ROUTE. When the
// executor was split out of the GET handler, `routes/run.ts` kept the POSTs
// and stopped opening a stream at all; `routes/run-stream.ts` is now the only
// module that calls `openSseStream` for a run, so it is what "the run route
// passes { req, db }" is a claim about.
const RUN_ROUTE_PATH = join(process.cwd(), "server", "routes", "run-stream.ts");
const CONFIG_PATH = join(process.cwd(), "server", "kernel", "config.ts");
const SERVER_DIR = join(process.cwd(), "server");

// ── (A) Source-level: openSseStream is the single owner; routes pass { req, db } ─

describe("SSE connection limit — source-level: openSseStream owns the limit", () => {
  const serverFiles = walkTs(SERVER_DIR);

  test("openSseStream + acquireSseConnection are defined ONLY in server/sse.ts (single owner — dynamic discovery, )", async () => {
    for (const f of serverFiles) {
      const src = readFileSync(f, "utf8");
      if (/export\s+async\s+function\s+openSseStream\s*\(/.test(src) && !f.endsWith("sse.ts")) {
        throw new Error(`${f} redefines openSseStream — the SSE stream owner must live ONLY in server/sse.ts (Single-Party-Owner).`);
      }
      if (/export\s+async\s+function\s+acquireSseConnection\s*\(/.test(src) && !f.endsWith("sse.ts")) {
        throw new Error(`${f} redefines acquireSseConnection — the SSE connection-limit owner must live ONLY in server/sse.ts (Single-Party-Owner).`);
      }
    }
    const sseSrc = readFileSync(SSE_PATH, "utf8");
    expect(sseSrc).toMatch(/export\s+async\s+function\s+openSseStream\s*\(/);
    expect(sseSrc).toMatch(/export\s+async\s+function\s+acquireSseConnection\s*\(/);
  });

  test("EVERY openSseStream call in server/ passes { req, db } (no route bypasses the limit — dynamic discovery, )", async () => {
    // A route that calls openSseStream WITHOUT { req, db } bypasses the
    // per-identity connection limit (the limit is enforced inside
    // openSseStream only when req+db are provided). Every production SSE
    // route MUST pass both. Dynamic discovery: walk every server.ts file
    // and inspect every openSseStream call site. The argument list comes
    // from the parser, call by call — the two-hundred-byte window this
    // replaces dropped a long options object OUT of the population and
    // pulled whatever followed the call IN.
    let callSites = 0;
    for (const f of serverFiles) {
      if (f.endsWith("sse.ts")) continue; // the definition itself
      const src = readFileSync(f, "utf8");
      for (const args of callArgumentsOf(src, "openSseStream", `openSseStream calls in ${f}`)) {
        callSites++;
        // The call must reference `req` AND `db` in its arguments (`req:` /
        // `db:` properties or shorthand at the end of the options object).
        if (!/\breq[:\s,}]/.test(args) || !/\bdb[:\s,}]/.test(args)) {
          throw new Error(
            `${f}: openSseStream call \`${args.slice(0, 80)}…\` does not pass { req, db } — every production SSE route MUST pass both so the per-identity connection limit is enforced (SPO).`,
          );
        }
      }
    }
    // There MUST be at least one call site (the run stream route) — guards
    // against the call being accidentally deleted (a silent no-op limit).
    expect(callSites, "openSseStream must have at least one production call site in server/ (the run stream route)").toBeGreaterThan(0);
  });

  test("the run route passes { req, db } to openSseStream (the canonical SSE route)", async () => {
    const src = readFileSync(RUN_ROUTE_PATH, "utf8");
    // THE CLAIM IS `req` AND `db`, NOT "and nothing else", and not "in this
    // order with nothing between them". The first pattern required `db` to be
    // the LAST property — it ended at `db\s*}` — so adding a third option
    // failed a guard about the connection limit, which that option has
    // nothing to do with; the second required `db` ADJACENT to `req`, so a
    // comment between the two properties red it the same way. A pattern that
    // pins an option set it does not care about reds on unrelated correct
    // changes, and a guard that reds for the wrong reason teaches people to
    // widen it without reading it. The claim is asked of the call's argument
    // list instead: the route must hand over the request context's `req`,
    // and the `db` handle, however the object is laid out.
    const calls = callArgumentsOf(src, "openSseStream", "the run route's openSseStream call");
    expect(
      calls.length,
      "the run stream route must call openSseStream — the canonical SSE route went silent",
    ).toBeGreaterThan(0);
    expect(
      calls.some((args) => /\breq\s*:\s*ctx\.req\b/.test(args) && /\bdb\s*[,}]/.test(args)),
      "the run route must pass { req: ctx.req, db } to openSseStream — the per-identity connection limit needs both",
    ).toBe(true);
  });

  test("sse.ts derives the identity via the shared rateLimitKey", async () => {
    const sseSrc = readFileSync(SSE_PATH, "utf8");
    // The connection-limit key is derived by reusing the rate-limiter's
    // rateLimitKey. A reimplementation
    // would be a scattered duplicate (No Scattered Helpers).
    expect(sseSrc).toMatch(/from\s+["']\.\/rate-limiter\.ts["']/);
    expect(sseSrc).toMatch(/\brateLimitKey\b/);
  });

  test("sse.ts reuses RateLimitError (the router maps it to 429 + Retry-After) — not a new error type", async () => {
    const sseSrc = readFileSync(SSE_PATH, "utf8");
    expect(sseSrc).toMatch(/RateLimitError/);
    expect(sseSrc).toMatch(/sse_connection_limit/);
  });
});

// ── (B) Config: sseMaxConnectionsPerUser + sseConnectionRetryAfterSeconds ─────

describe("SSE connection limit — config (single owner in server/config.ts)", () => {
  test("sseMaxConnectionsPerUser defaults to 8 (generous for multi-tab dev, caps exhaustion)", async () => {
    const cfg = resolveServerConfig({});
    expect(cfg.sseMaxConnectionsPerUser).toBe(8);
  });

  test("sseMaxConnectionsPerUser is configurable via HARNESS_WEB_SSE_MAX_CONNECTIONS_PER_USER", async () => {
    expect(resolveServerConfig({ HARNESS_WEB_SSE_MAX_CONNECTIONS_PER_USER: "3" }).sseMaxConnectionsPerUser).toBe(3);
    expect(resolveServerConfig({ HARNESS_WEB_SSE_MAX_CONNECTIONS_PER_USER: "100" }).sseMaxConnectionsPerUser).toBe(100);
  });

  test("sseMaxConnectionsPerUser invalid (0, below min) → ConfigError", async () => {
    expect(() => resolveServerConfig({ HARNESS_WEB_SSE_MAX_CONNECTIONS_PER_USER: "0" })).toThrow(ConfigError);
  });

  test("sseMaxConnectionsPerUser invalid (non-integer) → ConfigError", async () => {
    expect(() => resolveServerConfig({ HARNESS_WEB_SSE_MAX_CONNECTIONS_PER_USER: "abc" })).toThrow(ConfigError);
  });

  test("sseMaxConnectionsPerUser invalid (above max 10 000) → ConfigError", async () => {
    expect(() => resolveServerConfig({ HARNESS_WEB_SSE_MAX_CONNECTIONS_PER_USER: "10001" })).toThrow(ConfigError);
  });

  test("sseConnectionRetryAfterSeconds defaults to 5 + is configurable", async () => {
    expect(resolveServerConfig({}).sseConnectionRetryAfterSeconds).toBe(5);
    expect(resolveServerConfig({ HARNESS_WEB_SSE_CONNECTION_RETRY_AFTER_SECONDS: "10" }).sseConnectionRetryAfterSeconds).toBe(10);
  });

  test("sseConnectionRetryAfterSeconds invalid (0, below min) → ConfigError", async () => {
    expect(() => resolveServerConfig({ HARNESS_WEB_SSE_CONNECTION_RETRY_AFTER_SECONDS: "0" })).toThrow(ConfigError);
  });

  test("DEFAULT_SSE_MAX_CONNECTIONS_PER_USER + DEFAULT_SSE_CONNECTION_RETRY_AFTER_SECONDS are exported (single owner)", async () => {
    const src = readFileSync(CONFIG_PATH, "utf8");
    expect(src).toMatch(/export\s+const\s+DEFAULT_SSE_MAX_CONNECTIONS_PER_USER\b/);
    expect(src).toMatch(/export\s+const\s+DEFAULT_SSE_CONNECTION_RETRY_AFTER_SECONDS\b/);
  });
});

// ── (C) Behavioral: acquireSseConnection rejects over the limit ───────────────

describe("SSE connection limit — acquireSseConnection behavior", () => {
  let tmpRoot: string;
  let db: DbClient;
  let adb: AsyncDbClient;
  let userA: ReturnType<typeof createTestUser>;
  let userB: ReturnType<typeof createTestUser>;

  beforeAll(() => {
    tmpRoot = createTempDir("ch-sse-acq-");
    db = new DbClient({ path: join(tmpRoot, "web.db") });
    adb = AsyncDbClient.inline(db);
    userA = createTestUser(db, "sse-a");
    userB = createTestUser(db, "sse-b");
  });

  afterAll(() => {
    if (db) db.close();
  });

  beforeEach(() => resetSseConnectionTracker());
  afterEach(() => resetSseConnectionTracker());

  test("acquireSseConnection admits up to the limit (default 8) for one identity", async () => {
    const req = mockReq({ cookie: userA.cookie });
    const releases: (() => void)[] = [];
    for (let i = 0; i < serverConfig.sseMaxConnectionsPerUser; i++) {
      releases.push(await acquireSseConnection(req, adb));
    }
    expect(sseConnectionCount(`user:${userA.userId}`)).toBe(serverConfig.sseMaxConnectionsPerUser);
    // Cleanup.
    for (const r of releases) r();
  });

  test("acquireSseConnection rejects the (limit+1)th connection with RateLimitError + correct code + retryAfter", async () => {
    const req = mockReq({ cookie: userA.cookie });
    const releases: (() => void)[] = [];
    for (let i = 0; i < serverConfig.sseMaxConnectionsPerUser; i++) {
      releases.push(await acquireSseConnection(req, adb));
    }
    // The next one MUST throw the SPECIFIC typed error.
    let caught: unknown;
    try {
      await acquireSseConnection(req, adb);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RateLimitError);
    expect((caught as RateLimitError).code).toBe("sse_connection_limit");
    expect((caught as RateLimitError).statusCode).toBe(429);
    expect((caught as RateLimitError).retryAfterSeconds).toBe(serverConfig.sseConnectionRetryAfterSeconds);
    expect((caught as RateLimitError).retryAfterSeconds).toBeGreaterThan(0);
    for (const r of releases) r();
  });

  test("a DIFFERENT user has an INDEPENDENT connection budget (per-identity isolation)", async () => {
    const reqA = mockReq({ cookie: userA.cookie });
    const reqB = mockReq({ cookie: userB.cookie });
    // Exhaust user A.
    const releasesA: (() => void)[] = [];
    for (let i = 0; i < serverConfig.sseMaxConnectionsPerUser; i++) {
      releasesA.push(await acquireSseConnection(reqA, adb));
    }
    // User A is exhausted.
    await expect(acquireSseConnection(reqA, adb)).rejects.toThrow(RateLimitError);
    // User B has a fresh budget — still admits.
    const releaseB = await acquireSseConnection(reqB, adb);
    expect(sseConnectionCount(`user:${userB.userId}`)).toBe(1);
    expect(sseConnectionCount(`user:${userA.userId}`)).toBe(serverConfig.sseMaxConnectionsPerUser);
    for (const r of releasesA) r();
    releaseB();
  });

  test("unauthenticated requests are keyed by the un-spoofable client IP (deny-by-default — no cookie bypass)", async () => {
    const req = mockReq({ remoteAddress: "198.51.100.7" }); // no cookie
    const release = await acquireSseConnection(req, adb);
    expect(sseConnectionCount("ip:198.51.100.7")).toBe(1);
    release();
    expect(sseConnectionCount("ip:198.51.100.7")).toBe(0);
  });
});

// ── (D) Cleanup: closing releases the slot ────────────────────────────────────

describe("SSE connection limit — cleanup releases the slot", () => {
  let tmpRoot: string;
  let db: DbClient;
  let adb: AsyncDbClient;
  let user: ReturnType<typeof createTestUser>;

  beforeAll(() => {
    tmpRoot = createTempDir("ch-sse-cleanup-");
    db = new DbClient({ path: join(tmpRoot, "web.db") });
    adb = AsyncDbClient.inline(db);
    user = createTestUser(db, "sse-cleanup");
  });

  afterAll(() => {
    if (db) db.close();
  });

  beforeEach(() => resetSseConnectionTracker());
  afterEach(() => resetSseConnectionTracker());

  test("closing a stream decrements the count; the identity entry is removed at zero", async () => {
    const req = mockReq({ cookie: user.cookie });
    const res = createMockRes();
    const stream = await openSseStream(res, { req, db: adb });
    expect(sseConnectionCount(`user:${user.userId}`)).toBe(1);
    stream.close();
    expect(sseConnectionCount(`user:${user.userId}`)).toBe(0);
    // The entry is fully removed (not left as 0) so sseConnectionIdentities shrinks.
    expect(sseConnectionIdentities()).toBe(0);
  });

  test("after closing, a new connection succeeds (the slot was released)", async () => {
    const req = mockReq({ cookie: user.cookie });
    // Fill to the limit.
    const streams: Awaited<ReturnType<typeof openSseStream>>[] = [];
    const responses: ReturnType<typeof createMockRes>[] = [];
    for (let i = 0; i < serverConfig.sseMaxConnectionsPerUser; i++) {
      const res = createMockRes();
      responses.push(res);
      streams.push(await openSseStream(res, { req, db: adb }));
    }
    expect(sseConnectionCount(`user:${user.userId}`)).toBe(serverConfig.sseMaxConnectionsPerUser);
    // The next one is rejected.
    const overRes = createMockRes();
    await expect(openSseStream(overRes, { req, db: adb })).rejects.toThrow(RateLimitError);
    // Close ONE — the slot is released.
    streams[0]!.close();
    expect(sseConnectionCount(`user:${user.userId}`)).toBe(serverConfig.sseMaxConnectionsPerUser - 1);
    // Now a new connection succeeds.
    const newRes = createMockRes();
    const newStream = await openSseStream(newRes, { req, db: adb });
    expect(sseConnectionCount(`user:${user.userId}`)).toBe(serverConfig.sseMaxConnectionsPerUser);
    // Cleanup.
    for (const s of streams.slice(1)) s.close();
    newStream.close();
  });

  test("the slot is released on res 'close' event (client disconnect)", async () => {
    const req = mockReq({ cookie: user.cookie });
    const res = createMockRes();
    await openSseStream(res, { req, db: adb });
    expect(sseConnectionCount(`user:${user.userId}`)).toBe(1);
    // Simulate a client disconnect — the res 'close' event fires.
    res.emit("close");
    expect(sseConnectionCount(`user:${user.userId}`)).toBe(0);
  });

  test("the slot is released on res 'error' event", async () => {
    const req = mockReq({ cookie: user.cookie });
    const res = createMockRes();
    await openSseStream(res, { req, db: adb });
    expect(sseConnectionCount(`user:${user.userId}`)).toBe(1);
    res.emit("error", new Error("boom"));
    expect(sseConnectionCount(`user:${user.userId}`)).toBe(0);
  });

  test("close is idempotent — calling it twice does not double-decrement (no negative count)", async () => {
    const req = mockReq({ cookie: user.cookie });
    const res = createMockRes();
    const stream = await openSseStream(res, { req, db: adb });
    stream.close();
    stream.close();
    expect(sseConnectionCount(`user:${user.userId}`)).toBe(0);
  });

  test("-B6: if writeHead throws after a slot is acquired, the slot is released (no leak)", async () => {
    const req = mockReq({ cookie: user.cookie });
    // A res whose writeHead throws (e.g. already ended). The slot MUST be
    // released so it doesn't leak (deny-by-default: never hold a slot for
    // a stream that never opened).
    const badRes = createMockRes();
    (badRes as unknown as { writeHead: () => void }).writeHead = () => { throw new Error("already ended"); };
    // assert the SPECIFIC error message (not a bare.toThrow that
    // catches ANY error — the writeHead "already ended" error must be the
    // one re-thrown, not some other swallowed failure).
    await expect(openSseStream(badRes, { req, db: adb })).rejects.toThrow("already ended");
    expect(sseConnectionCount(`user:${user.userId}`)).toBe(0);
  });

  /**
   * THE FIFTH CLOSE PATH, and the one that had no listener.
   *
   * The other four (explicit close, res `close`, res `error`, a keepalive
   * write failure) are covered above and all run `close()`. This one could
   * not: `openSseStream` AWAITS the identity (`rateLimitKey` → the database)
   * before it attaches any listener, so a client that vanished inside that
   * window fired `close` into an empty room. The stream was then wired to a
   * response that was already dead — no further event would ever arrive — and
   * the slot was held for the life of the process.
   *
   * It is not a rare race in the situation this whole change is about: a
   * browser being refused four times a second aborts constantly, and every
   * leaked slot makes the next refusal likelier. A leak turns a survivable
   * cap into an inevitable one.
   */
  test("the slot is released when the client disconnects DURING the acquire (the fifth path)", async () => {
    const req = mockReq({ cookie: user.cookie });
    const res = createMockRes();
    // Not awaited yet: the identity resolution is still suspended.
    const opening = openSseStream(res, { req, db: adb });
    // The browser gives up while we are still deciding who it is.
    res.emit("close");
    const stream = await opening;
    expect(
      stream.isClosed(),
      "a stream opened onto an already-closed response must not be handed back live",
    ).toBe(true);
    expect(
      sseConnectionCount(`user:${user.userId}`),
      "the slot must be released — nothing else will ever close this response",
    ).toBe(0);
    expect(sseConnectionIdentities()).toBe(0);
  });

  test("all five close paths return the count to zero, from a full budget", async () => {
    // The leak that matters is not one slot; it is the count never returning
    // to zero. Every path is exercised against the SAME identity in one test
    // so the assertion is about the total, not about five separate ones.
    const req = mockReq({ cookie: user.cookie });
    const key = `user:${user.userId}`;

    const explicit = await openSseStream(createMockRes(), { req, db: adb });
    explicit.close();

    const disconnected = createMockRes();
    await openSseStream(disconnected, { req, db: adb });
    disconnected.emit("close");

    const errored = createMockRes();
    await openSseStream(errored, { req, db: adb });
    errored.emit("error", new Error("boom"));

    const badHeaders = createMockRes();
    (badHeaders as unknown as { writeHead: () => void }).writeHead = () => {
      throw new Error("already ended");
    };
    await expect(openSseStream(badHeaders, { req, db: adb })).rejects.toThrow("already ended");

    const raced = createMockRes();
    const opening = openSseStream(raced, { req, db: adb });
    raced.emit("close");
    await opening;

    expect(sseConnectionCount(key), "every path must give the slot back").toBe(0);
    expect(sseConnectionIdentities()).toBe(0);
  });

  test("closeAllSseStreams (shutdown) releases every slot it closes", async () => {
    const req = mockReq({ cookie: user.cookie });
    const streams = [];
    for (let i = 0; i < 3; i += 1) {
      streams.push(await openSseStream(createMockRes(), { req, db: adb }));
    }
    expect(sseConnectionCount(`user:${user.userId}`)).toBe(3);
    const closed = closeAllSseStreams();
    expect(closed).toBeGreaterThanOrEqual(3);
    expect(
      sseConnectionCount(`user:${user.userId}`),
      "shutdown must not leave the tracker holding slots for streams it ended",
    ).toBe(0);
  });

  test("a keepalive write failure closes the stream + releases the slot", async () => {
    vi.useFakeTimers();
    try {
      const req = mockReq({ cookie: user.cookie });
      const res = createMockRes();
      // Make write throw to trigger the keepalive close path.
      (res as unknown as { write: () => boolean }).write = () => { throw new Error("write failed"); };
      await openSseStream(res, { req, db: adb, keepaliveMs: 50 });
      expect(sseConnectionCount(`user:${user.userId}`)).toBe(1);
      vi.advanceTimersByTime(100);
      // The keepalive threw → close ran → the slot was released.
      expect(sseConnectionCount(`user:${user.userId}`)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── (H) The liveness stream draws on its OWN budget ──────────────────────────

/**
 * THE DEFECT THIS SECTION EXISTS FOR, stated once.
 *
 * `/api/live` is a STANDING connection carrying `retry: 250ms`. While it drew
 * on the run budget, eight streams of any kind for one identity meant every
 * liveness reconnect was refused with 429 — and the browser, obeying the
 * cadence the server itself wrote, asked again four times a second, forever.
 * A refusal cannot be cured by retrying, so the page never recovered; only
 * restarting the API cleared it. Browser-observed, with the cockpit blocked
 * behind "The harness API is not answering" over a server that answered
 * every request put to it.
 *
 * The perverse part is the argument: THE STREAM WHOSE ENTIRE JOB IS DETECTING
 * OUTAGES WAS THE FIRST CASUALTY OF LOAD. So the fix is not a bigger shared
 * number — that only moves the point at which the instrument lies — it is
 * that the two classes are counted separately, which is a property of the
 * KEY rather than of anyone remembering to raise a limit.
 */
describe("SSE connection limit — the liveness stream has its own budget", () => {
  let tmpRoot: string;
  let db: DbClient;
  let adb: AsyncDbClient;
  let user: ReturnType<typeof createTestUser>;

  beforeAll(() => {
    tmpRoot = createTempDir("ch-sse-class-");
    db = new DbClient({ path: join(tmpRoot, "web.db") });
    adb = AsyncDbClient.inline(db);
    user = createTestUser(db, "sse-class");
  });

  afterAll(() => {
    if (db) db.close();
  });

  beforeEach(() => resetSseConnectionTracker());
  afterEach(() => resetSseConnectionTracker());

  test("the liveness budget is LARGER than the run budget (the detector is never the scarcer resource)", () => {
    const cfg = resolveServerConfig({});
    expect(cfg.sseMaxLivenessConnectionsPerUser).toBe(32);
    expect(
      cfg.sseMaxLivenessConnectionsPerUser,
      "an outage detector that runs out before the streams it observes reports outages that are not happening",
    ).toBeGreaterThan(cfg.sseMaxConnectionsPerUser);
  });

  test("the liveness budget is sized for real multi-tab use", () => {
    // Several browser windows plus several in-page workspaces is the NORMAL
    // case for this product — a deliberate feature decision, not abuse. One
    // liveness socket per tab (the client holds exactly one per page), so the
    // budget is a tab count, and it must be well past what a person opens.
    expect(resolveServerConfig({}).sseMaxLivenessConnectionsPerUser).toBeGreaterThanOrEqual(16);
  });

  test("the liveness budget is configurable, and FLOORED at the run budget", () => {
    expect(
      resolveServerConfig({ HARNESS_WEB_SSE_MAX_LIVENESS_CONNECTIONS_PER_USER: "64" })
        .sseMaxLivenessConnectionsPerUser,
    ).toBe(64);
    // Raising the RUN budget alone must not leave the detector below it —
    // that is the defect, reachable through the config door.
    expect(
      resolveServerConfig({ HARNESS_WEB_SSE_MAX_CONNECTIONS_PER_USER: "200" })
        .sseMaxLivenessConnectionsPerUser,
      "the liveness budget must never resolve below the run budget",
    ).toBe(200);
    // And an explicit value below the run budget is floored too, rather than
    // being accepted into the shape that broke.
    const cfg = resolveServerConfig({
      HARNESS_WEB_SSE_MAX_CONNECTIONS_PER_USER: "50",
      HARNESS_WEB_SSE_MAX_LIVENESS_CONNECTIONS_PER_USER: "2",
    });
    expect(cfg.sseMaxLivenessConnectionsPerUser).toBe(50);
  });

  test("an EXHAUSTED run budget still admits the liveness stream (the defect, mechanically)", async () => {
    const req = mockReq({ cookie: user.cookie });
    const releases: (() => void)[] = [];
    for (let i = 0; i < serverConfig.sseMaxConnectionsPerUser; i += 1) {
      releases.push(await acquireSseConnection(req, adb, SSE_CONNECTION_CLASSES.run));
    }
    // Run streams are full…
    await expect(
      acquireSseConnection(req, adb, SSE_CONNECTION_CLASSES.run),
    ).rejects.toThrow(RateLimitError);
    // …and the liveness beat gets through anyway. Before the split, this
    // threw, the browser retried four times a second, and the page reported
    // an outage that was not happening.
    const live = await acquireSseConnection(req, adb, SSE_CONNECTION_CLASSES.liveness);
    expect(sseConnectionCount(`user:${user.userId}`, SSE_CONNECTION_CLASSES.liveness)).toBe(1);
    expect(sseConnectionCount(`user:${user.userId}`, SSE_CONNECTION_CLASSES.run)).toBe(
      serverConfig.sseMaxConnectionsPerUser,
    );
    live();
    for (const r of releases) r();
  });

  test("an exhausted LIVENESS budget still admits a run stream (the separation is symmetric)", async () => {
    const req = mockReq({ cookie: user.cookie });
    const releases: (() => void)[] = [];
    for (let i = 0; i < serverConfig.sseMaxLivenessConnectionsPerUser; i += 1) {
      releases.push(await acquireSseConnection(req, adb, SSE_CONNECTION_CLASSES.liveness));
    }
    await expect(
      acquireSseConnection(req, adb, SSE_CONNECTION_CLASSES.liveness),
    ).rejects.toThrow(RateLimitError);
    const run = await acquireSseConnection(req, adb, SSE_CONNECTION_CLASSES.run);
    expect(sseConnectionCount(`user:${user.userId}`, SSE_CONNECTION_CLASSES.run)).toBe(1);
    run();
    for (const r of releases) r();
  });

  test("the liveness budget is still a BOUND — it is not uncapped", async () => {
    // Separating the budgets must not have removed the exhaustion protection
    // the cap exists for. Fill it and check the next one is refused with the
    // same typed error and Retry-After the client's backoff reads.
    const req = mockReq({ cookie: user.cookie });
    const releases: (() => void)[] = [];
    for (let i = 0; i < serverConfig.sseMaxLivenessConnectionsPerUser; i += 1) {
      releases.push(await acquireSseConnection(req, adb, SSE_CONNECTION_CLASSES.liveness));
    }
    let caught: unknown;
    try {
      await acquireSseConnection(req, adb, SSE_CONNECTION_CLASSES.liveness);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RateLimitError);
    expect((caught as RateLimitError).code).toBe("sse_connection_limit");
    expect((caught as RateLimitError).retryAfterSeconds).toBe(
      serverConfig.sseConnectionRetryAfterSeconds,
    );
    for (const r of releases) r();
  });

  test("the class defaults to `run` — the permissive budget must be asked for", async () => {
    // Deny-by-default: a route that says nothing gets the STRICT budget. A
    // default of `liveness` would silently widen every future stream.
    const req = mockReq({ cookie: user.cookie });
    const release = await acquireSseConnection(req, adb);
    expect(sseConnectionCount(`user:${user.userId}`, SSE_CONNECTION_CLASSES.run)).toBe(1);
    expect(sseConnectionCount(`user:${user.userId}`, SSE_CONNECTION_CLASSES.liveness)).toBe(0);
    release();
  });

  test("openSseStream routes the class through to the tracker", async () => {
    // The route passes `connectionClass`; this is the path from that option to
    // the bucket, asserted end to end rather than at the acquire helper only.
    const req = mockReq({ cookie: user.cookie });
    const stream = await openSseStream(createMockRes(), {
      req,
      db: adb,
      connectionClass: SSE_CONNECTION_CLASSES.liveness,
    });
    expect(sseConnectionCount(`user:${user.userId}`, SSE_CONNECTION_CLASSES.liveness)).toBe(1);
    expect(sseConnectionCount(`user:${user.userId}`, SSE_CONNECTION_CLASSES.run)).toBe(0);
    stream.close();
    expect(sseConnectionCount(`user:${user.userId}`, SSE_CONNECTION_CLASSES.liveness)).toBe(0);
  });

  test("the liveness route is the ONLY caller that names the liveness class", () => {
    // The budget is generous BECAUSE the stream is payload-free and one per
    // tab. A second route helping itself to it would be borrowing headroom
    // sized for a different thing.
    const named: string[] = [];
    for (const f of walkTs(SERVER_DIR)) {
      if (f.endsWith(join("server", "router/sse.ts"))) continue; // the definition
      const src = readFileSync(f, "utf8");
      if (/SSE_CONNECTION_CLASSES\.liveness/.test(src)) named.push(f);
    }
    expect(named.map((f) => f.split(sep).slice(-2).join("/"))).toEqual(["routes/live.ts"]);
  });
});

// ── (E) Lowest-level: openSseStream throws BEFORE writeHead when over limit ───

describe("SSE connection limit — lowest-level: rejection before headers", () => {
  let tmpRoot: string;
  let db: DbClient;
  let adb: AsyncDbClient;
  let user: ReturnType<typeof createTestUser>;

  beforeAll(() => {
    tmpRoot = createTempDir("ch-sse-low-");
    db = new DbClient({ path: join(tmpRoot, "web.db") });
    adb = AsyncDbClient.inline(db);
    user = createTestUser(db, "sse-low");
  });

  afterAll(() => {
    if (db) db.close();
  });

  beforeEach(() => resetSseConnectionTracker());
  afterEach(() => resetSseConnectionTracker());

  test("openSseStream throws RateLimitError BEFORE writing the 200 SSE headers (no half-open stream)", async () => {
    const req = mockReq({ cookie: user.cookie });
    // Fill to the limit.
    const streams: Awaited<ReturnType<typeof openSseStream>>[] = [];
    for (let i = 0; i < serverConfig.sseMaxConnectionsPerUser; i++) {
      streams.push(await openSseStream(createMockRes(), { req, db: adb }));
    }
    // The over-limit connection: openSseStream must throw BEFORE writeHead,
    // so the response never gets the 200 text/event-stream headers (the
    // router maps the 429 instead).
    const overRes = createMockRes();
    await expect(openSseStream(overRes, { req, db: adb })).rejects.toThrow(RateLimitError);
    expect(overRes.headerStatus, "the SSE 200 headers must NOT be written on a rejected connection (the router maps the 429)").toBe(0);
    expect(overRes.headersSent).toBe(false);
    for (const s of streams) s.close();
  });

  test("openSseStream without { req, db } does NOT enforce the limit (backward-compat — the prevention test guards routes pass it)", async () => {
    // A call without { req, db } skips the limit (backward compat for
    // tests). The prevention test (A) verifies every server/ caller passes
    // { req, db }, so no production route can use this bypass.
    const res = createMockRes();
    const stream = await openSseStream(res); // no opts
    expect(res.headerStatus).toBe(200);
    expect(sseConnectionIdentities()).toBe(0);
    stream.close();
  });
});

// ── (F) -F9: subprocess env allowlist (subprocessEnv secret-leak fix) ────────────

describe("Subprocess env allowlist (/ -F9) — secrets dropped, allowlist enforced", () => {
  test("subprocessEnv does NOT contain HARNESS_* secrets (deny-by-default — the full-env leak is fixed)", async () => {
    const cfg = resolveServerConfig({
      HARNESS_API_KEY: ("sk" + "-secret-should-not-leak"),
      HARNESS_WEB_DB_KEY: "db-secret-should-not-leak",
      HARNESS_WEB_AUTH_PASSWORD: "pw-secret-should-not-leak",
      PATH: "/usr/bin",
      HOME: "/home/test",
    });
    const env = cfg.subprocessEnv as Record<string, string>;
    expect(env["HARNESS_API_KEY"], "HARNESS_API_KEY must NOT leak to subprocesses").toBeUndefined();
    expect(env["HARNESS_WEB_DB_KEY"], "HARNESS_WEB_DB_KEY must NOT leak to subprocesses").toBeUndefined();
    expect(env["HARNESS_WEB_AUTH_PASSWORD"], "HARNESS_WEB_AUTH_PASSWORD must NOT leak to subprocesses").toBeUndefined();
    // Allowlisted vars DO pass through.
    expect(env["PATH"]).toBe("/usr/bin");
    expect(env["HOME"]).toBe("/home/test");
  });

  test("subprocessEnv ALWAYS adds GIT_OPTIONAL_LOCKS=0 (the git optimization)", async () => {
    const cfg = resolveServerConfig({ PATH: "/usr/bin" });
    expect(cfg.subprocessEnv["GIT_OPTIONAL_LOCKS"]).toBe("0");
  });

  test("the GIT_*, NODE_* and npm_* FAMILIES are dropped — each one can make a child run something", async () => {
    // These three wildcards used to be in the allowlist, and every one of them
    // carries a variable that names a program a child will execute. The
    // previous defence was to neutralise the two that had been noticed, which
    // is a list — and `GIT_CONFIG_COUNT` was measured walking straight past
    // it: with GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM both at /dev/null, a
    // `core.fsmonitor` injected through GIT_CONFIG_KEY_0 still ran.
    //
    // Deny-by-default is the structural answer, and this is its evidence: the
    // named vectors, plus a family member nobody has thought of, all absent.
    const cfg = resolveServerConfig({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.fsmonitor",
      GIT_CONFIG_VALUE_0: "/tmp/pwn.sh",
      GIT_SSH_COMMAND: "/tmp/pwn.sh",
      GIT_EXTERNAL_DIFF: "/tmp/pwn.sh",
      GIT_PAGER: "/tmp/pwn.sh",
      GIT_DIR: "/tmp/elsewhere/.git",
      GIT_AUTHOR_NAME: "Test Author",
      GIT_A_VARIABLE_INVENTED_NEXT_YEAR: "x",
      NODE_OPTIONS: "--require /tmp/pwn.js",
      NODE_PATH: "/tmp/evil_modules",
      npm_config_node_options: "--require /tmp/pwn.js",
      npm_config_registry: "https://registry.npmjs.org",
      PATH: "/usr/bin",
    });
    for (const dropped of [
      "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0",
      "GIT_SSH_COMMAND", "GIT_EXTERNAL_DIFF", "GIT_PAGER", "GIT_DIR",
      "GIT_AUTHOR_NAME", "GIT_A_VARIABLE_INVENTED_NEXT_YEAR",
      "NODE_OPTIONS", "NODE_PATH",
      "npm_config_node_options", "npm_config_registry",
    ]) {
      expect(cfg.subprocessEnv[dropped], `${dropped} must not reach a child process`).toBeUndefined();
    }
    // LIVENESS: the builder really ran and really passed the things it should.
    expect(cfg.subprocessEnv["PATH"]).toBe("/usr/bin");
    expect(cfg.subprocessEnv["GIT_OPTIONAL_LOCKS"]).toBe("0");
  });

  test("subprocessEnv passes http_proxy/https_proxy (proxy config — not a secret)", async () => {
    const cfg = resolveServerConfig({
      https_proxy: "http://proxy.example.com:8080",
      HTTP_PROXY: "http://proxy.example.com:8080",
      PATH: "/usr/bin",
    });
    expect(cfg.subprocessEnv["https_proxy"]).toBe("http://proxy.example.com:8080");
    expect(cfg.subprocessEnv["HTTP_PROXY"]).toBe("http://proxy.example.com:8080");
  });

  test("subprocessEnv drops a random unlisted var (deny-by-default — only allowlisted vars pass)", async () => {
    const cfg = resolveServerConfig({
      RANDOM_UNLISTED_VAR: "should-not-pass",
      MY_CUSTOM_SECRET: "should-not-pass",
      PATH: "/usr/bin",
    });
    expect(cfg.subprocessEnv["RANDOM_UNLISTED_VAR"]).toBeUndefined();
    expect(cfg.subprocessEnv["MY_CUSTOM_SECRET"]).toBeUndefined();
  });

  test("subprocessEnvAllowlist is configurable (a custom var can be allowed)", async () => {
    const cfg = resolveServerConfig({
      HARNESS_WEB_SUBPROCESS_ENV_ALLOWLIST: "PATH,HOME,MY_CUSTOM_VAR",
      PATH: "/usr/bin",
      HOME: "/home/test",
      MY_CUSTOM_VAR: "allowed",
      HARNESS_API_KEY: "sk-secret",
    });
    expect(cfg.subprocessEnv["PATH"]).toBe("/usr/bin");
    expect(cfg.subprocessEnv["HOME"]).toBe("/home/test");
    expect(cfg.subprocessEnv["MY_CUSTOM_VAR"]).toBe("allowed");
    // A custom allowlist REPLACES the default — GIT_* no longer matches
    // (only the explicit entries pass). This is deny-by-default.
    expect(cfg.subprocessEnv["HARNESS_API_KEY"]).toBeUndefined();
    expect(cfg.subprocessEnv["GIT_OPTIONAL_LOCKS"], "GIT_OPTIONAL_LOCKS=0 is ALWAYS added regardless of the allowlist").toBe("0");
  });

  test("subprocessEnvAllowlist prefix match works with a custom allowlist (e.g. FOO_*)", async () => {
    const cfg = resolveServerConfig({
      HARNESS_WEB_SUBPROCESS_ENV_ALLOWLIST: "PATH,FOO_*",
      PATH: "/usr/bin",
      FOO_BAR: "1",
      FOO_BAZ: "2",
      BAZ_QUX: "3",
    });
    expect(cfg.subprocessEnv["FOO_BAR"]).toBe("1");
    expect(cfg.subprocessEnv["FOO_BAZ"]).toBe("2");
    expect(cfg.subprocessEnv["BAZ_QUX"]).toBeUndefined();
  });

  test("the default subprocessEnvAllowlist is the environment projection's COMMAND_ENVIRONMENT (single owner)", async () => {
    expect(resolveServerConfig({ PATH: "/usr/bin" }).subprocessEnvAllowlist).toEqual(COMMAND_ENVIRONMENT);
  });

  test("the config type exposes subprocessEnvAllowlist (the single owner field)", async () => {
    const cfg = resolveServerConfig({ PATH: "/usr/bin" });
    expect(Array.isArray(cfg.subprocessEnvAllowlist)).toBe(true);
    expect(cfg.subprocessEnvAllowlist.length).toBeGreaterThan(0);
  });
});

// ── (G) -F8: normalizeIp dual-stack unification ────────────────────────────

describe("normalizeIp (/ -F8) — dual-stack loopback unification", () => {
  test("strips the IPv4-mapped-IPv6 prefix (::ffff:127.0.0.1 → 127.0.0.1)", async () => {
    expect(normalizeIp("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeIp("::ffff:192.0.2.5")).toBe("192.0.2.5");
  });

  test("unifies the IPv6 loopback::1 with the IPv4 loopback 127.0.0.1 (-F8 fix)", async () => {
    // Before ::1 and 127.0.0.1 got DIFFERENT buckets on a dual-stack
    // server (a client could pick the less-limited stack). After: they
    // share one bucket.
    expect(normalizeIp("::1")).toBe("127.0.0.1");
    expect(normalizeIp("127.0.0.1")).toBe("127.0.0.1");
  });

  test("a regular IPv4 address is unchanged", async () => {
    expect(normalizeIp("198.51.100.7")).toBe("198.51.100.7");
  });

  test("a regular IPv6 address is unchanged (only::1 loopback is unified)", async () => {
    expect(normalizeIp("2001:db8::1")).toBe("2001:db8::1");
  });

  test("normalizeIp is exported (for the prevention test — single owner in rate-limiter.ts)", async () => {
    const limiterSrc = readFileSync(join(process.cwd(), "server", "router", "rate-limiter.ts"), "utf8");
    expect(limiterSrc).toMatch(/export\s+function\s+normalizeIp\s*\(/);
  });
});
