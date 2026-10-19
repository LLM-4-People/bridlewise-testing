// @vitest-environment node
/**
 * The causal walk against a REAL ledger — real SQLite, real schema, real rows.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE FAKE-PORT TESTS
 *
 * `lens-ancestry-walk.test.ts` proves the walk's LOGIC: every terminating
 * condition, the per-hop ownership gate, cycles, depth caps. It does that
 * against a fake port, which means it proves nothing about whether the
 * queries actually work — whether `event_log` accepts these writes, whether
 * `parent_event_id` chains resolve through `getEvent`, or whether the columns
 * the walk reads are the columns the store returns. Those are exactly the
 * assumptions that a hand-written fake will happily confirm while being
 * wrong.
 *
 * So this file writes real events into a real `DatabaseSync` over a temp file,
 * through the same `createTimelineStore` the server uses, and walks them with
 * the same `walkAncestry`. No server is started; the store is a library.
 *
 * WHAT IS STILL NOT COVERED, AND IS SAID SO PLAINLY
 *
 * `ancestryPortFor()` and `recorderCoverage()` bind the walk to the process-
 * wide `getTimelineQuery()` singleton and to `DbClient.runBelongsToUser`.
 * That singleton resolves its path from `serverConfig` at first use, and the
 * suite runs with `isolate: false`, so pointing it at a temp database here
 * would mutate state shared with every other test file. The BRIDGE wiring is
 * therefore still unexercised; the query behaviour it depends on is not.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";

import { createTimelineQuery, createTimelineStore } from "../../server/kernel/canonical.ts";
import { summarizeCausality } from "../../shared/provenance.ts";
import { createTempDir } from "../helpers/temp-dir.ts";
import {
  walkAncestry,
  walkTrace,
  type AncestryEvent,
  type AncestryPort,
} from "../../server/blocks/provenance.ts";

const LEDGER_ID = "ledger-lens-e2e";

let dir: string;
let store: ReturnType<typeof createTimelineStore>;
let query: ReturnType<typeof createTimelineQuery>;

/** Append one real row. Returns its event id. */
function append(
  id: string,
  opts: Readonly<{
    parentEventId?: string;
    traceId?: string;
    runId?: string;
    actor?: Readonly<{ kind: string; id: string }>;
    description?: string;
    /** Failure detail as ONE complete value — see the note in class E. */
    error?: Readonly<{ category: string; code: string; message: string; retryable: boolean }>;
  }> = {},
): string {
  store.appendEvent({
    eventId: id,
    ledgerId: LEDGER_ID,
    eventType: "resource",
    actor: opts.actor ?? { kind: "user", id: "u-owner" },
    description: opts.description ?? `event ${id}`,
    wallTime: new Date().toISOString(),
    ...(opts.runId !== undefined ? { correlation: { runId: opts.runId } } : {}),
    ...(opts.traceId !== undefined ? { traceId: opts.traceId } : {}),
    ...(opts.parentEventId !== undefined ? { parentEventId: opts.parentEventId } : {}),
    ...(opts.error !== undefined ? { error: opts.error } : {}),
  });
  return id;
}

/** The port, built exactly as `ancestryPortFor` builds it — over the real query. */
function realPort(ownedRuns: readonly string[]): AncestryPort {
  return {
    getEvent: (eventId) => {
      const e = query.getEvent(eventId);
      return e === undefined ? undefined : (e as unknown as AncestryEvent);
    },
    // The REAL byTrace, unfiltered — exactly what the live port returns.
    eventsInTrace: (traceId) =>
      query.byTrace(traceId, { limit: 64 }).events as unknown as readonly AncestryEvent[],
    ownsRun: (runId) => runId !== null && runId.length > 0 && ownedRuns.includes(runId),
  };
}

