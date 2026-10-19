/**
 * WIRE LOAD SUITE — the product over the real network stack.
 *
 * The gap this fills: every number in `bench/*.bench.ts` is IN-PROCESS. They
 * construct a `DbClient` and call it, which skips the whole server — the auth
 * gate's `countUsers()` per request, `resolveAuthUser`'s session lookup, the
 * CSRF check, the rate-limit bucket, the redaction walk at the `sendJson`
 * choke point, `JSON.stringify`, the socket, the kernel. A read that is 40ms
 * in-process and 400ms over the wire is a 360ms product defect that the
 * existing harness cannot see, and 100 concurrent connections is a question
 * an in-process bench cannot even ask.
 *
 * WHAT IS MEASURED, and why each shape is kept apart
 *
 *   latency      Per endpoint CLASS, serially, on ONE connection. This is the
 *                uncontended floor — the best the product can do. Every
 *                concurrency number is judged against it, because "no added
 *                latency at 100 connections" is a comparison, not an absolute.
 *   sse          First byte, and the distribution of INTER-EVENT GAPS. A
 *                stream's health is its gaps; a mean over them hides the one
 *                three-second stall that is the whole finding.
 *   concurrency  N DISTINCT connections running N DISTINCT runs. The shape
 *                the product claims to support.
 *   runshare     MULTIPLE connections on ONE run. Kept in its own phase and
 *                never merged into the headline, because
 *                `GET /api/run/:runId/stream` is the run EXECUTOR, not a
 *                subscriber: a second connection starts a second full
 *                execution and the first disconnect aborts the run. Blending
 *                a known-broken shape into a concurrency number would produce
 *                a headline that is neither the working case nor the broken
 *                one.
 *   sustained    RSS and WAL growth over time, and whether ONE stalled client
 *                back-pressures the others (`server/sse.ts` discards
 *                `res.write()`'s return value and never listens for `drain`).
 *   saturate     At and past the limit. The requirement is an HONEST REFUSAL
 *                — a clear status and a typed code — not a hang and not a
 *                silent slide past every budget. This phase classifies which
 *                of the three actually happens.
 *
 * HONESTY RULES THIS SUITE ENFORCES ON ITSELF
 *   · Machine conditions are stamped by `Reporter` (bench/lib/report.ts) and
 *     a NOT-QUIET box makes every number an upper bound, loudly.
 *   · The noise floor is measured once and threaded into every `Stats`, so
 *     `meaningful` marks anything indistinguishable from the act of measuring.
 *   · The observer is itself measured: `probe/observer-cost` runs the same
 *     case with the in-process probe on and off. If they disagree beyond the
 *     floor, the probe is distorting what it observes and the report says so.
 *   · Event-loop lag is sampled INSIDE the server process
 *     (`bench/wire/preload-lag.ts`, loaded with `--import`; no product code
 *     is touched) and windowed to each phase. When the sampler is itself
 *     starved, the lag percentiles are reported as a LOWER BOUND rather than
 *     as the answer.
 *
 * Usage
 *   node --experimental-strip-types bench/wire/load.ts --profile tiny --validate
 *   node --experimental-strip-types bench/wire/load.ts --profile fleet --only latency,sse
 *   node --experimental-strip-types bench/wire/load.ts --profile fleet --connections 100 --users 50
 *   node --experimental-strip-types bench/wire/load.ts --profile real --baseline bench/wire-baseline.json
 *
 * Reports land in BENCH_OUT_DIR as `wire-<profile>.json`, in the exact shape
 * `bench/lib/report.ts` expects, so `diffReports` works across runs.
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { Reporter, loadReport, diffReports, BENCH_OUT_DIR, type Measurement } from "../lib/report.ts";
import { measureNoiseFloor, summarize, ms, bytes as fmtBytes, BUDGET, type Stats } from "../lib/stats.ts";
import { snapshotMachine } from "../lib/machine.ts";
import { makeRng } from "../fixtures/scale.ts";
import { WireClient, openSse, readProbe, type WireSession, type WireResult } from "./client.ts";
import { summarizeProbeLag } from "./preload-lag.ts";
import { OVERFLOW_BODY_QUOTE_CHARS, WIRE_DIFF_ROWS_SHOWN } from "../bench-config.ts";
import {
  startServer,
  FIXTURE_PASSWORD,
  killPid,
  reapStrayInstances,
  clearScratch,
  pickPort,
  sleep,
  type ServerInstance,
} from "./server.ts";

// ── CLI ──────────────────────────────────────────────────────────────────

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(name);
}
function argInt(name: string, fallback: number): number {
  const v = arg(name);
  const n = v === undefined ? Number.NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const PROFILE = arg("--profile") ?? "tiny";
const VALIDATE = flag("--validate");
const ONLY = arg("--only")?.split(",").map((s) => s.trim());
const CONNECTIONS = argInt("--connections", VALIDATE ? 4 : 100);
const USERS = argInt("--users", VALIDATE ? 1 : 50);
const SUSTAIN_MS = argInt("--sustain-ms", VALIDATE ? 4_000 : 60_000);
const BASELINE = arg("--baseline");
/** Override the load instance's limiter. `--rate-limit 60 --rate-limit-refill-ms 60000`
 *  reproduces the SHIPPED constraint under load, which is what a real user meets. */
const RATE_LIMIT = argInt("--rate-limit", 10_000);
const RATE_LIMIT_REFILL_MS = argInt("--rate-limit-refill-ms", 1_000);
/** Keep bench/.scratch/ after the run. Each fleet copy is 1.58GB. */
const KEEP_SCRATCH = flag("--keep-scratch");

/** Deterministic id selection: same profile → same chats requested, every run. */
const rng = makeRng(0xc0ffee);

// ── Endpoint catalogue ───────────────────────────────────────────────────

type EndpointClass = {
  readonly name: string;
  /** What KIND of cost this isolates — the reason the class exists. */
  readonly what: string;
  readonly method: string;
  readonly path: (ctx: PathCtx) => string;
  readonly json?: (ctx: PathCtx) => unknown;
  readonly budgetMs: number;
  /** Iterations for the serial latency phase. Heavy reads get fewer. */
  readonly iterations: number;
  readonly warmup: number;
  /** Include in the concurrency / sustained phases (cheap, representative). */
  readonly inLoad: boolean;
  /** A mutation — subject to the rate limiter, which GETs are exempt from. */
  readonly mutating: boolean;
};

type PathCtx = {
  readonly projectId: string;
  readonly projectPath: string;
  readonly chatId: string;
  /** The largest chat in the fixture when there is one — the worst-case read. */
  readonly bigChatId: string;
  readonly nonce: number;
};

/**
 * THE CATALOGUE IS COCKPIT-WEIGHTED, FROM EVIDENCE.
 *
 * This repo has two front ends. The old one (`src/**​/lib/**`, `App.svelte`)
 * is scheduled for deletion at cutover; the new one is `src/cockpit/**`. The
 * server is shared, so the server-side findings are unaffected — but ROUTE
 * SELECTION is, and a headline latency number driven by a route only the
 * dying UI touches would be work ranked against a corpse.
 *
 * Every class below was traced from the client source, not from the route
 * table. The cockpit issues no `fetch` of its own: everything goes through
 * `src/lib/data/broker.ts::fetchJson` and `src/client.ts`, which is what
 * makes the tracing decidable.
 *
 * `tier` records WHY a class is here, and it is what stops a legacy route
 * from quietly driving a headline:
 *   boot     one of the cockpit's SEQUENTIAL startup probes
 *            (src/cockpit/boot/probes.ts) — the user stares at these
 *   view     a cockpit per-view read, mostly block reads under /api/b/
 *   poll     the cockpit's ONE timer (5s, ref-counted to one room)
 *   write    a cockpit mutation
 *   legacy   NOT called by the cockpit. Measured for contrast only, never
 *            in the load profile, never ranked for fixing.
 */
type Tier = "boot" | "view" | "poll" | "write" | "legacy";

/**
 * Block reads are `GET /api/b/<blockId>?<zod-validated query>`; block actions
 * are `POST /api/b/<blockId>/<action>`. The id is NOT re-encoded — the dot
 * stays literal (shared/block-contract.ts::blockReadPath).
 */
function blockRead(id: string, query: string): string {
  return `/api/b/${id}${query ? `?${query}` : ""}`;
}

const CLASSES: readonly (EndpointClass & { readonly tier: Tier })[] = [
  // ── The cockpit's boot burst, in the order probes.ts issues it ──────────
  // These are STRICTLY SEQUENTIAL (each `await measure(...)`), so their
  // latencies ADD. That is why `boot-burst` below measures them as one
  // number as well as individually: the user waits for the sum.
  {
    name: "boot1.health",
    what: "boot step 1 — no auth, no DB: the pure middleware + socket floor",
    tier: "boot",
    method: "GET",
    path: () => "/api/health",
    budgetMs: BUDGET.ACK_MS,
    iterations: 200,
    warmup: 30,
    inLoad: true,
    mutating: false,
  },
  {
    name: "boot2.auth-status",
    what: "boot step 2 — public, but pays countUsers() + session resolve: the auth tax alone",
    tier: "boot",
    method: "GET",
    path: () => "/api/auth/status",
    budgetMs: BUDGET.ACK_MS,
    iterations: 200,
    warmup: 30,
    inLoad: true,
    mutating: false,
  },
  {
    name: "boot3.schema-ui",
    what: "boot step 3 — the served UI schema + block-action manifest the cockpit is built from",
    tier: "boot",
    method: "GET",
    path: () => "/api/schema/ui",
    budgetMs: BUDGET.VIEW_MS,
    iterations: 120,
    warmup: 20,
    inLoad: true,
    mutating: false,
  },
  {
    name: "boot4.projects-list",
    what: "boot step 4 — auth-gated list, the smallest real read",
    tier: "boot",
    method: "GET",
    path: () => "/api/projects",
    budgetMs: BUDGET.VIEW_MS,
    iterations: 150,
    warmup: 20,
    inLoad: true,
    mutating: false,
  },
  {
    name: "boot5.intelligence-map",
    what: "boot step 5 — the repository map for the open project",
    tier: "boot",
    method: "GET",
    path: (c) => `/api/intelligence/map?path=${encodeURIComponent(c.projectPath)}`,
    budgetMs: BUDGET.VIEW_MS,
    iterations: 30,
    warmup: 3,
    inLoad: false,
    mutating: false,
  },
  {
    name: "boot6.chats-list",
    what: "boot step 6 — the chat list, which grows with the user's history",
    tier: "boot",
    method: "GET",
    path: (c) => `/api/projects/${c.projectId}/chats`,
    budgetMs: BUDGET.VIEW_MS,
    iterations: 150,
    warmup: 20,
    inLoad: true,
    mutating: false,
  },
  {
    name: "boot7.chat-history",
    what:
      "boot step 7 — THE heavy read, and it is on the pre-paint critical path. " +
      "This is the cockpit's only conversation read; it never calls /messages",
    tier: "boot",
    method: "GET",
    path: (c) => `/api/chats/${c.chatId}/history`,
    budgetMs: BUDGET.VIEW_MS,
    iterations: 30,
    warmup: 3,
    inLoad: true,
    mutating: false,
  },
  {
    name: "chat-history-worst",
    what: "the known pathology — the LARGEST chat, whole, in one blocking response",
    tier: "boot",
    method: "GET",
    path: (c) => `/api/chats/${c.bigChatId}/history`,
    budgetMs: BUDGET.VIEW_MS,
    iterations: 8,
    warmup: 1,
    inLoad: false,
    mutating: false,
  },

  // ── Cockpit per-view reads (the block surface) ──────────────────────────
  {
    name: "block.conversation-pulse",
    what: "switch room — a ledger rollup for the open chat (15s TTL, warmed on hover)",
    tier: "view",
    method: "GET",
    path: (c) => blockRead("synthesis.conversationPulse", `chatId=${encodeURIComponent(c.chatId)}`),
    budgetMs: BUDGET.VIEW_MS,
    iterations: 60,
    warmup: 8,
    inLoad: true,
    mutating: false,
  },
  {
    name: "block.sweep-spectrum",
    what: "switch + sweep rooms — time-binned ledger density (5s TTL, invalidated on run:done)",
    tier: "view",
    method: "GET",
    path: (c) => blockRead("sweep.spectrum", `scope=chat&chatId=${encodeURIComponent(c.chatId)}&bins=64`),
    budgetMs: BUDGET.VIEW_MS,
    iterations: 60,
    warmup: 8,
    inLoad: true,
    mutating: false,
  },
  {
    name: "block.tools-breaker",
    what: "desk — per-tool breaker rows folded from the ledger (5s TTL)",
    tier: "view",
    method: "GET",
    path: (c) => blockRead("tools.breaker", `chatId=${encodeURIComponent(c.chatId)}`),
    budgetMs: BUDGET.VIEW_MS,
    iterations: 60,
    warmup: 8,
    inLoad: true,
    mutating: false,
  },
  {
    name: "block.custody-state",
    what: "custody room — REAL `git status` joined against the ledger (5s TTL). Shells out",
    tier: "view",
    method: "GET",
    path: (c) => blockRead("custody.state", `projectId=${encodeURIComponent(c.projectId)}`),
    budgetMs: BUDGET.VIEW_MS,
    iterations: 20,
    warmup: 3,
    inLoad: false,
    mutating: false,
  },
  {
    name: "block.run-compose",
    what: "desk — the next-turn composition fold (5s TTL)",
    tier: "view",
    method: "GET",
    path: (c) => blockRead("run.compose", `chatId=${encodeURIComponent(c.chatId)}`),
    budgetMs: BUDGET.VIEW_MS,
    iterations: 60,
    warmup: 8,
    inLoad: true,
    mutating: false,
  },

  // ── The cockpit's only timer ───────────────────────────────────────────
  {
    name: "poll.schema-values",
    what:
      "the ONLY polling timer in the cockpit: 5s, ref-counted to the instruments room " +
      "(the legacy UI polls this app-wide and unconditionally — see the legacy note)",
    tier: "poll",
    method: "GET",
    path: () => "/api/schema/ui/values",
    budgetMs: BUDGET.VIEW_MS,
    iterations: 120,
    warmup: 20,
    inLoad: true,
    mutating: false,
  },

  // ── Cockpit writes ─────────────────────────────────────────────────────
  {
    name: "write.create-chat",
    what: "a cockpit mutation — the rate limiter's only visible surface (GET is exempt)",
    tier: "write",
    method: "POST",
    path: (c) => `/api/projects/${c.projectId}/chats`,
    json: (c) => ({ title: `bench wire chat ${c.nonce}` }),
    budgetMs: BUDGET.ACK_MS,
    iterations: 40,
    warmup: 5,
    inLoad: false,
    mutating: true,
  },

  // ── Gate cost with no handler ──────────────────────────────────────────
  {
    name: "unmatched-route",
    what: "auth gate + CSRF + route-table walk, then 404 — the middleware cost alone",
    tier: "view",
    method: "GET",
    path: () => "/api/__bench_no_such_route__",
    budgetMs: BUDGET.ACK_MS,
    iterations: 200,
    warmup: 30,
    inLoad: false,
    mutating: false,
  },

  // ── LEGACY-ONLY. Measured for contrast; never in the load profile ───────
  {
    name: "legacy.chat-messages",
    what:
      "LEGACY-ONLY (dying): GET /api/chats/:id/messages. `getChatMessages` is not imported " +
      "anywhere under src/cockpit/**. Measured only so the cockpit's /history cost has a comparison",
    tier: "legacy",
    method: "GET",
    path: (c) => `/api/chats/${c.chatId}/messages`,
    budgetMs: BUDGET.VIEW_MS,
    iterations: 30,
    warmup: 3,
    inLoad: false,
    mutating: false,
  },
  {
    name: "legacy.message-write",
    what: "LEGACY-ONLY (dying): POST /api/chats/:id/messages — the cockpit writes turns via /api/run/start",
    tier: "legacy",
    method: "POST",
    path: (c) => `/api/chats/${c.chatId}/messages`,
    json: (c) => ({ role: "user", content: `bench wire write ${c.nonce}` }),
    budgetMs: BUDGET.ACK_MS,
    iterations: 30,
    warmup: 3,
    inLoad: false,
    mutating: true,
  },
];

