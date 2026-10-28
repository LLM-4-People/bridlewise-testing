// @vitest-environment jsdom
/**
 * THE SHELL HONORS THE VIEW-REQUEST SEAM — the plug proof.
 *
 * `src/cockpit/shell/view-request.ts` exists for callers with no ShellApi
 * handle (the LLM `control_interface` pipeline). The client half is proven
 * in tests/prevention/ui-control-{wiring,surface-owner}.test.ts; THIS file
 * proves the shell half is actually plugged in — a request store nobody
 * subscribes to is the correct-and-unplugged failure, and nothing about the
 * seam's own green tests would notice it.
 *
 * Harness style mirrors shell-room-load-failure.test.ts: real Cockpit mount
 * over a stubbed API, outlet DISCOVERY mocked so the settings room exists
 * (comp null renders the room chrome's honest empty state — the .room
 * element is the evidence a room opened).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mount, unmount } from "svelte";

vi.mock("../../src/cockpit/shell/outlets.ts", () => ({
  outletExists: () => false,
  loadOutlet: async () => null,
  roomExists: (id: string) => id === "settings",
  loadRoom: async () => null,
}));

import Cockpit from "../../src/cockpit/Cockpit.svelte";
import {
  consumeShellViewRequest,
  requestShellView,
} from "../../src/cockpit/shell/view-request.ts";
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


describe("the mounted shell consumes and honors view requests", () => {
  let host: HTMLElement;
  let app: object | null = null;

  beforeEach(async () => {
    if (typeof window.requestAnimationFrame !== "function") {
      vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
        setTimeout(() => cb(performance.now()), 16),
      );
    }
    consumeShellViewRequest(); // never inherit a request from another test
    stubApi();
    host = document.createElement("div");
    document.body.appendChild(host);
    app = mount(Cockpit, { target: host });
    await until(() => host.querySelector(".shell")?.getAttribute("data-revealed") === "true");
  });

  afterEach(() => {
    if (app !== null) unmount(app);
    app = null;
    host.remove();
    consumeShellViewRequest();
    vi.unstubAllGlobals();
  });

  test("a room request opens the room, a flow request closes it, and both consume", async () => {
    // Keep-alive shell: a CLOSED room keeps its (hidden) subtree, so the
    // honest open/closed evidence is data-room-active, never DOM presence.
    expect(host.querySelector('[data-room-active="true"]')).toBeNull();

    requestShellView({ kind: "room", id: "settings" });
    await until(() => host.querySelector('[data-room-active="true"]') !== null);
    expect(
      host.querySelector('[data-room-active="true"]')!.getAttribute("aria-label"),
    ).toBe("settings room");
    // Consumed one-shot: nothing pending after the shell acted.
    expect(consumeShellViewRequest()).toBeNull();

    requestShellView({ kind: "flow" });
    await until(() => host.querySelector('[data-room-active="true"]') === null);
    expect(consumeShellViewRequest()).toBeNull();
  });

  test("a request for a room that is not built surfaces the honest hint, never a half-open room", async () => {
    requestShellView({ kind: "room", id: "custody" });
    await until(() => host.querySelector(".hint") !== null);
    expect(host.querySelector(".hint")!.textContent).toContain("not built yet");
    expect(host.querySelector(".room")).toBeNull();
  });
});
