// @vitest-environment node
/**
 * DESK feed (§3.4–3.5) — the load machine and the act contract:
 *
 *   OPTIMISTIC ACK, READ-BACK CONFIRM. An act must (1) mark its target
 *   pending SYNCHRONOUSLY (the §1.5 <100ms acknowledgement), (2) post the
 *   real block action, (3) FORCE re-read the block, and (4) clear the
 *   pending mark only AFTER that read-back settles. The displayed state
 *   (chip / strip) may only ever change because a READ changed it — a chip
 *   that confirms from the action's own response is confirming from hope.
 *
 *   The invariant is checked mechanically over a recorded transition log
 *   (`readBackViolations`) and MUTATION-TESTED: a hopeful sequence (pending
 *   cleared / state flipped before the read-back lands) must be flagged.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  actFailures,
  actKey,
  armBreaker,
  disarmBreaker,
  breakerLoads,
  composeLoads,
  flipBreaker,
  muteChannel,
  muteMemoryItem,
  pendingActs,
  pinMemory,
  requestBreaker,
  requestDesk,
  requestItemDetail,
  itemDetailLoads,
  itemLoadKey,
  refreshDesk,
  resetBreaker,
  resetDeskFeed,
  setDeskIo,
  setTrim,
  unmuteChannel,
  unmuteMemoryItem,
} from "../../src/cockpit/desk/desk-feed.ts";
import { ClientError } from "../../src/data/errors.ts";

const CHAT = "chat-1";

const COMPOSE_WIRE = {
  channels: [
    { id: "system", tokens: 100, items: [{ id: "system-prompt", label: "system", tokens: 100 }] },
    { id: "memories", tokens: 50, items: [{ id: "mem-1", label: "m", tokens: 50 }] },
    { id: "history", tokens: 200, items: [{ id: "turn-1", label: "turn 1: hi", tokens: 200 }] },
    { id: "toolResults", tokens: 0, items: [] },
  ],
  limit: 1000,
  settings: { pinnedMemoryIds: [], mutedChannels: [], mutedMemoryIds: [] },
};

const ROWS_ON = [{ id: "edit_file", label: "edit file", state: "on", calls: 1 }];
const ROWS_OFF = [{ id: "edit_file", label: "edit file", state: "off", calls: 1 }];

/** Deferred promise helper. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => resetDeskFeed());
afterEach(() => resetDeskFeed());

describe("source detail demand ends with the last mounted reader", () => {
  const body = (itemId: string, text = itemId) => ({ channel: "history", itemId, label: itemId, tokens: 1, origin: "recorded", parts: [{ role: "user", field: "content", text }], withheldChars: 0 });

  test("shared readers coalesce, last release removes retained content and later refresh does no hidden work", async () => {
    const reads: string[] = [];
    setDeskIo({ itemDetail: async (_chat, _channel, item) => { reads.push(item); return body(item); } });
    const first = requestItemDetail(CHAT, "history", "one");
    const second = requestItemDetail(CHAT, "history", "one");
    try {
      await Promise.resolve();
      expect(reads).toEqual(["one"]);
      expect(itemDetailLoads.get()[itemLoadKey(CHAT, "history", "one")]?.kind).toBe("measured");
      first(); first();
      refreshDesk(CHAT); await Promise.resolve();
      expect(reads).toEqual(["one", "one"]);
      second();
      expect(itemDetailLoads.get()).toEqual({});
      refreshDesk(CHAT); await Promise.resolve();
      expect(reads).toEqual(["one", "one"]);
      for (const item of ["two", "three", "four"]) {
        const release = requestItemDetail(CHAT, "history", item);
        await Promise.resolve(); release();
        expect(itemDetailLoads.get()).toEqual({});
      }
    } finally { first(); second(); }
  });

  test.each(["resolve", "reject"] as const)("a released %s cannot repopulate a closed item or resume hidden refresh work", async (completion) => {
    const held = deferred<unknown>();
    let reads = 0;
    setDeskIo({ itemDetail: async () => { reads++; return held.promise; } });
    const release = requestItemDetail(CHAT, "history", "one");
    release();
    expect(itemDetailLoads.get()).toEqual({});
    if (completion === "resolve") held.resolve(body("one")); else held.reject(new Error("reader left"));
    await held.promise.catch(() => undefined); await Promise.resolve();
    expect(itemDetailLoads.get()).toEqual({});
    refreshDesk(CHAT); await Promise.resolve();
    expect(reads).toBe(1);
  });

  test.each(["resolve", "reject"] as const)("a released %s cannot repopulate a reopened item", async (completion) => {
    const held = deferred<unknown>();
    let calls = 0;
    setDeskIo({ itemDetail: async () => ++calls === 1 ? held.promise : body("one", "current") });
    const old = requestItemDetail(CHAT, "history", "one"); old();
    const current = requestItemDetail(CHAT, "history", "one");
    try {
      await Promise.resolve(); await Promise.resolve();
      if (completion === "resolve") held.resolve(body("one", "stale")); else held.reject(new Error("old request failed"));
      await held.promise.catch(() => undefined); await Promise.resolve();
      const value = itemDetailLoads.get()[itemLoadKey(CHAT, "history", "one")];
      expect(value?.kind).toBe("measured");
      if (value?.kind === "measured") expect(value.view.parts[0]?.text).toBe("current");
    } finally { held.resolve(body("one")); current(); }
    expect(itemDetailLoads.get()).toEqual({});
  });
});

// ── The mechanical read-back invariant ──────────────────────────────────────

type Transition = "pending-set" | "action-settled" | "state-changed" | "read-settled" | "pending-cleared";

/**
 * The invariant, as a pure check over a transition log for ONE successful
 * act: after the action settles, any displayed-state change and the pending
 * clear must come AFTER the read-back settled. (Exported logic lives in the
 * test on purpose: the log is produced by observing the REAL machine.)
 */
