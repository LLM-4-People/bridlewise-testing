/**
 * THE TOOL MERGE HAS ONE OWNER, ON THE SERVER (specs/cfg-final.md §17 B1).
 *
 * The browser recomputed the effective enabled set from the manifest and the
 * account's overrides, and its rule ignored the global `tools.enabled` list
 * (`if (t.category === "mcp") return true; return true;`): a tool the operator
 * switched off everywhere showed as ON in the Tools panel. The merge now lives
 * in `server/tools/tools-bridge.ts` alone (`effectiveEnabledToolNames`, the rule
 * every run and account view uses), `GET /api/tools/settings` serves its result,
 * and the client stores exactly that list.
 */
import { afterEach, describe, expect, test, vi } from "vitest";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("the tool merge", () => {
  test("the server's one rule: an override wins, else the global list governs the built-in surface", async () => {
    const config = await import("../../server/kernel/harness-config.ts");
    const bridge = await import("../../server/tools/tools-bridge.ts");
    const builtIns = bridge.getToolManifest().filter((tool) => tool.category !== "mcp").map((tool) => tool.name);
    expect(builtIns.length).toBeGreaterThan(2);
    const [kept, off, overridden] = builtIns as [string, string, string];
    vi.spyOn(config, "getEnabledTools").mockReturnValue([kept]);

    const noOverrides = bridge.effectiveEnabledToolNames(new Map());
    expect(noOverrides).toContain(kept);
    expect(noOverrides, "a built-in tool the global list leaves out is OFF with no override").not.toContain(off);

    const withOverrides = bridge.effectiveEnabledToolNames(new Map([[overridden, true], [kept, false]]));
    expect(withOverrides, "an override switches a tool on past the global list").toContain(overridden);
    expect(withOverrides, "an override switches a tool off inside the global list").not.toContain(kept);
    // The run's manifest and the account view agree with the list (one rule).
    expect(bridge.getEnabledToolManifestForSession(new Map()).map((tool) => tool.name)).toEqual(noOverrides);
    expect(bridge.getToolAccountStates(new Map()).filter((state) => state.enabled).map((state) => state.name)).toEqual(noOverrides);
  });

  test("the client stores the server's effective list and never recomputes it", async () => {
    const { getToolSettings } = await import("../../src/client.ts");
    const { enabledTools } = await import("../../src/state/tools.ts");
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      settings: [{ toolName: "read_file", enabled: true, config: null }],
      enabledList: ["search_code"],
    }), { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
    const rows = await getToolSettings();
    expect(rows).toEqual([{ toolName: "read_file", enabled: true, config: null }]);
    expect(enabledTools.get(), "exactly the server's list — the override row is NOT re-merged in the browser").toEqual(["search_code"]);
  });

  test("a settings answer without the effective list is refused, typed", async () => {
    const { getToolSettings } = await import("../../src/client.ts");
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify([{ toolName: "read_file", enabled: true, config: null }]),
      { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
    await expect(getToolSettings()).rejects.toMatchObject({ code: "malformed" });
  });
});
