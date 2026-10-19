// @vitest-environment node
/**
 * THE LEDGER DIG READER — against a REAL store-built ledger.
 *
 * The dig reader (`engine/src/timeline/ledger-dig.ts` — the ledger's
 * read-owner domain, beside the store that builds the file it reads) is the
 * read path behind `scripts/trace.ts`: it answers "what did this run/trace
 * actually do" from the ledger with its own READ-ONLY connection, so the
 * evidence rounds one and two recorded becomes one command instead of a
 * hand-written node:sqlite script.
 *
 * A fake row set would happily confirm query, grouping, document-selection
 * and summary semantics the REAL store no longer satisfies (column shapes,
 * document position ordering, identifier validation). So the fixture is a
 * REAL ledger: `createTimelineStore` builds it in a temp dir, events are
 * written through the store's own `appendEvent` with the document shapes
 * the writers actually record (effect-timing, effect-args, usage,
 * llm-request, llm-response), and the reader is then pointed at the file —
 * the same path the CLI takes.
 *
 * Pinned invariants, each with its mutation arm:
 *
 *   A. SCOPING — a run dig returns exactly that run's events in ascending
 *      causal order; a trace dig the same set by trace; the tail is newest
 *      first and bounded. (Mutation: drop the predicate → foreign events
 *      appear; flip the order → the sequences come back reversed.)
 *   B. GROUPING — turn-correlated events are grouped under their turn,
 *      run-level events stay at the top level, and the group boundary is
 *      the RECORDED correlation, nothing else. (Mutation: grouping by a
 *      constant → the `turn …` headers vanish and indented member lines
 *      appear at the top level.)
 *   C. DOCUMENT SELECTION — the llm view keeps exactly the provider
 *      payloads + redacted args; the all view keeps EVERY stored document
 *      by name-agnostic passthrough, so a document type the reader was
 *      never told about still shows. (Mutation: filter the all view through
 *      a fixed name list → the fixture's unlisted document vanishes.)
 *   D. SUMMARY — event count, wall span, llm call count, token sums (only
 *      decodable usage documents), tool groups by recorded description with
 *      outcome tallies, and the error-detail list that shows a thrown-4xx
 *      shape (succeeded + error fields) with its outcome. (Mutation:
 *      off-by-one in any count, or folding an undecodable usage document
 *      into the sums, → the exact numbers disagree.)
 *   E. FAILURE FILTER — `--failed` keeps outcome failed/denied ONLY; an
 *      event with error fields on a succeeded outcome is NOT a failure.
 *      (Mutation: filtering on error-field presence → the succeeded+
 *      error-detail event leaks in.)
 *   F. HONEST REFUSALS — a missing ledger file is refused with the reason;
 *      a relative configured path is anchored so the tool works from any
 *      cwd.
 *   G. RUNS AGGREGATION — the per-run rollup over the real ledger: counts,
 *      outcome rollups, failure counts, tool failures by name, token sums,
 *      chat scoping, newest-first order, --failed/--last filters.
 *      (Mutation: break a count → the exact numbers disagree.)
 *   H. DOCTOR — the newest FAILED run is picked over the newer clean one;
 *      its failed events, its gate-block fields (failedFields + escalated)
 *      and its provider payloads are collapsed into one answer; a ledger
 *      with no run gets the honest none verdict. (Mutation: picking the
 *      newest run instead of the newest FAILED run → the arm reds on the
 *      wrong runId.)
 *   I. WALL-TIME BOUNDS — --since/--until filter on the event time,
 *      inclusive at both edges, from ISO-8601 timestamps (normalized) and
 *      relative durations; an invalid bound is a typed refusal with the
 *      grammar in the message.
 *   J. EVENT-TYPE VALIDATION + TAIL HYGIENE — an unknown --event-type is a
 *      typed refusal listing the recorded vocabulary; the match is
 *      case-insensitive; the resource lane is VALID and excluded from the
 *      tail's default scan, with --all-types and an explicit
 *      --event-type resource both opting back in. (Mutation: removing the
 *      tail's resource exclusion → the default-scan arm reds on the
 *      resource rows reappearing.)
 *   K. ABSENT VS EMPTY — a run/trace id that matches nothing is ABSENT
 *      (the pure verdict says so; the shell exits 1 with one honest line);
 *      a filter that matches nothing inside an existing scope is EMPTY
 *      (exit 0 with the honest empty dump). The shell's exit-code mapping
 *      is pinned by running the real CLI as a subprocess against the
 *      fixture ledger — the shell resolves its ledger path from the server
 *      config owner at import time, so a spawned child with the env
 *      override is the one honest door into that mapping. (Mutation: an
 *      absent id exiting 0 → the exit-semantics arm reds.)
 *   L. FOLLOW BATCHES — the pure new-rows rule: after a last-seen sequence
 *      only newer rows are new, in causal order; a null cursor takes the
 *      whole window; the cursor never regresses. The poll loop itself is
 *      deliberately not tested — it runs until interrupted.
 *   M. THE --schema CONTRACT — the JSON contract table beside the types is
 *      walked against every command's REAL --json output in both
 *      directions (every emitted key declared, every declared non-optional
 *      key present on a non-empty result), so the table can never drift
 *      from the shapes silently; the document vocabulary and the
 *      raw-text note are part of the printed contract.
 */
import { beforeAll, describe, expect, test } from "vitest";
import { join } from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { startHttpTestServer } from "../helpers/http-server.ts";
import { registerAuthRoutes } from "../../server/routes/auth.ts";
import { hashPassword } from "../../server/auth/auth.ts";
import { defineAnatomyBlocks } from "../../server/blocks/anatomy.ts";
import { mountBlockRoutes } from "../../server/blocks/define.ts";
import { blockReadPath } from "../../shared/block-contract.ts";

import { createTimelineStore } from "../../server/kernel/canonical.ts";
import {
  resolveLedgerPath,
  openLedgerReadOnly,
  digLedger,
  digExitVerdict,
  resolveEventTypeFilter,
  resolveWallTimeBound,
  listRuns,
  doctorLedger,
  nextFollowBatch,
  groupByTurn,
  selectDocuments,
  formatDigText,
  formatDigJson,
  formatRunsText,
  formatRunsJson,
  formatDoctorText,
  formatDoctorJson,
  formatSchemaJson,
  DIG_JSON_SCHEMA,
  DIG_KNOWN_DOCUMENT_NAMES,
  type DigDocumentView,
  type DigEvent,
  type DigSchemaField,
} from "../../engine/src/timeline/ledger-dig.ts";
import { sha256 } from "../../engine/src/kernel/integrity.ts";
import { InputError } from "../../engine/src/kernel/errors.ts";
import {
  TIMELINE_EFFECT_TIMING_DOCUMENT,
  TIMELINE_EFFECT_ARGS_DOCUMENT,
  TIMELINE_GATE_BLOCK_DOCUMENT,
  TIMELINE_LLM_REQUEST_DOCUMENT,
  TIMELINE_LLM_RESPONSE_DOCUMENT,
  TIMELINE_RESOURCE_METRIC_DOCUMENT,
} from "../../shared/constants.ts";
import { TIMELINE_TOKEN_USAGE_DOCUMENT } from "../../engine/src/timeline/timeline-types.ts";
import { createTempDir } from "../helpers/temp-dir.ts";

const LEDGER_ID = "ledger-dig-test";
const RUN = "run-dig-1";
const TRACE = "trace-dig-a";
const OTHER_RUN = "run-dig-2";
const OTHER_TRACE = "trace-dig-b";
const TURN_1 = "turn-dig-t1";
const TURN_2 = "turn-dig-t2";
/** The chat sessions the fixture correlates its runs by. */
const CHAT_A = "chat-dig-a";
const CHAT_B = "chat-dig-b";
/** The resource-lane events' event ids — asserted as a set, never in order. */
const RESOURCE_EVENTS: readonly string[] = ["ev-res-1", "ev-res-2", "ev-res-3"];

/** Distinct, increasing wall times so every ordering assertion is exact. */
const AT = (n: number): string => `2026-08-30T00:${String(n).padStart(2, "0")}:00.000Z`;

/** The document names the fixture writes — the expected set for the all
 * view is DERIVED from this list (and the extra unlisted document), never
 * restated inside the assertions. */
const TIMING = (durationMs: number, cpuMs?: number, heapDeltaBytes?: number) =>
  doc(TIMELINE_EFFECT_TIMING_DOCUMENT, JSON.stringify({ durationMs, ...(cpuMs !== undefined ? { cpuMs } : {}), ...(heapDeltaBytes !== undefined ? { heapDeltaBytes } : {}) }));
const ARGS = (shape: string) => doc(TIMELINE_EFFECT_ARGS_DOCUMENT, shape);
const USAGE = (promptTokens: number, completionTokens: number) =>
  doc(TIMELINE_TOKEN_USAGE_DOCUMENT, JSON.stringify({ promptTokens, completionTokens, totalTokens: promptTokens + completionTokens }));
/**
 * The boundary shape that exposed the decoder drift: a usage document
 * carrying ONLY the measured pair. The dig's former private decoder folded
 * it in while the store's counted it unparsed — the ONE decoder now reads
 * it the same way on both sides (the total is derived as the pair's sum).
 */
const USAGE_WITHOUT_TOTAL = (promptTokens: number, completionTokens: number) =>
  doc(TIMELINE_TOKEN_USAGE_DOCUMENT, JSON.stringify({ promptTokens, completionTokens }));
