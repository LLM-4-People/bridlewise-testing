/**
 * AN ISOLATED APP STACK POINTED AT A SCALE FIXTURE.
 *
 * The question this answers is the one the whole scale sweep depends on:
 * can a real browser be pointed at the 347k-message corpus WITHOUT editing
 * a single line of product code? It can, and the seam is already there —
 * this module only uses it:
 *
 *   • `server/config.ts` reads `HARNESS_WEB_PORT`, `HARNESS_WEB_DB_PATH`,
 *     `HARNESS_KEY_HOME` and `HARNESS_WEB_ALLOWED_ORIGIN` from the
 *     environment. So a second API server can serve a fixture copy on its
 *     own port, beside the dev server, sharing nothing.
 *   • `vite.config.ts` builds its `/api` proxy target from the SAME
 *     `HARNESS_WEB_PORT`. So a second Vite, launched with that variable
 *     set and `--port` on the command line, proxies to the fixture API.
 *
 * Both processes take port 0 and read the assigned port back: the API child
 * binds 0 (`HARNESS_WEB_PORT: "0"`) and announces its port on its readiness
 * line (`server on http://…:PORT`); Vite binds 0 (`--port 0`) and prints its
 * `Local: http://…:PORT/` line. No port is chosen and probed first — a
 * chosen-then-bound number is a time-of-check/time-of-use race a concurrent
 * process can claim in the window, and a fixed default is the same race run
 * on every invocation. The kernel assigns a free port atomically inside the
 * bind, so there is no window.
 *
 * The client itself needs no configuration at all: `client-config.ts`
 * hardcodes `DEFAULT_API_BASE = "/api"`, a same-origin relative path. The
 * frontend never chooses an API origin — the origin it was served from IS
 * the API origin. That is what makes the repointing possible without a
 * product-code edit, and it is worth stating plainly, because the obvious
 * alternative design (a baked-in absolute API URL) would have made this
 * measurement impossible.
 *
 * Every process started here is tracked and killed BY PID on `stop()`,
 * including on SIGINT — an orphaned 2GB-fixture server would poison every
 * later measurement on this box.
 *
 * Usage (CLI, for interactive/browser-driven measurement):
 *   node --experimental-strip-types tests/performance/scale/stack.ts heavy
 *   # prints the URL to point a browser at; Ctrl-C tears it down.
 *
 * @test-only — never imported by the runtime bundle.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  prepareFixture,
  DEFAULT_SCRATCH_ROOT,
  scratchRootParentOrRefuse,
  type PreparedFixture,
} from "./prepare-fixture.ts";

/** Scratch root for fixture copies — one owner (prepare-fixture.ts), so the
 * launcher and the preparer can never disagree about where a 2GB copy goes. */
export const SCRATCH_ROOT = DEFAULT_SCRATCH_ROOT;

export type StackPorts = Readonly<{ api: number; web: number }>;

export type RunningStack = Readonly<{
  fixture: PreparedFixture;
  ports: StackPorts;
  /** The URL to point a browser at — the cockpit, on the fixture. */
  url: string;
  apiPid: number;
  webPid: number;
  stop: () => Promise<void>;
}>;

const REPO_ROOT = process.cwd();

/**
 * Waits until `url` answers, or REFUSES the moment the process meant to serve
 * it has exited: the readiness of a server is bounded by the server's own
 * life, never by a wall clock (NO-LOAD-BLOCK) — a busy host makes a booting
 * server slow, not dead.
 */
function waitForHttp(url: string, server: ChildProcess, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      fetch(url).then(
        () => resolve(),
        () => {
          if (server.exitCode !== null || server.signalCode !== null) {
            reject(new Error(`${name} exited (${String(server.exitCode ?? server.signalCode)}) before ${url} answered`));
          } else setTimeout(tick, 200);
        },
      );
    };
    tick();
  });
}

/**
 * Read a spawned child's OS-assigned port out of its own readiness output.
 *
 * The child was bound to port 0, so the kernel picked the port atomically at
 * listen time; the only place the number exists is the line the child prints
 * once it is listening. `pattern` must capture the port in group 1. Resolves
 * on the first match; rejects if the child exits first or the deadline
 * passes — a child that never prints its readiness line is a failed start,
 * not a server to be probed for.
 */
export function readPortFromReadiness(
  child: ChildProcess,
  label: string,
  pattern: RegExp,
  timeoutMs: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const deadline = setTimeout(() => {
      cleanup();
      reject(new Error(`${label} never announced its port within ${timeoutMs}ms. Log so far:\n${buf}`));
    }, timeoutMs);
    const onData = (b: Buffer): void => {
      buf += b.toString();
      const match = buf.match(pattern);
      if (match) {
        cleanup();
        resolve(Number(match[1]));
      }
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`${label} exited (${code ?? "signal"}) before announcing its port. Log:\n${buf}`));
    };
    const cleanup = (): void => {
      clearTimeout(deadline);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", onExit);
  });
}

