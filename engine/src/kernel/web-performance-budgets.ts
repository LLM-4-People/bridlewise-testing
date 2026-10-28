/**
 * THE WEB-UI PERFORMANCE BUDGETS, ONE LIST (a module of its own: the root
 * policy's literal holds only imports before it, so its static reading stays
 * whole — S1's freeze boundary): each budget's name in the config
 * section `webUi.performance` with the kind of number it is. The config
 * schema, the server's accessor and the ledger judge's budget registry are
 * all read from it (UR-24: one budget judgement — a perf budget is judged
 * like the CPU budget, owned and not worse than the target's value).
 */
export const WEB_PERFORMANCE_BUDGET_KINDS = {
  lcpMaxMs: "positive",
  clsMax: "non-negative",
  longTaskWorstMaxMs: "positive",
  longTaskTotalMaxMs: "positive",
  tabSwitchMaxMs: "positive",
  tabDomNodesMax: "positive-int",
  typingMeanMaxMs: "positive",
  apiResponseMaxMs: "positive",
  longSessionHeapGrowthMaxMb: "positive",
  longSessionDomGrowthMax: "positive-int",
  longChatRenderMaxMs: "positive",
  manyProjectsRenderMaxMs: "positive",
  viewportLcpMaxMs: "positive",
} as const;

/**
 * THE BUDGETS THAT ARE WALL TIME, recorded as SIGNALS and never judged
 * (NO-LOAD-BLOCK, audit A-06/B-02; the coordinator's ruling 2 on #355): a
 * millisecond reading of a page load, a long task, a switch, a keystroke, a
 * response or a render says how busy the host was as much as how heavy the
 * code is. Each is measured, recorded in the run's row, trended and shown;
 * none fails a run, measured or not (a probe that timed out on a busy host
 * is load too), until the browser gates are judged in CPU work.
 * The rest (layout shift, DOM nodes, heap and DOM growth) are not time and
 * stay judged.
 */
export const WEB_PERFORMANCE_WALL_SIGNALS: ReadonlySet<keyof typeof WEB_PERFORMANCE_BUDGET_KINDS> = new Set([
  "lcpMaxMs", "longTaskWorstMaxMs", "longTaskTotalMaxMs", "tabSwitchMaxMs", "typingMeanMaxMs",
  "apiResponseMaxMs", "longChatRenderMaxMs", "manyProjectsRenderMaxMs", "viewportLcpMaxMs",
]);

/** Where a web ledger row keeps the profile's measurements, and the gate name a perf budget's judgement carries. */
export const WEB_PERFORMANCE_LEDGER_FIELD = "performanceMeasurements";
export const WEB_PERFORMANCE_GATE_PREFIX = "performance:";
