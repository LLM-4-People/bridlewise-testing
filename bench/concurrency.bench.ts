/**
 * CONCURRENCY BENCHMARK — does work overlap, or does it serialize?
 *
 * The hypothesis under test: `node:sqlite`'s `DatabaseSync` is synchronous,
 * so every DB touch blocks the single event-loop thread. If that is true,
 * concurrent requests do not overlap — they queue — and latency grows
 * LINEARLY with the number of simultaneous users regardless of how cheap
 * each individual query is. No amount of query tuning fixes that shape;
 * only moving the work off-thread does.
 *
 * The experiment distinguishes the two shapes without needing an HTTP
 * server (so it does not contend with anyone's dev process):
 *
 *   - Issue N logically-concurrent operations.
 *   - Measure each operation's own latency as N grows.
 *   - OVERLAPPED work: per-op latency stays FLAT as N grows.
 *   - SERIALIZED work: per-op latency grows LINEARLY in N, because each
 *     operation waits behind all the others.
 *
 * Growth-vs-N is the verdict. See `verdictLine` for the metric that was
 * tried, found degenerate, and discarded.
 *
 * Event-loop availability is sampled throughout, as the number of times a
 * short interval timer actually got to fire versus how many times it should
 * have. That IS the number that matters for a multi-user server: a loop
 * that cannot run timers is a loop serving nobody — not the slow user, not
 * the fast one, not a health check.
 *
 * A control is included (`setTimeout`, genuinely async) so the harness
 * proves it can DETECT overlap when overlap exists. Without the control a
 * "serialized" verdict could just be a broken measurement.
 *
 * Run: node --experimental-strip-types bench/concurrency.bench.ts [profile]
 */

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";

import { buildFixture, assertReadTargetsPristine, fixtureKeyHome } from "./fixtures/scale.ts";
import { AsyncDbClient } from "../server/db/async-client.ts";
import { defaultReadPoolSize } from "../server/db/thread-backend.ts";
import {
  measureNoiseFloor,
  summarize,
  startLagSampler,
  BUDGET,
  ms,
  band,
  type Stats,
} from "./lib/stats.ts";
import { Reporter, BENCH_OUT_DIR } from "./lib/report.ts";

const SUITE = "concurrency";

function gitHead(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

type FanOutResult = {
  readonly perOp: Stats;
  readonly wallMs: number;
  readonly lag: Stats;
  /**
   * How many times the event loop's timer phase ran during the fan-out.
   *
   * This is the sharpest single number in the whole harness. A 5ms interval
   * timer over a W-ms fan-out SHOULD fire about W/5 times. If it fires far
   * fewer, the loop was not free to run timers — it was inside synchronous
   * work. Zero or one firing over a half-second window means the process
   * served nothing else at all for that whole window.
   */
  readonly lagSamples: number;
};

/**
 * Run `n` operations "concurrently" — each wrapped in an async function and
 * started before any is awaited, which is exactly how a Node server handles
 * n simultaneous requests. Whether they ACTUALLY overlap is what we measure.
 */
async function fanOut(
  n: number,
  op: () => unknown | Promise<unknown>,
  noise: number,
): Promise<FanOutResult> {
  const lag = startLagSampler(5);
  const perOp: number[] = [];
  const wall0 = process.hrtime.bigint();

  const tasks: Array<Promise<void>> = [];
  for (let i = 0; i < n; i++) {
    tasks.push(
      (async () => {
        // Yield first, so every task is genuinely in flight before any of
        // them does work — otherwise the loop below would just run them
        // one at a time by construction and the test would be rigged.
        await Promise.resolve();
        const t0 = process.hrtime.bigint();
        await op();
        const t1 = process.hrtime.bigint();
        perOp.push(Number(t1 - t0) / 1_000_000);
      })(),
    );
  }
  await Promise.all(tasks);

  const wallMs = Number(process.hrtime.bigint() - wall0) / 1_000_000;
  const stats = summarize(perOp, noise);
  const lagStats = lag.stop(noise);
  return { perOp: stats, wallMs, lag: lagStats, lagSamples: lagStats.n };
}

/**
 * The verdict line for one fan-out.
 *
 * NOTE on a metric deliberately NOT used: `wall / max(individual)` is
 * degenerate here and was discarded after it reported ~1.0 for BOTH the
 * parallel control and the serialized DB case. It is degenerate because
 * every task starts at once, so in the serialized case the last task's own
 * measured latency already spans the entire queue — max ≈ wall by
 * construction, whether or not anything overlapped.
 *
 * The discriminator that actually works is GROWTH OF PER-OP LATENCY WITH N,
 * read against the control:
 *   - genuinely async work  → per-op p50 stays FLAT as N grows
 *   - serialized sync work  → per-op p50 grows LINEARLY with N
 * plus `expectedTimerFirings vs lagSamples`, which shows directly how much
 * of the window the loop was unavailable.
 */
/**
 * BURN THE COLD START OUT OF THE n=1 BASELINE.
 *
 * Every growth verdict below divides by the n=1 measurement, so whatever is
 * in that one number is in every ratio. The first invocation of an operation
 * on a fresh connection pays one-time costs the later ones do not — SQLite
 * compiles the statement, the WAL touches its first page, the page cache is
 * empty.
 *
 * Under `synchronous=FULL` that was invisible: an fsync per commit dwarfed
 * it, so n=1 and n=50 were both "an fsync". At `synchronous=NORMAL` a write
 * is 140µs and the cold start is milliseconds, so it becomes the DOMINANT
 * term in the denominator — and the ratio it produces is a lie in the
 * flattering direction: `createMessage` reported "grew 0.4× at 50
 * concurrent" (a green!) against 9.88ms at n=1 and 4.14ms at n=50, while the
 * warm range 5→50 concurrent grew 590µs → 4.14ms, which is 7.0× for a 10×
 * increase in N. Linear. Unchanged in shape.
 *
 * That is exactly the trap DESIGN-PERFORMANCE §5b says to expect: a
 * constant-factor fix making a shape metric LOOK green. The shape did not
 * move; the measurement was fooled. This warms the operation first so the
 * denominator is a warm operation, like every numerator it divides.
 */
async function burnInCold(op: () => unknown): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve(op());
  }
}

