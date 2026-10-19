// @vitest-environment node
/**
 * DARKFIELD + ANNUNCIATOR against a REAL ledger — real SQLite, real schema,
 * real rows, through the real store port.
 *
 * Same rationale as `lens-ancestry-real-ledger.test.ts`: pure-logic tests
 * against a fake port would happily confirm column names and aggregate
 * semantics the real store no longer satisfies. So this file writes real
 * events through the same `createTimelineStore` the server uses and computes
 * both reports over that store — the exact `CoveragePort` binding production
 * uses (the bridge's store IS the port; no adapter exists to diverge).
 *
 * The query plans are EXPLAIN-asserted where the SQL lives — beside its owner
 * in `engine/test/timeline/timeline-coverage-counts.test.ts`
 * — not here, because this repo's raw-SQL guard makes the store the single
 * ledger-SQL party and the plan is that party's property.
 *
 * The properties pinned here, each mutation-verified (see the class comments):
 *
 *   A. Enumeration is DYNAMIC — the cells are exactly the harness registries.
 *   B. Counts are true against real rows, and a zero cell is PROVEN.
 *   C. "unknown" and "0" are structurally distinct; a failed port claims no
 *      count anywhere.
 *   D. Undeclared vocabulary is counted, never quoted.
 *   E. The annunciator's facts match hand-computed truths on the seed.
 *   F. The effect-kind table parse reads the ratchet's source and maps into
 *      the declared registry.
 *   G. The block declarations: deny-by-default input, authentication gate.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  createTimelineStore,
  TIMELINE_EVENT_TYPES,
  TIMELINE_RECORD_KINDS,
  TIMELINE_EDGE_TYPES,
} from "../../server/kernel/canonical.ts";
import { AuthError } from "../../server/kernel/errors.ts";
import { clearBlocks, listBlocks } from "../../server/blocks/define.ts";
import type { AsyncDbClient } from "../../server/db/async-client.ts";
import type { RouteContext } from "../../server/router/router.ts";
import {
  EFFECT_KIND_SOURCE,
  LEDGER_UNAVAILABLE_REASON,
  computeAnnunciator,
  computeDarkfield,
  defineCoverageBlocks,
  effectKindDarkfield,
  type CoveragePort,
} from "../../server/blocks/coverage.ts";
// The ONE effect-kind table — the same compiled value the block, both effect
// sinks and the choke-point ratchet consume.
import { EFFECT_KIND_EVENT_TYPES } from "../../server/kernel/canonical.ts";

/** The declared kind → event-type table, derived from the owner's own value. */
function declaredTable(): ReadonlyMap<string, string> {
  return new Map(Object.entries(EFFECT_KIND_EVENT_TYPES));
}
import { createTempDir } from "../helpers/temp-dir.ts";

const LEDGER_ID = "ledger-coverage-e2e";
const HEX64 = "a".repeat(64);
/** A vocabulary value that exists in NO declared registry. */
const UNDECLARED_TYPE = "zzzSecretVocab";

let dir: string;
let dbPath: string;
let store: ReturnType<typeof createTimelineStore>;
/** The production-shaped binding: the store IS the port. */
const port = (): CoveragePort => store;

const now = (): string => new Date().toISOString();

