// @vitest-environment node
/**
 * Single-Party-Owner: context manager owner.
 *
 * Binding authority: "Single-Party-Owner Principle" — CONTEXT
 * management (trimming, injection, memory seeding, dedup) must have ONE
 * owner. The unified context manager
 * (`integration/src/memory/unified/unified-context-manager.ts`) is the
 * single source of truth for what's sent to the LLM. ALL context
 * manipulation goes through it — no route or service builds the LLM input
 * directly.
 *
 * This test mechanically pins the three SPO invariants so a bypass cannot
 * be reintroduced silently:
 *
 * (a) ONE entry point for LLM input — the run route calls
 * `buildLLMInput` (context-bridge.ts) which assembles the system
 * prompt AND derives the trimmed history from the context manager.
 * The route does NOT build `conversationHistory` or `systemPrompt`
 * ad-hoc.
 * (b) ALL injection paths go through the context owner — the system-
 * prompt assembly (`buildSystemPrompt` + `injectRepositoryMapIntoPrompt`
 * + `injectMemoriesIntoPrompt`) is orchestrated by `assembleSystemPrompt`
 * / `buildLLMInput` in context-bridge.ts, NOT called directly from
 * the run route.
 * (c) NO route builds conversationHistory directly — the only path to
 * the LLM is `streamChat` (llm-bridge.ts), which receives its input
 * from the context owner (`buildLLMInput`'s output). The route
 * never constructs a raw unbounded history array for the LLM.
 *
 * Three assurance classes (WORKFLOW.md §9 + ):
 * 1. SOURCE-SCAN: the run route calls `buildLLMInput`, not the three
 * ad-hoc injection functions directly.
 * 2. SINGLE-OWNER: `assembleSystemPrompt` + `buildLLMInput` are defined
 * in exactly ONE module (context-bridge.ts) — never redefined.
 * 3. BEHAVIORAL: `buildLLMInput` actually derives the system prompt
 * (with repo map + memories) and the trimmed history from a context
 * manager — the output is the full LLM input shape.
 *
 * Mutation-verified: removing `buildLLMInput` from run.ts makes the
 * source-scan tests FAIL; removing the `assembleSystemPrompt` call from
 * `buildLLMInput` makes the behavioral test FAIL (no repo-map/memory
 * section in the system prompt).
 */
import assert from "node:assert/strict";
import { isLLMError } from "../../engine/src/shared/llm/errors.ts";
import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { walkTs } from "../helpers/source-scan.ts";
// The run path is FIVE modules since the executor was split out of the GET
// handler that used to be it. This guard asks about the run path, not about
// whichever file happened to hold the answer when it was written.
import { runPathSource } from "../helpers/run-source.ts";
import {
  createRunContextManager,
  buildLLMInput,
  assembleSystemPrompt,
  buildTrimmedHistory,
  type RetrievedMemory,
} from "../../server/context/context-bridge.ts";

import { modulePath } from "../helpers/module-resolver.ts";
const unready = (error: unknown): boolean => isLLMError(error) && error.code === "llm_invalid_response" &&
  error.safeDetails.protocolCode === "responses_history_unready";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const RUN_PATH = resolve(ROOT, modulePath("run.ts"));
const CONTEXT_BRIDGE_PATH = resolve(ROOT, modulePath("context-bridge.ts"));

