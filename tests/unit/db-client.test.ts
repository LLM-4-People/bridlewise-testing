// @vitest-environment node
import { describe, test, expect, beforeEach, vi } from "vitest";
import { join } from "node:path";

import { DbClient } from "../../server/db/client.ts";
import { SCHEMA_VERSION_LATEST } from "../../server/db/schema.ts";
import { runMigrations, readSchemaVersion, MIGRATIONS } from "../../server/db/migrations.ts";
import { DatabaseSync } from "node:sqlite";
import { createTestUser } from "../helpers/multi-user.ts";
import { ZodError } from "zod";
import { ValidationError } from "../../server/kernel/errors.ts";
import { createTempDir } from "../helpers/temp-dir.ts";
import { planRewind } from "../../server/run/rewind.ts";

// ── Table-driven inputs ──

const PROJECT_INPUTS = [
  { name: "alpha", path: "/a" },
  { name: "beta", path: "/b" },
  { name: "gamma", path: "/c" },
] as const;

const CHAT_INPUTS = [
  { title: "first chat" },
  { title: "second chat", model_id: "gpt-4o" },
] as const;

const MESSAGE_ROLES = ["user", "assistant", "tool", "error"] as const;

// ── Test fixture: fresh in-memory DB per test ──

let tmpRoot = "";

beforeEach(() => {
  tmpRoot = createTempDir("ch-web-db-");
});

function freshDb(): { db: DbClient; userId: string } {
  // Use a fresh file per test under tmpRoot so we exercise the
  // file-path code path (not just:memory:). v12: create a registered
  // user so the user_id-scoped project methods have an owner.
  const path = join(tmpRoot, `web-${Math.random().toString(36).slice(2)}.db`);
  const db = new DbClient({ path });
  const userId = createTestUser(db, "owner").userId;
  return { db, userId };
}

// ── Migration tests ──

describe("db migrations", () => {
  test("a fresh DB reaches the latest schema version", () => {
    const path = join(tmpRoot, "fresh.db");
    const db = new DatabaseSync(path);
    try {
      const version = runMigrations(db);
      expect(version).toBe(SCHEMA_VERSION_LATEST);
      expect(readSchemaVersion(db)).toBe(SCHEMA_VERSION_LATEST);
    } finally {
      db.close();
    }
  });

  test("migrations are idempotent — running twice is a no-op", () => {
    const path = join(tmpRoot, "idem.db");
    const db = new DatabaseSync(path);
    try {
      runMigrations(db);
      const version1 = readSchemaVersion(db);
      runMigrations(db);
      const version2 = readSchemaVersion(db);
      expect(version2).toBe(version1);
      expect(version2).toBe(SCHEMA_VERSION_LATEST);
    } finally {
      db.close();
    }
  });

  test("a targetVersion below latest stops at the target", () => {
    const path = join(tmpRoot, "targeted.db");
    const db = new DatabaseSync(path);
    try {
      // We only have migration v1 today; target 0 should apply nothing.
      runMigrations(db, 0);
      expect(readSchemaVersion(db)).toBe(0);
    } finally {
      db.close();
    }
  });

  test("MIGRATIONS list is sorted by version and starts at 1", () => {
    const versions = MIGRATIONS.map((m) => m.version);
    const sorted = [...versions].sort((a, b) => a - b);
    expect(versions).toEqual(sorted);
    expect(versions[0]).toBe(1);
  });
});

// ── Project CRUD ──

