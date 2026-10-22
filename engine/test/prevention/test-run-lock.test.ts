// Prevention test for heavy-run admission (engine/scripts/tooling/test-run-lock.ts,
// src/process/instrument-lock.ts; NO-LOAD-BLOCK).
//
// It was ONE INSTRUMENT AT A TIME: a host-wide lock a second heavy run waited
// for, because suites judged in contention-inflated CPU time could not share
// the cores. Budgets judge CPU work now, so every heavy run is admitted AT
// ONCE under its per-run caps, and no run waits for another.
//
// Two families of arms:
//
//   FUNCTIONAL — drive the door in temporary registries: two runs admitted
//   side by side, a dead run's record cleared and never obeyed, a recycled
//   pid, an unreadable record, a parent's run borrowed, a re-entrant
//   admission, the exit hook, and SIGKILL recovery. Each plants its records
//   from outside the module, the way a real run produces them.
//
//   WIRING — deny-by-default over the real tree: every vite/vitest config,
//   every playwright config, and every engine suite entry discovered on disk
//   must reach the door. A runner added tomorrow outside the door — and so
//   outside the per-run caps — is a red here, not a remembered note. Source
//   questions go through `readSourceView`, because a module specifier is a
//   quoted string and a string-blanked view cannot see one.

import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { test } from "node:test";

import { enforceTestRunLock, TEST_RUN_LOCK_FILE_NAME, type TestRunLock } from "../../scripts/tooling/test-run-lock.ts";
import { FILE_LOCK_SCHEMA_VERSION, type FileLockContent } from "../../src/filesystem/file-lock.ts";
import { admittedRuns, borrowInstrumentLock } from "../../src/process/instrument-lock.ts";
import { ensurePrivateStateDirectory } from "../../src/filesystem/private-state.ts";
import { processIdentity } from "../../src/process/process-facts.ts";
import { readSourceView } from "../../scripts/verification/source-view.ts";
import { bodyCalls, functionBody } from "../../src/shared/source-structure.ts";
import { astNode, astNodeArray, parseSourceModule, walkAst } from "../../src/quality-packs/prevention/ast-helpers.ts";
import { createTempDir } from "../support/temp-dir.ts";

const ENGINE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SETUP_DIR = join(REPO_ROOT, "tests", "setup");
const MODULE_URL = pathToFileURL(join(ENGINE_ROOT, "scripts", "tooling", "test-run-lock.ts")).href;

function lockPathOf(dir: string): string {
  return join(dir, TEST_RUN_LOCK_FILE_NAME);
}

/** The run registry the door keeps beside the lock path: one record per admitted run. */
function registryOf(dir: string): string {
  return `${lockPathOf(dir)}.runs`;
}

/** The records in the registry (live or not). */
function recordsIn(dir: string): readonly string[] {
  return existsSync(registryOf(dir)) ? readdirSync(registryOf(dir)).filter((name) => name.endsWith(".lock")) : [];
}

/** A run record as the one file lock writes it, planted in the registry from outside. */
function writePlantedRun(dir: string, pid: number, runner: string, startTime: number = processIdentity(pid).startTime ?? 1): string {
  const content: FileLockContent = {
    schemaVersion: FILE_LOCK_SCHEMA_VERSION,
    holder: runner,
    pid,
    startTime,
    acquiredAt: new Date().toISOString(),
    nonce: `planted-${String(pid)}`,
    adopted: [],
  };
  ensurePrivateStateDirectory(registryOf(ensurePrivateStateDirectory(dir)));
  const path = join(registryOf(dir), `planted-${String(pid)}.lock`);
  writeFileSync(path, `${JSON.stringify(content)}\n`);
  return path;
}

