// @vitest-environment node
/**
 * ONE LIVENESS SOCKET PER BROWSER CONTEXT — elected, shared, and inherited.
 *
 * THE DEFECT, MEASURED LIVE (the UIE-044 drives). Chrome holds SIX
 * HTTP/1.1 sockets per origin per browser context. Every logged-in tab used
 * to pin one with its own `/api/live` EventSource for its whole life, so a
 * six-tab session pinned the pool completely: every further request — a
 * steer POST included — queued forever and the broker's 30s timeout killed
 * it with `net::ERR_ABORTED` while the server recorded nothing. Two of three
 * steers died that way in the residual drive that filed UIE-044; the
 * controlled reproduction starved them all, with the aborted observers
 * batched in the same second.
 *
 * WHAT THE FIX PINS, AND EACH ARM IS A DISTINCT WAY TO UNDO IT:
 *
 *   1. ONE SOCKET. Among tabs sharing one context, only the ELECTED one
 *      opens the liveness stream; a later tab waits and opens nothing, and
 *      that is what hands the per-origin pool its slots back to the writes
 *      that starved behind them.
 *   2. HANDOVER. When the leader's document goes away, the browser wakes
 *      one waiting tab and THAT tab opens the stream — the fix survives the
 *      leader closing.
 *   3. THE FOLLOWER SEES THE SAME FACTS. The leader's beats and drops are
 *      applied to the follower's own state machine, so an idle follower —
 *      the exact case the stream exists for — still detects liveness.
 *   4. THE FOLLOWER'S OWN WATCHDOG STANDS. A follower that stops hearing
 *      the leader states slow, asks the server ITSELF, and stays socketless
 *      — it never trusts a silent partner forever.
 *   5. THE FALLBACK IS THE OLD BEHAVIOUR, AND ITS PRECONDITION IS REAL.
 *      `webLivenessShare` answers null outside a browser context — Node 24
 *      ships a LockManager, but a node process has no document whose
 *      destruction could release a lock, so a share elected there would
 *      wedge every later election (measured: 7 connection tests went red
 *      before the precondition existed). With the browser pieces stubbed,
 *      the real BroadcastChannel delivers between two shares in-process.
 *   6. THE ELECTION IS IDEMPOTENT. A watch that restarts inside one tab
 *      cannot double-claim leadership through one share.
 *
 * TEST-SHAPE NOTE, honestly: the connection state atom is per-TAB in the
 * real world and per-MODULE in this process, so the multi-tab arms run one
 * tab's world at a time — `resetConnectionForTest` is the boundary between
 * tab A's world and tab B's, with the fake lock manager carrying the one
 * fact that crosses it: the lock is still held. The follower-state arms use
 * a share that never elects this tab, so the module state is purely the
 * follower's own.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  connection,
  resetConnectionForTest,
  setLivenessBeatMs,
  startLivenessWatch,
  type LivenessPort,
} from "../../src/data/connection.ts";
import {
  soloLivenessShare,
  webLivenessShare,
  type LivenessShare,
  type LivenessSignal,
} from "../../src/data/liveness-share.ts";
import {
  LIVENESS_CHANNEL_NAME,
  LIVENESS_LOCK_NAME,
} from "../../src/client-config.ts";
import { LIVE_STREAM_MISSED_BEATS } from "../../shared/constants.ts";
import { loadChatHistory, startChatRecordWatch } from "../../src/client.ts";
import { onInvalidation } from "../../src/data/broker.ts";
import { clearMessages, setStreaming } from "../../src/state/chat-messages.ts";
import { currentChatId } from "../../src/state/chats.ts";

type Diagnosis =
  | { outcome: "answered" }
  | { outcome: "refused"; retryAfterMs: number }
  | { outcome: "unreached"; elapsedMs: number };

/** A stand-in for `src/client.ts`'s two liveness functions — the same shape
 *  `connection-owner.test.ts` drives, so the two files cannot disagree about
 *  the port contract. */
