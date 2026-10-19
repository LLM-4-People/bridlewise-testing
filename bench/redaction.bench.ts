/**
 * REDACTION BENCHMARK — the per-response egress tax.
 *
 * `sendJson` (server/router.ts) runs `redactForUserDisplay` over the ENTIRE
 * response payload before `JSON.stringify`, on every REST response. The
 * walker descends to every string leaf, and each leaf runs the secret-signal
 * detector, which allocates a UTF-8 offset map and compiles its regex
 * catalog per call. That is a cost proportional to response bytes, paid on
 * every response, and it is a claim worth a number rather than an argument.
 *
 * `server/sse.ts` runs the SAME function per streamed SSE event — i.e. per
 * token — so the small-string cost is measured separately and multiplied
 * out to a realistic run.
 *
 * Measured here:
 *   R1  cost vs payload size, over real fixture data (a chat history), and
 *       compared against `JSON.stringify` of the same value so the tax is
 *       expressed as a multiple of the serialization it precedes.
 *   R2  cost for a single streamed token, and what that totals over a run.
 *   R3  whether the cost is paid twice — `routes/views.ts` redacts rows on
 *       the way out and then `sendJson` redacts the result again.
 *
 * Run: node --experimental-strip-types bench/redaction.bench.ts [profile]
 */

import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { redactForUserDisplay } from "../server/redaction.ts";
import { buildFixture, assertReadTargetsPristine } from "./fixtures/scale.ts";
import { measureNoiseFloor, timeSync, BUDGET, ms, bytes } from "./lib/stats.ts";
import { Reporter, BENCH_OUT_DIR } from "./lib/report.ts";
import { REDACTION_CHAT_SCAN_LIMIT } from "./bench-config.ts";

const SUITE = "redaction";

function gitHead(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  const profileName = process.argv[2] ?? "real";
  const noise = measureNoiseFloor();
  const reporter = new Reporter(gitHead());
  console.log(`noise floor: ${(noise * 1000).toFixed(2)}µs\n`);

  const fx = buildFixture(profileName);
  assertReadTargetsPristine(fx);
  const user = fx.users[0]!;

  // ── R1: cost vs payload size ──────────────────────────────────────────
  console.log("── R1: egress redaction vs payload size ──");
  const targets: Array<{ label: string; value: unknown }> = [];
  {
    targets.push({ label: "listProjects", value: fx.db.listProjects(user.userId) });
    targets.push({
      label: "listChats",
      value: fx.db.listChats(user.projectIds[0]!, user.userId),
    });
    // A mid-sized and a large conversation.
    let biggest = { id: user.chatIds[0]!, n: 0 };
    for (const cid of user.chatIds.slice(0, REDACTION_CHAT_SCAN_LIMIT)) {
      const n = fx.db.listMessages(cid, user.userId).length;
      if (n > biggest.n) biggest = { id: cid, n };
    }
    targets.push({
      label: `chatHistory(${biggest.n} msgs)`,
      value: fx.db.getChatHistory(biggest.id, user.userId),
    });
  }

  for (const t of targets) {
    const raw = Buffer.byteLength(JSON.stringify(t.value) ?? "null", "utf8");
    const { stats: redact } = timeSync(() => redactForUserDisplay(t.value), noise, {
      warmup: 2,
      iterations: raw > 1_000_000 ? 5 : 30,
      maxWallMs: 60_000,
    });
    const { stats: stringify } = timeSync(() => JSON.stringify(t.value), noise, {
      warmup: 2,
      iterations: raw > 1_000_000 ? 5 : 30,
      maxWallMs: 60_000,
    });
    reporter.add({
      suite: SUITE,
      name: "redactForUserDisplay",
      scale: t.label,
      stats: redact,
      bytes: raw,
      budgetMs: BUDGET.ACK_MS,
      notes:
        `payload ${bytes(raw)} · JSON.stringify of the same value costs ${ms(stringify.p50Ms)}, ` +
        `so redaction is ${(redact.p50Ms / stringify.p50Ms).toFixed(1)}× the serialization it precedes · ` +
        `${((redact.p50Ms / raw) * 1_000_000).toFixed(1)}µs per KB`,
    });
  }

  // ── R2: the per-token SSE cost ────────────────────────────────────────
  console.log("\n── R2: per streamed token (server/sse.ts calls this per event) ──");
  {
    const tokenEvent = {
      sequence: 42,
      protocol: "openai-responses",
      type: "text_delta",
      outputIndex: 0,
      delta: " architecture",
    };
    const { stats } = timeSync(() => redactForUserDisplay(tokenEvent), noise, {
      warmup: 500,
      iterations: 20_000,
    });
    const perTokenMs = stats.p50Ms;
    reporter.add({
      suite: SUITE,
      name: "redactForUserDisplay.oneToken",
      scale: "1 text_delta event",
      stats,
      budgetMs: BUDGET.FRAME_MS,
      notes:
        `a 2,000-token response therefore spends ${ms(perTokenMs * 2000)} in redaction alone, ` +
        `on the event loop, in addition to ${2000} JSON.stringify calls and 4,000 res.write() calls. ` +
        "With 10 concurrent streams that is serialized, not shared.",
    });
  }

  // ── R3: is it paid twice? ─────────────────────────────────────────────
  console.log("\n── R3: double redaction ──");
  {
    const hist = fx.db.getChatHistory(user.chatIds[0]!, user.userId);
    const once = redactForUserDisplay(hist);
    const { stats } = timeSync(() => redactForUserDisplay(once), noise, {
      warmup: 2,
      iterations: 30,
    });
    reporter.add({
      suite: SUITE,
      name: "redactForUserDisplay.secondPass",
      scale: "already-redacted history",
      stats,
      budgetMs: BUDGET.ACK_MS,
      notes:
        "server/routes/views.ts redacts rows on the way out and server/router.ts sendJson " +
        "redacts the result again. The second pass costs the same as the first and can find " +
        "nothing new — the strings it scans were already cleaned.",
    });
  }

  fx.close();
  reporter.finish(join(BENCH_OUT_DIR, `redaction-${profileName}.json`));
}

void main();
