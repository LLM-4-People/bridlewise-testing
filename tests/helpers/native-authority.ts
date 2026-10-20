/**
 * The native-authority ceiling case, shared by every delegation surface: a
 * profile's tool names stay a ceiling when the call adds restrictions, and the
 * admitted native request is what proves it. One copy, so a change to how the
 * provider seam is stubbed lands once.
 */
import { describe, expect, test, vi } from "vitest";
import { SharedLLMClient } from "../../engine/src/shared/llm/client.ts";
import { getToolManifest } from "../../server/tools/tools-bridge.ts";

export type NativeAuthorityGrant = readonly string[] | "all";

/**
 * Declare the ceiling suite for one delegation tool. `grant` installs a
 * profile whose tools are the given grant; `invoke` runs the delegation with a
 * read-only restriction.
 */
export function describeNativeAuthorityCeiling(toolName: string, grant: (tools: NativeAuthorityGrant) => void, invoke: () => Promise<unknown>): void {
  describe(`${toolName} native authority: profile names remain a ceiling under restrictions`, () => {
    for (const tools of [[], ["read_file"], "all"] as const) test(`native authority grant ${JSON.stringify(tools)}`, async () => {
      grant(tools);
      let offered: string[] | undefined;
      vi.spyOn(SharedLLMClient.prototype, "stream").mockImplementation(async function* (source) {
        const body = source as { tools?: { type: string; name?: string }[] };
        offered = (body.tools ?? []).filter(tool => tool.type === "function").map(tool => tool.name!);
        // The assertion observes admission, independently of the still-pending web native-output mapping.
        yield { type: "finish", reason: "error", truncated: false } as const;
      });
      await invoke();
      expect(offered, "the native admitted request must actually be reached").toBeDefined();
      if (tools === "all") {
        const expected = getToolManifest().filter(tool => tool.category === "built-in" && tool.capabilities.every(cap => cap === "read")).map(tool => tool.name);
        expect(expected.length).toBeGreaterThan(1);
        expect([...offered!].sort()).toEqual(expected.sort());
      } else expect(offered).toEqual(tools);
    });
  });
}
