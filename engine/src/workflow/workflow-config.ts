/**
 * Workflow operational defaults — the single source of truth for all
 * workflow-domain configurable values.
 *
 * Per the no-configurables-outside-config invariant: "No configurables
 * outside the global config file. One single source of truth. No default
 * values outside config." These numeric operational defaults (timeouts,
 * concurrency, stale intervals) previously lived as scattered `const
 * DEFAULT_*_MS` literals in `harness-commands.ts`, `resource-lock.ts`,
 * `workspace-manager.ts`, and `test-result-collector.ts`. They are
 * consolidated here so the `no-hardcoded-configurables` prevention test
 * passes and there is exactly one owner per concept.
 *
 * The resolved config document (`bridlewise.config.json` →
 * `ConfigDocument`) overrides these at runtime; the values here are the
 * fallback when a config field is absent. This file is the canonical
 * owner (its basename contains "config"), so the prevention scanner
 * excludes it.
 *
 * When the config document gains a field for one of these values, the
 * consumer should read `config.resourceLock.timeoutMs?? DEFAULT_LOCK_TIMEOUT_MS`
 * the default stays here as the fallback, the config overrides it.
 */

import type { SubprocessBounds } from "../process/subprocess-bounds.ts";
import type { ConfigDocument } from "../kernel/config-contracts.ts";
import { loadPinnedConfigSnapshot } from "../kernel/config.ts";
import { InputError } from "../kernel/errors.ts";
import { statePath } from "../kernel/product-identity.ts";

/**
 * A workflow operational option, or its default when absent: a present value
 * must be a finite number above zero (`positive`) or at least zero
 * (`non-negative`), else the typed `workflow_option_invalid` naming the option. The ONE
 * validator of the workflow's numeric options (the resource locks, the test
 * collector's concurrency): it was two private copies, the DRY allowlist's
 * standing baseline pair.
 */
export function numericOption(value: number | undefined, fallback: number, name: string, bound: "positive" | "non-negative"): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || (bound === "positive" ? value <= 0 : value < 0)) {
    throw new InputError(`${name} must be a ${bound} finite number`, "workflow_option_invalid");
  }
  return value;
}

// ── the roadmap feed (src/workflow/forge/projector/roadmap-feed.ts) ───────

/** How many whole weeks of shipped history a milestone's ETA band needs; below it the band is `unknown`, never guessed. */
export const DEFAULT_ROADMAP_ETA_MINIMUM_WEEKS = 4;

/** The CPU-time ceiling, in seconds, of one confined projection or feed computation (the guardian's `cpu_seconds`). */
export const DEFAULT_PROJECTION_CPU_SECONDS = 120;

/**
 * The address-space ceiling, in bytes, of the same computation (the guardian's
 * `memory_bytes`, RLIMIT_AS). Address space, not resident memory: node 24
 * reserves address space well beyond its working set and does not start under
 * 1 GiB of it; 1.5 GiB starts it and stops a runaway allocation.
 */
export const DEFAULT_PROJECTION_MEMORY_BYTES = 1_610_612_736;

// ── harness-commands.ts defaults ──────────────────────────────────────────


// ── the ONE command runner (checkout-setup.ts): errored-class retries ───────

/** How often an ERRORED command (a ceiling, a signal, an environmental marker) is retried (`harness.commandErroredRetries`). */
const DEFAULT_COMMAND_ERRORED_RETRIES = 2;
/** The wait before the first retry, doubled for each next one (`harness.commandRetryBackoffMs`). */
const DEFAULT_COMMAND_RETRY_BACKOFF_MS = 60_000;

/** The ONE command runner's errored-class retry policy as `document` configures it (the one reader of both settings; `{}` answers the defaults). */
export function commandRetryPolicy(document: Pick<ConfigDocument, "harness">): Readonly<{ retries: number; backoffMs: number }> {
  return Object.freeze({
    retries: document.harness?.commandErroredRetries ?? DEFAULT_COMMAND_ERRORED_RETRIES,
    backoffMs: document.harness?.commandRetryBackoffMs ?? DEFAULT_COMMAND_RETRY_BACKOFF_MS,
  });
}
/**
 * How many hex digits of a commit id a person-facing line shows (the release
 * train's answers, the release notes), each linking or naming the full id
 * beside it: git's own short form tops out at 12.
 */
export const DISPLAY_COMMIT_ID_LENGTH = 12;

