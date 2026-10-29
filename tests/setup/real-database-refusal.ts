/**
 * A BROWSER SUITE NEVER DRIVES A SERVER THAT SERVES A REAL DATABASE (UD-S15).
 *
 * ── THE INCIDENT ──────────────────────────────────────────────────────────
 *
 * The live `web.db` held 204 seeded conversations of 1,000 messages each:
 * the performance profile's long-chat phase seeded them into the database of
 * the developer's own running server, from the Playwright process, which
 * nothing recognised as "under test". The runners now ARM every Playwright
 * process (`armPlaywrightRun`), so a database door opened from one refuses a
 * real database itself; what remains is the server the suite drives over
 * HTTP, which `reuseExistingServer` may find already running — the
 * developer's own, on the real database.
 *
 * ── THE SIGNAL ────────────────────────────────────────────────────────────
 *
 * The server's `/api/health` states WHOSE database it serves, read from the
 * database's own header (`engine/src/filesystem/database-provenance.ts`):
 * `product` (a real database), `fixture` (a deliberate copy made by the
 * fixture door), `test` (one a process under test created), `unstamped` (one
 * the product has not opened since it stamps). The global setup drives only
 * a `fixture` or `test` server, never `product`, `unstamped` (SCALE-CR1-FIX
 * N5: the under-test server on a real database from before the stamp) or a
 * server that does not say (an older build) — never by port or path, so a
 * renamed or moved database is judged the same way.
 */
import { armCheckoutUnderTest, enclosingTestRunScratch } from "../../engine/src/filesystem/checkout-write-door.ts";
import { createOwnedTemporaryDirectory, ensurePrivateStateDirectory } from "../../engine/src/filesystem/private-state.ts";
import { armTestKeyHome } from "../../engine/test/support/test-key-home.ts";

import { join } from "node:path";

/** The refusal for one server's health answer, or null when it may be driven. Pure. */
export function realServerRefusal(health: unknown, origin: string): string | null {
  const database = health !== null && typeof health === "object" ? (health as { database?: unknown }).database : undefined;
  if (database === "fixture" || database === "test") return null;
  if (database === "product") {
    return `the API server at ${origin} serves a REAL database (its header carries the product's stamp); a browser suite drives a server it started on a database it owns, or one serving a fixture copy — stop that server, or point it at a fixture`;
  }
  return database === "unstamped" || database === "foreign"
    ? `the API server at ${origin} serves a database with no test or fixture stamp (${database}): it may be a real one from before the product stamped its databases — stop that server, or point it at a database the suite owns`
    : `the API server at ${origin} does not say whose database it serves (an older build?); restart it from this checkout so the suite can tell it is not a real one`;
}

/** Ask the API server listening on `port`; throw the refusal. No server listening: nothing to judge. */
export async function refuseRealApiServer(port: number): Promise<void> {
  const origin = `http://127.0.0.1:${String(port)}`;
  let health: unknown;
  try {
    const response = await fetch(`${origin}/api/health`);
    health = await response.json();
  } catch {
    return;
  }
  const refusal = realServerRefusal(health, origin);
  if (refusal !== null) throw new Error(refusal);
}

/**
 * ARM A PLAYWRIGHT RUN as every other runner is armed: this checkout is under
 * test for the runner, its workers and every process they start (the
 * inherited marker), with a private key home. In the RUNNER (no
 * `TEST_WORKER_INDEX`), also a private state folder for the API server the
 * run starts — an owned temporary in the run's own scratch (removed when the
 * runner exits, and with the run) — returned as that
 * server's environment: its databases are the run's own, never the
 * checkout's `.bridlewise/web.db`.
 */
export function armPlaywrightRun(repositoryRoot: string): Readonly<Record<string, string>> {
  armCheckoutUnderTest(repositoryRoot);
  armTestKeyHome();
  if (process.env.TEST_WORKER_INDEX !== undefined) return {};
  // In the run's own scratch (the one test-execution door's; Playwright runs only through it): the checkout's state
  // root is read-only to a test run.
  const scratch = enclosingTestRunScratch();
  if (scratch === undefined) throw new Error("a Playwright run starts only through the test-execution door (npm run test:e2e), which gives it a run scratch");
  const state = createOwnedTemporaryDirectory(ensurePrivateStateDirectory(join(scratch, "browser-suite")), "run-");
  return Object.freeze({ HARNESS_WEB_DB_PATH: join(state, "web.db"), HARNESS_WEB_TIMELINE_DB_PATH: join(state, "timeline.db") });
}
