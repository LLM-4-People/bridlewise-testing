// @vitest-environment node
/**
 * TRAVELLING BACKWARDS THROUGH A CONVERSATION (DESIGN-PERFORMANCE §4).
 *
 * A conversation opens at its TAIL. Older beats arrive as the reader travels,
 * and the whole difficulty is that they arrive at the FRONT — the one place
 * every positional cursor in the flow assumes nothing ever appears.
 *
 * The failure this suite exists to prevent is silent and total: from inside a
 * `messages` subscription, a prefix insertion and a completely different
 * conversation look identical (the entry at index 0 changed), and the ingest's
 * answer to "the transcript diverged" is to rebuild the whole log. For a
 * prepend that throws away every beat, every measured height and the reader's
 * place — in order to add rows ABOVE them. Nothing would report it; the
 * conversation would simply flicker and lose its place.
 *
 * Claims:
 *   A. a prepend is a DELTA — the beats already built survive, by identity;
 *   B. the reader's own beats are NOT renumbered by rows arriving above them;
 *   C. a beat whose cause has just been loaded gets its cause;
 *   D. the transcript refuses a message it already holds;
 *   E. the height index carries its measurements across the shift;
 *   F. absence stays honest: "not loaded yet" is never rendered as "the
 *      beginning", and a FAILED page does not make older messages stop
 *      existing.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  appendMessage,
  clearMessages,
  messages,
  pendingPrepend,
  prependMessages,
  setMessages,
  type ChatMessage,
} from "../../src/state/chat-messages.ts";
import { currentChatId } from "../../src/state/chats.ts";
import { resetIngest, startIngest } from "../../src/cockpit/flow/ingest.ts";
import { beatCount, beatById, windowSlice } from "../../src/cockpit/flow/log.ts";
import { prependedCount } from "../../src/cockpit/flow/log.ts";
import { HeightIndex } from "../../src/cockpit/flow/heights.ts";
import {
  clearHistoryReach,
  historyReach,
  noteReachExtended,
  noteReachFailed,
  noteReachLoading,
  noteReachOpened,
} from "../../src/state/chat-history-reach.ts";
import { loadChatHistory, loadOlderHistory } from "../../src/client.ts";
import { partialPage, wholeConversationPage } from "../helpers/history-page.ts";
import type { Beat } from "../../src/cockpit/flow/types.ts";

const CHAT = "chat-under-test";

function allBeats(): readonly Beat[] {
  return windowSlice(0, beatCount());
}

let seq = 0;
function msg(role: ChatMessage["role"], content: string): ChatMessage {
  seq += 1;
  return { id: `m-${seq}`, role, content, timestamp: 1_700_000_000_000 + seq * 1000 };
}

/** The transcript as the tail page leaves it: two turns, already ingested. */
function openAtTail(): { user: ChatMessage; model: ChatMessage } {
  currentChatId.set(CHAT);
  const user = msg("user", "the newest question");
  const model = msg("assistant", "the newest answer");
  setMessages([user, model]);
  startIngest({ chatId: CHAT });
  return { user, model };
}

beforeEach(() => {
  seq = 0;
  currentChatId.set(null);
  clearMessages();
  clearHistoryReach();
  resetIngest();
});
afterEach(() => {
  resetIngest();
  clearMessages();
  clearHistoryReach();
  currentChatId.set(null);
});

