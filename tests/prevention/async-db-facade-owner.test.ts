// @vitest-environment node
/**
 * Prevention test: THE FACADE IS COMPLETE, AND NOTHING IS UNCLASSIFIED.
 *
 * The async facade routes each call to the read pool or to the single writer
 * on the strength of `server/db/method-kinds.ts`. Two ways that goes wrong
 * silently, and one guard each:
 *
 *  1. A method is added to `DbClient` and nobody classifies it. The facade
 *     refuses to dispatch it — correct, but discovered at runtime by whichever
 *     route reaches it first, in production, as a 500. This walks
 *     `DbClient.prototype` and fails at build time instead.
 *
 *  2. A method is classified but never exposed on `AsyncDbClient`. The call
 *     site then has nowhere to go and reaches for the sync client, which is
 *     precisely the half-async data layer §2 exists to prevent — "everything
 *     that can be async" is not a slogan that survives one exception.
 *
 * And the third guard, the one that keeps the seam a seam: **no product module
 * outside `server/db/` may hold a synchronous `DbClient`.** The engine stays
 * synchronous — the workers need it — so the thing to forbid is not its
 * existence but its reach.
 */
import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { DbClient } from "../../server/db/client.ts";
import { AsyncDbClient } from "../../server/db/async-client.ts";
import {
  DB_READ_METHODS,
  DB_WRITE_METHODS,
  DB_FACADE_OWNED_METHODS,
  DB_UNDISPATCHED_MEMBERS,
  methodKind,
} from "../../server/db/method-kinds.ts";
import { walk, SOURCE_EXTS } from "../helpers/source-scan.ts";

const SERVER_ROOT = join(process.cwd(), "server");
const DB_OWNER_DIR = join(SERVER_ROOT, "db");

function isWithin(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..");
}

/** Public members of DbClient — everything on the prototype that is not
 * `#private` and not TypeScript-`private` (which is erased, so it shows up
 * here; those are listed explicitly in DB_UNDISPATCHED_MEMBERS or are named
 * with a leading understanding that they are internal). */
function dbClientMembers(): readonly string[] {
  return Object.getOwnPropertyNames(DbClient.prototype);
}

/** TS `private` is erased at runtime, so the prototype still carries these.
 * They are internal by declaration and never dispatched. */
const TS_PRIVATE_MEMBERS = new Set([
  "pageAllRows",
  "recordCheckStatusEvent",
  // The history cursor's internals (DESIGN-PERFORMANCE §4). The two DOORS —
  // `getChatHistoryPage` and `getChatMessagePage` — are classified as reads;
  // these three are the machinery behind them and are never dispatched.
  "pageMessagesBackwards",
  "toolCallsForMessages",
  "toolCallBytesByMessage",
  "tailRows",
]);

