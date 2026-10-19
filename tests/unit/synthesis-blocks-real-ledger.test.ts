// @vitest-environment node
/**
 * SYNTHESIS blocks against a REAL ledger — real SQLite, real schema, real
 * rows, through the real store port (same rationale as
 * `coverage-blocks-real-ledger.test.ts`: a fake port would happily confirm
 * semantics the real store no longer satisfies).
 *
 * The query plans are EXPLAIN-asserted where the SQL lives — beside its owner
 * in `engine/test/timeline/timeline-synthesis-facts.test.ts`.
 *
 * The properties pinned here, each mutation-verified (see class comments):
 *
 *   A. PULSE facts are true against a hand-computed seed, and every measured
 *      fact carries a derivation sentence naming its own numbers.
 *   B. Honest absence: what is not derivable is `unavailable` with a reason —
 *      never a zero. `checksFlipped` is absent (with the recorded-since
 *      reason) for conversations predating the check-status history stream,
 *      and MEASURED — settled flips walked in ledger order — once the
 *      append-only check-status events exist.
 *   C. ECHOES is an exact join, gated per matched run: foreign runs are a
 *      COUNT and their ids never appear anywhere in the serialized report;
 *      unattributed records are counts only.
 *   D. FORECAST separates measurement from projection structurally: the
 *      projection is `kind: "projection"` with assumption + arithmetic, and
 *      it REFUSES under 3 samples, without a window, and without growth.
 *   E. Ownership wiring: an unauthenticated read throws AuthError; an
 *      authenticated caller asking for a chat that is not theirs gets 404
 *      (existence hidden); a non-owned runId entry to echoes gets 404.
 *   F. Registration + deny-by-default inputs (unknown keys refused, malformed
 *      paths refused, exactly-one-entry enforced).
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";

import { createTimelineStore } from "../../server/kernel/canonical.ts";
import { AuthError, NotFoundError } from "../../server/kernel/errors.ts";
import { clearBlocks, listBlocks } from "../../server/blocks/define.ts";
import type { AsyncDbClient } from "../../server/db/async-client.ts";
import type { RouteContext } from "../../server/router/router.ts";
import {
  CHECKS_FLIPPED_UNAVAILABLE_REASON,
  FORECAST_MIN_SAMPLES,
  chatRunScope,
  computeContextForecast,
  computeConversationPulse,
  computeEchoes,
  defineSynthesisBlocks,
  echoesForRun,
  runOwnershipFor,
  type SynthesisPort,
} from "../../server/blocks/synthesis.ts";
import { createTempDir } from "../helpers/temp-dir.ts";
import { jsonTimelineDocument } from "../helpers/timeline-documents.ts";

const LEDGER_ID = "ledger-synthesis-e2e";
const FOREIGN_RUN = "run-zz-foreign";
const AT = (n: number): string => `2026-07-21T00:00:${String(n).padStart(2, "0")}.000Z`;

let store: ReturnType<typeof createTimelineStore>;
const port = (): SynthesisPort => store;

function usageDoc(promptTokens: number, completionTokens: number) {
  return jsonTimelineDocument("usage", { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens });
}

function effectDoc(path: string, operation: string) {
  return jsonTimelineDocument("effect", { path, operation, preimageDigest: "d".repeat(64), postimageDigest: "e".repeat(64) });
}

function checkDoc(checkName: string, fromStatus: string | null, toStatus: string, chatId: string | null) {
  return jsonTimelineDocument("check-status", { checkId: `chk-${checkName}`, checkName, fromStatus, toStatus, projectId: "proj-1", chatId });
}

beforeAll(() => {
  const dir = createTempDir("synthesis-ledger-");
  store = createTimelineStore({ path: join(dir, "timeline.db"), ledgerId: LEDGER_ID });

  const ev = (
    eventId: string,
    eventType: Parameters<typeof store.appendEvent>[0]["eventType"],
    wallTime: string,
    extra: Partial<Parameters<typeof store.appendEvent>[0]> = {},
  ) =>
    store.appendEvent({
      eventId,
      ledgerId: LEDGER_ID,
      eventType,
      actor: { kind: "user", id: "u-1" },
      description: extra.description ?? `${eventType} event`,
      wallTime,
      ...extra,
    });

  // ── The seed, hand-computable ────────────────────────────────────────────
  // run-old (owned, PAST): touched /w/a.ts, has 1 error event.
  ev("old-f1", "file-effect", AT(0), {
    correlation: { runId: "run-old" },
    description: "write /w/a.ts",
    documents: [effectDoc("/w/a.ts", "write")],
  });
  ev("old-err", "error", AT(1), {
    correlation: { runId: "run-old" },
    error: { category: "tool", code: "tool_failed", message: "boom", retryable: false },
  });
  // run-foreign (NOT owned): touched /w/a.ts.
  ev("zz-f1", "file-effect", AT(2), {
    correlation: { runId: FOREIGN_RUN },
    description: "write /w/a.ts",
    documents: [effectDoc("/w/a.ts", "write")],
  });
  // unattributed: touched /w/a.ts with NO run id (the live recording gap).
  ev("un-f1", "file-effect", AT(3), {
    description: "write /w/a.ts",
    documents: [effectDoc("/w/a.ts", "write")],
  });
  // run-a + run-b: the current conversation (chat-1).
  ev("a-run", "run", AT(4), { correlation: { runId: "run-a" } });
  ev("a-m1", "message", AT(4), { correlation: { runId: "run-a" }, description: "user prompt" });
  ev("a-m2", "message", AT(5), { correlation: { runId: "run-a" }, description: "assistant message" });
  ev("a-t1", "tool", AT(5), { correlation: { runId: "run-a" }, description: "tool:read_file" });
  ev("a-t2", "tool", AT(6), { correlation: { runId: "run-a" }, description: "tool:read_file" });
  ev("a-t3", "tool", AT(6), { correlation: { runId: "run-a" }, description: "tool:run_command" });
  ev("a-u1", "token", AT(7), { correlation: { runId: "run-a" }, documents: [usageDoc(100, 20)] });
  ev("a-u2", "token", AT(8), { correlation: { runId: "run-a" }, documents: [usageDoc(160, 30)] });
  ev("a-u3", "token", AT(9), { correlation: { runId: "run-a" }, documents: [usageDoc(220, 40)] });
  ev("a-f1", "file-effect", AT(10), {
    correlation: { runId: "run-a" },
    description: "write /w/a.ts",
    documents: [effectDoc("/w/a.ts", "write")],
  });
  ev("a-f2", "file-effect", AT(11), {
    correlation: { runId: "run-a" },
    description: "write /w/new.ts",
    documents: [effectDoc("/w/new.ts", "write")],
  });
  ev("a-fail", "process", AT(12), { correlation: { runId: "run-a" }, outcome: "failed" });
  ev("b-m1", "message", AT(13), { correlation: { runId: "run-b" }, description: "user prompt" });
  // run-late (owned): touches /w/a.ts AFTER run-old — run-old's "later touches".
  ev("late-f1", "file-effect", AT(14), {
    correlation: { runId: "run-late" },
    description: "delete /w/a.ts",
    documents: [effectDoc("/w/a.ts", "delete")],
  });
  // ── check-status history (run-chk / chat-chk) — the checksFlipped seed ──
  // Sequence for check "typecheck": passed → running → failed → failed
  //   = exactly ONE flip (passed→failed; `running` marks a start, not a
  //   result, and the repeated `failed` is not a change).
  // Check "lint" (chat-level) settles once (warning) = zero flips, proven.
  // Check "lint" (PROJECT-level, chatId null) settles once (passed) = zero
  //   flips — and MUST NOT merge with chat-level lint, or the walk would
  //   fabricate a warning→passed flip out of two different checks.
  // One quality event with no document = counted undecodable.
  ev("chk-1", "quality", AT(15), {
    correlation: { runId: "run-chk" },
    description: "check:typecheck unrecorded→passed",
    documents: [checkDoc("typecheck", null, "passed", "chat-chk")],
  });
  ev("chk-2", "quality", AT(16), {
    correlation: { runId: "run-chk" },
    description: "check:typecheck passed→running",
    documents: [checkDoc("typecheck", "passed", "running", "chat-chk")],
  });
  // Recorded from the checks panel OUTSIDE any run: reachable via chat only.
  ev("chk-3", "quality", AT(17), {
    description: "check:typecheck running→failed",
    documents: [checkDoc("typecheck", "running", "failed", "chat-chk")],
  });
  ev("chk-4", "quality", AT(18), {
    correlation: { runId: "run-chk" },
    description: "check:typecheck failed→failed",
    documents: [checkDoc("typecheck", "failed", "failed", "chat-chk")],
  });
  ev("chk-5", "quality", AT(19), {
    correlation: { runId: "run-chk" },
    description: "check:lint unrecorded→warning",
    documents: [checkDoc("lint", null, "warning", "chat-chk")],
  });
  ev("chk-6", "quality", AT(20), {
    correlation: { runId: "run-chk" },
    description: "check:lint warning→passed",
    documents: [checkDoc("lint", "warning", "passed", null)],
  });
  ev("chk-nodoc", "quality", AT(21), {
    correlation: { runId: "run-chk" },
    description: "quality event from another writer",
  });
});

afterAll(() => {
  store.close();
});

const CHAT_RUNS = ["run-a", "run-b"] as const;
const ownsRun = (runId: string): boolean => runId !== FOREIGN_RUN;

// ── A. pulse facts + derivations ───────────────────────────────────────────

describe("A. conversationPulse computes true facts, each carrying its derivation", () => {
  const pulse = () => computeConversationPulse(port(), [...CHAT_RUNS]);

  test("runs line states known vs with-events from the two real sources", () => {
    const p = pulse();
    expect(p.runs).toEqual({
      known: 2,
      withEvents: 2,
      derivation: "2 run ids resolved from this conversation's message records; 2 of them have ledger events",
    });
  });

  test("filesTouched: distinct paths from run-attributed file-change records", () => {
    const p = pulse();
    expect(p.filesTouched.status).toBe("measured");
    if (p.filesTouched.status !== "measured") return;
    expect(p.filesTouched.value.distinctPaths).toBe(2);
    expect(p.filesTouched.value.records).toBe(2);
    expect([...p.filesTouched.value.paths].sort()).toEqual(["/w/a.ts", "/w/new.ts"]);
    // MUTATION: dropping the derivation, or writing one that does not state
    // the counted numbers, fails here — a fact without its derivation is
    // indistinguishable from a fabrication.
    expect(p.filesTouched.derivation).toContain("2 distinct paths");
    expect(p.filesTouched.derivation).toContain("2 file-change records");
    expect(p.filesTouched.derivation).toContain("recording gap");
  });

  test("toolsUsed: grouped by the recorded description, never a parsed name", () => {
    const p = pulse();
    if (p.toolsUsed.status !== "measured") throw new Error("toolsUsed not measured");
    expect(p.toolsUsed.value).toEqual({
      events: 3,
      byRecordedDescription: { "tool:read_file": 2, "tool:run_command": 1 },
    });
    expect(p.toolsUsed.derivation).toContain("3 tool events");
  });

  test("errors and wall-time span match the seed", () => {
    const p = pulse();
    if (p.errors.status !== "measured") throw new Error("errors not measured");
    expect(p.errors.value).toEqual({ eventsWithErrorDetail: 0, failedOutcomes: 1 });
    expect(p.errors.derivation).toContain("1 events with recorded outcome 'failed'");
    if (p.wallTimeSpan.status !== "measured") throw new Error("span not measured");
    expect(p.wallTimeSpan.value).toEqual({ firstEventAt: AT(4), lastEventAt: AT(13), events: 13 });
    expect(p.wallTimeSpan.derivation).toContain("13 ledger events");
  });

  test("tokens are summed from decodable usage records only", () => {
    const p = pulse();
    if (p.tokens.status !== "measured") throw new Error("tokens not measured");
    expect(p.tokens.value).toEqual({
      usageRecords: 3,
      unparsedUsageRecords: 0,
      promptTokens: 480,
      completionTokens: 90,
      totalTokens: 570,
    });
    expect(p.tokens.derivation).toContain("3 decodable token-usage records");
  });

  test("every measured fact carries a non-empty derivation", () => {
    const p = pulse();
    for (const fact of [p.filesTouched, p.toolsUsed, p.errors, p.tokens, p.wallTimeSpan]) {
      if (fact.status === "measured") {
        expect(fact.derivation.length).toBeGreaterThan(20);
      }
    }
  });
});

// ── B. honest absence ──────────────────────────────────────────────────────

describe("B. what is not derivable is absent with a reason — never a zero", () => {
  test("checksFlipped is unavailable — with the recorded-since reason and NO value — for a conversation with no check-status records", () => {
    // chat-1's runs recorded no check-status events (they predate the
    // history stream, exactly like every real conversation from before
    // CHECK_STATUS_HISTORY_SINCE).
    const p = computeConversationPulse(port(), [...CHAT_RUNS], "chat-1");
    expect(p.checksFlipped.status).toBe("unavailable");
    if (p.checksFlipped.status !== "unavailable") return;
    expect(p.checksFlipped.reason).toBe(CHECKS_FLIPPED_UNAVAILABLE_REASON);
    expect(p.checksFlipped.reason).toContain("recorded in the ledger only since");
    // MUTATION: replacing the honest absence with `{flips: 0}` fails here.
    expect("value" in p.checksFlipped).toBe(false);
    expect(JSON.stringify(p.checksFlipped)).not.toContain('"value"');
  });

  test("checksFlipped IS derivable once check-status events exist: one settled flip, running never flips, scopes never merge", () => {
    const p = computeConversationPulse(port(), ["run-chk"], "chat-chk");
    expect(p.checksFlipped.status).toBe("measured");
    if (p.checksFlipped.status !== "measured") return;
    const v = p.checksFlipped.value;
    // 6 decoded records (chk-1..chk-6); the docless quality event is counted
    // undecodable, never guessed at; the `running` record is transitional.
    expect(v.statusRecords).toBe(6);
    expect(v.transitionalRecords).toBe(1);
    expect(v.undecodableRecords).toBe(1);
    expect(v.truncated).toBe(false);
    // typecheck: passed → (running) → failed → failed = exactly one flip.
    // Both lints settle once each = proven zeros — and the project-level
    // lint is its own key (merging scopes would fabricate warning→passed).
    expect(v.byCheck).toEqual({
      typecheck: 1,
      lint: 0,
      "lint (project-level)": 0,
    });
    expect(v.flips).toBe(1);
    // The derivation states the walk in plain language.
    expect(p.checksFlipped.derivation).toContain("6 check-status records");
    expect(p.checksFlipped.derivation).toContain("'running' records mark starts");
    expect(p.checksFlipped.derivation).toContain("recorded since");
  });

  test("checksFlipped reaches panel-run checks through the chat id even when the conversation has no runs", () => {
    // chk-3 (typecheck→failed) was recorded OUTSIDE any run; a chat-only
    // scope still finds the chat-level records (5 of the 6 — the
    // project-level lint event names no chat and no in-scope run).
    const p = computeConversationPulse(port(), [], "chat-chk");
    expect(p.checksFlipped.status).toBe("measured");
    if (p.checksFlipped.status !== "measured") return;
    expect(p.checksFlipped.value.statusRecords).toBe(5);
    expect(p.checksFlipped.value.byCheck).toEqual({ typecheck: 1, lint: 0 });
    // The other pulse facts stay honestly unavailable — no runs to aggregate.
    expect(p.filesTouched.status).toBe("unavailable");
  });

  test("a conversation with no runs reports every ledger fact unavailable", () => {
    const p = computeConversationPulse(port(), []);
    expect(p.runs.known).toBe(0);
    for (const fact of [p.filesTouched, p.toolsUsed, p.errors, p.tokens, p.wallTimeSpan]) {
      expect(fact.status).toBe("unavailable");
      if (fact.status === "unavailable") expect(fact.reason).toContain("no recorded runs");
      expect("value" in fact).toBe(false);
    }
  });

  test("runs that recorded nothing are stated, not zero-filled", () => {
    const p = computeConversationPulse(port(), ["run-ghost-1", "run-ghost-2"]);
    expect(p.runs).toMatchObject({ known: 2, withEvents: 0 });
    expect(p.tokens.status).toBe("unavailable");
    if (p.tokens.status === "unavailable") {
      expect(p.tokens.reason).toContain("recorded nothing to the timeline");
    }
  });

  test("zero attributed token records is an absence, not a zero total", () => {
    // run-old has events but no usage docs.
    const p = computeConversationPulse(port(), ["run-old"]);
    expect(p.tokens.status).toBe("unavailable");
    if (p.tokens.status === "unavailable") {
      expect(p.tokens.reason).toContain("an absence, not a zero");
    }
  });
});

// ── C. echoes: exact join, per-run gate ────────────────────────────────────

describe("C. echoes joins exactly and withholds what is not the caller's", () => {
  const report = () => computeEchoes(port(), ownsRun, ["/w/a.ts"], "run-a");

  test("matches are the caller's own past runs, most recent first, with their recorded facts", () => {
    const r = report();
    expect(r.matches.map((m) => m.runId)).toEqual(["run-late", "run-old"]);
    const old = r.matches[1];
    expect(old).toBeDefined();
    expect(old?.fileChangeRecords).toBe(1);
    expect(old?.pathsTouched).toEqual(["/w/a.ts"]);
    expect(old?.eventsWithErrorDetail).toBe(1); // run-old's recorded error
    expect(old?.failedOutcomes).toBe(0);
    // After run-old's touch: zz-f1, un-f1, a-f1, late-f1 all match /w/a.ts.
    expect(old?.laterTouchesOfSamePaths).toBe(4);
    expect(old?.derivation).toContain("1 file-change records");
    expect(old?.derivation).toContain("exact string equality");
  });

  test("the current run is excluded from its own echoes", () => {
    const r = report();
    expect(r.matches.some((m) => m.runId === "run-a")).toBe(false);
  });

  test("foreign runs are a COUNT; the foreign run id appears nowhere in the report", () => {
    const r = report();
    expect(r.withheldRuns).toBe(1);
    // MUTATION: listing withheld runs (or leaking them through a derivation)
    // fails here — the count-not-content rule is the whole gate.
    expect(JSON.stringify(r)).not.toContain(FOREIGN_RUN);
  });

  test("unattributed records are counts only, per queried path", () => {
    const r = report();
    expect(r.unattributed).toEqual({ records: 1, byPath: { "/w/a.ts": 1 } });
    // No event id, wall time or description of the unattributed record leaks.
    expect(JSON.stringify(r.unattributed)).not.toContain("un-f1");
  });

  test("the summary and derivation state the join and its honest denominators", () => {
    const r = report();
    expect(r.summary).toContain("2 earlier runs you own changed these files");
    expect(r.summary).toContain("1 more matching run belong to other users");
    expect(r.summary).toContain("1 matching file-change records carry no run attribution");
    expect(r.derivation).toContain("exact string-equality join");
    expect(r.derivation).toContain("excluding the current run");
    expect(r.examined.fileEffectEvents).toBe(6);
    expect(r.examined.matchingRecords).toBe(5);
  });

  test("runId entry derives the run's own paths, and an effectless run is an honest empty", () => {
    const viaRun = echoesForRun(port(), ownsRun, "run-a");
    expect([...viaRun.queriedPaths].sort()).toEqual(["/w/a.ts", "/w/new.ts"]);
    expect(viaRun.matches.map((m) => m.runId).sort()).toEqual(["run-late", "run-old"]);

    const empty = echoesForRun(port(), ownsRun, "run-b"); // run-b touched nothing
    expect(empty.matches).toEqual([]);
    expect(empty.summary).toContain("no file-change records are attributed to this run");
    expect(empty.summary).toContain("recording gap");
  });
});

// ── D. forecast: measurement vs projection, structurally ───────────────────

describe("D. contextForecast labels projections and refuses honestly", () => {
  test("measured facts match the seed and state their arithmetic", () => {
    const f = computeContextForecast(port(), [...CHAT_RUNS], 1000);
    if (f.measured.messages.status !== "measured") throw new Error("messages not measured");
    expect(f.measured.messages.value).toBe(3);
    if (f.measured.tokensPerMessage.status !== "measured") throw new Error("tpm not measured");
    expect(f.measured.tokensPerMessage.value).toBe(190); // 570 / 3
    expect(f.measured.tokensPerMessage.derivation).toBe("570 total tokens ÷ 3 message events = 190");
    if (f.measured.promptGrowthPerRecord.status !== "measured") throw new Error("growth not measured");
    expect(f.measured.promptGrowthPerRecord.value).toBe(60); // (220-100)/2
    if (f.measured.lastRecordedPromptTokens.status !== "measured") throw new Error("last not measured");
    expect(f.measured.lastRecordedPromptTokens.value).toBe(220);
  });

  test("the projection is kind:'projection' with assumption and full arithmetic", () => {
    const f = computeContextForecast(port(), [...CHAT_RUNS], 1000);
    expect(f.projection.kind).toBe("projection");
    if (f.projection.kind !== "projection") return;
    expect(f.projection.value).toBe(13); // floor((1000-220)/60)
    expect(f.projection.unit).toBe("recorded model calls");
    // MUTATION: dropping the label, the assumption or the arithmetic fails
    // here — an unlabeled projection is a fabricated measurement.
    expect(f.projection.assumption).toContain("windowTokens=1000 was supplied by the caller");
    expect(f.projection.derivation).toContain("(assumed window 1000 − last recorded prompt 220) ÷ measured growth 60");
    expect(f.projection.derivation).toContain("~13");
  });

  test("no measured fact ever carries a projection label, and vice versa", () => {
    const f = computeContextForecast(port(), [...CHAT_RUNS], 1000);
    expect(JSON.stringify(f.measured)).not.toContain('"kind"');
    expect(JSON.stringify(f.projection)).not.toContain('"status"');
  });

  test("under 3 samples: refused, naming the shortfall", () => {
    // run-old alone has zero usage records.
    const f = computeContextForecast(port(), ["run-old"], 1000);
    expect(f.projection.kind).toBe("refused");
    if (f.projection.kind !== "refused") return;
    expect(f.projection.reason).toContain(`0 of at least ${FORECAST_MIN_SAMPLES}`);
  });

  test("without a caller-supplied window: refused, because no window is recorded anywhere", () => {
    const f = computeContextForecast(port(), [...CHAT_RUNS]);
    expect(f.projection.kind).toBe("refused");
    if (f.projection.kind !== "refused") return;
    expect(f.projection.reason).toContain("no context-window size is recorded");
    expect(f.projection.reason).toContain("supply windowTokens");
  });
});

// ── E + F. wiring, gates, registration, deny-by-default inputs ─────────────

/** A facade stub that authenticates any cookie as user u-1 and owns chat-1. */
function stubAsyncDb(): AsyncDbClient {
  return {
    getAuthSession: async () => ({ user_id: "u-1", created_at: new Date().toISOString() }),
    getUserById: async () => ({ id: "u-1", username: "u", is_admin: 0 }),
    // `runOwnershipFor` enumerates the caller's runs ONCE so the predicate it
    // hands back can stay synchronous. Mirrors the real client, where
    // `allRunIdsForUser` and `runBelongsToUser` are the same predicate.
    // Every run this stub's user owns. `runOwnershipFor` enumerates them
    // ONCE so the predicate it returns can stay synchronous — the same shape
    // the real client has, where `allRunIdsForUser` and `runBelongsToUser`
    // ask the identical question of `messages.run_id`.
    allRunIdsForUser: async (userId: string) =>
      userId === "u-1" ? [...CHAT_RUNS, "run-old"] : [],
    getChat: async (id: string, userId: string) =>
      id === "chat-1" && userId === "u-1" ? { id } : null,
    runIdsForChat: async (id: string, userId: string) =>
      id === "chat-1" && userId === "u-1" ? [...CHAT_RUNS] : [],
    runBelongsToUser: async (runId: string, userId: string) =>
      userId === "u-1" && ownsRun(runId),
    listMessages: async () => [],
    listToolCallsByChat: async () => [],
  } as unknown as AsyncDbClient;
}

