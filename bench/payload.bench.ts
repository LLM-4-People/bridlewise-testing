/**
 * PAYLOAD + BUNDLE BENCHMARK — what the client actually downloads.
 *
 * Over-fetching and over-sending are frequently the whole problem, and
 * both are measurable statically, without a running server or a browser:
 *
 *   P1  API response weight at scale, computed from the product's own
 *       DB reads. What does one conversation, one project list, one chat
 *       list actually weigh on the wire — and how does that grow?
 *   P2  Which responses are UNBOUNDED — where weight is a function of user
 *       data with no cap. A payload that is fine today and fatal at scale
 *       is the defining shape of "works on my ten-row fixture".
 *   P3  Bundle composition from `dist/client` — total initial JS/CSS, the
 *       largest chunks, what is on the critical path versus lazily split,
 *       and how much of the build output is source maps.
 *
 * Everything here is a static read of build output plus the product's own
 * query results. Nothing is served, nothing is mutated.
 *
 * Run: node --experimental-strip-types bench/payload.bench.ts [profile]
 */

import { execFileSync } from "node:child_process";
import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { join, extname } from "node:path";
import { gzipSync, brotliCompressSync } from "node:zlib";

import { buildFixture, assertReadTargetsPristine } from "./fixtures/scale.ts";
import { measureNoiseFloor, bytes, BUDGET } from "./lib/stats.ts";
import { Reporter, BENCH_OUT_DIR } from "./lib/report.ts";
import { BUNDLE_TOP_CHUNKS_SHOWN } from "./bench-config.ts";

const SUITE = "payload";

