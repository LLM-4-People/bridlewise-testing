/**
 * SCALE-FIXTURE PREPARATION — make a committed bench fixture DB reachable
 * by a real browser, without touching product code and without ever
 * mutating the committed fixture.
 *
 * WHY THIS EXISTS. `bench/.fixtures/*.db` are built through the real
 * `DbClient` (bench/fixtures/scale.ts) and are exactly what the server
 * would have produced — which makes them the honest way to answer "does
 * the frontend stay smooth no matter how many projects/files/chats". But
 * two things stand between a fixture and a browser:
 *
 *   1. The fixture is COMMITTED. A server pointed at it would write to it
 *      (sessions, rate-limit rows, `updated_at` touches) and the next
 *      bench run would no longer measure the same corpus. So we copy
 *      first, always, into a scratch directory — never a flag, never an
 *      option. The committed file is opened read-only exactly once, by
 *      `cp`.
 *   2. The fixture's users have a PLACEHOLDER password hash. scale.ts
 *      writes `hash-<n>` (it is building a data corpus, not an auth
 *      corpus), and `verifyPassword` correctly refuses it — the stored
 *      value is not a `scrypt$...` string. So a browser cannot sign in as
 *      the user who owns the 3000 chats, and everything the frontend
 *      shows is per-user scoped. We fix that ON THE COPY by re-hashing a
 *      known passphrase with the server's OWN `hashPassword` and writing
 *      it through the server's OWN `setUserPasswordHash` — the same path
 *      the change-password route uses, so the row is encrypted at rest
 *      exactly as a real one is.
 *
 * What we deliberately do NOT do: hand-write SQL, or bypass DbClient.
 * Every byte we change goes through the product's own writer, so the DB
 * the browser talks to is a DB the product could have produced.
 *
 * Usage:
 *   node --experimental-strip-types tests/performance/scale/prepare-fixture.ts <profile> [outDir]
 *
 * Prints one line of JSON: { dbPath, keyHome, username, password, counts }.
 *
 * @test-only — never imported by the runtime bundle.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { join, basename } from "node:path";

import { DatabaseSync } from "node:sqlite";

import { DbClient } from "../../../server/db/client.ts";
import { markFixtureCopy } from "../../../engine/src/filesystem/database-provenance.ts";
import { relocateDatabaseKey } from "../../../server/db/key-rotation.ts";
import { admitKeyHome, databaseKeyFile, type AdmittedKeyHome } from "../../../engine/src/filesystem/self-protection/key-home.ts";
import { FIXTURE_DIR, fixtureKeyHome } from "../../../bench/fixtures/scale.ts";
import { hashPassword } from "../../../server/auth/auth.ts";
import { serverConfig } from "../../../server/kernel/config.ts";
import { seedChatMessagesViaDb, type PreparedProfileFixture } from "../lib/perf-harness.ts";

/** The passphrase we plant on the fixture user. Known, local-only, and
 * only ever valid inside a scratch COPY of a fixture. */
export const FIXTURE_PASSWORD = "perf-fixture-2026";

/** Where the committed fixtures live (read-only, from our point of view). */

/** Scratch root for fixture copies — deliberately OUTSIDE the repo (see the
 * CLI note below) and on real disk rather than /tmp, which is tmpfs here: a
 * 2GB fixture in tmpfs is 2GB of RAM competing with the thing being
 * measured. `stack.ts` re-exports this as its own SCRATCH_ROOT so the two
 * cannot drift. */
export const DEFAULT_SCRATCH_ROOT = "/home/example/code-harness-workspaces/.perf-scratch";

/**
 * REFUSE TO CREATE THE SCRATCH ROOT'S PARENT, AND SAY WHAT TO DO INSTEAD.
 *
 * `mkdirSync(SCRATCH_ROOT, { recursive: true })` is the natural spelling and it
 * is the wrong one HERE, because `recursive` also creates every missing parent
 * — and this root's parent is a shared workspaces tree a cleanup may retire.
 * Running the performance suite after that retirement would silently RESURRECT
 * the directory the retirement was for, and report nothing: the run would be
 * green, the tree would be back, and nobody would connect the two.
 *
 * So the parent must already exist. A missing parent is not an error to crash
 * on and not a thing to guess around — it is a configuration question with one
 * plain answer, which is what this message gives. There is deliberately no
 * fallback to `/tmp`: tmpfs is RAM on this machine, and a 2GB fixture there
 * competes with the measurement, so a silent fallback would not fail — it would
 * quietly produce numbers that mean something else, which is worse.
 */
export function scratchRootParentOrRefuse(root: string = DEFAULT_SCRATCH_ROOT): string {
  const parent = join(root, "..");
  if (existsSync(parent)) return root;
  throw new Error(
    `Performance scratch root unavailable: its parent directory ${parent} does not exist.\n` +
      `This root holds multi-gigabyte COPIES of the committed fixtures, so it lives outside ` +
      `the repository and off tmpfs (which is RAM here, and would compete with the thing ` +
      `being measured).\n` +
      `Create ${parent} on real disk, or point the suite at another real-disk location by ` +
      `passing it as the second argument to prepare-fixture, and update DEFAULT_SCRATCH_ROOT ` +
      `in tests/performance/scale/prepare-fixture.ts to match.\n` +
      `It is NOT created automatically on purpose: doing so would resurrect ${parent}, ` +
      `a shared workspaces tree, after it has been deliberately retired.`,
  );
}