describe("db client: projects", () => {
  test("createProject returns the persisted row with timestamps", () => {
    const { db, userId } = freshDb();
    try {
      const row = db.createProject(PROJECT_INPUTS[0]!, userId);
      expect(row.id).toMatch(/-/);
      expect(row.name).toBe("alpha");
      expect(row.path).toBe("/a");
      expect(row.created_at).toBe(row.updated_at);
      expect(row.config_overlay).toBeNull();
    } finally { db.close(); }
  });

  test("listProjects orders by REAL LAST ACTIVITY (chats' updated_at, newest first) — the river's measure", async () => {
    // ONE ORDERING OWNER (the switch-river CLS finding): the wire serves the
    // projects in the order the Switch river displays — real chat activity,
    // newest first — so the river's first fill IS its settled order and no
    // post-paint re-sort happens. The OLD contract (created_at ASC) made the
    // first fill rank by stale project-row timestamps and re-sort once chats
    // landed; this arm pins the replacement contract, not the old one.
    const { db, userId } = freshDb();
    try {
      // alpha is created FIRST and stays the oldest by every row timestamp…
      const alpha = db.createProject(PROJECT_INPUTS[0]!, userId);
      await new Promise((r) => setTimeout(r, 3));
      db.createProject(PROJECT_INPUTS[1]!, userId);
      await new Promise((r) => setTimeout(r, 3));
      const gamma = db.createProject(PROJECT_INPUTS[2]!, userId);
      // …then work happens in alpha, making it the most-recently-active —
      // the exact user shape that red the CLS gate (an old project made the
      // most-recent by real conversation).
      await new Promise((r) => setTimeout(r, 3));
      const chat = db.createChat({ project_id: alpha.id, title: "recent work" }, userId);
      db.createMessage({ chat_id: chat.id, role: "user", content: "hello" }, userId);
      // The message's write bumped the chat's updated_at — read it back so
      // the assertion compares against the REAL activity instant.
      const activity = db.getChat(chat.id, userId)!.updated_at;

      const list = db.listProjects(userId);
      // Activity order DESC: alpha (its conversation just moved) leads, then
      // the chat-less projects by their own row times, newest first.
      expect(list.map((p) => p.name)).toEqual(["alpha", "gamma", "beta"]);
      // The served `updated_at` IS the activity instant — the same value the
      // river's first fill ranks by — not the stale project-row timestamp.
      // This is what makes the client's pre-chat sort agree with the wire
      // order, which is the whole fix.
      expect(list[0]!.updated_at).toBe(activity);
      expect(activity > gamma.updated_at).toBe(true);
      expect(list[0]!.updated_at).not.toBe(alpha.updated_at);
    } finally { db.close(); }
  });

  test("listProjects with NO chats falls back to the project row's own updated_at, DESC", async () => {
    const { db, userId } = freshDb();
    try {
      db.createProject(PROJECT_INPUTS[0]!, userId);
      await new Promise((r) => setTimeout(r, 3));
      db.createProject(PROJECT_INPUTS[1]!, userId);
      await new Promise((r) => setTimeout(r, 3));
      const gamma = db.createProject(PROJECT_INPUTS[2]!, userId);
      // No conversation anywhere: the most-recently-created (touched) project
      // leads — the DESC direction of the fallback, which the old ASC
      // contract answered the other way.
      const list = db.listProjects(userId);
      expect(list.map((p) => p.name)).toEqual(["gamma", "beta", "alpha"]);
      expect(list[0]!.updated_at).toBe(gamma.updated_at);
    } finally { db.close(); }
  });

  test("getProject returns null for unknown id", () => {
    const { db, userId } = freshDb();
    try {
      expect(db.getProject("does-not-exist", userId)).toBeNull();
    } finally { db.close(); }
  });

  test("createProject rejects invalid input (empty name)", () => {
    const { db, userId } = freshDb();
    try {
      // Tightened (EHC-3): empty name fails the zod schema
      // (PROJECT_CREATE_INPUT.parse) → ZodError. A loose `.toThrow` would
      // pass on ANY error (e.g. a connection failure), masking a real bug.
      expect(() => db.createProject({ name: "", path: "/x" }, userId)).toThrow(ZodError);
    } finally { db.close(); }
  });
});

// ── Chat + Message + ToolCall + History CRUD ──

