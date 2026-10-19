// @vitest-environment node
/**
 * Prevention test: + — project/chat selection persists across
 * page refresh. On reload, the previously-selected project's chats auto-load
 * and the last active chat is restored (not "chats only load when I click").
 *
 * This test exercises the real persistence module + nanostores. In Node there
 * is no localStorage, so the helpers degrade to no-ops — the test installs a
 * mock localStorage to verify the save/restore cycle.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { atom } from "nanostores";
import {
  persistGet,
  persistSet,
  restoreStringAtom,
  bindAtomPersistence,
  restoreBooleanAtom,
  persistBooleanAtom,
} from "../../src/state/persistence";

// Minimal localStorage mock for Node.
class MockStorage {
  private store = new Map<string, string>();
  get length(): number { return this.store.size; }
  key(index: number): string | null { return [...this.store.keys()][index] ?? null; }
  getItem(k: string): string | null { return this.store.get(k) ?? null; }
  setItem(k: string, v: string): void { this.store.set(k, v); }
  removeItem(k: string): void { this.store.delete(k); }
  clear(): void { this.store.clear(); }
}

beforeEach(() => {
  (globalThis as { localStorage: Storage }).localStorage = new MockStorage();
});

afterEach(() => {
  (globalThis as { localStorage: Storage | undefined }).localStorage = undefined;
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
    (globalThis as { localStorage: Storage | undefined }).localStorage = undefined;
    expect(() => persistGet("x")).not.toThrow();
    expect(() => persistSet("x", "y")).not.toThrow();
    const a = atom<string | null>(null);
    expect(() => restoreStringAtom(a, "x")).not.toThrow();
    expect(() => bindAtomPersistence(a, "x")).not.toThrow();
    expect(a.get(), "no restore when storage absent").toBeNull();
  });
});
