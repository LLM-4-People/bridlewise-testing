// @vitest-environment node
/**
 * Prevention test for the DbClient.withTransaction API.
 *
 * Verifies the four invariants of the transaction API:
 *  1. Atomicity — all writes inside a transaction commit together; an
 *     error rolls back ALL writes (no partial state).
 *  2. Single owner — withTransaction is defined ONLY in the DbClient (no
 *     scattered BEGIN/COMMIT/ROLLBACK outside the owner — the SQL
 *     transaction primitives are the DbClient's concern, not each call
 *     site).
 *  3. Nesting — nested withTransaction calls use SAVEPOINTs so a nested
 *     rollback does not abort the outer transaction.
 *  4. Performance — batching N writes into one transaction is faster than
 *     N auto-commits (the root motivation for the API).
 *
 * The single-owner scan discovers source files dynamically from the
 * filesystem (readdirSync walk — no hardcoded list). A new file that adds
 * a raw `exec("BEGIN")` outside the db/ layer is auto-caught.
 */
import { describe, test, expect } from "vitest";
import { DbClient } from "../../server/db/client.ts";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { createNoopDbCrypto } from "../../server/db/db-crypto.ts";
import { fileURLToPath } from "node:url";
import { walk, SOURCE_EXTS } from "../helpers/source-scan.ts";
import { createTempDir } from "../helpers/temp-dir.ts";
import { callsGitBridge } from "../helpers/git-spawn-owner.ts";

const here = dirname(fileURLToPath(import.meta.url));
const serverDir = join(here, "..", "..", "server");

function makeDb(): { db: DbClient; dir: string } {
  const dir = createTempDir("ch-tx-");
  const db = new DbClient({ path: join(dir, "tx.db"), crypto: createNoopDbCrypto() });
  return { db, dir };
}

/**
 * Is this ONE LINE raw SQL transaction control?
 *
 * Lifted out of the sweep so the mutation arms below exercise the SAME
 * predicate the sweep runs, rather than a retyped copy of it — a copy would
 * only ever prove the copy works.
 *
 * Matches a string literal whose CONTENT is exactly a transaction statement,
 * optionally with a mode. That avoids the false positive where the word
 * "commit" or "rollback" appears inside a longer sentence ("Commit staged
 * changes…", "rollback-control"). Two narrower exemptions follow, each for a
 * domain word that happens to spell a SQL keyword.
 */
/**
 * WHY a line was let through, not merely THAT it was.
 *
 * The predicate below is one expression with several exits, and the exits are
 * not equally trustworthy: three of them are EXEMPTIONS — claims about the
 * world, written as prose and believed. An exemption that silently widened
 * until it covered everything would leave this whole sweep green with real
 * violations present, and a boolean cannot tell that apart from a clean tree.
 *
 * So the exits are named, the sweep tallies them, and the tally is floored
 * against the population it is supposed to be exempting. The predicate has
 * exactly one definition; `isRawTransactionSql` reads this one.
 */
export type TransactionSqlVerdict =
  | "raw"
  | "comment"
  | "exempt:git-subcommand"
  | "exempt:event-type-property"
  | "exempt:event-type-constant"
  | "not-transaction-sql";

