// @vitest-environment node
/**
 * NO TEST REACHES A REAL DATABASE — BY THE DATABASE'S OWN STAMP (UD-S15).
 *
 * ── The incident (traced) ──
 * The live `web.db` held 204 conversations of exactly 1,000 messages each,
 * created 2026-08-30..09-12 and soft-deleted within seconds: the performance
 * profile's long-chat phase (`tests/performance/profile.spec.ts`, before
 * 82899260) opened a `DbClient` on the hard-coded `.bridlewise/web.db` from
 * the Playwright process — which nothing recognised as under test — seeded
 * 1,000 messages and trashed the chat afterwards.
 *
 * ── The guard ──
 * The product stamps a database it opens for writing (`application_id`,
 * `engine/src/filesystem/database-provenance.ts`); a process under test
 * refuses a stamped one at the database doors (the web client, the timeline
 * store) before anything is read or written, whatever the path's spelling.
 * Playwright runs are armed like every runner, and their global setup
 * refuses to drive a server that serves a real database.
 *
 * A real database from BEFORE the stamp (SCALE-CR1-FIX N5: the live 10 GB
 * ledger and the master checkout's databases were unstamped) is refused too:
 * under test, an unstamped database that already holds tables is admitted
 * only inside the run's temporary root, and an empty one a test creates is
 * stamped as the test's own (`BWTS`).
 */
import { describe, expect, test } from "vitest";
import { copyFileSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DbClient } from "../../server/db/client.ts";
import { createTimelineStore } from "../../engine/src/timeline/timeline-store.ts";
import { admitDatabaseProvenance, databaseProvenanceOf, DATABASE_PROVENANCE, markFixtureCopy, REAL_DATABASE_UNDER_TEST_CODE } from "../../engine/src/filesystem/database-provenance.ts";
import { processUnderTest } from "../../engine/src/filesystem/checkout-write-door.ts";
import { realServerRefusal } from "../setup/real-database-refusal.ts";
import { createTempDir } from "../helpers/temp-dir.ts";
import { walk } from "../helpers/source-scan.ts";
import { modulePath } from "../helpers/module-resolver.ts";
import { runNativeScript } from "../helpers/native-script.ts";
import { pathToFileURL } from "node:url";

/** A database as the product leaves it: stamped. (Made raw: a test process cannot stop being under test.) */
function productDatabase(path: string): void {
  const raw = new DatabaseSync(path);
  try {
    raw.exec("CREATE TABLE kept (value TEXT)");
    raw.exec(`PRAGMA application_id = ${String(DATABASE_PROVENANCE.product)}`);
  } finally { raw.close(); }
}

