/**
 * ONE SHARED BODY FOR BOTH PLAYWRIGHT DOORS.
 *
 * Playwright's `globalSetup` must be a module path, so each config gets its
 * own three-line door that names its runner; the mechanism is here, once.
 * The global setup runs once in the main Playwright process before any
 * worker starts, and the function it returns is the global teardown — so
 * the release rides the run's own lifecycle, and a killed run leaves a
 * stale lock the next runner breaks by liveness.
 *
 * The perf profile contends for the same cores as vitest and shares the dev
 * server with the e2e suite: measured while the rule was prose, the profile
 * run concurrently with vitest reported DOM growth 1613/1500 (a false red);
 * alone, 21/21. The e2e suite is the same class of instrument, so it takes
 * the same lock.
 *
 * The same door also refuses a STALE dev server: Playwright's
 * `reuseExistingServer` inherits whatever is listening, and after the
 * cutover's mass deletion a long-lived vite answered 31 of 45 e2e specs with
 * failures that vanished on restart. Both suites judge whatever serves, so
 * both doors take the freshness preflight — a new config routed through this
 * body gets both refusals without an edit.
 */

import { enforceTestRunLock, wholeInstrumentRun, type TestRunLock } from "../../engine/scripts/tooling/test-run-lock.ts";

import { assertFreshDevServers, devServerPorts } from "./dev-server-freshness.ts";
import { refuseRealApiServer } from "./real-database-refusal.ts";

export function playwrightConcurrencyLock(runner: string) {
  return async function globalSetup(): Promise<() => void> {
    // Heavy is the one definition: EVERY Playwright run is a browser instrument, heavy by kind whatever config,
    // project or filter it names (config `wholeInstruments`; counting its arguments read a flag's value as a file).
    // Playwright's main process would hold the lock in its own process, so the run only BORROWS the
    // supervising door's hold (`npm run test:e2e`, `npm run perf:profile`), and is refused by name otherwise.
    const lock: TestRunLock = enforceTestRunLock(runner, { testFileCount: wholeInstrumentRun("playwright"), inProcess: true });
    assertFreshDevServers(process.cwd());
    // After the web servers started (Playwright runs its webServer before the
    // global setup): never drive a server that serves a real database (UD-S15).
    try { await refuseRealApiServer(devServerPorts().api); } catch (error) { lock.release(); throw error; }
    return function globalTeardown(): void {
      lock.release();
    };
  };
}
