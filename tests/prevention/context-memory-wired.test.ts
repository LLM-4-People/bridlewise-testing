// @vitest-environment node
/**
 * Prevention: the chat pipeline must retrieve memories before
 * sending, inject them into the context, use the progressive context
 * manager for trimming, and store interactions after receiving (binding
 * "Auto-healing, context injection, memory management, and ALL
 * other backend features must be fully implemented and wired").
 *
 * SPO update: the system-prompt assembly + memory injection now
 * go through `buildLLMInput` (the context owner's single entry point in
 * context-bridge.ts), NOT ad-hoc in run.ts. The test checks that run.ts
 * calls `buildLLMInput` (which internally calls `injectMemoriesIntoPrompt`
 * + `buildSystemPrompt` + `injectRepositoryMapIntoPrompt`) and does NOT
 * call the injection functions directly.
 */
import { describe, test, expect } from "vitest";
// The run path is FIVE modules since the executor was split out of the GET
// handler that used to be it. This guard asks about the run path, not about
// whichever file happened to hold the answer when it was written.
import { runPathSource } from "../helpers/run-source.ts";

import { modulePath } from "../helpers/module-resolver.ts";
const RUN_PATH = modulePath("run.ts");

describe("context-manager + memory wired into the chat pipeline", () => {
  const source = runPathSource();

  test("retrieves relevant memories before sending to the LLM", () => {
    expect(source, "run.ts must call retrieveRelevantMemories before the LLM call").toContain("retrieveRelevantMemories");
  });

  test("builds LLM input through the context owner (buildLLMInput)", () => {
    expect(source, "run.ts must call buildLLMInput (the context owner's single entry point)").toContain("buildLLMInput");
  });

  test("does NOT call injectMemoriesIntoPrompt directly (goes through buildLLMInput)", () => {
    expect(source, "run.ts must not call injectMemoriesIntoPrompt directly — it goes through buildLLMInput").not.toContain("injectMemoriesIntoPrompt");
  });

  test("does NOT call buildSystemPrompt directly (goes through buildLLMInput)", () => {
    expect(source, "run.ts must not call buildSystemPrompt directly — it goes through buildLLMInput").not.toContain("buildSystemPrompt");
  });

  test("does NOT call injectRepositoryMapIntoPrompt directly (goes through buildLLMInput)", () => {
    expect(source, "run.ts must not call injectRepositoryMapIntoPrompt directly — it goes through buildLLMInput").not.toContain("injectRepositoryMapIntoPrompt");
  });

  test("creates a per-run context manager", () => {
    expect(source, "run.ts must call createRunContextManager").toContain("createRunContextManager");
    expect(source, "ActiveRun must have a contextManager field").toContain("contextManager:");
  });

  test("adds turns to the context manager, and lets the derivation trim", () => {
    expect(source, "must addTurn to the context manager").toMatch(/contextManager\.addTurn/);
    // THE TRIM IS NOT THE RUN PATH'S TO SEQUENCE, and this line used to
    // require that it was. Requiring the spelling `contextManager.trim` was
    // satisfied by a trim at the END of a turn, priced against the manifest of
    // the turn that had just finished — while the next turn re-read the
    // manifest and sent the repriced history untrimmed. Pricing and evicting
    // now happen inside `buildTrimmedHistory`, the one function every
    // provider-bound history comes out of, so a trim sequenced here is a
    // second place that has to remember. That is what this asserts instead.
    // The behaviour is driven in
    // tests/prevention/context-charge-matches-payload.test.ts.
    expect(source, "the LLM history must come from the derivation owner").toMatch(/buildTrimmedHistory\(active\.contextManager/);
    expect(
      source.split("\n").filter((l) => /contextManager\.trim\(\)/.test(l) && !l.trimStart().startsWith("//")),
      "the run path must not trim on its own — deriving the history is what prices and trims",
    ).toEqual([]);
  });

  test("stores the interaction in the memory store after the run", () => {
    expect(source, "run.ts must call storeInteraction after the run").toContain("storeInteraction");
  });

  test("imports from context-bridge and memory-bridge", () => {
    expect(source).toMatch(/from\s+["']\.\.\/context\/context-bridge\.ts["']/);
    expect(source).toMatch(/from\s+["']\.\.\/context\/memory-bridge\.ts["']/);
  });

  test("context SSE event exposes memory + context-manager state", () => {
    expect(source, "the context SSE event must report recalledMemoryCount").toContain("recalledMemoryCount");
    expect(source, "the context SSE event must report contextTokens").toContain("contextTokens");
  });
});
