/**
 * THE METRIC REGISTRY — the single declaration of every signal the floor
 * judges, records or quotes.
 *
 * ── WHY THIS IS A MODULE AND NOT A PARAGRAPH ─────────────────────────────
 *
 * The measurement contract has four clauses, and each one used to live in
 * prose scattered beside the code it governed:
 *
 *   DYNAMIC        computed from the run's own facts, never a per-machine
 *                  constant table;
 *   RESILIENT      absent, never zero, when unreadable — and never silently
 *                  swapped for a different quantity;
 *   LOAD-AGNOSTIC  or an explicitly declared sensitivity with the bound past
 *                  which the verdict defers;
 *   SINGLE-OWNER   computed once at the lowest chokepoint that sees the raw
 *                  facts, exposed through the shared layers, and read by
 *                  every consumer from there.
 *
 * Prose cannot refuse a new derivation. This module gives the guard
 * (`engine/scripts/verification/measurement-contract.ts`) ONE list to read:
 * every entry names its producer (module + exported function), its consumers
 * (gate, receipt/record, evidence/doc), its unit, its absent semantics, its
 * zero semantics, and its load behaviour. The guard checks the declarations
 * against the tree, scans the declared derivative universe for a second
 * computation of the same quantity, and refuses a gate or budget name that
 * no entry maps.
 *
 * ── WHAT THIS FILE IS NOT ────────────────────────────────────────────────
 *
 * It is not a reporter, and it is not a second store of the values. The
 * producer stays where the raw facts are; consumers keep reading it. This is
 * the DECLARATION layer the contract names, placed in `engine/src/shared/`
 * beside the shared signals/settings/judgement modules it describes.
 *
 * ── THE CPU PLACEHOLDER IS DELIBERATE ────────────────────────────────────
 *
 * Another change owns the CPU metric in `run-cpu.ts` and `budget-verdict.ts`.
 * Editing either file here would collide with it and guess a shape that is
 * still moving. The placeholder below reserves ONLY what is already stable —
 * the producer, its absence rule and the gate consumer — and says, in the
 * registry, that the final fields and load declaration are owned by that
 * change. `CPU_METRIC_PLACEHOLDERS` is a separate list so the guard can tell
 * a finished entry from a reserved one, and can refuse a placeholder that
 * silently disappears.
 *
 * ── FINDINGS ARE PART OF THE DECLARATION ─────────────────────────────────
 *
 * A signal that is genuinely load-sensitive today and has no deferral bound
 * is recorded as a FINDING (`MEASUREMENT_FINDINGS`) and named by the entry's
 * load declaration. The guard allows a sensitive entry with no numeric bound
 * only when it cites a registered finding; it never lets an "agnostic" claim
 * through without a normalisation step. That is the difference between
 * recording a known weakness and softening it into prose.
 */

/** A declared consumer of a registered measurement. */
export type MetricConsumer =
  | {
    /** A verdict arm that refuses or admits a reading. */
    readonly kind: "gate";
    readonly id: string;
    /** Repository-relative source that must name the gate. */
    readonly source: string;
  }
  | {
    /** A written record: ledger row, summary, receipt or report field. */
    readonly kind: "record";
    readonly id: string;
    readonly source: string;
  }
  | {
    /** A budget key in the root policy / configuration. */
    readonly kind: "budget";
    readonly id: string;
  }
  | {
    /** A document that quotes the signal. */
    readonly kind: "doc";
    readonly id: string;
    readonly source: string;
    readonly anchor: string;
  };

/** How a producer represents a value it could not measure. */
export type AbsentSemantics =
  | { readonly kind: "null"; readonly reason: string }
  | { readonly kind: "sentinel"; readonly value: string; readonly reason: string }
  | { readonly kind: "refusal"; readonly reason: string; readonly refusal: string };

/** What a measured zero means. */
export type ZeroSemantics =
  | { readonly kind: "not-numeric"; readonly reason: string }
  | { readonly kind: "honest"; readonly witness: string; readonly reason: string }
  | { readonly kind: "floor"; readonly value: number; readonly reason: string }
  | { readonly kind: "unreachable"; readonly reason: string };

/** The entry's declared relationship to host load. */
export type LoadBehaviour =
  | {
    readonly kind: "agnostic";
    /** The step that removes host load from the answer (a share, a content
     *  hash, a structural count), stated in words. */
    readonly normalization: string;
    /** A source token that proves the normalisation exists in the producer
     *  or a consumer; the guard refuses a claim with no such step. */
    readonly proof: string;
  }
  | {
    readonly kind: "sensitive";
    readonly sensitivity: string;
    /** The bound past which the verdict defers, or null when no such bound
     *  exists and the entry records that as a finding. */
    readonly bound: { readonly value: number; readonly unit: string; readonly defersAt: string } | null;
    /** Required when `bound` is null: the finding that records the gap. */
    readonly finding: string | null;
  }
  | {
    /** A reserved entry whose final load model is owned by an in-flight
     *  change. Never valid for a finished entry. */
    readonly kind: "placeholder";
    readonly note: string;
  };

/** One registered signal. */
export interface MetricEntry {
  /** A stable, namespaced identifier (`suite.perFile.collectMs`). */
  readonly name: string;
  /** One unit, in words the reader can check (`milliseconds`, `sha256`). */
  readonly unit: string;
  /**
   * Entries in the same family measure closely related quantities (e.g. two
   * per-file wall durations). Each must name how it differs from its
   * siblings, so a new family member cannot hide a duplicate derivation.
   */
  readonly family: string | null;
  readonly distinctFrom: readonly { readonly name: string; readonly reason: string }[];
  readonly producer: {
    /** Repository-relative module. */
    readonly module: string;
    /** The exported function that computes the quantity. */
    readonly symbol: string;
    /**
     * Regex sources that pin the COMPUTATION itself (not just the name of
     * the function). At least one MUST match the producer's body; a value
     * that only reads the raw fact (`loadavg()`) is not proof of
     * computation and belongs in {@link reads}.
     */
    readonly compute: readonly string[];
    /**
     * Regex sources for a direct READ of the raw fact. Duplicate-scan only:
     * reading `loadavg()` outside the producer is a second sample of the
     * same fact, but a bare read is not the declared computation, so it can
     * never satisfy the body clause on its own.
     */
    readonly reads: readonly string[];
    /**
     * Tokens that would prove the producer substituted a different quantity
     * (a wall clock for CPU, a duration for load). The guard refuses them.
     */
    readonly forbids: readonly string[];
  };
  readonly consumers: readonly MetricConsumer[];
  readonly load: LoadBehaviour;
  readonly absent: AbsentSemantics;
  readonly zero: ZeroSemantics;
  /** Free-form note for the reader; not a substitute for a declaration. */
  readonly note?: string;
  /** `placeholder` entries reserve a producer while another change owns it. */
  readonly status?: "registered" | "placeholder";
}