function readBackViolations(log: readonly Transition[]): string[] {
  const out: string[] = [];
  const readAt = log.indexOf("read-settled");
  const clearedAt = log.indexOf("pending-cleared");
  const changedAt = log.indexOf("state-changed");
  if (clearedAt !== -1 && (readAt === -1 || clearedAt < readAt)) {
    out.push("pending cleared before the read-back settled — confirmation from hope");
  }
  if (changedAt !== -1 && (readAt === -1 || changedAt < readAt)) {
    out.push("displayed state changed before the read-back settled — not read-confirmed");
  }
  return out;
}

describe("loads — pending → measured / absent, plain words", () => {
  test("requestDesk measures both halves from real reads", async () => {
    setDeskIo({
      compose: async () => COMPOSE_WIRE,
      breaker: async () => ROWS_ON,
    });
    requestDesk(CHAT);
    expect(composeLoads.get()[CHAT]!.kind).toBe("pending");
    expect(breakerLoads.get()[CHAT]!.kind).toBe("pending");
    await Promise.resolve();
    await Promise.resolve();
    const c = composeLoads.get()[CHAT]!;
    const b = breakerLoads.get()[CHAT]!;
    expect(c.kind).toBe("measured");
    if (c.kind === "measured") expect(c.view.total).toBe(350);
    expect(b.kind).toBe("measured");
  });

  test("a failed read becomes ABSENT with plain words — never a guess", async () => {
    setDeskIo({
      compose: async () => {
        throw new ClientError("http_500", "boom", 500);
      },
      breaker: async () => {
        throw new ClientError("forbidden", "no", 403);
      },
    });
    requestDesk(CHAT);
    await Promise.resolve();
    await Promise.resolve();
    const c = composeLoads.get()[CHAT]!;
    const b = breakerLoads.get()[CHAT]!;
    expect(c.kind).toBe("absent");
    if (c.kind === "absent") expect(c.reason).toBe("not available right now");
    expect(b.kind).toBe("absent");
    if (b.kind === "absent") expect(b.reason).toBe("not available to this session");
  });

  test("malformed wire → honest absence, not a partial strip", async () => {
    setDeskIo({ compose: async () => ({ nope: true }), breaker: async () => ({}) });
    requestDesk(CHAT);
    await Promise.resolve();
    await Promise.resolve();
    expect(composeLoads.get()[CHAT]!.kind).toBe("absent");
    expect(breakerLoads.get()[CHAT]!.kind).toBe("absent");
  });

  test("requestBreaker loads ONLY the breaker half (the closed-desk edge)", async () => {
    setDeskIo({ breaker: async () => ROWS_ON });
    requestBreaker(CHAT);
    await Promise.resolve();
    expect(breakerLoads.get()[CHAT]!.kind).toBe("measured");
    expect(composeLoads.get()[CHAT]).toBeUndefined();
  });
});

