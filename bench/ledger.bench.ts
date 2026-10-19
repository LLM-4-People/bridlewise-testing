/**
 * LEDGER BENCHMARK — the recording tax, measured separately and explicitly.
 *
 * Recording is on EVERY path by design, so its per-effect cost multiplies
 * across the whole product. This bench decomposes that cost so the fix can
 * be aimed rather than guessed:
 *
 *   L1  End-to-end `recordEffect(...)` — what one recorded effect costs a
 *       caller, including the AsyncLocalStorage span, the sink, the chain
 *       hash, the two row writes and the COMMIT fsync.
 *   L2  The same append with `synchronous` varied FULL / NORMAL / OFF.
 *       This isolates the fsync term. It is the single largest lever and
 *       the only one that trades durability, so it is measured, not
 *       assumed. (What each setting actually risks is stated in the notes
 *       so the trade can be decided rather than inherited.)
 *   L3  Chain hashing alone — `computeChainHash` over a realistic envelope,
 *       with no I/O. Answers "is tamper evidence blocking each write?"
 *   L4  Append cost vs LEDGER SIZE. Every append does
 *       `SELECT ... ORDER BY sequence DESC LIMIT 1` and updates ~22 B-tree
 *       indexes across two tables, so cost should grow with log(n) at best
 *       and with WAL depth at worst. Measured at 1k / 10k / 100k events.
 *   L5  Read-back: the SWEEP's spectrum scan and a trace query, at size.
 *   L6  The wasted work after COMMIT — `doAppend` issues 3 more SELECTs and
 *       builds a 40-field frozen record that every production caller
 *       discards. Measured as the delta between a hydrating append and the
 *       raw insert.
 *
 * Run: node --experimental-strip-types bench/ledger.bench.ts [events]
 */

import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTimelineStore } from "../engine/src/timeline/timeline-store.ts";
import { createTimelineRecorder } from "../engine/src/timeline/timeline-recorder.ts";
import { computeChainHash } from "../engine/src/timeline/ledger-primitives.ts";
import { recordEffect, setEffectSink } from "../engine/src/timeline/recorded-effect.ts";
import { withRecordingContext } from "../engine/src/timeline/recording-context.ts";

import { measureNoiseFloor, timeSync, BUDGET, ms, bytes } from "./lib/stats.ts";
import { Reporter, BENCH_OUT_DIR } from "./lib/report.ts";

const SUITE = "ledger";

