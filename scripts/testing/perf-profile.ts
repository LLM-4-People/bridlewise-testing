/**
 * THE ONE PERF PROFILE STEP: `npm run perf:profile`.
 *
 * The web suite's regression gate (`tests/performance/regression.test.ts`)
 * judges the profile report (`tests/performance/.report.json`); this step is
 * what produces it, and the workspace gate that runs the web suite REQUIRES it
 * (`workspaceIsolation.commands["web-suite"].requires`): a gate never judges
 * an artifact no step produced. In order, inside the host's one instrument
 * lock (taken here, through the test runners' one door, so the profile's
 * workers stamp the report "held"):
 *
 *   1. any earlier report is removed — a report present afterwards is this
 *      run's own;
 *   2. a fresh cockpit fixture is prepared (`prepareCockpitFixture`) in an
 *      owned scratch folder under the user's cache home — its key home must
 *      lie outside every checkout and the system temp folder, as a test
 *      run's does — removed when the step ends and swept if it was killed;
 *      its admin password a random one made here
 *      and handed on only through the environment (never printed, never
 *      written to a record);
 *   3. an isolated stack serves it: the real API server (a child, bound to
 *      port 0 and read back from its readiness line) on the fixture's
 *      database, key home and a scratch timeline, and the client through
 *      vite IN THIS PROCESS, in middleware mode behind an HTTP server bound
 *      to port 0 — vite reads a port of 0 as "its default" (5173, strict:
 *      the developer's own dev server), so it never chooses the port here;
 *      never the checkout's stores, never the developer's running servers;
 *   4. the profile spec runs (`playwright.perf.config.ts`,
 *      `tests/performance/profile.spec.ts`) against that stack;
 *   5. the stack is stopped (each process group, waited for), the scratch
 *      folder removed, and the step exits with the profile's code — a
 *      profile that passed but wrote no report is a failure.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { fileURLToPath } from "node:url";

import { enforceTestRunLock, wholeInstrumentRun } from "../../engine/scripts/tooling/test-run-lock.ts";
import { ensureTestProcessSupervisor } from "../../engine/guardian/build.ts";
import { superviseCommand } from "../../engine/src/process/supervised-run.ts";
import { readTestExecutionConfig } from "../../engine/src/workflow/test-result-collector.ts";
import { INSIDE_INSTRUMENT_LOCK_VARIABLE, runInsideInstrumentLock } from "../../engine/src/workflow/slot-cli.ts";
import { ownedChild, terminate, type OwnedProcess } from "../../engine/src/process/process-facts.ts";
import { createOwnedTemporaryDirectory, ensurePrivateStateDirectory, removeOwnedTemporaryDirectory } from "../../engine/src/filesystem/private-state.ts";
import { userCacheFolder } from "../../engine/src/filesystem/user-folders.ts";
import { PRODUCT_NAME } from "../../engine/src/kernel/product-identity.ts";
import { bootstrapProcess, isEntryPoint } from "../../engine/src/runtime/cli-debug.ts";
import { REPORT_PATH } from "../../tests/performance/lib/perf-harness.ts";
import { prepareCockpitFixture } from "../../tests/performance/scale/prepare-fixture.ts";
import { readPortFromReadiness } from "../../tests/performance/scale/stack.ts";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..", "..");
/** How long a stopped process group has after SIGTERM before SIGKILL. */
const STOP_GRACE_MS = 5_000;

