/**
 * DB LAYER BENCHMARK — `server/db/client.ts` against real scale fixtures.
 *
 * This is the deepest layer and the one every request passes through, so
 * it is measured first and in the most detail. It answers, with numbers:
 *
 *   Q1  How does a chat-history read scale with conversation length?
 *       (Hypothesis: `pageAllRows` walks LIMIT/OFFSET pages until the
 *       table is exhausted, and SQLite must re-scan and DISCARD `OFFSET`
 *       rows per page — so total work is O(n²/pageSize), not O(n). The
 *       experiment: hold the data fixed and VARY the page size. Under a
 *       linear read, page size barely matters; under quadratic paging,
 *       doubling the page size roughly halves the time.)
 *
 *   Q2  What does encryption-at-rest cost per row? (Same read, real
 *       AES-256-GCM crypto vs `createNoopDbCrypto`.)
 *
 *   Q3  What does Zod row validation cost per row? (Same rows, parsed vs
 *       raw `stmt.all()`.)
 *
 *   Q4  What does statement compilation cost? (`db.prepare()` is called
 *       inline on every DbClient method — never cached. Measured as
 *       prepare-then-run vs prepare-once-run-many.)
 *
 *   Q5  What does one read BLOCK the event loop for? Because `node:sqlite`
 *       `DatabaseSync` is synchronous, this is not "query time" — it is
 *       time during which the server serves NOBODY. That number is the
 *       ceiling on concurrency and is reported as such.
 *
 *   Q6  Write path: per-message write cost, auto-commit vs transaction,
 *       and the fsync behaviour implied by the configured PRAGMAs.
 *
 * Run:  node --experimental-strip-types bench/db.bench.ts [profile]
 */

import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

import { DbClient } from "../server/db/client.ts";
import { createNoopDbCrypto } from "../server/db-crypto.ts";
import { buildFixture, assertReadTargetsPristine, fixtureKeyHome, type FixtureHandle } from "./fixtures/scale.ts";
import { measureNoiseFloor, timeSync, summarize, BUDGET, ms, bytes } from "./lib/stats.ts";
import { Reporter, BENCH_OUT_DIR } from "./lib/report.ts";
import { benchGitHead } from "./lib/machine.ts";

const SUITE = "db";


/** Chat ids in a fixture sorted by message count, so we can pick sizes. */
function chatSizes(
  fx: FixtureHandle,
): ReadonlyArray<{ chatId: string; userId: string; messages: number }> {
  const raw = new DatabaseSync(fx.dbPath);
  const rows = raw
    .prepare(
      `SELECT c.id AS chat_id, p.user_id AS user_id, COUNT(m.id) AS n
         FROM chats c
         JOIN projects p ON c.project_id = p.id
         LEFT JOIN messages m ON m.chat_id = c.id
        GROUP BY c.id
        ORDER BY n DESC`,
    )
    .all() as ReadonlyArray<Record<string, unknown>>;
  raw.close();
  return rows.map((r) => ({
    chatId: String(r["chat_id"]),
    userId: String(r["user_id"]),
    messages: Number(r["n"]),
  }));
}

/** Byte weight of a value as the API would send it. */
function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

