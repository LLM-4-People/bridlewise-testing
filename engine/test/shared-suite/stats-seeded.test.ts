/**
 * THE ONE SEEDED RANDOM SOURCE (`src/shared/stats.ts`; prompt-registry F-PR-7).
 *
 * The evaluation matrix executor held a private mulberry32; it now draws from
 * the shared `seededRandom`/`seededShuffle`, which the prompt experiments'
 * assignment reuses. A seed must reproduce the same sequence in every process
 * and after this move: the golden values below are the private copy's own
 * output for the CHEP master seed, so an evaluation run shuffles its eligible
 * cells exactly as it did.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { seededRandom, seededShuffle } from "../../src/shared/stats.ts";

const CHEP_SEED = 0x4825f13e;

test("stats: seededRandom reproduces the evaluation's former private sequence for its seed", () => {
  const next = seededRandom(CHEP_SEED);
  assert.deepEqual([next(), next(), next()], [0.7036034595221281, 0.8861647688318044, 0.5442889267578721]);
  const again = seededRandom(CHEP_SEED);
  assert.equal(again(), 0.7036034595221281, "the same seed restarts the same sequence");
  for (let i = 0; i < 1000; i += 1) {
    const value = next();
    assert.ok(value >= 0 && value < 1, `a value in [0, 1): ${value}`);
  }
});

test("stats: seededShuffle is a seeded permutation, identical to the executor's former order", () => {
  const items = ["a", "b", "c", "d", "e", "f", "g", "h"];
  assert.deepEqual(seededShuffle(items, CHEP_SEED), ["c", "b", "h", "a", "e", "d", "g", "f"]);
  assert.deepEqual([...seededShuffle(items, CHEP_SEED)].sort(), items, "a permutation: nothing lost or added");
  assert.deepEqual(items, ["a", "b", "c", "d", "e", "f", "g", "h"], "the input is not mutated");
  assert.notDeepEqual(seededShuffle(items, CHEP_SEED + 1), seededShuffle(items, CHEP_SEED), "another seed, another order");
  assert.deepEqual(seededShuffle(["only"], CHEP_SEED), ["only"]);
  assert.deepEqual(seededShuffle([], CHEP_SEED), []);
});