/**
 * A WINDOW SHORTER THAN THE SAMPLER MEASURES NOTHING, and must not be reported
 * as 0%.
 *
 * The availability figure counts firings of a 5ms interval timer over the
 * fan-out. When the fan-out itself lasts under ~10ms — which every fast write
 * case does, at 0.9ms for n=1 — the timer has no opportunity to fire whatever
 * the loop is doing, and `Math.max(1, floor(wall/5))` then reports "0 of 1
 * expected", printed as 100% starved.
 *
 * That is the same inversion this file already records for C3, where a starved
 * poller's single sample read as "instant". Here it produces the opposite lie:
 * a perfectly free loop reported as totally blocked, on the async rows, in the
 * table that is supposed to show the loop being freed. An honest instrument
 * says it could not tell.
 */
const LAG_SAMPLE_MS = 5;
const MIN_MEASURABLE_WINDOW_MS = LAG_SAMPLE_MS * 2;

function availabilityPhrase(r: FanOutResult): string {
  if (r.wallMs < MIN_MEASURABLE_WINDOW_MS) {
    return (
      `loop availability UNMEASURABLE — the window (${ms(r.wallMs)}) is shorter than ` +
      `two ${LAG_SAMPLE_MS}ms sampling periods, so a free loop and a blocked one look ` +
      "the same here. Read the larger-N rows, and C3."
    );
  }
  const expectedFirings = Math.max(1, Math.floor(r.wallMs / LAG_SAMPLE_MS));
  const starvation = 1 - r.lagSamples / expectedFirings;
  return (
    `loop timer fired ${r.lagSamples}/${expectedFirings} expected times ` +
    `(${(Math.max(0, starvation) * 100).toFixed(0)}% of the window the loop could serve nobody)`
  );
}

function verdictLine(r: FanOutResult, n: number, baselineP50: number | undefined): string {
  const growth = baselineP50 ? r.perOp.p50Ms / baselineP50 : 1;
  return (
    `wall ${ms(r.wallMs)} · per-op p50 grew ${growth.toFixed(1)}× vs n=1 ` +
    `(flat = overlapped, ~${n}× = serialized) · ` +
    availabilityPhrase(r)
  );
}

