import { defineConfig, devices } from "@playwright/test";

import { assertSpecPatternsAreLive } from "./tests/helpers/playwright-liveness.ts";
import { armPlaywrightRun } from "./tests/setup/real-database-refusal.ts";

/**
 * Dedicated Playwright config for the performance profile suite.
 *
 * Separate from the default `playwright.config.ts` (which targets
 * `./tests/cockpit/e2e`) so the heavy, single-browser profile run is invoked
 * explicitly (through `npm run perf:profile`)
 * and never runs as part of the regular e2e suite. The profile is
 * intentionally NOT parallel — it profiles one browser against one
 * running server, measuring real interaction latency (parallelism would
 * add scheduling noise). `retries: 0` because a profile is a measurement,
 * not a pass/fail gate (the regression gate is the vitest test that reads
 * the JSON report against the budget).
 *
 * @test-only
 */
const TEST_DIR = "./tests/performance";

// REFUSED AT THE DOOR, exactly as the sibling config is. This declaration has
// ONE alternative rather than two, so total loss and partial loss are the same
// event here — but `testDir` is the half that can go quiet without a sound,
// and a directory that stops existing is what the helper's own refusal names.
// Measured: 2 of the 7 tracked `*.spec.ts` in the repository reach this run.
assertSpecPatternsAreLive("playwright.perf.config.ts", TEST_DIR, [], import.meta.dirname);

// ARMED LIKE EVERY RUNNER (UD-S15): no database door opened under this run
// reaches a real database, and the global setup refuses a server that serves
// one — the profile drives the prepared FIXTURE's server, never the real one.
armPlaywrightRun(import.meta.dirname);

export default defineConfig({
  testDir: TEST_DIR,
  // ONE INSTRUMENT AT A TIME, refused at this door: run concurrently with
  // vitest, this profile measured DOM growth 1613/1500 (a false red); alone,
  // 21/21. The refusal names the holder instead — see
  // tests/setup/playwright-concurrency-lock.ts.
  globalSetup: "./tests/setup/perf-concurrency-lock.ts",
  // Only the Playwright spec — NOT the vitest regression gate
  // (`regression.test.ts`), which imports `vitest` and would crash under
  // Playwright's runner.
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["json", { outputFile: "tests/performance/.run.json" }]],
  use: {
    // The isolated stack's origin, from the one profile step (scripts/testing/perf-profile.ts).
    baseURL: process.env["HARNESS_PERF_BASE_URL"],
    trace: "off",
    screenshot: "off",
    video: "off",
    // Same reason as the sibling config: a controlling service worker
    // can answer reads without the serving data owner and would make the
    // real-population wire census incomplete.
    serviceWorkers: "block",
    ...devices["Desktop Chrome"],
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  // No webServer block: the one profile step (`npm run perf:profile`) owns
  // the isolated stack this profile drives, and the profile fails loudly
  // when it is not running rather than booting or reusing another server.
});
