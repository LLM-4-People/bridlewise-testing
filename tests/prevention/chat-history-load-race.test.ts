// @vitest-environment node
/**
 * Prevention test: a SUPERSEDED chat-history load can never write the
 * shared chat stores.
 *
 * ── The defect ──
 *
 * `loadChatHistory(chatId)` did `await getChatHistory(chatId)` and then
 * wrote `setMessages` / `setTimelineRefs` / `selectModel` / `setMetrics`
 * unconditionally. Nothing checked, after the await, whether the load was
 * still the one the user was waiting for. Switch from chat A to chat B
 * while A's request is in flight and A's response lands second: chat A's
 * transcript is written into the store while the header, the model picker
 * and the timeline all say chat B. The user reads another conversation's
 * messages attributed to the one they are looking at — user-visible data
 * corruption, not a cosmetic glitch.
 *
 * The two orderings differ, and both must hold:
 *   - B starts last and answers last  → B wins (the ordinary case).
 *   - B starts last and answers FIRST → B STILL wins; A's late response
 *     must not overwrite it. This is the one that was broken.
 *
 * ── What is verified ──
 *
 * A. Behaviour (the real functions, real stores, mocked transport):
 *    A1 out-of-order responses — the newest REQUEST wins, not the newest
 *       RESPONSE.
 *    A2 a load whose chat is no longer selected writes nothing at all.
 *    A3 the ordinary in-order case still hydrates (the guard must not
 *       have been "fixed" by making every load a no-op).
 *    A4 the superseded caller still RECEIVES its data — losing the right
 *       to write is not the same as failing.
 *    A5 two loads for the SAME chat share ONE request, so the same-chat
 *       interleaving the generation counter used to arbitrate cannot occur
 *       at all (DESIGN-PERFORMANCE §6 item 1 — the measured defect was the
 *       34,665ms history read being issued TWICE against a 30,000ms
 *       timeout). Dedup narrows what the generation gate has to arbitrate;
 *       it does not replace it — A1/A2/A4 and B1 still exercise it.
 *    A6 that dedup is keyed per chat and released when the read settles —
 *       it is a request-level join, never a cache.
 * B. The same guarantee for the timeline lane (`queryTimeline` /
 *    `loadMoreTimeline`) — the sibling functions with the identical shape.
 * C. Structure: the store writes live inside the callback only
 *    `loadLatestOnly` can invoke, and that callback is synchronous, so
 *    there is no suspension point between the currency check and the
 *    writes. A late write is impossible, not merely unlikely.
 *
 * ── Mutation-verified ──
 * Reverting `readChatHistory` to write the stores directly after the
 * await makes A1 + A2 + C FAIL. Making `loadLatestOnly` skip its
 * generation check makes A1 FAIL. Making it skip the `isStillCurrent`
 * check makes A2 FAIL. Making `applyToStores` async (reintroducing a
 * suspension point) makes C FAIL. Removing the `inFlightChatHistory`
 * join (calling `readChatHistory` straight from `loadChatHistory`) makes
 * A5 + C1b FAIL. Keying the dedup map on a constant instead of the chat
 * id, or never deleting the entry, makes A6 FAIL.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

import { loadChatHistory, queryTimeline, listChats } from "../../src/client";
import { selectChat, currentChatId, resetChats, projectChatsFor } from "../../src/state/chats";
import { messages, clearMessages } from "../../src/state/chat-messages";
import { timelineRefs } from "../../src/state/timeline-refs";
import { timelineResults } from "../../src/state/timeline-query";
import { read, stripCommentsOnly } from "../helpers/source-scan.ts";
import { wholeConversationPage } from "../helpers/history-page.ts";

import { modulePathMatching } from "../helpers/module-resolver.ts";
const originalFetch = globalThis.fetch;

/** A minimal but SHAPE-COMPLETE chat-history payload for `chatId`. */
function historyFor(chatId: string): unknown {
  return {
    chat: {
      id: chatId,
      projectId: "p1",
      title: `title-${chatId}`,
      modelId: `model-${chatId}`,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    },
    messages: [
      {
        id: `msg-${chatId}`,
        chatId,
        role: "user",
        content: `content-of-${chatId}`,
        createdAt: "2024-01-01T00:00:00.000Z",
        runId: null,
        metadata: null,
      },
    ],
    toolCalls: [],
    metricsSnapshots: [],
    timelineRefs: [],
    page: wholeConversationPage(1),
  };
}

