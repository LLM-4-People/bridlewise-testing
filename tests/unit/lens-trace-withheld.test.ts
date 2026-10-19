// @vitest-environment node
/**
 * The withheld count SURVIVES to the chain the client sees.
 *
 * `ownedTraceEvents` has always counted what the ownership gate filtered out,
 * but until now `walkTrace` dropped that count on the successful path — so a
 * trace that was half another user's rendered exactly like a trace that was
 * entirely the caller's own. That is a partial answer presented as a whole
 * one, which is the precise lie the `denied` status exists to prevent on the
 * other path. These tests pin the propagation and the shape of the count.
 *
 * SECURITY SHAPE: `withheld` is a count and nothing else. Several tests here
 * re-assert (like the walk tests do) that no field of a foreign event reaches
 * the serialised chain alongside it.
 */
import { describe, test, expect } from "vitest";

import {
  walkAncestry,
  walkTrace,
  type AncestryEvent,
  type AncestryPort,
} from "../../server/blocks/provenance.ts";
import { buildAncestryChain, withWithheld } from "../../shared/provenance.ts";

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

function portOver(
  events: readonly AncestryEvent[],
  owned: readonly string[] = ["run-mine"],
): AncestryPort {
  const byId = new Map(events.map((e) => [e.eventId, e]));
  return {
    getEvent: (id) => byId.get(id),
    eventsInTrace: (traceId) => events.filter((e) => e.traceId === traceId),
    ownsRun: (runId) => runId !== null && runId.length > 0 && owned.includes(runId),
  };
}

describe("withWithheld — the pure attachment rule", () => {
  test("a positive count is attached to an otherwise unchanged chain", () => {
    const base = buildAncestryChain([]);
    const chain = withWithheld(base, 2);
    expect(chain.withheld).toBe(2);
    expect(chain.status).toBe(base.status);
  });

  test("zero is an identity — no `withheld: 0` field is fabricated", () => {
    const base = buildAncestryChain([]);
    const chain = withWithheld(base, 0);
    expect(chain).toBe(base);
    expect("withheld" in chain).toBe(false);
  });

  test("negative and fractional counts are identities too", () => {
    const base = buildAncestryChain([]);
    expect(withWithheld(base, -1)).toBe(base);
    expect(withWithheld(base, 1.5)).toBe(base);
  });

  test("the returned chain is frozen like every other chain", () => {
    expect(Object.isFrozen(withWithheld(buildAncestryChain([]), 3))).toBe(true);
  });
});

describe("walkTrace carries the count to the caller", () => {
  test("a successful walk over a partly-foreign trace says how much was withheld", () => {
    const chain = walkTrace(
      "t",
      portOver(
        [
          ev({ eventId: "mine", traceId: "t", runId: "run-mine", sequence: "1" }),
          ev({ eventId: "theirs-1", traceId: "t", runId: "run-theirs", sequence: "2" }),
          ev({ eventId: "theirs-2", traceId: "t", runId: "run-theirs", sequence: "3" }),
        ],
        ["run-mine"],
      ),
    );
    expect(chain.hops.map((h) => h.eventId)).toEqual(["mine"]);
    expect(chain.withheld).toBe(2);
  });

  test("a wholly-owned trace carries NO withheld field — absence, not zero", () => {
    const chain = walkTrace(
      "t",
      portOver([
        ev({ eventId: "e1", traceId: "t", sequence: "1" }),
        ev({ eventId: "e2", parentEventId: "e1", traceId: "t", sequence: "2" }),
      ]),
    );
    expect(chain.status).toBe("complete");
    expect("withheld" in chain).toBe(false);
  });

  test("a wholly-foreign trace is denied AND counted", () => {
    const chain = walkTrace(
      "t",
      portOver(
        [ev({ eventId: "secret", traceId: "t", runId: "run-theirs" })],
        ["run-mine"],
      ),
    );
    expect(chain.status).toBe("denied");
    expect(chain.deniedAt).toBe("t");
    expect(chain.withheld).toBe(1);
  });

  test("the count travels with nothing else about the foreign events", () => {
    const chain = walkTrace(
      "t",
      portOver(
        [
          ev({ eventId: "mine", traceId: "t", runId: "run-mine", sequence: "1" }),
          ev({
            eventId: "secret-event-id",
            traceId: "t",
            runId: "run-theirs",
            sequence: "2",
            description: "SECRET WORK",
            actorId: "other-user",
          }),
        ],
        ["run-mine"],
      ),
    );
    expect(chain.withheld).toBe(1);
    const serialised = JSON.stringify(chain);
    expect(serialised).not.toContain("SECRET WORK");
    expect(serialised).not.toContain("secret-event-id");
    expect(serialised).not.toContain("other-user");
  });

  test("an event-id entry never carries a withheld count — only trace entry can know one", () => {
    // Direct walks have no trace population to have withheld anything from;
    // a count appearing there would be fabricated.
    const chain = walkAncestry("only", portOver([ev({ eventId: "only", traceId: "t" })]));
    expect("withheld" in chain).toBe(false);
  });
});