const LLM_REQUEST = doc(TIMELINE_LLM_REQUEST_DOCUMENT, JSON.stringify([{ role: "user", content: "write the file" }]));
const LLM_RESPONSE = doc(TIMELINE_LLM_RESPONSE_DOCUMENT, JSON.stringify({ text: "on it", toolCalls: [{ name: "write_file", arguments: "{}" }] }));
/** The gate-block document a blocked tool call carries — the structured
 * half of the refusal, with the fields the doctor surfaces. */
const GATE_BLOCK = doc(TIMELINE_GATE_BLOCK_DOCUMENT, JSON.stringify({
  kind: "schema_mismatch",
  toolName: "mcp__filesystem__write_file",
  failedFields: ["path", "content"],
  escalated: true,
}));
/** A document name NO writer declares — the all view must still show it. */
const UNLISTED = doc("future-doc", JSON.stringify({ anything: true }));

function doc(name: string, contentJson: string) {
  return { name, contentJson, contentDigest: sha256(contentJson) };
}

let ledgerPath: string;
/** A store-built ledger with ZERO events — the honest-empty fixtures. */
let emptyLedgerPath: string;
/** A minimal web db (messages table only) so the CLI's `--chat` resolution
 * runs against controlled rows, never this machine's real web db. Built in
 * the same temp dir as the ledger fixture. */
let webDbPath: string;
let digEvents: readonly DigEvent[];
/** The real CLI, run as a subprocess for the shell-level pins (see K). */
const TRACE_TS = join(fileURLToPath(import.meta.url), "..", "..", "..", "scripts", "trace.ts");

beforeAll(() => {
  const dir = createTempDir("ledger-dig-");
  ledgerPath = join(dir, "timeline.db");
  emptyLedgerPath = join(dir, "timeline-empty.db");
  webDbPath = join(dir, "web.db");
  {
    const web = new DatabaseSync(webDbPath);
    try {
      // The chat→runs seam reads ONE table through the db owner's owned
      // statement (CHAT_RUN_IDS_SQL) — a minimal messages table is the
      // whole contract surface it needs.
      web.exec(
        "CREATE TABLE messages (id INTEGER PRIMARY KEY, chat_id TEXT, run_id TEXT)",
      );
      const insert = web.prepare("INSERT INTO messages (chat_id, run_id) VALUES (?, ?)");
      insert.run("chat-live", RUN);
      insert.run("chat-live", RUN);
      insert.run("chat-live", null);
      insert.run("chat-live", "");
      insert.run("chat-ghost", "run-not-in-this-ledger");
      // chat-empty: no row at all — resolves to zero run ids.
    } finally {
      web.close();
    }
  }
  createTimelineStore({ path: emptyLedgerPath, ledgerId: `${LEDGER_ID}-empty` }).close();
  const store = createTimelineStore({ path: ledgerPath, ledgerId: LEDGER_ID });

  const ev = (
    eventId: string,
    n: number,
    eventType: string,
    description: string,
    extra: {
      runId?: string;
      traceId?: string;
      turnId?: string;
      chatId?: string;
      outcome?: "succeeded" | "failed" | "denied";
      error?: { category: string; code: string; message: string; retryable: boolean };
      documents?: ReturnType<typeof doc>[];
    } = {},
  ) =>
    store.appendEvent({
      eventId,
      ledgerId: LEDGER_ID,
      eventType: eventType as never,
      actor: { kind: "user", id: "u-dig" },
      description,
      wallTime: AT(n),
      ...(extra.traceId !== undefined ? { traceId: extra.traceId } : {}),
      ...(extra.outcome !== undefined ? { outcome: extra.outcome } : {}),
      ...(extra.error !== undefined ? { error: extra.error } : {}),
      ...(extra.runId !== undefined || extra.turnId !== undefined || extra.chatId !== undefined
        ? {
            correlation: {
              ...(extra.runId !== undefined ? { runId: extra.runId } : {}),
              ...(extra.turnId !== undefined ? { turnId: extra.turnId } : {}),
              ...(extra.chatId !== undefined ? { sessionId: extra.chatId } : {}),
            },
          }
        : {}),
      ...(extra.documents !== undefined ? { documents: extra.documents } : {}),
    });

  // ── run-dig-1 under trace-dig-a: the shape of a real run ────────────────
  ev("ev-run-start", 1, "run", "run started", { runId: RUN, traceId: TRACE, chatId: CHAT_A });
  ev("ev-db-1", 2, "db", "db:getProjectByPath", {
    runId: RUN, traceId: TRACE, chatId: CHAT_A, outcome: "succeeded",
    documents: [TIMING(13, 7, 21504), ARGS('{"argCount":1,"args":[{"type":"string","bytes":36}]}'), UNLISTED],
  });
  ev("ev-http-1", 3, "network", "http:POST /api/run/start", {
    runId: RUN, traceId: TRACE, chatId: CHAT_A, outcome: "succeeded",
    documents: [TIMING(117, 38, 1623048)],
  });
  // The thrown-4xx shape: outcome succeeded, error fields populated. The
  // failure filter must NOT claim it; the summary's error list must SHOW it.
  ev("ev-http-4xx", 4, "network", "http:GET /api/chats", {
    runId: RUN, traceId: TRACE, chatId: CHAT_A, outcome: "succeeded",
    error: { category: "http", code: "missing_query", message: "Missing ?projectId query parameter", retryable: false },
    documents: [TIMING(4)],
  });
  ev("ev-turn-1", 5, "turn", "assistant turn started", { runId: RUN, traceId: TRACE, chatId: CHAT_A, turnId: TURN_1 });
  ev("ev-tool-failed", 6, "tool", "tool:mcp__filesystem__write_file", {
    runId: RUN, traceId: TRACE, chatId: CHAT_A, turnId: TURN_1, outcome: "failed",
    error: { category: "tool", code: "tool_gate_schema_mismatch", message: "arguments failed schema validation", retryable: true },
    documents: [TIMING(2), ARGS('{"path":null}'), GATE_BLOCK],
  });
  ev("ev-gate-error", 7, "error", "Tool 'mcp__filesystem__write_file' arguments failed schema validation", {
    runId: RUN, traceId: TRACE, chatId: CHAT_A, turnId: TURN_1, outcome: "denied",
  });
  ev("ev-tool-ok", 8, "tool", "tool:edit", {
    runId: RUN, traceId: TRACE, chatId: CHAT_A, turnId: TURN_1, outcome: "succeeded",
    documents: [TIMING(120, 40, 1048576)],
  });
  ev("ev-turn-2", 9, "turn", "assistant turn started", { runId: RUN, traceId: TRACE, chatId: CHAT_A, turnId: TURN_2 });
  ev("ev-provider-1", 10, "provider", "llm:google/gemma-4-31b-it", {
    runId: RUN, traceId: TRACE, chatId: CHAT_A, turnId: TURN_2, outcome: "succeeded",
    documents: [TIMING(3296, 957, -381024), ARGS('{"model":"google/gemma-4-31b-it","toolChoice":"auto"}'), LLM_REQUEST, LLM_RESPONSE],
  });
  ev("ev-token-1", 11, "token", "Token usage: prompt=100 completion=5", {
    runId: RUN, traceId: TRACE, chatId: CHAT_A, turnId: TURN_2,
    documents: [USAGE(100, 5)],
  });
  // The pair-only boundary document — decoded (never counted unparsed), its
  // measured tokens folded in exactly like a three-field sample's.
  ev("ev-token-pair-only", 11, "token", "Token usage: prompt=37 completion=8", {
    runId: RUN, traceId: TRACE, chatId: CHAT_A, turnId: TURN_2,
    documents: [USAGE_WITHOUT_TOTAL(37, 8)],
  });
  ev("ev-provider-2", 12, "provider", "llm:google/gemma-4-31b-it", {
    runId: RUN, traceId: TRACE, chatId: CHAT_A, turnId: TURN_2, outcome: "succeeded",
    documents: [TIMING(4000), LLM_REQUEST, LLM_RESPONSE],
  });
  // A usage document that does NOT decode to numbers — counted, never folded
  // into the sums.
  ev("ev-token-bad", 13, "token", "Token usage: unreadable", {
    runId: RUN, traceId: TRACE, chatId: CHAT_A, turnId: TURN_2,
    documents: [{ name: TIMELINE_TOKEN_USAGE_DOCUMENT, contentJson: "{not json", contentDigest: sha256("{not json") }],
  });
  // ── the honest fallback catches, exercised by real rows (the reader's
  // unreadable-document paths): a gate-block document that does not PARSE
  // rides in the doctor's answer as the unreadable verdict, and an
  // effect-timing document whose duration is not a number renders the
  // `took` cell as the honest absence. Neither is silently dropped.
  ev("ev-gate-unreadable", 13, "error", "Tool 'mcp__filesystem__read_file' blocked (details unreadable)", {
    runId: RUN, traceId: TRACE, chatId: CHAT_A, turnId: TURN_2, outcome: "succeeded",
    documents: [{ name: TIMELINE_GATE_BLOCK_DOCUMENT, contentJson: "{not json", contentDigest: sha256("{not json") }],
  });
  ev("ev-timing-unreadable", 13, "db", "db:getChatMessages", {
    runId: RUN, traceId: TRACE, chatId: CHAT_A, turnId: TURN_2, outcome: "succeeded",
    documents: [{ name: TIMELINE_EFFECT_TIMING_DOCUMENT, contentJson: '{"durationMs":"forever"}', contentDigest: sha256('{"durationMs":"forever"}') }],
  });

  // ── a second run: scoping + tail material ──────────────────────────────
  ev("ev-other-run", 14, "run", "run started", { runId: OTHER_RUN, traceId: OTHER_TRACE, chatId: CHAT_B });
  ev("ev-other-db", 15, "db", "db:listProjects", {
    runId: OTHER_RUN, traceId: OTHER_TRACE, chatId: CHAT_B, outcome: "succeeded",
    documents: [TIMING(63, 18, 1523712)],
  });
  // An event with no run and no trace — the tail must still show it, with
  // honest "—" ids.
  ev("ev-ambientless", 16, "memory", "memory entry recorded", {});

  // ── the sampler's resource lane: ambient, OLDER than every other event ──
  // so the existing top-of-tail assertions keep their exact meaning, and
  // present at the bottom of any whole-ledger tail window where the
  // default scan must exclude them.
  ev("ev-res-1", 0, "resource", "Resource process.rss: 123bytes", {
    documents: [doc(TIMELINE_RESOURCE_METRIC_DOCUMENT, JSON.stringify({ metric: "process.rss", value: 123, unit: "bytes" }))],
  });
  ev("ev-res-2", 0, "resource", "Resource cpu.user: 5.5ms", {});
  ev("ev-res-3", 0, "resource", "Resource eventLoop.utilization: 0.25ratio", {});

  store.close();
  digEvents = digLedger(openLedgerReadOnly(ledgerPath), { kind: "run", id: RUN }).events;
});

