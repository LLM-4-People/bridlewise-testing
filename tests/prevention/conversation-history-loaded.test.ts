// @vitest-environment node
/**
 * Prevention test for the conversation-memory bug.
 *
 * Root cause: `run.ts` initialized `conversationHistory` with ONLY the
 * current prompt, so the LLM forgot every prior turn. This test guards the
 * `buildConversationHistory` reconstruction helper (the single owner of
 * DB→ChatMessage[] mapping) so the regression can never reappear.
 *
 * Covers: simple multi-turn history, tool-call reconstruction with
 * consistent synthetic tool_call_id, incomplete tool calls, empty
 * assistant turns, error messages, and the current-prompt-last contract.
 */
import { describe, test, expect, beforeEach } from "vitest";
import { join } from "node:path";

import { DbClient } from "../../server/db/client.ts";
import { AsyncDbClient } from "../../server/db/async-client.ts";
import { buildConversationHistory } from "../../server/context/chat-history.ts";
import { createTempDir } from "../helpers/temp-dir.ts";

let tmpRoot = "";

beforeEach(() => {
  tmpRoot = createTempDir("ch-history-");
});

function freshDb(): DbClient {
  const path = join(tmpRoot, `hist-${Math.random().toString(36).slice(2)}.db`);
  return new DbClient({ path });
}

function seedChat(db: DbClient): { projectId: string; chatId: string } {
  const project = db.createProject({ name: "p", path: "/proj" }, "u");
  const chat = db.createChat({ project_id: project.id, title: "c" }, "u");
  return { projectId: project.id, chatId: chat.id };
}