beforeAll(() => {
  dir = createTempDir("coverage-ledger-");
  dbPath = join(dir, "timeline.db");
  store = createTimelineStore({ path: dbPath, ledgerId: LEDGER_ID });

  // ── The seed, hand-computable ────────────────────────────────────────────
  // events: e1 run(run-a,t-1) · e2 tool(run-a, 2 edges) · e3 tool(no run)
  //         e4 message(no run) · raw undeclared row (below)
  // intent: i1 filesystem(run-a, t-2) — terminal: t1 filesystem(run-a, t-2)
  // observation: o1 test(no corr)
  store.appendEvent({
    eventId: "e1", ledgerId: LEDGER_ID, eventType: "run",
    actor: { kind: "user", id: "u-1" }, description: "run started",
    wallTime: now(), traceId: "t-1", correlation: { runId: "run-a" },
  });
  store.appendEvent({
    eventId: "e2", ledgerId: LEDGER_ID, eventType: "tool",
    actor: { kind: "user", id: "u-1" }, description: "tool inside the run",
    wallTime: now(), correlation: { runId: "run-a" },
    edges: [
      { edgeType: "causal", targetEventId: "e1" },
      { edgeType: "part-of", targetEventId: "e1" },
    ],
  });
  store.appendEvent({
    eventId: "e3", ledgerId: LEDGER_ID, eventType: "tool",
    actor: { kind: "harness", id: "web-ui" }, description: "tool outside any run",
    wallTime: now(),
  });
  store.appendEvent({
    eventId: "e4", ledgerId: LEDGER_ID, eventType: "message",
    actor: { kind: "user", id: "u-1" }, description: "a message without a run",
    wallTime: now(),
  });
  store.appendIntent({
    eventId: "i1", ledgerId: LEDGER_ID, eventType: "filesystem",
    effectKind: "filesystem", effectId: "fx-1",
    actor: { kind: "user", id: "u-1" }, description: "mkdir intent",
    intentHash: HEX64, wallTime: now(), traceId: "t-2",
    correlation: { runId: "run-a" },
  });
  store.appendTerminal({
    eventId: "t1", ledgerId: LEDGER_ID, eventType: "filesystem",
    effectId: "fx-1", outcome: "succeeded", resultHash: HEX64, wallTime: now(),
  });
  store.appendObservation({
    eventId: "o1", ledgerId: LEDGER_ID, eventType: "test",
    observationId: "obs-1", actor: { kind: "harness", id: "observer" }, evidenceHash: HEX64, wallTime: now(),
  });

  // A row the STORE could never write: an undeclared event type, inserted
  // through a raw writable connection. This is the corrupt/foreign-vocabulary
  // case DARKFIELD must count without quoting. (INSERT is legal on the
  // append-only ledger; only UPDATE/DELETE are trigger-blocked. Raw SQL is in
  // scope for tests — the server-side guard covers server/, not tests/.)
  const raw = new DatabaseSync(dbPath);
  raw
    .prepare(
      `INSERT INTO event_log (event_id, ledger_id, sequence, record_kind, event_type,
         wall_time, actor_kind, actor_id, description, previous_chain_hash, chain_hash)
       VALUES (?, ?, ?, 'event', ?, ?, 'harness', 'raw-writer', 'undeclared vocabulary row', 'x', 'x')`,
    )
    .run("e-raw", LEDGER_ID, 999_999, UNDECLARED_TYPE, now());
  raw.close();
});

afterAll(() => {
  // Close the handle; the temp directory itself is swept by
  // `tests/helpers/temp-dir.ts`, the single owner of test temp lifetimes.
  store.close();
});

// ── A. dynamic enumeration ─────────────────────────────────────────────────

describe("A. cells enumerate the harness registries, never a hand-list", () => {
  // MUTATION: replacing a registry import in coverage.ts with a copied
  // literal list goes stale the moment the harness vocabulary moves; these
  // equalities are against the live export, so the block and the harness
  // cannot disagree about what "declared" means.
  test("event-type cells are exactly TIMELINE_EVENT_TYPES, in registry order", () => {
    const d = computeDarkfield(port);
    expect(d.eventTypes.status).toBe("counted");
    if (d.eventTypes.status !== "counted") return;
    expect(d.eventTypes.cells.map((c) => c.id)).toEqual([...TIMELINE_EVENT_TYPES]);
    expect(d.eventTypes.declared).toBe(TIMELINE_EVENT_TYPES.length);
  });

  test("record-kind cells are exactly TIMELINE_RECORD_KINDS", () => {
    const d = computeDarkfield(port);
    if (d.recordKinds.status !== "counted") throw new Error("recordKinds not counted");
    expect(d.recordKinds.cells.map((c) => c.id)).toEqual([...TIMELINE_RECORD_KINDS]);
  });

  test("edge-type cells are exactly TIMELINE_EDGE_TYPES", () => {
    const d = computeDarkfield(port);
    if (d.edgeTypes.status !== "counted") throw new Error("edgeTypes not counted");
    expect(d.edgeTypes.cells.map((c) => c.id)).toEqual([...TIMELINE_EDGE_TYPES]);
  });
});