describe("A. scoping — a dig returns exactly its scope, in order", () => {
  test("a run dig returns only that run's events, ascending by sequence", () => {
    expect(digEvents.map((e) => e.eventId)).toEqual([
      "ev-run-start", "ev-db-1", "ev-http-1", "ev-http-4xx", "ev-turn-1",
      "ev-tool-failed", "ev-gate-error", "ev-tool-ok", "ev-turn-2",
      "ev-provider-1", "ev-token-1", "ev-token-pair-only", "ev-provider-2", "ev-token-bad",
      "ev-gate-unreadable", "ev-timing-unreadable",
    ]);
    const sequences = digEvents.map((e) => Number(e.sequence));
    expect([...sequences].sort((a, b) => a - b)).toEqual(sequences);
  });

  test("a trace dig returns the same events by trace, excluding the other run", () => {
    const result = digLedger(openLedgerReadOnly(ledgerPath), { kind: "trace", id: TRACE });
    expect(result.events.map((e) => e.eventId)).toEqual(digEvents.map((e) => e.eventId));
    const other = digLedger(openLedgerReadOnly(ledgerPath), { kind: "trace", id: OTHER_TRACE });
    expect(other.events.map((e) => e.eventId)).toEqual(["ev-other-run", "ev-other-db"]);
  });

  test("the tail is newest first, bounded, and shows run/trace ids — including honest absence", () => {
    const result = digLedger(openLedgerReadOnly(ledgerPath), { kind: "tail", limit: 3 });
    expect(result.events.map((e) => e.eventId)).toEqual(["ev-ambientless", "ev-other-db", "ev-other-run"]);
    const text = formatDigText(result, "none");
    expect(text).toContain("ev-ambientless".length > 0 ? "memory entry recorded" : "");
    // ids ride every tail line; an event with none says "—" rather than a blank.
    const ambientless = result.events.find((e) => e.eventId === "ev-ambientless")!;
    expect(ambientless.runId).toBeNull();
    expect(ambientless.traceId).toBeNull();
    expect(formatDigText(result, "none")).toMatch(/memory entry recorded\s+· — · —/u);
  });

  test("the event-type filter narrows any scope", () => {
    const result = digLedger(openLedgerReadOnly(ledgerPath), { kind: "run", id: RUN }, { eventType: "tool" });
    expect(result.events.map((e) => e.eventId)).toEqual(["ev-tool-failed", "ev-tool-ok"]);
  });
});

describe("B. grouping — the recorded turn correlation drives the groups", () => {
  test("groupByTurn opens a group at each turn boundary and keeps run-level events top-level", () => {
    const groups = groupByTurn(digEvents);
    expect(groups.map((g) => g.turnId)).toEqual([null, TURN_1, TURN_2]);
    expect(groups[0]!.events.map((e) => e.eventId)).toEqual(["ev-run-start", "ev-db-1", "ev-http-1", "ev-http-4xx"]);
    expect(groups[1]!.events.map((e) => e.eventId)).toEqual(["ev-turn-1", "ev-tool-failed", "ev-gate-error", "ev-tool-ok"]);
    expect(groups[2]!.events.map((e) => e.eventId)).toEqual(["ev-turn-2", "ev-provider-1", "ev-token-1", "ev-token-pair-only", "ev-provider-2", "ev-token-bad", "ev-gate-unreadable", "ev-timing-unreadable"]);
  });

  test("the text dump prints turn headers and gutters their members; run-level rows carry the plain pad", () => {
    const text = formatDigText(digLedger(openLedgerReadOnly(ledgerPath), { kind: "run", id: RUN }), "none");
    const lines = text.split("\n");
    const headerIdx = lines.findIndex((l) => l === `turn ${TURN_1}`);
    expect(headerIdx).toBeGreaterThan(-1);
    // The first member line under the header carries the turn gutter and
    // that turn's first event.
    expect(lines[headerIdx + 1]).toMatch(/^  │ /u);
    expect(lines[headerIdx + 1]).toContain("assistant turn started");
    // A run-level row (before any turn header) carries the plain pad — the
    // gutter is the only thing that differs, so the columns stay aligned.
    const runStartIdx = lines.findIndex((l) => l.includes("run started"));
    expect(runStartIdx).toBeGreaterThan(-1);
    expect(lines[runStartIdx]!.startsWith("    ")).toBe(true);
    expect(lines[runStartIdx]!).not.toMatch(/^  │ /u);
  });
});

describe("C. document selection — the payload views print what the ledger holds", () => {
  const provider = () => digEvents.find((e) => e.eventId === "ev-provider-1")!;

  test("the llm view keeps exactly the provider payloads and the redacted args", () => {
    const names = selectDocuments(provider(), "llm").map((d) => d.name);
    expect(names.sort()).toEqual(
      [TIMELINE_LLM_REQUEST_DOCUMENT, TIMELINE_LLM_RESPONSE_DOCUMENT, TIMELINE_EFFECT_ARGS_DOCUMENT].sort(),
    );
  });

  test("the llm view omits the timing and usage documents", () => {
    const names = selectDocuments(provider(), "llm").map((d) => d.name);
    // WITNESS: a document the llm view KEEPS, asserted present — the absence
    // claims below only mean something over a list proven to be the real
    // one (an instrument pointed at nothing would also return "absent").
    expect(names).toContain(TIMELINE_LLM_REQUEST_DOCUMENT);
    expect(names).not.toContain(TIMELINE_EFFECT_TIMING_DOCUMENT);
    expect(names).not.toContain(TIMELINE_TOKEN_USAGE_DOCUMENT);
  });

  test("the all view is name-agnostic: a document type the reader was never told about still shows", () => {
    const dbEvent = digEvents.find((e) => e.eventId === "ev-db-1")!;
    const names = selectDocuments(dbEvent, "all").map((d) => d.name);
    // The expected set is derived from what the fixture wrote — no restated
    // list. The unlisted document is the mutation arm: a fixed-name filter
    // in the all view drops it and this line fails.
    expect(names).toEqual(dbEvent.documents.map((d) => d.name));
    expect(names).toContain("future-doc");
  });

  test("the none view prints no documents", () => {
    expect(selectDocuments(provider(), "none")).toEqual([]);
  });

  test("the text dump prints document bodies verbatim under their event", () => {
    const text = formatDigText(digLedger(openLedgerReadOnly(ledgerPath), { kind: "run", id: RUN }), "llm");
    expect(text).toContain("document llm-request");
    expect(text).toContain('"write the file"');
    expect(text).toContain("document llm-response");
    expect(text).toContain('"on it"');
    // The timing document is not part of the llm view.
    expect(text).not.toContain("document effect-timing");
  });

  // THE UNPARSEABLE-TIMING CATCH, exercised by a real row: an effect-timing
  // document whose duration is not a number takes the honest fallback — the
  // `took` cell renders the absence mark, never an invented zero and never a
  // crash — while the SAME dump's readable timings keep their measured
  // numbers (the witness that makes the absence mean something).
  test("an unparseable effect-timing document renders the took cell as the honest absence", () => {
    const text = formatDigText(digLedger(openLedgerReadOnly(ledgerPath), { kind: "run", id: RUN }), "all");
    const lines = text.split("\n");
    const unreadable = lines.find((l) => l.includes("db:getChatMessages"))!;
    expect(unreadable).toMatch(/succeeded\s+—\s+db:getChatMessages/u);
    const readable = lines.find((l) => l.includes("db:getProjectByPath"))!;
    expect(readable).toMatch(/13ms/u);
    expect(readable).not.toMatch(/—\s+db:getProjectByPath/u);
  });
});

