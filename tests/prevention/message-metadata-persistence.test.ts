// @vitest-environment node
/**
 * Prevention test: the full chat exposure (reasoning, tokens,
 * timing, headers, model, finish reason, context) must persist to the
 * DB and survive a reload via getChatHistory → hydrateChatFromHistory.
 *
 * Root cause this guards against: persistModelEvent's `default` case
 * dropped reasoning_delta/usage, the `finish` case only stored content,
 * and the context/metadata SSE events were live-only. On refresh all
 * that data vanished. The fix added a `metadata` JSON column to
 * `messages` (migration v3) + `updateMessageMetadata` on finish.
 *
 * This exercises the REAL DbClient with a temp SQLite DB, simulating the
 * run stream's persist path:
 * 1. start → create an empty assistant message
 * 2. updateMessageMetadata with the full blob
 * 3. getChatHistory returns the message WITH the metadata blob
 *
 * Regression guards:
 * - If anyone reintroduces the default-case drop, getChatHistory returns
 * null metadata and the assertions fail.
 * - If updateMessageMetadata is removed/renamed, this fails to compile.
 * - If the migration doesn't add the metadata column, the insert fails.
 */
import { describe, it, expect, afterAll } from "vitest";
import { DbClient } from "../../server/db/client.ts";
import { SCHEMA_VERSION_LATEST, type MessageMetadataUpdate } from "../../server/db/schema.ts";
import { ROOT_POLICY } from "../../server/kernel/canonical.ts";

import { join } from "node:path";
import { ZodError } from "zod";
import { createTempDir } from "../helpers/temp-dir.ts";

/** The tmpdirs + DBs created by `makeDb()` — cleaned up in `afterAll` so the
 * suite does not leak `harness-msg-meta-*` dirs or DB file handles. */
const CREATED_DIRS: string[] = [];
const CREATED_DBS: DbClient[] = [];

