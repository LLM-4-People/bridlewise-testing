// @vitest-environment node
/**
 * Comprehensive message-persistence audit (exp519).
 *
 * The user: "we still lose metrics on page refresh/server reboot." This
 * test audits EVERY field on a chat message through the FULL real path the
 * harness uses:
 *
 * run-stream events → DbClient.createMessage / updateMessageContent /
 * updateMessageMetadata (the WRITE path in server/routes/run.ts)
 * → db.getChatHistory (the reload path, "sess-1")
 * → chatHistoryToView (the snake_case → camelCase view mapper)
 * → hydrateChatFromHistory (the client re-hydration in src/client.ts)
 * → assert every field survived on the reconstructed ChatMessage.
 *
 * Fields audited: content, role, timestamp, tokenMetrics (in/out/total/
 * cached/reasoning), timingMetrics (ttft/dur/tps/firstToken/finished),
 * reasoning, responseHeaders, responseModel, finishReason, context
 * (systemPrompt/toolNames/historyLength/modelId/recalledMemoryCount/
 * contextTokens/contextTokenLimit/contextTrimmed), dedupSummary (the
 * call's input-dedup savings), redactionNotice (the call's masked-input
 * fact: counts + confidence split + the upstream number + value-free
 * reasons), eventKind, tool calls
 * (name/input/output/status/duration), and the error-flush path for an
 * interrupted run.
 *
 * Uses the REAL DbClient (temp SQLite) + the REAL view mapper + the REAL
 * hydrate function — no mocks. If any field is lost anywhere in the chain,
 * the assertion fails and names the field.
 */
import { describe, it, expect, afterAll } from "vitest";
import { DbClient } from "../../server/db/client.ts";
import { chatHistoryToView } from "../../server/routes/views.ts";
import { hydrateChatFromHistory, type ChatHistoryView } from "../../src/client.ts";
import type { MessageMetadataUpdate } from "../../server/db/client.ts";

import { join } from "node:path";
import { createTempDir } from "../helpers/temp-dir.ts";

/** The tmpdirs + DBs created by `makeDb()` — cleaned up in `afterAll` so the
 * suite does not leak `harness-persist-audit-*` dirs or DB file handles. */
const CREATED_DIRS: string[] = [];
const CREATED_DBS: DbClient[] = [];

function makeDb(): DbClient {
  const dir = createTempDir("harness-persist-audit-");
  CREATED_DIRS.push(dir);
  const db = new DbClient({ path: join(dir, "test.db") });
  CREATED_DBS.push(db);
  return db;
}

afterAll(() => {
  for (const db of CREATED_DBS) {
    try { db.close(); } catch { /* best effort */ }
  }
  for (const dir of CREATED_DIRS) {
  }
});

/** Simulate the run-stream "finish" metadata write exactly as run.ts does. */
function writeFullMetadata(db: DbClient, msgId: string): void {
  const metadata: MessageMetadataUpdate = {
    reasoning: "step 1: think\nstep 2: act",
    tokenMetrics: {
      inputTokens: 521,
      outputTokens: 1843,
      totalTokens: 2364,
      cachedInputTokens: 100,
      reasoningTokens: 50,
    },
    timingMetrics: {
      startedAt: 1000,
      firstTokenAt: 1050,
      finishedAt: 2000,
      ttftMs: 50,
      totalMs: 1000,
      tps: 1.8,
    },
    finishReason: "stop",
    responseHeaders: { "x-request-id": "req-abc", "x-ratelimit-remaining": "59" },
    responseModel: "gemma-4-31b",
    dedupSummary: {
      applied: true,
      originalChars: 2440,
      dedupedChars: 1845,
      charReductionPct: 24.39,
      removedBlocks: 5,
      removedLines: 31,
      messageCount: 5,
    },
    redactionNotice: {
      maskedCount: 2,
      proven: 1,
      format: 0,
      inferred: 1,
      maskedUpstream: 3,
      byTier: { selfValidating: 1, declaredValues: 1 },
      reasons: [
        { confidence: "proven", category: "credential", maskedLength: 24, explanation: "equals a credential this machine holds" },
        { confidence: "inferred", category: "password", maskedLength: 8, explanation: "the words around it introduced it and its shape agreed" },
      ],
    },
    context: {
      systemPrompt: "be helpful",
      toolNames: ["read_file", "search_code"],
      historyLength: 3,
      modelId: "gemma-4-31b",
      recalledMemoryCount: 2,
      contextTokens: 1800,
      contextTokenLimit: 32768,
      contextTrimmed: false,
    },
  };
  db.updateMessageMetadata(msgId, metadata, "sess-1");
}