describe("breaker acts — optimistic ack, read-back confirm (§3.5)", () => {
  test("the pending ack is SYNCHRONOUS (the <100ms budget is same-tick)", () => {
    setDeskIo({
      act: async () => ({}),
      breaker: async () => ROWS_OFF,
    });
    const p = flipBreaker(CHAT, "edit_file", false);
    // Before ANY await settles: the act is already acknowledged.
    expect(pendingActs.get()[actKey("breaker", "edit_file")]).toContain("turning off");
    return p;
  });

  test("the chip's state changes ONLY when the read-back lands; pending clears AFTER it", async () => {
    // Seed a measured "on" row.
    setDeskIo({ breaker: async () => ROWS_ON });
    requestBreaker(CHAT);
    await Promise.resolve();

    // The transition log is recorded by OBSERVING the real machine: the
    // stores' own subscriptions plus the injected IO's settle points.
    const log: Transition[] = [];
    const actGate = deferred<unknown>();
    const readGate = deferred<unknown>();
    setDeskIo({
      act: async () => {
        const value = await actGate.promise;
        log.push("action-settled");
        return value;
      },
      breaker: async () => {
        const wire = await readGate.promise;
        log.push("read-settled");
        return wire;
      },
    });
    const KEY = actKey("breaker", "edit_file");
    let sawPending = false;
    const unsubPending = pendingActs.subscribe((acts) => {
      const has = acts[KEY] !== undefined;
      if (has && !sawPending) {
        sawPending = true;
        log.push("pending-set");
      } else if (!has && sawPending && !log.includes("pending-cleared")) {
        log.push("pending-cleared");
      }
    });
    const unsubRows = breakerLoads.subscribe((loads) => {
      const l = loads[CHAT];
      if (l?.kind === "measured" && l.rows[0]!.state === "off" && !log.includes("state-changed")) {
        log.push("state-changed");
      }
    });

    const done = flipBreaker(CHAT, "edit_file", false);

    // The action settles: the row must STILL read "on" (no hope) and the
    // pending mark must still stand — nothing is confirmed yet.
    actGate.resolve({ tool: "edit_file", on: false, effectiveAt: "next-boundary" });
    await Promise.resolve();
    await Promise.resolve();
    const midway = breakerLoads.get()[CHAT]!;
    expect(midway.kind).toBe("measured");
    if (midway.kind === "measured") expect(midway.rows[0]!.state).toBe("on");
    expect(pendingActs.get()[KEY]).toBeDefined();

    // Only now does the forced read-back land with the recorded new state.
    readGate.resolve(ROWS_OFF);
    await done;

    unsubPending();
    unsubRows();
    const settled = breakerLoads.get()[CHAT]!;
    if (settled.kind === "measured") expect(settled.rows[0]!.state).toBe("off");
    expect(pendingActs.get()[KEY]).toBeUndefined();
    // THE invariant, on the log the real machine produced.
    expect(readBackViolations(log), log.join(" → ")).toEqual([]);
    expect(log).toEqual([
      "pending-set",
      "action-settled",
      "read-settled",
      "state-changed",
      "pending-cleared",
    ]);
  });

  test("a failed act clears pending, records plain-words failure, changes NO state", async () => {
    setDeskIo({ breaker: async () => ROWS_ON });
    requestBreaker(CHAT);
    await Promise.resolve();
    let reads = 0;
    setDeskIo({
      act: async () => {
        throw new ClientError("not_toggleable", "Only built-in tools have breakers", 400);
      },
      breaker: async () => {
        reads += 1;
        return ROWS_ON;
      },
    });
    await flipBreaker(CHAT, "edit_file", false);
    expect(pendingActs.get()[actKey("breaker", "edit_file")]).toBeUndefined();
    expect(actFailures.get()[actKey("breaker", "edit_file")]).toContain("Only built-in tools");
    const l = breakerLoads.get()[CHAT]!;
    if (l.kind === "measured") expect(l.rows[0]!.state).toBe("on");
    // A failed action invalidates nothing — no read-back fired.
    expect(reads).toBe(0);
  });

  test("reset and arm post the declared inputs and read back", async () => {
    const posts: { action: string; input: Record<string, unknown> }[] = [];
    let breakerReads = 0;
    setDeskIo({
      act: async (_b, action, input) => {
        posts.push({ action, input: { ...input } });
        return {};
      },
      breaker: async () => {
        breakerReads += 1;
        return ROWS_ON;
      },
    });
    await resetBreaker(CHAT, "search");
    await armBreaker(CHAT, "search", 5);
    expect(posts).toEqual([
      { action: "reset", input: { tool: "search" } },
      { action: "arm", input: { tool: "search", tripAfterFailures: 5 } },
    ]);
    expect(breakerReads).toBe(2); // one read-back per settled act
  });

  test("disarm posts the declared input and read back (the way back from arm)", async () => {
    const posts: { action: string; input: Record<string, unknown> }[] = [];
    let breakerReads = 0;
    setDeskIo({
      act: async (_b, action, input) => {
        posts.push({ action, input: { ...input } });
        return {};
      },
      breaker: async () => {
        breakerReads += 1;
        return ROWS_ON;
      },
    });
    await disarmBreaker(CHAT, "search");
    expect(posts).toEqual([{ action: "disarm", input: { tool: "search" } }]);
    expect(breakerReads).toBe(1);
  });

  test("mute and unmute post the declared inputs and read back (both directions of a two-way verb)", async () => {
    const posts: { action: string; input: Record<string, unknown> }[] = [];
    let composeReads = 0;
    setDeskIo({
      act: async (_b, action, input) => {
        posts.push({ action, input: { ...input } });
        return {};
      },
      compose: async () => {
        composeReads += 1;
        return COMPOSE_WIRE;
      },
    });
    await muteChannel(CHAT, "memories");
    await unmuteChannel(CHAT, "memories");
    await muteMemoryItem(CHAT, "mem-1");
    await unmuteMemoryItem(CHAT, "mem-1");
    expect(posts).toEqual([
      { action: "mute", input: { chatId: CHAT, channel: "memories", turns: 1 } },
      { action: "unmute", input: { chatId: CHAT, channel: "memories" } },
      { action: "mute", input: { chatId: CHAT, channel: "memories", itemId: "mem-1", turns: 1 } },
      { action: "unmute", input: { chatId: CHAT, channel: "memories", itemId: "mem-1" } },
    ]);
    expect(composeReads).toBe(4); // one read-back per settled act
  });

  // ── MUTATION SELF-CHECKS on the invariant checker ───────────────────────
  test("mutation: a hopeful confirm (pending cleared before read-back) is flagged", () => {
    expect(
      readBackViolations(["pending-set", "action-settled", "pending-cleared", "read-settled"]),
    ).toHaveLength(1);
  });
  test("mutation: a state flip straight from the action response is flagged", () => {
    expect(
      readBackViolations(["pending-set", "action-settled", "state-changed", "read-settled", "pending-cleared"]),
    ).toHaveLength(1);
  });
  test("mutation: no read-back at all is flagged twice over", () => {
    expect(
      readBackViolations(["pending-set", "action-settled", "state-changed", "pending-cleared"]),
    ).toHaveLength(2);
  });
});

