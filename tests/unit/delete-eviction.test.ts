// @vitest-environment node
/**
 * Nearest-neighbor eviction tests.
 *
 * When the active chat/project is deleted, the selection must move to the
 * NEAREST remaining neighbor (the next one, or the previous if the deleted
 * was last) — not always the first. This keeps the user's place in the list
 * and ensures the main content area never references a
 * deleted entity.
 *
 * Mocks fetch (DELETE) so the store-mutation + selection logic is exercised in
 * isolation. Adversarial: delete the first / middle / last / only item.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

import { deleteChat, deleteProject } from "../../src/client";
import {
  chatsSnapshot,
  setChats,
  currentChatId,
  type ChatSummary,
} from "../../src/state/chats";
import {
  projects,
  currentProjectId,
  type ProjectSummary,
} from "../../src/state/projects";
import { messages, clearMessages } from "../../src/state/chat-messages";

const originalFetch = globalThis.fetch;

function mockDeleteOk(): void {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ deleted: true, id: "x" }),
  } as Response);
}

function chat(id: string, projectId: string, updatedAt = "2026-01-01T00:00:00Z"): ChatSummary {
  return { id, projectId, title: id, createdAt: updatedAt, updatedAt, modelId: null, pinned: false };
}

function project(id: string): ProjectSummary {
  return { id, name: id, path: `/${id}`, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
}

beforeEach(() => {
  clearMessages();
  mockDeleteOk();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("deleteChat — nearest-neighbor eviction", () => {
  test("deleting the middle chat selects the NEXT chat (not the first)", async () => {
    setChats([chat("c0", "p"), chat("c1", "p"), chat("c2", "p"), chat("c3", "p")]);
    currentChatId.set("c1");
    await deleteChat("c1");
    expect(currentChatId.get()).toBe("c2");
  });

  test("deleting the first chat selects the new first chat", async () => {
    setChats([chat("c0", "p"), chat("c1", "p"), chat("c2", "p")]);
    currentChatId.set("c0");
    await deleteChat("c0");
    expect(currentChatId.get()).toBe("c1");
  });

  test("deleting the LAST chat selects the PREVIOUS chat (clamped to last available)", async () => {
    setChats([chat("c0", "p"), chat("c1", "p"), chat("c2", "p")]);
    currentChatId.set("c2");
    await deleteChat("c2");
    expect(currentChatId.get()).toBe("c1");
  });

  test("deleting the ONLY chat clears the selection + messages (no neighbor available)", async () => {
    setChats([chat("solo", "p")]);
    currentChatId.set("solo");
    messages.set([{ id: "m1", role: "user", content: "hi", timestamp: 1 }]);
    await deleteChat("solo");
    expect(currentChatId.get()).toBeNull();
    expect(messages.get()).toHaveLength(0);
  });

  test("deleting a non-active chat does NOT change the active selection", async () => {
    setChats([chat("c0", "p"), chat("c1", "p"), chat("c2", "p")]);
    currentChatId.set("c2");
    await deleteChat("c0");
    expect(currentChatId.get()).toBe("c2");
  });

  test("the deleted chat is removed from the chats store", async () => {
    setChats([chat("c0", "p"), chat("c1", "p")]);
    currentChatId.set("c1");
    await deleteChat("c1");
    expect(chatsSnapshot().map((c) => c.id)).toEqual(["c0"]);
  });
});

describe("deleteProject — nearest-neighbor eviction", () => {
  test("deleting the middle project selects the NEXT project", async () => {
    projects.set([project("p0"), project("p1"), project("p2"), project("p3")]);
    currentProjectId.set("p2");
    // Also seed a chat belonging to p2 so the chats-clear path runs.
    setChats([chat("c-p2", "p2")]);
    await deleteProject("p2");
    expect(currentProjectId.get()).toBe("p3");
  });

  test("deleting the LAST project selects the PREVIOUS project", async () => {
    projects.set([project("p0"), project("p1"), project("p2")]);
    currentProjectId.set("p2");
    await deleteProject("p2");
    expect(currentProjectId.get()).toBe("p1");
  });

  test("deleting the ONLY project clears the selection", async () => {
    projects.set([project("solo")]);
    currentProjectId.set("solo");
    setChats([chat("c-solo", "solo")]);
    await deleteProject("solo");
    expect(currentProjectId.get()).toBeNull();
  });

  test("deleting a non-active project does NOT change the active selection", async () => {
    projects.set([project("p0"), project("p1")]);
    currentProjectId.set("p1");
    await deleteProject("p0");
    expect(currentProjectId.get()).toBe("p1");
  });

  test("the deleted project is removed + its chats are cleared from the store", async () => {
    projects.set([project("p0"), project("p1")]);
    currentProjectId.set("p1");
    setChats([chat("c1", "p1"), chat("c2", "p1"), chat("c-other", "p0")]);
    await deleteProject("p1");
    expect(projects.get().map((p) => p.id)).toEqual(["p0"]);
    // Chats for the deleted project are gone; other projects' chats remain.
    expect(chatsSnapshot().map((c) => c.id)).toEqual(["c-other"]);
  });
});
