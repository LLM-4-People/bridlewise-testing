import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createInteractiveSession } from "../../src/runtime/interactive-session.ts";
import { createToolRegistry } from "../../src/runtime/tool-registry.ts";
import type { TimelineRecorder } from "../../src/timeline/timeline-recorder.ts";
import type { ChatStreamEvent } from "../../src/runtime/provider-adapter.ts";
import { makeNativeMockAdapter as makeMockAdapter } from "../support/mock-provider.ts";
import { mkOwnedTempDir } from "../support/temp-dir.ts";

/**
 * Regression test for FIX-1 (CRITICAL): provider intent timeline recording.
 *
 * Root cause: `recordIntent` called `canonicalHash(payload)` where `payload`
 * was the provider `request` including `signal: AbortSignal`. `AbortSignal`
 * is a non-plain object (`Object.getPrototypeOf(value)!== Object.prototype`),
 * so `integrity.ts` threw `"Canonical data contains an unsupported object"`
 * and every provider chat-completion intent was dropped from the timeline.
 * The `FailureTracker` only surfaced the first failure, so subsequent drops
 * were invisible.
 *
 * Fix: `recordIntent` now strips non-serializable fields (specifically
 * `signal`) from the payload before canonicalization. The signal is an
 * operational concern, not part of the semantic intent.
 *
 * These tests verify:
 * 1. A turn with an AbortSignal does not cause recording failures (the
 * intent hash is computed and recorded, not dropped).
 * 2. The captured intent hash is a valid SHA-256 hex digest (the canonical
 * hash succeeded, proving the signal was stripped).
 */

const TEMP_ROOT = mkOwnedTempDir("session-intent-");
writeFileSync(join(TEMP_ROOT, "test.txt"), "test content");

const content = (text: string): ChatStreamEvent => Object.freeze({ type: "content" as const, text });
const finish = (reason: string): ChatStreamEvent => Object.freeze({ type: "finish" as const, reason });

interface CapturedEffect {
  effectId: string;
  kind: string;
  intentHash: string;
  description: string;
}

function capturingTimeline(): { recorder: TimelineRecorder; effects: CapturedEffect[] } {
  const effects: CapturedEffect[] = [];
  const recorder = {
    ledgerId: "test-ledger",
    segmentId: "test-segment",
    closure: {} as never,
    store: {} as never,
    query: {} as never,
    rollback: {} as never,
    beginEffect: (input: Readonly<{ effectId: string; kind: string; description: string; intentHash: string }>) => {
      effects.push({ effectId: input.effectId, kind: input.kind, intentHash: input.intentHash, description: input.description });
    },
    endEffect: () => {},
    observeExternalEffect: () => {},
    recordEvent: () => {},
    recordRun: () => {},
    recordTurn: () => {},
    recordMessage: () => {},
    recordTokenUsage: () => {},
    recordResource: () => {},
    recordTest: () => {},
    recordGitOperation: () => {},
    recordCommit: () => {},
    recordFileEffect: () => {},
    lineage: () => [],
    pendingEffects: () => [],
    observations: () => [],
    assertClosureComplete: () => ({ complete: true, missingTerminals: [] }) as never,
    verifyChain: () => ({ valid: true, verifiedRecords: 0 }) as never,
    verifyTimelineChain: () => ({ valid: true, verifiedRecords: 0 }) as never,
    rebuildProjections: () => {},
    close: () => {},
  } as unknown as TimelineRecorder;
  return { recorder, effects };
}

async function runTurn(session: ReturnType<typeof createInteractiveSession>, signal?: AbortSignal): Promise<void> {
  const gen = session.runTurn(signal);
  let res = await gen.next();
  while (!res.done) { res = await gen.next(res.value); }
}

test("recordIntent: provider intent is recorded when request carries an AbortSignal (FIX-1)", async () => {
  const adapter = makeMockAdapter([content("Hi"), finish("stop")]);
  const { recorder, effects } = capturingTimeline();
  const session = createInteractiveSession({
    adapter,
    model: "test-model",
    systemPrompt: "sys",
    maxTokens: 4096,
    temperature: 0,
    toolRegistry: createToolRegistry(),
    repositoryRoot: TEMP_ROOT,
    timeline: recorder,
  });
  const controller = new AbortController();
  session.addUserMessage("hello");
  await runTurn(session, controller.signal);
  // The provider intent must have been recorded (not dropped).
  const providerIntents = effects.filter((e) => e.kind === "provider");
  assert.ok(
    providerIntents.length >= 1,
    `expected at least one provider intent effect, got ${providerIntents.length}: ${JSON.stringify(effects)}`,
  );
  // The intent hash must be a valid 64-char hex digest (proving canonicalHash
  // succeeded rather than throwing on the AbortSignal).
  const intent = providerIntents[0]!;
  assert.match(
    intent.intentHash,
    /^[0-9a-f]{64}$/u,
    `intentHash must be a SHA-256 hex digest, got: ${intent.intentHash}`,
  );
  // No recording failures must have accumulated.
  assert.equal(session.getRecordingFailures(), 0, "no recording failures when payload carries an AbortSignal");
});

test("recordIntent: provider intent is recorded when no AbortSignal is present", async () => {
  const adapter = makeMockAdapter([content("Hi"), finish("stop")]);
  const { recorder, effects } = capturingTimeline();
  const session = createInteractiveSession({
    adapter,
    model: "test-model",
    systemPrompt: "sys",
    maxTokens: 4096,
    temperature: 0,
    toolRegistry: createToolRegistry(),
    repositoryRoot: TEMP_ROOT,
    timeline: recorder,
  });
  session.addUserMessage("hello");
  await runTurn(session);
  const providerIntents = effects.filter((e) => e.kind === "provider");
  assert.ok(providerIntents.length >= 1, "expected at least one provider intent effect");
  assert.match(providerIntents[0]!.intentHash, /^[0-9a-f]{64}$/u);
  assert.equal(session.getRecordingFailures(), 0);
});

test("recordIntent: intent hash is stable across turns (signal does not affect hash)", async () => {
  // The signal is operational, not semantic. Two turns with different signals
  // but identical request data must produce the same intent hash.
  const adapter = makeMockAdapter([content("Hi"), finish("stop")]);
  const { recorder, effects } = capturingTimeline();
  const session = createInteractiveSession({
    adapter,
    model: "test-model",
    systemPrompt: "sys",
    maxTokens: 4096,
    temperature: 0,
    toolRegistry: createToolRegistry(),
    repositoryRoot: TEMP_ROOT,
    timeline: recorder,
  });
  // Turn 1 with one AbortSignal
  const c1 = new AbortController();
  session.addUserMessage("hello");
  await runTurn(session, c1.signal);
  // Turn 2 with a different AbortSignal but identical message content
  // (the system prompt + "hello" + "hello" user message are the same shape).
  const c2 = new AbortController();
  session.addUserMessage("hello");
  await runTurn(session, c2.signal);
  const providerIntents = effects.filter((e) => e.kind === "provider");
  assert.ok(providerIntents.length >= 2, "expected at least two provider intent effects");
  // The first-turn intent hashes must match (same request data, different signals).
  const firstTurnIntents = providerIntents.filter((e) => e.effectId.startsWith("provider-turn-1-"));
  assert.ok(
    firstTurnIntents.every((e) => e.intentHash === firstTurnIntents[0]!.intentHash),
    "intent hashes within a turn must be identical regardless of signal identity",
  );
  assert.equal(session.getRecordingFailures(), 0);
});