function makeDb(): DbClient {
  const dir = createTempDir("harness-msg-meta-");
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

describe("message-metadata-persistence", () => {
  it("updateMessageMetadata persists the full chat-exposure blob and getChatHistory reads it back", () => {
    const db = makeDb();
    const project = db.createProject({ name: "T", path: "/tmp/t" }, "sess-1");
    const chat = db.createChat({ project_id: project.id, title: "Chat" }, "sess-1");

    // Simulate the run stream: start → create assistant message.
    const msg = db.createMessage({
      chat_id: chat.id,
      role: "assistant",
      content: "",
      model_event_type: "start",
      run_id: "run-1",
    }, "sess-1");

    // finish → persist content + the full metadata blob.
    db.updateMessageContent(msg.id, "the answer", "sess-1", { model_event_type: "finish" });
    db.updateMessageMetadata(msg.id, {
      reasoning: "step by step",
      tokenMetrics: { inputTokens: 5, outputTokens: 8, totalTokens: 13 },
      timingMetrics: { startedAt: 1000, firstTokenAt: 1050, finishedAt: 2000, ttftMs: 50, totalMs: 1000, tps: 8 },
      responseHeaders: { "x-req": "abc" },
      responseModel: "gemma-4-31b",
      finishReason: "stop",
      context: { systemPrompt: "be helpful", toolNames: ["read_file", "search"], historyLength: 1 },
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
    }, "sess-1");

    // ── getChatHistory reads it back (this is the reload path) ──
    const history = db.getChatHistory(chat.id, "sess-1");
    expect(history, "history must be non-null").not.toBeNull();
    expect(history!.messages.length).toBe(1);
    const m = history!.messages[0]!;
    expect(m.content).toBe("the answer");
    expect(m.metadata, "metadata must be persisted (not null)").not.toBeNull();
    const meta = m.metadata as Record<string, unknown>;
    expect(meta["reasoning"]).toBe("step by step");
    expect(meta["finishReason"]).toBe("stop");
    expect(meta["responseModel"]).toBe("gemma-4-31b");
    expect((meta["tokenMetrics"] as Record<string, unknown>)?.["totalTokens"]).toBe(13);
    expect((meta["timingMetrics"] as Record<string, unknown>)?.["ttftMs"]).toBe(50);
    expect((meta["responseHeaders"] as Record<string, string>)?.["x-req"]).toBe("abc");
    expect((meta["context"] as Record<string, unknown>)?.["systemPrompt"]).toBe("be helpful");
    // The turn's dedup savings survive the reload path with the wire's own
    // numbers — the footer's face is identical live and reloaded.
    const dedup = meta["dedupSummary"] as Record<string, unknown>;
    expect(dedup?.["applied"]).toBe(true);
    expect(dedup?.["originalChars"]).toBe(2440);
    expect(dedup?.["dedupedChars"]).toBe(1845);
    expect(dedup?.["charReductionPct"]).toBe(24.39);
    expect(dedup?.["removedBlocks"]).toBe(5);
    expect(dedup?.["removedLines"]).toBe(31);
    expect(dedup?.["messageCount"]).toBe(5);
    // The turn's masked-input notice survives the reload path with the
    // wire's own numbers — the footer's masking face is identical live
    // and reloaded, and the already-hidden-upstream count stays its own
    // number.
    const redaction = meta["redactionNotice"] as Record<string, unknown>;
    expect(redaction?.["maskedCount"]).toBe(2);
    expect(redaction?.["proven"]).toBe(1);
    expect(redaction?.["format"]).toBe(0);
    expect(redaction?.["inferred"]).toBe(1);
    expect(redaction?.["maskedUpstream"]).toBe(3);
    expect((redaction?.["byTier"] as Record<string, number>)?.["selfValidating"]).toBe(1);
    const reasons = redaction?.["reasons"] as Record<string, unknown>[];
    expect(reasons).toHaveLength(2);
    expect(reasons[0]?.["confidence"]).toBe("proven");
    expect(reasons[0]?.["explanation"]).toBe("equals a credential this machine holds");
  });

  it("messages without metadata hydrate with null metadata (older messages, user messages)", () => {
    const db = makeDb();
    const project = db.createProject({ name: "T", path: "/tmp/t2" }, "sess-1");
    const chat = db.createChat({ project_id: project.id, title: "Chat" }, "sess-1");
    db.createMessage({ chat_id: chat.id, role: "user", content: "hi" }, "sess-1");
    const history = db.getChatHistory(chat.id, "sess-1");
    expect(history!.messages[0]!.metadata).toBeNull();
  });

  it("the schema migrated to the latest version (metadata column exists)", () => {
    const db = makeDb();
    expect(db.schemaVersion).toBe(SCHEMA_VERSION_LATEST);
  });

  it("createMessage accepts a metadata blob on insert (context-only safety write)", () => {
    const db = makeDb();
    const project = db.createProject({ name: "T", path: "/tmp/t3" }, "sess-1");
    const chat = db.createChat({ project_id: project.id, title: "Chat" }, "sess-1");
    const msg = db.createMessage({
      chat_id: chat.id,
      role: "assistant",
      content: "",
      metadata: { context: { systemPrompt: "sp", toolNames: [], historyLength: 0 } },
    }, "sess-1");
    const history = db.getChatHistory(chat.id, "sess-1");
    const m = history!.messages.find((x) => x.id === msg.id)!;
    expect((m.metadata as Record<string, unknown>)?.["context"]).toBeDefined();
  });

  it("updateMessageMetadata rejects a malformed blob (Zod validation)", () => {
    const db = makeDb();
    const project = db.createProject({ name: "T", path: "/tmp/t4" }, "sess-1");
    const chat = db.createChat({ project_id: project.id, title: "Chat" }, "sess-1");
    const msg = db.createMessage({ chat_id: chat.id, role: "assistant", content: "x" }, "sess-1");
    // tokenMetrics.inputTokens must be a nonnegative number; a string throws.
    // Tightened (EHC-6): assert the SPECIFIC typed error (ZodError — the
    // metadata blob is zod-validated). A loose `.toThrow` would pass on
    // any error, masking a real failure.
    expect(() =>
      db.updateMessageMetadata(msg.id, { tokenMetrics: { inputTokens: "bad" } } as unknown as MessageMetadataUpdate, "sess-1"),
    ).toThrow(ZodError);
  });
});

describe("required metadata and private evidence boundary", () => {
  it("refuses a missing or foreign metadata write instead of reporting success", () => {
    const db = makeDb();
    const project = db.createProject({ name: "owned", path: "/tmp/owned" }, "owner");
    const chat = db.createChat({ project_id: project.id, title: "owned" }, "owner");
    const row = db.createMessage({ chat_id: chat.id, role: "assistant", content: "" }, "owner");
    for (const [id, user] of [["missing", "owner"], [row.id, "other"]]) {
      expect(() => db.updateMessageMetadata(id!, { providerEvidence: { private: "secret" } }, user!)).toThrow(expect.objectContaining({ code: "message_metadata_not_owned" }));
    }
    expect(db.getMessage(row.id, "owner")!.metadata).toBeNull();
    db.updateMessageMetadata(row.id, { providerEvidence: { private: "secret" } }, "owner");
    expect(db.getMessage(row.id, "owner")!.metadata).toEqual({ providerEvidence: { private: "secret" } });
  });

  it("public metadata excludes opaque native evidence and private observation bindings", async () => {
    const { messageToView } = await import("../../server/routes/views.ts");
    const db = makeDb();
    const project = db.createProject({ name: "native", path: "/tmp/native" }, "owner");
    const chat = db.createChat({ project_id: project.id, title: "native" }, "owner");
    const row = db.createMessage({ chat_id: chat.id, role: "assistant", content: "public", metadata: {
      finishReason: "stop", providerEvidence: { unknownProtocolExtension: "private-canary" },
      providerObservation: { observationKey: "private-binding-canary" }, extra: "private-extension-canary",
    } }, "owner");
    expect(messageToView(row).metadata).toEqual({ finishReason: "stop" });
    expect(JSON.stringify(messageToView(row))).not.toContain("canary");
  });
});

describe("metadata write acknowledgement", () => {
  it("requires an affected row after the scoped read", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const path = join(createTempDir("metadata-ignore-"), "ignore.db");
    const db = new DbClient({ path }); CREATED_DBS.push(db);
    const project = db.createProject({ name: "owned", path: "/tmp/owned" }, "owner");
    const chat = db.createChat({ project_id: project.id, title: "owned" }, "owner");
    const row = db.createMessage({ chat_id: chat.id, role: "assistant", content: "" }, "owner");
    const raw = new DatabaseSync(path);
    try {
      raw.exec("CREATE TRIGGER refuse_metadata_update BEFORE UPDATE OF metadata ON messages BEGIN SELECT RAISE(IGNORE); END;");
      expect(() => db.updateMessageMetadata(row.id, { providerEvidence: { actual: true } }, "owner")).toThrow(expect.objectContaining({ code: "message_metadata_write_failed" }));
      expect(db.getMessage(row.id, "owner")!.metadata).toBeNull();
      raw.exec("DROP TRIGGER refuse_metadata_update");
      db.updateMessageMetadata(row.id, { providerEvidence: { actual: true } }, "owner");
      expect(db.getMessage(row.id, "owner")!.metadata).toEqual({ providerEvidence: { actual: true } });
    } finally { raw.close(); }
  });
});

