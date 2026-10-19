// @vitest-environment node
/**
 * THE SWITCH — session feeds (spec §5.2): absence-first states, refusal
 * rendered as absence (never an error wall), once-per-session chat loads
 * with failed-only retry, idempotent per-reel reads, and the concurrency
 * cap (never a 90-request stampede). Readers are injected — no network.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  FEED_CONCURRENCY,
  chatsStates,
  densityStates,
  ensureChats,
  feedActiveCount,
  feedChanges,
  outcomeStates,
  requestReelData,
  resetSwitchFeed,
  revalidateReels,
  setSwitchReaders,
} from "../../src/cockpit/rooms/switch-feed.ts";
import { ClientError } from "../../src/data/errors.ts";

const PULSE = {
  runs: { known: 2, withEvents: 2 },
  filesTouched: { status: "measured", value: { distinctPaths: 4 }, derivation: "t" },
  errors: { status: "measured", value: { eventsWithErrorDetail: 0, failedOutcomes: 0 }, derivation: "t" },
  wallTimeSpan: {
    status: "measured",
    value: { firstEventAt: "2026-07-25T14:00:00.000Z", lastEventAt: "2026-07-25T15:00:00.000Z", events: 12 },
    derivation: "t",
  },
};

function spectrumWire(events: number): unknown {
  const cats = ["x"] as const;
  const bins = 2;
  const flat = new Int16Array([events, 0, 0, 0]); // 1 cat row + error row
  return {
    header: {
      categories: cats, errorRow: 1, errorRowIsOverlay: true, rows: 2, bins,
      binMs: 500, t0: events > 0 ? 0 : null, t1: events > 0 ? 1000 : null,
      events, unbinnable: 0, attributedOnly: true, clamped: false,
    },
    packed: Buffer.from(flat.buffer).toString("base64"),
  };
}

const EMPTY_SPECTRUM = {
  header: {
    categories: ["x"], errorRow: 1, errorRowIsOverlay: true, rows: 2, bins: 0,
    binMs: 0, t0: null, t1: null, events: 0, unbinnable: 0,
    attributedOnly: true, clamped: false,
  },
  packed: "",
};

beforeEach(() => resetSwitchFeed());
afterEach(() => resetSwitchFeed());

describe("per-reel data — pending → measured, absence-first", () => {
  test("a real pulse and spectrum land as measured states", async () => {
    const pulse = vi.fn(async () => PULSE);
    const spectrum = vi.fn(async () => spectrumWire(3));
    setSwitchReaders({ pulse, spectrum });

    requestReelData("c1");
    expect(outcomeStates.get("c1")).toEqual({ kind: "pending" });
    expect(densityStates.get("c1")).toEqual({ kind: "pending" });

    await vi.waitFor(() => {
      expect(outcomeStates.get("c1")!.kind).toBe("measured");
      expect(densityStates.get("c1")!.kind).toBe("measured");
    });
    const outcome = outcomeStates.get("c1")!;
    expect(outcome).toMatchObject({ line: "2 runs · 4 files · no errors" });
  });

  test("idempotent: a second request does not re-read", async () => {
    const pulse = vi.fn(async () => PULSE);
    const spectrum = vi.fn(async () => spectrumWire(3));
    setSwitchReaders({ pulse, spectrum });
    requestReelData("c1");
    requestReelData("c1");
    await vi.waitFor(() => expect(outcomeStates.get("c1")!.kind).toBe("measured"));
    requestReelData("c1");
    expect(pulse).toHaveBeenCalledTimes(1);
    expect(spectrum).toHaveBeenCalledTimes(1);
  });

  test("an EMPTY spectrum is the honest blank, not an error", async () => {
    setSwitchReaders({ pulse: async () => PULSE, spectrum: async () => EMPTY_SPECTRUM });
    requestReelData("c1");
    await vi.waitFor(() =>
      expect(densityStates.get("c1")).toEqual({ kind: "absent", reason: "no events recorded" }),
    );
  });

  test("refusals render as absence in plain words (403/404/other)", async () => {
    setSwitchReaders({
      pulse: async () => {
        throw new ClientError("forbidden", "no", 403);
      },
      spectrum: async () => {
        throw new ClientError("not_found", "no", 404);
      },
    });
    requestReelData("c1");
    await vi.waitFor(() => {
      expect(outcomeStates.get("c1")).toEqual({
        kind: "absent",
        reason: "not available to this session",
      });
      expect(densityStates.get("c1")).toEqual({ kind: "absent", reason: "no recorded history" });
    });

    setSwitchReaders({
      pulse: async () => {
        throw new Error("boom");
      },
      spectrum: async () => spectrumWire(1),
    });
    requestReelData("c2");
    await vi.waitFor(() =>
      expect(outcomeStates.get("c2")).toEqual({ kind: "absent", reason: "not available right now" }),
    );
  });

  test("a spectrum that lies about itself becomes absence, never painted", async () => {
    setSwitchReaders({
      pulse: async () => PULSE,
      spectrum: async () => ({ header: { errorRowIsOverlay: false }, packed: "" }),
    });
    requestReelData("c1");
    await vi.waitFor(() =>
      expect(densityStates.get("c1")).toEqual({ kind: "absent", reason: "not available right now" }),
    );
  });
});

describe("chats per project — once per session, failed-only retry", () => {
  test("pending → loaded; a second ensure does not refetch", async () => {
    const chats = vi.fn(async () => []);
    setSwitchReaders({ chats });
    ensureChats(["p1", "p2"]);
    expect(Object.fromEntries(chatsStates)).toEqual({ p1: "pending", p2: "pending" });
    await vi.waitFor(() => expect(Object.fromEntries(chatsStates)).toEqual({ p1: "loaded", p2: "loaded" }));
    ensureChats(["p1", "p2"]);
    expect(chats).toHaveBeenCalledTimes(2);
  });

  test("a large population publishes pending once and keeps completion work local through the whole queue", async () => {
    const population = Array.from({ length: 5_000 }, (_, i) => `bulk-${i}`);
    const chats = vi.fn(async (_id: string) => [] as readonly unknown[]);
    setSwitchReaders({ chats });
    const emissions: number[] = [];
    const completed = new Set<string>();
    const unsubscribe = feedChanges.listen(change => {
      if (change.kind !== "chats") return;
      emissions.push(change.ids.length);
      for (const id of change.ids) if (chatsStates.get(id) === "loaded") completed.add(id);
    });
    let scans = 0;
    const iterator = Map.prototype[Symbol.iterator];
    const observe = vi.spyOn(Map.prototype, Symbol.iterator).mockImplementation(function (this: Map<unknown, unknown>) {
      if (this === chatsStates) scans++;
      return iterator.call(this);
    });
    let shiftedReaders = 0;
    const originalShift = Array.prototype.shift;
    // A Vitest spy itself consumes its mock-once queue with shift; observe
    // the native boundary directly so the observer cannot recurse on itself.
    Array.prototype.shift = new Proxy(originalShift, {
      apply(target, receiver: unknown[], args) {
        if (typeof receiver[0] === "function") shiftedReaders += receiver.length;
        return Reflect.apply(target, receiver, args);
      },
    });
    try {
      ensureChats(population);
      expect(emissions).toEqual([5000]);
      await vi.waitFor(() => expect(completed.size).toBe(5000));
      expect(chats).toHaveBeenCalledTimes(5000);
      expect(emissions).toHaveLength(5001);
      expect(emissions.slice(1).every(count => count === 1)).toBe(true);
      expect(scans, "a completion must not copy/iterate the containing feed Map").toBe(0);
      expect(shiftedReaders, "the full reader queue must not shift its remaining population").toBe(0);
      expect(chatsStates.size).toBe(5000);
      for (const id of population) expect(chatsStates.get(id)).toBe("loaded");
    } finally { Array.prototype.shift = originalShift; observe.mockRestore(); unsubscribe(); }
  });

  test("a failed project retries on the next ensure; loaded ones do not", async () => {
    let failP2 = true;
    const chats = vi.fn(async (id: string) => {
      if (id === "p2" && failP2) throw new Error("down");
      return [];
    });
    setSwitchReaders({ chats });
    ensureChats(["p1", "p2"]);
    await vi.waitFor(() => expect(Object.fromEntries(chatsStates)).toEqual({ p1: "loaded", p2: "failed" }));
    failP2 = false;
    ensureChats(["p1", "p2"]);
    await vi.waitFor(() => expect(Object.fromEntries(chatsStates)).toEqual({ p1: "loaded", p2: "loaded" }));
    expect(chats.mock.calls.filter(([id]) => id === "p1")).toHaveLength(1);
    expect(chats.mock.calls.filter(([id]) => id === "p2")).toHaveLength(2);
  });
});

describe("the concurrency cap — never a request stampede", () => {
  test(`at most ${FEED_CONCURRENCY} reads are in flight`, async () => {
    let open = 0;
    let peak = 0;
    const resolvers: Array<() => void> = [];
    const gate = () =>
      new Promise<unknown>((resolve) => {
        open += 1;
        peak = Math.max(peak, open);
        resolvers.push(() => {
          open -= 1;
          resolve(PULSE);
        });
      });
    setSwitchReaders({ pulse: gate, spectrum: async () => spectrumWire(1) });

    for (let i = 0; i < 20; i += 1) requestReelData(`c${i}`);
    await vi.waitFor(() => expect(feedActiveCount()).toBeGreaterThan(0));
    expect(feedActiveCount()).toBeLessThanOrEqual(FEED_CONCURRENCY);

    while (resolvers.length > 0 || open > 0) {
      resolvers.splice(0).forEach((r) => r());
      await new Promise((r) => setTimeout(r, 0));
    }
    await vi.waitFor(() => {
      for (let i = 0; i < 20; i += 1) {
        expect(outcomeStates.get(`c${i}`)!.kind).toBe("measured");
      }
    });
    expect(peak).toBeLessThanOrEqual(FEED_CONCURRENCY);
  });
});

/**
 * REVALIDATE ON SHOW, NEVER BLANK ON FAILURE.
 *
 * The room is kept alive now (shell/RoomHost.svelte): it is hidden on close,
 * not destroyed, so its reels are still on screen when it reopens. That makes
 * two things load-bearing that were not before — the room has to go and CHECK
 * on show, and a check that fails must not take the lines away with it.
 */
