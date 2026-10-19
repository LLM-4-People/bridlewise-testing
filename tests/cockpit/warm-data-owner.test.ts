// @vitest-environment node
/**
 * WARM DATA — the owner suite for the third state.
 *
 * THE DEFECT THIS LOCKS SHUT, in the user's own words: "why are things not
 * preloaded, every menu we go, every options reloads instead of being updated
 * in the background". Every room open was a cold start. Absence-first was the
 * right answer to FABRICATION, but it had been applied as though a surface had
 * only two states — "nothing" and "fresh" — and the state that makes an app
 * feel instant is the third one: LAST-KNOWN, shown immediately, revalidated
 * underneath, patched in place.
 *
 * The line this suite defends, in both directions:
 *
 *   A. STALE-WHILE-REVALIDATE at the choke point — a known value is served
 *      without waiting for the network, and the network runs underneath.
 *      MUTATION: a read that awaits the wire for a value it already holds
 *      fails.
 *   B. PATCH, DO NOT REPLACE — fresh bytes notify subscribers ONLY when they
 *      differ, so the common "nothing changed" revalidation costs zero
 *      updates and therefore zero flashes.
 *      MUTATION: a notification on identical bytes fails.
 *   C. NEVER BLANK WHAT YOU KNOW — a failed revalidation leaves the last-known
 *      value standing, and the failure is still in the provenance ledger.
 *      MUTATION: a cache dropped on failure fails.
 *   D. FIRST-EVER LOAD IS STILL ABSENCE-FIRST — nothing known, nothing shown,
 *      nothing invented.
 *   E. WARM ON INTENT RESPECTS A PLANTED HEAD — a warm during a past view
 *      warms the key the OPEN would use, or none at all.
 *      MUTATION: a prefetch that ignored the head fails.
 *   F. QUIET WHEN HIDDEN — a kept-alive surface releases its acquisition when
 *      it stops being on screen and re-takes it when it returns, without
 *      double-acquiring.
 *   G. THE IDLE FILL — ordered by the user's own measured activations, and
 *      structurally incapable of changing the layout.
 *
 * The existing time-travel guard (time-travel-owner.test.ts, section C) still
 * owns "a cached past entry is never served live"; this suite deliberately
 * does not restate it, but §E below proves warming obeys the same rule.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";

import { read as readSource, relpath, walk } from "../helpers/source-scan.ts";

import {
  cacheKey,
  clearCache,
  onFreshRead,
  prefetch,
  read,
  readKey,
  readMeta,
} from "../../src/data/broker.ts";
import { plantHead, returnToLive } from "../../src/data/asof.ts";
import { ClientError } from "../../src/data/errors.ts";
import { provenanceFor, clearProvenance } from "../../src/data/ledger.ts";
import {
  bindShellVisibility,
  setVisibleRoom,
  whileFlowVisible,
  whileRoomVisible,
} from "../../src/cockpit/shell/room-visibility.ts";
import {
  deskWarmPlan,
  planForTarget,
  recordRoomActivation,
  resetRoomActivations,
  roomWarmOrder,
  warmRoom,
  WARM_PLANS,
  STATIC_WARM_ORDER,
} from "../../src/cockpit/shell/room-warm.ts";
import { currentChatId } from "../../src/state/chats.ts";
import { projects, selectProject } from "../../src/state/projects.ts";

// A ranged block (answers at a past instant) and one that does not — the same
// pair the time-travel suite uses, so the two guards describe one world.
const RANGED = "tools.breaker";
const NOT_RANGED = "run.compose";
const TTL = 50; // short enough that a test can step past it without waiting

const realFetch = globalThis.fetch;

/** Every URL asked for, in order. */
let requested: string[] = [];
/** Resolvers for in-flight requests, so a test can hold the wire open. */
let release: Array<(body: unknown, etag?: string) => void> = [];

function envelope(data: unknown, etag: string): Response {
  return new Response(
    JSON.stringify({ data, meta: { etag, asOf: 1_700_000_000_000 } }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

/** A fetch that ANSWERS IMMEDIATELY with a body derived from the URL. */
function instantFetch(body: (url: string) => unknown, etag = 'W/"a"'): void {
  globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : String(input);
    requested.push(url);
    return Promise.resolve(envelope(body(url), etag));
  }) as unknown as typeof fetch;
}

/** A fetch that HANGS until the test releases it — the only way to prove a
 *  read resolved WITHOUT waiting on the wire. */
function heldFetch(): void {
  globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
    requested.push(typeof input === "string" ? input : String(input));
    return new Promise<Response>((resolve) => {
      release.push((body, etag = 'W/"b"') => resolve(envelope(body, etag)));
    });
  }) as unknown as typeof fetch;
}

