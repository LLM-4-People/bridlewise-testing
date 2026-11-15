---
schema: bridlewise-tracker-item/v1
published: false
id: FLOOR-SUITE-CALIBRATED-CAP
type: Task
title: Bring the supported suite under the calibrated-work cap
state: open
lane: floor
owner-role: engine performance
blocked-by: [RISK-NO-CALIBRATED-JUDGED-RUN]
opened: 2026-10-20
---

Owns the remaining CPU accounting, calibration and measured-floor work for `testExecution.integrationSuiteCpuBudget` and `testExecution.webUiSuiteCpuBudget`. The engine performance owner coordinates the shared `engine/src/shared/run-cpu.ts` measurement owner and its measuring tools. This is corrective work with an acceptance condition, not permission to raise a cap or accept a new failure.

### Current work

The shipped baseline still uses the historical `calibrated-work/v1` machinery. Corrections for `calibrated-work/v2` and the shared measuring tool have been reviewed locally, but their complete source integration, initial floor adoption and all-load validity proof remain pending. A source component's review does not qualify the integrated suite or adopt an operator floor. Keep this item open through that remaining work.

Use the shared measurement declarations and their measuring tool as the authority for the current metric, sample eligibility, cohort size, progress and derived floor. Do not copy a fixed sample count into this task, reinterpret old readings as a new metric, edit generated numeric fields, inflate a ceiling, exclude busy-host observations or wait for lower host load. Retain every failed, refused and unjudged observation with its original meaning.

### Acceptance

Integrate and independently verify the shared measurement source, registry and tools at one qualified source revision. Through the measuring tool, establish an eligible cohort bound to that revision and declaration generation, with complete suite censuses and terminal evidence, then derive and verify the floor through the declared write operation. Prove that the current metric and the consumers of both budget declarations agree, including supported host-load conditions, and retain any unproved validity condition as open work. Closure requires the corrective source on `main` and the required integrated qualification and floor-adoption evidence. A non-worse comparison of one run alone is not that closure evidence.

### Historical evidence

The 2026-10-20 record measured 2124.7 and 2183.7 ms/file against a 2032.2 ms/file cap in retired `raw-cpu-ms/v0`, without calibration readings. The older 1926 ms/file floor at 521 files was recorded as incomparable. Neither set of values converts into a current calibrated floor. That record also described an initial twelve-run `calibrated-work/v1` campaign and a four-file subset experiment; those are historical observations, not the present cohort requirement or an all-load qualification. The original evidence remains in `docs/floor/evidence.md`.
