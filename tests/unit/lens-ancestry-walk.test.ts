// @vitest-environment node
/**
 * The causal walk — including the ownership gate that makes it safe.
 *
 * The `parent_event_id` chain is the one part of LENS that can cross a
 * security boundary: `event_log` is a single shared table with no user column,
 * and a chain can walk from the caller's own run into somebody else's. A walk
 * that authorises only its STARTING event is therefore a cross-user read
 * dressed up as a feature. Class C exists to prove that cannot happen.
 *
 * The port is faked, so every terminating condition is reachable without a
 * database — including the ones a real ledger makes very hard to produce on
 * demand (a cycle, a dangling parent, a denied ancestor).
 */
import { describe, test, expect } from "vitest";

import {
  ownedTraceEvents,
  walkAncestry,
  walkTrace,
  type AncestryEvent,
  type AncestryPort,
} from "../../server/blocks/provenance.ts";
import { ANCESTRY_MAX_DEPTH } from "../../shared/provenance.ts";

let seq = 0;

function ev(over: Partial<AncestryEvent> & { eventId: string }): AncestryEvent {
  return {
    sequence: String(++seq),
    parentEventId: null,
    traceId: null,
    eventType: "effect",
    description: `event ${over.eventId}`,
    actorKind: "harness",
    actorId: "web-ui",
    wallTime: "2026-01-01T00:00:00.000Z",
    outcome: null,
    errorCode: null,
    runId: "run-mine",
    ...over,
  };
}

/** A port over a fixed event set. `owned` decides which runs are the caller's. */
function portOver(
  events: readonly AncestryEvent[],
  owned: readonly string[] = ["run-mine"],
): AncestryPort {
  const byId = new Map(events.map((e) => [e.eventId, e]));
  return {
    getEvent: (id) => byId.get(id),
    // UNFILTERED, exactly as the live port returns it — the whole point of
    // class D is that the gate, not the query, is what makes this safe.
    eventsInTrace: (traceId) => events.filter((e) => e.traceId === traceId),
    ownsRun: (runId) => runId !== null && runId.length > 0 && owned.includes(runId),
  };
}

describe("A. the chain that exists", () => {
  test("walks parent links to a rooted trace and reports complete", () => {
    const chain = walkAncestry(
      "e3",
      portOver([
        ev({ eventId: "e3", parentEventId: "e2", traceId: "t" }),
        ev({ eventId: "e2", parentEventId: "e1", traceId: "t" }),
        ev({ eventId: "e1", traceId: "t" }),
      ]),
    );
    expect(chain.status).toBe("complete");
    expect(chain.hops.map((h) => h.eventId)).toEqual(["e3", "e2", "e1"]);
  });

  test("hops are nearest-cause-first — the explanation reads outward from the value", () => {
    const chain = walkAncestry(
      "e2",
      portOver([ev({ eventId: "e2", parentEventId: "e1", traceId: "t" }), ev({ eventId: "e1", traceId: "t" })]),
    );
    expect(chain.hops[0]?.eventId).toBe("e2");
  });

  test("actor is composed from kind and id, so responsibility is attributable", () => {
    const chain = walkAncestry(
      "e1",
      portOver([ev({ eventId: "e1", traceId: "t", actorKind: "user", actorId: "u-42" })]),
    );
    expect(chain.hops[0]?.actor).toBe("user:u-42");
  });

  test("an error on a hop is carried — a failed cause is still a cause", () => {
    const chain = walkAncestry(
      "e1",
      portOver([ev({ eventId: "e1", traceId: "t", errorCode: "path_traversal", outcome: "failed" })]),
    );
    expect(chain.hops[0]?.errorCode).toBe("path_traversal");
    expect(chain.hops[0]?.outcome).toBe("failed");
  });
});

