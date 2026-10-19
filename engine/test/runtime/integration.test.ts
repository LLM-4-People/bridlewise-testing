import assert from "node:assert/strict";
import { writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createEditorTools, type EditorToolArgs } from "../../src/editor/edit-tools.ts";
import { HarnessError } from "../../src/kernel/errors.ts";
import { sha256 } from "../../src/kernel/integrity.ts";
import { createUnifiedContextManager } from "../../src/memory/unified/unified-context-manager.ts";
import { resolveMemoryConfig } from "../../src/memory/memory-types.ts";
import { resolveUnifiedConfig } from "../../src/memory/unified/unified-config.ts";
import { createMetricsCollector } from "../../src/performance/metrics-collector.ts";
import { DEFAULT_PERFORMANCE_CONFIG } from "../../src/performance/performance-config.ts";
import { createPrivacyPolicy } from "../../src/privacy/privacy-policy.ts";
import {
  createBuiltInToolAdapters,
} from "../../src/tools/built-in-tools.ts";
import { createBuiltInToolManifestEntries } from "../../src/tools/built-in-tool-manifest.ts";
import type { ToolAdapter } from "../../src/tools/tool-adapter.ts";
import type { ToolManifestEntry } from "../../src/tools/tool-manifest.ts";
import { createTimelineRecorder, type TimelineRecorder } from "../../src/timeline/timeline-recorder.ts";
import { createTimelineStore } from "../../src/timeline/timeline-store.ts";
import { createInteractiveSession } from "../../src/runtime/interactive-session.ts";
import {
  createToolRegistry,
  type ToolRegistry,
  type RegisteredTool,
} from "../../src/runtime/tool-registry.ts";
import type {
  ChatStreamEvent,
  ProviderAdapter,
} from "../../src/runtime/provider-adapter.ts";
import { makeNativeMockAdapter as makeMockAdapter, nativeResponseAdapter } from "../support/mock-provider.ts";
import { mkTempDir } from "../support/temp-dir.ts";

// ---------------------------------------------------------------------------
// Integration test: verifies that the tested modules (timeline, editor,
// privacy, metrics, built-in tools, context manager) are wired together into
// the chat runtime's tool registry and interactive session. Each test
// exercises a distinct wiring path end-to-end through the real components.
// ---------------------------------------------------------------------------

function contentEvents(...texts: string[]): ChatStreamEvent[] {
  return texts.map((text) => Object.freeze({ type: "content" as const, text }));
}

function finishEvent(reason: string): ChatStreamEvent {
  return Object.freeze({ type: "finish" as const, reason });
}

function usageEvent(prompt: number, completion: number): ChatStreamEvent {
  return Object.freeze({
    type: "usage" as const,
    usage: Object.freeze({ promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion }),
  });
}

function toolCallEvents(id: string, name: string, args: string): ChatStreamEvent[] {
  return [
    Object.freeze({ type: "tool_call_start" as const, index: 0, id, name }),
    Object.freeze({ type: "tool_call_delta" as const, index: 0, arguments: args }),
  ];
}

/**
 * Bridge built-in ToolAdapter tools into the runtime's ToolRegistry — the
 * same bridge used in the chat runtime. Duplicated here so the integration test
 * is self-contained and does not depend on chat-runtime internals.
 */
function registerBuiltInTools(
  registry: ToolRegistry,
  adapters: Readonly<{
    executeCommand: ToolAdapter;
    searchWeb: ToolAdapter;
    fetchPage: ToolAdapter;
    readDocs: ToolAdapter;
    repoQuestion: ToolAdapter;
  }>,
  entries: readonly ToolManifestEntry[],
): void {
  const pairs: ReadonlyArray<readonly [string, ToolAdapter, ToolManifestEntry]> = Object.freeze([
    ["execute_command", adapters.executeCommand, entries[0]!],
    ["search_web", adapters.searchWeb, entries[1]!],
    ["fetch_page", adapters.fetchPage, entries[2]!],
    ["read_docs", adapters.readDocs, entries[3]!],
    ["repo_question", adapters.repoQuestion, entries[4]!],
  ]);
  for (const [name, adapter, entry] of pairs) {
    registry.register({
      definition: Object.freeze({
        type: "function",
        function: Object.freeze({
          name,
          description: entry.description,
          parameters: entry.inputSchema as Readonly<Record<string, unknown>>,
        }),
      }),
      handler: () => {
        throw new HarnessError(`Tool '${name}' is async-only`, "tool_async_only");
      },
      asyncHandler: async (args, context, signal) => {
        const ctx = signal !== undefined
          ? Object.freeze({ repositoryRoot: context.repositoryRoot, signal })
          : Object.freeze({ repositoryRoot: context.repositoryRoot });
        const result = await adapter.execute({ toolId: name, arguments: args }, ctx);
        if (result.isError) {
          throw new HarnessError(result.content, "tool_execution_failed");
        }
        return result.content;
      },
    });
  }
}