/**
 * Kill a child and wait for it to actually be gone.
 *
 * KILLING THE PID IS NOT ENOUGH, and this was measured, not assumed: the
 * first version of this file spawned Vite through `npx`, killed the `npx`
 * PID, watched it exit — and left the real Vite process listening on 5399,
 * which would have poisoned every later measurement on this box. Two fixes,
 * both needed:
 *
 *   1. every child is spawned `detached: true`, so it LEADS a process
 *      group, and we signal the GROUP (`-pid`) rather than the leader;
 *   2. we verify the exit instead of trusting `kill()` to mean "exited" —
 *      a `kill()` that returns is not a process that is gone.
 */
function killAndWait(child: ChildProcess, label: string): Promise<void> {
  const pid = child.pid;
  return new Promise((resolve) => {
    if (pid === undefined || child.exitCode !== null || child.signalCode !== null) {
      return resolve();
    }
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    child.once("exit", done);
    const signalGroup = (sig: NodeJS.Signals): void => {
      // Negative PID = the whole process group (npx → vite, node → workers).
      try { process.kill(-pid, sig); } catch { /* group already gone */ }
      try { process.kill(pid, sig); } catch { /* leader already gone */ }
    };
    signalGroup("SIGTERM");
    setTimeout(() => {
      if (!settled) {
        process.stderr.write(`${label} (pgid ${pid}) did not exit on SIGTERM — SIGKILL\n`);
        signalGroup("SIGKILL");
      }
    }, 4000);
    setTimeout(done, 7000);
  });
}

/**
 * The PID-GROUP LEDGER — teardown that does not depend on remembering.
 *
 * The second thing measurement taught this file: `stop()` only ever runs if
 * someone still holds the handle. A harness that crashes, a test runner that
 * is killed, or an operator who backgrounds the CLI and then signals the
 * wrong wrapper PID all leave a fixture server listening. So the moment the
 * children exist, their process-GROUP ids are written to a file, and
 * `reapStacks()` can kill them later knowing nothing else. Belt and braces,
 * because the failure it prevents is silent: an orphaned server holding a
 * 2GB fixture does not announce itself, it just makes the next run's numbers
 * quietly wrong.
 */
const LEDGER_PATH = join(SCRATCH_ROOT, "running-stacks.json");

type LedgerEntry = { profile: string; pgids: number[]; ports: StackPorts; at: string };

function readLedger(): LedgerEntry[] {
  if (!existsSync(LEDGER_PATH)) return [];
  try {
    return JSON.parse(readFileSync(LEDGER_PATH, "utf8")) as LedgerEntry[];
  } catch {
    return [];
  }
}

function writeLedger(entries: readonly LedgerEntry[]): void {
  // `recursive` would also create the scratch root's PARENT, and that parent is
  // the retired sibling-checkout tree — see `scratchRootParentOrRefuse`. Ask
  // first, so a deleted tree stays deleted and says so instead of reappearing.
  mkdirSync(scratchRootParentOrRefuse(SCRATCH_ROOT), { recursive: true });
  if (entries.length === 0) rmSync(LEDGER_PATH, { force: true });
  else writeFileSync(LEDGER_PATH, JSON.stringify(entries, null, 2) + "\n", "utf8");
}

/**
 * Kill every process group any previous run recorded, and clear the ledger.
 * Safe to call when nothing is running (a dead pgid signals nothing) and
 * safe to call before a run — which is exactly when it should be called, so
 * a leftover from a crashed run cannot contend with the one about to start.
 */
export function reapStacks(): readonly number[] {
  const reaped: number[] = [];
  for (const entry of readLedger()) {
    for (const pgid of entry.pgids) {
      try {
        process.kill(-pgid, "SIGKILL");
        reaped.push(pgid);
      } catch { /* already gone */ }
    }
  }
  writeLedger([]);
  return reaped;
}

