---
id: L-2026-11-14-qualification-inputs-use-their-owners
date: 2026-11-14
source: PR 817 qualification
kind: guard
status: pending
route: BUG-GUARDIAN-FIXTURE-BYTE-OWNER / BUG-FLAKY-MEMORY-INVENTORY-CACHE
---

## Observation

Guardian qualification exposed two different input defects. A fixture test acquired its own build-directory snapshot beside an existing exact-byte Makefile mutation, entering the raw-source reader guard. The LIVE flaky-memory guard also required an ignored inventory cache even though normal guard preparation does not create it. The cache removal's origin is unknown.

## Lesson

Qualification inputs must come through their existing owners with the provenance each claim needs. Exact artifact mutations need original bytes. Filesystem snapshots need bounded acquisition and stable identities. A current source-derived judgment must derive its authoritative projection without depending on an optional cache's presence. Keep independent failures and their evidence distinct.

## Change

The planned change routes Guardian fixture snapshots through the canonical bounded tree and byte readers and derives the LIVE flaky-memory consumer's suite projection through the existing inventory producer. Paired guard coverage, cache-present/cache-absent consumer coverage, whole affected owners and changed-head normal validation must qualify these changes before this lesson is marked acted. The current guard semantics, suspect judgments, runtime admission and prior failure records remain in force.
