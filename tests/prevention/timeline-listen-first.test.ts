// @vitest-environment node
/**
 * THE SERVER LISTENS FIRST; THE LEDGER'S MIGRATIONS RUN OFF ITS THREAD (SCALE-CR1 C10).
 *
 * ── The defect (measured) ──
 * The boot opened the ledger before `listen`, and a ledger that owed a
 * migration ran it right there: migration 9 over a 10 GB ledger blocked the
 * boot for 488.8 s with nothing answering, not even `/api/health`.
 *
 * ── The rule, driven on the real server ──
 * A ledger from the previous build (every migration but the newest) is held
 * locked by another connection, so its migration cannot finish yet. The
 * server must LISTEN anyway; `/api/health` answers with `ledger: "migrating"`
 * (liveness separate from readiness); a route that needs the ledger is
 * refused typed and retryable (503 `timeline_migrating`); once the lock is
 * released the migration completes, the ledger reports `ready`, the
 * migration is registered, and one `recording-gap` event says what the
 * migrating window did not record.
 */
import { afterAll, expect, test } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DbClient } from "../../server/db/client.ts";
import { createSessionToken, hashSessionToken } from "../../server/auth/auth.ts";
import { ALL_MIGRATIONS } from "../../engine/src/timeline/timeline-schema.ts";
import { sha256 } from "../../engine/src/kernel/integrity.ts";
import { createTempDir } from "../helpers/temp-dir.ts";
import { atomicWriteFile } from "../../engine/src/filesystem/atomic-write.ts";
import { modulePathMatching } from "../helpers/module-resolver.ts";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const NEWEST = ALL_MIGRATIONS.at(-1)!;
let child: ChildProcess | undefined;