/** A weakness the registry records rather than hides. */
export interface MeasurementFinding {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
}

export const MEASUREMENT_FINDINGS: readonly MeasurementFinding[] = Object.freeze([
  {
    id: "F-PERF-LATENCY-NO-BOUND",
    title: "Web performance latencies are judged absolutely with no ambient bound",
    detail:
      "The profile's latency budgets (LCP, long tasks, tab switch, typing, API response, " +
      "long-chat render, 10k-projects render, viewport LCP) are wall-clock durations judged " +
      "against absolute budgets from a slotted profile. The instrument lock and the idle-host " +
      "contract are preconditions, but no numeric ambient-load bound exists past which the " +
      "verdict defers: a busy but slotted host still yields a judged reading. Recorded as an " +
      "open finding; the registry does not claim these entries are load-agnostic.",
  },
  {
    id: "F-PERF-CLS-NO-BOUND",
    title: "CLS is unitless but timing-sensitive, with no ambient bound",
    detail:
      "CLS is a unitless score, but its measured band moved with the host (0.087–0.1096 in the " +
      "recorded ambient runs) and the budget sits at 0.12 above that band. There is no " +
      "declared load bound or normalisation step, so the entry is sensitive, not agnostic.",
  },
  {
    id: "F-PERF-MEMORY-NO-BOUND",
    title: "Long-session heap growth is sensitive to GC timing and has no ambient bound",
    detail:
      "Heap growth is a byte quantity, but when it is sampled and how much the collector " +
      "reclaims is timing-sensitive. The profile measures under the instrument lock; no " +
      "ambient-load bound or normalisation exists beyond that precondition.",
  },
  {
    id: "F-SHARD-WEIGHT-WALL-CLOCK",
    title: "Shard weights are wall-clock durations with no load bound",
    detail:
      "Per-file shard weights are vitest JSON `endTime - startTime`: wall-clock durations that " +
      "inflate with host contention and cold caches. They are accepted only from a complete " +
      "green shard report set and are used to BALANCE shards, not to pass or fail a code " +
      "change; no ambient bound exists. Recorded so a reader does not mistake the balance for " +
      "a measurement of the tree.",
  },
  {
    id: "F-TOTAL-COLLECT-WALL-CLOCK",
    title: "The total collect time is a sum of wall-clock durations",
    detail:
      "`totalCollectMs` is the sum of every measured `collectDuration`. It inflates with " +
      "contention and, harder, with a cold transform cache. The worst-collect gate uses a " +
      "SHARE of wall clock, not this total; the total is recorded for diagnosis. It is " +
      "load-sensitive and has no deferral bound of its own.",
  },
  {
    id: "F-CI-DURATION-WALL-CLOCK",
    title: "CI shard durations are wall-clock and `testPhaseCpuMs` is not CPU time",
    detail:
      "The shard receipt's `testPhaseMs` is the critical path across shard start/finish times " +
      "and `testPhaseCpuMs` is the sum of each shard's `durationMs` — wall-clock durations, " +
      "despite the CPU in the name. They are comparable only within a declared runner class " +
      "and carry no ambient-load bound. Recorded as a finding; the field name is not softened.",
  },
  {
    id: "F-AMBIENT-NO-DEFERRAL",
    title: "Ambient load is a covariate with a capped adjustment, not a deferral bound",
    detail:
      "The verdict reads the run-start 5-minute load per CPU and applies the declared " +
      "ambient-inflation envelope (slope per CPU, capped fraction). It does not defer a run " +
      "for being busy: the old quiet-ambient deferral was removed deliberately because it " +
      "demanded a quiet box this machine does not have. The 1-minute leg is a decaying ghost " +
      "and is recorded, not used to normalise. This entry therefore has no bound past which a " +
      "verdict defers; the finding records that design.",
  },
  {
    id: "F-TOKEN-THROUGHPUT-NO-BOUND",
    title: "Token throughput is measured over wall time with no ambient bound",
    detail:
      "Tokens per second divides the recorder's token accumulator by the server's elapsed wall " +
      "clock. Host load, a stalled stream or a slow client lengthens that interval and lowers " +
      "the rate, and no numeric ambient-load bound exists past which the exposure signal, the " +
      "history point or the metrics route defers. Recorded as an open finding; the registry " +
      "does not claim the figure is load-agnostic.",
  },
]);

/**
 * Every gate that exists in a measurement-producing source but does NOT
 * judge a registered quantity. The guard refuses a gate literal in these
 * files unless it is registered or explained here, and refuses an explanation
 * whose gate no longer appears (a stale exemption hides the next new gate).
 */
export const NON_MEASUREMENT_GATES: Readonly<Record<string, string>> = Object.freeze({
  "command-completion": "the command runner's terminal completion, not a measured quantity",
  "current-qualification": "identity and completeness of the current invocation, not a number",
  "engine-execution": "the engine run's independent execution outcome, not a measured quantity",
  "engine-summary": "the engine receipt's publication completeness, not a measurement",
  "engine-test-results": "the engine receipt's test census completeness, not a measurement",
  "engine-${reason}": "the engine receipt's reason-coded publication outcomes; each reason names a withheld or incomplete receipt, not a measurement",
  "harness-folder": "a before/after identity comparison of the harness folder",
  "module-census": "the population of terminal test modules, not a cost or duration",
  "module-errors": "presence of modules with errors, not a measured value",
  "qualification-scope": "what a shard was allowed to cover, not a measurement",
  "runner-terminal": "the process terminal state, not a measurement",
  "suite-errors": "presence of unhandled errors, not a quantity",
  "test-results": "pass/fail counts are outcomes, not a performance signal",
  "unhandled-errors": "presence of unhandled errors, not a quantity",
  "web-summary": "the web receipt's publication completeness, not a measurement",
});

