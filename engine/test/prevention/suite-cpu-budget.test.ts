// THE SUITE CPU GATE, DRIVEN BRANCH BY BRANCH.
//
// `scripts/run-tests.ts` judges each full run at end-of-run through the
// shared verdict owner (`src/shared/budget-verdict.ts` — the same module the
// web suite consumes through its shim). The interesting branches fire rarely
// by design — a refusal, a cold cache, a run over the cap — so every one is
// driven here with fabricated evidence, exactly as the web side drives its
// summary judgment. The three behaviours the predecessor gate got wrong are
// each pinned by name: a refusal is a first-class NOT-JUDGED (never a pass),
// a measurement is validated by its own witness (a fabricated zero is a
// contradiction, not warmth), and one judged run over the cap is the
// verdict (UR-24-BUDGETS: no streak, no band, no re-run).

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import { createTempDir } from "../support/temp-dir.ts";
import { createRepositoryWorkingCopy, removeRepositoryLocalTemporaryDirectory } from "../support/repository-local-temporary.ts";
import { createCanonicalNodeTestInventoryFixture } from "../support/test-inventory-fixture.ts";
import { VERIFICATION_PATHS } from "../../src/kernel/verification-paths.ts";
import type { MetricEntry } from "../../src/shared/measurement-registry.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { atomicWriteFile } from "../../src/filesystem/atomic-write.ts";
import { superviseCommand } from "../../src/process/supervised-run.ts";
import { testProcessSupervisorBinary } from "../../guardian/build.ts";

import {
  deriveRollingBaseline,
  judgeSuiteCpu,
  judgePopulationDrift,
  ambientInflationFraction,
  COLD_MODULE_CACHE_FRACTION,
  type AccumulatingCpuBudget,
  type DeclaredCpuBudget,
  type SuiteCpuEvidence,
  type JudgedRunRecord,
  type RollingCpuBudget,
} from "../../src/shared/budget-verdict.ts";
import { appendJudgedRun, currentQualificationOutcome, finalizeQualifiedRun, qualificationInvocation, qualificationTerminal, runForInvocation, supervisedCommandOutcome, TEST_RUN_HISTORY_PATH, QUALIFICATION_INVOCATION_ENV, readRunHistory, HISTORY_KEPT } from "../../src/shared/run-history.ts";
import { scanCacheDirectory } from "../../scripts/tooling/compile-cache.ts";

const FILES = 700;
const LABEL = "integration";
const KEY = "testExecution.integrationSuiteCpuBudget";

const ACCUMULATING: AccumulatingCpuBudget = {
  metric: "calibrated-work/v1",
  phase: "accumulation",
  minimumJudgedRuns: 5,
  maxPopulationDriftFraction: 0.03,
  calibrationDriftMaxFraction: 0.15,
  validThroughLoad5PerCpu: 1.25,
};

const DERIVED: DeclaredCpuBudget & { readonly phase: "derived" } = {
  phase: "derived",
  metric: "calibrated-work/v1",
  unitsPerTestFile: 1_000,
  derivedAtTestFileCount: FILES,
  calibrationDriftMaxFraction: 0.15,
  validThroughLoad5PerCpu: 1.25,
  maxPopulationDriftFraction: 0.03,
  // The same proportions as the deployed web declaration, so the ambient
  // arms below exercise the arithmetic the live gate runs.
  ambientInflationSlopePerCpu: 0.05,
  ambientInflationCapFraction: 0.12,
};
/** A warm, complete, judgeable run at the given per-file CPU cost. */
function evidence(over: Partial<SuiteCpuEvidence> = {}, unitsPerFile = 900): SuiteCpuEvidence {
  const testFileCount = over.testFileCount ?? FILES;
  return {
    workUnitsPerTestFile: unitsPerFile,
    workMetric: "calibrated-work/v1",
    rawCpuMsPerTestFile: unitsPerFile,
    calibrationMs: 100,
    calibrationDriftFraction: 0.02,
    testFileCount,
    wallClockMs: 105_000,
    timestamp: "2026-07-30T18:00:00.000Z",
    warmth: {
      entriesAtEnd: 40_000,
      writtenDuringRun: 120,
      newestEntryMtimeMs: 1_000_500,
      runStartMs: 1_000_000,
    },
    // Identity/condition default to unreadable — the tests that assert their
    // recording pass them explicitly.
    headSha: null,
    ambientLoadPerCpu: null,
    // Zero is a recorded, valid condition (no ambient adjustment earned);
    // the tests that assert an UNREADABLE leg pass null explicitly.
    ambientLoad5PerCpu: 0,
    ambientLoad15PerCpu: null,
    ...over,
  };
}

/** A prior JUDGED run, population defaulting to the current one's. */
function ranAt(unitsPerTestFile: number, testModuleCount = FILES, when = "2026-07-30T17:00:00.000Z"): JudgedRunRecord {
  return {
    timestamp: when,
    cpuMsPerTestFile: unitsPerTestFile,
    workUnitsPerTestFile: unitsPerTestFile,
    metric: "calibrated-work/v1",
    calibrationMs: 1,
    calibrationDriftFraction: 0.02,
    testModuleCount,
  };
}

// ── Refusals are three-valued and never a pass ────────────────────────────

test("suite-cpu: an unreadable CPU is NOT JUDGED, never zero and never a pass", () => {
  const { outcome, judgedRecord } = judgeSuiteCpu(evidence({ workUnitsPerTestFile: null }), DERIVED, [], LABEL, KEY);
  assert.equal(outcome.kind, "not-judged");
  assert.match(outcome.message, /calibrated work could not be measured/);
  assert.equal(judgedRecord, null, "a refused run must not enter the ledger");
});

test("suite-cpu: a zero CPU reading is refused — the most permissive number there is", () => {
  const { outcome } = judgeSuiteCpu(evidence({ workUnitsPerTestFile: 0 }), DERIVED, [], LABEL, KEY);
  assert.equal(outcome.kind, "not-judged");
});

