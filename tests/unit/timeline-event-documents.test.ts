// @vitest-environment node
/**
 * THE RECORDED DOCUMENTS FOLD — its state owner, tested at the seam.
 *
 * The fold's contract (BeatScope renders it; this module owns its truth):
 *   - an unopened fold has NOT read — absence, no invented empty list;
 *   - opening reads ONCE through the injectable door; a measured/absent
 *     load stands (reopening is not a re-fetch);
 *   - the door's 404 (an event not the caller's, or gone) is a stated
 *     ABSENCE — never an error banner on the record being read;
 *   - a transport failure IS a failure, stated, and reopening after one is
 *     the honest retry (a failed load is the one state that re-reads);
 *   - a document's recorded content is parsed; a record whose content does
 *     not parse keeps the document and shows the raw string it stored —
 *     never a fabricated value, never a dropped document;
 *   - a late answer for a reset store must not resurrect a removed entry.
 *
 * Mutation discipline: every arm names the state it would be red in.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  eventDocumentsLoads,
  loadEventDocuments,
  resetEventDocuments,
  setEventDocumentsReader,
  type EventDocument,
  type EventDocumentsReader,
} from "../../src/state/timeline-event-documents";

/** A reader that records its calls and answers from a script. */
function scriptedReader(
  script: readonly (readonly EventDocument[] | null | Error)[],
): EventDocumentsReader & { calls: string[] } {
  const calls: string[] = [];
  let at = 0;
  const reader: EventDocumentsReader = async (eventId) => {
    calls.push(eventId);
    const answer = script[Math.min(at, script.length - 1)] ?? null;
    at += 1;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return Object.assign(reader, { calls });
}

const defaultReader = setEventDocumentsReader(scriptedReader([]));
setEventDocumentsReader(defaultReader);

function projectedDocument(name: string, content: unknown): EventDocument {
  return { name, content, contentJson: JSON.stringify(content), orderedJson: null, contentDigest: null };
}
const DOC = Object.freeze(projectedDocument("gate-block", { blocked: true }));

beforeEach(() => {
  resetEventDocuments();
});

afterEach(() => {
  setEventDocumentsReader(scriptedReader([]));
});

describe("the unopened fold", () => {
  test("a fold never opened has NOT read — the store holds no entry for it", () => {
    const reader = scriptedReader([[DOC]]);
    const prev = setEventDocumentsReader(reader);
    expect(eventDocumentsLoads.get().has("evt-1")).toBe(false);
    expect(reader.calls).toHaveLength(0);
    setEventDocumentsReader(prev);
  });
});

describe("opening the fold", () => {
  test("reads once and lands the documents with parsed content", async () => {
    const reader = scriptedReader([[projectedDocument("finding", { kind: "bias" })]]);
    const prev = setEventDocumentsReader(reader);
    await loadEventDocuments("evt-1");
    const load = eventDocumentsLoads.get().get("evt-1");
    expect(load).toEqual({
      kind: "measured",
      documents: [projectedDocument("finding", { kind: "bias" })],
    });
    expect(reader.calls).toEqual(["evt-1"]);
    setEventDocumentsReader(prev);
  });

  test("a measured load STANDS — reopening the fold does not re-fetch", async () => {
    const reader = scriptedReader([[DOC]]);
    const prev = setEventDocumentsReader(reader);
    await loadEventDocuments("evt-1");
    await loadEventDocuments("evt-1");
    await loadEventDocuments("evt-1");
    expect(reader.calls).toHaveLength(1);
    setEventDocumentsReader(prev);
  });

  test("the door's 404 is a stated ABSENCE, not an error", async () => {
    const reader = scriptedReader([null]);
    const prev = setEventDocumentsReader(reader);
    await loadEventDocuments("evt-foreign");
    const load = eventDocumentsLoads.get().get("evt-foreign");
    expect(load?.kind).toBe("absent");
    expect(load?.kind === "absent" ? load.reason : "").toContain("not reachable");
    setEventDocumentsReader(prev);
  });

  test("a record with NO documents is a measured empty list, stated by the fold as such", async () => {
    const reader = scriptedReader([[]]);
    const prev = setEventDocumentsReader(reader);
    await loadEventDocuments("evt-bare");
    expect(eventDocumentsLoads.get().get("evt-bare")).toEqual({
      kind: "measured",
      documents: [],
    });
    setEventDocumentsReader(prev);
  });

  test("a record whose content does not parse keeps the RAW STRING it stored", async () => {
    const reader = scriptedReader([
      [projectedDocument("unparseable", "{not json")],
    ]);
    const prev = setEventDocumentsReader(reader);
    await loadEventDocuments("evt-2");
    const load = eventDocumentsLoads.get().get("evt-2");
    expect(load?.kind).toBe("measured");
    if (load?.kind !== "measured") throw new Error("unreachable");
    expect(load.documents).toEqual([projectedDocument("unparseable", "{not json")]);
    setEventDocumentsReader(prev);
  });

  test("a row without a name is the route's shape violation — dropped, not guessed into", async () => {
    // The reader contract returns EventDocument[]; the LIVE reader filters
    // nameless rows. The state owner's own promise: everything it lands has
    // a name. (Exercised through the live parse path below.)
    const reader = scriptedReader([[DOC]]);
    const prev = setEventDocumentsReader(reader);
    await loadEventDocuments("evt-3");
    const load = eventDocumentsLoads.get().get("evt-3");
    if (load?.kind !== "measured") throw new Error("unreachable");
    for (const doc of load.documents) {
      expect(typeof doc.name).toBe("string");
      expect(doc.name.length).toBeGreaterThan(0);
    }
    setEventDocumentsReader(prev);
  });
});

describe("failure and retry", () => {
  test("a transport failure is a stated failure — and reopening after it re-reads", async () => {
    const reader = scriptedReader([new Error("network down"), [DOC]]);
    const prev = setEventDocumentsReader(reader);
    await loadEventDocuments("evt-4");
    const failed = eventDocumentsLoads.get().get("evt-4");
    expect(failed?.kind).toBe("failed");
    if (failed?.kind !== "failed") throw new Error("unreachable");
    expect(failed.reason).toContain("network down");

    // The honest retry: a FAILED load is the one state that re-reads.
    await loadEventDocuments("evt-4");
    const measured = eventDocumentsLoads.get().get("evt-4");
    expect(measured).toEqual({ kind: "measured", documents: [DOC] });
    expect(reader.calls).toHaveLength(2);
    setEventDocumentsReader(prev);
  });

  test("an absent load does NOT re-read on reopen (absence is the door's answer)", async () => {
    const reader = scriptedReader([null]);
    const prev = setEventDocumentsReader(reader);
    await loadEventDocuments("evt-5");
    await loadEventDocuments("evt-5");
    expect(reader.calls).toHaveLength(1);
    setEventDocumentsReader(prev);
  });
});

describe("the reset", () => {
  test("the registry reset clears every fold's state — the next open reads again", async () => {
    const reader = scriptedReader([[DOC]]);
    const prev = setEventDocumentsReader(reader);
    await loadEventDocuments("evt-6");
    expect(eventDocumentsLoads.get().has("evt-6")).toBe(true);
    resetEventDocuments();
    expect(eventDocumentsLoads.get().has("evt-6")).toBe(false);
    await loadEventDocuments("evt-6");
    expect(reader.calls).toEqual(["evt-6", "evt-6"]);
    setEventDocumentsReader(prev);
  });

  test("a late answer for a fold whose store was reset mid-flight resurrects nothing", async () => {
    // A reader that answers AFTER the test resets the store: the load's
    // settlement must not re-create the entry the reset removed.
    const prev = setEventDocumentsReader(async () => {
      resetEventDocuments();
      return [DOC];
    });
    await loadEventDocuments("evt-7");
    expect(eventDocumentsLoads.get().has("evt-7")).toBe(false);
    setEventDocumentsReader(prev);
  });
});


test("the actual broker-backed reader preserves raw representations, digests and inline presence", async () => {
  const documents = [
    { name: "empty", contentJson: "", orderedJson: null, contentDigest: "empty-digest" },
    { name: "json-null", contentJson: "null", orderedJson: null, contentDigest: "null-digest" },
    { name: "ordered", contentJson: null, orderedJson: '{ "b": 2, "a": 1 }\n', contentDigest: "ordered-digest" },
    { name: "raw", contentJson: "before\u0000after\r\n", orderedJson: null, contentDigest: "raw-digest" },
    { name: "reference", contentJson: null, orderedJson: null, contentDigest: "reference-digest" },
  ];
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ documents: [...documents, { contentJson: "nameless" }] }), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
  const previous = setEventDocumentsReader(defaultReader);
  try {
    await loadEventDocuments("exact-documents");
    const load = eventDocumentsLoads.get().get("exact-documents");
    expect(load?.kind).toBe("measured");
    if (load?.kind !== "measured") throw new Error("Expected documents");
    expect(load.documents).toEqual(documents.map((doc, index) => ({ ...doc, content: ["", null, { b: 2, a: 1 }, "before\u0000after\r\n", null][index] })));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).toContain("/timeline/events/exact-documents");
  } finally { setEventDocumentsReader(previous); vi.unstubAllGlobals(); }
});
