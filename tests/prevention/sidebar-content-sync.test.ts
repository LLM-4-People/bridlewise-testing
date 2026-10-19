// @vitest-environment node
/**
 * Prevention test: main content area matches the sidebar
 * selection on any tab, any action.
 *
 * This test mechanically verifies the state-store invariants that enforce
 * sidebar/content sync:
 * 1. When a project is deleted, removeProject clears currentProjectId.
 * 2. When a project is deleted, removeChatsForProject clears the chats
 * for that project AND clears currentChatId if it belonged to it.
 * 3. When a chat is selected, currentChatId is set (so the content loads).
 * 4. When a project is selected, currentProjectId is set (so chats load).
 * 5. The client's deleteProject clears chats + messages.
 *
 * These are the pure-state invariants; the UI wiring (App.svelte effects)
 * is verified via the auto-reopen-last-chat prevention test + Chrome tests.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { bodyCalls, bodyCallsWith, functionBody } from "../helpers/function-scope.ts";
import {
  projects,
  currentProjectId,
  setProjects,
  removeProject,
  selectProject,
  resetProjects,
  type ProjectSummary,
} from "../../src/state/projects";
import {
  chatsSnapshot,
  currentChatId,
  setChats,
  removeChatsForProject,
  selectChat,
  resetChats,
  type ChatSummary,
} from "../../src/state/chats";

function mkProject(id: string, name = "P"): ProjectSummary {
  return { id, name, path: "/tmp/x", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
}
function mkChat(id: string, projectId: string, title = "C"): ChatSummary {
  return { id, projectId, title, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", modelId: null, pinned: false };
}

beforeEach(() => {
  resetProjects();
  resetChats();
});

describe("sidebar-content-sync", () => {
  it("selectProject sets currentProjectId", () => {
    setProjects([mkProject("p1")]);
    selectProject("p1");
    expect(currentProjectId.get()).toBe("p1");
  });

  it("removeProject clears currentProjectId when the removed project was selected", () => {
    setProjects([mkProject("p1"), mkProject("p2")]);
    selectProject("p1");
    removeProject("p1");
    expect(currentProjectId.get(), "selecting the deleted project must clear the selection").toBeNull();
    expect(projects.get().length).toBe(1);
  });

  it("selectChat sets currentChatId", () => {
    setChats([mkChat("c1", "p1")]);
    selectChat("c1");
    expect(currentChatId.get()).toBe("c1");
  });

  it("removeChatsForProject clears chats for that project", () => {
    setChats([mkChat("c1", "p1"), mkChat("c2", "p2"), mkChat("c3", "p1")]);
    removeChatsForProject("p1");
    const remaining = chatsSnapshot();
    expect(remaining.length, "p1 chats removed; p2 chat remains").toBe(1);
    expect(remaining[0]!.id).toBe("c2");
  });

  it("removeChatsForProject clears currentChatId if it belonged to the deleted project", () => {
    setChats([mkChat("c1", "p1"), mkChat("c2", "p2")]);
    selectChat("c1");
    removeChatsForProject("p1");
    expect(currentChatId.get(), "the deleted project's chat must be deselected").toBeNull();
  });

  it("removeChatsForProject does NOT clear currentChatId if it belonged to a different project", () => {
    setChats([mkChat("c1", "p1"), mkChat("c2", "p2")]);
    selectChat("c2");
    removeChatsForProject("p1");
    expect(currentChatId.get(), "a different project's chat must stay selected").toBe("c2");
  });

  it("deleteProject client source clears chats + messages + project", () => {
    const src = readFileSync(resolve(__dirname, "../../src/client.ts"), "utf8");
    // The three clear-calls are asked of deleteProject's OWN body, not of
    // seven hundred bytes after its name: the window this replaces counted
    // a call sitting in whichever function followed, and outgrew its budget
    // the day deleteProject's own body grew past it.
    const scope = functionBody(src, "deleteProject", "client deleteProject");
    expect(
      bodyCalls(scope, "removeChatsForProject"),
      "deleteProject must call removeChatsForProject",
    ).toBe(true);
    expect(
      bodyCallsWith(scope, "setMessages", ["[]"]),
      "deleteProject must clear the messages store",
    ).toBe(true);
    expect(
      bodyCalls(scope, "removeProject"),
      "deleteProject must call removeProject",
    ).toBe(true);
  });

  // (The three App.svelte wiring probes died with the old tree; the
  //  pure-state selection invariants above are the surviving subject.)
});
