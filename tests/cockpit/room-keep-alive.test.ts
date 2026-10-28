// @vitest-environment jsdom
/**
 * ROOM KEEP-ALIVE — the owner suite for "reopening is not reloading".
 *
 * The user's report was that every room open is a cold start. It literally
 * was: `RoomHost` rendered the open room inside an `{#if}`, so CLOSING a room
 * DESTROYED it. Every reopen paid the whole mount again — the component tree,
 * every canvas, every derivation — and threw away everything the tree was
 * holding: scroll position, expansion state, an open sheet, a typed filter.
 *
 * The fix is that a VISITED room is never unmounted, only hidden. That claim
 * is only testable if the room itself can say how many times it has been
 * constructed, which is what `fixtures/KeepAliveProbe.svelte` exists for — a
 * test that merely looked for a DOM node would pass against a host that
 * unmounted and re-mounted an identical-looking subtree, i.e. against the
 * exact defect.
 *
 *   MUTATION: a host that unmounts on close fails (the mount count rises on
 *   the second open, and the local state is gone).
 *   MUTATION: a hidden room that stays interactive fails (it would answer
 *   clicks and keys aimed at whatever is actually on screen).
 */
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { flushSync } from "svelte";
import { cleanup, render } from "@testing-library/svelte";

import RoomHost from "../../src/cockpit/shell/RoomHost.svelte";
import KeepAliveProbe from "./fixtures/KeepAliveProbe.svelte";
import EditorRoom from "../../src/cockpit/rooms/EditorRoom.svelte";
import type { RoomId, ShellApi, VisitedRoom } from "../../src/cockpit/shell/contract.ts";
import { requestEditorOpen } from "../../src/cockpit/editor/open-request.ts";
import { setEditorReaders } from "../../src/cockpit/editor/feed.ts";
import { fileBuffer, forgetEditorBufferForTests } from "../../src/cockpit/editor/buffer.ts";
import { authState, initialAuth } from "../../src/state/auth.ts";
import { resetProjects, selectProject, setProjects } from "../../src/state/projects.ts";
import { until } from "../helpers/until.ts";

type Probe = { mounts: number; destroys: number };

function probe(): Probe {
  return ((globalThis as unknown as { __keepAliveProbe?: Probe }).__keepAliveProbe ??= {
    mounts: 0,
    destroys: 0,
  });
}

const entryKeepAliveProbe = Object.getOwnPropertyDescriptor(globalThis, "__keepAliveProbe");

// The probe is a module-scope global the fixture component also reads. Remove
// it at teardown so the file leaves the boundary it inherited.
afterAll(() => {
  if (entryKeepAliveProbe === undefined) delete (globalThis as { __keepAliveProbe?: Probe }).__keepAliveProbe;
  else Object.defineProperty(globalThis, "__keepAliveProbe", entryKeepAliveProbe);
});

const shell = {} as ShellApi;