/** The cockpit boot burst, in issue order — sequential, so the costs ADD. */
const BOOT_SEQUENCE = ["boot1.health", "boot2.auth-status", "boot3.schema-ui", "boot4.projects-list", "boot5.intelligence-map", "boot6.chats-list", "boot7.chat-history"] as const;

// ── Helpers ──────────────────────────────────────────────────────────────

/** projectId → on-disk path, resolved once from the live server. */
const projectPaths = new Map<string, string>();

/**
 * Fetch a class by name from the PREFLIGHT-SURVIVING set.
 *
 * Throws rather than substituting. A phase that quietly swapped in a
 * different endpoint because its intended one was dropped would publish a
 * number under the wrong name, and the report's whole value is that
 * `suite/name[scale]` means the same thing in every run.
 */
function pick(
  classes: ReadonlyArray<EndpointClass & { tier: Tier }>,
  name: string,
): EndpointClass & { tier: Tier } {
  const found = classes.find((c) => c.name === name);
  if (!found) {
    throw new Error(
      `endpoint class "${name}" did not survive preflight, so this phase cannot run against it. ` +
        `See the wire.preflight/dropped-classes note for why it was excluded.`,
    );
  }
  return found;
}

function pickCtx(inst: ServerInstance, userIndex: number, nonce: number): PathCtx {
  const user = inst.ids.users[userIndex % inst.ids.users.length]!;
  const projectId = user.projectIds[Math.floor(rng() * user.projectIds.length)] ?? "";
  const chatId = user.chatIds[Math.floor(rng() * user.chatIds.length)] ?? "";
  // `megaChatId` is the deliberate worst case (20k messages) and only the
  // `heavy` profile has one. Without it, fall back to the first chat and SAY
  // SO in the case notes — silently measuring a 10-message chat and labelling
  // it "worst case" is exactly the lie this harness exists to prevent.
  const bigChatId = inst.ids.megaChatId ?? chatId;
  return { projectId, projectPath: projectPaths.get(projectId) ?? "", chatId, bigChatId, nonce };
}

/**
 * PREFLIGHT — ask the server, once, what every class actually returns.
 *
 * A latency case that quietly measures a 404 or a 400 is worse than no case
 * at all: it produces a fast, confident, meaningless number. So every class
 * is fired once before the suite runs, and any class that does not answer
 * 2xx is DROPPED from the measured set and RECORDED as dropped, with the
 * status and the response body. Two things this catches routinely:
 * a block whose zod query schema disagrees with the query the bench built,
 * and a route whose handler depends on state the fixture does not have
 * (the fixture's project paths are synthetic — no such directory, no git
 * repo — so anything that touches the filesystem for a project will fail
 * here, which is a fact about the FIXTURE and must be reported as one).
 */
async function preflight(
  inst: ServerInstance,
  rep: Reporter,
): Promise<ReadonlyArray<EndpointClass & { readonly tier: Tier }>> {
  const session = inst.sessions[0]!;
  const client = new WireClient(inst.port);
  try {
    // Resolve real project paths first — boot5 needs one and the manifest
    // does not carry it.
    const list = await client.request({ path: "/api/projects", session, keepBody: true });
    try {
      const rows = JSON.parse(list.body ?? "[]") as ReadonlyArray<{ id?: string; path?: string }>;
      for (const row of rows) if (row.id && row.path) projectPaths.set(row.id, row.path);
    } catch {
      /* reported by the per-class probe below */
    }

    const kept: (EndpointClass & { tier: Tier })[] = [];
    const dropped: string[] = [];
    for (const cls of CLASSES) {
      const ctx = pickCtx(inst, 0, 0);
      const r = await client.request({
        method: cls.method,
        path: cls.path(ctx),
        session: cls.name === "boot1.health" ? null : session,
        ...(cls.json ? { json: cls.json(ctx) } : {}),
        keepBody: true,
        timeoutMs: 120_000,
      });
      const expected = cls.name === "unmatched-route" ? r.status === 404 : r.status >= 200 && r.status < 300;
      if (expected) {
        kept.push(cls);
      } else {
        dropped.push(
          `${cls.name} (${cls.method} ${cls.path(ctx)}) → ${r.status} ${(r.body ?? r.error ?? "").slice(0, 200)}`,
        );
      }
    }
    if (dropped.length > 0) {
      rep.note(
        "wire.preflight",
        "dropped-classes",
        `${dropped.length} endpoint class(es) did NOT answer as expected and are EXCLUDED from every ` +
          `measurement below — they would have produced fast, confident numbers for an error path:\n` +
          dropped.map((d) => `         · ${d}`).join("\n"),
      );
    }
    rep.note(
      "wire.preflight",
      "measured-classes",
      `${kept.length}/${CLASSES.length} classes measured · ` +
        `cockpit boot ${kept.filter((c) => c.tier === "boot").length}, ` +
        `cockpit view ${kept.filter((c) => c.tier === "view").length}, ` +
        `cockpit poll ${kept.filter((c) => c.tier === "poll").length}, ` +
        `cockpit write ${kept.filter((c) => c.tier === "write").length}, ` +
        `LEGACY (excluded from the load profile and from the fix ranking) ${kept.filter((c) => c.tier === "legacy").length}`,
    );
    return kept;
  } finally {
    client.destroy();
  }
}

/**
 * The cockpit's boot burst as ONE number.
 *
 * `src/cockpit/boot/probes.ts` awaits each step in turn, so what the user
 * experiences before first paint is the SUM, not the max. Measuring the
 * steps individually and leaving the reader to add them up invites the
 * reassuring per-step verdict ("all under 200ms") to hide a boot that is
 * over a second — which is the number that actually decides whether the
 * product feels alive.
 */
async function phaseBootBurst(
  inst: ServerInstance,
  rep: Reporter,
  classes: ReadonlyArray<EndpointClass & { tier: Tier }>,
  noiseFloor: number,
  scale: string,
): Promise<void> {
  const seq = BOOT_SEQUENCE.map((n) => classes.find((c) => c.name === n)).filter(
    (c): c is EndpointClass & { tier: Tier } => c !== undefined,
  );
  if (seq.length === 0) return;
  console.log(`\n── cockpit boot burst (${seq.length}/${BOOT_SEQUENCE.length} steps, sequential) ──`);

  const session = inst.sessions[0]!;
  const since = await probeNow(inst);
  const totals: number[] = [];
  const iterations = VALIDATE ? 10 : 25;

  for (let i = 0; i < iterations + 3; i++) {
    // A fresh connection per boot: a real cockpit boot is a cold page load,
    // not the tail of a warm keep-alive pool.
    const client = new WireClient(inst.port);
    const t0 = process.hrtime.bigint();
    for (const cls of seq) {
      const ctx = pickCtx(inst, 0, i);
      await client.request({
        method: cls.method,
        path: cls.path(ctx),
        session: cls.name === "boot1.health" ? null : session,
        timeoutMs: 120_000,
      });
    }
    client.destroy();
    if (i >= 3) totals.push(Number(process.hrtime.bigint() - t0) / 1_000_000);
  }

  rep.add({
    suite: "wire.cockpit",
    name: "boot-burst.total",
    scale,
    stats: summarize(totals, noiseFloor),
    items: seq.length,
    // Boot is a view open, and the declared budget for a view is 200ms.
    budgetMs: BUDGET.VIEW_MS,
    notes:
      `${seq.length} SEQUENTIAL requests on a cold connection: ${seq.map((c) => c.name).join(" → ")} · ` +
      `this is what the user waits for before first paint, and because probes.ts awaits each step ` +
      `the per-step latencies ADD — a per-step verdict of "all under budget" can still be a boot over 1s` +
      (seq.length < BOOT_SEQUENCE.length
        ? ` · ${BOOT_SEQUENCE.length - seq.length} step(s) were dropped by preflight, so this total is INCOMPLETE and reads LOW`
        : ""),
  });

  const lag = await lagMeasurement(inst, "wire.lag", "cockpit.boot-burst", scale, since, noiseFloor);
  if (lag.m) rep.add(lag.m);
}

/** Assert a response is what the case assumed. A 401/404 that goes unnoticed
 *  turns a latency measurement into a measurement of the error path. */
function verdictOf(results: readonly WireResult[]): {
  readonly ok: number;
  readonly statuses: Record<string, number>;
  readonly clean: boolean;
} {
  const statuses: Record<string, number> = {};
  let ok = 0;
  for (const r of results) {
    const key = r.error !== null ? `err:${r.error.slice(0, 40)}` : String(r.status);
    statuses[key] = (statuses[key] ?? 0) + 1;
    if (r.status >= 200 && r.status < 300) ok++;
  }
  return { ok, statuses, clean: ok === results.length };
}

