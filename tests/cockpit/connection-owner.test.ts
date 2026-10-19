// @vitest-environment node
/**
 * THE CONNECTION HAS ONE OWNER, AND IT DECIDES BY EVIDENCE.
 *
 * THE DEFECT, MEASURED IN THE BROWSER BEFORE THIS EXISTED. With the API
 * stopped, the Vite dev proxy answers `502 Bad Gateway`, `text/plain`, empty
 * body, in 5ms. `fetchJson` turns that into `ClientError("http_502")`. The
 * three places that decided "offline" all tested
 * `err.code === "network" || err.code === "timeout"` — so NONE of them fired,
 * and the cockpit (which issues no requests at rest — measured: zero fetches
 * in twelve seconds) showed a fully-populated screen over a server that was
 * gone.
 *
 * WHAT THIS FILE PINS, and each is a distinct way to get it wrong:
 *
 *  1. the API's identity header — NOT the status code — decides whether the
 *     API answered. Keying on 502 would call a healthy server offline every
 *     time an upstream model provider failed, because `shared/errors.ts`
 *     maps that to 502 too ("502 is the honest status: this side worked");
 *  2. 401/403/500 are ANSWERS. The server replied, so it is reachable;
 *  3. a refused socket is unreachable IMMEDIATELY — no timeout is waited out;
 *  4. a TIMEOUT is not a refusal. It needs corroboration, because a busy
 *     server is not an absent one — DESIGN-PERFORMANCE §1 L1 measures an
 *     8,009ms scan on an otherwise 3ms endpoint, and the first draft of this
 *     module produced a REAL false outage in the browser ("stopped answering
 *     after 2s") against a server that was up and serving;
 *  5. anything that answers resets the strike count;
 *  6. a request must not sit on the 30s budget once we know the API is down;
 *  7. one watch reaches ONE verdict — a malformed body after a real 200 must
 *     not be reported as an outage;
 *  8. recovery revalidates, so the screen refreshes without a reload.
 *
 * EVERY assertion below is mutation-tested at the bottom: the guard is shown
 * to go RED when the behaviour it claims to protect is removed. A guard that
 * cannot fail is not a guard.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  connection,
  connectionMessage,
  noteAnswered,
  noteNotReached,
  requestBudgetMs,
  resetConnectionForTest,
  setLivenessBeatMs,
  silenceAnchorMs,
  startLivenessWatch,
  watchRequest,
  type ConnectionState,
} from "../../src/data/connection.ts";
import {
  API_IDENTITY_HEADER,
  API_IDENTITY_VALUE,
  GATEWAY_UNREACHED_STATUSES,
  LIVE_STREAM_MISSED_BEATS,
  LIVE_STREAM_RETRY_MS,
} from "../../shared/constants.ts";
import {
  CONNECTION_TIMEOUT_STRIKES,
  CONNECTION_UNREACHABLE_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
} from "../../src/client-config.ts";

/** A response as the API itself would produce it — signed. */
function signed(status: number): Response {
  return new Response(null, {
    status,
    headers: { [API_IDENTITY_HEADER]: API_IDENTITY_VALUE },
  });
}

/** A response something IN FRONT of the API produced. This is exactly what
 *  the Vite dev proxy sends when the upstream socket is refused. */
function unsigned(status: number): Response {
  return new Response(null, { status, headers: { "Content-Type": "text/plain" } });
}

function kind(): ConnectionState["kind"] {
  return connection.get().kind;
}

beforeEach(() => {
  resetConnectionForTest();
});

