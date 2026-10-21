// @vitest-environment node
/**
 * Rewind suite split: rewind-record-and-addressing.
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
  discardedRunIdsForChat,
} from "../../server/run/rewind.ts";
import { APPEND_ONLY_TRIGGERS } from "../../engine/src/timeline/timeline-schema.ts";
import { serverConfig } from "../../server/kernel/config.ts";

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

describe("a rewind is a recorded event, not an erasure", () => {
  test("the ledger holds the rewind, naming the anchor and every id withdrawn", async () => {
    const ids = await newConversation("rewind-is-recorded");
    await sendTurn(ids, "recorded prompt", "recorded answer");
    const stored = await storedMessages(ids.chatId);
    const modelTurn = stored.find((m) => m.role === "assistant")!;
    const userTurn = stored.find((m) => m.role === "user")!;

    const { data } = await rewind(ids.chatId, modelTurn.id, "causing-prompt");

    // Read back through the REAL query port, from the real ledger the suite
    // points at a per-worker temp file.
    const events = getTimelineQuery().byEventType("rollback", { limit: 500 }).events;
    const mine = events.filter((e) => e.description.includes(ids.chatId));
    expect(mine.length).toBe(1);
    const doc = mine[0]!.documents.find((d) => d.name === "rewind");
    expect(doc).toBeDefined();
    const payload = JSON.parse(doc!.contentJson!) as {
      chatId: string;
      anchorMessageId: string;
      discardedMessageIds: string[];
      mode: string;
    };
    expect(payload.chatId).toBe(ids.chatId);
    // The anchor is the USER turn, not the model turn the verb named — the
    // resolution the server performed is itself part of the record.
    expect(payload.anchorMessageId).toBe(userTurn.id);
    expect(payload.discardedMessageIds).toEqual([userTurn.id, modelTurn.id]);
    expect(payload.mode).toBe("causing-prompt");
    expect(mine[0]!.outcome).toBe("succeeded");
    expect(data.eventId).toBe(mine[0]!.eventId);
  }, 20000);

  test("a withdrawn turn is NOT silently gone from the record", async () => {
    const ids = await newConversation("withdrawn-not-erased");
    await sendTurn(ids, "the withdrawn words", "the withdrawn reply");
    const before = await storedMessages(ids.chatId);
    const modelTurn = before.find((m) => m.role === "assistant")!;

    await rewind(ids.chatId, modelTurn.id, "causing-prompt");

    const after = await storedMessages(ids.chatId);
    // Same rows, same content — plus the withdrawal's own record-fact, the
    // one row a rewind APPENDS (UIE-039). Nothing that existed before was
    // deleted.
    const beforeIds = before.map((m) => m.id);
    for (const id of beforeIds) {
      expect(after.find((m) => m.id === id), `row ${id} was deleted by the rewind`).toBeDefined();
    }
    expect(after.find((m) => m.id === modelTurn.id)!.content).toBe("the withdrawn reply");
    // And every one of them SAYS it was withdrawn — a reader who cannot tell
    // "taken back" from "never happened" has been shown a hole. The one row
    // NOT flagged is the rewind's own event row: a fact about the record,
    // never a turn, so it is not withdrawn by anything.
    for (const row of before) {
      expect(after.find((m) => m.id === row.id)!.discarded).toBe(true);
    }
    const factRow = after.find((m) => m.role === "event");
    expect(factRow, "the rewind appends its own record-fact row").toBeDefined();
    expect(factRow!.discarded).toBeUndefined();
    expect(factRow!.content).toContain("2 messages taken back from here");
  }, 20000);

  test("a live turn is not marked withdrawn — the flag means something", async () => {
    // The mirror of the test above. Without this, a mapper that marked EVERY
    // message discarded would pass the one above and be catastrophically
    // wrong.
    const ids = await newConversation("live-turns-are-not-flagged");
    await sendTurn(ids, "still here", "still here too");
    const rows = await storedMessages(ids.chatId);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((m) => m.discarded === true)).toBe(false);
  }, 20000);
});

describe("the rewind point may sit in a page that was never loaded", () => {
  test("retry resolves the causing prompt over the WHOLE conversation, not the loaded page", async () => {
    const ids = await newConversation("rewind-across-pages");
    await sendTurn(ids, "older prompt", "older answer");
    await sendTurn(ids, "newer prompt", "newer answer");

    // The conversation opens at its TAIL with a cursor (commit daf44ee). Ask
    // for the narrowest page there is: one message.
    const tail = await api("GET", `/api/chats/${ids.chatId}/history?limit=1`);
    expect(tail.status).toBe(200);
    const page = tail.body as { messages: Array<{ id: string; content: string }>; page: { hasOlder: boolean } };
    expect(page.page.hasOlder).toBe(true);
    expect(page.messages).toHaveLength(1);
    const loadedTurn = page.messages[0]!;
    expect(loadedTurn.content).toBe("newer answer");
    // THE SETUP THAT MAKES THIS A REAL TEST: the prompt that caused the only
    // loaded turn is NOT in the loaded page. The old client-side lookup
    // (`Flow.svelte::userPromptBefore`, an in-memory beat scan) returned null
    // here and the verb rendered "none is recorded before this turn" — a
    // sentence about the record that was false about the record.
    expect(page.messages.some((m) => m.content === "newer prompt")).toBe(false);

    const { status, data } = await rewind(ids.chatId, loadedTurn.id, "causing-prompt");
    expect(status).toBe(200);
    expect(data.promptForRerun).toBe("newer prompt");

    const retried = await sendTurn(ids, data.promptForRerun as string, "better answer");
    expect(pairs(retried)).toEqual([
      "user: older prompt",
      "assistant: older answer",
      "user: newer prompt",
    ]);
  }, 30000);

  test("an older page carries the same withdrawal marks the tail does", async () => {
    const ids = await newConversation("older-page-marks");
    await sendTurn(ids, "page-a prompt", "page-a answer");
    await sendTurn(ids, "page-b prompt", "page-b answer");
    const stored = await storedMessages(ids.chatId);
    const first = stored[0]!;

    // Withdraw the whole conversation from its first message.
    const { data } = await rewind(ids.chatId, first.id, "at");
    expect(data.discarded).toBe(4);

    const tail = await api("GET", `/api/chats/${ids.chatId}/history?limit=1`);
    const cursor = (tail.body as { page: { olderCursor: string | null } }).page.olderCursor;
    expect(cursor).not.toBeNull();
    const older = await api(
      "GET",
      `/api/chats/${ids.chatId}/history/older?before=${encodeURIComponent(cursor!)}`,
    );
    expect(older.status).toBe(200);
    const olderRows = (older.body as { messages: Array<{ discarded?: boolean }> }).messages;
    expect(olderRows.length).toBeGreaterThan(0);
    // The fold is over the CONVERSATION, not over the page. A reader scrolling
    // back into a rewound stretch must see it as rewound.
    expect(olderRows.every((m) => m.discarded === true)).toBe(true);
  }, 30000);
});

describe("the door refuses what it cannot address", () => {
  test("a message this chat does not hold is refused, not rounded to the nearest one", async () => {
    const ids = await newConversation("unknown-anchor");
    await sendTurn(ids, "only turn", "only answer");
    const res = await rewind(ids.chatId, "msg-that-does-not-exist", "at");
    expect(res.status).toBe(404);
  }, 20000);

  test("the fold is scoped to the acting user, not just the conversation", async () => {
    // THE LEDGER IS ONE FILE shared by every conversation on this server, and
    // the fold is a scan over it. The chat id alone is the outer lock; this
    // asserts the inner one, at the level it lives at, because the block
    // action's ownership check makes it unreachable from the wire — and an
    // untestable lock is one nobody notices being removed. (It was: this case
    // exists because a mutation that dropped the user comparison survived the
    // whole suite.)
    const ids = await newConversation("fold-user-scope");
    await sendTurn(ids, "scoped prompt", "scoped answer");
    const modelTurn = (await storedMessages(ids.chatId)).find((m) => m.role === "assistant")!;
    await rewind(ids.chatId, modelTurn.id, "causing-prompt");

    const owner = ownerUserId;
    const outsider = createTestUser(db, `fold-outsider-${Date.now()}`);
    expect(discardedMessageIdsForChat(ids.chatId, owner).size).toBe(2);
    expect(discardedRunIdsForChat(ids.chatId, owner).size).toBe(1);
    // Same conversation id, different reader: nothing is withdrawn for them.
    expect(discardedMessageIdsForChat(ids.chatId, outsider.userId).size).toBe(0);
    expect(discardedRunIdsForChat(ids.chatId, outsider.userId).size).toBe(0);
  }, 20000);

  test("another user cannot rewind this conversation", async () => {
    const ids = await newConversation("rewind-scoping");
    await sendTurn(ids, "mine", "mine too");
    const modelTurn = (await storedMessages(ids.chatId)).find((m) => m.role === "assistant")!;

    const outsider = createTestUser(db, "rewind-outsider");
    const res = await rewind(ids.chatId, modelTurn.id, "causing-prompt", outsider.cookie);
    expect(res.status).toBe(404);

    // And the conversation is untouched — a refused rewind withdrew nothing.
    const after = await storedMessages(ids.chatId);
    expect(after.some((m) => m.discarded === true)).toBe(false);
  }, 20000);
});

// ───────────────────────────────────────────────────────────────────────────
// HOSTILE USE — the cases nobody types on purpose
//
// Everything above asks whether the verb WORKS. This half asks what it does
// when it is misused, raced, aimed at somebody else's conversation, or handed
// something that is not a message id at all. A door that only behaves for its
// intended input is a door with a second, undescribed behaviour.
// ───────────────────────────────────────────────────────────────────────────

describe("hostile: the extremes of the conversation", () => {
  test("rewinding to the FIRST message withdraws everything and leaves an empty request", async () => {
    const ids = await newConversation("hostile-first");
    await sendTurn(ids, "alpha one", "alpha answer");
    await sendTurn(ids, "beta two", "beta answer");

    const first = (await storedMessages(ids.chatId))[0]!;
    const res = await rewind(ids.chatId, first.id, "at");
    expect(res.status).toBe(200);
    expect((res.data.discardedMessageIds as string[]).length).toBe(4);

    // The next request carries ONLY the new prompt. An off-by-one at the
    // anchor would leave the very first turn in — the one place "the anchor
    // is inclusive" is easiest to get wrong and hardest to notice.
    const next = await sendTurn(ids, "starting over", "fine");
    expect(pairs(next)).toEqual(["user: starting over"]);
  }, 30000);

  test("rewinding to the LAST message withdraws exactly that one", async () => {
    const ids = await newConversation("hostile-last");
    await sendTurn(ids, "gamma one", "gamma answer");
    const rows = await storedMessages(ids.chatId);
    const last = rows[rows.length - 1]!;

    const res = await rewind(ids.chatId, last.id, "at");
    expect(res.status).toBe(200);
    expect(res.data.discardedMessageIds).toEqual([last.id]);
    // The prompt that caused it is still live, because `at` means AT. The
    // one other live row is the withdrawal's OWN record-fact (a role
    // "event" row the rewind appends — UIE-039), which is the record's
    // voice about what just happened, not a turn: it stays live through
    // any rewind and never reaches the model.
    const after = await storedMessages(ids.chatId);
    expect(after.filter((m) => m.discarded !== true && m.role !== "event").map((m) => m.content))
      .toEqual(["gamma one"]);
    expect(
      after.filter((m) => m.discarded !== true && m.role === "event").map((m) => m.content).join(""),
    ).toContain("1 messages taken back from here");
  }, 30000);

  test("a conversation holding nothing is refused, not answered with an empty rewind", async () => {
    // There is no anchor to name, so every id is unknown. The failure mode
    // this rules out is a door that returns `{ discarded: 0 }` and a 200 — a
    // success report for an operation that did not happen.
    const ids = await newConversation("hostile-empty");
    const res = await rewind(ids.chatId, "any-id-at-all", "at");
    expect(res.status).toBe(404);
  }, 20000);
});

describe("hostile: aiming a rewind somewhere it does not belong", () => {
  test("an anchor from ANOTHER conversation is refused, and neither conversation moves", async () => {
    // The cross-conversation leak. Both chats belong to the SAME user, so the
    // ownership check passes and only the chat scoping can refuse this —
    // which is exactly why it needs its own case.
    const victim = await newConversation("hostile-victim");
    const attacker = await newConversation("hostile-attacker");
    await sendTurn(victim, "victim prompt", "victim answer");
    await sendTurn(attacker, "attacker prompt", "attacker answer");

    const victimRows = await storedMessages(victim.chatId);
    const res = await rewind(attacker.chatId, victimRows[0]!.id, "at");
    expect(res.status).toBe(404);

    expect((await storedMessages(victim.chatId)).some((m) => m.discarded === true)).toBe(false);
    expect((await storedMessages(attacker.chatId)).some((m) => m.discarded === true)).toBe(false);
  }, 30000);
});

describe("hostile: the same rewind, twice and at once", () => {
  test("rewinding twice to the same anchor withdraws nothing the second time", async () => {
    // Idempotence is not decoration here: the event records a MEASURED set,
    // and a second event re-listing the same ids would double every count a
    // reader is shown about what was withdrawn.
    const ids = await newConversation("hostile-twice");
    await sendTurn(ids, "delta one", "delta answer");
    const anchor = (await storedMessages(ids.chatId))[0]!;

    const first = await rewind(ids.chatId, anchor.id, "at");
    expect((first.data.discardedMessageIds as string[]).length).toBe(2);
    const second = await rewind(ids.chatId, anchor.id, "at");
    expect(second.status).toBe(200);
    expect(second.data.discardedMessageIds).toEqual([]);
    expect(second.data.discarded).toBe(0);

    // …and the fold is not double-counted.
    expect(discardedMessageIdsForChat(ids.chatId, ownerUserId).size).toBe(2);
  }, 30000);

  test("two rewinds issued at once do not name the same turn between them", async () => {
    const ids = await newConversation("hostile-concurrent");
    await sendTurn(ids, "epsilon one", "epsilon answer");
    await sendTurn(ids, "epsilon two", "epsilon answer two");
    const rows = await storedMessages(ids.chatId);

    const [a, b] = await Promise.all([
      rewind(ids.chatId, rows[0]!.id, "at"),
      rewind(ids.chatId, rows[2]!.id, "at"),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    // Whatever order they landed in, the UNION is every row and no row is
    // named twice — a ledger that could say a turn was withdrawn twice is one
    // whose counts do not add up for anybody reading them back.
    const named = [
      ...(a.data.discardedMessageIds as string[]),
      ...(b.data.discardedMessageIds as string[]),
    ];
    expect(new Set(named).size, "a turn was named by both rewinds").toBe(named.length);
    expect(new Set(named)).toEqual(new Set(rows.map((r) => r.id)));
    expect(discardedMessageIdsForChat(ids.chatId, ownerUserId).size).toBe(4);
  }, 30000);
});

describe("hostile: a rewind issued while the run is still streaming", () => {
  test("the rewind lands, and the turn the run is producing is not left half-withdrawn", async () => {
    // The reader can press `rewind here` at any moment, including while the
    // model is mid-answer. The failure this rules out is a torn conversation:
    // a rewind whose measured set is taken before the run appends its
    // assistant row leaves that row OUTSIDE the withdrawal, so the abandoned
    // answer survives as accepted history with nothing marking it.
    const ids = await newConversation("hostile-mid-stream");
    await sendTurn(ids, "zeta first", "zeta first answer");
    const anchor = (await storedMessages(ids.chatId))[0]!;

    harness.provider.reply = "an answer nobody waited for";
    const start = await api("POST", "/api/run/start", {
      projectId: ids.projectId,
      prompt: "zeta second",
      chatId: ids.chatId,
    });
    expect(start.status).toBe(201);

    // Do NOT await the drain: the rewind is issued into a live run.
    const draining = drainRunStream((start.body as { runId: string }).runId);
    const res = await rewind(ids.chatId, anchor.id, "at");
    await draining;

    expect(res.status).toBe(200);

    // Whatever the interleaving was, the invariant is the same: every row the
    // conversation now holds is either withdrawn or live, and the rows the
    // model is next shown are exactly the live ones. Nothing may be BOTH
    // present in the request and marked withdrawn.
    const rows = await storedMessages(ids.chatId);
    const live = rows.filter((m) => m.discarded !== true && m.role !== "event").map((m) => m.content);
    const withdrawn = rows.filter((m) => m.discarded === true).map((m) => m.content);
    expect(withdrawn, "the rewind withdrew nothing at all").not.toHaveLength(0);

    const next = await sendTurn(ids, "zeta third", "zeta third answer");
    const shown = pairs(next);
    for (const gone of withdrawn) {
      expect(shown.join("\n"), `a withdrawn turn reached the model: ${gone}`).not.toContain(gone);
    }
    // The record's own voice never reaches the model either: the rewind's
    // event row is a fact about the conversation, not a turn of it.
    expect(shown.join("\n"), "a record-fact row reached the model").not.toContain("taken back");
    // …and the surviving TURNS are the ones that DID reach it, so this is
    // not passing by sending nothing. (Event rows are excluded on both
    // sides of the count: they are live in the record and absent from the
    // request, which is exactly their contract.)
    expect(shown.length).toBe(live.length + 1);
  }, 30000);
});

describe("hostile: what the door accepts as input", () => {
  test("every malformed shape is REFUSED with a 4xx — never a 500, never a silent 200", async () => {
    const ids = await newConversation("hostile-input");
    await sendTurn(ids, "input prompt", "input answer");
    const anchor = (await storedMessages(ids.chatId))[0]!;

    // Derived from the valid body's OWN fields rather than listed by hand: for
    // each field, drop it and corrupt it. A field added to the action tomorrow
    // is covered without anyone remembering to add a case for it.
    const valid: Record<string, unknown> = {
      chatId: ids.chatId,
      toMessageId: anchor.id,
      mode: "at",
    };
    const corruptions: readonly unknown[] = [null, 42, true, [], {}, ""];
    const cases: Array<{ what: string; body: unknown }> = [
      { what: "null body", body: null },
      { what: "a bare string", body: "rewind please" },
      { what: "an array", body: [] },
      { what: "an empty object", body: {} },
      { what: "an unknown extra field", body: { ...valid, sudo: true } },
      { what: "a mode nobody declared", body: { ...valid, mode: "obliterate" } },
    ];
    for (const field of Object.keys(valid)) {
      const missing = { ...valid };
      delete missing[field];
      cases.push({ what: `missing ${field}`, body: missing });
      for (const bad of corruptions) {
        cases.push({ what: `${field} = ${JSON.stringify(bad)}`, body: { ...valid, [field]: bad } });
      }
    }

    for (const c of cases) {
      const res = await api("POST", "/api/b/run.compose/rewind", c.body);
      expect(
        res.status,
        `${c.what} was not refused (${String(res.status)}: ${JSON.stringify(res.body)})`,
      ).toBeGreaterThanOrEqual(400);
      expect(res.status, `${c.what} became a server error rather than a refusal`).toBeLessThan(500);
    }

    // …and none of them withdrew anything.
    expect((await storedMessages(ids.chatId)).some((m) => m.discarded === true)).toBe(false);
  }, 60000);

  test("an enormous, astral or NUL-bearing id is refused AS AN ID, not truncated into a real one", async () => {
    // NUL bytes have twice hidden content from text tooling in this codebase,
    // so the question is not only "is it refused" but "is it refused for being
    // an unknown id": a truncation at the NUL would make `<real-id>\0junk`
    // address the real message, and the door would obey an id nobody sent.
    const ids = await newConversation("hostile-strings");
    await sendTurn(ids, "strings prompt", "strings answer");
    const anchor = (await storedMessages(ids.chatId))[0]!;

    const hostile: readonly string[] = [
      "x".repeat(100_000),
      "\u{1D518}\u{1D52B}\u{1D526}\u{1D520}\u{1D52C}\u{1D521}\u{1D522}-\u{1F70F}\u{1F70F}",
      " ",
      `${anchor.id}\u0000trailing`,
      `\u0000${anchor.id}`,
      `${anchor.id} `,
      "../../etc/passwd",
      "%00",
      "\r\nGET /admin",
      "' OR '1'='1",
    ];
    for (const id of hostile) {
      const res = await api("POST", "/api/b/run.compose/rewind", {
        chatId: ids.chatId,
        toMessageId: id,
        mode: "at",
      });
      const label = JSON.stringify(id.slice(0, 48));
      expect(res.status, `id ${label} was accepted`).toBeGreaterThanOrEqual(400);
      expect(res.status, `id ${label} crashed the door`).toBeLessThan(500);
    }
    // The real message is still live: no truncated id addressed it.
    expect((await storedMessages(ids.chatId)).some((m) => m.discarded === true)).toBe(false);
  }, 60000);
});

describe("hostile: the rewind lands MID-RUN", () => {
  test("withdrawing a model turn withdraws the memory that carries its words", async () => {
    // `rewind here` anchors on whatever beat the reader is standing on, and
    // that can be the MODEL's turn — which withdraws the answer while the
    // prompt that caused it stays live. The run is then only PARTLY withdrawn.
    //
    // The stored memory for a run is `User: …\nAssistant: …`, so the withdrawn
    // answer is inside it verbatim. A partly-withdrawn run that keeps its
    // memory therefore hands the rejected answer to the SYSTEM PROMPT of every
    // later turn — the second door, reopened for the one mode that reaches it.
    const ids = await newConversation("hostile-mid-run");
    const REJECTED = "the plimbex coefficient is measured in furlongs per candela";
    await sendTurn(ids, "what is the plimbex coefficient", REJECTED);

    const modelTurn = (await storedMessages(ids.chatId)).find((m) => m.role === "assistant")!;
    expect(modelTurn.content).toContain("plimbex");
    const res = await rewind(ids.chatId, modelTurn.id, "at");
    expect(res.status).toBe(200);

    const next = await sendTurn(ids, "what is the plimbex coefficient", "a better answer");
    expect(
      pairs(next).join("\n"),
      "the withdrawn answer came back as conversation",
    ).not.toContain(REJECTED);
    expect(
      systemOf(next),
      "the withdrawn answer came back through the memory channel",
    ).not.toContain(REJECTED);
  }, 30000);
});

describe("hostile: the ledger will not be edited", () => {
  test("a recorded rewind survives every write the storage layer declares forbidden", async () => {
    // The whole design rests on this: a rewind is safe to RECORD rather than
    // perform destructively only because the record cannot be quietly revised
    // afterwards. Asserted against the storage layer itself, on the row a real
    // rewind actually wrote, and driven off the trigger registry so a table
    // protected tomorrow is covered without this test being edited.
    const ids = await newConversation("hostile-append-only");
    await sendTurn(ids, "ledger prompt", "ledger answer");
    const anchor = (await storedMessages(ids.chatId))[0]!;
    await rewind(ids.chatId, anchor.id, "at");

    const recorded = getTimelineQuery()
      .byEventType("rollback", { limit: 500 })
      .events.find((e) => e.description.includes(ids.chatId));
    expect(recorded, "the rewind was not recorded at all").toBeDefined();

    const { DatabaseSync } = await import("node:sqlite");
    const ledger = new DatabaseSync(serverConfig.timelineDbPath);
    try {
      // The rewind's own rows must exist, or every refusal below would be a
      // refusal to touch nothing.
      const eventRows = ledger
        .prepare(`SELECT COUNT(*) AS n FROM event_log WHERE event_id = ?`)
        .get(recorded!.eventId) as { n: number };
      expect(eventRows.n, "the rewind event is not in the ledger file").toBe(1);

      expect(APPEND_ONLY_TRIGGERS.length, "no append-only triggers are declared").toBeGreaterThan(0);

      const installed = new Set(
        (
          ledger
            .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`)
            .all() as unknown as ReadonlyArray<{ name: string }>
        ).map((r) => r.name),
      );
      const rowsIn = (table: string): number =>
        (ledger.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

      let exercised = 0;
      for (const trigger of APPEND_ONLY_TRIGGERS) {
        // Declared is not installed. A trigger that never reached the file is
        // the failure this whole design would be silently missing.
        expect(
          installed.has(trigger.name),
          `${trigger.name} is declared but not installed on the ledger`,
        ).toBe(true);

        // A BEFORE trigger on an empty table never fires, so attempting the
        // write there would prove nothing and REPORT a pass. Only tables that
        // actually hold rows count as evidence.
        if (rowsIn(trigger.table) === 0) continue;
        exercised += 1;

        const sql =
          trigger.operation === "DELETE"
            ? `DELETE FROM ${trigger.table}`
            : `UPDATE ${trigger.table} SET rowid = rowid`;
        let caught: unknown = null;
        try {
          ledger.exec(sql);
        } catch (err) {
          caught = err;
        }
        expect(
          caught,
          `${trigger.table} accepted a ${trigger.operation} — the ledger is editable`,
        ).not.toBeNull();
        expect(
          String((caught as Error).message),
          `${trigger.table} refused the ${trigger.operation} for the wrong reason`,
        ).toContain("append-only");
      }
      // The rewind's own event and its document are both in there, so at
      // least those four (log/documents × update/delete) must have been real
      // attempts against real rows.
      expect(rowsIn("event_log"), "the ledger holds no events at all").toBeGreaterThan(0);
      expect(rowsIn("event_documents"), "the ledger holds no documents at all").toBeGreaterThan(0);
      expect(exercised, "no forbidden write was attempted against real rows").toBeGreaterThanOrEqual(4);
    } finally {
      ledger.close();
    }

    // The rewind still stands after every attempt.
    expect(discardedMessageIdsForChat(ids.chatId, ownerUserId).size).toBe(2);
  }, 30000);
});
