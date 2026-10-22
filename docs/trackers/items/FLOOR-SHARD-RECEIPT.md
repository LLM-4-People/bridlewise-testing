---
schema: bridlewise-tracker-item/v1
id: FLOOR-SHARD-RECEIPT
type: Task
title: Publish the full supported-set shard receipt
state: closed
resolution: completed
lane: floor
opened: 2026-10-20
closed: 2026-10-20
---

CI run 39439338300 at `3b4db454` ran the matrix on a push: the plan, ten `ubuntu-24.04` shards (521 files, 8722 tests, 8722 passed, 0 failed, 0 skipped), and the merge all succeeded, and the merge job uploaded the `test-shard-receipt` artifact described in [the evidence page](../../floor/evidence.md#the-sharded-gate). This supersedes the prose-only d47909de receipt. The artifact records `testPhaseMs` 88000 but no same-commit single-host baseline, so it does not re-derive the 2.81x factor; the roadmap's 10x exit line remains open.