function exitOf(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> {
  return new Promise((resolve) => {
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("exit", (code, signal) => resolve({ code, signal, stderr }));
  });
}

// ── FUNCTIONAL ─────────────────────────────────────────────────────────────

test("admitted: a second heavy runner through the door is admitted AT ONCE beside a live one — it never waits — and both are live in the registry, by name", () => {
  const dir = createTempDir("test-run-lock-admitted-");
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => undefined, 60000)"], { stdio: "ignore" });
  try {
    writePlantedRun(dir, holder.pid!, "a planted run");
    const second = enforceTestRunLock("the second runner", { lockDir: dir, testFileCount: Number.POSITIVE_INFINITY });
    assert.equal(second.owns, true, "admitted at once, beside the live run");
    const live = admittedRuns(lockPathOf(dir)).map((line) => line.split(" (pid")[0]).sort();
    assert.deepEqual(live, ["a planted run", "the second runner"]);
    second.release();
    assert.deepEqual(admittedRuns(lockPathOf(dir)).map((line) => line.split(" (pid")[0]), ["a planted run"], "release removes only its own record");
  } finally {
    holder.kill("SIGKILL");
  }
});

test("fresh checkout: the registry folder it creates is private, so the receipt chain beneath it stays admissible", () => {
  const dir = join(createTempDir("test-run-lock-fresh-"), "state-root");
  const previousUmask = process.umask(0o002);
  try {
    const lock = enforceTestRunLock("the first runner", { lockDir: dir, testFileCount: Number.POSITIVE_INFINITY });
    assert.equal(statSync(dir).mode & 0o7777, 0o700);
    lock.release();
  } finally {
    process.umask(previousUmask);
  }
});

test("stale: a dead run's record is never obeyed — it is not live, and it is cleared when met", () => {
  const dir = createTempDir("test-run-lock-stale-");
  const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  assert.ok(dead.pid !== undefined, "the planted dead run must have had a pid");
  const record = writePlantedRun(dir, dead.pid, "a dead run");
  assert.deepEqual(admittedRuns(lockPathOf(dir)), [], "a dead run is not live");
  assert.equal(existsSync(record), false, "and its record is cleared");
});

test("recycled: a LIVE pid with another start time is another process — its record is not a live run; a record with no start time is no identity (unreadable: kept until the bound, never pid 1's live run)", () => {
  const dir = createTempDir("test-run-lock-recycled-");
  writePlantedRun(dir, 1, "a process whose pid was recycled", (processIdentity(1).startTime ?? 0) + 12_345);
  assert.deepEqual(admittedRuns(lockPathOf(dir)), [], "a recycled pid's record is no live run");
  const bare = join(registryOf(dir), "bare.lock");
  writeFileSync(bare, `${JSON.stringify({ schemaVersion: FILE_LOCK_SCHEMA_VERSION, holder: "pid 1 by pid alone", pid: 1, acquiredAt: new Date().toISOString(), nonce: "bare", adopted: [] })}\n`);
  assert.deepEqual(admittedRuns(lockPathOf(dir)), [], "an unidentified record is never obeyed as pid 1's live run");
  assert.equal(existsSync(bare), true, "a fresh unidentified record is kept until the file lock's bound");
});

test("borrowed: a run admitted for this process's parent is borrowed, and the child never releases it", () => {
  const dir = createTempDir("test-run-lock-parent-");
  const record = writePlantedRun(dir, process.ppid, "the parent runner");
  const borrowed = borrowInstrumentLock(lockPathOf(dir), "the child runner");
  assert.equal(borrowed?.owns, false, "the child borrows; it does not own");
  borrowed?.release();
  assert.equal(existsSync(record), true, "a borrowed handle must not release the parent's record");
});

test("re-entrant: a second admission in the same process is borrowed, and only the owner releases", () => {
  const dir = createTempDir("test-run-lock-reentrant-");
  const first = enforceTestRunLock("the owning admission", { lockDir: dir, testFileCount: Number.POSITIVE_INFINITY });
  const second = enforceTestRunLock("the same process again", { lockDir: dir, testFileCount: Number.POSITIVE_INFINITY });
  assert.equal(first.owns, true);
  assert.equal(second.owns, false, "a same-process second admission borrows");
  second.release();
  assert.equal(recordsIn(dir).length, 1, "the borrowed handle must not release");
  first.release();
  assert.equal(recordsIn(dir).length, 0, "the owning handle releases");
});