describe("a real database under test", () => {
  test("this suite's process is under test (the doors' one answer)", () => {
    expect(processUnderTest()).toBe(true);
  });

  test("the web database client refuses a product database for reading and writing, and writes nothing", () => {
    const dir = createTempDir("real-db-web-");
    const path = join(dir, "web.db");
    productDatabase(path);
    const before = readFileSync(path);
    expect(() => new DbClient({ path })).toThrow(expect.objectContaining({ code: REAL_DATABASE_UNDER_TEST_CODE }));
    expect(() => new DbClient({ path, readOnly: true })).toThrow(expect.objectContaining({ code: REAL_DATABASE_UNDER_TEST_CODE }));
    expect(readFileSync(path).equals(before), "nothing was migrated, sealed or stamped").toBe(true);
  });

  test("the refusal follows the database, not its path: a copy, a symlink and another name are refused the same", () => {
    const dir = createTempDir("real-db-spellings-");
    const original = join(dir, "web.db");
    productDatabase(original);
    const copy = join(dir, "renamed-copy.sqlite");
    copyFileSync(original, copy);
    const link = join(dir, "link.db");
    symlinkSync(original, link);
    for (const path of [copy, link, `${dir}/./web.db`]) {
      expect(() => new DbClient({ path }), path).toThrow(expect.objectContaining({ code: REAL_DATABASE_UNDER_TEST_CODE }));
    }
  });

  test("the timeline store refuses a product ledger before migrating it", () => {
    const dir = createTempDir("real-db-ledger-");
    const path = join(dir, "timeline.db");
    productDatabase(path);
    expect(() => createTimelineStore({ path, ledgerId: "real" })).toThrow(expect.objectContaining({ code: REAL_DATABASE_UNDER_TEST_CODE }));
    const raw = new DatabaseSync(path, { readOnly: true });
    try {
      expect((raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'schema_migrations'").get() as { n: number }).n, "no migration ran").toBe(0);
    } finally { raw.close(); }
  });

  test("a database a test creates is opened and stamped as the test's own; a fixture copy is opened and keeps its stamp", () => {
    const dir = createTempDir("real-db-own-");
    const own = join(dir, "own.db");
    const client = new DbClient({ path: own });
    expect(client.provenance).toBe("test");
    client.close();
    const reopened = new DbClient({ path: own });
    expect(reopened.provenance, "the test's own database stays its own").toBe("test");
    reopened.close();
    const fixture = join(dir, "fixture.db");
    const raw = new DatabaseSync(fixture);
    try { raw.exec("CREATE TABLE seed (v TEXT)"); markFixtureCopy(raw); } finally { raw.close(); }
    const opened = new DbClient({ path: fixture });
    expect(opened.provenance).toBe("fixture");
    opened.close();
  });

  test("the product's branch stamps an unstamped database it opens for writing, and keeps a fixture's stamp", () => {
    const dir = createTempDir("real-db-stamp-");
    const fresh = new DatabaseSync(join(dir, "fresh.db"));
    try {
      admitDatabaseProvenance(fresh, join(dir, "fresh.db"), "read", false);
      expect(databaseProvenanceOf(fresh), "a read-only open never stamps").toBe("unstamped");
      admitDatabaseProvenance(fresh, join(dir, "fresh.db"), "write", false);
      expect(databaseProvenanceOf(fresh)).toBe("product");
      expect(() => admitDatabaseProvenance(fresh, join(dir, "fresh.db"), "read", true)).toThrow(expect.objectContaining({ code: REAL_DATABASE_UNDER_TEST_CODE }));
      markFixtureCopy(fresh);
      admitDatabaseProvenance(fresh, join(dir, "fresh.db"), "write", false);
      expect(databaseProvenanceOf(fresh), "the product keeps a fixture a fixture").toBe("fixture");
    } finally { fresh.close(); }
    expect(() => admitDatabaseProvenance(new DatabaseSync(":memory:"), ":memory:", "write", true)).not.toThrow();
  });

  test("an UNSTAMPED database that holds data is refused under test outside the run's temporary root, and admitted inside it (SCALE-CR1-FIX N5)", () => {
    const dir = createTempDir("real-db-unstamped-");
    const path = join(dir, "legacy.db");
    const raw = new DatabaseSync(path);
    try { raw.exec("CREATE TABLE event_log (v TEXT); INSERT INTO event_log VALUES ('real')"); } finally { raw.close(); }
    const db = new DatabaseSync(path);
    try {
      const elsewhere = join(dir, "another-run-temporary-root");
      mkdirSync(elsewhere);
      expect(() => admitDatabaseProvenance(db, path, "read", true, elsewhere)).toThrow(expect.objectContaining({ code: REAL_DATABASE_UNDER_TEST_CODE }));
      expect(() => admitDatabaseProvenance(db, path, "write", true, elsewhere)).toThrow(expect.objectContaining({ code: REAL_DATABASE_UNDER_TEST_CODE }));
      expect(databaseProvenanceOf(db), "a refusal stamps nothing").toBe("unstamped");
      admitDatabaseProvenance(db, path, "write", true, dir);
      expect(databaseProvenanceOf(db), "a test's own fixture inside the temporary root is admitted as it is").toBe("unstamped");
    } finally { db.close(); }
  });

  test("through the real doors: a process under test whose temporary root does not hold the ledger refuses it before migrating, and changes no byte (SCALE-CR1-FIX N5)", () => {
    const dir = createTempDir("real-db-legacy-ledger-");
    const path = join(dir, "timeline.db");
    const raw = new DatabaseSync(path);
    try { raw.exec("CREATE TABLE event_log (v TEXT); INSERT INTO event_log VALUES ('real')"); } finally { raw.close(); }
    const before = readFileSync(path);
    const inner = join(dir, "tmp");
    mkdirSync(inner);
    const store = JSON.stringify(pathToFileURL(modulePath("engine/src/timeline/timeline-store.ts")).href);
    const result = runNativeScript(`
      process.env.TMPDIR = ${JSON.stringify(inner)};
      const { createTimelineStore, pendingTimelineMigrations } = await import(${store});
      const codes = [];
      for (const open of [() => pendingTimelineMigrations(${JSON.stringify(path)}), () => createTimelineStore({ path: ${JSON.stringify(path)}, ledgerId: "legacy" })]) {
        try { open(); codes.push("opened"); } catch (error) { codes.push(error.code); }
      }
      console.log(JSON.stringify(codes));
    `);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim().split("\n").at(-1)!)).toEqual([REAL_DATABASE_UNDER_TEST_CODE, REAL_DATABASE_UNDER_TEST_CODE]);
    expect(readFileSync(path).equals(before), "nothing was migrated or stamped").toBe(true);
  });

  test("a browser suite refuses a server that serves a real database, or that does not say", () => {
    expect(realServerRefusal({ status: "ok", database: "product" }, "http://127.0.0.1:5174")).toMatch(/serves a REAL database/u);
    expect(realServerRefusal({ status: "ok" }, "http://127.0.0.1:5174")).toMatch(/does not say whose database/u);
    expect(realServerRefusal({ status: "ok", database: "fixture" }, "x")).toBeNull();
    expect(realServerRefusal({ status: "ok", database: "test" }, "x")).toBeNull();
    expect(realServerRefusal({ status: "ok", database: "unstamped" }, "x"), "an unstamped database may be a real one from before the stamp").toMatch(/no test or fixture stamp/u);
  });

  test("both Playwright configs arm their run, the API server it starts keeps its own databases, and only the fixture door marks a fixture", () => {
    const e2e = readFileSync("playwright.config.ts", "utf8");
    const perf = readFileSync("playwright.perf.config.ts", "utf8");
    expect(e2e).toContain("const API_SERVER_STATE = armPlaywrightRun(import.meta.dirname);");
    expect(e2e).toContain("env: { ...API_SERVER_STATE },");
    expect(perf).toContain("armPlaywrightRun(import.meta.dirname);");
    const exts = [".ts", ".mts", ".mjs", ".js"];
    const markers = [...walk("server", { exts }), ...walk("engine/src", { exts }), ...walk("tests", { exts }), ...walk("scripts", { exts })]
      .filter((file) => !/\.test\.[cm]?[jt]s$/u.test(file))
      .filter((file) => /\bmarkFixtureCopy\(/u.test(readFileSync(file, "utf8")))
      .map((file) => file.replace(`${process.cwd()}/`, ""));
    expect(markers.toSorted()).toEqual([relative(process.cwd(), modulePath("database-provenance.ts")), "tests/performance/scale/prepare-fixture.ts"].toSorted());
  });
});