/**
 * Exported functions the producer-universe scan reads as measurement-shaped
 * but that compute no judged, recorded or quoted signal.
 *
 * THE SAME PATTERN AS {@link NON_MEASUREMENT_GATES}, and for the same reason:
 * the alternative is a prefix allowlist, which is how four registered
 * producers sat outside the scan while its failure text claimed "no opt-out
 * list". A declaration here is a sentence a reader can argue with, and the
 * guard refuses an entry whose function the scan no longer finds (a stale
 * exemption hides the next new producer). Each key is `module::symbol`.
 */
export const NON_MEASUREMENT_PRODUCERS: Readonly<Record<string, string>> = Object.freeze({
  "engine/scripts/tooling/compile-cache.ts::pruneCacheDirectory": "prunes the V8 compile cache and reports how many entries it removed; a maintenance count, not a judged signal",
  "engine/scripts/tooling/compile-cache.ts::scanCacheDirectory": "counts cache entries so the prune can bound itself; a maintenance count, not a measurement",
  "engine/scripts/tooling/test-run-lock.ts::testFileCountOfArgs": "parses the runner's argument vector into a test-file count; an input parse, not a measurement",
  "engine/src/kernel/integrity.ts::sha256": "a content identity hash; not a duration, load or cost the floor judges",
  "engine/src/kernel/integrity.ts::sha256Bytes": "a content identity hash over a buffer; identity, not a measurement",
  "engine/src/kernel/integrity.ts::gitBlobId": "git's blob identity for content; an object id, not a measurement",
  "engine/src/workflow/test-result-collector.ts::loadPriorTestFileDurations": "reads the engine suite's scheduling cache written by another runner; this floor neither judges nor records it",
  "engine/src/workflow/test-result-collector.ts::writeTestFileDurations": "writes the engine suite's scheduling cache; a scheduling input, not a recorded signal",
  "engine/src/shared/flake-reproduction.ts::readFlakeReproductions": "reads recorded flake reproductions; the file contents are evidence, not a quantity this module computes",
  "engine/src/process/supervised-run.ts::readSupervisorReceipt": "reads the supervisor's terminal receipt; a terminal outcome, not a quantity",
  "tests/performance/lib/perf-harness.ts::seedChatMessagesViaDb": "seeds the performance fixture's chat rows; fixture setup, not a measurement",
  "engine/src/workflow/hash-binding-registry.ts::computeBindingHash": "content hash of a binding fixture; identity, not a measured quantity",
  "engine/src/workflow/hash-binding-registry.ts::fixtureDigestBindings": "digests the fixture bindings for the guard's own comparison; identity, not a measurement",
  "engine/src/workflow/hash-binding-registry.ts::repairBinding": "repairs a stored binding fixture; no measurement",
  "src/state/chat-messages.ts::toolCallDurationMs": "the UI's tool-call elapsed time for display; not judged, recorded or quoted by the floor",
  "src/state/chat-messages.ts::healStrandedToolCallsFromLedger": "repairs chat state from the ledger using wall-clock stamps; a state repair, not a recorded measurement",
  "src/state/chat-messages.ts::settleHydratedRunningToolCalls": "settles hydrated running tool calls; a state repair, not a measurement",
  "engine/src/process/process-facts.ts::startWallTimeMsOf": "reads a process start stamp for the instrument lock's identity; identity, not a duration",
  "engine/src/process/process-facts.ts::processIdentity": "assembles the process's identity for the instrument lock; identity, not a measurement",
  "engine/src/process/process-facts.ts::processGroupMembers": "samples a process group's members (identity, parent, CPU) for the work-bounded supervisor's stop decision on ONE tool run (supervised-run.ts runCpuBounded); never recorded, quoted or compared across runs by the floor",
  "server/observability/metrics-recorder.ts::recordLlmCall": "records one LLM call into the metrics collector; a recording hook, not a computed quantity",
  "server/observability/metrics-recorder.ts::recordToolCall": "records one tool call into the metrics collector; a recording hook, not a computed quantity",
});

/**
 * Modules that import or call a registered producer symbol but consume NO
 * declared quantity from it. They are named, with a reason, because the
 * consumer clause is TOTAL: every module the import universe shows touching
 * a producer is either in that entry's `consumers` or here. Silence is not
 * an exemption.
 *
 * THE SAME PATTERN AS {@link NON_MEASUREMENT_PRODUCERS}: the guard refuses an
 * entry whose module no longer touches its producer (a stale exemption hides
 * the next new consumer). Each key is `module::symbol`.
 */
export const NON_MEASUREMENT_CONSUMERS: Readonly<Record<string, string>> = Object.freeze({
  "tests/prevention/measurement-contract.test.ts::readAmbientLoadPerCpu": "drives the producer's unreadable-sample branches in unit arms; it records no ambient quantity and is a test of the producer, not a consumer of a measured value",
  "engine/scripts/tooling/test-run-lock.ts::instrumentLockStamp": "borrows the stamp for the runner's own lock decision and re-exposes it; it records no instrument-lock measurement",
  "engine/test/process/instrument-lock.test.ts::instrumentLockStamp": "drives the stamp's held/unslotted branches; the test asserts the producer, it records no measurement",
  "tests/prevention/flaky-test-memory.test.ts::readMeasuredSurfaceHash": "builds a synthetic profile report with the measured surface's hash; the test plants identity, it records no measurement",
  "tests/prevention/tree-identity-owner.test.ts::readMeasuredSurfaceHash": "asserts the hash owner is single and changes with the surface; the test drives the producer, it records no measurement",
  "tests/prevention/web-ui-runtime-budget-verdict.test.ts::readMeasuredSurfaceHash": "feeds a synthetic tree identity into the budget-verdict arms; the test plants identity, it records no measurement",
  "tests/prevention/web-ui-runtime-budget-verdict.test.ts::performanceMeasurements": "drives the measurement reader with planted reports to prove absence/finiteness arms; it records no web budget reading",
  "tests/prevention/performance-exposure-wired.test.ts::getTokenThroughput": "drives the throughput reading's null/non-null exposure arms; the test asserts the producer, it records no rate",
  "tests/public/test-shard-manifest.test.mjs::mergeShardReports": "builds shard receipts in temp trees to drive the merge guard; the test consumes no CI duration it records as evidence",
  "tests/public/test-shard-merge.test.mjs::mergeShardReports": "builds shard receipts in temp trees to drive the merge guard; the test consumes no CI duration it records as evidence",
});

