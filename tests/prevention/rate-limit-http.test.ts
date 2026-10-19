// @vitest-environment node
/**
 * Rate-limit HTTP behavioral tests — the session-cookie bypass is fixed.
 *
 * Split from rate-limit-security.test.ts so the four HTTP-loop tests (which
 * fire ~360 real requests against a real server) run in their own file. The
 * fast source-scan + in-process tests stay in rate-limit-security.test.ts;
 * this file owns the slow HTTP-server describe block. All invariants are
 * preserved — only the file boundary moved (no weakening).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";

import { registerAllRoutes } from "../../server/routes/registry.ts";
import { createTestUser } from "../helpers/multi-user.ts";
import { startHttpTestServer, type HttpTestServer } from "../helpers/http-server.ts";
import { resetRateLimiter, consumeToken } from "../../server/router/rate-limiter.ts";

describe("Rate-limit security — the session-cookie bypass is fixed (behavioral)", () => {
  let srv: HttpTestServer;
  let userA: ReturnType<typeof createTestUser>;
  let userB: ReturnType<typeof createTestUser>;

  beforeAll(async () => {
    srv = await startHttpTestServer({
      prefix: "ch-rl-http-",
      register: (router, db, adb) => {
        registerAllRoutes(router, adb);
      },
    });
    userA = createTestUser(srv.db, "rl-http-a");
    userB = createTestUser(srv.db, "rl-http-b");
  });

  afterAll(async () => {
    if (srv) await srv.stop();
    resetRateLimiter();
  });

  beforeEach(() => { resetRateLimiter(); });
  afterEach(() => { resetRateLimiter(); });

  /** A public mutating POST (logout — fast, no scrypt) with the CSRF custom
   * header. `cookie` controls auth (null = no cookie at all). */
  async function postPublic(cookie: string | null): Promise<number> {
    const headers: Record<string, string> = {
      "X-Requested-With": "test",
      "Content-Type": "application/json",
    };
    if (cookie !== null) headers["Cookie"] = cookie;
    const res = await fetch(`${srv.baseUrl}/api/auth/logout`, {
      method: "POST",
      headers,
      body: "{}",
    });
    return res.status;
  }

  /** A protected mutating POST (projects with an empty body → 400, but the
   * token is consumed BEFORE the handler; the route does not destroy the
   * auth session, so the userId key stays stable across repeated calls). */
  async function postProtected(cookie: string): Promise<number> {
    const res = await fetch(`${srv.baseUrl}/api/projects`, {
      method: "POST",
      headers: {
        "Cookie": cookie,
        "X-Requested-With": "test",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    return res.status;
  }

  // (a) No-cookie requests are STILL rate-limited (by IP).
  test("(a) omitting the session cookie does NOT bypass the rate limit (keyed by IP)", async () => {
    // Fire the 80 requests concurrently — the HTTP I/O overlaps (80× RTT →
    // ~1× RTT). The server's rate limiter is synchronous (Map operations
    // on the event loop), so concurrent requests are still processed one
    // at a time; the token bucket still allows ~60 + rate-limits ~20.
    const statuses = await Promise.all(
      Array.from({ length: 80 }, () => postPublic(null)),
    );
    const rateLimited = statuses.filter((s) => s === 429).length;
    const allowed = statuses.filter((s) => s !== 429).length;
    expect(rateLimited, "no-cookie requests must be rate-limited by IP (bypass fix)").toBeGreaterThan(0);
    expect(allowed).toBeGreaterThan(0);
  });

  // (b1) Session rotation does NOT reset the bucket (keyed by userId).
  test("(b1) rotating the harness_session cookie does NOT reset the bucket (keyed by userId)", async () => {
    // Fire the 65 requests concurrently to exhaust the bucket, then fire
    // the rotated-cookie request after they complete. The bucket is
    // exhausted by the 65 before the rotated request arrives.
    await Promise.all(Array.from({ length: 65 }, () => postProtected(userA.cookie)));
    const rotated = await postProtected(`${userA.cookie}; harness_session=rotated-${Date.now()}`);
    expect(rotated, "session rotation must NOT reset the bucket (keyed by userId, not session)").toBe(429);
  });

  // (b2) Omitting the session cookie (while authenticated) does NOT bypass.
  test("(b2) omitting the harness_session cookie while authenticated does NOT bypass (flag fix)", async () => {
    await Promise.all(Array.from({ length: 65 }, () => postProtected(userA.cookie)));
    const omitted = await postProtected(userA.cookie);
    expect(omitted, "omitting the session cookie must NOT bypass the rate limit (/fix)").toBe(429);
  });

  // (b3) A different user has an INDEPENDENT fresh bucket.
  test("(b3) a different authenticated user has an independent fresh bucket (per-user keying)", async () => {
    await Promise.all(Array.from({ length: 65 }, () => postProtected(userA.cookie)));
    const exhaustedA = await postProtected(userA.cookie);
    expect(exhaustedA).toBe(429);
    const userBStatus = await postProtected(userB.cookie);
    expect(userBStatus, "a different user has an independent fresh bucket (per-user keying)").not.toBe(429);
  });

  test("the bucket mechanism still works (consumeToken exhaustion + independence) — regression guard", () => {
    // Direct low-level guard using the live limiter (reset first). The bucket
    // primitive still enforces a budget per key, independent across keys.
    resetRateLimiter();
    const keyA = "guard-a";
    const keyB = "guard-b";
    let aAllowed = 0;
    for (let i = 0; i < 80; i++) {
      if (consumeToken(keyA)) aAllowed++;
    }
    expect(aAllowed).toBeLessThanOrEqual(60);
    expect(aAllowed).toBeGreaterThan(0);
    expect(consumeToken(keyB)).toBe(true);
  });
});