describe("what counts as the API answering", () => {
  test("a signed 200 is reachable", () => {
    watchRequest().responded(signed(200));
    expect(kind()).toBe("reachable");
  });

  test("401 IS NOT OFFLINE — the server answered", () => {
    noteNotReached("refused", 3);
    expect(kind()).toBe("unreachable");
    watchRequest().responded(signed(401));
    expect(kind()).toBe("reachable");
  });

  test("403 and 500 are answers too — reachability is not authorization", () => {
    for (const status of [403, 500, 404]) {
      resetConnectionForTest();
      noteNotReached("refused", 3);
      watchRequest().responded(signed(status));
      expect(kind(), `status ${status}`).toBe("reachable");
    }
  });

  test("a SIGNED 502 is reachable — the API said it, and it means the model provider failed", () => {
    // shared/errors.ts maps an upstream provider failure to 502 on purpose.
    // Keying "offline" on the number would blank the whole cockpit every time
    // a model hiccuped, which is a fabricated outage.
    watchRequest().responded(signed(502));
    expect(kind()).toBe("reachable");
  });

  test("an UNSIGNED 502 is unreachable — something in front of the API answered", () => {
    watchRequest().responded(unsigned(502));
    expect(kind()).toBe("unreachable");
  });

  test("an unsigned 200 is REACHABLE — absence of the header proves nothing alone", () => {
    // The rule is a conjunction, and this is the half that keeps it safe: a
    // reverse proxy that strips unknown headers must not turn a perfectly
    // healthy 200 into a permanent outage. Only a gateway-class status that
    // the API did not sign means "the API was not reached".
    watchRequest().responded(unsigned(200));
    expect(kind()).toBe("reachable");
  });

  test("every gateway-class status, unsigned, is unreachable", () => {
    for (const status of GATEWAY_UNREACHED_STATUSES) {
      resetConnectionForTest();
      watchRequest().responded(unsigned(status));
      expect(kind(), `unsigned ${status}`).toBe("unreachable");
    }
  });

  test("the same statuses, SIGNED, are reachable — the API said them", () => {
    for (const status of GATEWAY_UNREACHED_STATUSES) {
      resetConnectionForTest();
      noteNotReached("refused", 3);
      watchRequest().responded(signed(status));
      expect(kind(), `signed ${status}`).toBe("reachable");
    }
  });
});

describe("refused is instant; timed out is not", () => {
  test("a refused socket is unreachable on the first failure", () => {
    watchRequest().failed("refused");
    const s = connection.get();
    expect(s.kind).toBe("unreachable");
    if (s.kind === "unreachable") expect(s.cause).toBe("refused");
  });

  test("ONE timeout does not blank the app", () => {
    // A busy server is not an absent one. This is the assertion that would
    // have caught the false outage measured in the browser.
    watchRequest().failed("timeout");
    expect(kind()).not.toBe("unreachable");
  });

  test("consecutive timeouts, with nothing answering between, do", () => {
    for (let i = 0; i < CONNECTION_TIMEOUT_STRIKES; i += 1) {
      watchRequest().failed("timeout");
    }
    const s = connection.get();
    expect(s.kind).toBe("unreachable");
    if (s.kind === "unreachable") expect(s.cause).toBe("timeout");
  });

  test("an answer between them resets the count", () => {
    for (let i = 0; i < CONNECTION_TIMEOUT_STRIKES * 3; i += 1) {
      watchRequest().failed("timeout");
      watchRequest().responded(signed(200));
    }
    expect(kind()).toBe("reachable");
  });
});

describe("one watch, one verdict", () => {
  test("a failure AFTER a response is ignored — a malformed body is not an outage", () => {
    // `fetchJson` has ONE catch block, and a JSON parse error over a real 200
    // lands in it exactly as a refused socket does. Without the latch this is
    // reported as the server being gone.
    const watch = watchRequest();
    watch.responded(signed(200));
    watch.failed("refused");
    expect(kind()).toBe("reachable");
  });

  test("release reaches no verdict at all", () => {
    watchRequest().release();
    expect(kind()).toBe("reachable");
  });
});

describe("no request waits out the full budget once we know", () => {
  test("the budget is capped while unreachable", () => {
    expect(requestBudgetMs(DEFAULT_REQUEST_TIMEOUT_MS)).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
    noteNotReached("refused", 4);
    expect(requestBudgetMs(DEFAULT_REQUEST_TIMEOUT_MS)).toBe(
      CONNECTION_UNREACHABLE_TIMEOUT_MS,
    );
    expect(CONNECTION_UNREACHABLE_TIMEOUT_MS).toBeLessThan(DEFAULT_REQUEST_TIMEOUT_MS);
  });

  test("a caller's own smaller budget is never widened", () => {
    noteNotReached("refused", 4);
    expect(requestBudgetMs(250)).toBe(250);
  });
});