describe("warm reels — re-asked on show, never un-measured by a failure", () => {
  test("revalidateReels re-asks for every reel already known", async () => {
    let pulses = 0;
    setSwitchReaders({
      pulse: async () => {
        pulses += 1;
        return PULSE;
      },
      spectrum: async () => spectrumWire(1),
    });
    requestReelData("c1");
    requestReelData("c2");
    await vi.waitFor(() => expect(outcomeStates.get("c2")!.kind).toBe("measured"));
    const before = pulses;

    revalidateReels();
    await vi.waitFor(() => expect(pulses).toBe(before + 2));
    // A plain request is still idempotent — only an explicit revalidation
    // re-asks, so rendering the river does not re-read on every frame.
    requestReelData("c1");
    await new Promise((r) => setTimeout(r, 0));
    expect(pulses).toBe(before + 2);
  });

  // MUTATION (required): a surface that blanks on reopen must fail here.
  test("mutation — a failed revalidation keeps the measured line standing", async () => {
    setSwitchReaders({ pulse: async () => PULSE, spectrum: async () => spectrumWire(1) });
    requestReelData("c1");
    await vi.waitFor(() => expect(outcomeStates.get("c1")!.kind).toBe("measured"));
    const measured = outcomeStates.get("c1");
    const density = densityStates.get("c1");

    setSwitchReaders({
      pulse: async () => {
        throw new ClientError("http_500", "boom", 500);
      },
      spectrum: async () => {
        throw new ClientError("http_500", "boom", 500);
      },
    });
    revalidateReels();
    await new Promise((r) => setTimeout(r, 5));
    // The line and the strip were TRUE when the server said them. A later
    // hiccup does not un-measure them; the Broker logged the failure.
    expect(outcomeStates.get("c1")).toEqual(measured);
    expect(densityStates.get("c1")).toEqual(density);
  });

  test("but a reel that never answered still says so — absence-first survives", async () => {
    setSwitchReaders({
      pulse: async () => {
        throw new ClientError("http_500", "boom", 500);
      },
      spectrum: async () => {
        throw new ClientError("http_500", "boom", 500);
      },
    });
    requestReelData("cold");
    await vi.waitFor(() => expect(outcomeStates.get("cold")!.kind).toBe("absent"));
    expect(densityStates.get("cold")!.kind).toBe("absent");
  });
});