function statusLine(statuses: Record<string, number>): string {
  return Object.entries(statuses)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}×${v}`)
    .join(" ");
}

/** Read the in-process probe and turn it into a reportable measurement. */
async function lagMeasurement(
  inst: ServerInstance,
  suite: string,
  name: string,
  scale: string,
  sinceMs: number,
  noiseFloor: number,
): Promise<{ readonly m: Measurement | null; readonly rssBytes: number; readonly atMs: number }> {
  const reading = await readProbe(inst.probePort, sinceMs);
  if (reading === null) return { m: null, rssBytes: 0, atMs: sinceMs };
  const { stats, starved, note } = summarizeProbeLag(reading, noiseFloor);
  return {
    m: {
      suite,
      name,
      scale,
      stats,
      // One frame of lag is the point at which a blocked loop becomes a
      // dropped frame for anyone else on the server.
      budgetMs: BUDGET.FRAME_MS,
      notes:
        `event-loop lag INSIDE the server process · ${note}` +
        (starved ? " · TREAT AS A LOWER BOUND" : "") +
        ` · rss ${fmtBytes(reading.rssBytes)} heap ${fmtBytes(reading.heapUsedBytes)}`,
    },
    rssBytes: reading.rssBytes,
    atMs: reading.atMs,
  };
}

async function probeNow(inst: ServerInstance): Promise<number> {
  const r = await readProbe(inst.probePort);
  return r?.atMs ?? 0;
}

// ── Phase: serial latency, one connection ────────────────────────────────

async function phaseLatency(
  inst: ServerInstance,
  rep: Reporter,
  classes: ReadonlyArray<EndpointClass & { tier: Tier }>,
  noiseFloor: number,
  scale: string,
): Promise<void> {
  console.log(`\n── latency (serial, 1 connection) ──`);
  const session = inst.sessions[0]!;
  const client = new WireClient(inst.port);
  try {
    for (const cls of classes) {
      const since = await probeNow(inst);
      let nonce = 0;
      const results: WireResult[] = [];

      const run = async (): Promise<WireResult> => {
        const ctx = pickCtx(inst, 0, nonce++);
        return client.request({
          method: cls.method,
          path: cls.path(ctx),
          session: cls.name === "boot1.health" ? null : session,
          ...(cls.json ? { json: cls.json(ctx) } : {}),
          timeoutMs: 120_000,
        });
      };

      for (let i = 0; i < cls.warmup; i++) await run();
      const started = Date.now();
      for (let i = 0; i < cls.iterations; i++) {
        results.push(await run());
        // A pathological case must REPORT rather than hang the suite.
        if (Date.now() - started > 60_000) break;
      }

      const v = verdictOf(results);
      const ttfb = summarize(results.map((r) => r.ttfbMs), noiseFloor);
      const total = summarize(results.map((r) => r.totalMs), noiseFloor);
      const meanBytes = results.reduce((a, r) => a + r.bytes, 0) / Math.max(1, results.length);
      const bigChatIsReal = inst.ids.megaChatId !== null;

      rep.add({
        suite: "wire.latency",
        name: `${cls.name}.ttfb`,
        scale,
        stats: ttfb,
        bytes: Math.round(meanBytes),
        budgetMs: cls.budgetMs,
        notes:
          `${cls.method} · ${cls.what} · statuses ${statusLine(v.statuses)}` +
          (v.clean ? "" : " · NOT ALL 2xx — this case is measuring an error path, not the route") +
          (cls.name === "chat-history-worst" && !bigChatIsReal
            ? ` · NO mega-chat in profile "${PROFILE}" — this is an ORDINARY chat, NOT the worst case`
            : ""),
      });
      rep.add({
        suite: "wire.latency",
        name: `${cls.name}.total`,
        scale,
        stats: total,
        bytes: Math.round(meanBytes),
        budgetMs: cls.budgetMs,
        notes:
          `full response received · mean payload ${fmtBytes(meanBytes)} · ` +
          `transfer tail = total p50 − ttfb p50 = ${ms(total.p50Ms - ttfb.p50Ms)}`,
      });

      const lag = await lagMeasurement(inst, "wire.lag", `latency.${cls.name}`, scale, since, noiseFloor);
      if (lag.m) rep.add(lag.m);
    }
  } finally {
    client.destroy();
  }
}

// ── Phase: observer cost ─────────────────────────────────────────────────

/**
 * Does watching change what is watched? Runs the cheapest class against a
 * server started WITHOUT the probe and compares. A harness that cannot state
 * its own overhead is asking to be trusted rather than checked.
 */
async function phaseObserverCost(rep: Reporter, noiseFloor: number, scale: string): Promise<void> {
  console.log(`\n── observer cost (probe on vs probe off) ──`);
  const control = await startServer({
    profile: PROFILE,
    tag: "observer-control",
    port: pickPort(10),
    probePort: pickPort(11),
    knobs: { probe: false, llmFixtures: true },
  });
  try {
    const client = new WireClient(control.port);
    const samples: number[] = [];
    for (let i = 0; i < 30; i++) await client.request({ path: "/api/health" });
    for (let i = 0; i < 200; i++) {
      samples.push((await client.request({ path: "/api/health" })).ttfbMs);
    }
    client.destroy();
    rep.add({
      suite: "wire.probe",
      name: "observer-cost.health.ttfb.no-probe",
      scale,
      stats: summarize(samples, noiseFloor),
      budgetMs: BUDGET.ACK_MS,
      notes:
        "CONTROL: identical server started WITHOUT bench/wire/preload-lag.ts. " +
        "Compare against wire.latency/boot1.health.ttfb — a difference beyond the noise " +
        "floor means the in-process probe is distorting the numbers it reports.",
    });
  } finally {
    await control.stop();
  }
}

// ── Phase: SSE ───────────────────────────────────────────────────────────

/** Start a run and return its id, or null with the reason it could not. */
async function startRun(
  client: WireClient,
  session: WireSession,
  projectId: string,
  chatId: string,
  prompt = "bench wire probe",
): Promise<{ readonly runId: string | null; readonly why: string; readonly ackMs: number }> {
  const r = await client.request({
    method: "POST",
    path: "/api/run/start",
    session,
    json: { projectId, chatId, prompt },
    keepBody: true,
    timeoutMs: 60_000,
  });
  if (r.status !== 201 && r.status !== 200) {
    return { runId: null, why: `run/start → ${r.status} ${r.body?.slice(0, 160) ?? r.error ?? ""}`, ackMs: r.totalMs };
  }
  try {
    const parsed = JSON.parse(r.body ?? "{}") as { runId?: string };
    return { runId: parsed.runId ?? null, why: "", ackMs: r.totalMs };
  } catch {
    return { runId: null, why: "run/start body was not JSON", ackMs: r.totalMs };
  }
}

async function phaseSse(
  inst: ServerInstance,
  rep: Reporter,
  noiseFloor: number,
  scale: string,
): Promise<void> {
  console.log(`\n── sse (first byte, inter-event gaps, server lag during stream) ──`);
  const session = inst.sessions[0]!;
  const ctx = pickCtx(inst, 0, 1);
  const client = new WireClient(inst.port);
  const since = await probeNow(inst);

  try {
    const firstBytes: number[] = [];
    const acks: number[] = [];
    const gaps: number[] = [];
    let streams = 0;
    let eventTotal = 0;
    let lastNote = "";

    for (let i = 0; i < (VALIDATE ? 3 : 10); i++) {
      const started = await startRun(client, session, ctx.projectId, ctx.chatId);
      acks.push(started.ackMs);
      if (started.runId === null) {
        lastNote = started.why;
        break;
      }
      const stream = openSse(client, {
        path: `/api/run/${started.runId}/stream`,
        session,
        maxEvents: 40,
        maxDurationMs: 20_000,
      });
      const res = await stream.done;
      streams++;
      eventTotal += res.events.length;
      if (res.status === 200 && res.events.length > 0) {
        firstBytes.push(res.firstBodyByteMs);
        // The FIRST event's gap is measured from first body byte, so it is
        // not an inter-event gap; drop it from the gap distribution.
        for (const e of res.events.slice(1)) gaps.push(e.gapMs);
      } else {
        lastNote = `stream → status ${res.status} endedBy=${res.endedBy} events=${res.events.length} ${res.error ?? ""}`;
      }
      // Free the run's SSE connection slot before the next iteration.
      await client.request({ method: "POST", path: `/api/run/${started.runId}/cancel`, session });
      await sleep(50);
    }

    if (acks.length > 0) {
      rep.add({
        suite: "wire.sse",
        name: "run-start.ack",
        scale,
        stats: summarize(acks, noiseFloor),
        budgetMs: BUDGET.ACK_MS,
        notes: "POST /api/run/start — the acknowledgement the user waits for before anything streams",
      });
    }
    if (firstBytes.length > 0) {
      rep.add({
        suite: "wire.sse",
        name: "stream.first-byte",
        scale,
        stats: summarize(firstBytes, noiseFloor),
        budgetMs: BUDGET.ACK_MS,
        notes: `GET /api/run/:runId/stream — request write → first stream body byte · ${streams} streams`,
      });
    }
    if (gaps.length > 0) {
      rep.add({
        suite: "wire.sse",
        name: "stream.inter-event-gap",
        scale,
        stats: summarize(gaps, noiseFloor),
        items: eventTotal,
        budgetMs: BUDGET.FRAME_MS,
        notes:
          `gap between consecutive SSE events · ${gaps.length} gaps over ${streams} streams · ` +
          `the tail is the finding: p99/max is the longest the UI sat frozen mid-answer` +
          (lastNote ? ` · ${lastNote}` : ""),
      });
    }
    if (firstBytes.length === 0 && gaps.length === 0) {
      rep.note("wire.sse", "stream", `NO stream measured — ${lastNote || "no runs started"}`);
    }

    const lag = await lagMeasurement(inst, "wire.lag", "sse.streaming", scale, since, noiseFloor);
    if (lag.m) rep.add(lag.m);
  } finally {
    client.destroy();
  }
}

// ── Phase: head-of-line blocking ─────────────────────────────────────────

/**
 * WHAT ONE BLOCKING READ DOES TO EVERYONE ELSE.
 *
 * This is the phase that explains every other number. Node serves on ONE
 * thread: a route that spends seconds in synchronous work — decrypting rows,
 * walking them for redaction, `JSON.stringify`-ing tens of megabytes — is not
 * slow only for its own caller. It is a stop-the-world pause for every
 * connection on the process. A peer measured `/api/health` going from p50
 * 1.27ms alone to p95 1795ms / max 4814ms while a single 20k-message history
 * read was in flight. Same server, same endpoint, nothing wrong with it.
 *
 * So the design here is deliberately asymmetric: hammer the CHEAPEST endpoint
 * in the product on its own connection, and measure what happens to it while
 * ONE heavy read runs on another. A control period before and after isolates
 * the effect from ambient noise.
 *
 * THE TAIL IS THE FINDING. p50 barely moves — most cheap requests land
 * between the blocking stretches and are genuinely fast. It is p99 and max
 * that carry it, which is exactly why a p50/p95 summary would report a
 * perfectly healthy server here.
 */
async function phaseHeadOfLine(
  inst: ServerInstance,
  rep: Reporter,
  classes: ReadonlyArray<EndpointClass & { tier: Tier }>,
  noiseFloor: number,
  scale: string,
): Promise<void> {
  console.log(`\n── head-of-line (cheap endpoint while ONE heavy read blocks) ──`);
  const heavy = pick(classes, "chat-history-worst");
  const session = inst.sessions[0]!;
  const cheap = new WireClient(inst.port);
  const blocker = new WireClient(inst.port);

  /** Hammer /api/health on its own connection for `durationMs`. */
  const hammer = async (durationMs: number): Promise<readonly WireResult[]> => {
    const out: WireResult[] = [];
    const deadline = Date.now() + durationMs;
    while (Date.now() < deadline) {
      out.push(await cheap.request({ path: "/api/health", timeoutMs: 60_000 }));
    }
    return out;
  };

  try {
    // CONTROL: the same endpoint, same connection, nothing else happening.
    const control = await hammer(VALIDATE ? 1_500 : 4_000);

    // TREATMENT: one heavy read in flight, cheap requests throughout.
    const ctx = pickCtx(inst, 0, 1);
    const since = await probeNow(inst);
    const t0 = Date.now();
    const heavyPromise = blocker.request({
      method: heavy.method,
      path: heavy.path(ctx),
      session,
      timeoutMs: 180_000,
    });
    // Keep sampling until the heavy read actually finishes, so the window is
    // defined by the blocking work rather than by a guessed duration.
    const during: WireResult[] = [];
    let heavyDone = false;
    void heavyPromise.then(() => {
      heavyDone = true;
    });
    while (!heavyDone && Date.now() - t0 < (VALIDATE ? 20_000 : 180_000)) {
      during.push(await cheap.request({ path: "/api/health", timeoutMs: 60_000 }));
    }
    const heavyResult = await heavyPromise;
    const heavyWallMs = Date.now() - t0;

    const controlStats = summarize(control.map((r) => r.totalMs), noiseFloor);
    const duringStats = summarize(during.map((r) => r.totalMs), noiseFloor);

    rep.add({
      suite: "wire.headofline",
      name: "health.control",
      scale,
      stats: controlStats,
      items: control.length,
      budgetMs: BUDGET.ACK_MS,
      notes: `GET /api/health alone, nothing else in flight — the uncontended truth about this endpoint`,
    });
    rep.add({
      suite: "wire.headofline",
      name: "health.during-heavy-read",
      scale,
      stats: duringStats,
      items: during.length,
      budgetMs: BUDGET.ACK_MS,
      notes:
        `the SAME endpoint on its own connection while ONE ${heavy.name} read ran ` +
        `(${(heavyWallMs / 1000).toFixed(1)}s, ${fmtBytes(heavyResult.bytes)}, status ${heavyResult.status}) · ` +
        `p50 ${ms(controlStats.p50Ms)}→${ms(duringStats.p50Ms)} (${(duringStats.p50Ms / Math.max(controlStats.p50Ms, 1e-9)).toFixed(1)}×) · ` +
        `p95 ${ms(controlStats.p95Ms)}→${ms(duringStats.p95Ms)} (${(duringStats.p95Ms / Math.max(controlStats.p95Ms, 1e-9)).toFixed(1)}×) · ` +
        `p99 ${ms(controlStats.p99Ms)}→${ms(duringStats.p99Ms)} (${(duringStats.p99Ms / Math.max(controlStats.p99Ms, 1e-9)).toFixed(1)}×) · ` +
        `MAX ${ms(controlStats.maxMs)}→${ms(duringStats.maxMs)} (${(duringStats.maxMs / Math.max(controlStats.maxMs, 1e-9)).toFixed(1)}×) · ` +
        `THE TAIL IS THE FINDING: p50 barely moves because most cheap requests land between the ` +
        `blocking stretches. A p50/p95-shaped summary would report a healthy server here. ` +
        `Node serves on one thread, so a synchronous route is a stop-the-world pause for every connection.` +
        (during.length < 30
          ? ` · WARNING: only ${during.length} samples — the heavy read finished too fast at this scale ` +
            `for the window to hold a distribution. These percentiles are NOT meaningful; run this ` +
            `phase against a profile with a genuinely large chat (heavy).`
          : ""),
    });

    const lag = await lagMeasurement(inst, "wire.lag", "headofline.during-heavy-read", scale, since, noiseFloor);
    if (lag.m) rep.add(lag.m);

    // RECOVERY: does the cheap endpoint return to its control distribution?
    const after = await hammer(VALIDATE ? 1_500 : 4_000);
    const afterStats = summarize(after.map((r) => r.totalMs), noiseFloor);
    rep.add({
      suite: "wire.headofline",
      name: "health.after-heavy-read",
      scale,
      stats: afterStats,
      items: after.length,
      budgetMs: BUDGET.ACK_MS,
      notes:
        `same endpoint once the heavy read completed · p99 ${ms(afterStats.p99Ms)} vs control ` +
        `${ms(controlStats.p99Ms)} · a tail that does NOT return to control is retention or GC ` +
        `pressure left behind by the read, not the read itself`,
    });
  } finally {
    cheap.destroy();
    blocker.destroy();
  }
}

// ── Phase: run-share (KNOWN BROKEN — kept isolated) ──────────────────────

/**
 * Two connections on ONE run id.
 *
 * `GET /api/run/:runId/stream` is the run EXECUTOR: the handler opens the
 * stream and then drives the whole turn loop inside it. It is not a
 * subscriber to an existing execution. So a second GET on the same runId
 * should start a SECOND full execution against the same run state, and
 * either connection closing fires `res.on("close")` → `abortController.abort()`
 * + `activeRuns.delete(runId)`, killing the run for BOTH.
 *
 * This phase VERIFIES that is still true and characterises it. Its numbers
 * never enter the concurrency headline: a broken shape averaged into a
 * working one produces a figure that describes neither.
 */
/** How many messages the chat holds right now. Uses the cockpit's own
 *  conversation read (`/history`), not the legacy `/messages` route. */
async function countMessages(
  client: WireClient,
  session: WireSession,
  chatId: string,
): Promise<number> {
  const r = await client.request({ path: `/api/chats/${chatId}/history`, session, keepBody: true });
  try {
    const body = JSON.parse(r.body ?? "{}") as { messages?: readonly unknown[] };
    return Array.isArray(body.messages) ? body.messages.length : -1;
  } catch {
    return -1;
  }
}

async function phaseRunShare(
  inst: ServerInstance,
  rep: Reporter,
  scale: string,
): Promise<void> {
  console.log(`\n── runshare (multiple connections on ONE run — known broken) ──`);
  const session = inst.sessions[0]!;
  const ctx = pickCtx(inst, 0, 2);
  const starter = new WireClient(inst.port);
  const a = new WireClient(inst.port);
  const b = new WireClient(inst.port);

  try {
    const before = await countMessages(starter, session, ctx.chatId);
    const started = await startRun(
      starter,
      session,
      ctx.projectId,
      ctx.chatId,
      `bench runshare probe ${Date.now()}`,
    );
    if (started.runId === null) {
      rep.note("wire.runshare", "second-connection", `could not start a run: ${started.why}`);
      return;
    }
    const runId = started.runId;

    // TIMING IS THE WHOLE EXPERIMENT. With HARNESS_WEB_LLM_FIXTURES=1 a run
    // finishes in a couple of hundred milliseconds, and `activeRuns.delete`
    // runs on completion — so a second connection opened too late gets a
    // clean 404 for a run that is simply over. That is NOT evidence the
    // sharing case is handled; it is evidence the probe missed the window.
    // Both connections are therefore opened as close to simultaneously as
    // the loop allows, and the result is explicitly classified INCONCLUSIVE
    // when the run had already ended.
    // Both opened in the SAME TICK, on separate sockets, with no await
    // between them: any delay at all can miss a fixture run that finishes in
    // ~200ms, and a 404 for a run that simply ended is not a result.
    const first = openSse(a, { path: `/api/run/${runId}/stream`, session, maxEvents: 60, maxDurationMs: 15_000 });
    const second = openSse(b, { path: `/api/run/${runId}/stream`, session, maxEvents: 60, maxDurationMs: 15_000 });

    // Close the FIRST connection while the second should still be live. If
    // the disconnect handler aborts the shared run, the second connection
    // dies with it — a user opening a second tab kills their own answer.
    await sleep(60);
    first.close();
    const firstRes = await first.done;
    const secondRes = await second.done;

    const secondAccepted = secondRes.status === 200;
    const secondSawEvents = secondRes.events.length > 0;
    const secondSurvived = secondRes.endedBy === "max-events" || secondRes.events.length > firstRes.events.length;
    // A 404 means `activeRuns` no longer held the id. Either the run had
    // already completed (probe missed the window) or the first connection's
    // close handler deleted it. `firstRes.endedBy` tells them apart: a
    // server-closed first stream that already collected the full fixture
    // event set means the run finished on its own.
    // Three outcomes are possible and they mean different things, so the
    // note DESCRIBES what happened and names the candidate causes rather
    // than asserting one. A 404 in particular is ambiguous: the run may have
    // completed (the route deletes it from `activeRuns` on completion, even
    // though the SSE stream stays open), or the first connection's close
    // handler may have deleted it. Distinguishing those needs a turn that
    // outlives the probe, which the fixture model stream does not provide.
    const secondNotFound = secondRes.status === 404;

    rep.note(
      "wire.runshare",
      "second-connection",
      `2nd GET on the same runId → status ${secondRes.status}` +
        (secondAccepted ? " (ACCEPTED — not refused)" : " (not 200)") +
        ` · 1st: ${firstRes.events.length} events endedBy=${firstRes.endedBy}` +
        ` · 2nd: ${secondRes.events.length} events endedBy=${secondRes.endedBy}` +
        (secondAccepted && secondSawEvents
          ? " · the second connection RE-EXECUTED the run rather than subscribing to it: " +
            "GET /api/run/:runId/stream is the EXECUTOR, not a subscriber" +
            (secondSurvived
              ? " · and it outlived the first's disconnect"
              : " · and it DIED when the first disconnected — one tab closing kills the other answer")
          : secondAccepted
            ? " · accepted but produced no events"
            : secondNotFound
              ? " · 404: the runId was no longer in `activeRuns`. AMBIGUOUS between (a) the run " +
                "completed — the route deletes it on completion even though the SSE stream stays " +
                "open, which would also mean the cockpit's park-and-return reconnect " +
                "(src/cockpit/flow/run-stream.ts:266) 404s on a finished run — and (b) the first " +
                "connection's close handler deleted it. Separating these needs a turn that outlives " +
                "the probe; the fixture model stream (8 events, ~200ms) does not. NOT a clean bill of health."
              : " · refused with a non-404 status") +
        ` · fixture stream is ${VALIDATE ? "8 events/~200ms" : "8 events/~200ms"}, which bounds what this probe can reach`,
    );

    // Did the shared-run attempt persist MORE than one execution's worth of
    // messages? Counting repeated CONTENT would be a false positive — the
    // fixture corpus repeats strings constantly and every previous probe left
    // the same prompt behind — so this measures the DELTA in the chat's own
    // message count across the attempt, against what one execution costs.
    const after = await countMessages(starter, session, ctx.chatId);
    const delta = after - before;
    // The STRUCTURE does not depend on winning a timing race, and it is the
    // part that matters. Verified by reading server/routes/run.ts directly
    // (line numbers checked in this tree, not quoted from elsewhere):
    //   · `activeRuns.set` appears ONCE, at :776, inside POST /api/run/start.
    //   · `activeRuns.delete` appears at :850 (cancel), :945 (the stream's
    //     res 'close' handler) and :1670 (the finally, on completion).
    //   · The GET stream handler at :900 checks only that the id is present
    //     and owned, then EXECUTES the run inside the response — the route's
    //     own comment calls it the "RUN RECORDING BOUNDARY". There is no
    //     subscriber path in the file at all.
    // Three consequences follow without needing to observe them:
    //   (a) a second connection while the first is executing passes both
    //       checks and runs the turn AGAIN;
    //   (b) whichever client disconnects first aborts the run for everyone;
    //   (c) after ANY of the three deletes, a reconnect gets 404 with no way
    //       to tell "finished" from "someone else's tab closed".
    rep.note(
      "wire.runshare",
      "structure-CONFIRMED-by-inspection",
      `GET /api/run/:runId/stream is the run EXECUTOR, not a subscriber — server/routes/run.ts:900, ` +
        `with the turn loop running inside the response body. activeRuns.set ×1 (:776); ` +
        `activeRuns.delete ×3 (:850 cancel, :945 res-close, :1670 completion). Therefore: a 2nd ` +
        `connection re-executes the run; the FIRST disconnect aborts it for everyone; and any ` +
        `reconnect after any exit is an indistinguishable 404. ` +
        `USER-VISIBLE CONSEQUENCE: the cockpit's park-and-return reconnect ` +
        `(src/cockpit/flow/run-stream.ts:266) 404s on any finished run. ` +
        `STRUCTURAL BLOCKER for "one user, multiple workspaces, multiple devices": a second device ` +
        `cannot WATCH a run — it can only start a duplicate or kill the original. No concurrency ` +
        `tuning fixes this; it needs the executor decoupled from the response, with fan-out to ` +
        `subscribers. Mechanism confirmed by inspection; the timing probe below is corroboration only.`,
    );

    rep.note(
      "wire.runshare",
      "persisted-messages",
      `chat message count ${before} → ${after} (Δ${delta >= 0 ? "+" : ""}${delta}) across the shared-run ` +
        `attempt · ONE execution of the fixture turn persists the user prompt (written by ` +
        `POST /api/run/start) plus the assistant turn · a delta materially above that is a second ` +
        `execution writing its own copies` +
        (delta < 0 ? " · NEGATIVE delta means something DELETED messages, which is its own finding" : ""),
    );

    await starter.request({ method: "POST", path: `/api/run/${runId}/cancel`, session });
  } finally {
    starter.destroy();
    a.destroy();
    b.destroy();
  }
}