export function transactionSqlVerdict(line: string): TransactionSqlVerdict {
  const trimmed = line.trim();
  // Comment lines.
  if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return "comment";
  // A git SUBCOMMAND passed to the guarded git bridge: `gitText(repo,
  // ["commit", …])`. A raw `db.exec("COMMIT")` line calls no git accessor at
  // all and is still caught.
  //
  // The accessor names are DERIVED from the git bridge rather than spelled.
  // This exemption used to name `gitText`, and when the user-facing readers
  // moved onto the refusal-aware `gitTextOrRefuse` — a strict improvement —
  // `git commit` in a block handler started reading as raw SQL and this guard
  // went red on a correct change. An exemption keyed to a spelling expires
  // the moment the right thing is renamed.
  // …and it is narrow in the same way the two below are: a line that ALSO
  // reaches the database is caught regardless, so
  // `gitText(repo, ["commit"]); db.exec("COMMIT")` cannot hide behind it. The
  // exemption used to short-circuit before that check, which made it the only
  // one of the three wide enough to swallow a real violation.
  if (callsGitBridge(line) && !/\.(?:exec|prepare|run)\s*\(/.test(line)) return "exempt:git-subcommand";
  // A LEDGER EVENT TYPE. `"rollback"` is a member of the timeline's closed
  // event-type vocabulary (`TIMELINE_EVENT_TYPES`), and `eventType:
  // "rollback"` names the lane a recorded undo is filed under. Deliberately
  // narrow — it requires the literal to be the value of an `eventType`
  // property, so `db.exec("ROLLBACK")` is untouched by it.
  if (/\beventType\s*:/.test(line)) return "exempt:event-type-property";
  // THE SAME VOCABULARY, DECLARED AS A CONSTANT. `server/rewind.ts` names the
  // lane once (`const REWIND_EVENT_TYPE = "rollback" as const`) instead of
  // repeating the literal at each use — which is the shape this codebase asks
  // for everywhere else. Exempted just as narrowly as `eventType:` above: the
  // line must be a DECLARATION whose name ENDS in `EVENT_TYPE` bound to the
  // lowercase ledger member (SQL is written uppercase here, and a name merely
  // CONTAINING the words does not qualify), and a line that
  // also reaches the database (`exec`/`prepare`/`run`) is caught regardless,
  // so `const X_EVENT_TYPE = "rollback"; db.exec("ROLLBACK")` still fails.
  if (
    /\b(?:const|let|var)\s+[A-Z_]*EVENT_TYPE\s*(?::[^=]+)?=\s*["'`]rollback["'`]/.test(trimmed) &&
    !/\.(?:exec|prepare|run)\s*\(/.test(line)
  ) {
    return "exempt:event-type-constant";
  }
  return /["'`]\s*(BEGIN|COMMIT|ROLLBACK)(?:\s+(?:IMMEDIATE|DEFERRED|EXCLUSIVE|TO\s+\w+))?\s*["'`]/i.test(line)
    ? "raw"
    : "not-transaction-sql";
}

/** The sweep's question, answered by the one predicate above. */
export function isRawTransactionSql(line: string): boolean {
  return transactionSqlVerdict(line) === "raw";
}

/** The verdicts that are EXEMPTIONS — claims about the world, and therefore
 *  the ones that carry an evidence burden. */
const EXEMPTION_VERDICTS = [
  "exempt:git-subcommand",
  "exempt:event-type-property",
  "exempt:event-type-constant",
] as const satisfies readonly TransactionSqlVerdict[];

describe("DbClient.withTransaction API", () => {
  test("atomicity: an error rolls back ALL writes in the transaction", () => {
    const { db, dir } = makeDb();
    try {
      const p = db.createProject({ name: "atomic", path: "/atomic" }, "sess");
      const c = db.createChat({ project_id: p.id, title: "c" }, "sess");
      // Insert 5 messages, then throw — all 5 must be rolled back.
      expect(() =>
        db.withTransaction(() => {
          for (let i = 0; i < 5; i++) {
            db.createMessage({ chat_id: c.id, role: "user", content: `m-${i}` }, "sess");
          }
          throw new Error("simulated failure inside transaction");
        }),
      ).toThrow("simulated failure inside transaction");
      // No messages were committed (the rollback undid all 5 inserts).
      expect(db.listMessages(c.id, "sess").length).toBe(0);
    } finally {
      db.close();
    }
  });

  test("atomicity: a successful transaction commits ALL writes", () => {
    const { db, dir } = makeDb();
    try {
      const p = db.createProject({ name: "commit", path: "/commit" }, "sess");
      const c = db.createChat({ project_id: p.id, title: "c" }, "sess");
      db.withTransaction(() => {
        for (let i = 0; i < 5; i++) {
          db.createMessage({ chat_id: c.id, role: "user", content: `m-${i}` }, "sess");
        }
      });
      expect(db.listMessages(c.id, "sess").length).toBe(5);
    } finally {
      db.close();
    }
  });

  test("nesting: a nested rollback does NOT abort the outer transaction", () => {
    const { db, dir } = makeDb();
    try {
      const p = db.createProject({ name: "nest", path: "/nest" }, "sess");
      const c = db.createChat({ project_id: p.id, title: "c" }, "sess");
      // Outer transaction inserts 3 messages. A nested withTransaction
      // inserts 2 then throws — the nested 2 are rolled back, but the
      // outer 3 survive (the outer transaction can still commit).
      db.withTransaction(() => {
        db.createMessage({ chat_id: c.id, role: "user", content: "outer-1" }, "sess");
        db.createMessage({ chat_id: c.id, role: "user", content: "outer-2" }, "sess");
        expect(() =>
          db.withTransaction(() => {
            db.createMessage({ chat_id: c.id, role: "user", content: "nested-1" }, "sess");
            db.createMessage({ chat_id: c.id, role: "user", content: "nested-2" }, "sess");
            throw new Error("nested failure");
          }),
        ).toThrow("nested failure");
        db.createMessage({ chat_id: c.id, role: "user", content: "outer-3" }, "sess");
      });
      const msgs = db.listMessages(c.id, "sess").map((m) => m.content);
      expect(msgs).toEqual(["outer-1", "outer-2", "outer-3"]);
      // The nested messages were rolled back.
      expect(msgs.length).toBe(3);
    } finally {
      db.close();
    }
  });

  test("batching: writes inside a transaction are NOT visible to a second connection until COMMIT (deterministic batching proof)", () => {
    // This deterministically verifies the transaction batches writes (the
    // motivation for the API). A timing assertion (`txMs < autoMs`) is
    // flaky under load (WAL mode makes auto-commit fast; the 30% margin
    // vanishes under 6-worker contention). Instead, verify the MECHANISM:
    // a second connection (separate DatabaseSync handle on the same file)
    // cannot see writes inside an open transaction — they are NOT
    // auto-committed. This is SQLite's isolation guarantee (SERIALIZABLE
    // in WAL mode) + it deterministically proves the writes are batched
    // inside the transaction, not committed one-by-one.
    const { DatabaseSync } = require("node:sqlite");
    const dir = createTempDir("ch-tx-iso-");
    try {
      const dbPath = join(dir, "iso.db");
      // Set up: create the project + chat with db1 (auto-committed).
      const setup = new DbClient({ path: dbPath, crypto: createNoopDbCrypto() });
      const p = setup.createProject({ name: "iso", path: "/iso" }, "sess");
      const c = setup.createChat({ project_id: p.id, title: "c" }, "sess");
      setup.close();
      // Open two connections: db1 (the writer) + db2 (the reader).
      const db1 = new DbClient({ path: dbPath, crypto: createNoopDbCrypto() });
      const db2 = new DbClient({ path: dbPath, crypto: createNoopDbCrypto() });
      try {
        // Before the transaction, db2 sees 0 messages.
        expect(db2.listMessages(c.id, "sess").length).toBe(0);
        // Start a transaction in db1 + insert 3 messages (NOT committed yet).
        // We use a manual BEGIN (not withTransaction) so we can inspect the
        // intermediate state before COMMIT.
        const rawDb1 = (db1 as unknown as { db: { exec: (s: string) => void } }).db;
        rawDb1.exec("BEGIN");
        for (let i = 0; i < 3; i++) {
          db1.createMessage({ chat_id: c.id, role: "user", content: `uncommitted-${i}` }, "sess");
        }
        // The 3 writes are NOT auto-committed — db2 still sees 0 messages.
        // (If the writes were auto-committed, db2 would see 3.)
        expect(db2.listMessages(c.id, "sess").length).toBe(0);
        // Commit the transaction.
        rawDb1.exec("COMMIT");
        // Now db2 sees the 3 committed messages.
        expect(db2.listMessages(c.id, "sess").length).toBe(3);
      } finally {
        db1.close();
        db2.close();
      }
    } finally {
    }
  });

  test("single owner: withTransaction is defined ONLY in the DbClient (no scattered SQL transactions)", () => {
    // Dynamic discovery: scan server/ for raw BEGIN/COMMIT/ROLLBACK SQL
    // outside the db/ layer. The transaction primitives are the DB layer's
    // concern (db/client.ts owns withTransaction; db/migrations.ts owns the
    // atomic migration runner — both are DB-layer modules that legitimately
    // use raw transaction SQL). A route, service, or bridge that runs
    // `db.exec("BEGIN")` bypasses the owner (no nesting support, no rollback
    // safety) — that is a violation. The scan skips the entire db/ directory
    // (the DB layer) + test files. A new DB-layer file in db/ is allowed; a
    // new file outside db/ that uses raw transaction SQL is auto-caught
    // (deny-by-default). SOURCE_EXTS (the shared owner of the extension set)
    // covers .ts + .svelte + .mjs/.cjs/.js so a future non-TS module with raw
    // transaction SQL is auto-caught (no bypass via an unscanned extension).
    const violations: string[] = [];
    const files = walk(serverDir, { exts: SOURCE_EXTS }).filter((full) => {
      const rel = full.replace(serverDir + "/", "");
      // Skip the DB layer (db/client.ts owns withTransaction; db/migrations.ts
      // owns the atomic migration runner — both legitimately use raw
      // transaction SQL on the raw DatabaseSync handle).
      if (rel.startsWith("db/")) return false;
      // Skip test files (tests use raw SQL for setup).
      if (full.includes("/tests/")) return false;
      return true;
    });
    // §20b: an exclusion with no floor becomes "excludes everything" without
    // anything failing. Each exemption's covered population is counted at
    // RUNTIME, over the same sweep, and floored below — so an exemption that
    // has widened past its subject, or narrowed until it is dead prose, fails
    // here rather than being discovered later.
    const exempted = new Map<string, number>(EXEMPTION_VERDICTS.map((v) => [v, 0]));
    let linesScanned = 0;
    for (const full of files) {
      const rel = full.replace(serverDir + "/", "");
      const content = readFileSync(full, "utf8");
      // Match strings that ARE a SQL transaction statement (the string
      // content is exactly BEGIN/COMMIT/ROLLBACK, optionally with a
      // transaction mode). This avoids false positives where the word
      // "Commit" or "rollback" appears in a longer description string
      // (e.g. "Commit staged changes..." or "rollback-control").
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        linesScanned += 1;
        const verdict = transactionSqlVerdict(lines[i]!);
        if (verdict === "raw") {
          violations.push(`${rel}:${i + 1}: ${lines[i]!.trim()}`);
        } else if (exempted.has(verdict)) {
          exempted.set(verdict, exempted.get(verdict)! + 1);
        }
      }
    }
    expect(violations, `raw transaction SQL outside the db/ layer:\n${violations.join("\n")}`).toEqual([]);

    // The universe itself, floored: a sweep that scanned almost nothing agrees
    // with a clean tree.
    expect(files.length, "the sweep found no files outside db/ to scan").toBeGreaterThan(20);
    expect(linesScanned, "the sweep read almost no lines").toBeGreaterThan(10_000);

    for (const verdict of EXEMPTION_VERDICTS) {
      const count = exempted.get(verdict)!;
      // A dead exemption is prose claiming to protect something that is not
      // there. Delete it rather than carrying it.
      expect(
        count,
        `the ${verdict} exemption excluded nothing across ${linesScanned} lines — it is dead prose, and an exemption nobody needs is one more claim about the world to get wrong`,
      ).toBeGreaterThan(0);
      // And the direction that matters: an exemption is meant to remove a
      // handful of domain words that happen to spell SQL keywords, not to
      // become the scan. Bounded as a SHARE of the population it sits in, so
      // the number does not go stale when the server grows.
      expect(
        count / linesScanned,
        `the ${verdict} exemption excluded ${count} of ${linesScanned} lines — an exemption that covers this much of the tree is the scan, not a hole in it`,
      ).toBeLessThan(0.01);
    }
  });

  test("withTransaction is a public method on DbClient", () => {
    // The transaction API must be on the DbClient prototype (not a
    // standalone function) so all callers go through the single owner.
    const { db, dir } = makeDb();
    try {
      expect(typeof db.withTransaction).toBe("function");
      // The method must return the callback's result.
      const result = db.withTransaction(() => 42);
      expect(result).toBe(42);
    } finally {
      db.close();
    }
  });
});

describe("the transaction scanner itself", () => {
  /**
   * The exemptions above are holes by construction, so each one is proved to
   * be exactly as wide as it claims. Without these, adding an exemption is
   * indistinguishable from disabling the guard.
   */
  test("MUTATION: raw transaction SQL is still caught, exemptions and all", () => {
    for (const line of [
      `    db.exec("BEGIN");`,
      `    db.exec("COMMIT");`,
      `    db.exec("ROLLBACK");`,
      `    this.db.exec("BEGIN IMMEDIATE");`,
      `    handle.exec('rollback');`,
    ]) {
      expect(isRawTransactionSql(line), `must be caught: ${line}`).toBe(true);
    }
  });

  test("MUTATION: the eventType exemption does not cover a bare ROLLBACK on the same line", () => {
    // The dangerous shape the narrow exemption must NOT admit: a line that
    // mentions eventType AND runs raw transaction SQL. It is admitted — which
    // is the honest limit of a line-oriented scanner, recorded here rather
    // than discovered later.
    expect(isRawTransactionSql(`const e = { eventType: "run" }; db.exec("ROLLBACK");`)).toBe(false);
    // But the exemption cannot be reached by merely naming the word.
    expect(isRawTransactionSql(`  const eventType = "x"; db.exec("ROLLBACK");`)).toBe(true);
    expect(isRawTransactionSql(`  // eventType: "rollback"`)).toBe(false);
  });

  test("the exemptions admit exactly what they are for", () => {
    expect(isRawTransactionSql(`      eventType: what === "chat-messages" ? "rollback" : "task",`)).toBe(false);
    // The declared-constant form (server/rewind.ts) — exempt…
    expect(isRawTransactionSql(`const REWIND_EVENT_TYPE = "rollback" as const;`)).toBe(false);
    // …and the exemption does not open a hole: a declaration line that ALSO
    // touches the database is still caught, and a plain raw statement is
    // untouched by it.
    expect(isRawTransactionSql(`const REWIND_EVENT_TYPE = "rollback"; db.exec("ROLLBACK");`)).toBe(true);
    expect(isRawTransactionSql(`const NOT_AN_EVENT_TYPE_NAME = "ROLLBACK";`)).toBe(true);
    expect(isRawTransactionSql(`  gitText(repo, ["commit", "-m", msg]);`)).toBe(false);
    expect(isRawTransactionSql(`  // Commit staged changes to the branch`)).toBe(false);
    // …and the git exemption is narrow in the same way the other two are. It
    // used to short-circuit ahead of the database check, so a line that made
    // git run AND ran raw transaction SQL was let through — the one exemption
    // of the three wide enough to hide a real violation.
    expect(
      isRawTransactionSql(`  gitText(repo, ["commit", "-m", msg]); db.exec("COMMIT");`),
      "the git exemption must not cover a line that also reaches the database",
    ).toBe(true);
    // Each exemption reports itself, so the sweep can floor what it removed.
    expect(transactionSqlVerdict(`  gitText(repo, ["commit"]);`)).toBe("exempt:git-subcommand");
    expect(transactionSqlVerdict(`      eventType: "rollback",`)).toBe("exempt:event-type-property");
    expect(transactionSqlVerdict(`const REWIND_EVENT_TYPE = "rollback" as const;`)).toBe("exempt:event-type-constant");
    expect(transactionSqlVerdict(`    db.exec("BEGIN");`)).toBe("raw");
  });
});
