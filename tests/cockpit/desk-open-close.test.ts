// @vitest-environment jsdom
/**
 * DESK open/close (§2.3, §3.4–3.5, §12.5) — the geometry and the gestures:
 *
 *   - 64px closed → 280px open, from the token owner (the two heights are
 *     `--desk-h` / `--desk-open-h`, never literals in the component);
 *   - keyboard reachable: the grip is a real button carrying the platform
 *     chord in its label, and the desk chord toggles it;
 *   - the ONE-REVEAL law is untouched: the panel outlet mounts only from
 *     the reveal frame and the desk opens ONLY from a user action — never
 *     from boot or from a live event;
 *   - the `breaker` verb's desk-bus request OPENS a closed desk and never
 *     closes an open one (a jump is not a toggle).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";

vi.mock("../../src/cockpit/shell/outlets.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/cockpit/shell/outlets.ts")>();
  return { ...actual, outletExists: () => false, loadOutlet: async () => null,
    loadRoom: async () => null, roomExists: () => false,
    loadInspectorGroup: async () => (await import("./fixtures/DeskPanelProbe.svelte")).default,
  };
});

import { rightMenu, closeRightMenu } from "../../src/cockpit/shell/right-menu.ts";
import Cockpit from "../../src/cockpit/Cockpit.svelte";
import { jumpToBreakerRow, resetDeskBus } from "../../src/cockpit/desk/desk-bus.ts";
import { resetUiSchema } from "../../src/state/schema-store.ts";
import { read as readSource } from "../helpers/source-scan.ts";
import { plantHead, returnToLive } from "../../src/data/asof.ts";
import { PAST_VIEW_ACT_REASON } from "../../src/data/asof.ts";
import { until } from "../helpers/until.ts";

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
      if (url.includes("/api/schema/ui")) return jsonResponse({ menus: [], panels: [], widgets: [] });
      if (url.includes("/api/projects")) return jsonResponse([]);
      throw new Error(`unstubbed fetch: ${url}`);
    }),
  );
}


describe("the desk's geometry comes from the token owner (§2.3)", () => {
  const tokens = readSource("src/cockpit/tokens.css");
  const desk = readSource("src/cockpit/shell/Desk.svelte");

  test("detail geometry belongs to the inspector; the composer has no second panel", () => {
    expect(tokens).not.toMatch(/--desk-(?:open-)?h:/);
    expect(desk).not.toMatch(/panel-clip|grid-template-rows|Splitter/);
    expect(desk).toContain('openInspectorSection("setup-sec-model")');
  });

  test("reduced motion is owned by the shared duration scale", () => {
    expect(tokens).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*--t-2:\s*1ms/);
  });

  /**
   * IT MAY NOT ANIMATE A LAYOUT PROPERTY.
   *
   * `transition: height` re-laid the desk AND its whole panel subtree on
   * every frame of every toggle — on the surface the product animates most.
   * The reveal is a grid ROW opening over a panel that is laid out once at
   * its final size, so the only thing that moves each frame is the clip.
   */
  test("the desk animates no layout property (height/width/padding/margin)", () => {
    const style = desk.slice(desk.indexOf("<style"));
    const animated: string[] = [];
    for (const m of style.matchAll(/transition:\s*([a-z-]+)/g)) {
      const prop = m[1]!;
      if (/^(height|width|padding|margin|top|left|right|bottom|inset)/.test(prop)) {
        animated.push(prop);
      }
    }
    expect(
      animated,
      `animating ${animated.join(", ")} thrashes layout every frame — use ` +
        `transform/opacity, or grid-template-rows for a real height reveal`,
    ).toEqual([]);
    // MUTATION: the scanner must see the shape it is forbidding.
    const before = ".desk { transition: height var(--t-2) var(--ease-desk); }";
    expect(/transition:\s*(height)/.test(before)).toBe(true);
  });


});

