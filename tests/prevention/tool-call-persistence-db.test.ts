// @vitest-environment node
/**
 * Prevention test: tool calls persist correctly across reload.
 *
 * This is a DB-level integration test (not a source-string scan). It
 * exercises the REAL DbClient with an in-memory SQLite DB, simulating the
 * exact sequence the run stream performs:
 * 1. tool_call_start → create a "tool" role message + a "running" tool_call row
 * 2. tool_call_done → UPDATE the existing row with the parsed input
 * 3. tool_result → UPDATE the row with output + "done" status + duration
 *
 * Assertions:
 * Exactly ONE "tool" role message exists (not zero, not two).
 * Exactly ONE tool_call row exists (no duplicate "done" row).
 * The tool_call row is linked to the "tool" message (messageId matches).
 * The final status is "done" (not "running").
 * The output and duration are persisted.
 * getChatHistory returns the tool message + tool call so the client can
 * hydrate the tool card on reload.
 *
 * Regression guards: if anyone reintroduces the bug where tool_call_done
 * calls createToolCall instead of updateToolCall, the "exactly one row"
 * assertion fails. If tool_call_start links to the assistant message
 * instead of creating a tool message, the "exactly one tool message"
 * assertion fails.
 */
import { describe, it, expect } from "vitest";
import { DbClient } from "../../server/db/client.ts";
import { toolCallToView } from "../../server/routes/views.ts";

import { join } from "node:path";
import { createTempDir } from "../helpers/temp-dir.ts";

function makeDb(): DbClient {
  const dir = createTempDir("harness-tool-persist-");
  return new DbClient({ path: join(dir, "test.db") });
}