/** Start `command` leading its own process group, its output on this process's stderr under `label`. */
function startGroup(label: string, command: string, args: readonly string[], env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(command, args, { cwd: REPOSITORY_ROOT, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  child.stdout?.on("data", (chunk: Buffer) => process.stderr.write(`[${label}] ${chunk.toString()}`));
  child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[${label}!] ${chunk.toString()}`));
  return child;
}

/** Stop a group this step started, through the one terminator: SIGTERM to the group, SIGKILL after the grace, until it is gone. */
async function stopGroup(owned: OwnedProcess): Promise<void> {
  await terminate({ group: owned }, { graceMs: STOP_GRACE_MS });
}

/**
 * The client, served by vite in this process: middleware mode behind an HTTP
 * server the kernel gives a port (vite's own listener maps a port of 0 to its
 * configured 5173). `vite.config.ts` builds its `/api` proxy from
 * HARNESS_WEB_PORT, so the API's port is set before the config is read.
 */
async function serveClient(apiPort: number): Promise<Readonly<{ port: number; close: () => Promise<void> }>> {
  process.env["HARNESS_WEB_PORT"] = String(apiPort);
  const { createServer } = await import("vite");
  const http = createHttpServer();
  const vite = await createServer({ root: REPOSITORY_ROOT, appType: "spa", server: { middlewareMode: true, ws: { server: http } } });
  http.on("request", vite.middlewares);
  await new Promise<void>((resolveListen, rejectListen) => {
    http.once("error", rejectListen);
    http.listen(0, "127.0.0.1", () => resolveListen());
  });
  const close = async (): Promise<void> => {
    await vite.close();
    await new Promise<void>((resolveClose) => http.close(() => resolveClose()));
  };
  return { port: (http.address() as AddressInfo).port, close };
}

/** Run `command` to completion under the native supervisor (adopted into the hold), with this process's output streams; its exit code (anything but an exit is a failure). */
async function runToExit(command: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  const { engineSuiteWatchdog } = readTestExecutionConfig(join(REPOSITORY_ROOT, "engine"));
  const run = await superviseCommand({
    supervisor: ensureTestProcessSupervisor(), command, args, cwd: REPOSITORY_ROOT, env,
    hardCeilingMs: engineSuiteWatchdog.hardCeilingMs, killGraceMs: engineSuiteWatchdog.killGraceMs,
    onStdout: (chunk) => process.stdout.write(chunk), onStderr: (chunk) => process.stderr.write(chunk), killOnInterrupt: true,
  });
  return run.ending === "exited" ? run.exitCode : 1;
}

/** The step (see the header); resolves to the exit code. */
export async function runPerfProfile(): Promise<number> {
  // Inside the hold the supervising door took (see the entry point): borrowed, never taken in this process.
  const lock = enforceTestRunLock("perf profile", { testFileCount: wholeInstrumentRun("profile"), inProcess: true });
  const scratch = createOwnedTemporaryDirectory(ensurePrivateStateDirectory(join(userCacheFolder(), PRODUCT_NAME, "perf-profile")), "run-");
  const started: OwnedProcess[] = [];
  let client: Awaited<ReturnType<typeof serveClient>> | undefined;
  let code = 1;
  try {
    rmSync(REPORT_PATH, { force: true });
    // The fixture's admin, the server and the profile's login read the one variable.
    process.env["HARNESS_WEB_AUTH_PASSWORD"] = randomBytes(24).toString("base64url");
    const env: NodeJS.ProcessEnv = { ...process.env };
    const fixture = await prepareCockpitFixture(join(scratch, "fixture"));
    const api = startGroup("api", process.execPath, ["--experimental-strip-types", join(REPOSITORY_ROOT, "server", "index.ts")], {
      ...env,
      HARNESS_WEB_PORT: "0",
      HARNESS_WEB_HOST: "127.0.0.1",
      HARNESS_WEB_DB_PATH: fixture.dbPath,
      HARNESS_KEY_HOME: fixture.keyHome,
      // Beside the fixture's database: a database folder is disjoint from the key home.
      HARNESS_WEB_TIMELINE_DB_PATH: join(dirname(fixture.dbPath), "timeline.db"),
      // The browser reaches the API only through vite's proxy (a server-to-server hop).
      HARNESS_WEB_ALLOWED_ORIGIN: "http://127.0.0.1",
    });
    // Owned at spawn (KILL-OWNED-ONLY): the stop below signals exactly this group.
    started.push(ownedChild(api));
    const apiPort = await readPortFromReadiness(api, "api", /server on http:\/\/[\d.]+:(\d+)/u);
    client = await serveClient(apiPort);
    const webPort = client.port;
    // The profile spec alone: it is what writes the report (the config's other spec is the cockpit benchmark).
    code = await runToExit("npx", ["playwright", "test", "--config=playwright.perf.config.ts", "tests/performance/profile.spec.ts"], {
      ...env,
      HARNESS_PERF_FIXTURE_PATH: fixture.manifestPath,
      HARNESS_PERF_BASE_URL: `http://127.0.0.1:${String(webPort)}`,
      HARNESS_WEB_PORT: String(apiPort),
    });
    if (code === 0 && !existsSync(REPORT_PATH)) {
      process.stderr.write(`perf profile: the profile passed but wrote no report at ${REPORT_PATH}\n`);
      code = 1;
    }
    return code;
  } finally {
    await client?.close();
    await Promise.all(started.map(stopGroup));
    removeOwnedTemporaryDirectory(scratch);
    lock.release();
  }
}

if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  // THE PROFILE IS A WHOLE INSTRUMENT, held through the supervising door: this
  // process re-runs itself under the native supervisor inside the hold, so a
  // door killed outright never frees the lock under the browsers and servers
  // it started (correctness L-N1).
  const door = async (): Promise<number> => {
    if (process.env[INSIDE_INSTRUMENT_LOCK_VARIABLE] === "1") return runPerfProfile();
    let code = 1;
    code = (await runInsideInstrumentLock("perf profile", wholeInstrumentRun("profile"),
      [process.execPath, ...process.execArgv, fileURLToPath(import.meta.url)])).exitCode;
    return code;
  };
  door().then(
    (code) => { process.exitCode = code; },
    (error: unknown) => {
      process.stderr.write(`perf profile failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