afterAll(async () => {
  if (child !== undefined && child.exitCode === null) {
    child.kill("SIGTERM");
    const deadline = Date.now() + 8_000;
    while (child.exitCode === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});

/** A ledger as the previous build left it: every migration but the newest, in WAL mode. */
function previousBuildLedger(path: string): void {
  const raw = new DatabaseSync(path);
  try {
    raw.exec("PRAGMA journal_mode = WAL");
    raw.exec("CREATE TABLE schema_migrations (migration_id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, checksum TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT");
    for (const migration of ALL_MIGRATIONS.filter((m) => m.id !== NEWEST.id)) {
      raw.exec(migration.sql);
      raw.prepare("INSERT INTO schema_migrations VALUES (?,?,?,?)").run(migration.id, migration.name, sha256(migration.sql), "2026-09-30T00:00:00.000Z");
    }
  } finally { raw.close(); }
}

async function waitFor<T>(what: string, read: () => Promise<T | undefined>, logs: readonly string[], ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`server exited (${String(child.exitCode)}) while waiting for ${what}:\n${logs.join("")}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}:\n${logs.join("")}`);
}

/** A server booted on a previous-build ledger whose write lock another connection HOLDS (its migration waits). */
async function startOnHeldLedger(timeline: Readonly<Record<string, unknown>>) {
  const dir = createTempDir("ch-listen-first-");
  const dbPath = join(dir, "web.db");
  const timelinePath = join(dir, "timeline.db");
  previousBuildLedger(timelinePath);
  // The ledger's identity, published beside it as the server's first open did.
  writeFileSync(join(dir, "timeline-ledger-id"), `ledger-${randomUUID()}`, { mode: 0o600 });
  const configPath = join(dir, "bridlewise.config.json");
  expect(atomicWriteFile(configPath, `${JSON.stringify({ timeline: { sqliteBusyTimeoutMs: 60_000, ...timeline } })}\n`, { createMode: 0o600 }).success).toBe(true);
  const seed = new DbClient({ path: dbPath });
  const user = seed.createUser("listen-first", "not-a-real-hash");
  const token = createSessionToken();
  seed.createAuthSession(hashSessionToken(token), user.id, "listen-first-session");
  seed.close();

  // Hold the ledger's write lock: the migration waits on it (busy timeout 60 s).
  const holder = new DatabaseSync(timelinePath);
  holder.exec("BEGIN IMMEDIATE");
  const logs: string[] = [];
  child = spawn("node", ["--experimental-strip-types", modulePathMatching("server/index.ts")], {
    cwd: REPO_ROOT,
    env: { ...process.env, HARNESS_CONFIG_PATH: configPath, HARNESS_WEB_PORT: "0", HARNESS_WEB_HOST: "127.0.0.1", HARNESS_WEB_DB_PATH: dbPath, HARNESS_WEB_TIMELINE_DB_PATH: timelinePath, HARNESS_WEB_PROJECT_ROOT: dir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d: Buffer) => logs.push(d.toString()));
  child.stderr?.on("data", (d: Buffer) => logs.push(d.toString()));
  let port: number;
  try {
    port = await waitFor("the listening line", async () => {
      const match = /server on http:\/\/[\d.]+:(\d+)/u.exec(logs.join(""));
      return match === null ? undefined : Number(match[1]);
    }, logs);
  } catch (error) { holder.exec("ROLLBACK"); holder.close(); throw error; }
  const base = `http://127.0.0.1:${String(port)}`;
  const get = async (path: string) => {
    const res = await fetch(`${base}${path}`, { headers: { cookie: `harness_auth=${token}`, "x-requested-with": "XMLHttpRequest" } });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  let held = true;
  return {
    timelinePath, logs, get,
    release: (): void => { if (held) { holder.exec("COMMIT"); held = false; } },
    abandon: (): void => { if (held) { holder.exec("ROLLBACK"); held = false; } holder.close(); },
  };
}

async function stopServer(logs: readonly string[]): Promise<void> {
  child!.kill("SIGTERM");
  await waitFor("the server to exit", async () => (child?.exitCode !== null ? true : undefined), logs, 15_000);
}

test("the server answers while the ledger migrates, refuses ledger work typed, and opens the ledger when the migration completes", async () => {
  const server = await startOnHeldLedger({});
  const { get, logs } = server;
  try {
    // LISTENING while the migration is held: liveness answers, readiness says migrating.
    const during = await get("/api/health");
    expect(during.status).toBe(200);
    expect(during.body).toMatchObject({ status: "ok", ledger: "migrating", database: "test" });
    expect(logs.join("")).toContain(`the ledger owes 1 migration(s) (${NEWEST.name})`);
    // Ledger work is refused typed and retryable, never hung and never crashed.
    const refused = await get("/api/timeline/events/evt-any");
    expect(refused.status, JSON.stringify(refused.body)).toBe(503);
    expect(refused.body).toMatchObject({ error: "timeline_migrating" });

    // Release the lock: the migration completes and the ledger opens.
    server.release();
    await waitFor("the ledger to be ready", async () => ((await get("/api/health")).body.ledger === "ready" ? true : undefined), logs);
    expect((await get("/api/timeline/events/evt-any")).status, "the ledger serves again").toBe(404);
  } finally {
    server.abandon();
  }
  await stopServer(logs);

  const ledger = new DatabaseSync(server.timelinePath, { readOnly: true });
  try {
    expect((ledger.prepare("SELECT name FROM schema_migrations WHERE name = ?").get(NEWEST.name) as { name: string } | undefined)?.name).toBe(NEWEST.name);
    const gaps = ledger.prepare("SELECT description FROM event_log WHERE event_type = 'ledger' AND description LIKE 'recording-gap:%'").all() as { description: string }[];
    expect(gaps).toHaveLength(1);
    // What the server did while the ledger migrated (its boot's own recorded
    // work, the requests above) was COUNTED, not silently lost (N6/M22).
    expect(Number(/^recording-gap: (\d+) effect/u.exec(gaps[0]!.description)?.[1] ?? "0"), gaps[0]!.description).toBeGreaterThan(0);
  } finally { ledger.close(); }
});

test("a recording-gap event that cannot be written is reported, and the open ledger still says ready (SCALE-CR1-FIX M9c)", async () => {
  // A document limit no gap document fits: the ledger opens, the gap write is refused.
  const server = await startOnHeldLedger({ maxDocumentBytes: 8 });
  const { get, logs } = server;
  try {
    expect((await get("/api/health")).body).toMatchObject({ ledger: "migrating" });
    server.release();
    await waitFor("the ledger to leave migrating", async () => {
      const state = (await get("/api/health")).body.ledger;
      return state === "migrating" ? undefined : state;
    }, logs);
    await waitFor("the gap report", async () => (logs.join("").includes("recording-gap event could not be written") ? true : undefined), logs);
    expect((await get("/api/health")).body.ledger, "the ledger is open and records: never `failed`").toBe("ready");
    expect((await get("/api/timeline/events/evt-any")).status, "the ledger serves").toBe(404);
  } finally {
    server.abandon();
  }
  await stopServer(logs);
});