describe("native JSON storage admission", () => {
  it("refuses non-JSON evidence before traps or writes, across create and update doors", () => {
    const db = makeDb();
    const user = "json-owner";
    const project = db.createProject({ name: "native-json", path: "/tmp/native-json" }, user);
    const chat = db.createChat({ project_id: project.id, title: "native-json" }, user);
    const message = db.createMessage({ chat_id: chat.id, role: "assistant", content: "retained", metadata: { providerEvidence: { retained: true } } }, user);
    const projection = { observationKey: "private-binding", toolName: "read", input: {}, output: "" };
    const tool = db.createToolCall({ message_id: message.id, tool_name: "read", call_id: "original", input: {}, status: "done", public_projection: projection }, user);
    let traps = 0;
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    const getter = Object.defineProperty({}, "value", { enumerable: true, get() { traps++; return "unsafe"; } });
    const toJSON = { toJSON() { traps++; return "unsafe"; } };
    const proxy = new Proxy({}, { ownKeys() { traps++; return []; } });
    let tooDeep: unknown = null;
    for (let depth = 0; depth <= ROOT_POLICY.forensics.limits.maximumDepth; depth++) tooDeep = [tooDeep];
    const tooManyNodes = Array.from({ length: ROOT_POLICY.forensics.limits.maximumNodes }, () => null);
    const invalid: unknown[] = [{ lost: undefined }, NaN, Infinity, -Infinity, -0, cyclic, getter, toJSON, proxy, tooDeep, tooManyNodes];
    const refusal = expect.objectContaining({ name: "WebError", code: "db_json_input_invalid", message: "Database JSON input is invalid" });
    let attempts = 0;
    for (const value of invalid) {
      for (const field of ["providerEvidence", "providerObservation"] as const) {
        const metadata = { [field]: value };
        expect(() => db.createMessage({ chat_id: chat.id, role: "assistant", content: "must-not-write", metadata }, user)).toThrow(refusal);
        expect(() => db.updateMessageMetadata(message.id, metadata, user)).toThrow(refusal);
        attempts += 2;
      }
      const unsafeProjection = { ...projection, input: value };
      expect(() => db.createToolCall({ message_id: message.id, tool_name: "read", input: {}, status: "done", public_projection: unsafeProjection }, user)).toThrow(refusal);
      expect(() => db.updateToolCall(tool.id, user, { publicProjection: unsafeProjection })).toThrow(refusal);
      attempts += 2;
      expect(db.getChatHistory(chat.id, user)!.messages).toEqual([message]);
      expect(db.listToolCallsByMessage(message.id, user)).toEqual([tool]);
      expect(traps).toBe(0);
    }
    expect(attempts).toBe(66);
    // The schema must not invoke accessors on the projection/evidence container.
    const rootGetter = Object.defineProperty({}, "input", { enumerable: true, get() { traps++; return {}; } });
    expect(() => db.updateToolCall(tool.id, user, { publicProjection: rootGetter as typeof projection })).toThrow(refusal);
    const metadataGetter = Object.defineProperty({}, "providerEvidence", { enumerable: true, get() { traps++; return {}; } });
    expect(() => db.updateMessageMetadata(message.id, metadataGetter, user)).toThrow(refusal);
    const createGetter = Object.defineProperty({ chat_id: chat.id, role: "assistant" as const, content: "" }, "metadata", { enumerable: true, get() { traps++; return {}; } });
    expect(() => db.createMessage(createGetter, user)).toThrow(refusal);
    expect(traps).toBe(0);
  });

  it("preserves own JSON keys and large evidence within the generic structural ceiling", () => {
    const db = makeDb();
    const user = "json-positive";
    const project = db.createProject({ name: "native-json", path: "/tmp/native-json-positive" }, user);
    const chat = db.createChat({ project_id: project.id, title: "native-json" }, user);
    const evidence = JSON.parse('{"__proto__":{"own":"retained"},"nested":[0,false,null,""]}') as Record<string, unknown>;
    evidence.large = "x".repeat(1024 * 1024 + 1);
    const metadata = { providerEvidence: evidence, providerObservation: { safe: evidence } };
    const message = db.createMessage({ chat_id: chat.id, role: "assistant", content: "", metadata }, user);
    expect(db.getMessage(message.id, user)!.metadata).toEqual(metadata);
    const projection = { observationKey: "private-binding", toolName: "read", input: evidence, output: "" };
    const tool = db.createToolCall({ message_id: message.id, tool_name: "read", input: {}, status: "done", public_projection: projection }, user);
    expect(db.listToolCallsByMessage(message.id, user)[0]!.public_projection).toEqual(projection);
    db.updateMessageMetadata(message.id, { providerEvidence: evidence }, user);
    db.updateToolCall(tool.id, user, { publicProjection: projection });
    expect(db.getMessage(message.id, user)!.metadata).toEqual(metadata);
    expect(db.listToolCallsByMessage(message.id, user)[0]!.public_projection).toEqual(projection);
  });

  it("cannot replace an admitted column while the schema reads another field", () => {
    const db = makeDb();
    const user = "snapshot-owner";
    const project = db.createProject({ name: "snapshot", path: "/tmp/snapshot" }, user);
    const chat = db.createChat({ project_id: project.id, title: "snapshot" }, user);
    let traps = 0;
    let replaced: boolean | undefined;
    const hostile = { toJSON() { traps++; return "lost-evidence"; } };
    const input = {
      chat_id: chat.id, content: "", metadata: { providerEvidence: { retained: true } },
      get role(): "assistant" {
        replaced = Reflect.set(this, "metadata", { providerEvidence: hostile });
        return "assistant";
      },
    };
    const row = db.createMessage(input, user);
    expect(replaced).toBe(false);
    expect(traps).toBe(0);
    expect(row.metadata).toEqual({ providerEvidence: { retained: true } });
    db.updateMessageMetadata(row.id, { providerEvidence: undefined, responseModel: undefined }, user);
    expect(db.getMessage(row.id, user)!.metadata).toEqual(row.metadata);
  });
});