export async function startStack(profile: string): Promise<RunningStack> {
  // Never start beside a leftover: a crashed previous run's server would
  // still hold its port (and its fixture) and contend for the same CPU.
  reapStacks();

  const fixture = await prepareFixture(profile, join(scratchRootParentOrRefuse(SCRATCH_ROOT), profile));

  // The API binds port 0 — the kernel assigns a free port atomically — and
  // announces the assigned number on its readiness line. The allowed origin
  // is set after the web port is known (below); a wildcard is wrong here, so
  // the API is started first and the web child is given the resolved ports.
  const apiEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HARNESS_WEB_PORT: "0",
    HARNESS_WEB_HOST: "127.0.0.1",
    HARNESS_WEB_DB_PATH: fixture.dbPath,
    HARNESS_KEY_HOME: fixture.keyHome,
    // The origin is unknown until the web port is assigned; the API serves a
    // loopback fixture behind the vite proxy (a server-to-server hop), so the
    // browser never crosses an origin to reach it. The proxy target — not the
    // origin header — is what carries the API port to the web child.
    HARNESS_WEB_ALLOWED_ORIGIN: "http://127.0.0.1",
  };
  const api = spawn(
    process.execPath,
    ["--experimental-strip-types", join(REPO_ROOT, "server", "index.ts")],
    { cwd: REPO_ROOT, env: apiEnv, stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  api.stdout?.on("data", (b: Buffer) => process.stderr.write(`[api] ${b.toString()}`));
  api.stderr?.on("data", (b: Buffer) => process.stderr.write(`[api!] ${b.toString()}`));

  // Read the API's OS-assigned port from its readiness line before starting
  // the web child, which needs it for the /api proxy target.
  let apiPort: number;
  try {
    apiPort = await readPortFromReadiness(api, "api", /server on http:\/\/[\d.]+:(\d+)/, 60_000);
  } catch (err) {
    await killAndWait(api, "api");
    throw err;
  }

  // Vite reads HARNESS_WEB_PORT to build its /api proxy target (see
  // vite.config.ts) — so this one variable is the whole repointing. Vite
  // binds 0 and prints its own `Local:` line carrying the assigned web port.
  const web = spawn(
    "npx",
    ["vite", "--port", "0", "--host", "127.0.0.1"],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, HARNESS_WEB_PORT: String(apiPort) },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  web.stdout?.on("data", (b: Buffer) => process.stderr.write(`[web] ${b.toString()}`));
  web.stderr?.on("data", (b: Buffer) => process.stderr.write(`[web!] ${b.toString()}`));

  let webPort: number;
  try {
    webPort = await readPortFromReadiness(web, "vite", /Local:\s+https?:\/\/[\d.]+:(\d+)\//, 60_000);
  } catch (err) {
    await Promise.all([killAndWait(api, "api"), killAndWait(web, "vite")]);
    throw err;
  }

  const ports: StackPorts = { api: apiPort, web: webPort };
  const webOrigin = `http://127.0.0.1:${webPort}`;

  // Record the groups BEFORE waiting for readiness — a stack that hangs on
  // startup is exactly the one most likely to be killed from outside.
  const pgids = [api.pid, web.pid].filter((p): p is number => typeof p === "number");
  writeLedger([
    ...readLedger().filter((e) => e.profile !== profile),
    { profile, pgids, ports, at: new Date().toISOString() },
  ]);

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await Promise.all([killAndWait(api, "api"), killAndWait(web, "vite")]);
    writeLedger(readLedger().filter((e) => e.profile !== profile));
  };
  process.once("SIGINT", () => void stop().then(() => process.exit(130)));
  process.once("SIGTERM", () => void stop().then(() => process.exit(143)));
  process.once("SIGHUP", () => void stop().then(() => process.exit(129)));

  try {
    await waitForHttp(`http://127.0.0.1:${apiPort}/api/health`, api, "api");
    await waitForHttp(`${webOrigin}/`, web, "vite");
  } catch (err) {
    await stop();
    throw err;
  }

  return {
    fixture,
    ports,
    url: `${webOrigin}/`,
    apiPid: api.pid ?? -1,
    webPid: web.pid ?? -1,
    stop,
  };
}

// CLI entry — `stop` reaps whatever a previous run left; otherwise start,
// print, and hold until signalled.
if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv[2] === "stop") {
    const reaped = reapStacks();
    process.stdout.write(JSON.stringify({ reapedPgids: reaped }) + "\n");
    process.exit(0);
  }
  const profile = process.argv[2] ?? "tiny";
  startStack(profile).then(
    (stack) => {
      process.stdout.write(
        JSON.stringify(
          {
            ready: true,
            url: stack.url,
            apiPid: stack.apiPid,
            webPid: stack.webPid,
            username: stack.fixture.username,
            password: stack.fixture.password,
            counts: stack.fixture.counts,
            megaChatId: stack.fixture.megaChatId,
            dbPath: stack.fixture.dbPath,
          },
          null,
          2,
        ) + "\n",
      );
    },
    (err: unknown) => {
      process.stderr.write(`stack failed: ${String(err)}\n`);
      process.exit(1);
    },
  );
}
