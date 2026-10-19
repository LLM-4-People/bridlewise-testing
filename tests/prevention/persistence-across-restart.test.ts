// @vitest-environment node
/**
 * Prevention test: ALL DB data survives a server reboot AND is encrypted at rest.
 *
 * Root cause this guards against: the project path was encrypted at rest
 * with a per-process random key. On every restart a NEW key was generated,
 * so previously-encrypted paths became unrecoverable `enc:` ciphertext —
 * every project lost access to its directory. The previous fix REMOVED
 * encryption (plaintext at rest — a security risk the user rejected).
 *
 * The CORRECT fix (server/db-crypto.ts): encrypt ALL sensitive columns
 * with a PERSISTED key (a sibling `db-key` file, mode 0600, generated once
 * and never changed). The key SURVIVES reboots, so all `enc:` data remains
 * decryptable across server restarts. The disk stores ciphertext; the
 * DbClient transparently decrypts on read.
 *
 * This test creates a full data graph (project → chat → messages → tool
 * calls + metrics + auto-checks + timeline refs) in a REAL SQLite file,
 * CLOSES the DB, reopens with a BRAND-NEW DbClient instance (simulating a
 * fresh process/reboot — the key file is loaded, not regenerated), and
 * asserts every entity survives with its exact plaintext values (decrypted).
 * It also asserts the raw DB file on disk is ENCRYPTED (enc: prefix) —
 * proof that encryption-at-rest works (a thief who copies the file gets
 * ciphertext, not the user's paths/content).
 *
 * each fix must create a prevention test. never
 * weaken/fake a test. This uses a real file (not:memory:) because the bug
 * only manifests across process boundaries (the key must persist).
 */
import { describe, test, expect, beforeAll, vi } from "vitest";
import { DbClient } from "../../server/db/client.ts";
import { SCHEMA_VERSION_LATEST } from "../../server/db/schema.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createKeyHome, createTempDir } from "../helpers/temp-dir.ts";
import { preBindingCrypto } from "../helpers/data-loss-helpers.ts";

import { modulePathMatching } from "../helpers/module-resolver.ts";
let tmpRoot = "";
let dbPath = "";

beforeAll(() => {
  tmpRoot = createTempDir("ch-web-reboot-");
  dbPath = join(tmpRoot, "reboot-real.db");
});

