/**
 * SSE CONNECTION-CAP MECHANISM CHECK — the half of the honest-refusal
 * question that the wire cannot reach.
 *
 * WHY THIS EXISTS AS A SEPARATE PROCESS. The brief asks whether the product
 * refuses honestly at its limit. For the SSE connection cap that question
 * splits in two, and only one half is answerable over HTTP:
 *
 *   1. Does the LIMIT ITSELF work — correct threshold, a typed error, the
 *      right status, a usable `Retry-After`, and a slot that is genuinely
 *      released afterwards rather than leaked?
 *   2. Does an over-limit HTTP request actually receive that refusal?
 *
 * (2) is unreachable with `HARNESS_WEB_LLM_FIXTURES=1`, and this was
 * measured rather than assumed: a fixture run completes inside a SINGLE
 * event-loop turn (`streamChat` yields 8 canned events with no I/O to
 * await), so every stream acquires and releases its slot before the next
 * connection is dispatched. Six simultaneous stream GETs against a cap of 1
 * all returned 200 — not because the cap failed, but because the server
 * genuinely never held two streams at once. Reporting that as "the cap is
 * not enforced" would have been a false accusation.
 *
 * (1) IS answerable, because `server/sse.ts` deliberately exports
 * `acquireSseConnection` and `sseConnectionCount` — its own comment says
 * they are "Exposed so the prevention test + diagnostics can verify the
 * limit directly (without an HTTP server)". This module is that diagnostic.
 *
 * It runs as a CHILD PROCESS because `serverConfig` is built once at module
 * load: the cap has to be in the environment before `server/config.ts` is
 * ever imported, and the bench process has already imported it (through
 * `server/auth.ts`) long before this check runs.
 *
 * Prints one line of JSON on stdout. Never a bare pass/fail — the caller
 * reports the observed values.
 *
 * Usage: node --experimental-strip-types bench/wire/sse-cap-probe.ts [cap]
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";

const cap = Number(process.argv[2] ?? "2");
const scratch = mkdtempSync(join(tmpdir(), "ssecap-"));

// MUST precede every import below — serverConfig snapshots the env at load.
process.env["HARNESS_WEB_SSE_MAX_CONNECTIONS_PER_USER"] = String(cap);
process.env["HARNESS_WEB_DB_PATH"] = join(scratch, "web.db");
process.env["HARNESS_WEB_TIMELINE_DB_PATH"] = join(scratch, "timeline.db");

const { acquireSseConnection, sseConnectionCount } = await import("../../server/sse.ts");
const { rateLimitKey } = await import("../../server/rate-limiter.ts");
const { serverConfig } = await import("../../server/config.ts");
const { DbClient } = await import("../../server/db/client.ts");

const db = new DbClient({ path: process.env["HARNESS_WEB_DB_PATH"]! });

// An unauthenticated request keys by IP (`rateLimitKey`'s documented
// fallback), which exercises the same counting path an authenticated one
// does — the key's SOURCE differs, the bookkeeping does not.
const req = { headers: {}, socket: { remoteAddress: "127.0.0.1" } } as unknown as IncomingMessage;
const key = rateLimitKey(req, db);

const attempts: Array<{
  n: number;
  admitted: boolean;
  countAfter: number;
  errorName?: string;
  statusCode?: number;
  code?: string;
  retryAfterSeconds?: number;
}> = [];

const releases: Array<() => void> = [];
// Two past the cap, so a limit that is merely off-by-one is still caught.
for (let n = 1; n <= cap + 2; n++) {
  try {
    releases.push(acquireSseConnection(req, db));
    attempts.push({ n, admitted: true, countAfter: sseConnectionCount(key) });
  } catch (err) {
    const e = err as { constructor?: { name?: string }; statusCode?: number; code?: string; retryAfterSeconds?: number };
    attempts.push({
      n,
      admitted: false,
      countAfter: sseConnectionCount(key),
      errorName: e?.constructor?.name ?? "unknown",
      ...(e?.statusCode !== undefined ? { statusCode: e.statusCode } : {}),
      ...(e?.code !== undefined ? { code: e.code } : {}),
      ...(e?.retryAfterSeconds !== undefined ? { retryAfterSeconds: e.retryAfterSeconds } : {}),
    });
  }
}

// A leaked slot turns a transient refusal into a permanent one, so the
// release path matters as much as the refusal.
const countBeforeRelease = sseConnectionCount(key);
releases[0]?.();
const countAfterRelease = sseConnectionCount(key);
let reacquired = false;
try {
  acquireSseConnection(req, db);
  reacquired = true;
} catch {
  reacquired = false;
}

const admitted = attempts.filter((a) => a.admitted).length;
const refused = attempts.filter((a) => !a.admitted);

process.stdout.write(
  JSON.stringify({
    configuredCap: serverConfig.sseMaxConnectionsPerUser,
    requestedCap: cap,
    capReadCorrectly: serverConfig.sseMaxConnectionsPerUser === cap,
    key,
    attempts,
    admitted,
    admittedMatchesCap: admitted === cap,
    refusedCount: refused.length,
    allRefusalsTyped: refused.length > 0 && refused.every((r) => r.statusCode === 429 && typeof r.code === "string"),
    refusalStatus: refused[0]?.statusCode ?? null,
    refusalCode: refused[0]?.code ?? null,
    retryAfterSeconds: refused[0]?.retryAfterSeconds ?? null,
    countBeforeRelease,
    countAfterRelease,
    releaseDecrements: countAfterRelease === countBeforeRelease - 1,
    slotReusableAfterRelease: reacquired,
  }) + "\n",
);

db.close();