// ── Phase: concurrency (N distinct connections, N distinct runs) ─────────

type ConcurrencyOutcome = {
  readonly connections: number;
  readonly results: readonly WireResult[];
  readonly wallMs: number;
};

/** Drive `connections` DISTINCT clients, each on its own socket, spread over
 *  `users` distinct sessions, all requesting `cls` for `durationMs`. */
async function driveConcurrent(
  inst: ServerInstance,
  cls: EndpointClass,
  connections: number,
  users: number,
  durationMs: number,
): Promise<ConcurrencyOutcome> {
  const clients: WireClient[] = [];
  const results: WireResult[] = [];
  const t0 = Date.now();
  const deadline = t0 + durationMs;

  const workers = Array.from({ length: connections }, (_, i) => {
    // One client = one Agent with maxSockets 1 = one TCP connection.
    const client = new WireClient(inst.port);
    clients.push(client);
    const userIndex = i % Math.max(1, Math.min(users, inst.sessions.length));
    const session = inst.sessions[userIndex]!;
    const ctx = pickCtx(inst, userIndex, i);
    return (async () => {
      let nonce = 0;
      while (Date.now() < deadline) {
        const r = await client.request({
          method: cls.method,
          path: cls.path({ ...ctx, nonce: nonce++ }),
          session: cls.name === "boot1.health" ? null : session,
          ...(cls.json ? { json: cls.json({ ...ctx, nonce }) } : {}),
          timeoutMs: 60_000,
        });
        results.push(r);
      }
    })();
  });

  await Promise.all(workers);
  for (const c of clients) c.destroy();
  return { connections, results, wallMs: Date.now() - t0 };
}

async function phaseConcurrency(
  inst: ServerInstance,
  rep: Reporter,
  classes: ReadonlyArray<EndpointClass & { tier: Tier }>,
  noiseFloor: number,
  scale: string,
): Promise<void> {
  const usersAvailable = inst.sessions.length;
  const users = Math.min(USERS, usersAvailable);
  console.log(
    `\n── concurrency (${CONNECTIONS} distinct connections over ${users} distinct users` +
      (users < USERS ? `; fixture only has ${usersAvailable}` : "") +
      `) ──`,
  );

  for (const cls of classes.filter((c) => c.inLoad && c.tier !== "legacy")) {
    const since = await probeNow(inst);
    const out = await driveConcurrent(inst, cls, CONNECTIONS, users, VALIDATE ? 2_000 : 15_000);
    const v = verdictOf(out.results);
    const ttfb = summarize(out.results.map((r) => r.ttfbMs), noiseFloor);
    const throughput = (out.results.length / out.wallMs) * 1000;

    rep.add({
      suite: "wire.concurrency",
      name: `${cls.name}.ttfb@${CONNECTIONS}`,
      scale,
      stats: ttfb,
      items: out.results.length,
      budgetMs: cls.budgetMs,
      notes:
        `${CONNECTIONS} connections / ${users} users · ${out.results.length} requests in ${(out.wallMs / 1000).toFixed(1)}s ` +
        `= ${throughput.toFixed(0)} req/s · statuses ${statusLine(v.statuses)}` +
        (v.clean
          ? ""
          : ` · ${out.results.length - v.ok} NON-2xx — under load this route is refusing or failing, ` +
            `so the latency above describes a mixture of served and rejected requests`) +
        ` · compare with wire.latency/${cls.name}.ttfb: the requirement is NO ADDED LATENCY, which is a ratio, not an absolute`,
    });

    const lag = await lagMeasurement(inst, "wire.lag", `concurrency.${cls.name}`, scale, since, noiseFloor);
    if (lag.m) rep.add(lag.m);
  }

  // N distinct RUNS on N distinct connections — the shape the product claims.
  await concurrentDistinctRuns(inst, rep, noiseFloor, scale, users);
}

