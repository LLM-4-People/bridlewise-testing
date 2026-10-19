/**
 * SERVER INSTANCE LIFECYCLE — start a real one, on its own port, over a
 * DISPOSABLE COPY of a fixture, and always kill it by PID.
 *
 * Every rule here exists because breaking it would silently corrupt a
 * measurement or someone else's work:
 *
 *   NEVER the committed fixture. The server MIGRATES the database it opens
 *     and WRITES to it (sessions, messages, the timeline). Pointing it at
 *     `bench/.fixtures/heavy.db` would mutate the fixture that every other
 *     bench number is anchored to, and the corruption would be invisible —
 *     later runs would just quietly measure different data. Every instance
 *     gets a fresh copy in `bench/.scratch/`, and the copy's `-wal`/`-shm`
 *     come with it (a db without its WAL is a db missing its most recent
 *     writes).
 *   NEVER the default port. 5173 (vite) and 5174 (api) belong to the
 *     developer. The bench allocates from 5200 up.
 *   NEVER an orphan. The PID is written to a pidfile beside the copy before
 *     anything else happens, so a bench that dies mid-run leaves a trail
 *     rather than a server nobody can find. `stop()` is SIGTERM, then
 *     SIGKILL on a deadline — a server hung inside a 3-second blocking read
 *     will not answer SIGTERM promptly, and waiting forever for it is how a
 *     harness leaks processes.
 *
 * SESSIONS ARE MINTED, NOT LOGGED IN. The scale fixtures create users
 * through `DbClient.createUser(username, "hash-N")` — a literal, not a scrypt
 * hash — so `POST /api/auth/login` can never succeed for a fixture user, and
 * `POST /api/auth/register` is closed once any user exists (routes/auth.ts:
 * "Registration is closed"). So this module opens the COPY before the server
 * does and inserts auth-session rows directly, using the product's OWN
 * helpers (`createSessionToken`, `hashSessionToken`, `db.createAuthSession`)
 * — exactly what `establishSession` in routes/auth.ts does, minus the HTTP.
 * The resulting cookie is indistinguishable to the server from a login's.
 *
 * WHAT THIS SKIPS, said plainly: the scrypt verify on the login path. That
 * is deliberate — scrypt is ~50-100ms of libuv thread-pool work per login
 * and would dominate a read-latency measurement while telling us nothing
 * about the read. Login cost is measured on its own, once, as its own case.
 */

import { spawnSync, spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  copyFileSync,
  rmSync,
  writeFileSync,
  readFileSync,
  statSync,
  openSync,
  constants,
} from "node:fs";
import { join } from "node:path";
import { parseProcessIdentityRecord, processIdentity, processIdentityRecord, terminate, type TerminationEnding } from "../../engine/src/process/process-facts.ts";
import { pathToFileURL } from "node:url";

import { DbClient } from "../../server/db/client.ts";
import { relocateDatabaseKey } from "../../server/db/key-rotation.ts";
import { databaseKeyFile, type AdmittedKeyHome } from "../../engine/src/filesystem/self-protection/key-home.ts";
import { FIXTURE_DIR, fixtureKeyHome } from "../fixtures/scale.ts";
import { createSessionToken, hashSessionToken, hashPassword, AUTH_COOKIE_NAME } from "../../server/auth.ts";
// REUSE, not a second definition: the passphrase planted on fixture users is
// owned by tests/performance/scale/prepare-fixture.ts (the frontend perf
// harness). Importing the constant keeps the two harnesses from drifting onto
// different passwords for the same fixture. We do NOT call its
// `prepareFixture()` — that copies the fixture a second time and does not
// stage the timeline db, project root, pidfile or probe port this harness
// needs. Same passphrase, different staging.
import { FIXTURE_PASSWORD } from "../../tests/performance/scale/prepare-fixture.ts";

export { FIXTURE_PASSWORD };
import { WireClient, type WireSession } from "./client.ts";

const REPO_ROOT = process.cwd();

const SCRATCH_DIR = join(REPO_ROOT, "bench", ".scratch");

/** Ports the bench may use. 5173/5174 are the developer's and are never touched. */
export const BENCH_PORT_BASE = 5200;