function gitHead(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/** Wire weight of a JSON response: raw, gzip and brotli. */
function wireWeight(value: unknown): { raw: number; gzip: number; brotli: number } {
  // `JSON.stringify(undefined)` is `undefined`, not a string — guard it so a
  // missing read reports as zero weight rather than crashing the run.
  const json = Buffer.from(JSON.stringify(value) ?? "null", "utf8");
  return {
    raw: json.byteLength,
    gzip: gzipSync(json).byteLength,
    brotli: brotliCompressSync(json).byteLength,
  };
}

async function main(): Promise<void> {
  const profileName = process.argv[2] ?? "real";
  const noise = measureNoiseFloor();
  const reporter = new Reporter(gitHead());

  // ── P3: bundle composition ────────────────────────────────────────────
  console.log("── P3: build output composition ──");
  const distDir = join(process.cwd(), "dist", "client");
  if (!existsSync(distDir)) {
    reporter.note(SUITE, "bundle", "dist/client not present — run `npm run build` first");
  } else {
    const assetsDir = join(distDir, "assets");
    const files = existsSync(assetsDir)
      ? readdirSync(assetsDir).map((f) => ({ name: f, size: statSync(join(assetsDir, f)).size }))
      : [];
    const js = files.filter((f) => extname(f.name) === ".js");
    const css = files.filter((f) => extname(f.name) === ".css");
    const maps = files.filter((f) => f.name.endsWith(".map"));
    const sum = (xs: ReadonlyArray<{ size: number }>): number => xs.reduce((a, b) => a + b.size, 0);

    reporter.note(
      SUITE,
      "bundle.total",
      `${js.length} JS chunks ${bytes(sum(js))} · ${css.length} CSS ${bytes(sum(css))} · ` +
        `${maps.length} source maps ${bytes(sum(maps))} ` +
        `(maps are ${((sum(maps) / (sum(js) + sum(css) + sum(maps))) * 100).toFixed(0)}% of build output)`,
    );

    // What the entry HTML actually pulls in synchronously is the critical
    // path; everything else is only fetched if something imports it.
    const indexHtml = join(distDir, "index.html");
    if (existsSync(indexHtml)) {
      const html = readFileSync(indexHtml, "utf8");
      const refs = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((m) => m[1]!);
      let critical = 0;
      const detail: string[] = [];
      for (const ref of refs) {
        const p = join(distDir, ref.replace(/^\//, ""));
        if (existsSync(p)) {
          const size = statSync(p).size;
          critical += size;
          detail.push(`${ref.split("/").pop()} ${bytes(size)}`);
        }
      }
      const gz = refs
        .map((r) => join(distDir, r.replace(/^\//, "")))
        .filter(existsSync)
        .reduce((a, p) => a + gzipSync(readFileSync(p)).byteLength, 0);
      reporter.note(
        SUITE,
        "bundle.criticalPath",
        `${bytes(critical)} raw / ${bytes(gz)} gzip referenced directly by index.html — ${detail.join(", ")}`,
      );
    }

    const top = [...files]
      .sort((a, b) => b.size - a.size)
      .filter((f) => !f.name.endsWith(".map"))
      .slice(0, BUNDLE_TOP_CHUNKS_SHOWN);
    for (const f of top) {
      const p = join(assetsDir, f.name);
      reporter.note(
        SUITE,
        `bundle.chunk.${f.name.replace(/-[A-Za-z0-9_-]{8}\./, ".")}`,
        `${bytes(f.size)} raw / ${bytes(gzipSync(readFileSync(p)).byteLength)} gzip`,
      );
    }
  }

  // ── P1/P2: API response weight, from the product's own reads ──────────
  console.log("\n── P1/P2: response weight at scale ──");
  const fx = buildFixture(profileName);
  assertReadTargetsPristine(fx);
  const user = fx.users[0]!;
  console.log(
    `fixture "${profileName}": ${fx.counts.projects} projects, ${fx.counts.chats} chats, ${fx.counts.messages} messages\n`,
  );

  const rows: Array<{ name: string; w: ReturnType<typeof wireWeight>; scale: string; note: string }> = [];

  {
    const v = fx.db.listProjects(user.userId);
    rows.push({
      name: "GET /api/projects",
      w: wireWeight(v),
      scale: `${v.length} projects`,
      note: "UNBOUNDED — every project the user owns, no paging parameter exists",
    });
  }
  {
    const pid = user.projectIds[0]!;
    const v = fx.db.listChats(pid, user.userId);
    rows.push({
      name: "GET /api/projects/:id/chats",
      w: wireWeight(v),
      scale: `${v.length} chats`,
      note: "UNBOUNDED — the whole sidebar in one response, no paging parameter exists",
    });
  }
  {
    // Largest chat in the fixture — the worst case a real user reaches.
    let worst = { id: user.chatIds[0] ?? "", n: 0 };
    for (const cid of user.chatIds) {
      const n = fx.db.listMessages(cid, user.userId).length;
      if (n > worst.n) worst = { id: cid, n };
      if (worst.n > 5000) break;
    }
    const target = fx.megaChatId ?? worst.id;
    console.log(`   worst-case chat: ${target} with ${worst.n} messages`);
    const hist = fx.db.getChatHistory(target, user.userId);
    const msgs = hist?.messages.length ?? 0;
    rows.push({
      name: "GET /api/chats/:id/history",
      w: wireWeight(hist),
      scale: `${msgs} messages`,
      note:
        "UNBOUNDED — messages + tool calls + metrics + timeline refs for the WHOLE conversation " +
        "in a single response. There is no cursor and no limit parameter; opening a long " +
        "conversation transfers all of it, every time.",
    });
    if (hist) {
      rows.push({
        name: "  ↳ messages only",
        w: wireWeight(hist.messages),
        scale: `${msgs} messages`,
        note: "the share of the history payload that is message content",
      });
      rows.push({
        name: "  ↳ tool calls only",
        w: wireWeight(hist.tool_calls),
        scale: `${hist.tool_calls.length} tool calls`,
        note:
          "tool INPUT and OUTPUT are stored and returned verbatim — a single file-read tool " +
          "result can be hundreds of KB, and it is re-sent on every history load",
      });
    }
  }
  {
    const cid = user.chatIds[0]!;
    const v = fx.db.listTimelineRefs(cid, user.userId);
    rows.push({
      name: "GET /api/chats/:id/timeline",
      w: wireWeight(v),
      scale: `${v.length} refs`,
      note: "UNBOUNDED — every timeline ref for the chat",
    });
  }

  for (const r of rows) {
    reporter.note(
      SUITE,
      r.name,
      `[${r.scale}] ${bytes(r.w.raw)} raw · ${bytes(r.w.gzip)} gzip · ${bytes(r.w.brotli)} brotli — ${r.note}`,
    );
  }

  // Per-message wire cost, the number that predicts every long conversation.
  {
    const cid = fx.megaChatId ?? user.chatIds[0]!;
    const msgs = fx.db.listMessages(cid, user.userId);
    if (msgs.length > 0) {
      const w = wireWeight(msgs);
      const perMsg = w.raw / msgs.length;
      const perMsgGz = w.gzip / msgs.length;
      reporter.note(
        SUITE,
        "perMessage.wireCost",
        `${bytes(perMsg)} raw / ${bytes(perMsgGz)} gzip per message. ` +
          `A 1,000-message conversation therefore costs ${bytes(perMsg * 1000)} raw / ` +
          `${bytes(perMsgGz * 1000)} gzip on EVERY open, with no incremental load path.`,
      );
      // Against the 200ms view budget on a typical connection.
      for (const [label, mbps] of [["fast home 100Mbps", 100], ["typical 4G 20Mbps", 20], ["weak 4G 5Mbps", 5]] as const) {
        const msAt = (perMsgGz * 1000 * 8) / (mbps * 1_000_000) * 1000;
        reporter.note(
          SUITE,
          `perMessage.transferAt.${mbps}mbps`,
          `${label}: a 1,000-message history = ${msAt.toFixed(0)}ms of transfer alone ` +
            `(budget for a view open is ${BUDGET.VIEW_MS}ms, and this is before the server ` +
            `reads it, before decrypt, and before render)`,
        );
      }
    }
  }

  fx.close();
  reporter.finish(join(BENCH_OUT_DIR, `payload-${profileName}.json`));
}

void main();