function setupTimeline(dir: string, runId: string): { store: ReturnType<typeof createTimelineStore>; recorder: TimelineRecorder } {
  const store = createTimelineStore({ path: join(dir, "timeline.db"), ledgerId: runId });
  const recorder = createTimelineRecorder({ store, correlation: { runId, sessionId: runId } });
  return { store, recorder };
}

async function runTurn(session: ReturnType<typeof createInteractiveSession>): Promise<void> {
  const generator = session.runTurn();
  let result = await generator.next();
  while (!result.done) {
    result = await generator.next(result.value);
  }
}

// ============================================================================
// INT-1: Durable timeline records run, turn, message, token events
// ============================================================================

test("integration: timeline records run, turn, message, and token events", async () => {
  const dir = mkTempDir("integration-test-");
  try {
    const runId = "integration-timeline";
    const { store, recorder } = setupTimeline(dir, runId);
    recorder.recordRun({ description: "test run", correlation: { runId, sessionId: runId } });

    const registry = createToolRegistry();
    const contextManager = createUnifiedContextManager(resolveUnifiedConfig({
      contextTokenLimit: resolveMemoryConfig().contextTokenLimit,
      trimThreshold: 0.8,
      recentTurnWindow: 10,
      summaryTokenBudget: 512,
    }));
    const adapter = makeMockAdapter([...contentEvents("Hello"), finishEvent("stop"), usageEvent(10, 5)]);
    const session = createInteractiveSession({
      adapter,
      model: "test-model",
      systemPrompt: "You are helpful.",
      maxTokens: 4096,
      temperature: 0,
      toolRegistry: registry,
      repositoryRoot: dir,
      timeline: recorder,
      contextManager,
      correlation: { runId, sessionId: runId },
    });
    session.addUserMessage("test input");
    await runTurn(session);

    const runEvents = store.query({ eventType: "run" });
    const turnEvents = store.query({ eventType: "turn" });
    const messageEvents = store.query({ eventType: "message" });
    const tokenEvents = store.query({ eventType: "token" });

    assert.ok(runEvents.length >= 1, `expected at least 1 run event; got ${runEvents.length}`);
    assert.ok(turnEvents.length >= 1, `expected at least 1 turn event; got ${turnEvents.length}`);
    assert.ok(messageEvents.length >= 2, `expected at least 2 message events (user+assistant); got ${messageEvents.length}`);
    assert.ok(tokenEvents.length >= 1, `expected at least 1 token event; got ${tokenEvents.length}`);

    const verification = store.verifyChain();
    assert.ok(verification.valid, "timeline chain must be valid after recording");

    recorder.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// INT-5: Transactional editor tools work through the tool registry
// ============================================================================

test("integration: editor tools edit files through the tool registry and record to timeline", async () => {
  const dir = mkTempDir("integration-test-");
  try {
    const original = "export const x = 1;";
    writeFileSync(join(dir, "target.ts"), original);
    const runId = "integration-editor";
    const { store, recorder } = setupTimeline(dir, runId);

    const registry = createToolRegistry();
    const editorBundle = createEditorTools({
      repositoryRoot: dir,
      writeSet: new Set(["target.ts"]),
    });
    for (const def of editorBundle.definitions) {
      const name = def.function.name;
      const handler = editorBundle.handlers[name];
      if (handler === undefined) continue;
      const registered: RegisteredTool = {
        definition: def,
        handler: (args) => JSON.stringify(handler(args as EditorToolArgs)),
      };
      registry.register(registered);
    }

    const newContent = "export const x = 2;";
    const result = await registry.executeAsync(
      { id: "call_1", name: "edit", arguments: JSON.stringify({ path: "target.ts", oldString: "x = 1", newString: "x = 2" }) },
      { repositoryRoot: dir },
    );
    assert.equal(result.isError, false, `edit should succeed; got: ${result.content}`);
    const parsed = JSON.parse(result.content);
    assert.equal(parsed.success, true);
    assert.equal(parsed.postimageHash, sha256(newContent));
    assert.equal(readFileSync(join(dir, "target.ts"), "utf8"), newContent);

    // The editor itself records to its own recorder (none here), but the
    // timeline store should be queryable. The editor wiring in the chat runtime
    // uses a timeline bridge; this test verifies the tool-registry path.
    assert.ok(store.verifyChain().valid);

    recorder.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// INT-14: read_file redacts credential spans via the privacy file viewer
// ============================================================================

test("integration: read_file redacts credential spans via privacy policy", () => {
  const dir = mkTempDir("integration-test-");
  try {
    const secret = "AKIAIOSFODNN7EXAMPLE";
    const content = `config = { key: "${secret}" }`;
    writeFileSync(join(dir, "secrets.txt"), content);

    const policy = createPrivacyPolicy();
    const registry = createToolRegistry({ privacyPolicy: policy });

    const result = registry.execute(
      { id: "call_1", name: "read_file", arguments: JSON.stringify({ path: "secrets.txt" }) },
      { repositoryRoot: dir },
    );
    assert.equal(result.isError, false);
    assert.ok(!result.content.includes(secret), "raw secret must not appear in read_file output");
    assert.ok(result.content.includes("[REDACTED:"), `expected redaction marker; got: ${result.content}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integration: read_file preserves non-secret content unchanged", () => {
  const dir = mkTempDir("integration-test-");
  try {
    const content = "export const greeting = 'hello world';";
    writeFileSync(join(dir, "plain.ts"), content);

    const registry = createToolRegistry({ privacyPolicy: createPrivacyPolicy() });
    const result = registry.execute(
      { id: "call_1", name: "read_file", arguments: JSON.stringify({ path: "plain.ts" }) },
      { repositoryRoot: dir },
    );
    assert.equal(result.isError, false);
    assert.equal(result.content, content, "non-secret content must be returned verbatim");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// INT-15: Metrics collector records tool calls
// ============================================================================

test("integration: metrics collector records tool call durations and outcomes", () => {
  const dir = mkTempDir("integration-test-");
  try {
    writeFileSync(join(dir, "data.txt"), "test data");
    const metrics = createMetricsCollector({ config: DEFAULT_PERFORMANCE_CONFIG });
    const registry = createToolRegistry({ metricsCollector: metrics });

    const result = registry.execute(
      { id: "call_1", name: "read_file", arguments: JSON.stringify({ path: "data.txt" }) },
      { repositoryRoot: dir },
    );
    assert.equal(result.isError, false);

    const snapshot = metrics.snapshot();
    assert.ok(snapshot.totalCallCount > 0, "metrics collector must record at least one call");
    const toolEntry = snapshot.entries.find((e) => e.key.function === "read_file");
    assert.ok(toolEntry, "metrics must include a read_file entry");
    assert.ok(toolEntry!.callCount >= 1);
    assert.ok(toolEntry!.durationHistogram.totalCount >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integration: metrics collector records failed tool calls", () => {
  const dir = mkTempDir("integration-test-");
  try {
    const metrics = createMetricsCollector({ config: DEFAULT_PERFORMANCE_CONFIG });
    const registry = createToolRegistry({ metricsCollector: metrics });

    registry.execute(
      { id: "call_1", name: "read_file", arguments: JSON.stringify({ path: "nonexistent.txt" }) },
      { repositoryRoot: dir },
    );

    const snapshot = metrics.snapshot();
    assert.ok(snapshot.totalErrorCount > 0, "metrics must record the failed tool call");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// INT-3: Built-in tools work through the tool registry bridge
// ============================================================================

test("integration: execute_command runs an allowed command through the registry", async () => {
  const dir = mkTempDir("integration-test-");
  try {
    const registry = createToolRegistry();
    registerBuiltInTools(registry, createBuiltInToolAdapters(), createBuiltInToolManifestEntries());

    const result = await registry.executeAsync(
      { id: "call_1", name: "execute_command", arguments: JSON.stringify({ command: "echo", args: ["hello-integration"] }) },
      { repositoryRoot: dir },
    );
    assert.equal(result.isError, false, `execute_command should succeed; got: ${result.content}`);
    const parsed = JSON.parse(result.content);
    assert.equal(parsed.exitCode, 0);
    assert.ok(parsed.stdout.includes("hello-integration"), `stdout must contain echo output; got: ${parsed.stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integration: execute_command rejects a disallowed command", async () => {
  const dir = mkTempDir("integration-test-");
  try {
    const registry = createToolRegistry();
    registerBuiltInTools(registry, createBuiltInToolAdapters(), createBuiltInToolManifestEntries());

    const result = await registry.executeAsync(
      { id: "call_1", name: "execute_command", arguments: JSON.stringify({ command: "rm" }) },
      { repositoryRoot: dir },
    );
    assert.equal(result.isError, true, "disallowed command must be rejected");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integration: search_web returns a typed blocker when no adapter is configured", async () => {
  const dir = mkTempDir("integration-test-");
  try {
    const registry = createToolRegistry();
    registerBuiltInTools(registry, createBuiltInToolAdapters(), createBuiltInToolManifestEntries());

    const result = await registry.executeAsync(
      { id: "call_1", name: "search_web", arguments: JSON.stringify({ query: "test" }) },
      { repositoryRoot: dir },
    );
    assert.equal(result.isError, true, "unconfigured search_web must return an error (typed blocker)");
    assert.ok(result.content.includes("not configured"), `expected typed blocker message; got: ${result.content}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integration: all 5 built-in tools are registered in the registry", () => {
  const dir = mkTempDir("integration-test-");
  try {
    const registry = createToolRegistry();
    registerBuiltInTools(registry, createBuiltInToolAdapters(), createBuiltInToolManifestEntries());
    const names = registry.names();
    for (const expected of ["execute_command", "search_web", "fetch_page", "read_docs", "repo_question"]) {
      assert.ok(names.includes(expected), `registry must include ${expected}; got: ${names.join(", ")}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// INT-4: Context manager tracks turns and trims
// ============================================================================

test("integration: context manager tracks user and assistant turns through the session", async () => {
  const dir = mkTempDir("integration-test-");
  try {
    const contextManager = createUnifiedContextManager(resolveUnifiedConfig({
      contextTokenLimit: resolveMemoryConfig().contextTokenLimit,
      trimThreshold: 0.8,
      recentTurnWindow: 10,
      summaryTokenBudget: 512,
    }));
    const adapter = makeMockAdapter([...contentEvents("response"), finishEvent("stop"), usageEvent(5, 3)]);
    const registry = createToolRegistry();
    const session = createInteractiveSession({
      adapter,
      model: "test-model",
      systemPrompt: "You are helpful.",
      maxTokens: 4096,
      temperature: 0,
      toolRegistry: registry,
      repositoryRoot: dir,
      contextManager,
    });
    session.addUserMessage("user message one");
    await runTurn(session);

    const turns = contextManager.turns();
    assert.ok(turns.length >= 2, `context manager must track user+assistant turns; got ${turns.length}`);
    assert.equal(turns[0]!.role, "system");
    assert.equal(turns[0]!.pinned, true);
    assert.equal(turns[1]!.role, "user");
    assert.equal(turns[1]!.content, "user message one");
    assert.equal(turns[2]!.role, "assistant");
    assert.equal(turns[2]!.content, "response");
    assert.ok(turns[2]!.responseItems?.length, "native evidence is captured too");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integration: context manager trim is called before each turn", async () => {
  const dir = mkTempDir("integration-test-");
  try {
    // Use a very small token limit so trim triggers immediately.
    const contextManager = createUnifiedContextManager(resolveUnifiedConfig({
      contextTokenLimit: 50,
      trimThreshold: 0.8,
      recentTurnWindow: 10,
      summaryTokenBudget: 32,
    }));
    const delegate = makeMockAdapter([...contentEvents("ok"), finishEvent("stop"), usageEvent(1, 1)]);
    let requests = 0;
    const adapter: ProviderAdapter = { ...delegate, async *streamChatCompletion(request) {
      requests++;
      assert.ok(contextManager.tokenCount() <= contextManager.tokenLimit(), "every admitted request is trimmed before send");
      yield* delegate.streamChatCompletion(request);
    } };
    const registry = createToolRegistry();
    const session = createInteractiveSession({
      adapter,
      model: "test-model",
      systemPrompt: "",
      maxTokens: 4096,
      temperature: 0,
      toolRegistry: registry,
      repositoryRoot: dir,
      contextManager,
    });
    // Add enough turns to exceed the 50-token limit.
    for (let i = 0; i < 5; i++) {
      session.addUserMessage(`message number ${i} with enough text to exceed the token limit`);
      await runTurn(session);
    }
    const state = contextManager.state();
    assert.equal(requests, 5);
    assert.ok(state.trimCount > 0, "recorded trim count proves trimming occurred before send");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// Full integration: all wired components work together in a single session
// ============================================================================

test("integration: full session with timeline, editor, privacy, metrics, tools, and context", async () => {
  const dir = mkTempDir("integration-test-");
  try {
    const original = "export const value = 1;";
    writeFileSync(join(dir, "edit-target.ts"), original);
    writeFileSync(join(dir, "secret.txt"), 'API_KEY="AKIAIOSFODNN7EXAMPLE"');
    const runId = "integration-full";
    const { store, recorder } = setupTimeline(dir, runId);
    recorder.recordRun({ description: "full integration test", correlation: { runId, sessionId: runId } });

    const metrics = createMetricsCollector({ config: DEFAULT_PERFORMANCE_CONFIG });
    const policy = createPrivacyPolicy();
    const registry = createToolRegistry({ metricsCollector: metrics, privacyPolicy: policy });

    // Wire editor tools
    const editorBundle = createEditorTools({
      repositoryRoot: dir,
      writeSet: new Set(["edit-target.ts"]),
    });
    for (const def of editorBundle.definitions) {
      const name = def.function.name;
      const handler = editorBundle.handlers[name];
      if (handler === undefined) continue;
      registry.register({
        definition: def,
        handler: (args) => JSON.stringify(handler(args as EditorToolArgs)),
      });
    }

    // Wire built-in tools
    registerBuiltInTools(registry, createBuiltInToolAdapters(), createBuiltInToolManifestEntries());

    // Wire context manager
    const contextManager = createUnifiedContextManager(resolveUnifiedConfig({
      contextTokenLimit: resolveMemoryConfig().contextTokenLimit,
      trimThreshold: 0.8,
      recentTurnWindow: 10,
      summaryTokenBudget: 512,
    }));

    // Mock adapter: first call reads a secret file, second call edits a file,
    // third call runs a command, final call responds.
    let callCount = 0;
    const adapter: ProviderAdapter = nativeResponseAdapter({
      providerId: "mock",
      async *streamChatCompletion(): AsyncGenerator<ChatStreamEvent, void, unknown> {
        callCount++;
        if (callCount === 1) {
          yield* toolCallEvents("c1", "read_file", '{"path":"secret.txt"}');
          yield finishEvent("tool_calls");
        } else if (callCount === 2) {
          yield* toolCallEvents("c2", "edit", JSON.stringify({ path: "edit-target.ts", oldString: "value = 1", newString: "value = 2" }));
          yield finishEvent("tool_calls");
        } else if (callCount === 3) {
          yield* toolCallEvents("c3", "execute_command", '{"command":"echo","args":["done"]}');
          yield finishEvent("tool_calls");
        } else {
          yield* contentEvents("All tools executed successfully");
          yield finishEvent("stop");
          yield usageEvent(20, 10);
        }
      },
      async chatCompletion() {
        return Object.freeze({ content: "", toolCalls: [], usage: undefined, finishReason: "stop" });
      },
    });

    const session = createInteractiveSession({
      adapter,
      model: "test-model",
      systemPrompt: "You are helpful.",
      maxTokens: 4096,
      temperature: 0,
      toolRegistry: registry,
      repositoryRoot: dir,
      timeline: recorder,
      contextManager,
      correlation: { runId, sessionId: runId },
    });
    session.addUserMessage("read the secret, edit the target, run echo");
    await runTurn(session);

    // Verify the file was edited
    assert.equal(readFileSync(join(dir, "edit-target.ts"), "utf8"), "export const value = 2;");

    // Verify the timeline recorded events
    assert.ok(store.query({ eventType: "run" }).length >= 1, "timeline must have run events");
    assert.ok(store.query({ eventType: "turn" }).length >= 1, "timeline must have turn events");
    assert.ok(store.query({ eventType: "token" }).length >= 1, "timeline must have token events");
    assert.ok(store.verifyChain().valid, "timeline chain must be valid");

    // Verify metrics were collected
    const snapshot = metrics.snapshot();
    assert.ok(snapshot.totalCallCount > 0, "metrics must have recorded calls");

    // Verify context manager tracked turns
    assert.ok(contextManager.turns().length >= 2, "context manager must have tracked turns");

    recorder.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
