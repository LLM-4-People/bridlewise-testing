// @vitest-environment jsdom
/**
 * ONE-REVEAL law, mechanical (DESIGN-COCKPIT-V2 §10.3): after the reveal
 * frame, NOTHING may mount, move, or resize except from user action or a
 * live event.
 *
 * This is the jsdom half of the guard: a real Cockpit mount over a stubbed
 * API (probe endpoints answer instantly — the stub shapes mirror the real
 * routes), driven to the reveal, then watched by a MutationObserver over an
 * idle window in which ZERO DOM mutations are allowed. jsdom cannot do
 * layout, so pixel-level layout-shift enforcement lives in the Playwright
 * half (tests/cockpit/e2e/cockpit-boot-owner.spec.ts) — run with
 * `npx playwright test` against the dev server. MANUAL STEP (documented,
 * §10.3): on a real session, load `/`, sign in, and watch one
 * full boot with the DevTools performance overlay's Layout Shift Regions
 * on — no region may flash after the reveal.
 *
 * The harness itself is MUTATION-TESTED below: a deliberately injected
 * late mount / late style move MUST be caught, proving the observer would
 * fail CI on a real regression.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mount, unmount } from "svelte";

// The SHELL's reveal discipline is what this guard owns. Sibling outlet
// surfaces (src/cockpit/{flow,sweep,desk}) are mounted by the shell at the
// reveal in production, but they are separate programs with their own I/O
// and their own guards — mocking the outlet DISCOVERY module (not any
// component) pins this harness to the shell alone, deterministically,
// whether or not sibling files exist yet. The full composition (shell +
// real outlets + real layout) is asserted by the Playwright half
// (tests/cockpit/e2e/cockpit-boot-owner.spec.ts).
vi.mock("../../src/cockpit/shell/outlets.ts", async () => {
  const stub = await import("./switch-landing-stub.svelte");
  return {
    outletExists: () => false,
    loadOutlet: async () => null,
    loadRoom: async (id: string) => (id === "switch" ? stub.default : null),
    roomExists: (id: string) => id === "switch",
  };
});

import Cockpit from "../../src/cockpit/Cockpit.svelte";
import { resetUiSchema } from "../../src/state/schema-store.ts";

type Json = Record<string, unknown> | unknown[];

function jsonResponse(body: Json): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

/** Stub the API surface the boot probes hit (mirrors the real routes:
 * server/routes/{health,auth,schema,projects}). Instant answers = a warm
 * boot. The SHAPES are the real ones; only the transport is stubbed —
 * this guard tests the shell's reveal discipline, not data honesty. */
function stubApi(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes("/api/health")) return jsonResponse({ status: "ok", harnessReady: false });
      if (url.includes("/api/auth/status"))
        return jsonResponse({ setupRequired: false, authenticated: true, username: "ada", isAdmin: true });
      if (url.includes("/api/schema/ui")) return jsonResponse({ menus: [], panels: [], widgets: [] });
      if (url.includes("/api/projects")) return jsonResponse([]);
      throw new Error(`unstubbed fetch in boot harness: ${url}`);
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

/** THE harness: record every DOM mutation under `root` for `ms`. */
export function observeIdle(root: Node, ms: number): Promise<MutationRecord[]> {
  return new Promise((resolve) => {
    const records: MutationRecord[] = [];
    const mo = new MutationObserver((batch) => records.push(...batch));
    mo.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    setTimeout(() => {
      records.push(...mo.takeRecords());
      mo.disconnect();
      resolve(records);
    }, ms);
  });
}

const IDLE_WINDOW_MS = 300;

