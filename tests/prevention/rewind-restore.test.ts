// @vitest-environment node
/**
 * Rewind suite split: rewind-restore.
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
import { createRewindHarness } from "../helpers/rewind-provider-harness.ts";
import {
  discardedMessageIdsForChat,
  discardedRunIdsForChat,
} from "../../server/run/rewind.ts";
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

describe("undoing the undo: a withdrawal can be brought back", () => {
  test("what was taken back is INSPECTABLE — the ledger reaches a surface", async () => {
    // The rows were never deleted and the event named them, and none of that
    // is worth anything while no read can reach it. This is that read.
    const ids = await newConversation("restore-inspectable");
    await sendTurn(ids, "iota one", "iota answer");
    const rows = await storedMessages(ids.chatId);

    expect((await withdrawn(ids.chatId)).stretches, "nothing is withdrawn yet").toEqual([]);

    const { data } = await rewind(ids.chatId, rows[0]!.id, "at");
    const listed = await withdrawn(ids.chatId);
    expect(listed.status).toBe(200);
    expect(listed.stretches).toHaveLength(1);
    const stretch = listed.stretches[0]!;
    expect(stretch.eventId).toBe(data.eventId);
    expect(stretch.anchorMessageId).toBe(rows[0]!.id);
    expect(stretch.messageIds).toEqual(data.discardedMessageIds);
    expect(stretch.restored).toBe(false);
  }, 30000);

  test("restoring puts the turns back into what the model is shown", async () => {
    const ids = await newConversation("restore-reaches-provider");
    await sendTurn(ids, "kappa one", "kappa answer");
    const rows = await storedMessages(ids.chatId);
    const { data } = await rewind(ids.chatId, rows[0]!.id, "at");

    // Withdrawn: the model no longer sees the stretch.
    const during = await sendTurn(ids, "kappa two", "kappa two answer");
    expect(pairs(during).join("\n")).not.toContain("kappa one");

    const res = await restore(ids.chatId, data.eventId as string);
    expect(res.status).toBe(200);
    expect((res.body as { data: { restored: number } }).data.restored).toBe(
      (data.discardedMessageIds as string[]).length,
    );

    // Brought back: the same turns reach the provider again.
    const after = await sendTurn(ids, "kappa three", "kappa three answer");
    expect(pairs(after).join("\n")).toContain("kappa one");
    expect(pairs(after).join("\n")).toContain("kappa answer");
    // …and the transcript stops flagging them.
    const restoredRows = await storedMessages(ids.chatId);
    for (const id of data.discardedMessageIds as string[]) {
      expect(restoredRows.find((m) => m.id === id)?.discarded).toBeUndefined();
    }
  }, 40000);

  test("the withdrawal STAYS in the record after it is undone", async () => {
    // A restore is an append, not an erasure — the same rule the rewind
    // itself obeys. The stretch is still listed; it is listed as restored.
    const ids = await newConversation("restore-keeps-the-record");
    await sendTurn(ids, "lambda one", "lambda answer");
    const rows = await storedMessages(ids.chatId);
    const { data } = await rewind(ids.chatId, rows[0]!.id, "at");
    await restore(ids.chatId, data.eventId as string);

    const listed = await withdrawn(ids.chatId);
    expect(listed.stretches).toHaveLength(1);
    expect(listed.stretches[0]!.restored).toBe(true);
    expect(listed.stretches[0]!.eventId).toBe(data.eventId);
  }, 30000);

  test("the withdrawal and its undo each PERSIST a row in the transcript — the pair survives a reload (UIE-039)", async () => {
    // The record's two halves, as the conversation surface reads them. The
    // rewind's row says the stretch was taken back and names the door; the
    // restore's row says it was brought back. Without them a reloaded
    // reader finds withdrawn turns gone from the flow (they do not replay)
    // with NOTHING saying they were ever there or ever came back — the
    // same hole the withdrawal itself was filed for, one undo later.
    const ids = await newConversation("restore-pair-persists");
    await sendTurn(ids, "omicron one", "omicron answer");
    const rows = await storedMessages(ids.chatId);
    const { data } = await rewind(ids.chatId, rows[0]!.id, "at");

    const takenBack = await storedMessages(ids.chatId);
    type Row = { id: string; role: string; content: string; metadata?: { eventKind?: string; timelineEventId?: string } };
    const rewindRow = (takenBack as Row[]).find(
      (m) => m.role === "event" && m.content.includes("taken back from here"),
    );
    expect(rewindRow, "the withdrawal must persist its own row in the transcript").toBeDefined();
    expect(rewindRow!.content).toContain("2 messages taken back");
    expect(rewindRow!.content).toContain("restore from here brings them back");
    // The row IS the recorded withdrawal: its ledger address is the very
    // eventId the `restore from here` verb passes back through the door.
    expect(rewindRow!.metadata?.eventKind).toBe("rewind");
    expect(rewindRow!.metadata?.timelineEventId).toBe(data.eventId);

    const res = await restore(ids.chatId, data.eventId as string);
    const restoredEventId = (res.body as { data: { eventId: string } }).data.eventId;

    const broughtBack = await storedMessages(ids.chatId);
    const restoreRow = (broughtBack as Row[]).find(
      (m) => m.role === "event" && m.content.includes("brought back"),
    );
    expect(restoreRow, "the undo must persist its own row too — the pair reads honestly").toBeDefined();
    expect(restoreRow!.content).toContain("the withdrawal stays in the record");
    expect(restoreRow!.metadata?.eventKind).toBe("restore");
    expect(restoreRow!.metadata?.timelineEventId).toBe(restoredEventId);
    // Both halves stand: the rewind's row was not edited or erased by the
    // undo — the record keeps BOTH facts, in order.
    expect(broughtBack.find((m) => m.id === rewindRow!.id)?.content).toContain("taken back");
  }, 30000);

  test("a run's MEMORY comes back too — not half an undo", async () => {
    // The rewind withdrew the run so its stored interaction stopped being
    // recalled into the system prompt. A restore that returned the turns and
    // left the run withdrawn would leave the memory permanently unrecallable
    // with nothing saying so.
    const ids = await newConversation("restore-brings-back-memory");
    await sendTurn(ids, "mu one", "mu answer");
    const rows = await storedMessages(ids.chatId);
    const { data } = await rewind(ids.chatId, rows[0]!.id, "at");
    expect(discardedRunIdsForChat(ids.chatId, ownerUserId).size).toBeGreaterThan(0);

    await restore(ids.chatId, data.eventId as string);
    expect(
      discardedRunIdsForChat(ids.chatId, ownerUserId).size,
      "the run is still withdrawn from memory recall after the restore",
    ).toBe(0);
  }, 30000);

  test("withdraw, bring back, withdraw again — the last act is the one that stands", async () => {
    // The sequence a subtract-the-restores fold gets wrong: it ends with the
    // stretch LIVE, quietly undoing the last thing the reader did.
    const ids = await newConversation("restore-then-rewind-again");
    await sendTurn(ids, "nu one", "nu answer");
    const rows = await storedMessages(ids.chatId);

    const first = await rewind(ids.chatId, rows[0]!.id, "at");
    await restore(ids.chatId, first.data.eventId as string);
    const second = await rewind(ids.chatId, rows[0]!.id, "at");
    expect(second.status).toBe(200);
    expect((second.data.discardedMessageIds as string[]).length).toBe(
      (first.data.discardedMessageIds as string[]).length,
    );

    expect(
      discardedMessageIdsForChat(ids.chatId, ownerUserId).size,
      "the second withdrawal did not stand",
    ).toBe((first.data.discardedMessageIds as string[]).length);
    const next = await sendTurn(ids, "nu two", "nu two answer");
    expect(pairs(next).join("\n")).not.toContain("nu one");
  }, 40000);

  test("sequential regions nest — both region rows stand, and restoring the EARLIER leaves the LATER untouched", async () => {
    // THE NESTING CONTRACT (rewind.ts's fold, compose.ts's restore door).
    // Two rewinds in sequence produce two coexisting regions whose SPANS
    // nest: the later one is anchored at-or-before the earlier one, and
    // every rewind runs "from here to the end". The measured ID SETS stay
    // disjoint — planRewind skips ids an earlier rewind already withdrew —
    // so a restore of the earlier region must bring back exactly its own
    // ids and leave the later region exactly as it stood. A fold that
    // treated the spans as one, or a restore that no-oped because "a later
    // withdrawal covers this range", would strand turns the record says
    // are live. No arm pinned any of this: every existing restore arm holds
    // exactly ONE region.
    const ids = await newConversation("restore-nested-regions");
    await sendTurn(ids, "alpha prompt", "alpha answer");
    await sendTurn(ids, "beta prompt", "beta answer");
    const rows = await storedMessages(ids.chatId);
    expect(rows.filter((m) => m.role !== "event")).toHaveLength(4);

    // Region 1 — the EARLIER withdrawal: the second exchange, to the end.
    const first = await rewind(ids.chatId, rows[2]!.id, "at");
    expect(first.status).toBe(200);
    expect(first.data.discardedMessageIds).toEqual([rows[2]!.id, rows[3]!.id]);

    // Region 2 — the LATER withdrawal, anchored EARLIER: its span runs
    // from the first turn to the end and so COVERS region 1's span, while
    // the measured set names only what was still live.
    const second = await rewind(ids.chatId, rows[0]!.id, "at");
    expect(second.status).toBe(200);
    expect(second.data.discardedMessageIds).toEqual([rows[0]!.id, rows[1]!.id]);

    // BOTH region rows are visible in the row set, and both STAND through
    // it — the record's event rows are immune to any rewind's fold, so the
    // second withdrawal did not take the first region's row with it.
    type EventRow = { id: string; role: string; content: string; discarded?: boolean; metadata?: { eventKind?: string; timelineEventId?: string } };
    const afterTwo = (await storedMessages(ids.chatId)) as EventRow[];
    const regionRows = afterTwo.filter((m) => m.role === "event");
    expect(regionRows).toHaveLength(2);
    expect(
      regionRows.every((m) => m.discarded === undefined),
      "a rewind must never withdraw the record's own voice",
    ).toBe(true);
    expect(
      new Set(regionRows.map((m) => m.metadata?.timelineEventId)),
      "each region row must be its own recorded withdrawal",
    ).toEqual(new Set([first.data.eventId as string, second.data.eventId as string]));
    // Both stretches are listed; neither is restored.
    const listedTwo = await withdrawn(ids.chatId);
    expect(listedTwo.stretches).toHaveLength(2);
    expect(listedTwo.stretches.every((s) => !s.restored)).toBe(true);
    expect(discardedMessageIdsForChat(ids.chatId, ownerUserId).size).toBe(4);

    // RESTORE THE EARLIER region while the later stands.
    const res = await restore(ids.chatId, first.data.eventId as string);
    expect(res.status).toBe(200);
    expect((res.body as { data: { restoredMessageIds: string[] } }).data.restoredMessageIds)
      .toEqual([rows[2]!.id, rows[3]!.id]);

    // EXACTLY the earlier region's ids returned; the later's stay
    // withdrawn — decided PER EVENT, never by span.
    expect([...discardedMessageIdsForChat(ids.chatId, ownerUserId)]).toEqual([rows[0]!.id, rows[1]!.id]);
    const listedAfter = await withdrawn(ids.chatId);
    expect(listedAfter.stretches.find((s) => s.eventId === first.data.eventId)?.restored).toBe(true);
    expect(listedAfter.stretches.find((s) => s.eventId === second.data.eventId)?.restored).toBe(false);

    // The model's request is the same statement at the wire: the restored
    // turns reach it, the later region's do not.
    const next = await sendTurn(ids, "gamma prompt", "gamma answer");
    expect(pairs(next).join("\n")).toContain("beta prompt");
    expect(pairs(next).join("\n")).toContain("beta answer");
    expect(pairs(next).join("\n")).not.toContain("alpha prompt");
    expect(pairs(next).join("\n")).not.toContain("alpha answer");

    // THE LATER REGION'S ROW STAYS — and the restore's own pair row joined
    // it: the record holds both withdrawals and the reversal, in order.
    const afterRestore = (await storedMessages(ids.chatId)) as EventRow[];
    const laterRow = afterRestore.find(
      (m) => m.role === "event" && m.metadata?.timelineEventId === second.data.eventId,
    );
    expect(laterRow, "the later region's row must stand through the earlier's restore").toBeDefined();
    expect(laterRow!.discarded).toBeUndefined();
    expect(laterRow!.content).toContain("2 messages taken back");
    const restoreRow = afterRestore.find((m) => m.role === "event" && m.metadata?.eventKind === "restore");
    expect(restoreRow, "the restore appends its own pair row").toBeDefined();
    expect(restoreRow!.content).toContain("2 messages brought back");
  }, 40000);
});