describe("persistence across restart (real SQLite file)", () => {
  // IDs captured during the first "process" so the second can assert them.
  let projectId = "";
  let chatId = "";
  let userMsgId = "";
  let assistantMsgId = "";
  let toolCallId = "";
  let metricsId = "";
  let autoCheckId = "";
  let timelineRefId = "";

  test("process 1: create the full data graph", () => {
    const db = new DbClient({ path: dbPath });
    try {
      expect(db.schemaVersion).toBe(SCHEMA_VERSION_LATEST);

      // Project — the path MUST be plaintext (the bug was enc: ciphertext).
      const project = db.createProject(
        { name: "persistence-test", path: "/home/example/my-project" },
        "session-reboot-1",
      );
      projectId = project.id;
      expect(project.path).toBe("/home/example/my-project");
      expect(project.path.startsWith("enc:")).toBe(false);

      // Chat with a model + pinned.
      const chat = db.createChat({ project_id: projectId, title: "reboot chat", model_id: "gemma-4-31b" }, "session-reboot-1");
      chatId = chat.id;
      db.setChatPinned(chatId, true, "session-reboot-1");

      // User message with metadata blob (reasoning, tokens, headers, context).
      const userMsg = db.createMessage({
        chat_id: chatId,
        role: "user",
        content: "hello from before the reboot",
      }, "session-reboot-1");
      userMsgId = userMsg.id;

      // Assistant message with the full metadata exposure blob.
      const assistantMsg = db.createMessage({
        chat_id: chatId,
        role: "assistant",
        content: "I will persist this across the reboot.",
        model_event_type: "finish",
        run_id: "run-reboot-1",
        metadata: {
          reasoning: "thinking about persistence",
          tokenMetrics: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
          timingMetrics: { startedAt: 1_000, totalMs: 500 },
          responseHeaders: { "x-request-id": "req-1" },
          responseModel: "gemma-4-31b",
          finishReason: "stop",
          context: {
            systemPrompt: "you are a test",
            toolNames: ["read_file"],
            historyLength: 2,
            modelId: "gemma-4-31b",
            contextTokens: 500,
            contextTokenLimit: 32_000,
          },
        },
      }, "session-reboot-1");
      assistantMsgId = assistantMsg.id;

      // Tool call (running → done) attached to the assistant message.
      const tc = db.createToolCall({
        message_id: assistantMsgId,
        tool_name: "read_file",
        input: { path: modulePathMatching("src/main.ts") },
        status: "running",
      }, "session-reboot-1");
      toolCallId = tc.id;
      db.updateToolCall(toolCallId, "session-reboot-1", {
        output: { content: "export function main() {}" },
        status: "done",
        durationMs: 42,
      });

      // Metrics snapshot.
      const ms = db.createMetricsSnapshot({
        chat_id: chatId,
        snapshot: { totalTokens: 150, durationMs: 500 },
      }, "session-reboot-1");
      metricsId = ms.id;

      // Auto-check (project-scoped + chat-scoped).
      const ac = db.createAutoCheck({
        project_id: projectId,
        chat_id: chatId,
        check_name: "typecheck",
        status: "passed",
        output: { errors: 0, warnings: 0 },
      }, "session-reboot-1");
      autoCheckId = ac.id;

      // Timeline ref.
      const tr = db.createTimelineRef({
        chat_id: chatId,
        event_id: "evt-reboot-1",
        event_type: "message.finish",
        timestamp: new Date().toISOString(),
        metadata: { runId: "run-reboot-1" },
      }, "session-reboot-1");
      timelineRefId = tr.id;
    } finally {
      db.close();
    }

    // The file must exist on disk (not in-memory).
    expect(existsSync(dbPath)).toBe(true);
  });

  test("process 2: ALL data survives the reboot with exact values", () => {
    // A BRAND-NEW DbClient on the same file = a fresh process after reboot.
    const db = new DbClient({ path: dbPath });
    try {
      expect(db.schemaVersion).toBe(SCHEMA_VERSION_LATEST);

      // ── Project: path is the exact plaintext (NOT enc: ciphertext) ──
      const project = db.getProject(projectId, "session-reboot-1");
      expect(project).not.toBeNull();
      expect(project!.name).toBe("persistence-test");
      expect(project!.path).toBe("/home/example/my-project");
      expect(project!.path.startsWith("enc:")).toBe(false);
      // v12: the 2nd arg to createProject is the user_id (was session_id).
      expect(project!.user_id).toBe("session-reboot-1");

      // listProjects also returns the plaintext path.
      const allProjects = db.listProjects("session-reboot-1");
      expect(allProjects.length).toBe(1);
      expect(allProjects[0]!.path).toBe("/home/example/my-project");
      expect(allProjects[0]!.path.startsWith("enc:")).toBe(false);

      // ── Chat: title, model, pinned all survive ──
      const chats = db.listChats(projectId, "session-reboot-1");
      expect(chats.length).toBe(1);
      expect(chats[0]!.id).toBe(chatId);
      expect(chats[0]!.title).toBe("reboot chat");
      expect(chats[0]!.model_id).toBe("gemma-4-31b");
      expect(chats[0]!.pinned).toBe(1);

      // ── Messages: content, role, run_id, metadata blob all survive ──
      const messages = db.listMessages(chatId, "session-reboot-1");
      expect(messages.length).toBe(2);
      expect(messages[0]!.id).toBe(userMsgId);
      expect(messages[0]!.role).toBe("user");
      expect(messages[0]!.content).toBe("hello from before the reboot");

      const assistant = messages[1]!;
      expect(assistant.id).toBe(assistantMsgId);
      expect(assistant.role).toBe("assistant");
      expect(assistant.content).toBe("I will persist this across the reboot.");
      expect(assistant.model_event_type).toBe("finish");
      expect(assistant.run_id).toBe("run-reboot-1");
      // The full metadata blob must survive (reasoning, tokens, headers, context).
      const meta = assistant.metadata as Record<string, unknown> | null;
      expect(meta).not.toBeNull();
      expect(meta!.reasoning).toBe("thinking about persistence");
      const tokens = meta!.tokenMetrics as Record<string, number>;
      expect(tokens.totalTokens).toBe(150);
      const headers = meta!.responseHeaders as Record<string, string>;
      expect(headers["x-request-id"]).toBe("req-1");
      expect(meta!.responseModel).toBe("gemma-4-31b");
      expect(meta!.finishReason).toBe("stop");
      const ctx = meta!.context as Record<string, unknown>;
      expect(ctx.historyLength).toBe(2);
      expect(ctx.contextTokens).toBe(500);

      // ── Tool calls: input, output, status, duration all survive ──
      const toolCalls = db.listToolCallsByChat(chatId, "session-reboot-1");
      expect(toolCalls.length).toBe(1);
      expect(toolCalls[0]!.id).toBe(toolCallId);
      expect(toolCalls[0]!.tool_name).toBe("read_file");
      expect(toolCalls[0]!.status).toBe("done");
      expect(toolCalls[0]!.duration_ms).toBe(42);
      const tcInput = toolCalls[0]!.input as Record<string, unknown>;
      expect(tcInput.path).toBe(modulePathMatching("src/main.ts"));
      const tcOutput = toolCalls[0]!.output as Record<string, unknown>;
      expect(tcOutput.content).toBe("export function main() {}");

      // ── Metrics snapshots survive ──
      const snapshots = db.listMetricsSnapshots(chatId, "session-reboot-1");
      expect(snapshots.length).toBe(1);
      expect(snapshots[0]!.id).toBe(metricsId);
      const snap = snapshots[0]!.snapshot as Record<string, number>;
      expect(snap.totalTokens).toBe(150);

      // ── Auto-checks survive (chat-scoped — created with chat_id) ──
      // The check was created with BOTH project_id and chat_id, so it is
      // CHAT-scoped: it appears in the chat list, NOT the project
      // list (project list = chat_id IS NULL only).
      const checksByProject = db.listAutoChecksByProject(projectId, "session-reboot-1");
      expect(checksByProject.length).toBe(0); // chat-scoped → not project-level
      const checksByChat = db.listAutoChecksByChat(chatId, "session-reboot-1");
      expect(checksByChat.length).toBe(1);
      expect(checksByChat[0]!.id).toBe(autoCheckId);
      expect(checksByChat[0]!.check_name).toBe("typecheck");
      expect(checksByChat[0]!.status).toBe("passed");

      // ── Timeline refs survive ──
      const refs = db.listTimelineRefs(chatId, "session-reboot-1");
      expect(refs.length).toBe(1);
      expect(refs[0]!.id).toBe(timelineRefId);
      expect(refs[0]!.event_id).toBe("evt-reboot-1");
      expect(refs[0]!.event_type).toBe("message.finish");
      const refMeta = refs[0]!.metadata as Record<string, unknown>;
      expect(refMeta.runId).toBe("run-reboot-1");

      // ── runIdsForChat resolves the run the persisted message carries ──
      const runIds = db.runIdsForChat(chatId, "session-reboot-1");
      expect(runIds).toContain("run-reboot-1");
    } finally {
      db.close();
    }
  });

  test("the raw DB file is ENCRYPTED at rest (enc: prefix on disk) and the DbClient decrypts it", () => {
    // Open the file directly (bypass the DbClient) and verify the path is
    // stored as CIPHERTEXT on disk — this is the proof encryption-at-rest
    // works: the bytes on disk are `enc:` ciphertext, NOT the plaintext path.
    // A thief who copies the DB file gets ciphertext, not the user's paths.
    const db = new DatabaseSync(dbPath);
    try {
      const row = db.prepare("SELECT path, name FROM projects LIMIT 1").get() as { path: string; name: string };
      // The disk stores ciphertext (enc: prefix), never the plaintext path.
      expect(row.path.startsWith("enc:")).toBe(true);
      expect(row.path).not.toBe("/home/example/my-project");
      // The project name is also encrypted at rest.
      expect(row.name.startsWith("enc:")).toBe(true);
      expect(row.name).not.toBe("persistence-test");
    } finally {
      db.close();
    }
    // The DbClient transparently decrypts: callers see the plaintext path.
    const client = new DbClient({ path: dbPath });
    try {
      const project = client.getProject(projectId, "session-reboot-1");
      expect(project).not.toBeNull();
      expect(project!.path).toBe("/home/example/my-project");
      expect(project!.name).toBe("persistence-test");
    } finally {
      client.close();
    }
  });

  test("a third reboot still preserves everything (no cumulative loss)", () => {
    // Open, add one more message, close, reopen — verify old + new survive.
    const db1 = new DbClient({ path: dbPath });
    db1.createMessage({ chat_id: chatId, role: "user", content: "after second reboot" }, "session-reboot-1");
    db1.close();

    const db2 = new DbClient({ path: dbPath });
    try {
      const messages = db2.listMessages(chatId, "session-reboot-1");
      expect(messages.length).toBe(3);
      expect(messages[2]!.content).toBe("after second reboot");
      // Old data still intact.
      expect(messages[0]!.content).toBe("hello from before the reboot");
      const projects = db2.listProjects("session-reboot-1");
      expect(projects[0]!.path).toBe("/home/example/my-project");
    } finally {
      db2.close();
    }
  });
});

