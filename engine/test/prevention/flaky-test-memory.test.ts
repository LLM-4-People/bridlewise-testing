// A TEST THAT IS GREEN TODAY AND RED YESTERDAY IS AN UNREAD BUG REPORT.
//
// The failure this guard exists for: a wire-level data-corruption bug
// presented for rounds as an OCCASIONAL failure of an unrelated test — red
// twice in twenty-two runs — and the baseline handed to the next agent read
// "0 failing" because the second run happened to be green. Every gate in
// this project judged one run at a time; the intermittent failure was
// invisible to all of them.
//
// The memory already existed: `scripts/run-tests.ts` appends every judged
// full run to `.bridlewise/state/test-results/run-history.json`, failure
// rows included (`<file>::<test name>`). What was missing is the verdict
// over that memory — `flakySuspectsWithin` in `src/shared/run-history.ts`,
// driven here branch by branch, and then pointed at the live ledger. The
// verdict's explanations (a regeneration here; a declared and reproduced
// fix in test/git/flake-cause-fixes.test.ts) are driven beside the owner.
//
// (The freshness exemption below is JSDoc so the census guard reads it.)
/**
 * @freshness-exempt the run-history ledger is APPEND-ONLY: every judged run
 * appends a record and none is ever invalidated by a later commit, so the
 * verdict ("did this test fail recently but pass now") reads a GROWING
 * history, not a snapshot of the tree. There is no "stale" — an old entry is
 * still a true record of the run it describes. The sha the entry carries
 * (`headSha`) is provenance for the same-sha derivation, not a freshness gate.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import { createTempDir } from "../support/temp-dir.ts";
import {
  appendJudgedRun,
  flakySuspectArchivePath,
  flakySuspectsWithin,
  flakyVerdictWithin,
  readRunFailureRows,
  HISTORY_KEPT,
  regeneratedSuspectsMessage,
  TEST_RUN_HISTORY_PATH,
  type ArtifactRegeneration,
} from "../../src/shared/run-history.ts";
import { judgeFlakyMemory } from "../../src/workflow/flaky-burn-down.ts";
import { discoverTestNames, loadTestInventory } from "../../scripts/test-inventory.ts";

/**
 * This guard's own ledger-identity prefix — the feedback-loop exclusion,
 * computed from the file's own place rather than spelled, so a rename of
 * this file cannot silently re-arm the loop.
 */
const OWN_PREFIX = `${relative(process.cwd(), fileURLToPath(import.meta.url)).replaceAll("\\", "/")}::`;


/** A judged ledger entry with failure rows, planted oldest-first. */
function plantRun(cpuMsPerTestFile: number, failures: readonly string[], timestamp?: string) {
  return {
    timestamp: timestamp ?? `2026-08-0${String(1 + (cpuMsPerTestFile % 9))}T00:00:00.000Z`,
    cpuMsPerTestFile,
    testModuleCount: 700,
    failures,
  };
}

test("flaky-memory ledger: failure rows round-trip through the shared owner, and legacy entries read as empty", () => {
  const dir = createTempDir("flaky-history-");
  const path = join(dir, "run-history.json");
  appendJudgedRun(plantRun(901, ["test/a.test.ts::one", "test/a.test.ts::two"]), path);
  appendJudgedRun({ timestamp: "2026-08-01T01:00:00.000Z", cpuMsPerTestFile: 902, testModuleCount: 700 }, path);

  const rows = readRunFailureRows(path);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0]!.failures, ["test/a.test.ts::one", "test/a.test.ts::two"]);
  // The legacy entry — recorded before failure rows existed — is an empty
  // set, never an error: it can delay a red, it cannot manufacture one.
  assert.deepEqual(rows[1]!.failures, []);

  // Rows that are not non-empty strings are skipped, not believed — planted
  // at the byte level so the reader's tolerance is what is judged, not the
  // writer's.
  writeFileSync(
    path,
    JSON.stringify({
      runs: [
        { timestamp: "2026-08-01T00:00:00.000Z", cpuMsPerTestFile: 900, testModuleCount: 700, failures: ["kept", "", 42, null] },
      ],
    }),
  );
  assert.deepEqual(readRunFailureRows(path)[0]!.failures, ["kept"]);
});