test("exit hook: a run that exits normally removes its record", async () => {
  const dir = createTempDir("test-run-lock-exit-");
  const fixture = join(dir, "holder.ts");
  writeFileSync(fixture, [
    `import { enforceTestRunLock } from ${JSON.stringify(MODULE_URL)};`,
    `enforceTestRunLock("the fixture run", { lockDir: process.argv[2], testFileCount: Number.POSITIVE_INFINITY });`,
    `process.exit(0);`,
    "",
  ].join("\n"));
  const child = spawn(process.execPath, ["--experimental-strip-types", fixture, dir], { stdio: ["ignore", "ignore", "pipe"] });
  const outcome = await exitOf(child);
  assert.equal(outcome.code, 0, `the fixture run must be admitted cleanly: ${outcome.stderr}`);
  assert.equal(recordsIn(dir).length, 0, "a normal exit runs the exit hook, which releases");
});

test("recovery: a SIGKILLed run leaves its record, which is dead and cleared when next met", async () => {
  const dir = createTempDir("test-run-lock-sigkill-");
  const fixture = join(dir, "doomed-holder.ts");
  writeFileSync(fixture, [
    `import { enforceTestRunLock } from ${JSON.stringify(MODULE_URL)};`,
    `enforceTestRunLock("the doomed run", { lockDir: process.argv[2], testFileCount: Number.POSITIVE_INFINITY });`,
    `process.kill(process.pid, "SIGKILL");`,
    "",
  ].join("\n"));
  const child = spawn(process.execPath, ["--experimental-strip-types", fixture, dir], { stdio: ["ignore", "ignore", "pipe"] });
  const outcome = await exitOf(child);
  assert.equal(outcome.signal, "SIGKILL", `the fixture must die by its own SIGKILL: ${outcome.stderr}`);
  assert.equal(recordsIn(dir).length, 1, "a hard death cannot run the exit hook");
  assert.deepEqual(admittedRuns(lockPathOf(dir)), [], "the killed run is not live");
  assert.equal(recordsIn(dir).length, 0, "its record is cleared when met");
});

// ── WIRING ─────────────────────────────────────────────────────────────────

function sourceText(path: string): string {
  return readSourceView(path).codeWithStrings();
}

/** Whether `source` calls `callee` with an options object whose `option` is the literal `true` (read from the syntax tree, never by distance). */
function callsWithOption(path: string, source: string, callee: string, option: string): boolean {
  let found = false;
  walkAst(parseSourceModule(path, source, { errorRecovery: true }), (node) => {
    if (found || node.type !== "CallExpression") return;
    const called = astNode(node.callee);
    if (called?.type !== "Identifier" || called.name !== callee) return;
    found = astNodeArray(node.arguments).some((argument) => argument.type === "ObjectExpression" && astNodeArray(argument.properties).some((property) =>
      property.type === "ObjectProperty" && astNode(property.key)?.type === "Identifier" && astNode(property.key)?.name === option && astNode(property.value)?.type === "BooleanLiteral" && astNode(property.value)?.value === true));
  });
  return found;
}

test("THE VITEST DOOR PASSES THE COUNT VITEST ITSELF SELECTS, a listing too: one file is light, the suite (or `vitest list` of it) is heavy — driven through the door's own setup with a door of the test's own", async () => {
  const { setup, teardown } = await import("../../../tests/setup/concurrency-lock.ts");
  const asked: number[] = [];
  const door = async (_runner: string, options: Readonly<{ testFileCount: number }>): Promise<TestRunLock> => {
    asked.push(options.testFileCount);
    return { owns: false, runner: "test", path: "unused", stamp: "not-held", release: () => undefined } as unknown as TestRunLock;
  };
  // A project whose specification search answers what vitest would select for the filters it is handed.
  const project = (selects: (filter: readonly string[]) => readonly string[]) => ({ vitest: { globTestSpecifications: async (filter: readonly string[]) => selects(filter).map((moduleId) => ({ moduleId })) } }) as never;
  const suite = ["tests/unit/a.test.ts", "tests/unit/b.test.ts", "tests/unit/c.test.ts"];
  const argv = process.argv;
  try {
    for (const [args, expected] of [
      [["run", "tests/unit/a.test.ts"], 1],
      [["run"], suite.length],
      [["list"], suite.length],
    ] as const) {
      process.argv = [argv[0]!, "vitest", ...args];
      await setup(project((filter) => filter.length === 0 ? suite : suite.filter((file) => filter.some((part) => file.includes(part)))), door as never);
      teardown();
      assert.equal(asked.at(-1), expected, `vitest ${args.join(" ")} passes the ${String(expected)} file(s) vitest selects`);
    }
  } finally {
    process.argv = argv;
  }
});

