/**
 * WHAT THE PROFILE MEASURED, PER PERFORMANCE BUDGET — the one reading of the
 * profile report against `webUi.performance` (the root policy's one list,
 * `webPerformanceBudgets.kinds`).
 *
 * The regression gate's arms judge the report's INTEGRITY (present, measured
 * in the host's lock, fresh, every probe measured its subject); a budget is
 * judged once, by the one budget judgement (UR-16, UR-24): the web suite's
 * reporter records each measurement in the run's ledger row and fails a
 * breach, and the workspace's ledger judge passes a breach only when an open
 * task row owns its budget and the value is no worse than the target's
 * lowest slotted value (engine/src/workflow/workspace-manager.ts). A budget
 * several arms share takes the worst of their values (the API budget: the
 * slowest in-session response and every isolated route). A value the report
 * did not measure is `null` — never a number a budget could pass.
 */
import { existsSync, readFileSync } from "node:fs";

import type { ProfileReport } from "../../tests/performance/lib/perf-harness.ts";
import { ROOT_POLICY } from "../../engine/src/kernel/root-policy.ts";
import { finiteNumber, type GateOutcome } from "../../engine/src/shared/budget-verdict.ts";
import { readMeasuredSurfaceHash } from "../../engine/src/shared/tree-identity.ts";
import type { PerformanceBudgetConfig } from "../../shared/wire-types.ts";

/** A performance budget's name (`webUi.performance.<name>`). */
export type PerformanceBudgetName = keyof typeof ROOT_POLICY.workflow.webPerformanceBudgets.kinds;

/** Each budget's measured value, or null when the report did not measure it. */
export type PerformanceMeasurements = Readonly<Record<PerformanceBudgetName, number | null>>;

/** The worst (largest) of values that must ALL be measured: one unmeasured member leaves the budget unmeasured, an empty population too. */
function worst(values: readonly unknown[]): number | null {
  if (values.length === 0) return null;
  const numbers = values.map(finiteNumber);
  return numbers.some((value) => value === null) ? null : Math.max(...(numbers as number[]));
}

/** The measurement of every performance budget in `report` (see the header). */
export function performanceMeasurements(report: ProfileReport): PerformanceMeasurements {
  const typing = report.interactions?.find((interaction) => interaction.name === "chat-input-typing");
  const longChat = report.realData?.longChat;
  const manyProjects = report.realData?.manyProjects;
  const okTabs = (report.tabs ?? []).every((tab) => tab.ok);
  const timedRoutes = (report.routeProfiles ?? []).filter((route) => route.ok && Number.isFinite(route.responseMs));
  return Object.freeze({
    lcpMaxMs: finiteNumber(report.pageLoad?.lcp),
    clsMax: finiteNumber(report.pageLoad?.cls),
    // The worst single task anywhere the profile watched: the page load, every clicked element, every scroll census.
    longTaskWorstMaxMs: worst([
      report.pageLoad?.longTaskWorstMs,
      ...(report.interactiveElements ?? []).map((element) => element.ok ? element.longTaskWorstMs : null),
      ...(report.interactions ?? []).filter((interaction) => interaction.kind === "scroll-long-task").map((row) => row.ok ? (row as { longTaskWorstMs?: unknown }).longTaskWorstMs : null),
      longChat?.ok === true && longChat.scroll.ok ? longChat.scroll.longTaskWorstMs : null,
    ]),
    longTaskTotalMaxMs: finiteNumber(report.pageLoad?.longTaskTotalMs),
    // A tab switch and an element click are judged against the one interaction budget.
    tabSwitchMaxMs: okTabs ? worst([...(report.tabs ?? []).map((tab) => tab.switchMs), ...(report.interactiveElements ?? []).map((element) => element.ok ? element.clickMs : null)]) : null,
    tabDomNodesMax: okTabs ? worst((report.tabs ?? []).map((tab) => tab.domNodes)) : null,
    typingMeanMaxMs: typing !== undefined && typing.ok ? finiteNumber((typing as { durationMs?: unknown }).durationMs) : null,
    apiResponseMaxMs: (report.networkSummary?.totalCalls ?? 0) > 0 && timedRoutes.length > 0 && report.routeSummary?.slowest
      ? worst([report.networkSummary.maxResponseMs, ...timedRoutes.map((route) => route.responseMs), report.routeSummary.slowest.responseMs])
      : null,
    longSessionHeapGrowthMaxMb: finiteNumber(report.longSession?.heapGrowthMb),
    longSessionDomGrowthMax: finiteNumber(report.longSession?.domNodeGrowth),
    longChatRenderMaxMs: longChat !== undefined && longChat.ok && longChat.renderMs > 0 ? finiteNumber(longChat.renderMs) : null,
    manyProjectsRenderMaxMs: manyProjects !== undefined && manyProjects.ok && manyProjects.renderMs > 0 ? finiteNumber(manyProjects.renderMs) : null,
    viewportLcpMaxMs: worst((report.viewports ?? []).map((viewport) => viewport.lcp)),
  });
}

