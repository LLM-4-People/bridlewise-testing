// @vitest-environment node
/**
 * Mechanical enforcement: Frontend Components Deep Audit.
 *
 * The Single-Party-Owner principle for the frontend COMPONENT layer
 * (every .svelte and .ts under src/) — DYNAMIC discovery.
 *
 * Assurance classes (deny-by-default — a file is checked unless explicitly
 * excluded; none are):
 *
 * (A) NO `console.warn`/`console.error`/`console.log` in any `.svelte`
 * component or `.ts` module. Everything routes through the single client
 * debug owner (`src/client-debug.ts` — `clientWarn` / `clientError` /
 * `clientLog`), NOT raw `console.*`. The owner itself is the ONLY file
 * allowed to reference `console.*` (it is the choke point).
 *
 * (B) NO `throw new Error` / `throw new TypeError` / `throw new RangeError`
 * in any `.svelte` component.
 * A component must not raise a generic error; it routes failures
 * through the client debug owner or a typed error from the client API.
 *
 * (C) NO `fetch(` in any `.svelte` component (SPO: client API fetch
 * owner — all HTTP goes through `client.ts`, never a direct `fetch`
 * in a component). Catches a component that bypasses the client API
 * owner to call a backend route directly.
 *
 * (G) The client debug owner EXISTS at `src/client-debug.ts` and exports
 * `clientWarn` / `clientError` / `clientLog` + `configureClientDebug`
 * (the single configuration entry point — the settings toggle).
 *
 * (I) Behavioral: the client debug owner is zero-overhead when OFF
 *. Before `configureClientDebug` is called, every
 * `clientWarn`/`clientError`/`clientLog` is a no-op (the spy sees
 * nothing). After `configureClientDebug({ enabled: true })`, the
 * calls reach `console.*` with the `[category]` prefix. Verified
 * via import + a console spy (no DOM needed).
 *
 * (Classes D, E, F and H — the shared-primitive CSS owners and the
 * ui-thresholds owner — died with the old tree; the cockpit token owner
 * guards its own CSS discipline in tests/cockpit/cockpit-tokens-owner.)
 *
 * Mutation-verified: re-adding a `console.warn` to a component → A FAILS;
 * deleting the client-debug owner → G FAILS.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { walk, walkTs, stripCommentsAndStringsFor } from "../helpers/source-scan.ts";

const SRC_ROOT = join(process.cwd(), "src");
const CLIENT_DEBUG_PATH = join(SRC_ROOT, "client-debug.ts");

/** Extract the `<style>` block CSS from a Svelte source (empty if none). */
function rawStyleBlock(src: string): string {
  const start = src.indexOf("<style>");
  const end = src.indexOf("</style>");
  if (start === -1 || end === -1) return "";
  return src.slice(start, end);
}

// walk ALL of src/ so every component is covered. An earlier discovery
// walked a subtree only, and the root component's 9 console.warn calls
// bypassed the client-debug owner undetected. Deny-by-default: EVERY
// .svelte under src/ is checked.
const ALL_SVELTE = walk(SRC_ROOT, { exts: [".svelte"] });
// the client debug owner covers ALL client modules, not just `.svelte`
// components. Collect every `.ts` under `src/` (state stores, lib helpers,
// the client API) EXCEPT the owner itself (`client-debug.ts` — it is the
// single `console.*` choke point). A `.ts` module that calls `console.*`
// directly bypasses the owner — caught here.
const ALL_SRC_TS = walkTs(SRC_ROOT).filter((f) => f !== CLIENT_DEBUG_PATH);