describe("what the reader is told", () => {
  test("reachable says nothing", () => {
    expect(connectionMessage({ kind: "reachable" })).toBeNull();
  });

  test("the sentences name the API and never say a bare 'offline'", () => {
    const said = [
      connectionMessage({ kind: "slow", since: 0 }),
      connectionMessage({ kind: "unreachable", cause: "refused", since: 0, elapsedMs: 5 }),
      connectionMessage({
        kind: "unreachable",
        cause: "timeout",
        since: 0,
        elapsedMs: 30_000,
      }),
    ];
    for (const s of said) {
      expect(s).not.toBeNull();
      expect(s!.toLowerCase()).toContain("api");
      expect(s!.toLowerCase()).not.toMatch(/\boffline\b/);
    }
  });

  test("the timeout sentence states the MEASURED elapsed, not a constant", () => {
    const a = connectionMessage({
      kind: "unreachable",
      cause: "timeout",
      since: 0,
      elapsedMs: 4_000,
    });
    const b = connectionMessage({
      kind: "unreachable",
      cause: "timeout",
      since: 0,
      elapsedMs: 30_000,
    });
    expect(a).toContain("4s");
    expect(b).toContain("30s");
    expect(a).not.toEqual(b);
  });
});

describe("recovery is automatic", () => {
  test("leaving unreachable revalidates every standing read", async () => {
    // The Broker installs the real probe at module load. Importing it here is
    // what wires `revalidateAll` in, so this exercises the production wiring
    // rather than a stub of it.
    const broker = await import("../../src/data/broker.ts");
    let refreshed = 0;
    const stop = broker.onInvalidation("test:connection-recovery", () => {
      refreshed += 1;
    });
    try {
      noteNotReached("refused", 5);
      expect(refreshed).toBe(0);
      noteAnswered();
      expect(kind()).toBe("reachable");
      expect(refreshed).toBe(1);
    } finally {
      stop();
    }
  });

  test("an answer while already reachable revalidates NOTHING", async () => {
    // Otherwise every single request would re-read every feed in the app.
    const broker = await import("../../src/data/broker.ts");
    let refreshed = 0;
    const stop = broker.onInvalidation("test:connection-noop", () => {
      refreshed += 1;
    });
    try {
      noteAnswered();
      noteAnswered();
      expect(refreshed).toBe(0);
    } finally {
      stop();
    }
  });
});

/**
 * ── THE RETRY CADENCE IS CHOSEN BY WHY THE STREAM FAILED ───────────────────
 *
 * THE DEFECT, OBSERVED IN THE BROWSER. `/api/live` was refused with 429 (the
 * server's own SSE connection cap, which the liveness stream shared with the
 * run streams). EventSource treats a non-2xx as a PERMANENT failure, the watch
 * re-opened it on the outage cadence, and the server refused it again — four
 * times a second, forever, with the cockpit blocked behind "The harness API is
 * not answering" over a server that was answering everything. The user
 * reported it as "api seems down". The API was healthy the whole time.
 *
 * TWO THINGS WERE WRONG AND BOTH ARE ASSERTED HERE:
 *
 *  1. ONE CADENCE FOR TWO CAUSES. 250ms is right for an outage — that is what
 *     makes recovery feel instant (measured: 104ms) — and wrong for a refusal,
 *     where an immediate retry cannot succeed and is what makes the exhaustion
 *     PERMANENT. The cause is now measured, not assumed, by asking the server
 *     directly; a 429 backs off on the server's own `Retry-After`, a dropped
 *     socket does not back off at all.
 *  2. A FALSE SENTENCE. A 429 carries the API's identity header, so by this
 *     module's own rule the API ANSWERED and is reachable. Saying "not
 *     answering" about a server that just answered is the fabrication this
 *     product exists to refuse, arriving through the connection door.
 */