export type PreparedFixture = Readonly<{
  profile: string;
  /** The SCRATCH copy the server should open (never the committed file). */
  dbPath: string;
  /** The SCRATCH key home holding the fixture's AES key (the server gets it as HARNESS_KEY_HOME). */
  keyHome: AdmittedKeyHome;
  username: string;
  password: string;
  dbBytes: number;
  /** Straight from the fixture's own `<profile>.spec.json` manifest — the
   * numbers scale.ts measured as it built the corpus. We do not re-count:
   * walking 3000 chats through `listMessages` would decrypt 347k rows just
   * to learn a number the builder already wrote down. */
  counts: Readonly<Record<string, number>>;
  projectIds: readonly string[];
  chatIds: readonly string[];
  /** The 20,000-message conversation (`heavy` only), the worst case. */
  megaChatId: string | null;
}>;

type FixtureManifest = Readonly<{
  users: ReadonlyArray<{ userId: string; projectIds: string[]; chatIds: string[] }>;
  megaChatId: string | null;
  counts: Record<string, number>;
}>;

function readManifest(profile: string): FixtureManifest {
  const specPath = join(FIXTURE_DIR, `${profile}.spec.json`);
  const spec = JSON.parse(readFileSync(specPath, "utf8")) as { manifest: FixtureManifest };
  return spec.manifest;
}

/** Copy the DB and its sidecars. The WAL is NOT optional: `tiny.db` carries
 * a 4MB WAL, and copying the `.db` alone would silently hand the server a
 * DB missing its most recent pages. */
function copyDbSet(srcDb: string, destDb: string): void {
  copyFileSync(srcDb, destDb);
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(srcDb + suffix)) copyFileSync(srcDb + suffix, destDb + suffix);
  }
}

/**
 * THE FIXTURE DOOR'S MARK (UD-S15): a prepared database is a FIXTURE — the
 * product keeps that stamp when it serves it, and a test may open it — never
 * the product's own (which a process under test refuses).
 */
function stampFixture(dbPath: string): void {
  const raw = new DatabaseSync(dbPath);
  try { markFixtureCopy(raw); } finally { raw.close(); }
}

/**
 * A prepared fixture's layout: the database under `<outDir>/db/`, its key in
 * the key home `<outDir>/keys/` — never beside the database (the key home
 * must share nothing with the database's folder).
 */
function fixtureLayout(outDir: string, dbName: string): Readonly<{ dbPath: string; keyHome: AdmittedKeyHome }> {
  const dbDir = join(outDir, "db");
  mkdirSync(dbDir, { recursive: true });
  return { dbPath: join(dbDir, dbName), keyHome: admitKeyHome(join(outDir, "keys"), [{ path: dbDir, what: "the fixture's database folder" }]) };
}

export async function prepareFixture(
  profile: string,
  outDir: string,
): Promise<PreparedFixture> {
  const srcDb = join(FIXTURE_DIR, `${profile}.db`);
  const srcKey = databaseKeyFile(fixtureKeyHome(FIXTURE_DIR), srcDb);
  if (!existsSync(srcDb)) throw new Error(`no such fixture: ${srcDb}`);
  if (!existsSync(srcKey)) throw new Error(`no key for fixture ${srcDb} in its key home: ${srcKey}`);

  mkdirSync(outDir, { recursive: true });
  const { dbPath, keyHome } = fixtureLayout(outDir, basename(srcDb));
  copyDbSet(srcDb, dbPath);
  // The committed fixture keeps its key beside it (fixture data, not an
  // install); the copy's key goes where every key goes, through the one
  // relocation owner (proved to open the database first).
  const staged = join(outDir, "fixture-key");
  copyFileSync(srcKey, staged);
  relocateDatabaseKey({ dbPath, from: staged, keyHome });
  stampFixture(dbPath);

  const manifest = readManifest(profile);
  const u0 = manifest.users[0];
  if (u0 === undefined) throw new Error(`fixture ${profile} has no users in its manifest`);

  // Open the COPY through the product's own client, with the fixture's own
  // key — anything else and the encrypted fields would not decrypt.
  const db = new DbClient({ path: dbPath, keyHome });
  try {
    // scale.ts names users `bench-u<n>`; user 0 owns the whole corpus for
    // every profile except `fleet` (and the 20,000-message conversation).
    const username = "bench-u0";
    const user = db.getUserByUsername(username);
    if (user === null) throw new Error(`fixture has no user ${username}`);
    if (user.id !== u0.userId) {
      throw new Error(`manifest/user drift: manifest says ${u0.userId}, db says ${user.id}`);
    }
    db.setUserPasswordHash(user.id, await hashPassword(FIXTURE_PASSWORD));
  } finally {
    db.close();
  }

  return {
    profile,
    dbPath,
    keyHome,
    username: "bench-u0",
    password: FIXTURE_PASSWORD,
    dbBytes: statSync(dbPath).size,
    counts: manifest.counts,
    projectIds: u0.projectIds,
    chatIds: u0.chatIds,
    megaChatId: manifest.megaChatId ?? null,
  };
}