describe("private provider identities and evidence", () => {
  test("encrypts, reopens and clones original IDs separately from public tool projections", () => {
    const path = join(createTempDir("native-provider-db-"), "native.db");
    const user = "native-owner";
    let db = new DbClient({ path });
    const project = db.createProject({ name: "native", path: "/tmp/native" }, user);
    const chat = db.createChat({ project_id: project.id, title: "native" }, user);
    const evidence = { protocol: "openai-responses", response: { id: "response-private-identity", object: "response", status: "completed", output: [{ type: "function_call", call_id: "original-private-identity", name: "provider-private-name", arguments: "{}" }] }, replayBlocked: false };
    const msg = db.createMessage({ chat_id: chat.id, role: "assistant", content: "", metadata: { providerEvidence: evidence } }, user);
    const publicProjection = { toolName: "[REDACTED:token]", input: {}, output: "", observationKey: "qualified-test" };
    const tc = db.createToolCall({ message_id: msg.id, call_id: "original-private-identity", tool_name: "provider-private-name", input: "{}", output: "", status: "done", public_projection: publicProjection }, user);
    expect(tc.call_id).toBe("original-private-identity"); expect(tc.tool_name).toBe("provider-private-name");
    db.close();
    const raw = new DatabaseSync(path);
    try {
      const row = raw.prepare("SELECT call_id, tool_name, public_projection FROM tool_calls WHERE id = ?").get(tc.id)!;
      for (const value of Object.values(row)) expect(value).toMatch(/^enc:/);
      const persisted = raw.prepare("SELECT metadata FROM messages WHERE id = ?").get(msg.id)!;
      expect(persisted.metadata).toMatch(/^enc:/);
      expect(JSON.stringify(row)).not.toContain("original-private-identity");
    } finally { raw.close(); }
    db = new DbClient({ path });
    try {
      const reopened = db.listToolCallsByChat(chat.id, user)[0]!;
      expect(reopened.call_id).toBe("original-private-identity"); expect(reopened.tool_name).toBe("provider-private-name");
      expect(reopened.public_projection).toEqual(publicProjection);
      expect(reopened.input).toBe("{}"); expect(reopened.output).toBe("");
      expect(db.getMessage(msg.id, user)!.metadata).toEqual({ providerEvidence: evidence });
      const clone = db.duplicateChat(chat.id, user)!;
      const copied = db.listToolCallsByChat(clone.id, user)[0]!;
      expect(copied.id).not.toBe(tc.id); expect(copied.message_id).not.toBe(msg.id);
      expect(copied.call_id).toBe("original-private-identity"); expect(copied.public_projection).toEqual(publicProjection);
      expect(copied.tool_name).toBe("provider-private-name"); expect(copied.input).toBe("{}"); expect(copied.output).toBe("");
      expect(db.listMessages(clone.id, user)[0]!.metadata).toEqual({ providerEvidence: evidence });
    } finally { db.close(); }
  });
});