describe("db client: chats + messages + history", () => {
  test("project → many chats: listChats returns only the project's chats", () => {
    const { db, userId } = freshDb();
    try {
      const p1 = db.createProject(PROJECT_INPUTS[0]!, userId);
      const p2 = db.createProject(PROJECT_INPUTS[1]!, userId);
      db.createChat({ project_id: p1.id, title: "p1-c1" }, userId);
      db.createChat({ project_id: p1.id, title: "p1-c2" }, userId);
      db.createChat({ project_id: p2.id, title: "p2-c1" }, userId);

      expect(db.listChats(p1.id, userId).map((c) => c.title)).toEqual(["p1-c2", "p1-c1"]);
      expect(db.listChats(p2.id, userId).map((c) => c.title)).toEqual(["p2-c1"]);
    } finally { db.close(); }
  });

  test("createChat with modelId persists it; without, modelId is null", () => {
    const { db, userId } = freshDb();
    try {
      const p = db.createProject(PROJECT_INPUTS[0]!, userId);
      const withModel = db.createChat({ project_id: p.id, ...CHAT_INPUTS[1] }, userId);
      const noModel = db.createChat({ project_id: p.id, ...CHAT_INPUTS[0] }, userId);
      expect(withModel.model_id).toBe("gpt-4o");
      expect(noModel.model_id).toBeNull();
    } finally { db.close(); }
  });

  test("createMessage + listMessages: messages persist and round-trip", () => {
    const { db, userId } = freshDb();
    try {
      const p = db.createProject(PROJECT_INPUTS[0]!, userId);
      const c = db.createChat({ project_id: p.id, title: "t" }, userId);
      db.createMessage({ chat_id: c.id, role: "user", content: "hello" }, userId);
      db.createMessage({ chat_id: c.id, role: "assistant", content: "hi back" }, userId);
      const msgs = db.listMessages(c.id, userId);
      expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
      expect(msgs.map((m) => m.content)).toEqual(["hello", "hi back"]);
    } finally { db.close(); }
  });

  test("createMessage rejects an invalid role", () => {
    const { db, userId } = freshDb();
    try {
      const p = db.createProject(PROJECT_INPUTS[0]!, userId);
      const c = db.createChat({ project_id: p.id, title: "t" }, userId);
      expect(() =>
        db.createMessage({ chat_id: c.id, role: "invalid" as never, content: "x" }, userId),
      ).toThrow(ZodError);
    } finally { db.close(); }
  });

  test("table-driven: all valid message roles persist", () => {
    const { db, userId } = freshDb();
    try {
      const p = db.createProject(PROJECT_INPUTS[0]!, userId);
      const c = db.createChat({ project_id: p.id, title: "t" }, userId);
      for (const role of MESSAGE_ROLES) {
        db.createMessage({ chat_id: c.id, role, content: `(${role})` }, userId);
      }
      const roles = db.listMessages(c.id, userId).map((m) => m.role);
      expect(roles).toEqual([...MESSAGE_ROLES]);
    } finally { db.close(); }
  });

  test("createToolCall + listToolCallsByChat round-trips JSON input/output", () => {
    const { db, userId } = freshDb();
    try {
      const p = db.createProject(PROJECT_INPUTS[0]!, userId);
      const c = db.createChat({ project_id: p.id, title: "t" }, userId);
      const m = db.createMessage({ chat_id: c.id, role: "tool", content: "" }, userId);
      db.createToolCall({
        message_id: m.id,
        tool_name: "read_file",
        input: { path: "server/index.ts" },
        output: { lines: 85 },
        status: "done",
        duration_ms: 12,
      }, userId);
      const tcs = db.listToolCallsByChat(c.id, userId);
      expect(tcs).toHaveLength(1);
      expect(tcs[0]!.tool_name).toBe("read_file");
      expect(tcs[0]!.input).toEqual({ path: "server/index.ts" });
      expect(tcs[0]!.output).toEqual({ lines: 85 });
      expect(tcs[0]!.status).toBe("done");
      expect(tcs[0]!.duration_ms).toBe(12);
    } finally { db.close(); }
  });

  test("getChatHistory returns the chat plus all related rows", () => {
    const { db, userId } = freshDb();
    try {
      const p = db.createProject(PROJECT_INPUTS[0]!, userId);
      const c = db.createChat({ project_id: p.id, title: "t" }, userId);
      const m = db.createMessage({ chat_id: c.id, role: "user", content: "hi" }, userId);
      db.createToolCall({
        message_id: m.id,
        tool_name: "search",
        input: { q: "x" },
        status: "running",
      }, userId);
      db.createMetricsSnapshot({ chat_id: c.id, snapshot: { totalCalls: 10 } }, userId);
      db.createTimelineRef({
        chat_id: c.id,
        event_id: "evt-1",
        event_type: "tool",
        timestamp: new Date().toISOString(),
        metadata: { runId: "r1" },
      }, userId);

      const history = db.getChatHistory(c.id, userId);
      expect(history).not.toBeNull();
      expect(history!.chat.id).toBe(c.id);
      expect(history!.messages).toHaveLength(1);
      expect(history!.tool_calls).toHaveLength(1);
      expect(history!.metrics_snapshots).toHaveLength(1);
      expect(history!.timeline_refs).toHaveLength(1);
      expect(history!.metrics_snapshots[0]!.snapshot).toEqual({ totalCalls: 10 });
      expect(history!.timeline_refs[0]!.metadata).toEqual({ runId: "r1" });
    } finally { db.close(); }
  });

  test("getChatHistory returns null for an unknown chat id", () => {
    const { db, userId } = freshDb();
    try {
      expect(db.getChatHistory("nope", userId)).toBeNull();
    } finally { db.close(); }
  });

  /**
   * These two tests exercised `deleteMessagesAfter`, which no longer exists:
   * rewinding withdraws rather than trims, so the DB owner carries no
   * message-deleting method at all (`data-loss-8-rollback.test.ts` is the
   * ratchet that keeps it that way).
   *
   * The first one's subject is gone with the method. The second's is NOT — it
   * protected cross-conversation isolation, which still matters and now lives
   * on the rewind owner. It is restated here against that owner rather than
   * dropped, because the guarantee outlived its implementation.
   */
  test("a rewind cannot take an anchor from another conversation", () => {
    const { db, userId } = freshDb();
    try {
      const p = db.createProject(PROJECT_INPUTS[0]!, userId);
      const c1 = db.createChat({ project_id: p.id, title: "c1" }, userId);
      const c2 = db.createChat({ project_id: p.id, title: "c2" }, userId);
      const foreign = db.createMessage({ chat_id: c1.id, role: "user", content: "x" }, userId);
      db.createMessage({ chat_id: c2.id, role: "user", content: "y" }, userId);

      // The anchor is resolved WITHIN the conversation's own rows, so an id
      // from another chat is not "rejected" by a check that someone could
      // forget to write — it is simply not present to be found. That is the
      // isolation being structural rather than remembered.
      const plan = planRewind(db.listMessages(c2.id, userId), foreign.id, "at");
      expect(plan).toBeNull();
      expect(db.listMessages(c2.id, userId)).toHaveLength(1);
      expect(db.listMessages(c1.id, userId)).toHaveLength(1);
    } finally { db.close(); }
  });

  test("a rewind within one conversation names the anchor and everything after it", () => {
    const { db, userId } = freshDb();
    try {
      const p = db.createProject(PROJECT_INPUTS[0]!, userId);
      const c = db.createChat({ project_id: p.id, title: "t" }, userId);
      const m1 = db.createMessage({ chat_id: c.id, role: "user", content: "first" }, userId);
      const m2 = db.createMessage({ chat_id: c.id, role: "assistant", content: "second" }, userId);
      const m3 = db.createMessage({ chat_id: c.id, role: "user", content: "third" }, userId);

      const plan = planRewind(db.listMessages(c.id, userId), m2.id, "at");
      expect(plan).not.toBeNull();
      expect(plan!.anchorMessageId).toBe(m2.id);
      // Inclusive of the anchor, and m1 — which precedes it — survives.
      expect(plan!.discardedMessageIds).toEqual([m2.id, m3.id]);
      // Nothing was destroyed by planning it.
      expect(db.listMessages(c.id, userId)).toHaveLength(3);
      expect(db.listMessages(c.id, userId)[0]!.id).toBe(m1.id);
    } finally { db.close(); }
  });
});

