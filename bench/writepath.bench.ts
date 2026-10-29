/**
 * WRITE-PATH DECOMPOSITION + fsync reality check.
 *
 * `bench/db.bench.ts` measured `DbClient.createMessage` at ~12ms p50 while
 * `bench/ledger.bench.ts` measured a full ledger append — which also
 * COMMITs — at ~87µs. Those two numbers cannot both be "the cost of a
 * durable SQLite commit", so one of them is dominated by something else.
 * This bench finds out which, by decomposing `createMessage` into its
 * constituent statements and timing each in isolation on the SAME database
 * file.
 *
 * It also answers a question that invalidates every durability claim if
 * left unanswered: **is fsync real on this filesystem?** Under WSL2 the
 * guest filesystem may not honour `fdatasync` the way bare-metal ext4 does,
 * which would make `synchronous=FULL` look free and lead to exactly the
 * wrong conclusion. The raw fsync probe below prices one real fsync so
 * every durability number in the report can be read against it.
 *
 * Nothing here modifies product code — it calls the product's own methods
 * and replicates their SQL against a scratch copy for the isolated pieces.
 *
 * Run: node --experimental-strip-types bench/writepath.bench.ts [profile]
 */

import { DatabaseSync } from "node:sqlite";
import { openSync, writeSync, fsyncSync, closeSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { buildFixture, assertReadTargetsPristine } from "./fixtures/scale.ts";
import { measureNoiseFloor, timeSync, BUDGET, ms } from "./lib/stats.ts";
import { Reporter, BENCH_OUT_DIR } from "./lib/report.ts";
import { benchGitHead } from "./lib/machine.ts";

const SUITE = "writepath";


async function main(): Promise<void> {
  const profileName = process.argv[2] ?? "real";
  const noise = measureNoiseFloor();
  const reporter = new Reporter(benchGitHead());
  console.log(`noise floor: ${(noise * 1000).toFixed(2)}µs\n`);

  // ── W0: is fsync real, and on WHICH filesystem? ───────────────────────
  //
  // This probe must run on the filesystem the DATABASE lives on. Measuring
  // it in `os.tmpdir()` is a trap: on this class of machine /tmp is tmpfs
  // (RAM), where fsync is a no-op, and every durability comparison taken
  // there is meaningless. Both are measured so the gap is visible in the
  // report rather than silently mistaken for a product property.
  console.log("── W0: fsync reality check (both filesystems) ──");
  for (const [label, base] of [
    ["tmpdir", tmpdir()],
    ["projectDisk", join(process.cwd(), "bench", ".fixtures")],
  ] as const) {
    const dir = mkdtempSync(join(base, "bench-fsync-"));
    const file = join(dir, "probe");
    const fd = openSync(file, "w");
    const buf = Buffer.alloc(4096, 0x61);
    const { stats } = timeSync(
      () => {
        writeSync(fd, buf);
        fsyncSync(fd);
      },
      noise,
      { warmup: 20, iterations: 300 },
    );
    closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
    reporter.add({
      suite: SUITE,
      name: `raw.fsync4k.${label}`,
      scale: "one 4KB write + fsync",
      stats,
      budgetMs: BUDGET.FRAME_MS,
      notes:
        stats.p50Ms < 0.05
          ? `${label}: under 50µs — NOT a real device fsync (RAM-backed / write-back cache). ` +
            "Durability comparisons taken here are meaningless."
          : `${label}: a real durability barrier costs ${ms(stats.p50Ms)}. ` +
            "Every SQLite COMMIT on this filesystem pays it under synchronous=FULL.",
    });
  }

  const fx = buildFixture(profileName);
  assertReadTargetsPristine(fx);
  const user = fx.users[0]!;
  // The WRITE SINK, never a read target. This bench appends hundreds of
  // messages per run; pointed at `chatIds[0]` (the mega chat in `heavy`) it
  // silently inflated every read bench that reads it. See scale.ts.
  const chatId = user.writeSinkChatId;

  // ── W1: the product method, end to end ────────────────────────────────
  console.log("\n── W1: DbClient.createMessage, end to end ──");
  const content = "x".repeat(2000);
  const { stats: full } = timeSync(
    () => fx.db.createMessage({ chat_id: chatId, role: "assistant", content, metadata: { b: 1 } }, user.userId),
    noise,
    { warmup: 10, iterations: 150 },
  );
  reporter.add({
    suite: SUITE,
    name: "createMessage.full",
    scale: "1 message, 2KB content",
    stats: full,
    budgetMs: BUDGET.ACK_MS,
    notes: "the product path — every streamed assistant message pays this, synchronously",
  });

  // ── W2: the same work, decomposed ─────────────────────────────────────
  // Replicated SQL against the same file, so each piece is priced against
  // the same page cache and the same WAL.
  console.log("\n── W2: the same work, piece by piece ──");
  const raw = new DatabaseSync(fx.dbPath);
  const crypto = (fx.db as unknown as { crypto: { encryptField: (v: string) => string | null } }).crypto;

  {
    const { stats } = timeSync(() => crypto.encryptField(content), noise, {
      warmup: 200,
      iterations: 5000,
    });
    reporter.add({
      suite: SUITE,
      name: "piece.encryptField",
      scale: "2KB",
      stats,
      budgetMs: BUDGET.FRAME_MS,
      notes: "AES-256-GCM + randomBytes(12) IV + base64 — done twice per message (content, metadata)",
    });
  }
  {
    const stmt = raw.prepare(
      `SELECT 1 FROM chats c JOIN projects p ON c.project_id = p.id
        WHERE c.id = ? AND p.user_id = ? LIMIT 1`,
    );
    const { stats } = timeSync(() => stmt.get(chatId, user.userId), noise, {
      warmup: 200,
      iterations: 5000,
    });
    reporter.add({
      suite: SUITE,
      name: "piece.ownershipProbe",
      scale: "1 row",
      stats,
      budgetMs: BUDGET.FRAME_MS,
      notes: "chatBelongsToUser — a JOIN executed before every message write",
    });
  }
  {
    const enc = crypto.encryptField(content)!;
    const stmt = raw.prepare(
      "INSERT INTO messages (id, chat_id, role, content, created_at, model_event_type, run_id, metadata) " +
        "VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)",
    );
    const now = new Date().toISOString();
    const { stats } = timeSync(() => stmt.run(randomUUID(), chatId, "assistant", enc, now), noise, {
      warmup: 20,
      iterations: 300,
    });
    reporter.add({
      suite: SUITE,
      name: "piece.insertAutocommit",
      scale: "1 row, 2KB",
      stats,
      budgetMs: BUDGET.FRAME_MS,
      notes: "ONE auto-commit INSERT — this is one COMMIT, i.e. one durability barrier",
    });
  }
  {
    const enc = crypto.encryptField(content)!;
    const stmt = raw.prepare(
      "INSERT INTO messages (id, chat_id, role, content, created_at, model_event_type, run_id, metadata) " +
        "VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)",
    );
    const now = new Date().toISOString();
    const { stats } = timeSync(
      () => {
        raw.exec("BEGIN");
        stmt.run(randomUUID(), chatId, "assistant", enc, now);
        raw.exec("COMMIT");
      },
      noise,
      { warmup: 20, iterations: 300 },
    );
    reporter.add({
      suite: SUITE,
      name: "piece.insertExplicitTxn",
      scale: "1 row, 2KB",
      stats,
      budgetMs: BUDGET.FRAME_MS,
      notes: "the same INSERT inside an explicit BEGIN/COMMIT — isolates transaction framing cost",
    });
  }
  {
    const stmt = raw.prepare("UPDATE chats SET updated_at = ? WHERE id = ?");
    const { stats } = timeSync(() => stmt.run(new Date().toISOString(), chatId), noise, {
      warmup: 20,
      iterations: 300,
    });
    reporter.add({
      suite: SUITE,
      name: "piece.bumpChatUpdatedAt",
      scale: "1 row",
      stats,
      budgetMs: BUDGET.FRAME_MS,
      notes: "the sidebar-recency bump — a SECOND auto-commit transaction per message write",
    });
  }
  {
    const stmt = raw.prepare(
      `SELECT m.* FROM messages m JOIN chats c ON m.chat_id = c.id
         JOIN projects p ON c.project_id = p.id
        WHERE m.id = ? AND p.user_id = ? LIMIT 1`,
    );
    const anyId = (raw.prepare("SELECT id FROM messages WHERE chat_id = ? LIMIT 1").get(chatId) as {
      id: string;
    }).id;
    const { stats } = timeSync(() => stmt.get(anyId, user.userId), noise, {
      warmup: 200,
      iterations: 5000,
    });
    reporter.add({
      suite: SUITE,
      name: "piece.readBackAfterInsert",
      scale: "1 row",
      stats,
      budgetMs: BUDGET.FRAME_MS,
      notes:
        "createMessage ends with getMessage(id) to return the row — a third query whose " +
        "values the caller already had in hand",
    });
  }

  // ── W3: WAL depth — does an unchecked WAL slow writes down? ───────────
  console.log("\n── W3: WAL depth effect ──");
  {
    const before = raw.prepare("PRAGMA wal_checkpoint(PASSIVE)").get() as Record<string, unknown>;
    reporter.note(SUITE, "wal.checkpointResult", JSON.stringify(before));
    const stmt = raw.prepare(
      "INSERT INTO messages (id, chat_id, role, content, created_at, model_event_type, run_id, metadata) " +
        "VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)",
    );
    const enc = crypto.encryptField(content)!;
    const now = new Date().toISOString();
    const { stats } = timeSync(() => stmt.run(randomUUID(), chatId, "assistant", enc, now), noise, {
      warmup: 20,
      iterations: 300,
    });
    reporter.add({
      suite: SUITE,
      name: "piece.insertAfterCheckpoint",
      scale: "1 row, 2KB",
      stats,
      budgetMs: BUDGET.FRAME_MS,
      notes: "the same auto-commit INSERT immediately after a passive checkpoint — compare to piece.insertAutocommit",
    });
  }

  raw.close();
  fx.close();

  console.log(
    `\nsum of pieces ≈ 2×encrypt + ownership + insert + bump + readback; ` +
      `compare against createMessage.full p50 = ${ms(full.p50Ms)}`,
  );
  reporter.finish(join(BENCH_OUT_DIR, `writepath-${profileName}.json`));
}

void main();
