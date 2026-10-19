// @vitest-environment jsdom
/**
 * THE TOKEN RAIL — the live-stream instrument (flow/StreamPulse.svelte).
 *
 * This replaced a bare `<span>streaming</span>`. The point of the
 * replacement is that it tells the truth about the stream, so these tests
 * are about truth, not about pixels:
 *
 *   MOTION ONLY FROM REAL ARRIVALS — the head advances once per observed
 *   growth of the tail and NOT otherwise. A spinner keeps moving through a
 *   stall; this must freeze, because a frozen rail is the honest report that
 *   nothing is arriving. Asserted by letting wall-clock time pass with no
 *   new text and checking the head has not moved.
 *
 *   NO FABRICATED RATE — a rate needs a measured time span. With a single
 *   arrival there is no span, so the readout must say it is waiting rather
 *   than print a number it cannot have measured.
 *
 *   NO IDLE ANIMATION IN THE SOURCE — a static check that the component
 *   contains no keyframes/animation/interval/rAF, so a later edit cannot
 *   quietly reintroduce timer-driven decoration.
 *
 *   LAYOUT STABILITY — the rail's own box must not change size as tokens
 *   land, or the flow virtualizer re-measures the beat because of its own
 *   activity indicator.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { readFileSync } from "node:fs";
import { bodyCalls, bodyCallsWith, functionBody } from "../helpers/function-scope.ts";
import { callArgumentsOf } from "../helpers/function-scope.ts";

import StreamPulseProbe from "./fixtures/StreamPulseProbe.svelte";
import { STREAM_RAIL_CELLS } from "../../src/cockpit/render/render-config.ts";
import {
  advanceWait,
  resetWait,
  waitStage,
  waitSteps,
  WAIT_SAY,
  WAIT_STAGES,
  type WaitStage,
} from "../../src/cockpit/flow/wait-stage.ts";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const SRC = readFileSync("src/cockpit/flow/StreamPulse.svelte", "utf8");

async function settle(): Promise<void> {
  await tick();
  await tick();
}

/**
 * Mount the probe and return the container plus `feed`, which pushes a new
 * tail into the SAME component instance — the way the real streamingTail
 * atom updates it. (Remounting would reset the arrival bookkeeping, which
 * is precisely the state under test.)
 */
function mount(): {
  container: HTMLElement;
  feed: (t: string) => Promise<void>;
  milestone: (s: WaitStage) => Promise<void>;
  startAt: (at: number | null) => Promise<void>;
} {
  let set: (t: string) => void = () => {};
  let setStage: (s: WaitStage) => void = () => {};
  let setStart: (at: number | null) => void = () => {};
  const { container } = render(StreamPulseProbe, {
    props: {
      register: (fn: (t: string) => void) => {
        set = fn;
      },
      registerStage: (fn: (s: WaitStage) => void) => {
        setStage = fn;
      },
      registerStartedAt: (fn: (at: number | null) => void) => {
        setStart = fn;
      },
    },
  });
  return {
    container,
    async feed(t: string) {
      set(t);
      await settle();
    },
    async milestone(s: WaitStage) {
      setStage(s);
      await settle();
    },
    async startAt(at: number | null) {
      setStart(at);
      await settle();
    },
  };
}

/** Index of the lit head cell, or -1 when none is lit. */
function headIndex(root: HTMLElement): number {
  const cells = Array.from(root.querySelectorAll(".cell"));
  return cells.findIndex((c) => c.classList.contains("head"));
}