/** The one document that owns the registry's reader-facing contract. */
export const MEASUREMENT_DOC_SOURCE = "docs/testing.md";
/** The phrase the document must carry, so the declaration is discoverable. */
export const MEASUREMENT_DOC_ANCHOR = "The measurement registry";

/** The measured-surface content hash the profile report is stamped with. */
const MEASURED_SURFACE: MetricEntry = {
  status: "registered",
  name: "perf.profile.measuredSurfaceHash",
  unit: "sha256 over the served/executed source surface",
  family: "profile.identity",
  distinctFrom: [],
  producer: {
    module: "engine/src/shared/tree-identity.ts",
    symbol: "readMeasuredSurfaceHash",
    compute: ["sha256\\(entries\\.join\\("],
    reads: [],
    forbids: ["Date.now", "loadavg(", "performance.now(", "cpuUsage("],
  },
  consumers: [
    {
      kind: "gate",
      id: "the report describes the current code (the measured surface's content hash matches the repository's)",
      source: "tests/performance/regression.test.ts",
    },
    { kind: "gate", id: "performance-report", source: "scripts/testing/performance-measurements.ts" },
    {
      kind: "record",
      id: "measuredSurfaceHash",
      source: "tests/performance/profile.spec.ts",
    },
    {
      kind: "doc",
      id: "measured-surface hash",
      source: MEASUREMENT_DOC_SOURCE,
      anchor: "measured-surface hash",
    },
  ],
  load: {
    kind: "agnostic",
    normalization: "content-addressed sha256 over the served source bytes; suite-regenerated pins are normalised away, and neither the clock nor the host's load contributes a byte",
    proof: "sha256(entries.join",
  },
  absent: {
    kind: "null",
    reason: "an unreadable surface or an empty population returns null; the profile writer refuses a null hash and the freshness gate refuses a report without one",
  },
  zero: { kind: "not-numeric", reason: "a hash is not a numeric measurement" },
};

/** Whether the profile ran inside the host's one instrument lock. */
const INSTRUMENT_LOCK: MetricEntry = {
  status: "registered",
  name: "perf.profile.instrumentLock",
  unit: "lock stamp (held | unslotted)",
  family: "profile.identity",
  distinctFrom: [],
  producer: {
    module: "engine/src/process/instrument-lock.ts",
    symbol: "instrumentLockStamp",
    compute: ["holder\\.pid === process\\.pid"],
    reads: [],
    forbids: ["Date.now", "performance.now(", "loadavg("],
  },
  consumers: [
    {
      kind: "gate",
      id: "the profile report was measured inside the host's one instrument lock (an unslotted report is refused, never judged)",
      source: "tests/performance/regression.test.ts",
    },
    { kind: "gate", id: "performance-report", source: "scripts/testing/performance-measurements.ts" },
    { kind: "gate", id: "instrumentLockStamp(lockPath)", source: "tests/reporters/budget-reporter.ts" },
    {
      kind: "record",
      id: "instrumentLock",
      source: "tests/performance/profile.spec.ts",
    },
    {
      kind: "doc",
      id: "instrument lock",
      source: MEASUREMENT_DOC_SOURCE,
      anchor: "instrument lock",
    },
  ],
  load: {
    kind: "agnostic",
    normalization: "a host-lock STATE read at write time, not a duration: the same report is held or unslotted independently of load",
    proof: "instrumentLockStamp",
  },
  absent: {
    kind: "sentinel",
    value: "unslotted",
    reason: "no live hold stamps \"unslotted\"; the gate refuses it by name rather than judging the profile",
  },
  zero: { kind: "not-numeric", reason: "a stamp is not a numeric measurement" },
};

/** One web-performance budget signal. */
function perfBudget(
  budget: string,
  unit: string,
  compute: string,
  gateTitle: string,
  load: LoadBehaviour,
  zero: ZeroSemantics,
): MetricEntry {
  return {
    status: "registered",
    name: `web.perf.${budget}`,
    unit,
    family: "web.perf.budget",
    distinctFrom: [],
    producer: {
      module: "scripts/testing/performance-measurements.ts",
      symbol: "performanceMeasurements",
      compute: [compute],
      reads: [],
      forbids: ["Date.now", "performance.now(", "loadavg(", "cpuUsage("],
    },
    consumers: [
      {
        kind: "gate",
        id: gateTitle,
        source: "tests/performance/regression.test.ts",
      },
      { kind: "gate", id: `performance:${budget}`, source: "scripts/testing/performance-measurements.ts" },
      { kind: "budget", id: `webUi.performance.${budget}` },
      {
        kind: "record",
        id: budget,
        source: "scripts/testing/performance-measurements.ts",
      },
    ],
    load,
    absent: {
      kind: "null",
      reason: "the profile did not measure it; `performanceMeasurements` maps NaN/absent to null and the budget judgement refuses a null instead of passing a zero",
    },
    zero,
  };
}

const PERF_LATENCY_FINDING: LoadBehaviour = {
  kind: "sensitive",
  sensitivity: "wall-clock latency measured in the browser under the instrument lock; a busy host inflates it",
  bound: null,
  finding: "F-PERF-LATENCY-NO-BOUND",
};

const PERF_STRUCTURAL: LoadBehaviour = {
  kind: "agnostic",
  normalization: "a structural count from the captured page/tab snapshot; it does not read a clock and does not grow with host load",
  proof: "domNodes",
};

