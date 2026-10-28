/**
 * THE SYSTEM PROMPT GOES ON THE WIRE EXACTLY AS RENDERED
 * (specs/prompt-registry.md §10 F-PR-9).
 *
 * `buildNativeRequest` ran `dedupContentForLLM` over EVERY message, the system
 * prompt included, so with LLM-input dedup on, the instructions the provider
 * received differed from the rendered (and, with the prompt registry,
 * versioned) text: the attribution broke and the cached prefix moved. Dedup is
 * for conversation content. The dedup is stubbed to a visible rewrite so the
 * test sees exactly which messages it touched.
 */
import { afterEach, describe, expect, test, vi } from "vitest";

import * as dedupBridge from "../../server/awareness/dedup-bridge.ts";
import { buildNativeRequest } from "../../server/llm/llm-bridge.ts";
import { parseProviderStore, resolveProviderCredential } from "../../server/llm/providers.ts";
import { PROVIDER_FIXTURE_OWNER } from "../helpers/multi-user.ts";
import type { ChatMessage } from "../../server/kernel/canonical.ts";

const CREDENTIAL = resolveProviderCredential(
  parseProviderStore({
    providers: [{ id: "p", baseUrl: "https://provider.invalid/v1", apiKey: ("sk" + "-system-prompt-fixture"), models: [{ id: "m" }] }],
    defaultProvider: "p",
    defaultModel: "m",
  }),
  "m", PROVIDER_FIXTURE_OWNER,
);

afterEach(() => vi.restoreAllMocks());

describe("the system prompt on the wire", () => {
  test("is byte-equal to the rendered prompt while dedup rewrites the conversation", () => {
    vi.spyOn(dedupBridge, "dedupContentForLLM").mockImplementation((content: string) => ({ content: `${content} [deduped]`, report: null }));
    const systemPrompt = "You are the harness.\nRepeated rule.\nRepeated rule.\n";
    const { request } = buildNativeRequest("the question", {
      credential: CREDENTIAL,
      systemPrompt,
      conversationHistory: [{ role: "user", content: "an earlier turn" }],
    });
    const wire = JSON.stringify(request.input);
    expect(wire, "the rendered system prompt is on the wire, exact").toContain(JSON.stringify(systemPrompt));
    expect(wire).not.toContain(JSON.stringify(`${systemPrompt} [deduped]`));
    expect(wire, "history is still deduped").toContain("an earlier turn [deduped]");
    expect(wire, "the prompt is still deduped").toContain("the question [deduped]");
  });

  test("deny by default: only user, assistant and tool content is deduped — a role the bridge does not list stays exact (a2b-design M13)", () => {
    const spy = vi.spyOn(dedupBridge, "dedupContentForLLM").mockImplementation((content: string) => ({ content: `${content} [deduped]`, report: null }));
    // The next queue item (RC-04) persists harness notices as `developer` messages: a role
    // the conversation type does not carry yet, so it is planted the way a stored row would arrive.
    const notice = { role: "developer", content: "Harness notice.\nRepeated.\nRepeated.\n" } as unknown as ChatMessage;
    buildNativeRequest("the question", {
      credential: CREDENTIAL,
      conversationHistory: [notice, { role: "assistant", content: "an answer" }, { role: "tool", content: "a result", tool_call_id: "c1" }],
    });
    expect(spy.mock.calls.map(([content]) => content), "exactly the dedupable roles' content").toEqual(["an answer", "a result", "the question"]);
  });
});