/** The gate a budget's judgement carries in a run's qualification (`performance:<name>`), the ledger judge's registry key. */
export function performanceGate(name: PerformanceBudgetName): string {
  return `${ROOT_POLICY.workflow.webPerformanceBudgets.gatePrefix}${name}`;
}

/** The profile report at `path`, or null when it is absent or not JSON (the one reader: the gate and the reporter both read through it). */
export function readProfileReport(path: string): ProfileReport | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  try {
    return JSON.parse(raw) as ProfileReport;
  } catch {
    return null;
  }
}

/** What the one budget judgement reads from a run: each budget's outcome, and the measurements its ledger row records (absent: nothing was judged). */
export type PerformanceJudgement = Readonly<{ outcomes: readonly GateOutcome[]; measurements?: PerformanceMeasurements }>;

/**
 * THE RUN'S PERFORMANCE BUDGETS, judged like its CPU budget: the profile
 * report at `reportPath`, read only when it can be judged — present, measured
 * inside the host's lock, of the code in `repositoryRoot` (its measured
 * surface's hash) — each budget's measurement against `budget`: a breach or
 * an unmeasured value fails its gate (`performance:<name>`), which the
 * workspace's ledger judge then passes only as owned and not worse. A report
 * that cannot be judged FAILS the run (`performance-report`), by name: an
 * unmeasured budget is never a pass (design M-A).
 */
/**
 * THE ONE PREDICATE of a profile report that can be judged (design M-A: the
 * budget judge and every reader of the report ask it, never a copy): present,
 * measured inside the host's lock, of the code in `repositoryRoot` (its
 * measured surface's hash); else why not.
 */
export function judgeableProfileReport(repositoryRoot: string, reportPath: string): Readonly<{ report: ProfileReport } | { why: string }> {
  const report = readProfileReport(reportPath);
  if (report === null) return { why: `no profile report at ${reportPath} (\`npm run perf:profile\` makes it)` };
  if ((report as { instrumentLock?: unknown }).instrumentLock !== "held") return { why: "the profile report was measured outside the host's instrument lock" };
  if (report.treeIdentity?.measuredSurfaceHash === undefined || report.treeIdentity.measuredSurfaceHash !== readMeasuredSurfaceHash(repositoryRoot)) return { why: "the profile report describes other code (its measured surface's hash differs)" };
  return { report };
}

export function judgePerformanceBudgets(repositoryRoot: string, reportPath: string, budget: PerformanceBudgetConfig): PerformanceJudgement {
  const judgeable = judgeableProfileReport(repositoryRoot, reportPath);
  const why = "why" in judgeable ? judgeable.why : null;
  const report = "report" in judgeable ? judgeable.report : null;
  if (why !== null || report === null) return Object.freeze({ outcomes: Object.freeze<GateOutcome[]>([{ gate: "performance-report", kind: "fail", message: `unjudgeable, so it fails (an unmeasured budget is never a pass): ${why ?? ""}` }]) });
  const measurements = performanceMeasurements(report);
  const outcomes = (Object.keys(measurements) as PerformanceBudgetName[]).map((name): GateOutcome => {
    const value = measurements[name];
    const limit = budget[name];
    return value === null ? { gate: performanceGate(name), kind: "fail", message: `webUi.performance.${name}: the profile did not measure it` }
      : value > limit ? { gate: performanceGate(name), kind: "fail", message: `webUi.performance.${name}: ${String(value)} exceeds the budget ${String(limit)}` }
        : { gate: performanceGate(name), kind: "pass", message: `webUi.performance.${name}: ${String(value)} within ${String(limit)}` };
  });
  return Object.freeze({ outcomes: Object.freeze(outcomes), measurements });
}