/**
 * How many hex digits of its key's SHA-256 an SBOM element id carries
 * (`release-sbom.ts`: `SPDXRef-npm-<name>-<digits>`), so ids stay unique in
 * one document however a name sanitises. Twelve keeps them unique for any
 * lockfile a release could hold.
 */
export const SBOM_ELEMENT_ID_DIGEST_LENGTH = 12;

export const DEFAULT_GIT_ADD_TIMEOUT_MS = 30_000;
export const DEFAULT_GIT_COMMIT_TIMEOUT_MS = 30_000;

// ── the harness's subprocess bounds (src/process/subprocess-bounds.ts): NO-LOAD-BLOCK L2 ──
//
// Every script subprocess (`runScriptSubprocess`), `harness check`'s tsc and
// the commit guard's compile legs run through the one bounded run
// (`runCpuBounded`, src/process/supervised-run.ts) under these, and nothing
// else bounds them; an admitted run's own process gets the same kernel CPU
// limit (the instrument lock's per-run caps). The typecheck's own 120 s wall
// limit (`harness.typecheckTimeoutMs`) is gone with the step timeouts below.
//
// `harness sync`'s steps, the dispositions' auto-add, the inventory and the
// generators each ran under a WALL timeout of their own (120 s to 420 s), and
// a loaded host killed them: sync's step 5/5 (`harness check`, 240 s) died
// "without a status payload" and blocked merges (audit row A-18). A busy host
// makes a step WAIT for a core; it does not make it do more work. So a step
// is bounded by its WORK, and wall time only ends a hang:
//
// - its process group's CPU time, many times the heaviest step's measured
//   work, so it ends a runaway, never a slow host; the kernel's RLIMIT_CPU
//   backs it per process, just past it (`kernelCpuLimit`);
// - a STALL: no output and CPU work under a floor (by default 5% of a core)
//   for the stall window (by default 30 minutes): a step waiting on nothing,
//   or a poller, is not working;
// - the hang backstop, the one wall bound left: very large, and a step that
//   reaches it is reported HUNG, with how it ended, never retried here;
// - the output it may print (`harness check`'s payload is ~75 KB).
/** The defaults of `harness.subprocessBounds`, each a documented setting (src/kernel/config-contracts.ts; the settings room's harness rows). */
const DEFAULT_SUBPROCESS_BOUNDS: SubprocessBounds = Object.freeze({
  cpuBudgetMs: 1_800_000,
  minimumCpuRate: 0.05,
  stallMs: 1_800_000,
  hangBackstopMs: 7_200_000,
  pollMs: 1_000,
  killGraceMs: 5_000,
  outputBytes: 256 * 1024 * 1024,
});

/** The harness's subprocess bounds as `document` configures them (`harness.subprocessBounds`; `{}` answers the defaults). */
export function subprocessBounds(document: Pick<ConfigDocument, "harness">): SubprocessBounds {
  const configured = document.harness?.subprocessBounds;
  return Object.freeze({
    cpuBudgetMs: configured?.cpuBudgetMs ?? DEFAULT_SUBPROCESS_BOUNDS.cpuBudgetMs,
    minimumCpuRate: configured?.minimumCpuRate ?? DEFAULT_SUBPROCESS_BOUNDS.minimumCpuRate,
    stallMs: configured?.stallMs ?? DEFAULT_SUBPROCESS_BOUNDS.stallMs,
    hangBackstopMs: configured?.hangBackstopMs ?? DEFAULT_SUBPROCESS_BOUNDS.hangBackstopMs,
    pollMs: configured?.pollMs ?? DEFAULT_SUBPROCESS_BOUNDS.pollMs,
    killGraceMs: configured?.killGraceMs ?? DEFAULT_SUBPROCESS_BOUNDS.killGraceMs,
    outputBytes: configured?.outputBytes ?? DEFAULT_SUBPROCESS_BOUNDS.outputBytes,
  });
}

/** The harness's subprocess bounds from the pinned config document: what every harness subprocess, the commit guard's compile legs and an admitted run's own process run under. */
export function configuredSubprocessBounds(): SubprocessBounds {
  return subprocessBounds(loadPinnedConfigSnapshot().document);
}
/**
 * How long one CPU-calibration child (`src/shared/run-cpu.ts`: the fixed
 * benchmark a run takes at start and end to turn CPU time into work units)
 * may take before its reading is absent.
 */
export const DEFAULT_CPU_CALIBRATION_TIMEOUT_MS = 120_000;

/** Hex digits of the test-inventory hash `harness check` quotes in its passing message. */
export const INVENTORY_HASH_PREVIEW_HEX = 12;