describe("A. a page of older messages is a delta, not a reload", () => {
  test("the beats already on screen survive the prepend BY IDENTITY", () => {
    // MUTATION: delete the `pendingPrepend` consumption at the top of
    // `syncInto` and the positional divergence check below it rebuilds the
    // whole log — this fails on the identity comparison, which is exactly the
    // thing no count-based assertion would notice.
    openAtTail();
    const before = allBeats();
    expect(before).toHaveLength(2);
    const [firstBefore, secondBefore] = before;

    const added = prependMessages(CHAT, [msg("user", "older q"), msg("assistant", "older a")]);
    expect(added).toBe(2);

    const after = allBeats();
    expect(after).toHaveLength(4);
    expect(after[0]!.turn?.text).toBe("older q");
    expect(after[1]!.turn?.text).toBe("older a");
    // NOT merely equal — the SAME OBJECTS. A rebuild would produce new beats
    // with the same ids and the same text, and every count would still agree.
    expect(after[2]).toBe(firstBefore);
    expect(after[3]).toBe(secondBefore);
  });

  test("the log records HOW MANY arrived at the front, not merely that some did", () => {
    // The renderer's height index is keyed by POSITION; a boolean cannot tell
    // it how far to shift. MUTATION: make `prepended` a boolean-ish 0/1 and
    // the second page silently mis-shifts every measurement by one page.
    openAtTail();
    expect(prependedCount()).toBe(0);
    prependMessages(CHAT, [msg("user", "a"), msg("assistant", "b")]);
    expect(prependedCount()).toBe(2);
    prependMessages(CHAT, [msg("user", "c")]);
    expect(prependedCount()).toBe(3);
  });

  test("the signal is published BEFORE the transcript changes", () => {
    // A nanostores subscriber runs synchronously on `set`. Publishing the
    // delta afterwards would be one frame too late and the rebuild would
    // already have happened.
    // MUTATION: move `pendingPrepend.set(...)` below `messages.set(...)` in
    // `prependMessages` and this fails — the subscriber sees null.
    // No ingest here on purpose: the ingest is itself a subscriber, and it
    // CONSUMES the signal. What is under test is that the signal is already
    // published when the first subscriber runs — which is the only reason the
    // ingest can consume it at all.
    currentChatId.set(CHAT);
    setMessages([msg("user", "the newest question")]);
    let seenBySubscriber: unknown = "never ran";
    const stop = messages.listen(() => {
      seenBySubscriber = pendingPrepend.get();
    });
    prependMessages(CHAT, [msg("user", "older")]);
    stop();
    expect(seenBySubscriber).toEqual({ chatId: CHAT, count: 1 });
  });

  test("a bulk replacement drops an unapplied prefix", () => {
    // The list a prefix was a prefix OF no longer exists.
    pendingPrepend.set({ chatId: CHAT, count: 3 });
    setMessages([msg("user", "fresh")]);
    expect(pendingPrepend.get()).toBeNull();
  });

  test("a prepend for ANOTHER conversation is not applied to this one", () => {
    // MUTATION: drop the `prepend.chatId === state.chatId` test and one
    // conversation's messages splice into another's beats.
    openAtTail();
    const before = allBeats().length;
    pendingPrepend.set({ chatId: "some-other-chat", count: 2 });
    // A store update this ingest WOULD normally take.
    appendMessage(msg("user", "still this chat"));
    expect(allBeats()).toHaveLength(before + 1);
    expect(pendingPrepend.get()).toEqual({ chatId: "some-other-chat", count: 2 });
  });
});

describe("B. rows arriving above the reader do not renumber the reader's rows", () => {
  test("prepended turns are numbered DOWN from the head; the head keeps its number", () => {
    // The turn index of a beat is "how many of your turns preceded it", and
    // for a conversation loaded at its tail that number is genuinely unknown.
    // Renumbering what is on screen so the prefix could start at 0 would
    // change every fisheye decision and every group about beats the reader is
    // LOOKING AT, because of rows arriving above them.
    // MUTATION: compute the prefix's turn indices with `computeTurnIndex`
    // alone (drop `turnOffset`) and the prepended turns collide with the
    // head's — two different turns numbered the same.
    openAtTail();
    const headTurn = allBeats()[0]!.turnIndex;
    prependMessages(CHAT, [
      msg("user", "q-2"),
      msg("assistant", "a-2"),
      msg("user", "q-1"),
      msg("assistant", "a-1"),
    ]);
    const beats = allBeats();
    expect(beats.map((b) => b.turnIndex)).toEqual([
      headTurn - 2,
      headTurn - 2,
      headTurn - 1,
      headTurn - 1,
      headTurn,
      headTurn,
    ]);
  });

  test("turn indices stay strictly increasing through the seam", () => {
    openAtTail();
    prependMessages(CHAT, [msg("user", "q"), msg("assistant", "a")]);
    const indices = allBeats().map((b) => b.turnIndex);
    for (let i = 1; i < indices.length; i += 1) {
      expect(indices[i]!).toBeGreaterThanOrEqual(indices[i - 1]!);
    }
  });
});

