// A TEST THAT IS GREEN TODAY AND RED YESTERDAY IS AN UNREAD BUG REPORT.
//
// The failure this guard exists for: a wire-level data-corruption bug
// presented for rounds as an OCCASIONAL failure of an unrelated test — red
// twice in twenty-two runs — and the baseline handed to the next agent read
// "0 failing" because the second run happened to be green. Every gate in
// this project judged one run at a time; the intermittent failure was
// invisible to all of them.
//
// The memory already existed: `tests/reporters/budget-reporter.ts` appends
// every judged full run to `.bridlewise/web-test-results/run-history.json`,
// failure rows included (`<file>::<full test name>`). What was missing is
// the verdict over that memory — `flakySuspectsWithin` in the shared ledger
// owner, driven here against planted ledgers and then pointed at the live
// one. The comparison's full branch matrix lives beside the shared owner in
// the engine suite's guard of the same name; this file proves THIS suite's
// consumption of it — the web path binding, the config key, the live gate
// (the same declared and reproduced fixes the engine verdict reads), and the
// perf gate's freshness explanation.
//
// (The freshness exemption below is JSDoc so the census guard reads it.)
/**
 * @freshness-exempt the run-history ledger is APPEND-ONLY: every judged run
 * appends a record and none is invalidated by a later commit; the history
 * keeps its newest rows and moves each failing row it trims to its
 * never-trimmed suspect archive, which the verdict reads too, so the verdict
 * ("did this test fail and pass since") reads a GROWING record of failures,
 * not a snapshot of the tree. There is no "stale" — an old entry is
 * still a true record of the run it describes. The sha the entry carries
 * (`headSha`) is provenance for the same-sha derivation, not a freshness gate.
 */

import { describe, expect, test } from "vitest";
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createTempDir } from "../helpers/temp-dir.ts";
import { appendJudgedRun } from "../helpers/budget-history.ts";
import type { JudgedRunRecord } from "../helpers/budget-verdict.ts";
import { BUDGET_HISTORY_PATH } from "../helpers/budget-paths.ts";
import { excludedTestFiles } from "../helpers/test-manifest.ts";
import {
  flakySuspectsWithin,
  flakyVerdictWithin,
  readRunFailureRows,
  regeneratedSuspectsMessage,
  type ArtifactRegeneration,
} from "../../engine/src/shared/run-history.ts";
import {
  FRESHNESS_ARM_TEST_TITLE,
  REGRESSION_GATE_SUITE_TITLE,
  REPORT_PATH,
} from "../performance/lib/perf-harness";
import { enclosingFunctionOf, functionArgumentsOf } from "../../engine/src/shared/source-structure.ts";
import { judgeFlakyMemory } from "../../engine/src/workflow/flaky-burn-down.ts";
import { readMeasuredSurfaceHash } from "../../engine/src/shared/tree-identity.ts";
import { judgeableProfileReport } from "../../scripts/testing/performance-measurements.ts";

/**
 * This guard's own ledger-identity prefix — the feedback-loop exclusion,
 * computed from the file's own place rather than spelled, so a rename of
 * this file cannot silently re-arm the loop.
 */
const OWN_PREFIX = `${relative(process.cwd(), fileURLToPath(import.meta.url)).replaceAll("\\", "/")}::`;
/** This guard's own repository path: what an owner row of a burn-down entry must name beside the test. */
const GUARD_FILE = OWN_PREFIX.slice(0, -2);

/**
 * The perf gate's file, derived from this guard's own place — the subject
 * the freshness exclusion composes its identity around. Derived, never
 * spelled, for the same reason OWN_PREFIX is: the wiring must follow a
 * rename, and the arm below reds the day the path stops resolving.
 */
const GATE_FILE_ABSOLUTE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "performance",
  "regression.test.ts",
);
const GATE_FILE = relative(process.cwd(), GATE_FILE_ABSOLUTE).replaceAll("\\", "/");

/**
 * The freshness arm's ledger identity, composed exactly as the reporter
 * records identities (`<file>::<suite title> > <test title>`) from the
 * titles' ONE owner — the perf lib declares them, the gate renders them,
 * this guard composes with them — and the contract arm below pins the
 * declarations to the rendered titles, so a rename at either end reds the
 * day it happens instead of silently detaching the exclusion from the
 * rows it names.
 */
const FRESHNESS_ARM_IDENTITY = `${GATE_FILE}::${REGRESSION_GATE_SUITE_TITLE} > ${FRESHNESS_ARM_TEST_TITLE}`;

