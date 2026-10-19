// @vitest-environment jsdom
/**
 * THE WORKSPACE SPLIT — "what I am working on" must not be shared, and "how I
 * like the cockpit" must be.
 *
 * The defect being guarded: `currentProjectId`/`currentChatId` were a single
 * localStorage slot every browser tab wrote. Two tabs on different projects
 * overwrote each other on every selection and neither noticed; the tab you
 * touched last won. This suite proves the split holds in both directions at
 * once, which is the property that actually matters — a fix that stopped the
 * conversation travelling but also stopped the THEME travelling would have
 * traded one silent divergence for another.
 *
 * Two workspace contexts are simulated in one process (the workspace API is
 * the unit; a browser tab is just a page holding a list of them). No browser
 * is involved and none is needed: every claim here is about which slot a value
 * lands in and which subscriber sees it.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";

import { storageKeyFor, persistTabGet, persistTabSet } from "../../src/state/persistence";
import { cockpitTheme } from "../../src/cockpit/settings/local-prefs";
import { currentProjectId, selectProject } from "../../src/state/projects";
import { currentChatId, selectChat } from "../../src/state/chats";
import {
  workspaces,
  activeWorkspaceId,
  activeWorkspace,
  openWorkspace,
  activateWorkspace,
  closeWorkspace,
  restoreWorkspaces,
  resetWorkspaces,
  workspaceScopedKey,
  workspaceLabel,
  parseWorkspaces,
} from "../../src/state/workspaces";
import { noteShellView } from "../../src/cockpit/shell/workspace-view";
import { bindFlowView, noteFlowView } from "../../src/cockpit/flow/flow-view";
import { walk, relpath } from "../helpers/source-scan.ts";
import { lexSpans } from "../../engine/scripts/verification/source-view.ts";

/** The one file allowed to spell the workspace-scope prefix. Everything
 * else must build its keys through the owner's doors
 * (`workspaceScopedKey` / `workspaceScopedKeyFor`) — a hand-spelled
 * `ws:` template is a second source of truth that silently rots the day
 * the shape changes (the flow's outgoing-tab mirror carried exactly such
 * a spelling). */
const WS_PREFIX_OWNER = "src/state/workspaces.ts";