describe("B. the chain that does NOT exist — reported honestly", () => {
  test("an event with neither parent nor trace is UNRECORDED, not a root", () => {
    // This is the live state of the system today: the effect sink writes
    // events with no correlation, so their causality was never persisted.
    // Reporting this as `complete` would launder a recorder defect into a
    // confident one-node answer.
    const chain = walkAncestry("e1", portOver([ev({ eventId: "e1" })]));
    expect(chain.status).toBe("unrecorded");
    expect(chain.hops.length).toBe(1);
  });

  test("an unknown starting event is not_found and yields no hops", () => {
    const chain = walkAncestry("nope", portOver([]));
    expect(chain.status).toBe("not_found");
    expect(chain.hops).toEqual([]);
  });

  test("a dangling parent is truncated, never complete", () => {
    // The parent id points at a row that is not there. The chain cannot be
    // completed, and saying it was would assert a root that does not exist.
    const chain = walkAncestry(
      "e2",
      portOver([ev({ eventId: "e2", parentEventId: "gone", traceId: "t" })]),
    );
    expect(chain.status).toBe("truncated");
    expect(chain.hops.map((h) => h.eventId)).toEqual(["e2"]);
  });

  test("a cycle terminates instead of hanging, and reports truncated", () => {
    const chain = walkAncestry(
      "e1",
      portOver([
        ev({ eventId: "e1", parentEventId: "e2", traceId: "t" }),
        ev({ eventId: "e2", parentEventId: "e1", traceId: "t" }),
      ]),
    );
    expect(chain.status).toBe("truncated");
    expect(chain.hops.length).toBe(2);
  });

  test("the depth cap bounds the walk and is reported", () => {
    const events = Array.from({ length: 10 }, (_, i) =>
      ev({ eventId: `e${i}`, parentEventId: `e${i + 1}`, traceId: "t" }),
    );
    const chain = walkAncestry("e0", portOver(events), 4);
    expect(chain.status).toBe("truncated");
    expect(chain.hops.length).toBe(4);
  });

  test("the default cap is the contract's cap", () => {
    const events = Array.from({ length: ANCESTRY_MAX_DEPTH + 5 }, (_, i) =>
      ev({ eventId: `e${i}`, parentEventId: `e${i + 1}`, traceId: "t" }),
    );
    const chain = walkAncestry("e0", portOver(events));
    expect(chain.hops.length).toBe(ANCESTRY_MAX_DEPTH);
  });
});

describe("C. the ownership gate applies at EVERY hop", () => {
  test("an ancestor in another user's run stops the walk", () => {
    const chain = walkAncestry(
      "e2",
      portOver([
        ev({ eventId: "e2", parentEventId: "e1", traceId: "t", runId: "run-mine" }),
        ev({ eventId: "e1", traceId: "t", runId: "run-theirs" }),
      ]),
    );
    expect(chain.status).toBe("denied");
    expect(chain.deniedAt).toBe("e1");
  });

  test("nothing about the denied ancestor leaks — only its id, which the caller supplied the path to", () => {
    const chain = walkAncestry(
      "e2",
      portOver([
        ev({ eventId: "e2", parentEventId: "e1", traceId: "t", runId: "run-mine" }),
        ev({ eventId: "e1", traceId: "t", runId: "run-theirs", description: "SECRET WORK" }),
      ]),
    );
    const serialised = JSON.stringify(chain);
    expect(serialised).not.toContain("SECRET WORK");
    expect(chain.hops.map((h) => h.eventId)).toEqual(["e2"]);
  });

  test("a starting event the caller does not own yields nothing at all", () => {
    const chain = walkAncestry(
      "e1",
      portOver([ev({ eventId: "e1", traceId: "t", runId: "run-theirs" })]),
    );
    expect(chain.status).toBe("denied");
    expect(chain.hops).toEqual([]);
  });

  test("an event with a NULL run is denied — no run means no user provenance", () => {
    // Deny-by-default. Every effect-sink event currently has a null run, so
    // an allow-by-default here would expose the entire background effect
    // stream of every user on the instance.
    const chain = walkAncestry("e1", portOver([ev({ eventId: "e1", traceId: "t", runId: null })]));
    expect(chain.status).toBe("denied");
    expect(chain.hops).toEqual([]);
  });

  test("an empty-string run is denied too", () => {
    const chain = walkAncestry("e1", portOver([ev({ eventId: "e1", traceId: "t", runId: "" })]));
    expect(chain.status).toBe("denied");
  });
});