beforeAll(() => {
  dir = createTempDir("lens-ledger-");
  store = createTimelineStore({ path: join(dir, "timeline.db"), ledgerId: LEDGER_ID });
  query = createTimelineQuery(store);

  // A three-deep causal chain in one trace, all owned by run-mine.
  append("e-root", { traceId: "t-1", runId: "run-mine", description: "user asked a question" });
  append("e-mid", {
    parentEventId: "e-root", traceId: "t-1", runId: "run-mine",
    description: "the model called a tool",
  });
  append("e-leaf", {
    parentEventId: "e-mid", traceId: "t-1", runId: "run-mine",
    description: "the tool read the dependency graph",
  });

  // An event with NO causality recorded at all — the live defect class.
  append("e-orphan", { runId: "run-mine", description: "an effect with no correlation" });

  // A chain that crosses into another user's run.
  append("e-theirs", { traceId: "t-2", runId: "run-theirs", description: "SECRET WORK" });
  append("e-mine-child", {
    parentEventId: "e-theirs", traceId: "t-2", runId: "run-mine",
    description: "my event with their parent",
  });

  // A trace SHARED across two users' runs — the exposure `byTrace` creates.
  append("e-shared-theirs", {
    traceId: "t-shared", runId: "run-theirs", description: "SHARED TRACE SECRET",
    actor: { kind: "user", id: "u-other" },
  });
  append("e-shared-mine", {
    parentEventId: "e-shared-theirs", traceId: "t-shared", runId: "run-mine",
    description: "my event inside a shared trace",
  });

  // A trace whose newest event is a foreign SIBLING — not an ancestor of the
  // caller's event. Here the trace filter is the ONLY protection: the per-hop
  // gate never sees the foreign row because the walk would START on it.
  append("e-sib-mine", {
    traceId: "t-sibling", runId: "run-mine", description: "my sibling event",
  });
  append("e-sib-theirs", {
    traceId: "t-sibling", runId: "run-theirs", description: "SIBLING SECRET",
    actor: { kind: "user", id: "u-other" },
  });

  // A failure, so the error column round-trips.
  append("e-failed", {
    traceId: "t-3", runId: "run-mine",
    error: {
      category: "permission", code: "path_traversal",
      message: "outside the project root", retryable: false,
    },
    description: "a read that was refused",
  });
});

afterAll(() => {
  // Close the handle; the temp directory itself is swept by
  // `tests/helpers/temp-dir.ts`, the single owner of test temp lifetimes.
  // Removing it here as well would be a second, competing owner.
  store.close();
});

describe("A. the ledger really stores what the walk needs", () => {
  test("a written event round-trips with its causal columns intact", () => {
    // If `parent_event_id` or `trace_id` did not persist, every ancestry
    // answer would be `unrecorded` and look like a recorder bug rather than a
    // storage one.
    const e = query.getEvent("e-leaf");
    expect(e).toBeDefined();
    expect(e?.parentEventId).toBe("e-mid");
    expect(e?.traceId).toBe("t-1");
    expect(e?.runId).toBe("run-mine");
    expect(e?.actorKind).toBe("user");
    expect(e?.actorId).toBe("u-owner");
  });

  test("the store's record shape satisfies the walk's expected fields", () => {
    // The walk reads a structural subset rather than importing the record
    // type. This asserts the subset is actually a subset — the assumption a
    // fake port cannot check.
    const e = query.getEvent("e-leaf") as unknown as AncestryEvent;
    for (const field of [
      "eventId", "parentEventId", "traceId", "eventType",
      "description", "actorKind", "actorId", "wallTime", "outcome",
      "errorCode", "runId",
    ] as const) {
      expect(field in (e as object), `the ledger record has no "${field}"`).toBe(true);
    }
  });
});