test("THE SUSPECTS NEVER AGE OUT (design HIGH 2): a failing row the ledger trims past its depth moves to the never-trimmed suspect archive, and the memory still reads it — one failure then more green runs than the ledger keeps is still a suspect", () => {
  const dir = createTempDir("flaky-archive-");
  const path = join(dir, "run-history.json");
  appendJudgedRun(plantRun(901, ["test/a.test.ts::flakes"], "2026-08-01T00:00:00.000Z"), path);
  for (let index = 0; index < HISTORY_KEPT + 5; index += 1) appendJudgedRun(plantRun(902, [], `2026-08-02T00:00:${String(index).padStart(2, "0")}.000Z`), path);
  const ledger = JSON.parse(readFileSync(path, "utf8")) as { runs: unknown[] };
  assert.equal(ledger.runs.length, HISTORY_KEPT, "the run history is compacted to its depth");
  const archive = JSON.parse(readFileSync(flakySuspectArchivePath(path), "utf8")) as { runs: { failures: string[] }[] };
  assert.deepEqual(archive.runs.map((row) => row.failures), [["test/a.test.ts::flakes"]], "the trimmed failing row is archived; green rows are not");
  const rows = readRunFailureRows(path);
  assert.equal(rows.length, HISTORY_KEPT + 1, "the archive is read before the ledger");
  const suspects = flakySuspectsWithin(rows, rows.length);
  assert.deepEqual(suspects?.map((suspect) => suspect.identity), ["test/a.test.ts::flakes"], "still a suspect: it leaves only by a recorded reproduction or an owned entry");
  // A ledger write that failed after the archive's leaves the trimmed row in the ledger: the next append archives it
  // once, never twice (design LOW 11).
  const failing = { ...plantRun(901, ["test/a.test.ts::flakes"], "2026-08-01T00:00:00.000Z") };
  const restored = JSON.parse(readFileSync(path, "utf8")) as { runs: unknown[] };
  writeFileSync(path, JSON.stringify({ runs: [JSON.parse(JSON.stringify(failing)), ...restored.runs.slice(1)] }));
  appendJudgedRun(plantRun(902, [], "2026-08-03T00:00:00.000Z"), path);
  const again = JSON.parse(readFileSync(flakySuspectArchivePath(path), "utf8")) as { runs: unknown[] };
  assert.equal(again.runs.length, 1, "the same trimmed row is archived once");
});

test("flaky-memory verdict: a test that failed inside the window but not in the latest run is a suspect, with its provenance", () => {
  const entries = [
    { timestamp: "2026-08-01T00:00:00.000Z", failures: ["test/x.test.ts::flakes", "test/x.test.ts::steady"] },
    { timestamp: "2026-08-01T01:00:00.000Z", failures: [] },
    { timestamp: "2026-08-01T02:00:00.000Z", failures: ["test/x.test.ts::flakes"] },
    { timestamp: "2026-08-01T03:00:00.000Z", failures: ["test/x.test.ts::steady"] },
  ];
  const suspects = flakySuspectsWithin(entries, 4);
  assert.ok(suspects !== null);
  // "flakes" failed in r1 and r3 and not in r4 — the intermittent shape the
  // whole mechanism exists for. Its provenance names both occurrences.
  assert.deepEqual(suspects, [
    { identity: "test/x.test.ts::flakes", failedAt: ["2026-08-01T00:00:00.000Z", "2026-08-01T02:00:00.000Z"] },
  ]);
});

test("flaky-memory verdict: a test still failing in the latest run is NOT a suspect — the runner owns that red", () => {
  const entries = [
    { timestamp: "2026-08-01T00:00:00.000Z", failures: ["test/x.test.ts::broken"] },
    { timestamp: "2026-08-01T01:00:00.000Z", failures: ["test/x.test.ts::broken"] },
  ];
  assert.deepEqual(flakySuspectsWithin(entries, 2), []);
});

