// @vitest-environment node
/**
 * Rewind suite split: rewind-restore-hostile.
 *
 * The original 1,502-line file shared one DB, server and rewind fold across 44
 * tests. This file owns one behavior group with a fresh harness, so the late
 * test's cost is linear in its own group rather than the whole file.
 */
// @vitest-environment node
import { describe, test, expect, beforeAll, afterAll, vi } from "vitest";
vi.hoisted(() => {
  // The original file raised the limit because its 70 real runs share one
  // session. Each split file keeps the same setting; the limiter still runs.
  process.env.HARNESS_WEB_RATE_LIMIT = "10000";
  delete process.env.HARNESS_WEB_LLM_FIXTURES;
});
import type { DbClient } from "../../server/db/client.ts";
import { createTestUser } from "../helpers/multi-user.ts";
import { createRewindHarness, NUL } from "../helpers/rewind-provider-harness.ts";
import { getTimelineQuery } from "../../server/observability/timeline-bridge.ts";
import {
  discardedMessageIdsForChat,
  recordRestore,
  withdrawnStretchById,
} from "../../server/run/rewind.ts";
import { APPEND_ONLY_TRIGGERS } from "../../engine/src/timeline/timeline-schema.ts";
import { read } from "../helpers/source-scan.ts";

// The provider stays a real module-level mock at the same measurement point as
// the original file. Each split file gets a fresh harness, DB, ledger and
// memory store, so the late-test accumulation does not cross a file boundary.
vi.mock("../../engine/src/shared/llm/client.ts", async () => {
  const { rewindProvider } = await import("../helpers/rewind-provider-state.ts");
  class SharedLLMClient {
    constructor(_config: unknown) {}
    async *stream(redacted: unknown): AsyncGenerator<Readonly<Record<string, unknown>>, void, unknown> {
      const request = redacted as { input?: Array<{ type?: string; role?: string; content?: string }> };
      rewindProvider.requests.push(
        (request.input ?? []).filter((item) => item.type === "message")
          .map((item) => ({ role: item.role ?? "", content: item.content ?? "" })),
      );
      yield { type: "content", text: rewindProvider.reply };
      yield { type: "finish", reason: "stop", truncated: false };
    }
  }
  return { SharedLLMClient };
});

const harness = createRewindHarness();
const { api, drainRunStream, newConversation, sendTurn, storedMessages, rewind, pairs, systemOf, withdrawn, restore } = harness;
let db: DbClient;
let ownerUserId: string;
let authCookie: string;

beforeAll(async () => {
  ({ db, ownerUserId, authCookie } = await harness.start());
});
afterAll(async () => { await harness.stop(); });