// ── B. counts are true, zeros are proven ───────────────────────────────────

describe("B. lifetime counts against real rows", () => {
  test("event-type counts match the seed exactly", () => {
    const d = computeDarkfield(port);
    if (d.eventTypes.status !== "counted") throw new Error("not counted");
    const byId = new Map(d.eventTypes.cells.map((c) => [c.id, c.count]));
    expect(byId.get("run")).toBe(1);
    expect(byId.get("tool")).toBe(2);
    expect(byId.get("message")).toBe(1);
    expect(byId.get("filesystem")).toBe(2); // intent + terminal
    expect(byId.get("test")).toBe(1); // observation
    expect(d.eventTypes.occurred).toBe(5);
    expect(d.eventTypes.neverOccurred).toBe(TIMELINE_EVENT_TYPES.length - 5);
  });

  test("a never-seeded type is a PROVEN zero cell, not a missing cell", () => {
    const d = computeDarkfield(port);
    if (d.eventTypes.status !== "counted") throw new Error("not counted");
    const rollback = d.eventTypes.cells.find((c) => c.id === "rollback");
    expect(rollback).toBeDefined();
    expect(rollback?.count).toBe(0);
    // The proof holds up against the store's own filtered count.
    expect(store.count({ eventType: "rollback" })).toBe(0);
  });

  test("record kinds count all four kinds from their real append paths", () => {
    const d = computeDarkfield(port);
    if (d.recordKinds.status !== "counted") throw new Error("not counted");
    const byId = new Map(d.recordKinds.cells.map((c) => [c.id, c.count]));
    expect(byId.get("event")).toBe(5); // e1..e4 + raw row
    expect(byId.get("intent")).toBe(1);
    expect(byId.get("terminal")).toBe(1);
    expect(byId.get("observation")).toBe(1);
    expect(d.recordKinds.neverOccurred).toBe(0);
  });

  test("edge types count real evidence-graph rows; unseeded edge types are zero", () => {
    const d = computeDarkfield(port);
    if (d.edgeTypes.status !== "counted") throw new Error("not counted");
    const byId = new Map(d.edgeTypes.cells.map((c) => [c.id, c.count]));
    expect(byId.get("causal")).toBe(1);
    expect(byId.get("part-of")).toBe(1);
    expect(d.edgeTypes.occurred).toBe(2);
    expect(d.edgeTypes.neverOccurred).toBe(TIMELINE_EDGE_TYPES.length - 2);
  });

  test("the scope states the whole file: every event, every ledger", () => {
    const d = computeDarkfield(port);
    expect(d.scope).toEqual({ status: "counted", events: 8, ledgers: 1 });
  });

  test("the report is plain JSON — it survives the envelope's serialisation", () => {
    const d = computeDarkfield(port);
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);
  });
});

// ── C. unknown is not zero ─────────────────────────────────────────────────

