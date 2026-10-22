---
schema: bridlewise-tracker-item/v1
id: FLAKY-PUBLIC-WEB-WATCHDOG-C3
type: Flake
state: open
lane: flaky-burn-down
opened: 2026-10-20
---

**canonical owner after merging the duplicate `FLAKY-WATCHDOG-C3` row; still owned.** Covers `tests/prevention/test-run-watchdog.test.ts` C3. The recorded red (2026-10-20T11:44:16Z) is `expected 70 to be +0`; 70 is `PROCESS_FAULT_EXIT_CODE` (EX_SOFTWARE), so the nested focused wrapper faulted closed on an uncaught exception, an unhandled rejection or a guarded-callback fault. Reproduced with execution: a nonexistent `TMPDIR` drove the real wrapper to exit 70 with `error (process): uncaught exception … statfs` on stderr; the C3 arm then passed 10/10 focused runs at HEAD `25a446c3` and passed in the 11:50:26Z recorded full run. A scratch worktree at the recorded tree `b4dc6b33` ran the arm 30 times under a private TMPDIR: 28 green and two reds, the diagnosed one `ending: "stalled"` at 2.1s — the 1.5s watchdog killing the wrapper during startup, a different mode from the recorded exit-70. The prior 430 drives (400 wrapper, 30 real arms under load 11.5–15.4) and these 30 did not reproduce exit 70. Why the cause was never recorded: the old assertion printed the bare exit code; HEAD's assertion now prints `output.join("")`, so the next fault names its stack. Evidence that would close it: one recurrence under the recorded conditions (full web suite, 1-minute load ≥ 10, parallel files) whose failure message carries the fault line; its stack's throw site is the cause, then fix that owner and reproduce it under the door with the same conditions. A focused or partial run is not enough — the recorded red happened in a full run under load, and no accepted `engine/traceability/flake-reproductions/` record names this identity. Entry kept; nothing ages out. Guarded by `tests/prevention/flaky-test-memory.test.ts`.