describe("cockpit-boot-owner — one-reveal, then stillness", () => {
  let host: HTMLElement;
  let app: object | null = null;

  beforeEach(() => {
    if (typeof window.requestAnimationFrame !== "function") {
      vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
        setTimeout(() => cb(performance.now()), 16),
      );
    }
    stubApi();
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    if (app !== null) unmount(app);
    app = null;
    host.remove();
    // The boot writes the STUBBED schema body into the global store; with
    // `isolate: false` that state outlives this file. Whoever writes the
    // store clears it.
    resetUiSchema();
    vi.unstubAllGlobals();
  });

  test("static shell renders at final geometry BEFORE any probe resolves", () => {
    app = mount(Cockpit, { target: host });
    // Same tick as mount — no await: the fixed instruments must already be
    // in the tree (first paint is the full cockpit geometry, §10.2 step 1).
    expect(host.querySelector(".horizon")).not.toBeNull();
    // Desk, composer, sweep and the room rail wait for authed. Signed-out
    // first paint is the identity + registration column, not an inert
    // working surface.
    expect(host.querySelector(".sweep-outlet")).toBeNull();
    expect(host.querySelector(".desk")).toBeNull();
    // THE RIGHT MENUS ARE CLOSED AT FIRST PAINT (deny-by-default): this
    // harness never touches the right-menu store, so what is on screen
    // here is the store's own initial value — a column that appeared
    // without a reader's open would mount before the reveal frame and
    // break §10.3 twice over.
    expect(host.querySelector('[role="complementary"]')).toBeNull();
    expect(host.querySelector('[aria-label="arm menu"]')).toBeNull();
    expect(host.querySelector(".cockpit")?.getAttribute("data-revealed")).toBe("false");
  });

  test("warm signed-in boot reveals, and the registration column is 3 lines", async () => {
    app = mount(Cockpit, { target: host });
    await waitFor(
      () => host.querySelector(".cockpit")?.getAttribute("data-revealed") === "true",
    );
    // session · schema · index — compression is the correct warm experience
    // (§1.5 REGISTRATION row).
    const lines = host.querySelectorAll(".lines .line");
    expect(lines.length).toBe(3);
    // Every line carries a real measured ms.
    for (const li of lines) {
      expect(li.querySelector(".ms")?.textContent).toMatch(/^\d+ms$/);
    }
  });

  test("the project room is assigned in the reveal frame, not after it", async () => {
    app = mount(Cockpit, { target: host });
    await waitFor(
      () => host.querySelector(".cockpit")?.getAttribute("data-revealed") === "true",
    );
    const room = host.querySelector('[aria-label="switch room"]');
    expect(room, "Switch must be in the tree when revealed").not.toBeNull();
    expect(room?.getAttribute("data-room-active")).toBe("true");
    expect(host.querySelector("[data-landing='switch']")).not.toBeNull();
  });

  test("GUARD: zero DOM mutations in the idle window after the reveal", async () => {
    app = mount(Cockpit, { target: host });
    await waitFor(
      () => host.querySelector(".cockpit")?.getAttribute("data-revealed") === "true",
    );
    // Let the reveal frame's own flush finish (it IS the coordinated frame).
    await new Promise((r) => setTimeout(r, 50));
    const records = await observeIdle(host, IDLE_WINDOW_MS);
    const describeAll = records
      .map((r) => `${r.type} on <${(r.target as Element).nodeName ?? "?"}>`)
      .join("\n");
    expect(records, `late mounts/moves after reveal:\n${describeAll}`).toEqual([]);
  });

  // ── MUTATION SELF-CHECKS — the harness must catch a violator ──────────

  test("mutation: a late mount IS caught by the harness", async () => {
    app = mount(Cockpit, { target: host });
    await waitFor(
      () => host.querySelector(".cockpit")?.getAttribute("data-revealed") === "true",
    );
    await new Promise((r) => setTimeout(r, 50));
    const pending = observeIdle(host, IDLE_WINDOW_MS);
    setTimeout(() => {
      const rogue = document.createElement("div");
      rogue.textContent = "late tile";
      host.querySelector(".flow-outlet")?.appendChild(rogue);
    }, 60);
    const records = await pending;
    expect(records.length).toBeGreaterThan(0);
  });

  test("mutation: a late style move IS caught by the harness", async () => {
    app = mount(Cockpit, { target: host });
    await waitFor(
      () => host.querySelector(".cockpit")?.getAttribute("data-revealed") === "true",
    );
    await new Promise((r) => setTimeout(r, 50));
    const pending = observeIdle(host, IDLE_WINDOW_MS);
    setTimeout(() => {
      (host.querySelector(".sweep-outlet") as HTMLElement).style.height = "96px";
    }, 60);
    const records = await pending;
    expect(records.some((r) => r.type === "attributes")).toBe(true);
  });

  test("Registration does not spark — animationend would mutate the signed-out hold", async () => {
    // Playwright's signed-out idle window (cockpit-boot-owner.spec) is the
    // live proof. This pin names the class: a `use:moves` on a probe line
    // stamps data-motion and clears it on animationend after the gate has
    // settled, which is a late mutation with nothing behind it.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/cockpit/boot/Registration.svelte", "utf8");
    expect(src).not.toMatch(/use:moves/);
  });

  test("signed-out boot pauses at the passphrase line (no reveal, no spinner)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
        const url = String(input);
        if (url.includes("/api/health")) return jsonResponse({ status: "ok" });
        if (url.includes("/api/auth/status"))
          return jsonResponse({ setupRequired: false, authenticated: false });
        throw new Error(`unexpected pre-auth fetch: ${url}`);
      }),
    );
    app = mount(Cockpit, { target: host });
    await waitFor(() => host.querySelector(".gate") !== null);
    expect(host.querySelector(".cockpit")?.getAttribute("data-revealed")).toBe("false");
    // The signature line and the passphrase field, in the column, on the
    // measure — no floating form (§10.2 step 3).
    expect(host.querySelector(".gate h1")?.textContent).toBe("Sign in");
    expect(host.querySelector(".gate-note"), "the heading and submit action need no generic subtitle").toBeNull();
    expect(host.querySelector('input[type="password"]')).not.toBeNull();
    // The session line printed its honest absence.
    const details = [...host.querySelectorAll(".line .detail")].map((n) => n.textContent);
    expect(details).toContain("signed out");
    expect(host.querySelector(".cockpit")?.getAttribute("data-authed")).toBe("false");
    expect(host.querySelector(".desk")).toBeNull();
    expect(host.querySelector(".composer")).toBeNull();
    expect(host.querySelector(".rail")).toBeNull();
    expect(host.querySelector(".rail-fold")).toBeNull();
    // The side rail is the authed chrome too: signed-out first paint is the
    // identity + registration column, and no inspector column's mouse path
    // exists before there is a reader to click it.
    expect(host.querySelector(".side-rail")).toBeNull();
    expect(host.querySelector(".sweep-outlet")).toBeNull();
    expect(host.querySelector('[data-chord-target="chat"]')).toBeNull();
    expect(host.querySelector(".place")).toBeNull();
  });

  test("Registration consumes the field spine; a local .field restatement is not the choke", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/cockpit/boot/Registration.svelte", "utf8");
    const styleStart = src.indexOf("<style");
    const styleEnd = src.indexOf("</style>");
    const style = src.slice(styleStart, styleEnd).replace(/\/\*[\s\S]*?\*\//g, "");
    expect(src).toMatch(/class="column"/);
    expect(src).toMatch(/<label class="field">/);
    expect(src).not.toMatch(/12ch/);
    // A local `.field { display:grid }` loses to `.cockpit .field` under
    // Svelte 5 :where() scoping — that is how NAME/PASSPHRASE stacked ON
    // the inputs. The spine lives at the token owner; this file consumes it.
    expect(style).not.toMatch(/\.field\s*\{/);
    expect(style).toMatch(/caret-color:\s*var\(--beam\)/);
    expect(style).toMatch(/grid-template-columns:\s*var\(--label-track\)\s+1fr\s+auto/);
    expect(style).toMatch(/margin-left:\s*calc\(\s*var\(--label-track\)\s*\+\s*var\(--sp-4\)\s*\)/);
    expect(src).toMatch(/class="verb enter primary"/);

    // The column recipe must not be the only `.field` rule: without the
    // `.column .field` spine, the gate stacks. Drive the owner, not a copy.
    const tokens = readFileSync("src/cockpit/tokens.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect((tokens.match(/--label-track\s*:/g) ?? []).length).toBe(1);
    expect(tokens).toMatch(/\.cockpit\s+\.column\s+\.field\s*\{[^}]*display:\s*grid/);
    expect(tokens).toMatch(/\.cockpit\s+\.column\s+\.field\s*\{[^}]*grid-template-columns:\s*var\(--label-track\)/);
    const spine = /\.cockpit\s+\.column\s+\.field\s*\{([^}]*)\}/.exec(tokens)?.[1] ?? "";
    expect(spine).not.toMatch(/flex-direction:\s*column/);
    const welcome = /\.cockpit\s+\.column\.welcome\s+\.field\s*\{([^}]*)\}/.exec(tokens)?.[1] ?? "";
    expect(welcome).toMatch(/display:\s*flex/);
    expect(welcome).toMatch(/flex-direction:\s*column/);
    expect(src).toMatch(/class:welcome=\{needsForm\}/);
    const column = /\.cockpit\s+\.field\s*\{([^}]*)\}/.exec(tokens)?.[1] ?? "";
    expect(column).toMatch(/flex-direction:\s*column/);
  });
});