export type ServerKnobs = {
  /** `HARNESS_WEB_RATE_LIMIT` — tokens per refill window. Default: product default (60). */
  readonly rateLimit?: number;
  /** `HARNESS_WEB_RATE_LIMIT_REFILL_MS` — refill window. Floor is 1000 (config.ts). */
  readonly rateLimitRefillMs?: number;
  /** `HARNESS_WEB_SSE_MAX_CONNECTIONS_PER_USER`. Default: product default (8). */
  readonly sseMaxConnectionsPerUser?: number;
  /** `HARNESS_WEB_LLM_FIXTURES=1` — deterministic model events, no provider. */
  readonly llmFixtures?: boolean;
  /** Load `bench/wire/preload-lag.ts` into the server process. Default true. */
  readonly probe?: boolean;
  /** Plant a real scrypt password on user 0 so successful login is measurable. */
  readonly plantPassword?: boolean;
  /** Extra env, for one-off experiments. */
  readonly env?: Readonly<Record<string, string>>;
};

export type FixtureIds = {
  readonly users: ReadonlyArray<{
    readonly userId: string;
    readonly projectIds: readonly string[];
    readonly chatIds: readonly string[];
  }>;
  readonly megaChatId: string | null;
  readonly counts: Record<string, number>;
};

export type ServerInstance = {
  readonly pid: number;
  readonly port: number;
  readonly probePort: number;
  readonly dbPath: string;
  readonly dbBytesAtStart: number;
  readonly walPath: string;
  readonly logPath: string;
  /** ms from spawn to the server's OWN listen line — the real boot, free of
   *  the WSL2 SYN-retransmit artifact (see startServer). */
  readonly listenMs: number;
  /** ms from spawn to the first successful `/api/health`, measured only
   *  AFTER the port was confirmed bound. `bootMs - listenMs` is the app's
   *  first-request cost; it is NOT a kernel timer. */
  readonly bootMs: number;
  /** One session per fixture user, in fixture order. */
  readonly sessions: readonly WireSession[];
  readonly ids: FixtureIds;
  readonly knobs: ServerKnobs;
  /** Current size of the db's `-wal` file. WAL growth under sustained write
   *  load is a durability/space finding the in-process bench cannot see. */
  walBytes(): number;
  dbBytes(): number;
  stop(): Promise<{ readonly signal: string; readonly waitedMs: number }>;
};

/** A free-ish port. Not atomic — the bench serializes instance starts. */
export function pickPort(offset: number): number {
  return BENCH_PORT_BASE + offset;
}

function copyIfPresent(from: string, to: string): void {
  if (!existsSync(from)) return;
  // FICLONE gets a copy-on-write reflink on btrfs/xfs — a 2GB `heavy.db`
  // copy becomes instant and costs no disk. Falls back to a real copy
  // silently on filesystems that cannot (ext4).
  try {
    copyFileSync(from, to, constants.COPYFILE_FICLONE);
  } catch {
    copyFileSync(from, to);
  }
}

/**
 * Copy a fixture (db + wal + shm + key) into a private scratch directory.
 * Returns the copy's paths. The scratch dir is wiped first so a rerun never
 * inherits a previous run's writes — a fixture that accumulated one run's
 * messages would make the next run's numbers quietly non-comparable.
 */
