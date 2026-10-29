// @vitest-environment node
/**
 * Prevention test: THE THREE ORDERINGS THE FACADE MUST RE-ESTABLISH.
 *
 * When every database call was synchronous, ordering was free. Nobody wrote it
 * down because nobody could break it. Moving the work onto a read pool and a
 * writer thread takes all three away at once, so each is asserted here against
 * a REAL threaded facade — never the inline backend, which satisfies all of
 * them trivially and would therefore prove nothing.
 *
 *   W1  write ordering            — the ledger's chain hash depends on it
 *   W2  read-your-writes          — within a request, without awaiting
 *   W3  ledger sequence           — one ledger writer, on the main thread
 *
 * The two properties that make the architecture SAFE rather than merely fast —
 * the read pool physically cannot write, and the WAL stays bounded under
 * sustained writes with readers active — are the subject of the file on disk
 * rather than of the dispatch boundary, and live in `db-wal-bounded.test.ts`.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach } from "vitest";
import { join } from "node:path";

import { AsyncDbClient } from "../../server/db/async-client.ts";
import { DbClient } from "../../server/db/client.ts";
import { createTempDir } from "../helpers/temp-dir.ts";

type Fixture = Readonly<{ db: AsyncDbClient; userId: string; chatId: string; dir: string }>;

/**
 * Facades a single test opened for itself, closed when that test ends.
 *
 * Opening one costs ~0.5s of pure thread spawn — a writer plus four readers,
 * each loading the DB worker's module graph — and this file used to pay it
 * ELEVEN times, which is most of what made it the single most expensive file
 * in the suite. Only the tests whose subject IS a facade's own file or
 * lifecycle need a private one now; every ordering test shares the one below,
 * isolating itself with a fresh user/project/chat instead of a fresh pool.
 *
 * That substitution is not a weakening: W1/W2/W3 are properties of the
 * dispatch boundary, and the boundary is the same boundary whether the rows
 * on the far side of it are the only ones in the database or not. What each
 * test must not share is its ROWS, and it does not.
 */
const perTest: AsyncDbClient[] = [];

afterEach(async () => {
  while (perTest.length > 0) await perTest.pop()!.close();
});

/** The shared threaded facade — one real writer + read pool for the file. */
let sharedDb: AsyncDbClient | null = null;
let sharedDir = "";
/** Distinguishes each test's user/project/chat on the shared file. */
let tenant = 0;

beforeAll(async () => {
  sharedDir = createTempDir("ch-asyncdb-shared-");
  // The sync client opens the file once purely to run the migrations, exactly
  // as `threaded()` did — so the schema the pool reads is not written by the
  // pool under test.
  new DbClient({ path: join(sharedDir, "async.db") }).close();
  sharedDb = await AsyncDbClient.open({ path: join(sharedDir, "async.db"), readers: 4 });
});

afterAll(async () => {
  await sharedDb?.close();
  sharedDb = null;
});

/**
 * A fresh owner + project + chat on the SHARED facade.
 *
 * Seeded THROUGH the facade rather than beside it: a second connection writing
 * to the same file while the pool holds it open is a different situation from
 * the one the product is in, and this file exists to test the product's one.
 */
async function freshChat(): Promise<Fixture> {
  const db = sharedDb;
  if (db === null) throw new Error("the shared facade is not open — beforeAll did not run");
  tenant += 1;
  const user = await db.createUser(`owner-${String(tenant)}`, "hash");
  const project = await db.createProject(
    { name: `p-${String(tenant)}`, path: join(sharedDir, `proj-${String(tenant)}`) },
    user.id,
  );
  const chat = await db.createChat({ project_id: project.id, title: "c" }, user.id);
  return { db, userId: user.id, chatId: chat.id, dir: sharedDir };
}

describe("W1 — write ordering across the thread boundary", () => {
  test("writes commit in the order they were ISSUED, not the order they resolve", async () => {
    const { db, userId, chatId } = await freshChat();
    // Issue 200 writes without awaiting any of them. If the writer were a pool,
    // or the worker's handler were async, these would interleave.
    const issued = Array.from({ length: 200 }, (_, i) => `msg-${String(i).padStart(3, "0")}`);
    const pending = issued.map((content) =>
      db.createMessage({ chat_id: chatId, role: "user", content }, userId),
    );
    await Promise.all(pending);

    const stored = (await db.listMessages(chatId, userId)).map((m) => m.content);
    expect(stored).toEqual(issued);
  });

  test("a failing write does not reorder the writes around it", async () => {
    const { db, userId, chatId } = await freshChat();
    const p1 = db.createMessage({ chat_id: chatId, role: "user", content: "first" }, userId);
    // Not owned → ForbiddenError, rejected on the writer, between two good writes.
    const bad = db.createMessage({ chat_id: chatId, role: "user", content: "nope" }, "someone-else");
    const p3 = db.createMessage({ chat_id: chatId, role: "user", content: "third" }, userId);
    await expect(bad).rejects.toThrow(/does not belong to the caller/);
    await Promise.all([p1, p3]);
    expect((await db.listMessages(chatId, userId)).map((m) => m.content)).toEqual(["first", "third"]);
  });
});