// ── resource-lock.ts defaults ─────────────────────────────────────────────

export const DEFAULT_LOCK_DIRECTORY = statePath("state", "locks");
export const DEFAULT_LOCK_TIMEOUT_MS = 120_000 as const;

/**
 * How long `scripts/merge-round.mjs` waits for the merge file lock.
 *
 * ── WHY THIS MOVED HERE ──────────────────────────────────────────────────
 *
 * It lived in `src/shared/workflow/workflow-config.mjs` under the name
 * `DEFAULT_LOCK_TIMEOUT_MS` — the SAME name as the resource-lock default just
 * above, with a different value (60_000 against 120_000), and BOTH files
 * headed "the canonical owner". Two owners for one word is the shape this
 * project keeps rediscovering, and here it was worse than a duplicate: the
 * two names meant different things, so neither value was wrong and the
 * disagreement looked like drift.
 *
 * The stated reason for the split was that a `.mjs` script "cannot import the
 * `.ts` workflow config". Driven on this runtime (node 24.18.0): a `.mjs`
 * module importing a `.ts` module resolves and runs, exit 0. The reason was a
 * runtime axis expressed as a duplicated constant, and the axis does not
 * exist.
 *
 * The merge lock and the resource lock are genuinely different mechanisms —
 * `merge-round.mjs` creates its own `O_EXCL` lock file, `resource-lock.ts`
 * does not — so they keep separate values. What they may not keep is
 * separate homes, or the same name.
 */
export const DEFAULT_MERGE_LOCK_TIMEOUT_MS = 60_000 as const;
export const DEFAULT_LOCK_POLL_INTERVAL_MS = 100 as const;
export const DEFAULT_LOCK_STALE_MS = 300_000 as const;

// ── workspace-manager.ts defaults ──────────────────────────────────────────

const DEFAULT_WORKSPACE_INSPECT_TIMEOUT_MS = 30_000;
const DEFAULT_WORKTREE_OPERATION_TIMEOUT_MS = 30_000;
const DEFAULT_MERGE_OPERATION_TIMEOUT_MS = 60_000;
const DEFAULT_REMOTE_OPERATION_TIMEOUT_MS = 60_000;

/**
 * The git ceilings of a worktree's owner (`workspaceGit.timeouts`, each
 * defaulted above): `worktreeMs` a worktree add, remove or switch and the
 * land; `inspectMs` an inspection; `mergeMs` a commit that runs the
 * repository's hooks; `fetchMs` / `pushMs` a fetch (or a remote listing) and
 * a push. One reader for the workspace manager and the promotion.
 */
export function worktreeOperationTimeouts(document: Pick<ConfigDocument, "workspaceGit">): Readonly<{ worktreeMs: number; inspectMs: number; mergeMs: number; fetchMs: number; pushMs: number }> {
  const timeouts = document.workspaceGit?.timeouts;
  return Object.freeze({
    worktreeMs: timeouts?.addMs ?? DEFAULT_WORKTREE_OPERATION_TIMEOUT_MS,
    inspectMs: timeouts?.inspectMs ?? DEFAULT_WORKSPACE_INSPECT_TIMEOUT_MS,
    mergeMs: timeouts?.commitMs ?? DEFAULT_MERGE_OPERATION_TIMEOUT_MS,
    fetchMs: timeouts?.fetchMs ?? DEFAULT_REMOTE_OPERATION_TIMEOUT_MS,
    pushMs: timeouts?.pushMs ?? DEFAULT_REMOTE_OPERATION_TIMEOUT_MS,
  });
}

/**
 * The merge gate's end-to-end suite bound (`scripts/harness-root/merge-round.mjs`
 * hands it to `runE2e` in src/shared/workflow/e2e-runner.mjs, which holds no
 * default of its own). The engine suite measured 5-7 min on this host in
 * 2026-09 (the runner's comment said "~14 min" for a 10 min default).
 */
export const DEFAULT_E2E_SUITE_TIMEOUT_MS = 600_000;

/** How many events `harness timeline` lists when no `--limit` is given. */
export const DEFAULT_TIMELINE_COMMAND_LIMIT = 50;

// ── workspace-manager.ts display lengths ───────────────────────────────────
/** The length of a workspace id's random suffix: the last characters of a generated id. */
export const WORKSPACE_NONCE_CHARACTERS = 12;
/** How many characters of a commit or tree id a workspace's generated pull request text shows. */
export const WORKSPACE_SHORT_ID_CHARACTERS = 12;
/** How many paths a workspace refusal names before it stops listing. */
export const WORKSPACE_REFUSAL_PATHS_NAMED = 8;