describe("provider identity migration", () => {
  test("v17 plaintext names and IDs are encrypted without interpreting an enc: prefix", async () => {
    const { createDbCrypto, fieldBinding, UNBOUND } = await import("../../server/db/db-crypto.ts");
    const path = join(createTempDir("provider-v17-"), "migrate.db"), user = "migration-owner";
    let db = new DbClient({ path, schemaVersion: 17, crypto: preBindingCrypto(path) });
    const project = db.createProject({ name: "migration", path: "/tmp/migration" }, user);
    const chat = db.createChat({ project_id: project.id, title: "migration" }, user);
    const msg = db.createMessage({ chat_id: chat.id, role: "assistant", content: "" }, user);
    db.close();
    const raw = new DatabaseSync(path), crypto = createDbCrypto({ dbPath: path });
    try {
      const insert = raw.prepare("INSERT INTO tool_calls (id,message_id,tool_name,call_id,input,output,status,created_at) VALUES (?,?,?,?,?,?,?,?)");
      // A v17 database holds pre-binding ciphertext (UNBOUND); v20 re-seals it.
      insert.run("legacy-native", msg.id, "enc:literal-provider-name", "enc:literal-provider-call", crypto.encryptField("{}", UNBOUND), crypto.encryptField('""', UNBOUND), "done", "2026-01-01");
      insert.run("legacy-null", msg.id, "read_file", null, crypto.encryptField("{}", UNBOUND), null, "running", "2026-01-02");
    } finally { raw.close(); }
    db = new DbClient({ path });
    try {
      const rows = db.listToolCallsByChat(chat.id, user);
      expect(rows[0]).toMatchObject({ call_id: "enc:literal-provider-call", tool_name: "enc:literal-provider-name", public_projection: null, input: {}, output: "" });
      expect(rows[1]).toMatchObject({ call_id: null, tool_name: "read_file", public_projection: null, output: null });
    } finally { db.close(); }
    const inspected = new DatabaseSync(path);
    try {
      const row = inspected.prepare("SELECT call_id, tool_name FROM tool_calls WHERE id = 'legacy-native'").get()!;
      expect(row.call_id).toMatch(/^enc:/); expect(row.tool_name).toMatch(/^enc:/);
      expect(row.call_id).not.toBe("enc:literal-provider-call"); expect(row.tool_name).not.toBe("enc:literal-provider-name");
    } finally { inspected.close(); }
    db = new DbClient({ path });
    try { expect(db.listToolCallsByChat(chat.id, user)[0]!.call_id).toBe("enc:literal-provider-call"); }
    finally { db.close(); }
  });
});