/** Real elapsed wall-clock delay (the rate is measured from real timestamps). */
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("the rail moves ONLY when text actually arrives", () => {
  test("a fresh stream lights no head and reports no rate", async () => {
    const { container } = mount();
    await settle();
    expect(headIndex(container)).toBe(-1);
    expect(container.textContent).toContain("waiting for the first characters");
    expect(container.textContent).not.toMatch(/c\/s/);
  });

  test("each arrival advances the head exactly one cell", async () => {
    const { container, feed } = mount();
    await settle();

    await feed("a");
    const first = headIndex(container);
    expect(first).toBeGreaterThanOrEqual(0);

    await feed("ab");
    expect(headIndex(container)).toBe((first + 1) % STREAM_RAIL_CELLS);

    await feed("abc");
    expect(headIndex(container)).toBe((first + 2) % STREAM_RAIL_CELLS);
  });

  test("TIME PASSING WITH NO NEW TEXT MOVES NOTHING (a stall reads as a stall)", async () => {
    const { container, feed } = mount();
    await feed("abc");
    const parked = headIndex(container);
    expect(parked).toBeGreaterThanOrEqual(0);

    // Real time passes and the component is re-rendered with the SAME tail —
    // exactly what a stalled stream looks like. A timer-driven indicator
    // would have moved on; this one must be exactly where it stopped.
    await delay(80);
    await feed("abc");
    expect(headIndex(container)).toBe(parked);

    await delay(80);
    await feed("abc");
    expect(headIndex(container)).toBe(parked);
  });

  test("the head wraps the rail rather than running off it", async () => {
    const { container, feed } = mount();
    await settle();
    let text = "";
    for (let i = 0; i < STREAM_RAIL_CELLS * 2 + 3; i += 1) {
      text += "x";
      await feed(text);
      const h = headIndex(container);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(STREAM_RAIL_CELLS);
    }
  });

  test("a shorter tail means a NEW stream — the rail resets to waiting", async () => {
    const { container, feed } = mount();
    await feed("hello there");
    expect(headIndex(container)).toBeGreaterThanOrEqual(0);

    await feed("");
    expect(headIndex(container)).toBe(-1);
    expect(container.textContent).toContain("waiting for the first characters");
  });
});

describe("the readout reports measured values or absence — never a guess", () => {
  test("one arrival has no time span, so no rate is printed — but the COUNT is real", async () => {
    const { container, feed } = mount();
    await feed("first chunk");
    // A rate needs two arrivals to have a span; inventing one is fabrication.
    expect(container.textContent).not.toMatch(/c\/s/);
    // …and the readout must NOT still claim to be waiting for the first
    // characters, because eleven of them have landed. That sentence was
    // untrue from the instant the first token arrived.
    expect(container.textContent).not.toContain("waiting for the first characters");
    expect(container.textContent).toContain("11 chars");
  });

  test("the count is the REAL number received, and the rail prints NO rate", async () => {
    // THE RATE HAS ONE OWNER NOW, AND IT IS NOT THIS COMPONENT.
    //
    // A DESIGN DECISION (not user rulings — an earlier comment fabricated quotes here):
    // [FABRICATED QUOTE REMOVED — the user never said this; the decision below stands on its own merits]. The footer holds exactly
    // one rate slot (flow/TurnBeat.svelte `rateSay`), reporting the throughput
    // that is genuinely measured at that moment — characters per second while
    // the stream runs, tokens per second once the provider states the count.
    // The rail keeps the MOTION and the count.
    //
    // MUTATION: put a `.rate` span back in StreamPulse and this fails — two
    // components printing a rate is how the footer came to show `470 c/s` and
    // `176.4 tok/s` side by side.
    const { container, feed } = mount();
    await feed("12345");
    await delay(20);
    await feed("1234567890");

    expect(container.textContent).not.toMatch(/c\/s/);
    expect(container.textContent).not.toMatch(/tok\/s/);
    // The count is the real number observed, not an estimate.
    expect(container.textContent).toContain("10 chars");
  });

  test("the accessible name describes the STREAM, not a generic 'loading'", async () => {
    const { container, feed } = mount();
    await settle();
    const rail = container.querySelector(".rail")!;
    expect(rail.getAttribute("aria-label")).toContain("first characters");

    await feed("abc");
    await delay(20);
    await feed("abcdef");
    // It names what actually arrived and how much of it — never a generic
    // busy-word, and never a rate this component no longer owns.
    expect(rail.getAttribute("aria-label")).toMatch(/received 6 characters/);
    expect(rail.getAttribute("aria-label") ?? "").not.toMatch(/loading|spinner|please wait/i);
  });
});