describe("compose acts — the declared verbs, read-back re-measure (§3.4)", () => {
  test("pin/mute/trim post the block's declared inputs and force a compose re-read", async () => {
    const posts: { block: string; action: string; input: Record<string, unknown> }[] = [];
    let composeReads = 0;
    setDeskIo({
      act: async (block, action, input) => {
        posts.push({ block, action, input: { ...input } });
        return {};
      },
      compose: async () => {
        composeReads += 1;
        return COMPOSE_WIRE;
      },
    });
    await pinMemory(CHAT, "mem-1");
    await muteChannel(CHAT, "toolResults");
    await setTrim(CHAT, 4);
    expect(posts).toEqual([
      { block: "run.compose", action: "pin", input: { chatId: CHAT, channel: "memories", itemId: "mem-1" } },
      { block: "run.compose", action: "mute", input: { chatId: CHAT, channel: "toolResults", turns: 1 } },
      { block: "run.compose", action: "trim", input: { chatId: CHAT, beforeTurn: 4 } },
    ]);
    expect(composeReads).toBe(3);
    // The strips after the read-back are MEASURED (the next turn's real mix).
    const c = composeLoads.get()[CHAT]!;
    expect(c.kind).toBe("measured");
  });

  test("the trim act sends EXACTLY the number the handle shows (one vocabulary)", async () => {
    const sent: number[] = [];
    setDeskIo({
      act: async (_b, _a, input) => {
        sent.push(input.beforeTurn as number);
        return {};
      },
      compose: async () => COMPOSE_WIRE,
    });
    await setTrim(CHAT, 7);
    expect(sent).toEqual([7]);
  });
});