/** A fetch that always fails — a hiccup, not an answer. */
function failingFetch(): void {
  globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
    requested.push(typeof input === "string" ? input : String(input));
    return Promise.reject(new TypeError("network down"));
  }) as unknown as typeof fetch;
}

/** Let every pending microtask settle. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
/** Step past a TTL of `TTL` ms. */
const age = (): Promise<void> => new Promise((r) => setTimeout(r, TTL + 10));

beforeEach(() => {
  requested = [];
  release = [];
  returnToLive();
  clearCache();
  clearProvenance();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  returnToLive();
  clearCache();
  vi.restoreAllMocks();
});

// ── A. STALE-WHILE-REVALIDATE ──────────────────────────────────────────────

describe("A. a known value is served without waiting for the network", () => {
  test("fresh: served from cache, no request at all", async () => {
    instantFetch(() => ({ n: 1 }));
    await read(RANGED, { params: { chatId: "c1" }, ttlMs: 60_000 });
    expect(requested).toHaveLength(1);
    await read(RANGED, { params: { chatId: "c1" }, ttlMs: 60_000 });
    expect(requested).toHaveLength(1);
  });

  // MUTATION (required): a surface that BLANKS on reopen, or a read that
  // awaits the wire for something it already holds, must fail here.
  test("mutation — a stale value resolves BEFORE the wire answers", async () => {
    instantFetch(() => ({ n: 1 }));
    const first = await read<{ n: number }>(RANGED, { params: { chatId: "c1" }, ttlMs: TTL });
    expect(first.n).toBe(1);
    await age();

    // From here the wire HANGS. A fetch-or-cached fork would deadlock this
    // await; stale-while-revalidate answers from what it knows.
    heldFetch();
    const second = await read<{ n: number }>(RANGED, { params: { chatId: "c1" }, ttlMs: TTL });
    expect(second.n).toBe(1); // the last-known value, immediately
    expect(release).toHaveLength(1); // …and the revalidation IS open underneath

    release[0]!({ n: 2 }, 'W/"b"');
    await settle();
    const third = await read<{ n: number }>(RANGED, { params: { chatId: "c1" }, ttlMs: TTL });
    expect(third.n).toBe(2); // the fresh answer landed in the cache
  });

  test("concurrent readers of a stale key open ONE revalidation, not two", async () => {
    instantFetch(() => ({ n: 1 }));
    await read(RANGED, { params: { chatId: "c1" }, ttlMs: TTL });
    await age();
    heldFetch();
    await Promise.all([
      read(RANGED, { params: { chatId: "c1" }, ttlMs: TTL }),
      read(RANGED, { params: { chatId: "c1" }, ttlMs: TTL }),
      read(RANGED, { params: { chatId: "c1" }, ttlMs: TTL }),
    ]);
    expect(release).toHaveLength(1);
  });

  test("ttlMs 0 opts out — a value with no lifetime has no valid last-known", async () => {
    instantFetch(() => ({ n: 1 }));
    await read(RANGED, { params: { chatId: "c1" }, ttlMs: 0 });
    await read(RANGED, { params: { chatId: "c1" }, ttlMs: 0 });
    expect(requested).toHaveLength(2);
  });

  test("force still awaits the wire — a read-back must see the world after the act", async () => {
    instantFetch((url) => ({ url }));
    await read(RANGED, { params: { chatId: "c1" }, ttlMs: 60_000 });
    heldFetch();
    let settled = false;
    const pending = read(RANGED, { params: { chatId: "c1" }, ttlMs: 60_000, force: true }).then(
      (v) => {
        settled = true;
        return v;
      },
    );
    await settle();
    expect(settled).toBe(false); // it is genuinely waiting
    release[0]!({ url: "after-the-act" });
    await pending;
    expect(settled).toBe(true);
  });
});

// ── B. PATCH, DO NOT REPLACE ───────────────────────────────────────────────