// ── Auto-checks ──

describe("db client: auto-checks", () => {
  test("project-scoped and chat-scoped checks are listed separately (no overlap, no dups)", () => {
    const { db, userId } = freshDb();
    try {
      const p = db.createProject(PROJECT_INPUTS[0]!, userId);
      const c = db.createChat({ project_id: p.id, title: "t" }, userId);
      db.createAutoCheck({ project_id: p.id, check_name: "lint", status: "passed", output: {} }, userId);
      db.createAutoCheck({ project_id: p.id, chat_id: c.id, check_name: "typecheck", status: "running", output: {} }, userId);

      // Project list shows ONLY project-level checks (chat_id IS NULL) — the
      // chat-scoped "typecheck" does NOT leak into the project list.
      expect(db.listAutoChecksByProject(p.id, userId)).toHaveLength(1);
      expect(db.listAutoChecksByProject(p.id, userId)[0]!.check_name).toBe("lint");
      expect(db.listAutoChecksByProject(p.id, userId)[0]!.chat_id).toBeNull();
      // Chat list shows ONLY chat-scoped checks.
      expect(db.listAutoChecksByChat(c.id, userId)).toHaveLength(1);
      expect(db.listAutoChecksByChat(c.id, userId)[0]!.check_name).toBe("typecheck");
      // The two lists are disjoint — no check appears under both.
      const projectNames = new Set(db.listAutoChecksByProject(p.id, userId).map((x) => x.id));
      const chatNames = new Set(db.listAutoChecksByChat(c.id, userId).map((x) => x.id));
      for (const id of chatNames) expect(projectNames.has(id)).toBe(false);

      // Dedup: re-running the same check (same name + scope) replaces, not duplicates.
      db.createAutoCheck({ project_id: p.id, check_name: "lint", status: "failed", output: { errors: 3 } }, userId);
      expect(db.listAutoChecksByProject(p.id, userId)).toHaveLength(1); // still 1, not 2
      expect(db.listAutoChecksByProject(p.id, userId)[0]!.status).toBe("failed"); // updated in place
    } finally { db.close(); }
  });

  test("createAutoCheck rejects an invalid status", () => {
    const { db, userId } = freshDb();
    try {
      const p = db.createProject(PROJECT_INPUTS[0]!, userId);
      expect(() =>
        db.createAutoCheck({ project_id: p.id, check_name: "x", status: "bogus" as never, output: {} }, userId),
      ).toThrow(ZodError);
    } finally { db.close(); }
  });

  test("createAutoCheck rejects an unscoped check (both project_id and chat_id null)", () => {
    // A check with no project_id AND no chat_id has no ownership anchor:
    // the ownership pre-checks skip (no scope id to verify), the dedup
    // lookup matches across ALL users, and an unscoped, unowned row is
    // created — a cross-user collision + deny-by-default gap. The DbClient
    // gate rejects it with a specific ValidationError (not a generic throw).
    const { db, userId } = freshDb();
    try {
      const err = (() => {
        try {
          db.createAutoCheck({ check_name: "orphan", status: "running", output: {} }, userId);
          throw new Error("expected createAutoCheck to reject an unscoped check");
        } catch (e) {
          return e as Error;
        }
      })();
      expect(err, "must throw ValidationError, not a generic Error").toBeInstanceOf(ValidationError);
      expect((err as ValidationError).code, "must carry the invalid_auto_check_scope code").toBe("invalid_auto_check_scope");
    } finally { db.close(); }
  });
});