describe("tool-call-persistence-integration", () => {
  it("tool_call_start creates a tool message + running tool_call; tool_call_done updates (not duplicates); tool_result finalizes", () => {
    const db = makeDb();
    const project = db.createProject({ name: "Test", path: "/tmp/test" }, "sess-1");
    const chat = db.createChat({ project_id: project.id, title: "Chat" }, "sess-1");

    // Simulate the run stream: user message → assistant message → tool call.
    db.createMessage({ chat_id: chat.id, role: "user", content: "list files" }, "sess-1");

    // tool_call_start: create a "tool" role message + running tool_call row.
    const toolMsg = db.createMessage({
      chat_id: chat.id,
      role: "tool",
      content: "",
      run_id: "run-1",
    }, "sess-1");
    const toolRow = db.createToolCall({
      message_id: toolMsg.id,
      tool_name: "list_files",
      input: null,
      status: "running",
    }, "sess-1");

    // tool_call_done: UPDATE the existing row (NOT create a new one).
    db.updateToolCall(toolRow.id, "sess-1", { input: { path: "." } });

    // tool_result: UPDATE with output + done status + duration.
    db.updateToolCall(toolRow.id, "sess-1", {
      output: "file1.ts\nfile2.ts",
      status: "done",
      durationMs: 42,
    });

    // ── Assertions ──

    // Exactly ONE tool role message.
    const messages = db.listMessages(chat.id, "sess-1");
    const toolMessages = messages.filter((m) => m.role === "tool");
    expect(toolMessages.length, "exactly one 'tool' role message must exist").toBe(1);

    // Exactly ONE tool_call row (no duplicate).
    const toolCalls = db.listToolCallsByChat(chat.id, "sess-1");
    expect(toolCalls.length, "exactly one tool_call row (no duplicate 'done' row)").toBe(1);

    // The tool_call row is linked to the tool message.
    expect(toolCalls[0]!.message_id, "tool_call row must link to the tool message").toBe(toolMsg.id);

    // Final status is "done".
    expect(toolCalls[0]!.status, "final status must be 'done' (not 'running')").toBe("done");

    // Output and duration persisted.
    expect(toolCalls[0]!.output, "output must be persisted").toBe("file1.ts\nfile2.ts");
    expect(toolCalls[0]!.duration_ms, "duration must be persisted").toBe(42);

    // Input persisted from tool_call_done.
    expect(toolCalls[0]!.input, "input must be persisted from tool_call_done").toEqual({ path: "." });

    // getChatHistory returns both the tool message and the tool call.
    const history = db.getChatHistory(chat.id, "sess-1");
    expect(history, "getChatHistory must return non-null").not.toBeNull();
    expect(history!.messages.some((m) => m.role === "tool"), "history must include the tool message").toBe(true);
    expect(history!.tool_calls.length, "history must include the tool call").toBe(1);
    expect(history!.tool_calls[0]!.message_id, "history tool_call links to tool message").toBe(toolMsg.id);
  });

  it("tool_call errors persist (status 'error' survives reload)", () => {
    const db = makeDb();
    const project = db.createProject({ name: "Test", path: "/tmp/test2" }, "sess-1");
    const chat = db.createChat({ project_id: project.id, title: "Chat" }, "sess-1");

    const toolMsg = db.createMessage({
      chat_id: chat.id,
      role: "tool",
      content: "",
      run_id: "run-2",
    }, "sess-1");
    const toolRow = db.createToolCall({
      message_id: toolMsg.id,
      tool_name: "write_file",
      input: null,
      status: "running",
    }, "sess-1");
    // tool execution failed → status "error", output is the error message.
    db.updateToolCall(toolRow.id, "sess-1", {
      input: { path: "/readonly/file.ts" },
      output: "EACCES: permission denied",
      status: "error",
      durationMs: 5,
    });

    const toolCalls = db.listToolCallsByChat(chat.id, "sess-1");
    expect(toolCalls.length).toBe(1);
    expect(toolCalls[0]!.status, "error status must persist").toBe("error");
    expect(toolCalls[0]!.output, "error output must persist").toBe("EACCES: permission denied");
  });

  it("error model events persist as 'error' role messages (survive reload)", () => {
    const db = makeDb();
    const project = db.createProject({ name: "Test", path: "/tmp/test3" }, "sess-1");
    const chat = db.createChat({ project_id: project.id, title: "Chat" }, "sess-1");

    db.createMessage({
      chat_id: chat.id,
      role: "error",
      content: "rate limit exceeded",
      model_event_type: "error",
      run_id: "run-3",
    }, "sess-1");

    const messages = db.listMessages(chat.id, "sess-1");
    const errorMessages = messages.filter((m) => m.role === "error");
    expect(errorMessages.length, "error message must persist").toBe(1);
    expect(errorMessages[0]!.content, "error content must persist").toBe("rate limit exceeded");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// ALL tool-call fields survive a refresh — name, arguments,
// result, status, timing (duration), AND attempt count. The attempt count
// was previously in-memory only (run.ts toolAttemptCounts Map) and vanished
// on every page refresh; it is now persisted on the tool_call row (migration
// v11) so the "attempt N" badge survives reload. This block verifies the
// full field set survives a DB close + reopen (a simulated refresh) AND
// that the run-stream sequence (tool_call_start → tool_result with
// attemptCount) round-trips through getChatHistory → toolCallToView.
// ──────────────────────────────────────────────────────────────────────────
describe("tool-call-persistence — all fields survive refresh", () => {
  it("attempt_count defaults to 1 and persists across a refresh", () => {
    const dir = createTempDir("harness-tc-attempt-");
    const dbPath = join(dir, "attempt.db");
    // Process 1: create a tool call WITHOUT attempt_count (defaults to 1)
    // and one WITH an explicit attempt count (a retry).
    {
      const db = new DbClient({ path: dbPath });
      try {
        const project = db.createProject({ name: "P", path: "/p" }, "sess-1");
        const chat = db.createChat({ project_id: project.id, title: "C" }, "sess-1");
        const fresh = db.createMessage({ chat_id: chat.id, role: "tool", content: "", run_id: "r1" }, "sess-1");
        db.createToolCall({ message_id: fresh.id, tool_name: "read_file", input: null, status: "running" }, "sess-1");
        db.updateToolCall(db.listToolCallsByChat(chat.id, "sess-1")[0]!.id, "sess-1", {
          input: { path: "a.ts" },
          output: "ok",
          status: "done",
          durationMs: 12,
          // No attemptCount → stays at the default 1.
        });
        // A retried (failed-then-retried) tool call with attempt_count = 3.
        const retry = db.createMessage({ chat_id: chat.id, role: "tool", content: "", run_id: "r1" }, "sess-1");
        db.createToolCall({ message_id: retry.id, tool_name: "search_code", input: null, status: "running" }, "sess-1");
        db.updateToolCall(db.listToolCallsByChat(chat.id, "sess-1")[1]!.id, "sess-1", {
          input: { pattern: "x" },
          output: "retry-ok",
          status: "done",
          durationMs: 99,
          attemptCount: 3,
        });
      } finally {
        db.close();
      }
    }
    // Process 2 (refresh): new DbClient → rehydrate via getChatHistory.
    {
      const db = new DbClient({ path: dbPath });
      try {
        const chat = db.listChats(db.listProjects("sess-1")[0]!.id, "sess-1")[0]!;
        const history = db.getChatHistory(chat.id, "sess-1");
        expect(history).not.toBeNull();
        const tcs = history!.tool_calls;
        expect(tcs.length).toBe(2);
        // Fresh call: attempt_count = 1 (default).
        expect(tcs[0]!.attempt_count, "fresh call attempt_count defaults to 1").toBe(1);
        expect(tcs[0]!.tool_name).toBe("read_file");
        expect(tcs[0]!.input).toEqual({ path: "a.ts" });
        expect(tcs[0]!.output).toBe("ok");
        expect(tcs[0]!.status).toBe("done");
        expect(tcs[0]!.duration_ms).toBe(12);
        // Retried call: attempt_count = 3 survives the refresh.
        expect(tcs[1]!.attempt_count, "retried call attempt_count survives refresh").toBe(3);
        expect(tcs[1]!.duration_ms).toBe(99);
      } finally {
        db.close();
      }
    }
  });

  it("the run-stream sequence round-trips every field through toolCallToView", async () => {
    // Verify the server→client view mapping (views.ts toolCallToView) carries
    // attempt_count so the client hydrate can show the "attempt N" badge.
    const { toolCallToView } = await import("../../server/routes/views.ts");
    const dir = createTempDir("harness-tc-view-");
    const dbPath = join(dir, "view.db");
    const db = new DbClient({ path: dbPath });
    try {
      const project = db.createProject({ name: "P", path: "/p" }, "sess-1");
      const chat = db.createChat({ project_id: project.id, title: "C" }, "sess-1");
      const msg = db.createMessage({ chat_id: chat.id, role: "tool", content: "", run_id: "r" }, "sess-1");
      db.createToolCall({ message_id: msg.id, tool_name: "read_file", input: { path: "x.ts" }, output: "y", status: "done", duration_ms: 5, attempt_count: 4 }, "sess-1");
      const row = db.listToolCallsByChat(chat.id, "sess-1")[0]!;
      const view = toolCallToView(row);
      // Every field the client hydrate reads must be present + correct.
      expect(view.toolName).toBe("read_file");
      expect(view.input).toEqual({ path: "x.ts" });
      expect(view.output).toBe("y");
      expect(view.status).toBe("done");
      expect(view.durationMs).toBe(5);
      expect(view.attemptCount, "attemptCount must round-trip through the view").toBe(4);
      expect(view.messageId).toBe(msg.id);
    } finally {
      db.close();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// THE RUN-END READ-BACK — the ledger row is servable with its result even
// when the SSE feed never delivered (or already evicted) the result frame.
//
// The measured incident: a gate-blocked call's result sat in the DB while
// the client card claimed "no result — the run completed without this tool
// returning a result". The heal closes that by reading the chat's tool
// calls back at run end — which is only possible because (a) the read-back
// builder serves status + output + the callId the live card joins on, and
// (b) the callId (the identity the whole stream keys by) is PERSISTED on
// the row (migration v17) rather than living only in the run handler's
// memory. These arms pin both halves at the DB + view boundary; the
// frame-eviction context is driven end-to-end in run-ends-are-announced.
// ──────────────────────────────────────────────────────────────────────────
describe("tool-call-persistence — the run-end read-back", () => {
  it("persists the callId and serves it through the view (the heal's join key)", () => {
    const db = makeDb();
    const project = db.createProject({ name: "P", path: "/p" }, "sess-1");
    const chat = db.createChat({ project_id: project.id, title: "C" }, "sess-1");
    const msg = db.createMessage({ chat_id: chat.id, role: "tool", content: "", run_id: "r" }, "sess-1");
    db.createToolCall(
      { message_id: msg.id, tool_name: "create_artifact", call_id: "call-heal-1", input: { type: "app" }, status: "running" },
      "sess-1",
    );
    const row = db.listToolCallsByChat(chat.id, "sess-1")[0]!;
    expect(row.call_id, "the provider's stable callId persists on the row").toBe("call-heal-1");

    const view = toolCallToView(row);
    expect(view.callId, "the view serves the callId the live card joins on").toBe("call-heal-1");
    db.close();
  });

  it("serves a row recorded before the callId existed as callId null, never a guess", () => {
    const db = makeDb();
    const project = db.createProject({ name: "P", path: "/p2" }, "sess-1");
    const chat = db.createChat({ project_id: project.id, title: "C" }, "sess-1");
    const msg = db.createMessage({ chat_id: chat.id, role: "tool", content: "", run_id: "r" }, "sess-1");
    // No call_id — the pre-v17 shape (and any caller that never knew one).
    db.createToolCall({ message_id: msg.id, tool_name: "read_file", input: null, status: "done", output: "ok" }, "sess-1");
    const row = db.listToolCallsByChat(chat.id, "sess-1")[0]!;
    expect(row.call_id).toBeNull();
    expect(toolCallToView(row).callId).toBeNull();
    db.close();
  });

  it("the read-back builder serves the RESULT of a call whose stream frame never mattered", async () => {
    // The incident's row: a gate-block refusal — status error, a real output.
    // The feed may have evicted the frame, the client may never have applied
    // it; the DB row is the authority and getChatHistoryPage (the bounded
    // read the /tool-calls route serves) must carry status + output + callId
    // so the heal can do its work from the ledger alone.
    const db = makeDb();
    const project = db.createProject({ name: "P", path: "/p3" }, "sess-1");
    const chat = db.createChat({ project_id: project.id, title: "C" }, "sess-1");
    const msg = db.createMessage({ chat_id: chat.id, role: "tool", content: "", run_id: "run-1d39fa59" }, "sess-1");
    const row = db.createToolCall(
      { message_id: msg.id, tool_name: "create_artifact", call_id: "call-strand", input: { type: "app" }, status: "running" },
      "sess-1",
    );
    db.updateToolCall(row.id, "sess-1", {
      output: "field 'type' must be one of: html, game, sheet, presentation, got \"app\"",
      status: "error",
      durationMs: 41,
      attemptCount: 1,
    });

    const page = db.getChatHistoryPage(chat.id, "sess-1", 50);
    expect(page, "the page read must exist").not.toBeNull();
    const served = page!.tool_calls.find((t) => t.call_id === "call-strand");
    expect(served, "the read-back builder must include the tool results").toBeDefined();
    expect(served!.status).toBe("error");
    expect(served!.output).toContain("must be one of: html, game, sheet, presentation");
    expect(served!.duration_ms).toBe(41);

    // And the view over that same row serves the heal's whole join payload.
    const view = toolCallToView(served!);
    expect(view.callId).toBe("call-strand");
    expect(view.status).toBe("error");
    expect(view.output).toContain("must be one of: html");
    db.close();
  });
});