describe("B. fresh bytes notify only when they differ", () => {
  test("a CHANGED payload patches subscribers with the new value", async () => {
    instantFetch(() => ({ n: 1 }), 'W/"1"');
    await read(RANGED, { params: { chatId: "c1" }, ttlMs: TTL });
    const key = readKey(RANGED, { chatId: "c1" });

    const patched = vi.fn();
    const stop = onFreshRead(key, patched);
    await age();
    instantFetch(() => ({ n: 2 }), 'W/"2"');
    await read(RANGED, { params: { chatId: "c1" }, ttlMs: TTL });
    await settle();

    expect(patched).toHaveBeenCalledTimes(1);
    expect(patched.mock.calls[0]![0]).toEqual({ n: 2 });
    stop();
  });

  // MUTATION (required): a patch that re-renders unconditionally — i.e. fires
  // on an UNCHANGED answer — must fail. This is the no-flash guarantee.
  test("mutation — an UNCHANGED payload notifies nobody", async () => {
    instantFetch(() => ({ n: 1 }), 'W/"same"');
    await read(RANGED, { params: { chatId: "c1" }, ttlMs: TTL });
    const key = readKey(RANGED, { chatId: "c1" });

    const patched = vi.fn();
    const stop = onFreshRead(key, patched);
    await age();
    await read(RANGED, { params: { chatId: "c1" }, ttlMs: TTL });
    await settle();

    expect(requested).toHaveLength(2); // it DID revalidate
    expect(patched).not.toHaveBeenCalled(); // …and changed nothing on screen
    stop();
  });

  test("unsubscribing stops the patches (mutation check on the subscription)", async () => {
    instantFetch(() => ({ n: 1 }), 'W/"1"');
    await read(RANGED, { params: { chatId: "c1" }, ttlMs: TTL });
    const patched = vi.fn();
    onFreshRead(readKey(RANGED, { chatId: "c1" }), patched)();
    await age();
    instantFetch(() => ({ n: 2 }), 'W/"2"');
    await read(RANGED, { params: { chatId: "c1" }, ttlMs: TTL });
    await settle();
    expect(patched).not.toHaveBeenCalled();
  });

  test("a past-view key and a live key are separate subscriptions", async () => {
    const liveKey = readKey(RANGED, { chatId: "c1" });
    plantHead(1_700_000_000_000);
    const pastKey = readKey(RANGED, { chatId: "c1" });
    returnToLive();
    expect(pastKey).not.toBe(liveKey);

    const liveWatcher = vi.fn();
    const stop = onFreshRead(liveKey, liveWatcher);
    instantFetch(() => ({ n: 9 }), 'W/"p"');
    plantHead(1_700_000_000_000);
    await read(RANGED, { params: { chatId: "c1" }, ttlMs: TTL });
    await settle();
    // The past read landed under the past key; the live watcher is untouched.
    expect(liveWatcher).not.toHaveBeenCalled();
    stop();
  });
});

// ── C. NEVER BLANK WHAT YOU KNOW ───────────────────────────────────────────

describe("C. a failed revalidation leaves the last-known value standing", () => {
  // MUTATION (required): dropping the cache on a failed read must fail here.
  test("mutation — the value survives the failure, and the failure is recorded", async () => {
    instantFetch(() => ({ n: 1 }), 'W/"1"');
    await read(RANGED, { params: { chatId: "c1" }, ttlMs: TTL });
    const key = readKey(RANGED, { chatId: "c1" });
    await age();

    failingFetch();
    const during = await read<{ n: number }>(RANGED, { params: { chatId: "c1" }, ttlMs: TTL });
    expect(during.n).toBe(1);
    await settle();

    // The failure is not hidden: it is in the provenance ledger, which is
    // exactly what LENS reads out.
    expect(provenanceFor(key)?.cacheState).toBe("failed");

    // …and the value is still known. A read that returns it is the proof the
    // cache was NOT dropped: the wire is still failing, so a dropped entry
    // would reject here instead.
    await expect(
      read<{ n: number }>(RANGED, { params: { chatId: "c1" }, ttlMs: TTL }),
    ).resolves.toEqual({ n: 1 });
  });

  test("a background failure never rejects the caller's read", async () => {
    instantFetch(() => ({ n: 1 }), 'W/"1"');
    await read(RANGED, { params: { chatId: "c1" }, ttlMs: TTL });
    await age();
    failingFetch();
    await expect(read(RANGED, { params: { chatId: "c1" }, ttlMs: TTL })).resolves.toEqual({ n: 1 });
  });
});

// ── D. FIRST-EVER LOAD IS STILL ABSENCE-FIRST ──────────────────────────────