/**
 * ── THE WAIT: THE SAME INSTRUMENT, MEASURING SOMETHING ELSE ────────────────
 *
 * THE USER'S REPORT, VERBATIM: "I don't like the first animation we are
 * getting when submitting the message, the waiting thing, I do like a lot the
 * one we use for streaming tho, maybe we can use something similar but
 * appropriate?"
 *
 * The offender was this rail's own pre-first-token state — fourteen dead
 * cells and the words "waiting for the first characters" — and the fix had to
 * carry the PROPERTY the user likes (nothing moves unless something happened)
 * rather than the look. These tests are about that property.
 */
describe("the wait — three real milestones, and not one more", () => {
  test("firing NO milestone produces NO movement", () => {
    // The whole claim, stated once: the instrument is driven by observations.
    // With none, it is dark.
    const { container } = mount();
    expect(headIndex(container)).toBe(-1);
  });

  test("each milestone advances the head exactly one cell", async () => {
    const { container, milestone } = mount();
    const seen: number[] = [];
    for (const s of ["accepted", "connected", "answering"] as const) {
      await milestone(s);
      seen.push(headIndex(container));
    }
    expect(seen).toEqual([0, 1, 2]);
  });

  test("TIME PASSING BETWEEN MILESTONES MOVES NOTHING when no send-clock is armed", async () => {
    // WITHOUT startedAt the rail is arrival-only: a quiet connection must
    // look quiet. The wait-clock tests below arm the clock on purpose.
    const { container, milestone } = mount();
    await milestone("accepted");
    const parked = headIndex(container);
    await delay(80);
    await settle();
    expect(headIndex(container)).toBe(parked);
    await delay(120);
    await settle();
    expect(headIndex(container)).toBe(parked);
  });

  test("the handoff to the token rail is CONTINUOUS — the count never restarts", async () => {
    const { container, milestone, feed } = mount();
    await milestone("answering");
    const atLastMilestone = headIndex(container);
    expect(atLastMilestone).toBe(WAIT_STAGES.length - 2); // three milestones → cell 2

    // The first character is the NEXT observation, not a new instrument.
    await feed("H");
    expect(headIndex(container)).toBe((atLastMilestone + 1) % STREAM_RAIL_CELLS);
    await feed("He");
    expect(headIndex(container)).toBe((atLastMilestone + 2) % STREAM_RAIL_CELLS);
  });

  test("two mounts during one run agree on the cell (one instrument, two hosts)", async () => {
    // The rail moves from the flow's tail into the model turn's footer the
    // moment that turn exists. It may not JUMP when it does, which is only
    // true because the head is a function of facts about the RUN rather than
    // of anything a component instance remembers.
    const a = mount();
    await a.milestone("connected");
    const b = mount();
    await b.milestone("connected");
    expect(headIndex(b.container)).toBe(headIndex(a.container));
  });

  test("each stage says in plain words what actually happened", async () => {
    const { container, milestone } = mount();
    for (const s of ["accepted", "connected", "answering"] as const) {
      await milestone(s);
      expect(container.textContent).toContain(WAIT_SAY[s]);
      // Zero-knowledge language (§1.1): no wire vocabulary on screen.
      expect(container.textContent ?? "").not.toMatch(/runId|SSE|stream open|socket/i);
    }
  });

  test("the accessible name names the milestone, not a generic 'loading'", async () => {
    const { container, milestone } = mount();
    await milestone("accepted");
    const rail = container.querySelector(".rail")!;
    expect(rail.getAttribute("aria-label")).toBe(WAIT_SAY["accepted"]);
    expect(rail.getAttribute("aria-label") ?? "").not.toMatch(/loading|spinner|please wait/i);
  });

  test("THERE IS NO FOURTH STAGE — the ladder is exactly the three observations", () => {
    // Fewer honest steps beat more fabricated ones. A stage added to smooth
    // the motion would be a spinner wearing a milestone's clothes, so the
    // count is pinned: idle + the three.
    //
    // IT USED TO BE FOUR. `sent` was removed because it reported something
    // the reader could already see: it fired on the line after
    // `sendUserMessage`, which appends the reader's own beat SYNCHRONOUSLY,
    // so the sentence "your message is in" and the beat it describes
    // appeared in the same frame. Worse, it gave the rail exactly ONE
    // observed milestone, which lit one cell and then held there for the
    // whole of `startRun` — and a rail frozen at cell 0 is indistinguishable
    // from a broken one, which is the failure this instrument exists to
    // remove. See `wait-stage.ts` and `flow/WaitLine.svelte`.
    expect([...WAIT_STAGES]).toEqual(["idle", "accepted", "connected", "answering"]);
    expect(waitSteps("idle")).toBe(0);
    expect(waitSteps("answering")).toBe(3);
  });

  test("the store is ADVANCE-ONLY: an out-of-order observation cannot rewind it", () => {
    resetWait();
    advanceWait("connected");
    advanceWait("accepted"); // a late/duplicated earlier frame
    expect(waitStage.get()).toBe("connected");
    advanceWait("answering");
    expect(waitStage.get()).toBe("answering");
    resetWait();
    expect(waitStage.get()).toBe("idle");
  });
});