async function concurrentDistinctRuns(
  inst: ServerInstance,
  rep: Reporter,
  noiseFloor: number,
  scale: string,
  users: number,
): Promise<void> {
  const n = Math.min(VALIDATE ? 3 : CONNECTIONS, Math.max(1, users) * 8);
  console.log(`   distinct runs: ${n} runs, each on its own connection`);
  const since = await probeNow(inst);

  const outcomes = await Promise.all(
    Array.from({ length: n }, async (_, i) => {
      const userIndex = i % Math.max(1, Math.min(users, inst.sessions.length));
      const session = inst.sessions[userIndex]!;
      const ctx = pickCtx(inst, userIndex, i);
      const client = new WireClient(inst.port);
      try {
        const started = await startRun(client, session, ctx.projectId, ctx.chatId);
        if (started.runId === null) return { ok: false, why: started.why, firstByte: Number.NaN, events: 0, status: 0 };
        const res = await openSse(client, {
          path: `/api/run/${started.runId}/stream`,
          session,
          maxEvents: 20,
          maxDurationMs: 20_000,
        }).done;
        await client.request({ method: "POST", path: `/api/run/${started.runId}/cancel`, session });
        return {
          ok: res.status === 200 && res.events.length > 0,
          why: res.status === 200 ? "" : `stream status ${res.status}`,
          firstByte: res.firstBodyByteMs,
          events: res.events.length,
          status: res.status,
        };
      } finally {
        client.destroy();
      }
    }),
  );

  const good = outcomes.filter((o) => o.ok);
  const statuses: Record<string, number> = {};
  for (const o of outcomes) statuses[String(o.status)] = (statuses[String(o.status)] ?? 0) + 1;

  if (good.length > 0) {
    rep.add({
      suite: "wire.concurrency",
      name: `distinct-runs.first-byte@${n}`,
      scale,
      stats: summarize(good.map((o) => o.firstByte), noiseFloor),
      items: good.reduce((a, o) => a + o.events, 0),
      budgetMs: BUDGET.ACK_MS,
      notes:
        `${n} DISTINCT runs on ${n} DISTINCT connections over ${users} users · ` +
        `${good.length}/${n} streamed · statuses ${statusLine(statuses)}` +
        (good.length < n
          ? ` · ${n - good.length} did not stream — the per-identity SSE cap is ` +
            `${inst.knobs.sseMaxConnectionsPerUser ?? 8}/user (server/sse.ts::acquireSseConnection), ` +
            `so ${n} streams over ${users} users needs ${Math.ceil(n / Math.max(1, users))} per user`
          : ""),
    });
  } else {
    rep.note(
      "wire.concurrency",
      "distinct-runs",
      `NONE of ${n} runs streamed · statuses ${statusLine(statuses)} · ${outcomes[0]?.why ?? ""}`,
    );
  }

  const lag = await lagMeasurement(inst, "wire.lag", "concurrency.distinct-runs", scale, since, noiseFloor);
  if (lag.m) rep.add(lag.m);
}

// ── Phase: sustained ─────────────────────────────────────────────────────

async function phaseSustained(
  inst: ServerInstance,
  rep: Reporter,
  classes: ReadonlyArray<EndpointClass & { tier: Tier }>,
  noiseFloor: number,
  scale: string,
): Promise<void> {
  console.log(`\n── sustained (${(SUSTAIN_MS / 1000).toFixed(0)}s: RSS, WAL, and one stalled client) ──`);
  const users = Math.min(USERS, inst.sessions.length);
  const since = await probeNow(inst);

  const rssTrack: Array<{ t: number; rss: number; wal: number }> = [];
  const t0 = Date.now();
  const sampler = setInterval(() => {
    void readProbe(inst.probePort).then((r) => {
      if (r) rssTrack.push({ t: Date.now() - t0, rss: r.rssBytes, wal: inst.walBytes() });
    });
  }, 1_000);
  sampler.unref();

  const walStart = inst.walBytes();
  const dbStart = inst.dbBytes();

  const cls = pick(classes, "boot7.chat-history");
  const out = await driveConcurrent(inst, cls, Math.min(CONNECTIONS, 32), users, SUSTAIN_MS);
  clearInterval(sampler);
  await sleep(300);

  const v = verdictOf(out.results);
  rep.add({
    suite: "wire.sustained",
    name: "read-loop.ttfb",
    scale,
    stats: summarize(out.results.map((r) => r.ttfbMs), noiseFloor),
    items: out.results.length,
    budgetMs: cls.budgetMs,
    notes:
      `${Math.min(CONNECTIONS, 32)} connections for ${(out.wallMs / 1000).toFixed(0)}s · ` +
      `${out.results.length} requests · statuses ${statusLine(v.statuses)}`,
  });

  const rssFirst = rssTrack[0]?.rss ?? 0;
  const rssLast = rssTrack[rssTrack.length - 1]?.rss ?? 0;
  rep.note(
    "wire.sustained",
    "memory",
    `RSS ${fmtBytes(rssFirst)} → ${fmtBytes(rssLast)} over ${(out.wallMs / 1000).toFixed(0)}s ` +
      `(${rssLast > rssFirst ? "+" : ""}${fmtBytes(rssLast - rssFirst)}, ` +
      `${(((rssLast - rssFirst) / Math.max(1, out.wallMs)) * 1000 * 60 / 1024 / 1024).toFixed(2)} MB/min) · ` +
      `${rssTrack.length} samples`,
  );
  rep.note(
    "wire.sustained",
    "sqlite-wal",
    `WAL ${fmtBytes(walStart)} → ${fmtBytes(inst.walBytes())} · db ${fmtBytes(dbStart)} → ${fmtBytes(inst.dbBytes())} · ` +
      `a WAL that grows without checkpointing under a READ-ONLY load is a finding in itself`,
  );

  const lag = await lagMeasurement(inst, "wire.lag", "sustained.read-loop", scale, since, noiseFloor);
  if (lag.m) rep.add(lag.m);

  await backpressureProbe(inst, rep, classes, noiseFloor, scale);
}

/**
 * Does ONE stalled SSE reader hurt everyone else?
 *
 * `server/sse.ts::send` calls `res.write(...)` and DISCARDS the return value,
 * and the stream never listens for `drain`. So when a client stops reading,
 * the kernel send buffer fills, `write` starts returning false, and Node
 * buffers the unsent data in the process — unbounded, on the server's heap.
 * The wire-visible consequences to look for: the healthy clients' latency
 * rising, and the server's RSS climbing while the stalled client is silent.
 */
async function backpressureProbe(
  inst: ServerInstance,
  rep: Reporter,
  classes: ReadonlyArray<EndpointClass & { tier: Tier }>,
  noiseFloor: number,
  scale: string,
): Promise<void> {
  console.log(`   backpressure: one stalled SSE reader vs healthy readers`);
  const session = inst.sessions[0]!;
  const ctx = pickCtx(inst, 0, 7);
  const starter = new WireClient(inst.port);
  const stallClient = new WireClient(inst.port);

  try {
    const before = await readProbe(inst.probePort);
    const started = await startRun(starter, session, ctx.projectId, ctx.chatId);
    if (started.runId === null) {
      rep.note("wire.sustained", "backpressure", `could not start a run: ${started.why}`);
      return;
    }
    const stallMs = VALIDATE ? 2_000 : 10_000;
    const stalled = openSse(stallClient, {
      path: `/api/run/${started.runId}/stream`,
      session,
      maxEvents: 500,
      maxDurationMs: stallMs + 5_000,
      stallAfterFirstEventMs: stallMs,
    });

    // While one reader is frozen, healthy clients keep working. If their
    // latency degrades, the stalled client is costing everyone.
    await sleep(200);
    const healthy = await driveConcurrent(
      inst,
      pick(classes, "boot4.projects-list"),
      4,
      1,
      stallMs,
    );
    const res = await stalled.done;
    const after = await readProbe(inst.probePort);

    rep.add({
      suite: "wire.sustained",
      name: "backpressure.healthy-clients.ttfb",
      scale,
      stats: summarize(healthy.results.map((r) => r.ttfbMs), noiseFloor),
      items: healthy.results.length,
      budgetMs: BUDGET.VIEW_MS,
      notes:
        `4 healthy readers while ONE SSE client stopped reading for ${stallMs}ms · ` +
        `stalled stream: ${res.events.length} events, endedBy=${res.endedBy}, ${res.keepalives} keepalives · ` +
        `server RSS ${fmtBytes(before?.rssBytes ?? 0)} → ${fmtBytes(after?.rssBytes ?? 0)} ` +
        `(${fmtBytes((after?.rssBytes ?? 0) - (before?.rssBytes ?? 0))} while one client was silent) · ` +
        `compare with wire.latency/boot4.projects-list.ttfb — a rise is the missing SSE backpressure being paid by other users`,
    });

    // HONEST LIMIT OF THIS PROBE. With HARNESS_WEB_LLM_FIXTURES=1 the model
    // stream is a fixed handful of small events (server/fixtures.ts:
    // buildStreamModelEvents — 8 events, a few hundred bytes each). That is
    // orders of magnitude too little to fill a socket send buffer, so a
    // stalled reader here does NOT reach the point where `res.write()` starts
    // returning false. The missing-`drain` bug in server/sse.ts is therefore
    // NOT demonstrated by this case, and a flat result above must not be read
    // as evidence the bug is benign.
    rep.note(
      "wire.sustained",
      "backpressure-sse-coverage",
      `MECHANISM CONFIRMED, IMPACT UNQUANTIFIED. The bug is not in doubt: server/sse.ts calls ` +
        `res.write() at :210, :252 and :253 and discards the return value at all three, and the file ` +
        `contains no 'drain' listener anywhere (verified by grep in this tree). So a stream whose ` +
        `client stops reading will buffer without bound on the server. ` +
        `What this PROBE could not reach is how bad that gets: it used ${res.events.length} fixture ` +
        `events (~${fmtBytes(res.bytes)}), and a socket send buffer is typically 64KB-2MB, so ` +
        `res.write() never returned false here. Quantifying it needs a stream that emits megabytes — ` +
        `a real LLM turn with large tool outputs. Read this as "certain bug, unmeasured blast radius", ` +
        `NOT as an open question and NOT as a clean bill of health.`,
    );

    await starter.request({ method: "POST", path: `/api/run/${started.runId}/cancel`, session });

    // The OTHER unbounded-buffering path, which fixture scale CAN reach:
    // `sendJson` builds the entire response with `JSON.stringify` and hands
    // it to `res.end()`. A client that stops reading a large body leaves the
    // whole serialized payload resident in the server's heap for as long as
    // it stalls — same failure class as the missing SSE drain, but reachable
    // with a plain GET of a big chat.
    await stalledBodyProbe(inst, rep, classes, scale);
  } finally {
    starter.destroy();
    stallClient.destroy();
  }
}

/**
 * N clients request the biggest chat and then STOP READING.
 *
 * `server/router.ts::sendJson` does `res.end(JSON.stringify(redacted))`: the
 * complete response exists as one string, then as socket-buffered bytes. A
 * reader that stalls holds all of it on the server. Ten stalled readers of a
 * 74MB history is 740MB of server heap that no request is making progress on
 * — and nothing in the product bounds it or sheds it.
 */