/**
 * Route each request to a deferred promise the test resolves by hand, so
 * response ORDER is controlled independently of request ORDER. Requests are
 * settled by their index in the order they were issued — two loads for the
 * SAME chat are therefore separately addressable, which is exactly the case
 * the chat-identity gate cannot help with.
 */
function deferredFetch(): {
  settleNth: (index: number, payload: unknown) => void;
  count: () => number;
} {
  const waiting: ((payload: unknown) => void)[] = [];
  globalThis.fetch = vi.fn(() =>
    new Promise((resolve) => {
      waiting.push((payload: unknown) => {
        resolve({ ok: true, status: 200, json: async () => payload } as Response);
      });
    }),
  ) as unknown as typeof fetch;
  return {
    settleNth: (index, payload) => {
      const resolver = waiting[index];
      if (resolver === undefined) {
        throw new Error(`no request #${index} was issued (issued: ${waiting.length})`);
      }
      resolver(payload);
    },
    count: () => waiting.length,
  };
}

/** Let queued microtasks (the awaits inside the client) run to completion. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

beforeEach(() => {
  clearMessages();
  resetChats();
  timelineRefs.set([]);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("A. loadChatHistory — the newest REQUEST wins, whatever the response order", () => {
  test("A1 chat A's late response does not overwrite chat B's transcript", async () => {
    const net = deferredFetch();

    selectChat("A");
    const loadA = loadChatHistory("A");
    selectChat("B");
    const loadB = loadChatHistory("B");

    // The out-of-order case: B (the NEWER request, #1) answers first...
    net.settleNth(1, historyFor("B"));
    await flush();
    expect(
      messages.get().map((m) => m.content),
      "B's own response must hydrate the store",
    ).toEqual(["content-of-B"]);

    // ...then A (the SUPERSEDED request, #0) answers. This is the write
    // that used to corrupt the transcript.
    net.settleNth(0, historyFor("A"));
    await flush();

    expect(
      messages.get().map((m) => m.content),
      "chat A's superseded response must NOT be written under chat B",
    ).toEqual(["content-of-B"]);
    expect(currentChatId.get()).toBe("B");
    await Promise.all([loadA, loadB]);
  });

  test("A2 a load whose chat is no longer selected writes nothing", async () => {
    const net = deferredFetch();

    selectChat("A");
    const loadA = loadChatHistory("A");
    // The user deselects the chat (e.g. the chat was deleted, or the route
    // left the chat view) — no newer load exists to bump the generation, so
    // the identity gate is the only thing standing between a stale response
    // and the store.
    selectChat(null);

    net.settleNth(0, historyFor("A"));
    await flush();

    expect(
      messages.get(),
      "no chat is selected, so nothing may be hydrated",
    ).toEqual([]);
    await loadA;
  });

  test("A3 the ordinary in-order load still hydrates (the guard is not a blanket no-op)", async () => {
    const net = deferredFetch();
    selectChat("A");
    const loadA = loadChatHistory("A");
    net.settleNth(0, historyFor("A"));
    await flush();
    expect(messages.get().map((m) => m.content)).toEqual(["content-of-A"]);
    await loadA;
  });

  test("A4 the superseded caller still receives its own data (it loses the write, not the read)", async () => {
    const net = deferredFetch();
    selectChat("A");
    const loadA = loadChatHistory("A");
    selectChat("B");
    const loadB = loadChatHistory("B");
    net.settleNth(1, historyFor("B"));
    net.settleNth(0, historyFor("A"));
    const [a, b] = await Promise.all([loadA, loadB]);
    expect(a.chat.id, "the superseded load resolves with the data it asked for").toBe("A");
    expect(b.chat.id).toBe("B");
  });

  test("A5 two loads for the SAME chat share ONE request — the interleaving is now unreachable", async () => {
    // WHAT CHANGED, AND WHY THIS IS STRONGER THAN WHAT IT REPLACES.
    //
    // This case used to issue two requests for the same chat and prove that
    // the OLDER response could not overwrite the newer one — the generation
    // counter was the only thing distinguishing them, because the
    // chat-identity gate is useless when both loads name the selected chat.
    //
    // `loadChatHistory` now deduplicates by chat id at the REQUEST level
    // (DESIGN-PERFORMANCE §6 item 1): a caller that arrives while a read for
    // the same chat is in flight JOINS it. So there is no older response and
    // no newer one — there is one response, delivered to both callers. The
    // property the old assertion protected ("a stale same-chat response can
    // never land after a fresh one") now holds by construction rather than by
    // arithmetic, which is the direction a guard is allowed to move.
    //
    // The generation gate is NOT retired by this and is still under test:
    // A1/A2/A4 exercise it across chats and B1 across the timeline lane.
    // Dedup only removes the same-chat pair; every other race still needs it.
    const net = deferredFetch();
    selectChat("A");
    const first = loadChatHistory("A");
    const second = loadChatHistory("A");
    expect(
      net.count(),
      "a second load for the SAME chat must not issue a second request — the measured " +
        "defect was the 34.7s history read firing twice against a 30s timeout",
    ).toBe(1);

    const payload = historyFor("A") as { messages: { content: string }[] };
    payload.messages[0]!.content = "the one response";
    net.settleNth(0, payload);
    const [a, b] = await Promise.all([first, second]);
    expect(a, "both callers receive the same read").toBe(b);
    expect(messages.get().map((m) => m.content)).toEqual(["the one response"]);
  });

  test("A6 dedup is per-chat and ends when the read settles (it is not a cache)", async () => {
    // Two guards in one, because both directions of a dedup map are how it
    // goes wrong: keyed too coarsely it drops a DIFFERENT chat's read; held
    // too long it becomes an unrequested cache that never re-reads.
    const net = deferredFetch();
    selectChat("A");
    const a = loadChatHistory("A");
    const b = loadChatHistory("B");
    expect(net.count(), "a different chat must still issue its own request").toBe(2);
    net.settleNth(0, historyFor("A"));
    net.settleNth(1, historyFor("B"));
    await Promise.all([a, b]);

    const again = loadChatHistory("A");
    expect(net.count(), "a load AFTER the first settled must issue a fresh request").toBe(3);
    net.settleNth(2, historyFor("A"));
    await again;
  });
});

describe("B. the timeline lane has the same guarantee (the sibling with the same shape)", () => {
  test("B1 a superseded timeline query does not replace a newer query's results", async () => {
    const net = deferredFetch();
    const page = (id: string) => ({
      events: [{ eventId: `evt-${id}`, eventType: id, timestamp: "2024-01-01T00:00:00.000Z" }],
      total: 1,
      hasMore: false,
      nextCursor: null,
    });

    const first = queryTimeline({ limit: 10, eventType: "first" } as never);
    const second = queryTimeline({ limit: 10, eventType: "second" } as never);
    expect(net.count(), "both queries hit the transport").toBe(2);

    net.settleNth(1, page("second"));
    await flush();
    net.settleNth(0, page("first"));
    await flush();

    expect(
      timelineResults.get().events.map((e) => e.eventId),
      "the superseded query must not overwrite the newer one's page",
    ).toEqual(["evt-second"]);
    await Promise.all([first, second]);
  });
});

describe("C. the write path is structurally gated, not conditionally gated", () => {
  const CLIENT = stripCommentsOnly(read(modulePathMatching("src/client.ts")));

  test("C1 the history read routes its store writes through loadLatestOnly", () => {
    // `readChatHistory` is the body; `loadChatHistory` is the deduplicating
    // door onto it (A5). The store writes live in the body, so that is what
    // this scan holds to the gate.
    const start = CLIENT.indexOf("function readChatHistory");
    expect(start, "readChatHistory must exist in src/client.ts").toBeGreaterThan(-1);
    const body = CLIENT.slice(start, CLIENT.indexOf("\n}\n", start));
    expect(
      body,
      "loadChatHistory must hand its store writes to loadLatestOnly — a bare `await` " +
        "followed by direct store writes is the defect this test exists for",
    ).toContain("loadLatestOnly(");
    // The awaited fetch must be INSIDE the gate, not before it: a top-level
    // `const x = await getChatHistory(...)` in the function body means the
    // writes that follow are ungated again.
    expect(
      body,
      "loadChatHistory must not await the history itself — the fetch belongs to the gate",
    ).not.toMatch(/\bawait\s+getChatHistory\s*\(/);
    for (const writer of ["setMessages", "setTimelineRefs", "selectModel", "setMetrics"]) {
      // Every store write must be reachable only through the gate's
      // callback, which lives inside the loadLatestOnly( ... ) call.
      const gateStart = body.indexOf("loadLatestOnly(");
      const idx = body.indexOf(writer);
      if (idx === -1) continue; // written via a helper (e.g. hydrateChatFromHistory)
      expect(
        idx,
        `${writer} must appear inside the loadLatestOnly gate, not before it`,
      ).toBeGreaterThan(gateStart);
    }
  });

  test("C1b loadChatHistory is a door onto the gated body, and writes no stores itself", () => {
    const start = CLIENT.indexOf("export function loadChatHistory");
    expect(start, "loadChatHistory must exist in src/client.ts").toBeGreaterThan(-1);
    const body = CLIENT.slice(start, CLIENT.indexOf("\n}\n", start));
    expect(
      body,
      "loadChatHistory must delegate to the gated readChatHistory — a second, ungated " +
        "history path is exactly the defect this file exists for",
    ).toContain("readChatHistory(chatId)");
    expect(
      body,
      "the dedup map is the whole point of the door: without it the same chat's read " +
        "fires once per caller",
    ).toContain("inFlightChatHistory");
    for (const writer of ["setMessages", "setTimelineRefs", "selectModel", "setMetrics"]) {
      expect(body, `${writer} must not be reachable outside the gate`).not.toContain(writer);
    }
  });

  test("C2 the gate checks currency AND context identity before applying", () => {
    const start = CLIENT.indexOf("async function loadLatestOnly");
    expect(start, "the loadLatestOnly gate must exist").toBeGreaterThan(-1);
    const body = CLIENT.slice(start, CLIENT.indexOf("\n}\n", start));
    expect(body, "the gate must compare the load's generation against the lane's current one")
      .toMatch(/laneGenerations\.get\(lane\)\s*!==\s*generation/);
    expect(body, "the gate must honour an isStillCurrent predicate when given one")
      .toContain("isStillCurrent");
    expect(body, "the gate must only call applyToStores after its checks")
      .toContain("applyToStores(value)");
  });

  test("C3 applyToStores is synchronous, so no suspension point exists between check and write", () => {
    const start = CLIENT.indexOf("async function loadLatestOnly");
    const body = CLIENT.slice(start, CLIENT.indexOf("\n}\n", start));
    // A `void`-returning callback cannot be meaningfully awaited, and the
    // gate does not await it — so the currency check and every store write
    // run in ONE uninterrupted synchronous block. If the signature ever
    // becomes Promise-returning, or an `await` appears after the checks,
    // the window reopens.
    expect(
      body,
      "applyToStores must be declared as returning void (a Promise-returning " +
        "callback would reopen the interleaving window)",
    ).toMatch(/applyToStores:\s*\(value:\s*T\)\s*=>\s*void/);
    const afterCheck = body.slice(body.indexOf("laneGenerations.get(lane) !== generation"));
    expect(
      afterCheck,
      "no await may appear between the currency check and the store writes",
    ).not.toMatch(/\bawait\b/);
  });

  test("C4 the sibling load* / query functions share the gate (no second mechanism)", () => {
    for (const fn of ["queryTimeline", "loadMoreTimeline"]) {
      const start = CLIENT.indexOf(`export async function ${fn}`);
      expect(start, `${fn} must exist`).toBeGreaterThan(-1);
      const body = CLIENT.slice(start, CLIENT.indexOf("\n}\n", start));
      expect(
        body,
        `${fn} writes shared timeline state after an await — it must go through the same gate`,
      ).toContain("loadLatestOnly(");
    }
  });
});


describe("project list ingestion uses the same latest-load and reset boundary", () => {
  test("independent project lanes retain both answers, same-project supersession keeps the newest request", async () => {
    const net = deferredFetch();
    const row = (id: string, projectId: string) => ({ id, projectId, title: id, createdAt: "t", updatedAt: "t", modelId: null, pinned: false });
    const old = listChats("__proto__");
    const other = listChats("constructor");
    const latest = listChats("__proto__");
    net.settleNth(2, [row("latest", "__proto__")]);
    net.settleNth(1, [row("other", "constructor")]);
    await Promise.all([latest, other]);
    net.settleNth(0, [row("superseded", "__proto__")]);
    expect((await old)[0]!.id).toBe("superseded");
    expect(projectChatsFor("__proto__")[0]!.id).toBe("latest");
    expect(projectChatsFor("constructor")[0]!.id).toBe("other");
  });

  test("a response from before reset still reaches its caller but cannot repopulate shared chats", async () => {
    const net = deferredFetch();
    const pending = listChats("previous-user-project");
    resetChats();
    const row = { id: "private", projectId: "previous-user-project", title: "prior user", createdAt: "t", updatedAt: "t", modelId: null, pinned: false };
    net.settleNth(0, [row]);
    expect(await pending).toEqual([row]);
    expect(projectChatsFor(row.projectId)).toEqual([]);
  });
});