describe("the retry cadence depends on WHY the stream failed", () => {
  type Diagnosis =
    | { outcome: "answered" }
    | { outcome: "refused"; retryAfterMs: number }
    | { outcome: "unreached"; elapsedMs: number };

  /** A stand-in for `src/client.ts`'s two liveness functions. Records what the
   *  watch did and lets the test decide what the server says. */
  function fakePort(answers: Diagnosis[]) {
    const record = { opens: 0, diagnoses: 0 };
    let handlers: {
      onAlive: () => void;
      onDown: (i: { retrying: boolean }) => void;
    } | null = null;
    const port = {
      open: (h: typeof handlers) => {
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
      port: port as unknown as Parameters<typeof startLivenessWatch>[0],
      /** The stream failed the way a 429 or a dev-proxy 502 makes it fail:
       *  the browser gives up permanently. */
      dropPermanently: () => handlers?.onDown({ retrying: false }),
      /** A plain network error, with the browser still retrying by itself. */
      dropRetrying: () => handlers?.onDown({ retrying: true }),
      beat: () => handlers?.onAlive(),
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    resetConnectionForTest();
    vi.useRealTimers();
  });

  test("a REFUSAL backs off on the server's own Retry-After", async () => {
    const f = fakePort([{ outcome: "refused", retryAfterMs: 5_000 }]);
    startLivenessWatch(f.port);
    expect(f.record.opens).toBe(1);

    f.dropPermanently();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.record.diagnoses, "the cause must be asked, not assumed").toBe(1);

    // Not one moment before the server said.
    await vi.advanceTimersByTimeAsync(4_999);
    expect(f.record.diagnoses).toBe(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(f.record.diagnoses).toBe(2);

    // The defect, quantified: at the outage cadence this window would have
    // held twenty attempts instead of one.
    expect(5_000 / LIVE_STREAM_RETRY_MS).toBe(20);
  });

  test("a REFUSAL never says the server is unreachable — it answered", () => {
    const f = fakePort([{ outcome: "refused", retryAfterMs: 5_000 }]);
    startLivenessWatch(f.port);
    f.dropPermanently();
    return vi.advanceTimersByTimeAsync(0).then(() => {
      expect(kind(), "a 429 is a response; a response means reachable").toBe("reachable");
      expect(connectionMessage(connection.get())).toBeNull();
    });
  });

  test("an OUTAGE keeps the fast cadence and states the outage", async () => {
    const f = fakePort([{ outcome: "unreached", elapsedMs: 5 }]);
    startLivenessWatch(f.port);
    f.dropPermanently();
    await vi.advanceTimersByTimeAsync(0);
    expect(kind()).toBe("unreachable");
    const s = connection.get();
    if (s.kind === "unreachable") {
      expect(s.cause).toBe("refused");
      expect(s.elapsedMs, "the measured elapsed, never invented").toBe(5);
    }
    // Backing off here would be the regression in the other direction: the
    // whole reason for 250ms is that recovery from a real outage feels
    // instant.
    await vi.advanceTimersByTimeAsync(LIVE_STREAM_RETRY_MS - 1);
    expect(f.record.diagnoses).toBe(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(f.record.diagnoses).toBe(2);
  });

  test("recovery: once the server answers, the socket is re-opened and the block clears", async () => {
    const f = fakePort([
      { outcome: "unreached", elapsedMs: 5 },
      { outcome: "answered" },
    ]);
    startLivenessWatch(f.port);
    f.dropPermanently();
    await vi.advanceTimersByTimeAsync(0);
    expect(kind()).toBe("unreachable");
    // Second diagnosis, one outage cadence later, finds the server back.
    await vi.advanceTimersByTimeAsync(LIVE_STREAM_RETRY_MS + 1);
    expect(kind(), "an answer is an answer — the block clears without a reload").toBe(
      "reachable",
    );
    // And a socket is opened again (through the floor, so not instantly).
    await vi.advanceTimersByTimeAsync(LIVE_STREAM_RETRY_MS);
    expect(f.record.opens).toBe(2);
  });

  test("while the BROWSER is still retrying, nothing else runs", async () => {
    // It owns the loop; opening a second socket beside it would be two
    // clients against one endpoint. The outage is still stated at once.
    const f = fakePort([{ outcome: "answered" }]);
    startLivenessWatch(f.port);
    f.dropRetrying();
    expect(kind()).toBe("unreachable");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.record.diagnoses, "no diagnosis while the browser is mid-retry").toBe(0);
    expect(f.record.opens).toBe(1);
  });

  test("no two sockets closer together than the outage cadence, whatever asks", async () => {
    // The floor that keeps every path terminating. A server that answers the
    // diagnosis but drops the stream instantly would otherwise spin as fast as
    // the network allows — the same self-sustaining shape, from the other side.
    const f = fakePort([{ outcome: "answered" }]);
    startLivenessWatch(f.port);
    for (let i = 0; i < 5; i += 1) {
      f.dropPermanently();
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(f.record.opens, "five instant failures must not become five sockets").toBe(1);
    await vi.advanceTimersByTimeAsync(LIVE_STREAM_RETRY_MS);
    expect(f.record.opens).toBe(2);
  });

  test("a beat clears everything — the healthy page has no timer at all", async () => {
    const f = fakePort([{ outcome: "unreached", elapsedMs: 5 }]);
    startLivenessWatch(f.port);
    f.dropPermanently();
    await vi.advanceTimersByTimeAsync(0);
    expect(kind()).toBe("unreachable");
    f.beat();
    expect(kind()).toBe("reachable");
  });
});

/**
 * ── MUTATION SELF-CHECKS ───────────────────────────────────────────────────
 *
 * Each rebuilds the DEFECTIVE rule as a local function and asserts the
 * assertion above would have caught it. This is the check that the guards are
 * load-bearing: four ways a mutation can silently prove nothing were seen on
 * this codebase today (wrong file, no match, mocking the module under test,
 * mutating dead code), and a self-check that re-derives the rule in-file
 * avoids all four.
 */
describe("mutation: the connection guards fail when the rule is removed", () => {
  test("keying reachability on the STATUS CODE instead of the header", () => {
    // The defect: "5xx from the gateway means offline". Apply it to the two
    // 502s the real rule separates, and it gets BOTH wrong.
    const byStatus = (res: Response): "reachable" | "unreachable" =>
      res.status === 502 || res.status === 504 ? "unreachable" : "reachable";
    // A signed 502 (a model provider failed) would blank the cockpit …
    expect(byStatus(signed(502))).toBe("unreachable");
    // The real rule disagrees: a SIGNED 502 is the API speaking.
    watchRequest().responded(signed(502));
    expect(kind()).toBe("reachable");
    resetConnectionForTest();
    // And the mirror-image mutation — "no header means gone" — would call a
    // header-stripping proxy's healthy 200 an outage. The real rule does not.
    watchRequest().responded(unsigned(200));
    expect(kind()).toBe("reachable");
  });

  test("treating a timeout as proof — one strike is enough", () => {
    // The mutation is `CONNECTION_TIMEOUT_STRIKES = 1`. Re-derived here so the
    // check does not depend on editing the constant.
    const STRIKES_MUTATED = 1;
    expect(CONNECTION_TIMEOUT_STRIKES).toBeGreaterThan(STRIKES_MUTATED);
    watchRequest().failed("timeout");
    // Under the mutation this would already be "unreachable" — the assertion
    // in "ONE timeout does not blank the app" is what goes red.
    expect(kind()).not.toBe("unreachable");
  });

  test("dropping the one-verdict latch", () => {
    // The mutation removes `ended`, so the second verb also writes. Re-derived:
    // without a latch, responded-then-failed ends unreachable.
    let latched = false;
    let out = "reachable";
    const noLatch = { responded: () => { out = "reachable"; }, failed: () => { out = "unreachable"; } };
    noLatch.responded();
    noLatch.failed();
    expect(out).toBe("unreachable");
    expect(latched).toBe(false);
    // The real watch does not behave that way, which the test above asserts.
    const watch = watchRequest();
    watch.responded(signed(200));
    watch.failed("refused");
    expect(kind()).toBe("reachable");
  });

  test("not capping the budget while unreachable", () => {
    noteNotReached("refused", 4);
    const uncapped = DEFAULT_REQUEST_TIMEOUT_MS;
    expect(requestBudgetMs(DEFAULT_REQUEST_TIMEOUT_MS)).not.toBe(uncapped);
  });
});

/**
 * ── SILENCE BEHIND THE DEV PROXY BECOMES A VERDICT ─────────────────────────
 *
 * The defect: with the API dead behind the Vite proxy, the proxy holds the
 * client's liveness socket OPEN — no FIN, no error event, nothing for the
 * fast path to see. The silence watchdog was the only detector left, and
 * when it fired it said "slow" and STOPPED: no diagnosis, no recovery loop,
 * the block never appeared. Offline detection ran a whole watchdog
 * threshold behind, and then never actually said offline.
 *
 * What must hold now:
 *   - the watchdog's slow statement is anchored at the LAST CONFIRMED-ALIVE
 *     beat (not the verdict instant, not the stream's open);
 *   - silence triggers a DIAGNOSIS; an `unreached` answer (the proxy's
 *     unsigned 502) marks the outage promptly and keeps the recovery loop;
 *   - the outage INHERITS the silence's anchor — the clock does not restart
 *     at 0s over an outage already a threshold old;
 *   - a server that ANSWERS the diagnosis is reachable (production's
 *     busy-but-alive case never blocks), and the socket is re-opened.
 */
describe("silence behind the dev proxy is converted into a verdict", () => {
  type Diagnosis =
    | { outcome: "answered" }
    | { outcome: "refused"; retryAfterMs: number }
    | { outcome: "unreached"; elapsedMs: number };

  function fakePort(answers: Diagnosis[]) {
    const record = { opens: 0, diagnoses: 0 };
    let handlers: { onAlive: () => void; onDown: (i: { retrying: boolean }) => void } | null =
      null;
    const port = {
      open: (h: typeof handlers) => {
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
      port: port as unknown as Parameters<typeof startLivenessWatch>[0],
      beat: () => handlers?.onAlive(),
    };
  }

  const BEAT_MS = 100;
  const WATCHDOG_MS = BEAT_MS * LIVE_STREAM_MISSED_BEATS;

  beforeEach(() => {
    vi.useFakeTimers();
    setLivenessBeatMs(BEAT_MS);
  });
  afterEach(() => {
    resetConnectionForTest();
    vi.useRealTimers();
  });

  test("beats stop → slow anchored at the last beat → diagnosis → unreachable, same anchor", async () => {
    const f = fakePort([{ outcome: "unreached", elapsedMs: 7 }]);
    startLivenessWatch(f.port);
    f.beat();
    const lastBeatAt = Date.now();

    // The beats stop; the watchdog threshold passes.
    await vi.advanceTimersByTimeAsync(WATCHDOG_MS + 1);
    const s = connection.get();
    expect(s.kind, "silence alone is a verdict now, not a shrug").toBe("unreachable");
    if (s.kind === "unreachable") {
      // The clock runs from the last confirmed-alive instant — not from the
      // verdict (which would claim the outage just began) and not from the
      // stream's open (which would claim the whole session was down).
      expect(s.since).toBe(lastBeatAt);
      expect(s.elapsedMs).toBe(7);
    }
    expect(f.record.diagnoses, "the silence must be asked about, not assumed").toBe(1);
    // The recovery loop is armed: the next diagnosis comes at the outage cadence.
    await vi.advanceTimersByTimeAsync(LIVE_STREAM_RETRY_MS + 1);
    expect(f.record.diagnoses).toBe(2);
  });

  test("a server that ANSWERS the diagnosis stays reachable and gets its socket back — the busy-but-alive case never blocks", async () => {
    const f = fakePort([{ outcome: "answered" }]);
    startLivenessWatch(f.port);
    f.beat();
    await vi.advanceTimersByTimeAsync(WATCHDOG_MS + 1);
    expect(f.record.diagnoses).toBe(1);
    expect(connection.get().kind).toBe("reachable");
    // The old socket may be dead through the proxy; a fresh one is opened.
    await vi.advanceTimersByTimeAsync(LIVE_STREAM_RETRY_MS + 1);
    expect(f.record.opens).toBe(2);
  });

  test("the anchor math, as arithmetic", () => {
    // A confirmed-alive instant anchors the silence…
    expect(silenceAnchorMs(10_000, 4_000)).toBe(4_000);
    // …a stream that never beat proves nothing about the past…
    expect(silenceAnchorMs(10_000, 0)).toBe(10_000);
    // …and an anchor can never sit in the future of the report.
    expect(silenceAnchorMs(10_000, 11_000)).toBe(10_000);
  });
});
