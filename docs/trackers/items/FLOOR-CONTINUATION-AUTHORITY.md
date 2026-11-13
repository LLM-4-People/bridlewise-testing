---
schema: bridlewise-tracker-item/v1
published: false
id: FLOOR-CONTINUATION-AUTHORITY
type: Task
title: Enforce one authoritative continuation home and lossless recovery
state: open
lane: floor
opened: 2026-11-13
---

Declare one private coordination home for the current plan, instructions, task ownership, progress, evidence references and handoffs. Mechanically discover and reuse it before creating another location, maintain it as work changes, and refuse ambiguous or stale routing. Product tasks remain in their existing structured records and projector; private coordination references those owners rather than duplicating their semantic state. Generate current-entry pointers from the declared authority so moved or superseded locations cannot silently remain the entry point.

Preserving and adopting 32 continuation notes is useful progress. It does not establish complete historical accounting, reliable discovery, enforced maintenance or lossless recovery. Reconcile every conversation and child-task obligation with later instructions, current implementation and verified results. Retain superseded and rejected chains and explicit gaps; do not execute an old plan merely because it was recovered. A handoff must preserve goals, completed work, unfinished source and index custody, review and check status, blockers, dependencies and the next safe action. Test interrupted handoff and recovery, stale or missing pointers, conflicting homes, partial adoption and unavailable evidence without silently dropping work or declaring completion from inventory counts.

Repair the stale routing in [UR-22](../../decisions/UR-22-the-coordination-branch.md) through its existing decision owner, and align [REC-DIR](../../decisions/REC-DIR-useful-recovery-records-live-in-the-repository.md) with the declared private coordination boundary and public product records. Preserve the one-owner rule in [UR-16](../../decisions/UR-16-one-thing-for-everything.md). Keep private home names, paths, digests and transcripts out of public tracker records; credentials remain excluded under [D-09](../../decisions/D-09-credentials-never-in-repository-records.md). Evidence retention follows [EVD-STORE](../../decisions/EVD-STORE-raw-evidence-in-a-content-addressed-store.md).

Close this item only after the authority, generated entry points, creation and reuse checks, ongoing maintenance, complete handoff and recovery behavior are implemented and independently verified. The present note adoption and home inventory do not close it.