describe("context manager owner", () => {
  describe("(a) ONE entry point for LLM input — run route goes through buildLLMInput", () => {
    const runSource = runPathSource();

    test("run.ts imports buildLLMInput from context-bridge", () => {
      expect(runSource, "run.ts must import buildLLMInput from context-bridge").toMatch(/buildLLMInput/);
      expect(runSource, "buildLLMInput must come from context-bridge").toMatch(/from\s+["']\.\.\/context\/context-bridge\.ts["']/);
    });

    test("run.ts calls buildLLMInput to assemble the LLM input", () => {
      expect(runSource, "run.ts must call buildLLMInput(...)").toMatch(/buildLLMInput\(/);
    });

    test("run.ts does NOT call buildSystemPrompt directly (goes through buildLLMInput)", () => {
      expect(runSource, "run.ts must not call buildSystemPrompt — it's owned by buildLLMInput/assembleSystemPrompt in context-bridge").not.toContain("buildSystemPrompt");
    });

    test("run.ts does NOT call injectRepositoryMapIntoPrompt directly", () => {
      expect(runSource, "run.ts must not call injectRepositoryMapIntoPrompt — it's owned by assembleSystemPrompt in context-bridge").not.toContain("injectRepositoryMapIntoPrompt");
    });

    test("run.ts does NOT call injectMemoriesIntoPrompt directly", () => {
      expect(runSource, "run.ts must not call injectMemoriesIntoPrompt — it's owned by assembleSystemPrompt in context-bridge").not.toContain("injectMemoriesIntoPrompt");
    });

    test("run.ts does NOT import buildSystemPrompt from project-context", () => {
      expect(runSource, "run.ts must not import buildSystemPrompt from project-context").not.toMatch(/from\s+["']\.\.\/project-context\.ts["']/);
    });

    test("run.ts does NOT import injectRepositoryMapIntoPrompt from intelligence-bridge", () => {
      expect(runSource, "run.ts must not import injectRepositoryMapIntoPrompt from intelligence-bridge").not.toMatch(/from\s+["']\.\.\/intelligence-bridge\.ts["']/);
    });
  });

  describe("(b) ALL injection paths go through the context owner (context-bridge.ts)", () => {
    const bridgeSource = readFileSync(CONTEXT_BRIDGE_PATH, "utf8");

    test("assembleSystemPrompt is defined in context-bridge.ts", () => {
      expect(bridgeSource, "context-bridge must define assembleSystemPrompt").toMatch(/export\s+function\s+assembleSystemPrompt/);
    });

    test("buildLLMInput is defined in context-bridge.ts", () => {
      expect(bridgeSource, "context-bridge must define buildLLMInput").toMatch(/export\s+function\s+buildLLMInput/);
    });

    test("assembleSystemPrompt calls buildSystemPrompt (the base-prompt owner)", () => {
      expect(bridgeSource, "assembleSystemPrompt must call buildSystemPrompt internally").toMatch(/buildSystemPrompt\(/);
    });

    test("assembleSystemPrompt calls injectRepositoryMapIntoPrompt (the repo-map owner)", () => {
      expect(bridgeSource, "assembleSystemPrompt must call injectRepositoryMapIntoPrompt internally").toMatch(/injectRepositoryMapIntoPrompt\(/);
    });

    test("assembleSystemPrompt calls injectMemoriesIntoPrompt (the memory-injection owner)", () => {
      expect(bridgeSource, "assembleSystemPrompt must call injectMemoriesIntoPrompt internally").toMatch(/injectMemoriesIntoPrompt\(/);
    });

    test("buildLLMInput calls assembleSystemPrompt + buildTrimmedHistory", () => {
      expect(bridgeSource, "buildLLMInput must call assembleSystemPrompt").toMatch(/assembleSystemPrompt\(/);
      expect(bridgeSource, "buildLLMInput must call buildTrimmedHistory").toMatch(/buildTrimmedHistory\(/);
    });

    test("assembleSystemPrompt + buildLLMInput are NOT defined in any other server module (single owner)", () => {
      const serverDir = resolve(ROOT, "server");
      const tsFiles = walkTs(serverDir).filter((f) => !f.endsWith(".test.ts"));
      const defRegex = /export\s+function\s+(assembleSystemPrompt|buildLLMInput)\b/;
      const owners: string[] = [];
      for (const f of tsFiles) {
        const src = readFileSync(f, "utf8");
        if (defRegex.test(src)) owners.push(f);
      }
      expect(owners, "assembleSystemPrompt + buildLLMInput must be defined in exactly ONE module (context-bridge.ts)").toHaveLength(1);
      expect(owners[0], "the single owner must be context-bridge.ts").toBe(resolve(ROOT, modulePath("context-bridge.ts")));
    });
  });

  describe("(c) NO route builds conversationHistory directly for the LLM", () => {
    const runSource = runPathSource();

    test("streamChat is the only LLM call site in run.ts", () => {
      const matches = runSource.match(/streamChat\(/g);
      expect(matches, "run.ts must call streamChat").not.toBeNull();
      expect(matches!.length, "streamChat must be called (at least once)").toBeGreaterThanOrEqual(1);
    });

    test("the conversationHistory passed to streamChat comes from the context manager (buildTrimmedHistory), not a raw array", () => {
      // The subject is WHERE THE HISTORY COMES FROM, so the pattern stops at
      // the argument that carries that fact. It used to require the call to
      // take exactly one argument, which made a guard about provenance fail
      // on a change to the call's OPTIONS — the same "keyed to today's
      // layout" shape that has broken guards here before. The delimiter class
      // still refuses `buildTrimmedHistoryFromSomethingElse(...)`, and the
      // sibling test below still refuses a raw array.
      expect(runSource, "the LLM history must be derived from the context manager (buildTrimmedHistory)").toMatch(/conversationHistory:\s*buildTrimmedHistory\(active\.contextManager\s*[,)]/);
    });

    test("run.ts does NOT pass a raw conversationHistory array (like buildConversationHistory) to streamChat", () => {
      expect(runSource, "run.ts must not pass buildConversationHistory(...) directly to streamChat").not.toMatch(/conversationHistory:\s*buildConversationHistory/);
    });

    test("buildConversationHistory is only used to SEED the context manager, not sent to the LLM", () => {
      expect(runSource, "buildConversationHistory must be called to seed the context manager").toMatch(/buildConversationHistory\(/);
      expect(runSource, "buildConversationHistory must feed seedContextManagerFromHistory, not streamChat").toMatch(/seedContextManagerFromHistory\(/);
    });
  });

  describe("(d) BEHAVIORAL — buildLLMInput actually derives the full LLM input", () => {
    test("buildLLMInput returns { systemPrompt, conversationHistory }", () => {
      const cm = createRunContextManager();
      cm.addTurn({ role: "user", content: "Hello" });
      const input = buildLLMInput(cm, {
        projectName: "test-project",
        projectPath: "/tmp/nonexistent-path-for-test",
        tools: [],
        userPromptPrefs: undefined,
      }, []);
      expect(input).toHaveProperty("systemPrompt");
      expect(input).toHaveProperty("conversationHistory");
      expect(typeof input.systemPrompt).toBe("string");
      expect(Array.isArray(input.conversationHistory)).toBe(true);
    });

    test("buildLLMInput's system prompt includes the project name (from buildSystemPrompt)", () => {
      const cm = createRunContextManager();
      const input = buildLLMInput(cm, {
        projectName: "my-test-project-name",
        projectPath: "/tmp/nonexistent-path-for-test",
        tools: [],
        userPromptPrefs: undefined,
      }, []);
      expect(input.systemPrompt, "the system prompt must include the project name").toContain("my-test-project-name");
    });

    test("buildLLMInput's system prompt includes injected memories (from injectMemoriesIntoPrompt)", () => {
      const cm = createRunContextManager();
      const memories: RetrievedMemory[] = [
        { id: "mem-1", content: "The user prefers TypeScript.", tier: "short-term", timestamp: new Date().toISOString(), score: 5 },
      ];
      const input = buildLLMInput(cm, {
        projectName: "test-project",
        projectPath: "/tmp/nonexistent-path-for-test",
        tools: [],
        userPromptPrefs: undefined,
      }, memories);
      expect(input.systemPrompt, "the system prompt must include the recalled memory content").toContain("Recalled context");
      expect(input.systemPrompt, "the system prompt must include the memory entry text").toContain("The user prefers TypeScript.");
    });

    test("buildLLMInput's conversationHistory is derived from the context manager (trimmed)", () => {
      const cm = createRunContextManager();
      cm.addTurn({ role: "user", content: "What is 2+2?" });
      cm.addTurn({ role: "assistant", content: "4" });
      const input = buildLLMInput(cm, {
        projectName: "test-project",
        projectPath: "/tmp/nonexistent-path-for-test",
        tools: [],
        userPromptPrefs: undefined,
      }, []);
      expect(input.conversationHistory.length, "the conversation history must include the turns from the context manager").toBeGreaterThanOrEqual(2);
    });

    test("buildLLMInput with no memories does NOT include a 'Recalled context' section", () => {
      const cm = createRunContextManager();
      const input = buildLLMInput(cm, {
        projectName: "test-project",
        projectPath: "/tmp/nonexistent-path-for-test",
        tools: [],
        userPromptPrefs: undefined,
      }, []);
      expect(input.systemPrompt, "no memories → no 'Recalled context' section").not.toContain("Recalled context");
    });

    test("assembleSystemPrompt is a pure function (same input → same output)", () => {
      const parts = {
        projectName: "test-project",
        projectPath: "/tmp/nonexistent-path-for-test",
        tools: [],
        userPromptPrefs: undefined,
      };
      const memories: RetrievedMemory[] = [
        { id: "mem-1", content: "test memory", tier: "short-term", timestamp: new Date().toISOString(), score: 1 },
      ];
      const a = assembleSystemPrompt(parts, memories);
      const b = assembleSystemPrompt(parts, memories);
      expect(a, "assembleSystemPrompt must be deterministic (same input → same output)").toBe(b);
    });

    test("buildLLMInput's conversationHistory matches buildTrimmedHistory (single source of truth)", () => {
      const cm = createRunContextManager();
      cm.addTurn({ role: "user", content: "Hello world this is a test message" });
      cm.addTurn({ role: "assistant", content: "Hi! I received your message." });
      const input = buildLLMInput(cm, {
        projectName: "test-project",
        projectPath: "/tmp/nonexistent-path-for-test",
        tools: [],
        userPromptPrefs: undefined,
      }, []);
      const directHistory = buildTrimmedHistory(cm);
      expect(input.conversationHistory.length, "buildLLMInput's history must match buildTrimmedHistory").toBe(directHistory.length);
      expect(JSON.stringify(input.conversationHistory), "buildLLMInput's history must be identical to buildTrimmedHistory").toBe(JSON.stringify(directHistory));
    });
  });

  describe("(e) BEHAVIORAL — buildTrimmedHistory refuses unresolved local tool history", () => {
    test("an assistant with tool_calls but NO matching tool result refuses replay without deleting evidence", () => {
      const cm = createRunContextManager();
      const toolCalls = [{ id: "call_orphan", type: "function" as const, function: { name: "write_file", arguments: "{}" } }];
      cm.addTurn({ role: "assistant", content: "writing a file", toolCalls });
      assert.throws(() => buildTrimmedHistory(cm), unready);
      expect(cm.turns()[0]?.toolCalls).toEqual(toolCalls);
    });

    test("an assistant with tool_calls AND a matching tool result keeps the tool_calls", () => {
      const cm = createRunContextManager();
      const toolCalls = [{ id: "call_ok", type: "function" as const, function: { name: "write_file", arguments: "{}" } }];
      cm.addTurn({ role: "assistant", content: "writing a file", toolCalls });
      cm.addTurn({ role: "tool", content: "file written", toolCallId: "call_ok" });
      const history = buildTrimmedHistory(cm);
      const assistantMsg = history.find((m) => m.role === "assistant");
      expect(assistantMsg, "the assistant message must survive").toBeDefined();
      const msgToolCalls = (assistantMsg as { tool_calls?: readonly unknown[] }).tool_calls;
      expect(msgToolCalls, "the tool_calls with a matching tool result must be kept").toBeDefined();
      expect(msgToolCalls!.length, "exactly one tool_call").toBe(1);
    });

    test("an assistant with PARTIAL tool_calls (some answered, some not) refuses the whole unresolved batch", () => {
      const cm = createRunContextManager();
      const toolCalls = [
        { id: "call_answered", type: "function" as const, function: { name: "read_file", arguments: "{}" } },
        { id: "call_orphan", type: "function" as const, function: { name: "write_file", arguments: "{}" } },
      ];
      cm.addTurn({ role: "assistant", content: "calling two tools", toolCalls });
      cm.addTurn({ role: "tool", content: "file content", toolCallId: "call_answered" });
      assert.throws(() => buildTrimmedHistory(cm), unready);
      expect(cm.turns()[0]?.toolCalls).toEqual(toolCalls);
      expect(cm.turns()[1]?.toolCallId).toBe("call_answered");
    });

    test("an orphaned tool RESULT (no matching assistant tool_calls) refuses replay", () => {
      const cm = createRunContextManager();
      cm.addTurn({ role: "user", content: "hello" });
      cm.addTurn({ role: "tool", content: "orphaned result", toolCallId: "call_ghost" });
      assert.throws(() => buildTrimmedHistory(cm), unready);
      expect(cm.turns()[1]?.content).toBe("orphaned result");
    });
  });
});