function viteConfigNames(): string[] {
  return readdirSync(REPO_ROOT)
    .filter((name) => /^(?:vite|vitest)(?:\..*)?\.config\.ts$/u.test(name))
    .sort();
}

function playwrightConfigNames(): string[] {
  return readdirSync(REPO_ROOT)
    .filter((name) => /^playwright(?:\..*)?\.config\.ts$/u.test(name))
    .sort();
}

/** The reason `name` is not a locked vite config, or null when it is. */
function viteConfigLockFailure(name: string): string | null {
  const text = sourceText(join(REPO_ROOT, name));
  const match = /globalSetup:\s*\[([^\]]*)\]/u.exec(text);
  if (match === null) {
    return `${name}: no test.globalSetup array — every suite entry must take the one-instrument lock`;
  }
  const doors = [...(match[1] ?? "").matchAll(/"([^"]+)"/gu)].map((m) => m[1] ?? "");
  const holding = doors.filter((door) => {
    const resolved = join(REPO_ROOT, door);
    if (!existsSync(resolved)) return false;
    const doorText = sourceText(resolved);
    // The door is called by name, or through a parameter whose default IS the door (a test hands its own).
    const throughDefault = /door: typeof enforceTestRunLock = enforceTestRunLock/u.test(doorText) && /\bdoor\(\s*"[^"]+"/u.test(doorText);
    return doorText.includes("engine/scripts/tooling/test-run-lock.ts") && (/enforceTestRunLock\(\s*"[^"]+"/u.test(doorText) || throughDefault);
  });
  if (holding.length === 0) {
    return `${name}: globalSetup (${doors.join(", ") || "empty"}) has no door that takes the one-instrument lock`;
  }
  return null;
}

/** The reason `name` is not a locked playwright config, or null when it is. */
function playwrightConfigLockFailure(name: string): string | null {
  const text = sourceText(join(REPO_ROOT, name));
  const match = /globalSetup:\s*"(\.[^"]+)"/u.exec(text);
  if (match === null) {
    return `${name}: no globalSetup door — a browser instrument without the lock contends with every suite`;
  }
  const doorPath = join(REPO_ROOT, match[1] ?? "");
  if (!existsSync(doorPath)) {
    return `${name}: its global setup ${match[1] ?? ""} does not exist`;
  }
  const doorText = sourceText(doorPath);
  if (!doorText.includes("playwright-concurrency-lock.ts")) {
    return `${name}: its global setup does not route through the shared lock body (tests/setup/playwright-concurrency-lock.ts)`;
  }
  if (!/playwrightConcurrencyLock\(\s*"[^"]+"/u.test(doorText)) {
    return `${name}: its global setup names no runner — the refusal would have nothing to say`;
  }
  return null;
}

/**
 * The configs that can RUN the web suite: every `vitest*.config.ts`, and any
 * vite config that declares a `test` block. The build's own config
 * (`vite.config.ts`, shared with the product tree) declares none: the runner's
 * config extends it, and it is the one vitest resolves first.
 */
