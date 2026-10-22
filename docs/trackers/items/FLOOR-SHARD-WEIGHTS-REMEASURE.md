---
schema: bridlewise-tracker-item/v1
id: FLOOR-SHARD-WEIGHTS-REMEASURE
type: Task
title: Re-measure the shard weights at the manifest's own head
state: closed
resolution: completed
lane: floor
opened: 2026-10-20
closed: 2026-10-20
---

closed 2026-10-20 at `f54df4a5`. CI run `39470087124`'s `test-shard-receipt` artifact measured the ten `ubuntu-24.04` shards over 523 files and 8734 tests (8734 passed, 0 failed, 0 skipped): `testPhaseMs` 83438, `testPhaseCpuMs` 658687, shard walls 49566–81359 ms (max/min **1.64x**). The heavy shard was 8 (81359 ms, 53 files; `promotion-boundary` 29003 ms, `subprocess-confinement-owner` 22641 ms, `content-search-deadline` 11618 ms, `redaction-reaches-provider` 9362 ms); the light shard was 4 (49566 ms, 52 files, 579 tests). The checked-in weights from `0ba57912` predicted 1.00x, so the imbalance was stale measurement, not the assignment: the run's per-file `endTime - startTime` differed from the checked-in weight by 0.052x–10.47x and the weight sum fell from 1487347 ms to 798882 ms (1.86x). Re-derived through the manifest owner (`node scripts/test-shard-manifest.mjs measure --manifest tests/test-shards.json --head f54df4a5… --runner ubuntu-24.04 --out tests/test-shards.json` over the ten `test-shard-report-*` artifacts), which rewrote all 523 weights and `measuredHeadSha`; the new plan predicts 79888–79889 ms per shard (1.00x). The after wall spread is not measured: the run had at most three concurrent files, and packing the same file durations into three slots per shard gives a 26630–39967 ms critical path (1.50x) because `test-isolation-contract` alone costs 39967 ms; the next receipt confirms the wall, and splitting that file is the remaining lever. MEASURED 2026-10-20 (CI run 39471843640 on 9c4526e7, artifact test-shard-receipt): the walls did NOT improve — 45184–79817 ms, max/min 1.766x against the previous 1.641x, same 523 files and 8734 tests, all green. The weights are now truthful (the own-measure path rewrote all 523), but summed file cost is not wall time: setup, collection and per-file overhead are not in the weights, so balancing the sums cannot balance the walls. The open work is therefore wall-aware packing or per-shard overhead accounting (or splitting test-isolation-contract), not another weight edit — the weights themselves are measured and owned.