describe("C. a failed port yields UNKNOWN everywhere and claims no count", () => {
  // MUTATION: making computeDarkfield's catch produce zeroed cells (the lazy
  // fix) fails every test in this class — which is the point: the block's
  // one unclonable asset is that its zeros are proven.
  const broken = (): CoveragePort => {
    throw new Error("ledger unavailable");
  };

  test("every darkfield section is unknown, with no cells to mistake for zeros", () => {
    const d = computeDarkfield(broken);
    expect(d.scope.status).toBe("unknown");
    for (const section of [d.eventTypes, d.recordKinds, d.edgeTypes]) {
      expect(section.status).toBe("unknown");
      expect("cells" in section).toBe(false);
      expect("occurred" in section).toBe(false);
      if (section.status === "unknown") {
        expect(section.reason).toBe(LEDGER_UNAVAILABLE_REASON);
        // The declared size is still known — it comes from the registry, not
        // the ledger.
        expect(section.declared).toBeGreaterThan(0);
      }
    }
  });

  test("no annunciator fact claims a count", () => {
    const a = computeAnnunciator(broken, new Map([["tool", "tool"]]));
    for (const fact of [
      a.totalEvents, a.eventsWithoutRunId, a.eventsWithoutTraceId,
      a.toolEvents, a.toolEventsWithoutRunId, a.edgeRows,
    ]) {
      expect(fact.status).toBe("unknown");
      expect("count" in fact).toBe(false);
    }
    expect(a.effectKinds.status).toBe("unknown");
  });

  test('the serialised unknown report contains no "count" field at all', () => {
    const a = computeAnnunciator(broken, undefined);
    expect(JSON.stringify(a)).not.toContain('"count"');
  });

  test("an absent kind table is unknown even when the ledger is fine", () => {
    // The declared table is a compiled import now, so the production path
    // cannot lose it the way a source parse could — but the observer handed
    // NO table must still refuse to invent a vocabulary.
    const kinds = effectKindDarkfield(undefined, store.occurrenceCounts().eventTypeCounts);
    expect(kinds.status).toBe("unknown");
    if (kinds.status === "unknown") expect(kinds.reason).toMatch(/no effect-kind table/);
  });
});

// ── D. undeclared vocabulary: counted, never quoted ────────────────────────

describe("D. observed-but-undeclared vocabulary", () => {
  test("the raw undeclared row is counted", () => {
    const d = computeDarkfield(port);
    if (d.eventTypes.status !== "counted") throw new Error("not counted");
    expect(d.eventTypes.undeclared).toEqual({ distinctValues: 1, events: 1 });
  });

  // MUTATION: reporting the observed value strings instead of counts fails
  // this — an undeclared value is outside the closed vocabulary and could
  // carry anything, so it must never cross into a response.
  test("the undeclared VALUE never appears in either report", () => {
    const d = computeDarkfield(port);
    const a = computeAnnunciator(port, declaredTable());
    expect(JSON.stringify(d)).not.toContain(UNDECLARED_TYPE);
    expect(JSON.stringify(a)).not.toContain(UNDECLARED_TYPE);
  });

  test("registries with fully-declared observations report zero undeclared", () => {
    const d = computeDarkfield(port);
    if (d.edgeTypes.status !== "counted") throw new Error("not counted");
    expect(d.edgeTypes.undeclared).toEqual({ distinctValues: 0, events: 0 });
  });
});

// ── E. the annunciator's facts ─────────────────────────────────────────────

describe("E. recording-defect counts match hand-computed truth", () => {
  test("all facts, against the seed", () => {
    const a = computeAnnunciator(port, declaredTable());
    expect(a.totalEvents).toEqual({ status: "counted", count: 8 });
    // no run: e3, e4, o1, raw
    expect(a.eventsWithoutRunId).toEqual({ status: "counted", count: 4 });
    // no trace: everything except e1 (t-1) and the i1/t1 pair (t-2)
    expect(a.eventsWithoutTraceId).toEqual({ status: "counted", count: 5 });
    expect(a.toolEvents).toEqual({ status: "counted", count: 2 });
    expect(a.toolEventsWithoutRunId).toEqual({ status: "counted", count: 1 });
    expect(a.edgeRows).toEqual({ status: "counted", count: 2 });
  });

  test("counts only — no score, percentage or threshold fields", () => {
    const a = computeAnnunciator(port, declaredTable());
    expect(JSON.stringify(a)).not.toMatch(/score|percent|ratio|threshold|grade/i);
  });
});

// ── F. effect kinds — the owner's own table, mapped into the registry ─────