describe("message-persistence audit (exp519 — every field survives refresh)", () => {
  it("assistant message: all rich metadata fields survive DB → view → hydrate", () => {
    const db = makeDb();
    const project = db.createProject({ name: "T", path: "/tmp/t" }, "sess-1");
    const chat = db.createChat({ project_id: project.id, title: "Chat" }, "sess-1");

    // Simulate the run stream: user prompt → start (empty assistant) → finish.
    db.createMessage({ chat_id: chat.id, role: "user", content: "hello" }, "sess-1");
    const msg = db.createMessage({
      chat_id: chat.id,
      role: "assistant",
      content: "",
      model_event_type: "start",
      run_id: "run-1",
    }, "sess-1");
    db.updateMessageContent(msg.id, "the answer", "sess-1", { model_event_type: "finish" });
    writeFullMetadata(db, msg.id);

    // ── The reload path: DB → view → hydrate ──
    const history = db.getChatHistory(chat.id, "sess-1")!;
    const view: ChatHistoryView = chatHistoryToView(history);
    const msgs = hydrateChatFromHistory(view);
    const assistant = msgs.find((m) => m.role === "assistant")!;

    // Core fields.
    expect(assistant.content, "content").toBe("the answer");
    expect(assistant.role, "role").toBe("assistant");
    expect(assistant.timestamp, "timestamp (finite)").toBeGreaterThan(0);

    // Token metrics (in/out/total/cached/reasoning).
    expect(assistant.tokenMetrics, "tokenMetrics must survive").toBeDefined();
    expect(assistant.tokenMetrics!.inputTokens, "tokenMetrics.inputTokens").toBe(521);
    expect(assistant.tokenMetrics!.outputTokens, "tokenMetrics.outputTokens").toBe(1843);
    expect(assistant.tokenMetrics!.totalTokens, "tokenMetrics.totalTokens").toBe(2364);
    expect(assistant.tokenMetrics!.cachedInputTokens, "tokenMetrics.cachedInputTokens").toBe(100);
    expect(assistant.tokenMetrics!.reasoningTokens, "tokenMetrics.reasoningTokens").toBe(50);

    // Timing metrics (ttft/dur/tps/firstToken/finished).
    expect(assistant.timingMetrics, "timingMetrics must survive").toBeDefined();
    expect(assistant.timingMetrics!.startedAt, "timingMetrics.startedAt").toBe(1000);
    expect(assistant.timingMetrics!.firstTokenAt, "timingMetrics.firstTokenAt").toBe(1050);
    expect(assistant.timingMetrics!.finishedAt, "timingMetrics.finishedAt").toBe(2000);
    expect(assistant.timingMetrics!.ttftMs, "timingMetrics.ttftMs").toBe(50);
    expect(assistant.timingMetrics!.totalMs, "timingMetrics.totalMs").toBe(1000);
    expect(assistant.timingMetrics!.tps, "timingMetrics.tps").toBe(1.8);

    // Reasoning.
    expect(assistant.reasoning, "reasoning must survive").toBe("step 1: think\nstep 2: act");

    // Response headers + model + finish reason.
    expect(assistant.responseHeaders, "responseHeaders must survive").toBeDefined();
    expect(assistant.responseHeaders!["x-request-id"]).toBe("req-abc");
    expect(assistant.responseHeaders!["x-ratelimit-remaining"]).toBe("59");
    expect(assistant.responseModel, "responseModel must survive").toBe("gemma-4-31b");
    expect(assistant.finishReason, "finishReason must survive").toBe("stop");

    // Context (all sub-fields).
    expect(assistant.context, "context must survive").toBeDefined();
    expect(assistant.context!.systemPrompt).toBe("be helpful");
    expect(assistant.context!.toolNames).toEqual(["read_file", "search_code"]);
    expect(assistant.context!.historyLength).toBe(3);
    expect(assistant.context!.modelId).toBe("gemma-4-31b");
    expect(assistant.context!.recalledMemoryCount).toBe(2);
    expect(assistant.context!.contextTokens).toBe(1800);
    expect(assistant.context!.contextTokenLimit).toBe(32768);
    expect(assistant.context!.contextTrimmed).toBe(false);

    // The dedup savings of THIS call (chars before/after, pct, blocks) —
    // the footer's savings face is identical live and reloaded.
    expect(assistant.dedupSummary, "dedupSummary must survive").toBeDefined();
    expect(assistant.dedupSummary!.applied).toBe(true);
    expect(assistant.dedupSummary!.originalChars).toBe(2440);
    expect(assistant.dedupSummary!.dedupedChars).toBe(1845);
    expect(assistant.dedupSummary!.charReductionPct).toBe(24.39);
    expect(assistant.dedupSummary!.removedBlocks).toBe(5);
    expect(assistant.dedupSummary!.removedLines).toBe(31);
    expect(assistant.dedupSummary!.messageCount).toBe(5);

    // The masked-input notice of THIS call (counts + confidence split +
    // the already-hidden-upstream number + value-free reasons) — the
    // footer's masking face is identical live and reloaded.
    expect(assistant.redactionNotice, "redactionNotice must survive").toBeDefined();
    expect(assistant.redactionNotice!.maskedCount).toBe(2);
    expect(assistant.redactionNotice!.proven).toBe(1);
    expect(assistant.redactionNotice!.format).toBe(0);
    expect(assistant.redactionNotice!.inferred).toBe(1);
    expect(assistant.redactionNotice!.maskedUpstream).toBe(3);
    expect(assistant.redactionNotice!.byTier).toEqual({ selfValidating: 1, declaredValues: 1 });
    expect(assistant.redactionNotice!.reasons).toHaveLength(2);
    expect(assistant.redactionNotice!.reasons[0]!.confidence).toBe("proven");
    expect(assistant.redactionNotice!.reasons[0]!.category).toBe("credential");
    expect(assistant.redactionNotice!.reasons[1]!.explanation).toBe(
      "the words around it introduced it and its shape agreed",
    );
  });

  it("tool message + tool call survive refresh (name/input/output/status/duration)", () => {
    const db = makeDb();
    const project = db.createProject({ name: "T", path: "/tmp/t2" }, "sess-1");
    const chat = db.createChat({ project_id: project.id, title: "Chat" }, "sess-1");
    const assistant = db.createMessage({
      chat_id: chat.id, role: "assistant", content: "", model_event_type: "start", run_id: "run-1",
    }, "sess-1");
    const toolMsg = db.createMessage({
      chat_id: chat.id, role: "tool", content: "", run_id: "run-1",
    }, "sess-1");
    const toolCall = db.createToolCall({
      message_id: toolMsg.id,
      tool_name: "search_code",
      input: { pattern: "foo" },
      output: "src/a.ts:1:foo",
      status: "done",
      duration_ms: 42,
    }, "sess-1");

    const history = db.getChatHistory(chat.id, "sess-1")!;
    const view = chatHistoryToView(history);
    const msgs = hydrateChatFromHistory(view);
    const tool = msgs.find((m) => m.role === "tool")!;
    expect(tool.toolCall, "toolCall must survive").toBeDefined();
    expect(tool.toolCall!.name).toBe("search_code");
    expect(tool.toolCall!.input).toEqual({ pattern: "foo" });
    expect(tool.toolCall!.output).toBe("src/a.ts:1:foo");
    expect(tool.toolCall!.status).toBe("done");
    expect(tool.toolCall!.durationMs).toBe(42);
    // Ensure the tool-call id is stable (used for the LLM history pairing).
    expect(tool.toolCall!.id).toBe(toolCall.id);
    void assistant;
  });

  it("interrupted run: the error-flush path preserves partial metadata", () => {
    // Simulate a run interrupted before "finish" (server crash mid-stream).
    // The error case in run.ts flushes accumulated fields so partial
    // exposure survives instead of being lost forever.
    const db = makeDb();
    const project = db.createProject({ name: "T", path: "/tmp/t3" }, "sess-1");
    const chat = db.createChat({ project_id: project.id, title: "Chat" }, "sess-1");
    const msg = db.createMessage({
      chat_id: chat.id, role: "assistant", content: "partial", model_event_type: "start", run_id: "run-1",
    }, "sess-1");
    // The start handler persists context early; finish never arrives.
    db.updateMessageMetadata(msg.id, {
      context: { systemPrompt: "sp", toolNames: [], historyLength: 0, contextTokens: 100, contextTokenLimit: 32768 },
    }, "sess-1");
    // The error handler merges (not replaces) the accumulated tokens+reasoning.
    db.updateMessageMetadata(msg.id, {
      reasoning: "partial thought",
      tokenMetrics: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      timingMetrics: { startedAt: 1000, finishedAt: 1500, totalMs: 500 },
      finishReason: "error",
      responseModel: "gemma-4-31b",
    }, "sess-1");

    const history = db.getChatHistory(chat.id, "sess-1")!;
    const view = chatHistoryToView(history);
    const msgs = hydrateChatFromHistory(view);
    const m = msgs.find((x) => x.role === "assistant")!;
    // The merge must preserve BOTH the early context AND the late tokens.
    expect(m.context, "context from start must survive the error merge").toBeDefined();
    expect(m.context!.contextTokens).toBe(100);
    expect(m.tokenMetrics!.totalTokens, "tokens from error flush must survive").toBe(30);
    expect(m.reasoning).toBe("partial thought");
    expect(m.responseModel).toBe("gemma-4-31b");
    expect(m.finishReason).toBe("error");
  });

  it("event message: eventKind survives via the metadata blob", () => {
    // An inline event message (hallucination/steering/…) stored with its
    // eventKind must survive a refresh (the eventKind is now in the schema).
    const db = makeDb();
    const project = db.createProject({ name: "T", path: "/tmp/t4" }, "sess-1");
    const chat = db.createChat({ project_id: project.id, title: "Chat" }, "sess-1");
    db.createMessage({ chat_id: chat.id, role: "user", content: "hi" }, "sess-1");
    const evt = db.createMessage({
      chat_id: chat.id, role: "event", content: "hallucination detected: ghost tool", run_id: "run-1",
    }, "sess-1");
    db.updateMessageMetadata(evt.id, { eventKind: "hallucination" as MessageMetadataUpdate["eventKind"] }, "sess-1");

    const history = db.getChatHistory(chat.id, "sess-1")!;
    const view = chatHistoryToView(history);
    const msgs = hydrateChatFromHistory(view);
    const e = msgs.find((m) => m.role === "event")!;
    expect(e.content).toBe("hallucination detected: ghost tool");
    expect(e.eventKind, "eventKind must survive refresh").toBe("hallucination");
  });

  it("event message: the CANONICAL eventId survives via the metadata blob (the documents fold's persistence)", () => {
    // persistInlineEvent (run-executor) writes the eventId the recording
    // returned into the message metadata; the round-trip below is what a
    // page refresh replays. Without it, a refreshed transcript shows event
    // beats their body but can no longer open their recorded documents.
    const db = makeDb();
    const project = db.createProject({ name: "T", path: "/tmp/t4b" }, "sess-1");
    const chat = db.createChat({ project_id: project.id, title: "Chat" }, "sess-1");
    db.createMessage({ chat_id: chat.id, role: "user", content: "hi" }, "sess-1");
    const evt = db.createMessage({
      chat_id: chat.id, role: "event", content: "bias detected: one source", run_id: "run-1",
      metadata: { eventKind: "bias" as MessageMetadataUpdate["eventKind"], timelineEventId: "9f2c31de-6b4e-4d5f-8a1c-77e20a53b0d2" },
    }, "sess-1");

    const history = db.getChatHistory(chat.id, "sess-1")!;
    const view = chatHistoryToView(history);
    const msgs = hydrateChatFromHistory(view);
    const e = msgs.find((m) => m.role === "event")!;
    expect(e.id).toBe(evt.id);
    expect(e.eventKind).toBe("bias");
    expect(e.timelineEventId, "the canonical address must survive refresh").toBe(
      "9f2c31de-6b4e-4d5f-8a1c-77e20a53b0d2",
    );
  });

  it("event messages are also reconstructed from timeline_refs", () => {
    // Even without a stored event message, timeline refs with a relevant
    // event type become inline event messages on hydrate (the dual path).
    const db = makeDb();
    const project = db.createProject({ name: "T", path: "/tmp/t5" }, "sess-1");
    const chat = db.createChat({ project_id: project.id, title: "Chat" }, "sess-1");
    db.createMessage({ chat_id: chat.id, role: "user", content: "hi", run_id: "run-1" }, "sess-1");
    db.createTimelineRef({
      chat_id: chat.id,
      event_id: "evt-1",
      event_type: "steering",
      timestamp: new Date().toISOString(),
      metadata: { description: "user steered the run", runId: "run-1" },
    }, "sess-1");

    const history = db.getChatHistory(chat.id, "sess-1")!;
    const view = chatHistoryToView(history);
    const msgs = hydrateChatFromHistory(view);
    const steered = msgs.find((m) => m.role === "event" && m.eventKind === "steering");
    expect(steered, "steering event must be reconstructed from timeline_ref").toBeDefined();
    expect(steered!.content).toContain("steered");
    // The ref's event_id IS the reconstructed message's canonical address —
    // the documents fold opens on it without a stored event message.
    expect(steered!.timelineEventId).toBe("evt-1");
  });

  it("user + error messages survive refresh", () => {
    const db = makeDb();
    const project = db.createProject({ name: "T", path: "/tmp/t6" }, "sess-1");
    const chat = db.createChat({ project_id: project.id, title: "Chat" }, "sess-1");
    db.createMessage({ chat_id: chat.id, role: "user", content: "user prompt" }, "sess-1");
    db.createMessage({ chat_id: chat.id, role: "error", content: "something failed", run_id: "run-1" }, "sess-1");

    const history = db.getChatHistory(chat.id, "sess-1")!;
    const view = chatHistoryToView(history);
    const msgs = hydrateChatFromHistory(view);
    expect(msgs.find((m) => m.role === "user")!.content).toBe("user prompt");
    expect(msgs.find((m) => m.role === "error")!.content).toBe("something failed");
  });

  it("metadata merge (not replace): sequential partial writes accumulate", () => {
    // The root-cause fix for "page refresh loses token in/out": updateMessageMetadata
    // must MERGE, not replace. A context write then a tokens write must keep both.
    const db = makeDb();
    const project = db.createProject({ name: "T", path: "/tmp/t7" }, "sess-1");
    const chat = db.createChat({ project_id: project.id, title: "Chat" }, "sess-1");
    const msg = db.createMessage({ chat_id: chat.id, role: "assistant", content: "x" }, "sess-1");
    db.updateMessageMetadata(msg.id, { context: { systemPrompt: "sp", toolNames: [], historyLength: 0 } }, "sess-1");
    db.updateMessageMetadata(msg.id, { tokenMetrics: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } }, "sess-1");
    db.updateMessageMetadata(msg.id, { reasoning: "r" }, "sess-1");

    const history = db.getChatHistory(chat.id, "sess-1")!;
    const view = chatHistoryToView(history);
    const msgs = hydrateChatFromHistory(view);
    const m = msgs[0]!;
    expect(m.context, "context must survive later partial writes (merge)").toBeDefined();
    expect(m.tokenMetrics!.totalTokens, "tokens must survive later partial writes (merge)").toBe(3);
    expect(m.reasoning, "reasoning must survive").toBe("r");
  });
});
