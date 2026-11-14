// @vitest-environment node
/**
 * Prevention test: + — project/chat selection persists across
 * page refresh. On reload, the previously-selected project's chats auto-load
 * and the last active chat is restored (not "chats only load when I click").
 *
 * This test exercises the real persistence module + nanostores. In Node there
 * is no localStorage, so the helpers degrade to no-ops — the test installs the
 * shared in-memory Storage double to verify the save/restore cycle.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { atom } from "nanostores";
import {
  persistGet,
  persistSet,
  restoreStringAtom,
  bindAtomPersistence,
  restoreBooleanAtom,
  persistBooleanAtom,
} from "../../src/state/persistence";
import { MemoryStorage } from "../helpers/memory-storage.ts";

// Node has no localStorage; capture its exact entry descriptor so a file that
// installs a double can put the boundary back, including deleting the property
// when it was absent.
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const originalSessionStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");

beforeEach(() => {
  (globalThis as { localStorage: Storage }).localStorage = new MemoryStorage();
  (globalThis as unknown as { sessionStorage: Storage }).sessionStorage = new MemoryStorage();
});

afterEach(() => {
  if (originalSessionStorage === undefined) delete (globalThis as unknown as { sessionStorage?: Storage }).sessionStorage;
  else Object.defineProperty(globalThis, "sessionStorage", originalSessionStorage);
  if (originalLocalStorage === undefined) {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  } else {
    Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
  }
});

describe("selection-persistence", () => {
  it("persistSet / persistGet round-trip a value", () => {
    persistSet("projectId", "abc-123");
    expect(persistGet("projectId")).toBe("abc-123");
  });

  it("persistSet(null) removes the key", () => {
    persistSet("projectId", "abc");
    persistSet("projectId", null);
    expect(persistGet("projectId")).toBeNull();
  });

  it("restoreStringAtom restores a persisted value into an atom", () => {
    persistSet("currentProjectId", "proj-restored");
    const a = atom<string | null>(null);
    restoreStringAtom(a, "currentProjectId");
    expect(a.get()).toBe("proj-restored");
  });

  it("restoreStringAtom does nothing when nothing is persisted", () => {
    const a = atom<string | null>("default-id");
    restoreStringAtom(a, "currentProjectId");
    expect(a.get()).toBe("default-id");
  });

  it("bindAtomPersistence saves the atom value on every set", () => {
    const a = atom<string | null>(null);
    bindAtomPersistence(a, "currentChatId");
    a.set("chat-1");
    expect(persistGet("currentChatId")).toBe("chat-1");
    a.set("chat-2");
    expect(persistGet("currentChatId")).toBe("chat-2");
    a.set(null);
    expect(persistGet("currentChatId")).toBeNull();
  });

  it("restore + bind cycle simulates page refresh", () => {
    // Simulate page 1: select a project.
    const projectId = atom<string | null>(null);
    bindAtomPersistence(projectId, "currentProjectId");
    projectId.set("proj-A");

    // Simulate page refresh: new atom instances, restore from storage.
    const restoredProjectId = atom<string | null>(null);
    restoreStringAtom(restoredProjectId, "currentProjectId");
    expect(restoredProjectId.get(), "project selection must survive refresh").toBe("proj-A");

    // Simulate page 1: select a chat.
    const chatId = atom<string | null>(null);
    bindAtomPersistence(chatId, "currentChatId");
    chatId.set("chat-Z");

    // Simulate page refresh: restore chat selection.
    const restoredChatId = atom<string | null>(null);
    restoreStringAtom(restoredChatId, "currentChatId");
    expect(restoredChatId.get(), "chat selection must survive refresh").toBe("chat-Z");
  });

  it("boolean atoms persist and restore (UI layout)", () => {
    const panelOpen = atom<boolean>(true);
    persistBooleanAtom(panelOpen, "rightPanelOpen");
    restoreBooleanAtom(panelOpen, "rightPanelOpen");

    panelOpen.set(false);
    expect(persistGet("rightPanelOpen")).toBe("false");

    const restored = atom<boolean>(true);
    restoreBooleanAtom(restored, "rightPanelOpen");
    expect(restored.get(), "panel visibility must survive refresh").toBe(false);
  });

  it("helpers are safe when localStorage is absent (no throw)", () => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
    expect(() => persistGet("x")).not.toThrow();
    expect(() => persistSet("x", "y")).not.toThrow();
    const a = atom<string | null>(null);
    expect(() => restoreStringAtom(a, "x")).not.toThrow();
    expect(() => bindAtomPersistence(a, "x")).not.toThrow();
    expect(a.get(), "no restore when storage absent").toBeNull();
  });
});

describe("a public host selects one storage namespace before state loads", () => {
  it("preserves default exact addresses and keeps scoped logical/raw lanes disjoint", async () => {
    vi.resetModules();
    const normal = await import("../../src/state/persistence.ts");
    expect(normal.storageKeyFor("project")).toBe("bridlewise:project");
    expect(normal.rawStorageKeyFor("cockpit.sweep.marks.v1")).toBe("cockpit.sweep.marks.v1");
    expect(() => normal.selectPersistenceNamespace("late")).toThrowError(TypeError);
    expect(() => normal.selectPersistenceNamespace("late")).toThrowError(/already fixed/u);
    vi.resetModules();
    const scoped = await import("../../src/state/persistence.ts");
    expect(() => scoped.selectPersistenceNamespace("../unsafe")).toThrowError(/safe nonempty/u);
    for (const value of [null, 123, ["scope"]]) {
      expect(() => scoped.selectPersistenceNamespace(value as unknown as string)).toThrowError(TypeError);
      expect(() => scoped.selectPersistenceNamespace(value as unknown as string)).toThrowError(/safe nonempty/u);
    }
    scoped.selectPersistenceNamespace("public-test");
    expect(scoped.storageKeyFor("same")).not.toBe(scoped.rawStorageKeyFor("same"));
    expect(scoped.storageKeyFor("same")).toBe("bridlewise:scope:public-test:logical:same");
    expect(scoped.rawStorageKeyFor("same")).toBe("bridlewise:scope:public-test:raw:same");
    expect(() => scoped.selectPersistenceNamespace("other")).toThrowError(/already fixed/u);
    vi.resetModules();
  });

  it("scoped discovery and sweeps never restore or remove private values", async () => {
    vi.resetModules();
    const scoped = await import("../../src/state/persistence.ts");
    localStorage.setItem("bridlewise:chats:personal", "malformed-private-value");
    localStorage.setItem("bridlewise:currentProjectId", "private-project");
    scoped.selectPersistenceNamespace("public-sweep");
    scoped.persistJsonList("chats:example", [{ id: "example" }]);
    expect([...scoped.restoreJsonLists("chats:").entries()]).toEqual([["example", [{ id: "example" }]]]);
    expect(scoped.persistGet("currentProjectId")).toBeNull();
    expect(scoped.persistRemovePrefixed("chats:")).toBe(1);
    expect(localStorage.getItem("bridlewise:chats:personal")).toBe("malformed-private-value");
    expect(localStorage.getItem("bridlewise:currentProjectId")).toBe("private-project");
    scoped.persistSet("currentProjectId", "example-project");
    expect(scoped.persistGet("currentProjectId")).toBe("example-project");
    expect(localStorage.getItem("bridlewise:currentProjectId")).toBe("private-project");
    vi.resetModules();
  });
});

describe("a scoped browser tab preserves personal session values", () => {
  it("round-trips tab values, filters sweeps and passes logical keys to keep", async () => {
    vi.resetModules();
    const scope = await import("../../src/state/persistence.ts");
    sessionStorage.setItem("bridlewise:ws:private:focus", "private-focus");
    localStorage.setItem("bridlewise:currentChatId", "private-chat");
    scope.selectPersistenceNamespace("public-tab");
    scope.persistTabSet("currentChatId", "example-chat");
    expect(scope.persistTabGet("currentChatId")).toBe("example-chat");
    expect(scope.persistTabOnlySet("ws:keep:focus", "kept")).toBe(true);
    expect(scope.persistTabOnlySet("ws:drop:focus", "removed")).toBe(true);
    expect(scope.persistTabOnlyGet("ws:keep:focus")).toBe("kept");
    const seen: string[] = [];
    expect(scope.persistTabOnlyRemovePrefixed("ws:", key => { seen.push(key); return key === "ws:keep:focus"; })).toBe(1);
    expect(seen.sort()).toEqual(["ws:drop:focus", "ws:keep:focus"]);
    expect(scope.persistTabOnlyGet("ws:drop:focus")).toBeNull();
    expect(scope.persistTabOnlyGet("ws:keep:focus")).toBe("kept");
    expect(sessionStorage.getItem("bridlewise:ws:private:focus")).toBe("private-focus");
    expect(localStorage.getItem("bridlewise:currentChatId")).toBe("private-chat");
    vi.resetModules();
    const rawFirst = await import("../../src/state/persistence.ts");
    rawFirst.rawStorageKeyFor("legacy");
    expect(() => rawFirst.selectPersistenceNamespace("too-late")).toThrowError(TypeError);
    expect(() => rawFirst.selectPersistenceNamespace("too-late")).toThrowError(/already fixed/u);
    vi.resetModules();
  });
});
