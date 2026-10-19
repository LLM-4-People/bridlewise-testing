// @vitest-environment node
/**
 * Adversarial tests for the per-tool-name attempt counter (fix).
 *
 * Bug: the counter incremented on EVERY tool_call_start for a tool name, so
 * an LLM reading 5 files in a row (5 successful read_file calls) showed
 * "attempt 5" on the 5th file — a false positive. Fix: reset to 0 on
 * success; leave outstanding on failure. "attempt N" now means the
 * PREVIOUS call of the same tool name FAILED and this is a retry.
 *
 * These tests exercise the REAL decision functions imported from the
 * server (server/attempt-counter.ts) — the single owner — by
 * simulating a sequence of tool calls and verifying the displayed attempt
 * numbers match the intended behavior. hard, behavioral,
 * no faking.
 */
import { describe, test, expect } from "vitest";
import {
  attemptNumberForCall,
  nextCounterAfterCall,
} from "../../server/run/attempt-counter.ts";

/** Simulate a sequence of same-name tool calls and return the displayed
 * attempt number for each (the value the UI would badge). `successes` is a
 * parallel array of booleans — whether each call succeeded. */
function simulateSequence(successes: boolean[]): number[] {
  let counter = 0;
  const displayed: number[] = [];
  for (const success of successes) {
    const attempt = attemptNumberForCall(counter);
    displayed.push(attempt);
    counter = nextCounterAfterCall(counter, success);
  }
  return displayed;
}

describe("attempt counter — (false-positive fix)", () => {
  test("5 successful read_file calls in a row: all show 'attempt 1' (hidden, no badge)", () => {
    const out = simulateSequence([true, true, true, true, true]);
    expect(out).toEqual([1, 1, 1, 1, 1]);
    // The UI hides attemptCount > 1, so all five show NO "attempt" badge.
    expect(out.every((n) => n === 1)).toBe(true);
  });

  test("a failed call then a successful retry: retry shows 'attempt 2'", () => {
    const out = simulateSequence([false, true]);
    expect(out).toEqual([1, 2]);
    // Call 1 (fail) shows nothing (attempt 1, hidden); retry shows "attempt 2".
    expect(out[1]).toBe(2);
  });

  test("a failed call then 2 more failed retries: attempts 1, 2, 3", () => {
    const out = simulateSequence([false, false, false]);
    expect(out).toEqual([1, 2, 3]);
  });

  test("after a failed-then-success, the NEXT same-name call resets to attempt 1", () => {
    // fail, retry-succeeds (attempt 2), then a fresh read_file (attempt 1).
    const out = simulateSequence([false, true, true]);
    expect(out).toEqual([1, 2, 1]);
  });

  test("interleaved: read, read, fail, retry, read → 1,1,1,2,1", () => {
    const out = simulateSequence([true, true, false, true, true]);
    expect(out).toEqual([1, 1, 1, 2, 1]);
  });

  test("two DIFFERENT tool names are independent (per-name counter)", () => {
    // Simulate read_file x2 (success) then search_code x1 (fail) then
    // read_file x1 (success): read_file resets between, search_code starts
    // fresh. Each name has its own counter.
    let readCtr = 0;
    let searchCtr = 0;
    const displayed: number[] = [];
    // read_file #1 success
    displayed.push(attemptNumberForCall(readCtr));
    readCtr = nextCounterAfterCall(readCtr, true);
    // read_file #2 success
    displayed.push(attemptNumberForCall(readCtr));
    readCtr = nextCounterAfterCall(readCtr, true);
    // search_code #1 fail
    displayed.push(attemptNumberForCall(searchCtr));
    searchCtr = nextCounterAfterCall(searchCtr, false);
    // read_file #3 success (independent of search_code)
    displayed.push(attemptNumberForCall(readCtr));
    readCtr = nextCounterAfterCall(readCtr, true);
    expect(displayed).toEqual([1, 1, 1, 1]);
  });
});

describe("attempt counter — improper usage", () => {
  test("attemptNumberForCall(0) === 1 (fresh call, hidden)", () => {
    expect(attemptNumberForCall(0)).toBe(1);
  });

  test("nextCounterAfterCall success always resets to 0 regardless of prev", () => {
    expect(nextCounterAfterCall(0, true)).toBe(0);
    expect(nextCounterAfterCall(5, true)).toBe(0);
    expect(nextCounterAfterCall(99, true)).toBe(0);
  });

  test("nextCounterAfterCall failure leaves the attempt outstanding (prev + 1)", () => {
    expect(nextCounterAfterCall(0, false)).toBe(1);
    expect(nextCounterAfterCall(1, false)).toBe(2);
    expect(nextCounterAfterCall(4, false)).toBe(5);
  });
});