describe("D. summary — the header counts come from the matched events only", () => {
  const summary = () => digLedger(openLedgerReadOnly(ledgerPath), { kind: "run", id: RUN }).summary;

  test("event count, wall span and duration", () => {
    const s = summary();
    expect(s.events).toBe(16);
    expect(s.firstWallTime).toBe(AT(1));
    expect(s.lastWallTime).toBe(AT(13));
    expect(s.durationMs).toBe(12 * 60 * 1_000);
  });

  test("llm calls and token sums — only decodable usage documents count", () => {
    const s = summary();
    expect(s.llmCalls).toBe(2);
    // 100 + the pair-only boundary document's 37 (its total is DERIVED as 45,
    // never counted unparsed — the drift case this test pins on the dig side).
    expect(s.promptTokens).toBe(137);
    expect(s.completionTokens).toBe(13);
    expect(s.unparsedUsageDocuments).toBe(1);
  });

  test("tool groups carry per-outcome tallies by recorded description", () => {
    const s = summary();
    expect(s.tools).toEqual([
      { description: "tool:edit", total: 1, byOutcome: { succeeded: 1 } },
      { description: "tool:mcp__filesystem__write_file", total: 1, byOutcome: { failed: 1 } },
    ]);
  });

  test("the error list shows error detail whatever the outcome — the thrown-4xx shape included", () => {
    const s = summary();
    expect(s.errors).toEqual([
      { sequence: "4", description: "http:GET /api/chats", outcome: "succeeded", category: "http", code: "missing_query" },
      { sequence: "6", description: "tool:mcp__filesystem__write_file", outcome: "failed", category: "tool", code: "tool_gate_schema_mismatch" },
    ]);
  });
});

describe("E. the failure filter reads the outcome, never error-field presence", () => {
  test("--failed keeps failed and denied outcomes only", () => {
    const result = digLedger(openLedgerReadOnly(ledgerPath), { kind: "run", id: RUN }, { failedOnly: true });
    expect(result.events.map((e) => e.eventId)).toEqual(["ev-tool-failed", "ev-gate-error"]);
  });

  test("an event with error fields on a succeeded outcome is NOT a failure", () => {
    const result = digLedger(openLedgerReadOnly(ledgerPath), { kind: "run", id: RUN }, { failedOnly: true });
    expect(result.events.map((e) => e.eventId)).not.toContain("ev-http-4xx");
  });
});

describe("F. honest refusals and path resolution", () => {
  test("a missing ledger is refused with the reason, not a SQLite code dump", () => {
    expect(() => openLedgerReadOnly(join(createTempDir("ledger-dig-none-"), "absent.db"))).toThrow(
      /timeline ledger not found/u,
    );
  });

  test("a relative configured path is anchored; an absolute path passes through", () => {
    expect(resolveLedgerPath(".bridlewise/timeline.db", "/repo")).toBe("/repo/.bridlewise/timeline.db");
    expect(resolveLedgerPath("/var/data/timeline.db", "/repo")).toBe("/var/data/timeline.db");
  });
});

describe("the machine-readable dump", () => {
  test("--json round-trips the full result with the selected documents", () => {
    const view: DigDocumentView = "all";
    const parsed = JSON.parse(
      formatDigJson(digLedger(openLedgerReadOnly(ledgerPath), { kind: "run", id: RUN }), view),
    ) as {
      summary: { events: number; llmCalls: number };
      events: { eventId: string; documents: { name: string }[] }[];
    };
    expect(parsed.summary.events).toBe(16);
    expect(parsed.summary.llmCalls).toBe(2);
    expect(parsed.events).toHaveLength(16);
    const dbEvent = parsed.events.find((e) => e.eventId === "ev-db-1")!;
    expect(dbEvent.documents.map((d) => d.name)).toContain("future-doc");
  });

  test("the json dump honours the llm view like the text dump", () => {
    const parsed = JSON.parse(
      formatDigJson(digLedger(openLedgerReadOnly(ledgerPath), { kind: "run", id: RUN }), "llm"),
    ) as { events: { documents: { name: string }[] }[] };
    const names = parsed.events.flatMap((e) => e.documents.map((d) => d.name));
    expect(names).not.toContain(TIMELINE_EFFECT_TIMING_DOCUMENT);
    expect(names).toContain(TIMELINE_LLM_REQUEST_DOCUMENT);
    expect(names).toContain(TIMELINE_LLM_RESPONSE_DOCUMENT);
  });
});

// ── G. runs aggregation — one line per run over the real ledger ─────────────

describe("G. runs — the per-run rollup", () => {
  test("rolls up every run newest first, with counts, outcomes, failures and tokens", () => {
    const result = listRuns(openLedgerReadOnly(ledgerPath));
    expect(result.sessionId).toBeNull();
    expect(result.runIds).toBeNull();
    expect(result.scopeMatched).toBe(true);
    expect(result.runs.map((r) => r.runId)).toEqual([OTHER_RUN, RUN]);
    const run = result.runs.find((r) => r.runId === RUN)!;
    expect(run.sessionId).toBe(CHAT_A);
    expect(run.events).toBe(16);
    expect(run.firstWallTime).toBe(AT(1));
    expect(run.lastWallTime).toBe(AT(13));
    expect(run.durationMs).toBe(12 * 60 * 1_000);
    expect(run.llmCalls).toBe(2);
    expect(run.promptTokens).toBe(137);
    expect(run.completionTokens).toBe(13);
    expect(run.unparsedUsageDocuments).toBe(1);
    // The outcome rollup is dynamic over the recorded outcomes — the
    // unrecorded ones simply do not appear. Six of the run's sixteen
    // events carry no verdict (lifecycle and token rows) and show as "—".
    expect(run.byOutcome).toEqual({ "—": 6, succeeded: 8, failed: 1, denied: 1 });
    expect(run.failures).toBe(2);
    expect(run.toolFailures).toEqual([{ description: "tool:mcp__filesystem__write_file", count: 1 }]);
    const other = result.runs.find((r) => r.runId === OTHER_RUN)!;
    expect(other.events).toBe(2);
    expect(other.sessionId).toBe(CHAT_B);
    expect(other.failures).toBe(0);
    expect(other.llmCalls).toBe(0);
  });

  test("--failed keeps only runs with failures; --last keeps the newest N; --session scopes by the ledger's session column", () => {
    const db = openLedgerReadOnly(ledgerPath);
    expect(listRuns(db, { failedOnly: true }).runs.map((r) => r.runId)).toEqual([RUN]);
    expect(listRuns(db, { last: 1 }).runs.map((r) => r.runId)).toEqual([OTHER_RUN]);
    expect(listRuns(db, { sessionId: CHAT_A }).runs.map((r) => r.runId)).toEqual([RUN]);
    expect(listRuns(db, { sessionId: CHAT_B }).runs.map((r) => r.runId)).toEqual([OTHER_RUN]);
    expect(listRuns(db, { sessionId: CHAT_A }).sessionId).toBe(CHAT_A);
    // A session that matches nothing: the SCOPE is absent — the caller must
    // fix the id, not read an empty list as "no runs today".
    const bogus = listRuns(db, { sessionId: "no-such-session" });
    expect(bogus.scopeMatched).toBe(false);
    expect(bogus.runs).toEqual([]);
    expect(formatRunsText(bogus, false)).toContain("runs — no runs for session no-such-session");
    db.close();
  });

  // ── THE --chat SEAM (UIE-029). The ledger holds NO chat id — its
  // session_id column is the harness web session, not a chat — so a chat
  // reaches this reader ONLY as the run-id set the CLI resolves from the
  // web db's messages.run_id. These arms pin that scope's honest behavior;
  // the resolution itself (the db owner's CHAT_RUN_IDS_SQL) is pinned in
  // its own suite.
  test("a run-id scope (what --chat resolves to) keeps exactly those runs, echoed, with every rollup folded", () => {
    const db = openLedgerReadOnly(ledgerPath);
    const scoped = listRuns(db, { runIds: [RUN] });
    expect(scoped.runIds).toEqual([RUN]);
    expect(scoped.sessionId).toBeNull();
    expect(scoped.scopeMatched).toBe(true);
    expect(scoped.runs.map((r) => r.runId)).toEqual([RUN]);
    // The per-run folding crossed the scope: counts, outcomes and tokens are
    // the run's own, not the whole ledger's.
    expect(scoped.runs[0]!.events).toBe(16);
    expect(scoped.runs[0]!.failures).toBe(2);
    expect(scoped.runs[0]!.promptTokens).toBe(137);
    // A run-id set naming ids the ledger holds none of is ABSENT, not an
    // all-runs fallback and not a quiet empty list.
    const rotated = listRuns(db, { runIds: ["run-that-rotated-away"] });
    expect(rotated.scopeMatched).toBe(false);
    expect(rotated.runs).toEqual([]);
    db.close();
  });

  test("an EMPTY run-id scope (a chat whose messages recorded no run) matches nothing and says so", () => {
    const db = openLedgerReadOnly(ledgerPath);
    const empty = listRuns(db, { runIds: [] });
    expect(empty.scopeMatched).toBe(false);
    expect(empty.runs).toEqual([]);
    expect(formatRunsText(empty, false))
      .toContain("runs — the chat resolved to no runs (no message ever recorded one)");
    db.close();
  });

  test("the text dump is one line per run naming span, outcomes, failed tools and chat", () => {
    const result = listRuns(openLedgerReadOnly(ledgerPath), { failedOnly: true });
    const text = formatRunsText(result, true);
    expect(text).toContain("runs — 1 run(s) with failures, newest first");
    expect(text).toContain(RUN);
    expect(text).toContain("16 events");
    expect(text).toContain("succeeded 8");
    expect(text).toContain("failed tools: tool:mcp__filesystem__write_file ×1");
    expect(text).toContain(`session ${CHAT_A}`);
  });

  // THE TABLE-QUALIFIED CHAT PREDICATE. The usage query JOINs
  // event_documents; a future `session_id` column on THAT table would make a
  // bare `session_id` in the shared chat fragment ambiguous and turn every
  // chat-scoped rollup into an SQLite error the day the schema grows. This
  // arm adds exactly that column to the real fixture and proves the rollup
  // still answers — the fragment's `e.session_id` cannot become ambiguous.
  // (Mutation: reverting the qualification reds this arm with SQLite's
  // "ambiguous column name" — the hazard, caught as behavior.)
  test("a future session_id column on event_documents cannot make the chat predicate ambiguous", () => {
    const dir = createTempDir("ledger-dig-ambig-");
    const path = join(dir, "timeline.db");
    const store = createTimelineStore({ path, ledgerId: `${LEDGER_ID}-ambig` });
    store.appendEvent({
      eventId: "ev-ambig-1", ledgerId: `${LEDGER_ID}-ambig`, eventType: "run",
      actor: { kind: "user", id: "u-dig" }, description: "run started",
      wallTime: AT(1), correlation: { runId: "run-ambig", sessionId: CHAT_A },
      documents: [doc("usage", '{"promptTokens":5,"completionTokens":2,"totalTokens":7}')],
    });
    store.appendEvent({
      eventId: "ev-ambig-2", ledgerId: `${LEDGER_ID}-ambig`, eventType: "run",
      actor: { kind: "user", id: "u-dig" }, description: "run started",
      wallTime: AT(2), correlation: { runId: "run-ambig-2", sessionId: CHAT_B },
    });
    store.close();
    // Grow event_documents the way a future migration would: a session_id
    // column. Populating it is unnecessary AND refused (the ledger is
    // append-only) — SQLite resolves column names at PREPARE time, so the
    // column's mere existence is the hazard: an unqualified `session_id`
    // inside the JOIN fails to prepare, rows or not.
    const rw = new DatabaseSync(path);
    try {
      rw.exec("ALTER TABLE event_documents ADD COLUMN session_id TEXT");
    } finally {
      rw.close();
    }
    const db = openLedgerReadOnly(path);
    try {
      const scoped = listRuns(db, { sessionId: CHAT_A });
      expect(scoped.scopeMatched).toBe(true);
      expect(scoped.runs.map((r) => r.runId)).toEqual(["run-ambig"]);
      // The usage fold crossed the populated join and still landed: the
      // chat's own row counted its decodable usage document.
      expect(scoped.runs[0]!.promptTokens).toBe(5);
      expect(scoped.runs[0]!.completionTokens).toBe(2);
      const other = listRuns(db, { sessionId: CHAT_B });
      expect(other.runs.map((r) => r.runId)).toEqual(["run-ambig-2"]);
    } finally {
      db.close();
    }
  });

  test("an empty ledger is an honest empty list, not an absence", () => {
    const result = listRuns(openLedgerReadOnly(emptyLedgerPath));
    expect(result.scopeMatched).toBe(true);
    expect(result.runs).toEqual([]);
    expect(formatRunsText(result, false)).toContain("runs — no runs in the ledger");
    expect(formatRunsText(listRuns(openLedgerReadOnly(emptyLedgerPath), { failedOnly: true }), true))
      .toContain("no run in the ledger has failed or denied events");
  });
});