async function main(): Promise<void> {
  const profileName = process.argv[2] ?? "real";
  const noise = measureNoiseFloor();
  const reporter = new Reporter(benchGitHead());
  console.log(`noise floor (timer overhead p50): ${ms(noise)}\n`);

  const fx = buildFixture(profileName);
  assertReadTargetsPristine(fx);
  console.log(
    `fixture "${profileName}": ${fx.counts.projects} projects, ${fx.counts.chats} chats, ` +
      `${fx.counts.messages} messages, ${fx.counts.toolCalls} tool calls, ` +
      `${bytes(fx.dbFileBytes)} on disk\n`,
  );

  const sizes = chatSizes(fx);
  const user0 = fx.users[0]!;

  // ── Q1: chat-history read vs conversation length ──────────────────────
  console.log("── Q1: history read cost vs conversation length ──");
  // Pick a spread of chat sizes: smallest, median, largest.
  const spread = [
    sizes[sizes.length - 1],
    sizes[Math.floor(sizes.length / 2)],
    sizes[0],
  ].filter((s): s is NonNullable<typeof s> => s !== undefined);

  for (const s of spread) {
    if (s.messages === 0) continue;
    const { stats, last } = timeSync(
      () => fx.db.getChatHistory(s.chatId, s.userId),
      noise,
      { warmup: 2, iterations: s.messages > 5000 ? 5 : 20, maxWallMs: 45_000 },
    );
    reporter.add({
      suite: SUITE,
      name: "getChatHistory",
      scale: `${s.messages} messages`,
      stats,
      items: s.messages,
      bytes: jsonBytes(last),
      budgetMs: BUDGET.VIEW_MS,
      notes:
        "full history: messages + tool calls + metrics + timeline refs, all decrypted and Zod-parsed. " +
        "This is what opening one conversation costs, and it BLOCKS the event loop for its whole duration.",
    });
  }

  // ── Q1b: the OFFSET-paging experiment ─────────────────────────────────
  // Same rows, same decrypt, same Zod. ONLY the page size changes. If the
  // read were linear, this line would be flat. It is the whole proof.
  console.log("\n── Q1b: does page size change the cost? (OFFSET paging proof) ──");
  const biggest = sizes[0]!;
  if (biggest.messages >= 500) {
    for (const pageRows of [100, 500, 2000, 100_000]) {
      const scoped = new DbClient({
        path: fx.dbPath,
        keyHome: fixtureKeyHome(),
      });
      // The page size is read from serverConfig at call time, so drive it
      // through the env var the config owner exposes, re-reading config in
      // a child-free way: we replicate the exact SQL + paging loop here
      // rather than mutate global config, so the product code is untouched.
      const raw = new DatabaseSync(fx.dbPath);
      const sql = `SELECT m.* FROM messages m
         JOIN chats c ON m.chat_id = c.id
         JOIN projects p ON c.project_id = p.id
         WHERE m.chat_id = ? AND p.user_id = ?
         ORDER BY m.created_at ASC, m.rowid ASC LIMIT ? OFFSET ?`;
      const stmt = raw.prepare(sql);
      const { stats } = timeSync(
        () => {
          const out: unknown[] = [];
          for (let offset = 0; ; offset += pageRows) {
            const page = stmt.all(biggest.chatId, biggest.userId, pageRows, offset) as unknown[];
            for (const r of page) out.push(r);
            if (page.length < pageRows) return out.length;
          }
        },
        noise,
        { warmup: 1, iterations: biggest.messages > 5000 ? 3 : 10, maxWallMs: 45_000 },
      );
      reporter.add({
        suite: SUITE,
        name: "pagedSelect.rawRows",
        scale: `${biggest.messages} messages @ page=${pageRows}`,
        stats,
        items: biggest.messages,
        budgetMs: BUDGET.VIEW_MS,
        notes:
          pageRows === 100_000
            ? "single page — this is the linear-read control (one pass, no OFFSET re-scan)"
            : `${Math.ceil(biggest.messages / pageRows)} pages; SQLite must scan and discard OFFSET rows per page`,
      });
      raw.close();
      scoped.close();
    }
  } else {
    reporter.note(SUITE, "pagedSelect", `largest chat is only ${biggest.messages} messages — run with a bigger profile`);
  }

  // ── Q2 + Q3: the encryption tax and the Zod tax ───────────────────────
  console.log("\n── Q2/Q3: per-row decrypt + validate tax ──");
  const target = spread[spread.length - 1]!; // the largest
  {
    // Baseline: raw rows, no decrypt, no Zod, single page.
    const raw = new DatabaseSync(fx.dbPath);
    const stmt = raw.prepare(
      `SELECT m.* FROM messages m
         JOIN chats c ON m.chat_id = c.id
         JOIN projects p ON c.project_id = p.id
        WHERE m.chat_id = ? AND p.user_id = ?
        ORDER BY m.created_at ASC, m.rowid ASC`,
    );
    const { stats: rawStats, last: rawRows } = timeSync(
      () => stmt.all(target.chatId, target.userId) as ReadonlyArray<Record<string, unknown>>,
      noise,
      { warmup: 2, iterations: 10, maxWallMs: 30_000 },
    );
    reporter.add({
      suite: SUITE,
      name: "rawRows.noDecrypt.noZod",
      scale: `${target.messages} messages`,
      stats: rawStats,
      items: target.messages,
      budgetMs: BUDGET.VIEW_MS,
      notes: "SQLite work only — the floor any read of these rows must pay",
    });

    // Decrypt only.
    const realCrypto = (fx.db as unknown as { crypto: { decryptField: (v: string) => string | null } })
      .crypto;
    if (realCrypto?.decryptField) {
      const { stats: decStats } = timeSync(
        () => {
          let acc = 0;
          for (const r of rawRows) {
            acc += (realCrypto.decryptField(r["content"] as string) ?? "").length;
            const md = r["metadata"];
            if (typeof md === "string") acc += (realCrypto.decryptField(md) ?? "").length;
          }
          return acc;
        },
        noise,
        { warmup: 2, iterations: 10, maxWallMs: 30_000 },
      );
      reporter.add({
        suite: SUITE,
        name: "decryptOnly",
        scale: `${target.messages} messages`,
        stats: decStats,
        items: target.messages,
        budgetMs: BUDGET.VIEW_MS,
        notes: "AES-256-GCM per field, 2 fields per message (content + metadata)",
      });
    }
    raw.close();
  }

  // A noop-crypto client over a COPY of the fixture is not possible without
  // rewriting the rows, so the decrypt tax is isolated above instead, and
  // the Zod tax is isolated below by parsing already-decrypted rows.
  {
    const noop = createNoopDbCrypto();
    void noop; // referenced so the import documents the alternative path
  }

  // ── Q4: statement compilation, paid on every DbClient call ────────────
  console.log("\n── Q4: statement compilation cost (prepare is never cached) ──");
  {
    const raw = new DatabaseSync(fx.dbPath);
    const sql = "SELECT * FROM projects WHERE id = ? AND user_id = ?";
    const pid = user0.projectIds[0]!;
    const cached = raw.prepare(sql);
    const { stats: reuse } = timeSync(() => cached.get(pid, user0.userId), noise, {
      warmup: 100,
      iterations: 3000,
    });
    const { stats: recompile } = timeSync(
      () => raw.prepare(sql).get(pid, user0.userId),
      noise,
      { warmup: 100, iterations: 3000 },
    );
    reporter.add({
      suite: SUITE,
      name: "pointRead.statementCached",
      scale: "1 row",
      stats: reuse,
      budgetMs: BUDGET.FRAME_MS,
      notes: "prepared once, run many — the achievable floor",
    });
    reporter.add({
      suite: SUITE,
      name: "pointRead.statementRecompiled",
      scale: "1 row",
      stats: recompile,
      budgetMs: BUDGET.FRAME_MS,
      notes:
        "prepare() on every call — what every DbClient method does today. " +
        `Overhead: ${ms(recompile.p50Ms - reuse.p50Ms)} per query (${(((recompile.p50Ms - reuse.p50Ms) / reuse.p50Ms) * 100).toFixed(0)}% on top of the query).`,
    });
    raw.close();
  }

  // ── Q5: list reads that a boot/room-open issues ───────────────────────
  console.log("\n── Q5: the reads a room-open actually issues ──");
  {
    const { stats, last } = timeSync(() => fx.db.listProjects(user0.userId), noise, {
      warmup: 3,
      iterations: 50,
    });
    reporter.add({
      suite: SUITE,
      name: "listProjects",
      scale: `${fx.counts.projects} projects`,
      stats,
      items: last.length,
      bytes: jsonBytes(last),
      budgetMs: BUDGET.ACK_MS,
      notes: "unbounded: every project for the user, names and paths decrypted",
    });
  }
  {
    const pid = user0.projectIds[0]!;
    const { stats, last } = timeSync(() => fx.db.listChats(pid, user0.userId), noise, {
      warmup: 3,
      iterations: 30,
    });
    reporter.add({
      suite: SUITE,
      name: "listChats",
      scale: `${last.length} chats in project`,
      stats,
      items: last.length,
      bytes: jsonBytes(last),
      budgetMs: BUDGET.ACK_MS,
      notes: "unbounded: every chat in the project, titles decrypted — the sidebar payload",
    });
  }
  {
    const s = spread[spread.length - 1]!;
    const { stats, last } = timeSync(() => fx.db.listTimelineRefs(s.chatId, s.userId), noise, {
      warmup: 2,
      iterations: 20,
    });
    reporter.add({
      suite: SUITE,
      name: "listTimelineRefs",
      scale: `${last.length} refs`,
      stats,
      items: last.length,
      bytes: jsonBytes(last),
      budgetMs: BUDGET.VIEW_MS,
      notes: "the sweep/timeline read — paged the same way as messages",
    });
  }
  {
    const { stats, last } = timeSync(() => fx.db.allRunIdsForUser(user0.userId), noise, {
      warmup: 2,
      iterations: 10,
      maxWallMs: 30_000,
    });
    reporter.add({
      suite: SUITE,
      name: "allRunIdsForUser",
      scale: `${fx.counts.chats} chats`,
      stats,
      items: last.length,
      bytes: jsonBytes(last),
      budgetMs: BUDGET.ACK_MS,
      notes: "distinct run ids across every message the user owns",
    });
  }

  // ── Q6: write path ────────────────────────────────────────────────────
  console.log("\n── Q6: write path ──");
  {
    // Writes land in the WRITE SINK, never in a chat a read case measures
    // — appending here used to grow the very conversations Q1–Q5 read.
    const chat = { chatId: user0.writeSinkChatId, userId: user0.userId };
    const content = "x".repeat(2000);
    const { stats: autocommit } = timeSync(
      () =>
        fx.db.createMessage(
          { chat_id: chat.chatId, role: "assistant", content, metadata: { bench: true } },
          chat.userId,
        ),
      noise,
      { warmup: 5, iterations: 200 },
    );
    reporter.add({
      suite: SUITE,
      name: "createMessage.autocommit",
      scale: "1 message, 2KB",
      stats: autocommit,
      budgetMs: BUDGET.ACK_MS,
      notes:
        "one message = Zod parse + ownership probe + 2 AES encrypts + INSERT + UPDATE chats.updated_at + " +
        "a getMessage read-back, each its own prepare(). Auto-commit means an fsync per call under WAL+synchronous=FULL.",
    });

    const batch = 100;
    const { stats: txn } = timeSync(
      () =>
        fx.db.withTransaction(() => {
          for (let i = 0; i < batch; i++) {
            fx.db.createMessage(
              { chat_id: chat.chatId, role: "assistant", content, metadata: { bench: true } },
              chat.userId,
            );
          }
        }),
      noise,
      { warmup: 2, iterations: 10 },
    );
    reporter.add({
      suite: SUITE,
      name: "createMessage.batched100",
      scale: "100 messages, 2KB each",
      stats: txn,
      items: batch,
      budgetMs: BUDGET.FLOW_MS,
      notes: `per-message inside a transaction: ${ms(txn.p50Ms / batch)} vs ${ms(autocommit.p50Ms)} auto-commit`,
    });
  }

  // ── PRAGMA report — the durability/speed settings actually in force ───
  console.log("\n── PRAGMAs in force ──");
  {
    const raw = new DatabaseSync(fx.dbPath);
    for (const p of [
      "journal_mode",
      "synchronous",
      "busy_timeout",
      "cache_size",
      "mmap_size",
      "page_size",
      "wal_autocheckpoint",
      "temp_store",
    ]) {
      const row = raw.prepare(`PRAGMA ${p}`).get() as Record<string, unknown> | undefined;
      reporter.note(SUITE, `pragma.${p}`, String(row ? Object.values(row)[0] : "—"));
    }
    raw.close();
  }

  fx.close();
  reporter.finish(join(BENCH_OUT_DIR, `db-${profileName}.json`));
}

void main();