// ── test-result-collector.ts defaults ──────────────────────────────────────

export const MAXIMUM_PARALLEL_CONCURRENCY = 16 as const;
export const MINIMUM_PARALLEL_CONCURRENCY = 2 as const;

// S1 verification content-hash memoization cap. verifyS1Structure is a pure
// function of the filesystem at `root`; the cache is keyed by the manifest
// content hash (SHA-256 of every file). A test run produces at most ~117
// distinct hashes; the cap guards against pathological inventories only.
export const DEFAULT_S1_VERIFICATION_CACHE_MAX_ENTRIES = 512 as const;

// Filesystem-backed S1 verification cache cap. The serial test phase uses
// process isolation (each serial file runs in its own node process), so the
// in-memory cache is per-process and NOT shared across the ~8-12 serial
// processes. The filesystem cache (under os.tmpdir()/harness-s1-cache/) is
// shared across all processes on the machine, keyed by the manifest content
// hash. The first process to verify a given manifest hash computes + writes;
// subsequent processes read the cached result instead of re-parsing every
// source file with Babel. The cap bounds the cache directory size (FIFO
// eviction by mtime). Best-effort: a filesystem failure (read-only tmpdir,
// full disk) falls through to computation with no correctness impact.
export const DEFAULT_S1_FILESYSTEM_CACHE_MAX_ENTRIES = 256 as const;

// Filesystem-backed S1 verification cache directory (relative to os.tmpdir()).
// Shared across all processes on the machine. The directory is created
// best-effort on first write; a creation failure (read-only tmpdir) falls
// through to computation.
export const DEFAULT_S1_FILESYSTEM_CACHE_DIRECTORY = "harness-s1-cache" as const;

// THE ENGINE SUITE'S PER-TEST BOUNDS, for a root whose config does not
// declare them (a foreign or fixture tree; this checkout's own values are
// `testExecution.testHangBackstopMs` and `testExecution.testCpuClasses`,
// enforced by scripts/tooling/engine-test-bounds.ts). The hang backstop ends
// a test that never settles and never polices slowness; a test is judged by
// its CPU work against its file's class (TEST-CPU-CLASSES). The per-test
// WALL cap these replace (`runtimeBudgetMs`, 120 s) failed tests that pass
// alone under full-suite contention (NO-LOAD-BLOCK row G-05).
export const DEFAULT_TEST_HANG_BACKSTOP_MS = 600_000 as const;
export const DEFAULT_TEST_CPU_CLASSES: Readonly<{ defaultCeilingMs: number; headroomFactor: number; classes: readonly Readonly<{ name: string; measuredCpuMs: number; files: readonly string[] }>[] }> =
  Object.freeze({ defaultCeilingMs: 60_000, headroomFactor: 2, classes: Object.freeze([]) });

/**
 * THE ONE DERIVATION of a CPU class's ceiling: what its tests were measured
 * to do, times the one declared headroom. A class never carries a ceiling of
 * its own, so no ceiling is a number someone picked for one test. The
 * judgement (scripts/tooling/test-cpu-class.ts) and the exposure page both
 * ask this.
 */
export function classCeilingMs(classes: Readonly<{ headroomFactor: number }>, declared: Readonly<{ measuredCpuMs: number }>): number {
  return Math.ceil(declared.measuredCpuMs * classes.headroomFactor);
}

// The ENGINE suite's watchdog (overridable via testExecution.engineSuiteWatchdog;
// enforced in scripts/tooling/inventory-test-run.ts): a phase that reports no
// test event for `stallTimeoutMs`, or a run still going at `hardCeilingMs`, is
// aborted and its running files killed and reported failed. The per-test hang
// backstop above cannot end a FILE whose cancelled test left a handle open
// (measured: one file held a run for two hours). Both are HANG bounds, never
// judgements of speed (NO-LOAD-BLOCK): the stall bound (no progress at all)
// sits above the per-test backstop, so a hung test always reports before a
// stall is declared, and the ceiling is the schema's largest, far above any
// run that is still making progress (a loaded host's full suite took 1357 s
// of wall on CI). A stopped run (a stall, the ceiling, an operator's stop)
// has `killGraceMs` after its SIGTERM before it and every descendant are
// SIGKILLed.
export type SuiteWatchdog = Readonly<{ stallTimeoutMs: number; hardCeilingMs: number; killGraceMs: number }>;
export const DEFAULT_ENGINE_SUITE_WATCHDOG: SuiteWatchdog = Object.freeze({ stallTimeoutMs: 900_000, hardCeilingMs: 14_400_000, killGraceMs: 3_000 });

