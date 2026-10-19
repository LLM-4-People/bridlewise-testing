// Prevention test for the one-instrument lock (engine/scripts/tooling/test-run-lock.ts).
//
// The sequential rule — suites and profiles never run concurrently — lived in
// prose, and prose did not refuse anything. Measured while it was prose: the
// web suite run together with the engine suite went red at 35.81 s against a
// 35 s cap and passed alone immediately after; the engine suite's worker setup
// rejects candidates while the web suite runs. A red caused by your own
// parallelism is indistinguishable from a regression until you re-run alone.
//
// Two families of arms:
//
//   FUNCTIONAL — drive the lock mechanism itself in temporary directories:
//   held, stale, borrowed (parent-held and re-entrant), unreadable, the exit
//   hook, and the SIGKILL recovery. Each plants its lock state from outside
//   the module, the way a real contender produces it.
//
//   WIRING — deny-by-default over the real tree: every vite/vitest config,
//   every playwright config, and every engine suite entry discovered on disk
//   must take the lock at its door. A runner added tomorrow without the lock
//   is a red here, not a remembered note. Source questions go through
//   `readSourceView`, because a module specifier is a quoted string and a
//   string-blanked view cannot see one.

import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { test } from "node:test";

import { enforceTestRunLock, TEST_RUN_LOCK_FILE_NAME, type TestRunLock } from "../../scripts/tooling/test-run-lock.ts";
import { FILE_LOCK_SCHEMA_VERSION, tryAcquireFileLock, type FileLockContent } from "../../src/filesystem/file-lock.ts";
import { borrowInstrumentLock } from "../../src/process/instrument-lock.ts";
import { ensurePrivateStateDirectory } from "../../src/filesystem/private-state.ts";
import { processIdentity } from "../../src/process/process-facts.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
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

/**
 * ONE LOOK at a test's own lock, as the door's wait looks each time (it never
 * waits): borrowed when this process runs inside the hold, else the one file
 * lock's attempt — taken, held (by whom), unreadable.
 */
function look(runner: string, dir: string): Readonly<{ state: "borrowed" | "taken" | "held" | "unreadable" | "contended"; holder?: string | undefined; release: () => void }> {
  const path = lockPathOf(ensurePrivateStateDirectory(dir));
  const borrowed = borrowInstrumentLock(path, runner);
  if (borrowed !== undefined) return { state: "borrowed", release: borrowed.release };
  const attempt = tryAcquireFileLock(path, { holder: runner });
  if (attempt.state === "taken") return { state: "taken", release: attempt.handle.release };
  if (attempt.state === "held") return { state: "held", holder: attempt.holder.holder ?? undefined, release: () => undefined };
  return { state: attempt.state, release: () => undefined };
}

/** A lock record as the one file lock writes it (the instrument lock is that lock). */
function writePlantedLock(dir: string, pid: number, runner: string, startTime: number = processIdentity(pid).startTime ?? 1): void {
  const content: FileLockContent = {
    schemaVersion: FILE_LOCK_SCHEMA_VERSION,
    holder: runner,
    pid,
    startTime,
    acquiredAt: new Date().toISOString(),
    nonce: `planted-${String(pid)}`,
    adopted: [],
  };
  writeFileSync(lockPathOf(dir), `${JSON.stringify(content)}\n`);
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

test("held: a live holder holds the lock against a second runner, by name; the door WAITS for it (never runs beside it)", async () => {
  const dir = createTempDir("test-run-lock-held-");
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => undefined, 30000)"], { stdio: "ignore" });
  const holderPid = holder.pid;
  assert.ok(holderPid !== undefined, "the planted holder must have a pid");
  try {
    writePlantedLock(dir, holderPid, "a planted holder");
    const second = look("the second runner", dir);
    assert.equal(second.state, "held");
    assert.equal(second.holder, "a planted holder", "the holder is named");
    const waiting = enforceTestRunLock("the second runner", { lockDir: dir, testFileCount: Number.POSITIVE_INFINITY });
    const outcome = await Promise.race([waiting.then(() => "taken"), new Promise((resolveLater) => setTimeout(() => resolveLater("waiting"), 400))]);
    assert.equal(outcome, "waiting", "the door waits while the holder lives");
    holder.kill("SIGKILL");
    const taken = await waiting;
    assert.equal(taken.owns, true, "and takes the lock once the holder is gone");
    taken.release();
  } finally {
    holder.kill("SIGKILL");
  }
});