describe("D. nothing known means nothing shown", () => {
  test("a first-ever read with no cache REJECTS rather than inventing a value", async () => {
    failingFetch();
    const err = await read(NOT_RANGED, { params: { chatId: "cold" }, ttlMs: TTL }).catch(
      (e: unknown) => e,
    );
    // The transport failure reaches the caller unchanged — the surface renders
    // it as an honest absence, because there is genuinely nothing to show.
    expect(err).toBeInstanceOf(ClientError);
    expect((err as ClientError).code).toBe("network");
    expect(readMeta(cacheKey(NOT_RANGED, { chatId: "cold" }))).toBeUndefined();
  });

  test("readMeta names no meta for a key nothing has read — no pre-seeding", () => {
    expect(readMeta(cacheKey(RANGED, { chatId: "never" }))).toBeUndefined();
  });

  test("the age a surface displays is the SERVER's asOf, never the moment of receipt", async () => {
    instantFetch(() => ({ n: 1 }), 'W/"1"');
    await read(RANGED, { params: { chatId: "c1" }, ttlMs: 60_000 });
    const meta = readMeta(readKey(RANGED, { chatId: "c1" }));
    // A cached hit an hour from now still reports THIS instant, because the
    // envelope says so. Stamping Date.now() would be a true value under a
    // false timestamp — the fabrication class, arrived at by accident.
    expect(meta?.asOf).toBe(1_700_000_000_000);
  });
});

// ── E. WARM ON INTENT ──────────────────────────────────────────────────────