/**
 * NEVER BLANK WHAT IS ALREADY MEASURED.
 *
 * The desk re-asks for its two reads on every open now, because the Broker
 * serves what it holds and only touches the network past the 5s TTL — so a
 * re-ask is cheap and keeps the strips current. That only works if a re-ask
 * that FAILS leaves the strips alone: wiping a composition the server already
 * stated, because a later request timed out, is the flash the user reported as
 * "everything reloads". The strips carry their own `asOf`; the failure is in
 * the provenance ledger, which is what LENS reads out.
 */
describe("warm strips — re-asked on open, never un-measured by a failure", () => {
  // MUTATION (required): patching `absent` over a measured load must fail.
  test("mutation — a failed re-read keeps the composition and the rows standing", async () => {
    setDeskIo({ compose: async () => COMPOSE_WIRE, breaker: async () => ROWS_ON });
    requestDesk(CHAT);
    await Promise.resolve();
    await Promise.resolve();
    const compose = composeLoads.get()[CHAT]!;
    const breaker = breakerLoads.get()[CHAT]!;
    expect(compose.kind).toBe("measured");
    expect(breaker.kind).toBe("measured");

    setDeskIo({
      compose: async () => {
        throw new ClientError("http_500", "boom", 500);
      },
      breaker: async () => {
        throw new ClientError("http_500", "boom", 500);
      },
    });
    requestDesk(CHAT);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(composeLoads.get()[CHAT]).toEqual(compose);
    expect(breakerLoads.get()[CHAT]).toEqual(breaker);
  });

  test("a re-open re-asks (the TTL, not the feed, decides whether that costs a request)", async () => {
    let composes = 0;
    setDeskIo({
      compose: async () => {
        composes += 1;
        return COMPOSE_WIRE;
      },
      breaker: async () => ROWS_ON,
    });
    requestDesk(CHAT);
    await Promise.resolve();
    await Promise.resolve();
    expect(composes).toBe(1);
    requestDesk(CHAT);
    await Promise.resolve();
    await Promise.resolve();
    expect(composes).toBe(2);
  });

  test("a chat that never answered still states its absence — absence-first survives", async () => {
    setDeskIo({
      compose: async () => {
        throw new ClientError("http_500", "boom", 500);
      },
      breaker: async () => {
        throw new ClientError("forbidden", "no", 403);
      },
    });
    requestDesk("cold-chat");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(composeLoads.get()["cold-chat"]!.kind).toBe("absent");
    expect(breakerLoads.get()["cold-chat"]!.kind).toBe("absent");
  });
});