/**
 * THE SEND PATH FIRES THE THREE MILESTONES, at the three points where the
 * client genuinely learns something. Read from the source rather than from a
 * mocked run, because what is being asserted is WHERE the calls sit relative
 * to the observations they report — a call moved above its own await would
 * report a fact before it was true, and no mock can see that.
 */
describe("the milestones are wired to real observations", () => {
  const RUN = readFileSync("src/cockpit/flow/run-stream.ts", "utf8");

  test("each of the three is recorded, and only after its own observation", () => {
    // THE SEND ITSELF IS NOT A MILESTONE. `sendUserMessage` is a synchronous
    // store append, so the reader's beat is on screen in the same frame —
    // there is no window in which announcing it would tell them anything.
    // Asserted as an ABSENCE so the removed stage cannot quietly return.
    expect(RUN).not.toMatch(/advanceWait\("sent"\)/);
    // 1. accepted — after the awaited startRun resolved with a runId.
    const acceptedAt = RUN.indexOf('advanceWait("accepted")');
    const startAt = RUN.indexOf("await startRun(");
    expect(startAt).toBeGreaterThan(-1);
    expect(acceptedAt).toBeGreaterThan(startAt);
    // 2. connected — inside the stream's own `connected` handler.
    // INSIDE THE HANDLER'S OWN BODY. These were 200- and 300-byte windows, and
    // the two handlers are adjacent: the `onModelEvent` window reached past its
    // own body, so an `advanceWait("answering")` written anywhere in the next
    // few lines satisfied a claim about a handler that no longer made it.
    // THE CALL AND ITS ARGUMENT, both as names. `bodyCallsWith` asks the call
    // graph for `advanceWait` and compares the argument the PARSER delimited,
    // so `advanceWait("connected")` written across two lines is the same call
    // and a mention in a comment is not one at all.
    expect(
      bodyCallsWith(functionBody(RUN, "onConnected"), "advanceWait", ['"connected"']),
      "the connected milestone must come from the stream's own connected handler",
    ).toBe(true);
    // 3. answering — inside the model-event handler.
    expect(
      bodyCallsWith(functionBody(RUN, "onModelEvent"), "advanceWait", ['"answering"']),
      "the answering milestone must come from a received frame",
    ).toBe(true);
  });

  test("a new run starts from absence, and a finished run returns to it", () => {
    // `beginWait` clears the stage AND starts the clock the wait row reads.
    // The send's optimistic beat id may be captured for the refusal unwind
    // (a refused send takes its beat back), so the pattern allows the
    // binding without weakening the ORDER pin: the wait resets BEFORE the
    // transcript is touched.
    expect(RUN).toMatch(/beginWait\(\);\s*(?:\/\/[^\n]*\n\s*)*(?:const \w+ = )?sendUserMessage/);
    expect(
      bodyCalls(functionBody(RUN, "runEnded"), "resetWait"),
      "the run ending must clear the wait",
    ).toBe(true);
  });

  test("no timer drives any of them", () => {
    // The milestones are recorded from returns and received frames. A
    // setTimeout that advanced the stage would be exactly the spinner this
    // instrument replaced. (The ONE timer here is the run-END debounce, which
    // reports a boundary rather than progress — named, so it cannot hide.)
    // THE WHOLE ARGUMENT LIST, balanced — not the first 160 bytes of it. A
    // timer whose callback is longer than the window would have had its tail
    // unexamined, and that tail is exactly where a late `advanceWait` would
    // sit. The population is stated, because "no timer advanced the wait" and
    // "no timer was found" are the same empty result.
    const timers = callArgumentsOf(RUN, "setTimeout");
    expect(timers.length, `setTimeout call sites examined: ${timers.length}`).toBeGreaterThan(0);
    for (const args of timers) {
      expect(args, "a timer must not advance the wait").not.toContain("advanceWait");
    }
  });
});

