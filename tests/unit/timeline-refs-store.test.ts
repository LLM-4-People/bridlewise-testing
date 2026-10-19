// @vitest-environment node
import { describe, test, expect, beforeEach } from "vitest";

import {
  timelineRefs,
  currentTimelineChatId,
  timelineRefCount,
  setTimelineRefs,
  appendTimelineRef,
  setCurrentTimelineChatId,
  resetTimelineRefs,
  type TimelineRef,
} from "../../src/state/timeline-refs";

function makeRef(overrides: Partial<TimelineRef> = {}): TimelineRef {
  return {
    id: `ref-${Math.random().toString(36).slice(2)}`,
    chatId: "c1",
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    eventType: "tool",
    timestamp: new Date().toISOString(),
    metadata: {},
    ...overrides,
  };
}

describe("timeline-refs store", () => {
  beforeEach(() => resetTimelineRefs());

  test("initial state is empty", () => {
    expect(timelineRefs.get()).toHaveLength(0);
    expect(currentTimelineChatId.get()).toBeNull();
    expect(timelineRefCount.get()).toBe(0);
  });

  test("setTimelineRefs replaces the list", () => {
    setTimelineRefs([makeRef({ id: "r1" }), makeRef({ id: "r2" })]);
    expect(timelineRefs.get()).toHaveLength(2);
    expect(timelineRefCount.get()).toBe(2);
  });

  test("appendTimelineRef appends a single ref", () => {
    setTimelineRefs([makeRef({ id: "r1" })]);
    appendTimelineRef(makeRef({ id: "r2" }));
    expect(timelineRefs.get()).toHaveLength(2);
  });

  test("setCurrentTimelineChatId sets the current chat scope", () => {
    setCurrentTimelineChatId("chat-42");
    expect(currentTimelineChatId.get()).toBe("chat-42");
  });

  test("resetTimelineRefs clears the list and scope", () => {
    setTimelineRefs([makeRef({ id: "r1" })]);
    setCurrentTimelineChatId("c1");
    resetTimelineRefs();
    expect(timelineRefs.get()).toHaveLength(0);
    expect(currentTimelineChatId.get()).toBeNull();
  });
});