// ── H. doctor — the one-shot diagnostic ──────────────────────────────────────

describe("H. doctor — the newest failed run, collapsed", () => {
  test("picks the newest run WITH failures over the newer clean run, and collapses its answer", () => {
    const result = doctorLedger(openLedgerReadOnly(ledgerPath));
    // OTHER_RUN is the newest run but has no failure — the doctor must skip
    // it and name RUN, the newest run that has something to diagnose.
    expect(result.verdict).toBe("failed-run");
    expect(result.runId).toBe(RUN);
    expect(result.summary?.events).toBe(16);
    expect(result.summary?.llmCalls).toBe(2);
    expect(result.failed.map((e) => e.eventId)).toEqual(["ev-tool-failed", "ev-gate-error"]);
    expect(result.gateBlocks).toEqual([
      { sequence: "6", toolName: "mcp__filesystem__write_file", kind: "schema_mismatch", failedFields: ["path", "content"], escalated: true },
      // THE UNREADABLE-DOCUMENT CATCH, exercised by a real row: a gate-block
      // document that does not parse rides in as the honest verdict — the
      // recorded fields are absent ("—", none, not escalated), never
      // silently dropped and never guessed from the prose.
      { sequence: "15", toolName: "—", kind: "unreadable", failedFields: [], escalated: false },
    ]);
    // The provider payloads only — the collapsed third move, not every
    // event that carries an args document.
    expect(result.llmPayloads.map((p) => p.event.eventId)).toEqual(["ev-provider-1", "ev-provider-2"]);
    for (const payload of result.llmPayloads) {
      expect(payload.documents.map((d) => d.name)).toContain(TIMELINE_LLM_REQUEST_DOCUMENT);
    }
  });

  test("the text dump names the run, its failed events, its gate-block fields and its payloads", () => {
    const text = formatDoctorText(doctorLedger(openLedgerReadOnly(ledgerPath)));
    expect(text).toContain("doctor — the newest run with failures");
    expect(text).toContain(`run ${RUN}`);
    expect(text).toContain("failed events — 2");
    expect(text).toContain("tool:mcp__filesystem__write_file");
    expect(text).toContain("gate blocks — 2");
    expect(text).toContain("failed fields: path, content");
    expect(text).toContain("escalated");
    // The unreadable gate-block verdict is ON the answer, in plain words.
    expect(text).toContain("unreadable");
    expect(text).toContain("no failed fields recorded");
    expect(text).toContain("llm payloads — 2 event(s)");
    expect(text).toContain("document llm-request");
  });

  test("a session whose runs are all clean gets the newest-run verdict; a session with no runs gets the honest none", () => {
    const db = openLedgerReadOnly(ledgerPath);
    const clean = doctorLedger(db, { sessionId: CHAT_B });
    expect(clean.verdict).toBe("newest-run");
    expect(clean.runId).toBe(OTHER_RUN);
    expect(clean.sessionId).toBe(CHAT_B);
    expect(clean.failed).toEqual([]);
    expect(formatDoctorText(clean)).toContain("no run has failures; the newest run");
    const absent = doctorLedger(db, { sessionId: "no-such-session" });
    expect(absent.verdict).toBe("none");
    expect(absent.scopeMatched).toBe(false);
    expect(formatDoctorText(absent)).toContain("doctor — no runs for session no-such-session, nothing to diagnose");
    db.close();
  });

  test("a run-id scope (what --chat resolves to) carries the absent-vs-empty seam into the doctor", () => {
    const db = openLedgerReadOnly(ledgerPath);
    // The scope's own runs: the doctor picks among them, exactly as a
    // session scope does.
    const scoped = doctorLedger(db, { runIds: [RUN, OTHER_RUN] });
    expect(scoped.verdict).toBe("failed-run");
    expect(scoped.runId).toBe(RUN);
    expect(scoped.runIds).toEqual([RUN, OTHER_RUN]);
    // An empty resolved set: the chat is absent, and the doctor says so in
    // plain words — the caller must fix the id, not read "nothing to
    // diagnose" as a clean bill of health.
    const empty = doctorLedger(db, { runIds: [] });
    expect(empty.verdict).toBe("none");
    expect(empty.scopeMatched).toBe(false);
    expect(formatDoctorText(empty)).toContain("doctor — the chat resolved to no runs, nothing to diagnose");
    db.close();
  });

  test("a ledger with no run at all gets the honest none verdict — nothing to diagnose is an answer", () => {
    const result = doctorLedger(openLedgerReadOnly(emptyLedgerPath));
    expect(result.verdict).toBe("none");
    expect(result.scopeMatched).toBe(true);
    expect(result.runId).toBeNull();
    expect(result.summary).toBeNull();
    expect(formatDoctorText(result)).toContain("doctor — no runs in the ledger, nothing to diagnose");
  });
});

// ── I. wall-time bounds — --since/--until on the event time ──────────────────