describe("E. warming asks for exactly the key the open would use", () => {
  beforeEach(() => {
    currentChatId.set("c1");
    projects.set([
      { id: "p1", name: "p", path: "/p", createdAt: "2026-01-01", updatedAt: "2026-01-01" },
    ] as never);
    selectProject("p1");
  });

  test("a grip's plan is derived from the target it fires — it cannot warm another room", () => {
    expect(planForTarget("switch")).toBe(WARM_PLANS.switch);
    expect(planForTarget("custody")).toBe(WARM_PLANS.custody);
    expect(planForTarget("desk")).toBe(deskWarmPlan);
    // A target with nothing to warm says so, rather than guessing.
    expect(planForTarget("lens")).toBeNull();
    expect(planForTarget("instruments")).toBeNull();
  });

  test("warming the switch opens its two per-reel reads for the OPEN conversation", async () => {
    instantFetch(() => ({ ok: true }));
    warmRoom("switch");
    await settle();
    expect(requested.some((u) => u.includes("synthesis.conversationPulse"))).toBe(true);
    expect(requested.some((u) => u.includes("sweep.spectrum") && u.includes("bins=64"))).toBe(true);
    for (const url of requested) expect(url).toContain("chatId=c1");
  });

  /**
   * DRIFT GUARD. The plans live in the shell rather than in each feed, because
   * a feed module only loads when its room loads — which is exactly the moment
   * warming was supposed to have already happened. The cost of that choice is
   * that the shell now names blocks it does not own, so this asserts the name
   * still appears in the feed that reads it. A feed that renames or drops a
   * read leaves the shell warming a key nobody will ever look at, which is a
   * request bought for nothing and a room that stays cold while claiming not
   * to be.
   */
  test("every warmed block is still read by the feed it claims to warm", () => {
    const FEED_OF: Readonly<Record<string, string>> = {
      switch: "src/cockpit/rooms/switch-feed.ts",
      custody: "src/cockpit/rooms/custody-feed.ts",
    };
    for (const [room, plan] of Object.entries(WARM_PLANS)) {
      const source = readFileSync(FEED_OF[room]!, "utf8");
      const blocks = plan!().map((t) => t.block);
      expect(blocks.length).toBeGreaterThan(0);
      for (const block of blocks) expect(source).toContain(`"${block}"`);
    }
    // The desk's opener is not a room, but it makes the same claim.
    const deskSource = readFileSync("src/cockpit/desk/desk-feed.ts", "utf8");
    for (const t of deskWarmPlan()) expect(deskSource).toContain(`"${t.block}"`);
  });

  /**
   * A SPECULATIVE READ MAY BE CHEAP, OR IT MAY BE WANTED — IT MAY NOT BE
   * NEITHER. (DESIGN-PERFORMANCE §6 item 7.)
   *
   * `warmAtIdle` fires just after reveal, for rooms nobody has opened. Two
   * different things make that defensible, and a warmed read has to be one of
   * them:
   *
   *   - SOMETHING CONSUMES IT WITH THE ROOM CLOSED, so the warm only moves
   *     work that was going to happen anyway; or
   *   - IT IS CHEAP — its server handler touches the DB and nothing else.
   *
   * A read that is neither is the failure this rule exists for: work bought
   * for nobody, and — because every git and filesystem touch is synchronous —
   * work that blocks every unrelated request while it runs. Measured:
   * `/api/health` p50 1.31ms and **max 4,814ms** with one heavy custody read
   * in flight, on a 5s TTL against a read costing 4,336ms at scale. The
   * prefetch was usually stale before anyone could have used it.
   *
   * `custody.history` was exactly that: ~24 sequential blocking `git` spawns
   * for a room nobody had opened, read by `CustodyRoom.svelte` and by nothing
   * else. `custody.state` survives the rule on the first clause (the Switch's
   * reel badges read it closed, through `custodyChatCounts`); the Switch's own
   * two reads survive on the second (no subprocess anywhere on their handlers).
   *
   * Both clauses are DERIVED, not listed: the consumer side by scanning the
   * cockpit for the store the feed fills, the cost side by scanning the block's
   * own server definition for a subprocess. If saved history ever gains a
   * second consumer, or a Switch read ever grows a git call, this turns red
   * and the decision gets made again instead of quietly outliving its reason.
   */
  const SUBPROCESS_CALLS = ["gitText(", "spawnSync(", "execFileSync(", "getGitStatus(", "getLog("];

  /** The source of one block's `defineBlock({ id: "<id>" … })` region. */
  function blockDefinition(blockId: string): string {
    for (const file of walk("server/blocks", { exts: [".ts"] })) {
      const src = readSource(file);
      const at = src.indexOf(`id: "${blockId}"`);
      if (at === -1) continue;
      const next = src.indexOf("defineBlock({", at);
      return src.slice(at, next === -1 ? src.length : next);
    }
    return "";
  }

  /** Cockpit sources — other than the room itself and the feeds, which read
   * everything — that name this symbol. */
  function consumersOutside(symbol: string, room: string): string[] {
    return walk("src/cockpit", { exts: [".ts", ".svelte"] })
      .map(relpath)
      .filter((f) => f !== room && !f.endsWith("-feed.ts"))
      .filter((f) => new RegExp(`\\b${symbol}\\b`).test(readSource(f)));
  }

  test("every warmed read is either wanted with the room closed, or cheap", () => {
    // store: what the feed fills from this read. room: the component that
    // owns the room, excluded from the consumer scan.
    const WARMED: Readonly<Record<string, Readonly<{ store: string; room: string }>>> = {
      "custody.state": { store: "custodyChatCounts", room: "src/cockpit/rooms/CustodyRoom.svelte" },
      "synthesis.conversationPulse": { store: "outcomeStates", room: "src/cockpit/rooms/SwitchRoom.svelte" },
      "sweep.spectrum": { store: "densityStates", room: "src/cockpit/rooms/SwitchRoom.svelte" },
    };
    for (const [room, plan] of Object.entries(WARM_PLANS)) {
      for (const target of plan!()) {
        const entry = WARMED[target.block];
        expect(entry, `${room} warms "${target.block}" but nothing here describes it`).toBeDefined();
        const definition = blockDefinition(target.block);
        expect(definition.length, `${target.block} must have a server definition`).toBeGreaterThan(0);
        const spawns = SUBPROCESS_CALLS.filter((c) => definition.includes(c));
        const wantedClosed = consumersOutside(entry!.store, entry!.room).length > 0;
        expect(
          wantedClosed || spawns.length === 0,
          `"${target.block}" is warmed at idle for a closed room, nothing outside ` +
            `${entry!.room} reads it, and its handler spawns subprocesses (${spawns.join(", ")}) — ` +
            "a request bought for nobody that blocks every other request while it runs",
        ).toBe(true);
      }
    }
  });

  test("custody.history is NOT warmed — room-only reader AND a subprocess scan", () => {
    const warmed = WARM_PLANS.custody!().map((t) => t.block);
    expect(
      warmed,
      "saved history is ~24 sequential blocking git spawns for a room nobody opened",
    ).not.toContain("custody.history");
    expect(warmed, "the state read stays — the Switch's badges consume it closed").toContain(
      "custody.state",
    );
    // Both halves of the reason, checked rather than asserted.
    expect(
      consumersOutside("custodyHistories", "src/cockpit/rooms/CustodyRoom.svelte"),
      "if saved history gains a second consumer, warming it becomes arguable again",
    ).toEqual([]);
    expect(
      SUBPROCESS_CALLS.filter((c) => blockDefinition("custody.history").includes(c)).length,
    ).toBeGreaterThan(0);
    // And the room really does ask for it on open, so the omission is not a
    // feature deletion wearing a performance hat.
    expect(readSource("src/cockpit/rooms/CustodyRoom.svelte")).toMatch(/requestCustodyHistory\(/);
  });

  test("an unresolved parameter warms NOTHING rather than warming the wrong row", async () => {
    currentChatId.set(null);
    instantFetch(() => ({ ok: true }));
    warmRoom("switch");
    await settle();
    expect(requested).toHaveLength(0);
  });

  test("a warm no-ops on a fresh entry — hovering ten times costs one request", async () => {
    instantFetch(() => ({ ok: true }));
    warmRoom("switch");
    await settle();
    const after = requested.length;
    for (let i = 0; i < 10; i++) warmRoom("switch");
    await settle();
    expect(requested).toHaveLength(after);
  });

  // MUTATION (required): a prefetch that ignores a planted head must fail.
  test("mutation — during a past view, warming a block that cannot answer asks NOTHING", async () => {
    instantFetch(() => ({ ok: true }));
    plantHead(1_700_000_000_000);
    // `run.compose` is not ranged: the open itself would be REFUSED, so the
    // warm must not quietly fetch the live answer and cache it where the past
    // read would look. (`prefetch` resolves the head exactly as `read` does.)
    prefetch(NOT_RANGED, { params: { chatId: "c1" }, ttlMs: TTL });
    await settle();
    expect(requested).toHaveLength(0);
  });

  test("during a past view, a RANGED warm carries the head — the same key the open would use", async () => {
    instantFetch(() => ({ ok: true }));
    const head = 1_700_000_000_000;
    plantHead(head);
    prefetch(RANGED, { params: { chatId: "c1" }, ttlMs: TTL });
    await settle();
    expect(requested).toHaveLength(1);
    expect(requested[0]).toContain(`until=${head}`);
    // …and the open now costs nothing, because the warm filled the same entry.
    const before = requested.length;
    await read(RANGED, { params: { chatId: "c1" }, ttlMs: TTL });
    expect(requested).toHaveLength(before);
  });
});

// ── F. QUIET WHEN HIDDEN ───────────────────────────────────────────────────

describe("F. a kept-alive surface holds its feed only while it is on screen", () => {
  let unbind: (() => void) | null = null;

  beforeEach(() => {
    unbind = bindShellVisibility();
  });
  afterEach(() => {
    unbind?.();
    unbind = null;
  });

  test("held while visible, released while hidden, re-taken on return", () => {
    const releases = vi.fn();
    const acquire = vi.fn(() => releases);
    const stop = whileRoomVisible("instruments", acquire);

    expect(acquire).toHaveBeenCalledTimes(0); // no room open yet
    setVisibleRoom("instruments");
    expect(acquire).toHaveBeenCalledTimes(1);
    setVisibleRoom(null);
    expect(releases).toHaveBeenCalledTimes(1);
    setVisibleRoom("instruments");
    expect(acquire).toHaveBeenCalledTimes(2);
    stop();
    expect(releases).toHaveBeenCalledTimes(2); // teardown releases too
  });

  test("another room being shown hides this one", () => {
    const releases = vi.fn();
    const stop = whileRoomVisible("instruments", () => releases);
    setVisibleRoom("instruments");
    setVisibleRoom("switch");
    expect(releases).toHaveBeenCalledTimes(1);
    stop();
  });

  test("re-publishing the SAME room does not release and re-acquire", () => {
    const acquire = vi.fn(() => () => undefined);
    const stop = whileRoomVisible("switch", acquire);
    setVisibleRoom("switch");
    setVisibleRoom("switch");
    setVisibleRoom("switch");
    expect(acquire).toHaveBeenCalledTimes(1);
    stop();
  });

  test("the flow's mirror: held whenever NO room covers it", () => {
    const releases = vi.fn();
    const acquire = vi.fn(() => releases);
    const stop = whileFlowVisible(acquire);
    expect(acquire).toHaveBeenCalledTimes(1); // nothing open — the flow is on screen
    setVisibleRoom("switch");
    expect(releases).toHaveBeenCalledTimes(1);
    setVisibleRoom(null);
    expect(acquire).toHaveBeenCalledTimes(2);
    stop();
  });

  test("with NO shell mounted, a surface counts as visible — it is testable alone", () => {
    unbind?.();
    unbind = null;
    const acquire = vi.fn(() => () => undefined);
    const stop = whileRoomVisible("custody", acquire);
    expect(acquire).toHaveBeenCalledTimes(1);
    stop();
  });
});

// ── G. THE IDLE FILL ───────────────────────────────────────────────────────

describe("G. the idle fill is ordered by measurement and cannot move a pixel", () => {
  beforeEach(() => {
    resetRoomActivations();
  });
  afterEach(() => {
    resetRoomActivations();
  });

  test("with no history, the order is the DECLARED static one — never invented", () => {
    expect(roomWarmOrder()).toEqual([...STATIC_WARM_ORDER]);
  });

  test("the user's own opens reorder it; counts are never seeded", () => {
    recordRoomActivation("custody");
    recordRoomActivation("custody");
    recordRoomActivation("switch");
    expect(roomWarmOrder()[0]).toBe("custody");
    recordRoomActivation("switch");
    recordRoomActivation("switch");
    expect(roomWarmOrder()[0]).toBe("switch");
  });

  test("only rooms with something to warm are ordered — the rest are absent, deliberately", () => {
    for (const id of roomWarmOrder()) expect(WARM_PLANS[id]).toBeDefined();
    // Instruments and settings open from the boot-loaded schema store; a warm
    // for them would be a request that buys nothing.
    expect(WARM_PLANS.instruments).toBeUndefined();
    expect(WARM_PLANS.settings).toBeUndefined();
  });

  test("ZERO LAYOUT CHANGE is structural: warming touches the cache and nothing else", async () => {
    currentChatId.set("c1");
    instantFetch(() => ({ ok: true }));
    // The proof is that the ONLY observable effect of a warm is a cache entry.
    // There is no render path out of `prefetch`, which is why the post-reveal
    // idle fill cannot break the one-reveal law (§10.3).
    const key = readKey("synthesis.conversationPulse", { chatId: "c1" });
    expect(readMeta(key)).toBeUndefined();
    warmRoom("switch");
    await settle();
    expect(readMeta(key)).toBeDefined();
  });
});

// ── H. THE FEEDS: KEEP THE LAST VALUES ─────────────────────────────────────

/**
 * The Broker can only serve what a feed is willing to display. These are the
 * surface-side half of the same law: a feed that answered its own failure by
 * wiping the store would blank the screen no matter how warm the cache is.
 *
 * The distinction each of these draws is the one that matters: a failed
 * ANSWER to the same question keeps what is on screen; a CHANGED question
 * clears it, because the pixels would otherwise answer something nobody asked.
 */
describe("H. a feed never un-measures what it measured", () => {
  // The per-feed halves of this law live beside their subjects, where the real
  // payload fixtures are: switch-feed.test.ts, desk-feed.test.ts and
  // sweep-spectrum-load.test.ts each carry a "keeps what it measured" guard.
  test("instruments — releasing the feed stops the poll and clears NOTHING", async () => {
    const feed = await import("../../src/cockpit/rooms/instruments-feed.ts");
    feed.resetInstrumentsFeed();
    let polls = 0;
    feed.setInstrumentsReader({
      values: async () => {
        polls += 1;
        return {};
      },
    });
    // Ingest one snapshot the way a landed poll does.
    feed.bindInstrumentsIngest();
    const release = feed.acquireInstrumentsFeed();
    await settle();
    expect(polls).toBeGreaterThan(0);
    expect(feed.feedRunning()).toBe(true);

    const { uiSchemaValues } = await import("../../src/state/schema-store.ts");
    uiSchemaValues.set({ signals: [{ id: "s1", value: 7 }] } as never);
    expect(feed.signalCurrent.get()["s1"]?.v).toBe(7);

    release();
    // MUTATION: a feed that cleared its stores on release would blank all 112
    // cells on the next open — the cold start keep-alive exists to remove.
    expect(feed.feedRunning()).toBe(false);
    expect(feed.signalCurrent.get()["s1"]?.v).toBe(7);
    feed.resetInstrumentsFeed();
  });

});