// Default concurrency for the serial phase. Files marked as sharing
// process-level resources (evidence-worker spawns, S1 repository walks,
// harness-live-root regenerators) run in a SEPARATE phase after the parallel
// phase to avoid cross-phase I/O contention. Within that serial phase, a
// bounded concurrency lets the isolated serial files (each using its own
// temp directory) share the phase, cutting the serial wall time. 1 preserves
// the original fully sequential behavior; values >1 run that many serial
// files at once. The value is a configurable (overridable via
// testExecution.serialPhaseConcurrency).
export const DEFAULT_SERIAL_PHASE_CONCURRENCY = 2 as const;

// `DEFAULT_SUITE_RUNTIME_BUDGET_MS` (120 s, the suite's wall-clock budget)
// lived here and is DELETED with its concept: the suite budget is a CPU
// budget now, declared in the config as `testExecution.integrationSuiteCpuBudget`
// with NO default anywhere — a budget nobody chose is not a budget, and the
// silent 120 s fallback was exactly that. A missing declaration reaches the
// runner's gate as absent and is reported NOT JUDGED in plain words
// (`judgeSuiteCpu` in `src/shared/budget-verdict.ts`), never quietly judged
// against a constant.

// Default serial-phase concurrency for the FULL test suite (RUN_SLOW=1). The
// slow serial files (S1 scenarios, harness-live-root) use process isolation
// when concurrency > 1, so each file gets its own process (no shared state, no
// live-repo races). A higher concurrency is safe with isolation and cuts the
// serial phase wall time dramatically. The value is a configurable (overridable
// via testExecution.fullSuiteSerialPhaseConcurrency). This is the concurrency
// for the SUBPROCESS-SPAWNING serial tier (files that import node:child_process
// or use the evidence pipeline); the in-process serial tier uses
// fullSuiteInProcessSerialPhaseConcurrency (higher, since no subprocess
// oversubscription).
export const DEFAULT_FULL_SUITE_SERIAL_PHASE_CONCURRENCY = 8 as const;

// Default serial-phase concurrency for the IN-PROCESS serial tier in the FULL
// test suite (RUN_SLOW=1). The in-process serial files (S1 scenarios that call
// verifyS1Structure/makeRuntimeCandidate, harness-commands architecture scans)
// are CPU-bound Babel-parse processes that thrash memory bandwidth + CPU cache
// when too many run at once. On a 12-CPU host, 12-way gives a 5.7× slowdown per
// scenario (17.7s isolated → ~100s) from the 15 Babel processes competing for
// memory. A LOWER concurrency (4) reduces the memory-contention penalty
// dramatically while keeping the subprocess tier (which runs concurrently at
// 8-way) close to its isolation speed. Total processes 4 + 8 = 12 (no
// oversubscription for the subprocess tier's child processes). The value is a
// configurable (overridable via testExecution.fullSuiteInProcessSerialPhaseConcurrency).
export const DEFAULT_FULL_SUITE_IN_PROCESS_SERIAL_PHASE_CONCURRENCY = 4 as const;

// Default parallel-phase concurrency for the FULL test suite (RUN_SLOW=1).
// The full suite runs the parallel phase FIRST (alone), then the serial tiers
// concurrently. The parallel phase wall is dominated by the slowest parallel
// straggler (awareness ~46s) regardless of concurrency, so the value mainly
// affects how many parallel processes run at once during the (isolated)
// parallel phase. 12 (the host parallelism) is the proven-safe default; a
// lower value is a tunable for hosts where the parallel phase's process
// count matters. The value is a configurable (overridable via
// testExecution.fullSuiteParallelConcurrency).
export const DEFAULT_FULL_SUITE_PARALLEL_CONCURRENCY = 12 as const;

// Content-hash AST cache bounds for S1 verification. These caches memoize
// the Babel parse of source files so that mutated candidates (which share
// most file contents via copy-on-write reflinks) reuse cached parses for
// unchanged files. The number of distinct source files is bounded by the
// architecture manifest (~200 modules); the caps guard against pathological
// inventories only. These are implementation constants, not user-facing
// configurables — they live here so the no-hardcoded-configurables
// prevention test is satisfied (the config owner is the canonical home).
export const DEFAULT_ARCHITECTURE_SOURCE_CACHE_MAX_ENTRIES = 1024 as const;