describe("I. --since/--until — wall-clock bounds", () => {
  test("the resolver normalizes ISO-8601 and resolves relative durations against the given now", () => {
    expect(resolveWallTimeBound("2026-08-30")).toBe("2026-08-30T00:00:00.000Z");
    expect(resolveWallTimeBound("2026-08-30T00:07:00Z")).toBe("2026-08-30T00:07:00.000Z");
    const now = new Date("2026-08-30T00:20:00.000Z");
    expect(resolveWallTimeBound("45m", now)).toBe("2026-08-29T23:35:00.000Z");
    expect(resolveWallTimeBound("1h30m", now)).toBe("2026-08-29T22:50:00.000Z");
    expect(resolveWallTimeBound("3d", now)).toBe("2026-08-27T00:20:00.000Z");
    expect(resolveWallTimeBound("30s", now)).toBe("2026-08-30T00:19:30.000Z");
  });

  test("an unparseable bound is a typed refusal that names the grammar", () => {
    expect(() => resolveWallTimeBound("2x")).toThrowError(InputError);
    expect(() => resolveWallTimeBound("2x")).toThrowError(/relative duration/u);
    try {
      resolveWallTimeBound("yesterday-ish");
      expect.unreachable("the resolver must refuse an unparseable bound");
    } catch (err) {
      expect(err).toBeInstanceOf(InputError);
      expect((err as InputError).code).toBe("timeline_dig_time_bound_invalid");
    }
  });

  test("--since keeps events at or after the bound, inclusive at the edge", () => {
    const db = openLedgerReadOnly(ledgerPath);
    const fromSeven = digLedger(db, { kind: "run", id: RUN }, { sinceWallTime: AT(7) });
    expect(fromSeven.events.map((e) => e.eventId)).toEqual([
      "ev-gate-error", "ev-tool-ok", "ev-turn-2", "ev-provider-1", "ev-token-1", "ev-token-pair-only", "ev-provider-2", "ev-token-bad",
      "ev-gate-unreadable", "ev-timing-unreadable",
    ]);
    // Inclusive: the bound naming an event's own wall time keeps it.
    const fromSix = digLedger(db, { kind: "run", id: RUN }, { sinceWallTime: AT(6) });
    expect(fromSix.events[0]!.eventId).toBe("ev-tool-failed");
    db.close();
  });

  test("--until keeps events at or before the bound, and the pair narrows a window", () => {
    const db = openLedgerReadOnly(ledgerPath);
    const untilSix = digLedger(db, { kind: "run", id: RUN }, { untilWallTime: AT(6) });
    expect(untilSix.events.map((e) => e.eventId)).toEqual([
      "ev-run-start", "ev-db-1", "ev-http-1", "ev-http-4xx", "ev-turn-1", "ev-tool-failed",
    ]);
    const window = digLedger(db, { kind: "run", id: RUN }, { sinceWallTime: AT(7), untilWallTime: AT(11) });
    expect(window.events.map((e) => e.eventId)).toEqual([
      "ev-gate-error", "ev-tool-ok", "ev-turn-2", "ev-provider-1", "ev-token-1", "ev-token-pair-only",
    ]);
    db.close();
  });

  test("a relative bound integrates: until 10m before a fixed now cuts the tail window", () => {
    const db = openLedgerReadOnly(ledgerPath);
    const until = resolveWallTimeBound("10m", new Date("2026-08-30T00:20:00.000Z"));
    const result = digLedger(db, { kind: "tail", limit: 50 }, { untilWallTime: until });
    // Every event at or before AT(10) — the resource rows excluded by the
    // tail's default scan stay excluded under the bound too.
    expect(result.events.map((e) => e.eventId)).toContain("ev-turn-2");
    expect(result.events.map((e) => e.eventId)).not.toContain("ev-provider-2");
    expect(result.events.every((e) => e.wallTime <= until)).toBe(true);
    db.close();
  });
});

// ── J. event-type validation + the tail's resource hygiene ──────────────────

describe("J. --event-type validation + tail resource hygiene", () => {
  test("an unknown event type is a typed refusal listing the recorded vocabulary", () => {
    try {
      resolveEventTypeFilter("resourc");
      expect.unreachable("the resolver must refuse an unknown event type");
    } catch (err) {
      expect(err).toBeInstanceOf(InputError);
      expect((err as InputError).code).toBe("timeline_dig_event_type_invalid");
      // The message teaches the vocabulary, not just the refusal.
      expect((err as Error).message).toContain("resourc");
      for (const known of ["run", "turn", "tool", "provider", "resource", "db", "ledger"]) {
        expect((err as Error).message).toContain(known);
      }
    }
  });

  test("the match is case-insensitive and answers the registry's canonical spelling", () => {
    expect(resolveEventTypeFilter("TOOL")).toBe("tool");
    expect(resolveEventTypeFilter("Provider")).toBe("provider");
    // The resource lane IS a valid type — excluded from the tail's default
    // scan by hygiene, never by invalidity.
    expect(resolveEventTypeFilter("RESOURCE")).toBe("resource");
  });

  test("the tail's default scan excludes the sampler's resource rows", () => {
    const db = openLedgerReadOnly(ledgerPath);
    const result = digLedger(db, { kind: "tail", limit: 50 });
    expect(result.events.length).toBe(19);
    expect(result.events.filter((e) => e.eventType === "resource")).toEqual([]);
    db.close();
  });

  test("--all-types opts the resource lane back in, and an explicit --event-type resource returns it", () => {
    const db = openLedgerReadOnly(ledgerPath);
    const all = digLedger(db, { kind: "tail", limit: 50 }, { allEventTypes: true });
    expect(all.events.length).toBe(22);
    expect(new Set(all.events.filter((e) => e.eventType === "resource").map((e) => e.eventId)))
      .toEqual(new Set([...RESOURCE_EVENTS]));
    const onlyResource = digLedger(db, { kind: "tail", limit: 50 }, { eventType: resolveEventTypeFilter("RESOURCE") });
    expect(new Set(onlyResource.events.map((e) => e.eventId))).toEqual(new Set([...RESOURCE_EVENTS]));
    db.close();
  });

  test("the run replay keeps the resource lane out of its own run's scope only because it is not that run's — no hygiene rule hides run rows", () => {
    // A run replay is complete by design: the fixture's resource rows carry
    // no run, so the run dig never sees them for the honest reason.
    const db = openLedgerReadOnly(ledgerPath);
    const run = digLedger(db, { kind: "run", id: RUN }, { allEventTypes: true });
    expect(run.events.every((e) => e.runId === RUN)).toBe(true);
    expect(run.events).toHaveLength(16);
    db.close();
  });
});

// ── K. absent vs empty — the exit verdict and the shell's mapping ────────────

describe("K. absent vs empty — the verdict is pure, the shell maps it to exit codes", () => {
  test("a run/trace id matching nothing is absent; a filter matching nothing in a real scope is empty", () => {
    const db = openLedgerReadOnly(ledgerPath);
    expect(digExitVerdict(digLedger(db, { kind: "run", id: "run-does-not-exist" }))).toBe("absent");
    expect(digExitVerdict(digLedger(db, { kind: "trace", id: "trace-does-not-exist" }))).toBe("absent");
    expect(digLedger(db, { kind: "run", id: "run-does-not-exist" }).scopeMatched).toBe(false);
    // The scope exists; the bound matches nothing inside it.
    const empty = digLedger(db, { kind: "run", id: RUN }, { sinceWallTime: "2099-01-01T00:00:00.000Z" });
    expect(empty.scopeMatched).toBe(true);
    expect(digExitVerdict(empty)).toBe("empty");
    // A populated dig is ok, and the tail is never absent — it names no id.
    expect(digExitVerdict(digLedger(db, { kind: "run", id: RUN }))).toBe("ok");
    expect(digLedger(openLedgerReadOnly(emptyLedgerPath), { kind: "tail", limit: 3 }).scopeMatched).toBe(true);
    db.close();
  });

  // The shell resolves its ledger path from the server config owner at
  // import time, so the mapping is pinned through the real CLI as a
  // subprocess with the config owner's env override pointing at the
  // fixture — the exit status IS the contract under test.
  const runCli = (args: readonly string[]): { status: number; stdout: string; stderr: string } => {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", TRACE_TS, ...args], {
      encoding: "utf8",
      // Both dbs controlled: the ledger at the store-built fixture, the web
      // db at the minimal messages fixture — the `--chat` seam never touches
      // this machine's real web db.
      env: { ...process.env, HARNESS_WEB_TIMELINE_DB_PATH: ledgerPath, HARNESS_WEB_DB_PATH: webDbPath },
      timeout: 60_000,
    });
    return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };

  test("an absent run id exits 1 with one honest stderr line; an empty scope exits 0 with the honest dump", { timeout: 60_000 }, () => {
    const absent = runCli(["run", "run-does-not-exist"]);
    expect(absent.status, `stderr: ${absent.stderr}`).toBe(1);
    expect(absent.stderr).toContain(`no run with id run-does-not-exist in the ledger`);
    const empty = runCli(["run", RUN, "--since", "2099-01-01"]);
    expect(empty.status, `stderr: ${empty.stderr}`).toBe(0);
    expect(empty.stdout).toContain(`run ${RUN}`);
    expect(empty.stdout).toContain("no events");
    const ok = runCli(["run", RUN, "--failed"]);
    expect(ok.status).toBe(0);
    // The dump prints each event's DESCRIPTION (the failed tool's name and
    // the refusal prose), never its internal event id.
    expect(ok.stdout).toContain("tool:mcp__filesystem__write_file");
    expect(ok.stdout).toContain("arguments failed schema validation");
  });

  test("an invalid event type exits 1 naming the vocabulary; a chat resolves through the web db; absent scopes exit 1", { timeout: 120_000 }, () => {
    const invalid = runCli(["tail", "3", "--event-type", "resourc"]);
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain("unknown event type 'resourc'");
    expect(invalid.stderr).toContain("resource");
    // THE --chat SEAM, END TO END: the chat resolves to its run ids through
    // the web db's messages.run_id (duplicates, NULLs and empty strings
    // collapse away), and the rollup answers with exactly those runs.
    const live = runCli(["runs", "--chat", "chat-live"]);
    expect(live.status, `stderr: ${live.stderr}`).toBe(0);
    expect(live.stdout).toContain(RUN);
    expect(live.stdout).not.toContain(OTHER_RUN);
    // A chat whose messages recorded NO run id: ABSENT, exit 1 — never an
    // all-runs fallback, never a quiet empty list.
    const emptyChat = runCli(["runs", "--chat", "chat-empty"]);
    expect(emptyChat.status).toBe(1);
    expect(emptyChat.stderr).toContain("no runs recorded for chat chat-empty");
    // A chat that resolves, but to a run the ledger does not hold (a rotated
    // ledger): still absent, still one honest line.
    const ghost = runCli(["runs", "--chat", "chat-ghost"]);
    expect(ghost.status).toBe(1);
    expect(ghost.stderr).toContain("no runs for chat chat-ghost in the ledger");
    // The same absent-vs-empty seam through the doctor.
    const doctorAbsent = runCli(["doctor", "--chat", "chat-empty"]);
    expect(doctorAbsent.status).toBe(1);
    expect(doctorAbsent.stderr).toContain("no runs recorded for chat chat-empty");
    // An absent SESSION id (the ledger's own scope) is absent too.
    const absentSession = runCli(["runs", "--session", "no-such-session"]);
    expect(absentSession.status).toBe(1);
    expect(absentSession.stderr).toContain("no runs for session no-such-session in the ledger");
  });

  test("nothing to diagnose is an ANSWER, not an error — doctor's honest none keeps exit 0", { timeout: 60_000 }, () => {
    // The none verdict that exits 0 is the NO-SCOPE one (or a matched scope
    // with nothing failing — but then the verdict is newest-run). An empty
    // LEDGER with no scope given is the clean case.
    const result = spawnSync(process.execPath, ["--experimental-strip-types", TRACE_TS, "doctor"], {
      encoding: "utf8",
      env: { ...process.env, HARNESS_WEB_TIMELINE_DB_PATH: emptyLedgerPath },
      timeout: 60_000,
    });
    expect(result.status, `stderr: ${result.stderr ?? ""}`).toBe(0);
    expect(result.stdout ?? "").toContain("doctor — no runs in the ledger, nothing to diagnose");
  });

  test("runs and doctor answer over the fixture and --schema prints a parseable contract", { timeout: 60_000 }, () => {
    const runs = runCli(["runs", "--failed"]);
    expect(runs.status, `stderr: ${runs.stderr}`).toBe(0);
    expect(runs.stdout).toContain(RUN);
    expect(runs.stdout).toContain("failed tools: tool:mcp__filesystem__write_file ×1");
    const doctor = runCli(["doctor"]);
    expect(doctor.status, `stderr: ${doctor.stderr}`).toBe(0);
    expect(doctor.stdout).toContain(`run ${RUN}`);
    const schema = runCli(["--schema"]);
    expect(schema.status).toBe(0);
    expect(() => JSON.parse(schema.stdout)).not.toThrow();
  });
});