async function stalledBodyProbe(
  inst: ServerInstance,
  rep: Reporter,
  classes: ReadonlyArray<EndpointClass & { tier: Tier }>,
  scale: string,
): Promise<void> {
  const cls = pick(classes, "chat-history-worst");
  const stallers = VALIDATE ? 3 : 10;
  const before = await readProbe(inst.probePort);

  const stallMs = VALIDATE ? 3_000 : 20_000;
  const clients: WireClient[] = [];
  const pending = Array.from({ length: stallers }, (_, i) => {
    const client = new WireClient(inst.port);
    clients.push(client);
    const ctx = pickCtx(inst, i, i);
    // Read the headers, take ONE chunk, then stop reading. The rest of the
    // payload has nowhere to go: it sits in the kernel send buffer and, once
    // that fills, in Node's own write queue on the server's heap.
    return client.request({
      method: cls.method,
      path: cls.path(ctx),
      session: inst.sessions[i % inst.sessions.length]!,
      stallBodyMs: stallMs,
      timeoutMs: stallMs + 60_000,
    });
  });

  // Sample while they are still frozen — the peak is the point.
  await sleep(Math.min(stallMs - 500, VALIDATE ? 2_000 : 8_000));
  const during = await readProbe(inst.probePort);
  const results = await Promise.all(pending);
  for (const c of clients) c.destroy();
  // Give V8 a chance to release anything genuinely transient before deciding
  // whether what we saw was buffering or retention.
  await sleep(2_000);
  const after = await readProbe(inst.probePort);

  const completed = results.filter((r) => r.status >= 200 && r.status < 300).length;
  const totalBytes = results.reduce((a, r) => a + r.bytes, 0);
  const peakGrowth = (during?.rssBytes ?? 0) - (before?.rssBytes ?? 0);
  const retained = (after?.rssBytes ?? 0) - (before?.rssBytes ?? 0);

  rep.note(
    "wire.sustained",
    "stalled-body-readers",
    `${stallers} clients requested the largest chat, read ONE chunk, then stopped reading for ` +
      `${(stallMs / 1000).toFixed(0)}s · ${completed}/${stallers} eventually completed · ` +
      `${fmtBytes(totalBytes)} total across the wire · ` +
      `server RSS ${fmtBytes(before?.rssBytes ?? 0)} → ${fmtBytes(during?.rssBytes ?? 0)} (while frozen) ` +
      `→ ${fmtBytes(after?.rssBytes ?? 0)} (2s after release) · ` +
      `peak growth ${fmtBytes(peakGrowth)}, still held afterwards ${fmtBytes(retained)} · ` +
      `MECHANISM (confirmed by inspection, server/router.ts::sendJson): the whole response is built by ` +
      `JSON.stringify and handed to res.end(), so every stalled reader pins its ENTIRE payload on the ` +
      `server. Nothing bounds the total across readers and nothing sheds it under pressure. ` +
      `${retained > peakGrowth * 0.5 && peakGrowth > 0 ? "RSS did NOT return to baseline — this is retention, not transient buffering." : "RSS returned toward baseline — transient buffering at this scale."}`,
  );
}

// ── Phase: saturation ────────────────────────────────────────────────────

/**
 * Past the limit, is the failure an HONEST REFUSAL, a HANG, or SILENT
 * DEGRADATION? Those are three different products, and only the first is
 * acceptable. The classification is mechanical:
 *
 *   refusal     a non-2xx status with a typed code, returned promptly
 *   hang        a request that neither answers nor refuses before the timeout
 *   degradation 2xx responses far past every budget, with no signal to the
 *               user that the system is beyond capacity — the worst outcome,
 *               because nothing tells anyone anything is wrong
 */
async function phaseSaturate(
  inst: ServerInstance,
  rep: Reporter,
  classes: ReadonlyArray<EndpointClass & { tier: Tier }>,
  noiseFloor: number,
  scale: string,
): Promise<void> {
  const steps = VALIDATE ? [4, 8] : [25, 50, 100, 200, 400];
  console.log(`\n── saturate (${steps.join(" → ")} connections) ──`);
  const users = Math.min(USERS, inst.sessions.length);
  const cls = pick(classes, "boot7.chat-history");
  const timeoutMs = 15_000;

  for (const n of steps) {
    const since = await probeNow(inst);
    const clients: WireClient[] = [];
    const results: WireResult[] = [];
    const t0 = Date.now();

    await Promise.all(
      Array.from({ length: n }, async (_, i) => {
        const client = new WireClient(inst.port);
        clients.push(client);
        const userIndex = i % Math.max(1, users);
        const ctx = pickCtx(inst, userIndex, i);
        // ONE request each, all at once — the burst, not a sustained rate.
        results.push(
          await client.request({
            method: cls.method,
            path: cls.path(ctx),
            session: inst.sessions[userIndex]!,
            timeoutMs,
          }),
        );
      }),
    );
    for (const c of clients) c.destroy();

    const wallMs = Date.now() - t0;
    const v = verdictOf(results);
    const timeouts = results.filter((r) => r.error?.includes("timeout")).length;
    const resets = results.filter((r) => r.error !== null && !r.error.includes("timeout")).length;
    const refusals = results.filter((r) => r.status === 429 || r.status === 503).length;
    const served = results.filter((r) => r.status >= 200 && r.status < 300);
    const stats = summarize(results.map((r) => r.totalMs), noiseFloor);

    const classification =
      timeouts > 0
        ? "HANG — requests neither answered nor refused within the timeout"
        : refusals > 0
          ? "HONEST REFUSAL — a typed 429/503 the client can act on"
          : resets > 0
            ? "CONNECTION ERROR — the socket died with no HTTP answer, which a user sees as 'it broke', not 'it is busy'"
            : served.length === results.length && stats.p99Ms > BUDGET.FLOW_MS
              ? "SILENT DEGRADATION — every request succeeded, far past budget, with nothing telling anyone the system is over capacity"
              : "served within budget";

    rep.add({
      suite: "wire.saturate",
      name: `burst@${n}.total`,
      scale,
      stats,
      items: results.length,
      budgetMs: cls.budgetMs,
      notes:
        `${n} simultaneous connections, 1 request each, ${(wallMs / 1000).toFixed(1)}s wall · ` +
        `statuses ${statusLine(v.statuses)} · timeouts ${timeouts} resets ${resets} refusals ${refusals} · ` +
        classification,
    });

    const lag = await lagMeasurement(inst, "wire.lag", `saturate.burst@${n}`, scale, since, noiseFloor);
    if (lag.m) rep.add(lag.m);

    // Is the server still there afterwards, and how fast does it recover?
    const recover = new WireClient(inst.port);
    const t1 = Date.now();
    const health = await recover.request({ path: "/api/health", timeoutMs: 30_000 });
    recover.destroy();
    rep.note(
      "wire.saturate",
      `recovery@${n}`,
      `after the burst, GET /api/health → ${health.status} in ${ms(Date.now() - t1)}` +
        (health.status === 200 ? "" : " — the server did not recover cleanly"),
    );
    if (health.status !== 200) break;
    await sleep(500);
  }
}

// ── Phase: the gates themselves ──────────────────────────────────────────

/**
 * Characterise auth, CSRF and the rate limiter as MEASURED behaviour rather
 * than as read code. These are the three things that most distort a load
 * test, and a load number taken without knowing them is a number about the
 * gates, not about the product.
 */
async function phaseGates(rep: Reporter, noiseFloor: number, scale: string): Promise<void> {
  console.log(`\n── gates (auth / CSRF / rate limit — on a server at PRODUCT DEFAULTS) ──`);
  // Its OWN instance, with every knob left alone. The main instance runs with
  // the rate limit raised (or the write budget would be spent before the SSE
  // phases even start — the validation run proved that by 429-ing every
  // `POST /api/run/start`), and measuring a raised limiter would tell us
  // nothing about what a user meets.
  const inst = await startServer({
    profile: PROFILE,
    tag: "gates",
    port: pickPort(20),
    probePort: pickPort(21),
    knobs: { llmFixtures: true, probe: false, plantPassword: true },
  });
  try {
    await gatesBody(inst, rep, noiseFloor, scale);
  } finally {
    const stopped = await inst.stop();
    console.log(`   gates server ${inst.pid} stopped: ${stopped.ending}`);
  }
}

async function gatesBody(inst: ServerInstance, rep: Reporter, noiseFloor: number, scale: string): Promise<void> {
  const session = inst.sessions[0]!;
  const ctx = pickCtx(inst, 0, 99);
  const client = new WireClient(inst.port);
  try {
    const noCookie = await client.request({ path: "/api/projects", keepBody: true });
    rep.note(
      "wire.gates",
      "auth",
      `GET /api/projects with NO cookie → ${noCookie.status} ${noCookie.body?.slice(0, 120) ?? ""}`,
    );

    const noCsrf = await client.request({
      method: "POST",
      path: `/api/chats/${ctx.chatId}/messages`,
      session,
      json: { role: "user", content: "csrf probe" },
      omitCsrf: true,
      keepBody: true,
    });
    rep.note(
      "wire.gates",
      "csrf",
      `POST with a valid cookie but NO Origin and NO ${"x-requested-with"} → ${noCsrf.status} ` +
        `${noCsrf.body?.slice(0, 120) ?? ""} · the bench sends the custom header, which is the path ` +
        `server/csrf.ts documents for non-browser clients`,
    );

    // ORDER: the SSE-cap probe runs FIRST, because it needs ~10 successful
    // `POST /api/run/start` calls and the exhaustion probe below deliberately
    // spends the entire 60-write budget. Run the other way round (as the
    // first version did) and every stream it tries to open is 429'd by the
    // limiter, so the phase reports "0 streams opened, NOT a clean refusal"
    // — a false failure that says nothing about the cap.
    sseCapMechanism(rep);
    await sseCapRefusal(rep, scale);

    // GETs are EXEMPT from the limiter (server/router.ts: `isReadOnly`), so
    // the exhaustion probe must use a mutation or it will prove nothing.
    const budget = inst.knobs.rateLimit ?? 60;
    const shots = Math.min(budget + 15, 120);
    let firstRefusalAt = -1;
    const codes: Record<string, number> = {};
    for (let i = 0; i < shots; i++) {
      const r = await client.request({
        method: "POST",
        path: `/api/chats/${ctx.chatId}/messages`,
        session,
        json: { role: "user", content: `rl probe ${i}` },
        keepBody: true,
      });
      codes[String(r.status)] = (codes[String(r.status)] ?? 0) + 1;
      if (r.status === 429 && firstRefusalAt < 0) firstRefusalAt = i + 1;
    }
    rep.note(
      "wire.gates",
      "rate-limit",
      `${shots} sequential POSTs → ${statusLine(codes)} · first 429 at request #${firstRefusalAt < 0 ? "never" : firstRefusalAt} · ` +
        `configured budget ${budget} per ${(inst.knobs.rateLimitRefillMs ?? 60_000) / 1000}s, keyed by USER ID ` +
        `(server/rate-limiter.ts::rateLimitKey) · GET is exempt entirely (server/router.ts isReadOnly), ` +
        `so read load is NOT limiter-constrained and write load is`,
    );

    // How many GETs land untouched — proof the read path is limiter-free.
    let getOk = 0;
    for (let i = 0; i < 150; i++) {
      const r = await client.request({ path: "/api/projects", session });
      if (r.status === 200) getOk++;
    }
    rep.note(
      "wire.gates",
      "rate-limit-get-exemption",
      `150 sequential GETs immediately after exhausting the write budget → ${getOk}/150 succeeded ` +
        `(a limiter that applied to GET would have refused most of them)`,
    );

    // The login path, priced once. It is excluded from every other case
    // because scrypt is ~50-100ms of thread-pool work that would dominate.
    // The username must NOT exist. A fixture user's stored `password_hash` is
    // the literal "hash-N" (bench/fixtures/scale.ts creates users directly),
    // which is not in scrypt's `scrypt$N$r$p$salt$hash` format — so
    // `verifyPassword` fails its PARSE and returns false WITHOUT deriving
    // anything. Logging in as a fixture user therefore measures a string
    // check, not scrypt, and reports ~0.6ms for work that costs ~50-100ms.
    // An unknown user hits `DUMMY_PASSWORD_HASH`, which IS a real scrypt
    // hash, so the derivation actually runs — which is also the exact path
    // auth.ts built to keep unknown-user and wrong-password timings equal.
    const loginSamples: number[] = [];
    for (let i = 0; i < 10; i++) {
      const r = await client.request({
        method: "POST",
        path: "/api/auth/login",
        json: { username: `no-such-user-${i}`, password: "definitely-not-the-password" },
      });
      loginSamples.push(r.totalMs);
    }
    rep.add({
      suite: "wire.gates",
      name: "login.rejected",
      scale,
      stats: summarize(loginSamples, noiseFloor),
      budgetMs: BUDGET.FLOW_MS,
      notes:
        "POST /api/auth/login for an UNKNOWN user — the full scrypt (N=16384) verify against " +
        "DUMMY_PASSWORD_HASH, which auth.ts runs unconditionally so unknown-user and wrong-password " +
        "cost the same (no enumeration oracle). Async scrypt runs on the libuv THREAD POOL, so this " +
        "costs LATENCY without costing event-loop LAG — and the pool is 4 threads by default, which " +
        "is the real concurrency ceiling for simultaneous logins.",
    });

    // The same call for a user that DOES exist but whose stored hash is not
    // scrypt-formatted. If this is dramatically faster than the case above,
    // the parse-failure short-circuit is an enumeration oracle for any
    // account whose hash predates the current format.
    //
    // It MUST NOT be user 0: this instance plants a real scrypt password on
    // user 0 so the successful-login path is measurable, which destroys the
    // very condition being tested. An earlier version used user 0 and
    // reported 24.9ms — indistinguishable from the real scrypt path, i.e. it
    // silently stopped measuring the oracle while still claiming to. Any user
    // past the first still carries the `hash-<n>` placeholder.
    const placeholderUser = inst.sessions[1];
    if (placeholderUser === undefined) {
      rep.note(
        "wire.gates",
        "login.rejected.unparseable-stored-hash",
        `SKIPPED: profile "${PROFILE}" has only one fixture user, and this instance plants a real ` +
          `password on it. Needs a multi-user profile (fleet) where users past the first still carry ` +
          `the placeholder hash. Not measured — not "fine".`,
      );
    } else {
    const legacyHashSamples: number[] = [];
    const known = placeholderUser.username;
    for (let i = 0; i < 10; i++) {
      const r = await client.request({
        method: "POST",
        path: "/api/auth/login",
        json: { username: known, password: "definitely-not-the-password" },
      });
      legacyHashSamples.push(r.totalMs);
    }
    const legacy = summarize(legacyHashSamples, noiseFloor);
    const real = summarize(loginSamples, noiseFloor);
    rep.add({
      suite: "wire.gates",
      name: "login.rejected.unparseable-stored-hash",
      scale,
      stats: legacy,
      budgetMs: BUDGET.FLOW_MS,
      notes:
        `login as "${known}", whose stored hash is not in scrypt format · ` +
        `${(real.p50Ms / Math.max(legacy.p50Ms, 1e-9)).toFixed(1)}× FASTER than the unknown-user path ` +
        `(${ms(legacy.p50Ms)} vs ${ms(real.p50Ms)}) · verifyPassword returns false on a parse failure ` +
        `BEFORE deriving, so the constant-time guarantee holds only for correctly-formatted stored ` +
        `hashes. This is a fixture artefact HERE, but it is a real timing oracle for any account ` +
        `whose stored hash is malformed or predates the format.`,
    });
    }
    // The SUCCESSFUL login path, which the fixture cannot express on its own
    // (its users ship a placeholder hash). A real password is planted on the
    // COPY for this instance only. This matters for the 50-user target: a
    // login storm is bounded by the libuv thread pool (4 threads by default),
    // not by the event loop, so it is the one place where more users means
    // queueing that the lag sampler will NOT see.
    const okLogin: number[] = [];
    for (let i = 0; i < 10; i++) {
      const r = await client.request({
        method: "POST",
        path: "/api/auth/login",
        json: { username: inst.sessions[0]!.username, password: FIXTURE_PASSWORD },
        keepBody: true,
      });
      if (r.status === 200) okLogin.push(r.totalMs);
    }
    if (okLogin.length > 0) {
      rep.add({
        suite: "wire.gates",
        name: "login.successful",
        scale,
        stats: summarize(okLogin, noiseFloor),
        budgetMs: BUDGET.FLOW_MS,
        notes:
          `POST /api/auth/login with the correct password — full scrypt verify plus session creation. ` +
          `Runs on the libuv THREAD POOL (4 threads by default), so N simultaneous logins queue in ` +
          `groups of 4 without producing any event-loop lag: the lag sampler is BLIND to this ` +
          `particular ceiling, and it is the reason a login storm can look healthy and feel slow.`,
      });
    } else {
      rep.note("wire.gates", "login.successful", "no successful login observed — password planting failed");
    }
  } finally {
    client.destroy();
  }
}

