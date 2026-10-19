import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { configureDebugSystem, createCollectingSink, resetDebugSystem } from "../../src/shared/debug/debug-system.ts";
import { DEBUG_CONFIG_DEFAULTS } from "../../src/shared/debug/debug-config.ts";

import { createInteractiveSession } from "../../src/runtime/interactive-session.ts";
import { createToolRegistry } from "../../src/runtime/tool-registry.ts";
import type { TimelineRecorder } from "../../src/timeline/timeline-recorder.ts";
import type { ChatStreamEvent } from "../../src/runtime/provider-adapter.ts";
import { makeNativeMockAdapter as makeMockAdapter } from "../support/mock-provider.ts";
import { mkOwnedTempDir } from "../support/temp-dir.ts";

/**
 * INVARIANT #50: timeline recording failures must be tracked and the first
 * failure must be surfaced to stderr (not silently swallowed). The session
 * counts failures via getRecordingFailures so a broken timeline recorder
 * never crashes the session but is never invisible either.
 */

const TEMP_ROOT = mkOwnedTempDir("session-recfail-");
writeFileSync(join(TEMP_ROOT, "test.txt"), "test content");

const content = (text: string): ChatStreamEvent => Object.freeze({ type: "content" as const, text });
const finish = (reason: string): ChatStreamEvent => Object.freeze({ type: "finish" as const, reason });
const usage = (p: number, c: number): ChatStreamEvent => Object.freeze({
  type: "usage" as const,
  usage: Object.freeze({ promptTokens: p, completionTokens: c, totalTokens: p + c }),
});

/**
 * A timeline recorder mock whose recording methods throw. The session must
 * catch these, count them, and emit one stderr warning on the first failure.
 */
let recordingThrows = 0;
function throwingTimeline(): TimelineRecorder {
  const boom = (): never => { recordingThrows++; throw new Error("fixture-secret"); };
  return {
    ledgerId: "test-ledger",
    segmentId: "test-segment",
    closure: {} as never,
    store: {} as never,
    query: {} as never,
    rollback: {} as never,
    beginEffect: boom,
    endEffect: boom,
    observeExternalEffect: boom,
    recordEvent: boom,
    recordRun: boom,
    recordTurn: boom,
    recordMessage: boom,
    recordTokenUsage: boom,
    recordResource: boom,
    recordTest: boom,
    recordGitOperation: boom,
    recordCommit: boom,
    recordFileEffect: boom,
    lineage: () => [],
    pendingEffects: () => [],
    observations: () => [],
    assertClosureComplete: () => ({ complete: true, missingTerminals: [] }) as never,
    verifyChain: () => ({ valid: true, verifiedRecords: 0 }) as never,
    verifyTimelineChain: () => ({ valid: true, verifiedRecords: 0 }) as never,
    rebuildProjections: () => {},
    close: () => {},
  } as unknown as TimelineRecorder;
}

function captureStderr<T>(fn: () => Promise<T>): Promise<{ stderr: string; result: T }> {
  let captured = "";
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => { captured += String(chunk); return true; }) as typeof process.stderr.write;
  return fn().then(
    (result) => { process.stderr.write = original; return { stderr: captured, result }; },
    (error) => { process.stderr.write = original; throw error; },
  );
}

async function runTurn(session: ReturnType<typeof createInteractiveSession>): Promise<void> {
  const gen = session.runTurn();
  let res = await gen.next();
  while (!res.done) { res = await gen.next(res.value); }
}

test("Session recording failures: getRecordingFailures > 0 when timeline throws", async () => {
  const adapter = makeMockAdapter([content("Hi"), finish("stop"), usage(10, 5)]);
  const session = createInteractiveSession({
    adapter,
    model: "test-model",
    systemPrompt: "sys",
    maxTokens: 4096,
    temperature: 0,
    toolRegistry: createToolRegistry(),
    repositoryRoot: TEMP_ROOT,
    timeline: throwingTimeline(),
  });
  assert.equal(session.getRecordingFailures(), 0, "no failures before any turn");
  session.addUserMessage("hello");
  await runTurn(session);
  assert.ok(
    session.getRecordingFailures() > 0,
    "getRecordingFailures() must be > 0 after a turn with a throwing timeline recorder",
  );
});

test("Session recording failures: first failure emits a stderr warning", async () => {
  const adapter = makeMockAdapter([content("Hi"), finish("stop")]);
  const session = createInteractiveSession({
    adapter,
    model: "test-model",
    systemPrompt: "sys",
    maxTokens: 4096,
    temperature: 0,
    toolRegistry: createToolRegistry(),
    repositoryRoot: TEMP_ROOT,
    timeline: throwingTimeline(),
  });
  const { stderr } = await captureStderr(async () => {
    session.addUserMessage("hello");
    await runTurn(session);
  });
  assert.ok(
    /\[debug\] diagnostic unavailable/.test(stderr) && !stderr.includes("fixture-secret"),
    `a fixed safe failure diagnostic must be emitted on first failure, got: ${stderr.slice(0, 200)}`,
  );
});

for (const configured of [false, true]) {
test(`Session recording failures: warning is emitted only once (not per failure) (configured=${configured})`, async (t) => {
  resetDebugSystem();
  t.after(resetDebugSystem);
  const sink = createCollectingSink();
  if (configured) configureDebugSystem({ ...DEBUG_CONFIG_DEFAULTS, sinks: { enabledSinks: ["collecting"] } }, [sink]);
  const adapter = makeMockAdapter([content("Hi"), finish("stop"), usage(1, 1)]);
  const session = createInteractiveSession({
    adapter,
    model: "test-model",
    systemPrompt: "sys",
    maxTokens: 4096,
    temperature: 0,
    toolRegistry: createToolRegistry(),
    repositoryRoot: TEMP_ROOT,
    timeline: throwingTimeline(),
  });
  const beforeThrows = recordingThrows;
  const { stderr } = await captureStderr(async () => {
    session.addUserMessage("hello");
    await runTurn(session);
    session.addUserMessage("again");
    await runTurn(session);
  });
  const warningCount = configured ? sink.events.length : (stderr.match(/\[debug\] diagnostic unavailable/g) || []).length;
  assert.equal(
    warningCount,
    1,
    `the stderr warning must be emitted exactly once (got ${warningCount} occurrences)`,
  );
  assert.equal(session.getRecordingFailures(), recordingThrows - beforeThrows);
  assert.equal(JSON.stringify({ stderr, events: sink.events }).includes("fixture-secret"), false);
    if (configured) assert.equal(sink.events[0]?.code, "best_effort_failed");
  assert.ok(session.getRecordingFailures() > 1, "multiple failures must be counted even though warning is emitted once");
});
}


test("Session recording failures: session completes normally despite throwing recorder", async () => {
  const adapter = makeMockAdapter([content("Hello"), finish("stop")]);
  const session = createInteractiveSession({
    adapter,
    model: "test-model",
    systemPrompt: "sys",
    maxTokens: 4096,
    temperature: 0,
    toolRegistry: createToolRegistry(),
    repositoryRoot: TEMP_ROOT,
    timeline: throwingTimeline(),
  });
  await captureStderr(async () => {
    session.addUserMessage("hi");
    await runTurn(session);
  });
  assert.equal(session.state().turnCount, 1, "the turn must complete despite recording failures");
});
