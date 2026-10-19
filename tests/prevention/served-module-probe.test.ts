// @vitest-environment node
/**
 * The served-module settle-and-poll verdict, driven over fixtures.
 *
 * The defect class (DESK-CSS-2): the vite dev server answers `health 200`
 * before the compile pipeline has populated the metadata a transform request
 * reads, so a boot probe that reads the artifact ONCE at health-green lands
 * in the raw-source fallthrough window and false-refuses a healthy boot. The
 * shared mechanics — warm the parent module first (the browser's order), poll
 * the artifact read through a settle window, refuse only a PERSISTENT bad
 * read — are owned by `scripts/served-module-probe.ts`; this file proves the
 * window verdict flips the right way for every shape a probe can meet.
 *
 * The search before creation: `svelte-css-scope-probe.test.ts` owns the
 * CSS-specific JUDGMENT half (the classifier over a served style payload);
 * `vite-dep-cache-staleness.test.ts` owns the cache-freshness verdict. Neither
 * judges the settle-and-poll WINDOW — the transient-versus-persistent
 * distinction — so this is a new owner, not a second door.
 *
 * Mutation-verified below: a verdict that refused on a TRANSIENT bad read, or
 * one that passed a PERSISTENT one, turns the planted sequences the wrong
 * colour. The INERT shape — a loop that polls but discards the judgment — is
 * caught by the arms that assert the refusal carries the probe's OWN judgment
 * text, evidence only the judged path can produce.
 */
import { describe, expect, test } from "vitest";

import {
  SERVED_MODULE_SETTLE_WINDOW_MS,
  pollServedModule,
  servedModuleWindowVerdict,
  type ServedModuleObservation,
} from "../../scripts/served-module-probe.ts";

const BAD: ServedModuleObservation = { fetchFailed: false, judgment: "bad read" };
const GOOD: ServedModuleObservation = { fetchFailed: false, judgment: null };
const FAILED: ServedModuleObservation = { fetchFailed: true, judgment: null };
const INSIDE = SERVED_MODULE_SETTLE_WINDOW_MS - 1;
const CLOSED = SERVED_MODULE_SETTLE_WINDOW_MS;

describe("servedModuleWindowVerdict — the window", () => {
  test("always-good settles clean from the first read", () => {
    expect(servedModuleWindowVerdict([GOOD], 0)).toEqual({ kind: "settled-clean" });
  });

  test("a clean read AFTER a bad one settles clean (transient bad is forgiven)", () => {
    expect(servedModuleWindowVerdict([BAD, BAD, GOOD], INSIDE)).toEqual({ kind: "settled-clean" });
  });

  test("a bad read INSIDE the window keeps polling (null — no verdict yet)", () => {
    expect(servedModuleWindowVerdict([BAD], INSIDE)).toBeNull();
    expect(servedModuleWindowVerdict([BAD, BAD, BAD], INSIDE)).toBeNull();
  });

  test("a PERSISTENT bad read is refused once the window has closed", () => {
    const verdict = servedModuleWindowVerdict([BAD, BAD, BAD], CLOSED);
    expect(verdict).toEqual({ kind: "refused", judgment: "bad read" });
  });

  test("the refusal carries the probe's OWN judgment text (the inert-shape witness)", () => {
    const verdict = servedModuleWindowVerdict(
      [{ fetchFailed: false, judgment: "served UNSCOPED: .bar" }],
      CLOSED,
    );
    expect(verdict).toEqual({ kind: "refused", judgment: "served UNSCOPED: .bar" });
  });

  test("a window of failed fetches only is NOT JUDGED — absence, never a guess", () => {
    expect(servedModuleWindowVerdict([FAILED, FAILED], CLOSED)).toEqual({ kind: "not-judged" });
    // …and an empty window (the server never answered once) the same.
    expect(servedModuleWindowVerdict([], CLOSED)).toEqual({ kind: "not-judged" });
  });

  test("failed fetches inside the window keep polling, never judged", () => {
    expect(servedModuleWindowVerdict([FAILED], INSIDE)).toBeNull();
  });

  test("a failed fetch does not erase a prior bad read's candidacy", () => {
    const verdict = servedModuleWindowVerdict([BAD, FAILED, FAILED], CLOSED);
    expect(verdict).toEqual({ kind: "refused", judgment: "bad read" });
  });

  test("the LAST bad judgment is the one reported", () => {
    const verdict = servedModuleWindowVerdict(
      [
        { fetchFailed: false, judgment: "first shape" },
        { fetchFailed: false, judgment: "second shape" },
      ],
      CLOSED,
    );
    expect(verdict).toEqual({ kind: "refused", judgment: "second shape" });
  });
});

describe("pollServedModule — the live loop, over an injected clock", () => {
  /** A clock that advances by the poll interval on every sleep. */
  function fakeClock(intervalMs: number) {
    let t = 0;
    return {
      now: () => t,
      sleep: (ms: number) => {
        t += ms;
      },
      intervalMs,
    };
  }

  test("always-good passes on the first poll without sleeping", () => {
    const clock = fakeClock(100);
    let sleeps = 0;
    const outcome = pollServedModule(() => {}, () => "body", () => null, {
      now: clock.now,
      sleep: (ms) => {
        sleeps += 1;
        clock.sleep(ms);
      },
    });
    expect(outcome).toEqual({ kind: "settled-clean" });
    expect(sleeps).toBe(0);
  });

  test("transient-bad-then-good passes — the warmup window is tolerated", () => {
    const clock = fakeClock(100);
    const bodies = ["raw-source", "raw-source", "compiled"];
    let reads = 0;
    const outcome = pollServedModule(
      () => {},
      () => bodies[Math.min(reads++, bodies.length - 1)]!,
      (body) => (body === "compiled" ? null : `unscoped: ${body}`),
      { now: clock.now, sleep: clock.sleep, pollIntervalMs: 100 },
    );
    expect(outcome).toEqual({ kind: "settled-clean" });
    expect(reads).toBe(3);
  });

  test("persistent-bad is refused once the window closes, carrying the judgment", () => {
    const clock = fakeClock(1_000);
    const outcome = pollServedModule(() => {}, () => "raw", () => "unscoped: raw", {
      now: clock.now,
      sleep: clock.sleep,
      pollIntervalMs: 1_000,
    });
    expect(outcome).toEqual({ kind: "refused", judgment: "unscoped: raw" });
  });

  test("a throwing fetch is retried, never judged — and a later good read passes", () => {
    const clock = fakeClock(100);
    let calls = 0;
    const outcome = pollServedModule(
      () => {},
      () => {
        calls += 1;
        if (calls < 3) throw new Error("connection refused");
        return "body";
      },
      () => null,
      { now: clock.now, sleep: clock.sleep, pollIntervalMs: 100 },
    );
    expect(outcome).toEqual({ kind: "settled-clean" });
    expect(calls).toBe(3);
  });

  test("a server that never answers is NOT JUDGED, never refused", () => {
    const clock = fakeClock(1_000);
    const outcome = pollServedModule(
      () => {},
      () => {
        throw new Error("connection refused");
      },
      () => null,
      { now: clock.now, sleep: clock.sleep, pollIntervalMs: 1_000 },
    );
    expect(outcome).toEqual({ kind: "not-judged" });
  });

  test("the parent module is warmed BEFORE the artifact is fetched, every poll", () => {
    const order: string[] = [];
    pollServedModule(
      () => order.push("warm"),
      () => {
        order.push("fetch");
        return "body";
      },
      () => null,
      { now: fakeClock(100).now, sleep: () => {} },
    );
    expect(order).toEqual(["warm", "fetch"]);
  });
});