describe("plaintext cannot masquerade as database ciphertext", () => {
  test("encrypts literal prefixes and valid ciphertext supplied as content through create/update/clone/reopen", async () => {
    const { createDbCrypto, fieldBinding, UNBOUND } = await import("../../server/db/db-crypto.ts");
    const path = join(createTempDir("provider-prefix-"), "prefix.db"), user = "prefix-owner";
    const crypto = createDbCrypto({ dbPath: path });
    const literalCiphertext = crypto.encryptField("inner-plaintext-canary", UNBOUND)!;
    const values = [literalCiphertext, "enc:ordinary-private-canary"];
    let db = new DbClient({ path });
    const project = db.createProject({ name: "prefix", path: "/tmp/prefix" }, user);
    const chat = db.createChat({ project_id: project.id, title: "prefix" }, user);
    const rows = values.map(content => {
      const row = db.createMessage({ chat_id: chat.id, role: "assistant", content }, user);
      expect(row.content).toBe(content);
      expect(db.getMessage(row.id, user)!.content).toBe(content);
      return row;
    });
    values.reverse();
    for (const [index, row] of rows.entries()) {
      db.updateMessageContent(row.id, values[index]!, user);
      expect(db.getMessage(row.id, user)!.content).toBe(values[index]);
    }
    const copied = db.duplicateChat(chat.id, user)!;
    db.close();
    const raw = new DatabaseSync(path);
    try {
      for (const [index, row] of rows.entries()) {
        const stored = raw.prepare("SELECT content FROM messages WHERE id = ?").get(row.id)!.content;
        expect(stored).toMatch(/^enc:/); expect(stored).not.toBe(values[index]);
        expect(stored).not.toContain("ordinary-private-canary");
      }
    } finally { raw.close(); }
    db = new DbClient({ path });
    try {
      expect(db.listMessages(chat.id, user).map(row => row.content)).toEqual(values);
      expect(db.listMessages(copied.id, user).map(row => row.content)).toEqual(values);
      expect(crypto.encryptField(null, UNBOUND)).toBeNull(); expect(crypto.encryptField(undefined, UNBOUND)).toBeNull(); expect(crypto.encryptField("", UNBOUND)).toBe("");
    } finally { db.close(); }
  });
});