function runnerConfigNames(): string[] {
  return viteConfigNames().filter((name) => name.startsWith("vitest") || /\btest:\s*\{/u.test(sourceText(join(REPO_ROOT, name))));
}

test("wiring: every vite/vitest config that can run the suite passes the lock at its global setup", () => {
  const configs = runnerConfigNames();
  assert.ok(configs.length > 0, "discovered zero vitest configs — the discovery went blind, not the wiring");
  assert.ok(
    viteConfigNames().some((name) => !configs.includes(name)),
    "fixture assumption: the build config (vite.config.ts) declares no test block — it is not a runner config",
  );
  for (const name of configs) {
    const failure = viteConfigLockFailure(name);
    assert.ok(failure === null, failure ?? "");
  }
});

test("PC-5: the build config is never a runner — vitest given it refuses at load, before any file runs", async () => {
  const build = join(REPO_ROOT, "vite.config.ts");
  const loaded = await import(pathToFileURL(build).href) as { default: (env: { mode: string; command: string }) => unknown; BUILD_CONFIG: unknown };
  const before = process.env["VITEST"];
  process.env["VITEST"] = "true";
  try {
    assert.throws(() => loaded.default({ mode: "test", command: "serve" }), /not the web test runner's/u);
    assert.equal(loaded.default({ mode: "production", command: "build" }), loaded.BUILD_CONFIG, "a `vite build` a test spawns still loads the build");
  } finally {
    if (before === undefined) delete process.env["VITEST"];
    else process.env["VITEST"] = before;
  }
  // The live drive: vitest itself, handed the build config, refuses before collecting a file.
  const drive = spawnSync(join(REPO_ROOT, "node_modules", ".bin", "vitest"), ["list", "--config", "vite.config.ts"], { cwd: REPO_ROOT, encoding: "utf8", timeout: 120_000 });
  assert.notEqual(drive.status, 0, `vitest ran with the build config:\n${drive.stdout}`);
  assert.match(`${drive.stdout}${drive.stderr}`, /not the web test runner's/u);
});

test("wiring: every playwright config names a global setup door that takes the lock", () => {
  // The shared body is asserted once, here, because every door delegates to
  // it: if the import or the enforce call is removed from the shared body,
  // every door becomes a no-op while still looking wired — the inert shape.
  const shared = sourceText(join(SETUP_DIR, "playwright-concurrency-lock.ts"));
  assert.ok(
    shared.includes("engine/scripts/tooling/test-run-lock.ts") && /enforceTestRunLock\(\s*runner/u.test(shared),
    "the shared playwright body must import and call the lock — the doors delegate to it",
  );
  // The body's second refusal: a dev server older than the last HEAD change.
  // Playwright's `reuseExistingServer` inherits whatever is listening, and a
  // wedged long-lived server once answered 31 of 45 e2e specs with failures
  // that vanished on restart — a door that stopped calling the preflight
  // would look exactly like a healthy one while judging a ghost tree.
  assert.ok(
    shared.includes("dev-server-freshness.ts") && /assertFreshDevServers\s*\(/u.test(shared),
    "the shared playwright body must import and call the dev-server freshness preflight — " +
      "without it, `reuseExistingServer` silently judges a server from before the last HEAD change",
  );
  const configs = playwrightConfigNames();
  assert.ok(configs.length > 0, "discovered zero playwright configs — the discovery went blind, not the wiring");
  for (const name of configs) {
    const failure = playwrightConfigLockFailure(name);
    assert.ok(failure === null, failure ?? "");
  }
});

test("wiring: every engine suite entry takes the lock", () => {
  const pkg = JSON.parse(readFileSync(join(ENGINE_ROOT, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  const scripts = pkg.scripts ?? {};
  // Deny by default: a direct `node --test` script bypasses the wrapper and
  // with it the lock. Zero such scripts is the healthy state.
  for (const [name, command] of Object.entries(scripts)) {
    assert.ok(
      !/(?:^|\s)--test(?:\s|$)/u.test(command),
      `engine script "${name}" invokes node --test directly; route it through scripts/test-guards.ts so the one-instrument lock is taken`,
    );
  }
  assert.ok(
    scripts["test:guards"]?.includes("scripts/tooling/test-guards.ts"),
    "test:guards must run through scripts/test-guards.ts, the node --test door of the lock",
  );
  const wrapper = sourceText(join(ENGINE_ROOT, "scripts", "tooling", "test-guards.ts"));
  assert.ok(
    wrapper.includes("./test-run-lock.ts") && /enforceTestRunLock\(/u.test(wrapper),
    "the test-guards wrapper must take the lock in the supervisor process",
  );
  assert.ok(wrapper.includes('"--test"'), "the wrapper must delegate to node --test");
  assert.ok(
    scripts["test"]?.includes("scripts/tooling/run-tests.ts"),
    'the engine "test" script must route through scripts/run-tests.ts, whose lock is taken at the start of the run',
  );
  const runner = sourceText(join(ENGINE_ROOT, "scripts", "tooling", "run-tests.ts"));
  assert.ok(
    runner.includes("./test-run-lock.ts") && /enforceTestRunLock\(\s*"engine npm test"/u.test(runner),
    "the engine suite runner must take the lock at the start of the run — an import without the call is wired but inert",
  );
  const coverage = sourceText(join(ENGINE_ROOT, "scripts", "tooling", "coverage.ts"));
  assert.ok(
    /runInsideInstrumentLock\(\s*"engine coverage run"/u.test(coverage) && coverage.includes("INSIDE_INSTRUMENT_LOCK_VARIABLE"),
    "a coverage run is the suite plus instrumentation — it holds the same lock through the supervising door, never in its own process (L-N1)",
  );
  // Its inner path BORROWS the hold through the one door (refused outside a live hold): the marker never grants the lock (L-L1).
  assert.ok(callsWithOption(join(ENGINE_ROOT, "scripts", "tooling", "coverage.ts"), coverage, "enforceTestRunLock", "inProcess"), "the coverage run's inner path borrows the hold through the door");
});

test("wiring: every other heavy door takes the SAME one lock — the web runner, `harness slot run`, `ws validate` and `ws merge` (no second lock, no door of its own)", () => {
  const webRunner = sourceText(join(REPO_ROOT, "scripts", "run-tests.ts"));
  assert.ok(
    webRunner.includes("engine/scripts/tooling/test-run-lock.ts") && /enforceTestRunLock\(\s*"web npm test"/u.test(webRunner),
    "the web runner takes the one lock before it starts vitest (whose global setup then borrows it)",
  );
  const slot = sourceText(join(ENGINE_ROOT, "src", "workflow", "slot-cli.ts"));
  assert.ok(slot.includes("../process/instrument-lock.ts") && /holdInstrumentLock\(/u.test(slot), "`harness slot run` takes the one lock");
  assert.ok(/superviseCommand\(/u.test(slot) && !/\bspawn\(/u.test(slot), "`harness slot run` runs its command under the supervisor (adopted), never a bare spawn");
  const profile = sourceText(join(REPO_ROOT, "scripts", "testing", "perf-profile.ts"));
  assert.ok(/runInsideInstrumentLock\(\s*"perf profile"/u.test(profile) && /inProcess: true/u.test(profile) && bodyCalls(functionBody(profile, "runToExit"), "superviseCommand"),
    "the perf profile holds the lock through the supervising door and runs Playwright under the supervisor (L-N1)");
  // A bare heavy vitest run (outside every door) re-runs ITSELF inside the one supervising door, never holding the
  // lock in its own process.
  assert.ok(bodyCalls(functionBody(sourceText(join(SETUP_DIR, "concurrency-lock.ts")), "setup"), "runInsideInstrumentLock"), "the vitest door re-runs a bare heavy run inside the supervising door");
  for (const door of [join(SETUP_DIR, "concurrency-lock.ts"), join(SETUP_DIR, "playwright-concurrency-lock.ts")]) {
    const text = sourceText(door);
    const viaDefault = /door: typeof enforceTestRunLock = enforceTestRunLock/u.test(text) && callsWithOption(door, text, "door", "inProcess");
    assert.ok(callsWithOption(door, text, "enforceTestRunLock", "inProcess") || viaDefault, `${door}: a runner's own process never holds the lock (it only borrows a supervising door's hold)`);
  }
  const workspaceCli = sourceText(join(ENGINE_ROOT, "src", "workflow", "workspace-cli.ts"));
  assert.ok(/action === "validate"\) \{[^}]*?withInstrumentLock\(/u.test(workspaceCli), "`ws validate` runs inside the one lock");
  assert.ok(/action === "merge"\) \{[^}]*?withInstrumentLock\(/u.test(workspaceCli), "`ws merge` runs inside the one lock");
  assert.ok(workspaceCli.includes("../process/instrument-lock.ts") && /holdInstrumentLock\(/u.test(workspaceCli), "withInstrumentLock takes the one lock");
  assert.match(workspaceCli, /holdInstrumentLock\(\{[^}]*testFileCount: Number\.POSITIVE_INFINITY/u, "a validate or a merge is a whole instrument: heavy by kind, never light (correctness M7)");
  const guardsRunner = sourceText(join(ENGINE_ROOT, "scripts", "tooling", "test-guards.ts"));
  assert.ok(/superviseCommand\(/u.test(guardsRunner) && !/\bspawn\(/u.test(guardsRunner), "the subset runner runs node --test under the supervisor (adopted), never a bare spawn");
});

test("wiring: root scripts reach vitest and playwright only through locked configs", () => {
  const rootPkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  const scripts = rootPkg.scripts ?? {};
  const viteConfigs = new Set(viteConfigNames());
  // With no --config, vitest loads the first of its own config names that
  // exists (its CONFIG_NAMES order: `vitest.config` before `vite.config`).
  const resolvedByVitest = ["vitest.config.ts", "vite.config.ts"].find((name) => viteConfigs.has(name)) ?? "vitest.config.ts";
  const playwrightConfigs = new Set(playwrightConfigNames());
  let vitestScripts = 0;
  let playwrightScripts = 0;
  for (const [name, command] of Object.entries(scripts)) {
    if (/\bvitest\b/u.test(command)) {
      vitestScripts += 1;
      const configured = /--config[=\s]+(\S+)/u.exec(command)?.[1] ?? resolvedByVitest;
      assert.ok(
        viteConfigs.has(configured) && viteConfigLockFailure(configured) === null,
        `root script "${name}" runs vitest against ${configured}, which does not take the one-instrument lock`,
      );
    }
    if (/playwright\s+test/u.test(command)) {
      playwrightScripts += 1;
      const configured = /--config[=\s]+(\S+)/u.exec(command)?.[1] ?? "playwright.config.ts";
      assert.ok(
        playwrightConfigs.has(configured) && playwrightConfigLockFailure(configured) === null,
        `root script "${name}" runs playwright against ${configured}, which does not take the one-instrument lock`,
      );
    }
  }
  assert.ok(vitestScripts > 0, "no root script runs vitest — the discovery went blind, not the wiring");
  assert.ok(playwrightScripts > 0, "no root script runs playwright — the discovery went blind, not the wiring");
});

test("ONE DEFINITION OF HEAVY (design L-2): a run of fewer than the configured test files takes nothing, whatever its door; a heavy run whose runner would hold the lock IN ITS OWN PROCESS only borrows a supervising door's hold, and is refused by name outside one (correctness L-N1)", async () => {
  const dir = createTempDir("test-run-lock-heavy-");
  const light = enforceTestRunLock("a one-file run", { lockDir: dir, testFileCount: 1 });
  assert.equal(light.owns, false);
  assert.equal(recordsIn(dir).length, 0, "a light run records nothing");
  const lightInProcess = enforceTestRunLock("a one-file vitest run", { lockDir: dir, testFileCount: 1, inProcess: true });
  assert.equal(lightInProcess.owns, false, "a light in-process run needs no hold");
  assert.throws(() => enforceTestRunLock("a whole vitest run", { lockDir: dir, testFileCount: Number.POSITIVE_INFINITY, inProcess: true }),
    (error: unknown) => (error as { code?: string }).code === "instrument_lock_unsupervised" && /npm test/u.test((error as Error).message));
  assert.equal(recordsIn(dir).length, 0, "the refused run recorded nothing");
  // Inside a hold a supervising door took (here: this process), the in-process runner borrows it.
  const door = enforceTestRunLock("the supervising door", { lockDir: dir, testFileCount: Number.POSITIVE_INFINITY });
  const borrowed = enforceTestRunLock("a whole vitest run", { lockDir: dir, testFileCount: Number.POSITIVE_INFINITY, inProcess: true });
  assert.equal(borrowed.owns, false);
  assert.equal(borrowed.stamp, "held");
  door.release();
  // Every entry passes the count of the files it runs (the type requires it; the vitest door counts vitest's own selection).
  const vitestDoor = sourceText(join(SETUP_DIR, "concurrency-lock.ts"));
  assert.match(vitestDoor, /globTestSpecifications\(filter\)/u, "the vitest door counts the files vitest itself selects");
});
