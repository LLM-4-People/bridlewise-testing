---
id: TEST-CPU-CLASSES
date: 2026-10-22
by: coordinator
group: process
status: in-force
implementation: partial
route: NOLOAD (engine suite next; the web suite's per-test overrides next)
acted_in: [engine/scripts/tooling/test-cpu-class.ts, tests/setup/test-cpu-class.ts, tests/test-budget.ts, vitest.config.ts, engine/src/kernel/config-contracts.ts, engine/bridlewise.config.json]
---
# Per-test limits are CPU-work classes plus one hang backstop

A per-test wall timeout judges the machine, not the test: a busy host makes a
test wait for a core, it does not make it do more work. On 2026-10-22 the web
suite's required shard 2 went red on pull requests that never touched the
failing test (`declared-pattern-liveness`, 17-30 s of wall against a 30 s
wall limit). The cause was CPU work (it re-ran the whole public suite, ~32 s
of CPU), and a wall limit could not tell that from a loaded runner. This
carries out [NO-LOAD-BLOCK](NO-LOAD-BLOCK-nothing-is-blocked-by-cpu-load.md)
(audit L2, row G-05) for per-test limits, under
[Q-TX2](Q-TX2-budgets-count-cpu-work.md).

- **The judgement is CPU work.** Each test's CPU (its process, every thread,
  and every child it reaped) is read by the one in-repo reader
  (`engine/src/shared/run-cpu.ts`) and judged against its file's class:
  `testExecution.testCpuClasses` declares `defaultCeilingMs` and named
  classes, each listing the files it holds, once, for both suites. A test
  over its ceiling fails with the work it did and the ceiling it broke. Wall
  time is recorded beside it and never judged. An unreadable reading is a
  refusal, never a pass.
- **The numbers were measured.** A full web-suite run (7,270 tests,
  2026-10-22, 12-core host) put every test at or under 15.2 s of CPU work
  except `test-isolation-contract`'s nested runner launches (up to 30.1 s).
  The default ceiling is 60 s (hosted runners spent about 1.3 times this
  host's CPU on the same test); the `nested-runner` class holds
  `test-isolation-contract` at 180 s.
- **One judgement, installed by each runner's door.**
  `engine/scripts/tooling/test-cpu-class.ts` holds it; the web suite installs
  it from `tests/setup/test-cpu-class.ts` (the reading is kept on each test
  as `meta.cpuMs`/`meta.wallMs`).
- **Wall time survives only as one hang backstop.**
  `testExecution.testHangBackstopMs` (600 s) is vitest's `testTimeout` and
  `hookTimeout`; a test that reaches it is reported as `hung`, with the CPU
  work it had done, and is never retried. It sits below the web stall
  watchdog's bound (`webSuiteWatchdog.stallTimeoutMs`, raised to 900 s), so a
  hung test is named before its run is killed. A nested runner launch's bound
  derives from it (`tests/test-budget.ts`).
- **A per-test timeout written in a test file is a wall judgement** and
  leaves the tree: the web suite's are removed in the follow-up, after which
  a guard refuses new ones; the engine suite's per-test kill timeout
  (`runtimeBudgetMs`) becomes the same backstop with the same classes.