describe("reset preserves concurrency ownership and refuses stale feed results", () => {
  test("old success/failure and queued readers cannot refill a new session", async () => {
    const pending: Array<{ resolve: (value: unknown) => void; reject: (reason: Error) => void }> = [];
    const old = vi.fn(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
    setSwitchReaders({ chats: old });
    ensureChats(["__proto__", "constructor", "never-started"]);
    expect(old).toHaveBeenCalledTimes(2);
    resetSwitchFeed();
    const next = vi.fn(async () => []);
    setSwitchReaders({ chats: next });
    ensureChats(["__proto__", "new"]);
    expect(next).not.toHaveBeenCalled();
    expect(feedActiveCount()).toBe(2);
    pending[0]!.resolve([]);
    pending[1]!.reject(new Error("old failure"));
    await vi.waitFor(() => expect(feedActiveCount()).toBe(0));
    expect(old).toHaveBeenCalledTimes(2);
    expect(next).toHaveBeenCalledTimes(2);
    expect(chatsStates.get("__proto__")).toBe("loaded");
    expect(chatsStates.get("new")).toBe("loaded");
    expect(chatsStates.has("constructor")).toBe(false);
    expect(chatsStates.has("never-started")).toBe(false);
  });

  test("old reel reads cannot publish after reset", async () => {
    const pending: Array<(value: unknown) => void> = [];
    const reader = () => new Promise(resolve => pending.push(resolve));
    setSwitchReaders({ pulse: reader, spectrum: reader });
    requestReelData("old");
    expect(pending).toHaveLength(2);
    resetSwitchFeed();
    pending[0]!(PULSE);
    pending[1]!(spectrumWire(2));
    await vi.waitFor(() => expect(feedActiveCount()).toBe(0));
    expect(outcomeStates.size).toBe(0);
    expect(densityStates.size).toBe(0);
  });
});
