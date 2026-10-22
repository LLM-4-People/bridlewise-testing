---
schema: bridlewise-tracker-item/v1
id: FLOOR-SUITE-CALIBRATED-CAP
type: Task
title: Bring the supported suite under the calibrated-work cap
state: open
lane: floor
opened: 2026-10-20
---

the old raw-CPU row is SUPERSEDED, not rescaling its numbers. Two full runs on 2026-10-20 measured 2124.7 and 2183.7 ms/file against a 2032.2 ms/file cap, but those figures are in the retired `raw-cpu-ms/v0` unit: the runs were measured with NO calibration reading, so they are INCOMPARABLE with the current declaration and no arithmetic converts them. The red was the box, not the suite: the same tree moved to 2124.7 ms/file under load ~9-10 against the 1926 ms/file floor, and raw CPU is not invariant at saturation. The metric now judges calibrated work (`calibrated-work/v1`): each run pairs its CPU delta with a fixed start/end calibration benchmark (256 KiB working set, six fixed chunks, `--no-opt`, median chunk; `engine/src/shared/run-cpu.ts` `computeRunWork`) and judges `workUnitsPerTestFile = (runCpuMs / calibrationMs) / testFileCount` — computed once, read by the verdict, the reporter, the engine runner and the pages. The declaration is in ACCUMULATION (0 of 12 clean judged full runs); the retired 1926 ms/file at 521 files is recorded under `legacy` with `incomparable: true` and its two ledger rows carry no metric, so they never feed the new window. Next: run the full suite twelve times inside the instrument lock; `npm run budget:measure -- --check` must stop answering `migrating`, then the window's clean median is derived into the floor from the calibrated rows alone (later floors go through `npm run budget:measure -- --write`). Measured residual on a four-file/68-test subset (2026-10-20, 12-core WSL2): among runs inside BOTH declared bounds (drift <=15%, load5 <=1.7/cpu), units/file spread 1.1% and the eight-burner step +1.1%, against raw 7.0% spread and +7.3%; the two runs outside the drift bound (26.2% and 17.9% start/end drift) are DEFERRED, never judged. Evidence: `docs/floor/evidence.md`.