/**
 * THE FLOOR THE GROWTH RATIO CANNOT GO BELOW, and why it is not 1.
 *
 * The budget in DESIGN-PERFORMANCE §5 asks for per-op growth < 2× at 50
 * concurrent, measured against the n=1 baseline. That is the right bar for
 * work that WAITS — the control below sleeps 20ms and stays flat at any N,
 * because fifty simultaneous sleeps still take 20ms. It is not reachable for
 * work that COMPUTES, and this read computes: of a whole-conversation read,
 * SQLite's own work is ~14%, AES decryption ~49%, and Zod validation most of
 * the rest. All of it is CPU.
 *
 * With K workers and N equal tasks of duration W, the task finishing in the
 * median position completes at `W · ceil(ceil(N/2) / K)`, so the best growth
 * ratio ANY correct implementation can report is that multiple. At N=50 with
 * K=8 readers the floor is 4×, on a 12-core machine. Reaching 2× would need
 * ~25 cores doing nothing else.
 *
 * So a growth figure is only meaningful against this floor, and it is printed
 * beside every async row rather than left for a reader to work out. The
 * measurement that has no such floor — and therefore no excuse — is event-loop
 * availability, which is why §5 says to gate hardest on it.
 */
function parallelFloor(n: number, readers: number): string {
  const floor = Math.ceil(Math.ceil(n / 2) / readers);
  return ` · parallel floor for CPU-bound work with ${readers} readers: ${floor.toFixed(1)}×`;
}

/**
 * THE ONE WAY THE ASYNC GROWTH RATIO FLATTERS ITSELF, said out loud.
 *
 * Every growth figure divides by its own n=1. The async path's n=1 includes
 * the message round trip and the structured clone of the result, which the
 * sync path does not pay — so the async denominator is LARGER, and a larger
 * denominator makes the ratio smaller for free. That is a real effect and it
 * is not the product improving.
 *
 * §5 already records what happens when a growth denominator goes unexamined:
 * `createMessage` reported 0.4× growth — a green — because its n=1 carried a
 * cold statement compilation. `burnInCold` fixed that one. This is the same
 * hazard from the other direction, and the answer is the same: show the
 * number that has no denominator. The ABSOLUTE p50 at each concurrency is
 * immune to it, so it is printed beside every ratio.
 */
function crossPath(syncP50: number | undefined, asyncP50: number): string {
  if (syncP50 === undefined) return "";
  return (
    ` · absolute p50 vs the sync path: ${ms(syncP50)} → ${ms(asyncP50)} ` +
    `(${(syncP50 / asyncP50).toFixed(2)}× faster). The ratio above divides by the ` +
    "async n=1, which carries a round trip the sync n=1 does not — so read the " +
    "absolute figure, which has no denominator to flatter."
  );
}

