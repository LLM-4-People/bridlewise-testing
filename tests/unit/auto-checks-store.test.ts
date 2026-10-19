// @vitest-environment node
import { describe, test, expect, beforeEach } from "vitest";

import {
  autoChecks,
  autoChecksProjectId,
  autoChecksChatId,
  checksForCurrentProject,
  checksForCurrentChat,
  autoCheckCount,
  setAutoChecks,
  addAutoCheck,
  upsertAutoChecks,
  setAutoChecksScope,
  resetAutoChecks,
  type AutoCheck,
} from "../../src/state/auto-checks";

function makeCheck(overrides: Partial<AutoCheck> = {}): AutoCheck {
  return {
    id: `chk-${Math.random().toString(36).slice(2)}`,
    projectId: "p1",
    chatId: null,
    checkName: "typecheck",
    status: "passed",
    output: {},
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("auto-checks store", () => {
  beforeEach(() => resetAutoChecks());

  test("initial state is empty with no scope", () => {
    expect(autoChecks.get()).toHaveLength(0);
    expect(autoChecksProjectId.get()).toBeNull();
    expect(autoChecksChatId.get()).toBeNull();
    expect(autoCheckCount.get()).toBe(0);
  });

  test("setAutoChecks populates the list", () => {
    setAutoChecks([makeCheck({ id: "c1" }), makeCheck({ id: "c2" })]);
    expect(autoChecks.get()).toHaveLength(2);
    expect(autoCheckCount.get()).toBe(2);
  });

  test("addAutoCheck appends a single check", () => {
    setAutoChecks([makeCheck({ id: "c1" })]);
    addAutoCheck(makeCheck({ id: "c2" }));
    expect(autoChecks.get()).toHaveLength(2);
  });

  test("setAutoChecksScope updates both project and chat scope", () => {
    setAutoChecksScope("p1", "c1");
    expect(autoChecksProjectId.get()).toBe("p1");
    expect(autoChecksChatId.get()).toBe("c1");
  });

  test("checksForCurrentProject filters by the scoped project id", () => {
    setAutoChecks([
      makeCheck({ id: "c1", projectId: "p1" }),
      makeCheck({ id: "c2", projectId: "p2" }),
    ]);
    setAutoChecksScope("p1", null);
    expect(checksForCurrentProject.get().map((c) => c.id)).toEqual(["c1"]);
  });

  test("checksForCurrentProject is empty when no project is scoped", () => {
    setAutoChecks([makeCheck({ id: "c1", projectId: "p1" })]);
    setAutoChecksScope(null, null);
    expect(checksForCurrentProject.get()).toHaveLength(0);
  });

  test("checksForCurrentChat filters by the scoped chat id", () => {
    setAutoChecks([
      makeCheck({ id: "c1", chatId: "ch1" }),
      makeCheck({ id: "c2", chatId: "ch2" }),
      makeCheck({ id: "c3", chatId: null }),
    ]);
    setAutoChecksScope("p1", "ch1");
    expect(checksForCurrentChat.get().map((c) => c.id)).toEqual(["c1"]);
  });

  test("upsertAutoChecks replaces entries with the same id (no duplicates)", () => {
    setAutoChecks([makeCheck({ id: "c1", status: "running" })]);
    upsertAutoChecks([makeCheck({ id: "c1", status: "passed" }), makeCheck({ id: "c2", status: "failed" })]);
    const list = autoChecks.get();
    expect(list).toHaveLength(2);
    expect(list.find((c) => c.id === "c1")?.status).toBe("passed");
  });

  test("resetAutoChecks clears both the list and the scope", () => {
    setAutoChecks([makeCheck({ id: "c1" })]);
    setAutoChecksScope("p1", "c1");
    resetAutoChecks();
    expect(autoChecks.get()).toHaveLength(0);
    expect(autoChecksProjectId.get()).toBeNull();
    expect(autoChecksChatId.get()).toBeNull();
  });
});