describe("the async facade classifies every DbClient method", () => {
  test("no public DbClient method is unclassified", () => {
    const unclassified = dbClientMembers().filter((name) => {
      if (TS_PRIVATE_MEMBERS.has(name)) return false;
      if ((DB_UNDISPATCHED_MEMBERS as readonly string[]).includes(name)) return false;
      if ((DB_FACADE_OWNED_METHODS as readonly string[]).includes(name)) return false;
      return methodKind(name) === null;
    });
    expect(
      unclassified,
      "add each of these to DB_READ_METHODS or DB_WRITE_METHODS in " +
        "server/db/method-kinds.ts — the facade refuses to guess",
    ).toEqual([]);
  });

  test("nothing is classified twice", () => {
    const seen = new Map<string, string[]>();
    for (const [list, label] of [
      [DB_READ_METHODS, "read"],
      [DB_WRITE_METHODS, "write"],
      [DB_FACADE_OWNED_METHODS, "facade-owned"],
    ] as const) {
      for (const name of list) seen.set(name, [...(seen.get(name) ?? []), label]);
    }
    const dupes = [...seen].filter(([, labels]) => labels.length > 1);
    expect(dupes).toEqual([]);
  });

  test("every classified method actually exists on DbClient", () => {
    const members = new Set(dbClientMembers());
    const missing = [...DB_READ_METHODS, ...DB_WRITE_METHODS, ...DB_FACADE_OWNED_METHODS].filter(
      (name) => !members.has(name),
    );
    expect(missing, "method-kinds.ts names a method DbClient does not have").toEqual([]);
  });

  test("every dispatched method is reachable through the facade", () => {
    // The facade is the ONLY door once the sync path is out of the product, so
    // a classified method with no facade method is a capability that exists and
    // cannot be used — which is how a call site ends up reaching around it.
    const facade = new Set(Object.getOwnPropertyNames(AsyncDbClient.prototype));
    // `createAutoCheckReturningTransition` is deliberately not exposed: the
    // facade's own `createAutoCheck` is the door, and exposing the half without
    // the ledger append would make it possible to write a check with no
    // recorded transition.
    const internalToFacade = new Set(["createAutoCheckReturningTransition"]);
    const missing = [...DB_READ_METHODS, ...DB_WRITE_METHODS, ...DB_FACADE_OWNED_METHODS].filter(
      (name) => !facade.has(name) && !internalToFacade.has(name),
    );
    expect(missing, "AsyncDbClient is missing a method for these").toEqual([]);
  });

  test("every facade data method returns a promise", async () => {
    // The whole standardization claim in one assertion. A method that returns a
    // value directly is the exception that makes every call site check.
    const db = AsyncDbClient.inline({ path: ":memory:" });
    try {
      const notPromises: string[] = [];
      for (const name of [...DB_READ_METHODS, ...DB_WRITE_METHODS, ...DB_FACADE_OWNED_METHODS]) {
        const fn = (db as unknown as Record<string, unknown>)[name];
        if (typeof fn !== "function") continue;
        // Called with no arguments on an empty database: most will reject, and
        // that is fine — a REJECTED promise is still a promise. What is being
        // checked is the return type, not the outcome.
        let result: unknown;
        try {
          result = (fn as () => unknown).call(db);
        } catch {
          notPromises.push(`${name} threw synchronously instead of rejecting`);
          continue;
        }
        if (!(result instanceof Promise)) notPromises.push(`${name} returned a non-promise`);
        else void (result as Promise<unknown>).catch(() => undefined);
      }
      expect(notPromises).toEqual([]);
    } finally {
      await db.close();
    }
  });
});

