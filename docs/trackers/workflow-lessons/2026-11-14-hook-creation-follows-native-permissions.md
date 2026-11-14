---
id: L-2026-11-14-hook-creation-follows-native-permissions
date: 2026-11-14
source: a normal full-validation attempt launched with the private evidence driver's restrictive umask
kind: guard
status: acted
acted_in: [engine/test/prevention/commit-move-guard.test.ts, engine/scripts/verification/shipped-hooks.ts]
---

## Observation

A guard expected a regenerated new hook to have full permissions 0755. The evidence driver launched validation with umask 077, and both the fixture's native creation and the existing atomic writer correctly produced 0700. The assertion confused requested creation permissions with the resulting native file permissions. No production permission change caused this failure.

## Lesson

A file-creation test should capture an independent native creation oracle under its actual process conditions. Do not duplicate umask arithmetic, force a permissive umask or chmod the product output to satisfy a fixture. Existing-file permissions and executable hook installation remain separate enforced contracts.

## Change

The existing shipped-hook fixture captures the native hook mode before deleting that hook and compares regeneration with that observed mode. It also checks that rewriting the remaining hook preserves its original permissions. Canonical content, stale detection, regeneration and installation guards remain intact. The owner comment states that requested creation permissions respect the process umask. Whole-file runs under both ordinary and restrictive masks provide portability evidence; complete milestone qualification remains a separate requirement.