describe("C. a beat whose cause has just been loaded gets its cause", () => {
  test("the model turn at the old top is re-parented to the user turn that arrived", () => {
    // A model turn built when the conversation was loaded at its tail has
    // `parentId: null` — honestly, because its cause was not loaded. Once the
    // cause exists, the null is a lie of omission and the causal ribbon stops
    // at the page seam.
    // MUTATION: delete the `repairBoundaryParentage` call and this fails
    // while every other assertion in this file stays green.
    currentChatId.set(CHAT);
    const orphan = msg("assistant", "answer with no visible question");
    setMessages([orphan]);
    startIngest({ chatId: CHAT });
    const orphanBeat = allBeats()[0]!;
    expect(orphanBeat.parentId).toBeNull();

    const cause = msg("user", "the question");
    prependMessages(CHAT, [cause]);

    const repaired = beatById(orphanBeat.id)!;
    expect(repaired.parentId).toBe(allBeats()[0]!.id);
    expect(allBeats()[0]!.turn?.text).toBe("the question");
  });

  test("a beat that already had a cause keeps it", () => {
    // MUTATION: make the repair unconditional (drop `beat.parentId === null`)
    // and every model turn in the loaded region is re-parented to the newest
    // prepended user turn — a fabricated causal chain.
    openAtTail();
    const modelBeat = allBeats()[1]!;
    const originalParent = modelBeat.parentId;
    expect(originalParent).not.toBeNull();
    prependMessages(CHAT, [msg("user", "older q")]);
    expect(beatById(modelBeat.id)!.parentId).toBe(originalParent);
  });
});

describe("D. the transcript refuses a message it already holds", () => {
  test("a re-delivered page adds nothing and reports zero", () => {
    // A message that appears twice is the surface saying you sent it twice.
    // MUTATION: drop the `held` filter in `prependMessages` and the log
    // throws on the duplicate beat id — loudly, but only because `log.ts`
    // refuses; the transcript itself would already be wrong.
    openAtTail();
    const older = msg("user", "older");
    expect(prependMessages(CHAT, [older])).toBe(1);
    expect(prependMessages(CHAT, [older])).toBe(0);
    expect(messages.get().filter((m) => m.id === older.id)).toHaveLength(1);
    expect(allBeats()).toHaveLength(3);
  });
});

describe("E. the height index carries its measurements across the shift", () => {
  test("measured heights, stamps and un-measured flags move with their rows", () => {
    // Dropping them would put every already-drawn row back at the estimate,
    // the document would change height under the reader, and the scroll
    // compensation would be computed against a geometry that no longer
    // exists.
    // MUTATION: in `HeightIndex.prepend`, stop replaying `kept` and every
    // measurement is lost — the offsets below collapse to estimates.
    const index = new HeightIndex(40, 16);
    index.append(4);
    // Rows 0 and 2 measured, rows 1 and 3 NEVER measured — a real window,
    // where some rows have mounted and some have not. A fixture where every
    // row is measured cannot see the `measured` flag being lost, because
    // `update` sets it anyway: verified by mutation, which survived until the
    // fixture was mixed.
    index.update(0, 100, "shape-0");
    index.update(2, 102, "shape-2");
    const heightsBefore = [0, 1, 2, 3].map((i) => index.heightOf(i));
    const stampsBefore = [0, 1, 2, 3].map((i) => index.stampOf(i));
    const measuredBefore = [0, 1, 2, 3].map((i) => index.isMeasured(i));
    expect(measuredBefore).toEqual([true, false, true, false]);
    const totalBefore = index.totalHeight();

    index.prepend(3);

    expect(index.length).toBe(7);
    expect([3, 4, 5, 6].map((i) => index.heightOf(i))).toEqual(heightsBefore);
    expect([3, 4, 5, 6].map((i) => index.stampOf(i))).toEqual(stampsBefore);
    expect(
      [3, 4, 5, 6].map((i) => index.isMeasured(i)),
      "a row still at its estimate must not come out of a prepend claiming to have been measured",
    ).toEqual(measuredBefore);
    // The new rows are UN-measured and un-stamped.
    expect([0, 1, 2].map((i) => index.isMeasured(i))).toEqual([false, false, false]);
    expect([0, 1, 2].map((i) => index.stampOf(i))).toEqual([null, null, null]);
    // The shift the renderer applies to `scrollTop` is exactly this.
    expect(index.offsetOf(3)).toBe(3 * 40);
    expect(index.totalHeight()).toBe(totalBefore + 3 * 40);
  });

  test("the shift is exact across a capacity growth", () => {
    const index = new HeightIndex(40, 16);
    index.append(16);
    for (let i = 0; i < 16; i += 1) index.update(i, 50, "x");
    index.prepend(40);
    expect(index.length).toBe(56);
    expect(index.offsetOf(40)).toBe(40 * 40);
    expect(index.totalHeight()).toBe(40 * 40 + 16 * 50);
    expect(index.indexAtOffset(40 * 40)).toBe(40);
  });

  test("prepending nothing does nothing", () => {
    const index = new HeightIndex(40, 16);
    index.append(2);
    index.update(0, 77, "s");
    index.prepend(0);
    expect(index.length).toBe(2);
    expect(index.heightOf(0)).toBe(77);
  });
});