// ── Conversation record is undeletable (v16 BEFORE DELETE ABORT) ──

describe("db client: conversation rows cannot be deleted", () => {
  test("a raw DELETE FROM chats is aborted; messages, tool_calls, timeline_refs stay", () => {
    const { db, userId } = freshDb();
    try {
      const p = db.createProject(PROJECT_INPUTS[0]!, userId);
      const c = db.createChat({ project_id: p.id, title: "t" }, userId);
      const m = db.createMessage({ chat_id: c.id, role: "user", content: "x" }, userId);
      db.createToolCall({ message_id: m.id, tool_name: "t", input: {}, status: "done" }, userId);
      db.createTimelineRef({
        chat_id: c.id,
        event_id: "e1",
        event_type: "tool",
        timestamp: new Date().toISOString(),
        metadata: {},
      }, userId);

      // A second handle with foreign_keys ON — the old CASCADE path. The
      // engine must abort before CASCADE can run.
      const raw = new DatabaseSync(db.path);
      try {
        raw.exec("PRAGMA foreign_keys = ON");
        expect(() => raw.prepare("DELETE FROM chats WHERE id = ?").run(c.id)).toThrow(
          /never deleted/,
        );
      } finally {
        raw.close();
      }

      expect(db.getChat(c.id, userId)?.id).toBe(c.id);
      expect(db.listMessages(c.id, userId)).toHaveLength(1);
      expect(db.listToolCallsByChat(c.id, userId)).toHaveLength(1);
      expect(db.listTimelineRefs(c.id, userId)).toHaveLength(1);
    } finally { db.close(); }
  });
});