// ── L. follow batches — the pure new-rows rule ─────────────────────────────

describe("L. tail --follow's new-rows computation (pure — the loop is not tested)", () => {
  const ev = (id: string, sequence: string): DigEvent => ({
    eventId: id, sequence, wallTime: "2026-08-31T00:00:00.000Z", eventType: "db",
    outcome: null, traceId: null, runId: null, turnId: null, spanId: null,
    description: id, errorCategory: null, errorCode: null, errorMessage: null, documents: [],
  });

  test("after a last-seen sequence, only newer rows are new — in causal order, with the cursor advanced", () => {
    // The window arrives newest-first, the tail's own order.
    const window = [ev("c", "23"), ev("b", "22"), ev("a", "21")];
    const next = nextFollowBatch(window, "21");
    expect(next.batch.map((e) => e.eventId)).toEqual(["b", "c"]);
    expect(next.lastSeenSequence).toBe("23");
  });

  test("a null cursor (the first poll establishing the baseline) takes the whole window", () => {
    const window = [ev("c", "23"), ev("b", "22"), ev("a", "21")];
    const next = nextFollowBatch(window, null);
    expect(next.batch.map((e) => e.eventId)).toEqual(["a", "b", "c"]);
    expect(next.lastSeenSequence).toBe("23");
  });

  test("an idle window changes nothing — the batch is empty and the cursor never regresses", () => {
    const window = [ev("c", "23"), ev("b", "22"), ev("a", "21")];
    const next = nextFollowBatch(window, "23");
    expect(next.batch).toEqual([]);
    expect(next.lastSeenSequence).toBe("23");
    // A window that has somehow lost its newest row (a bounded fetch after
    // a compaction) must not drag the cursor backwards.
    const stale = nextFollowBatch([ev("a", "21")], "23");
    expect(stale.batch).toEqual([]);
    expect(stale.lastSeenSequence).toBe("23");
  });

  test("the first batch's cursor is the baseline the follow carries forward", () => {
    // The tail's own first print is the follow's baseline: its newest row
    // becomes the last-seen sequence the first poll compares against.
    const first = digLedger(openLedgerReadOnly(ledgerPath), { kind: "tail", limit: 3 });
    const baseline = nextFollowBatch(first.events, null);
    expect(baseline.lastSeenSequence).toBe(first.events[0]!.sequence);
    expect(baseline.batch.map((e) => e.eventId)).toEqual(
      [...first.events.map((e) => e.eventId)].reverse(),
    );
  });
});

// ── M. the --schema contract — the table cannot drift from the real output ──

describe("M. --schema — the printed contract matches every command's real --json output", () => {
  /** Walk one actual value against its declared field, both directions:
   * every emitted key is declared, every declared non-optional key is
   * present, types agree, and null only appears where nullable. */
  const expectMatchesSchema = (actual: unknown, field: DigSchemaField, path: string): void => {
    if (actual === null) {
      expect(field.nullable === true, `${path} is null but the contract does not mark it nullable`).toBe(true);
      return;
    }
    if (field.type === "array") {
      expect(Array.isArray(actual), `${path} should be an array, got ${typeof actual}`).toBe(true);
      for (const [i, item] of (actual as unknown[]).entries()) {
        expect(field.items, `${path}[${i}] has no declared element contract`).toBeDefined();
        expectMatchesSchema(item, field.items!, `${path}[${i}]`);
      }
      return;
    }
    if (field.type === "object") {
      expect(typeof actual === "object" && !Array.isArray(actual), `${path} should be an object`).toBe(true);
      const record = actual as Record<string, unknown>;
      if (field.fields !== undefined) {
        for (const key of Object.keys(record)) {
          expect(field.fields[key], `${path}.${key} is emitted but not declared in the contract`).toBeDefined();
        }
        for (const [key, sub] of Object.entries(field.fields)) {
          if (key in record) {
            expectMatchesSchema(record[key], sub, `${path}.${key}`);
          } else {
            expect(sub.optional === true, `${path}.${key} is declared required but missing on a non-empty result`).toBe(true);
          }
        }
      } else {
        // CLOSE THE POCKET: an object the contract does NOT spell out walks no
        // deeper than "it is an object" — its inner keys could change shape
        // silently. Such a field must carry a note saying where its shape IS
        // pinned (a record with a documented value type, a shape owned by
        // another suite), so the walk is honest about what it is not
        // checking. An opaque object field with neither inner fields nor a
        // note is an undeclared contract, not a documented one.
        expect(
          typeof field.note === "string" && field.note.length > 0,
          `${path} is an object the contract spells no inner fields for and documents no note — declare its fields or say where its shape is pinned`,
        ).toBe(true);
      }
      return;
    }
    expect(typeof actual === field.type, `${path} should be ${field.type}, got ${typeof actual}`).toBe(true);
  };

  test("the dig, runs and doctor json outputs walk their declared contracts cleanly", () => {
    const db = openLedgerReadOnly(ledgerPath);
    const dig = JSON.parse(formatDigJson(digLedger(db, { kind: "run", id: RUN }), "all"));
    expectMatchesSchema(dig, DIG_JSON_SCHEMA["run | trace | tail"]!, "dig");
    const runs = JSON.parse(formatRunsJson(listRuns(db)));
    expectMatchesSchema(runs, DIG_JSON_SCHEMA.runs!, "runs");
    const doctor = JSON.parse(formatDoctorJson(doctorLedger(db)));
    expectMatchesSchema(doctor, DIG_JSON_SCHEMA.doctor!, "doctor");
    db.close();
  });

  test("the doctor none verdict walks its contract too — the nullable fields carry the honest absence", () => {
    const none = JSON.parse(formatDoctorJson(doctorLedger(openLedgerReadOnly(emptyLedgerPath))));
    expectMatchesSchema(none, DIG_JSON_SCHEMA.doctor!, "doctor(none)");
    expect(none.runId).toBeNull();
  });

  test("the contract's document contentJson is a STRING — the raw-text note is the printed rule", () => {
    const schema = JSON.parse(formatSchemaJson()) as {
      documents: { contentJson: string; knownNames: string[] };
    };
    expect(schema.documents.contentJson).toContain("exact stored text");
    // The known names are DERIVED from the wire-literal owners the writers
    // join on — the fixture's stored documents are all in the set.
    expect(new Set(schema.documents.knownNames)).toEqual(new Set(DIG_KNOWN_DOCUMENT_NAMES));
    expect(schema.documents.knownNames).toContain(TIMELINE_GATE_BLOCK_DOCUMENT);
    // And the real output keeps the promise: a document's body arrives as
    // a JSON-encoded string that needs the second parse.
    const dig = JSON.parse(formatDigJson(digLedger(openLedgerReadOnly(ledgerPath), { kind: "run", id: RUN }), "all")) as {
      events: { documents: { name: string; contentJson: string | null }[] }[];
    };
    const withDoc = dig.events.flatMap((e) => e.documents).find((d) => d.contentJson !== null)!;
    expect(typeof withDoc.contentJson).toBe("string");
    expect(() => JSON.parse(withDoc.contentJson!)).not.toThrow();
  });

  test("the printed exit-code contract states the absent-vs-empty split", () => {
    const schema = JSON.parse(formatSchemaJson()) as { exitCodes: Record<string, string> };
    expect(schema.exitCodes["0"]).toContain("empty scope");
    expect(schema.exitCodes["1"]).toContain("absent");
  });

  test("the anatomy command's json top-level keys are the declared contract (the census shapes stay with their owner)", { timeout: 60_000 }, async () => {
    // The anatomy payload is composed by the shell from the census and
    // registry owners; its top-level shape is the CLI's contract, so the
    // real command is the honest witness. The per-process and per-component
    // shapes are pinned by the anatomy block's own suite.
    const srv = await startHttpTestServer({
      prefix: "ledger-anatomy-http-",
      register: (router, _db, adb) => {
        registerAuthRoutes(router, adb);
        defineAnatomyBlocks(adb);
        mountBlockRoutes(router);
      },
    });
    let parsed: Record<string, unknown>;
    try {
      const username = "anatomy-cli", password = "anatomy-fixture-password";
      srv.db.createUser(username, await hashPassword(password));
      const requests: { method: string | undefined; path: string | undefined; status: number }[] = [];
      srv.server.on("request", (req, res) => res.on("finish", () => requests.push({ method: req.method, path: req.url, status: res.statusCode })));
      // Await asynchronously: this worker owns the real listener's event loop.
      const result = await promisify(execFile)(
        process.execPath,
        ["--experimental-strip-types", TRACE_TS, "anatomy", "--json"],
        { encoding: "utf8", timeout: 60_000, env: {
          ...process.env, HARNESS_WEB_PORT: new URL(srv.baseUrl).port,
          HARNESS_WEB_AUTH_USERNAME: username, HARNESS_WEB_AUTH_PASSWORD: password,
        } },
      );
      expect(requests, "the actual CLI must authenticate and read only its test-owned listener").toEqual([
        { method: "POST", path: "/api/auth/login", status: 200 },
        { method: "GET", path: blockReadPath("observability.anatomy"), status: 200 },
      ]);
      parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    } finally {
      await srv.stop();
    }
    const declared = DIG_JSON_SCHEMA.anatomy!;
    for (const key of Object.keys(parsed)) {
      expect(declared.fields![key], `anatomy emits '${key}' but the contract does not declare it`).toBeDefined();
    }
    for (const [key, sub] of Object.entries(declared.fields!)) {
      if (key in parsed) {
        expectMatchesSchema(parsed[key], sub, `anatomy.${key}`);
      } else {
        expect(sub.optional === true, `anatomy.${key} is declared required but missing`).toBe(true);
      }
    }
  });
});

