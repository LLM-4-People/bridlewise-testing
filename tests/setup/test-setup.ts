/**
 * Vitest setup file — the isolation contract under `isolate: true`.
 *
 * `vitest.config.ts` pins `isolate: true` (a shared module registry made
 * `vi.mock` silently inapplicable: a file mocking a module an earlier file
 * already imported for real got the real one). Under `isolate: true` every
 * test file gets its OWN module registry — but `process.env` is NOT part of
 * that registry: the env is per WORKER PROCESS and leaks across files. Two
 * guarantees keep that boundary honest:
 *
 *   1. CONFIG RESET — `serverConfig` is a `let` singleton re-resolved from
 *      `process.env`. A test that sets `HARNESS_WEB_PORT` via `vi.hoisted`
 *      expects `serverConfig.port` to reflect the new value. Under
 *      `isolate: true` each file re-evaluates config.ts — but a LATER file
 *      would read the env its PREDECESSOR left if nobody restores it (the
 *      second guarantee). `resetServerConfig()` is called in `beforeAll`
 *      (after the test file's `vi.hoisted`/top-level env mutation has run,
 *      before the first test) so the singleton matches the file's env.
 *
 *   2. ENV RESTORE — `process.env` is shared within a worker process. A test
 *      file that sets `process.env.HARNESS_CONFIG_PATH = "/tmp/..."` would
 *      leak to the next file (its fresh config.ts evaluation would read the
 *      stale path). The entire `process.env` is snapshotted once per worker
 *      (at setup-module load — the clean boot state) + restored in
 *      `afterAll` of every file, so each file starts from the same clean
 *      env. This is dynamic (no hardcoded var list) — every env key is
 *      covered, including keys added by future tests.
 *
 * The `beforeAll`/`afterAll` hooks run per test FILE. So does this module's
 * own body: vitest RE-EXECUTES setup files for every test file (measured,
 * because the distinction is load-bearing below: a `mkdtemp` at this
 * module's scope produced one directory per test file, not one per worker.
 * Anything that must be worker-scoped therefore has to be memoised in a
 * normal module — see `createWorkerTempDir` — not here; and under
 * `isolate: true` a worker-scoped memo IS per-file again, which is exactly
 * why per-file dirs belong in the setup file's sweep).
 *
 * Being re-executed per file is what lets this module set state that a test
 * file's own module evaluation will read, which no hook can do: hooks run
 * after the test file has already been imported.
 *
 * It is NOT test weakening: every invariant is still tested; the setup
 * merely restores clean boundary state between files so the worker's shared
 * process state (env) is safe to reuse.
 */

import { beforeAll, afterAll, expect, vi } from "vitest";
import { join } from "node:path";
import { resetServerConfig } from "../../server/kernel/config.ts";
import { resetUiSchema } from "../../src/state/schema-store.ts";
import { returnToLive } from "../../src/data/asof.ts";
import { createWorkerTempDir, sweepTempDirs } from "../helpers/temp-dir.ts";
import { assertGlobalsRestored, captureGlobals } from "../helpers/global-boundary.ts";
import { refuseRemoteNetworkUnderTest } from "../../engine/scripts/tooling/network-under-test.ts";

// ── THE NETWORK (worker scope, before any test file is read) ──────────────
//
// A test never dials a remote host: this worker connects only to this machine,
// at the socket (`net.Socket.prototype.connect`, which the platform fetch,
// http, tls, undici and WebSocket all connect through); the one declared live
// opt-in is `engine/src/process/live-network.ts`. Idempotent: this file runs
// again for every test file, and a process keeps the first guard it loads.
refuseRemoteNetworkUnderTest();