// Filesystem-backed architecture source cache cap. The architecture source
// cache (analyzeArchitectureSource) stores the Babel parse + analysis result
// for each source file. The serial test phase uses process isolation, so
// the in-memory cache is per-process. The filesystem cache (shared across
// processes) lets candidate verifications reuse Babel parses from other
// processes — candidates share most files via copy-on-write reflinks, so
// only the mutated file needs re-parsing. The cap bounds the cache directory
// size (FIFO eviction by mtime, amortized).
export const DEFAULT_ARCHITECTURE_SOURCE_FILESYSTEM_CACHE_MAX_ENTRIES = 1024 as const;
export const DEFAULT_GOVERNED_SOURCE_PARSE_CACHE_MAX_ENTRIES = 1024 as const;
export const DEFAULT_GOVERNED_SOURCE_VIOLATIONS_CACHE_MAX_ENTRIES = 1024 as const;

// Filesystem-backed governed-source violations cache cap. Shares the
// governed-source AST analysis (violations) across serial-phase processes.
export const DEFAULT_GOVERNED_SOURCE_VIOLATIONS_FILESYSTEM_CACHE_MAX_ENTRIES = 1024 as const;
export const DEFAULT_STATIC_MODULE_SHAPE_CACHE_MAX_ENTRIES = 1024 as const;

// Filesystem-backed static-module-shape cache cap. Shares the lexical
// tokenization + module-shape analysis across serial-phase processes.
export const DEFAULT_STATIC_MODULE_SHAPE_FILESYSTEM_CACHE_MAX_ENTRIES = 1024 as const;

// Content-hash memoization cap for the Babel parse of root-policy.ts in
// extractBoundedTopLevelStaticLiteral. The function parses the same source up
// to ~11 times per verifyS1Structure call (once per propertyPath); caching
// collapses these into 1 parse per distinct source. Few distinct sources are
// ever parsed (root-policy.ts + occasional test mutations), so a small cap
// suffices.
export const DEFAULT_STATIC_LITERAL_PARSE_CACHE_MAX_ENTRIES = 64 as const;

// Filesystem-backed static-literal EXTRACTION cache cap. The in-memory
// parse cache (above) stores non-serializable Babel AST nodes, so it is
// per-process and NOT shared across the serial-phase processes. The
// filesystem cache stores the EVALUATED extraction result
// (StaticLiteralExtraction — a JSON-serializable { ok, value? }) keyed by
// the content hash + bindingName + propertyPath + freezeBoundary hash +
// identifierBindings hash. The first process to extract a given (source,
// binding, path) tuple computes + writes; the rest read the cached result
// instead of re-parsing root-policy.ts with Babel. This collapses the
// ~11 extractions per verifyS1Structure call across the ~10 serial
// processes (~110 Babel parses) to ~11 computes + ~cache hits. Best-effort:
// a filesystem failure falls through to computation with no correctness
// impact. The cap bounds the cache directory size (FIFO eviction by mtime,
// amortized).
export const DEFAULT_STATIC_LITERAL_EXTRACTION_FILESYSTEM_CACHE_MAX_ENTRIES = 256 as const;

// ── workspace-manager.ts gate-output caps ──────────────────────────────────
// R49-V5: previously two scattered inline literals (`2048` and `2000`) in
// workspace-manager.ts. These cap gate-outcome text at the
// persistence boundary; the persisted bound stays well under the contract's
// 4096-char gate-output bound (owned by root-policy).

/** Cap one gate outcome's full text (reports, receipts). */
export const DEFAULT_MAXIMUM_GATE_OUTPUT_CHARACTERS = 2048 as const;
/** Persisted gate strings stay well under the contract's 4096-char bound. */
export const DEFAULT_MAXIMUM_PERSISTED_GATE_STRING_CHARACTERS = 2000 as const;

// ── R50: remaining scattered workflow caps ────────────────────
// Previously bare inline literals in workspace-cli.ts, test-inventory-binding.ts,
// and test-result-collector.ts with no owner.

/** workspace-cli git-runtime output byte cap (256 MiB). */
export const DEFAULT_GIT_RUNTIME_MAXIMUM_BYTES = 268_435_456 as const;
/** test-inventory-binding max reported violations (display cap). */
export const DEFAULT_MAX_REPORTED_VIOLATIONS = 20 as const;
/** test-result-collector assertion value truncation length. */
export const DEFAULT_ASSERTION_VALUE_MAX_LENGTH = 160 as const;