export function stageFixture(profile: string, tag: string): {
  readonly dir: string;
  readonly dbPath: string;
  readonly keyHome: AdmittedKeyHome;
  readonly ids: FixtureIds;
} {
  const src = join(FIXTURE_DIR, `${profile}.db`);
  const srcSpec = join(FIXTURE_DIR, `${profile}.spec.json`);
  if (!existsSync(src)) {
    throw new Error(
      `fixture ${profile} not built: ${src} does not exist. ` +
        `Build it with: node --experimental-strip-types bench/fixtures/scale.ts ${profile}`,
    );
  }
  if (!existsSync(srcSpec)) {
    throw new Error(
      `fixture ${profile} has no ${profile}.spec.json — it is still being BUILT, or the build failed. ` +
        `The spec sidecar is written last, so its absence means the db is incomplete. Do not measure it.`,
    );
  }

  const dir = join(SCRATCH_DIR, `${profile}-${tag}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const dbPath = join(dir, "web.db");
  copyIfPresent(src, dbPath);
  copyIfPresent(`${src}-wal`, `${dbPath}-wal`);
  copyIfPresent(`${src}-shm`, `${dbPath}-shm`);
  // The copy's key goes into the stage's own key home (beside the stage,
  // never inside it) through the one relocation owner.
  const staged = join(dir, "fixture-key");
  copyIfPresent(databaseKeyFile(fixtureKeyHome(FIXTURE_DIR), src), staged);
  const keyHome = fixtureKeyHome(dir);
  relocateDatabaseKey({ dbPath, from: staged, keyHome });

  const spec = JSON.parse(readFileSync(srcSpec, "utf8")) as { manifest: FixtureIds };

  return { dir, dbPath, keyHome, ids: spec.manifest };
}

/**
 * Mint one auth session per user directly in the staged copy, using the
 * product's own session helpers. Runs BEFORE the server starts and closes
 * the handle, so the server opens the db uncontended.
 */
export async function mintSessions(
  dbPath: string,
  keyHome: AdmittedKeyHome,
  ids: FixtureIds,
  /** Also plant a REAL scrypt password on user 0, so the successful-login
   *  path can be measured. Fixture users ship `hash-<n>`, which
   *  `verifyPassword` correctly refuses, so without this the only login
   *  latency observable is the failure path. Written through the product's
   *  own `hashPassword` + `setUserPasswordHash` — the same route
   *  change-password uses — on the COPY only. */
  plantPassword = false,
): Promise<readonly WireSession[]> {
  const db = new DbClient({ path: dbPath, keyHome });
  try {
    const sessions: WireSession[] = [];
    // The user set comes from the fixture MANIFEST, not from a table scan:
    // the manifest is what the rest of the harness keys its project/chat ids
    // to, so a session list derived from anything else could drift out of
    // correspondence with the ids the load phases actually request.
    for (const entry of ids.users) {
      const user = db.getUserById(entry.userId);
      if (user === null) {
        throw new Error(
          `fixture manifest names user ${entry.userId} but the db has no such row — ` +
            `the manifest and the db have diverged; rebuild the fixture.`,
        );
      }
      const token = createSessionToken();
      // Exactly what routes/auth.ts::establishSession does: store the HASH,
      // hand the client the token. The `sessionId` third argument is the
      // anonymous isolation cookie, kept as audit metadata.
      db.createAuthSession(hashSessionToken(token), user.id, `bench-${user.id}`);
      sessions.push({
        userId: user.id,
        username: user.username,
        cookie: `${AUTH_COOKIE_NAME}=${token}`,
      });
    }
    if (sessions.length === 0) {
      throw new Error(
        `fixture db ${dbPath} has NO users — every non-public route would 401 with "setup_required". ` +
          `The fixture build is incomplete.`,
      );
    }
    if (plantPassword) {
      const first = ids.users[0]!;
      db.setUserPasswordHash(first.userId, await hashPassword(FIXTURE_PASSWORD));
    }
    return sessions;
  } finally {
    db.close();
  }
}

/**
 * Start a server instance. Resolves once `/api/health` answers 200, so
 * `bootMs` includes schema migration of the staged copy — which for a
 * multi-gigabyte fixture is itself a finding (a user's first request after
 * an upgrade waits for it).
 */
export async function startServer(options: {
  readonly profile: string;
  readonly tag: string;
  readonly port: number;
  readonly probePort: number;
  readonly knobs?: ServerKnobs;
  readonly readyTimeoutMs?: number;
}): Promise<ServerInstance> {
  const knobs = options.knobs ?? {};
  const staged = stageFixture(options.profile, options.tag);
  const sessions = await mintSessions(staged.dbPath, staged.keyHome, staged.ids, knobs.plantPassword === true);

  const logPath = join(staged.dir, "server.log");
  const logFd = openSync(logPath, "a");

  const env: Record<string, string> = {
    ...process.env,
    HARNESS_WEB_PORT: String(options.port),
    HARNESS_WEB_HOST: "127.0.0.1",
    HARNESS_WEB_DB_PATH: staged.dbPath,
    HARNESS_KEY_HOME: staged.keyHome,
    // The timeline is a SECOND sqlite database and the server opens it
    // eagerly (index.ts calls getTimelineRecorder() at boot). Left at its
    // default it would write into the developer's `.bridlewise/`.
    HARNESS_WEB_TIMELINE_DB_PATH: join(staged.dir, "timeline.db"),
    HARNESS_WEB_PROJECT_ROOT: staged.dir,
  };
  if (knobs.rateLimit !== undefined) env["HARNESS_WEB_RATE_LIMIT"] = String(knobs.rateLimit);
  if (knobs.rateLimitRefillMs !== undefined) {
    env["HARNESS_WEB_RATE_LIMIT_REFILL_MS"] = String(knobs.rateLimitRefillMs);
  }
  if (knobs.sseMaxConnectionsPerUser !== undefined) {
    env["HARNESS_WEB_SSE_MAX_CONNECTIONS_PER_USER"] = String(knobs.sseMaxConnectionsPerUser);
  }
  if (knobs.llmFixtures) env["HARNESS_WEB_LLM_FIXTURES"] = "1";
  const useProbe = knobs.probe !== false;
  if (useProbe) env["HARNESS_BENCH_PROBE_PORT"] = String(options.probePort);
  for (const [k, v] of Object.entries(knobs.env ?? {})) env[k] = v;

  const args = ["--experimental-strip-types"];
  if (useProbe) {
    // `--import` runs the probe in the server's isolate BEFORE server/index.ts
    // is evaluated. Nothing in server/ imports it; nothing in server/ knows.
    args.push("--import", pathToFileURL(join(REPO_ROOT, "bench", "wire", "preload-lag.ts")).href);
  }
  args.push(join(REPO_ROOT, "server", "index.ts"));

  const t0 = process.hrtime.bigint();
  const child: ChildProcess = spawn(process.execPath, args, {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", logFd, logFd],
  });
  const pid = child.pid ?? -1;
  // Pidfile FIRST: if this bench is killed a millisecond from now, the pid
  // is still on disk and the server is still findable.
  if (pid > 0) writeFileSync(join(staged.dir, "server.pid"), processIdentityRecord(processIdentity(pid)), "utf8");

  let exited = false;
  let exitInfo = "";
  child.on("exit", (code, signal) => {
    exited = true;
    exitInfo = `code=${code} signal=${signal}`;
  });

  // ── READINESS: WATCH THE LOG, NEVER RACE THE SOCKET ──────────────────
  //
  // This box (WSL2) SILENTLY DROPS a TCP SYN sent to a port that is not yet
  // bound — it does not refuse it. The connect then succeeds only on the
  // kernel's SYN retransmit, ~1s later (then 3s, 7s up the RTO ladder). So a
  // readiness loop that just tries to connect measures the RETRANSMIT TIMER,
  // not the server.
  //
  // Measured on this machine, directly: the server printed its listen line at
  // 410ms; a connect issued at t=0 completed at 1027ms; a connect issued
  // AFTER the listen line took 2.61ms. That is 618ms of pure kernel artifact.
  // It is also why an earlier version of this harness reported a boot of
  // 1.02s for a 5MB database and 1.03s for a 1.58GB one — two figures that
  // cannot both be boot, and neither of which was.
  //
  // So: wait for the server's OWN listen line (`server/index.ts` prints it
  // through `webConsoleInfo`, which writes to stdout unconditionally — not
  // gated behind the debug flag), and only then touch the socket. BOTH
  // numbers are returned, because the gap between them is a real thing a
  // client experiences at startup and hiding it would be its own dishonesty.
  const readyTimeoutMs = options.readyTimeoutMs ?? 180_000;
  const listenMarker = `server on http://${"127.0.0.1"}:${options.port}`;
  let listenMs = Number.NaN;
  let bootMs = Number.NaN;
  const probeClient = new WireClient(options.port);
  try {
    const deadline = Date.now() + readyTimeoutMs;
    while (Number.isNaN(listenMs)) {
      if (exited) throw new Error(`server exited before it listened (${exitInfo}). Log: ${logPath}`);
      if (Date.now() > deadline) {
        throw new Error(
          `server never printed its listen line within ${readyTimeoutMs}ms. Log: ${logPath}`,
        );
      }
      try {
        if (readFileSync(logPath, "utf8").includes(listenMarker)) {
          listenMs = Number(process.hrtime.bigint() - t0) / 1_000_000;
          break;
        }
      } catch {
        /* log not created yet */
      }
      await sleep(2);
    }

    // Now the port is genuinely bound, so this connect measures the app.
    for (;;) {
      if (exited) throw new Error(`server exited during readiness (${exitInfo}). Log: ${logPath}`);
      const r = await probeClient.request({ path: "/api/health", timeoutMs: 5_000 });
      if (r.status === 200) {
        bootMs = Number(process.hrtime.bigint() - t0) / 1_000_000;
        break;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `server listened but /api/health did not answer 200 within ${readyTimeoutMs}ms ` +
            `(last status ${r.status}, error ${r.error ?? "none"}). Log: ${logPath}`,
        );
      }
      await sleep(20);
    }
  } catch (err) {
    await killPid(pid);
    throw err;
  } finally {
    probeClient.destroy();
  }

  const walPath = `${staged.dbPath}-wal`;

  return {
    pid,
    port: options.port,
    probePort: options.probePort,
    dbPath: staged.dbPath,
    listenMs,
    dbBytesAtStart: existsSync(staged.dbPath) ? statSync(staged.dbPath).size : 0,
    walPath,
    logPath,
    bootMs,
    sessions,
    ids: staged.ids,
    knobs,
    walBytes: () => (existsSync(walPath) ? statSync(walPath).size : 0),
    dbBytes: () => (existsSync(staged.dbPath) ? statSync(staged.dbPath).size : 0),
    stop: () => killPid(pid),
  };
}