// ── LEDGER + DB REDIRECTION (worker scope, before any test file is read) ──
//
// The defect: `server/config.ts` defaults `timelineDbPath` to
// `.bridlewise/timeline.db` and `dbPath` to `.bridlewise/web.db`, both
// relative to `process.cwd()` — the developer's OWN repo. No test set either
// variable, so every ledger-touching test appended to the LIVE dev ledger.
// Measured before this redirection: the real `.bridlewise/timeline.db` grew
// by hundreds of rows per run (`action:settings…`, `action:arm.flags/set`,
// tool/file-effect/memory events), and its row count moved while the suite ran.
//
// Why it has to happen HERE, at module scope, and not in a hook:
// `server/timeline-bridge.ts` memoises its store/query/recorder in module-scope
// `let`s on first use, and derives its ledger-id sidecar path at module
// evaluation. Under `isolate: false` that module is evaluated ONCE per worker,
// by whichever test file imports it first — long before any `beforeAll` of
// that file has run. So a hook is structurally too late: by the time it fires,
// the handle to the real DB is already open and cached for the whole worker.
// Setup-file module scope is the only point that precedes every test file.
//
// `resetServerConfig()` is called immediately after, because `serverConfig`
// was already resolved (from the un-redirected env) when the static import of
// `server/config.ts` above was evaluated.
//
// This is the temp-dir owner's argument applied to the data stores: a test
// that opens a ledger gets a throwaway one BY CONSTRUCTION, rather than every
// ledger-touching test being asked to remember an env var.
const WORKER_STORE = createWorkerTempDir("ch-web-worker-store-");
process.env.HARNESS_WEB_TIMELINE_DB_PATH = join(WORKER_STORE, "timeline.db");
process.env.HARNESS_WEB_DB_PATH = join(WORKER_STORE, "web.db");
// Database redirection cannot isolate a subprocess's HTTP client. Port zero
// never names the canonical listener; tests that need HTTP must pass their
// actual test-owned ephemeral listener through the supported config owner.
process.env.HARNESS_WEB_PORT = "0";
resetServerConfig();

// Snapshot the clean boot env. This module re-executes per test file, and the
// previous file's `afterAll` has already restored the env, so the value read
// here is the same clean state on every file. Restoring to it in each file's
// `afterAll` returns the worker to that state for the next file.
// Captured AFTER the store redirection above so the per-file env restore
// preserves it rather than deleting it back to the live paths.
const INITIAL_ENV: Record<string, string> = { ...process.env } as Record<string, string>;

// ── GLOBALS THAT CROSS A FILE BOUNDARY ───────────────────────────────────
//
// Owned by `tests/helpers/global-boundary.ts` — the what and the why are
// documented there, including why the bookkeeping cannot live in this file
// (vitest re-executes setup files per test file, so module state here is
// per-file and a worker-scoped ledger of leaks would be wiped between files).
//
// THE SNAPSHOT IS TAKEN HERE, AT MODULE SCOPE, BECAUSE THIS IS THE LAST POINT
// BEFORE VITEST IMPORTS THE TEST FILE. A `beforeAll` snapshot runs after the
// file's module body, so a module-scope `globalThis.fetch = fake` was stored
// as that file's own pristine value and could never be reported. This module
// body is re-executed for every test file, and the helper's snapshot is
// per-file for the same reason.
//
// FRAMEWORK-INSTALLED GLOBALS ARE ENVIRONMENT, NOT A FILE'S LEAK. Svelte's
// dev client defines `$state`/`$effect`/`$derived`/`$inspect`/`$props`/
// `$bindable` on `globalThis`, and `svelte/internal/disclose-version` adds
// `window.__svelte` the first time a component module loads. Preload both in
// the DOM environment BEFORE the boundary snapshot, so the framework's own
// install is part of the file's entry state; importing a component later then
// adds nothing. Without this, every cockpit file would be blamed for the
// framework's globals rather than for a global it replaced.
if (typeof window !== "undefined") {
  await import("svelte");
  // @ts-expect-error -- the package export ships no declaration file.
  await import("svelte/internal/disclose-version");
}
//
// The contract the hooks below enforce: every own property of `globalThis`
// holds its entry descriptor when the file ends.
captureGlobals();