const WEB_PERF_ENTRIES: readonly MetricEntry[] = Object.freeze([
  perfBudget("lcpMaxMs", "milliseconds", "lcpMaxMs:\\s*finiteNumber\\(report\\.pageLoad\\?\\.lcp\\)", "page LCP was measured (its budget is judged once, by the one budget judgement)", PERF_LATENCY_FINDING, { kind: "unreachable", reason: "a paint timing of zero cannot occur with a live observer; absent is null" }),
  perfBudget("clsMax", "unitless layout-shift score", "clsMax:\\s*finiteNumber\\(report\\.pageLoad\\?\\.cls\\)", "page CLS was measured (its budget is judged once, by the one budget judgement)", { kind: "sensitive", sensitivity: "layout-shift timing: the measured band moved with the host, so the score is timing-sensitive", bound: null, finding: "F-PERF-CLS-NO-BOUND" }, { kind: "honest", witness: "the layout-shift observer was live (clsEntries measured)", reason: "zero shifts with a live observer is a measured answer" }),
  perfBudget("longTaskWorstMaxMs", "milliseconds", "longTaskWorstMaxMs:\\s*worst\\(", "the worst long task was measured (its budget is judged once, by the one budget judgement)", PERF_LATENCY_FINDING, { kind: "honest", witness: "the long-task observer was live (eventCount-style witness field)", reason: "zero long tasks with a live observer is a measured answer" }),
  perfBudget("longTaskTotalMaxMs", "milliseconds", "longTaskTotalMaxMs:\\s*finiteNumber\\(report\\.pageLoad\\?\\.longTaskTotalMs\\)", "the total long-task time was measured (its budget is judged once, by the one budget judgement)", PERF_LATENCY_FINDING, { kind: "honest", witness: "the long-task observer was live", reason: "zero total long-task time with a live observer is a measured answer" }),
  perfBudget("tabSwitchMaxMs", "milliseconds", "tabSwitchMaxMs:\\s*okTabs", "every tab switch was measured (its budget is judged once, by the one budget judgement)", PERF_LATENCY_FINDING, { kind: "unreachable", reason: "a measured switch has a positive duration; absence is null" }),
  perfBudget("tabDomNodesMax", "DOM node count", "tabDomNodesMax:\\s*okTabs", "every tab DOM node count was measured (its budget is judged once, by the one budget judgement)", PERF_STRUCTURAL, { kind: "honest", witness: "a measured tab population (okTabs) and a DOM snapshot", reason: "a zero-node tab is a measured structural answer; the population arm refuses an empty tab set" }),
  perfBudget("typingMeanMaxMs", "milliseconds", "typingMeanMaxMs:\\s*typing", "chat input typing latency was measured, settle-inclusive (its budget is judged once, by the one budget judgement)", PERF_LATENCY_FINDING, { kind: "unreachable", reason: "a typing sample has a positive duration; absence is null" }),
  perfBudget("apiResponseMaxMs", "milliseconds", "apiResponseMaxMs:\\s*\\(report\\.networkSummary", "the slowest API response was measured (its budget is judged once, by the one budget judgement)", PERF_LATENCY_FINDING, { kind: "unreachable", reason: "a timed response has a positive duration; absence is null" }),
  perfBudget("longSessionHeapGrowthMaxMb", "megabytes", "longSessionHeapGrowthMaxMb:\\s*finiteNumber\\(report\\.longSession", "long-session heap growth was measured (its budget is judged once, by the one budget judgement)", { kind: "sensitive", sensitivity: "heap growth depends on collector timing and the sampling window, not only on the tree", bound: null, finding: "F-PERF-MEMORY-NO-BOUND" }, { kind: "honest", witness: "the memory snapshots were captured", reason: "zero growth with captured snapshots is a measured answer" }),
  perfBudget("longSessionDomGrowthMax", "DOM node count", "longSessionDomGrowthMax:\\s*finiteNumber\\(report\\.longSession", "long-session DOM growth was measured (its budget is judged once, by the one budget judgement)", { kind: "agnostic", normalization: "DOM node count between captured snapshots; a structural count, not a duration", proof: "domNodeGrowth" }, { kind: "honest", witness: "the memory/DOM snapshots were captured", reason: "zero growth with captured snapshots is a measured answer" }),
  perfBudget("longChatRenderMaxMs", "milliseconds", "longChatRenderMaxMs:\\s*longChat", "the long-chat (1000 messages) render was measured (its budget is judged once, by the one budget judgement)", PERF_LATENCY_FINDING, { kind: "unreachable", reason: "a render has a positive duration; absence is null" }),
  perfBudget("manyProjectsRenderMaxMs", "milliseconds", "manyProjectsRenderMaxMs:\\s*manyProjects", "the 10k-projects sidebar render was measured (its budget is judged once, by the one budget judgement)", PERF_LATENCY_FINDING, { kind: "unreachable", reason: "a render has a positive duration; absence is null" }),
  perfBudget("viewportLcpMaxMs", "milliseconds", "viewportLcpMaxMs:\\s*worst\\(", "every viewport LCP was measured (its budget is judged once, by the one budget judgement)", PERF_LATENCY_FINDING, { kind: "unreachable", reason: "a paint timing of zero cannot occur with a live observer; absence is null" }),
]);

const PER_FILE_DURATION_DISTINCTNESS = (
  sibling: string,
  reason: string,
): { name: string; reason: string } => ({ name: sibling, reason });

/** Per-file collect time, the sequencer-invisible cost. */
const PER_FILE_COLLECT: MetricEntry = {
  status: "registered",
  name: "suite.perFile.collectMs",
  unit: "milliseconds per test file",
  family: "per-file.wall-duration",
  distinctFrom: [
    PER_FILE_DURATION_DISTINCTNESS("suite.perFile.occupancyMs", "collect is the import/suite-callback phase alone; occupancy is every phase a worker held the file for"),
    PER_FILE_DURATION_DISTINCTNESS("shards.file.weightMs", "collect is vitest's module diagnostic during THIS run; the shard weight is the JSON reporter's endTime - startTime used to schedule a DIFFERENT run"),
  ],
  producer: {
    module: "engine/src/shared/test-costs.ts",
    symbol: "summarizeTestCosts",
    compute: ['finiteDiagnosticMs\\(diagnostic,\\s*"collectDuration"\\)'],
    reads: [],
    forbids: ["cpuUsage(", "endTime", "startTime", "wallClockMs"],
  },
  consumers: [
    { kind: "gate", id: "collect-tail-share", source: "engine/src/shared/budget-verdict.ts" },
    { kind: "record", id: "slowestCollects", source: "tests/reporters/budget-reporter.ts" },
    { kind: "doc", id: "per-file collect", source: MEASUREMENT_DOC_SOURCE, anchor: "per-file collect" },
  ],
  load: {
    kind: "agnostic",
    normalization: "the collect gate consumes the worst file's collect as a SHARE of the run's wall clock (`worstCollectShare`); contention inflates both numerator and denominator",
    proof: "worstCollectShare",
  },
  absent: {
    kind: "null",
    reason: "a file with no readable collect diagnostic is omitted from the population, never recorded as a zero-cost file; an empty population leaves the total null and the gate refuses it",
  },
  zero: { kind: "honest", witness: "a readable module diagnostic reporting 0 ms", reason: "a measured zero collect is a real answer and is distinct from an absent diagnostic" },
};