/** Every arm of the regression gate's suite: each judges the profile report and nothing else of the run. */
const GATE_SUITE_PREFIX = `${GATE_FILE}::${REGRESSION_GATE_SUITE_TITLE} > `;

/**
 * The gate suite's pre-mint explanation, derived from the artifact its arms
 * judge: the profile report's own regeneration instant — the `generatedAt` the
 * profile step wrote INTO a report that can be judged (measured inside the
 * host's lock, of this code: the one predicate, `judgeableProfileReport`),
 * never the file's mtime (a `touch` would mute every earlier failure: design
 * F6). Every arm of the
 * suite reads the report (its presence, its lock stamp, its freshness, its
 * measurements), so a failure row recorded strictly before the instant
 * described a report that no longer exists (or none), and the one profile
 * step that mints a new one is the recorded remedy: the flaky window must
 * not read it as a flake. A failure at or after the instant judged THIS
 * report and indicts. The identities are the gate suite's own rows in the
 * ledger (`ledgerIdentities`), never a list spelled here; a report that
 * cannot be stat'd can prove nothing, and nothing is excluded: the
 * historical posture, deny-by-default. The suite's other describe blocks
 * (the harness's own unit tests) are not the report's and stay judged.
 */
function reportRegeneration(ledgerIdentities: Iterable<string>, reportPath: string = REPORT_PATH): ArtifactRegeneration[] {
  const judgeable = judgeableProfileReport(process.cwd(), reportPath);
  if ("why" in judgeable) return [];
  const regeneratedAtMs = Date.parse(judgeable.report.generatedAt);
  if (!Number.isFinite(regeneratedAtMs)) return [];
  return [...new Set([...ledgerIdentities].filter((identity) => identity.startsWith(GATE_SUITE_PREFIX)))].map((identity) => ({ identity, regeneratedAtMs }));
}