function authedCtx(): RouteContext {
  return { req: { headers: { cookie: "harness_auth=test-token" } } } as unknown as RouteContext;
}

describe("E. ownership choke points", () => {
  // The gate is awaited now that it crosses the async facade, so each refusal
  // arrives as a REJECTION rather than a synchronous throw. `rejects.toThrow`
  // still fails when nothing is thrown at all, so the assertions kept their
  // force through the move — and each was mutation-proved again after it.
  test("an unauthenticated caller is refused before any ledger read", async () => {
    const ctx = { req: { headers: {} } } as unknown as RouteContext;
    await expect(chatRunScope(ctx, stubAsyncDb(), "chat-1")).rejects.toThrow(AuthError);
  });

  test("a chat that is not the caller's is a 404 — existence hidden", async () => {
    // MUTATION: removing the getChat gate makes this return [] instead of
    // throwing, and the block would serve an empty-but-real-looking pulse for
    // someone else's chat id.
    await expect(
      chatRunScope(authedCtx(), stubAsyncDb(), "chat-of-someone-else"),
    ).rejects.toThrow(NotFoundError);
  });

  test("an owned chat resolves to its scoped run ids", async () => {
    expect(await chatRunScope(authedCtx(), stubAsyncDb(), "chat-1")).toEqual([
      ...CHAT_RUNS,
    ]);
  });

  test("the echoes runId entry denies a non-owned run as not-found", async () => {
    clearBlocks();
    defineSynthesisBlocks(stubAsyncDb());
    const echoes = listBlocks().find((b) => b.descriptor.id === "synthesis.echoes");
    clearBlocks();
    expect(echoes).toBeDefined();
    await expect(
      Promise.resolve().then(() =>
        echoes?.definition.read?.handler({ runId: FOREIGN_RUN }, { ctx: authedCtx() }),
      ),
    ).rejects.toThrow(NotFoundError);
  });

  test("runOwnershipFor threads the caller's user id into runBelongsToUser", async () => {
    const owns = await runOwnershipFor(authedCtx(), stubAsyncDb());
    expect(owns("run-old")).toBe(true);
    expect(owns(FOREIGN_RUN)).toBe(false);
  });
});