/** Per-file occupancy, every phase a worker held the file. */
const PER_FILE_OCCUPANCY: MetricEntry = {
  status: "registered",
  name: "suite.perFile.occupancyMs",
  unit: "milliseconds per test file",
  family: "per-file.wall-duration",
  distinctFrom: [
    PER_FILE_DURATION_DISTINCTNESS("suite.perFile.collectMs", "occupancy includes collect plus setup, environment, prepare and test time; collect is one phase of it"),
    PER_FILE_DURATION_DISTINCTNESS("shards.file.weightMs", "occupancy is the sum of vitest's module diagnostics in this run; the shard weight is the JSON reporter's endTime - startTime for scheduling"),
  ],
  producer: {
    module: "engine/src/shared/test-costs.ts",
    symbol: "totalModuleOccupancyMs",
    compute: ["total\\s*\\+=\\s*ms"],
    reads: [],
    forbids: ["cpuUsage(", "endTime", "startTime", "wallClockMs"],
  },
  consumers: [
    { kind: "gate", id: "per-file-pool-share", source: "engine/src/shared/budget-verdict.ts" },
    { kind: "record", id: "slowestFiles", source: "tests/reporters/budget-reporter.ts" },
    { kind: "doc", id: "per-file occupancy", source: MEASUREMENT_DOC_SOURCE, anchor: "per-file occupancy" },
  ],
  load: {
    kind: "agnostic",
    normalization: "the occupancy gate consumes the worst file as a SHARE of the pool's total occupancy (`per-file-pool-share`); contention inflates every file together",
    proof: "per-file-pool-share",
  },
  absent: {
    kind: "null",
    reason: "a file with none of the occupancy fields readable is omitted; the pool denominator is null when nothing was measured, and the gate refuses rather than dividing by zero",
  },
  zero: { kind: "honest", witness: "a readable module diagnostic with measured fields", reason: "a measured zero occupancy is a real answer; an unreadable diagnostic is absent" },
};

/** The collect gate's recorded denominator. */
const TOTAL_COLLECT: MetricEntry = {
  status: "registered",
  name: "suite.run.totalCollectMs",
  unit: "milliseconds per run",
  family: null,
  distinctFrom: [],
  producer: {
    module: "engine/src/shared/test-costs.ts",
    symbol: "summarizeTestCosts",
    compute: ["totalCollectMs\\s*=\\s*collects"],
    reads: [],
    forbids: ["cpuUsage(", "endTime", "startTime", "wallClockMs"],
  },
  consumers: [
    { kind: "record", id: "totalCollectMs", source: "tests/reporters/budget-reporter.ts" },
    { kind: "doc", id: "total collect", source: MEASUREMENT_DOC_SOURCE, anchor: "total collect" },
  ],
  load: {
    kind: "sensitive",
    sensitivity: "a sum of wall-clock collect durations; contention and a cold transform cache inflate it",
    bound: null,
    finding: "F-TOTAL-COLLECT-WALL-CLOCK",
  },
  absent: {
    kind: "null",
    reason: "no measured collect leaves the total null; it is never recorded as 0",
  },
  zero: { kind: "honest", witness: "at least one measured collect of 0 ms", reason: "a measured zero total is possible and is distinct from an empty population" },
};

/** The per-file-share gate's denominator. */
const TOTAL_OCCUPANCY: MetricEntry = {
  status: "registered",
  name: "suite.run.totalOccupancyMs",
  unit: "milliseconds per run",
  family: null,
  distinctFrom: [],
  producer: {
    module: "engine/src/shared/test-costs.ts",
    symbol: "summarizeTestCosts",
    compute: ["totalOccupancyMs\\s*=\\s*totals"],
    reads: [],
    forbids: ["cpuUsage(", "endTime", "startTime", "wallClockMs"],
  },
  consumers: [
    { kind: "gate", id: "per-file-pool-share", source: "engine/src/shared/budget-verdict.ts" },
    { kind: "record", id: "totalOccupancyMs", source: "tests/reporters/budget-reporter.ts" },
    { kind: "doc", id: "total occupancy", source: MEASUREMENT_DOC_SOURCE, anchor: "total occupancy" },
  ],
  load: {
    kind: "agnostic",
    normalization: "it is the denominator of the per-file share (`per-file-pool-share`); the same contention inflates numerator and denominator",
    proof: "per-file-pool-share",
  },
  absent: {
    kind: "null",
    reason: "nothing measurable leaves the denominator null; the gate treats a missing denominator as unjudgeable rather than dividing by a zero",
  },
  zero: { kind: "honest", witness: "the measured population summed to 0 ms", reason: "a measured zero denominator is refused by the gate as unjudgeable, never silently divided" },
};