describe("a visited room is hidden on close, never destroyed", () => {
  let host: HTMLElement;
  let rerender: (props: Record<string, unknown>) => Promise<void>;
  let roomId: RoomId | null = null;
  let visited: readonly VisitedRoom[] = [];

  beforeEach(() => {
    (globalThis as unknown as { __keepAliveProbe?: Probe }).__keepAliveProbe = {
      mounts: 0,
      destroys: 0,
    };
    roomId = null;
    visited = [];
    const view = render(RoomHost, {
      props: { shell, roomId, visited, onClose: () => undefined },
    });
    host = view.container as HTMLElement;
    rerender = view.rerender as unknown as (props: Record<string, unknown>) => Promise<void>;
  });

  afterEach(() => {
    cleanup();
  });

  /** What the shell does on a first open: add to the stack, then show it. */
  function open(id: RoomId): void {
    if (!visited.some((r) => r.id === id)) {
      visited = [...visited, { id, comp: KeepAliveProbe as never }];
    }
    roomId = id;
    void rerender({ shell, roomId, visited, onClose: () => undefined });
    flushSync();
  }

  function close(): void {
    roomId = null;
    void rerender({ shell, roomId, visited, onClose: () => undefined });
    flushSync();
  }

  function section(id: RoomId): HTMLElement | null {
    return host.querySelector(`section.room[aria-label="${id} room"]`);
  }

  test("nothing renders before any room has been opened", () => {
    expect(host.querySelectorAll("section.room")).toHaveLength(0);
    expect(probe().mounts).toBe(0);
  });

  // MUTATION (required): a host that unmounts on close fails here.
  test("mutation — reopening does NOT re-mount the room", () => {
    open("switch");
    expect(probe().mounts).toBe(1);
    close();
    open("switch");
    close();
    open("switch");
    expect(probe().mounts).toBe(1);
    expect(probe().destroys).toBe(0);
  });

  test("the room's own state survives the excursion — this is what a cold start lost", async () => {
    open("switch");
    const field = host.querySelector<HTMLInputElement>('[data-testid="probe-field"]')!;
    field.value = "half-typed filter";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(host.querySelector('[data-testid="probe-echo"]')!.textContent).toBe(
      "half-typed filter",
    );

    close();
    open("switch");
    expect(host.querySelector('[data-testid="probe-echo"]')!.textContent).toBe(
      "half-typed filter",
    );
  });

  test("a closed room stays in the DOM — that is what keeps its scroll offset", () => {
    open("switch");
    const el = section("switch");
    close();
    expect(section("switch")).toBe(el); // the very same element object
    expect(el!.getAttribute("data-room-active")).toBe("false");
  });

  // MUTATION (required): a hidden room that stays interactive fails here.
  test("mutation — a hidden room is inert and out of the tab order", () => {
    open("switch");
    open("instruments"); // switch is now hidden behind instruments
    const hidden = section("switch")!;
    expect(hidden.classList.contains("hidden")).toBe(true);
    // `inert` ALONE, deliberately: it removes the subtree from focus, the
    // tab order and the accessibility tree in one declaration. aria-hidden
    // used to ride beside it and left aria-hidden-over-focus when a room
    // closed with focus inside — Chrome's own audit names inert as the fix
    // (guard: tests/cockpit/a11y-hidden-focus-owner.test.ts).
    expect(hidden.getAttribute("aria-hidden")).toBeNull();
    // `inert` is set as a DOM property by the compiler (it is a boolean IDL
    // attribute), so the property is what carries the truth in every engine.
    expect((hidden as HTMLElement & { inert: boolean }).inert).toBe(true);
    // Its close button must not be reachable by Tab either — two "close"
    // buttons in the tab order would be a keyboard trap of the shell's own
    // making.
    expect(hidden.querySelector(".close")!.getAttribute("tabindex")).toBe("-1");

    const shown = section("instruments")!;
    expect(shown.classList.contains("hidden")).toBe(false);
    expect((shown as HTMLElement & { inert: boolean }).inert).toBe(false);
    expect(shown.querySelector(".close")!.getAttribute("tabindex")).toBe("0");
  });

  test("several visited rooms coexist; exactly one is active", () => {
    open("switch");
    open("instruments");
    open("settings");
    expect(host.querySelectorAll("section.room")).toHaveLength(3);
    expect(host.querySelectorAll('section.room[data-room-active="true"]')).toHaveLength(1);
    close();
    expect(host.querySelectorAll("section.room")).toHaveLength(3);
    expect(host.querySelectorAll('section.room[data-room-active="true"]')).toHaveLength(0);
  });

  test("a room whose component did not load is kept alive too — the answer must not flicker", () => {
    // THE ID HERE MUST BE A DECLARED ROOM, and it did not used to be: this
    // read `"memory"`, a room whose declaration was removed once every
    // declared room was required to have a component. Runtime stayed green —
    // the shell only ever compares the string — so the four type errors sat
    // in a program `npm run typecheck` does not run.
    //
    // The SCENARIO is still real and is why the test survives the rename:
    // `comp: null` is what the shell holds when `loadRoom` answers null, which
    // it does for any id whose module fails to load. "Not built yet" is the
    // honest state the shell renders around, and closing must not destroy it.
    visited = [{ id: "custody", comp: null }];
    roomId = "custody";
    void rerender({ shell, roomId, visited, onClose: () => undefined });
    flushSync();
    expect(section("custody")!.textContent).toContain("not built yet");
    close();
    expect(section("custody")).not.toBeNull();
  });

  test("the landing room does not cut — there is no previous room", () => {
    open("switch");
    expect(section("switch")!.getAttribute("data-motion")).toBeNull();
  });

  test("a later room cut names the change; the hidden room does not move", () => {
    open("switch");
    open("settings");
    expect(section("settings")!.getAttribute("data-motion")).toBe("cut");
    expect(section("settings")!.getAttribute("data-motion-signal")).toBe("the open room");
    expect(section("switch")!.getAttribute("data-motion")).toBeNull();
  });
});

