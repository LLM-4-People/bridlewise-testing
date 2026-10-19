// @vitest-environment node
/**
 * Prevention test: the web DB's DURABILITY IS CHOSEN, AND ITS EXPOSURE
 * WINDOW IS BOUNDED BY TIME AND STATED. (DESIGN-PERFORMANCE §2, §6 item 2.)
 *
 * ── The defect ──
 *
 * `server/db/client.ts` set `journal_mode = WAL` and said nothing about
 * `synchronous`, so SQLite's compiled-in default (FULL) applied: a value
 * nobody in this codebase chose, costing an fsync per commit. Measured on
 * real ext4 (NOT `os.tmpdir()`, which is tmpfs where fsync is a no-op —
 * 0.002ms there against 5.04ms on the project disk):
 *
 *     createMessage, auto-commit             11.05 ms
 *       ↳ the INSERT alone                    5.04 ms
 *       ↳ the chats.updated_at UPDATE alone   5.03 ms
 *       ↳ everything that is not fsync       ~17 µs
 *
 * ── Why this needs a guard and not just a commit ──
 *
 * `synchronous=NORMAL` is only defensible because the loss window is
 * BOUNDED. SQLite's own `wal_autocheckpoint` does not bound it: it fires on
 * a WAL PAGE COUNT, so a database that takes a few writes and goes quiet can
 * hold them unsynced for the life of the process. A future edit that removes
 * the checkpoint timer, or sets the window to 0, would leave the speed and
 * silently remove the bound — the setting would still read `NORMAL` and
 * nothing would look wrong.
 *
 * ── What is verified ──
 *
 * A. The choice is made, configured, and OBSERVED (read off the connection,
 *    not echoed from what was asked for — `PRAGMA synchronous` is
 *    per-connection, so a probe connection reports its own default and
 *    proves nothing).
 * B. The window exists, is bounded by TIME, and fires on its own clock with
 *    a WAL far below `wal_autocheckpoint`'s page threshold.
 * C. Under FULL no timer is armed (the window it would bound is zero), and
 *    an explicit setting beats the config default.
 * D. What durability may NOT cost: nothing about what is WRITTEN changes.
 *    Rows survive a close/reopen; foreign keys and WAL mode are untouched.
 * E. The timer never keeps the process alive.
 *
 * ── Mutation-verified ──
 * Removing `PRAGMA synchronous` from the constructor makes A FAIL.
 * Setting the window to 0 (or deleting the timer) makes B FAIL.
 * Arming the timer under FULL makes C FAIL.
 * Dropping `.unref()` makes E FAIL.
 */
import { describe, test, expect, beforeEach } from "vitest";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { DbClient } from "../../server/db/client.ts";
import {
  serverConfig,
  DEFAULT_DB_SYNCHRONOUS,
  DEFAULT_DB_DURABILITY_WINDOW_MS,
} from "../../server/kernel/config.ts";
import { createNoopDbCrypto } from "../../server/db/db-crypto.ts";
import { createTempDir } from "../helpers/temp-dir.ts";

let tmpRoot = "";

beforeEach(() => {
  tmpRoot = createTempDir("db-durability-");
});

function dbAt(name: string, extra: Record<string, unknown> = {}): DbClient {
  return new DbClient({ path: join(tmpRoot, name), crypto: createNoopDbCrypto(), ...extra });
}