describe("private stored evidence integrity", () => {
  test("refuses corrupt encrypted and JSON columns without returning raw ciphertext or losing evidence", async () => {
    const { createDbCrypto, fieldBinding, UNBOUND } = await import("../../server/db/db-crypto.ts");
    const path = join(createTempDir("native-integrity-"), "integrity.db"), user = "integrity-owner";
    const db = new DbClient({ path }), crypto = createDbCrypto({ dbPath: path });
    const project = db.createProject({ name: "native", path: "/tmp/integrity" }, user);
    const chat = db.createChat({ project_id: project.id, title: "native" }, user);
    const msg = db.createMessage({ chat_id: chat.id, role: "assistant", content: "private body", metadata: { providerEvidence: { output: "private evidence" } } }, user);
    const tool = db.createToolCall({ message_id: msg.id, call_id: "private call", tool_name: "private name", input: {}, output: "", status: "done", public_projection: { observationKey: "key", toolName: "public name", input: {}, output: "" } }, user);
    const raw = new DatabaseSync(path);
    const columns = [["messages", msg.id, "content"], ["messages", msg.id, "metadata"], ["tool_calls", tool.id, "call_id"], ["tool_calls", tool.id, "tool_name"], ["tool_calls", tool.id, "public_projection"], ["tool_calls", tool.id, "input"], ["tool_calls", tool.id, "output"]] as const;
    let exercised = 0;
    try {
      for (const [table, id, column] of columns) {
        const original = raw.prepare(`SELECT ${column} AS value FROM ${table} WHERE id = ?`).get(id)!.value as string;
        const packed = Buffer.from(original.slice(4), "base64"); packed[packed.length - 1] = packed[packed.length - 1]! ^ 1;
        const corruptions = ["plaintext replacement canary", "enc:not-base64!", "enc:AQ==", `${original}!`, `enc:${packed.toString("base64")}`];
        const read = () => table === "messages" ? db.getMessage(msg.id, user) : db.listToolCallsByMessage(msg.id, user);
        for (const corrupted of corruptions) {
          raw.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`).run(corrupted, id);
          try {
            expect(read).toThrow(expect.objectContaining({ name: "WebError", code: "db_decryption_failed", message: "Encrypted database field could not be authenticated" }));
            expect(raw.prepare(`SELECT ${column} AS value FROM ${table} WHERE id = ?`).get(id)!.value).toBe(corrupted);
            exercised++;
          } finally { raw.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`).run(original, id); }
          expect(read()).toEqual(table === "messages" ? msg : [tool]);
        }
        if (column !== "content") {
          // Authenticated (bound to exactly this row) but malformed JSON.
          const identity = table === "messages" ? { id, chat_id: chat.id } : { id, message_id: msg.id };
          raw.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`).run(crypto.encryptField("{broken-json-canary", fieldBinding(table, column as never, identity, user)), id);
          const malformedStored = raw.prepare(`SELECT ${column} AS value FROM ${table} WHERE id = ?`).get(id)!.value;
          try {
            expect(read).toThrow(expect.objectContaining({ name: "WebError", code: "db_json_invalid", message: "Stored database JSON is invalid" }));
            expect(raw.prepare(`SELECT ${column} AS value FROM ${table} WHERE id = ?`).get(id)!.value).toBe(malformedStored);
          }
          finally { raw.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`).run(original, id); }
        }
      }
      expect(exercised).toBe(35);
      expect(db.getMessage(msg.id, user)).toEqual(msg); expect(db.listToolCallsByMessage(msg.id, user)).toEqual([tool]);
    } finally { raw.close(); db.close(); }
  });
});

describe("stored preference JSON integrity", () => {
  test("absence stays null; malformed authenticated JSON refuses without rewriting either preference", async () => {
    const { createDbCrypto, fieldBinding, UNBOUND } = await import("../../server/db/db-crypto.ts");
    const path = join(createTempDir("prefs-integrity-"), "prefs.db");
    const db = new DbClient({ path });
    const crypto = createDbCrypto({ dbPath: path });
    const raw = new DatabaseSync(path);
    const user = "prefs-owner";
    try {
      expect(db.getUserModelPrefs(user)).toBeNull();
      expect(db.getUserPromptPrefs(user)).toBeNull();
      db.upsertUserModelPrefs(user, { models: ["native"] });
      db.upsertUserPromptPrefs(user, { prompt: "retained" });
      const cases = [
        { table: "user_model_prefs", column: "config_json", read: () => db.getUserModelPrefs(user), value: { models: ["native"] } },
        { table: "user_prompt_prefs", column: "prefs_json", read: () => db.getUserPromptPrefs(user), value: { prompt: "retained" } },
      ];
      for (const { table, column, read, value } of cases) {
        expect(read()).toEqual(value);
        const original = raw.prepare(`SELECT ${column} AS value FROM ${table} WHERE user_id = ?`).get(user)!.value as string;
        const invalid = crypto.encryptField("{private malformed prefs canary", fieldBinding(table as "user_model_prefs", column as never, { user_id: user }, user));
        raw.prepare(`UPDATE ${table} SET ${column} = ? WHERE user_id = ?`).run(invalid, user);
        try {
          expect(read).toThrow(expect.objectContaining({ code: "db_json_invalid", message: "Stored database JSON is invalid" }));
          expect(raw.prepare(`SELECT ${column} AS value FROM ${table} WHERE user_id = ?`).get(user)!.value).toBe(invalid);
        } finally { raw.prepare(`UPDATE ${table} SET ${column} = ? WHERE user_id = ?`).run(original, user); }
        expect(read()).toEqual(value);
      }
    } finally { raw.close(); db.close(); }
    const reopened = new DbClient({ path });
    try {
      expect(reopened.getUserModelPrefs(user)).toEqual({ models: ["native"] });
      expect(reopened.getUserPromptPrefs(user)).toEqual({ prompt: "retained" });
    } finally { reopened.close(); }
  });
});


