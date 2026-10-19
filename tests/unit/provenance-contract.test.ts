// @vitest-environment node
/**
 * The PROVENANCE contract — every rule that decides what LENS SAYS.
 *
 * These are the assertions that stop the instrument from lying. The recurring
 * theme is that "unknown" must stay distinguishable from "known": an age with
 * no `asOf`, a root with no trace, a key with no record and an empty
 * population are each a different statement about the system, and each has a
 * test here proving LENS does not collapse it into a neighbouring one.
 *
 * Pure functions only — no DOM, no clock, no I/O. Every clock is injected, so
 * nothing here depends on when it runs.
 */
import { describe, test, expect } from "vitest";

import {
  ANCESTRY_MAX_DEPTH,
  PROVENANCE_ATTR,
  PROVENANCE_SELECTOR,
  ageMs,
  answerFor,
  buildAncestryChain,
  classifyTerminal,
  computeCoverage,
  coveragePercent,
  displayedAt,
  freshnessOf,
  freshnessOfRecord,
  makeProvenanceRecord,
  readEnvelopeCausality,
  reconstructableSpan,
  summarizeCausality,
  type AncestryHop,
  type ProvenanceRecord,
} from "../../shared/provenance.ts";

/** A record built through the real constructor — never a hand-made literal. */
function rec(over: Partial<Parameters<typeof makeProvenanceRecord>[0]> = {}): ProvenanceRecord {
  return makeProvenanceRecord({
    key: "code.graph",
    block: "code.graph",
    cacheState: "fresh",
    requestedAt: 1_000,
    settledAt: 1_050,
    ttlMs: 60_000,
    meta: { etag: 'W/"abc"', asOf: 1_040 },
    ...over,
  });
}

describe("the binding attribute is derived, not authored twice", () => {
  test("the selector is built from the attribute name", () => {
    // Two independently-written constants would drift the moment either is
    // renamed, and the failure would be silent: nothing would match.
    expect(PROVENANCE_SELECTOR).toBe(`[${PROVENANCE_ATTR}]`);
  });
});

describe("makeProvenanceRecord — what the Broker observed, and nothing more", () => {
  test("latency is measured, not assumed", () => {
    expect(rec({ requestedAt: 100, settledAt: 380 }).latencyMs).toBe(280);
  });

  test("a backwards clock never yields a negative latency", () => {
    expect(rec({ requestedAt: 500, settledAt: 100 }).latencyMs).toBe(0);
  });

  test("a cache hit reports zero latency truthfully", () => {
    expect(rec({ cacheState: "cached", requestedAt: 900, settledAt: 900 }).latencyMs).toBe(0);
  });

  test("asOf comes from the envelope and is NOT defaulted to the response time", () => {
    // The whole staleness story rests on this. Substituting `settledAt` for a
    // missing `asOf` would make every value look freshly produced.
    const r = rec({ meta: { etag: 'W/"x"' } });
    expect(r.asOf).toBeUndefined();
    expect(r.settledAt).toBe(1_050);
  });

  test("a non-numeric asOf is rejected rather than coerced", () => {
    expect(rec({ meta: { asOf: "1040" } }).asOf).toBeUndefined();
  });

  test("an empty etag is treated as absent, not as an etag", () => {
    expect(rec({ meta: { etag: "" } }).etag).toBeUndefined();
  });

  test("partial is carried only when the server actually said so", () => {
    expect(rec({ meta: { partial: false } }).partial).toBeUndefined();
    expect(rec({ meta: { partial: true } }).partial).toBe(true);
  });

  test("the record is frozen — no consumer can rewrite history", () => {
    expect(Object.isFrozen(rec())).toBe(true);
  });
});

describe("readEnvelopeCausality — never invents a causal id", () => {
  test("a meta with no causal fields yields nothing", () => {
    expect(readEnvelopeCausality({ etag: "x", asOf: 1 })).toEqual({});
  });

  test("non-string and empty-string ids are refused", () => {
    expect(readEnvelopeCausality({ traceId: 42, eventId: "", actor: null })).toEqual({});
  });

  test("real ids are carried through unchanged", () => {
    expect(readEnvelopeCausality({ traceId: "t1", eventId: "e1", actor: "user:u1" })).toEqual({
      traceId: "t1",
      eventId: "e1",
      actor: "user:u1",
    });
  });

  test("a null or primitive meta does not throw", () => {
    expect(readEnvelopeCausality(null)).toEqual({});
    expect(readEnvelopeCausality("nope")).toEqual({});
    expect(readEnvelopeCausality(undefined)).toEqual({});
  });
});