test("flaky-memory verdict: a clean window, an empty ledger and a one-run ledger are all green", () => {
  assert.deepEqual(flakySuspectsWithin([], 10), []);
  assert.deepEqual(flakySuspectsWithin([{ timestamp: "2026-08-01T00:00:00.000Z", failures: ["test/x.test.ts::once"] }], 10), []);
  assert.deepEqual(
    flakySuspectsWithin(
      [
        { timestamp: "2026-08-01T00:00:00.000Z", failures: [] },
        { timestamp: "2026-08-01T01:00:00.000Z", failures: [] },
      ],
      10,
    ),
    [],
  );
});

test("flaky-memory verdict: the window trims to the LAST N runs — an aged-out failure is memory, not a suspect", () => {
  const entries = [
    { timestamp: "2026-07-01T00:00:00.000Z", failures: ["test/x.test.ts::old-flake"] },
    { timestamp: "2026-08-01T00:00:00.000Z", failures: [] },
    { timestamp: "2026-08-01T01:00:00.000Z", failures: [] },
    { timestamp: "2026-08-01T02:00:00.000Z", failures: [] },
  ];
  assert.deepEqual(flakySuspectsWithin(entries, 3), []);
  assert.deepEqual(flakySuspectsWithin(entries, 4), [
    { identity: "test/x.test.ts::old-flake", failedAt: ["2026-07-01T00:00:00.000Z"] },
  ]);
});

test("flaky-memory verdict: the guard's own rows are excluded by prefix — a gate must not indict itself", () => {
  const entries = [
    { timestamp: "2026-08-01T00:00:00.000Z", failures: ["test/prevention/flaky-test-memory.test.ts::itself", "test/x.test.ts::real-flake"] },
    { timestamp: "2026-08-01T01:00:00.000Z", failures: [] },
  ];
  assert.deepEqual(
    flakySuspectsWithin(entries, 2, "test/prevention/flaky-test-memory.test.ts::"),
    [{ identity: "test/x.test.ts::real-flake", failedAt: ["2026-08-01T00:00:00.000Z"] }],
  );
});

test("flaky-memory verdict: a window below 2 is a refusal, never an empty answer", () => {
  assert.equal(flakySuspectsWithin([], 1), null);
  assert.equal(flakySuspectsWithin([], 0), null);
  assert.equal(flakySuspectsWithin([], 1.5), null);
});

test("flaky-memory verdict: a deliberate mutation run never indicts — its red is the verification working", () => {
  // A DELIBERATE MUTATION-VERIFICATION run (HARNESS_MUTATION_RUN=1 — the
  // operator plants a defect, runs the owning suite to watch it red,
  // restores) is expected to red: the red IS the verification working, so
  // its failure rows are evidence about the planted defect, never about the
  // committed code. The standing 2026-08-24 suspect (a module-load failure
  // healed within minutes, never recurred) was recorded by exactly such a
  // run and misread as the suite's flakiness for a whole window. The
  // marker's exclusion is the INDICT half alone — the window-slot and
  // latest-run postures stay the provisional precedent, and an UNMARKED
  // row keeps the historical verdict.
  // 1. A mutation red alone never indicts.
  assert.deepEqual(
    flakySuspectsWithin(
      [
        { timestamp: "2026-08-01T00:00:00.000Z", failures: ["test/x.test.ts::planted"], mutation: true },
        { timestamp: "2026-08-01T01:00:00.000Z", failures: [] },
      ],
      10,
    ),
    [],
  );
  // 2. The IDENTICAL shape without the marker indicts — the exclusion is
  //    the marker's alone, and a row that cannot say it was a mutation run
  //    was, as far as the ledger knows, an ordinary one.
  assert.deepEqual(
    flakySuspectsWithin(
      [
        { timestamp: "2026-08-01T00:00:00.000Z", failures: ["test/x.test.ts::unmarked"] },
        { timestamp: "2026-08-01T01:00:00.000Z", failures: [] },
      ],
      10,
    ),
    [{ identity: "test/x.test.ts::unmarked", failedAt: ["2026-08-01T00:00:00.000Z"] }],
  );
  // 3. A mutation red beside a real one of the same test indicts on the
  //    real run's evidence alone — the provenance names only the
  //    indicting run, never the verification.
  assert.deepEqual(
    flakySuspectsWithin(
      [
        { timestamp: "2026-08-01T00:00:00.000Z", failures: ["test/x.test.ts::both"], mutation: true },
        { timestamp: "2026-08-01T01:00:00.000Z", failures: ["test/x.test.ts::both"] },
        { timestamp: "2026-08-01T02:00:00.000Z", failures: [] },
      ],
      10,
    ),
    [{ identity: "test/x.test.ts::both", failedAt: ["2026-08-01T01:00:00.000Z"] }],
  );
  // 4. The marker is not a time machine: a mutation run occupies its window
  //    slot like any recorded run (the provisional precedent), so a real
  //    failure still ages out through recorded runs whatever their marks.
  assert.deepEqual(
    flakySuspectsWithin(
      [
        { timestamp: "2026-08-01T00:00:00.000Z", failures: ["test/x.test.ts::aging"] },
        { timestamp: "2026-08-01T01:00:00.000Z", failures: [], mutation: true },
        { timestamp: "2026-08-01T02:00:00.000Z", failures: [] },
      ],
      2,
    ),
    [],
  );
});

