// @vitest-environment jsdom
/**
 * The shell composer seams + desk-line slot (contract.ts additions):
 *   - prefillComposer(text)  — FLOW "edit & resend" lands in the ONE input;
 *   - clearComposer(sent)   — an accepted submission consumes EXACTLY its
 *     own snapshot, so in-window typing survives the clear;
 *   - restoreComposerText(text) — a refused send gives the words back;
 *   - onComposerChange       — per-KEYSTROKE subscription (live `/` menu);
 *     unsubscribing stops the fan-out (the mutation check);
 *   - setDeskLine            — a component docks into the findings row
 *     (data-testid="desk-line-slot"), which the shell places ABOVE THE BAND,
 *     and null clears it.
 *
 * Harness style mirrors cockpit-boot-owner.test.ts: real Cockpit mount over
 * a stubbed API, with the outlet DISCOVERY mocked to hand the test a probe
 * outlet that captures the ShellApi (outlets are the one seam that gets it).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";

vi.mock("../../src/cockpit/shell/outlets.ts", () => ({
  outletExists: (id: string) => id === "flow",
  loadOutlet: async (id: string) =>
    id === "flow"
      ? (await import("./fixtures/SeamProbeOutlet.svelte")).default
      : null,
  loadRoom: async () => null,
  roomExists: () => false,
}));

import Cockpit from "../../src/cockpit/Cockpit.svelte";
import DeskLineFixture from "./fixtures/DeskLineFixture.svelte";
import type { ShellApi } from "../../src/cockpit/shell/contract.ts";
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


function capturedShell(): ShellApi {
  const shell = (globalThis as unknown as { __seamShell?: ShellApi }).__seamShell;
  if (shell === undefined) throw new Error("probe outlet did not capture the shell");
  return shell;
}

describe("shell composer seams + desk-line slot", () => {
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
    await until(
      () => host.querySelector('[data-testid="seam-probe"]') !== null,
    );
  });

  afterEach(() => {
    if (app !== null) unmount(app);
    app = null;
    host.remove();
    delete (globalThis as unknown as { __seamShell?: ShellApi }).__seamShell;
    vi.unstubAllGlobals();
  });

  function composerInput(): HTMLInputElement {
    return host.querySelector(".composer") as HTMLInputElement;
  }

  test("prefillComposer puts the text into the ONE composer input", () => {
    capturedShell().prefillComposer("fix the test and resend");
    flushSync();
    expect(composerInput().value).toBe("fix the test and resend");
    expect(capturedShell().composerText()).toBe("fix the test and resend");
  });

  test("clearComposer consumes exactly the sent snapshot", () => {
    const shell = capturedShell();
    // The commit-window contract: words typed between the send and the
    // clear were never the send's to take. The clear removes the sent
    // snapshot alone.
    shell.prefillComposer("send me");
    shell.clearComposer("send me");
    flushSync();
    expect(composerInput().value).toBe("");
    // In-window typing SURVIVES the clear of what was sent before it.
    shell.prefillComposer("send me and this too");
    shell.clearComposer("send me");
    flushSync();
    expect(
      composerInput().value,
      "the words typed during the commit window are the reader's, still in flight",
    ).toBe(" and this too");
    // An edited-since field is not provably the send's to take — it stands.
    shell.prefillComposer("totally different now");
    shell.clearComposer("send me");
    flushSync();
    expect(composerInput().value).toBe("totally different now");
  });

  test("restoreComposerText returns refused words ahead of in-window typing", () => {
    const shell = capturedShell();
    // A refused send consumed nothing: the words come back to the box,
    // ahead of whatever the reader typed meanwhile (the order they were
    // typed in), and the box takes focus for the correction.
    shell.prefillComposer("kept typing");
    shell.restoreComposerText("the refused words");
    flushSync();
    expect(composerInput().value).toBe("the refused wordskept typing");
    expect(capturedShell().composerText()).toBe("the refused wordskept typing");
  });

  test("onComposerChange fires per keystroke; unsubscribing stops it (mutation check)", () => {
    const shell = capturedShell();
    const seen: string[] = [];
    const unsub = shell.onComposerChange((t) => seen.push(t));

    const input = composerInput();
    for (const value of ["/", "/t", "/to"]) {
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      flushSync();
    }
    expect(seen).toEqual(["/", "/t", "/to"]);

    unsub();
    input.value = "/too";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(seen).toEqual(["/", "/t", "/to"]); // no further fan-out
  });

  test("setDeskLine docks a component ABOVE THE BAND; null clears it", () => {
    const shell = capturedShell();
    expect(host.querySelector('[data-testid="desk-line-slot"]')).toBeNull();

    shell.setDeskLine({ component: DeskLineFixture, props: { label: "1 finding" } });
    flushSync();
    const slot = host.querySelector('[data-testid="desk-line-slot"]');
    expect(slot).not.toBeNull();
    expect(slot!.textContent).toContain("1 finding");
    // It is a row of the SHELL's own column — never inside the flow outlet's
    // padding, which is the thing the seam exists to avoid.
    expect(slot!.closest(".flow-outlet")).toBeNull();

    // …and it is ABOVE THE BAND. The user asked for the computer's sentences
    // above the timeline, not below it ("I want these messages to show above
    // the timeline as said before, not below"), and DOM order is where that
    // decision is made — Cockpit.svelte owns the column. The e2e airspace
    // guard measures the pixels; this is the same claim in one line, so a
    // reorder cannot pass the unit suite on its way to failing the browser.
    const band = host.querySelector(".sweep-outlet");
    expect(band).not.toBeNull();
    expect(slot!.parentElement).toBe(band!.parentElement);
    expect(
      slot!.compareDocumentPosition(band!) & Node.DOCUMENT_POSITION_FOLLOWING,
      "the findings row must come BEFORE the band in the shell's column",
    ).toBeTruthy();

    shell.setDeskLine(null);
    flushSync();
    expect(host.querySelector('[data-testid="desk-line-slot"]')).toBeNull();
  });
});