describe("provider identity migration key admission", () => {
  test("wrong-key v17 upgrade rolls back identities, schema and version before a correct-key upgrade", async () => {
    const { createDbCrypto, fieldBinding, UNBOUND } = await import("../../server/db/db-crypto.ts");
    const path = join(createTempDir("identity-migration-key-"), "migration.db");
    const user = "migration-owner";
    const old = new DbClient({ path, schemaVersion: 17, crypto: preBindingCrypto(path, { passphrase: "key-A" }) });
    const project = old.createProject({ name: "retained", path: "/tmp/key-migration" }, user);
    const chat = old.createChat({ project_id: project.id, title: "retained" }, user);
    const message = old.createMessage({ chat_id: chat.id, role: "assistant", content: "retained" }, user);
    old.close();
    const raw = new DatabaseSync(path);
    const crypto = createDbCrypto({ dbPath: path, passphrase: "key-A" });
    try {
      raw.prepare("INSERT INTO tool_calls (id,message_id,tool_name,call_id,input,output,status,duration_ms,attempt_count,created_at) VALUES (?,?,?,?,?,?,?,NULL,1,?)")
        .run("tool-v17", message.id, "original-name", "original-id", crypto.encryptField(JSON.stringify({ path: "read" }), UNBOUND), crypto.encryptField(JSON.stringify(""), UNBOUND), "done", new Date().toISOString());
      const before = raw.prepare("SELECT * FROM tool_calls").all();
      const versions = raw.prepare("SELECT * FROM schema_version").all();
      const columns = raw.prepare("PRAGMA table_info(tool_calls)").all();
      let wrong: DbClient | undefined;
      const close = DatabaseSync.prototype.close;
      const closed: DatabaseSync[] = [];
      const closeSpy = vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(function (this: DatabaseSync) {
        close.call(this);
        closed.push(this);
      });
      try {
        expect(() => { wrong = new DbClient({ path, passphrase: "key-B" }); }).toThrow(expect.objectContaining({ code: "db_decryption_failed" }));
        // The client's own handle, plus the read-only handles it opened on the
        // way (the key admission's schema probe, the pre-migration backup's
        // verification): every one is closed, none leaks.
        expect(closed.length).toBe(3);
        expect(closed.map((handle) => handle.isOpen)).toEqual([false, false, false]);
        expect(raw.prepare("SELECT * FROM tool_calls").all()).toEqual(before);
        expect(raw.prepare("SELECT * FROM schema_version").all()).toEqual(versions);
        expect(raw.prepare("PRAGMA table_info(tool_calls)").all()).toEqual(columns);
      } finally { wrong?.close(); closeSpy.mockRestore(); }
    } finally { raw.close(); }
    for (let reopen = 0; reopen < 2; reopen++) {
      const correct = new DbClient({ path, passphrase: "key-A" });
      try {
        expect(correct.schemaVersion).toBe(SCHEMA_VERSION_LATEST);
        expect(correct.getMessage(message.id, user)!.content).toBe("retained");
        expect(correct.listToolCallsByMessage(message.id, user)[0]).toMatchObject({ call_id: "original-id", tool_name: "original-name", input: { path: "read" }, output: "" });
      } finally { correct.close(); }
    }
  });
});