describe("F. the effect-kind vocabulary is the owner's own table", () => {
  test("the ONE table is non-empty and carries the produced kinds", () => {
    const table = declaredTable();
    expect(table.size).toBeGreaterThanOrEqual(3);
    expect(table.has("tool")).toBe(true);
  });

  test("every mapped event type is itself a declared timeline event type", () => {
    // The sink's table maps INTO the closed registry — a value outside it
    // would mean a sink writes events the timeline cannot categorise.
    const declared = new Set<string>(TIMELINE_EVENT_TYPES);
    for (const [kind, eventType] of declaredTable()) {
      expect(declared.has(eventType), `kind "${kind}" maps to undeclared "${eventType}"`).toBe(
        true,
      );
    }
  });

  test("kind counts agree with the event-type cells, and zeros are unproduced", () => {
    const kinds = effectKindDarkfield(declaredTable(), store.occurrenceCounts().eventTypeCounts);
    expect(kinds.status).toBe("counted");
    if (kinds.status !== "counted") return;
    // The report names its source — the vocabulary owner's own table.
    expect(kinds.source).toBe(EFFECT_KIND_SOURCE);
    const types = store.occurrenceCounts().eventTypeCounts;
    for (const k of kinds.kinds) {
      expect(k.eventsOfMappedType).toBe(types[k.eventType] ?? 0);
    }
    expect(kinds.unproduced).toEqual(
      kinds.kinds.filter((k) => k.eventsOfMappedType === 0).map((k) => k.kind),
    );
    // The seed produced tool events, so "tool" is provably produced.
    expect(kinds.unproduced).not.toContain("tool");
  });

  test("the honest-unknown arm stays reachable through the darkfield's own contract", () => {
    // The declared table is a COMPILED import now, so it can no longer fail
    // to be found the way a source parse could. The unknown status must stay
    // reachable for the observer that genuinely has no table — this pins
    // that the darkfield refuses to invent a vocabulary when handed none.
    const kinds = effectKindDarkfield(undefined, store.occurrenceCounts().eventTypeCounts);
    expect(kinds.status).toBe("unknown");
  });
});

// ── G. the block declarations ──────────────────────────────────────────────

describe("G. registration, deny-by-default input, and the authentication gate", () => {
  // Registration needs nothing from the DbClient (handlers close over it
  // lazily); the gate test below substitutes a stub that resolves no session.
  const noSessionDb = { getAuthSession: () => null } as unknown as AsyncDbClient;

  function registered() {
    clearBlocks();
    defineCoverageBlocks(noSessionDb);
    const blocks = listBlocks();
    clearBlocks();
    return blocks;
  }

  test("both instruments are declared with reads", () => {
    const ids = registered().map((b) => b.descriptor.id);
    expect(ids).toEqual(["coverage.darkfield", "coverage.annunciator"]);
    for (const b of registered()) expect(b.descriptor.hasRead).toBe(true);
  });

  test("the read input is deny-by-default: an unknown parameter is refused", () => {
    for (const b of registered()) {
      const schema = b.definition.read?.input;
      expect(schema).toBeDefined();
      expect(schema?.safeParse({}).success).toBe(true);
      // MUTATION: swapping strictObject for a plain object makes this pass a
      // stray parameter silently — the exact deny-by-default gap.
      expect(
        schema?.safeParse({ unexpected: "1" }).success,
        `${b.descriptor.id} accepted an undeclared input key`,
      ).toBe(false);
    }
  });

  test("an unauthenticated read is refused BEFORE any ledger access", async () => {
    // MUTATION: removing requireUserContext from a handler fails this with a
    // successful result instead of an AuthError.
    //
    // The gate is AWAITED now that it crosses the async facade, so the refusal
    // arrives as a rejected promise rather than a synchronous throw. The
    // assertion had to move with it — and that is exactly the shape of change
    // that can silently stop asserting anything, so it was mutation-proved
    // again after the move (see the commit that made the gate async).
    for (const b of registered()) {
      const ctx = { req: { headers: {} } } as unknown as RouteContext;
      await expect(
        Promise.resolve().then(() => b.definition.read?.handler({}, { ctx })),
        `${b.descriptor.id} served an unauthenticated read`,
      ).rejects.toThrow(AuthError);
    }
  });
});