/** The per-file weight the shard plan is built from. */
const SHARD_WEIGHT: MetricEntry = {
  status: "registered",
  name: "shards.file.weightMs",
  unit: "milliseconds per test file",
  family: "per-file.wall-duration",
  distinctFrom: [
    PER_FILE_DURATION_DISTINCTNESS("suite.perFile.collectMs", "the shard weight is the JSON reporter's endTime - startTime for a whole file-run and is used to schedule a future run; collect is a diagnostic phase in this run"),
    PER_FILE_DURATION_DISTINCTNESS("suite.perFile.occupancyMs", "the shard weight comes from the JSON reporter's start/end pair; occupancy is the sum of vitest's module diagnostics"),
  ],
  producer: {
    module: "scripts/test-shard-manifest.mjs",
    symbol: "measuredFileDurationMs",
    compute: ["endTime\\s*-\\s*\\w+\\.?startTime"],
    reads: [],
    forbids: ["cpuUsage(", "cpuMs", "wallClockMs"],
  },
  consumers: [
    { kind: "record", id: "weightMs", source: "tests/test-shards.json" },
    { kind: "record", id: "assignShards", source: "scripts/test-shard-manifest.mjs" },
    { kind: "doc", id: "shard weights", source: MEASUREMENT_DOC_SOURCE, anchor: "shard weights" },
  ],
  load: {
    kind: "sensitive",
    sensitivity: "a wall-clock per-file duration measured in CI; contention and cold caches inflate it",
    bound: null,
    finding: "F-SHARD-WEIGHT-WALL-CLOCK",
  },
  absent: {
    kind: "refusal",
    reason: "a missing, duplicated, partial, non-green or different-manifest report refuses the measurement; it never writes a zero weight",
    refusal: "measure: expected",
  },
  zero: { kind: "floor", value: 1, reason: "a sub-0.5 ms measurement rounds to 0 and is floored to 1 because the plan needs a positive weight; the floor is declared here, never silent" },
};

/** The CI receipt's critical path. */
const CI_TEST_PHASE: MetricEntry = {
  status: "registered",
  name: "ci.shard.testPhaseMs",
  unit: "milliseconds across the shard set",
  family: "ci.shard.duration",
  distinctFrom: [
    { name: "ci.shard.summedShardDurationMs", reason: "this is the critical path across shard timestamps; the sibling is the SUM of every shard's own durationMs" },
  ],
  producer: {
    module: "scripts/test-shard-merge.mjs",
    symbol: "mergeShardReports",
    compute: ["testPhaseMs\\s*="],
    reads: [],
    forbids: ["cpuUsage(", "loadavg("],
  },
  consumers: [
    { kind: "record", id: "testPhaseMs", source: "scripts/test-shard-merge.mjs" },
    { kind: "doc", id: "testPhaseMs", source: MEASUREMENT_DOC_SOURCE, anchor: "testPhaseMs" },
  ],
  load: {
    kind: "sensitive",
    sensitivity: "the critical path from shard start/finish timestamps; it includes queueing and host contention",
    bound: null,
    finding: "F-CI-DURATION-WALL-CLOCK",
  },
  absent: {
    kind: "null",
    reason: "if any shard carries no timing the receipt records null; it never records a zero critical path",
  },
  zero: { kind: "honest", witness: "all shard timings were present and identical", reason: "a measured zero critical path is possible and is distinct from missing timing" },
};

/** The CI receipt's summed shard duration (quoted as `testPhaseCpuMs`). */
const CI_SUMMED_SHARD: MetricEntry = {
  status: "registered",
  name: "ci.shard.summedShardDurationMs",
  unit: "milliseconds summed over shards",
  family: "ci.shard.duration",
  distinctFrom: [
    { name: "ci.shard.testPhaseMs", reason: "testPhaseMs is the critical path across shards; this is the SUM of every shard's durationMs (and is quoted in the receipt as testPhaseCpuMs)" },
  ],
  producer: {
    module: "scripts/test-shard-merge.mjs",
    symbol: "mergeShardReports",
    compute: ["testPhaseCpuMs\\s*="],
    reads: [],
    forbids: ["cpuUsage(", "loadavg("],
  },
  consumers: [
    { kind: "record", id: "testPhaseCpuMs", source: "scripts/test-shard-merge.mjs" },
    { kind: "doc", id: "testPhaseCpuMs", source: MEASUREMENT_DOC_SOURCE, anchor: "testPhaseCpuMs" },
  ],
  load: {
    kind: "sensitive",
    sensitivity: "a sum of wall-clock shard durations; it inflates with contention and includes queueing",
    bound: null,
    finding: "F-CI-DURATION-WALL-CLOCK",
  },
  absent: {
    kind: "null",
    reason: "missing shard timing leaves the sum null; it is never recorded as a zero",
  },
  zero: { kind: "honest", witness: "every shard timing was present and 0 ms", reason: "a measured zero sum is possible and is distinct from missing timing" },
};

/**
 * The run-start ambient load, per CPU. The verdict consumes the 5-minute
 * leg; the 1-minute leg is recorded as a covariate and is never a normaliser.
 *
 * COMPUTE vs READ. The division spellings are the computation this entry
 * declares; `loadavg()` is only the RAW READ of the fact, so it lives in
 * `reads` and can never satisfy the body clause by itself. The producer is
 * the one owner of the sample, so a `loadavg()` call anywhere else is a
 * second reading of the same fact even when it does not divide — the direct
 * readers this entry caught (`checkout-setup.ts`, `flake-cli.ts`,
 * `bench/lib/machine.ts`) record the raw leg and were invisible to a
 * division-only scan.
 *
 * CONSUMERS ARE TOTAL. Every module that imports or calls the producer
 * symbol is declared here (gate/record/doc) or in
 * {@link NON_MEASUREMENT_CONSUMERS} with a reason; the guard walks the
 * import universe, so a new reader cannot stay undeclared.
 */