describe("db client: tool settings upsert (atomic, no race)", () => {
  test("upsertToolSetting on a fresh key inserts and returns the row", () => {
    const { db, userId } = freshDb();
    try {
      const row = db.upsertToolSetting({ tool_name: "read_file", enabled: true }, userId);
      expect(row.tool_name).toBe("read_file");
      expect(row.enabled).toBe(true);
      expect(row.user_id).toBe(userId);
      expect(db.listToolSettings(userId)).toHaveLength(1);
    } finally { db.close(); }
  });

  test("re-toggling the same key UPDATEs the prior row (no duplicate, no throw, id preserved)", () => {
    // Regression for the SELECT-then-INSERT race: a second upsert for the
    // same (user_id, tool_name) must UPDATE the prior row, not insert a
    // duplicate (which the UNIQUE(user_id, tool_name) index would reject
    // with an unhandled SQLITE_CONSTRAINT). The atomic ON CONFLICT upsert
    // makes this safe. The row id is preserved across the conflict (the
    // DO UPDATE clause does not touch id), so a caller caching the id is
    // not handed a stale reference.
    const { db, userId } = freshDb();
    try {
      const first = db.upsertToolSetting({ tool_name: "read_file", enabled: true }, userId);
      const firstId = first.id;
      const second = db.upsertToolSetting({ tool_name: "read_file", enabled: false, config: { x: 1 } }, userId);
      expect(second.id).toBe(firstId);
      expect(second.enabled).toBe(false);
      expect(second.config).toEqual({ x: 1 });
      expect(db.listToolSettings(userId)).toHaveLength(1);
    } finally { db.close(); }
  });

  test("upsertToolSetting does not collide across users (same tool name, different user id)", () => {
    const { db } = freshDb();
    try {
      const userA = createTestUser(db, "userA").userId;
      const userB = createTestUser(db, "userB").userId;
      db.upsertToolSetting({ tool_name: "read_file", enabled: false }, userA);
      db.upsertToolSetting({ tool_name: "read_file", enabled: true }, userB);
      expect(db.listToolSettings(userA)).toHaveLength(1);
      expect(db.listToolSettings(userB)).toHaveLength(1);
      expect(db.listToolSettings(userA)[0]!.enabled).toBe(false);
      expect(db.listToolSettings(userB)[0]!.enabled).toBe(true);
    } finally { db.close(); }
  });

  test("upsertToolSetting tolerates a pre-existing row from a concurrent writer (atomic update, no constraint throw)", () => {
    // Directly exercises the race the atomic upsert closes: a row already
    // exists (inserted by another path — a concurrent writer that won the
    // SELECT-then-INSERT race the old code had) when upsertToolSetting
    // runs. The atomic ON CONFLICT must UPDATE it rather than throw
    // SQLITE_CONSTRAINT. The pre-existing row is inserted via a raw second
    // connection (the way a concurrent writer would), then upsert runs.
    const { db, userId } = freshDb();
    try {
      const raw = new DatabaseSync(db.path);
      try {
        raw.prepare(
          "INSERT INTO tool_settings (id, user_id, tool_name, enabled, config, updated_at) VALUES (?, ?, ?, ?, NULL, ?)",
        ).run("pre-existing-id", userId, "search_code", 1, new Date().toISOString());
      } finally {
        raw.close();
      }
      const row = db.upsertToolSetting({ tool_name: "search_code", enabled: false }, userId);
      expect(row.id).toBe("pre-existing-id");
      expect(row.enabled).toBe(false);
      expect(db.listToolSettings(userId)).toHaveLength(1);
    } finally { db.close(); }
  });
});


