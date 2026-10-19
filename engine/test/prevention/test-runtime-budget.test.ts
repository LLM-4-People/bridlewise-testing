// Test-runtime budget — THE TREE'S HALF of the gate. The RUN'S half lives in
// the runner.
//
// This file used to BE the gate: it read the previous run's wall clock from
// `latest-summary.json` and compared it against `suiteRuntimeBudgetMs`. That
// design carried every defect its web-side sibling had already been convicted
// of, plus its own:
//   - it judged WALL CLOCK, which moves +73% under contention while CPU moves
//     +2.6% on the same unchanged tree — a cap on the box, not the suite;
//   - it judged the PREVIOUS run (a test inside a run cannot read that run's
//     own total), so a spike in one run reddened the next clean one;
//   - it had THREE silent refusal paths scored as PASS: summary absent,
//     wallClockMs absent, corrupt JSON — each a bare `return` out of the test
//     body. Its header called that "absence of evidence is not evidence of
//     regression". THAT DOCTRINE IS SUPERSEDED: absence of evidence is a
//     first-class NOT-JUDGED result that must be SAID, because a guard with
//     no evidence is OFF, and a green that cannot be told from OFF certifies
//     nothing;
//   - its number fell back to a silent 120 s default nobody had chosen.
//
// The gate now lives where the evidence lives: `scripts/run-tests.ts` judges
// the run it just ran — CPU per test file from the runner's own reaped-child
// accounting, population from the pinned inventory, compile-cache warmth from
// an mtime scan — through the SHARED verdict owner
// `src/shared/budget-verdict.ts` (the same module the web suite consumes),
// appends judged runs to the run-history ledger, prints every NOT-JUDGED, and
// exits non-zero on a failed gate. Those behaviours are driven in
// `test/prevention/suite-cpu-budget.test.ts`.
//
// What is left HERE has no run in it: the declaration exists in the config
// (missing configuration is a red in the tree, unlike missing evidence, which
// is a not-judged in the run), its values sit inside the ranges their
// derivations allow, and the runner is actually wired to the shared judge —
// because a judge nothing calls is the correct-and-unplugged shape, and
// deleting the wiring would otherwise be a green run.

import { test } from "node:test";
import assert from "node:assert/strict";

import { readTestExecutionConfig } from "../../src/workflow/test-result-collector.ts";
import { readSourceView } from "../../scripts/verification/source-view.ts";

test("test-runtime budget: the integration CPU budget is DECLARED in the config", () => {
  const config = readTestExecutionConfig(process.cwd());
  const declared = config.integrationSuiteCpuBudget;
  assert.ok(
    declared !== undefined,
    "testExecution.integrationSuiteCpuBudget is not declared in bridlewise.config.json. " +
      "There is no default and no fallback — a budget nobody chose is not a budget — so an " +
      "undeclared budget is a defect in the TREE, and this test is where it reds.",
  );
  if ("phase" in declared) {
    // ACCUMULATION: no cap yet, and none guessed. The bounds are the ones
    // the mechanism's own derivation needs.
    assert.equal(declared.phase, "accumulation");
    assert.ok(
      Number.isInteger(declared.minimumJudgedRuns) && declared.minimumJudgedRuns >= 2,
      "a cap derived from fewer than 2 judged runs is a single reading wearing a median's clothes",
    );
    assert.ok(
      declared.maxPopulationDriftFraction > 0 && declared.maxPopulationDriftFraction < 0.042,
      "the drift tolerance must sit below the 4.2% growth that carried the web suite's old " +
        "cap past its own derivation — a tolerance that admits the incident admits the defect",
    );
    return;
  }
  // DERIVED: the same ranges the web declaration is held to, for the same
  // measured reasons (see webUiSuiteCpuBudget's schema comment).
  assert.ok(Number.isFinite(declared.msPerTestFile) && declared.msPerTestFile > 0);
  assert.ok(Number.isInteger(declared.derivedAtTestFileCount) && declared.derivedAtTestFileCount > 0);
  assert.ok(declared.maxPopulationDriftFraction > 0 && declared.maxPopulationDriftFraction < 0.042);
  assert.ok(!("overCapRunsBeforeRed" in declared) && !("sameTreeSpreadFraction" in declared), "no streak and no band: one judged run over the cap fails (UR-24-BUDGETS)");
});