/**
 * The deny-by-default scan, as a PURE FUNCTION so it can be mutation-tested.
 * Each pattern is a way to make something move WITHOUT anything happening,
 * which is the exact dishonesty this instrument exists to avoid.
 */
export function timerDrivenMotion(src: string): string[] {
  const BANNED: readonly RegExp[] = [
    /@keyframes/,
    /\banimation\s*:/,
    /animation-name/,
    /setInterval\s*\(/,
    /setTimeout\s*\(/,
    /requestAnimationFrame\s*\(/,
    /\binfinite\b/,
  ];
  return BANNED.filter((re) => re.test(src)).map((re) => String(re));
}

describe("while waiting for the first character, elapsed walks the rail", () => {
  test("a whole elapsed second advances the head one cell", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const { container, milestone, startAt } = mount();
    await startAt(10_000);
    await milestone("answering");
    const parked = headIndex(container);
    expect(parked).toBe(waitSteps("answering") - 1);
    expect(container.querySelector('[data-field="wait-elapsed"]')?.textContent).toBe("0.0s");
    vi.advanceTimersByTime(1_000);
    await settle();
    expect(
      headIndex(container),
      "the left rail must walk with elapsed — a frozen bar at 'the model is answering' is the stall Nielsen forbids",
    ).toBe((parked + 1) % STREAM_RAIL_CELLS);
    expect(container.querySelector('[data-field="wait-elapsed"]')?.textContent).toBe("1.0s");
    vi.useRealTimers();
  });

  test("the first character continues from the clock cell — the head does not jump back", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const { container, milestone, startAt, feed } = mount();
    await startAt(10_000);
    await milestone("answering");
    vi.advanceTimersByTime(2_000);
    await settle();
    const atTwoSeconds = headIndex(container);
    await feed("H");
    expect(
      headIndex(container),
      "latching the clock-cells is what stops the head jumping backward (never reset)",
    ).toBe((atTwoSeconds + 1) % STREAM_RAIL_CELLS);
    expect(container.querySelector('[data-field="wait-elapsed"]')).toBeNull();
    vi.useRealTimers();
  });

  test("after the first character, further time passing freezes the head again", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const { container, milestone, startAt, feed } = mount();
    await startAt(10_000);
    await milestone("answering");
    await feed("H");
    const parked = headIndex(container);
    vi.advanceTimersByTime(3_000);
    await settle();
    expect(
      headIndex(container),
      "once characters flow, a stall must still read as a stall",
    ).toBe(parked);
    vi.useRealTimers();
  });

  test("TurnBeat arms the send-clock while the turn is streaming", () => {
    const src = readFileSync("src/cockpit/flow/TurnBeat.svelte", "utf8");
    expect(src).toContain("waitStartedAt");
    expect(src).toContain("startedAt={turn.streaming ? $waitStartedAt : null}");
  });
});