/** Seed a chat and append `n` messages; return the main-db size afterwards. */
function seedAndSize(db: DbClient, path: string, n: number): number {
  const project = db.createProject({ name: "p", path: "/p" }, "u");
  const chat = db.createChat({ project_id: project.id, title: "c" }, "u");
  for (let i = 0; i < n; i += 1) {
    db.createMessage({ chat_id: chat.id, role: "user", content: `m-${i}` }, "u");
  }
  return statSync(path).size;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("A. the durability choice is made, configured, and observed", () => {
  test("the config owns the value and the window, and both are real numbers", () => {
    expect(DEFAULT_DB_SYNCHRONOUS).toBe("NORMAL");
    expect(DEFAULT_DB_DURABILITY_WINDOW_MS).toBeGreaterThan(0);
    expect(serverConfig.dbSynchronous).toBe(DEFAULT_DB_SYNCHRONOUS);
    expect(serverConfig.dbDurabilityWindowMs).toBe(DEFAULT_DB_DURABILITY_WINDOW_MS);
  });

  test("the connection REPORTS the configured setting (not the SQLite default)", () => {
    const db = dbAt("a.db");
    try {
      // Read back off the connection itself. FULL is what an uninstructed
      // connection reports, so seeing NORMAL here is the whole proof.
      expect(db.durability.synchronous).toBe("NORMAL");
      expect(db.durability.windowMs).toBe(DEFAULT_DB_DURABILITY_WINDOW_MS);
    } finally {
      db.close();
    }
  });
});

describe("B. the exposure window is bounded by TIME", () => {
  test("a checkpoint runs on the timer's clock, with the WAL far below wal_autocheckpoint", async () => {
    const path = join(tmpRoot, "b.db");
    const db = dbAt("b.db", { durabilityWindowMs: 20 });
    try {
      const before = seedAndSize(db, path, 5);
      const walBytes = existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0;
      expect(
        Math.floor(walBytes / 4096),
        "the WAL must be below wal_autocheckpoint's 1000-page threshold, or SQLite's " +
          "own SIZE bound could be what check-pointed and this proves nothing about TIME",
      ).toBeLessThan(1000);

      await sleep(300);
      expect(
        statSync(path).size,
        "a PASSIVE checkpoint copies WAL frames into the main file, so the main file " +
          "growing is the evidence the window fired. Without it, a quiet database " +
          "holds its writes unsynced for as long as the process runs",
      ).toBeGreaterThan(before);
    } finally {
      db.close();
    }
  });

  test("a window of 0 is a STATED absence of a bound, not a hidden one", () => {
    const db = dbAt("b0.db", { durabilityWindowMs: 0 });
    try {
      expect(
        db.durability.windowMs,
        "0 must be reported as 0 — an unbounded window that reported the config " +
          "default would be a durability claim nobody could check",
      ).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe("C. FULL is still available, and arms nothing", () => {
  test("an explicit synchronous beats the config default", () => {
    const db = dbAt("c.db", { synchronous: "FULL" });
    try {
      expect(db.durability.synchronous).toBe("FULL");
      expect(db.durability.windowMs, "under FULL the window is genuinely zero").toBe(0);
    } finally {
      db.close();
    }
  });

  test("under FULL no checkpoint runs on a timer", async () => {
    const path = join(tmpRoot, "c2.db");
    const db = dbAt("c2.db", { synchronous: "FULL", durabilityWindowMs: 20 });
    try {
      const before = seedAndSize(db, path, 5);
      await sleep(300);
      expect(
        statSync(path).size,
        "if the main file grew, a timer was armed to bound a window that does not exist",
      ).toBe(before);
    } finally {
      db.close();
    }
  });
});

describe("D. what durability may NOT cost — the writing itself is unchanged", () => {
  test("every row survives a close and reopen", () => {
    const path = join(tmpRoot, "d.db");
    const first = dbAt("d.db");
    const project = first.createProject({ name: "p", path: "/p" }, "u");
    const chat = first.createChat({ project_id: project.id, title: "c" }, "u");
    for (let i = 0; i < 25; i += 1) {
      first.createMessage({ chat_id: chat.id, role: "user", content: `m-${i}` }, "u");
    }
    first.close();

    const second = new DbClient({ path, crypto: createNoopDbCrypto() });
    try {
      expect(
        second.listMessages(chat.id, "u").map((m) => m.content),
        "NORMAL changes WHEN bytes are flushed, never whether they are written",
      ).toEqual(Array.from({ length: 25 }, (_, i) => `m-${i}`));
    } finally {
      second.close();
    }
  });

  test("WAL mode and foreign keys are untouched by the durability change", () => {
    const db = dbAt("d2.db");
    try {
      const raw = (db as unknown as { db: { prepare: (s: string) => { get: () => unknown } } }).db;
      expect((raw.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
      expect(Number((raw.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys)).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe("E. the window timer never holds the process open", () => {
  test("an open DbClient adds no ref'd handle to the event loop", () => {
    // `getActiveResourcesInfo()` lists only handles KEEPING THE LOOP ALIVE.
    // A ref'd interval would make every test run — and every CLI invocation —
    // a process that never exits.
    const before = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    const db = dbAt("e.db");
    try {
      expect(
        process.getActiveResourcesInfo().filter((r) => r === "Timeout").length,
      ).toBe(before);
    } finally {
      db.close();
    }
  });
});
