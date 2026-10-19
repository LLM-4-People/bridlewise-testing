// @vitest-environment node
/**
 * Flow latency budgets (spec §1.5 F2, enforced in CI):
 *   live event → its beat in the log     well under the 100ms screen budget
 *   5k-message hydration → full rebuild  bounded (one-off chat switch cost)
 *   one virtualizer frame on a 5k log    inside the 16ms frame
 *
 * These are the CPU-side halves of the budgets; the paint halves are
 * asserted in the jsdom virtualizer test (append→DOM < 100ms) and observed
 * on the dev harness in a real browser.
 *
 * ── MEASUREMENT: THE BEST OF SEVERAL RUNS, NEVER ONE SAMPLE ──────────────
 *
 * `render-perf.test.ts` already states this and this file did not follow it,
 * which is why it was flaky: the live-event budget failed whenever ambient
 * load crossed ~13, and was observed red at loadavg 7.77 in a full run.
 *
 * The suite runs 400+ files in parallel worker processes, so a LONE timing
 * measures scheduler contention as much as it measures the code. A budget
 * that a busy machine can fail is not a budget — it reports the box, and it
 * trains people to re-run until green, which is how a real regression gets
 * dismissed as flakiness.
 *
 * The MINIMUM of several samples is the least-disturbed one, so it measures
 * the work itself. That keeps the number an honest 10ms rather than one
 * inflated to absorb noise: taking the best sample TIGHTENS the assertion
 * instead of loosening it, which is the whole reason it is the right answer
 * here and raising the threshold is not.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  appendMessage,
  clearMessages,
  setMessages,
  type ChatMessage,
} from "../../src/state/chat-messages.ts";
import { resetIngest, startIngest } from "../../src/cockpit/flow/ingest.ts";
import { beatCount, windowSlice, clearLog, appendBeat, batch } from "../../src/cockpit/flow/log.ts";
import { HeightIndex } from "../../src/cockpit/flow/heights.ts";
import { fisheyeLevel } from "../../src/cockpit/flow/fisheye.ts";
import { syntheticBeats } from "../../src/cockpit/flow/dev/synthetic.ts";
import { resetAdmission } from "../../src/cockpit/computer/admission.ts";

function history(n: number): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push(
      i % 3 === 0
        ? { id: `h-u-${i}`, role: "user", content: `prompt ${i}`, timestamp: i }
        : i % 3 === 1
          ? {
              id: `h-a-${i}`,
              role: "assistant",
              content: `answer ${i} `.repeat(20),
              timestamp: i,
              tokenMetrics: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 },
            }
          : {
              id: `h-t-${i}`,
              role: "tool",
              content: "",
              timestamp: i,
              toolCall: {
                id: `tc-${i}`,
                name: "read_file",
                input: { path: `f${i}.ts` },
                output: "data",
                status: "done",
                startedAt: i,
              },
            },
    );
  }
  return out;
}

beforeEach(() => {
  clearMessages();
  resetAdmission();
  resetIngest();
});
afterEach(() => {
  resetIngest();
  clearMessages();
  resetAdmission();
});

describe("latency budgets on a 5k log", () => {
  test("hydrating 5k messages rebuilds the whole log inside 1.5s (one-off)", () => {
    startIngest();
    const t0 = performance.now();
    setMessages(history(5000));
    const ms = performance.now() - t0;
    expect(beatCount()).toBe(5000);
    expect(ms).toBeLessThan(1500);
  });

  test("ONE live event lands in the log far under the 100ms budget", () => {
    startIngest();
    setMessages(history(5000));
    // Each sample is a DISTINCT append — the same message id twice would be
    // deduplicated and the second "append" would time a no-op, which is the
    // easy way to make this budget pass while measuring nothing.
    const SAMPLES = 7;
    let best = Number.POSITIVE_INFINITY;
    for (let s = 0; s < SAMPLES; s += 1) {
      const t0 = performance.now();
      appendMessage({ id: `h-u-live-${s}`, role: "user", content: "live", timestamp: 9e9 + s });
      const ms = performance.now() - t0;
      if (ms < best) best = ms;
    }
    // Every sample must have landed, or the "best" is the cost of a rejected
    // append rather than of an accepted one.
    expect(beatCount()).toBe(5000 + SAMPLES);
    // CPU half of the event→screen budget; leave ≥90ms for paint.
    expect(best, `${best.toFixed(3)}ms for the least-disturbed of ${SAMPLES} appends`).toBeLessThan(
      10,
    );
  });

  test("one full virtualizer frame (window math + fisheye) fits the 16ms frame", () => {
    clearLog();
    batch(() => {
      for (const b of syntheticBeats(5000)) appendBeat(b);
    });
    const idx = new HeightIndex(56, 16);
    idx.append(5000);
    for (let i = 0; i < 5000; i += 1) idx.update(i, 24 + (i % 300));

    const FRAMES = 50;
    const oneSweep = (): void => {
      for (let f = 0; f < FRAMES; f += 1) {
        const scrollTop = (f * 3777) % (idx.totalHeight() - 1000);
        const start = Math.max(0, idx.indexAtOffset(scrollTop) - 6);
        const end = Math.min(5000, idx.indexAtOffset(scrollTop + 900) + 7);
        const slice = windowSlice(start, end);
        for (let k = 0; k < slice.length; k += 1) {
          idx.offsetOf(start + k);
          fisheyeLevel({
            beat: slice[k]!,
            focusTurnIndex: 40,
            onFocusChain: false,
            latestTurnIndex: 80,
          });
        }
      }
    };
    // Best of several sweeps — the least-disturbed one measures the window
    // math rather than the worker scheduler. See the header.
    let best = Number.POSITIVE_INFINITY;
    for (let s = 0; s < 3; s += 1) {
      const t0 = performance.now();
      oneSweep();
      const msPerFrame = (performance.now() - t0) / FRAMES;
      if (msPerFrame < best) best = msPerFrame;
    }
    expect(best, `${best.toFixed(3)}ms per frame`).toBeLessThan(16);
  });
});
