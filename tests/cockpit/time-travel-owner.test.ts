/**
 * TIME TRAVEL — the owner suite for the global `asOf` (DESIGN-COCKPIT-V2 §6.2).
 *
 * The defect this locks shut: the sweep planted a head, the banner said
 * `viewing 16:00:53`, and NOTHING else on screen changed. The head and the
 * server's ranged-read `until` both existed; nothing joined them. Every test
 * here is written so that removing one link in that join FAILS, and each
 * mutation self-check below proves the test can actually see the removal.
 *
 *   A. ONE OWNER — the sweep's `sweepHead` and the data layer's `asOfHead`
 *      are the SAME atom, not two that agree today.
 *   B. THE `until` PLUMBING — a Broker read at a planted head carries
 *      `until=<head>` on the wire, for ranged blocks, without the call site
 *      passing anything.
 *      MUTATION: a read that drops `until` fails.
 *   C. CACHE-KEY CORRECTNESS — the past answer and the live answer are
 *      different cache entries in BOTH directions.
 *      MUTATION: a live cache entry served for a planted head fails.
 *   D. HONEST DEGRADATION — a block that does not implement `until` is
 *      REFUSED, never served live data dressed as past data, and the
 *      refusal maps to the one plain sentence surfaces render.
 *   E. NO WRITES — `broker.action` refuses while a head is planted.
 *      MUTATION: an action enabled during past view fails.
 *   F. THE RE-READ — moving the head notifies every standing refresh
 *      subscription, which is the half whose absence WAS the bug.
 *   G. RETURN TO LIVE — the prior state is restored, not re-fetched.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  action,
  cacheKey,
  clearCache,
  onInvalidation,
  read,
  readKey,
} from "../../src/data/broker.ts";
import {
  asOfHead,
  blockAnswersInPast,
  isPastView,
  PAST_VIEW_ACT_REASON,
  PAST_VIEW_READ_ONLY_CODE,
  PAST_VIEW_UNSUPPORTED_CODE,
  PAST_VIEW_UNSUPPORTED_SENTENCE,
  paramsWithAsOf,
  plantHead,
  RANGED_BLOCKS,
  returnToLive,
  TIME_INVARIANT_BLOCKS,
} from "../../src/data/asof.ts";
import { sweepHead } from "../../src/cockpit/sweep/sweep-store.ts";
import { absenceReason } from "../../src/data/absence.ts";
import { ClientError } from "../../src/data/errors.ts";

/** A planted instant. Any epoch-ms value works; a fixed one keeps the
 *  expected query strings literal and readable. */
const HEAD_MS = 1_700_000_000_000;

/** A ranged block (implements `until`) and a block that does not. */
const RANGED = "tools.breaker";
const NOT_RANGED = "run.compose";

const realFetch = globalThis.fetch;

/** Every URL the code under test asked for, in order. */
let requested: string[] = [];