describe("hostile restore cases", () => {
  test("hostile: restoring the same withdrawal twice is refused, not counted twice", async () => {
    const ids = await newConversation("restore-twice");
    await sendTurn(ids, "xi one", "xi answer");
    const rows = await storedMessages(ids.chatId);
    const { data } = await rewind(ids.chatId, rows[0]!.id, "at");

    expect((await restore(ids.chatId, data.eventId as string)).status).toBe(200);
    const again = await restore(ids.chatId, data.eventId as string);
    expect(again.status).toBe(404);
    expect((again.body as { error: string }).error).toBe("not_found");
    expect((again.body as { message: string }).message).toContain("already been brought back");
    // One reversal in the record, not two.
    expect((await withdrawn(ids.chatId)).stretches.filter((s) => s.restored)).toHaveLength(1);
  }, 30000);

  test("hostile: an event id this chat never recorded is refused", async () => {
    const ids = await newConversation("restore-unknown-event");
    await sendTurn(ids, "omicron one", "omicron answer");
    const res = await restore(ids.chatId, "evt-nobody-recorded");
    expect(res.status).toBe(404);
    expect((res.body as { error: string }).error).toBe("not_found");
  }, 30000);

  test("hostile: a withdrawal recorded in ANOTHER conversation cannot be restored here", async () => {
    const mine = await newConversation("restore-cross-chat-a");
    const other = await newConversation("restore-cross-chat-b");
    await sendTurn(mine, "pi one", "pi answer");
    await sendTurn(other, "rho one", "rho answer");
    const otherRows = await storedMessages(other.chatId);
    const { data } = await rewind(other.chatId, otherRows[0]!.id, "at");

    // The other conversation's withdrawal, aimed at this one.
    const res = await restore(mine.chatId, data.eventId as string);
    expect(res.status).toBe(404);
    // …and it did NOT leak into this chat's list, nor come undone in its own.
    expect((await withdrawn(mine.chatId)).stretches).toEqual([]);
    expect((await withdrawn(other.chatId)).stretches[0]!.restored).toBe(false);
  }, 40000);

  test("hostile: another user can neither see nor restore this conversation's withdrawals", async () => {
    const ids = await newConversation("restore-cross-user");
    await sendTurn(ids, "sigma one", "sigma answer");
    const rows = await storedMessages(ids.chatId);
    const { data } = await rewind(ids.chatId, rows[0]!.id, "at");

    const stranger = createTestUser(db, `restore-stranger-${Date.now()}`);
    // The read is refused at the chat gate — the stranger does not own it.
    expect((await withdrawn(ids.chatId, stranger.cookie)).status).toBe(404);
    const res = await restore(ids.chatId, data.eventId as string, stranger.cookie);
    expect(res.status).toBe(404);
    // The withdrawal stands, untouched.
    expect((await withdrawn(ids.chatId)).stretches[0]!.restored).toBe(false);
    expect(discardedMessageIdsForChat(ids.chatId, ownerUserId).size).toBe(
      (data.discardedMessageIds as string[]).length,
    );
  }, 40000);

  test("hostile: the restore door refuses malformed input with a 4xx, never a 500", async () => {
    const ids = await newConversation("restore-malformed");
    const bad: unknown[] = [
      {},
      { chatId: ids.chatId },
      { chatId: ids.chatId, eventId: null },
      { chatId: ids.chatId, eventId: 7 },
      { chatId: ids.chatId, eventId: "" },
      { chatId: ids.chatId, eventId: "x".repeat(5000) },
      { chatId: ids.chatId, eventId: `evt-${NUL}-cut-here` },
      { chatId: ids.chatId, eventId: "evt-\u{1F4A9}\u{10FFFF}" },
      { chatId: ids.chatId, eventId: "evt-1", extra: "not in the schema" },
      { chatId: null, eventId: "evt-1" },
    ];
    for (const body of bad) {
      const res = await api("POST", "/api/b/run.compose/restore", body);
      const shown = JSON.stringify(body).slice(0, 60);
      expect(res.status, `${shown} must be refused`).toBeGreaterThanOrEqual(400);
      expect(res.status, `${shown} produced a server error`).toBeLessThan(500);
    }
  }, 30000);

  test("hostile: a NUL-bearing event id is refused AS AN ID, not truncated into a real one", async () => {
    // NUL has twice hidden code from text tools in this project, so the
    // question is not whether it is rejected but whether it is rejected as
    // the WHOLE string it is. A door that cut the value at the NUL would
    // read this as the real event id and bring the stretch back.
    const ids = await newConversation("restore-nul-truncation");
    await sendTurn(ids, "tau one", "tau answer");
    const rows = await storedMessages(ids.chatId);
    const { data } = await rewind(ids.chatId, rows[0]!.id, "at");

    const res = await restore(ids.chatId, `${String(data.eventId)}${NUL}junk`);
    expect(res.status).toBe(404);
    expect((await withdrawn(ids.chatId)).stretches[0]!.restored).toBe(false);
    expect(discardedMessageIdsForChat(ids.chatId, ownerUserId).size).toBe(
      (data.discardedMessageIds as string[]).length,
    );
  }, 30000);

  test("hostile: two restores of the same withdrawal at once produce ONE reversal", async () => {
    const ids = await newConversation("restore-concurrent");
    await sendTurn(ids, "upsilon one", "upsilon answer");
    const rows = await storedMessages(ids.chatId);
    const { data } = await rewind(ids.chatId, rows[0]!.id, "at");

    const [a, b] = await Promise.all([
      restore(ids.chatId, data.eventId as string),
      restore(ids.chatId, data.eventId as string),
    ]);
    const ok = [a, b].filter((r) => r.status === 200);
    // Whichever landed first wins; the other must be refused rather than
    // appending a second reversal for one withdrawal.
    expect(ok.length, "both restores succeeded — the record now double-counts").toBe(1);
    expect((await withdrawn(ids.chatId)).stretches.filter((s) => s.restored)).toHaveLength(1);
    // The served history and the ledger agree afterwards.
    const restoredRows = await storedMessages(ids.chatId);
    expect(restoredRows.filter((m) => m.discarded === true)).toHaveLength(0);
    expect(discardedMessageIdsForChat(ids.chatId, ownerUserId).size).toBe(0);
  }, 40000);

  test("the restore APPEND refuses a second reversal for one withdrawal — deterministically, at the owner", async () => {
    // The HTTP race above is real but TIMING-dependent: it needs the suite's
    // worker pressure to interleave the two requests into the check-then-act
    // window, which is why it flaked rather than failed every run. The
    // property itself is not timing — a second reversal of the same
    // withdrawal must be refused no matter how it arrives — so it is pinned
    // HERE, at the owner's append, with no HTTP and no scheduling between the
    // two calls: the first `recordRestore` commits, the second meets the
    // fold's own re-read and is refused. Removing the refusal inside
    // `recordRestore` turns this arm red on every run (mutation-verified);
    // the HTTP arm above is the same class driven through the real door.
    const ids = await newConversation("restore-owner-atomic");
    await sendTurn(ids, "omicron one", "omicron answer");
    const rows = await storedMessages(ids.chatId);
    const { data } = await rewind(ids.chatId, rows[0]!.id, "at");

    const stretch = withdrawnStretchById(ids.chatId, ownerUserId, data.eventId as string);
    expect(stretch, "the rewind just recorded must be inspectable").not.toBeNull();
    expect(stretch!.restored).toBe(false);

    const firstId = recordRestore(ids.chatId, ownerUserId, stretch!);
    expect(typeof firstId).toBe("string");
    // The second append of the SAME withdrawal is refused by name — never a
    // second reversal row, never a double-counted record.
    let caught: unknown = null;
    try {
      recordRestore(ids.chatId, ownerUserId, stretch!);
    } catch (err) {
      caught = err;
    }
    expect(caught, "the second restore of one withdrawal appended a second reversal").not.toBeNull();
    expect((caught as Error).name).toBe("NotFoundError");
    expect(String((caught as Error).message)).toContain("already been brought back");
    // Exactly one stretch, restored once.
    expect((await withdrawn(ids.chatId)).stretches.filter((s) => s.restored)).toHaveLength(1);
  }, 30000);

  test("the reversal is an APPEND — it lands in the same append-only lane", async () => {
    // The restore is only honest if it obeys the same law as the thing it
    // reverses.
    const ids = await newConversation("restore-is-append-only");
    await sendTurn(ids, "phi one", "phi answer");
    const rows = await storedMessages(ids.chatId);
    const { data } = await rewind(ids.chatId, rows[0]!.id, "at");
    const res = await restore(ids.chatId, data.eventId as string);
    const reversalId = (res.body as { data: { eventId: string } }).data.eventId;

    const events = getTimelineQuery().byEventType("rollback", { limit: 500 }).events;
    const reversal = events.find((e) => e.eventId === reversalId);
    expect(reversal, "the reversal must be in the ledger").toBeDefined();
    expect(reversal!.description).toContain("rewind-restore:");
    // The triggers the schema declares are what refuse an edit to either
    // event; read from the schema owner so a dropped trigger is caught here.
    expect(APPEND_ONLY_TRIGGERS.length).toBeGreaterThan(0);
  }, 30000);
});