describe("frontend components deep audit", () => {
  test("dynamic discovery found.svelte files (sanity — not silently empty)", () => {
    expect(ALL_SVELTE.length, "expected .svelte files under src/").toBeGreaterThan(0);
  });

  describe("A. no console.* in components OR client.ts modules", () => {
    // the client debug owner covers ALL client modules, not just
    // `.svelte` components. Before  13 `console.warn`/`console.debug`
    // calls in `.ts` files (client.ts, state/persistence.ts, state/route.ts)
    // bypassed the owner — the owner existed but its coverage was incomplete
    // (the "wired but inert" class). routed them through `clientWarn`/
    // `clientLog`; this now scans BOTH `.svelte` AND `.ts` so a NEW `console.*`
    // in any client module is caught (deny-by-default — the owner is the
    // single `console.*` choke point).
    for (const file of ALL_SVELTE) {
      test(`${relative(SRC_ROOT, file)} has no console.warn/error/log/info/debug`, () => {
        const code = stripCommentsAndStringsFor(readFileSync(file, "utf8"), file);
        if (/console\.(warn|error|log|info|debug)\b/.test(code)) {
          throw new Error(
            `${relative(process.cwd(), file)} uses console.* directly. ` +
              `Import clientWarn/clientError/clientLog from the client debug owner ` +
              `(src/client-debug.ts) and route through it.`,
          );
        }
      });
    }
    for (const file of ALL_SRC_TS) {
      test(`${relative(SRC_ROOT, file)} (.ts) has no console.warn/error/log/info/debug`, () => {
        const code = stripCommentsAndStringsFor(readFileSync(file, "utf8"), file);
        if (/console\.(warn|error|log|info|debug)\b/.test(code)) {
          throw new Error(
            `${relative(process.cwd(), file)} (.ts) uses console.* directly. ` +
              `Import clientWarn/clientError/clientLog from the client debug owner ` +
              `(src/client-debug.ts) and route ` +
              `through it — the owner is the single console.* choke point.`,
          );
        }
      });
    }
  });

  describe("B. no throw new Error/TypeError/RangeError in components", () => {
    for (const file of ALL_SVELTE) {
      test(`${relative(SRC_ROOT, file)} has no throw new Error/TypeError/RangeError`, () => {
        const code = stripCommentsAndStringsFor(readFileSync(file, "utf8"), file);
        if (/throw\s+new\s+(Error|TypeError|RangeError)\b/.test(code)) {
          throw new Error(
            `${relative(process.cwd(), file)} throws a generic Error. ` +
              `Use the typed error hierarchy from the client API or route the failure ` +
              `through the client debug owner.`,
          );
        }
      });
    }
  });

  describe("C. no direct fetch(in components (client API owner)", () => {
    for (const file of ALL_SVELTE) {
      test(`${relative(SRC_ROOT, file)} has no direct fetch(`, () => {
        const code = stripCommentsAndStringsFor(readFileSync(file, "utf8"), file);
        // `fetch(` as a direct call (not `fetchMemory` / a method name).
        // Word-boundary before `fetch` + `(` immediately after.
        if (/\bfetch\s*\(/.test(code)) {
          throw new Error(
            `${relative(process.cwd(), file)} calls fetch() directly (SPO). ` +
              `All HTTP goes through the client API owner (client.ts); a component ` +
              `must never call the backend directly.`,
          );
        }
      });
    }
  });

  // (Classes D–F — the shared-primitive CSS owners — died with the old
  //  tree's component library.)

  describe("G. client debug owner exists + is the single console.* owner", () => {
    test("src/client-debug.ts exists (the single client debug owner)", () => {
      expect(existsSync(CLIENT_DEBUG_PATH), "client-debug.ts must exist at src/client-debug.ts").toBe(true);
    });

    test("client-debug.ts exports clientWarn, clientError, clientLog, configureClientDebug", () => {
      const src = readFileSync(CLIENT_DEBUG_PATH, "utf8");
      expect(src).toMatch(/export\s+function\s+clientWarn\b/);
      expect(src).toMatch(/export\s+function\s+clientError\b/);
      expect(src).toMatch(/export\s+function\s+clientLog\b/);
      expect(src).toMatch(/export\s+function\s+configureClientDebug\b/);
    });

    // (The old "no .ts under the shared dir may console.*" check was a
    // narrower duplicate of class A's ALL_SRC_TS scan, rooted in a tree
    // that no longer exists — class A is the choke-point scan.)
  });

  // (Class H — the ui-thresholds owner — died with the old tree.)

  describe("I. behavioral — client debug owner is zero-overhead when OFF", () => {
    let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
    let consoleLogSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
      // Dynamically import the owner fresh (so the module-level config is
      // the default OFF state). vi.resetModules ensures no stale state.
      vi.resetModules();
      consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    });

    afterEach(() => {
      consoleWarnSpy.mockRestore();
      consoleErrorSpy.mockRestore();
      consoleLogSpy.mockRestore();
    });

    test("before configureClientDebug, clientWarn/clientError/clientLog are no-ops", async () => {
      const mod = await import("../../src/client-debug");
      mod.resetClientDebug();
      mod.clientWarn("test", "should not appear");
      mod.clientError("test", "should not appear");
      mod.clientLog("test", "should not appear");
      expect(consoleWarnSpy, "clientWarn is a no-op when OFF").not.toHaveBeenCalled();
      expect(consoleErrorSpy, "clientError is a no-op when OFF").not.toHaveBeenCalled();
      expect(consoleLogSpy, "clientLog is a no-op when OFF").not.toHaveBeenCalled();
      expect(mod.isClientDebugEnabled(), "disabled by default").toBe(false);
    });

    test("after configureClientDebug({ enabled: true }), calls reach console with [category] prefix", async () => {
      const mod = await import("../../src/client-debug");
      mod.configureClientDebug({ enabled: true });
      expect(mod.isClientDebugEnabled(), "enabled after configure").toBe(true);
      mod.clientWarn("chat", "warn message", { x: 1 });
      mod.clientError("graph", "error message");
      mod.clientLog("timeline", "log message");
      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
      expect(consoleWarnSpy.mock.calls[0]?.[0]).toBe("[chat]");
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy.mock.calls[0]?.[0]).toBe("[graph]");
      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      expect(consoleLogSpy.mock.calls[0]?.[0]).toBe("[timeline]");
    });

    test("category allow-list (deny-by-default — explicit-add) filters emission", async () => {
      const mod = await import("../../src/client-debug");
      mod.configureClientDebug({ enabled: true, categories: ["chat"] });
      mod.clientWarn("chat", "allowed");
      mod.clientWarn("graph", "blocked");
      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
      expect(consoleWarnSpy.mock.calls[0]?.[0]).toBe("[chat]");
    });

    test("resetClientDebug returns to the no-op state", async () => {
      const mod = await import("../../src/client-debug");
      mod.configureClientDebug({ enabled: true });
      mod.clientWarn("chat", "before reset");
      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
      mod.resetClientDebug();
      consoleWarnSpy.mockClear();
      mod.clientWarn("chat", "after reset");
      expect(consoleWarnSpy, "no-op after resetClientDebug").not.toHaveBeenCalled();
    });
  });

  // the ROOT component (src/App.svelte) lives OUTSIDE src/lib, so the
  // pre-discovery (walkSvelte(SRC_LIB)) silently skipped it. Class A now
  // covers its console.* (deny-by-default via the SRC_ROOT walk). This class
  // pins the App.svelte-specific config-OWNER compliance: the root component
  // must source its tunable literals from the single owners (timeline limit,
  // panel clamp ratio) — NOT inline magic numbers — and the Ctrl+K shortcut
  // selector must stay in contract with the MessageInput aria-label. These
  // are App.svelte-specific because no general scanner catches inline
  // numeric CALL-ARG literals like `queryTimeline({ limit: 50 })` (the
  // no-hardcoded-values test only catches Math.max/min; no-hardcoded-config-
  // values only catches named-const >= 1000). This is the deny-by-default
  // gate for the root component.
  // (Classes J–O — App.svelte, the Button/GitPanel/section-label owners,
  //  the IntelligencePanel composition and the truncation-width owners —
  //  died with the old tree.)
});