test("suite-cpu: a missing population is refused with the artifact named", () => {
  const { outcome, judgedRecord } = judgeSuiteCpu(evidence({ testFileCount: null }), DERIVED, [], LABEL, KEY);
  assert.equal(outcome.kind, "not-judged");
  assert.match(outcome.message, /inventory/);
  assert.equal(judgedRecord, null);
});

test("suite-cpu: a MISSING DECLARATION is a loud not-judged, and the evidence is still recorded", () => {
  const missing = { missing: "integrationSuiteCpuBudget is not set — a budget nobody chose is not a budget." };
  const { outcome, judgedRecord } = judgeSuiteCpu(evidence(), missing, [], LABEL, KEY);
  assert.equal(outcome.kind, "not-judged");
  assert.match(outcome.message, /nobody chose/);
  assert.ok(judgedRecord !== null, "the ledger is what a future declaration is derived from");
});

// ── Warmth: the same three arms as the web verdict, over the V8 cache ─────

test("suite-cpu: a COLD run is refused — its CPU includes compile work a warm run does not pay", () => {
  const { outcome, judgedRecord } = judgeSuiteCpu(
    evidence({
      warmth: { entriesAtEnd: 40_000, writtenDuringRun: 39_000, newestEntryMtimeMs: 1_000_900, runStartMs: 1_000_000 },
    }),
    DERIVED,
    [],
    LABEL,
    KEY,
  );
  assert.equal(outcome.kind, "not-judged");
  assert.match(outcome.message, /WROTE/);
  assert.equal(judgedRecord, null, "a cold run is never recorded as a judged reading");
  // The threshold in force is the shared one, bounded by the web prevention
  // test on both sides; assert it is the one actually consulted.
  assert.ok(39_000 / 40_000 >= COLD_MODULE_CACHE_FRACTION);
});

test("suite-cpu: THE FABRICATED ZERO — a written count of 0 beside a newest mtime after run start is a contradiction, not warmth", () => {
  // The mutant this arm exists for: compute the walk, return 0. The walk's
  // own newest-mtime witness then contradicts the count, and the verdict
  // refuses instead of judging a cold run into the ledger — which is exactly
  // what the S37-check drove past the previous deny-by-default arm (it
  // refused only the NULL spelling).
  const { outcome, judgedRecord } = judgeSuiteCpu(
    evidence({
      warmth: { entriesAtEnd: 40_000, writtenDuringRun: 0, newestEntryMtimeMs: 1_000_900, runStartMs: 1_000_000 },
    }),
    DERIVED,
    [],
    LABEL,
    KEY,
  );
  assert.equal(outcome.kind, "not-judged");
  assert.match(outcome.message, /contradict/);
  assert.equal(judgedRecord, null);
});

test("suite-cpu: a genuinely warm zero — newest mtime BEFORE run start — is judged", () => {
  const { outcome } = judgeSuiteCpu(
    evidence({
      warmth: { entriesAtEnd: 40_000, writtenDuringRun: 0, newestEntryMtimeMs: 999_000, runStartMs: 1_000_000 },
    }),
    DERIVED,
    [],
    LABEL,
    KEY,
  );
  assert.equal(outcome.kind, "pass");
});

test("suite-cpu: a warmth claim without its measurement is refused (deny by default)", () => {
  for (const hole of [
    { writtenDuringRun: null },
    { newestEntryMtimeMs: null },
    { runStartMs: null },
  ]) {
    const { outcome } = judgeSuiteCpu(
      evidence({
        warmth: {
          entriesAtEnd: 40_000,
          writtenDuringRun: 120,
          newestEntryMtimeMs: 1_000_500,
          runStartMs: 1_000_000,
          ...hole,
        },
      }),
      DERIVED,
      [],
      LABEL,
      KEY,
    );
    assert.equal(outcome.kind, "not-judged", `hole ${JSON.stringify(hole)} must refuse`);
  }
});

test("suite-cpu: a wholly unobservable cache says nothing about coldness and does not block judgment", () => {
  const { outcome } = judgeSuiteCpu(evidence({ warmth: null }), DERIVED, [], LABEL, KEY);
  assert.equal(outcome.kind, "pass");
});

// ── Accumulation: not-judged-until-N, with the reason and the count printed ─

test("suite-cpu: ACCUMULATION is not-judged with the run counted, and the record still enters the ledger", () => {
  const { outcome, judgedRecord } = judgeSuiteCpu(evidence(), ACCUMULATING, [ranAt(910), ranAt(905)], LABEL, KEY);
  assert.equal(outcome.kind, "not-judged", "no cap exists during accumulation, and none is guessed");
  assert.match(outcome.message, /run 3 of 5/);
  assert.match(outcome.message, /900\.000 calibration units\/file/);
  assert.ok(judgedRecord !== null);
  assert.equal(judgedRecord.cpuMsPerTestFile, 900);
  assert.equal(judgedRecord.testModuleCount, FILES);
});

test("suite-cpu: accumulation COMPLETE prints the derivation — median and spread — and still refuses to self-adopt a cap", () => {
  const prior = [ranAt(900), ranAt(910), ranAt(950), ranAt(1_000)];
  const { outcome } = judgeSuiteCpu(evidence({}, 920), ACCUMULATING, prior, LABEL, KEY);
  assert.equal(outcome.kind, "not-judged", "deriving is a config edit somebody signs, never a self-adopted number");
  // Samples: 900, 910, 950, 1000, 920 → median 920; spread max |x−920|/920 = 80/920.
  assert.match(outcome.message, /median 920\.000 calibration units\/file/);
  assert.match(outcome.message, new RegExp(`±${((80 / 920) * 100).toFixed(1)}%`));
  assert.match(outcome.message, /bridlewise\.config\.json/);
});

test("suite-cpu: accumulation validates ledger entries by population — a subset entry does not count toward N", () => {
  const prior = [ranAt(910), ranAt(1_338, 30), ranAt(905)]; // the 30-file entry is a subset run's shape
  const { outcome } = judgeSuiteCpu(evidence(), ACCUMULATING, prior, LABEL, KEY);
  assert.equal(outcome.kind, "not-judged");
  assert.match(outcome.message, /run 3 of 5/, "the deviant-population entry must not be counted");
});