/**
 * HALF ONE of the honest-refusal question: does the LIMIT MECHANISM work?
 *
 * Runs `bench/wire/sse-cap-probe.ts` in a child process (the cap must be in
 * the environment before `server/config.ts` is first imported, and this
 * process imported it long ago). Checks the threshold, the typed error, the
 * status, the `Retry-After`, and — the part that decides whether a refusal
 * is transient or permanent — that releasing a slot actually frees it.
 */
function sseCapMechanism(rep: Reporter): void {
  const probeCap = 2;
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", join(process.cwd(), "bench", "wire", "sse-cap-probe.ts"), String(probeCap)],
    { encoding: "utf8", cwd: process.cwd(), timeout: 120_000 },
  );
  if (r.status !== 0) {
    rep.note(
      "wire.gates",
      "sse-cap-mechanism",
      `probe FAILED to run (exit ${r.status}): ${(r.stderr ?? "").slice(0, 300)} — the mechanism is ` +
        `therefore UNVERIFIED, which is not the same as working`,
    );
    return;
  }
  try {
    const o = JSON.parse((r.stdout ?? "").trim().split("\n").pop() ?? "{}") as Record<string, unknown>;
    const pass =
      o["capReadCorrectly"] === true &&
      o["admittedMatchesCap"] === true &&
      o["allRefusalsTyped"] === true &&
      o["releaseDecrements"] === true &&
      o["slotReusableAfterRelease"] === true;
    rep.note(
      "wire.gates",
      "sse-cap-mechanism",
      `${pass ? "PASS — the limit mechanism is correct" : "FAIL — see values"} · ` +
        `env cap ${probeCap} read as ${String(o["configuredCap"])} · ` +
        `admitted exactly ${String(o["admitted"])} of ${probeCap + 2} attempts ` +
        `(${o["admittedMatchesCap"] === true ? "matches the cap" : "DOES NOT match the cap"}) · ` +
        `over-limit attempts refused with status ${String(o["refusalStatus"])} code ` +
        `${String(o["refusalCode"])} Retry-After ${String(o["retryAfterSeconds"])}s ` +
        `(${o["allRefusalsTyped"] === true ? "typed and consistent" : "NOT consistently typed"}) · ` +
        `releasing a slot decremented the count: ${String(o["releaseDecrements"])}, ` +
        `and the freed slot was reusable: ${String(o["slotReusableAfterRelease"])} ` +
        `(a leaked slot would turn a transient refusal into a permanent one) · ` +
        `verified via server/sse.ts's OWN exported diagnostics, which its comment provides for exactly ` +
        `this ("verify the limit directly (without an HTTP server)") · ` +
        `NOTE: this is the mechanism, NOT the end-to-end HTTP path — see sse-connection-cap-refusal`,
    );
  } catch (err) {
    rep.note("wire.gates", "sse-cap-mechanism", `probe output unparseable: ${String(err)}`);
  }
}

/**
 * HALF TWO: does an over-limit HTTP request actually receive that refusal?
 *
 * The brief asks whether the product refuses clearly at its limit or hangs /
 * degrades silently. `server/sse.ts::acquireSseConnection` claims to throw a
 * `RateLimitError` (429 + `Retry-After`) once an identity holds
 * `sseMaxConnectionsPerUser` streams. A claim in a comment is not a
 * behaviour, so this checks all five things that make a refusal honest:
 *
 *   1. the refusal arrives, and promptly (not a hang)
 *   2. it is a real 429, not a socket reset and not a 200 with an empty body
 *   3. it carries a real `Retry-After` the client can act on
 *   4. the streams already open are UNHARMED — refusing the newcomer must
 *      not punish the incumbents
 *   5. the server is healthy afterwards, and a slot freed by a close is
 *      genuinely reusable (a leaked slot turns a transient refusal permanent)
 *
 * This runs on the DEFAULT-CONFIG instance, so it measures the cap as
 * shipped (8 per identity), not a raised one.
 */
async function sseCapRefusal(rep: Reporter, scale: string): Promise<void> {
  // THE CAP IS FORCED TO 1 so the smallest possible window is enough, and
  // even that is not enough. This is measured, not assumed — see below.
  //
  // Under test is the REFUSAL PATH: `acquireSseConnection` throwing
  // `RateLimitError`, the router mapping it to 429 + `Retry-After`, the
  // incumbents surviving, the slot being released afterwards. That path is a
  // single `throw` and is identical at any cap value; only the threshold
  // differs. So cap=1 is the cheapest way to reach it.
  //
  // WHY IT IS STILL UNREACHABLE WITH FIXTURE RUNS. Measured directly on this
  // tree: one fixture stream stays open 184ms, and an overflow GET issued in
  // the SAME TICK was still served a 200 with the incumbent already closed.
  // The reason is that a fixture run completes WITHIN A SINGLE EVENT-LOOP
  // TURN — `streamChat` yields the 8 canned events with no real I/O to await
  // — so the slot is acquired, used and released before the server ever gets
  // round to dispatching the second connection. The probe cannot lose this
  // race, because the race is decided before it starts.
  //
  // That is worth stating as a finding in its own right rather than a
  // caveat: it is the same single-threaded property that produces the
  // head-of-line blocking measured in wire.headofline. A run that does not
  // yield does not just hold the slot — it holds the whole server.
  //
  // Settled only by a run with genuine async work (a real model turn, or a
  // tool call with real latency), where the slot is held across many turns of
  // the loop. Until then this reports UNREACHABLE, never "pass" and never
  // "fail": the mechanism exists in code (`server/sse.ts::acquireSseConnection`
  // throws `RateLimitError` with `sseConnectionRetryAfterSeconds`), and what
  // is unverified is only whether it behaves correctly end to end.
  const cap = 1;
  const inst = await startServer({
    profile: PROFILE,
    tag: "ssecap",
    port: pickPort(30),
    probePort: pickPort(31),
    knobs: { llmFixtures: true, probe: false, sseMaxConnectionsPerUser: cap, rateLimit: 500, rateLimitRefillMs: 1_000 },
  });
  try {
    await sseCapRefusalBody(inst, rep, scale, cap);
  } finally {
    await inst.stop();
  }
}

async function sseCapRefusalBody(
  inst: ServerInstance,
  rep: Reporter,
  scale: string,
  cap: number,
): Promise<void> {
  const session = inst.sessions[0]!;
  const ctx = pickCtx(inst, 0, 42);
  const starter = new WireClient(inst.port);
  const clients: WireClient[] = [];
  const open: Array<{ close: () => void; isDone: () => boolean; done: Promise<import("./client.ts").SseResult> }> = [];

  try {
    // STEP 1 — start every run FIRST, before opening any stream.
    //
    // This ordering is the whole experiment. A run sits idle in `activeRuns`
    // until someone GETs its stream, because execution happens INSIDE the GET
    // handler. With HARNESS_WEB_LLM_FIXTURES a run then completes in ~200ms
    // and the server closes the stream, releasing the connection slot. So
    // opening streams one at a time — start, connect, sleep, repeat — holds
    // ONE slot at a time, never `cap` of them, and the overflow attempt then
    // sails through with a 200. An earlier version of this probe did exactly
    // that and reported "NOT a clean refusal" on the strength of it: a false
    // accusation produced by the probe's own pacing.
    // cap + 1 runs, ALL created before any stream opens — including the
    // overflow run. Creating the overflow run later would put a POST
    // round-trip between "I counted N live streams" and "I attempted the
    // overflow", and a fixture run only lives ~200ms: an earlier version did
    // that and left a 1.48s gap, in which all 8 streams finished and released
    // their slots. It then recorded a 200 for the overflow as though the cap
    // had failed, when in truth the cap was empty by the time it was tested.
    const runIds: string[] = [];
    for (let i = 0; i < cap + 1; i++) {
      const started = await startRun(starter, session, ctx.projectId, ctx.chatId, `cap probe ${i}`);
      if (started.runId === null) break;
      runIds.push(started.runId);
    }
    const overflowRunId = runIds.length === cap + 1 ? runIds.pop()! : null;

    // STEP 2 — connect to all of them in the SAME tick, so the slots are held
    // simultaneously rather than in sequence.
    for (const runId of runIds) {
      const c = new WireClient(inst.port);
      clients.push(c);
      open.push(openSse(c, { path: `/api/run/${runId}/stream`, session, maxEvents: 500, maxDurationMs: 25_000 }));
    }
    // No await, no sleep: the overflow goes out in the same tick as the
    // incumbents. Any delay at all is fatal (measured: a 15ms sleep was
    // already too long), and even zero delay loses — which is the finding.
    const incumbentOpenedAt = Date.now();

    // STEP 3 — the overflow attempt, immediately, plus a COUNT OF WHAT WAS
    // ACTUALLY HELD at that instant. Without this count the result is
    // uninterpretable: a 200 means "the cap does not work" only if the cap
    // was genuinely full.
    const liveAtOverflow = open.filter((o) => !o.isDone()).length;
    let overflowStatus = 0;
    let retryAfter: string | undefined;
    let overflowMs = Number.NaN;
    let overflowBody = "";
    let liveAfterOverflow = 0;
    if (overflowRunId !== null) {
      const c = new WireClient(inst.port);
      clients.push(c);
      const t0 = Date.now();
      // Fired in the same tick as the liveness count above — no awaited
      // round-trip in between.
      const pending = c.request({
        path: `/api/run/${overflowRunId}/stream`,
        session,
        keepBody: true,
        timeoutMs: 20_000,
      });
      const r = await pending;
      overflowMs = Date.now() - t0;
      overflowStatus = r.status;
      retryAfter = r.headers["retry-after"] as string | undefined;
      overflowBody = (r.body ?? r.error ?? "").slice(0, OVERFLOW_BODY_QUOTE_CHARS);
      // Liveness AFTER as well: if the incumbents had already drained by the
      // time the overflow was served, the count taken before is not the
      // condition the server actually evaluated.
      liveAfterOverflow = open.filter((o) => !o.isDone()).length;
    }

    // Did refusing the newcomer harm the incumbents?
    const health = await starter.request({ path: "/api/health", timeoutMs: 15_000 });
    for (const o of open) o.close();
    const settled = await Promise.all(open.map((o) => o.done));
    const incumbentsKilled = settled.filter((r) => r.status !== 200).length;

    // Is a freed slot genuinely reusable, or was it leaked?
    await sleep(300);
    const reuse = await startRun(starter, session, ctx.projectId, ctx.chatId, "cap probe reuse");
    let reuseStatus = 0;
    if (reuse.runId !== null) {
      const c = new WireClient(inst.port);
      clients.push(c);
      const r = await c.request({ path: `/api/run/${reuse.runId}/stream`, session, timeoutMs: 15_000 });
      reuseStatus = r.status;
    }

    const incumbentHeldMs = Date.now() - incumbentOpenedAt;
    // The cap was genuinely exercised only if an incumbent was still holding
    // its slot when the server EVALUATED the overflow. `liveAfterOverflow`
    // is the conservative test: if every incumbent had drained by the time
    // the overflow was served, we cannot claim the limit was reached.
    const capWasFull = liveAtOverflow >= cap && liveAfterOverflow >= cap;
    const isRefusal = overflowStatus === 429;
    const hasRetryAfter = typeof retryAfter === "string" && retryAfter.length > 0;
    const prompt = Number.isFinite(overflowMs) && overflowMs < 2_000;
    const incumbentsSafe = incumbentsKilled === 0;
    const recovered = health.status === 200;
    const slotReusable = reuseStatus === 200;
    const verdict = !capWasFull
      ? "UNREACHABLE WITH FIXTURE RUNS — not a pass and not a failure"
      : isRefusal && hasRetryAfter && prompt && incumbentsSafe && recovered && slotReusable
        ? "HONEST REFUSAL — PASS on all six counts"
        : "NOT a clean refusal";

    rep.note(
      "wire.gates",
      "sse-connection-cap-refusal",
      `${verdict} · cap ${cap}/identity (FORCED via env so the window is reachable; the refusal PATH is identical at any cap, only the threshold differs) · ${open.length} streams opened, ` +
        `${liveAtOverflow} live immediately before the overflow and ${liveAfterOverflow} still live ` +
        `once it was served` +
        `${capWasFull ? " (cap genuinely full — the result below is interpretable)" : ` — the incumbent released its slot within ${incumbentHeldMs}ms, before the server evaluated the overflow, so THE LIMIT WAS NEVER REACHED and the status below says NOTHING about the cap. Cause, measured: a fixture run completes inside ONE event-loop turn (streamChat yields 8 canned events with no I/O to await), so acquire and release both happen before the second connection is dispatched. Settled only by a run with real async work. The mechanism EXISTS in code (server/sse.ts::acquireSseConnection throws RateLimitError with sseConnectionRetryAfterSeconds); what is unverified is its end-to-end behaviour`} · then one more → ` +
        `status ${overflowStatus}${isRefusal ? " (429 as documented)" : " (NOT 429)"} in ${ms(overflowMs)}` +
        `${prompt ? " (prompt, no hang)" : " (SLOW — this is a hang, not a refusal)"} · ` +
        `Retry-After: ${hasRetryAfter ? retryAfter : "ABSENT — the client is told to wait but not how long"} · ` +
        `incumbent streams not ending 200: ${incumbentsKilled}/${settled.length}` +
        `${capWasFull ? (incumbentsSafe ? " (existing streams unaffected by the refusal)" : " — REFUSING THE NEWCOMER PUNISHED THE INCUMBENTS") : " (uninterpretable here: the incumbents ended NATURALLY, not because of the overflow)"} · ` +
        `/api/health after: ${health.status}${recovered ? "" : " — server did not recover"} · ` +
        `slot reusable after close: ${slotReusable ? "yes" : `NO (status ${reuseStatus}) — the slot leaked, so a transient refusal became permanent`} · ` +
        `body ${overflowBody}`,
    );
  } finally {
    starter.destroy();
    for (const c of clients) c.destroy();
  }
}