test("fresh checkout: the lock directory it creates is private, so the receipt chain beneath it stays admissible", async () => {
  const dir = join(createTempDir("test-run-lock-fresh-"), "state-root");
  const previousUmask = process.umask(0o002);
  try {
    const lock = await enforceTestRunLock("the first runner", { lockDir: dir, testFileCount: Number.POSITIVE_INFINITY });
    assert.equal(statSync(dir).mode & 0o7777, 0o700);
    lock.release();
  } finally {
    process.umask(previousUmask);
  }
});

test("stale: a dead holder's lock is broken, not obeyed, and the breaker then owns it", () => {
  const dir = createTempDir("test-run-lock-stale-");
  const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  assert.ok(dead.pid !== undefined, "the planted dead holder must have had a pid");
  writePlantedLock(dir, dead.pid, "a dead holder");
  const acquisition = look("the surviving runner", dir);
  assert.equal(acquisition.state, "taken", "a dead holder's lock is broken");
  const content = JSON.parse(readFileSync(lockPathOf(dir), "utf8")) as FileLockContent;
  assert.equal(content.holder, "the surviving runner", "the broken lock is re-created in the new holder's name");
  acquisition.release();
  assert.equal(existsSync(lockPathOf(dir)), false, "release removes the lock");
});

test("recycled: a LIVE pid with another start time is another process — its lock is stale; a record with no start time is no identity (unreadable: honoured only until the bound, never as pid 1's)", () => {
  // The one identity rule (src/process/process-facts.ts): pid alone cannot
  // tell a holder from a later process that got its pid.
  const dir = createTempDir("test-run-lock-recycled-");
  writePlantedLock(dir, 1, "a process whose pid was recycled", (processIdentity(1).startTime ?? 0) + 12_345);
  const acquisition = look("the runner after the recycled pid", dir);
  assert.equal(acquisition.state, "taken", "a recycled pid's lock is broken");
  acquisition.release();
  writeFileSync(lockPathOf(dir), `${JSON.stringify({ schemaVersion: FILE_LOCK_SCHEMA_VERSION, holder: "pid 1 by pid alone", pid: 1, acquiredAt: new Date().toISOString(), nonce: "bare", adopted: [] })}\n`);
  assert.equal(look("a second runner", dir).state, "unreadable", "a fresh unreadable lock is honoured until the bound, never obeyed as pid 1's live hold");
});

test("borrowed: a lock held by this process's parent is not refused, and the child never releases it", () => {
  const dir = createTempDir("test-run-lock-parent-");
  writePlantedLock(dir, process.ppid, "the parent runner");
  const acquisition = look("the child runner", dir);
  assert.equal(acquisition.state, "borrowed", "the child borrows; it does not own");
  acquisition.release();
  assert.equal(existsSync(lockPathOf(dir)), true, "a borrowed handle must not release the parent's lock");
});

test("re-entrant: a second acquisition in the same process is borrowed, and only the owner releases", async () => {
  const dir = createTempDir("test-run-lock-reentrant-");
  const first = await enforceTestRunLock("the owning acquisition", { lockDir: dir, testFileCount: Number.POSITIVE_INFINITY });
  const second = await enforceTestRunLock("the same process again", { lockDir: dir, testFileCount: Number.POSITIVE_INFINITY });
  assert.equal(first.owns, true);
  assert.equal(second.owns, false, "a same-process second acquisition borrows");
  second.release();
  assert.equal(existsSync(lockPathOf(dir)), true, "the borrowed handle must not release");
  first.release();
  assert.equal(existsSync(lockPathOf(dir)), false, "the owning handle releases");
});

test("unreadable: a lock no instrument wrote is honoured (refused, kept) until it is as old as the file lock's bound, then broken — the one policy of every lock", () => {
  const dir = createTempDir("test-run-lock-unreadable-");
  writeFileSync(lockPathOf(dir), "this was not written by an instrument\n");
  assert.equal(look("any runner", dir).state, "unreadable", "a fresh unreadable lock is honoured, not taken");
  assert.equal(existsSync(lockPathOf(dir)), true, "a fresh unidentified lock is not deleted");
  // As old as the bound: broken like any other lock's (wf-del2-design D1).
  const old = (Date.now() - ROOT_POLICY.filesystemInfrastructure.fileLock.staleMs - 60_000) / 1000;
  utimesSync(lockPathOf(dir), old, old);
  const aged = look("the runner after the bound", dir);
  assert.equal(aged.state, "taken", "an unreadable lock older than the bound is broken");
  aged.release();
});