describe("encrypted fields are bound to their row and owner (CRED-F13)", () => {
  test("a ciphertext copied into another user's row, another row or another column — or a row moved to another owner — fails to decrypt", async () => {
    const path = join(createTempDir("field-binding-"), "binding.db");
    const db = new DbClient({ path });
    const raw = new DatabaseSync(path);
    try {
      const alice = db.createProject({ name: "alice-project", path: "/home/alice/secret" }, "alice");
      const bob = db.createProject({ name: "bob-project", path: "/home/bob/work" }, "bob");
      const chat = db.createChat({ project_id: alice.id, title: "alice chat" }, "alice");
      const first = db.createMessage({ chat_id: chat.id, role: "user", content: "first private" }, "alice");
      const second = db.createMessage({ chat_id: chat.id, role: "user", content: "second" }, "alice");
      const stored = (sql: string, id: string) => (raw.prepare(sql).get(id) as { value: string }).value;
      const refused = expect.objectContaining({ code: "db_decryption_failed" });
      // Another user's row.
      raw.prepare("UPDATE projects SET path = ? WHERE id = ?").run(stored("SELECT path AS value FROM projects WHERE id = ?", alice.id), bob.id);
      expect(() => db.getProject(bob.id, "bob")).toThrow(refused);
      // Another row of the same owner, and another column of the same row.
      raw.prepare("UPDATE messages SET content = ? WHERE id = ?").run(stored("SELECT content AS value FROM messages WHERE id = ?", first.id), second.id);
      expect(() => db.getMessage(second.id, "alice")).toThrow(refused);
      raw.prepare("UPDATE projects SET name = ? WHERE id = ?").run(stored("SELECT path AS value FROM projects WHERE id = ?", alice.id), alice.id);
      expect(() => db.getProject(alice.id, "alice")).toThrow(refused);
      // A chat moved under another user's project by a database edit: every
      // row of its chain is bound to its OWNING USER, so neither the chat nor
      // any message or tool call under it opens for the new "owner"
      // (secc-security SECC-V-A1: the untouched children used to follow it).
      const call = db.createToolCall({ message_id: first.id, tool_name: "read", input: { path: "ALICE-TOOL-INPUT" }, status: "done" }, "alice");
      raw.prepare("UPDATE chats SET project_id = ? WHERE id = ?").run(bob.id, chat.id);
      expect(() => db.getChat(chat.id, "bob")).toThrow(refused);
      expect(() => db.getMessage(first.id, "bob")).toThrow(refused);
      expect(() => db.listMessages(chat.id, "bob")).toThrow(refused);
      expect(() => db.listToolCallsByMessage(first.id, "bob")).toThrow(refused);
      // Moved back, everything opens for its owner again (nothing was destroyed).
      raw.prepare("UPDATE chats SET project_id = ? WHERE id = ?").run(alice.id, chat.id);
      expect(db.getMessage(first.id, "alice")!.content).toBe("first private");
      expect(db.listToolCallsByMessage(first.id, "alice").map((row) => row.id)).toEqual([call.id]);
    } finally { raw.close(); db.close(); }
  });

  test("migration 20 re-seals pre-binding fields, keeps an unreadable one, and refuses a key that reads none", async () => {
    const { createDbCrypto, UNBOUND } = await import("../../server/db/db-crypto.ts");
    const dir = createTempDir("field-binding-v20-"), path = join(dir, "v19.db");
    const user = "v19-owner";
    const old = new DbClient({ path, schemaVersion: 19, crypto: preBindingCrypto(path) });
    const project = old.createProject({ name: "placeholder", path: "/placeholder" }, user);
    const chat = old.createChat({ project_id: project.id, title: "placeholder" }, user);
    const msg = old.createMessage({ chat_id: chat.id, role: "user", content: "placeholder" }, user);
    old.close();
    // Rewrite the rows the way a v19 writer sealed them: no associated data.
    const legacy = createDbCrypto({ dbPath: path });
    const raw = new DatabaseSync(path);
    try {
      raw.prepare("UPDATE projects SET name = ?, path = ? WHERE id = ?").run(legacy.encryptField("legacy name", UNBOUND), legacy.encryptField("/legacy/path", UNBOUND), project.id);
      raw.prepare("UPDATE chats SET title = ? WHERE id = ?").run(legacy.encryptField("legacy title", UNBOUND), chat.id);
      raw.prepare("UPDATE messages SET content = ? WHERE id = ?").run("enc:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", msg.id);
    } finally { raw.close(); }
    const before = new DatabaseSync(path);
    const unboundPath = (before.prepare("SELECT path FROM projects WHERE id = ?").get(project.id) as { path: string }).path;
    before.close();
    // A key that reads none of them: refused, version and rows untouched.
    // Another key home: a database of the same folder mints ITS key there.
    const wrongKey = createKeyHome("field-binding-wrong-key-");
    createDbCrypto({ dbPath: join(dir, "other.db"), keyHome: wrongKey });
    expect(() => new DbClient({ path, keyHome: wrongKey })).toThrow(expect.objectContaining({ code: "db_migration_undecodable" }));
    const unchanged = new DatabaseSync(path);
    try {
      expect((unchanged.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v).toBe(19);
      expect((unchanged.prepare("SELECT path FROM projects WHERE id = ?").get(project.id) as { path: string }).path).toBe(unboundPath);
    } finally { unchanged.close(); }
    // Its own key: re-sealed under the binding, read back, the unreadable field kept as it was.
    const db = new DbClient({ path });
    try {
      expect(db.schemaVersion).toBe(20);
      expect(db.getProject(project.id, user)).toMatchObject({ name: "legacy name", path: "/legacy/path" });
      expect(db.getChat(chat.id, user)!.title).toBe("legacy title");
      expect(() => db.getMessage(msg.id, user)).toThrow(expect.objectContaining({ code: "db_decryption_failed" }));
    } finally { db.close(); }
    const after = new DatabaseSync(path);
    try {
      const sealed = (after.prepare("SELECT path FROM projects WHERE id = ?").get(project.id) as { path: string }).path;
      expect(sealed).toMatch(/^enc:/); expect(sealed).not.toBe(unboundPath);
      expect(() => legacy.decryptField(sealed, UNBOUND)).toThrow(expect.objectContaining({ code: "db_decryption_failed" }));
      expect((after.prepare("SELECT content FROM messages WHERE id = ?").get(msg.id) as { content: string }).content).toBe("enc:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    } finally { after.close(); }
  });
});
