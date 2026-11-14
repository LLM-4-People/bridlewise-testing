---
schema: bridlewise-tracker-item/v1
published: false
id: BUG-GUARDIAN-FIXTURE-BYTE-OWNER
title: Preserve byte ownership in Guardian fixture snapshots
type: Bug
state: open
lane: floor
horizon: now
tests: [engine/test/filesystem/self-protection/guardian-build-stamp.test.ts, tests/prevention/raw-source-reader-owner.test.ts]
evidence: https://github.com/LLM-4-People/bridlewise-testing/pull/817
opened: 2026-11-14
---

Route Guardian fixture snapshots through their existing bounded tree and byte owners. The CI guard in `tests/prevention/raw-source-reader-owner.test.ts` flagged `engine/test/filesystem/self-protection/guardian-build-stamp.test.ts`: its existing exact Makefile declaration mutations and newly added direct build-directory enumeration jointly entered the file-level raw-source matcher universe.

Use `listSafeRepositoryTree` and `readSafeRepositoryFile` for the complete native fixture snapshot, preserving file identity, exact-byte hashes, the directory timestamp witness and before/after acquisition checks. Keep the portable declaration mutation unchanged; a JavaScript source view cannot stand in for original Makefile data.

Qualification must show the original real-tree guard failure, the corrected whole guard and native fixture owner tests, and a paired regression that keeps the direct byte-read, match and enumeration combination refused while the canonical fixture acquisition retains its owners. The production guard and its allowlist retain their current semantics.

This item remains open until the follow-up source and evidence are independently qualified. It records a deterministic tree violation; it grants no flaky-failure explanation or landing clearance. Caller-owned TMPDIR admission remains a separate CI consumer obligation.