describe("W2 — read-your-writes within a request", () => {
  test("a read sees a write issued before it even when the write was NOT awaited", async () => {
    const { db, userId, chatId } = await freshChat();
    for (let i = 0; i < 20; i += 1) {
      // Deliberately un-awaited: this is the case the barrier exists for.
      void db.createMessage({ chat_id: chatId, role: "user", content: `m${i}` }, userId);
      expect(await db.countMessages(chatId, userId)).toBe(i + 1);
    }
  });

  test("a composite read reflects an un-awaited write to the same chat", async () => {
    const { db, userId, chatId } = await freshChat();
    void db.createMessage({ chat_id: chatId, role: "assistant", content: "hello" }, userId);
    const history = await db.getChatHistory(chatId, userId);
    expect(history?.messages.map((m) => m.content)).toEqual(["hello"]);
  });

  // (A test of "a read with no write pending is not made to wait" stood here,
  // judged by a 200 ms wall bound (NO-LOAD-BLOCK forbids it). Its outcome is
  // already everyone's: a barrier that waited with nothing pending would wait
  // for a write that never comes, and every awaited read in this file would
  // hang. What it measured beyond that was LATENCY (a needless queue hop),
  // which is not a correctness property and runs on the reader threads, where
  // this thread's CPU cannot see it. The barrier's own property, a read
  // issued after an un-awaited write sees it, is the test above; removing
  // the barrier turns it red.)
});

describe("W3 — the ledger keeps one writer, on the main thread", () => {
  test("opening the timeline ledger from a DB worker thread throws", async () => {
    // The guard is keyed on the env var the DB workers are started with, so it
    // can be exercised directly: set it, and the ledger must refuse to open.
    const before = process.env["HARNESS_DB_WORKER"];
    process.env["HARNESS_DB_WORKER"] = "1";
    try {
      const { getTimelineRecorder } = await import("../../server/observability/timeline-bridge.ts");
      expect(() => getTimelineRecorder()).toThrow(/one writer|off_main_thread|main thread/i);
    } finally {
      if (before === undefined) delete process.env["HARNESS_DB_WORKER"];
      else process.env["HARNESS_DB_WORKER"] = before;
    }
  });

  test("the facade appends the check-status event itself, on the calling thread", async () => {
    const { db, userId, chatId } = await freshChat();
    // If this were appended inside the worker it would throw there, be
    // swallowed by the recorder's warn-not-throw handler, and the check would
    // still be written — so the row coming back is NOT the assertion. The
    // assertion is that the call succeeds from the main thread, where the
    // ledger IS reachable.
    const row = await db.createAutoCheck(
      { chat_id: chatId, check_name: "lint", status: "passed", output: { ok: true } },
      userId,
    );
    expect(row.check_name).toBe("lint");
    expect(row.status).toBe("passed");
  });

  test("createAutoCheck is never dispatched to a worker", async () => {
    const { DB_READ_METHODS, DB_WRITE_METHODS, DB_FACADE_OWNED_METHODS } = await import(
      "../../server/db/method-kinds.ts"
    );
    expect(DB_FACADE_OWNED_METHODS).toContain("createAutoCheck");
    expect([...DB_READ_METHODS, ...DB_WRITE_METHODS]).not.toContain("createAutoCheck");
    // And the ledger-free half IS dispatched, or the facade could not do the
    // write at all.
    expect(DB_WRITE_METHODS).toContain("createAutoCheckReturningTransition");
  });
});

