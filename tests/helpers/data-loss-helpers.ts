/**
 * Shared helpers for the data-loss mechanical tests.
 *
 * The data-loss suite verifies SQLite persistence across process/file boundaries
 * with REAL database files (not :memory:). The eight scenarios were originally
 * one file (data-loss-mechanical.test.ts, ~4s) and are now split into eight
 * parallel files so they run concurrently instead of sequentially. These
 * helpers are the single owner of the seeding logic so every scenario reuses
 * the same primitives (no duplicated setup).
 *
 * Temporary directories are deliberately NOT owned here. They belong to the
 * single temp-dir owner, `tests/helpers/temp-dir.ts` — each scenario calls
 * `createTempDir("ch-data-loss-<scenario>-")` directly. The former
 * `createBase`/`removeBase`/`freshDir` trio was a SECOND, parallel temp-dir
 * owner (created here, removed by each scenario's own `afterAll`), and that
 * split ownership is exactly the shape that let directories leak. Removing it
 * also upgrades the scenarios from file-scoped to per-test cleanup.
 */
import { DbClient } from "../../server/db/client.ts";
import { runMigrations } from "../../server/db/migrations.ts";
import { createDbCrypto, createNoopDbCrypto, UNBOUND, type DbCrypto } from "../../server/db/db-crypto.ts";
import { DatabaseSync } from "node:sqlite";

/** Create a full data graph in the given DbClient and return the ids.
 * The 9 writes are wrapped in ONE transaction so the seeding is atomic —
 * if any write fails (e.g. a constraint violation), the whole graph rolls
 * back instead of leaving partial state that would confuse the test's
 * durability verification. */
export function seedFullGraph(db: DbClient, sessionId: string) {
  return db.withTransaction(() => {
    const project = db.createProject({ name: "loss-test", path: "/home/example/loss-project" }, sessionId);
    const chat = db.createChat({ project_id: project.id, title: "loss chat", model_id: "gemma-4-31b" }, sessionId);
    const u = db.createMessage({ chat_id: chat.id, role: "user", content: "user msg before reboot" }, sessionId);
    const a = db.createMessage({
      chat_id: chat.id, role: "assistant", content: "assistant msg before reboot",
      model_event_type: "finish", run_id: "run-loss-1",
      metadata: { reasoning: "thinking", tokenMetrics: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
    }, sessionId);
    const tc = db.createToolCall({ message_id: a.id, tool_name: "read_file", input: { path: "x.ts" }, status: "running" }, sessionId);
    db.updateToolCall(tc.id, sessionId, { output: { ok: true }, status: "done", durationMs: 7 });
    const ms = db.createMetricsSnapshot({ chat_id: chat.id, snapshot: { totalTokens: 15 } }, sessionId);
    const ac = db.createAutoCheck({ project_id: project.id, chat_id: chat.id, check_name: "typecheck", status: "passed", output: { errors: 0 } }, sessionId);
    const tr = db.createTimelineRef({ chat_id: chat.id, event_id: "evt-1", event_type: "message.finish", timestamp: new Date().toISOString(), metadata: { runId: "run-loss-1" } }, sessionId);
    return { project, chat, u, a, tc, ms, ac, tr };
  });
}

/** Re-export the migration primitives so each scenario file imports from the
 * single owner (no scattered migration imports across the data-loss files). */
export { runMigrations, createNoopDbCrypto, DatabaseSync };

/**
 * A WRITER FROM BEFORE FIELD BINDING (schema < 20): the database's own key,
 * every field sealed and opened with no associated data — what a v17–v19
 * install actually stored. A fixture built at an old schema version with the
 * live client would otherwise seal bound values no old database can hold (and
 * migration 20 rightly refuses a mix of bound and unbound values).
 */
export function preBindingCrypto(dbPath: string, options: Readonly<{ passphrase?: string }> = {}): DbCrypto {
  const real = createDbCrypto({ dbPath, ...options });
  return Object.freeze({
    ...real,
    encryptField: (plaintext: string | null | undefined) => real.encryptField(plaintext, UNBOUND),
    decryptField: (ciphertext: string | null | undefined) => real.decryptField(ciphertext, UNBOUND),
    authenticates: (ciphertext: string) => real.authenticates(ciphertext, UNBOUND),
  });
}
