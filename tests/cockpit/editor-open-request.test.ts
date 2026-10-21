// @vitest-environment jsdom
/**
 * FILE PATHS ARE DOORS — a path named on a beat, or carried by a
 * shell view request, opens the editor room AT that file, through the
 * editor's own probe-first open mechanism.
 *
 * The plug-proofs are the point. A payload seam has three places to die
 * quietly: the shell could open the room and drop the path (B), the room
 * could never consume the seam (C), and the chip could render as dead text
 * (D). Each arm asserts evidence only the wired path can produce — the
 * pending seam's value, the probe issued for the exact file, the room-open
 * call — so any of the three going inert is a red, not a shrug.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { cleanup, render } from "@testing-library/svelte";

vi.mock("../../src/cockpit/shell/outlets.ts", () => ({
  outletExists: () => false,
  loadOutlet: async () => null,
  roomExists: (id: string) => id === "editor" || id === "settings",
  loadRoom: async () => null,
}));

import Cockpit from "../../src/cockpit/Cockpit.svelte";
import EditorRoom from "../../src/cockpit/rooms/EditorRoom.svelte";
import PathChip from "../../src/cockpit/flow/PathChip.svelte";
import ToolBeat from "../../src/cockpit/flow/ToolBeat.svelte";
import {
  consumeEditorOpenRequest,
  pendingEditorOpen,
  requestEditorOpen,
} from "../../src/cockpit/editor/open-request.ts";
import { setEditorReaders } from "../../src/cockpit/editor/feed.ts";
import { forgetEditorBufferForTests } from "../../src/cockpit/editor/buffer.ts";
import {
  consumeShellViewRequest,
  requestShellView,
} from "../../src/cockpit/shell/view-request.ts";
import { SHELL_CONTEXT_KEY, type ShellApi } from "../../src/cockpit/shell/contract.ts";
import { resetProjects, selectProject, setProjects } from "../../src/state/projects.ts";
import type { Beat } from "../../src/cockpit/flow/types.ts";

const ROOT = "/proj";

function stubShell(overrides: Partial<Record<keyof ShellApi, unknown>> = {}): ShellApi {
  return {
    revealAt: () => 0,
    openRoom: () => undefined,
    closeRoom: () => undefined,
    openScope: () => undefined,
    closeScope: () => undefined,
    setAnnunciators: () => undefined,
    setMonitors: () => undefined,
    claimKey: () => () => undefined,
    pushDismiss: () => () => undefined,
    hint: () => undefined,
    composerText: () => "",
    onComposerSubmit: () => () => undefined,
    prefillComposer: () => undefined,
    clearComposer: () => undefined,
    restoreComposerText: () => {},
    onComposerChange: () => () => undefined,
    setDeskLine: () => undefined,
    ...overrides,
  } as unknown as ShellApi;
}

async function settle(ms = 40): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

beforeEach(() => {
  consumeEditorOpenRequest();
  consumeShellViewRequest();
});

afterEach(() => {
  consumeEditorOpenRequest();
  consumeShellViewRequest();
  vi.unstubAllGlobals();
});

describe("A. the seam — one-shot, plain-words refusals", () => {
  test("a request is held once and consuming clears it; blank paths are refused at the door", () => {
    requestEditorOpen("  src/a.ts  ");
    expect(pendingEditorOpen.get()).toBe("src/a.ts");
    expect(consumeEditorOpenRequest()).toBe("src/a.ts");
    expect(pendingEditorOpen.get()).toBeNull();
    requestEditorOpen("   ");
    expect(pendingEditorOpen.get()).toBeNull();
  });
});

describe("B. the shell forwards the payload, and refuses it for a room that cannot consume it", () => {
  let host: HTMLElement;
  let app: object | null = null;

  function jsonResponse(body: unknown): Response {
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }

  beforeEach(async () => {
    if (typeof window.requestAnimationFrame !== "function") {
      vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
        setTimeout(() => cb(performance.now()), 16),
      );
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
        const url = String(input);
        if (url.includes("/api/health")) return jsonResponse({ status: "ok" });
        if (url.includes("/api/auth/status"))
          return jsonResponse({ setupRequired: false, authenticated: true, username: "ada", isAdmin: true });
        if (url.includes("/api/schema/ui")) return jsonResponse({ menus: [], panels: [], widgets: [] });
        if (url.includes("/api/projects")) return jsonResponse([]);
        throw new Error(`unstubbed fetch: ${url}`);
      }),
    );
    host = document.createElement("div");
    document.body.appendChild(host);
    app = mount(Cockpit, { target: host });
    const t0 = Date.now();
    while (host.querySelector(".shell")?.getAttribute("data-revealed") !== "true") {
      if (Date.now() - t0 > 4000) throw new Error("shell never revealed");
      await settle(10);
    }
  });

  afterEach(() => {
    if (app !== null) unmount(app);
    app = null;
    host.remove();
  });

  test("a room request carrying a path opens the editor AND lands the path on the open seam", async () => {
    requestShellView({ kind: "room", id: "editor", path: "src/app.ts" });
    const t0 = Date.now();
    while (host.querySelector('[data-room-active="true"]') === null) {
      if (Date.now() - t0 > 4000) throw new Error("room never opened");
      await settle(10);
    }
    expect(host.querySelector('[data-room-active="true"]')!.getAttribute("aria-label")).toBe(
      "editor room",
    );
    // The payload was FORWARDED — the room component is mocked out here, so
    // the seam still holds it. Dropping the forward makes this null.
    expect(pendingEditorOpen.get()).toBe("src/app.ts");
  });

  test("a path on a room that cannot consume it refuses the WHOLE request, out loud", async () => {
    requestShellView({ kind: "room", id: "settings", path: "src/app.ts" });
    const t0 = Date.now();
    while (host.querySelector(".hint") === null) {
      if (Date.now() - t0 > 4000) throw new Error("no hint");
      await settle(10);
    }
    expect(host.querySelector(".hint")!.textContent).toContain("cannot open a file");
    expect(host.querySelector('[data-room-active="true"]')).toBeNull();
    expect(pendingEditorOpen.get()).toBeNull();
  });
});

describe("C. the editor room consumes the seam through its own open mechanism", () => {
  const probed: string[] = [];
  const readPaths: string[] = [];
  let restore: ReturnType<typeof setEditorReaders> | null = null;

  beforeEach(() => {
    probed.length = 0;
    readPaths.length = 0;
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
    restore = setEditorReaders({
      tree: () => Promise.resolve({ root: ROOT, entryCount: 0, entries: [] }),
      probe: (path: string) => {
        probed.push(path);
        return Promise.resolve({
          abs: path,
          relativePath: path.slice(ROOT.length + 1),
          kind: "file",
          size: 10,
          text: true,
          binaryReason: null,
          mediaType: null,
          language: "typescript",
          maxReadBytes: 1 << 20,
          maxEditBytes: 10 << 20,
        });
      },
      read: (path: string) => {
        readPaths.push(path);
        return Promise.resolve({
          path,
          relativePath: path.slice(ROOT.length + 1),
          content: "const a = 1;",
          size: 12,
          lineCount: 1,
          language: "typescript",
          truncated: false,
        });
      },
    });
    // jsdom has no ResizeObserver; install an inert one through vitest so the
    // file teardown restores the environment it inherited (a direct `??=`
    // assignment outlives the file under the suite's worker).
    vi.stubGlobal("ResizeObserver", class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
  });

  afterEach(() => {
    if (restore !== null) setEditorReaders(restore);
    restore = null;
    forgetEditorBufferForTests();
    resetProjects();
    cleanup();
  });

  test("a pending path is consumed on mount and opened probe-first, like a tree click", async () => {
    requestEditorOpen("src/app.ts");
    render(EditorRoom, { props: { shell: stubShell() } });
    await settle();
    expect(pendingEditorOpen.get()).toBeNull();
    expect(probed).toContain(`${ROOT}/src/app.ts`);
    expect(readPaths).toContain(`${ROOT}/src/app.ts`);
  });

  test("a path arriving WHILE the room is open is honored too", async () => {
    render(EditorRoom, { props: { shell: stubShell() } });
    await settle();
    requestEditorOpen("src/late.ts");
    await settle();
    expect(pendingEditorOpen.get()).toBeNull();
    expect(probed).toContain(`${ROOT}/src/late.ts`);
  });

  test("a path outside the project is refused in plain words, with no doomed probe", async () => {
    requestEditorOpen("/etc/passwd");
    const { container } = render(EditorRoom, { props: { shell: stubShell() } });
    await settle();
    expect(pendingEditorOpen.get()).toBeNull();
    expect(probed).toHaveLength(0);
    expect(container.textContent).toContain("outside this project");
  });
});

describe("D. the chip — a rendered path is clickable and keyboard-activatable", () => {
  let host: HTMLElement | null = null;
  let app: object | null = null;

  afterEach(() => {
    if (app !== null) unmount(app);
    app = null;
    host?.remove();
    host = null;
  });

  function mountWithShell(component: unknown, props: Record<string, unknown>, shell: ShellApi) {
    host = document.createElement("div");
    document.body.appendChild(host);
    app = mount(component as never, {
      target: host,
      props: props as never,
      context: new Map([[SHELL_CONTEXT_KEY, shell]]),
    });
    flushSync();
    return host;
  }

  test("clicking the chip lands the path on the seam and opens the editor room", () => {
    const opened: string[] = [];
    const shell = stubShell({ openRoom: (id: string) => opened.push(id) });
    const el = mountWithShell(PathChip, { path: "src/a.ts" }, shell);
    const chip = el.querySelector<HTMLButtonElement>("button.path-chip");
    expect(chip).not.toBeNull();
    // A real <button>: keyboard activation comes with the element. The
    // tooltip teaches the room's chord, per the mouse-path law.
    expect(chip!.getAttribute("title")).toContain("editor");
    chip!.click();
    expect(pendingEditorOpen.get()).toBe("src/a.ts");
    expect(opened).toEqual(["editor"]);
  });

  test("a tool beat whose input names a path renders the chip in the header", () => {
    const beat: Beat = {
      id: "b1",
      kind: "tool",
      parentId: null,
      turnIndex: 0,
      at: 1,
      abnormal: false,
      bleed: true,
      verbs: [],
      tool: {
        name: "read_file",
        label: "read file",
        status: "done",
        input: { path: "src/deep/thing.ts" },
        output: "x",
        startedAt: 1,
      },
    };
    const el = mountWithShell(ToolBeat, { beat, expanded: false }, stubShell());
    const chip = el.querySelector<HTMLButtonElement>('[data-field="input-hint"] button.path-chip');
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toBe("src/deep/thing.ts");
  });

  test("without a shell above it, the path renders as plain text — no dead control", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    app = mount(PathChip, { target: host, props: { path: "src/a.ts" } });
    flushSync();
    expect(host.querySelector("button")).toBeNull();
    expect(host.textContent).toContain("src/a.ts");
  });
});