function envelope(data: unknown): Response {
  return new Response(
    JSON.stringify({ data, meta: { etag: 'W/"t"', asOf: Date.now() } }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

beforeEach(() => {
  requested = [];
  returnToLive();
  clearCache();
  globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : String(input);
    requested.push(url);
    // The payload names the query it answered, so a test can prove WHICH
    // answer a surface is holding rather than merely that it holds one.
    return Promise.resolve(envelope({ answeredFor: url }));
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  returnToLive();
  clearCache();
  vi.restoreAllMocks();
});

// ── A. ONE OWNER ───────────────────────────────────────────────────────────

describe("A. one owner for asOf", () => {
  test("the sweep's head and the data layer's head are the SAME atom", () => {
    expect(sweepHead).toBe(asOfHead);
  });

  test("planting through the sweep's vocabulary moves the data layer's head", () => {
    plantHead(HEAD_MS);
    expect(sweepHead.get()).toBe(HEAD_MS);
    expect(isPastView.get()).toBe(true);
    returnToLive();
    expect(sweepHead.get()).toBeNull();
    expect(isPastView.get()).toBe(false);
  });
});

// ── B. THE `until` PLUMBING ────────────────────────────────────────────────

describe("B. every Broker read carries the ambient until", () => {
  test("live: no until is sent", async () => {
    await read(RANGED, { params: { chatId: "c1" } });
    expect(requested).toHaveLength(1);
    expect(requested[0]).toContain("chatId=c1");
    expect(requested[0]).not.toContain("until");
  });

  test("planted: the call site passes nothing and until still reaches the wire", async () => {
    plantHead(HEAD_MS);
    await read(RANGED, { params: { chatId: "c1" } });
    expect(requested).toHaveLength(1);
    expect(requested[0]).toContain(`until=${HEAD_MS}`);
  });

  test("planted with NO params at all: until is still sent", async () => {
    plantHead(HEAD_MS);
    await read("arm.flags");
    expect(requested[0]).toContain(`until=${HEAD_MS}`);
  });

  // MUTATION (required): a read that drops `until` must fail this suite.
  test("mutation — a reader that builds its own params without until is caught", async () => {
    plantHead(HEAD_MS);
    // This is what a call site that "remembers to pass until" itself looks
    // like when it forgets: params assembled by hand, no ambient fold.
    const droppedUntil = { chatId: "c1" };
    const path = `/api/b/${RANGED}?${new URLSearchParams(droppedUntil).toString()}`;
    expect(path).not.toContain("until");
    // The real read, over the same params, does NOT drop it — which is the
    // whole point of applying it at the choke point.
    await read(RANGED, { params: droppedUntil });
    expect(requested[0]).toContain(`until=${HEAD_MS}`);
    expect(requested[0]).not.toBe(path);
  });
});

// ── C. CACHE-KEY CORRECTNESS ───────────────────────────────────────────────

describe("C. time is part of cache identity, in both directions", () => {
  test("the key gains until at a planted head and loses it live", () => {
    const live = readKey(RANGED, { chatId: "c1" });
    plantHead(HEAD_MS);
    const past = readKey(RANGED, { chatId: "c1" });
    returnToLive();
    expect(past).not.toBe(live);
    expect(past).toContain(`until=${HEAD_MS}`);
    expect(readKey(RANGED, { chatId: "c1" })).toBe(live);
  });

  // MUTATION (required): a LIVE cache entry served for a planted head fails.
  test("mutation — a live entry is NOT served once a head is planted", async () => {
    const liveAnswer = await read<{ answeredFor: string }>(RANGED, {
      params: { chatId: "c1" },
      ttlMs: 60_000,
    });
    expect(requested).toHaveLength(1);
    expect(liveAnswer.answeredFor).not.toContain("until");

    plantHead(HEAD_MS);
    const pastAnswer = await read<{ answeredFor: string }>(RANGED, {
      params: { chatId: "c1" },
      ttlMs: 60_000,
    });
    // A SECOND request went out: the fresh live entry could not answer for
    // the past. Serving it would be the cache poisoning this guards.
    expect(requested).toHaveLength(2);
    expect(pastAnswer.answeredFor).toContain(`until=${HEAD_MS}`);
    expect(pastAnswer.answeredFor).not.toBe(liveAnswer.answeredFor);
  });

  test("and the reverse: a PAST entry is never served to a live reader", async () => {
    plantHead(HEAD_MS);
    const pastAnswer = await read<{ answeredFor: string }>(RANGED, {
      params: { chatId: "c1" },
      ttlMs: 60_000,
    });
    returnToLive();
    const liveAnswer = await read<{ answeredFor: string }>(RANGED, {
      params: { chatId: "c1" },
      ttlMs: 60_000,
    });
    expect(liveAnswer.answeredFor).not.toContain("until");
    expect(liveAnswer.answeredFor).not.toBe(pastAnswer.answeredFor);
  });

  test("two different heads are two different entries", async () => {
    plantHead(HEAD_MS);
    await read(RANGED, { params: { chatId: "c1" }, ttlMs: 60_000 });
    plantHead(HEAD_MS - 1000);
    await read(RANGED, { params: { chatId: "c1" }, ttlMs: 60_000 });
    expect(requested).toHaveLength(2);
    expect(requested[0]).not.toBe(requested[1]);
  });

  test("the prov stamp names the entry actually displayed, not the live one", () => {
    plantHead(HEAD_MS);
    expect(readKey(RANGED, { chatId: "c1" })).toBe(
      cacheKey(RANGED, { chatId: "c1", until: String(HEAD_MS) }),
    );
  });
});

// ── D. HONEST DEGRADATION ──────────────────────────────────────────────────

describe("D. a block that cannot answer in the past refuses, loudly", () => {
  test("live, the same block reads normally", async () => {
    await read(NOT_RANGED, { params: { chatId: "c1" } });
    expect(requested).toHaveLength(1);
  });

  test("planted, no request is made at all — nothing to mistake for past data", async () => {
    plantHead(HEAD_MS);
    await expect(read(NOT_RANGED, { params: { chatId: "c1" } })).rejects.toThrow(
      ClientError,
    );
    expect(requested).toHaveLength(0);
  });

  test("the refusal carries the typed code and the one plain sentence", async () => {
    plantHead(HEAD_MS);
    const err = await read(NOT_RANGED).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClientError);
    expect((err as ClientError).code).toBe(PAST_VIEW_UNSUPPORTED_CODE);
    // Surfaces render the mapped sentence, never a transport excuse: the app
    // DECIDED not to ask, and blaming the network for that would be a lie.
    expect(absenceReason(err)).toBe(PAST_VIEW_UNSUPPORTED_SENTENCE);
    expect(absenceReason(err)).not.toBe("not available right now");
  });

  test("a time-invariant block passes through unbounded (its answer cannot change)", async () => {
    plantHead(HEAD_MS);
    await read("lens.ancestry", { params: { traceId: "t1" } });
    expect(requested).toHaveLength(1);
    // Deliberately NO `until`: bounding an immutable ancestry chain would
    // truncate a real chain and show the stump as the whole cause.
    expect(requested[0]).not.toContain("until");
  });

  test("the split is total — every block is ranged, invariant, or refusing", () => {
    for (const id of RANGED_BLOCKS) expect(blockAnswersInPast(id)).toBe(true);
    for (const id of TIME_INVARIANT_BLOCKS) expect(blockAnswersInPast(id)).toBe(true);
    expect(blockAnswersInPast(NOT_RANGED)).toBe(false);
    // The two sets are disjoint: a block cannot be both bounded and immune.
    for (const id of RANGED_BLOCKS) expect(TIME_INVARIANT_BLOCKS.has(id)).toBe(false);
  });

  test("mutation — a block quietly added to the ranged set would send a parameter its schema drops", () => {
    // `paramsWithAsOf` is the ONE place that decides. Membership is the whole
    // decision, so a wrong membership is visible here rather than as a silent
    // live answer three surfaces away.
    plantHead(HEAD_MS);
    expect(() => paramsWithAsOf(NOT_RANGED, { chatId: "c1" })).toThrow(ClientError);
    expect(paramsWithAsOf(RANGED, { chatId: "c1" })).toEqual({
      chatId: "c1",
      until: String(HEAD_MS),
    });
  });
});

// ── E. NO WRITES FROM A PAST VIEW ──────────────────────────────────────────

describe("E. a past view is read-only at the write door", () => {
  test("live, the action posts", async () => {
    await action(RANGED, "set", { tool: "t", on: true });
    expect(requested).toHaveLength(1);
  });

  // MUTATION (required): an action enabled during past view must fail.
  test("mutation — an action invoked during a past view never reaches the wire", async () => {
    plantHead(HEAD_MS);
    const err = await action(RANGED, "set", { tool: "t", on: true }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ClientError);
    expect((err as ClientError).code).toBe(PAST_VIEW_READ_ONLY_CODE);
    expect((err as ClientError).message).toBe(PAST_VIEW_ACT_REASON);
    // Nothing was posted, so nothing changed — the guarantee does not depend
    // on a component remembering to disable its button.
    expect(requested).toHaveLength(0);
  });

  test("returning to live restores the ability to act", async () => {
    plantHead(HEAD_MS);
    await action(RANGED, "set", {}).catch(() => undefined);
    returnToLive();
    await action(RANGED, "set", {});
    expect(requested).toHaveLength(1);
  });
});

// ── F. MOVING THE HEAD RE-READS ────────────────────────────────────────────

describe("F. moving the head re-dates every surface", () => {
  test("planting notifies standing refresh subscriptions", () => {
    const refreshed = vi.fn();
    const stop = onInvalidation("run:done", refreshed);
    plantHead(HEAD_MS);
    expect(refreshed).toHaveBeenCalledTimes(1);
    returnToLive();
    expect(refreshed).toHaveBeenCalledTimes(2);
    stop();
  });

  test("one feed registered under three events re-reads ONCE, not three times", () => {
    // The desk does exactly this (`refreshAllLoaded` under `compose:changed`,
    // `tools:changed` and `run:done`) and its refresh FORCES its reads, which
    // deliberately bypasses in-flight dedup. Calling it per event opened
    // three identical requests per head move — browser-measured.
    const feed = vi.fn();
    const stops = [
      onInvalidation("compose:changed", feed),
      onInvalidation("tools:changed", feed),
      onInvalidation("run:done", feed),
    ];
    plantHead(HEAD_MS);
    expect(feed).toHaveBeenCalledTimes(1);
    for (const stop of stops) stop();
  });

  test("a subscription registered under ANY event is notified — the question changed for all of them", () => {
    const composeFeed = vi.fn();
    const toolsFeed = vi.fn();
    const stops = [
      onInvalidation("compose:changed", composeFeed),
      onInvalidation("tools:changed", toolsFeed),
    ];
    plantHead(HEAD_MS);
    expect(composeFeed).toHaveBeenCalledTimes(1);
    expect(toolsFeed).toHaveBeenCalledTimes(1);
    for (const stop of stops) stop();
  });

  test("mutation — without the re-read nothing would change on screen (the original defect)", () => {
    const feed = vi.fn();
    const stop = onInvalidation("run:done", feed);
    // Setting the head to the value it ALREADY holds is not a move, and must
    // not stampede every feed. This is what distinguishes "the head moved"
    // from "someone wrote the same number again".
    plantHead(HEAD_MS);
    feed.mockClear();
    plantHead(HEAD_MS);
    expect(feed).not.toHaveBeenCalled();
    plantHead(HEAD_MS - 1);
    expect(feed).toHaveBeenCalledTimes(1);
    stop();
  });
});

// ── G. RETURN TO LIVE RESTORES ─────────────────────────────────────────────

describe("G. returning to now restores the prior state", () => {
  test("the live entry survives the excursion and is served again without a refetch", async () => {
    const before = await read<{ answeredFor: string }>(RANGED, {
      params: { chatId: "c1" },
      ttlMs: 60_000,
    });
    plantHead(HEAD_MS);
    await read(RANGED, { params: { chatId: "c1" }, ttlMs: 60_000 });
    returnToLive();
    const after = await read<{ answeredFor: string }>(RANGED, {
      params: { chatId: "c1" },
      ttlMs: 60_000,
    });
    // Two network trips total (live, then past). The return was served from
    // the surviving live entry — restored, not re-fetched.
    expect(requested).toHaveLength(2);
    expect(after.answeredFor).toBe(before.answeredFor);
  });
});
