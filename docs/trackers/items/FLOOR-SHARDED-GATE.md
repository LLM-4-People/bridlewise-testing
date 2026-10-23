---
schema: bridlewise-tracker-item/v1
published: false
id: FLOOR-SHARDED-GATE
type: Task
title: Activate the sharded full-suite gate
state: closed
resolution: completed
lane: floor
opened: 2026-10-20
closed: 2026-10-20
---

`.github/workflows/test-shards.yml` is now a reusable workflow called by the `shards` job in `.github/workflows/ci.yml` on every push and pull request to `main`; the merge refuses a failed shard or a union that is not the manifest exactly once, and uploads `test-shard-receipt`. The dispatch path and runner choice remain. The local two-shard sample and the refusal arms are recorded in [the evidence page](../../floor/evidence.md#the-sharded-gate).