describe("B. walking a real chain", () => {
  test("walks leaf → root and reports complete", () => {
    const chain = walkAncestry("e-leaf", realPort(["run-mine"]));
    expect(chain.status).toBe("complete");
    expect(chain.hops.map((h) => h.eventId)).toEqual(["e-leaf", "e-mid", "e-root"]);
  });

  test("the explanation reads outward from the value", () => {
    const chain = walkAncestry("e-leaf", realPort(["run-mine"]));
    expect(chain.hops.map((h) => h.description)).toEqual([
      "the tool read the dependency graph",
      "the model called a tool",
      "user asked a question",
    ]);
  });

  test("actor and timestamp survive the round trip", () => {
    const chain = walkAncestry("e-leaf", realPort(["run-mine"]));
    expect(chain.hops[0]?.actor).toBe("user:u-owner");
    expect(chain.hops[0]?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("an error code on a real row is carried into the explanation", () => {
    const chain = walkAncestry("e-failed", realPort(["run-mine"]));
    expect(chain.hops[0]?.errorCode).toBe("path_traversal");
  });

  test("a real event with no parent and no trace is UNRECORDED", () => {
    // The defect class this whole feature refuses to launder, observed on a
    // genuine row rather than a fabricated one.
    const chain = walkAncestry("e-orphan", realPort(["run-mine"]));
    expect(chain.status).toBe("unrecorded");
  });

  test("an id that is not in the ledger is not_found", () => {
    const chain = walkAncestry("e-nope", realPort(["run-mine"]));
    expect(chain.status).toBe("not_found");
    expect(chain.hops).toEqual([]);
  });
});

describe("C. the ownership gate holds against real rows", () => {
  test("the walk stops at an ancestor in another user's run", () => {
    const chain = walkAncestry("e-mine-child", realPort(["run-mine"]));
    expect(chain.status).toBe("denied");
    expect(chain.deniedAt).toBe("e-theirs");
  });

  test("the other user's description never reaches the response", () => {
    const chain = walkAncestry("e-mine-child", realPort(["run-mine"]));
    expect(JSON.stringify(chain)).not.toContain("SECRET WORK");
  });

  test("owning the other run reveals the rest of the chain", () => {
    // The gate is the ONLY thing withholding it — proving the denial above is
    // authorisation, not a broken query.
    const chain = walkAncestry("e-mine-child", realPort(["run-mine", "run-theirs"]));
    expect(chain.status).toBe("complete");
    expect(chain.hops.map((h) => h.eventId)).toEqual(["e-mine-child", "e-theirs"]);
  });
});

describe("E. a partial error is now UNREPRESENTABLE, not silently completed", () => {
  /**
   * This class began life pinning a defect: `appendEvent` took four flat
   * error fields and dropped `errorCode` when `errorCategory` was absent —
   * silently, so LENS rendered a blank where a real failure happened. Running
   * against a real store is what surfaced it; the fake port had answered
   * whatever it was told.
   *
   * The repair went further than the report. The store was also COMPLETING a
   * partial error with the invented literals `code: "unknown"` and
   * `message: ""` and chain-hashing them into a tamper-evident ledger —
   * fabricated data inside the audit record. The four fields are now one
   * required `TimelineErrorSummary`, so both halves are unrepresentable
   * rather than merely fixed, and a `rejectFlattenedError` guard DENIES the
   * legacy names instead of dropping them.
   *
   * These tests now pin the repair, because a silent regression here would
   * put invented data back into the chain hash.
   */
  test("a complete error round-trips intact", () => {
    const e = query.getEvent("e-failed");
    expect(e?.errorCode).toBe("path_traversal");
    expect(e?.errorCategory).toBe("permission");
    expect(e?.errorMessage).toBe("outside the project root");
    expect(e?.errorRetryable).toBe(false);
  });

  test("a legacy flat error field is DENIED, not dropped", () => {
    // The old shape must fail loudly. Silently ignoring it would recreate the
    // original defect in a quieter form for any untyped or cast caller.
    expect(() =>
      store.appendEvent({
        eventId: "e-flat-legacy",
        ledgerId: LEDGER_ID,
        eventType: "resource",
        actor: { kind: "user", id: "u-owner" },
        description: "an event using the removed flat error shape",
        wallTime: new Date().toISOString(),
        errorCode: "swallowed_code",
      } as unknown as Parameters<typeof store.appendEvent>[0]),
    ).toThrow(/flattened error field/);
  });

  test("the denied event was not written — a rejected append leaves no row", () => {
    expect(query.getEvent("e-flat-legacy")).toBeUndefined();
  });

  test("no event carries an invented placeholder code", () => {
    // `"unknown"` / `""` were the literals the store used to synthesise. Their
    // absence across every row is the mechanical proof the fabrication is gone.
    const all = query.byRuns(["run-mine"], { limit: 200 });
    for (const e of all.events) {
      expect(e.errorCode, `event ${e.eventId} carries the invented placeholder code`).not.toBe(
        "unknown",
      );
    }
  });
});

describe("D. recorder coverage over real rows", () => {
  test("byRuns + summarizeCausality count what the ledger actually holds", () => {
    // This is the query `recorderCoverage()` runs, against a real store.
    const result = query.byRuns(["run-mine"], { limit: 200 });
    const coverage = summarizeCausality(result.events);
    expect(coverage.sampled).toBe(result.events.length);
    expect(coverage.sampled).toBeGreaterThan(0);
    // Every row we wrote has an actor; only some have a trace or a parent.
    expect(coverage.withActor).toBe(coverage.sampled);
    expect(coverage.withTrace).toBeLessThan(coverage.sampled);
    expect(coverage.withParent).toBeLessThan(coverage.sampled);
  });

  test("the run filter really scopes — another user's rows are not counted", () => {
    const mine = query.byRuns(["run-mine"], { limit: 200 });
    expect(mine.events.some((e) => e.runId === "run-theirs")).toBe(false);
  });

  test("an empty run set claims nothing rather than everything", () => {
    // The dangerous default: an empty scope that silently means "no filter".
    const none = query.byRuns([], { limit: 200 });
    expect(none.events.length).toBe(0);
    expect(summarizeCausality(none.events).sampled).toBe(0);
  });
});

describe("F. entering by trace against the real index", () => {
  /**
   * `byTrace` is backed by a composite index and has NO ownership gate of its
   * own — it returns whatever shares the trace id, across runs. These tests
   * drive the real query, so they prove the filter is applied to real rows
   * rather than to a fake that returned only what it was handed.
   */
  test("a real trace resolves to the caller's newest event and walks back", () => {
    const chain = walkTrace("t-1", realPort(["run-mine"]));
    expect(chain.status).toBe("complete");
    expect(chain.hops.map((h) => h.eventId)).toEqual(["e-leaf", "e-mid", "e-root"]);
  });

  test("byTrace really does return another user's rows — the gate is load-bearing", () => {
    // Establishes the premise of the test below. If this ever returns only
    // one row, the filter has stopped being exercised and the next test is
    // passing for the wrong reason.
    const raw = query.byTrace("t-shared", { limit: 64 });
    expect(raw.events.length).toBe(2);
    expect(raw.events.some((e) => e.runId === "run-theirs")).toBe(true);
  });

  test("a cross-run trace never leaks the other user's event CONTENT", () => {
    const chain = walkTrace("t-shared", realPort(["run-mine"]));
    const serialised = JSON.stringify(chain);
    expect(serialised, "the other user's description leaked").not.toContain(
      "SHARED TRACE SECRET",
    );
    expect(serialised, "the other user's identity leaked").not.toContain("u-other");
    // The foreign event is not a hop — only the caller's own event is.
    expect(chain.hops.map((h) => h.eventId)).toEqual(["e-shared-mine"]);
    expect(chain.status).toBe("denied");
  });

  test("the denied id IS named, and that is deliberate — it is a column on the caller's own row", () => {
    // `e-shared-mine.parent_event_id` literally contains this id, and that row
    // belongs to the caller. Suppressing it would mean redacting a field of
    // the user's OWN event, and would leave the UI unable to say "the chain
    // continues past something you cannot see" — which would make a truncated
    // answer look like a complete one. Existence is disclosed; content is not.
    const chain = walkTrace("t-shared", realPort(["run-mine"]));
    expect(chain.deniedAt).toBe("e-shared-theirs");
    expect(chain.hops[0]?.parentEventId).toBe("e-shared-theirs");
  });

  test("entering a trace where nothing is owned names only the trace, never an event id", () => {
    // The contrast that makes the rule above sound: with no owned row, there
    // is no legitimate reason for the caller to learn any event id, so none
    // is disclosed.
    const chain = walkTrace("t-2", realPort(["run-unrelated"]));
    expect(chain.deniedAt).toBe("t-2");
    expect(JSON.stringify(chain)).not.toContain("e-theirs");
  });

  test("the same trace shows everything once BOTH runs are owned", () => {
    // Proves the exclusion above is authorisation, not a broken query.
    const chain = walkTrace("t-shared", realPort(["run-mine", "run-theirs"]));
    expect(chain.hops.map((h) => h.eventId)).toContain("e-shared-theirs");
  });

  test("a trace containing only another user's events is denied", () => {
    const chain = walkTrace("t-2", realPort(["run-unrelated"]));
    expect(chain.status).toBe("denied");
    expect(chain.deniedAt).toBe("t-2");
    expect(JSON.stringify(chain)).not.toContain("SECRET WORK");
  });

  test("a foreign SIBLING is never the entry point, even as the newest event", () => {
    // The case the per-hop gate cannot cover. Without the ownership filter on
    // the trace result, the walk begins on the other user's row; the hop gate
    // then denies it, so the caller sees an empty denied chain INSTEAD of
    // their own perfectly visible event — a wrong answer as well as a
    // disclosure that a foreign row exists in their trace.
    const chain = walkTrace("t-sibling", realPort(["run-mine"]));
    expect(chain.status).toBe("complete");
    expect(chain.hops.map((h) => h.eventId)).toEqual(["e-sib-mine"]);
    const serialised = JSON.stringify(chain);
    expect(serialised).not.toContain("SIBLING SECRET");
    expect(serialised).not.toContain("e-sib-theirs");
    expect(serialised).not.toContain("u-other");
  });

  test("an unknown trace is not_found", () => {
    expect(walkTrace("t-nope", realPort(["run-mine"])).status).toBe("not_found");
  });
});
