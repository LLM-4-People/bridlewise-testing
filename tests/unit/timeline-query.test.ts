// @vitest-environment node
import { describe, test, expect, beforeEach } from "vitest";

import {
  timelineFilter,
  timelineResults,
  hasNext,
  timelineTotal,
  setFilter,
  ingestResults,
  appendResults,
  resetTimeline,
  scopedTimelineEvents,
  scopedTimelineTotal,
  timelineScope,
  setTimelineScope,
  type TimelineScope,
} from "../../src/state/timeline-query";
import type { TimelineEventSummariesResult, TimelineEventSummary } from "../../shared/types";

function makeEvent(eventId: string, runId: string | null, traceId: string | null = null): TimelineEventSummary {
  return {
    eventId,
    ledgerId: "l1",
    sequence: "1",
    recordKind: "observation",
    eventType: "tool",
    effectKind: null,
    effectId: null,
    observationId: null,
    outcome: "succeeded",
    wallTime: "2026-01-01T00:00:00Z",
    monotonicNanoseconds: null,
    traceId,
    spanId: null,
    parentEventId: null,
    actorKind: "agent",
    actorId: "a1",
    actorRole: null,
    runId,
    sessionId: null,
    turnId: null,
    messageId: null,
    taskId: null,
    attemptId: null,
    agentId: null,
    parentEffectId: null,
    intentHash: null,
    resultHash: null,
    evidenceHash: null,
    errorCategory: null,
    errorCode: null,
    errorMessage: null,
    errorRetryable: null,
    description: "",
    payloadRef: null,
    payloadDigest: null,
    previousChainHash: "0",
    chainHash: "1",
  };
}

describe("timeline-query store", () => {
  beforeEach(() => resetTimeline());

  test("initial state is empty", () => {
    expect(timelineFilter.get()).toEqual({});
    expect(timelineResults.get().events).toHaveLength(0);
    expect(hasNext.get()).toBe(false);
    expect(timelineTotal.get()).toBe(0);
  });

  test("setFilter replaces the filter", () => {
    setFilter({ runId: "r1", limit: 10 });
    expect(timelineFilter.get()).toEqual({ runId: "r1", limit: 10 });
  });

  test("ingestResults updates results, total, and hasNext", () => {
    const result: TimelineEventSummariesResult = {
      events: [makeEvent("e1", "r1")],
      total: 1,
      hasMore: true,
      nextCursor: "cursor-1",
    };
    ingestResults(result);
    expect(timelineResults.get().events).toHaveLength(1);
    expect(timelineTotal.get()).toBe(1);
    expect(hasNext.get()).toBe(true);
  });

  test("resetTimeline clears filter and results", () => {
    setFilter({ runId: "r1" });
    ingestResults({ events: [], total: 0, hasMore: false, nextCursor: null });
    resetTimeline();
    expect(timelineFilter.get()).toEqual({});
    expect(timelineTotal.get()).toBe(0);
  });

  // ── PREVENTION: timeline scope must filter for BOTH chat AND project ──
  // Regression: previously scopedTimelineEvents only filtered for "chat"
  // scope; "project" scope returned ALL events (from all projects). The
  // server now filters server-side via runIds, and the client-side
  // scopedTimelineEvents is a safety net that filters by runIds regardless
  // of scope kind. This test ensures project scope also filters.
  describe("scoped timeline events (prevention: project scope must filter)", () => {
    test("chat scope filters events to the scope's runIds", () => {
      // Set the scope BEFORE ingesting (production order: scope-then-query).
      // setTimelineScope evicts the raw cache on scope change so stale events
      // from the previous scope do not linger.
      setTimelineScope({
        kind: "chat",
        label: "chat-1",
        runIds: ["run-A"],
        chatId: "chat-1",
      });
      ingestResults({
        events: [makeEvent("e1", "run-A"), makeEvent("e2", "run-B"), makeEvent("e3", null)],
        total: 3,
        hasMore: false,
        nextCursor: null,
      });
      const scoped = scopedTimelineEvents.get();
      expect(scoped).toHaveLength(1);
      expect(scoped[0]!.eventId).toBe("e1");
      expect(scopedTimelineTotal.get()).toBe(1);
    });

    test("project scope ALSO filters events to the scope's runIds (regression)", () => {
      setTimelineScope({
        kind: "project",
        label: "proj-1",
        runIds: ["run-A", "run-B"],
        projectId: "proj-1",
      });
      ingestResults({
        events: [makeEvent("e1", "run-A"), makeEvent("e2", "run-B"), makeEvent("e3", "run-C")],
        total: 3,
        hasMore: false,
        nextCursor: null,
      });
      const scoped = scopedTimelineEvents.get();
      // Must NOT show run-C (the old bug showed ALL events for project scope).
      expect(scoped).toHaveLength(2);
      expect(scoped.map((e) => e.eventId).sort()).toEqual(["e1", "e2"]);
      expect(scopedTimelineTotal.get()).toBe(2);
    });

    test("global scope (no runIds) shows all events", () => {
      setTimelineScope({ kind: "global", label: "All events", runIds: [] });
      ingestResults({
        events: [makeEvent("e1", "run-A"), makeEvent("e2", "run-B")],
        total: 2,
        hasMore: false,
        nextCursor: null,
      });
      expect(scopedTimelineEvents.get()).toHaveLength(2);
      expect(scopedTimelineTotal.get()).toBe(2);
    });

    test("TimelineScope carries chatId and projectId for server-side filtering", () => {
      const chatScope: TimelineScope = {
        kind: "chat",
        label: "c",
        runIds: ["r1"],
        chatId: "chat-42",
      };
      setTimelineScope(chatScope);
      expect(timelineScope.get().chatId).toBe("chat-42");
      const projectScope: TimelineScope = {
        kind: "project",
        label: "p",
        runIds: [],
        projectId: "proj-42",
      };
      setTimelineScope(projectScope);
      expect(timelineScope.get().projectId).toBe("proj-42");
      const traceScope: TimelineScope = {
        kind: "trace",
        label: "one request's trace",
        runIds: [],
        traceId: "t-42",
      };
      setTimelineScope(traceScope);
      expect(timelineScope.get().traceId).toBe("t-42");
    });

    test("trace scope nets the streamed window by traceId (the run-pane trace filter)", () => {
      // The chain's rows carry the trace id; rows without it are OUT of the
      // trace — even run-attributed ones (a null traceId is never a member
      // of any trace). This is the client-side net for the band's fallback
      // window, mirroring what the runIds net does for chat/project.
      setTimelineScope({
        kind: "trace",
        label: "one request's trace",
        runIds: [],
        traceId: "t-1",
      });
      ingestResults({
        events: [
          makeEvent("e1", "run-A", "t-1"),
          makeEvent("e2", "run-A", null),
          makeEvent("e3", "run-A", "t-2"),
        ],
        total: 3,
        hasMore: false,
        nextCursor: null,
      });
      const scoped = scopedTimelineEvents.get();
      expect(scoped).toHaveLength(1);
      expect(scoped[0]!.eventId).toBe("e1");
      // A trace scope counts like a run-scoped one: the raw total is a
      // different population's (the global query's), so the badge count is
      // the netted window's own.
      expect(scopedTimelineTotal.get()).toBe(1);
    });

    test("a trace scope with an UNKNOWN trace id is a proven-empty window, not a leak", () => {
      setTimelineScope({
        kind: "trace",
        label: "one request's trace",
        runIds: [],
        traceId: "t-none",
      });
      ingestResults({
        events: [makeEvent("e1", "run-A", "t-1"), makeEvent("e2", "run-A", "t-2")],
        total: 2,
        hasMore: false,
        nextCursor: null,
      });
      expect(scopedTimelineEvents.get()).toHaveLength(0);
      expect(scopedTimelineTotal.get()).toBe(0);
    });
  });
});