describe("staleness — measured against the read's OWN ttl", () => {
  test("age is measured from server production time, not response time", () => {
    // asOf 1_040, now 4_040 → 3s old. If age were measured from `settledAt`
    // (1_050) it would read 2.99s — close enough to look right and wrong
    // enough to hide a slow server.
    expect(ageMs(rec(), 4_040)).toBe(3_000);
  });

  test("age is undefined — not zero — when the envelope carried no asOf", () => {
    expect(ageMs(rec({ meta: {} }), 9_999)).toBeUndefined();
  });

  test("age never goes negative on a skewed clock", () => {
    expect(ageMs(rec(), 0)).toBe(0);
  });

  test("an unknown age classifies as unknown, never as live", () => {
    expect(freshnessOf(undefined, 60_000)).toBe("unknown");
  });

  test("the same age is live under a long ttl and stale under a short one", () => {
    // The point of a ratio: a global "stale after 30s" would lie about one of
    // these two blocks.
    expect(freshnessOf(30_000, 60_000)).toBe("live");
    expect(freshnessOf(30_000, 15_000)).toBe("stale");
  });

  test("aging is entered before stale, not at the same moment", () => {
    expect(freshnessOf(44_000, 60_000)).toBe("live");
    expect(freshnessOf(45_000, 60_000)).toBe("aging");
    expect(freshnessOf(59_999, 60_000)).toBe("aging");
    expect(freshnessOf(60_000, 60_000)).toBe("stale");
  });

  test("a zero ttl means always-revalidate, so nothing is ever live", () => {
    expect(freshnessOf(0, 0)).toBe("stale");
  });

  test("freshnessOfRecord composes age and ttl from the record itself", () => {
    expect(freshnessOfRecord(rec({ ttlMs: 1_000 }), 1_040)).toBe("live");
    expect(freshnessOfRecord(rec({ ttlMs: 1_000 }), 3_040)).toBe("stale");
  });
});

describe("answerFor — absence is an answer, and the two absences differ", () => {
  const lookup = (k: string) => (k === "known" ? rec({ key: "known" }) : undefined);

  test("no key at all is UNBOUND — the doctrine violation", () => {
    expect(answerFor(undefined, lookup)).toEqual({ kind: "absent", reason: "unbound" });
    expect(answerFor("", lookup)).toEqual({ kind: "absent", reason: "unbound" });
  });

  test("a key with no record is UNRESOLVED, not unbound", () => {
    // Conflating these would cry wolf on a cold cache and hide real holes.
    const a = answerFor("missing", lookup);
    expect(a).toEqual({ kind: "absent", reason: "unresolved", key: "missing" });
  });

  test("a known key answers with the record", () => {
    const a = answerFor("known", lookup);
    expect(a.kind).toBe("record");
    expect(a.kind === "record" && a.record.key).toBe("known");
  });
});

describe("causal ancestry — every terminating condition is named", () => {
  function hop(over: Partial<AncestryHop> = {}): AncestryHop {
    return {
      eventId: "e1",
      eventType: "effect",
      description: "read the graph",
      actor: "harness:web-ui",
      ...over,
    };
  }

  test("a hop with a parent is part of a complete chain", () => {
    expect(classifyTerminal(hop({ parentEventId: "e0" }))).toBe("complete");
  });

  test("no parent but a trace id is a genuine ROOT", () => {
    expect(classifyTerminal(hop({ traceId: "t1" }))).toBe("complete");
  });

  test("neither parent nor trace is UNRECORDED — a recorder defect, not a root", () => {
    // This is the distinction that lets LENS report the write path's own bug
    // instead of silently absorbing it as "this just happened".
    expect(classifyTerminal(hop())).toBe("unrecorded");
    expect(classifyTerminal(hop({ parentEventId: "", traceId: "" }))).toBe("unrecorded");
  });

  test("an empty walk is not_found, never an empty complete chain", () => {
    expect(buildAncestryChain([]).status).toBe("not_found");
  });

  test("hitting the cap reports truncated even when the last hop looks rooted", () => {
    const chain = buildAncestryChain([hop({ traceId: "t1" })], { hitCap: true });
    expect(chain.status).toBe("truncated");
  });

  test("denial outranks every other status and names where it stopped", () => {
    const chain = buildAncestryChain([hop({ traceId: "t1" })], { deniedAt: "e-other" });
    expect(chain.status).toBe("denied");
    expect(chain.deniedAt).toBe("e-other");
  });

  test("the depth cap is a real bound", () => {
    expect(ANCESTRY_MAX_DEPTH).toBeGreaterThan(0);
    expect(Number.isInteger(ANCESTRY_MAX_DEPTH)).toBe(true);
  });
});

