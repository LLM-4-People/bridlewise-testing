// @vitest-environment node
/**
 * Mechanical enforcement: the test-isolation contract.
 *
 * ── THE DECISION THIS PINS, AND WHY IT REVERSED ────────────────────────────
 *
 * The suite previously ran with bare `isolate: false` (a module registry
 * shared across test files in a worker) for the speed: per-file module-graph re-evaluation
 * collapsed to per-worker. It was measurably faster and it was quietly
 * BREAKING `vi.mock`.
 *
 * With a shared registry, a file that mocks a module which an EARLIER file
 * already imported for real gets the real one: the cached importer never
 * re-runs its imports, and `mockPath()` invalidates the `mock:` node, not the
 * real module's importers. The symptom is a test that passes alone and fails
 * in the suite — measured here on `composer-commit-seam`,
 * `flow-stream-channels` and `model-provenance-owner`, all green in isolation
 * and red in a full run. That is not flakiness; it is a mock that never
 * applied, and a test asserting against real code it believed it had
 * replaced.
 *
 * `vi.resetModules()` is NOT the fix and is unusable here: it clears the
 * whole evaluated-module registry, so the setup file keeps pre-reset
 * instances of `schema-store`, `asof` and `temp-dir` while every test file
 * gets post-reset ones — resurrecting leaks that were already fixed.
 *
 * Node files retain fresh OS processes. Explicit DOM files now receive a
 * fresh VM context per file in a reusable OS process. The guard below drives
 * actual PID/context lifecycles, mocks, changed inputs and cancellation;
 * a pool name or an isolation flag alone cannot prove these guarantees.
 *
 * ── THE SETUP FILE'S GUARANTEES SURVIVE THE REVERSAL ───────────────────────
 *
 * They are still pinned below, and deliberately. `isolate: true` gives each
 * FILE a fresh registry; it does not restore `process.env`, and a config
 * singleton frozen at first import is wrong under either setting. These are
 * the guarantees:
 *
 *   1. CONFIG-LAZY: `serverConfig` is a `let` (not `const`) so the live
 *      binding can be re-resolved via `resetServerConfig()` per test file.
 *      A `const` singleton would freeze at the first import + a test that
 *      sets `HARNESS_WEB_PORT` via `vi.hoisted` would see a stale value.
 *
 *   2. ENV-RESTORE SETUP: the vitest setup file snapshots `process.env` once
 *      per worker + restores it in `afterAll` of every file, so env
 *      mutations do not leak across files. Without this, a file that sets
 *      `HARNESS_CONFIG_PATH` would leak to the next file's config reset.
 *
 * This test pins both guarantees so a regression (reverting `let` to `const`,
 * removing the setup file, or flipping `isolate: true`) is caught
 * mechanically. Dynamic discovery (no hardcoded file lists): the config +
 * setup paths are derived from the project root, not a static array.
 */
import { beforeAll, describe, test, expect } from "vitest";
import type { PoolOptions, WorkerRequest, WorkerResponse } from "vitest/node";
import { contextPool } from "../helpers/vm-context-pool.ts";
import { runBoundedTestProcess } from "../../engine/src/process/supervised-run.ts";
import { isProcessAlive } from "../../engine/src/process/process-facts.ts";
import { testProcessSupervisorBinary } from "../../engine/guardian/build.ts";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { getCompileCacheDir } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createTempDir } from "../helpers/temp-dir.ts";
import { webSuiteKillGraceMs } from "../helpers/budget-config.ts";
import { NESTED_RUNNER_LAUNCH_MS, NESTED_RUNNER_TEST_MARGIN_MS, TEST_TIMEOUT_MS } from "../test-budget.ts";
import { resetServerConfig, serverConfig } from "../../server/kernel/config.ts";
import { read } from "../helpers/source-scan.ts";
import { ISOLATION_SCENARIOS, isolationWitness, type IsolationRun, type IsolationWitness } from "../helpers/vm-isolation-witness.ts";
import { COMPILE_CACHE_DIRECTORY } from "../../engine/scripts/tooling/compile-cache.ts";

import { modulePath, modulePathMatching } from "../helpers/module-resolver.ts";
import { requireLinuxHost } from "../../engine/test/support/host-requirement.ts";
const CONFIG_REL = modulePathMatching("server/kernel/config.ts");
const SESSION_REL = modulePath("session.ts");
const RUNNER_CONFIG_REL = "vitest.config.ts";
const SETUP_REL = "tests/setup/test-setup.ts";