test("flaky-memory verdict: a provisional (dirty-tree) failure alone never indicts — a mid-edit iteration is not a flake", () => {
  // The iterate-then-verify loop of building a fix runs the suite against a
  // tree whose tracked content is deliberately mid-edit; those reds are
  // evidence about the edit, never about the committed code. The verdict
  // therefore requires a COMMITTED-tree failure inside the window.
  const dirtyOnly = flakySuspectsWithin(
    [
      { timestamp: "2026-08-01T00:00:00.000Z", failures: ["test/x.test.ts::mid-edit"], provisional: true },
      { timestamp: "2026-08-01T01:00:00.000Z", failures: [] },
    ],
    10,
  );
  assert.deepEqual(dirtyOnly, []);
  // A dirty-tree failure beside a COMMITTED-tree one indicts on the
  // committed run's evidence — the provenance names only the indicting run.
  const mixed = flakySuspectsWithin(
    [
      { timestamp: "2026-08-01T00:00:00.000Z", failures: ["test/x.test.ts::real-flake"], provisional: true },
      { timestamp: "2026-08-01T01:00:00.000Z", failures: ["test/x.test.ts::real-flake"] },
      { timestamp: "2026-08-01T02:00:00.000Z", failures: [] },
    ],
    10,
  );
  assert.deepEqual(mixed, [
    { identity: "test/x.test.ts::real-flake", failedAt: ["2026-08-01T01:00:00.000Z"] },
  ]);
});

test("flaky-memory verdict: a row without provenance counts as a REAL failure — absence is not innocence", () => {
  // Legacy entries predate the marker, and a malformed flag must not read as
  // provisional: both are the historical posture, a real failure.
  assert.deepEqual(
    flakySuspectsWithin(
      [
        { timestamp: "2026-08-01T00:00:00.000Z", failures: ["test/x.test.ts::legacy"] },
        { timestamp: "2026-08-01T01:00:00.000Z", failures: [] },
      ],
      10,
    ),
    [{ identity: "test/x.test.ts::legacy", failedAt: ["2026-08-01T00:00:00.000Z"] }],
  );
});

test("flaky-memory verdict: the latest run's failures mute a suspect whatever their provenance", () => {
  // A break visible in the LATEST run is the runner's own red, and the
  // memory does not split that ownership by tree state.
  assert.deepEqual(
    flakySuspectsWithin(
      [
        { timestamp: "2026-08-01T00:00:00.000Z", failures: ["test/x.test.ts::still-red"] },
        { timestamp: "2026-08-01T01:00:00.000Z", failures: ["test/x.test.ts::still-red"], provisional: true },
      ],
      10,
    ),
    [],
  );
});