function fakePort(answers: Diagnosis[]) {
  const record = { opens: 0, diagnoses: 0 };
  let handlers: {
    onAlive: () => void;
    onDown: (i: { retrying: boolean }) => void;
  } | null = null;
  const port: LivenessPort = {
    open: (h) => {
      record.opens += 1;
      handlers = h;
      return () => {};
    },
    diagnose: async (): Promise<Diagnosis> => {
      record.diagnoses += 1;
      return answers[Math.min(record.diagnoses - 1, answers.length - 1)]!;
    },
  };
  return {
    record,
    port,
    beat: () => handlers?.onAlive(),
  };
}

/**
 * The lock manager's half of a multi-tab context, standing in for the Web
 * Locks API. `holdForeign` is the fact that crosses between the sequential
 * tab worlds below: a lock held by a tab whose watch is NOT in this process
 * (the first test's tab A, or any leader at all). The share's broadcast and
 * subscription are REAL wiring over one listener set — the BroadcastChannel's
 * job — so the leader-side broadcast arm has a witness.
 */
function lockWorld() {
  let held = false;
  const listeners = new Set<(signal: LivenessSignal) => void>();
  const openTab = () => {
    let pending: (() => void) | null = null;
    let claimed = false;
    return {
      share: {
        elect(onLeader: () => void): void {
          if (claimed) return; // idempotent per share, like the web share
          claimed = true;
          pending = onLeader;
        },
        broadcast(signal: LivenessSignal): void {
          for (const listener of [...listeners]) listener(signal);
        },
        onSignal(listener: (signal: LivenessSignal) => void): () => void {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      } satisfies LivenessShare,
      /** The manager grants the lock to this tab — at once for the first
       *  asker, never while another tab holds it. */
      acquire(): void {
        if (pending === null || held) return;
        held = true;
        pending();
      },
    };
  };
  return {
    openTab,
    /** The lock is already held by a tab outside this test's process. */
    holdForeign(): void {
      held = true;
    },
    /** The holder's document went away: the manager wakes ONE waiting tab. */
    handover(tab: { acquire: () => void }): void {
      held = false;
      tab.acquire();
    },
  };
}

/** A share that NEVER elects this tab — a pure follower, so the module state
 *  in this process is the follower's own and nothing else writes it. */
function followerShare(): LivenessShare & { signal: (s: LivenessSignal) => void } {
  let listener: ((s: LivenessSignal) => void) | null = null;
  return {
    elect(): void {
      // never elected — the lock is held by another tab
    },
    broadcast(): void {
      // a follower has no audience
    },
    onSignal(cb: (s: LivenessSignal) => void): () => void {
      listener = cb;
      return () => {
        listener = null;
      };
    },
    signal(s: LivenessSignal): void {
      listener?.(s);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  setLivenessBeatMs(100);
});

afterEach(() => {
  resetConnectionForTest();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the one-socket invariant (UIE-044's mechanism arm)", () => {
  test("the first tab to ask is elected at once; a later tab waits and opens NOTHING", async () => {
    const world = lockWorld();

    // TAB A's world: the first asker — the manager grants at once.
    const tabA = world.openTab();
    const watchA = fakePort([{ outcome: "answered" }]);
    startLivenessWatch(watchA.port, { share: tabA.share });
    tabA.acquire();
    expect(watchA.record.opens, "the elected tab holds the socket").toBe(1);

    // TAB B's world (the module singleton makes B's watch replace A's here,
    // which is honest about the one fact that crosses: A still holds).
    resetConnectionForTest();
    const tabB = world.openTab();
    const watchB = fakePort([{ outcome: "answered" }]);
    startLivenessWatch(watchB.port, { share: tabB.share });
    tabB.acquire(); // the manager keeps B waiting — the leader holds the lock
    await vi.advanceTimersByTimeAsync(10_000);
    expect(watchB.record.opens, "a waiting tab opens nothing, however long").toBe(0);
  });

  test("handover: when the leader's document goes away, the woken tab opens the stream", async () => {
    const world = lockWorld();
    world.holdForeign(); // the leader is a tab whose watch is not in this process

    const tabB = world.openTab();
    const watchB = fakePort([{ outcome: "answered" }]);
    startLivenessWatch(watchB.port, { share: tabB.share });
    tabB.acquire(); // waiting
    await vi.advanceTimersByTimeAsync(0);
    expect(watchB.record.opens).toBe(0);

    // The leader closes; the manager wakes the ONE waiting tab.
    world.handover(tabB);
    await vi.advanceTimersByTimeAsync(0);
    expect(watchB.record.opens, "the woken tab takes the socket over").toBe(1);
  });

  test("the leader's beats reach the follower's state machine — an idle follower still detects liveness", () => {
    const follower = followerShare();
    const ownWatch = fakePort([{ outcome: "answered" }]);
    startLivenessWatch(ownWatch.port, { share: follower });

    // The leader (another tab, not in this process) says its stream is
    // alive. The follower's state is the leader's fact, applied locally.
    follower.signal("beat");
    expect(connection.get().kind).toBe("reachable");
  });

  test("a follower that stops hearing the leader asks the server ITSELF — and stays socketless", async () => {
    const follower = followerShare();
    const ownWatch = fakePort([{ outcome: "unreached", elapsedMs: 9 }]);
    startLivenessWatch(ownWatch.port, { share: follower });

    follower.signal("beat");
    expect(connection.get().kind).toBe("reachable");

    // The broadcasts stop — the leader may be gone. The follower's own
    // watchdog, armed by the last broadcast, fires; it diagnoses with its
    // own request rather than trusting the silence, and its verdict is
    // measured (slow → asked → unreachable, anchored at the last beat).
    await vi.advanceTimersByTimeAsync(100 * LIVE_STREAM_MISSED_BEATS + 1);
    expect(ownWatch.record.diagnoses, "the follower asks, it does not assume").toBe(1);
    expect(connection.get().kind, "the follower's verdict is its own measurement").toBe(
      "unreachable",
    );
    expect(ownWatch.record.opens, "still socketless through its own verdict").toBe(0);
  });

  test("the leader's drop reaches the follower: the browser-retrying state, honestly and instantly", () => {
    const follower = followerShare();
    const ownWatch = fakePort([{ outcome: "answered" }]);
    startLivenessWatch(ownWatch.port, { share: follower });

    follower.signal("beat");
    expect(connection.get().kind).toBe("reachable");
    follower.signal("down");
    const s = connection.get();
    expect(s.kind).toBe("unreachable");
    if (s.kind === "unreachable") {
      expect(s.cause).toBe("refused");
      expect(s.elapsedMs).toBe(0); // no elapsed is invented for a shared drop
    }
  });

  test("a follower whose own diagnosis ANSWERS still opens nothing — every connect door is leader-gated", async () => {
    const follower = followerShare();
    const ownWatch = fakePort([{ outcome: "answered" }]);
    startLivenessWatch(ownWatch.port, { share: follower });

    follower.signal("beat");
    expect(connection.get().kind).toBe("reachable");
    // The broadcasts stop; the follower's watchdog asks; the server ANSWERS
    // (busy but alive). On this very path the LEADER re-opens its socket —
    // the follower must not, or the fix is undone from the inside.
    await vi.advanceTimersByTimeAsync(100 * LIVE_STREAM_MISSED_BEATS + 1);
    expect(ownWatch.record.diagnoses, "the follower asked and was answered").toBe(1);
    expect(connection.get().kind).toBe("reachable");
    expect(ownWatch.record.opens, "an answered diagnosis must not open a follower socket").toBe(0);
  });

  test("the leader's own stream beat is BROADCAST — the wire the follower's state rides on", async () => {
    const world = lockWorld();
    const tabA = world.openTab();
    const watchA = fakePort([{ outcome: "answered" }]);
    // A follower's ear on the same share's channel (its own watch lives in
    // another process — the TEST-SHAPE NOTE).
    const heard: LivenessSignal[] = [];
    const stop = tabA.share.onSignal((s) => heard.push(s));

    startLivenessWatch(watchA.port, { share: tabA.share });
    tabA.acquire();
    expect(watchA.record.opens).toBe(1);

    // The server beats on the LEADER's socket: the beat must go out on the
    // channel too, or every follower is deaf and the whole share is a wire
    // that was never connected.
    watchA.beat();
    expect(heard).toEqual(["beat"]);
    stop();
  });
});

describe("the fallback (the honest old behaviour, with a real precondition)", () => {
  test("solo elects immediately, so a tab without the platform pieces keeps its own stream", async () => {
    const watch = fakePort([{ outcome: "answered" }]);
    startLivenessWatch(watch.port, { share: soloLivenessShare() });
    await vi.advanceTimersByTimeAsync(0);
    expect(watch.record.opens).toBe(1);
  });

  test("the election is idempotent per share — a restarted watch cannot double-claim", async () => {
    const share = soloLivenessShare();
    const watch = fakePort([{ outcome: "answered" }]);
    startLivenessWatch(watch.port, { share });
    // A second watch in the same tab with the SAME share is a no-op election.
    startLivenessWatch(watch.port, { share });
    await vi.advanceTimersByTimeAsync(0);
    expect(watch.record.opens).toBe(1);
  });

  test("soloLivenessShare's broadcast and subscription are honest no-ops", () => {
    const share = soloLivenessShare();
    let heard = 0;
    const stop = share.onSignal(() => {
      heard += 1;
    });
    share.broadcast("beat");
    expect(heard).toBe(0); // no audience in a solo world
    stop();
  });

  test("webLivenessShare answers null here: Node 24 HAS a LockManager, but no document whose lifetime could own the lock", () => {
    // The honest precondition, not a test convenience: the lock releases
    // when the holder's DOCUMENT goes away — the browser-context lifetime
    // IS the handover mechanism. A share elected in a process with no
    // document would hold forever and wedge every later election in it
    // (measured: 7 connection tests went red before this precondition
    // existed).
    expect(
      (globalThis as { navigator?: { locks?: unknown } }).navigator?.locks,
    ).toBeDefined();
    expect((globalThis as { window?: unknown }).window).toBeUndefined();
    expect(webLivenessShare(LIVENESS_LOCK_NAME, LIVENESS_CHANNEL_NAME)).toBeNull();
  });

  test("with the browser pieces stubbed, the REAL BroadcastChannel delivers between two shares", async () => {
    // A controlled browser context: window + document + an immediately-
    // granting fake lock manager (a REAL held lock in this process could
    // never release — the very pollution the precondition exists for), over
    // Node's real BroadcastChannel, so the delivery path is the platform's.
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {});
    vi.stubGlobal("navigator", {
      locks: {
        request: (_name: string, cb: (lock: unknown) => Promise<never> | void) => {
          void cb({ name: _name });
          return new Promise<void>(() => undefined);
        },
      },
    });

    const leaderShare = webLivenessShare(LIVENESS_LOCK_NAME, LIVENESS_CHANNEL_NAME);
    const followerShare2 = webLivenessShare(LIVENESS_LOCK_NAME, LIVENESS_CHANNEL_NAME);
    expect(leaderShare).not.toBeNull();
    expect(followerShare2).not.toBeNull();

    let elected = false;
    leaderShare!.elect(() => {
      elected = true;
    });
    expect(elected, "the first asker is granted at once").toBe(true);

    const heard: LivenessSignal[] = [];
    const stop = followerShare2!.onSignal((s) => heard.push(s));
    leaderShare!.broadcast("beat");
    // BroadcastChannel delivery is async to the macrotask queue — advance
    // the fake clock past it (the channel's own delivery is real).
    await vi.advanceTimersByTimeAsync(5);
    expect(heard).toEqual(["beat"]);
    stop();
  });
});

// ── THE FOLLOWER TAB'S STALENESS, HEALED AT ITS OWN DOOR (UIE-052) ─────────
//
// The multi-tab world's standing truth: chat data does NOT converge between
// tabs (cross-tab.ts adopts device state only), so a follower tab that
// rendered a conversation and went to the background shows a stale record
// when it comes back — with nothing saying so. Verified before this fix:
// NOTHING re-reads on tab focus. The honest fix is not background sync but
// a check at the one moment the staleness can matter — the reader returning:
// one chat ROW says whether the record moved; only a record that moved pays
// the re-read, through the SAME loadChatHistory a reload performs (whose
// in-place heal keeps every beat identity, so an unmoved record re-reads
// as a no-op on screen).
//
// ── AND THE HEAL CONVERGES EVERY SURFACE, NOT JUST THE TRANSCRIPT (UIE-053) ─
//
// A record that moved means a run recorded new data, so the heal fires the
// declared `run:done` Broker invalidation — the same door the sweep band's
// spectrum read subscribes to (spectrum-load). The live drive measured the
// gap: a focused follower's transcript healed while the band kept the
// measured-empty sentence for 9+ seconds, because none of the band's own
// triggers fired. The arms below assert the refresh SIGNAL (the Broker
// event, listened to exactly the way the band listens), not the band's
// pixels — the band's own response to the event is owned by
// tests/cockpit/sweep-spectrum-load.test.ts.
//
// ── AND A FAILED HEAL CONVERGES NOTHING (the UIE-053 triple-check's gap) ──
//
// The fire rides the SUCCESS of the heal, not its attempt: a re-read that
// rejects must fire nothing, because the event promises "the transcript
// landed and every run-scoped surface may re-read" — firing it beside a
// transcript that did NOT land would wake the band on a record the page
// cannot show (and the unmoved baseline the row compared against is still
// what the screen holds). The failed-heal arm below is the one that kills
// the finally-placement variant: a fire moved into a `finally` (or a
// `.finally()` on the re-read) fires on rejection too, and passes the three
// convergence arms above — every one of them heals successfully. Only this
// arm drives a rejecting re-read.
describe("the focus-time record check (UIE-052) — a follower tab heals when the reader returns", () => {
  const jsonResponse = (body: unknown): Response =>
    ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

  /** history payload with a controllable chat.updatedAt — the baseline the
   * flow's read establishes, and what a foreign run moves. */
  const historyAt = (chatId: string, updatedAt: string): unknown => ({
    chat: {
      id: chatId,
      projectId: "p1",
      title: "the conversation",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt,
      modelId: null,
      pinned: false,
    },
    messages: [],
    toolCalls: [],
    metricsSnapshots: [],
    timelineRefs: [],
    page: { hasOlder: false, olderCursor: null, messageCount: 0 },
  });

  /** A window stub that records listeners — the watcher's real door. */
  function fakeWindow(): {
    win: Window;
    fire: (type: string) => void;
  } {
    const listeners = new Map<string, Array<(e: unknown) => void>>();
    const win = {
      addEventListener: (type: string, fn: (e: unknown) => void) => {
        listeners.set(type, [...(listeners.get(type) ?? []), fn]);
      },
      removeEventListener: (type: string, fn: (e: unknown) => void) => {
        listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn));
      },
    } as unknown as Window;
    return {
      win,
      fire: (type: string) => {
        for (const fn of listeners.get(type) ?? []) fn({});
      },
    };
  }

  let stopWatch: (() => void) | null = null;
  let stopRunDone: (() => void) | null = null;

  /** Listen to the heal's convergence signal the way the band's feed listens
   *  (spectrum-load's `onInvalidation("run:done", refresh)`): the REAL
   *  Broker door, not a mock. Each entry records how many history reads had
   *  landed when the event fired, so the ordering is pinned too — the band
   *  converges AFTER the transcript healed, never before it. */
  const listenRunDone = (historyReadsAt: () => number): number[] => {
    const fires: number[] = [];
    stopRunDone = onInvalidation("run:done", () => {
      fires.push(historyReadsAt());
    });
    return fires;
  };

  afterEach(() => {
    stopWatch?.();
    stopWatch = null;
    stopRunDone?.();
    stopRunDone = null;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    clearMessages();
    currentChatId.set(null);
  });

  test("the record moved on elsewhere → focus re-reads through the tab's own history door", async () => {
    let recordUpdatedAt = "2026-01-01T12:00:00.000Z"; // moves when a foreign run lands
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      urls.push(url);
      if (/\/api\/chats\/c1\/history/.test(url)) return jsonResponse(historyAt("c1", recordUpdatedAt));
      if (/\/api\/chats\/c1$/.test(url)) {
        return jsonResponse({
          id: "c1", projectId: "p1", title: "the conversation",
          createdAt: "2026-01-01T00:00:00.000Z", updatedAt: recordUpdatedAt,
          modelId: null, pinned: false,
        });
      }
      throw new Error(`unstubbed fetch: ${url}`);
    }) as unknown as typeof fetch;

    // The tab opened the conversation (the baseline read), then went to the
    // background while a run landed ELSEWHERE (the record moved).
    currentChatId.set("c1");
    await loadChatHistory("c1");
    expect(urls.filter((u) => u.includes("/history")).length).toBe(1);
    recordUpdatedAt = "2026-01-01T12:05:00.000Z";

    const { win, fire } = fakeWindow();
    vi.stubGlobal("window", win);
    vi.stubGlobal("document", {
      visibilityState: "visible",
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    stopWatch = startChatRecordWatch();
    const runDone = listenRunDone(() => urls.filter((u) => u.includes("/history")).length);

    fire("focus");
    await vi.advanceTimersByTimeAsync(15);

    // One row read + ONE history re-read — the exact door a reload uses.
    expect(urls.some((u) => /\/api\/chats\/c1$/.test(u))).toBe(true);
    expect(urls.filter((u) => u.includes("/history")).length).toBe(2);
    // The band's half (UIE-053): the healed record fires the run:done
    // invalidation the band's spectrum read declared — exactly once, and
    // only after the history it converges with has landed.
    expect(runDone).toEqual([2]);
  });

  test("the record did NOT move → focus pays one row, never a re-read", async () => {
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      urls.push(url);
      if (/\/api\/chats\/c2\/history/.test(url)) return jsonResponse(historyAt("c2", "2026-02-01T00:00:00.000Z"));
      if (/\/api\/chats\/c2$/.test(url)) {
        return jsonResponse({
          id: "c2", projectId: "p1", title: "quiet conversation",
          createdAt: "2026-02-01T00:00:00.000Z", updatedAt: "2026-02-01T00:00:00.000Z",
          modelId: null, pinned: false,
        });
      }
      throw new Error(`unstubbed fetch: ${url}`);
    }) as unknown as typeof fetch;

    currentChatId.set("c2");
    await loadChatHistory("c2");
    const { win, fire } = fakeWindow();
    vi.stubGlobal("window", win);
    vi.stubGlobal("document", {
      visibilityState: "visible",
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    stopWatch = startChatRecordWatch();
    const runDone = listenRunDone(() => urls.filter((u) => u.includes("/history")).length);

    fire("focus");
    await vi.advanceTimersByTimeAsync(15);

    expect(urls.some((u) => /\/api\/chats\/c2$/.test(u))).toBe(true); // the row was checked
    expect(urls.filter((u) => u.includes("/history")).length, "unmoved record: no re-read").toBe(1);
    // The cost gate (UIE-053): an unmoved record converges nothing — the
    // band's spectrum read is not re-asked on focus alone.
    expect(runDone, "unmoved record: no run:done fire, no band refetch").toEqual([]);
  });

  test("a live run in THIS tab: focus never re-reads under the streaming tail", async () => {
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      urls.push(url);
      if (/\/api\/chats\/c3\/history/.test(url)) return jsonResponse(historyAt("c3", "2026-03-01T00:00:00.000Z"));
      if (/\/api\/chats\/c3$/.test(url)) {
        return jsonResponse({
          id: "c3", projectId: "p1", title: "running here",
          createdAt: "2026-03-01T00:00:00.000Z", updatedAt: "2026-03-01T09:00:00.000Z",
          modelId: null, pinned: false,
        });
      }
      throw new Error(`unstubbed fetch: ${url}`);
    }) as unknown as typeof fetch;

    currentChatId.set("c3");
    await loadChatHistory("c3");
    setStreaming(true); // the tab's own run is writing the transcript
    const { win, fire } = fakeWindow();
    vi.stubGlobal("window", win);
    vi.stubGlobal("document", {
      visibilityState: "visible",
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    stopWatch = startChatRecordWatch();
    const runDone = listenRunDone(() => urls.filter((u) => u.includes("/history")).length);

    fire("focus");
    await vi.advanceTimersByTimeAsync(15);
    setStreaming(false);

    expect(urls.filter((u) => u.includes("/history")).length, "a mid-run re-read would fight the stream").toBe(1);
    expect(urls.some((u) => /\/api\/chats\/c3$/.test(u))).toBe(false); // not even the row was asked
    // The live-run guard covers the convergence signal too: no re-read, so
    // no run:done fire — the band keeps its own stream-close trigger.
    expect(runDone, "a live run heals nothing, fires nothing").toEqual([]);
  });

  test("the heal FAILS → focus fires nothing — a failed re-read converges no surface", async () => {
    const urls: string[] = [];
    // The heal's re-read fails with an ANSWERED refusal: the history endpoint
    // serves the BASELINE load, then a 500 on every attempt after. A 500 —
    // not a thrown socket — is the honest shape for this arm: the server
    // answered (the connection watch records a response, not an outage), so
    // what is isolated here is the HEAL's own failure, not the Broker's
    // separate reconnection door, which deliberately wakes every standing
    // subscription when a tab that could not ask comes back (a refused
    // socket would pull that mechanism in and the arm would conflate the
    // two).
    let historyBroken = false;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      urls.push(url);
      if (/\/api\/chats\/c4\/history/.test(url)) {
        if (historyBroken) {
          return { ok: false, status: 500, json: async () => ({ message: "history unreadable" }) } as unknown as Response;
        }
        return jsonResponse(historyAt("c4", "2026-04-01T00:00:00.000Z"));
      }
      if (/\/api\/chats\/c4$/.test(url)) {
        return jsonResponse({
          id: "c4", projectId: "p1", title: "broken conversation",
          createdAt: "2026-04-01T00:00:00.000Z", updatedAt: "2026-04-01T12:05:00.000Z",
          modelId: null, pinned: false,
        });
      }
      throw new Error(`unstubbed fetch: ${url}`);
    }) as unknown as typeof fetch;

    // The tab opened the conversation (the baseline read), went to the
    // background while a run landed elsewhere, and the history door broke.
    currentChatId.set("c4");
    await loadChatHistory("c4");
    historyBroken = true;
    const { win, fire } = fakeWindow();
    vi.stubGlobal("window", win);
    vi.stubGlobal("document", {
      visibilityState: "visible",
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    stopWatch = startChatRecordWatch();
    const runDone = listenRunDone(() => urls.filter((u) => u.includes("/history")).length);

    fire("focus");
    await vi.advanceTimersByTimeAsync(15);

    // The moved record paid the re-read attempt and the attempt FAILED —
    // one row, one failed history read — and the failure fired NOTHING:
    // the run:done event promises a landed transcript, and none landed.
    expect(urls.some((u) => /\/api\/chats\/c4$/.test(u))).toBe(true);
    expect(urls.filter((u) => u.includes("/history")).length, "the heal was attempted once and failed").toBe(2);
    expect(runDone, "a failed heal fires nothing — the finally-placement variant").toEqual([]);

    // The catch handled it honestly (the client's warn door is a no-op
    // unconfigured) and the watcher SURVIVED: the next focus re-attempts
    // through the same doors rather than wedging on the first failure.
    fire("focus");
    await vi.advanceTimersByTimeAsync(15);
    expect(urls.filter((u) => /\/api\/chats\/c4$/.test(u)).length, "the watcher re-attempts after a failed heal").toBe(2);
    expect(urls.filter((u) => u.includes("/history")).length).toBe(3);
    expect(runDone, "still nothing fired — the record has not landed").toEqual([]);
  });
});