// ── Main ─────────────────────────────────────────────────────────────────

const PHASES: Record<string, true> = {
  gates: true,
  latency: true,
  boot: true,
  hol: true,
  sse: true,
  runshare: true,
  concurrency: true,
  sustained: true,
  saturate: true,
  observer: true,
};

function wanted(name: string): boolean {
  if (!ONLY) return true;
  return ONLY.includes(name);
}

async function main(): Promise<void> {
  const reaped = await reapStrayInstances();
  if (reaped.length > 0) console.log(`reaped stray bench servers: ${reaped.join(", ")}`);

  const unknown = (ONLY ?? []).filter((p) => !(p in PHASES));
  if (unknown.length > 0) {
    console.error(`unknown phase(s): ${unknown.join(", ")}. Available: ${Object.keys(PHASES).join(", ")}`);
    process.exit(1);
  }

  const gitHead =
    spawnSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).stdout?.trim() ?? "unknown";
  const noiseFloor = measureNoiseFloor();
  const machine = snapshotMachine();

  console.log("═".repeat(78));
  console.log(
    `WIRE LOAD · profile "${PROFILE}" · ${CONNECTIONS} connections / ${USERS} users` +
      (VALIDATE ? " · VALIDATION RUN (tiny scale, low concurrency — not a baseline)" : ""),
  );
  console.log(`noise floor ${ms(noiseFloor)} · git ${gitHead}`);
  console.log("═".repeat(78));

  const rep = new Reporter(gitHead);
  const scale = `${PROFILE}${VALIDATE ? "/validate" : ""}`;

  // The rate limiter is raised for the LOAD phases only, and the raise is
  // recorded in the report. Leaving it at 60/min would make every write-load
  // number a measurement of the limiter; hiding that it was raised would be
  // worse. `HARNESS_WEB_RATE_LIMIT` (max 10 000) and
  // `HARNESS_WEB_RATE_LIMIT_REFILL_MS` (floor 1 000ms) are real env overrides
  // in server/config.ts — no product code is edited to obtain them.
  const inst = await startServer({
    profile: PROFILE,
    tag: "main",
    port: pickPort(0),
    probePort: pickPort(1),
    knobs: {
      llmFixtures: true,
      probe: true,
      // THE LIMITER IS RAISED HERE, AND THE RAISE IS IN THE REPORT.
      // At the shipped 60-writes-per-minute-per-user the validation run spent
      // the whole budget inside the latency phase and then 429'd every
      // `POST /api/run/start`, so the SSE, runshare and distinct-run phases
      // measured the rate limiter and nothing else. Both knobs are real env
      // overrides in server/config.ts (`HARNESS_WEB_RATE_LIMIT`, max 10 000;
      // `HARNESS_WEB_RATE_LIMIT_REFILL_MS`, floor 1 000ms) — no product code
      // is edited to obtain them. The limiter AS SHIPPED is measured by the
      // `gates` phase, which runs on its own untouched instance.
      rateLimit: RATE_LIMIT,
      rateLimitRefillMs: RATE_LIMIT_REFILL_MS,
      // Likewise the per-identity SSE cap: 8 (the default) over 50 users is
      // 400 streams, which covers the 100-connection target — but a
      // single-user profile like `tiny` or `heavy` would hit the cap at 8 and
      // the run would report the cap as if it were the product's ceiling.
      sseMaxConnectionsPerUser: 512,
    },
  });

  console.log(
    `server pid ${inst.pid} on :${inst.port} (probe :${inst.probePort}) · boot ${ms(inst.bootMs)} ` +
      `· db ${fmtBytes(inst.dbBytesAtStart)} · ${inst.sessions.length} sessions · log ${inst.logPath}`,
  );
  rep.note(
    "wire.server",
    "boot",
    `spawn → server's own listen line: ${ms(inst.listenMs)} (THE REAL BOOT — ESM load, TS type-strip, ` +
      `opening + migrating a ${fmtBytes(inst.dbBytesAtStart)} database) · ` +
      `listen → first 200 from /api/health: ${ms(inst.bootMs - inst.listenMs)} · ` +
      `NOTE: readiness is detected from the LOG LINE, not by racing the socket. On this box a TCP SYN to ` +
      `an unbound port is silently DROPPED, so a connect issued before listen only completes on the ~1s ` +
      `kernel retransmit — measured here at 618ms of pure artifact. An earlier version of this harness ` +
      `reported 1.02s boot for a 5MB db and 1.03s for a 1.58GB one; neither was boot.`,
  );
  rep.note(
    "wire.server",
    "chat-history-paging",
    `HARNESS_WEB_CHAT_HISTORY_PAGE_ROWS = 500 is an INTERNAL page size only: the read walks pages until ` +
      `the table is exhausted, so the caller still receives EVERY row. There is no cursor and no limit at ` +
      `the route level — the API contract is unchanged by it, and any "it is paged" reassurance is about ` +
      `the query, not the response.`,
  );
  rep.note(
    "wire.server",
    "rate-limit-RAISED",
    `this instance runs with HARNESS_WEB_RATE_LIMIT=${inst.knobs.rateLimit} per ` +
      `${(inst.knobs.rateLimitRefillMs ?? 60_000) / 1000}s instead of the shipped 60/60s. Every LOAD number ` +
      `below is therefore NOT limiter-constrained — which is the point, but it means these numbers do NOT ` +
      `describe what a real client meets on a write-heavy path. The shipped limiter is measured, ` +
      `un-raised, by the wire.gates suite on its own server instance.`,
  );
  rep.note(
    "wire.server",
    "sse-connection-cap",
    `HARNESS_WEB_SSE_MAX_CONNECTIONS_PER_USER = ${inst.knobs.sseMaxConnectionsPerUser ?? "8 (product default)"} · ` +
      `server/sse.ts caps CONCURRENT SSE STREAMS PER IDENTITY, and the identity is the user id — so ` +
      `"100 connections from 50 users" is 2/user and fits the default, but 100 streams from ONE user does not`,
  );

  let failure: unknown = null;
  const failedPhases: string[] = [];
  try {
    const classes = await preflight(inst, rep);

    // Each phase is isolated: one phase failing must not silently delete the
    // others' findings. The failure is RECORDED into the report rather than
    // only printed, so a report with a missing suite says why.
    const phase = async (name: string, fn: () => Promise<void>): Promise<void> => {
      if (!wanted(name)) return;
      try {
        await fn();
      } catch (err) {
        failedPhases.push(name);
        const detail = err instanceof Error ? err.message : String(err);
        console.error(`  phase "${name}" FAILED: ${detail}`);
        rep.note("wire.failed-phase", name, detail);
      }
    };

    // ORDER MATTERS, and it is the read-first order on purpose. Every write
    // this suite performs (the gates phase's rate-limit probe, the runs the
    // SSE phases start) PERSISTS into the staged database, growing the chats
    // that the read cases measure. Running the reads first means they see the
    // fixture as built; running `gates` — the heaviest writer — last means
    // its ~120 probe messages cannot inflate anything but themselves.
    await phase("latency", () => phaseLatency(inst, rep, classes, noiseFloor, scale));
    await phase("boot", () => phaseBootBurst(inst, rep, classes, noiseFloor, scale));
    await phase("sse", () => phaseSse(inst, rep, noiseFloor, scale));
    await phase("hol", () => phaseHeadOfLine(inst, rep, classes, noiseFloor, scale));
    await phase("runshare", () => phaseRunShare(inst, rep, scale));
    await phase("concurrency", () => phaseConcurrency(inst, rep, classes, noiseFloor, scale));
    await phase("sustained", () => phaseSustained(inst, rep, classes, noiseFloor, scale));
    await phase("saturate", () => phaseSaturate(inst, rep, classes, noiseFloor, scale));
    // Last, because it deliberately exhausts the write budget and leaves
    // ~120 probe messages behind.
    await phase("gates", () => phaseGates(rep, noiseFloor, scale));
  } catch (err) {
    failure = err;
    console.error(`\nRUN FAILED: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  } finally {
    const stopped = await inst.stop();
    console.log(`\nserver ${inst.pid} stopped: ${stopped.ending} after ${stopped.waitedMs}ms`);
  }

  if (wanted("observer") && failure === null) {
    try {
      await phaseObserverCost(rep, noiseFloor, scale);
    } catch (err) {
      console.error(`observer-cost phase failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const outPath = join(BENCH_OUT_DIR, `wire-${PROFILE}${VALIDATE ? "-validate" : ""}.json`);
  const report = rep.finish(outPath);

  if (!machine.quiet) {
    console.log(
      `\n!! The machine was NOT quiet at the start of this run (${machine.quietNote}).\n` +
        `   Every number above is an UPPER BOUND that includes contention.`,
    );
  }

  if (BASELINE) {
    const baseline = loadReport(BASELINE);
    if (!baseline) console.log(`\nbaseline ${BASELINE} not found`);
    else {
      console.log(`\nregression diff vs ${BASELINE} (worst first):`);
      for (const row of diffReports(baseline, report).slice(0, WIRE_DIFF_ROWS_SHOWN)) {
        const mark = row.ratio > 1.2 ? "REGRESSED" : row.ratio < 0.8 ? "improved " : "         ";
        console.log(`  ${mark} ${row.key}: ${ms(row.baselineP95Ms)} → ${ms(row.currentP95Ms)} (${row.ratio.toFixed(2)}×)`);
      }
    }
  }

  // Anything still alive is a leak, and a bench that leaks servers is a bench
  // that poisons the next run's machine conditions.
  const stray = await reapStrayInstances();
  if (stray.length > 0) console.log(`\n!! reaped leftover servers at exit: ${stray.join(", ")}`);

  if (failedPhases.length > 0) {
    console.log(`\n!! phases that failed (their findings are ABSENT, not zero): ${failedPhases.join(", ")}`);
  }

  if (KEEP_SCRATCH) {
    console.log(`\nbench/.scratch kept (--keep-scratch). Staged fleet copies are ~1.58GB each.`);
  } else {
    const { removedBytes } = clearScratch();
    console.log(`\nbench/.scratch removed — reclaimed ${fmtBytes(removedBytes)}`);
  }
  process.exit(failure === null && failedPhases.length === 0 ? 0 : 1);
}

void main().catch(async (err) => {
  console.error(err);
  await reapStrayInstances();
  process.exit(1);
});

export { killPid, type Stats };
