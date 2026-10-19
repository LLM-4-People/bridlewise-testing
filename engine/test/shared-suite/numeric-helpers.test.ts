import assert from "node:assert/strict";
import test from "node:test";

import { InputError } from "../../src/kernel/errors.ts";
import { clamp, percentile, round, roundKeepNonFinite } from "../../src/shared/numeric-helpers.ts";
import { computePercentiles } from "../../src/performance/benchmark-runner.ts";

/**
 * ONE PERCENTILE, ONE UNIT, ONE OWNER.
 *
 * ── THE DEFECT, DRIVEN ────────────────────────────────────────────────────
 *
 * `percentile(xs, 50)` returned THE MAXIMUM. The parameter was a fraction and
 * nothing said so, so a percent computed `floor(50 * length)`, clamped to the
 * last index, and produced a number that was plausible, in the right units,
 * from the right array, and wrong — a maximum is indistinguishable from a high
 * percentile by inspection.
 *
 * Three functions across these two repositories were called "percentile" and
 * disagreed about what the second argument means:
 *
 *   src/shared/numeric-helpers.ts  fraction 0..1, nearest rank
 *   web bench/lib/stats.ts         PERCENT 0..100, interpolated, NaN on empty
 *   src/shared/stats.ts            percentileOf — the INVERSE function
 *
 * plus a fourth, private, byte-identical copy of the first inside
 * `computePercentiles`. Three contracts behind one word only ever surfaces in
 * the answer, so the unit is now enforced instead of documented.
 */

test("numeric-helpers: percentile takes a FRACTION and refuses a percent", () => {
  const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  // The contract, stated on values where a wrong unit is visible.
  assert.equal(percentile(xs, 0), 1);
  assert.equal(percentile(xs, 0.5), 6);
  assert.equal(percentile(xs, 1), 10);

  // THE DEFECT, as it behaved: the old body returned `xs[min(9, floor(50*10))]`
  // — the maximum — for every percent anyone could pass. Now every one of them
  // is a refusal, and the message names the fix rather than the internals.
  for (const percent of [50, 95, 99, 100, 1.0001]) {
    assert.throws(
      () => percentile(xs, percent),
      (error: unknown) => {
        assert.ok(error instanceof InputError);
        assert.equal(error.code, "input_invalid");
        assert.match(error.message, /fraction between 0 and 1/u);
        assert.match(error.message, /divide by 100/u);
        return true;
      },
      `percentile(xs, ${percent}) must refuse, not return the maximum`,
    );
  }

  // And the mutation that proves the refusal changed an ANSWER: the old rank
  // rule, applied to a percent, is exactly the last element.
  const oldRankRule = (p: number): number => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))]!;
  assert.equal(oldRankRule(50), 10);
  assert.notEqual(oldRankRule(50), percentile(xs, 0.5));
});

test("numeric-helpers: percentile refuses an empty distribution and a non-finite fraction", () => {
  // Zero was a real value for most callers, so the old `return 0` on empty was
  // an unmeasured quantity presented as a measurement — indistinguishable
  // downstream from a genuine zero.
  assert.throws(() => percentile([], 0.5), (error: unknown) => {
    assert.ok(error instanceof InputError);
    assert.match(error.message, /no samples/u);
    return true;
  });
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -0.5]) {
    assert.throws(() => percentile([1, 2, 3], bad), InputError);
  }
});

test("numeric-helpers: computePercentiles consumes the shared owner and did not change its answers", () => {
  // `computePercentiles` carried a byte-identical private copy of the rank
  // rule. Collapsing it must be behaviour-preserving, so the values are
  // pinned against the shared owner on the same input.
  const durations = [90, 10, 50, 30, 70, 20, 100, 40, 80, 60];
  const sorted = [...durations].toSorted((a, b) => a - b);
  const result = computePercentiles(durations);
  assert.deepEqual(
    { p50: result.p50, p95: result.p95, p99: result.p99 },
    { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), p99: percentile(sorted, 0.99) },
  );
  assert.deepEqual({ p50: result.p50, p95: result.p95, p99: result.p99 }, { p50: 60, p95: 100, p99: 100 });

  // The one place a zero is honest: no samples were taken, and the caller's
  // own guard says so before the owner is ever consulted.
  assert.deepEqual(computePercentiles([]), { p50: 0, p95: 0, p99: 0 });
});

test("numeric-helpers: round, roundKeepNonFinite and clamp keep their distinct contracts", () => {
  // These three sit beside `percentile` and are the reason a shared numeric
  // module exists at all; the pair of rounders differ ONLY in their non-finite
  // policy, which is exactly the kind of near-duplicate that produced the
  // percentile defect. Both policies are asserted so neither can absorb the
  // other.
  assert.equal(round(1.005, 2), 1);
  assert.equal(round(Number.NaN, 2), 0);
  assert.ok(Number.isNaN(roundKeepNonFinite(Number.NaN, 2)));
  assert.equal(roundKeepNonFinite(Number.POSITIVE_INFINITY, 2), Number.POSITIVE_INFINITY);
  assert.equal(clamp(5, 1, 3), 3);
  assert.equal(clamp(-5, 1, 3), 1);
});