describe("appendResults — paging keeps what is already loaded", () => {
  beforeEach(() => { resetTimeline(); });

  function page(
    events: readonly TimelineEventSummary[],
    nextCursor: string | null,
  ): TimelineEventSummariesResult {
    return { events, total: 10, hasMore: nextCursor !== null, nextCursor };
  }

  test("adds the new page to the existing events", () => {
    ingestResults(page([makeEvent("e1", "r1"), makeEvent("e2", "r1")], "2"));
    appendResults(page([makeEvent("e3", "r1")], null));
    expect(timelineResults.get().events.map((e) => e.eventId)).toEqual(["e1", "e2", "e3"]);
  });

  test("carries the page metadata forward", () => {
    ingestResults(page([makeEvent("e1", "r1")], "1"));
    appendResults(page([makeEvent("e2", "r1")], null));
    expect(hasNext.get()).toBe(false);
    expect(timelineResults.get().nextCursor).toBeNull();
    // The total describes the matching SET, so it must not shrink as the user
    // pages through it.
    expect(timelineTotal.get()).toBe(10);
  });

  test("never shows the same event twice", () => {
    // A page that arrives while a refresh is in flight can overlap. A repeated
    // event in a timeline is a phantom occurrence of something that happened
    // once.
    ingestResults(page([makeEvent("e1", "r1"), makeEvent("e2", "r1")], "2"));
    appendResults(page([makeEvent("e2", "r1"), makeEvent("e3", "r1")], null));
    expect(timelineResults.get().events.map((e) => e.eventId)).toEqual(["e1", "e2", "e3"]);
  });
});

describe("the scope owns the filter's scope keys", () => {
  beforeEach(() => { resetTimeline(); });

  test("a scope change strips the previous scope's chatId from the standing filter — the next refresh re-derives it", () => {
    setFilter({ chatId: "chat-old", limit: 200 });
    setTimelineScope({
      kind: "chat",
      label: "the new chat",
      runIds: ["r-new"],
      chatId: "chat-new",
    } satisfies TimelineScope);
    const standing = timelineFilter.get();
    expect(standing.chatId).toBeUndefined();
    expect(standing.limit).toBe(200);
  });

  test("a filter with no scope keys passes a scope change through untouched", () => {
    setFilter({ eventType: "tool", limit: 200 });
    setTimelineScope({
      kind: "chat",
      label: "a chat",
      runIds: ["r1"],
      chatId: "c1",
    } satisfies TimelineScope);
    expect(timelineFilter.get()).toEqual({ eventType: "tool", limit: 200 });
  });
});