describe("isolation contract — config-lazy singleton (the config reset guarantee)", () => {
  test("serverConfig is declared `let` (NOT `const`) so the live binding can be re-resolved", () => {
    const src = read(CONFIG_REL);
    // `export let serverConfig` — the live binding lets resetServerConfig
    // reassign it so every `import { serverConfig }` consumer sees the new
    // value. A `const` would freeze the reference at the first import.
    expect(src, "server/config.ts must declare `export let serverConfig` (the config-lazy invariant for isolate:false)").toMatch(/export\s+let\s+serverConfig\b/);
    expect(src, "server/config.ts must NOT declare serverConfig as const (const freezes the singleton at import)").not.toMatch(/export\s+const\s+serverConfig\b/);
  });

  test("resetServerConfig is exported + re-resolves the singleton from env", () => {
    const src = read(CONFIG_REL);
    expect(src, "server/config.ts must export resetServerConfig (the per-file reset function)").toMatch(/export\s+function\s+resetServerConfig\s*\(/);
    // The reset must reassign the singleton (not just return a fresh value).
    expect(src, "resetServerConfig must reassign the `serverConfig` binding so the live binding propagates").toMatch(/serverConfig\s*=\s*resolveServerConfig\(/);
  });

  test("resetServerConfig behaviorally re-resolves the config from a custom env", () => {
    // `serverConfig` is a static `import` (a live binding to the `let` export),
    // so it reflects the reassignment after `resetServerConfig` runs. A
    // destructuring `const { serverConfig } = await import(...)` would NOT
    // (it copies the value once) — this is why the 28 consumers use static
    // `import { serverConfig }`, not dynamic destructuring.
    const before = serverConfig.rateLimitPerMinute;
    // Re-resolve with a custom env that overrides the rate limit.
    const resolved = resetServerConfig({ HARNESS_WEB_RATE_LIMIT: "9999" } as NodeJS.ProcessEnv);
    expect(resolved.rateLimitPerMinute).toBe(9999);
    // The live binding propagated: the static-imported `serverConfig` reflects
    // the new value (not the stale pre-reset value). This is the exact
    // contract the 28 consumers rely on under `isolate: false`.
    expect(serverConfig.rateLimitPerMinute, "the static `import { serverConfig }` live binding must reflect the reset (let, not const)").toBe(9999);
    // Restore so this test does not leak the override to subsequent tests.
    resetServerConfig();
    expect(serverConfig.rateLimitPerMinute).toBe(before);
  });

  test("session.ts reads sessionRotationHours at CALL time (not module-load capture)", () => {
    // A module-level `const SESSION_ROTATION_MS = serverConfig.sessionRotationHours`
    // would freeze the value at import + survive a resetServerConfig call
    // (the same bug class as the const serverConfig). The call-time read
    // (a function) reflects the live config.
    const src = read(SESSION_REL);
    expect(src, "session.ts must NOT capture SESSION_ROTATION_MS at module load (would freeze + survive reset)").not.toMatch(/^(const|let|var)\s+SESSION_ROTATION_MS\s*=/m);
    // The rotation period must be read at call time so resetServerConfig is
    // reflected (the call-time function reads serverConfig.sessionRotationHours).
    expect(src, "session.ts must read sessionRotationHours at call time (a function, not a module-level const)").toMatch(/function\s+sessionRotationMs\s*\(/);
  });
});

describe("isolation contract — the env-restore setup file (the env isolation guarantee)", () => {
  test("worker HTTP defaults and inherited children cannot address the canonical listener", () => {
    expect(process.env.HARNESS_WEB_PORT, "worker setup replaces inherited HTTP configuration before tests run").toBe("0");
    expect(resetServerConfig().port, "the live config uses the isolated worker port").toBe(0);
    const program = `import {serverConfig} from ${JSON.stringify(pathToFileURL(resolve(CONFIG_REL)).href)};
console.log(JSON.stringify({inherited:process.env.HARNESS_WEB_PORT,resolved:serverConfig.port}));`;
    const child = runBoundedTestProcess(testProcessSupervisorBinary(), process.execPath, ["--input-type=module", "--eval", program], { timeoutMs: TEST_TIMEOUT_MS, killGraceMs: webSuiteKillGraceMs() });
    expect(child.error, "the real child must resolve supported configuration without HTTP").toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ inherited: "0", resolved: 0 });
    expect(child.supervision.noOwnedChildren).toBe(true);
  });

  test("the setup file exists at the wired path", () => {
    expect(existsSync(SETUP_REL), `the isolate:false setup file must exist at ${SETUP_REL}`).toBe(true);
  });

  test("the setup file snapshots process.env once + restores it in afterAll", () => {
    const src = read(SETUP_REL);
    // Snapshot once per worker (at setup-module load).
    expect(src, "the setup file must snapshot process.env once per worker (INITIAL_ENV)").toMatch(/INITIAL_ENV[\s\S]*=\s*\{\s*\.\.\.process\.env\s*\}/);
    // Restore in afterAll: delete keys not in the snapshot, reset snapshot keys.
    expect(src, "the setup file must restore process.env in afterAll (delete new keys + reset snapshot keys)").toMatch(/afterAll\s*\(/);
    expect(src, "the setup file must delete env keys added by the test file").toMatch(/delete\s+process\.env\[/);
    expect(src, "the setup file must reset env keys from the snapshot").toMatch(/process\.env\[key\]\s*=\s*value/);
  });

  test("the setup file calls resetServerConfig in beforeAll + afterAll", () => {
    const src = read(SETUP_REL);
    // beforeAll: re-resolve after the test file's vi.hoisted/top-level env mutation.
    expect(src, "the setup file must call resetServerConfig in beforeAll (so the singleton matches the file's env)").toMatch(/beforeAll\s*\(/);
    expect(src, "the setup file must import resetServerConfig from the config owner").toMatch(/import\s+\{[^}]*resetServerConfig[^}]*\}\s*from\s*["']\.\.\/\.\.\/server\/kernel\/config\.ts["']/);
  });
});

describe("isolation contract — the vitest config wires isolation, the pool, and the timeout", () => {
  let cacheAvailable: boolean;
  function cacheAvailableForWorker(env: NodeJS.ProcessEnv): boolean {
    // Vitest applies test.env before starting the worker. That effective
    // input, including a worker-only opt-out, governs native startup.
    if (env.NODE_DISABLE_COMPILE_CACHE === "1") return false;
    // Independent oracle: use the configured path, never the helper's
    // success/failure or the worker's observed state to decide availability.
    // An absent enable call must still red on a writable filesystem. A
    // missing cache is creatable iff its nearest existing ancestor permits
    // creation. The temp owner registers cleanup even if an assertion fails.
    try {
      let ancestor = resolve(env.NODE_COMPILE_CACHE ?? COMPILE_CACHE_DIRECTORY);
      while (statSync(ancestor, { throwIfNoEntry: false }) === undefined) ancestor = dirname(ancestor);
      createTempDir("native-cache-availability-", { besidePath: join(ancestor, "probe") });
      return true;
    } catch (error) {
      expect(error, "unavailability needs a real filesystem failure witness")
        .toMatchObject({ code: expect.any(String), syscall: expect.stringMatching(/^(stat|mkdtemp)$/) });
      return false;
    }
  }

  beforeAll(() => {
    cacheAvailable = cacheAvailableForWorker(process.env);
  });

  test("effective worker opt-out overrides an available compilation cache", () => {
    const directory = createTempDir("native-cache-worker-input-");
    const env = { ...process.env, NODE_COMPILE_CACHE: directory, NODE_DISABLE_COMPILE_CACHE: "0" };
    expect(cacheAvailableForWorker(env), "the configured directory must independently permit caching").toBe(true);
    expect(cacheAvailableForWorker({ ...env, NODE_DISABLE_COMPILE_CACHE: "1" }),
      "the effective worker opt-out must disable caching even when the launcher permits it").toBe(false);
  });

  function assertWorkerCache(): void {
    if (cacheAvailable) {
      expect(getCompileCacheDir(), "Node must reuse compilation in the actual test fork")
        .toEqual(expect.any(String));
      expect(process.env.NODE_COMPILE_CACHE, "descendants must inherit the same cache owner")
        .toEqual(expect.any(String));
    } else {
      expect(getCompileCacheDir(), "disabled or unavailable caching must leave native state absent")
        .toBeUndefined();
    }
  }

  test("the actual isolated worker inherits the native compilation cache", () => {
    // Work, not a source-text proxy: Node itself must have enabled the
    // cache before this worker's imports. An unused enable call or a call
    // in only the watchdog cannot satisfy the ordinary `vitest run` door.
    assertWorkerCache();
  });

  test.each(["mjs", "cjs"])("native %s cache reuses compilation with fresh state and source invalidation", (extension) => {
    assertWorkerCache();
    const dir = createTempDir("native-compilation-isolation-");
    const target = join(dir, `subject.${extension}`);
    const url = pathToFileURL(target).href;
    const program = (value: string): string =>
      `const state = { evaluations: 0 }; state.evaluations += 1;\n` +
      `console.log(JSON.stringify({ value: '${value}', evaluations: state.evaluations }));\n`;
    // Every child is a new process using only the actual worker's inherited
    // env. No local enable call can hide a broken config-to-fork chain.
    const run = (disabled = false) => {
      const env = { ...process.env, NODE_DEBUG_NATIVE: "COMPILE_CACHE" };
      if (disabled) Object.assign(env, { NODE_DISABLE_COMPILE_CACHE: "1" });
      const child = spawnSync(process.execPath, [target], {
        env, encoding: "utf8", timeout: TEST_TIMEOUT_MS, killSignal: "SIGKILL",
      });
      expect(child.error, "native cache probe must complete without a launch/timeout error").toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
      return { value: JSON.parse(child.stdout) as { value: string; evaluations: number }, trace: child.stderr };
    };
    const accepted = (trace: string): boolean => trace.split("\n").some((line) =>
      line.includes("V8 code cache for ") &&
      line.includes(extension === "mjs" ? url : target) && line.includes(" was accepted,"));
    writeFileSync(target, program("first"));
    const initial = run();
    expect(initial.value).toEqual({ value: "first", evaluations: 1 });
    expect(accepted(initial.trace), "new source has no prior compiled entry").toBe(false);
    const reused = run();
    expect(reused.value, "compiled code must execute again in a fresh process")
      .toEqual({ value: "first", evaluations: 1 });
    expect(accepted(reused.trace), "native reuse must agree with independently witnessed availability").toBe(cacheAvailable);
    const disabled = run(true);
    expect(disabled.value).toEqual(reused.value);
    expect(accepted(disabled.trace), "the disabled control must not claim a cache hit").toBe(false);
    // Same path and length: invalidation must bind source bytes, rather
    // than only a path, size, or previously computed answer.
    writeFileSync(target, program("later"));
    const changed = run();
    expect(changed.value).toEqual({ value: "later", evaluations: 1 });
    expect(accepted(changed.trace), "changed source must reject the old compiled entry").toBe(false);
    const refreshed = run();
    expect(refreshed.value).toEqual(changed.value);
    expect(accepted(refreshed.trace), "refreshed reuse must agree with independently witnessed availability").toBe(cacheAvailable);
  });

  test("native initialization creates missing directories and leaves opt-out and filesystem failures nonfatal", () => {
    const root = createTempDir("native-cache-initialization-");
    const blocked = join(root, "file-parent");
    writeFileSync(blocked, "a file cannot contain the cache");
    const owner = pathToFileURL(resolve(modulePath("compile-cache.ts"))).href;
    const program = `import { enableSharedCompileCache, compileCacheDirInUse } from ${JSON.stringify(owner)};\n` +
      `enableSharedCompileCache(); enableSharedCompileCache();\n` +
      `console.log(JSON.stringify({ cache: compileCacheDirInUse(), inherited: process.env.NODE_COMPILE_CACHE ?? null, evaluated: true }));`;
    const inherited = join(root, "already-enabled");
    // A HOST REQUIREMENT (LIVE-SUITE): the procfs cases below are Linux's, and every case runs on every run — never
    // fewer cases on another host (design LOW 9).
    requireLinuxHost();
    mkdirSync(join(root, "bridlewise"));
    symlinkSync("/proc", join(root, "bridlewise", "v8-compile-cache"), "dir");
    const cases: { cacheHome: string; disabled: boolean; available: boolean; inherited?: string }[] = [
      { cacheHome: join(root, "missing", "nested"), disabled: false, available: true },
      { cacheHome: join(root, "disabled"), disabled: true, available: false },
      // Linux procfs returns ENOENT for creation even though /proc exists.
      // The leaf child imports no process-spawning code; spawnSync's KILL
      // deadline and wait reap it even if native initialization stops yielding.
      { cacheHome: "/proc", disabled: false, available: false },
      // The configured cache root already exists but redirects creation
      // of Node's version child to a filesystem that returns ENOENT.
      { cacheHome: root, disabled: false, available: false },
      { cacheHome: blocked, disabled: false, available: false },
      // The caller's already-enabled directory wins even if the unused
      // XDG fallback cannot be created. No preparation may run in this arm.
      { cacheHome: blocked, disabled: false, available: true, inherited },
    ];
    for (const scenario of cases) {
      // Explicit fixture env: this control starts with no pre-enabled cache,
      // independently of the operator's settings used by the actual worker.
      const env: NodeJS.ProcessEnv = { ...process.env, XDG_CACHE_HOME: scenario.cacheHome };
      delete env.NODE_COMPILE_CACHE;
      delete env.NODE_DISABLE_COMPILE_CACHE;
      if (scenario.inherited !== undefined) env.NODE_COMPILE_CACHE = scenario.inherited;
      if (scenario.disabled) Object.assign(env, { NODE_DISABLE_COMPILE_CACHE: "1" });
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", program], {
        env, encoding: "utf8", timeout: TEST_TIMEOUT_MS, killSignal: "SIGKILL",
      });
      expect(child.error, `initialization must return for ${scenario.cacheHome}`).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
      const value = JSON.parse(child.stdout) as { cache: string | null; inherited: string | null; evaluated: boolean };
      expect(value.evaluated).toBe(true);
      if (scenario.available) {
        expect(value.cache).toEqual(expect.any(String));
        expect(value.inherited).toBe(scenario.inherited ?? join(scenario.cacheHome, "bridlewise", "v8-compile-cache"));
        expect(child.stderr).toBe("");
      } else {
        expect(value.cache).toBeNull();
        expect(value.inherited).toBeNull();
        if (scenario.disabled) expect(existsSync(scenario.cacheHome)).toBe(false);
        else expect(child.stderr).toMatch(/\[debug\] diagnostic unavailable/);
      }
    }
  });

  // ONE REAL RUNNER LAUNCH PER TEST. The witness writes its fixture once, in
  // `beforeAll` — outside any test, so the temp-dir owner keeps the folder
  // until the FILE ends (a folder made inside the first test is removed when
  // that test finishes). The runs share that fixture and run in this file's
  // order; each pays one launch against the per-test budget, never five.
  let witness: IsolationWitness | undefined;
  beforeAll(() => {
    witness = isolationWitness();
  });
  const isolation = (): IsolationWitness => witness!;

  /**
   * A completed run: each DOM file got a fresh VM context on the expected
   * number of worker processes, and both populations are externally
   * killable OS children of the supervising runner (Node files each in their
   * own process, never a DOM one).
   */
  function expectIsolatedRun(run: IsolationRun, domProcesses: number): void {
    expect(run.cancelled).toBe(false);
    const files = run.events.filter((event) => event.kind === "file");
    const dom = files.filter((event) => /dom-\d\.test\.ts$/.test(event.file ?? ""));
    const node = files.filter((event) => /node-\d\.test\.ts$/.test(event.file ?? ""));
    expect(dom).toHaveLength(4);
    const pids = new Set(dom.map((event) => event.pid));
    expect(pids.size, "normal batches reuse their available slots; the forced memory limit must retire the process after each file")
      .toBe(domProcesses);
    const created = run.events.filter((event) => event.kind === "context" && pids.has(event.pid));
    expect(created, "a fresh runner object without a fresh VM context cannot satisfy isolation").toHaveLength(dom.length);
    expect(node).toHaveLength(2);
    expect(new Set(node.map((event) => event.pid)).size).toBe(node.length);
    for (const event of files) {
      expect(event.pid).not.toBe(run.runnerPid);
      expect(event.ppid, "the externally supervising runner must own the OS child").toBe(run.runnerPid);
      expect(event.thread, "a thread inside the runner process is not a separate OS process").toBe(0);
    }
    for (const event of node) expect(dom.map((entry) => entry.pid)).not.toContain(event.pid);
  }

  test("the effective project globs select every required file once, each in its declared environment's process", () => {
    isolation().discover();
  });

  // Each holds ONE nested runner launch: its own budget, above the launch's bound (tests/test-budget.ts).
  const LAUNCH_TEST_TIMEOUT_MS = NESTED_RUNNER_LAUNCH_MS + NESTED_RUNNER_TEST_MARGIN_MS;

  test("first bytes, two slots: each DOM file gets fresh globals, modules, mocks, env and current source", () => {
    expectIsolatedRun(isolation().launch(ISOLATION_SCENARIOS.firstBytes), ISOLATION_SCENARIOS.firstBytes.expectedDomProcesses);
  }, LAUNCH_TEST_TIMEOUT_MS);

  test("a same-path, same-length, same-mtime rewrite on one slot: every file still reads the current source", () => {
    const run = isolation().launch(ISOLATION_SCENARIOS.rewrittenBytes);
    expect(run.rewrittenFiles, "both fixture files held other bytes and were rewritten in place — whatever ran before").toBe(2);
    expectIsolatedRun(run, ISOLATION_SCENARIOS.rewrittenBytes.expectedDomProcesses);
  }, LAUNCH_TEST_TIMEOUT_MS);

  test("a forced memory limit retires the worker process after each DOM file", () => {
    expectIsolatedRun(isolation().launch(ISOLATION_SCENARIOS.memoryLimit), ISOLATION_SCENARIOS.memoryLimit.expectedDomProcesses);
  }, LAUNCH_TEST_TIMEOUT_MS);

  test("a keyboard cancel discards the remaining one-slot batch before another file executes", () => {
    const run = isolation().launch(ISOLATION_SCENARIOS.cancelled);
    expect(run.cancelled).toBe(true);
    expect(run.events.filter((event) => event.kind === "file"),
      "cancellation must discard the remaining one-slot batch before another file executes").toHaveLength(1);
    expect(run.events.filter((event) => event.kind === "context"),
      "cancelled files must not even receive another VM context").toHaveLength(1);
  }, LAUNCH_TEST_TIMEOUT_MS);

  test("vitest.config.ts sets a per-test timeout from the single budget owner", () => {
    const src = read(RUNNER_CONFIG_REL);
    // Covers the ASYNC hang. Deliberately NOT the layer relied on for a
    // synchronous spin — see tests/test-budget.ts.
    expect(src).toMatch(/testTimeout:\s*TEST_TIMEOUT_MS/);
    expect(src).toMatch(/hookTimeout:\s*TEST_TIMEOUT_MS/);
    expect(src, "the budget must come from the one owner, not a re-typed literal").toMatch(
      /from\s+["']\.\/tests\/test-budget\.ts["']/,
    );
  });

  test("vitest.config.ts wires the setup file", () => {
    const src = read(RUNNER_CONFIG_REL);
    expect(src, "vitest.config.ts must wire the setup file that provides the config reset + env restore").toMatch(/setupFiles:\s*\[[^\]]*test-setup[^\]]*\]/);
  });

  test("vitest.config.ts enables the persistent module cache (fsModuleCache) for rerun speed", () => {
    const src = read(RUNNER_CONFIG_REL);
    expect(src, "vitest.config.ts must enable experimental.fsModuleCache for fast reruns").toMatch(/fsModuleCache:\s*true/);
  });

  test("vitest.config.ts defaults to the node environment (jsdom is opt-in)", () => {
    const src = read(RUNNER_CONFIG_REL);
    // The default must be node (fast — no DOM setup). Files that render
    // Svelte opt in via `// @vitest-environment jsdom`.
    expect(src, "vitest.config.ts must default to environment: node (jsdom is opt-in, not the default)").toMatch(/environment:\s*["']node["']/);
  });

  test("vitest.config.ts wires the budget reporter (the runtime-budget enforcement data source)", () => {
    const src = read(RUNNER_CONFIG_REL);
    // The budget reporter persists the wall-clock duration so the
    // runtime-budget prevention test can ratchet against it. Removing the
    // reporter silently disables the budget enforcement — this pin makes
    // that impossible (deny-by-default: the reporter is required).
    expect(src, "vitest.config.ts must wire the budget reporter (./tests/reporters/budget-reporter.ts) so the runtime-budget test has data").toMatch(/budget-reporter/);
  });

  test("vitest.config.ts enables the ssr dependency optimizer + pre-bundles svelte/compiler (the largest import bottleneck)", () => {
    const src = read(RUNNER_CONFIG_REL);
    // Pre-bundling external dependencies cuts the per-worker import cost.
    // Disabling it silently regresses the import time — this pin catches it.
    expect(src, "vitest.config.ts must enable deps.optimizer.ssr for faster imports").toMatch(/optimizer:\s*\{\s*ssr/);
    // svelte/compiler was the single largest import (4.3s) because it was NOT
    // pre-bundled by default. Removing it from the include list silently
    // regresses the import back to 4.3s — this pin catches the removal.
    expect(src, "vitest.config.ts must include svelte/compiler in the ssr optimizer (the 4.3s import bottleneck)").toMatch(/include:\s*\[[^\]]*["']svelte\/compiler["']/);
  });
});


describe("isolation contract — bounded context adapter work", () => {
  function controlledWorker(vmMemoryLimit: string | number = "2MiB") {
    const options = { project: { vitest: { config: {
      watch: false, maxWorkers: 1, vmMemoryLimit, teardownTimeout: 1,
    } } } } as unknown as PoolOptions;
    return contextPool.createPoolWorker(options) as ReturnType<typeof contextPool.createPoolWorker> & {
      worker: { send(message: WorkerRequest): void };
      message(message: WorkerResponse): void;
      lifecycle(type: "started" | "stopped", message: WorkerRequest): Promise<void>;
      memoryLimit: number;
    };
  }

  test.each(["run", "collect"] as const)("a %s execution error ends its batch and forwards the original terminal response", (type) => {
    const worker = controlledWorker();
    const sent: WorkerRequest[] = [];
    const received: WorkerResponse[] = [];
    worker.worker = { send(message) { sent.push(message); } };
    worker.on("message", message => received.push(message));
    const readIndices: number[] = [];
    const files = Array.from({ length: 3 }, (_, index) => ({ filepath: String(index) }));
    for (let index = 0; index < files.length; index++) {
      Object.defineProperty(files, index, { get() { readIndices.push(index); return { filepath: String(index) }; } });
    }
    const request = { __vitest_worker_request__: true, type, context: { files } } as unknown as WorkerRequest;
    worker.send(request);
    const finished = { __vitest_worker_response__: true, type: "testfileFinished", usedMemory: 1 } as WorkerResponse;
    worker.message(finished);
    expect(sent).toHaveLength(2);
    expect(received).toEqual([]);
    const failure = { ...finished, error: { name: "Error", message: `${type} failed before its terminal report` } } as WorkerResponse;
    worker.message(failure);
    expect(sent, "an execution failure may not dispatch a later file in its batch").toHaveLength(2);
    expect(readIndices, "an execution failure may not read an undispatched file").toEqual([0, 1]);
    expect(received, "the original terminal failure must reach the parent").toEqual([failure]);
    expect(received[0]).toBe(failure);

    worker.send({ ...request, context: { files: [{ filepath: "next request" }] } } as unknown as WorkerRequest);
    worker.message(finished);
    expect(sent).toHaveLength(3);
    expect(sent[2]).toMatchObject({ type, context: { files: [{ filepath: "next request" }] } });
    expect(received).toEqual([failure, finished]);
  });

  test("a cancelled batch never reads or constructs undispatched file requests", () => {
    const worker = controlledWorker();
    const sent: WorkerRequest[] = [];
    worker.worker = { send(message) { sent.push(message); } };
    const readIndices: number[] = [];
    const files = Array.from({ length: 64 }, (_, index) => ({ filepath: String(index) }));
    for (let index = 0; index < files.length; index++) {
      Object.defineProperty(files, index, { get() { readIndices.push(index); return { filepath: String(index) }; } });
    }
    const request = { __vitest_worker_request__: true, type: "run", context: { files } } as unknown as WorkerRequest;
    worker.send(request);
    expect(readIndices, "only the dispatched file may be read from the batch").toEqual([0]);
    expect(sent[0]).toMatchObject({ context: { files: [{ filepath: "0" }] } });
    worker.send({ m: "onCancel" } as unknown as WorkerRequest);
    const finished = { __vitest_worker_response__: true, type: "testfileFinished", usedMemory: 1 } as WorkerResponse;
    worker.message(finished);
    expect(readIndices).toEqual([0]);
    expect(sent).toHaveLength(2);

    sent.length = 0;
    worker.send({ ...request, type: "collect", context: { files: files.slice(0, 3) } } as unknown as WorkerRequest);
    worker.message(finished);
    worker.message(finished);
    worker.message(finished);
    expect(sent.map(message => (message as { context: { files: { filepath: string }[] } }).context.files))
      .toEqual([[{ filepath: "0" }], [{ filepath: "1" }], [{ filepath: "2" }]]);
  });

  test("memory conversion and lifecycle failures keep the typed tooling hierarchy", async () => {
    for (const [input, expected] of [["2k", 2000], ["2KiB", 2048], ["3MB", 3_000_000], ["2MiB", 2_097_152],
      ["1g", 1_000_000_000], ["1GiB", 1_073_741_824], ["2048", 2048], [2048.9, 2048]] as const) {
      expect(controlledWorker(input).memoryLimit).toBe(expected);
    }
    for (const input of [-1, "0", "1x", "1-", "1.", "nonsense", Infinity]) {
      let error: unknown;
      try { controlledWorker(input); } catch (caught) { error = caught; }
      expect(error).toMatchObject({ name: "InputError", code: "context_worker_memory_invalid" });
    }
    const worker = controlledWorker();
    worker.worker = { send() {} };
    await expect(worker.lifecycle("started", { __vitest_worker_request__: true, type: "stop" }))
      .rejects.toMatchObject({ name: "HarnessError", code: "context_worker_lifecycle_timeout" });
  });

  test("a malformed long memory value is refused inside the real hard process bound", () => {
    const directory = createTempDir("context-memory-bound-");
    const script = join(directory, "memory.mjs");
    writeFileSync(script, `import {contextPool} from ${JSON.stringify(pathToFileURL(resolve("tests/helpers/vm-context-pool.ts")).href)};
let error;try{contextPool.createPoolWorker({project:{vitest:{config:{watch:false,maxWorkers:1,vmMemoryLimit:'1'.repeat(1_000_000)+'-'}}}});}catch(caught){error=caught;}
console.log(JSON.stringify({name:error?.name,code:error?.code}));`);
    const child = runBoundedTestProcess(testProcessSupervisorBinary(), process.execPath, [script], { timeoutMs: TEST_TIMEOUT_MS, killGraceMs: webSuiteKillGraceMs() });
    expect(child.error, "repeated prefix retries must not consume the execution bound").toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ name: "InputError", code: "context_worker_memory_invalid" });
    expect(child.supervision.noOwnedChildren).toBe(true);
  });

  test("native descriptor exhaustion after launch fails only after its owned descendants are reaped", () => {
    const directory = createTempDir("native-supervisor-descriptor-bound-");
    const native = realpathSync("engine/guardian/build/test-process-supervisor");
    // The outer owner is a safety boundary and independent witness: it must
    // adopt nothing when the failing inner primitive cleans up correctly.
    // Positional shell arguments preserve arbitrary paths without interpolation.
    const descendantPath = join(directory, "descendant-pid");
    const child = runBoundedTestProcess(testProcessSupervisorBinary(), "sh", ["-c",
      'exec 3>"$1"; exec "$2" 1000 100 sh -c \'sleep 60 & echo $! > "$1"; prlimit --pid "$PPID" --nofile=4:4\' resource-child "$3"',
      "supervisor-resource-control", join(directory, "failed-receipt.json"), native, descendantPath], { timeoutMs: TEST_TIMEOUT_MS, killGraceMs: webSuiteKillGraceMs() });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(1);
    expect(child.stderr).toContain("test supervisor owned children: Too many open files");
    const commandPid = child.stderr.match(/test supervisor: owned command pid (\d+)/)?.[1];
    expect(commandPid, "the refusal must occur after an actual successful fork").toBeDefined();
    expect(child.supervision.reaped, "post-fork errors must not leave cleanup to the outer owner").toEqual([]);
    expect(child.supervision.killed).toEqual([]);
    expect(child.supervision.noOwnedChildren).toBe(true);
    expect(isProcessAlive(Number(commandPid)), "the failed supervisor's real command is gone").toBe(false);
    const descendantPid = readFileSync(descendantPath, "utf8").trim();
    expect(descendantPid).toMatch(/^\d+$/);
    expect(isProcessAlive(Number(descendantPid)), "the live descendant must also be reaped").toBe(false);
  });

  test("hard cancellation uses the native owner and reaps a TERM-handling launcher and escaped spun child", () => {
    const directory = createTempDir("context-hard-cancel-");
    const launcher = join(directory, "launcher.mjs");
    const spinner = join(directory, "spinner.mjs");
    const events = join(directory, "events.jsonl");
    writeFileSync(spinner, `import {appendFileSync,readFileSync} from 'node:fs';
appendFileSync(${JSON.stringify(events)},JSON.stringify({kind:'spinner',pid:process.pid,stat:readFileSync('/proc/self/stat','utf8')})+'\\n');
process.on('SIGTERM',()=>{});for(;;){}`);
    writeFileSync(launcher, `import {spawn} from 'node:child_process';import {appendFileSync,readFileSync,readlinkSync,openSync,readSync,closeSync} from 'node:fs';import assert from 'node:assert/strict';
const supervisor='/proc/'+process.ppid;
const descriptor=openSync(supervisor+'/exe','r'),magic=Buffer.alloc(4);try{assert.equal(readSync(descriptor,magic,0,4,0),4,'Complete executable header');}finally{closeSync(descriptor);}
appendFileSync(${JSON.stringify(events)},JSON.stringify({kind:'supervisor',pid:process.ppid,exe:readlinkSync(supervisor+'/exe'),stat:readFileSync(supervisor+'/stat','utf8'),magic:[...magic]})+'\\n');
spawn(process.execPath,[${JSON.stringify(spinner)}],{stdio:'inherit',detached:true});
process.on('SIGTERM',()=>appendFileSync(${JSON.stringify(events)},JSON.stringify({kind:'term-handled',pid:process.pid})+'\\n'));
setInterval(()=>{},1000);`);
    const child = runBoundedTestProcess(testProcessSupervisorBinary(), process.execPath, [launcher], { timeoutMs: 1000, killGraceMs: 100 });
    const all = readFileSync(events, "utf8").trim().split("\n").map(line => JSON.parse(line) as { kind: string; pid: number; exe?: string; stat?: string; magic?: number[] });
    const owners = all.filter(event => event.kind === "supervisor");
    expect(owners, "the real command must observe exactly one supervising executable").toHaveLength(1);
    const owner = owners[0]!;
    expect(owner.exe, "actual supervision cannot execute an embedded interpreter behind a TS wrapper")
      .toBe(realpathSync("engine/guardian/build/test-process-supervisor"));
    expect(owner.magic, "the executed lifetime primitive must be a native ELF").toEqual([127, 69, 76, 70]);
    expect(Number(owner.stat!.slice(owner.stat!.lastIndexOf(")") + 1).trim().split(/\s+/)[1]),
      "no intervening interpreter or wrapper may supervise the native owner").toBe(process.pid);
    const observed = all.filter(event => event.kind !== "supervisor");
    expect(observed.map(event => event.kind).sort()).toEqual(["spinner", "term-handled"]);
    const spinnerEvent = observed.find(event => event.kind === "spinner")!;
    expect(Number(spinnerEvent.stat!.slice(spinnerEvent.stat!.lastIndexOf(")") + 1).trim().split(/\s+/)[3]),
      "the synchronous spinner must actually escape the launcher's session").toBe(spinnerEvent.pid);
    expect(child.error).toMatchObject({ name: "HarnessError", code: "test_process_boundary_exceeded" });
    expect(child.signal).toBe("SIGKILL");
    expect(child.supervision.timedOut).toBe(true);
    expect(child.supervision.killed.slice().sort((a, b) => a - b))
      .toEqual(observed.map(event => event.pid).sort((a, b) => a - b));
    expect(child.supervision.reaped.map(event => event.pid))
      .toEqual(observed.filter(event => event.kind === "spinner").map(event => event.pid));
    expect(child.supervision.noOwnedChildren).toBe(true);
    expect(child.supervision.waitedCpuUs, "reaped command and descendant CPU reaches the receipt").toBeGreaterThan(0);
    expect(child.supervision.supervisorCpuUsBeforeReceipt).toBeGreaterThan(0);
    for (const event of observed) expect(isProcessAlive(event.pid), "the owned PID must actually be gone").toBe(false);
  });
});