beforeAll(() => {
  // The test file's `vi.hoisted`/top-level env mutation has already run (it
  // runs during the test file's module initialization, before setup hooks).
  // Re-resolve the singleton so it reflects the current env. Tests that read
  // `serverConfig` see the file's env, not the previous file's stale value.
  resetServerConfig();
});

afterAll(() => {
  // GLOBAL RESTORE — the boundary described above, enforced in two steps.
  //
  // First `vi.unstubAllGlobals()`, which undoes every `vi.stubGlobal` the file
  // registered. Files that already call it in their own `afterEach` are
  // unaffected (it is idempotent); files that forget, or that stub inside a
  // test that throws before its teardown, are covered here.
  //
  // Then the descriptor compare, because `unstubAllGlobals` is blind to direct
  // `globalThis.x = …` (or `globalThis["x"] = …`) assignment — the shape nine
  // files actually use. It compares EVERY own property, not a watchlist, and
  // runs at the END of this hook (below), after the cleanup that must not be
  // skipped by its failure, and it THROWS for the file that leaked: under
  // `isolate: true` a later file cannot see (or blame) this one.
  vi.unstubAllGlobals();

  // TEMP-DIR SWEEP — the file-scope half of the temp-dir owner contract.
  //
  // `tests/helpers/temp-dir.ts` removes per-test dirs via `onTestFinished`,
  // but that hook cannot be registered at module scope or inside `beforeAll`
  // (no test context). Those dirs belong to the FILE, and setup-file hooks
  // are registered per test file — so this is their correct owner. Without
  // it a `beforeAll`-created dir leaks: verified by probe, and this class of
  // leak filled a 36G tmpfs with 74,476 stale dirs.
  //
  // Runs before the env restore below only in the sense that it is in the
  // same hook; ordering between them does not matter (disjoint concerns).
  sweepTempDirs();

  // TIME-TRAVEL HEAD — a file that plants a head and never returns to live
  // leaves the whole worker in a past view. Every write door then correctly
  // REFUSES (that is the feature working), so unrelated files fail with
  // symptoms that look nothing like the cause: the composer stops accepting
  // text, a run refuses to begin, custody's verbs are inert. Five files were
  // planting without returning; rather than ask each to remember, the
  // worker-level owner returns to live here — the same reasoning as the
  // config, schema and temp-dir resets above.
  returnToLive();

  // SERVED-SCHEMA RESET — the third shared singleton, for exactly the same
  // reason as the config one above.
  //
  // `src/state/schema-store.ts` is a module-scope nanostore. Any file that
  // mounts the cockpit against a STUBBED `/api/schema/ui` writes that stub
  // into it, and a stub is a partial shape (typically `{menus, panels,
  // widgets}` with no `modules`) because the surface under test does not
  // need the rest. Left behind, it hands the next file a schema no real
  // server would send — and the failure surfaces over in THAT file
  // (`uiSchema.get()?.modules.find(...)` on `undefined`), which reads as a
  // bug in code the file never touched. Resetting here fixes the whole class
  // once, instead of relying on every future cockpit test remembering to.
  resetUiSchema();

  // Restore `process.env` to the clean boot snapshot: delete keys added by
  // this file, reset keys changed by this file. Dynamic — no key list.
  const current = process.env as Record<string, string | undefined>;
  for (const key of Object.keys(current)) {
    if (!(key in INITIAL_ENV)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(INITIAL_ENV)) {
    process.env[key] = value;
  }
  // Re-resolve so the singleton matches the restored env for the next file.
  resetServerConfig();

  // THE GLOBAL BOUNDARY FAILS THE FILE THAT LEAKED. This is last so the
  // repairs above (temp dirs, time travel, env, schema) run even when a leak
  // throws. `vi.unstubAllGlobals()` has already restored every sanctioned
  // `vi.stubGlobal`; what remains is a direct assignment the file never put
  // back, which used to be repaired silently and blamed on the next file.
  assertGlobalsRestored(expect.getState().testPath ?? "unknown");
});