async function main(): Promise<void> {
  const profileName = process.argv[2] ?? "real";
  const noise = measureNoiseFloor();
  const reporter = new Reporter(gitHead());
  console.log(`noise floor: ${(noise * 1000).toFixed(2)}µs\n`);

  const fx = buildFixture(profileName);
  assertReadTargetsPristine(fx);
  const user = fx.users[0]!;
  // READ target and WRITE target are DIFFERENT CHATS, and that separation is
  // the whole reason C1 is comparable across runs. They used to be the same
  // chat: C1 read it, then C2 and C3 appended ~257 messages to it, so every
  // run permanently worsened the next run's read baseline. Measured on the
  // fixture that produced: 1,412 messages in the read target against 46–167
  // in its neighbours, which read as a 1.8× read regression at n=1 across a
  // wave that never touched the read path.
  const readChatId = user.chatIds[Math.floor(user.chatIds.length / 2)]!;
  const writeChatId = user.writeSinkChatId;

  // The async facade over the SAME database file. Opened here so both paths
  // are measured in one process against one fixture under one machine state —
  // the only arrangement in which "before" and "after" describe the same
  // situation.
  const adb = await AsyncDbClient.open({
    path: fx.dbPath,
    keyHome: fixtureKeyHome(dirname(fx.dbPath)),
  });
  console.log(
    `async facade: ${adb.readPoolSize} reader threads + 1 writer ` +
      `(default for this machine: ${defaultReadPoolSize()}), off-thread: ${adb.isOffThread}`,
  );

  const CONCURRENCIES = [1, 5, 10, 25, 50, 100];

  // ── C0: CONTROL — genuinely async work must stay flat ─────────────────
  // If per-op latency here grows with N, the harness cannot detect
  // concurrency and no other verdict below is trustworthy.
  console.log("── C0: control — 20ms of genuinely async work ──");
  const controlBaseline: { p50?: number } = {};
  for (const n of [1, 50]) {
    const r = await fanOut(n, () => new Promise((res) => setTimeout(res, 20)), noise);
    if (n === 1) controlBaseline.p50 = r.perOp.p50Ms;
    reporter.add({
      suite: SUITE,
      name: "control.asyncSleep20ms",
      scale: `${n} concurrent`,
      stats: r.perOp,
      budgetMs: BUDGET.VIEW_MS,
      notes:
        verdictLine(r, n, controlBaseline.p50) +
        " — CONTROL: genuinely async work. Per-op latency here MUST stay flat as N grows; " +
        "if it does not, the harness cannot detect overlap and no verdict below is trustworthy.",
    });
  }

  // ── C1: a synchronous DB read under concurrency ───────────────────────
  console.log("\n── C1: DbClient.getChatHistory under concurrency ──");
  console.log("   (this is what N users opening a conversation at once costs)");
  const baseline: { p50?: number } = {};
  /** Sync p50 per concurrency, so the async rows can state the ABSOLUTE
   * comparison and not only the ratio. See `crossPath`. */
  const syncReadP50 = new Map<number, number>();
  await burnInCold(() => fx.db.getChatHistory(readChatId, user.userId));
  for (const n of CONCURRENCIES) {
    const r = await fanOut(n, () => fx.db.getChatHistory(readChatId, user.userId), noise);
    if (n === 1) baseline.p50 = r.perOp.p50Ms;
    syncReadP50.set(n, r.perOp.p50Ms);
    reporter.add({
      suite: SUITE,
      name: "getChatHistory.concurrent",
      scale: `${n} concurrent`,
      stats: r.perOp,
      budgetMs: BUDGET.VIEW_MS,
      notes: verdictLine(r, n, baseline.p50),
    });
  }

  // ── C1a: the SAME read, through the async facade ──────────────────────
  //
  // Measured in the SAME PROCESS, against the SAME fixture, in the same run
  // as C1. That is deliberate and it is the only way the pair is comparable:
  // the fixture drifts between runs, the page cache differs, the machine's
  // load differs. A before-figure from an earlier run and an after-figure
  // from this one would be two numbers about two situations.
  console.log("\n── C1a: AsyncDbClient.getChatHistory under concurrency (read pool) ──");
  const aBaseline: { p50?: number } = {};
  await burnInCold(() => adb.getChatHistory(readChatId, user.userId));
  for (const n of CONCURRENCIES) {
    const r = await fanOut(n, () => adb.getChatHistory(readChatId, user.userId), noise);
    if (n === 1) aBaseline.p50 = r.perOp.p50Ms;
    reporter.add({
      suite: SUITE,
      name: "getChatHistory.concurrent.async",
      scale: `${n} concurrent`,
      stats: r.perOp,
      budgetMs: BUDGET.VIEW_MS,
      notes:
        verdictLine(r, n, aBaseline.p50) +
        parallelFloor(n, adb.readPoolSize) +
        crossPath(syncReadP50.get(n), r.perOp.p50Ms),
    });
  }

  // ── C2: a synchronous DB WRITE under concurrency ──────────────────────
  // Writes carry a durability barrier (fsync per COMMIT under
  // synchronous=FULL), so this is the worst case and the one that decides
  // how many simultaneous live runs the process can carry.
  console.log("\n── C2: DbClient.createMessage under concurrency ──");
  console.log("   (this is what N users streaming a run at once costs)");
  const content = "x".repeat(2000);
  const wBaseline: { p50?: number } = {};
  await burnInCold(() =>
    fx.db.createMessage({ chat_id: writeChatId, role: "assistant", content }, user.userId),
  );
  for (const n of CONCURRENCIES) {
    const r = await fanOut(
      n,
      () => fx.db.createMessage({ chat_id: writeChatId, role: "assistant", content }, user.userId),
      noise,
    );
    if (n === 1) wBaseline.p50 = r.perOp.p50Ms;
    reporter.add({
      suite: SUITE,
      name: "createMessage.concurrent",
      scale: `${n} concurrent`,
      stats: r.perOp,
      budgetMs: BUDGET.ACK_MS,
      notes: verdictLine(r, n, wBaseline.p50),
    });
  }

  // ── C2a: the SAME write, through the async facade ─────────────────────
  //
  // There is ONE writer thread, by design — the ledger's chain hash depends
  // on write order — so writes are expected to queue. What changes is WHO
  // waits: the queue is on another thread, so the request thread stays free
  // to accept connections, serve reads and answer a health check while it
  // drains. C3 is where that shows up.
  console.log("\n── C2a: AsyncDbClient.createMessage under concurrency (single writer) ──");
  const awBaseline: { p50?: number } = {};
  await burnInCold(() =>
    adb.createMessage({ chat_id: writeChatId, role: "assistant", content }, user.userId),
  );
  for (const n of CONCURRENCIES) {
    const r = await fanOut(
      n,
      () => adb.createMessage({ chat_id: writeChatId, role: "assistant", content }, user.userId),
      noise,
    );
    if (n === 1) awBaseline.p50 = r.perOp.p50Ms;
    reporter.add({
      suite: SUITE,
      name: "createMessage.concurrent.async",
      scale: `${n} concurrent`,
      stats: r.perOp,
      budgetMs: BUDGET.ACK_MS,
      notes: verdictLine(r, n, awBaseline.p50),
    });
  }

  // ── C3: the health check behind the queue ─────────────────────────────
  //
  // The user-visible symptom, measured the only way that is honest: a
  // "health check" that does NO work is issued repeatedly on a 1ms timer
  // while N durable writes are queued. Its own execution time is
  // meaningless (a no-op is always fast); what matters is HOW OFTEN IT GOT
  // TO RUN AT ALL, and how long it waited between turns.
  //
  // An earlier version of this case reported the no-op's own duration and
  // produced ~10µs with n=1 sample — which looked like "instant" and was
  // in fact the opposite: the poller was starved so completely it only ran
  // once. That inversion is exactly the trap this bench exists to avoid,
  // so the case now measures GAPS BETWEEN TURNS, not the turn itself.
  console.log("\n── C3: can a trivial request run at all while N users are writing? ──");
  //
  // THE SHARPEST COMPARISON IN THE FILE. C2/C2a measure what the WRITER
  // costs; this measures what everyone ELSE pays while it works. Both paths
  // queue their writes — one writer is a design decision, not an accident —
  // so the question is not whether writes queue but whether the process can
  // do anything at all while they do.
  for (const path of ["sync", "async"] as const) {
    const write =
      path === "sync"
        ? () => fx.db.createMessage({ chat_id: writeChatId, role: "assistant", content }, user.userId)
        : () => adb.createMessage({ chat_id: writeChatId, role: "assistant", content }, user.userId);
    for (const n of [10, 50]) {
      const gaps: number[] = [];
      let stop = false;
      let lastTurn = process.hrtime.bigint();
      let turns = 0;
      const poller = (async () => {
        while (!stop) {
          await new Promise((r) => setTimeout(r, 1));
          const now = process.hrtime.bigint();
          gaps.push(Number(now - lastTurn) / 1_000_000);
          lastTurn = now;
          turns++;
        }
      })();
      const t0 = process.hrtime.bigint();
      await fanOut(n, write, noise);
      const windowMs = Number(process.hrtime.bigint() - t0) / 1_000_000;
      stop = true;
      await poller;
      const stats = summarize(gaps, noise);
      const expected = Math.max(1, Math.floor(windowMs / 1));
      reporter.add({
        suite: SUITE,
        name: path === "sync" ? "trivialOp.gapWhileWriting" : "trivialOp.gapWhileWriting.async",
        scale: `${n} concurrent writers`,
        stats,
        budgetMs: BUDGET.ACK_MS,
        notes:
          `over a ${ms(windowMs)} window a 1ms poller got ${turns} turns ` +
          `(${expected} expected — ${(100 * (1 - turns / expected)).toFixed(0)}% starved). ` +
          `Worst wait between turns: ${ms(stats.maxMs)}. ` +
          "This is the floor under EVERY other request while writes are in flight — " +
          "/api/health, an SSE token, a keystroke acknowledgement all wait here.",
      });
    }
  }

  // ── The scaling verdict, computed rather than asserted ────────────────
  console.log("\n── verdict ──");
  {
    const r1 = await fanOut(1, () => fx.db.createMessage({ chat_id: writeChatId, role: "assistant", content }, user.userId), noise);
    const per = r1.perOp.p50Ms;
    const capacity = per > 0 ? 1000 / per : Number.NaN;
    reporter.note(
      SUITE,
      "capacity.durableWritesPerSecond",
      `${capacity.toFixed(0)} durable message writes/sec for the WHOLE PROCESS ` +
        `(one write = ${ms(per)} of blocked event loop). Every user, every device, every ` +
        `workspace shares this one number — it does not divide, it queues.`,
    );
    const usersAt200ms = Math.floor(BUDGET.VIEW_MS / per);
    reporter.note(
      SUITE,
      "capacity.usersWithin200msBudget",
      `${usersAt200ms} simultaneous writers before the LAST one exceeds the 200ms view budget ` +
        `(${band(BUDGET.VIEW_MS)} boundary from DESIGN-COCKPIT-V2.md §1.5)`,
    );
  }

  await adb.close();
  fx.close();
  reporter.finish(join(BENCH_OUT_DIR, `concurrency-${profileName}.json`));
}

void main();
