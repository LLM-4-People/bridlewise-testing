// @vitest-environment node
/**
 * TTFT — TIME TO THE FIRST TOKEN OF ANY KIND, thinking included.
 *
 * A DESIGN DECISION (provenance corrected — not a user instruction)
 *   "for thinking models, ttft is from the time it starts thinking"
 *   [FABRICATED QUOTE REMOVED — the user never said this; the decision below stands on its own merits]
 *   (design decision: one number, deduped at its owner)
 *   [FABRICATED QUOTE REMOVED — the user never said this; the decision below stands on its own merits]
 *
 * Three things are under test here and the third is the one that matters most:
 *
 *   1. THE MEASUREMENT — the clock starts at the turn's `start` frame and
 *      stops at the first token of EITHER kind, from received frames only.
 *   2. THE OBSERVED BOUNDARY — `answerStarted` flips on a `text_delta` and on
 *      nothing else, and reaches the beat even though the transcript is
 *      deliberately not rewritten per token.
 *   3. THE HONESTY OF THE LABEL — which recorded number is entitled to be
 *      called "ttft". A turn with no thinking may use the long-recorded
 *      answer-word latency, because for that turn the two ARE the same
 *      quantity. A turn that DID think may not, because they are not. Nothing
 *      recorded is redefined, so no comparison across today can be misled.
 *
 * Each block names the mutation that breaks it; every one was applied to the
 * real source, proved to change it, observed to fail, and reverted.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  noteOutputDelta,
  noteToolInputDelta,
  noteTurnEnd,
  noteTurnStart,
  resetTurnTimings,
  turnLatency,
  turnTimingFor,
} from "../../src/cockpit/flow/turn-timing.ts";
import { resetIngest, startIngest } from "../../src/cockpit/flow/ingest.ts";
import { beatCount, windowSlice } from "../../src/cockpit/flow/log.ts";
import {
  appendMessage,
  clearMessages,
  appendUserMessage,
  setStreaming,
  type ChatMessage,
} from "../../src/state/chat-messages.ts";
import { resetAdmission } from "../../src/cockpit/computer/admission.ts";
import type { Beat, TurnBody } from "../../src/cockpit/flow/types.ts";

let n = 0;
function assistant(id: string, content = "", extra: Partial<ChatMessage> = {}): ChatMessage {
  n += 1;
  return { id, role: "assistant", content, timestamp: 1_000 + n, ...extra } as ChatMessage;
}

function modelBeats(): readonly Beat[] {
  return windowSlice(0, beatCount()).filter(
    (b) => b.kind === "turn" && b.turn?.who === "model",
  );
}

function turnOf(over: Partial<TurnBody>): TurnBody {
  return { who: "model", text: "", streaming: false, ...over };
}

beforeEach(() => {
  clearMessages();
  resetAdmission();
  resetIngest();
  resetTurnTimings();
  setStreaming(false);
});
afterEach(() => {
  resetIngest();
  clearMessages();
  resetTurnTimings();
  resetAdmission();
  setStreaming(false);
});

// ── 1. The measurement ────────────────────────────────────────────────────

describe("the clock stops at the first token of ANY kind", () => {
  test("a THINKING token stops it — that is the whole ruling", () => {
    // MUTATION: in `noteOutputFrame` (run-stream.ts) drop the
    // `reasoning_delta` from the accepted types, or in `noteOutputDelta`
    // ignore the "thinking" kind, and the clock runs on to the answer — the
    // 26s and 136s latencies the user was shown.
    noteTurnStart("m1", 1_000);
    noteOutputDelta("m1", "thinking", 1_340);
    expect(turnTimingFor("m1")?.firstOutputMs).toBe(340);
    // A later ANSWER token does not move a clock that has already stopped.
    noteOutputDelta("m1", "answer", 13_400);
    expect(turnTimingFor("m1")?.firstOutputMs).toBe(340);
  });

  test("with no thinking it is simply the first token — no special case", () => {
    noteTurnStart("m2", 1_000);
    noteOutputDelta("m2", "answer", 1_820);
    expect(turnTimingFor("m2")?.firstOutputMs).toBe(820);
  });

  test("a turn with no `start` frame reports no latency rather than a zero", () => {
    // §1.1: absence is absence. A delta whose turn-start was never observed
    // has no clock to have stopped, and inventing 0ms would be fabrication.
    noteOutputDelta("m3", "answer", 5_000);
    expect(turnTimingFor("m3")?.firstOutputMs).toBeUndefined();
    expect(turnTimingFor("m3")?.answerStarted).toBe(true);
    noteToolInputDelta("m3", 12, 5_100);
    noteOutputDelta("m3", "answer", 5_200, 5);
    noteTurnEnd("m3", 5_500);
    expect(turnTimingFor("m3")?.firstOutputMs, "later fresh output cannot invent a missed start").toBeUndefined();
    expect(turnTimingFor("m3")?.generationMs).toBeUndefined();
    expect(turnTimingFor("m3")?.observedChars, "fresh continuation still counts actual arrivals").toBe(17);
  });

  test("nothing is reported for a turn nobody observed", () => {
    expect(turnTimingFor("never-seen")).toBeUndefined();
  });
});

// ── 2. The observed boundary ──────────────────────────────────────────────

describe("answerStarted is an observed frame, never an inference", () => {
  test("thinking alone never claims the answer began", () => {
    // MUTATION: set `answerStarted` for either kind in `noteOutputDelta` and
    // the thinking block folds away the instant it opens.
    noteTurnStart("m4", 0);
    noteOutputDelta("m4", "thinking", 10);
    noteOutputDelta("m4", "thinking", 20);
    expect(turnTimingFor("m4")?.answerStarted).toBe(false);
    noteOutputDelta("m4", "answer", 30);
    expect(turnTimingFor("m4")?.answerStarted).toBe(true);
  });

  test("an answer that began cannot un-begin", () => {
    noteTurnStart("m5", 0);
    noteOutputDelta("m5", "answer", 10);
    noteOutputDelta("m5", "thinking", 20);
    expect(turnTimingFor("m5")?.answerStarted).toBe(true);
  });

  test("it reaches the BEAT, which the transcript alone could never tell it", () => {
    // The transcript is deliberately not rewritten per answer token (the O(1)
    // streaming property, §3.8), so `messages` never fires for a text_delta.
    // MUTATION: remove the `turnTimingVersion.subscribe(...)` line from
    // startIngest and the beat never learns the answer began — the block then
    // stays open until the whole turn ends.
    startIngest({ seamDebounceMs: 0 });
    appendUserMessage("think about it");
    setStreaming(true);
    appendMessage(assistant("live-1", "", { reasoning: "hmm" }));
    expect(modelBeats()[0]!.turn!.answerStarted).toBeUndefined();

    noteTurnStart("live-1", 1_000);
    noteOutputDelta("live-1", "thinking", 1_200);
    expect(modelBeats()[0]!.turn!.firstOutputMs).toBe(200);
    expect(modelBeats()[0]!.turn!.answerStarted).toBeUndefined();

    noteOutputDelta("live-1", "answer", 9_000);
    expect(modelBeats()[0]!.turn!.answerStarted).toBe(true);
    expect(modelBeats()[0]!.turn!.firstOutputMs).toBe(200);
  });

  test("a measurement taken is a measurement kept when the record is renamed", () => {
    // A re-read of the same conversation comes back with every message under
    // its DATABASE id. The beats keep their ids (ingest.ts `sameRecord`), so
    // the timing map's key is gone — and the latency this session measured
    // must not vanish off a turn nobody touched.
    // MUTATION: delete the `carryTurnTiming(...)` wrapper in `syncInto` and
    // the number disappears on the re-read.
    startIngest({ seamDebounceMs: 0 });
    appendUserMessage("go");
    setStreaming(true);
    appendMessage(assistant("client-1", "", { reasoning: "hmm" }));
    noteTurnStart("client-1", 0);
    noteOutputDelta("client-1", "thinking", 250);
    expect(modelBeats()[0]!.turn!.firstOutputMs).toBe(250);

    // The same record, renamed, with its text committed — and the timing map
    // emptied, exactly as an eviction or a reload would leave it.
    resetTurnTimings();
    setStreaming(false);
    appendMessage(assistant("client-2", "second turn"));
    expect(modelBeats()[0]!.turn!.firstOutputMs).toBe(250);
  });
});

// ── 3. Which number may be called "ttft" ──────────────────────────────────

describe("the label is earned, per turn, from that turn's own record", () => {
  test("no thinking: the recorded answer-word latency IS the ttft", () => {
    // Every non-thinking turn already in the database reads correctly under
    // the new name, because for it the two quantities are one quantity.
    // MUTATION: drop the `(thought ? undefined : turn.firstWordMs)` fallback
    // and every historical turn loses its latency for no reason.
    expect(turnLatency(turnOf({ text: "hi", firstWordMs: 820 }))).toEqual({ ttftMs: 820 });
  });

  test("thinking: the answer-word latency may NOT be called ttft", () => {
    // THE LIE THIS PREVENTS: printing a 136-second answer-word latency under a
    // name that claims the reader waited that long for the first sign of life.
    // MUTATION: return `{ ttftMs: turn.firstOutputMs ?? turn.firstWordMs }`
    // and this fails — that mutation IS the silent redefinition.
    expect(
      turnLatency(turnOf({ text: "hi", reasoning: "long think", firstWordMs: 136_000 })),
    ).toEqual({});
  });

  test("thinking, measured live: the real ttft wins over the recorded one", () => {
    expect(
      turnLatency(
        turnOf({ text: "hi", reasoning: "long think", firstOutputMs: 340, firstWordMs: 136_000 }),
      ),
    ).toEqual({ ttftMs: 340 });
  });

  test("EXACTLY ONE latency is ever returned — the dedup, mechanically", () => {
    // A DESIGN DECISION (not a user correction — an earlier comment fabricated it):
    // make sure you dedup" and "you left the first answer word, it should
    // [FABRICATED QUOTE REMOVED — the user never said this; the decision below stands on its own merits]". MUTATION: add any second latency key back to
    // `TurnLatency` and return it, and this fails.
    const cases: TurnBody[] = [
      turnOf({ text: "hi", firstWordMs: 820 }),
      turnOf({ text: "hi", reasoning: "r", firstOutputMs: 340, firstWordMs: 12_400 }),
      turnOf({ text: "hi", reasoning: "r", firstWordMs: 12_400 }),
      turnOf({ text: "hi", firstOutputMs: 200, firstWordMs: 200 }),
      turnOf({ text: "hi" }),
    ];
    for (const turn of cases) {
      const keys = Object.keys(turnLatency(turn));
      expect(keys.length, `expected at most one latency, got ${keys.join(", ")}`).toBeLessThanOrEqual(1);
      for (const k of keys) expect(k).toBe("ttftMs");
    }
  });

  test("nothing measured renders as nothing", () => {
    expect(turnLatency(turnOf({ text: "hi", reasoning: "r" }))).toEqual({});
    expect(turnLatency(turnOf({ text: "hi" }))).toEqual({});
  });
});

// ── tok/s: the slot that was always empty ─────────────────────────────────

describe("tokens per second, measured rather than inherited", () => {
  test("the rate is computed from the MEASURED window and the turn's own tokens", () => {
    // A DESIGN DECISION (provenance corrected — not a user instruction) "[FABRICATED QUOTE REMOVED — the user never said this; the decision below stands on its own merits]
    // message, just beside where 'first word' is". The slot existed and was
    // permanently empty, because THIS PROVIDER SENDS `usage` AFTER `finish` —
    // verified on the wire — and `src/client.ts` computes the rate in its
    // finish handler, guarded on token counts that do not exist yet. It never
    // recomputes when they land.
    //
    // Holding the WINDOW and dividing at render time is what makes the arrival
    // order irrelevant. MUTATION: drop the `generationMs` branch from
    // `turnLatency` and the rate goes back to being undefined for every turn
    // on this provider.
    expect(
      turnLatency(turnOf({ text: "hi", outputTokens: 573, generationMs: 10_000 })).tokPerSec,
    ).toBe(57.3);
  });

  test("…and it is available even though the token count arrived after the finish frame", () => {
    // The window closes at `finish` with no tokens known; `usage` completes it.
    const atFinish = turnOf({ text: "hi", generationMs: 4_000 });
    expect(turnLatency(atFinish).tokPerSec).toBeUndefined();
    const afterUsage = turnOf({ text: "hi", generationMs: 4_000, outputTokens: 200 });
    expect(turnLatency(afterUsage).tokPerSec).toBe(50);
  });

  test("no thinking: the recorded rate is over the same window and is used as it stands", () => {
    expect(turnLatency(turnOf({ text: "hi", tokPerSec: 41 })).tokPerSec).toBe(41);
  });

  test("thinking: the live window wins; the recorded rate is what a refresh keeps", () => {
    // generationMs is frames, gone on a re-read. The recorded tokPerSec is
    // the stamp finish/usage wrote — the same number the live footer showed.
    // MUTATION: refuse `turn.tokPerSec` whenever the turn thought, and a
    // refresh of a thinking turn blanks the rate.
    expect(
      turnLatency(turnOf({ text: "hi", reasoning: "a long think", tokPerSec: 18.4 })).tokPerSec,
    ).toBe(18.4);
    // The live window still wins when both exist (honest first-token-of-any-kind).
    expect(
      turnLatency(
        turnOf({
          text: "hi",
          reasoning: "a long think",
          tokPerSec: 900,
          outputTokens: 300,
          generationMs: 30_000,
        }),
      ).tokPerSec,
    ).toBe(10);
  });

  test("a zero-length window yields no rate rather than an infinity", () => {
    expect(
      turnLatency(turnOf({ text: "hi", outputTokens: 10, generationMs: 0 })).tokPerSec,
    ).toBeUndefined();
  });

  test("the window is closed by the finish frame, from the first token of ANY kind", () => {
    // MUTATION: measure `generationMs` from `startedAt` instead of from the
    // first token and the rate silently includes the model's pre-output wait,
    // understating the throughput by however long it stalled.
    noteTurnStart("m-gen", 1_000);
    noteOutputDelta("m-gen", "thinking", 3_000);
    noteTurnEnd("m-gen", 13_000);
    expect(turnTimingFor("m-gen")?.generationMs).toBe(10_000);
    const original = turnTimingFor("m-gen");
    // A parked transcript can be empty while its existing clock survives.
    // Replay then arrives before history and is admitted by the transcript.
    noteTurnStart("m-gen", 80_000);
    noteOutputDelta("m-gen", "thinking", 81_000, 7);
    noteToolInputDelta("m-gen", 20, 82_000);
    noteTurnEnd("m-gen", 83_000);
    expect(turnTimingFor("m-gen"), "replay before hydration cannot extend a closed producing window or count its output twice").toEqual(original);
  });

  test("a turn that produced no token gets no window", () => {
    noteTurnStart("m-silent", 0);
    noteTurnEnd("m-silent", 5_000);
    expect(turnTimingFor("m-silent")?.generationMs).toBeUndefined();
    const original = turnTimingFor("m-silent");
    noteToolInputDelta("m-silent", 20, 82_000);
    noteOutputDelta("m-silent", "answer", 82_500, 3);
    noteTurnEnd("m-silent", 83_000);
    expect(turnTimingFor("m-silent"), "a silent ending stays closed without inventing an output window").toEqual(original);
  });
});

// ── A span that does not make sense is no span ────────────────────────────

describe("a clock that goes backwards produces absence, never a zero", () => {
  test("a backwards jump before the first token records NO ttft", () => {
    // `Math.max(0, at - startedAt)` would report "ttft 0ms" here: a
    // measurement nobody took, printed as one. An NTP correction mid-turn is
    // the ordinary way this happens.
    // MUTATION: restore the `Math.max(0, …)` clamp and this fails with 0.
    noteTurnStart("m-back", 10_000);
    noteOutputDelta("m-back", "answer", 4_000);
    expect(turnTimingFor("m-back")?.firstOutputMs).toBeUndefined();
  });

  test("a backwards jump before the finish frame records NO window", () => {
    // A zero window would print an INFINITE tok/s.
    // MUTATION: restore the clamp in `noteTurnEnd` and `generationMs` is 0,
    // which `turnLatency` then divides by.
    noteTurnStart("m-back2", 0);
    noteOutputDelta("m-back2", "answer", 1_000);
    noteTurnEnd("m-back2", 500);
    expect(turnTimingFor("m-back2")?.generationMs).toBeUndefined();
  });

  test("and a zero-length window still yields no rate rather than an infinity", () => {
    expect(
      turnLatency(turnOf({ text: "hi", outputTokens: 10, generationMs: 0 })).tokPerSec,
    ).toBeUndefined();
  });
});
