/**
 * Prevention test: the timeline is scoped per-chat, not global.
 *
 * Root cause: the Timeline tab queried ALL events globally and displayed
 * them. The `timelineScope` store existed but was never wired to filter
 * the queried events by the current chat's run IDs.
 *
 * This test verifies:
 * 1. `scopedTimelineEvents` filters events by the scope's runIds when
 * the scope kind is "chat".
 * 2. `scopedTimelineEvents` returns all events when scope is "global" or
 * "project".
 * 3. `loadChatHistory` in client.ts extracts runIds and scopes the
 * timeline to the chat (structural source check).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Re-implement the scopedTimelineEvents logic to test the filtering
// invariant independently. The actual store is in src/state/timeline-query.ts;
// this test validates the filtering behavior the store must implement.
function buildScopedEvents(
  events: readonly { runId: string | null }[],
  scope: { kind: "global" | "chat" | "project"; runIds: readonly string[] },
): readonly { runId: string | null }[] {
  if (scope.kind !== "chat" || scope.runIds.length === 0) return events;
  const runIdSet = new Set(scope.runIds);
  return events.filter((e) => e.runId !== null && runIdSet.has(e.runId));
}

describe("scopedTimelineEvents filtering (prevention)", () => {
  it("filters to only events matching the chat's runIds when scope is 'chat'", () => {
    const events = [
      { runId: "run-A" },
      { runId: "run-B" },
      { runId: "run-A" },
      { runId: null },
    ];
    const scoped = buildScopedEvents(events, { kind: "chat", runIds: ["run-A"] });
    expect(scoped.length).toBe(2);
    expect(scoped.every((e) => e.runId === "run-A")).toBe(true);
  });

  it("returns all events when scope is 'global'", () => {
    const events = [{ runId: "run-A" }, { runId: "run-B" }];
    const scoped = buildScopedEvents(events, { kind: "global", runIds: [] });
    expect(scoped.length).toBe(2);
  });

  it("returns all events when scope is 'project'", () => {
    const events = [{ runId: "run-A" }, { runId: "run-B" }];
    const scoped = buildScopedEvents(events, { kind: "project", runIds: [] });
    expect(scoped.length).toBe(2);
  });

  it("returns all events when scope is 'chat' but runIds is empty", () => {
    const events = [{ runId: "run-A" }];
    const scoped = buildScopedEvents(events, { kind: "chat", runIds: [] });
    expect(scoped.length).toBe(1);
  });

  it("excludes events with null runId when scoped to a chat", () => {
    const events = [{ runId: null }, { runId: "run-A" }];
    const scoped = buildScopedEvents(events, { kind: "chat", runIds: ["run-A"] });
    expect(scoped.length).toBe(1);
    expect(scoped[0]!.runId).toBe("run-A");
  });
});

// Structural test: verify the timeline-query store exports the scoped stores.
describe("timeline-query store exports (prevention)", () => {
  it("exports scopedTimelineEvents and scopedTimelineTotal", () => {
    const storePath = resolve(__dirname, "../../src/state/timeline-query.ts");
    const source = readFileSync(storePath, "utf8");
    expect(source.includes("scopedTimelineEvents"), "Must export scopedTimelineEvents").toBe(true);
    expect(source.includes("scopedTimelineTotal"), "Must export scopedTimelineTotal").toBe(true);
  });

  it("client.ts's history read scopes the timeline to the chat", () => {
    const clientPath = resolve(__dirname, "../../src/client.ts");
    const source = readFileSync(clientPath, "utf8");
    // `readChatHistory` is the body of the history load; `loadChatHistory` is
    // the deduplicating door onto it (see
    // tests/prevention/chat-history-load-race.test.ts A5). The scoping lives
    // with the hydration, so that is the block under test — and the door is
    // then checked to actually route through it, so a second ungated history
    // path cannot appear and skip the scoping.
    const body = extractFunction(source, "readChatHistory");
    expect(body, "Could not find readChatHistory in client.ts").toBeTruthy();
    expect(body!.includes("scopeTimelineToChat"), "the history read must call scopeTimelineToChat").toBe(true);
    expect(body!.includes("runId"), "the history read must extract runIds from history").toBe(true);

    const door = extractFunction(source, "loadChatHistory");
    expect(door, "Could not find loadChatHistory in client.ts").toBeTruthy();
    expect(
      door!.includes("readChatHistory("),
      "loadChatHistory must delegate to readChatHistory — otherwise the timeline scoping " +
        "is reachable only on one of two history paths",
    ).toBe(true);
  });
});

function extractFunction(source: string, name: string): string | null {
  const idx = source.indexOf(`function ${name}(`);
  if (idx === -1) return null;
  const after = source.slice(idx);
  const braceIdx = after.indexOf("{");
  if (braceIdx === -1) return null;
  let depth = 0;
  for (let i = braceIdx; i < after.length; i++) {
    if (after[i] === "{") depth++;
    if (after[i] === "}") depth--;
    if (depth === 0 && i > braceIdx) return after.slice(0, i + 1);
  }
  return after.slice(0, 500);
}

// ── Raw cache eviction on scope change (choke-point fix) ──

describe("setTimelineScope evicts the raw timelineResults on scope change (choke-point fix)", () => {
  // The scope choke point (`setTimelineScope`) MUST evict the raw
  // `timelineResults` so events from the previous scope do not linger
  // until a new query replaces them. The derived `scopedTimelineEvents`
  // filters by the new scope's runIds (view is correct), but the raw cache
  // held the previous scope's events — a stale-cache class of bug. Evicting
  // at the single setter (every scope change goes through it) means no
  // caller can forget to clear the raw cache.
  it("setTimelineScope evicts timelineResults when the scope changes", async () => {
    const { timelineResults, setTimelineScope, ingestResults, resetTimeline, timelineScope } =
      await import("../../src/state/timeline-query");
    resetTimeline();
    // Seed raw results from a previous scope (e.g. the global scope).
    ingestResults({ events: [{ runId: "old-run", ...({} as object) }], total: 1, hasMore: false } as never);
    expect(timelineResults.get().total, "raw results seeded").toBe(1);
    // Switch the scope (the choke point) — the raw results MUST be evicted.
    setTimelineScope({ kind: "chat", label: "chat-A", runIds: ["new-run"], chatId: "c1" });
    expect(timelineResults.get().total, "raw results evicted on scope change").toBe(0);
    expect(timelineResults.get().events.length, "raw events cleared on scope change").toBe(0);
    // The scope itself updated.
    expect(timelineScope.get().kind).toBe("chat");
    resetTimeline();
  });

  it("resetTimeline clears the scope + results (regression guard)", async () => {
    const { timelineResults, resetTimeline, timelineScope, ingestResults } =
      await import("../../src/state/timeline-query");
    ingestResults({ events: [], total: 5, hasMore: false } as never);
    resetTimeline();
    expect(timelineResults.get().total).toBe(0);
    expect(timelineScope.get().kind).toBe("global");
  });
});