describe("F. registration and deny-by-default inputs", () => {
  function registered() {
    clearBlocks();
    defineSynthesisBlocks(stubAsyncDb());
    const blocks = listBlocks();
    clearBlocks();
    return blocks;
  }

  test("all three blocks are declared with reads", () => {
    const ids = registered().map((b) => b.descriptor.id);
    expect(ids).toEqual([
      "synthesis.conversationPulse",
      "synthesis.echoes",
      "synthesis.contextForecast",
    ]);
    for (const b of registered()) expect(b.descriptor.hasRead).toBe(true);
  });

  test("unknown input keys are refused on every block", () => {
    for (const b of registered()) {
      const schema = b.definition.read?.input;
      const valid =
        b.descriptor.id === "synthesis.echoes" ? { paths: '["/w/a.ts"]' } : { chatId: "chat-1" };
      expect(schema?.safeParse(valid).success).toBe(true);
      expect(
        schema?.safeParse({ ...valid, unexpected: "1" }).success,
        `${b.descriptor.id} accepted an undeclared input key`,
      ).toBe(false);
    }
  });

  test("echoes: malformed paths and both-or-neither entries are 400s, not guesses", () => {
    const echoes = registered().find((b) => b.descriptor.id === "synthesis.echoes");
    const schema = echoes?.definition.read?.input;
    expect(schema?.safeParse({ paths: "not json" }).success).toBe(false);
    expect(schema?.safeParse({ paths: '"just-a-string"' }).success).toBe(false);
    expect(schema?.safeParse({ paths: "[]" }).success).toBe(false);
    expect(schema?.safeParse({ paths: '[""]' }).success).toBe(false);
    expect(schema?.safeParse({}).success).toBe(false);
    expect(schema?.safeParse({ paths: '["/w/a.ts"]', runId: "run-a" }).success).toBe(false);
    expect(schema?.safeParse({ runId: "run-a" }).success).toBe(true);
  });

  test("forecast: windowTokens must be a positive bounded integer", () => {
    const forecast = registered().find((b) => b.descriptor.id === "synthesis.contextForecast");
    const schema = forecast?.definition.read?.input;
    expect(schema?.safeParse({ chatId: "chat-1", windowTokens: "200000" }).success).toBe(true);
    expect(schema?.safeParse({ chatId: "chat-1", windowTokens: "-5" }).success).toBe(false);
    expect(schema?.safeParse({ chatId: "chat-1", windowTokens: "1.5" }).success).toBe(false);
    expect(schema?.safeParse({ chatId: "chat-1", windowTokens: "999999999999" }).success).toBe(false);
  });

  test("an unauthenticated read is refused on every block", async () => {
    for (const b of registered()) {
      const ctx = { req: { headers: {} } } as unknown as RouteContext;
      const input =
        b.descriptor.id === "synthesis.echoes" ? { paths: ["/w/a.ts"] } : { chatId: "chat-1" };
      await expect(
        Promise.resolve().then(() => b.definition.read?.handler(input, { ctx })),
        `${b.descriptor.id} served an unauthenticated read`,
      ).rejects.toThrow(AuthError);
    }
  });
});