/**
 * Kill by PID: SIGTERM, then SIGKILL on a deadline (the process-facts
 * owner's one terminate loop).
 *
 * The deadline is not politeness — `server/index.ts` handles SIGTERM with
 * `server.close()`, which waits for in-flight requests. A request blocked in
 * a 3-second synchronous read (or an SSE stream that is still open) delays
 * or prevents that close, so a harness that only sends SIGTERM and waits
 * leaks servers exactly when the product is behaving worst.
 */
export async function killPid(pid: number, graceMs = 4_000): Promise<Readonly<{ ending: TerminationEnding; waitedMs: number }>> {
  return terminate({ pid }, { graceMs, pollMs: 50 });
}

/**
 * Stop any server this harness left behind in a previous run, by the identity
 * its pid file holds (a pid recycled by an unrelated process is never
 * signalled), through the process-facts owner's one terminate loop with a
 * short grace (a leftover has no in-flight work to finish).
 */
export async function reapStrayInstances(): Promise<readonly number[]> {
  if (!existsSync(SCRATCH_DIR)) return [];
  const out = spawnSync("find", [SCRATCH_DIR, "-name", "server.pid"], { encoding: "utf8" });
  const identities = (out.stdout ?? "").trim().split("\n").filter(Boolean).flatMap((file) => {
    try {
      return parseProcessIdentityRecord(readFileSync(file, "utf8")) ?? [];
    } catch {
      return []; // the pid file vanished between the listing and this read
    }
  });
  const endings = await Promise.all(identities.map((identity) => terminate(identity, { graceMs: 1_000, pollMs: 50 })));
  return identities.filter((_, index) => endings[index]!.ending !== "gone").map((identity) => identity.pid);
}

/** Delete every staged fixture copy. The `fleet` copy is 1.58GB and three
 *  instances stage their own, so a run that does not clean up costs ~4.7GB
 *  of disk per invocation. Called at the end of a run unless --keep-scratch. */
export function clearScratch(): { readonly removedBytes: number } {
  if (!existsSync(SCRATCH_DIR)) return { removedBytes: 0 };
  let removedBytes = 0;
  const out = spawnSync("du", ["-sb", SCRATCH_DIR], { encoding: "utf8" });
  const parsed = Number((out.stdout ?? "").trim().split(/\s+/)[0]);
  if (Number.isFinite(parsed)) removedBytes = parsed;
  rmSync(SCRATCH_DIR, { recursive: true, force: true });
  return { removedBytes };
}

export function sleep(msValue: number): Promise<void> {
  return new Promise((r) => setTimeout(r, msValue));
}

export { SCRATCH_DIR, FIXTURE_DIR };
