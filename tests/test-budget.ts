/**
 * THE TEST RUN'S TIME LIMITS — one owner, read by the vitest config AND by
 * the watchdog that wraps it (`scripts/run-tests.ts`).
 *
 * ── WHY THERE ARE TWO NUMBERS AND NOT ONE ──────────────────────────────────
 *
 * They defend against different failures, and the second exists because the
 * first provably cannot cover its case.
 *
 * `TEST_TIMEOUT_MS` is vitest's own per-test limit. It works against an ASYNC
 * hang: a promise that never settles, a timer that never fires, a request
 * with no response. The event loop is still turning, so the timer that kills
 * the test can actually run.
 *
 * The STALL WATCHDOG is enforced OUTSIDE the runtime, by `scripts/run-tests.ts`,
 * and it is the only layer effective against a SYNCHRONOUS spin. This is the
 * part that is easy to get wrong: a `for` loop with no exit blocks the worker,
 * and a blocked worker cannot run the timer that would interrupt it. No
 * in-runtime timeout — not `testTimeout`, not `hookTimeout`, not an
 * `AbortSignal` — can help, because every one of them is a callback waiting
 * for a turn on a loop that will never yield again. Only something that does
 * not need the hung process to cooperate can end it, which means a different
 * process holding a clock and a PID.
 *
 * MEASURED, not hypothetical: six orphaned vitest workers ran
 * `artifact-runtime-errors.test.ts` at ~102% CPU each for up to 1h16m after
 * the run that spawned them had finished — about 600% of a 12-core machine —
 * because a mutation raised a cap and turned `for (i < CAP + 3)` into a spin.
 * They corrupted every measurement taken that day.
 */

/**
 * Per-test and per-hook limit.
 *
 * Generous on purpose. The slowest legitimate tests here mount Svelte
 * components in jsdom and walk the whole source tree; the point of this
 * number is to end a HANG, not to police slowness, and a tight value would
 * turn a loaded machine into a red suite. Slowness is the budget reporter's
 * job (`tests/reporters/budget-reporter.ts`), which ratchets against the
 * measured wall of the previous run.
 */
export const TEST_TIMEOUT_MS = 30_000;

/**
 * ONE NESTED REAL-RUNNER LAUNCH's bound — a test that starts a whole vitest
 * run as its child (the isolation witness, `tests/helpers/vm-isolation-witness.ts`).
 *
 * MEASURED (2026-09-29, this 12-core host, the witness's first launch): 13.9 s
 * idle, 25.1 s at a 5-minute load of ~24, 30.5 s at 42-52. A bound equal to
 * {@link TEST_TIMEOUT_MS} left no headroom: the suite's own load pushed a
 * launch past it and the arm went red (a4-correctness N-2). The bound is
 * twice the worst launch measured; the test around a launch takes
 * {@link NESTED_RUNNER_TEST_MARGIN_MS} more, so the nested bound always fires
 * first and the failure carries the child's output, never a bare timeout.
 */
export const NESTED_RUNNER_LAUNCH_MS = 60_000;
/** What a test holding one nested launch adds to {@link NESTED_RUNNER_LAUNCH_MS}: its own assertions and the fixture's writes. */
export const NESTED_RUNNER_TEST_MARGIN_MS = 15_000;

/**
 * The watchdog's settings (`testExecution.webSuiteWatchdog` in
 * `bridlewise.config.json`, read by `tests/helpers/budget-config.ts`).
 *
 * It used to be a fixed 180 s KILL: measured against idle runs (~31–42 s),
 * it fired on a loaded shared machine and turned a healthy, slow run into a
 * red one. A spin and a slow run differ in one observable: a spinning suite
 * stops PRINTING. So the kill is a STALL (no output for `stallTimeoutMs`),
 * plus a HARD CEILING (`hardCeilingMs`) that ends even a run printing
 * forever, whatever the load. There is no wall-clock VERDICT: whether the
 * suite got slower is the CPU budget's question (`webUiSuiteCpuBudget`, with
 * its ambient-load model) — a second, load-sensitive wall-clock gate judged
 * the machine and hid regressions behind "unmeasurable" (wf1a-design M-1).
 * Its shape is the engine suite's (`SuiteWatchdog`,
 * `engine/src/workflow/workflow-config.ts`): the same schema serves both.
 */