test("exit hook: a holder that exits normally frees the path for the next runner", async () => {
  const dir = createTempDir("test-run-lock-exit-");
  const fixture = join(dir, "holder.ts");
  writeFileSync(fixture, [
    `import { enforceTestRunLock } from ${JSON.stringify(MODULE_URL)};`,
    `await enforceTestRunLock("the fixture holder", { lockDir: process.argv[2], testFileCount: Number.POSITIVE_INFINITY });`,
    `process.exit(0);`,
    "",
  ].join("\n"));
  const child = spawn(process.execPath, ["--experimental-strip-types", fixture, dir], { stdio: ["ignore", "ignore", "pipe"] });
  const outcome = await exitOf(child);
  assert.equal(outcome.code, 0, `the fixture holder must acquire cleanly: ${outcome.stderr}`);
  assert.equal(existsSync(lockPathOf(dir)), false, "a normal exit runs the exit hook, which releases");
  const next = look("the next runner", dir);
  assert.equal(next.state, "taken", "after a clean exit the path is free");
  next.release();
});

test("recovery: a SIGKILLed holder leaves a stale lock, and the next runner breaks it", async () => {
  const dir = createTempDir("test-run-lock-sigkill-");
  const fixture = join(dir, "doomed-holder.ts");
  writeFileSync(fixture, [
    `import { enforceTestRunLock } from ${JSON.stringify(MODULE_URL)};`,
    `await enforceTestRunLock("the doomed holder", { lockDir: process.argv[2], testFileCount: Number.POSITIVE_INFINITY });`,
    `process.kill(process.pid, "SIGKILL");`,
    "",
  ].join("\n"));
  const child = spawn(process.execPath, ["--experimental-strip-types", fixture, dir], { stdio: ["ignore", "ignore", "pipe"] });
  const outcome = await exitOf(child);
  assert.equal(outcome.signal, "SIGKILL", `the fixture must die by its own SIGKILL: ${outcome.stderr}`);
  assert.equal(existsSync(lockPathOf(dir)), true, "a hard death cannot run the exit hook");
  const next = look("the recovering runner", dir);
  assert.equal(next.state, "taken", "a stale lock after SIGKILL is broken by liveness");
  const content = JSON.parse(readFileSync(lockPathOf(dir), "utf8")) as FileLockContent;
  assert.equal(content.holder, "the recovering runner");
  next.release();
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
  const light = await enforceTestRunLock("a one-file run", { lockDir: dir, testFileCount: 1 });
  assert.equal(light.owns, false);
  assert.equal(existsSync(lockPathOf(dir)), false, "a light run takes no lock");
  const lightInProcess = await enforceTestRunLock("a one-file vitest run", { lockDir: dir, testFileCount: 1, inProcess: true });
  assert.equal(lightInProcess.owns, false, "a light in-process run needs no hold");
  await assert.rejects(enforceTestRunLock("a whole vitest run", { lockDir: dir, testFileCount: Number.POSITIVE_INFINITY, inProcess: true }),
    (error: unknown) => (error as { code?: string }).code === "instrument_lock_unsupervised" && /npm test/u.test((error as Error).message));
  assert.equal(existsSync(lockPathOf(dir)), false, "the refused run took nothing");
  // Inside a hold a supervising door took (here: this process), the in-process runner borrows it.
  const door = await enforceTestRunLock("the supervising door", { lockDir: dir, testFileCount: Number.POSITIVE_INFINITY });
  const borrowed = await enforceTestRunLock("a whole vitest run", { lockDir: dir, testFileCount: Number.POSITIVE_INFINITY, inProcess: true });
  assert.equal(borrowed.owns, false);
  assert.equal(borrowed.stamp, "held");
  door.release();
  // Every entry passes the count of the files it runs (the type requires it; the vitest door counts vitest's own selection).
  const vitestDoor = sourceText(join(SETUP_DIR, "concurrency-lock.ts"));
  assert.match(vitestDoor, /globTestSpecifications\(filter\)/u, "the vitest door counts the files vitest itself selects");
});