test("flaky-memory ledger: the provisional marker round-trips through the shared owner, and legacy or malformed flags read as real failures", () => {
  const dir = createTempDir("flaky-provisional-");
  const path = join(dir, "run-history.json");
  appendJudgedRun({ ...plantRun(910, ["test/a.test.ts::mid-edit"]), provisionalFailures: true }, path);
  appendJudgedRun(plantRun(911, ["test/a.test.ts::committed"]), path);
  const rows = readRunFailureRows(path);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.provisional, true);
  assert.equal(rows[1]!.provisional, false);
  // Planted at the byte level: a legacy entry (no field) and a malformed
  // flag both read as a REAL failure — the lean that can postpone a
  // provisional reprieve, never fabricate one.
  writeFileSync(
    path,
    JSON.stringify({
      runs: [
        { timestamp: "2026-08-01T00:00:00.000Z", cpuMsPerTestFile: 900, testModuleCount: 700, failures: ["legacy"] },
        { timestamp: "2026-08-01T01:00:00.000Z", cpuMsPerTestFile: 901, testModuleCount: 700, failures: ["malformed"], provisionalFailures: "yes" },
      ],
    }),
  );
  const reread = readRunFailureRows(path);
  assert.equal(reread[0]!.provisional, false);
  assert.equal(reread[1]!.provisional, false);
});

test("flaky-memory ledger: the deliberate-mutation marker round-trips through the shared owner, and legacy or malformed flags read as real failures", () => {
  // The marker is recorded at the append site (the runners spread
  // `mutationRunMark()`), so the ledger's own byte shape is pinned here the
  // same way the provisional marker's is: a marked row reads `mutation:
  // true`, and everything else — a legacy entry, a malformed flag — reads
  // as an ordinary run whose failures count in both directions.
  const dir = createTempDir("flaky-mutation-");
  const path = join(dir, "run-history.json");
  appendJudgedRun({ ...plantRun(910, ["test/a.test.ts::planted"]), mutationRun: true }, path);
  appendJudgedRun(plantRun(911, ["test/a.test.ts::ordinary"]), path);
  const rows = readRunFailureRows(path);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.mutation, true);
  assert.equal(rows[0]!.provisional, false);
  assert.equal(rows[1]!.mutation, false);
  writeFileSync(
    path,
    JSON.stringify({
      runs: [
        { timestamp: "2026-08-01T00:00:00.000Z", cpuMsPerTestFile: 900, testModuleCount: 700, failures: ["legacy"] },
        { timestamp: "2026-08-01T01:00:00.000Z", cpuMsPerTestFile: 901, testModuleCount: 700, failures: ["malformed"], mutationRun: "yes" },
      ],
    }),
  );
  const reread = readRunFailureRows(path);
  assert.equal(reread[0]!.mutation, false);
  assert.equal(reread[1]!.mutation, false);
});