// ── THE EDITOR ROOM, KEPT ALIVE — what the host preserves must stay LIVE ──
//
// A kept-alive room keeps its DOM, so a surface that LOOKS interactive can
// quietly stop being wired to the state behind it — the exact class the drive
// filed as UIE-012: after one hide/show cycle the edit-mode textarea changed
// the DOM on every keystroke while the buffer registered nothing (no unsaved
// chip, "Nothing has changed", the text gone on reload).
//
// The root cause turned out not to be the hide/show itself — it was the
// buffer retiring the DRAFT (on save, and on revert) while the pane stayed in
// edit mode, so the textarea faced a draft-less buffer whose keystroke door
// (`setBufferDraft`) answers null with silence. The hide/show was just the
// excursion around a save. So this block pins the WHOLE class against the
// real room, mounted under the real host:
//
//   A. type → hide → show → type — the excursion itself must not cost the
//      binding (the class the host owns);
//   B. type → SAVE → type — the window that actually fired (the buffer's);
//   C. type → revert → type — the same window through the other door;
//   D. the delete dialog quotes a measurement taken AT THE ARM, not the one
//      the room happened to read when the file was opened (the drift the same
//      drive observed: "130 bytes" for a file that was 84 after an undo).
//   E. a save's folder re-read does not steal focus out of the textarea —
//      the roving-focus pulse must re-fire only on its own sequence, not on
//      a row re-bind (the theft made the user's next Space activate the tree
//      row and re-open the file mid-edit).
//
//   MUTATION: `markBufferSaved` back to `draft: null` → B fails (and the
//   buffer suite's save arm with it).
//   MUTATION: `revert()` without the re-begun session → C fails.
//   MUTATION: `armDelete()` without the re-probe → D fails.
//   MUTATION: FileTree's focus effect back to a tracked row lookup → E fails.
describe("the kept-alive editor room's draft binding survives every excursion", () => {
  const ROOT = "/proj";
  const FILE_REL = "scratch.txt";
  const FILE_ABS = `${ROOT}/${FILE_REL}`;
  const ON_DISK = "const a = 1;";
  /** The size the file was when OPENED, mutable so the delete arm can make
   * the disk move underneath the room the way a custody undo does. */
  let sizeOnDisk = 10;

  let host: HTMLElement;
  let rerender: (props: Record<string, unknown>) => Promise<void>;
  let restoreReaders: ReturnType<typeof setEditorReaders> | null = null;
  let prevWidthDesc: PropertyDescriptor | undefined;
  let roomId: RoomId | null = null;
  const visited: readonly VisitedRoom[] = [{ id: "editor", comp: EditorRoom as never }];
  const editorShell = {
    claimKey: () => () => undefined,
  } as unknown as ShellApi;

  function show(): void {
    roomId = "editor";
    void rerender({ shell: editorShell, roomId, visited, onClose: () => undefined });
    flushSync();
  }

  function hide(): void {
    roomId = null;
    void rerender({ shell: editorShell, roomId, visited, onClose: () => undefined });
    flushSync();
  }

  /** Real keystroke shape: the native value setter (so the DOM value really
   * changes) plus the bubbling input event the textarea listens for. */
  function type(text: string): void {
    const area = host.querySelector<HTMLTextAreaElement>('textarea[name="editor-text"]')!;
    expect(area, "the edit-mode textarea must be on screen").not.toBeNull();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(area, area.value + text);
    area.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
  }

  function verb(id: string): HTMLButtonElement {
    const el = host.querySelector<HTMLButtonElement>(`button[data-verb-id="${id}"]`);
    expect(el, `${id} must be on screen`).not.toBeNull();
    return el!;
  }

  /** Wait until the pane has actually read the file (the open is probe-first
   * and async; the textarea does not exist until the edit verb is offered). */
  async function untilEditOffered(): Promise<void> {
    await until(() => host.querySelector('button[data-verb-id="editor.view-edit"]') !== null);
    verb("editor.view-edit").click();
    flushSync();
  }

  const draft = () => fileBuffer.get().draft;
  const dirty = () => {
    const chip = host.querySelector(".fact.unsaved");
    return chip !== null && chip.textContent === "unsaved";
  };

  beforeEach(() => {
    sizeOnDisk = 10;
    forgetEditorBufferForTests();
    authState.set({ ...initialAuth, authenticated: true, username: "ada" });
    setProjects([
      {
        id: "p1",
        name: "proj",
        path: ROOT,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    selectProject("p1");
    restoreReaders = setEditorReaders({
      tree: () =>
        Promise.resolve({
          root: ROOT,
          entryCount: 1,
          entries: [
            {
              name: FILE_REL,
              path: FILE_ABS,
              relativePath: FILE_REL,
              type: "file",
              size: sizeOnDisk,
              extension: "txt",
              lineCount: 1,
            },
          ],
        }),
      probe: (path: string) =>
        Promise.resolve({
          abs: path,
          relativePath: path.slice(ROOT.length + 1),
          kind: "file",
          size: sizeOnDisk,
          text: true,
          binaryReason: null,
          mediaType: null,
          language: "typescript",
          maxReadBytes: 1 << 20,
          maxEditBytes: 10 << 20,
        }),
      read: (path: string) =>
        Promise.resolve({
          path,
          relativePath: path.slice(ROOT.length + 1),
          content: ON_DISK,
          size: sizeOnDisk,
          lineCount: 1,
          language: "typescript",
          truncated: false,
        }),
      write: (save: { apiPath: string }) => Promise.resolve({ path: save.apiPath }),
    });
    // jsdom has no layout — clientWidth is hardcoded 0 — so the room would
    // stay "stacked" (the tree hidden while a file is open) and the tree rows
    // would never render. The focus-theft arm needs them on screen, so the
    // width reads answer a real two-pane width for the life of this block
    // only, restored after each test.
    prevWidthDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth")!;
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get: () => 1400,
    });
    // Svelte's dimension bindings construct a ResizeObserver; jsdom ships
    // none, so an inert one keeps the constructor from throwing. It goes
    // through vitest so this file's teardown restores what it inherited.
    vi.stubGlobal("ResizeObserver", class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
    requestEditorOpen(FILE_REL);
    const view = render(RoomHost, {
      props: { shell: editorShell, roomId: null, visited, onClose: () => undefined },
    });
    host = view.container as HTMLElement;
    rerender = view.rerender as unknown as (props: Record<string, unknown>) => Promise<void>;
    show();
  });

  afterEach(() => {
    if (restoreReaders !== null) setEditorReaders(restoreReaders);
    restoreReaders = null;
    if (prevWidthDesc !== undefined) {
      Object.defineProperty(HTMLElement.prototype, "clientWidth", prevWidthDesc);
      prevWidthDesc = undefined;
    }
    forgetEditorBufferForTests();
    resetProjects();
    authState.set(initialAuth);
    cleanup();
    // Undo this block's `vi.stubGlobal("ResizeObserver")` in the same file
    // that installed it: the DOM project shares one registry per worker
    // (`isolate: false`), so the inert constructor must not outlive the test.
    vi.unstubAllGlobals();
  });

  test("A. type → hide → show → type — the excursion costs the binding nothing", async () => {
    await untilEditOffered();
    type("one");
    expect(draft()).toBe(`${ON_DISK}one`);
    expect(dirty(), "the draft registers while the room is shown").toBe(true);

    hide();
    expect(host.querySelector('section.room[aria-label="editor room"]')!.classList.contains("hidden")).toBe(
      true,
    );
    show();
    type("two");
    expect(draft(), "typing after the excursion must still register").toBe(`${ON_DISK}onetwo`);
    expect(dirty()).toBe(true);
  });

  test("B. type → save → type — the window that fired (the save must not end the session)", async () => {
    await untilEditOffered();
    type("x");
    expect(dirty()).toBe(true);
    verb("editor.save").click();
    // Waited for by the save's own word on screen, never a fixed pause (NO-LOAD-BLOCK).
    await until(() => host.textContent?.includes("saved to") === true);
    expect(host.textContent).toContain("saved to");
    // The saved text is both base and draft: nothing unsaved, session live.
    expect(draft()).toBe(`${ON_DISK}x`);
    expect(dirty()).toBe(false);
    // THE WINDOW: typing on from a save must register, not die silently.
    type("y");
    expect(draft(), "a keystroke after a save is data entry, not a decoration").toBe(`${ON_DISK}xy`);
    expect(dirty()).toBe(true);
    expect(verb("editor.save").disabled).toBe(false);
  });

  test("C. type → revert → type — the discard ends the DRAFT, not the session", async () => {
    await untilEditOffered();
    type("x");
    verb("editor.revert").click();
    flushSync();
    verb("editor.revert-confirm").click();
    flushSync();
    expect(draft(), "the discarded edit is gone; the saved text stands").toBe(ON_DISK);
    expect(dirty()).toBe(false);
    // THE WINDOW: the still-mounted textarea must accept new work.
    type("z");
    expect(draft(), "a keystroke after a revert must register").toBe(`${ON_DISK}z`);
    expect(dirty()).toBe(true);
  });

  test("D. the delete dialog quotes the size measured AT THE ARM, not at the open", async () => {
    await untilEditOffered();
    // The disk moved underneath the room (a custody undo, an agent, another
    // tab) after the file was opened.
    sizeOnDisk = 84;
    verb("editor.delete").click();
    // Waited for by the confirmation on screen, never a fixed pause (NO-LOAD-BLOCK).
    await until(() => host.querySelector(".loss") !== null);
    const loss = host.querySelector(".loss");
    expect(loss, "the delete confirmation must be on screen").not.toBeNull();
    expect(loss!.textContent).toContain("84 bytes");
    expect(loss!.textContent, "the open-time measurement must not survive the arm").not.toContain(
      "10 bytes",
    );
  });

  test("E. a save's folder re-read does not steal focus out of the textarea", async () => {
    await untilEditOffered();
    type("x");
    const area = host.querySelector<HTMLTextAreaElement>('textarea[name="editor-text"]')!;
    area.focus();
    expect(document.activeElement).toBe(area);
    verb("editor.save").click();
    // Waited for by the save's own word on screen (its folder re-read has run), never a fixed pause.
    await until(() => host.textContent?.includes("saved to") === true);
    // The save re-reads the parent folder; the transient reading state
    // unmounts and remounts every tree row. The roving-focus pulse must not
    // re-fire on the re-bind — observed live, it stole focus to the tree row,
    // and the user's next Space activated the row and re-opened the file
    // mid-edit (the pane left edit mode and the keystrokes fell to the
    // composer).
    expect(document.activeElement, "focus stays where the user put it").toBe(area);
    // …and the session the user was typing in is still live.
    type("y");
    expect(draft()).toBe(`${ON_DISK}xy`);
  });
});