// ── Declared cap: ONE judged run is the verdict (UR-24-BUDGETS) ───────────

test("suite-cpu: within cap PASSES and reports the wall clock as reported-not-judged", () => {
  const { outcome } = judgeSuiteCpu(evidence(), DERIVED, [], LABEL, KEY);
  assert.equal(outcome.kind, "pass");
  assert.match(outcome.message, /reported, not judged/);
});

test("suite-cpu: ONE judged run over the cap FAILS that run — no band, no streak, no re-run (UR-24-BUDGETS, the 2026-10-07 decision)", () => {
  // 1 ms/file over the cap at no ambient: the old "same-tree spread" band
  // called this a warn and the streak waited for three runs beyond it.
  const { outcome } = judgeSuiteCpu(evidence({}, 1_001), DERIVED, [], LABEL, KEY);
  assert.equal(outcome.kind, "fail");
  assert.match(outcome.message, /no streak, no band, no re-run/);
  assert.match(outcome.message, /do not raise the budget/);
  assert.match(outcome.message, new RegExp(LABEL));
  // +50% (the reviewer's probe) fails the same way.
  assert.equal(judgeSuiteCpu(evidence({}, 1_500), DERIVED, [], LABEL, KEY).outcome.kind, "fail");
  // At the cap exactly: a pass (the cap is the last value a run may reach).
  assert.equal(judgeSuiteCpu(evidence({}, 1_000), DERIVED, [], LABEL, KEY).outcome.kind, "pass");
});

test("suite-cpu: the ledger's earlier runs never change a verdict — a red after reds, a red after greens and a red with a deviant entry are the same red", () => {
  const verdict = (prior: readonly JudgedRunRecord[]) => judgeSuiteCpu(evidence({}, 1_060), DERIVED, prior, LABEL, KEY).outcome.kind;
  assert.equal(verdict([]), "fail");
  assert.equal(verdict([ranAt(1_055), ranAt(1_070)]), "fail");
  assert.equal(verdict([ranAt(900), ranAt(905)]), "fail");
  assert.equal(verdict([ranAt(1_338, 30)]), "fail");
  const green = (prior: readonly JudgedRunRecord[]) => judgeSuiteCpu(evidence({}, 990), DERIVED, prior, LABEL, KEY).outcome.kind;
  assert.equal(green([ranAt(2_000), ranAt(2_000), ranAt(2_000)]), "pass", "earlier reds never turn a run under the cap red");
});

// ── Ambient load: the one allowance left, stated numerically on every
// verdict until AMBIENT-ALLOWANCE-REMOVE removes it. The cap scales by the
// CPU inflation the run's OWN recorded 5-minute ambient leg explains (capped);
// a run over the scaled cap fails in that run.

test("suite-cpu: A CLEAN RUN AT A BUSY AMBIENT JUDGES CLEAN — the adjustment does its work, with the arithmetic on the line", () => {
  // At a recorded 5-minute ambient of 0.8/cpu the adjustment is +4%, so the
  // cap is 1,040. A reading of 1,030 is within it: a PASS, with the
  // arithmetic named.
  const { outcome, judgedRecord } = judgeSuiteCpu(
    evidence({ ambientLoad5PerCpu: 0.8 }, 1_030),
    DERIVED,
    [],
    LABEL,
    KEY,
  );
  assert.equal(outcome.kind, "pass");
  assert.match(outcome.message, /1030\.000 calibration units\/file within 1040\.000/);
  assert.match(outcome.message, /baseline 1000\.000 × 1\.040 ambient adjustment/);
  assert.match(outcome.message, /0\.800\/cpu/);
  // The allowance in force is SAID, numerically, until AMBIENT-ALLOWANCE-REMOVE lands: no pass reads as a strict one.
  assert.match(outcome.message, /\[ambient allowance in force until AMBIENT-ALLOWANCE-REMOVE: \+5\.0% per unit of 5-minute load per CPU, capped at \+\d+\.\d%; this verdict: \+4\.0%\]/);
  const strict = judgeSuiteCpu(evidence({ ambientLoad5PerCpu: 0.05 }, 900), DERIVED, [], LABEL, KEY);
  assert.match(strict.outcome.message, /this verdict: \+0\.3%\]|this verdict: \+0\.2%\]/, "a quiet verdict says what it added too");
  assert.ok(judgedRecord !== null);
  assert.equal(judgedRecord.ambientLoad5PerCpu, 0.8);
  // The boundary: the IDENTICAL reading at a quiet ambient FAILS — the
  // adjustment is what moved the line, and it is stated on both verdicts.
  const quiet = judgeSuiteCpu(evidence({ ambientLoad5PerCpu: 0.05 }, 1_030), DERIVED, [], LABEL, KEY);
  assert.equal(quiet.outcome.kind, "fail");
  assert.match(quiet.outcome.message, /ambient allowance in force until AMBIENT-ALLOWANCE-REMOVE/);
});

test("suite-cpu: THE TEETH HOLD UNDER LOAD — one regressed reading at a busy ambient fails, and no ambient empties the cap", () => {
  // At amb5 0.8 the cap is 1,040: a 1,050 reading fails in its one run.
  const { outcome } = judgeSuiteCpu(evidence({ ambientLoad5PerCpu: 0.8 }, 1_050), DERIVED, [], LABEL, KEY);
  assert.equal(outcome.kind, "fail");
  assert.match(outcome.message, /cap in force \(metric calibrated-work\/v1; raw [\d.]+ ms\/file, provenance\) = baseline 1000\.000 × 1\.040/);
  assert.match(outcome.message, /do not raise the budget/);
  // PAST THE METRIC'S VALIDITY BOUND THE GATE DEFERS. At 3.0/cpu the
  // calibrated metric's residual was never measured (bound 1.25), so the
  // run is NOT JUDGED — not failed, not passed. This is the honest half of
  // "load-agnostic or declare its sensitivity and defer past the bound".
  const saturated = judgeSuiteCpu(evidence({ ambientLoad5PerCpu: 3.0 }, 1_121), DERIVED, [], LABEL, KEY);
  assert.equal(saturated.outcome.kind, "not-judged");
  assert.match(saturated.outcome.message, /past the 1\.25\/cpu bound/);
  // The helper's own bounds, spelled at its boundary: absence and
  // non-positive readings adjust nothing, the slope scales until the cap.
  assert.equal(ambientInflationFraction(undefined, DERIVED), 0);
  assert.equal(ambientInflationFraction(null, DERIVED), 0);
  assert.equal(ambientInflationFraction(Number.NaN, DERIVED), 0);
  assert.equal(ambientInflationFraction(-1, DERIVED), 0);
  assert.equal(ambientInflationFraction(1, DERIVED), 0.05);
  assert.equal(ambientInflationFraction(3, DERIVED), 0.12);
});