describe("the desk in the shell — gestures only, one-reveal intact", () => {
  let host: HTMLElement;
  let app: object | null = null;

  beforeEach(async () => {
    if (typeof window.requestAnimationFrame !== "function") {
      vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
        setTimeout(() => cb(performance.now()), 16),
      );
    }
    resetDeskBus();
    closeRightMenu();
    stubApi();
    host = document.createElement("div");
    document.body.appendChild(host);
    app = mount(Cockpit, { target: host });
    await until(() => host.querySelector(".desk") !== null);
    // The reveal has landed when the shell says so.
    await until(() => host.querySelector('[data-revealed="true"]') !== null);
  });

  afterEach(() => {
    if (app !== null) unmount(app);
    app = null;
    host.remove();
    resetDeskBus();
    closeRightMenu();
    // The boot writes the STUBBED `/api/schema/ui` body into the global
    // schema store. `isolate: false` shares module state across files in a
    // worker, so leaving it there hands the next file a schema that is not
    // the shape a real server sends — a failure that lands in an unrelated
    // suite and reads like a bug in that suite. Whoever writes the store
    // clears it.
    resetUiSchema();
    vi.unstubAllGlobals();
  });

  const deskEl = (): HTMLElement => host.querySelector(".desk") as HTMLElement;
  const grip = (): HTMLButtonElement => host.querySelector('[data-verb-id="desk.toggle"]') as HTMLButtonElement;
  const panelMounted = (): boolean => host.querySelector('[data-testid="desk-panel-probe"]') !== null;

  test("boot leaves the desk CLOSED — it opens only on user action (§10.3)", () => {
    expect(rightMenu.get() === "setup").toBe(false);
    expect(panelMounted()).toBe(false);
  });

  test("the grip is keyboard reachable and teaches the platform chord", async () => {
    const g = grip();
    expect(g.tagName).toBe("BUTTON"); // focusable by construction, no tabindex hack
    expect(g.getAttribute("aria-expanded")).toBe("false");
    expect(g.getAttribute("aria-label")).toBe("Conversation setup");
    expect(g.title).toMatch(/Ctrl\+\.|⌘\./);

    // A keyboard activation of the focused grip (Enter on a button) opens it.
    g.focus();
    expect(document.activeElement).toBe(g);
    g.click();
    flushSync();
    await until(() => panelMounted());
    expect(rightMenu.get() === "setup").toBe(true);
    expect(grip().getAttribute("aria-expanded")).toBe("true");
    expect(grip().getAttribute("aria-label")).toBe("Conversation setup");
  });

  test("the desk chord toggles the desk both ways", async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: ".", ctrlKey: true, bubbles: true }));
    flushSync();
    await until(() => rightMenu.get() === "setup");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: ".", ctrlKey: true, bubbles: true }));
    flushSync();
    await until(() => rightMenu.get() !== "setup");
  });

  test.each(["Escape", "Back"])("%s returns from inspector detail to the same draft, focus and scroll", async (gesture) => {
    grip().click();
    await until(panelMounted);
    const origin = host.querySelector<HTMLButtonElement>('[data-testid="desk-source-probe"]')!;
    const input = host.querySelector<HTMLInputElement>('[aria-label="Retained editor draft"]')!;
    const body = host.querySelector<HTMLElement>('.right-menu .body')!;
    input.value = "Keep this unsaved thought";
    body.scrollTop = 64;
    origin.focus(); origin.click();
    await until(() => host.querySelector('.scope-title')?.textContent === "Context source");
    expect(host.querySelectorAll('[data-testid="desk-panel-probe"]')).toHaveLength(1);
    const hiddenOrigin = origin.closest<HTMLElement>('[hidden]');
    expect(hiddenOrigin).not.toBeNull();
    expect(hiddenOrigin!.inert).toBe(true);
    if (gesture === "Escape") window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    else host.querySelector<HTMLButtonElement>('[data-verb-id="scope.close"]')!.click();
    await until(() => host.querySelector('.scope-title') === null && document.activeElement === origin);
    expect(rightMenu.get()).toBe("setup");
    expect(input.value).toBe("Keep this unsaved thought");
    expect(body.scrollTop).toBe(64);
    host.querySelector<HTMLButtonElement>('[data-verb-id="right-menu.close"]')!.click();
    await until(() => rightMenu.get() === null);
  });

  test("a `breaker` verb jump OPENS a closed desk…", async () => {
    expect(rightMenu.get() === "setup").toBe(false);
    jumpToBreakerRow("edit_file");
    flushSync();
    await until(() => rightMenu.get() === "setup");
    await until(panelMounted);
  });

  test("…and never CLOSES an open one (a jump is not a toggle)", async () => {
    grip().click();
    flushSync();
    await until(() => rightMenu.get() === "setup");
    jumpToBreakerRow("edit_file");
    jumpToBreakerRow("run_command");
    flushSync();
    expect(rightMenu.get() === "setup").toBe(true);
  });
});

describe("the disabled send says why (UIE-049) — the title derives with the disabled state", () => {
  let host: HTMLElement;
  let app: object | null = null;

  beforeEach(async () => {
    if (typeof window.requestAnimationFrame !== "function") {
      vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
        setTimeout(() => cb(performance.now()), 16),
      );
    }
    resetDeskBus();
    closeRightMenu();
    stubApi();
    host = document.createElement("div");
    document.body.appendChild(host);
    app = mount(Cockpit, { target: host });
    await until(() => host.querySelector(".desk") !== null);
    await until(() => host.querySelector('[data-revealed="true"]') !== null);
  });

  afterEach(() => {
    if (app !== null) unmount(app);
    app = null;
    host.remove();
    resetDeskBus();
    closeRightMenu();
    resetUiSchema();
    returnToLive();
    vi.unstubAllGlobals();
  });

  const send = (): HTMLButtonElement =>
    host.querySelector<HTMLButtonElement>('[data-verb-id="composer.send"]')!;
  const composer = (): HTMLInputElement =>
    host.querySelector<HTMLInputElement>('input[name="composer"]')!;

  test("empty composer → the title states the refusal reason beside the chord", async () => {
    // The boot leaves the composer empty — the disabled state under test.
    expect(send().disabled).toBe(true);
    expect(send().title).toMatch(/send · (Ctrl\+Enter|⌘⏎)/);
    expect(send().title).toContain("nothing typed yet");
  });

  test("words in the composer → the chord title alone (a working control teaches no refusal)", async () => {
    const input = composer();
    input.value = "hello";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(send().disabled).toBe(false);
    expect(send().title).toMatch(/send · (Ctrl\+Enter|⌘⏎)/);
    expect(send().title).not.toContain("nothing");
  });

  test("a planted past view → the ONE owned past-view sentence, the standing shape", async () => {
    plantHead(Date.now());
    flushSync();
    expect(send().disabled).toBe(true);
    expect(send().title).toBe(PAST_VIEW_ACT_REASON);
  });
});
