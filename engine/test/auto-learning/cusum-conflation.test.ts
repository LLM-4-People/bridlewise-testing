// Regression test for EXP451: CUSUM score conflation.
// Root cause: CUSUM was pushed to the `extraction` array alongside actual
// extractors (frequency, apriori, GA). The score function (recall - fpRate)
// then declared CUSUM the "best extractor" (recall=1, fp=0) — but CUSUM is
// a TRIGGER (when to learn), not an EXTRACTOR (what patterns to learn).
// Fix: separate triggers from extractors. CUSUM is in `triggers`, not `extraction`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { bindingValueOf } from "../../src/shared/source-structure.ts";

test("CUSUM is NOT in the extraction array (separated as a trigger)", () => {
  const src = readFileSync("_experiments/auto-learning/benchmark.ts", "utf8");
  // The CUSUM push must go to `triggers`, not `extraction`.
  const cusumPushMatch = src.match(/name:\s*"cusum"[\s\S]*?triggers\.push|triggers\.push[\s\S]*?name:\s*"cusum"/);
  assert.ok(cusumPushMatch, "CUSUM must be pushed to the `triggers` array, not `extraction`");
  // The extraction array must NOT contain "cusum".
  const extractionSection = src.slice(src.indexOf("const extraction:"), src.indexOf("const triggers:"));
  assert.doesNotMatch(extractionSection, /name:\s*"cusum"/,
    "the extraction section must NOT contain cusum");
});

test("benchmark separates triggers from extractors (triggers array exists)", () => {
  const src = readFileSync("_experiments/auto-learning/benchmark.ts", "utf8");
  assert.match(src, /const triggers:\s*TechniqueResult\[\]/, "a `triggers` array must be declared");
  assert.match(src, /bestTrigger/, "the report must include `bestTrigger`");
  assert.match(src, /triggers:\s*ReadonlyArray<TechniqueResult>/, "BenchmarkReport must have a `triggers` field");
});

test("bestExtractor does NOT include cusum (it's a trigger)", () => {
  const src = readFileSync("_experiments/auto-learning/benchmark.ts", "utf8");
  // bestExtractor is computed from `extraction` only; cusum is in `triggers`.
  //
  // THE SUBJECT IS THE DECLARATION'S OWN VALUE, not the text between its name
  // and the next thing that looks like the end of it. The retired form was
  // `/const bestExtractor[\s\S]*?\.name\s*\?\?\s*"none"/`, and a sibling
  // `bestTrigger = …?.name ?? "none"` declared above it makes the lazy run stop
  // at the NEIGHBOUR — the extracted region is then the wrong declaration and
  // this assertion's verdict flips.
  const bestExtractor = bindingValueOf(src, "bestExtractor", "_experiments/auto-learning/benchmark.ts");
  assert.doesNotMatch(bestExtractor.body, /triggers/, "bestExtractor must NOT reference triggers");
});