describe("F. absence stays honest", () => {
  test("a failed page does NOT make the older messages stop existing", () => {
    // Rendering "this is the beginning of the conversation" because a request
    // failed is a fabricated absence — the reader would be told the
    // transcript ends where the network did (§1 L3).
    // MUTATION: clear `hasOlder` in `noteReachFailed` and this fails.
    noteReachOpened({ chatId: CHAT, hasOlder: true, olderCursor: "cur", messageCount: 900, loaded: 200 });
    noteReachLoading(CHAT);
    noteReachFailed(CHAT, "the request timed out after 30s");
    const reach = historyReach.get()!;
    expect(reach.hasOlder).toBe(true);
    expect(reach.olderCursor).toBe("cur");
    expect(reach.loading).toBe(false);
    expect(reach.failure).toBe("the request timed out after 30s");
  });

  test("the reach only ever answers about the conversation it describes", () => {
    // MUTATION: drop the `current.chatId !== chatId` guards and one
    // conversation's reach is overwritten by another's in-flight page.
    noteReachOpened({ chatId: CHAT, hasOlder: true, olderCursor: "cur", messageCount: 900, loaded: 200 });
    noteReachLoading("a-different-chat");
    noteReachExtended("a-different-chat", 50, { hasOlder: false, olderCursor: null, messageCount: 3 });
    noteReachFailed("a-different-chat", "boom");
    expect(historyReach.get()).toMatchObject({
      chatId: CHAT,
      hasOlder: true,
      loading: false,
      failure: null,
      loaded: 200,
    });
  });

  test("extending the reach counts what was HELD, not what was offered", () => {
    noteReachOpened({ chatId: CHAT, hasOlder: true, olderCursor: "c1", messageCount: 900, loaded: 200 });
    // 200 arrived, 3 were duplicates the transcript already held.
    noteReachExtended(CHAT, 197, { hasOlder: true, olderCursor: "c2", messageCount: 900 });
    expect(historyReach.get()).toMatchObject({ loaded: 397, olderCursor: "c2", hasOlder: true });
  });

  test("reaching the beginning is a fact the SERVER supplies", () => {
    noteReachOpened({ chatId: CHAT, hasOlder: true, olderCursor: "c1", messageCount: 12, loaded: 8 });
    noteReachExtended(CHAT, 4, { hasOlder: false, olderCursor: null, messageCount: 12 });
    const reach = historyReach.get()!;
    expect(reach.hasOlder).toBe(false);
    expect(reach.olderCursor).toBeNull();
  });
});