const AMBIENT_LOAD: MetricEntry = {
  status: "registered",
  name: "ambient.load.perCpu",
  unit: "load average per CPU (three legs)",
  family: "ambient-load",
  distinctFrom: [],
  producer: {
    module: "engine/src/shared/ambient-load.ts",
    symbol: "readAmbientLoadPerCpu",
    compute: [
      "load1\\s*/\\s*cpuCount",
      "loads?\\[0\\]\\s*/\\s*\\w+",
      "\\bl1\\s*/\\s*cores\\.length\\b",
    ],
    reads: ["loadavg\\(\\)"],
    forbids: ["wallClock", "performance.now(", "cpuUsage("],
  },
  consumers: [
    { kind: "gate", id: "cpu-per-test-file", source: "engine/src/shared/budget-verdict.ts" },
    { kind: "record", id: "load1PerCpuAtStart", source: "tests/reporters/budget-reporter.ts" },
    { kind: "record", id: "loadAverage1m", source: "server/observability/metrics-bridge.ts" },
    { kind: "record", id: "loadAverage1m", source: "src/state/metrics.ts" },
    { kind: "record", id: "loadAvg1", source: "engine/src/performance/diagnostic-modes.ts" },
    { kind: "record", id: "ambientLoadPerCpu", source: "engine/scripts/tooling/run-tests.ts" },
    { kind: "record", id: "loadPerCpu", source: "bench/lib/machine.ts" },
    { kind: "record", id: "ambient.loads?.[0] ?? null", source: "engine/src/workflow/checkout-setup.ts" },
    { kind: "record", id: "readAmbientLoadPerCpu().loads?.[0] ?? null", source: "engine/src/workflow/flake-cli.ts" },
    { kind: "doc", id: "ambient load", source: MEASUREMENT_DOC_SOURCE, anchor: "ambient load" },
  ],
  load: {
    kind: "sensitive",
    sensitivity: "it is the host's load average divided by the OS-reported CPU count; the 1-minute leg decays and the 5-minute leg is the verdict's covariate",
    bound: null,
    finding: "F-AMBIENT-NO-DEFERRAL",
  },
  absent: {
    kind: "null",
    reason: "an unreadable sample or CPU count yields `perCpu: null`; consumers record null and the verdict takes no ambient adjustment — never a fabricated zero",
  },
  zero: { kind: "not-numeric", reason: "the unit is load per CPU; a measured 0 is an idle reading and is represented as 0 only when the sample was readable" },
};

/**
 * The server's token throughput, exposed by the metrics bridge and recorded
 * in the web history. It is a RATE: the numerator is the recorder's token
 * accumulator and the denominator is the server's own elapsed wall clock.
 * A non-positive denominator has no rate, so the producer answers null and
 * every consumer carries null (never 0). It is load-sensitive with no
 * numeric bound, recorded as {@link MEASUREMENT_FINDINGS} finding
 * `F-TOKEN-THROUGHPUT-NO-BOUND`.
 */
const TOKEN_THROUGHPUT: MetricEntry = {
  status: "registered",
  name: "performance.tokensPerSecond",
  unit: "tokens per second",
  family: null,
  distinctFrom: [],
  producer: {
    module: "server/observability/metrics-recorder.ts",
    symbol: "getTokenThroughput",
    compute: ["totalTokens\\s*/\\s*seconds"],
    reads: [],
    forbids: ["cpuUsage("],
  },
  consumers: [
    { kind: "record", id: "tokensPerSecond", source: "server/observability/metrics-bridge.ts" },
    { kind: "record", id: "tokensPerSecond", source: "src/state/metrics.ts" },
    { kind: "record", id: "tokensPerSecond", source: "engine/src/shared/exposure/registrations/performance.ts" },
    { kind: "doc", id: "performance.tokensPerSecond", source: MEASUREMENT_DOC_SOURCE, anchor: "server's token throughput" },
  ],
  load: {
    kind: "sensitive",
    sensitivity: "the token count is divided by the server's elapsed wall clock; host load and stalled streams lengthen the interval and lower the rate",
    bound: null,
    finding: "F-TOKEN-THROUGHPUT-NO-BOUND",
  },
  absent: {
    kind: "null",
    reason: "a non-positive elapsed interval has no rate: the producer returns null and the bridge, the history point and the exposure signal carry null — never a fabricated 0",
  },
  zero: {
    kind: "honest",
    witness: "the accumulator held zero tokens across a positive measured interval",
    reason: "a zero rate over a real interval is a measured fact, distinct from an unmeasurable denominator",
  },
};

export const MEASUREMENT_REGISTRY: readonly MetricEntry[] = Object.freeze([
  MEASURED_SURFACE,
  INSTRUMENT_LOCK,
  ...WEB_PERF_ENTRIES,
  PER_FILE_COLLECT,
  PER_FILE_OCCUPANCY,
  TOTAL_COLLECT,
  TOTAL_OCCUPANCY,
  SHARD_WEIGHT,
  CI_TEST_PHASE,
  CI_SUMMED_SHARD,
  TOKEN_THROUGHPUT,
  AMBIENT_LOAD,
]);

/**
 * THE CPU PLACEHOLDER — reserved, not guessed.
 *
 * The CPU metric (`run-cpu.ts` readRunCpu, consumed by `budget-verdict.ts`)
 * is being changed by another agent. This entry deliberately declares only
 * facts that are already true and stable:
 *
 *   - the raw producer is `readRunCpu`, and it returns null on an unreadable
 *     `/proc` (the file's own contract);
 *   - the gate name is `cpu-per-test-file`, and the reporter records
 *     `runCpuMs`;
 *   - the final field set, load declaration and deferral bound belong to the
 *     in-flight change and are NOT restated here.
 */
export const CPU_METRIC_PLACEHOLDERS: readonly MetricEntry[] = Object.freeze([
  {
    status: "placeholder",
    name: "cpu.runCpu",
    unit: "milliseconds of CPU (final unit/fields owned by the CPU change)",
    family: "cpu",
    distinctFrom: [],
    producer: {
      module: "engine/src/shared/run-cpu.ts",
      symbol: "readRunCpu",
      compute: ["readRunCpu"],
      reads: [],
      forbids: [],
    },
    consumers: [
      { kind: "gate", id: "cpu-per-test-file", source: "engine/src/shared/budget-verdict.ts" },
      { kind: "record", id: "runCpuMs", source: "tests/reporters/budget-reporter.ts" },
    ],
    load: {
      kind: "placeholder",
      note: "the CPU metric's final load declaration is owned by the in-flight change to run-cpu.ts and budget-verdict.ts; this registry does not guess it",
    },
    absent: {
      kind: "null",
      reason: "readRunCpu returns null when /proc is unreadable or the CPU clocks cannot be calibrated; a zero would claim the run did no work",
    },
    zero: { kind: "honest", witness: "a readable CPU sample with 0 ms", reason: "a measured zero CPU reading is a real answer; the final zero policy is owned by the CPU change" },
  },
]);
