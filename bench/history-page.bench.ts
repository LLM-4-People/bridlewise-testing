/**
 * OPENING A CONVERSATION — before and after the cursor (DESIGN-PERFORMANCE §4).
 *
 * The defect, measured in a browser against this fixture:
 *
 *     GET /api/chats/<id>/history   200
 *       time to headers       7,217ms
 *       time to full body    34,665ms   ← client timeout is 30,000ms
 *       payload                75.1MB   (21,405 messages)
 *
 * The request aborted; the conversation could not be opened at all. This
 * measures the SAME conversation the two ways, IN ONE RUN and IN ONE PROCESS,
 * so the pair describes one situation rather than two:
 *
 *   H1  the whole-conversation read, as the route used to do it: read →
 *       view-map (which redacts) → egress redact → JSON.stringify. Every
 *       stage the response passed through, minus the socket.
 *   H2  the TAIL page, through the same stages.
 *   H3  the full backwards WALK — every page to the beginning — because a
 *       bound that made the open cheap by making the whole conversation
 *       unreadable would not be an improvement.
 *   H4  the egress redaction tax, as a multiple of the `JSON.stringify` it
 *       precedes, on both payloads. §5's budget row.
 *
 * The fixture is READ-ONLY here: `assertReadTargetsPristine` refuses a
 * fixture whose read targets have moved, and nothing in this file writes.
 *
 * Run: node --experimental-strip-types bench/history-page.bench.ts [profile]
 */

import { join } from "node:path";

import { chatHistoryToView, chatHistoryPageToView, chatMessagePageToView } from "../server/routes/views.ts";
import { redactForUserDisplay } from "../server/redaction.ts";
import { serverConfig } from "../server/config.ts";
import { buildFixture, assertReadTargetsPristine } from "./fixtures/scale.ts";
import { measureNoiseFloor, timeSync, ms, bytes, type Stats } from "./lib/stats.ts";
import { Reporter, BENCH_OUT_DIR } from "./lib/report.ts";
import { benchGitHead } from "./lib/machine.ts";

const SUITE = "history-page";

/** A single wall-clock reading, in the shape the reporter records. Used for
 * the cases that are measured ONCE by construction (a full backwards walk is
 * not something to repeat thirty times on a 2GB fixture). */
function oneShot(value: number, noiseFloorMs: number): Stats {
  return {
    n: 1,
    minMs: value,
    p50Ms: value,
    p95Ms: value,
    p99Ms: value,
    maxMs: value,
    meanMs: value,
    totalMs: value,
    noiseFloorMs,
    aboveNoise: value > noiseFloorMs,
  };
}


/** Everything the route does between the database and the socket. */
function serialize(view: unknown): string {
  return JSON.stringify(redactForUserDisplay(view));
}