describe("G. `loadOlderHistory` — one page at a time, and only when there is one", () => {
  /** The wire, stubbed: the tail page, then one older page per cursor. */
  function stubPages(pages: readonly (readonly ChatMessage[])[]): {
    fetch: ReturnType<typeof vi.fn>;
    olderRequests: () => number;
  } {
    let older = 0;
    const chat = {
      id: CHAT,
      projectId: "p1",
      title: "paged",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      modelId: null,
      pinned: false,
    };
    const asRows = (list: readonly ChatMessage[]): unknown[] =>
      list.map((m) => ({
        id: m.id,
        chatId: CHAT,
        role: m.role,
        content: m.content,
        createdAt: new Date(m.timestamp).toISOString(),
        modelEventType: null,
        runId: null,
        metadata: null,
      }));
    const total = pages.reduce((n, p) => n + p.length, 0);
    const fn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const olderMatch = /\/history\/older\?before=(.+)$/.exec(url);
      if (olderMatch !== null) {
        older += 1;
        const index = Number(decodeURIComponent(olderMatch[1]!));
        const page = pages[index] ?? [];
        const nextIndex = index - 1;
        return new Response(
          JSON.stringify({
            chatId: CHAT,
            messages: asRows(page),
            toolCalls: [],
            page:
              nextIndex >= 0
                ? partialPage(page.length, total, String(nextIndex))
                : wholeConversationPage(page.length),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/history")) {
        const tail = pages[pages.length - 1]!;
        return new Response(
          JSON.stringify({
            chat,
            messages: asRows(tail),
            toolCalls: [],
            metricsSnapshots: [],
            timelineRefs: [],
            page:
              pages.length > 1
                ? partialPage(tail.length, total, String(pages.length - 2))
                : wholeConversationPage(tail.length),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fn);
    return { fetch: fn, olderRequests: () => older };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("a burst of requests issues ONE page, not one per call", async () => {
    // The flow calls this on every scroll event. MUTATION: drop the
    // `reach.loading` refusal in `loadOlderHistory` and a single flick of the
    // wheel fetches the same page a dozen times, each of which SUCCEEDS —
    // so nothing reports it except the network tab.
    currentChatId.set(CHAT);
    const stub = stubPages([[msg("user", "oldest")], [msg("user", "newest")]]);
    await loadChatHistory(CHAT);
    startIngest({ chatId: CHAT });
    const results = await Promise.all([
      loadOlderHistory(CHAT),
      loadOlderHistory(CHAT),
      loadOlderHistory(CHAT),
    ]);
    expect(stub.olderRequests()).toBe(1);
    expect(results.filter((n) => n > 0)).toHaveLength(1);
    expect(allBeats().map((b) => b.turn?.text)).toEqual(["oldest", "newest"]);
  });

  test("it refuses when the server has said there is nothing older", async () => {
    currentChatId.set(CHAT);
    const stub = stubPages([[msg("user", "the only one")]]);
    await loadChatHistory(CHAT);
    expect(historyReach.get()).toMatchObject({ hasOlder: false, olderCursor: null });
    expect(await loadOlderHistory(CHAT)).toBe(0);
    expect(stub.olderRequests()).toBe(0);
  });

  test("it refuses for a conversation that is not the one on record", async () => {
    currentChatId.set(CHAT);
    const stub = stubPages([[msg("user", "a")], [msg("user", "b")]]);
    await loadChatHistory(CHAT);
    expect(await loadOlderHistory("a-different-chat")).toBe(0);
    expect(stub.olderRequests()).toBe(0);
  });

  test("walking to the beginning ends with the beginning, and the beats are in order", async () => {
    currentChatId.set(CHAT);
    stubPages([
      [msg("user", "p0-a"), msg("assistant", "p0-b")],
      [msg("user", "p1-a"), msg("assistant", "p1-b")],
      [msg("user", "p2-a"), msg("assistant", "p2-b")],
    ]);
    await loadChatHistory(CHAT);
    startIngest({ chatId: CHAT });
    while (historyReach.get()?.hasOlder === true) {
      const added = await loadOlderHistory(CHAT);
      expect(added, "the walk must advance or stop, never spin").toBeGreaterThan(0);
    }
    expect(historyReach.get()).toMatchObject({ hasOlder: false, olderCursor: null, loaded: 6 });
    expect(allBeats().map((b) => b.turn?.text)).toEqual([
      "p0-a",
      "p0-b",
      "p1-a",
      "p1-b",
      "p2-a",
      "p2-b",
    ]);
  });

  test("a failed page says so and leaves the way back open", async () => {
    // MUTATION: swallow the error (return 0 without `noteReachFailed`) and
    // the surface reports nothing at all about a page it could not read —
    // the L3 failure, one level down from the conversation open.
    currentChatId.set(CHAT);
    stubPages([[msg("user", "old")], [msg("user", "new")]]);
    await loadChatHistory(CHAT);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    expect(await loadOlderHistory(CHAT)).toBe(0);
    const reach = historyReach.get()!;
    expect(reach.failure).not.toBeNull();
    expect(reach.hasOlder, "the older messages did not stop existing").toBe(true);
    expect(reach.olderCursor).not.toBeNull();
    expect(reach.loading).toBe(false);
  });
});