describe("flaky-test memory — the web suite's consumption of the shared verdict", () => {
  test("the web binding's append preserves failure rows through the ledger owner (raw bytes asserted)", () => {
    const dir = createTempDir("flaky-web-history-");
    const path = join(dir, "run-history.json");
    appendJudgedRun(
      {
        timestamp: "2026-08-03T00:00:00.000Z",
        cpuMsPerTestFile: 900,
        testModuleCount: 400,
        failures: ["tests/unit/a.test.ts::suite > flakes"],
      } as JudgedRunRecord,
      path,
    );
    appendJudgedRun(
      {
        timestamp: "2026-08-03T01:00:00.000Z",
        cpuMsPerTestFile: 901,
        testModuleCount: 400,
        provisionalFailures: true,
      } as JudgedRunRecord,
      path,
    );
    const rows = readRunFailureRows(path);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.failures).toEqual(["tests/unit/a.test.ts::suite > flakes"]);
    expect(rows[1]!.failures).toEqual([]);
    // The provisional marker rides the same round-trip: a dirty-tree run's
    // rows read provisional, a run recorded without the marker reads as a
    // real failure (absence of provenance is not innocence).
    expect(rows[0]!.provisional).toBe(false);
    expect(rows[1]!.provisional).toBe(true);
  });

  test("a planted intermittent failure is indicted; the same failure still failing is not (the runner owns that red)", () => {
    const flaky = flakySuspectsWithin(
      [
        { timestamp: "r1", failures: ["tests/unit/x.test.ts::s > flakes"] },
        { timestamp: "r2", failures: [] },
      ],
      10,
    );
    expect(flaky).toEqual([{ identity: "tests/unit/x.test.ts::s > flakes", failedAt: ["r1"] }]);
    const steady = flakySuspectsWithin(
      [
        { timestamp: "r1", failures: ["tests/unit/x.test.ts::s > broken"] },
        { timestamp: "r2", failures: ["tests/unit/x.test.ts::s > broken"] },
      ],
      10,
    );
    expect(steady).toEqual([]);
  });

  test("a dirty-tree iteration is not a flake — provisional rows alone never indict", () => {
    // The web-side consumption of the provisional weighting (the full branch
    // matrix lives in the engine guard beside the shared owner): a failure
    // recorded on a tracked-dirty run is a mid-edit iteration, and a clean
    // latest run beside it greens.
    const dirtyOnly = flakySuspectsWithin(
      [
        { timestamp: "r1", failures: ["tests/unit/x.test.ts::s > mid-edit"], provisional: true },
        { timestamp: "r2", failures: [] },
      ],
      10,
    );
    expect(dirtyOnly).toEqual([]);
    // The same failure on a COMMITTED-tree run still indicts — the guard's
    // real-flake sensitivity is untouched by the weighting.
    const committed = flakySuspectsWithin(
      [
        { timestamp: "r1", failures: ["tests/unit/x.test.ts::s > real-flake"] },
        { timestamp: "r2", failures: [] },
      ],
      10,
    );
    expect(committed).toEqual([{ identity: "tests/unit/x.test.ts::s > real-flake", failedAt: ["r1"] }]);
  });

  test("the freshness exclusion is wired to the gate that owns it — the derived gate path resolves, or the exclusion is dead data", () => {
    // The identity the exclusion names is composed around the perf gate's
    // file path. The path is DERIVED (a rename of this guard or the gate
    // re-derives it), but the gate file itself must exist at the derived
    // place: a renamed gate file would leave the exclusion naming an
    // identity nothing records, and the round-start pre-mint rows would
    // return as unexplained flaky reds. This arm reds on the rename the
    // day it happens, naming the path — before the cost returns as a
    // mysterious flaky red nobody can place.
    expect(
      existsSync(GATE_FILE_ABSOLUTE),
      `the perf gate file is not at the path the freshness exclusion composes its identity from — ` +
        `the exclusion is naming a test nothing records. Restore the file or re-derive the composition.`,
    ).toBe(true);
  });

  test("the declared titles ARE the gate's rendered titles — the freshness identity's mirror cannot drift", () => {
    // The perf lib's suite + arm titles are the one spelling every identity
    // consumer composes from, and the gate renders its own titles as
    // literals — a MIRROR, held honest by this exact contract: the gate's
    // two rendered title literals are extracted from its source and must
    // equal the declarations. A rename at either end (a retitled gate, a
    // redeclared constant) reds HERE the day it happens — a named,
    // actionable red — instead of silently detaching the exclusion from
    // the rows it names and returning the pre-mint cost as a mysterious
    // flaky red a round later.
    const gateSource = readFileSync(GATE_FILE_ABSOLUTE, "utf8");
    const suites = functionArgumentsOf(gateSource, "describe", [JSON.stringify(REGRESSION_GATE_SUITE_TITLE)]);
    expect(
      suites.length,
      "the declared gate suite must render exactly once",
    ).toBe(1);
    const suite = suites[0]!;
    expect(enclosingFunctionOf(gateSource, suite.offset - 1), "the gate suite is top-level").toBeUndefined();
    const arms = functionArgumentsOf(gateSource, "it", [JSON.stringify(FRESHNESS_ARM_TEST_TITLE)]);
    expect(arms.length, "the declared freshness arm must render exactly once").toBe(1);
    const containing = enclosingFunctionOf(gateSource, arms[0]!.offset - 1);
    expect(containing?.offset, "the freshness arm must render directly inside its declared suite, not a neighboring or nested suite").toBe(suite.offset);
  });

  test("the exclusion's data is the report's OWN recorded regeneration instant, for the gate suite's arms the ledger names — a touch moves nothing; an unreadable report, one measured outside the lock or one of other code proves nothing (design F6)", () => {
    // Derived from the artifact itself, never asserted by the operator: a
    // judgeable report contributes each gate-suite arm the ledger names (and
    // no other row) + the `generatedAt` the profile step wrote into it; any
    // other report excludes NOTHING — the historical posture, deny-by-default.
    // PLANTED, never the real report: the profile report is a gitignored
    // artifact (absent in any fresh checkout), so an arm that read it would
    // judge the machine, not the rule.
    const dir = createTempDir("flaky-freshness-");
    const report = join(dir, "report.json");
    const regeneratedAt = new Date("2026-09-03T10:30:00.000Z");
    const planted = (fields: Readonly<Record<string, unknown>>): void => writeFileSync(report, JSON.stringify({
      generatedAt: regeneratedAt.toISOString(), instrumentLock: "held", treeIdentity: { measuredSurfaceHash: readMeasuredSurfaceHash(process.cwd()) }, ...fields,
    }));
    planted({});
    // A touch long after: the file's time is not the report's.
    utimesSync(report, new Date("2026-10-01T00:00:00.000Z"), new Date("2026-10-01T00:00:00.000Z"));
    const presentArm = `${GATE_SUITE_PREFIX}the profile report is present and parseable`;
    const harnessUnit = `${GATE_FILE}::network measurement ownership > drains every acquisition`;
    const rows = [FRESHNESS_ARM_IDENTITY, presentArm, presentArm, harnessUnit, "tests/unit/x.test.ts::s > genuine"];
    expect(reportRegeneration(rows, report)).toEqual([
      { identity: FRESHNESS_ARM_IDENTITY, regeneratedAtMs: regeneratedAt.getTime() },
      { identity: presentArm, regeneratedAtMs: regeneratedAt.getTime() },
    ]);
    expect(reportRegeneration(rows, join(dir, "absent-report.json"))).toEqual([]);
    planted({ instrumentLock: "unslotted" });
    expect(reportRegeneration(rows, report), "measured outside the lock").toEqual([]);
    planted({ treeIdentity: { measuredSurfaceHash: "0".repeat(64) } });
    expect(reportRegeneration(rows, report), "of other code").toEqual([]);
  });

  test("the freshness arm's pre-mint rows are explained by the report's regeneration — a genuine red beside them still indicts", () => {
    // The mint-last posture, made mechanical: a writer's full gates run
    // before the standing final mint, so the freshness arm's pre-mint red
    // is DETERMINISTIC with a known cause and a recorded remedy whose
    // instant postdates the symptom (one writer round paid 7 extra full
    // runs while exactly these rows aged out of that time's window (nothing ages out now) read as
    // flakiness; measured in the live ledger, 2026-09-03).
    const entries = [
      { timestamp: "2026-09-03T10:00:00.000Z", failures: [FRESHNESS_ARM_IDENTITY, "tests/unit/x.test.ts::s > genuine"] },
      { timestamp: "2026-09-03T11:00:00.000Z", failures: [] },
    ];
    const regeneration: ArtifactRegeneration[] = [
      { identity: FRESHNESS_ARM_IDENTITY, regeneratedAtMs: Date.parse("2026-09-03T10:30:00.000Z") },
    ];
    // WITH the data: the pre-mint row (recorded 10:00, the regeneration at
    // 10:30 postdates it) is explained and SAID — never silently muted —
    // while the GENUINE intermittent red beside it still indicts: the
    // exclusion is the freshness identity's alone, and an over-wide
    // mutation that mutes the genuine row too reds here.
    const verdict = flakyVerdictWithin(entries, 10, undefined, regeneration);
    expect(verdict).not.toBeNull();
    expect(verdict!.reds.map((s) => s.identity)).toEqual(["tests/unit/x.test.ts::s > genuine"]);
    expect(verdict!.regenerated.map((r) => r.suspect.identity)).toEqual([FRESHNESS_ARM_IDENTITY]);
    expect(regeneratedSuspectsMessage(verdict!.regenerated)).toContain(
      "indicted but explained by the artifact's regeneration",
    );
    // WITHOUT the data — the historical posture — the identical rows indict:
    // the exclusion is the data's alone, and removing the fix (or the data)
    // brings the round-50 reds back.
    const withoutData = flakyVerdictWithin(entries, 10, undefined, []);
    expect(withoutData!.regenerated).toEqual([]);
    expect(withoutData!.reds.map((s) => s.identity)).toContain(FRESHNESS_ARM_IDENTITY);
  });

  test("flaky-memory LIVE: no test failed in the retained ledger but passed in the latest recorded run, unless it is explained or an owned burn-down entry", async () => {
    // The actual gate, over this tree's own WHOLE ledger and its suspect archive (nothing ages out of a
    // window: design NH-E), through the one judgement both suites' guards call
    // (engine/src/workflow/flaky-burn-down.ts `judgeFlakyMemory`). A missing
    // ledger is an empty history — it can delay a red, never manufacture one.
    // The freshness arm's pre-mint rows consult the report's own recorded
    // regeneration the same way: a row the current report postdates is the
    // known pre-mint state (explained + said), and a failure at or after it
    // reds as the recurrence it is. The web suite has no live suite.
    // A file the manifest EXCLUDES from the supported population is not a
    // flake suspect: it was never part of the run being judged. Its failure
    // is explained by the exclusion (a declared refusal, with a reason), not
    // by a re-run — and the population owner is the manifest, read once.
    const excluded = excludedTestFiles();
    const entries = readRunFailureRows(BUDGET_HISTORY_PATH).map((entry) => ({
      ...entry,
      failures: entry.failures.filter((identity) => !excluded.has(identity.split("::")[0] ?? identity)),
    }));
    if (excluded.size > 0) {
      console.info(`flaky-test memory: ${String(excluded.size)} file(s) excluded from the supported population are not judged here (the gate catalogue's population exclusions, engine/src/workflow/gates/catalogue.ts)`);
    }
    const judgement = await judgeFlakyMemory({
      suite: "web", engineRoot: join(process.cwd(), "engine"), entries, ownPrefix: OWN_PREFIX, guardFile: GUARD_FILE,
      regenerated: reportRegeneration(entries.flatMap((entry) => entry.failures)), suites: null,
    });
    for (const line of judgement.lines) console.info(line);
    expect(judgement.failure, judgement.failure ?? "").toBeNull();
  });
});
