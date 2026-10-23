/**
 * THE TEST RUN'S HANG BOUNDS — one owner, read by the vitest config AND by
 * the watchdog that wraps it (`scripts/run-tests.ts`). Both end a HANG; neither
 * judges how long a test takes, which is CPU work's question (NO-LOAD-BLOCK).
 *
 * ── WHY THERE ARE TWO NUMBERS AND NOT ONE ──────────────────────────────────
 *
 * They defend against different failures, and the second exists because the
 * first provably cannot cover its case.
 *
 * `TEST_HANG_BACKSTOP_MS` is vitest's own per-test limit. It works against an ASYNC
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

import { readTestHangBackstopMs } from "./helpers/budget-config.ts";

/**
 * Per-test and per-hook WALL bound: the HANG BACKSTOP, and nothing else.
 *
 * It ends a test that never settles (an async hang: a promise that never
 * resolves, a timer that never fires). It does NOT police slowness: that is
 * judged in CPU WORK, per test, by its file's class
 * (`testExecution.testCpuClasses`, `tests/setup/test-cpu-class.ts`), because
 * a busy host makes a test wait for a core, not do more work (NO-LOAD-BLOCK).
 * It used to be a 30 s wall limit, and that limit was the judgement: on
 * hosted runners `declared-pattern-liveness` hit it at 17-30 s of wall while
 * other lanes' PRs went red for code they did not touch. The value is
 * `testExecution.testHangBackstopMs`, below the stall watchdog's bound so a
 * hung test is named before its run is killed.
 */
export const TEST_HANG_BACKSTOP_MS = readTestHangBackstopMs();

/** What a test holding one nested launch adds to {@link NESTED_RUNNER_LAUNCH_MS}: its own assertions and the fixture's writes. */
export const NESTED_RUNNER_TEST_MARGIN_MS = 15_000;

/**
 * ONE NESTED REAL-RUNNER LAUNCH's bound — a test that starts a whole vitest
 * run as its child (the isolation witness, `tests/helpers/vm-isolation-witness.ts`).
 *
 * A HANG BACKSTOP like the test's own, and derived from it: a launch is hung
 * only when the test holding it would be. It sits
 * {@link NESTED_RUNNER_TEST_MARGIN_MS} below {@link TEST_HANG_BACKSTOP_MS},
 * so the nested bound fires first and a hung launch's failure carries the
 * child's output, never a bare timeout. (It was a 60 s wall bound, measured
 * at 13.9 s idle and 30.5 s at a load of 42-52: the load, not the work, set
 * it.)
 */
export const NESTED_RUNNER_LAUNCH_MS = TEST_HANG_BACKSTOP_MS - NESTED_RUNNER_TEST_MARGIN_MS;

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