// SQL compilation belongs to a connection and a finite authored callsite.
// Executions still bind current inputs and read current database contents.
describe("db client: prepared statement ownership", () => {
  test("reuses SQL while changed values, contents and ownership remain live", () => {
    const { db, userId } = freshDb();
    const intruder = createTestUser(db, "intruder").userId;
    const prepared = vi.spyOn(DatabaseSync.prototype, "prepare");
    const constructed = vi.spyOn(String, "raw");
    try {
      for (let index = 0; index < 4; index++) expect(db.countUsers()).toBe(2);
      const staticConstruction = constructed.mock.calls.filter(([parts]) =>
        parts.raw.length === 1 && parts.raw[0] === "SELECT COUNT(*) AS n FROM users");
      expect(staticConstruction.length,
        "an immutable static statement needs at most one construction across repeated live executions").toBeLessThanOrEqual(1);
      const project = db.createProject({ name: "statements", path: "/statements" }, userId);
      const chat = db.createChat({ project_id: project.id, title: "current rows" }, userId);
      for (let i = 0; i < 3; i += 1) {
        const message = db.createMessage({ chat_id: chat.id, role: "user", content: `initial-${i}` }, userId);
        expect(db.getMessage(message.id, userId)?.content).toBe(`initial-${i}`);
        db.updateMessageContent(message.id, `changed-${i}`, userId);
        expect(db.getMessage(message.id, userId)?.content).toBe(`changed-${i}`);
        expect(db.getMessage(message.id, intruder)).toBeNull();
        db.updateMessageContent(message.id, "intruder", intruder);
        expect(db.getMessage(message.id, userId)?.content).toBe(`changed-${i}`);
      }
      expect(prepared.mock.calls.filter(([sql]) => sql.includes("WHERE m.id = ? AND p.user_id = ?")),
        "the same SQL must compile once while every read still executes with its current bindings").toHaveLength(1);
      expect(prepared.mock.calls.filter(([sql]) => sql.startsWith("INSERT INTO messages "))).toHaveLength(1);
    } finally { constructed.mockRestore(); prepared.mockRestore(); db.close(); }
  });

  test("one callsite retains only its last SQL shape and recompiles a changed shape", () => {
    const { db, userId } = freshDb();
    try {
      const project = db.createProject({ name: "initial", path: "/initial" }, userId);
      const prepared = vi.spyOn(DatabaseSync.prototype, "prepare");
      const constructed = vi.spyOn(String, "raw");
      try {
        expect(db.updateProject(project.id, { name: "first" }, userId)?.name).toBe("first");
        expect(db.updateProject(project.id, { name: "second" }, userId)?.name).toBe("second");
        expect(db.updateProject(project.id, { path: "/first" }, userId)).toMatchObject({ name: "second", path: "/first" });
        expect(db.updateProject(project.id, { path: "/second" }, userId)).toMatchObject({ name: "second", path: "/second" });
        expect(db.updateProject(project.id, { name: "last" }, userId)).toMatchObject({ name: "last", path: "/second" });
        expect(prepared.mock.calls.filter(([sql]) => sql.startsWith("UPDATE projects SET ")),
          "name → path → name recompiles three times; input variants cannot accumulate in an unbounded SQL map").toHaveLength(3);
        expect(constructed.mock.calls.filter(([parts]) => parts.raw[0] === "UPDATE projects SET ").length,
          "unchanged primitive substitutions need no reconstruction between the three SQL shape transitions").toBeLessThanOrEqual(3);
      } finally { constructed.mockRestore(); prepared.mockRestore(); }
    } finally { db.close(); }
  });

  test("connections and close/reopen never share prepared native statements", () => {
    const first = freshDb();
    const second = freshDb();
    let firstOpen = true;
    try {
      expect(first.db.getUserByUsername("owner")?.id).toBe(first.userId);
      expect(second.db.getUserByUsername("owner")?.id).toBe(second.userId);
      expect(second.userId).not.toBe(first.userId);
      first.db.close(); firstOpen = false;
      let closedError: unknown;
      try { first.db.getUserByUsername("owner"); }
      catch (error) { closedError = error; }
      expect(closedError).toBeInstanceOf(Error);
      expect(closedError).toMatchObject({
        code: "ERR_INVALID_STATE", message: "database is not open",
      });
      expect(second.db.getUserByUsername("owner")?.id).toBe(second.userId);
      const reopened = new DbClient({ path: first.db.path });
      try { expect(reopened.getUserByUsername("owner")?.id).toBe(first.userId); }
      finally { reopened.close(); }
    } finally { if (firstOpen) first.db.close(); second.db.close(); }
  });
});
