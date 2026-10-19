/**
 * THE WAL JOURNAL OWNER (`src/filesystem/sqlite-wal.ts`), deterministically
 * (a3-correctness M-3: the barrier race tests caught a broken wait only one
 * run in three). A connection whose WAL switch is refused SQLITE_BUSY (the
 * deadlock-avoidance answer SQLite gives without its busy handler) waits by
 * taking the write lock from nothing (`BEGIN IMMEDIATE`/`ROLLBACK`) and asks
 * again, within its busy timeout; the extended BUSY codes are the same
 * answer; any other failure, and a BUSY past the deadline, is thrown as it is.
 */
import assert from "node:assert/strict";
import { dirname, join, relative } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { establishWalJournal } from "../../src/filesystem/sqlite-wal.ts";
import { readSourceView } from "../../scripts/verification/source-view.ts";
import { walk } from "../../scripts/verification/source-walk.ts";

/** A connection whose WAL switch fails with `failures` in turn, then succeeds; it records every statement. */
function stubConnection(failures: readonly unknown[]): Readonly<{ db: DatabaseSync; statements: string[] }> {
  const statements: string[] = [];
  let next = 0;
  const db = {
    exec(sql: string): void {
      statements.push(sql);
      if (sql === "PRAGMA journal_mode = WAL" && next < failures.length) throw failures[next++];
    },
  } as unknown as DatabaseSync;
  return { db, statements };
}

const busy = (errcode: number) => Object.assign(new Error("database is locked"), { errcode });

test("sqlite wal: a BUSY switch (plain or extended) waits through BEGIN IMMEDIATE/ROLLBACK and asks again", () => {
  const { db, statements } = stubConnection([busy(5), busy(517)]);
  establishWalJournal(db, 60_000);
  assert.deepEqual(statements, [
    "PRAGMA journal_mode = WAL", "BEGIN IMMEDIATE", "ROLLBACK",
    "PRAGMA journal_mode = WAL", "BEGIN IMMEDIATE", "ROLLBACK",
    "PRAGMA journal_mode = WAL",
  ]);
});

test("sqlite wal: any other failure is thrown as it is; a BUSY past the deadline is the last refusal", () => {
  const other = Object.assign(new Error("disk I/O error"), { errcode: 10 });
  const failing = stubConnection([other]);
  assert.throws(() => establishWalJournal(failing.db, 60_000), (error: unknown) => error === other);
  assert.deepEqual(failing.statements, ["PRAGMA journal_mode = WAL"], "no wait for a failure that is not BUSY");
  const late = busy(5);
  const expired = stubConnection([late]);
  assert.throws(() => establishWalJournal(expired.db, 0), (error: unknown) => error === late);
  assert.deepEqual(expired.statements, ["PRAGMA journal_mode = WAL"], "no wait past the busy timeout");
});

test("sqlite wal: every store enters WAL through the one owner (a3-design M1) — no other source spells the switch", () => {
  const engine = join(import.meta.dirname, "..", "..");
  const repository = dirname(engine);
  const spelled: string[] = [];
  let scanned = 0;
  for (const root of [join(engine, "src"), join(engine, "scripts"), join(repository, "server"), join(repository, "shared")]) {
    for (const file of walk(root, { exts: [".ts", ".mts", ".mjs"] })) {
      if (file.endsWith(".test.ts")) continue;
      scanned += 1;
      const code = readSourceView(file).codeWithStrings();
      if (/journal_mode\s*=\s*['"]?WAL/iu.test(code) && !file.endsWith(join("filesystem", "sqlite-wal.ts"))) spelled.push(relative(repository, file));
    }
  }
  assert.ok(scanned > 300, `the scan saw the real sources (${scanned})`);
  assert.deepEqual(spelled, [], "enter WAL through establishWalJournal (engine/src/filesystem/sqlite-wal.ts)");
});
