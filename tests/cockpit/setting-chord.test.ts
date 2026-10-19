// @vitest-environment jsdom
/**
 * THE `,` CHORD — the focused fact's setting, built from parts that all
 * already existed:
 *
 *   - WHICH pixels are facts: the LENS stamp vocabulary (`data-setting` /
 *     `data-signal`), read up the ancestor chain by `readTarget`;
 *   - WHAT a fact adjusts: the settings openers' mechanical resolution
 *     (identical id → sheet; namespace → index; nothing → honest hint);
 *   - WHO is asked: whatever holds FOCUS — the keyboard's own "this one".
 *
 * The router never silently does nothing (§2.7): an unstamped focus gets a
 * hint naming the surfaces that do declare facts. Typing stays typing — a
 * `,` in the composer is a comma. The MOUSE path is the instrument cell's
 * own adjust verb, which now carries `data-chord-target="setting"` and the
 * grammar-derived tooltip (the mouse-path guard verifies that half).
 */
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mount, unmount } from "svelte";

vi.mock("../../src/cockpit/shell/outlets.ts", () => ({
  outletExists: () => false,
  loadOutlet: async () => null,
  // Rooms EXIST here (the stacking tests open one) but load as null — the
  // shell renders the honest not-built room, which is the real room PLANE
  // (the full-screen surface the sheet must clear) without any room body.
  roomExists: () => true,
  loadRoom: async () => null,
}));

import Cockpit from "../../src/cockpit/Cockpit.svelte";

type Json = Record<string, unknown> | unknown[];

function jsonResponse(body: Json): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function stubApi(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes("/api/health")) return jsonResponse({ status: "ok" });
      if (url.includes("/api/auth/status"))
        return jsonResponse({ setupRequired: false, authenticated: true, username: "ada", isAdmin: true });
      // The FULL wire shape: the settings resolution walks `settings` and
      // `signals`, and a partial stub crashes it in a way the real serve
      // (typed end to end) cannot.
      if (url.includes("/api/schema/ui"))
        return jsonResponse({
          menus: [],
          panels: [],
          widgets: [],
          modules: [],
          settings: [],
          signals: [],
        });
      if (url.includes("/api/projects")) return jsonResponse([]);
      throw new Error(`unstubbed fetch: ${url}`);
    }),
  );
}