test("suite-cpu: POPULATION DRIFT past the declared tolerance refuses to judge and prescribes the re-derivation at the right key", () => {
  const { outcome, judgedRecord } = judgeSuiteCpu(evidence({ testFileCount: 760 }), DERIVED, [], LABEL, KEY);
  assert.equal(outcome.kind, "not-judged");
  assert.match(outcome.message, /grown/);
  assert.match(outcome.message, new RegExp(KEY.replace(/\./g, "\\.")));
  assert.ok(judgedRecord !== null, "the drifted run is exactly the evidence the re-derivation needs");
});

test("suite-cpu: judgePopulationDrift names the config key it was asked about", () => {
  const stale = judgePopulationDrift(DERIVED, 800, KEY);
  assert.equal(stale.kind, "stale");
  if (stale.kind === "stale") assert.match(stale.why, /integrationSuiteCpuBudget/);
});

// ── The instrument, driven over planted mtimes ────────────────────────────

test("suite-cpu instrument: scanCacheDirectory returns the EXACT planted counts and the newest-mtime witness", () => {
  const dir = createTempDir("suite-cpu-scan-");
  const sinceMs = Date.now() - 60_000; // one minute ago
  // Three entries before the reference, two at-or-after, one subdirectory
  // (must not be counted — entries are files).
  const plant = (name: string, mtimeMs: number): void => {
    const p = join(dir, name);
    writeFileSync(p, name);
    utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
  };
  plant("old-1.cache", sinceMs - 50_000);
  plant("old-2.cache", sinceMs - 40_000);
  plant("old-3.cache", sinceMs - 30_000);
  plant("new-1.cache", sinceMs); // the boundary belongs to the run: >= counts
  plant("new-2.cache", sinceMs + 10_000);
  mkdirSync(join(dir, "a-subdir"));

  const scan = scanCacheDirectory(dir, sinceMs);
  assert.ok(scan !== null);
  assert.equal(scan.entries, 5);
  assert.equal(scan.writtenSince, 2);
  // The witness: the newest mtime observed by the SAME walk. A mutant that
  // computes the count and returns 0 still carries this witness, and the
  // verdict's contradiction arm refuses it — driven above.
  assert.ok(scan.newestMtimeMs !== null && Math.abs(scan.newestMtimeMs - (sinceMs + 10_000)) < 1_500);

  // Fully-old directory: zero written, and the witness agrees (< since).
  const warmDir = createTempDir("suite-cpu-warm-");
  const wp = join(warmDir, "only.cache");
  writeFileSync(wp, "x");
  utimesSync(wp, (sinceMs - 5_000) / 1000, (sinceMs - 5_000) / 1000);
  const warm = scanCacheDirectory(warmDir, sinceMs);
  assert.ok(warm !== null);
  assert.equal(warm.entries, 1);
  assert.equal(warm.writtenSince, 0);
  assert.ok(warm.newestMtimeMs !== null && warm.newestMtimeMs < sinceMs);

  // An unreadable directory is ABSENCE, never a zero.
  assert.equal(scanCacheDirectory(join(dir, "does-not-exist"), sinceMs), null);
});

// ── The ledger, at the integration path semantics ─────────────────────────

test("suite-cpu ledger: appends round-trip oldest-first, unknown fields survive, and the trim keeps the newest", () => {
  const dir = createTempDir("suite-cpu-history-");
  const path = join(dir, "run-history.json");
  appendJudgedRun({ ...ranAt(901), failures: ["test/a.test.ts::one"] }, path);
  appendJudgedRun({ ...ranAt(902) }, path);
  assert.deepEqual(readRunHistory(path).map((r) => r.cpuMsPerTestFile), [901, 902]);
  // The failure rows — the flaky-memory guard's future substrate — survive a
  // rewrite by a writer that does not read them.
  const raw = JSON.parse(readFileSync(path, "utf8")) as { runs: Record<string, unknown>[] };
  assert.deepEqual(raw.runs[0]!.failures, ["test/a.test.ts::one"]);
  // Trim keeps the NEWEST — trimming the newest would erase the evidence the rolling baseline reads.
  for (let i = 0; i < HISTORY_KEPT + 3; i++) appendJudgedRun({ ...ranAt(1_000 + i) }, path);
  const kept = readRunHistory(path);
  assert.equal(kept.length, HISTORY_KEPT);
  assert.equal(kept[kept.length - 1]!.cpuMsPerTestFile, 1_000 + HISTORY_KEPT + 2);
});

