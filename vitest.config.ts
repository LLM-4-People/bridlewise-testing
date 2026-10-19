/**
 * THE WEB TEST RUNNER'S CONFIGURATION — the build's own configuration
 * (`vite.config.ts`, which ships with the product) plus everything only the
 * suite needs: the declared test globs and their liveness refusal, the
 * checkout write door and the private key home it arms, the worker pools,
 * the setup and global-setup files, the module caches, the budget reporter.
 *
 * WHY TWO FILES. The product tree carries no test suite, so a build config
 * that imported `tests/**` (and the engine's test support) could not load
 * where the suite is absent: the shared file is product-only, and this one
 * EXTENDS it (`mergeConfig` over its `BUILD_CONFIG`) — one declaration of the
 * build half, read by both the dev server and the runner. (Its default export
 * refuses vitest's test mode: the suite never runs through it.) Vitest resolves `vitest.config.ts`
 * before `vite.config.ts` (its `CONFIG_NAMES` order), so every way of running
 * the suite — `vitest run`, `npm test`, `npm run test:raw`, watch, `vitest
 * list` — loads this file; `vite`, `vite build` and `vite preview` never do.
 */
import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, mergeConfig } from "vitest/config";

import { BUILD_CONFIG } from "./vite.config.ts";
import { TEST_TIMEOUT_MS } from "./tests/test-budget.ts";
import { TEST_INCLUDE } from "./tests/test-include.ts";
import { enableSharedCompileCache } from "./engine/scripts/tooling/compile-cache.ts";
import { armCheckoutUnderTest } from "./engine/src/filesystem/checkout-write-door.ts";
import { armTestKeyHome } from "./engine/test/support/test-key-home.ts";
import {
  globMatchCounts,
  patternLivenessFailure,
} from "./engine/scripts/verification/pattern-liveness.ts";

/**
 * EVERY DECLARED TEST GLOB, AND THE ONE DECLARATION THEY ARE READ FROM.
 *
 * Declared in `tests/test-include.ts` and re-exported here, because a guard
 * whose subject is "every file the runner selects" must read the binding the
 * runner is handed — and until that binding lived in a module with no weight,
 * one such guard could not import it and re-parsed THIS FILE'S SOURCE with a
 * regular expression instead. See `tests/test-include.ts` for what that copy
 * got wrong, twice.
 *
 * The re-export keeps this file the place a reader looks for the suite's
 * shape, and `include: [...TEST_INCLUDE]` below keeps the runner and the
 * liveness check on the same value.
 */
export { TEST_INCLUDE };

// Every test entry loads this config before Vitest creates its isolated
// workers. Reuse the engine's native compilation cache and its child-env
// propagation here, so raw `vitest run` and the watchdog pay the same work.
// Node caches compiled code, never evaluated module state: mocks, globals
// and per-file isolation belong to fresh forks for Node tests and fresh VM
// contexts for the declared DOM population. Vite-transformed
// modules keep their separate fsModuleCache below. The existing cache owner
// keeps the directory off tmpfs and outside scanned trees; no warm-up runs
// or precomputed product state are needed. Dev-server boots never load this
// file (they read `vite.config.ts`).
if (process.env.VITEST === "true") enableSharedCompileCache();

// THE SUITE ARMS THE CHECKOUT WRITE DOOR for the checkout it tests, here in
// vitest's main process and before any worker exists: every worker and every
// process a test spawns inherits the marker (or finds this process holding
// it), so no test can rewrite this checkout's files. A module that imports
// this file outside a vitest run (a guard reading its declarations) has no
// VITEST and arms nothing. See engine/src/filesystem/checkout-write-door.ts.
if (process.env.VITEST === "true") armCheckoutUnderTest(import.meta.dirname);
// …and a PRIVATE KEY HOME for the run, so no test reads or writes the user's
// harness keys (engine/src/filesystem/self-protection/key-home.ts).
if (process.env.VITEST === "true") armTestKeyHome();

/**
 * A DEAD GLOB REFUSES THE RUN, HERE, BEFORE A SINGLE TEST IS COLLECTED.
 *
 * This is the lowest choke point available for the invariant: every way of
 * running the suite — `vitest run`, `npm test`, `npm run test:raw`, watch,
 * the CI entry — loads this config first, so there is no path that reaches
 * the runner with a glob that selects nothing. Nothing has to remember to
 * call it.
 *
 * WHAT WAS THERE BEFORE, AND WHY IT COULD NOT SEE THIS. `passWithNoTests`
 * appears nowhere in this repository, so vitest's default guards only the
 * case where ALL FIVE globs are dead. The repository's own floor —
 * `expect(discovered).toBeGreaterThan(300)` over 451 files — is a SCALAR over
 * the whole population, and a scalar cannot see a partial collapse. Driven:
 * drop `tests/cockpit/**`, lose 121 files, and 330 still clears 300. Four of
 * the five globs can die one at a time in total silence. Only the largest
 * survives its own removal, and only by arithmetic accident.
 *
 * So the floor is keyed to the PART, not to the total.
 */
const includeLiveness = patternLivenessFailure(
  "vitest.config.ts test.include",
  globMatchCounts(TEST_INCLUDE, import.meta.dirname),
);
if (includeLiveness !== null) {
  throw new Error(
    `${includeLiveness} Nothing was run: a test runner pointed at a pattern that ` +
    `matches no file reports success for tests it never collected.`,
  );
}

// Match Vitest 4.1.10's FIRST environment directive, including the Jest
// spelling. This partitions the existing include population without adding
// or dropping a file. Files requiring Node process/native semantics remain
// in isolated forks; only explicit DOM files use fresh VM contexts.
const contextPool = process.env.VITEST === "true"
  ? (await import("./tests/helpers/vm-context-pool.ts")).contextPool
  : "forks";