describe("D. entering by trace — the gate a trace-scoped read does NOT come with", () => {
  /**
   * `byTrace` returns whatever shares a trace id, and a trace can span runs.
   * A trace-scoped LIST read therefore has no ownership boundary of its own:
   * it is the same cross-user exposure the per-hop gate exists to stop,
   * wearing a shape that looks harmless because no chain is being followed.
   *
   * The gate is `ownsRun` — the same predicate `walkAncestry` applies, not a
   * second copy. These tests exist to prove it is actually applied on this
   * path too, because a filter that is merely INTENDED is a filter that is
   * absent.
   */
  test("a trace entry walks the chain from the caller's newest owned event", () => {
    const chain = walkTrace(
      "t",
      portOver([
        ev({ eventId: "e1", traceId: "t", sequence: "1" }),
        ev({ eventId: "e2", parentEventId: "e1", traceId: "t", sequence: "2" }),
        ev({ eventId: "e3", parentEventId: "e2", traceId: "t", sequence: "3" }),
      ]),
    );
    expect(chain.status).toBe("complete");
    expect(chain.hops.map((h) => h.eventId)).toEqual(["e3", "e2", "e1"]);
  });

  test("the entry point is chosen by sequence, not by array order", () => {
    // If row order decided the entry, a query returning descending rows would
    // silently start the walk at the OLDEST event and explain nothing.
    const chain = walkTrace(
      "t",
      portOver([
        ev({ eventId: "e3", parentEventId: "e2", traceId: "t", sequence: "30" }),
        ev({ eventId: "e1", traceId: "t", sequence: "10" }),
        ev({ eventId: "e2", parentEventId: "e1", traceId: "t", sequence: "20" }),
      ]),
    );
    expect(chain.hops[0]?.eventId).toBe("e3");
  });

  test("sequences beyond Number.MAX_SAFE_INTEGER still order correctly", () => {
    // `sequence` is a ledger-wide counter stored wider than a JS number.
    // 2^53 and 2^53+1 are DISTINCT integers that both round to 2^53 as a JS
    // number, so a `Number()` comparison finds them equal and the entry point
    // silently falls back to array order. The pair is chosen precisely so the
    // two implementations disagree; an earlier version of this test used
    // 2^53+1 and 2^53+2, which happen to survive the conversion and so proved
    // nothing. `old` is placed FIRST so a broken comparison keeps it.
    const chain = walkTrace(
      "t",
      portOver([
        ev({ eventId: "old", traceId: "t", sequence: "9007199254740992" }),
        ev({ eventId: "new", traceId: "t", sequence: "9007199254740993" }),
      ]),
    );
    expect(chain.hops[0]?.eventId).toBe("new");
  });

  test("events in the trace that belong to another user are FILTERED OUT", () => {
    const port = portOver(
      [
        ev({ eventId: "mine", traceId: "t", runId: "run-mine", sequence: "1" }),
        ev({ eventId: "theirs", traceId: "t", runId: "run-theirs", sequence: "2",
             description: "SECRET WORK" }),
      ],
      ["run-mine"],
    );
    const { owned, withheld } = ownedTraceEvents(port.eventsInTrace("t"), port);
    expect(owned.map((e) => e.eventId)).toEqual(["mine"]);
    expect(withheld).toBe(1);
  });

  test("a foreign event is never the entry point, even when it is the newest", () => {
    // The dangerous case: their event has the highest sequence, so an
    // unfiltered "newest wins" would start the walk inside their run.
    const chain = walkTrace(
      "t",
      portOver(
        [
          ev({ eventId: "mine", traceId: "t", runId: "run-mine", sequence: "1" }),
          ev({ eventId: "theirs", traceId: "t", runId: "run-theirs", sequence: "99",
               description: "SECRET WORK" }),
        ],
        ["run-mine"],
      ),
    );
    expect(chain.hops.map((h) => h.eventId)).toEqual(["mine"]);
    expect(JSON.stringify(chain)).not.toContain("SECRET WORK");
  });

  test("nothing about a foreign event reaches the serialised response", () => {
    const chain = walkTrace(
      "t",
      portOver(
        [
          ev({ eventId: "mine", traceId: "t", runId: "run-mine", sequence: "1" }),
          ev({ eventId: "secret-event-id", traceId: "t", runId: "run-theirs",
               sequence: "2", description: "SECRET WORK", actorId: "other-user" }),
        ],
        ["run-mine"],
      ),
    );
    const serialised = JSON.stringify(chain);
    expect(serialised).not.toContain("SECRET WORK");
    expect(serialised).not.toContain("secret-event-id");
    expect(serialised).not.toContain("other-user");
  });

  test("a trace where NOTHING is owned is denied, and names only the caller's own input", () => {
    const chain = walkTrace(
      "t",
      portOver(
        [ev({ eventId: "secret-event-id", traceId: "t", runId: "run-theirs",
              description: "SECRET WORK" })],
        ["run-mine"],
      ),
    );
    expect(chain.status).toBe("denied");
    // The trace id came from the caller; an event id would be new information
    // about a row they are not allowed to know exists.
    expect(chain.deniedAt).toBe("t");
    expect(JSON.stringify(chain)).not.toContain("secret-event-id");
  });

  test("an EMPTY trace is not_found — absence and denial must not read alike", () => {
    const chain = walkTrace("no-such-trace", portOver([]));
    expect(chain.status).toBe("not_found");
  });

  test("an event with a null run is withheld from a trace read too", () => {
    // Deny-by-default, applied identically on both entry paths.
    const chain = walkTrace(
      "t",
      portOver([ev({ eventId: "orphan", traceId: "t", runId: null })], ["run-mine"]),
    );
    expect(chain.status).toBe("denied");
  });

  test("the per-hop gate still applies after a trace entry", () => {
    // Trace entry only chooses a starting point; it must not become a way to
    // bypass the walk's own gate on the ancestors.
    const chain = walkTrace(
      "t",
      portOver(
        [
          ev({ eventId: "mine", parentEventId: "theirs", traceId: "t",
               runId: "run-mine", sequence: "2" }),
          ev({ eventId: "theirs", traceId: "t", runId: "run-theirs", sequence: "1",
               description: "SECRET WORK" }),
        ],
        ["run-mine"],
      ),
    );
    expect(chain.status).toBe("denied");
    expect(chain.deniedAt).toBe("theirs");
    expect(JSON.stringify(chain)).not.toContain("SECRET WORK");
  });
});