describe("W2b — a read-modify-write the facade owns cannot lose an update", () => {
  /**
   * The one `withTransaction(fn)` call site in the product was a read-merge-
   * write over the user's model preferences, and a closure cannot cross a
   * thread. `updateUserModelPrefs` replaces it.
   *
   * Read the old code carefully before believing this test is unnecessary: the
   * transactional body was SYNCHRONOUS, so on a single-threaded loop nothing
   * could interleave with it whether or not it held a transaction. What the
   * conversion introduces is two `await` points INSIDE the sequence — and that
   * is the thing that loses updates. The regression would have been invisible
   * to the compiler and to every existing test, because each individual save
   * still succeeds and still returns a plausible document; only the OTHER
   * saver's contribution goes missing.
   */
  test("concurrent merges all survive — none reads a document the previous one already replaced", async () => {
    const { db, userId } = await freshChat();

    // Twenty savers, each adding its own provider, all issued at once. Every
    // one reads, merges onto what it read, and writes.
    const savers = Array.from({ length: 20 }, (_, i) =>
      db.updateUserModelPrefs(userId, (existing) => {
        const prev = (existing as { providers?: Record<string, string> } | null)?.providers ?? {};
        return { providers: { ...prev, [`p-${i}`]: `model-${i}` } };
      }),
    );
    await Promise.all(savers);

    const stored = (await db.getUserModelPrefs(userId)) as {
      providers: Record<string, string>;
    } | null;
    expect(stored).not.toBeNull();
    // All twenty, or the serialisation is not serialising. With the queue
    // removed this reads 1 — every saver merges onto the same empty document.
    expect(Object.keys(stored!.providers).sort()).toEqual(
      Array.from({ length: 20 }, (_, i) => `p-${i}`).sort(),
    );
  });

  test("a merge that throws does not strand the savers queued behind it", async () => {
    // The queue orders work; it must not couple outcomes. A predecessor that
    // rejects and takes the rest of the key's queue with it would turn one bad
    // request into a permanently wedged setting for that user.
    const { db, userId } = await freshChat();

    const boom = db.updateUserModelPrefs(userId, () => {
      throw new Error("merge failed");
    });
    const after = db.updateUserModelPrefs(userId, () => ({ providers: { ok: "yes" } }));

    await expect(boom).rejects.toThrow("merge failed");
    await expect(after).resolves.toEqual({ providers: { ok: "yes" } });
    expect(await db.getUserModelPrefs(userId)).toEqual({ providers: { ok: "yes" } });
  });

  test("the facade keeps no queue entry for a key with no work in flight", async () => {
    // A per-user key that is never released is a per-user leak: one map entry
    // for every user who ever saved, held for the life of the process.
    const { db, userId } = await freshChat();
    await db.updateUserModelPrefs(userId, () => ({ providers: {} }));
    // Let the release microtask run.
    await new Promise((r) => setTimeout(r, 0));
    const queues = (db as unknown as { queues: Map<string, unknown> }).queues;
    expect(queues.size, "a settled key must be dropped, not retained").toBe(0);
  });
});

describe("the process facade is threaded, opens late, and says what it is", () => {
  /**
   * The flip landed as a DEFERRED threaded backend: the decision is made at
   * construction, the connections open on first use, and `server/index.ts`
   * warms them before the socket listens.
   *
   * Three things can go wrong with that shape, and each has a guard here.
   * They are not obvious from the outside, which is exactly why they need
   * one: a facade that spawns nine threads on import, a facade that answers
   * "what are you connected to" before it is connected, and a threaded facade
   * pointed at `:memory:` — where nothing fails, because every thread gets its
   * own empty database and every read succeeds against a different one.
   */
  test("declaring the facade spawns nothing — the decision is not the opening", async () => {
    const dir = createTempDir("ch-deferred-");
    const before = process.getActiveResourcesInfo().filter((r) => r === "Worker").length;
    const db = AsyncDbClient.deferred({ path: join(dir, "late.db") });
    perTest.push(db);
    expect(db.isOffThread, "the decision is answerable without opening anything").toBe(true);
    expect(
      process.getActiveResourcesInfo().filter((r) => r === "Worker").length,
      "constructing the facade must not start worker threads — `getOrCreateAsyncDb` " +
        "is called by a prevention test, and importing a module must not light up a pool",
    ).toBe(before);
    // …and the pool is real once something asks it for something.
    expect(await db.countUsers()).toBe(0);
    expect(db.readPoolSize).toBeGreaterThan(0);
  });

  test("connection facts REFUSE before the pool is open, rather than reporting a blank", async () => {
    // A schema version of 0 or an empty path would be a fabricated answer to
    // "what are you connected to" — the L3 failure, arriving through a
    // lifecycle door. The refusal names the fix.
    const dir = createTempDir("ch-notopen-");
    const db = AsyncDbClient.deferred({ path: join(dir, "cold.db") });
    perTest.push(db);
    let caught: unknown;
    try {
      void db.schemaVersion;
      throw new Error("expected schemaVersion to refuse before the pool is open");
    } catch (err) {
      caught = err;
    }
    expect((caught as { code?: string }).code).toBe("db_not_open");
    expect((caught as Error).message).toContain("warmAsyncDb");
    // After warming, it answers for real.
    await db.warm();
    expect(db.schemaVersion).toBeGreaterThan(0);
    expect(db.path).toContain("cold.db");
  });

  test("a threaded facade REFUSES an in-memory path instead of quietly answering from nine databases", async () => {
    // The failure this prevents is silent, not loud: `:memory:` opened on N
    // threads is N empty databases, so a write goes to one and the next read
    // answers from another — with no error anywhere. The refusal happens at
    // OPEN, which in the server is the boot warm, before the socket listens.
    const db = AsyncDbClient.deferred({ path: ":memory:" });
    perTest.push(db);
    expect(db.isOffThread, "the process backend is threaded regardless of the path").toBe(true);
    await expect(db.warm()).rejects.toThrow(/in-memory database cannot be shared across threads/);
    await expect(db.countUsers()).rejects.toMatchObject({ code: "db_memory_not_threadable" });
  });
});

