/**
 * Persistence comprehensive test (, third report — exp520).
 *
 * Verifies that EVERY field of a chat message survives a DB close + reopen
 * (simulating a server reboot / page refresh). This is the prevention test
 * for the "we still lose info on page refresh" bug.
 *
 * Tests:
 * 1. ALL metadata fields survive close/reopen:
 * reasoning, tokenMetrics, timingMetrics, responseHeaders,
 * responseModel, finishReason, context, eventKind.
 * 2. Tool call rows survive close/reopen (input, output, status, duration).
 * 3. Inline event messages (hallucination, steering) survive close/reopen.
 * 4. The metadata merge path preserves all fields across multiple writes.
 * 5. hydrateChatFromHistory restores ALL metadata fields onto ChatMessage.
 */

import { describe, test, expect } from "vitest";
import { join } from "node:path";
import { rmSync } from "node:fs";

import { DbClient } from "../../server/db/client.ts";
import { hydrateChatFromHistory, type ChatHistoryView } from "../../src/client.ts";
import { createTempDir } from "../helpers/temp-dir.ts";

function makeTempDbPath(): string {
  const dir = createTempDir("harness-persist-");
  return join(dir, "test.db");
}

function makeHistoryView(db: DbClient, chatId: string): ChatHistoryView {
  const history = db.getChatHistory(chatId, "u");
  if (history === null) throw new Error(`Chat ${chatId} not found`);
  return {
    chat: {
      id: history.chat.id,
      projectId: history.chat.project_id,
      title: history.chat.title,
      createdAt: history.chat.created_at,
      updatedAt: history.chat.updated_at,
      modelId: history.chat.model_id,
      pinned: history.chat.pinned !== 0,
    },
    messages: history.messages.map((m) => ({
      id: m.id,
      chatId: m.chat_id,
      role: m.role,
      content: m.content,
      createdAt: m.created_at,
      modelEventType: m.model_event_type,
      runId: m.run_id,
      metadata: m.metadata,
    })),
    toolCalls: history.tool_calls.map((tc) => ({
      id: tc.id,
      messageId: tc.message_id,
      callId: tc.call_id,
      toolName: tc.tool_name,
      input: tc.input,
      output: tc.output,
      status: tc.status,
      durationMs: tc.duration_ms,
      attemptCount: tc.attempt_count,
      createdAt: tc.created_at,
    })),
    metricsSnapshots: history.metrics_snapshots.map((ms) => ({
      id: ms.id,
      chatId: ms.chat_id,
      snapshot: ms.snapshot,
      createdAt: ms.created_at,
    })),
    timelineRefs: history.timeline_refs.map((tr) => ({
      id: tr.id,
      chatId: tr.chat_id,
      eventId: tr.event_id,
      eventType: tr.event_type,
      timestamp: tr.timestamp,
      metadata: tr.metadata,
    })),
  };
}

