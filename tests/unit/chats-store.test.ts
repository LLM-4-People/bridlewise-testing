// @vitest-environment node
import { describe, test, expect, beforeEach, vi } from "vitest";

import {
  chatsSnapshot,
  currentChatId,
  currentChat,
  projectChatsFor,
  chatCount,
  setChats,
  addChat,
  chatForId,
  updateChatInStore,
  removeChat,
  replaceChatsForProject,
  selectChat,
  resetChats,
  type ChatSummary,
} from "../../src/state/chats";

function makeChat(overrides: Partial<ChatSummary> = {}): ChatSummary {
  return {
    id: `chat-${Math.random().toString(36).slice(2)}`,
    projectId: "p1",
    title: "test",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    modelId: null,
    pinned: false,
    ...overrides,
  };
}

describe("chats store", () => {
  beforeEach(() => resetChats());

  test("initial state is empty with no current chat", () => {
    expect(chatsSnapshot()).toHaveLength(0);
    expect(currentChatId.get()).toBeNull();
    expect(currentChat.get()).toBeNull();
    expect(chatCount.get()).toBe(0);
  });

  test("setChats populates the list and count", () => {
    setChats([makeChat({ id: "c1" }), makeChat({ id: "c2" })]);
    expect(chatsSnapshot()).toHaveLength(2);
    expect(chatCount.get()).toBe(2);
  });

  test("addChat appends without mutating the previous array", () => {
    setChats([makeChat({ id: "c1" })]);
    const before = chatsSnapshot();
    addChat(makeChat({ id: "c2" }));
    expect(chatsSnapshot()).toHaveLength(2);
    expect(before).toHaveLength(1);
  });

  test("selectChat sets currentChatId and currentChat resolves", () => {
    setChats([makeChat({ id: "c1", title: "alpha" })]);
    selectChat("c1");
    expect(currentChatId.get()).toBe("c1");
    expect(currentChat.get()?.title).toBe("alpha");
  });

  test("currentChat is null when id does not match", () => {
    setChats([makeChat({ id: "c1" })]);
    selectChat("nope");
    expect(currentChat.get()).toBeNull();
  });

  test("selectChat(null) clears selection", () => {
    setChats([makeChat({ id: "c1" })]);
    selectChat("c1");
    selectChat(null);
    expect(currentChatId.get()).toBeNull();
    expect(currentChat.get()).toBeNull();
  });

  test("project lookups group chats by projectId", () => {
    setChats([
      makeChat({ id: "c1", projectId: "p1" }),
      makeChat({ id: "c2", projectId: "p1" }),
      makeChat({ id: "c3", projectId: "p2" }),
    ]);
    expect(projectChatsFor("p1").map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(projectChatsFor("p2").map((c) => c.id)).toEqual(["c3"]);
    expect(projectChatsFor("p3")).toEqual([]);
  });

  test("replaceChatsForProject replaces only that project's chats", () => {
    setChats([
      makeChat({ id: "c1", projectId: "p1" }),
      makeChat({ id: "c2", projectId: "p2" }),
    ]);
    replaceChatsForProject("p1", [makeChat({ id: "c-new", projectId: "p1" })]);
    const list = chatsSnapshot();
    expect(list.map((c) => c.id).sort()).toEqual(["c-new", "c2"]);
    expect(list.find((c) => c.id === "c-new")?.projectId).toBe("p1");
  });

  test("replaceChatsForProject with an empty list removes all of that project's chats", () => {
    setChats([
      makeChat({ id: "c1", projectId: "p1" }),
      makeChat({ id: "c2", projectId: "p2" }),
    ]);
    replaceChatsForProject("p1", []);
    expect(chatsSnapshot().map((c) => c.id)).toEqual(["c2"]);
  });
});


describe("project completion work and immutable snapshots", () => {
  test("a held snapshot never subscribes to later unrelated completions", () => {
    const population = Array.from({ length: 1000 }, (_, i) => makeChat({ id: `c${i}`, projectId: `p${i}` }));
    setChats(population);
    const held = chatsSnapshot();
    const heldProject = projectChatsFor("p0");
    const materialize = vi.spyOn(Array, "from");
    let calls;
    try {
      for (let i = 0; i < population.length; i++) {
        replaceChatsForProject(`p${i}`, [{ ...population[i]!, title: `answer ${i}` }]);
      }
      calls = materialize.mock.calls.length;
    } finally { materialize.mockRestore(); }
    expect(calls, "completions must not rebuild a demanded whole-list snapshot").toBe(0);
    expect(held).toHaveLength(1000);
    expect(held[0]!.title).toBe("test");
    expect(heldProject[0]!.title).toBe("test");
    expect(chatsSnapshot()).toHaveLength(1000);
    expect(chatForId("c999")?.title).toBe("answer 999");
  });

  test.each(["__proto__", "constructor", "toString", "a\0b", "非ASCII"])("opaque project/chat identity %s is a normal key", id => {
    const incoming = [makeChat({ id, projectId: id })];
    replaceChatsForProject(id, incoming);
    incoming.push(makeChat({ id: "not ingested", projectId: id }));
    expect(projectChatsFor(id)).toHaveLength(1);
    selectChat(id);
    const held = projectChatsFor(id);
    updateChatInStore(id, { title: "renamed" });
    expect(currentChat.get()?.title).toBe("renamed");
    expect(held[0]!.title).toBe("test");
    removeChat(id);
    expect(chatForId(id)).toBeNull();
    expect(currentChatId.get()).toBeNull();
  });
});