describe("required private metadata through the writer", () => {
  test("acknowledges actual owned writes and propagates missing/foreign refusal", async () => {
    const { db, userId, chatId } = await freshChat();
    const row = await db.createMessage({ chat_id: chatId, role: "assistant", content: "" }, userId);
    const evidence = { items: [{ type: "opaque", encrypted_content: "exact-ciphertext" }] };
    await db.updateMessageMetadata(row.id, { providerEvidence: evidence }, userId);
    expect((await db.getMessage(row.id, userId))!.metadata).toEqual({ providerEvidence: evidence });
    for (const [id, owner] of [["missing", userId], [row.id, "foreign"]]) {
      await expect(db.updateMessageMetadata(id!, { providerEvidence: { replaced: true } }, owner!)).rejects.toThrow(expect.objectContaining({ code: "message_metadata_not_owned" }));
    }
    expect((await db.getMessage(row.id, userId))!.metadata).toEqual({ providerEvidence: evidence });
    const tool = await db.createToolCall({ message_id: row.id, tool_name: "name", call_id: "original", input: {}, status: "running" }, userId);
    const projection = { observationKey: "test", toolName: "safe", input: {}, output: "" };
    await db.updateToolCall(tool.id, userId, { output: "", status: "done", publicProjection: projection });
    expect((await db.listToolCallsByMessage(row.id, userId))[0]).toMatchObject({ call_id: "original", output: "", public_projection: projection });
  });

  test("admits opaque JSON before structured clone and before any transaction write", async () => {
    const { db, userId, chatId } = await freshChat();
    const row = await db.createMessage({ chat_id: chatId, role: "assistant", content: "retained" }, userId);
    const tool = await db.createToolCall({ message_id: row.id, tool_name: "read", input: {}, status: "done" }, userId);
    let traps = 0;
    const getter = Object.defineProperty({}, "payload", { enumerable: true, get() { traps++; return "cloned getter"; } });
    const proxy = new Proxy({}, { ownKeys() { traps++; return []; } });
    const toJSON = { toJSON() { traps++; return "serialized callback"; } };
    const refusal = { code: "db_json_input_invalid", message: "Database JSON input is invalid" };
    for (const value of [getter, proxy, toJSON, { lost: undefined }, -0]) {
      const metadata = { providerEvidence: value };
      const projection = { observationKey: "private", toolName: "read", input: value, output: "" };
      await expect(db.createMessage({ chat_id: chatId, role: "assistant", content: "must-not-write", metadata }, userId)).rejects.toMatchObject(refusal);
      await expect(db.updateMessageMetadata(row.id, metadata, userId)).rejects.toMatchObject(refusal);
      await expect(db.createToolCall({ message_id: row.id, tool_name: "read", input: {}, status: "done", public_projection: projection }, userId)).rejects.toMatchObject(refusal);
      await expect(db.updateToolCall(tool.id, userId, { publicProjection: projection })).rejects.toMatchObject(refusal);
      await expect(db.transaction([
        { method: "createMessage", args: [{ chat_id: chatId, role: "user", content: "must-not-write" }, userId] },
        { method: "updateMessageMetadata", args: [row.id, metadata, userId] },
      ])).rejects.toMatchObject(refusal);
      await expect(db.transaction([{ method: "updateToolCall", args: [tool.id, userId, { publicProjection: projection }] }])).rejects.toMatchObject(refusal);
      expect(traps).toBe(0);
      expect(await db.listMessages(chatId, userId)).toEqual([row]);
      expect(await db.listToolCallsByMessage(row.id, userId)).toEqual([tool]);
    }
    let methodReads = 0;
    await expect(db.transaction([{
      get method() { methodReads++; return methodReads === 1 ? "createMessage" : "countUsers"; },
      args: [{ chat_id: chatId, role: "assistant", content: "must-not-write", metadata: { providerEvidence: getter } }, userId],
    }])).rejects.toMatchObject(refusal);
    expect(methodReads).toBe(1);
    expect(traps).toBe(0);
    const exact = { providerObservation: JSON.parse('{"__proto__":{"own":true},"value":""}') as unknown };
    await db.transaction([{ method: "updateMessageMetadata", args: [row.id, exact, userId] }]);
    expect((await db.getMessage(row.id, userId))!.metadata).toEqual(exact);
  });
});