test("test-runtime budget: the runner is wired to the shared judge, and a failed gate is a non-zero exit", () => {
  // WITHOUT THIS, DELETING THE ENFORCEMENT IS A GREEN RUN: the judge lives in
  // a shared module, and a runner that stopped calling it would look exactly
  // like a suite with nothing to complain about. Read through the sanctioned
  // source view with string AND template interiors KEPT — the outcome kinds
  // ("fail", "not-judged") are quoted literals and the printed refusal line
  // lives inside a template literal, so a view that blanks either goes blind
  // to the very evidence this test exists to demand — and with comments
  // blanked, so this file's own prose cannot satisfy it.
  const src = readSourceView("scripts/tooling/run-tests.ts").codeWithStringsAndTemplates();
  assert.match(src, /judgeSuiteCpu\s*\(/, "the runner no longer calls the shared judge");
  assert.match(src, /appendJudgedRun\s*\(/, "the runner no longer appends judged runs to the ledger");
  assert.match(src, /readRunHistory\s*\(/, "the runner no longer reads the ledger the streak needs");
  assert.match(src, /scanCompileCache\s*\(/, "the runner no longer takes the warmth reading");
  assert.match(src, /readRunCpu\s*\(/, "the runner no longer measures the run's CPU");
  // A NOT-JUDGED must be PRINTED — the refusal-scored-as-pass class dying is
  // the point of the rewrite, so the print is load-bearing, not cosmetic.
  // Two anchored claims, no proximity window (a bounded gap is a guess that
  // two anchors are related): the runner consults the not-judged kind, and
  // the printed line carries the refusal's own reason, which only the
  // outcome's message interpolation can satisfy.
  assert.match(
    src,
    /o\.kind === "not-judged"/,
    "the runner no longer consults the not-judged outcome kind",
  );
  assert.match(
    src,
    /NOT JUDGED — \$\{o\.message\}/,
    "a not-judged outcome is no longer printed with its reason — a silent refusal is a pass in disguise",
  );
  // THE EXIT CODE MUST BE DOWNSTREAM OF THE FAILURE, and the runner's overall
  // exit must not be able to mask it: the gate's code is folded in with
  // Math.max, so a passing suite with a failing gate still exits non-zero.
  assert.match(
    src,
    /Math\.max\(execution\.exitCode,\s*gateExitCode\)/,
    "the gate's exit code is computed and then not folded into the runner's exit — the " +
      "wired-but-inert shape",
  );
});

test("test-runtime budget: a FAILED gate EXITS NON-ZERO — driven, not pattern-matched", async () => {
  // The predecessor asserted a lazy regex (/"fail"[\s\S]*?return 1;/) over the
  // runner's source. That match is VACUOUS: the lazy span crosses block
  // boundaries, so deleting the fail branch's own `return 1` left the regex
  // satisfied by the catch block's `return 1` — a failed gate masked as success
  // stayed green. A verdict-to-exit binding is a BEHAVIOUR, so it is guarded by
  // DRIVING the choke-point owner with each outcome kind and asserting the exit
  // code it returns, never by matching text near the word "fail".
  const { gateOutcomeExitCode } = await import("../../scripts/tooling/run-tests.ts");
  assert.equal(
    gateOutcomeExitCode("fail"),
    1,
    "a failed budget gate must exit non-zero — a fail verdict that exits 0 is a " +
      "regression reported as a green run",
  );
  // The other kinds must NOT fail the run: a refusal and a clean pass exit
  // clean so they never mask as a regression (there is no warn kind). There
  // is no provisional kind any more: a busy ambient is paid for by the
  // ambient-inflation adjustment in every judgement line, so a clean busy
  // run is a PASS and a regressed busy run is a FAIL — both at the ambient
  // the box honestly held, never deferred, never waiting for quiet.
  assert.equal(gateOutcomeExitCode("pass"), 0);
  assert.equal(gateOutcomeExitCode("not-judged"), 0);
});

test("test-runtime budget: the concurrency schedule is wired through the config single owner", () => {
  // The schedule fields must flow through readTestExecutionConfig (the single
  // owner of the testExecution→runner wiring) so `npm test` and `harness
  // test` cannot drift. Deny-by-default: the numeric fields are present
  // (defaulted) even when the config document omits them — these are DEFAULT
  // VALUES for tuning knobs, which is fine; the BUDGET above deliberately has
  // none, because a budget is a claim about a measurement, not a knob.
  const config = readTestExecutionConfig(process.cwd());
  assert.equal(typeof config.runtimeBudgetMs, "number");
  assert.ok(config.runtimeBudgetMs > 0, "the per-test kill timeout must stay wired — it is a timeout, not a budget");
  assert.equal(typeof config.serialPhaseConcurrency, "number");
  assert.ok(config.serialPhaseConcurrency > 0);
  assert.equal(typeof config.fullSuiteSerialPhaseConcurrency, "number");
  assert.ok(config.fullSuiteSerialPhaseConcurrency > 0);
  assert.equal(typeof config.fullSuiteInProcessSerialPhaseConcurrency, "number");
  assert.ok(config.fullSuiteInProcessSerialPhaseConcurrency > 0);
  if (config.fullSuiteParallelConcurrency !== undefined) {
    assert.equal(typeof config.fullSuiteParallelConcurrency, "number");
    assert.ok(config.fullSuiteParallelConcurrency > 0);
  }
});

test("test-runtime budget: the retired wall-clock budget left no second path behind", () => {
  // Extending a feature means extending its PATH: the CPU budget REPLACED the
  // wall-clock suite budget, so the old spelling must be gone from the config
  // owner — two budgets answering "may this suite cost this much" is the
  // two-sources defect this repository's first rule forbids. (The per-test
  // `runtimeBudgetMs` is not a budget; it is the kill timeout, asserted wired
  // above.)
  const config = readTestExecutionConfig(process.cwd()) as Record<string, unknown>;
  assert.equal(
    config.suiteRuntimeBudgetMs,
    undefined,
    "suiteRuntimeBudgetMs has returned to the config owner — the wall-clock budget was " +
      "deleted WITH its concept, and a resurrected key would be a second answer to the " +
      "one question integrationSuiteCpuBudget owns",
  );
});