const testFiles = process.env.VITEST === "true"
  ? [...globSync(TEST_INCLUDE, { cwd: import.meta.dirname })]
  : [];
const browserTests = testFiles.filter((path) =>
  readFileSync(join(import.meta.dirname, path), "utf8").match(/@(?:vitest|jest)-environment\s+([\w-]+)\b/)?.[1] === "jsdom");

const browserTestSet = new Set(browserTests);
const nodeTests = testFiles.filter((path) => !browserTestSet.has(path));


export default mergeConfig(BUILD_CONFIG, defineConfig({
  test: {
    // Default to the node environment (fast — no DOM setup). Files that
    // render Svelte components opt in via `// @vitest-environment jsdom`.
    // Most tests are unit/prevention tests that scan source or exercise
    // server logic — they never touch the DOM, so jsdom's ~0.5s/file setup
    // was wasted overhead. Deny-by-default: DOM is opt-in, not the default.
    environment: "node",
    globals: true,
    // Node tests retain fresh, externally killable child processes. The DOM
    // project below uses the same OS boundary with a fresh VM context for
    // every file. Each context evaluates new module/mock/global state;
    // process.env restoration stays with the existing setup owner.
    //
    // Bare shared-registry forks previously ignored mocks of modules an
    // earlier file had imported (composer-commit-seam, flow-stream-channels,
    // model-provenance-owner). Fresh contexts preserve those assertions.
    // Resetting only the module registry is insufficient: it splits setup's
    // schema-store/asof/temp-dir instances from the test file's instances.
    // The existing isolation guard now drives both real process populations.
    pool: "forks",
    isolate: true,
    setupFiles: ["./tests/setup/test-setup.ts"],
    // RUNS ONCE, AROUND THE WHOLE RUN, and that is the point: it fingerprints
    // first-party source before any worker starts and again after the last
    // one exits, so a test that mutates a real source file cannot hide behind
    // ordering, a `-t` filter, or a `finally` that restored the wrong bytes.
    // A run left `server/worker-ipc.ts` at zero bytes and was noticed only
    // because other tests imported it.
    // ONE INSTRUMENT AT A TIME, refused at this door: the lock runs FIRST,
    // before the fingerprint and before any worker — see
    // tests/setup/concurrency-lock.ts for the measured contention it ends.
    globalSetup: ["./tests/setup/concurrency-lock.ts", "./tests/setup/source-tree-immutable.ts"],
    // Persist the transformed module cache to disk so reruns skip the
    // per-file TS→JS transform + module-graph evaluation. The first run
    // builds the cache; subsequent runs (the common dev-iteration case)
    // read from disk — vitest docs show import 5.52s→2.35s, transform
    // 4.02s→842ms on reruns. The cache lives in node_modules/.experimental-
    // vitest-cache (gitignored as node_modules). `vitest --clearCache` resets.
    experimental: {
      fsModuleCache: true,
    },
    // Pre-bundle external dependencies (node_modules) with esbuild so each
    // worker reads one optimized bundle instead of evaluating dozens of
    // scattered module files. This cuts the per-worker `import` cost for
    // the external portion of the module graph (zod, nanostores, etc.).
    // The optimizer.ssr mode applies because the default environment is
    // `node` (vitest uses optimizer.ssr for node/edge, optimizer.client for
    // jsdom/happy-dom). `svelte/compiler` is included explicitly because it
    // was the single largest import bottleneck (4.3s — the compiler is a
    // large, scattered module graph that was NOT pre-bundled by default).
    // Adding it cut the slowest import 4.3s→0.9s (4.8×) and total import
    // self-time 199s→71s (2.8×), improving the warm wall 7.6s→6.8s (~10%).
    deps: {
      optimizer: {
        ssr: {
          enabled: true,
          include: ["zod", "nanostores", "svelte/compiler"],
        },
      },
    },
    // The budget reporter persists the wall-clock duration of each run so
    // the runtime-budget prevention test (web-ui-runtime-budget.test.ts) can
    // ratchet against it on the next run (one-run lag, mirroring the backend
    // test-result-collector pattern). "default" keeps the human-readable CLI
    // output alongside the machine-written summary.
    // A test may not run forever. This is the layer that DOES work against an
    // async hang (an unresolved promise, a pending timer) — and deliberately
    // NOT the layer relied on against a synchronous spin, which no in-runtime
    // timeout can interrupt. That one needs the wall-clock watchdog outside
    // the runtime (`scripts/run-tests.ts`).
    testTimeout: TEST_TIMEOUT_MS,
    hookTimeout: TEST_TIMEOUT_MS,
    reporters: ["default", "./tests/reporters/budget-reporter.ts"],
    // THE ONE DECLARATION, checked for per-glob liveness above before the
    // runner ever sees it. Spread rather than restated: a second list here
    // would be a second source of truth, and the checked one would not be
    // the one that ran.
    include: [...TEST_INCLUDE],
    projects: [
      { extends: true, test: {
        name: "node", include: [...TEST_INCLUDE], exclude: browserTests,
        pool: "forks", isolate: true, globalSetup: [],
      } },
      { extends: true, test: {
        name: "dom", include: browserTests, exclude: nodeTests,
        pool: contextPool, isolate: false, globalSetup: [],
      } },
    ],
    // A vitest invocation rooted OUTSIDE this suite's tree (the engine's
    // `test/`, reachable because vitest walks up to this config) matches
    // nothing once `root` is pinned (`vite.config.ts`). Exit clean there — the wrong-runner
    // dead-end is a signpost, not a red herring — while a real glob collapse
    // is still refused by the per-glob liveness check above.
    passWithNoTests: true,
  },
}));