/** Prepare the regular cockpit profile's actual populations on a fresh,
 * caller-owned path. It never connects to an existing or serving database. */
export async function prepareCockpitFixture(outDir: string): Promise<PreparedProfileFixture & { manifestPath: string }> {
  const manifestPath = join(outDir, "profile-manifest.json");
  const dbPath = join(outDir, "db", "projection.db"), keysDir = join(outDir, "keys");
  for (const path of [dbPath, keysDir, `${dbPath}-wal`, `${dbPath}-shm`, manifestPath]) assert(!existsSync(path), `fresh cockpit fixture path required: ${path}`);
  mkdirSync(outDir, { recursive: true });
  const { keyHome } = fixtureLayout(outDir, "projection.db");
  // The fixture admin's password is the caller's (the profile logs in with the
  // same variable) — never a literal in a tracked file.
  const password = process.env["HARNESS_WEB_AUTH_PASSWORD"];
  assert(password !== undefined && password.length > 0, "set HARNESS_WEB_AUTH_PASSWORD: the fixture admin's password (no built-in default)");
  const passwordHash = await hashPassword(password);
  const db = new DbClient({ path: dbPath, keyHome });
  let prepared: PreparedProfileFixture;
  try {
    // The v12 migration has ALREADY seeded the configured admin on this
    // fresh connection: it seeds whenever the configured password is set,
    // and the assert above required exactly that password in the
    // environment. Creating the same identity again would collide on
    // users.username UNIQUE (the reproduced F2 defect,
    // docs/findings/recovery/evidence/fix06-runtime/profile/) — so the
    // fixture ADOPTS the seeded row and rewrites the password hash through
    // the product's own change-password path, the same adopt-and-rehash
    // pattern prepareFixture uses for its fixture user. One owner names the
    // identity (serverConfig.authUsername, the same source the migration
    // reads), so the fixture can never spell it differently from the seed;
    // the createUser arm runs only when the migration seeded nothing.
    const username = serverConfig.authUsername;
    const seeded = db.getUserByUsername(username);
    const user = seeded ?? db.createUser(username, passwordHash);
    if (seeded !== null) db.setUserPasswordHash(seeded.id, passwordHash);
    const projectIds: string[] = [], chatIds: string[] = [];
    db.withTransaction(() => {
      for (let index = 0; index < 10000; index++) {
        const project = db.createProject({ name: `profile project ${index}`, path: process.cwd() }, user.id);
        projectIds.push(project.id);
        chatIds.push(db.createChat({ project_id: project.id, title: `profile conversation ${index}` }, user.id).id);
      }
    });
    const chatId = chatIds[0]!, projectId = projectIds[0]!;
    const seed = seedChatMessagesViaDb(db, { chatId, count: 1000, username });
    prepared = { dbPath, keyHome, closedBeforeServing: true, projectIds, chatIds, longChat: { projectId, chatId, messageIds: seed.messageIds, messageCount: db.countMessages(chatId, user.id) } };
    assert.equal(db.listProjects(user.id).length, 10000);
  } finally { db.close(); }
  stampFixture(dbPath);
  writeFileSync(manifestPath, JSON.stringify(prepared, null, 2) + "\n", { flag: "wx" });
  return { ...prepared, manifestPath };
}

// CLI entry.
if (import.meta.url === `file://${process.argv[1]}`) {
  const profile = process.argv[2] ?? "tiny";
  // The default MUST NOT be inside the repo. An earlier default of
  // `process.cwd()/.perf-scratch` put a 2GB fixture copy in the working
  // tree, where it showed up in `git status` and in every file watcher.
  // A scratch copy this large belongs outside the repo, always.
  // An explicit argv[3] is the caller naming a location and is taken as given.
  // The DEFAULT is the one that can resurrect a deleted tree, so only it asks.
  const outDir = process.argv[3] ?? join(scratchRootParentOrRefuse(), profile);
  (profile === "cockpit" ? prepareCockpitFixture(outDir) : prepareFixture(profile, outDir)).then(
    (r) => {
      // Print a SUMMARY, not the corpus. `heavy` carries 3000 chat ids and
      // dumping them buries the four facts a caller actually needs.
      process.stdout.write(
        JSON.stringify(
          {
            ...r,
            ...("longChat" in r ? { longChat: { ...r.longChat, messageIds: `${r.longChat.messageIds.length} prepared messages` } } : {}),
            projectIds: `${r.projectIds.length} projects (first: ${r.projectIds[0] ?? "none"})`,
            chatIds: `${r.chatIds.length} chats (first: ${r.chatIds[0] ?? "none"})`,
          },
          null,
          2,
        ) + "\n",
      );
    },
    (err: unknown) => {
      process.stderr.write(`prepare-fixture failed: ${String(err)}\n`);
      process.exit(1);
    },
  );
}