describe("exp520: comprehensive persistence — ALL fields survive close/reopen", () => {
  test("ALL metadata fields survive close/reopen", () => {
    const dbPath = makeTempDbPath();
    let db = new DbClient({ path: dbPath });

    // Create project + chat.
    const project = db.createProject({ name: "test-project", path: "/tmp/test" }, "u");
    const chat = db.createChat({ project_id: project.id, title: "test-chat" }, "u");

    // Create an assistant message with ALL metadata fields.
    const msg = db.createMessage({
      chat_id: chat.id,
      role: "assistant",
      content: "Hello world",
    }, "u");

    // Write ALL metadata fields in stages (simulating the run stream).
    db.updateMessageMetadata(msg.id, {
      context: {
        systemPrompt: "You are a helpful assistant.",
        toolNames: ["search_code", "read_file"],
        historyLength: 5,
        modelId: "gemma-4-31b",
        recalledMemoryCount: 3,
        contextTokens: 1500,
        contextTokenLimit: 8000,
        contextTrimmed: false,
      },
    }, "u");
    db.updateMessageMetadata(msg.id, {
      tokenMetrics: {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        cachedInputTokens: 20,
        reasoningTokens: 10,
      },
    }, "u");
    db.updateMessageMetadata(msg.id, {
      reasoning: "I should greet the user.",
      timingMetrics: {
        startedAt: 1700000000000,
        firstTokenAt: 1700000000500,
        finishedAt: 1700000002000,
        ttftMs: 500,
        totalMs: 2000,
        tps: 25.0,
      },
      responseHeaders: {
        "x-request-id": "req-123",
        "x-ratelimit-remaining": "99",
      },
      responseModel: "gemma-4-31b",
      finishReason: "stop",
    }, "u");

    db.close();

    // Reopen the DB (simulates server reboot).
    db = new DbClient({ path: dbPath });

    const messages = db.listMessages(chat.id, "u");
    expect(messages.length).toBe(1);
    const restored = messages[0]!;
    expect(restored.content).toBe("Hello world");
    expect(restored.role).toBe("assistant");

    const meta = restored.metadata as Record<string, unknown>;
    // Verify EVERY field survived.
    expect(meta["reasoning"]).toBe("I should greet the user.");
    expect(meta["tokenMetrics"]).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      cachedInputTokens: 20,
      reasoningTokens: 10,
    });
    expect(meta["timingMetrics"]).toEqual({
      startedAt: 1700000000000,
      firstTokenAt: 1700000000500,
      finishedAt: 1700000002000,
      ttftMs: 500,
      totalMs: 2000,
      tps: 25.0,
    });
    expect(meta["responseHeaders"]).toEqual({
      "x-request-id": "req-123",
      "x-ratelimit-remaining": "99",
    });
    expect(meta["responseModel"]).toBe("gemma-4-31b");
    expect(meta["finishReason"]).toBe("stop");
    expect(meta["context"]).toEqual({
      systemPrompt: "You are a helpful assistant.",
      toolNames: ["search_code", "read_file"],
      historyLength: 5,
      modelId: "gemma-4-31b",
      recalledMemoryCount: 3,
      contextTokens: 1500,
      contextTokenLimit: 8000,
      contextTrimmed: false,
    });

    db.close();
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  });

  test("tool call rows survive close/reopen", () => {
    const dbPath = makeTempDbPath();
    let db = new DbClient({ path: dbPath });

    const project = db.createProject({ name: "tp", path: "/tmp/tp" }, "u");
    const chat = db.createChat({ project_id: project.id, title: "tc" }, "u");

    // Create a tool message + tool_call row.
    const toolMsg = db.createMessage({
      chat_id: chat.id,
      role: "tool",
      content: "",
      run_id: "run-1",
    }, "u");
    const toolRow = db.createToolCall({
      message_id: toolMsg.id,
      tool_name: "search_code",
      input: null,
      status: "running",
    }, "u");
    db.updateToolCall(toolRow.id, "u", {
      input: { query: "test" },
      output: "result text",
      status: "done",
      durationMs: 42,
    });

    db.close();
    db = new DbClient({ path: dbPath });

    const toolCalls = db.listToolCallsByChat(chat.id, "u");
    expect(toolCalls.length).toBe(1);
    const tc = toolCalls[0]!;
    expect(tc.tool_name).toBe("search_code");
    expect(tc.input).toEqual({ query: "test" });
    expect(tc.output).toBe("result text");
    expect(tc.status).toBe("done");
    expect(tc.duration_ms).toBe(42);

    db.close();
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  });

  test("inline event messages (hallucination, steering) survive close/reopen", () => {
    const dbPath = makeTempDbPath();
    let db = new DbClient({ path: dbPath });

    const project = db.createProject({ name: "ev", path: "/tmp/ev" }, "u");
    const chat = db.createChat({ project_id: project.id, title: "events" }, "u");

    // Create event messages (as the run stream's persistInlineEvent would).
    db.createMessage({
      chat_id: chat.id,
      role: "event",
      content: "Ghost tool 'grep'use 'search_code' instead.",
      run_id: "run-1",
      metadata: { eventKind: "hallucination", timelineEventId: "event-gate" },
    }, "u");
    db.createMessage({
      chat_id: chat.id,
      role: "event",
      content: "Steered — new turn starting (0 queued)",
      run_id: "run-1",
      metadata: { eventKind: "steering", timelineEventId: "event-steer-a" },
    }, "u");
    db.createMessage({
      chat_id: chat.id,
      role: "event",
      content: "Steered — new turn starting (0 queued)",
      run_id: "run-1",
      metadata: { eventKind: "steering", timelineEventId: "event-steer-b" },
    }, "u");
    const recorded = db.listMessages(chat.id, "u");
    for (const message of recorded) {
      const metadata = message.metadata as { timelineEventId: string };
      db.createTimelineRef({
        chat_id: chat.id,
        event_id: metadata.timelineEventId,
        event_type: message === recorded[0] ? "error" : "agent",
        timestamp: message.created_at,
        metadata: { description: message.content },
      }, "u");
    }

    db.close();
    db = new DbClient({ path: dbPath });

    const messages = db.listMessages(chat.id, "u");
    expect(messages.length).toBe(recorded.length);
    expect(messages[0]!.role).toBe("event");
    expect(messages[0]!.content).toContain("Ghost tool");
    expect((messages[0]!.metadata as Record<string, unknown>)["eventKind"]).toBe("hallucination");
    expect(messages[1]!.role).toBe("event");
    expect((messages[1]!.metadata as Record<string, unknown>)["eventKind"]).toBe("steering");
    const restored = hydrateChatFromHistory(makeHistoryView(db, chat.id));
    expect(restored.map((message) => message.id), "saved primary rows retain their IDs through reference reconciliation").toEqual(recorded.map((message) => message.id));
    expect(new Set(restored.map((message) => message.timelineEventId)).size).toBe(recorded.length);
    expect(restored.filter((message) => message.eventKind === "steering"), "same-word steers survive close/reopen and hydration separately").toHaveLength(2);

    db.close();
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  });

  test("hydrateChatFromHistory restores ALL metadata fields onto ChatMessage", () => {
    const dbPath = makeTempDbPath();
    let db = new DbClient({ path: dbPath });

    const project = db.createProject({ name: "hyd", path: "/tmp/hyd" }, "u");
    const chat = db.createChat({ project_id: project.id, title: "hydrate" }, "u");

    const msg = db.createMessage({
      chat_id: chat.id,
      role: "assistant",
      content: "Response text",
    }, "u");
    db.updateMessageMetadata(msg.id, {
      reasoning: "thinking...",
      tokenMetrics: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      timingMetrics: { startedAt: 1000, totalMs: 500, tps: 10 },
      responseHeaders: { "x-test": "val" },
      responseModel: "qwen3.6-35b-fast",
      finishReason: "stop",
      context: {
        systemPrompt: "sys",
        toolNames: ["t1"],
        historyLength: 1,
      },
    }, "u");

    db.close();
    db = new DbClient({ path: dbPath });

    const view = makeHistoryView(db, chat.id);
    const restored = hydrateChatFromHistory(view);
    const assistantMsg = restored.find((m) => m.role === "assistant");

    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.content).toBe("Response text");
    expect(assistantMsg!.reasoning).toBe("thinking...");
    expect(assistantMsg!.tokenMetrics).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(assistantMsg!.timingMetrics?.startedAt).toBe(1000);
    expect(assistantMsg!.timingMetrics?.totalMs).toBe(500);
    expect(assistantMsg!.timingMetrics?.tps).toBe(10);
    expect(assistantMsg!.responseHeaders).toEqual({ "x-test": "val" });
    expect(assistantMsg!.responseModel).toBe("qwen3.6-35b-fast");
    expect(assistantMsg!.finishReason).toBe("stop");
    expect(assistantMsg!.context?.systemPrompt).toBe("sys");
    expect(assistantMsg!.context?.toolNames).toEqual(["t1"]);
    expect(assistantMsg!.context?.historyLength).toBe(1);

    db.close();
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  });

  test("metadata merge preserves all fields across multiple partial writes", () => {
    const dbPath = makeTempDbPath();
    let db = new DbClient({ path: dbPath });

    const project = db.createProject({ name: "merge", path: "/tmp/merge" }, "u");
    const chat = db.createChat({ project_id: project.id, title: "merge-test" }, "u");

    const msg = db.createMessage({
      chat_id: chat.id,
      role: "assistant",
      content: "",
    }, "u");

    // Simulate the run stream's staged writes:
    // 1. "start" handler writes context
    db.updateMessageMetadata(msg.id, { context: { systemPrompt: "s", toolNames: [], historyLength: 0 } }, "u");
    // 2. "usage" handler writes tokenMetrics (merge — must NOT clobber context)
    db.updateMessageMetadata(msg.id, { tokenMetrics: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } }, "u");
    // 3. "finish" handler writes reasoning + timing + finishReason + headers + model
    db.updateMessageMetadata(msg.id, {
      reasoning: "r",
      timingMetrics: { startedAt: 1, totalMs: 2 },
      finishReason: "stop",
      responseHeaders: { "h": "v" },
      responseModel: "m",
    }, "u");

    db.close();
    db = new DbClient({ path: dbPath });

    const restored = db.listMessages(chat.id, "u")[0]!;
    const meta = restored.metadata as Record<string, unknown>;

    // ALL fields must survive — the merge must not have clobbered any.
    expect(meta["context"]).toBeDefined();
    expect(meta["tokenMetrics"]).toBeDefined();
    expect(meta["reasoning"]).toBe("r");
    expect(meta["timingMetrics"]).toBeDefined();
    expect(meta["finishReason"]).toBe("stop");
    expect(meta["responseHeaders"]).toEqual({ "h": "v" });
    expect(meta["responseModel"]).toBe("m");

    db.close();
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  });
});