async function main(): Promise<void> {
  const profileName = process.argv[2] ?? "heavy";
  const noise = measureNoiseFloor();
  const reporter = new Reporter(benchGitHead());
  console.log(`noise floor: ${(noise * 1000).toFixed(2)}µs`);

  const fx = buildFixture(profileName);
  assertReadTargetsPristine(fx);
  const user = fx.users[0]!;

  // The single largest conversation — the one that could not be opened. The
  // fixture names it; the count is a COUNT, never a materialisation.
  const chatId = fx.megaChatId ?? user.chatIds[0]!;
  const target = { chatId, count: fx.db.countMessages(chatId, user.userId) };
  console.log(`\nfixture=${profileName} chat=${target.chatId} messages=${target.count.toLocaleString()}`);
  console.log(`page bound: ${serverConfig.chatHistoryTailRows} rows / ${bytes(serverConfig.chatHistoryPageBytes)}\n`);

  // ── H1: the whole conversation, the way the route used to answer ────────
  console.log("── H1: the whole-conversation read (the defect) ──");
  let wholeBytes = 0;
  const whole = timeSync(() => {
    const history = fx.db.getChatHistory(target.chatId, user.userId)!;
    const view = chatHistoryToView(history);
    wholeBytes = serialize(view).length;
    return view;
  }, noise, { warmup: 0, iterations: 1 });
  console.log(`  read+map+redact+stringify   ${ms(whole.stats.p50Ms)}`);
  console.log(`  payload                     ${bytes(wholeBytes)}`);
  reporter.add({ suite: SUITE, name: "whole-conversation", scale: `${target.count} messages`, stats: whole.stats, bytes: wholeBytes });

  // ── H2: the tail page ───────────────────────────────────────────────────
  console.log("\n── H2: the TAIL page (what opening a conversation costs now) ──");
  let tailBytes = 0;
  let tailRows = 0;
  let cursor: string | null = null;
  const tail = timeSync(() => {
    const page = fx.db.getChatHistoryPage(target.chatId, user.userId)!;
    const view = chatHistoryPageToView(page);
    tailBytes = serialize(view).length;
    tailRows = page.messages.length;
    cursor = page.page.olderCursor;
    return view;
  }, noise, { warmup: 2, iterations: 10 });
  console.log(`  read+map+redact+stringify   ${ms(tail.stats.p50Ms)} p50 / ${ms(tail.stats.p95Ms)} p95`);
  console.log(`  payload                     ${bytes(tailBytes)}   (${tailRows} messages)`);
  console.log(`  vs whole                    ${(whole.stats.p50Ms / tail.stats.p50Ms).toFixed(1)}× faster, ${(wholeBytes / tailBytes).toFixed(1)}× smaller`);
  reporter.add({ suite: SUITE, name: "tail-page", scale: `${target.count} messages`, stats: tail.stats, bytes: tailBytes });

  // ── H3: the whole conversation, one page at a time ──────────────────────
  console.log("\n── H3: the full backwards walk (nothing is unreachable) ──");
  const walkStart = process.hrtime.bigint();
  let pages = 1;
  let walkedRows = tailRows;
  let walkedBytes = tailBytes;
  const worstPage = { ms: tail.stats.p50Ms, bytes: tailBytes };
  while (cursor !== null) {
    const t0 = process.hrtime.bigint();
    const page = fx.db.getChatMessagePage(target.chatId, user.userId, cursor)!;
    const size = serialize(chatMessagePageToView(page)).length;
    const took = Number(process.hrtime.bigint() - t0) / 1e6;
    if (took > worstPage.ms) worstPage.ms = took;
    if (size > worstPage.bytes) worstPage.bytes = size;
    walkedRows += page.messages.length;
    walkedBytes += size;
    cursor = page.page.olderCursor;
    pages += 1;
  }
  const walkMs = Number(process.hrtime.bigint() - walkStart) / 1e6;
  console.log(`  pages                       ${pages}`);
  console.log(`  messages delivered          ${walkedRows.toLocaleString()} of ${target.count.toLocaleString()}`);
  console.log(`  worst single page           ${ms(worstPage.ms)} / ${bytes(worstPage.bytes)}`);
  console.log(`  whole walk                  ${ms(walkMs)} / ${bytes(walkedBytes)}`);
  reporter.add({ suite: SUITE, name: "full-walk", scale: `${target.count} messages`, stats: oneShot(walkMs, noise), bytes: walkedBytes });
  reporter.add({ suite: SUITE, name: "worst-page", scale: `${target.count} messages`, stats: oneShot(worstPage.ms, noise), bytes: worstPage.bytes });

  // ── H4: the egress redaction tax ────────────────────────────────────────
  console.log("\n── H4: egress redaction, as a multiple of the stringify it precedes ──");
  for (const [label, view] of [
    ["tail page", tail.last],
    ["whole conversation", whole.last],
  ] as const) {
    const iters = label === "tail page" ? 20 : 1;
    const stringify = timeSync(() => JSON.stringify(view), noise, { warmup: 1, iterations: iters });
    const redact = timeSync(() => redactForUserDisplay(view), noise, { warmup: 1, iterations: iters });
    const ratio = redact.stats.p50Ms / stringify.stats.p50Ms;
    console.log(
      `  ${label.padEnd(20)} stringify ${ms(stringify.stats.p50Ms).padStart(9)}  redact ${ms(redact.stats.p50Ms).padStart(9)}  = ${ratio.toFixed(2)}×`,
    );
    reporter.add({
      suite: SUITE,
      name: `redaction-ratio/${label.replace(/ /g, "-")}`,
      scale: `${target.count} messages`,
      stats: oneShot(ratio, 0),
      notes: `redact ${ms(redact.stats.p50Ms)} / stringify ${ms(stringify.stats.p50Ms)}`,
    });
  }

  reporter.finish(join(BENCH_OUT_DIR, `${SUITE}-${profileName}.json`));
}

await main();