describe("the sync path does not reach outside the DB owner", () => {
  /** Server modules other than the DB owner itself. */
  const files = walk(SERVER_ROOT, { exts: SOURCE_EXTS }).filter((f) => !isWithin(f, DB_OWNER_DIR));

  /**
   * A source file that is not plain text is a file scanners SKIP.
   *
   * Found during the call-site migration: `blocks/custody.ts` and
   * `blocks/compose.ts` each held a RAW NUL byte as a cache-key separator
   * (`${chatId}\0${runId}` typed as the byte, not the escape). `grep -r`
   * classifies such a file as binary and reports nothing from it, so two
   * modules holding a synchronous `DbClient` were invisible to the migration
   * inventory. `tsc` caught one; re-running with `grep -a` caught the other.
   *
   * The guards in this file read with `readFileSync` and were never fooled —
   * which is exactly why this needs its own test. The interlock below decides
   * whether the THREADED backend may be live by scanning these same files; a
   * file no scan can see is a file that cannot hold the interlock shut.
   * Writing the separator as the two-character escape `\\0` keeps the runtime
   * key byte-identical and keeps the file readable by every tool.
   */
  test("every server source is plain text, so no scan can silently skip one", () => {
    const binary: string[] = [];
    for (const file of walk(SERVER_ROOT, { exts: SOURCE_EXTS })) {
      const bytes = readFileSync(file);
      // NUL is the byte `grep`, `git diff` and most scanners use to decide a
      // file is binary. Other C0 controls are equally invisible in review.
      if (bytes.includes(0)) binary.push(relative(process.cwd(), file));
    }
    expect(
      binary,
      "these files contain a raw NUL byte and are skipped by grep and by every " +
        "tool that sniffs for binary. Write the byte as the source escape \\0 — " +
        "the runtime value is identical and the file stays scannable",
    ).toEqual([]);
  });

  test("no server module outside server/db/ imports DatabaseSync", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      if (/from\s+["']node:sqlite["']/.test(text) || /\bDatabaseSync\b/.test(text)) {
        offenders.push(relative(process.cwd(), file));
      }
    }
    expect(
      offenders,
      "the SQLite driver belongs to server/db/ — everything else goes through AsyncDbClient",
    ).toEqual([]);
  });

  /**
   * The two structural guards, and why they are structural.
   *
   * Both properties below are invisible from outside the facade at runtime —
   * that is precisely what makes them dangerous, and it is also why a
   * behavioural test cannot reach them. Mutation testing found both: removing
   * `HARNESS_DB_WORKER` from the spawn, and opening the read pool read-write,
   * each left every behavioural test green. A guard nobody can break is not a
   * guard; a property nothing checks is not a property.
   */
  test("the DB workers are spawned with the ledger guard set", async () => {
    // Both halves, because the flag is assembled in one file and applied in
    // another: `config.ts` owns the only `process.env` read in the web slice,
    // and `thread-backend.ts` owns the only `new Worker(`. Checking just one
    // is how this guard went stale the first time — it named the literal
    // `HARNESS_DB_WORKER: "1"`, the read moved to the config owner, and the
    // guard started failing while the property it guards was still true.
    const { dbWorkerEnv, DB_WORKER_FLAG } = await import("../../server/kernel/config.ts");
    expect(
      dbWorkerEnv()[DB_WORKER_FLAG],
      "the config owner must mark a DB worker's environment",
    ).toBe("1");

    const source = readFileSync(join(DB_OWNER_DIR, "thread-backend.ts"), "utf8");
    const spawn = source.slice(source.indexOf("new Worker("));
    expect(
      /env:\s*dbWorkerEnv\(\)/.test(spawn),
      "worker threads must be started with dbWorkerEnv(), or a worker could open " +
        "the timeline ledger — a second writer on the chain hash, recording with " +
        "no ambient causality",
    ).toBe(true);
  });

  test("the read pool asks SQLite for read-only connections", () => {
    const source = readFileSync(join(DB_OWNER_DIR, "db-worker.ts"), "utf8");
    expect(
      /readOnly:\s*data\.role\s*===\s*"reader"/.test(source),
      'the reader role must open read-only. Otherwise "the pool never writes" is a ' +
        "promise kept by a lookup table rather than by the file handle, and a " +
        "misrouted write races the WAL's single writer instead of failing",
    ).toBe(true);
  });

  /**
   * THE INTERLOCK: the threaded backend may not be live while any call site
   * still holds the synchronous client.
   *
   * A half-converted server would keep a read-write connection on the main
   * thread (for the modules still using `DbClient`) AND a read-write
   * connection on the writer thread. Two writers on one SQLite file. WAL would
   * not corrupt anything; it would simply stop being true that "the ledger
   * entry before this one" is well defined, which is the property W1 exists to
   * preserve and the chain hash rests on.
   *
   * The temptation this refuses is precise and it will arrive: the measured
   * win is large, conversion is 137 call sites, and flipping the backend early
   * would show most of the win immediately. It would trade a measurable
   * latency gain for an unmeasurable correctness loss, which is the trade
   * DESIGN-PERFORMANCE exists to refuse. So the interlock is checked rather
   * than remembered — and it INVERTS on its own once the last synchronous call
   * site is gone, at which point this test starts requiring the threaded
   * backend instead of forbidding it.
   */
  test("the server facade is threaded only once no call site holds the sync client", async () => {
    const stillSync = files.filter((f) => {
      const text = readFileSync(f, "utf8");
      return /\bDbClient\b/.test(text);
    });
    const { getOrCreateAsyncDb } = await import("../../server/db/index.ts");
    const offThread = getOrCreateAsyncDb(":memory:").isOffThread;

    if (stillSync.length > 0) {
      expect(
        offThread,
        `${stillSync.length} server modules still hold a synchronous DbClient ` +
          "(e.g. " +
          stillSync.slice(0, 3).map((f) => relative(process.cwd(), f)).join(", ") +
          "). The facade must stay INLINE until they are converted, or the process " +
          "runs two writers against one file.",
      ).toBe(false);
    } else {
      expect(
        offThread,
        "every call site is on the facade, so the backend must now be threaded — " +
          "otherwise the whole conversion bought nothing",
      ).toBe(true);
    }
  });

  test("no server module outside server/db/ constructs a DbClient", () => {
    // The engine stays synchronous because the workers need it. What must not
    // happen is a route, bridge or block opening one of its own — that is a
    // connection outside the pool, blocking the request thread, and invisible
    // to every ordering guarantee the facade makes.
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const [i, line] of text.split("\n").entries()) {
        if (line.trimStart().startsWith("*") || line.trimStart().startsWith("//")) continue;
        if (/\bnew\s+DbClient\s*\(/.test(line)) {
          offenders.push(`${relative(process.cwd(), file)}:${i + 1}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