test("suite-cpu ledger: ONE WRITER — an append while another process holds the ledger's read-modify-write keeps both rows", () => {
  // wf-del2-correctness NEW-9 / wf-del2-design D4: the append and a copy-back's
  // import were two raw read-modify-writes; the one that read first lost the
  // other's row. A contender holds the ledger lock across its whole cycle (it
  // read the ledger, waits, then writes its row back); the append must wait
  // for it and then keep its row.
  const dir = createTempDir("suite-cpu-one-writer-");
  const path = join(dir, "run-history.json");
  appendJudgedRun({ ...ranAt(900) }, path);
  const ready = join(dir, "contender-holds-the-lock");
  const code = [
    `import { readFileSync, writeFileSync } from "node:fs";`,
    `const { withFileLock } = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "..", "..", "src", "filesystem", "file-lock.ts")).href)});`,
    `withFileLock(${JSON.stringify(`${path}.lock`)}, (message) => new Error(message), () => {`,
    `  const runs = JSON.parse(readFileSync(${JSON.stringify(path)}, "utf8")).runs;`,
    `  writeFileSync(${JSON.stringify(ready)}, "");`,
    `  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);`,
    `  writeFileSync(${JSON.stringify(path)}, JSON.stringify({ runs: [...runs, { timestamp: "contender", cpuMsPerTestFile: 901, testModuleCount: 1 }] }));`,
    `});`,
  ].join("\n");
  const contender = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: "ignore" });
  const deadline = Date.now() + 60_000;
  while (!existsSync(ready)) {
    assert.ok(Date.now() < deadline, "the contender never took the ledger lock");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  appendJudgedRun({ ...ranAt(902) }, path);
  contender.kill();
  assert.deepEqual(readRunHistory(path).map((r) => r.cpuMsPerTestFile), [900, 901, 902], "a row was lost: the append did not wait for the other writer's cycle");
});

test("suite-cpu ledger: a missing or corrupt ledger is EMPTY — it can delay a red, never manufacture one", () => {
  const dir = createTempDir("suite-cpu-corrupt-");
  assert.deepEqual(readRunHistory(join(dir, "never.json")), []);
  const path = join(dir, "corrupt.json");
  writeFileSync(path, "{not json");
  assert.deepEqual(readRunHistory(path), []);
  appendJudgedRun({ ...ranAt(950) }, path);
  assert.deepEqual(readRunHistory(path).map((r) => r.cpuMsPerTestFile), [950],
    "the legacy provenance field still round-trips");
  assert.deepEqual(readRunHistory(path).map((r) => r.workUnitsPerTestFile), [950],
    "and the judged reading round-trips its calibrated unit");
});

// ── Tree identity + measurement condition in the ledger ──────────────────
//
// The accumulation ledger was measured CROSS-CONDITION (1287.6 vs ~2060
// ms/file over the SAME 407 files on the SAME day) and cross-commit (five
// samples over four commits) — a cap derived from such a ledger encodes the
// confound as permanent slack. The schema therefore carries each run's own
// HEAD sha and its ambient load per CPU, and the derivation prescription
// demands same-sha same-condition samples. The fields are OPTIONAL: old
// entries stay valid, and an unreadable identity is absent, never invented.

test("suite-cpu identity: a judged record carries headSha and ambientLoadPerCpu when the runner read them, and omits them when it could not", () => {
  const sha = "a".repeat(40);
  const withIdentity = judgeSuiteCpu(
    evidence({
      headSha: sha,
      ambientLoadPerCpu: 0.125,
      ambientLoad5PerCpu: 0.4,
      ambientLoad15PerCpu: 3.1,
    }),
    ACCUMULATING,
    [],
    LABEL,
    KEY,
  );
  assert.ok(withIdentity.judgedRecord !== null);
  assert.equal(withIdentity.judgedRecord.headSha, sha);
  assert.equal(withIdentity.judgedRecord.ambientLoadPerCpu, 0.125);
  // The pre-launch snapshot's longer legs ride in the same row — the
  // saturation ghost the 1-minute figure is blind to (a previous suite's
  // load decays out of the 1-minute average within minutes while the
  // 15-minute leg still carries it, so the ghost era's rows recorded
  // "quiet" 1-minute contexts at 15-minute averages of 2.4-4.1).
  assert.equal(withIdentity.judgedRecord.ambientLoad5PerCpu, 0.4);
  assert.equal(withIdentity.judgedRecord.ambientLoad15PerCpu, 3.1);
  const withoutIdentity = judgeSuiteCpu(evidence({ ambientLoad5PerCpu: null }), ACCUMULATING, [], LABEL, KEY);
  assert.ok(withoutIdentity.judgedRecord !== null);
  assert.ok(!("headSha" in withoutIdentity.judgedRecord), "an unreadable sha is ABSENT, never a placeholder");
  assert.ok(!("ambientLoadPerCpu" in withoutIdentity.judgedRecord), "an unreadable load is ABSENT, never a zero");
  assert.ok(!("ambientLoad5PerCpu" in withoutIdentity.judgedRecord), "an unreadable 5-minute leg is ABSENT");
  assert.ok(!("ambientLoad15PerCpu" in withoutIdentity.judgedRecord), "an unreadable 15-minute leg is ABSENT");
});

test("suite-cpu identity: the ledger round-trips identity fields and keeps pre-identity entries valid", () => {
  const dir = createTempDir("suite-cpu-identity-");
  const path = join(dir, "history.json");
  const sha = "b".repeat(40);
  // A PRE-IDENTITY entry (the old shape) and a new one, side by side.
  appendJudgedRun({ ...ranAt(900) }, path);
  appendJudgedRun(
    { ...ranAt(910), headSha: sha, ambientLoadPerCpu: 0.07, ambientLoad5PerCpu: 0.2, ambientLoad15PerCpu: 1.8 },
    path,
  );
  const read = readRunHistory(path);
  assert.equal(read.length, 2, "an entry without identity fields stays a valid judged run");
  assert.ok(!("headSha" in read[0]!));
  assert.equal(read[1]!.headSha, sha);
  assert.equal(read[1]!.ambientLoadPerCpu, 0.07);
  // The snapshot's longer legs round-trip through the ledger's own parse —
  // the read that future era analyses will do.
  assert.equal(read[1]!.ambientLoad5PerCpu, 0.2);
  assert.equal(read[1]!.ambientLoad15PerCpu, 1.8);
  assert.ok(!("ambientLoad15PerCpu" in read[0]!), "a pre-snapshot entry stays valid without the legs");
});