describe("coverage — the number the ratchet guards", () => {
  const subj = (id: string, kind: string, block?: string) =>
    block === undefined ? { id, kind } : { id, kind, block };

  test("counts bound vs total and names every unbound id", () => {
    const r = computeCoverage([
      subj("a", "code", "code.graph"),
      subj("b", "code"),
      subj("c", "system"),
    ]);
    expect(r.total).toBe(3);
    expect(r.bound).toBe(1);
    expect(r.unbound).toEqual(["b", "c"]);
  });

  test("an empty block id counts as UNBOUND, not as bound", () => {
    // Otherwise a typo that produces "" would inflate coverage silently.
    expect(computeCoverage([subj("a", "k", "")]).bound).toBe(0);
  });

  test("the breakdown attributes a regression to a region", () => {
    const r = computeCoverage([
      subj("a", "code", "code.graph"),
      subj("b", "code"),
      subj("c", "system", "lens.recorder"),
    ]);
    expect(r.byKind["code"]).toEqual({ total: 2, bound: 1 });
    expect(r.byKind["system"]).toEqual({ total: 1, bound: 1 });
  });

  test("an empty population is 1, not 0 — a broken walker must not read as a collapse", () => {
    expect(computeCoverage([]).ratio).toBe(1);
  });

  test("the percentage rounds DOWN so a regression cannot hide inside rounding", () => {
    // 2/3 = 66.67%. Floor gives 66; round-to-nearest gives 67 — an
    // OVERSTATEMENT. A guard expressed in whole percent must never be told
    // coverage is higher than it is, so this case is chosen precisely because
    // floor and round disagree.
    expect(coveragePercent(computeCoverage([
      subj("a", "k", "b1"), subj("b", "k", "b2"), subj("c", "k"),
    ]))).toBe(66);
    // 1/3 = 33.33% — floor and round agree, so this pins the ordinary case.
    expect(coveragePercent(computeCoverage([
      subj("a", "k", "b1"), subj("b", "k"), subj("c", "k"),
    ]))).toBe(33);
  });
});

describe("recorder causality coverage", () => {
  test("counts only ids that are actually present", () => {
    const c = summarizeCausality([
      { traceId: "t1", parentEventId: "e0", actorId: "u1" },
      { traceId: null, parentEventId: null, actorId: "u1" },
      { traceId: "", parentEventId: "", actorId: "" },
    ]);
    expect(c).toEqual({ sampled: 3, withTrace: 1, withParent: 1, withActor: 2 });
  });

  test("an empty sample claims nothing", () => {
    expect(summarizeCausality([])).toEqual({
      sampled: 0, withTrace: 0, withParent: 0, withActor: 0,
    });
  });
});

describe("reconstruction — what was DISPLAYED, never what came later", () => {
  const history: ProvenanceRecord[] = [
    rec({ key: "a", block: "a", settledAt: 100 }),
    rec({ key: "b", block: "b", settledAt: 200 }),
    rec({ key: "a", block: "a", settledAt: 300, meta: { etag: 'W/"newer"', asOf: 290 } }),
  ];

  test("each key resolves to the newest record at or before the instant", () => {
    const at = displayedAt(history, 250);
    expect(at.map((d) => d.key)).toEqual(["a", "b"]);
    expect(at.find((d) => d.key === "a")?.record.settledAt).toBe(100);
  });

  test("a later record supersedes once the instant passes it", () => {
    expect(displayedAt(history, 350).find((d) => d.key === "a")?.record.settledAt).toBe(300);
  });

  test("a key with no record yet is ABSENT — never filled from the future", () => {
    // Showing `b` at t=150 would display a value the app had not received.
    // That is the fabrication this whole feature must never commit.
    expect(displayedAt(history, 150).map((d) => d.key)).toEqual(["a"]);
  });

  test("an instant before everything reconstructs nothing", () => {
    expect(displayedAt(history, 0)).toEqual([]);
  });

  test("the span is the real extent of the log", () => {
    expect(reconstructableSpan(history)).toEqual({ fromMs: 100, toMs: 300 });
  });

  test("an empty log has NO span rather than a degenerate one at now", () => {
    // A [now, now] span would put a scrub handle on an axis that means
    // nothing, inviting the user to scrub through fabricated time.
    expect(reconstructableSpan([])).toBeUndefined();
  });
});