describe("no idle decoration can creep back in", () => {
  test("the component declares no timer-driven or looping animation", () => {
    expect(timerDrivenMotion(SRC), "StreamPulse must contain no timer-driven motion").toEqual([]);
    expect(SRC, "the wait-clock must use the shared elapsed tick, not a private interval").toContain(
      "startElapsedTick",
    );
  });

  test("mutation: a timer-driven advance IS caught by that scan", () => {
    // The mutation the guard exists to refuse, written out: a head that
    // climbs on a clock. Each shape must be flagged on its own.
    expect(timerDrivenMotion(`setInterval(() => { head += 1; }, 90);`)).toHaveLength(1);
    expect(timerDrivenMotion(`setTimeout(() => { head += 1; }, 90);`)).toHaveLength(1);
    expect(timerDrivenMotion(`requestAnimationFrame(step);`)).toHaveLength(1);
    expect(timerDrivenMotion(`@keyframes pulse { to { opacity: 1 } }`)).toHaveLength(1);
    expect(timerDrivenMotion(`animation: pulse 1s infinite;`).length).toBeGreaterThan(1);
    // …and an honest source is not flagged (the scan does not cry wolf).
    expect(timerDrivenMotion(`const head = $derived(observed === 0 ? -1 : observed - 1);`)).toEqual([]);
  });

  test("reduced motion removes the travel transition", () => {
    expect(SRC).toMatch(/prefers-reduced-motion/);
    expect(SRC).toMatch(/transition:\s*none/);
  });

  test("the READOUT's box is fixed, so a stage change cannot resize the footer", () => {
    // Three milestone sentences and a rate/count pair share one reserved box.
    // Without it the bubble around the footer changes width every time the
    // instrument changes what it is saying — a layout shift caused by an
    // activity indicator, which the virtualizer would then have to measure.
    expect(SRC).toMatch(/\.readout\s*\{[^}]*width:\s*var\(--stream-say-w\)/);
    const tokens = readFileSync("src/cockpit/tokens.css", "utf8");
    expect(tokens, "the width has one owner and it is tokens.css").toMatch(
      /--stream-say-w:\s*\d+ch/,
    );
    // …and it is wide enough for the longest thing it can hold.
    const declared = Number(/--stream-say-w:\s*(\d+)ch/.exec(tokens)?.[1] ?? 0);
    const longest = Math.max(...Object.values(WAIT_SAY).map((t) => t.length));
    expect(declared, `the reserved box must fit "${longest} chars" of sentence`).toBeGreaterThanOrEqual(longest);
  });

  test("the rail's box is token-sized, so it cannot resize as tokens land", () => {
    // Fixed cell + rail dimensions come from tokens.css. If a cell's WIDTH
    // ever depended on the stream, the virtualizer would re-measure the beat
    // on every token.
    expect(SRC).toMatch(/--stream-cell-w/);
    expect(SRC).toMatch(/--stream-rail-h/);
    // Only colour and height travel — never width, margin, or `all`.
    const transitions = SRC.match(/transition:[\s\S]*?;/g) ?? [];
    for (const t of transitions) {
      expect(t).not.toMatch(/\bwidth\b|\bmargin\b|\ball\b/);
    }
  });
});