test("flaky-memory regenerations: a later regeneration of the artifact a test judges explains its pre-regeneration failures — the mint-last posture is not a flake", () => {
  // The mint-last discipline guarantees the shape: a writer's full gates
  // run BEFORE the standing final profile regeneration, so a test whose
  // red says "the artifact no longer describes the current code" reds
  // deterministically on every pre-mint run and greens on every post-mint
  // one — the exact red-then-green signature the flaky window exists to
  // indict, produced by a KNOWN cause with a RECORDED remedy whose
  // instant postdates the symptom (one writer round paid 7 extra full
  // runs while exactly these rows aged out of that time's window (nothing ages out now) read as
  // flakiness; measured in the live ledger, 2026-09-03). The exclusion
  const entries = [
    { timestamp: "2026-09-03T10:00:00.000Z", failures: ["test/x.test.ts::stale-artifact"] },
    { timestamp: "2026-09-03T11:00:00.000Z", failures: [] },
  ];
  const regenerated: ArtifactRegeneration[] = [
    { identity: "test/x.test.ts::stale-artifact", regeneratedAtMs: Date.parse("2026-09-03T10:30:00.000Z") },
  ];
  // WITH the data: explained, moved out of the reds, and reported — the
  // composite carries the explanation, never a silent swallow.
  const verdict = flakyVerdictWithin(entries, 10, undefined, regenerated);
  assert.ok(verdict !== null);
  assert.deepEqual(verdict.reds, []);
  assert.deepEqual(verdict.regenerated, [
    {
      suspect: { identity: "test/x.test.ts::stale-artifact", failedAt: ["2026-09-03T10:00:00.000Z"] },
      regeneration: regenerated[0]!,
    },
  ]);
  const note = regeneratedSuspectsMessage(verdict.regenerated);
  assert.ok(note.includes("test/x.test.ts::stale-artifact"), note);
  assert.ok(note.includes("2026-09-03T10:30:00.000Z"), note);
  assert.ok(note.includes("the raw ledger rows stand"), note);
  // WITHOUT the data — the historical posture — the identical rows indict:
  // the exclusion is the data's alone, and an unreadable report or a caller
  // that passes nothing excludes nothing.
  const withoutData = flakyVerdictWithin(entries, 10, undefined, []);
  assert.deepEqual(withoutData!.regenerated, []);
  assert.deepEqual(withoutData!.reds, [
    { identity: "test/x.test.ts::stale-artifact", failedAt: ["2026-09-03T10:00:00.000Z"] },
  ]);
  // The RAW verdict is untouched by the dimension — the mute is the
  // composite's alone, exactly as the filed mute is.
  assert.deepEqual(flakySuspectsWithin(entries, 10)!.map((s) => s.identity), ["test/x.test.ts::stale-artifact"]);
});

test("flaky-memory regenerations: a recurrence after the regeneration reds — the forcing function survives the mechanical dimension too", () => {
  // The explanation is per-incident, never perpetual: it covers only
  // failures recorded strictly BEFORE the instant. A failure at or after
  // it is a recurrence the regeneration cannot explain, and the suspect
  // reds naming it — the same boundary the filed dimension takes.
  const regenerated: ArtifactRegeneration[] = [
    { identity: "test/x.test.ts::stale-artifact", regeneratedAtMs: Date.parse("2026-09-03T10:30:00.000Z") },
  ];
  const entries = [
    { timestamp: "2026-09-03T10:00:00.000Z", failures: ["test/x.test.ts::stale-artifact"] },
    { timestamp: "2026-09-03T11:00:00.000Z", failures: ["test/x.test.ts::stale-artifact"] },
    { timestamp: "2026-09-03T12:00:00.000Z", failures: [] },
  ];
  const verdict = flakyVerdictWithin(entries, 10, undefined, regenerated);
  assert.deepEqual(verdict!.regenerated, []);
  assert.deepEqual(verdict!.reds, [
    {
      identity: "test/x.test.ts::stale-artifact",
      failedAt: ["2026-09-03T10:00:00.000Z", "2026-09-03T11:00:00.000Z"],
    },
  ]);
  // The boundary is strict: a failure recorded AT the regeneration instant
  // is a recurrence too, never "simultaneous with the remedy" — the filed
  // dimension's exact edge.
  const atBoundary = flakyVerdictWithin(
    [
      { timestamp: "2026-09-03T10:30:00.000Z", failures: ["test/x.test.ts::stale-artifact"] },
      { timestamp: "2026-09-03T12:00:00.000Z", failures: [] },
    ],
    10,
    undefined,
    regenerated,
  );
  assert.deepEqual(atBoundary!.reds, [
    { identity: "test/x.test.ts::stale-artifact", failedAt: ["2026-09-03T10:30:00.000Z"] },
  ]);
  assert.deepEqual(atBoundary!.regenerated, []);
});