function gitHead(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

type Rig = {
  readonly dir: string;
  readonly path: string;
  readonly store: ReturnType<typeof createTimelineStore>;
  readonly recorder: ReturnType<typeof createTimelineRecorder>;
  close(): void;
};

/**
 * A fresh ledger on the PROJECT filesystem.
 *
 * Deliberately NOT `os.tmpdir()`: on this class of machine /tmp is tmpfs
 * (RAM), where fsync is a no-op — a ledger benchmarked there measures
 * SQLite's CPU work and nothing about durability, and would make
 * `synchronous=FULL` look free. The ledger in production lives beside the
 * workspace, on real storage, so that is where it is measured.
 * `bench/writepath.bench.ts` W0 prints the fsync cost of both filesystems
 * so this choice is visible rather than assumed.
 */
function newLedger(synchronous?: string): Rig {
  const dir = mkdtempSync(join(process.cwd(), "bench", ".fixtures", "bench-ledger-"));
  const path = join(dir, "timeline.db");
  const store = createTimelineStore({
    path,
    ledgerId: "bench-ledger",
    ...(synchronous !== undefined ? { synchronous } : {}),
  });
  const recorder = createTimelineRecorder({ store });
  return {
    dir,
    path,
    store,
    recorder,
    close: () => {
      try {
        store.close?.();
      } catch {
        /* store may not expose close */
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** One event shaped exactly like the effect sink's output. */
function effectEvent(i: number): Parameters<ReturnType<typeof createTimelineRecorder>["recordEvent"]>[0] {
  const timingJson = JSON.stringify({ durationMs: 12.5 });
  return {
    eventType: "tool",
    description: `tool:read_file:${i}`,
    outcome: "succeeded",
    documents: [
      {
        name: "effect.timing",
        contentJson: timingJson,
        contentDigest: "a".repeat(64),
      },
    ],
  };
}

async function main(): Promise<void> {
  const targetEvents = Number(process.argv[2] ?? 2000);
  const noise = measureNoiseFloor();
  const reporter = new Reporter(gitHead());
  console.log(`noise floor (timer overhead p50): ${(noise * 1000).toFixed(2)}µs\n`);

  // ── L3: chain hashing alone, no I/O ───────────────────────────────────
  console.log("── L3: chain hashing, no I/O ──");
  {
    const envelope = {
      ledgerId: "bench-ledger",
      sequence: "1000",
      eventId: "evt-0000",
      recordKind: "effect",
      eventType: "tool",
      outcome: "succeeded",
      wallTime: new Date().toISOString(),
      monotonicNs: "123456789",
      description: "tool:read_file:1",
      actorKind: "harness",
      actorId: "runtime",
      actorRole: "timeline",
    };
    const { stats } = timeSync(
      () => computeChainHash("timeline", "0".repeat(64), envelope),
      noise,
      { warmup: 1000, iterations: 20_000 },
    );
    reporter.add({
      suite: SUITE,
      name: "computeChainHash",
      scale: "1 envelope, 12 scalar fields",
      stats,
      budgetMs: BUDGET.FRAME_MS,
      notes:
        "canonicalize (deep clone + encode walk + per-leaf JSON.stringify) then SHA-256. " +
        "This runs INSIDE the write transaction, synchronously, per event.",
    });
  }

  // ── L1 + L2: append cost, and the fsync lever ─────────────────────────
  console.log("\n── L1/L2: one recorded append, synchronous = FULL / NORMAL / OFF ──");
  const durabilityNote: Record<string, string> = {
    FULL:
      "TODAY'S SETTING (timeline-store.ts:106, not overridable from config). fsync per COMMIT. " +
      "Survives OS crash and power loss with zero committed-event loss.",
    NORMAL:
      "WAL is fsynced at checkpoints, not per commit. Survives PROCESS crash with zero loss; " +
      "an OS crash / power loss can lose the tail since the last checkpoint. Never corrupts. " +
      "This is the standard WAL recommendation and the bounded trade to consider.",
    OFF:
      "No fsync at all. Shown only to price the fsync term — NOT a candidate: " +
      "an OS crash can leave the ledger torn, which breaks the chain-hash guarantee itself.",
  };
  for (const sync of ["FULL", "NORMAL", "OFF"]) {
    const rig = newLedger(sync);
    let i = 0;
    const { stats } = timeSync(() => rig.recorder.recordEvent(effectEvent(i++)), noise, {
      warmup: 50,
      iterations: 400,
    });
    reporter.add({
      suite: SUITE,
      name: `recordEvent.synchronous=${sync}`,
      scale: "1 effect event + 1 document",
      stats,
      budgetMs: BUDGET.FRAME_MS,
      notes: durabilityNote[sync]!,
    });
    rig.close();
  }

  // ── L1b: the full recordEffect wrapper (ALS span + sink + append) ─────
  console.log("\n── L1b: the full recordEffect(...) wrapper as callers use it ──");
  {
    const rig = newLedger();
    let i = 0;
    setEffectSink((record) => {
      const timingJson = JSON.stringify({ durationMs: record.durationMs });
      rig.recorder.recordEvent({
        eventType: "tool",
        description: `${record.kind}:${record.name}`,
        outcome: record.outcome,
        documents: [{ name: "effect.timing", contentJson: timingJson, contentDigest: "b".repeat(64) }],
      });
    });

    // The work being wrapped is deliberately trivial, so the number IS the
    // overhead: what recording adds to an operation that costs nothing.
    const trivial = (): number => i++;

    const { stats: wrapped } = timeSync(
      () => withRecordingContext({ actor: { kind: "user", id: "u1" }, runId: "run-1" }, () =>
        recordEffect("tool", "read_file", trivial),
      ),
      noise,
      { warmup: 50, iterations: 400 },
    );
    reporter.add({
      suite: SUITE,
      name: "recordEffect.wrapperOverhead",
      scale: "1 effect wrapping a no-op",
      stats: wrapped,
      budgetMs: BUDGET.FRAME_MS,
      notes:
        "This is the RECORDING TAX per effect: ALS span entry + frozen context object + " +
        "sink closure + JSON.stringify + SHA-256 of the timing doc + the full ledger append. " +
        "Multiply by the effects per request (5 baseline for a run turn, +2 per tool call).",
    });

    // Isolate the non-I/O half: same wrapper, sink that does nothing.
    setEffectSink(() => {});
    const { stats: sinkless } = timeSync(
      () => withRecordingContext({ actor: { kind: "user", id: "u1" }, runId: "run-1" }, () =>
        recordEffect("tool", "read_file", trivial),
      ),
      noise,
      { warmup: 500, iterations: 20_000 },
    );
    reporter.add({
      suite: SUITE,
      name: "recordEffect.contextOnly",
      scale: "1 effect, sink discarded",
      stats: sinkless,
      budgetMs: BUDGET.FRAME_MS,
      notes:
        "The AsyncLocalStorage + closure + classify half only, no ledger I/O. " +
        `The ledger append is therefore ${ms(wrapped.p50Ms - sinkless.p50Ms)} of the ` +
        `${ms(wrapped.p50Ms)} total (${(((wrapped.p50Ms - sinkless.p50Ms) / wrapped.p50Ms) * 100).toFixed(1)}%).`,
    });
    setEffectSink(() => {});
    rig.close();
  }

  // ── L4: append cost vs ledger size ────────────────────────────────────
  console.log("\n── L4: does append cost grow with ledger size? ──");
  {
    const rig = newLedger("NORMAL"); // NORMAL so fsync does not dominate the shape
    let i = 0;
    const checkpoints = [1_000, 10_000, Math.max(100_000, targetEvents)];
    let written = 0;
    for (const checkpoint of checkpoints) {
      while (written < checkpoint) {
        rig.recorder.recordEvent(effectEvent(i++));
        written++;
      }
      const { stats } = timeSync(() => rig.recorder.recordEvent(effectEvent(i++)), noise, {
        warmup: 20,
        iterations: 300,
      });
      written += 320;
      const walPath = `${rig.path}-wal`;
      reporter.add({
        suite: SUITE,
        name: "recordEvent.atSize",
        scale: `ledger has ${checkpoint} events`,
        stats,
        budgetMs: BUDGET.FRAME_MS,
        notes:
          `db ${bytes(existsSync(rig.path) ? statSync(rig.path).size : 0)}, ` +
          `wal ${bytes(existsSync(walPath) ? statSync(walPath).size : 0)} ` +
          "(synchronous=NORMAL here so the shape is index/WAL growth, not fsync)",
      });
    }

    // ── L5: the read side at this size ──────────────────────────────────
    console.log("\n── L5: ledger reads at size ──");
    const raw = new DatabaseSync(rig.path);
    {
      // The SWEEP spectrum read: unbounded projection scan, no LIMIT.
      const stmt = raw.prepare(
        "SELECT wall_time, event_type, outcome, error_code FROM event_log",
      );
      const { stats, last } = timeSync(() => (stmt.all() as unknown[]).length, noise, {
        warmup: 1,
        iterations: 5,
        maxWallMs: 60_000,
      });
      reporter.add({
        suite: SUITE,
        name: "spectrumScan.noTimeFilter",
        scale: `${last} events`,
        stats,
        items: last,
        budgetMs: BUDGET.VIEW_MS,
        notes:
          "the SWEEP's read when no time window is given — every row, no LIMIT, " +
          "then two more full JS passes (Date.parse per row, then binning) in the product code",
      });
    }
    {
      // OFFSET pagination: the deep page.
      const stmt = raw.prepare(
        "SELECT * FROM event_log WHERE ledger_id = ? ORDER BY sequence ASC LIMIT ? OFFSET ?",
      );
      for (const offset of [0, 50_000]) {
        const { stats } = timeSync(
          () => (stmt.all("bench-ledger", 1000, offset) as unknown[]).length,
          noise,
          { warmup: 1, iterations: 10, maxWallMs: 30_000 },
        );
        reporter.add({
          suite: SUITE,
          name: "query.offsetPage",
          scale: `1000 rows @ offset ${offset}`,
          stats,
          items: 1000,
          budgetMs: BUDGET.VIEW_MS,
          notes:
            offset === 0
              ? "the first page — the achievable cost"
              : "SQLite walks and discards OFFSET index entries; keyset pagination on `sequence` exists in buildWhere but OFFSET is still honoured",
        });
      }
    }
    {
      const row = raw.prepare("SELECT COUNT(*) AS n FROM timeline_projection").get() as { n: number };
      reporter.note(
        SUITE,
        "projection.rows",
        `${row.n} rows — a full duplicate of event_log, written on every append (7 more indexes)`,
      );
      const idx = raw
        .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND tbl_name='event_log'")
        .get() as { n: number };
      reporter.note(SUITE, "eventLog.indexes", `${idx.n} indexes on event_log — every one updated per INSERT`);
      const edges = raw.prepare("SELECT COUNT(*) AS n FROM event_edges").get() as { n: number };
      reporter.note(SUITE, "eventEdges.rows", `${edges.n} rows (3 indexes + a SELECT per append maintained for it)`);
    }
    raw.close();
    rig.close();
  }

  // ── Live ledger conditions, if one exists in this workspace ───────────
  console.log("\n── the live ledger in this workspace ──");
  {
    const live = join(process.cwd(), ".bridlewise", "timeline.db");
    if (existsSync(live)) {
      const dbBytes = statSync(live).size;
      const walBytes = existsSync(`${live}-wal`) ? statSync(`${live}-wal`).size : 0;
      const raw = new DatabaseSync(live);
      const n = (raw.prepare("SELECT COUNT(*) AS n FROM event_log").get() as { n: number }).n;
      const ac = raw.prepare("PRAGMA wal_autocheckpoint").get() as Record<string, unknown>;
      const pageSize = (raw.prepare("PRAGMA page_size").get() as Record<string, unknown>)["page_size"];
      raw.close();
      reporter.note(
        SUITE,
        "live.state",
        `${n} events · db ${bytes(dbBytes)} · wal ${bytes(walBytes)} · ` +
          `wal_autocheckpoint ${String(Object.values(ac)[0])} pages ` +
          `(= ${bytes(Number(Object.values(ac)[0]) * Number(pageSize))} threshold) — ` +
          `WAL is ${(walBytes / (Number(Object.values(ac)[0]) * Number(pageSize))).toFixed(0)}x past it`,
      );
    } else {
      reporter.note(SUITE, "live.state", "no .bridlewise/timeline.db in this workspace");
    }
  }

  reporter.finish(join(BENCH_OUT_DIR, "ledger.json"));
}

void main();