function foreignPrefixed(logicalKey: string, value: string | null): void {
  const raw = storageKeyFor(logicalKey);
  if (value === null) window.localStorage.removeItem(raw);
  else window.localStorage.setItem(raw, value);
  window.dispatchEvent(
    new StorageEvent("storage", { key: raw, newValue: value, storageArea: window.localStorage }),
  );
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  resetWorkspaces();
});

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("workspace split", () => {
  describe("a page holds several workspaces, each with its own conversation", () => {
    it("two workspaces keep different projects; switching back restores the first", () => {
      const a = activeWorkspaceId.get()!;
      selectProject("project-a");
      selectChat("chat-a");

      const b = openWorkspace();
      // A `+` opens EMPTY — it does not clone what you were already looking
      // at, which would give two tabs claiming the same work.
      expect(currentProjectId.get()).toBeNull();
      expect(currentChatId.get()).toBeNull();

      selectProject("project-b");
      selectChat("chat-b");

      activateWorkspace(a);
      expect(currentProjectId.get()).toBe("project-a");
      expect(currentChatId.get()).toBe("chat-a");

      activateWorkspace(b.id);
      expect(currentProjectId.get()).toBe("project-b");
      expect(currentChatId.get()).toBe("chat-b");
    });

    it("selecting in one workspace does not touch another's record", () => {
      const a = activeWorkspaceId.get()!;
      selectProject("project-a");
      const b = openWorkspace({ projectId: "project-b" });
      selectProject("project-b-renamed");

      const recordA = workspaces.get().find((w) => w.id === a);
      const recordB = workspaces.get().find((w) => w.id === b.id);
      expect(recordA?.projectId).toBe("project-a");
      expect(recordB?.projectId).toBe("project-b-renamed");
    });

    it("per-workspace view state gets its own key, so no workspace inherits another's view", () => {
      const a = activeWorkspaceId.get()!;
      const keyA = workspaceScopedKey("openRoom");
      openWorkspace();
      const keyB = workspaceScopedKey("openRoom");

      expect(keyA).not.toBeNull();
      expect(keyB).not.toBeNull();
      expect(keyA).not.toBe(keyB);
      expect(keyA).toContain(a);
    });

    it("closing the active workspace activates its neighbour rather than blanking", () => {
      const a = activeWorkspaceId.get()!;
      selectProject("project-a");
      const b = openWorkspace({ projectId: "project-b" });

      expect(closeWorkspace(b.id)).toBe(true);
      expect(activeWorkspaceId.get()).toBe(a);
      expect(currentProjectId.get()).toBe("project-a");
    });

    it("the last workspace cannot be closed — there would be nothing to render", () => {
      expect(workspaces.get().length).toBe(1);
      expect(closeWorkspace(activeWorkspaceId.get()!)).toBe(false);
      expect(workspaces.get().length).toBe(1);
    });

    it("an unknown workspace id is refused rather than clearing the active one", () => {
      selectProject("project-a");
      expect(activateWorkspace("ws-does-not-exist")).toBe(false);
      expect(currentProjectId.get()).toBe("project-a");
    });
  });

  // ── THE CLOSE IS TERMINAL FOR THE SCOPED KEYS (UIE-058) ──────────────────
  //
  // A workspace's per-view mirrors (the shell's room/desk, the flow's
  // scroll/focus/expansion) are written through `workspaceScopedKey` into
  // this TAB's sessionStorage — the reload mirror. Closing a workspace drops
  // its id from the list forever, so its mirrors are dead keys claiming
  // per-view state exists for a workspace the strip no longer names. The
  // close path sweeps them BY PREFIX (never a list of key names), so every
  // per-view owner — including one added after the sweep was written — is
  // cleaned up with everything else.
  describe("a close is terminal for the workspace's scoped keys", () => {
    /** Enumerate this tab's raw session keys under a LOGICAL prefix —
     * deny-by-default: the whole prefix is judged, not named keys. */
    function sessionKeysUnder(logicalPrefix: string): string[] {
      const raw = storageKeyFor(logicalPrefix);
      const out: string[] = [];
      for (let i = 0; i < window.sessionStorage.length; i += 1) {
        const k = window.sessionStorage.key(i);
        if (k !== null && k.startsWith(raw)) out.push(k);
      }
      return out;
    }

    /** Write REAL per-view mirrors for the ACTIVE workspace through the
     * owning writers, exactly as the shell and the flow do. */
    function noteRealViews(): void {
      noteShellView({ room: "switch", inspector: "setup" });
      noteFlowView({ scrollTop: 344, focusedId: null, expanded: { "b-1": true }, follow: true });
    }

    it("closing the ACTIVE workspace sweeps its scoped keys — after the activation's own mirror writes", () => {
      const a = activeWorkspaceId.get()!;
      noteRealViews();
      const b = openWorkspace();
      noteRealViews();
      // The REAL flow binder is live: handing the screen to the neighbour
      // records the OUTGOING workspace's last view, which re-writes its
      // mirrors — the sweep must run after that, or it is re-dirtied.
      const unbind = bindFlowView(
        () => undefined,
        () => ({ scrollTop: 12, focusedId: "x", expanded: {}, follow: false }),
      );

      expect(closeWorkspace(b.id)).toBe(true);
      unbind();

      expect(sessionKeysUnder(`ws:${b.id}:`), "the closed id can never be named again").toHaveLength(0);
      // The neighbour's mirrors stand untouched — the sweep cut at the id.
      expect(sessionKeysUnder(`ws:${a}:`).length).toBeGreaterThan(0);
      expect(window.sessionStorage.getItem(storageKeyFor(`ws:${a}:shell-view`))).toContain("switch");
      expect(window.sessionStorage.getItem(storageKeyFor(`ws:${a}:flow:scroll`))).toBe("344");
      // The strip's own list keys are not workspace-scoped and must survive.
      expect(window.sessionStorage.getItem(storageKeyFor("workspaces"))).not.toBeNull();
      expect(window.sessionStorage.getItem(storageKeyFor("workspaces:active"))).not.toBeNull();
    });

    it("closing a BACKGROUND workspace sweeps its keys and leaves the active one's alone", () => {
      const a = activeWorkspaceId.get()!;
      noteRealViews();
      const b = openWorkspace();
      noteRealViews();
      activateWorkspace(a);

      expect(closeWorkspace(b.id)).toBe(true);

      expect(sessionKeysUnder(`ws:${b.id}:`)).toHaveLength(0);
      expect(sessionKeysUnder(`ws:${a}:`).length).toBeGreaterThan(0);
    });

    it("sign-out sweeps every open workspace's keys — all of them close at once", () => {
      const a = activeWorkspaceId.get()!;
      noteRealViews();
      const b = openWorkspace();
      noteRealViews();

      resetWorkspaces();

      expect(sessionKeysUnder(`ws:${a}:`)).toHaveLength(0);
      expect(sessionKeysUnder(`ws:${b}:`)).toHaveLength(0);
      // The fresh sign-in workspace starts with no mirrors of its own.
      expect(sessionKeysUnder(`ws:${activeWorkspaceId.get()!}:`)).toHaveLength(0);
    });

    it("a reload-restore KEEPS the listed workspaces' keys — the sweep is for the closed only", () => {
      const a = activeWorkspaceId.get()!;
      noteRealViews();
      const b = openWorkspace();
      noteRealViews();

      // The reload: memory gone, the tab's session storage stands.
      const kept = window.sessionStorage.getItem(storageKeyFor("workspaces"))!;
      workspaces.set([]);
      activeWorkspaceId.set(null);
      window.sessionStorage.setItem(storageKeyFor("workspaces"), kept);
      restoreWorkspaces();

      expect(workspaces.get().map((w) => w.id)).toContain(a);
      expect(workspaces.get().map((w) => w.id)).toContain(b.id);
      expect(sessionKeysUnder(`ws:${a}:`).length, "the listed workspaces' mirrors restore").toBeGreaterThan(0);
      expect(sessionKeysUnder(`ws:${b.id}:`).length).toBeGreaterThan(0);
    });

    it("an UNUSABLE stored list sweeps its dead scoped keys — the ids can never be named again", () => {
      const a = activeWorkspaceId.get()!;
      noteRealViews();

      window.sessionStorage.setItem(storageKeyFor("workspaces"), "[[[");
      workspaces.set([]);
      activeWorkspaceId.set(null);
      restoreWorkspaces();

      expect(sessionKeysUnder("ws:")).toHaveLength(0);
      expect(a).toBeTruthy();
    });

    it("a restore with a VALID list sweeps residue of ids the list cannot name (the pre-fix orphans)", () => {
      const a = activeWorkspaceId.get()!;
      noteRealViews();
      const b = openWorkspace();
      noteRealViews();

      // A closed-before-the-fix workspace: its id is in NO list, but its
      // mirrors are still in the tab's store (the residue the live drive
      // measured — dead ids riding the session store forever).
      const deadPrefix = `ws:ws-dead-from-an-old-session:`;
      window.sessionStorage.setItem(storageKeyFor(`${deadPrefix}shell-view`), "{}");
      window.sessionStorage.setItem(storageKeyFor(`${deadPrefix}flow:scroll`), "99");

      // The reload: memory gone, the list (a + b) stands, the dead id is
      // not in it.
      const kept = window.sessionStorage.getItem(storageKeyFor("workspaces"))!;
      workspaces.set([]);
      activeWorkspaceId.set(null);
      window.sessionStorage.setItem(storageKeyFor("workspaces"), kept);
      restoreWorkspaces();

      expect(sessionKeysUnder(deadPrefix)).toHaveLength(0);
      expect(sessionKeysUnder(`ws:${a}:`).length, "the listed workspaces' mirrors restore").toBeGreaterThan(0);
      expect(sessionKeysUnder(`ws:${b.id}:`).length).toBeGreaterThan(0);
    });
  });

  describe("persistence: per browser tab, seeded from the shared value", () => {
    it("a selection is kept for THIS tab and refreshes the shared seed", () => {
      selectChat("chat-here");
      expect(window.sessionStorage.getItem(storageKeyFor("currentChatId"))).toBe("chat-here");
      // The seed is what a brand-new browser tab opens from — it is refreshed,
      // but it can no longer move a tab that is already open.
      expect(window.localStorage.getItem(storageKeyFor("currentChatId"))).toBe("chat-here");
    });

    it("a brand-new browser tab (no session storage) seeds from the shared value", () => {
      // Exactly the state of someone upgrading: a localStorage value left by
      // the old build, and no session value at all. This is the whole
      // migration path — nothing is copied or rewritten.
      window.localStorage.setItem(storageKeyFor("currentProjectId"), "kept-project");
      window.sessionStorage.clear();
      expect(persistTabGet("currentProjectId")).toBe("kept-project");
    });

    it("this tab's own value wins over the seed — the reload case", () => {
      window.localStorage.setItem(storageKeyFor("currentProjectId"), "seed-project");
      persistTabSet("currentProjectId", "this-tabs-project");
      expect(persistTabGet("currentProjectId")).toBe("this-tabs-project");
    });

    it("restore rebuilds this page's workspaces from session storage", () => {
      selectProject("project-a");
      const b = openWorkspace({ projectId: "project-b", chatId: "chat-b" });
      const before = workspaces.get();

      // A reload: memory is gone, session storage is not. Captured first,
      // because clearing the atoms writes through to storage in this process
      // in a way a real reload never would.
      const kept = window.sessionStorage.getItem(storageKeyFor("workspaces"))!;
      const keptActive = window.sessionStorage.getItem(storageKeyFor("workspaces:active"))!;
      workspaces.set([]);
      activeWorkspaceId.set(null);
      window.sessionStorage.setItem(storageKeyFor("workspaces"), kept);
      window.sessionStorage.setItem(storageKeyFor("workspaces:active"), keptActive);
      restoreWorkspaces();

      expect(workspaces.get().map((w) => w.projectId)).toEqual(
        before.map((w) => w.projectId),
      );
      expect(activeWorkspaceId.get()).toBe(b.id);
      expect(currentProjectId.get()).toBe("project-b");
    });

    it("a brand-new browser tab restores ONE workspace on the seed, not the other tab's set", () => {
      selectProject("project-a");
      openWorkspace({ projectId: "project-b" });
      expect(workspaces.get().length).toBe(2);

      // A NEW browser tab: session storage empty, localStorage (shared) intact.
      window.sessionStorage.clear();
      workspaces.set([]);
      activeWorkspaceId.set(null);
      restoreWorkspaces();

      expect(workspaces.get().length).toBe(1);
      expect(currentProjectId.get()).toBe("project-b"); // the seed, not the set
    });

    it("a malformed stored list degrades to the seed rather than to half a set", () => {
      expect(parseWorkspaces("{ not json")).toBeNull();
      expect(parseWorkspaces(JSON.stringify([{ id: "x" }]))).toBeNull();
      expect(parseWorkspaces(null)).toBeNull();

      window.sessionStorage.setItem(storageKeyFor("workspaces"), "[[[");
      window.localStorage.setItem(storageKeyFor("currentProjectId"), "seed-project");
      workspaces.set([]);
      activeWorkspaceId.set(null);
      restoreWorkspaces();
      expect(workspaces.get().length).toBe(1);
      expect(currentProjectId.get()).toBe("seed-project");
    });
  });

  describe("MUTATION: the split holds in BOTH directions", () => {
    it("a theme write from another browser tab converges; a project write does not", () => {
      selectProject("project-mine");
      cockpitTheme.set("carbon");

      // The other browser tab changes the theme AND moves to another project.
      // Both are real localStorage writes; only one of them may reach here.
      foreignPrefixed("cockpitTheme", "logbook");
      foreignPrefixed("currentProjectId", "project-theirs");

      // "How I like the cockpit" — shared. A tab left on the old theme is
      // simply wrong.
      expect(cockpitTheme.get()).toBe("logbook");

      // "What I am working on" — not shared. This is the whole defect: before
      // the fix there was no listener at all, and the two tabs' writes fought
      // over one slot instead. Now the other tab's project cannot move this
      // one, in either direction.
      expect(currentProjectId.get()).toBe("project-mine");
      expect(activeWorkspace.get()?.projectId).toBe("project-mine");
    });

    it("a conversation write from another browser tab does not move this tab", () => {
      selectChat("chat-mine");
      foreignPrefixed("currentChatId", "chat-theirs");
      expect(currentChatId.get()).toBe("chat-mine");
    });
  });

  describe("what a tab says on screen", () => {
    it("names the project and conversation in plain words, never an id", () => {
      const ws = openWorkspace({ projectId: "p1", chatId: "c1" });
      const label = workspaceLabel(
        ws,
        (id) => (id === "p1" ? "harness" : null),
        (id) => (id === "c1" ? "cross-tab coherence" : null),
      );
      expect(label).toBe("harness ▸ cross-tab coherence");
      expect(label).not.toContain("p1");
      expect(label).not.toContain(ws.id);
    });

    it("states absence rather than rendering blank", () => {
      const empty = openWorkspace();
      expect(workspaceLabel(empty, () => null, () => null)).toBe("nothing open yet");

      const noChat = openWorkspace({ projectId: "p1" });
      expect(workspaceLabel(noChat, () => "harness", () => null)).toBe(
        "harness ▸ no conversation open",
      );
    });
  });

  // ── THE SHAPE HAS ONE SPELLING (source-shape arm) ─────────────────────────
  //
  // Every behavioral arm above proves the split HOLDS; this one proves the
  // prefix the split is built from is WRITTEN in exactly one place. A
  // hand-spelled `ws:` template compiles to the same bytes today and drifts
  // silently the day the owner's shape changes — the read half, the sweep,
  // and every behavioral expectation stay keyed to the old spelling while
  // the hand-spelled writer stores under the new one, and no test reds
  // because each arm only ever sees the bytes both spellings agree on. The
  // scan reads STRING and TEMPLATE interiors only (through the shared
  // lexer, so comments and code never count), walks its population
  // dynamically (a new source file is covered the day it lands), and names
  // the one file that is allowed to spell the shape.
  describe("the ws: prefix has exactly one spelling (the owner)", () => {
    it("no source outside the owner spells the ws: prefix in a string or template", () => {
      const offenders: string[] = [];
      for (const root of ["src", "server"]) {
        for (const file of walk(root)) {
          const rel = relpath(file);
          const source = readFileSync(file, "utf8");
          // Only QUOTED material counts — a `(ws: Workspace)` type annotation
          // is code, not a spelling, and a comment mentioning the prefix is
          // prose. The shared lexer decides what a string is.
          for (const span of lexSpans(source, rel.endsWith(".svelte"))) {
            if (span.kind !== "string" && span.kind !== "template") continue;
            const text = source.slice(span.start, span.end);
            if (!text.includes("ws:")) continue;
            if (rel === WS_PREFIX_OWNER) continue;
            const line = source.slice(0, span.start).split("\n").length;
            offenders.push(`${rel}:${line} — ${text.slice(0, 80)}`);
          }
        }
      }
      expect(
        offenders,
        `the workspace-scope prefix must be built through ${WS_PREFIX_OWNER} ` +
        "(workspaceScopedKey / workspaceScopedKeyFor), never hand-spelled — " +
        `offenders: ${offenders.join(" | ")}`,
      ).toEqual([]);
    });
  });
});