test("flaky-memory regenerations: the explanation is the named identity's alone — a different test's identical-shape red still indicts", () => {
  // The over-widening catcher: an exclusion that silently widened to ALL
  // identities (or to the file's prefix) would mute a GENUINE intermittent
  // red that happens to be recorded beside the explained one. The
  // mechanism matches the exact identity, and this arm reds the day it
  // does not.
  const regenerated: ArtifactRegeneration[] = [
    { identity: "test/x.test.ts::stale-artifact", regeneratedAtMs: Date.parse("2026-09-03T10:30:00.000Z") },
  ];
  const verdict = flakyVerdictWithin(
    [
      {
        timestamp: "2026-09-03T10:00:00.000Z",
        failures: ["test/x.test.ts::stale-artifact", "test/x.test.ts::genuine-flake"],
      },
      { timestamp: "2026-09-03T11:00:00.000Z", failures: [] },
    ],
    10,
    undefined,
    regenerated,
  );
  assert.deepEqual(verdict!.regenerated.map((r) => r.suspect.identity), ["test/x.test.ts::stale-artifact"]);
  assert.deepEqual(verdict!.reds, [
    { identity: "test/x.test.ts::genuine-flake", failedAt: ["2026-09-03T10:00:00.000Z"] },
  ]);
});

test("flaky-memory regenerations: a suspect without readable provenance is never excluded — absence is not innocence on both sides of this pair too", () => {
  // A legacy row that recorded NO timestamp can never be proven
  // pre-regeneration, so the explanation does not cover it; and a
  // regeneration instant that is not a finite number can never be
  // compared, so it explains nothing. Both lean the same direction as
  // every other marker in the ledger: toward counting as a real failure.
  const noTimestamp = flakyVerdictWithin(
    [
      { timestamp: null, failures: ["test/x.test.ts::legacy-row"] },
      { timestamp: "2026-09-03T11:00:00.000Z", failures: [] },
    ],
    10,
    undefined,
    [{ identity: "test/x.test.ts::legacy-row", regeneratedAtMs: Date.parse("2026-09-03T10:30:00.000Z") }],
  );
  assert.deepEqual(noTimestamp!.reds, [{ identity: "test/x.test.ts::legacy-row", failedAt: [null] }]);
  assert.deepEqual(noTimestamp!.regenerated, []);
  const malformedInstant = flakyVerdictWithin(
    [
      { timestamp: "2026-09-03T10:00:00.000Z", failures: ["test/x.test.ts::malformed"] },
      { timestamp: "2026-09-03T11:00:00.000Z", failures: [] },
    ],
    10,
    undefined,
    [{ identity: "test/x.test.ts::malformed", regeneratedAtMs: Number.NaN }],
  );
  assert.deepEqual(malformedInstant!.reds, [
    { identity: "test/x.test.ts::malformed", failedAt: ["2026-09-03T10:00:00.000Z"] },
  ]);
  assert.deepEqual(malformedInstant!.regenerated, []);
});

test("flaky-memory LIVE: no test failed in the retained ledger but passed in the latest recorded run, unless it is explained or an owned burn-down entry", async () => {
  // The actual gate, over this tree's own WHOLE ledger (nothing ages out of a
  // window: design NH-E), through the one judgement both suites' guards call
  // (src/workflow/flaky-burn-down.ts `judgeFlakyMemory`). A missing ledger is
  // an empty history — it can delay a red, never manufacture one. A suspect a
  // declared AND reproduced fix explains is said (never silently dropped) and
  // does not red (FLAKE-REPRO); a malformed declaration or record is said, and
  // explains nothing.
  // A moved test is judged by the suites as they stand: the hermetic suite's
  // identities (the test inventory) and the live suite's manifest (the
  // inventory's qualified-external sources, read by the one test-name parser).
  const inventory = loadTestInventory(process.cwd());
  const suites = {
    hermetic: new Set(inventory.tests.map((entry) => `${entry.sourceId}::${entry.name}`)),
    live: new Set(inventory.scope.qualifiedExternalSourceIds.flatMap((sourceId) =>
      discoverTestNames(readFileSync(join(process.cwd(), sourceId), "utf8")).map((name) => `${sourceId}::${name}`))),
  };
  const judgement = await judgeFlakyMemory({
    suite: "engine", engineRoot: process.cwd(), entries: readRunFailureRows(join(process.cwd(), TEST_RUN_HISTORY_PATH)),
    ownPrefix: OWN_PREFIX, guardFile: OWN_PREFIX.slice(0, -2), regenerated: [], suites,
  });
  for (const line of judgement.lines) console.info(line);
  assert.equal(judgement.failure, null, judgement.failure ?? "");
});