async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("`,` opens the focused fact's setting through the existing owners", () => {
  let host: HTMLElement;
  let app: object | null = null;
  let stamped: HTMLElement | null = null;

  beforeEach(async () => {
    if (typeof window.requestAnimationFrame !== "function") {
      vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
        setTimeout(() => cb(performance.now()), 16),
      );
    }
    stubApi();
    host = document.createElement("div");
    document.body.appendChild(host);
    app = mount(Cockpit, { target: host });
    await waitFor(() => host.querySelector(".shell")?.getAttribute("data-revealed") === "true");
  });

  afterEach(() => {
    if (app !== null) unmount(app);
    app = null;
    host.remove();
    stamped?.remove();
    stamped = null;
    vi.unstubAllGlobals();
  });

  function focusStamped(attr: string, value: string): void {
    stamped = document.createElement("button");
    stamped.setAttribute(attr, value);
    stamped.textContent = "a fact";
    document.body.appendChild(stamped);
    stamped.focus();
  }

  const pressComma = (target?: EventTarget): void => {
    const ev = new KeyboardEvent("keydown", { key: ",", bubbles: true, cancelable: true });
    (target ?? window).dispatchEvent(ev);
  };

  test("a focused data-setting stamp opens THE setting sheet as a scope", async () => {
    focusStamped("data-setting", "cockpit.density");
    pressComma(stamped!);
    await waitFor(() => host.querySelector("[data-setting-sheet]") !== null);
    // The sheet is the ONE primitive, and it is about the stamped subject.
    expect(
      host.querySelector("[data-setting-sheet]")!.getAttribute("data-setting"),
    ).toBe("cockpit.density");
    // THE CAUSE SURVIVED COMPONENT STATE. ScopeHost holds its arrival in
    // $state, whose proxy used to replace the minted cause with a lookalike
    // — `consume` then refused it as a forgery and every undocked scope
    // open THREW. Causes are minted off a NULL PROTOTYPE now, and that is
    // the gate: the proxy returns objects whose prototype is neither Object
    // nor Array untouched (freezing is a separate promise — immutability —
    // not what makes the proxy pass it through). The stamped motion is the
    // proof it worked, through the real path.
    const scope = host.querySelector(".scope")!;
    expect(scope.getAttribute("data-motion")).toBe("sheet-in");
    expect(scope.getAttribute("data-motion-cause")).toBe("change");
  });

  test("a focused data-signal stamp resolves through the registry linkage — an unlinked fact gets the linkage's own honest hint", async () => {
    focusStamped("data-signal", "nobody.linked-this");
    pressComma(stamped!);
    await waitFor(() => host.querySelector(".hint") !== null);
    expect(host.querySelector(".hint")!.textContent).toContain(
      "no served setting is linked to nobody.linked-this",
    );
  });

  test("an unstamped focus is told WHERE facts live — never silence", async () => {
    (document.body as HTMLElement).focus?.();
    pressComma();
    await waitFor(() => host.querySelector(".hint") !== null);
    expect(host.querySelector(".hint")!.textContent).toContain("nothing focused declares a fact");
  });

  test.each(["input", "textarea", "select", "editable"])("a comma in %s stays with its native editor", async (kind) => {
    const input = document.createElement(kind === "editable" ? "div" : kind);
    if (kind === "editable") {
      input.setAttribute("contenteditable", "true");
      input.tabIndex = 0;
    }
    input.setAttribute("data-setting", "cockpit.density");
    document.body.appendChild(input);
    input.focus();
    const event = new KeyboardEvent("keydown", { key: ",", bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    expect(event.defaultPrevented, "the shell must not consume text or native typeahead").toBe(false);
    await new Promise((r) => setTimeout(r, 80));
    expect(host.querySelector(".hint")).toBeNull();
    expect(host.querySelector("[data-setting-sheet]")).toBeNull();
    input.remove();
  });

  // ── STACKING FOLLOWS THE DISMISSAL LADDER ─────────────────────────────
  // Rooms are where stamped facts live, and the sheet used to open UNDER
  // the room plane (scope z 20, room z 30): from inside a room, `,` and
  // the adjust verb opened an INVISIBLE sheet. The decision lives with the
  // Esc ladder (shell/routing.ts): a scope whose dismissal context is the
  // room ON SCREEN is what Esc takes FIRST, so it paints ABOVE that room;
  // a scope from any other context stays under it, exactly as Esc closes
  // the room first. Cockpit derives the fact; ScopeHost wears it.

  const pressRoomChord = (): void => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "'",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  };

  test("a sheet opened from inside a room paints ABOVE that room", async () => {
    pressRoomChord();
    await waitFor(
      () => host.querySelector('section.room[data-room-active="true"]') !== null,
    );
    focusStamped("data-setting", "cockpit.density");
    pressComma(stamped!);
    await waitFor(() => host.querySelector("[data-setting-sheet]") !== null);
    const scope = host.querySelector("aside.scope");
    expect(scope, "the sheet must exist while the room is open").not.toBeNull();
    // The room is still on screen — the sheet came OVER it, it did not
    // pull the room out from under itself.
    expect(host.querySelector('section.room[data-room-active="true"]')).not.toBeNull();
    expect(
      scope!.classList.contains("over-room"),
      "a scope whose dismissal context is the on-screen room must wear the " +
        "over-room stacking class — without it the sheet paints under the " +
        "room plane and the chord opens nothing anyone can see",
    ).toBe(true);
  });

  test("a sheet from ANOTHER context stays under a room opened after it", async () => {
    focusStamped("data-setting", "cockpit.density");
    pressComma(stamped!);
    await waitFor(() => host.querySelector("[data-setting-sheet]") !== null);
    pressRoomChord();
    await waitFor(
      () => host.querySelector('section.room[data-room-active="true"]') !== null,
    );
    const scope = host.querySelector("aside.scope");
    expect(scope).not.toBeNull();
    // The ladder has Esc close the ROOM first here (the sheet's layer is
    // not active in this room's context), so the paint order must agree:
    // no over-room class, sheet under the room plane.
    expect(scope!.classList.contains("over-room")).toBe(false);
  });

  test("the over-room z-index genuinely clears the room plane, and the base one stays under it", () => {
    // jsdom computes no cascade from component styles, so the z-order claim
    // is asserted where it is DECLARED — the two owners' own sources. The
    // numbers are read, never restated, so a renumbering cannot silently
    // invert the planes while this test keeps passing.
    const read = (rel: string): string =>
      readFileSync(new URL(rel, import.meta.url), "utf8");
    const scopeSrc = read("../../src/cockpit/shell/ScopeHost.svelte");
    const roomSrc = read("../../src/cockpit/shell/RoomHost.svelte");
    const grab = (src: string, selector: RegExp, what: string): number => {
      const m = selector.exec(src);
      if (m === null) throw new Error(`${what}: selector block with a z-index not found`);
      return Number(m[1]);
    };
    const roomZ = grab(roomSrc, /\.room\s*\{[^}]*?z-index:\s*(\d+)/, "RoomHost .room");
    const scopeBaseZ = grab(scopeSrc, /\.scope\s*\{[^}]*?z-index:\s*(\d+)/, "ScopeHost .scope");
    const scopeOverZ = grab(
      scopeSrc,
      /\.scope\.over-room\s*\{[^}]*?z-index:\s*(\d+)/,
      "ScopeHost .scope.over-room",
    );
    expect(
      scopeOverZ,
      "a sheet opened from the on-screen room must paint above the room plane",
    ).toBeGreaterThan(roomZ);
    expect(
      scopeBaseZ,
      "a sheet from another context must stay under the room plane — Esc closes the room first there",
    ).toBeLessThan(roomZ);
  });
});