describe("buildConversationHistory — memory reconstruction", () => {
  test("includes prior user+assistant turns before the current prompt", async () => {
    const db = freshDb();
    const { chatId } = seedChat(db);
    // Turn 1: user asks, assistant answers (persisted from a prior run).
    db.createMessage({ chat_id: chatId, role: "user", content: "What is 2+2?", run_id: "run-1" }, "u");
    const a1 = db.createMessage({ chat_id: chatId, role: "assistant", content: "", model_event_type: "start", run_id: "run-1" }, "u");
    db.updateMessageContent(a1.id, "It is 4.", "u");

    const history = await buildConversationHistory(AsyncDbClient.inline(db), { userId: "u", chatId: chatId, currentPrompt: "Now what is 3+3?" });

    // currentPrompt is LAST; prior turns precede it.
    expect(history.length).toBe(3);
    expect(history[0]).toEqual({ role: "user", content: "What is 2+2?" });
    expect(history[1]).toEqual({ role: "assistant", content: "It is 4." });
    expect(history[history.length - 1]).toEqual({ role: "user", content: "Now what is 3+3?" });
  });

  test("with no prior messages, history is just the current prompt", async () => {
    const db = freshDb();
    const { chatId } = seedChat(db);
    const history = await buildConversationHistory(AsyncDbClient.inline(db), { userId: "u", chatId: chatId, currentPrompt: "Hello" });
    expect(history).toEqual([{ role: "user", content: "Hello" }]);
  });

  test("reconstructs tool calls with matching tool_call_id on both sides", async () => {
    const db = freshDb();
    const { chatId } = seedChat(db);
    const runId = "run-tools";
    // user asks to read a file
    db.createMessage({ chat_id: chatId, role: "user", content: "read foo.ts", run_id: runId }, "u");
    // assistant turn (start) — will carry the tool call
    const assistant = db.createMessage({ chat_id: chatId, role: "assistant", content: "", model_event_type: "start", run_id: runId }, "u");
    db.updateMessageContent(assistant.id, "", "u"); // assistant emitted only a tool call, no text
    // tool message + tool_call row linked to it
    const toolMsg = db.createMessage({ chat_id: chatId, role: "tool", content: "", run_id: runId }, "u");
    const toolRow = db.createToolCall({ message_id: toolMsg.id, tool_name: "read_file", input: { path: "foo.ts" }, output: "export const x = 1;", status: "done" }, "u");

    const history = await buildConversationHistory(AsyncDbClient.inline(db), { userId: "u", chatId: chatId, currentPrompt: "what was in it?" });

    // assistant (content="" + tool_calls) → tool result → current prompt
    expect(history.length).toBe(4);
    expect(history[0]).toEqual({ role: "user", content: "read foo.ts" });
    const asst = history[1]!;
    expect(asst.role).toBe("assistant");
    expect(asst.content).toBe("");
    expect(Array.isArray(asst.tool_calls)).toBe(true);
    type HistoryToolCall = { id: string; type: string; function: { name: string; arguments: string } };
    const tc = (asst.tool_calls as ReadonlyArray<HistoryToolCall>)[0]!;
    expect(tc.id).toBe(toolRow.id);
    expect(tc.type).toBe("function");
    expect(tc.function.name).toBe("read_file");
    // tool result message uses the SAME id as tool_call_id (the contract)
    expect(history[2]).toEqual({ role: "tool", tool_call_id: toolRow.id, content: "export const x = 1;" });
    expect(history[3]).toEqual({ role: "user", content: "what was in it?" });
  });

  test("omits incomplete tool calls (no output) to keep the sequence valid", async () => {
    const db = freshDb();
    const { chatId } = seedChat(db);
    const runId = "run-inc";
    db.createMessage({ chat_id: chatId, role: "user", content: "read bar.ts", run_id: runId }, "u");
    const assistant = db.createMessage({ chat_id: chatId, role: "assistant", content: "", model_event_type: "start", run_id: runId }, "u");
    db.updateMessageContent(assistant.id, "Let me read it.", "u");
    const toolMsg = db.createMessage({ chat_id: chatId, role: "tool", content: "", run_id: runId }, "u");
    db.createToolCall({ message_id: toolMsg.id, tool_name: "read_file", input: { path: "bar.ts" }, output: undefined, status: "running" }, "u");

    const history = await buildConversationHistory(AsyncDbClient.inline(db), { userId: "u", chatId: chatId, currentPrompt: "again" });

    // The assistant had text, so it is emitted WITHOUT tool_calls (the
    // incomplete tool call is dropped — never an orphaned tool message).
    expect(history).toEqual([
      { role: "user", content: "read bar.ts" },
      { role: "assistant", content: "Let me read it." },
      { role: "user", content: "again" },
    ]);
  });

  test("skips empty assistant turns with no complete tool calls", async () => {
    const db = freshDb();
    const { chatId } = seedChat(db);
    const runId = "run-empty";
    db.createMessage({ chat_id: chatId, role: "user", content: "hi", run_id: runId }, "u");
    const a = db.createMessage({ chat_id: chatId, role: "assistant", content: "", model_event_type: "start", run_id: runId }, "u");
    db.updateMessageContent(a.id, "", "u"); // empty assistant, no tools

    const history = await buildConversationHistory(AsyncDbClient.inline(db), { userId: "u", chatId: chatId, currentPrompt: "hello?" });
    expect(history).toEqual([
      { role: "user", content: "hi" },
      { role: "user", content: "hello?" },
    ]);
  });

  test("never leaks error or system roles into the LLM history", async () => {
    const db = freshDb();
    const { chatId } = seedChat(db);
    const runId = "run-err";
    db.createMessage({ chat_id: chatId, role: "user", content: "boom", run_id: runId }, "u");
    db.createMessage({ chat_id: chatId, role: "error", content: "provider failed", model_event_type: "error", run_id: runId }, "u");

    const history = await buildConversationHistory(AsyncDbClient.inline(db), { userId: "u", chatId: chatId, currentPrompt: "retry" });
    expect(history.every((m) => (m.role as string) !== "error" && m.role !== "system")).toBe(true);
    expect(history).toEqual([
      { role: "user", content: "boom" },
      { role: "user", content: "retry" },
    ]);
  });

  test("maxHistoryMessages caps to the newest N messages", async () => {
    const db = freshDb();
    const { chatId } = seedChat(db);
    for (let k = 0; k < 6; k++) {
      db.createMessage({ chat_id: chatId, role: "user", content: `u${k}`, run_id: `r${k}` }, "u");
      db.createMessage({ chat_id: chatId, role: "assistant", content: `a${k}`, run_id: `r${k}` }, "u");
    }
    const history = await buildConversationHistory(AsyncDbClient.inline(db), { userId: "u", chatId: chatId, currentPrompt: "now", maxHistoryMessages: 4 });
    // newest 4 messages (u5,a5,u... actually last 4 rows: u4,a4,u5,a5) + current prompt
    expect(history.length).toBe(5);
    expect(history[history.length - 1]).toEqual({ role: "user", content: "now" });
  });
});
