/**
 * WHAT ONE TEST MODULE COST A WORKER — the single owner of the per-file
 * collect and occupancy figures the suite's run-cost gates judge.
 *
 * ── WHY THIS LEFT THE REPORTER ───────────────────────────────────────────
 *
 * The web budget reporter used to hold the only implementation:
 *
 *   - `finiteAt(diagnostic, "collectDuration")` read vitest's own
 *     "time to import the module, including suite callbacks";
 *   - `totalMsOf(diagnostic)` summed `OCCUPANCY_FIELDS` into the per-file
 *     occupancy;
 *   - two `reduce` calls turned those lists into the run's denominators.
 *
 * That was the right MEASUREMENT in the wrong place: a reporter is a
 * consumer of the run's facts, and the contract wants the quantity computed
 * once at the lowest chokepoint that can see the raw diagnostics. Moving the
 * pure reduction here gives the registry one producer per quantity
 * (`suite.perFile.collectMs`, `suite.perFile.occupancyMs`, and the two run
 * totals), lets the reporter stay a writer, and makes the duplicate scan
 * meaningful: a second module that sums `collectDuration` is now a defect
 * rather than a convention.
 *
 * ── ABSENT, NEVER ZERO ───────────────────────────────────────────────────
 *
 * A module with no readable diagnostic contributes NOTHING to the population;
 * it is not a zero-cost file. If no module measured a field, the matching
 * total is `null` (the verdict treats that as unmeasurable), never a
 * zero that would make a share denominator look real. A measured zero is
 * still a real answer: a file that imported in 0 ms with a live diagnostic
 * is recorded as 0, and that is distinct from the absent case.
 *
 * ── SHARES, NOT STOPWATCHES ──────────────────────────────────────────────
 *
 * Both per-file figures are wall-clock derived: contention inflates every
 * file together. The gates consume them as SHARES (`worst / wall clock` and
 * `worst / total occupancy`), which is what makes the reading load-agnostic;
 * the registry's load declaration points at those denominators.
 */

import { finiteNumber, type CollectCost } from "./budget-verdict.ts";

export type { CollectCost } from "./budget-verdict.ts";

/** Everything a file occupied a worker for, from vitest's module diagnostics. */
const OCCUPANCY_FIELDS = [
  "collectDuration",
  "setupDuration",
  "environmentSetupDuration",
  "prepareDuration",
  "duration",
] as const;

/** The reporter's input: a file name plus the module's diagnostic accessor. */
export interface ModuleCostSource {
  readonly file: string;
  readonly diagnostic: () => Readonly<Record<string, unknown>> | null;
}

/**
 * Call a module's diagnostic accessor, or answer null when vitest did not
 * expose one / it threw. A diagnostic that cannot be read is ABSENT, not a
 * module that cost nothing.
 */
export function readModuleDiagnostic(module: unknown): Readonly<Record<string, unknown>> | null {
  const diagnostic = (module as { diagnostic?: unknown } | null | undefined)?.diagnostic;
  if (typeof diagnostic !== "function") return null;
  try {
    const value = (diagnostic as () => unknown).call(module);
    return value !== null && typeof value === "object" ? value as Readonly<Record<string, unknown>> : null;
  } catch {
    return null;
  }
}

/**
 * One numeric field of a diagnostic, or null when it is absent / not finite —
 * the absence rule is the verdict's own `finiteNumber`, not a respelling.
 */
export function finiteDiagnosticMs(
  diagnostic: Readonly<Record<string, unknown>> | null,
  field: string,
): number | null {
  return finiteNumber(diagnostic?.[field]);
}

/**
 * Everything the file cost a worker, or null when vitest reported none of
 * the occupancy fields. The field list is named once above; a field silently
 * dropped from the sum would lower every file's measured cost and quietly
 * vacate the per-file share gate.
 */
export function totalModuleOccupancyMs(
  diagnostic: Readonly<Record<string, unknown>> | null,
): number | null {
  let total = 0;
  let any = false;
  for (const field of OCCUPANCY_FIELDS) {
    const ms = finiteDiagnosticMs(diagnostic, field);
    if (ms === null) continue;
    any = true;
    total += ms;
  }
  return any ? total : null;
}

/** The per-run cost summary the reporter writes and the verdict reads. */
export interface TestCostSummary {
  readonly slowestCollects: readonly CollectCost[];
  readonly slowestFiles: readonly CollectCost[];
  /** Sum of the measured collect figures, or null when none was measured. */
  readonly totalCollectMs: number | null;
  /** Sum of the measured per-file occupancies, or null when none was measured. */
  readonly totalOccupancyMs: number | null;
  /** Every module the run reported, measured or not. */
  readonly testModuleCount: number;
}

/** How many of the worst offenders each list keeps. */
export interface TestCostLimits {
  readonly slowestCollects: number;
  readonly slowestFiles: number;
}

/**
 * Reduce every module's diagnostic to the run's cost summary.
 *
 * The two totals and the two sorted lists are derived in ONE pass over the
 * same population, so they cannot disagree about which files were measured.
 */
export function summarizeTestCosts(
  sources: readonly ModuleCostSource[],
  limits: TestCostLimits,
): TestCostSummary {
  const collects: CollectCost[] = [];
  const totals: CollectCost[] = [];
  for (const source of sources) {
    const diagnostic = source.diagnostic();
    const collectMs = finiteDiagnosticMs(diagnostic, "collectDuration");
    if (collectMs !== null) collects.push({ file: source.file, ms: Math.round(collectMs) });
    const totalMs = totalModuleOccupancyMs(diagnostic);
    if (totalMs !== null) totals.push({ file: source.file, ms: Math.round(totalMs) });
  }
  const totalCollectMs = collects.length === 0 ? null : Math.round(collects.reduce((sum, row) => sum + row.ms, 0));
  const totalOccupancyMs = totals.length === 0 ? null : Math.round(totals.reduce((sum, row) => sum + row.ms, 0));
  collects.sort((a, b) => b.ms - a.ms);
  totals.sort((a, b) => b.ms - a.ms);
  return {
    slowestCollects: collects.slice(0, limits.slowestCollects),
    slowestFiles: totals.slice(0, limits.slowestFiles),
    totalCollectMs,
    totalOccupancyMs,
    testModuleCount: sources.length,
  };
}
