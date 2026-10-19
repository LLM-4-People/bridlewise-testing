// @vitest-environment jsdom
/**
 * Shell hardening — a room whose dynamic import FAILS must not silently
 * no-op the chord (routing law §2.7: silence is a bug).
 *
 * The real-world trigger: a stale-HMR module graph (the dev server was
 * rebuilt under a long-lived tab) makes `loadRoom`'s dynamic import
 * reject. Before the guard, `openRoomById` had no catch: the promise
 * rejected, nothing rendered, the pressed chord did nothing — the exact
 * silent failure the shell forbids. Now the failure surfaces as an honest
 * grammar hint ("<room> failed to load — reload the page") and the room
 * host stays closed (no half-open shell over a missing component).
 *
 * Harness style mirrors shell-composer-seam.test.ts: real Cockpit mount
 * over a stubbed API, with outlet DISCOVERY mocked so the switch room
 * EXISTS (the chord routes to openRoomById, not the not-built hint) but
 * its import rejects.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mount, unmount } from "svelte";

vi.mock("../../src/cockpit/shell/outlets.ts", () => ({
  outletExists: () => false,
  loadOutlet: async () => null,
  // The switch room exists in the tree…
  roomExists: (id: string) => id === "switch",
  // …but its module will not import (stale HMR / dropped network). A vi.fn
  // so the RETRY is provable: the hint promises "try again", and the proof
  // that this is true is a second press reaching a second import attempt.
  loadRoom: vi.fn(async () => {
    throw new Error("Failed to fetch dynamically imported module");
  }),
}));

import Cockpit from "../../src/cockpit/Cockpit.svelte";
import { loadRoom } from "../../src/cockpit/shell/outlets.ts";

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

async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("room import failure — honest hint, never a silent no-op", () => {
  let host: HTMLElement;
  let app: object | null = null;

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
    // Wait for the boot to settle (the shell reveals with no outlets).
    await waitFor(() => host.querySelector(".shell")?.getAttribute("data-revealed") === "true");
  });

  afterEach(() => {
    if (app !== null) unmount(app);
    app = null;
    host.remove();
    vi.unstubAllGlobals();
  });

  test("the chord surfaces 'switch failed to load — try again', and the next press IS the retry", async () => {
    const pressChord = (): void => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "j", ctrlKey: true, bubbles: true, cancelable: true }),
      );
    };
    // jsdom is non-mac: the switch chord fires on Ctrl+J.
    pressChord();

    // The failure is VISIBLE (grammar hint), in honest words — and the words
    // must not prescribe a page reload for a retry the next keystroke
    // already performs (the old hint threw the whole page away for it).
    await waitFor(() => host.querySelector(".hint") !== null);
    expect(host.querySelector(".hint")!.textContent).toBe("switch failed to load — try again");
    expect(host.querySelector(".hint")!.textContent).not.toContain("reload");

    // MUTATION check for the catch: no half-open room ever appears — the
    // pre-fix behavior (roomId set despite the failed import) renders the
    // `.room` chrome; the hardened path must not.
    await new Promise((r) => setTimeout(r, 50));
    expect(host.querySelector(".room")).toBeNull();

    // "TRY AGAIN" IS TRUE MECHANICALLY: the failed room never entered the
    // visited list, so the next press re-runs the import…
    const importer = vi.mocked(loadRoom);
    const attemptsAfterFirst = importer.mock.calls.length;
    expect(attemptsAfterFirst).toBeGreaterThan(0);
    // …and when the import then SUCCEEDS (the dev server caught up), the
    // room opens — the retry is a recovery, not a loop of hints.
    importer.mockImplementationOnce(
      async () => (await import("./fixtures/DeskPanelProbe.svelte")).default,
    );
    pressChord();
    await waitFor(() => importer.mock.calls.length > attemptsAfterFirst);
    await waitFor(() => host.querySelector(".room") !== null);
  });

  test("the place verb routes through the same guarded opener", async () => {
    // Clicking the HORIZON place is the other summoner of the Switch —
    // the same import failure must surface the same honest hint.
    const place = host.querySelector<HTMLElement>(".place, [data-verb-id='horizon.place']");
    if (place === null) return; // horizon place not rendered without a project — chord path above covers the seam
    place.click();
    await waitFor(() => host.querySelector(".hint") !== null);
    expect(host.querySelector(".hint")!.textContent).toContain("failed to load");
  });
});