// ── The anatomy view's printing (the `trace.ts anatomy` half) ─────────────
//
// The CLI is a thin shell; the anatomy formatting lives in the census +
// component-registry owners so the CLI and the anatomy block read print the
// SAME shapes by construction. These arms pin the text + JSON forms: every
// process line names its pid, what it is, how it relates to the tree, the
// sampled CPU and RSS; the JSON is the route's wire shape verbatim.
import {
  formatCensusText,
  formatCensusJson,
  type CensusProcess,
} from "../../server/observability/process-census.ts";
import {
  formatComponentsText,
  type RegisteredComponent,
} from "../../server/observability/component-registry.ts";

const ANATOMY_PROCESSES: readonly CensusProcess[] = [
  Object.freeze({
    pid: 4242,
    ppid: 4241,
    chain: Object.freeze([
      Object.freeze({ pid: 4241, name: "MainThread" }),
      Object.freeze({ pid: 220, name: "systemd" }),
    ]),
    startedAtBootTicks: 12345,
    startedAtWallIso: "2026-08-31T13:00:36.000Z",
    cwd: "/repo",
    argv: Object.freeze(["node", "--experimental-strip-types", "server/index.ts"]),
    cmdline: "node --experimental-strip-types server/index.ts",
    classification: Object.freeze({ label: "api server", scope: "server-tree" }),
    provenance: Object.freeze({ kind: "pidfile-owned", detail: "a live .dev pidfile names this pid" }),
    cpu: Object.freeze({ sampleMs: 500, cpuMs: 250, cpuMsPerSecond: 500 }),
    rssBytes: 123 * 1024 * 1024,
  }),
  Object.freeze({
    pid: 5000,
    ppid: 1682,
    chain: Object.freeze([Object.freeze({ pid: 1682, name: "bash" })]),
    startedAtBootTicks: 6789,
    startedAtWallIso: "2026-08-31T14:01:02.000Z",
    cwd: "/repo",
    argv: Object.freeze(["node", "scripts/trace.ts", "anatomy"]),
    cmdline: "node scripts/trace.ts anatomy",
    classification: Object.freeze({ label: "trace CLI", scope: "harness-tool" }),
    provenance: Object.freeze({ kind: "outside-tree", detail: "operator-run harness tool, not part of the server tree" }),
    cpu: null,
    rssBytes: null,
  }),
];

const ANATOMY_COMPONENTS: readonly RegisteredComponent[] = [
  Object.freeze({
    id: "c1",
    kind: "worker-thread",
    label: "repository-map",
    createdAtIso: "2026-08-31T13:00:39.000Z",
    provenance: "server/run/worker-pool.ts runWorkerTask",
    facts: Object.freeze({ task: "/repo", threadId: 11, workerUrl: "/server/intelligence/repository-map-worker.ts" }),
  }),
];

describe("the anatomy view's text form (trace.ts anatomy)", () => {
  test("the census text names pid, label, provenance kind, cpu, rss and the chain, per process", () => {
    const text = formatCensusText(ANATOMY_PROCESSES);
    expect(text).toContain("process census — 2 process(es)");
    expect(text).toContain("pid 4242");
    expect(text).toContain("api server");
    expect(text).toContain("pidfile-owned");
    expect(text).toContain("500.0ms/s");
    expect(text).toContain("123.0MiB");
    expect(text).toContain("chain MainThread(4241) ← systemd(220)");
    expect(text).toContain("cmd node --experimental-strip-types server/index.ts");
    expect(text).toContain("why pidfile-owned: a live .dev pidfile names this pid");
    // The unsampled process says "—" (an honest absence), never an
    // invented zero — the same rule the dig's timing column follows.
    expect(text).toContain("trace CLI");
    expect(text).toMatch(/cpu\s+—/);
    expect(text).toMatch(/rss\s+—/);
  });

  test("the component text groups by kind and carries label, facts and provenance", () => {
    const text = formatComponentsText(ANATOMY_COMPONENTS);
    expect(text).toContain("component registry — 1 live");
    expect(text).toContain("worker-thread");
    expect(text).toContain("repository-map");
    expect(text).toContain("server/run/worker-pool.ts runWorkerTask");
    expect(text).toContain("threadId");
    expect(formatComponentsText([])).toBe("component registry — 0 live");
  });

  test("the census JSON is the block read's data shape (processes verbatim)", () => {
    const parsed = JSON.parse(formatCensusJson(ANATOMY_PROCESSES)) as { processes: readonly CensusProcess[] };
    expect(parsed.processes).toHaveLength(2);
    expect(parsed.processes[0]!.pid).toBe(4242);
    expect(parsed.processes[0]!.classification.label).toBe("api server");
    expect(parsed.processes[1]!.cpu).toBeNull();
  });
});


test("dig preserves exact raw document fields and digest through JSON, text and doctor schemas", () => {
  const directory = createTempDir("dig-document-exact-");
  const path = join(directory, "timeline.db"); const store = createTimelineStore({ path, ledgerId: "exact-documents" });
  const documents = [
    { name: "empty", contentJson: "", contentDigest: sha256("") },
    { name: "ordered", orderedJson: '{ "b": 2, "a": 1 }\n', contentDigest: sha256('{ "b": 2, "a": 1 }\n') },
    { name: "raw", contentJson: "before\u0000after\r\n", contentDigest: sha256("before\u0000after\r\n") },
    { name: "reference", contentDigest: sha256("reference") },
  ];
  try {
    store.appendEvent({ eventId: "exact", ledgerId: store.ledgerId, eventType: "provider", actor: { kind: "test", id: "author" }, description: "exact", outcome: "failed", wallTime: AT(1), correlation: { runId: "exact-run" }, documents });
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const result = digLedger(db, { kind: "run", id: "exact-run" });
      const expected = documents.map((document) => ({ name: document.name, contentJson: "contentJson" in document ? document.contentJson : null, orderedJson: "orderedJson" in document ? document.orderedJson : null, contentDigest: document.contentDigest }));
      expect(result.events[0]!.documents).toEqual(expected);
      expect(JSON.parse(formatDigJson(result, "all")).events[0].documents).toEqual(expected);
      const text = formatDigText(result, "all");
      expect(text).toContain('{ "b": 2, "a": 1 }'); expect(text).toContain("before\u0000after\r");
      expect(text).toContain("digest-only"); expect(text).toContain(sha256("reference"));
    } finally { db.close(); }
  } finally { store.close(); }
});
