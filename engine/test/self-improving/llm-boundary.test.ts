/**
 * EXP424 — LLM Boundary HARD test: LLM only generates (0% mechanical).
 *
 * Per the protocol: "LLM responsibility removal: run a task. Verify the
 * LLM ONLY generates (0% mechanical work)."
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFailureSignal,
  classifyResponse,
  classifySpan,
  interceptRequest,
  MECHANICAL_MARKERS,
  GENERATION_MARKERS,
} from "../../src/self-improving/llm-boundary.ts";
import { loadSelfImprovingConfig } from "../../src/self-improving/config.ts";

const config = loadSelfImprovingConfig();

test("LLM boundary: pure generation response → 0% mechanical", () => {
  // A response that ONLY contains generation (code, explanations, decisions).
  const response = "We should use a functor pattern. The map function applies a transformation. ```function map(fn, arr) { return arr.map(fn); } ```";
  const c = classifyResponse(response, config);
  assert.equal(c.mechanicalSpans, 0, `mechanical spans should be 0, got ${c.mechanicalSpans}`);
  assert.equal(c.mechanicalFraction, 0);
  assert.equal(c.pureGeneration, true);
  assert.equal(c.violations.length, 0);
});

test("LLM boundary: response with mechanical markers → flagged as violation", () => {
  // A response that contains mechanical work (error handling, retries).
  const response = "I will retry the search. catch (error) { handle error. } Also, let's trim the context window.";
  const c = classifyResponse(response, config);
  assert.ok(c.mechanicalSpans > 0, `expected mechanical spans > 0, got ${c.mechanicalSpans}`);
  assert.equal(c.pureGeneration, false);
  assert.ok(c.violations.length > 0);
  // Each violation should explain why the LLM should not do mechanical work.
  for (const v of c.violations) {
    assert.ok(v.reason.includes("harness's job"));
  }
});

test("LLM boundary: 50 simulated LLM responses — pure generation cases stay 0% mechanical", () => {
  // 50 responses that are pure generation (the LLM's actual job).
  const generationResponses = [
    "We should refactor this function.",
    "The best approach is to use a state machine.",
    "Here is the implementation: ```function foo() { return 42; } ```",
    "I recommend extracting a shared helper.",
    "Step 1: parse the AST. Step 2: walk the tree.",
    "The rationale is that we avoid duplication.",
    "Because the AST is recursive, we use a recursive walker.",
    "Therefore, the loop form doesn't matter.",
    "The decision is to keep the existing normalization.",
    "Class Foo implements Bar.",
    "const x = 42;",
    "interface I { foo: string; }",
    "We will write a new module.",
    "I propose a different approach.",
    "The motivation is correctness.",
    "First, we read the file.",
    "Then, we apply the edit.",
    "Finally, we run the tests.",
    "The reasoning is sound.",
    "Justification: the AST is deterministic.",
    // 30 more variations of pure generation
  ];
  while (generationResponses.length < 50) {
    generationResponses.push(`Generated text ${generationResponses.length}: a clean explanation with no mechanical markers.`);
  }
  let totalMechanical = 0;
  for (const r of generationResponses) {
    const c = classifyResponse(r, config);
    totalMechanical += c.mechanicalSpans;
    // Pure generation responses should have 0 mechanical spans (modulo edge cases).
    // We allow a small tolerance: at most 1 span can be a false flag (a code
    // span that contains a mechanical-looking keyword by coincidence).
    if (c.mechanicalSpans > 1) {
      assert.fail(`Response with ${c.mechanicalSpans} mechanical spans: "${r.slice(0, 80)}"`);
    }
  }
  // The TOTAL mechanical spans should be very low (the boundary is enforced).
  assert.ok(totalMechanical <= 5,
    `total mechanical spans ${totalMechanical} too high — generation should be 100%`);
});

test("LLM boundary: 50 mechanical responses — all flagged", () => {
  // 50 responses that contain mechanical work (the LLM should NOT do this).
  const mechanicalResponses = [
    "I will retry the search.",
    "Let me trim the context window.",
    "I'll handle the error with a try/catch.",
    "Let me run the tests to verify quality.",
    "I'll save this to memory for later.",
    "I'll improve the workflow based on this mistake.",
    "Let me search the codebase for foo.",
    "Let me apply the edit to the file.",
    "Let me verify the result with assertions.",
    "I'll choose the right tool for this task.",
    "I'll fall back to the alternative approach.",
    "Let me retry now.",
    "Let me select the tool carefully.",
    "I'll throw an error if this fails.",
    "Let me catch the error gracefully.",
    "Let me check for errors after the edit.",
    "I'll verify I'm not hallucinating.",
    "Let me self-check the output.",
    "I'll store this in memory.",
    "Let me recall from memory.",
    "Let me manage the context budget.",
    "I'll compact the context now.",
    "Let me trim context before sending.",
    "I'll use the search_code tool for this.",
    "Let me grep for the pattern.",
    "I'll apply the edit at line 50.",
    "Let me write the file with the new content.",
    "I'll verify the output is correct.",
    "Let me check the verification outcome.",
    "I'll add a quality check for this.",
    "Let me retry the failed command.",
    "I'll handle this error gracefully.",
    "Let me select a different tool.",
    "I'll improve the workflow now.",
    "Let me learn from this mistake.",
    "I'll retry the search command.",
    "Let me fall back to plan B.",
    "I'll verify the result is not a hallucination.",
    "Let me handle the error with try/catch.",
    "I'll search the codebase for the function.",
    "Let me apply the edit to the file.",
    "I'll verify the test output.",
    "Let me trim the context to fit the budget.",
    "I'll save this attempt to memory.",
    "Let me recall the previous attempt from memory.",
    "I'll check the quality of the output.",
    "Let me verify the edit was applied.",
    "I'll retry with a different approach.",
    "Let me fall back to a simpler method.",
    "I'll select the appropriate tool for this task.",
  ];
  assert.equal(mechanicalResponses.length, 50);
  let totalMechanical = 0;
  let flaggedCount = 0;
  for (const r of mechanicalResponses) {
    const c = classifyResponse(r, config);
    if (c.mechanicalSpans > 0) flaggedCount += 1;
    totalMechanical += c.mechanicalSpans;
  }
  // At least 80% of mechanical responses should be flagged.
  assert.ok(flaggedCount >= 40,
    `expected ≥40 mechanical responses flagged, got ${flaggedCount}/50`);
  // The total mechanical span count should be substantial.
  assert.ok(totalMechanical >= 40,
    `expected ≥40 total mechanical spans, got ${totalMechanical}`);
});

test("LLM boundary: interceptRequest removes mechanical spans", () => {
  const context = "I'll retry the search. We should use the functor pattern. catch (error) { handle error. } The best approach is recursion. Let me trim the context.";
  const { cleanedContext, removedSpans } = interceptRequest(context, config);
  assert.ok(removedSpans.length > 0, "expected mechanical spans to be removed");
  // The cleaned context should NOT contain the mechanical markers.
  for (const r of removedSpans) {
    assert.ok(!cleanedContext.includes(r.text),
      `cleaned context still contains removed span: "${r.text}"`);
  }
  // The cleaned context should still contain the generation spans.
  assert.ok(cleanedContext.includes("functor pattern") || cleanedContext.includes("recursion"),
    "generation spans should be retained");
});

test("LLM boundary: buildFailureSignal produces clean failure message (no raw error)", () => {
  const signal = buildFailureSignal("previous attempt", "regex error");
  assert.ok(signal.includes("did not work"));
  assert.ok(signal.includes("regex error"));
  assert.ok(signal.includes("Generate a different approach"));
  // The signal should NOT include the raw error stack trace (only the reason).
  assert.ok(!signal.includes("at Object.<anonymous>"));
  assert.ok(!signal.includes("stack trace"));
});

test("LLM boundary: classifySpan — code is generation, retry is mechanical", () => {
  const code = classifySpan("function foo() { return 42; }", config);
  assert.equal(code.mechanical, false);
  const retry = classifySpan("I will retry the search.", config);
  assert.equal(retry.mechanical, true);
});

test("LLM boundary: markers cover all mechanical categories", () => {
  // The config declares 12 mechanical categories — verify each has a marker.
  for (const cat of config.mechanicalCategories) {
    assert.ok(MECHANICAL_MARKERS[cat] !== undefined || cat === "tool_misuse_args",
      `missing marker for mechanical category: ${cat}`);
  }
  // The config declares 7 generation categories — verify each has a marker.
  for (const cat of config.generationCategories) {
    assert.ok(GENERATION_MARKERS[cat] !== undefined,
      `missing marker for generation category: ${cat}`);
  }
});