test("suite-cpu prescription: the accumulation messages demand same-sha same-condition samples and count the same-sha subset", () => {
  const sha = "c".repeat(40);
  const priors: JudgedRunRecord[] = [
    { ...ranAt(900), headSha: sha, ambientLoadPerCpu: 0.05 },
    { ...ranAt(905), headSha: "d".repeat(40), ambientLoadPerCpu: 0.05 },
    { ...ranAt(910) }, // pre-identity — cannot claim same-sha
  ];
  const midway = judgeSuiteCpu(
    evidence({ headSha: sha, ambientLoadPerCpu: 0.06 }),
    ACCUMULATING,
    priors,
    LABEL,
    KEY,
  );
  assert.equal(midway.outcome.kind, "not-judged");
  assert.match(midway.outcome.message, /ONE headSha/u, "the prescription must demand same-sha samples");
  assert.match(midway.outcome.message, /ambient-adjusted readings, never excluded for busyness/u,
    "the prescription must name the ambient-adjusted feed — ambient is a covariate, never an exclusion");
  // The same-sha count: this run plus the one prior sharing its sha — the
  // other-sha and pre-identity entries must NOT count toward it.
  assert.match(midway.outcome.message, /2 of the counted samples share it/u);
  const complete = judgeSuiteCpu(
    evidence({ headSha: sha, ambientLoadPerCpu: 0.06 }),
    { ...ACCUMULATING, minimumJudgedRuns: 3 },
    priors,
    LABEL,
    KEY,
  );
  assert.equal(complete.outcome.kind, "not-judged");
  assert.match(complete.outcome.message, /accumulation complete/u);
  assert.match(complete.outcome.message, /same-sha same-condition subset/u,
    "the derivation prescription must demand the subset before a cap is set");
  // The prescription names the rolling shape and no headroom — the deleted band never comes back as advice.
  assert.match(complete.outcome.message, /rolling shape: baselineFloorUnitsPerTestFile \(the clean median, no headroom/u);
  assert.doesNotMatch(`${midway.outcome.message}\n${complete.outcome.message}`, /plus recorded headroom|median and measured spread/u);
});

// ── N: THE PRE-RUN ORDER IS A MECHANISM, NOT A COMMENT ─────────────────────
// prune BEFORE the CPU baseline BEFORE the start-stamp. Both halves are
// load-bearing (the warmth walk reads mtime >= start; the judged CPU is the
// delta from the baseline), and until this test the order was FOUR INLINE
// STATEMENTS under a comment: reordering them in a clone produced zero reds.
// The order now lives in `beginMeasuredRun`, driven here through injected
// steps that OBSERVE the sequence, and `runCli` is held to calling that
// function rather than re-inlining the statements (§33's durable form: the
// absence of the sequenced calls plus the presence of the derivation).

test("beginMeasuredRun takes prune, then the CPU baseline, then the start-stamp — in that order", async () => {
  const { beginMeasuredRun } = await import("../../scripts/tooling/run-tests.ts");
  const order: string[] = [];
  const baseline = { totalCpuMs: 111, childCpuMs: 22 };
  const STAMP = 1_234_567_890_123;
  const out = beginMeasuredRun(process.cwd(), {
    pruneCache: () => { order.push("prune"); },
    readCpuBaseline: () => { order.push("cpu-baseline"); return baseline; },
    measureCalibration: () => { order.push("calibration"); return { cpuMs: 100, chunks: [100, 100, 100], workload: "int-mem-l2/v1", chunkIterations: 5_000_000 }; },
    stampStart: () => { order.push("start-stamp"); return STAMP; },
  });
  assert.deepEqual(order, ["prune", "calibration", "cpu-baseline", "start-stamp"],
    "the pre-run measurements must run in exactly this order — the warmth walk and the CPU delta both depend on it");
  // LIVENESS AGAINST THE INERT SHAPE: the returned values must BE the
  // injected steps' answers, not parallel reads the function made itself —
  // a function that calls the steps and discards their results would pass
  // the ordering half while measuring something else entirely.
  assert.equal(out.runStartMs, STAMP, "the start-stamp the runner uses must be the one the stamp step produced");
  assert.equal(out.cpuBefore, baseline, "the CPU baseline the runner uses must be the one the baseline step produced");
});

test("runCli calls beginMeasuredRun and does not re-inline the sequence it extracts", () => {
  // Resolved from THIS file, not the process's cwd: the canonical invocation
  // (`node --test engine/test/prevention/suite-cpu-budget.test.ts`) runs from
  // the repository root, where `scripts/tooling/run-tests.ts` does not exist.
  const src = readFileSync(join(import.meta.dirname, "..", "..", "scripts", "tooling", "run-tests.ts"), "utf8");
  // The derivation is PRESENT on the runner's path...
  const cliStart = src.indexOf("async function runCli");
  assert.ok(cliStart >= 0, "runCli must exist in engine/scripts/tooling/run-tests.ts");
  const cliBody = src.slice(cliStart, src.indexOf("\nasync function", cliStart + 1));
  assert.match(cliBody, /beginMeasuredRun\(/u,
    "runCli must take its pre-run measurements through beginMeasuredRun — that function is where the order is guaranteed");
  // ...and the sequenced calls are ABSENT from the PRE-RUN region (before
  // the worker launches): re-inlining any one of the three steps there
  // would put its position back outside the guarantee. The end-of-run reads
  // (`cpuAfter`, `wallClockMs`) legitimately use the same primitives AFTER
  // the worker, so the window stops at the launch.
  const launchAt = cliBody.indexOf("runTestsWithEvidence(");
  assert.ok(launchAt >= 0, "runCli must launch the suite through runTestsWithEvidence(…)");
  const preRun = cliBody.slice(0, launchAt);
  for (const inlined of ["pruneCompileCacheIfDeclared(", "readRunCpu()", "Date.now()"]) {
    assert.ok(!preRun.includes(inlined),
      `runCli spells ${inlined} inline before the worker launch — the pre-run sequence must come from beginMeasuredRun, where its order is held`);
  }
});


// Actual append adapter: typed deterministic CPU inputs, copied configuration,
// real native child/ledger/finalization. No manually appended current verdict.
test("suite-cpu: actual adapter preserves its one-run red beside an owned test failure through current admission", async () => {
  const copy = createRepositoryWorkingCopy("suite-cpu-adapter-", {
    include: (path) => path.startsWith("engine/") || path.startsWith("shared/"),
  });
  try {
    const configPath = join(copy.engineRoot, ROOT_POLICY.configuration.basename);
    const config = JSON.parse(readFileSync(configPath, "utf8")) as { testExecution: Record<string, unknown> };
    config.testExecution.integrationSuiteCpuBudget = { ...DERIVED, derivedAtTestFileCount: 1 };
    // The copied config goes through the atomic-rename owner, like every
    // other config-shaped write in the walked population: the writer census
    // refuses a raw truncating write to a config path even in an isolated
    // per-test working copy — the torn-read class has no carve-out.
    const configWrite = atomicWriteFile(configPath, JSON.stringify(config));
    assert.ok(configWrite.success, configWrite.reason);
    const inventory = createCanonicalNodeTestInventoryFixture({
      sourceId: "test/adapter-fixture.test.ts", sourceHash: "a".repeat(64), name: "owned fixture failure",
    }).inventory;
    const inventoryPath = join(copy.engineRoot, VERIFICATION_PATHS.testInventory);
    mkdirSync(dirname(inventoryPath), { recursive: true });
    writeFileSync(inventoryPath, JSON.stringify(inventory));
    const historyPath = join(copy.engineRoot, TEST_RUN_HISTORY_PATH);
    const observedPath = join(copy.engineRoot, "adapter-observed.json");
    const owner = pathToFileURL(join(copy.engineRoot, "scripts", "tooling", "run-tests.ts")).href;
    const historyOwner = pathToFileURL(join(copy.engineRoot, "src", "shared", "run-history.ts")).href;
    const treeOwner = pathToFileURL(join(copy.engineRoot, "src", "shared", "tree-identity.ts")).href;
    const cacheOwner = pathToFileURL(join(copy.engineRoot, "scripts", "tooling", "compile-cache.ts")).href;
    for (const state of ["green", "red", "unslotted"] as const) {
      const red = state === "red";
      const invocationId = qualificationInvocation({});
      const environment: NodeJS.ProcessEnv = { ...process.env, NODE_DISABLE_COMPILE_CACHE: "1", [QUALIFICATION_INVOCATION_ENV]: invocationId };
      delete environment.NODE_COMPILE_CACHE;
      delete environment.HARNESS_MUTATION_RUN;
      const output: string[] = [];
      const child = await superviseCommand({
        supervisor: testProcessSupervisorBinary(), command: process.execPath,
        args: ["--input-type=module", "-e", [
          'import assert from "node:assert/strict"; import { writeFileSync } from "node:fs";',
          `const { judgeSuiteRunCost } = await import(${JSON.stringify(owner)});`,
          `const { qualificationInvocation, readRepositoryHeadSha } = await import(${JSON.stringify(historyOwner)});`,
          `const { readMeasuredTree } = await import(${JSON.stringify(treeOwner)});`,
          `const { compileCacheDirInUse } = await import(${JSON.stringify(cacheOwner)});`,
          // Null is observed, not fabricated warmth. The existing budget
          // explicitly permits this disabled-cache policy; assert disclosure.
          'assert.equal(compileCacheDirInUse(), null);',
          'const treeId = readMeasuredTree(process.cwd()); assert.notEqual(treeId, null);',
          `const gateExitCode = judgeSuiteRunCost({ root: process.cwd(), runStartMs: Date.now(), wallClockMs: 1,`,
          `cpuBefore: { totalCpuMs: 0, childCpuMs: 0 }, cpuAfter: { totalCpuMs: ${red ? 2_000 : 900}, childCpuMs: 0 },
          calibrationBefore: { cpuMs: 1, chunks: [1, 1, 1], workload: "int-mem-l2/v1", chunkIterations: 5000000 },
          calibrationAfter: { cpuMs: 1, chunks: [1, 1, 1], workload: "int-mem-l2/v1", chunkIterations: 5000000 },`,
          'failures: ["owned fixture failure"], failureDigests: {}, failureLocations: {}, invocationId: qualificationInvocation(process.env),',
          'producer: { complete: true, outcomes: [{ gate: "engine-results", kind: "pass", message: "complete typed fixture with one owned test failure" }] },',
          'headSha: readRepositoryHeadSha(process.cwd()), ambientLoadPerCpu: 0, ambientLoad5PerCpu: 0, ambientLoad15PerCpu: 0,',
          `heavySlot: ${JSON.stringify(state === "unslotted" ? "unslotted" : "held")}, provisional: {}, mutation: {}, tree: { treeId } });`,
          `writeFileSync(${JSON.stringify(observedPath)}, JSON.stringify({ gateExitCode, treeId }));`,
          // Both children exit1 for the same owned test. Only the adapter's
          // independently computed outcome may distinguish current admission.
          'process.exit(Math.max(1, gateExitCode));',
        ].join("\n")],
        cwd: copy.engineRoot, env: environment, hardCeilingMs: 60_000, killGraceMs: 500,
        onStdout: (chunk) => { output.push(chunk.toString()); }, onStderr: (chunk) => { output.push(chunk.toString()); },
      });
      assert.equal(supervisedCommandOutcome(child, "actual suite CPU adapter", 1).kind, "pass", output.join(""));
      const observed = JSON.parse(readFileSync(observedPath, "utf8")) as { gateExitCode: number; treeId: string };
      if (state === "unslotted") {
        // AN UNSLOTTED MEASUREMENT IS REFUSED, NEVER JUDGED: the run fails, says why, and records no row.
        assert.equal(observed.gateExitCode, 1, output.join(""));
        assert.match(output.join(""), /cpu-per-test-file REFUSED: this run did not hold the host's instrument lock/u);
        assert.equal(runForInvocation(historyPath, invocationId), undefined, "an unslotted measurement is not recorded");
        continue;
      }
      assert.equal(observed.gateExitCode, red ? 1 : 0, output.join(""));
      assert.match(output.join(""), /compile cache not observable/u);
      const raw = runForInvocation(historyPath, invocationId);
      assert.ok(raw?.qualification !== undefined, "actual adapter must publish its current envelope");
      assert.deepEqual(raw.failures, ["owned fixture failure"]);
      const terminal = qualificationTerminal(invocationId, observed.treeId, child);
      finalizeQualifiedRun(historyPath, invocationId, observed.treeId, terminal);
      const admission = currentQualificationOutcome(runForInvocation(historyPath, invocationId), {
        invocationId, treeId: observed.treeId, producer: "engine", outer: terminal,
      });
      assert.equal(admission.kind, red ? "fail" : "pass");
      if (red) assert.match(admission.message, /current non-test gate failed: cpu-per-test-file/u);
      assert.equal(raw.qualification.outcomes.find((outcome) => outcome.gate === "cpu-per-test-file")?.kind, red ? "fail" : "pass");
    }
  } finally {
    removeRepositoryLocalTemporaryDirectory(copy.root);
  }
});

test("THE BASELINE NEVER CLIMBS ON RUNS THAT FAILED (design HIGH 1): seven runs 2.5% over the cap fed the old fold through the spread and lifted the cap until the eighth passed; a row feeds only if its own CPU outcome passed", () => {
  const budget: RollingCpuBudget = {
    metric: "calibrated-work/v1",
    calibrationDriftMaxFraction: 0.15,
    validThroughLoad5PerCpu: 1.25,
    baselineFloorUnitsPerTestFile: 1_000, derivedAtTestFileCount: 100, maxPopulationDriftFraction: 0.05, sameTreeSpreadFraction: 0.026,
    baselineWindowRuns: 12, ambientInflationSlopePerCpu: 0, ambientInflationCapFraction: 0,
  };
  const run = (cpu: number, over: Partial<JudgedRunRecord> = {}): JudgedRunRecord => ({ timestamp: "2026-10-11T00:00:00.000Z", cpuMsPerTestFile: cpu, workUnitsPerTestFile: cpu, metric: "calibrated-work/v1", calibrationMs: 1, calibrationDriftFraction: 0.02, testModuleCount: 100, heavySlot: "held", ...over });
  // The same +2.5% regression, run after run: each is over the 1000 cap, so none feeds, and the cap stays 1000.
  const regressed = Array.from({ length: 40 }, () => run(1_025));
  const derived = deriveRollingBaseline(budget, regressed, 100, []);
  assert.equal(derived.baselineUnitsPerTestFile, 1_000, "forty failing runs move nothing");
  assert.deepEqual(derived.windowReadings, []);
  // Passing runs feed (at or under the cap in force), and the baseline is never lifted above the floor by them.
  assert.deepEqual(deriveRollingBaseline(budget, [run(990), run(1_000), run(995)], 100, []).windowReadings, [990, 1_000, 995]);
  // A row that recorded its own CPU outcome as failed never feeds, even when its reading is under today's cap.
  const failedOwn = run(990, { qualification: { schemaVersion: 1, invocationId: "qualification-00000000-0000-4000-8000-000000000000", treeId: "t", producer: "engine", producerComplete: true, outcomes: [{ gate: "cpu-per-test-file", kind: "fail", message: "over" }] } as never });
  assert.deepEqual(deriveRollingBaseline(budget, [failedOwn], 100, []).windowReadings, [], "its own recorded verdict is the word");
});


// ── THE MEASUREMENT REGISTRY'S ENGINE-SIDE COUNTERPART ───────────────────
//
// The registry is engine-owned (`src/shared/measurement-registry.ts`), so the
// engine package must be able to assert its own half without going through the
// web suite. This drives the same checked-in checker over the real tree and
// plants the four clauses' violations in memory (never in a tracked source).
test("measurement contract: the shared registry's producer, absence, gate and load clauses hold, and each plant is refused", async () => {
  const {
    loadMeasurementWorld,
    validateMeasurementContract,
    withSource,
  } = await import("../../scripts/verification/measurement-contract.ts");
  const { CPU_METRIC_PLACEHOLDERS, MEASUREMENT_REGISTRY } = await import("../../src/shared/measurement-registry.ts");
  const root = resolve(import.meta.dirname, "../../..");
  const world = loadMeasurementWorld(root);
  const codes = (candidate = world, registry = MEASUREMENT_REGISTRY): readonly string[] =>
    validateMeasurementContract(candidate, { registry }).failures.map((failure) => failure.code);

  const clean = validateMeasurementContract(world);
  assert.deepEqual(clean.failures, [], "the checked-in tree must satisfy the registry");
  assert.ok(clean.checked.metrics >= 20, "a vacuous registry would pass trivially");
  assert.equal(clean.checked.budgets, 13);
  assert.equal(CPU_METRIC_PLACEHOLDERS.length, 1);
  assert.equal(CPU_METRIC_PLACEHOLDERS[0]!.load.kind, "placeholder");

  const duplicate = withSource(
    world,
    "engine/src/shared/plant-duplicate-derivation.ts",
    "export function readPlantLoad(): number {\n  const loads = loadavg();\n  return loads[0] / cpuCount;\n}\n",
  );
  assert.ok(codes(duplicate).includes("duplicate-derivation"), "a second derivation of load-per-CPU must be refused");

  const ambient = world.sources.get("engine/src/shared/ambient-load.ts");
  assert.ok(ambient !== undefined);
  const zeroed = ambient.replace(
    "load1: toThousandths(load1 / cpuCount),",
    "load1: toThousandths(load1 / cpuCount) || 0,",
  );
  assert.ok(codes(withSource(world, "engine/src/shared/ambient-load.ts", zeroed)).includes("zero-as-absent"), "zero-for-absent must be refused");

  const history = world.sources.get("engine/src/shared/run-history.ts");
  assert.ok(history !== undefined);
  const gated = `${history}\nconst plantGate = { gate: "mystery-measurement", kind: "pass" };\n`;
  assert.ok(codes(withSource(world, "engine/src/shared/run-history.ts", gated)).includes("unregistered-gate"), "an unregistered measured gate must be refused");

  const agnostic: readonly MetricEntry[] = MEASUREMENT_REGISTRY.map((entry): MetricEntry => entry.name === "perf.profile.measuredSurfaceHash"
    ? { ...entry, load: { kind: "agnostic", normalization: "", proof: "" } }
    : entry);
  assert.ok(codes(world, agnostic).includes("agnostic-without-normalization"), "agnostic without a normalisation must be refused");
});
