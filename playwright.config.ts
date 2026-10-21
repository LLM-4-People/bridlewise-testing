import { defineConfig, devices } from "@playwright/test";

import { assertSpecPatternsAreLive } from "./tests/helpers/playwright-liveness.ts";
import { armPlaywrightRun } from "./tests/setup/real-database-refusal.ts";

/**
 * The spec trees this project runs under Playwright, as DATA.
 *
 * One declaration, two uses: the `testMatch` regex below is BUILT from these
 * alternatives, and the liveness refusal counts what each of them selects. A
 * hand-written regex beside a hand-written list would be two sources of truth
 * for one question, and the one that drifts is always the one nothing reads.
 *
 * ── THE DEAD ALTERNATIVE THIS REPLACES ────────────────────────────────────
 *
 * It read `/(e2e|cockpit\/e2e)\/.*\.spec\.ts/`, and `tests/e2e/` DOES NOT
 * EXIST — every spec lives under `tests/cockpit/e2e/`. The declaration
 * survived only because the regex is unanchored, so the bare `e2e` alternative
 * matches as a SUBSTRING of `cockpit/e2e`; the second alternative was
 * redundant and the first was matching for the wrong reason. Nothing could
 * have said so: 5 specs were found either way.
 */
const SPEC_TREES: readonly string[] = ["cockpit/e2e"];

const TEST_DIR = "./tests";

// REFUSED AT THE DOOR. Playwright loads this file for every `playwright test`
// invocation, so a tree that stops existing cannot be run past — the same
// place `vitest.config.ts` refuses a dead runner glob, for the same reason.
// A whole-declaration floor would not do: total loss is loud (`No tests
// found`), partial loss is silent, and partial loss is the one that happens.
assertSpecPatternsAreLive("playwright.config.ts", TEST_DIR, SPEC_TREES, import.meta.dirname);

// ARMED LIKE EVERY RUNNER (UD-S15): this checkout is under test for the run and
// everything it starts, so no database door opened under it reaches a real
// database, and the API server this run starts keeps its databases in the
// run's own folder. A server it would REUSE is judged by the global setup.
const API_SERVER_STATE = armPlaywrightRun(import.meta.dirname);

export default defineConfig({
  testDir: TEST_DIR,
  // ONE INSTRUMENT AT A TIME, refused at this door: the e2e suite contends
  // for the same cores and the same dev server as every other runner — see
  // tests/setup/playwright-concurrency-lock.ts.
  globalSetup: "./tests/setup/e2e-concurrency-lock.ts",
  // Built from the declaration above, and anchored at the end so a
  // vitest-owned `*.test.ts` cannot enter.
  testMatch: new RegExp(`(?:${SPEC_TREES.join("|")})/.*\\.spec\\.ts$`, "u"),
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "on-first-retry",
    // The cockpit entry registers the service worker, and a controlling SW
    // routes fetches AROUND Playwright's `page.route` — every mocked spec
    // would silently start hitting the real API on its second navigation.
    // Blocked here at the config choke point; the SW itself is verified by
    // tests/prevention/pwa.test.ts and the live browser check.
    serviceWorkers: "block",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  // BOTH halves of the product, so the suite carries its own dependencies:
  // the signed-out boot spec drives the REAL auth probe, and with only vite
  // here it failed whenever the API server was not already running — a spec
  // whose green depended on what happened to be started before it. Each
  // entry reuses a server the dev workflow already has up.
  webServer: [
    {
      command: "npm run dev",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: "npm run dev:api",
      url: "http://127.0.0.1:5174/api/health",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      env: { ...API_SERVER_STATE },
    },
  ],
});
