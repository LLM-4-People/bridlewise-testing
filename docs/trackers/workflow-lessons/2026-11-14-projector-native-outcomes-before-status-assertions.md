---
id: L-2026-11-14-projector-native-outcomes-before-status-assertions
date: 2026-11-14
source: projector subprocess termination in Engine CI for pull request 810
kind: tooling
status: acted
acted_in: [engine/test/forge/projector.test.ts]
---

## Observation

A subprocess status assertion reported null instead of zero without preserving the signal, spawn error or execution phase. The missing native outcome facts prevented the failure from being distinguished from bootstrap, signal and resource failures.

## Lesson

Preserve the native outcome before asserting success. Diagnostics must describe what was observed and retain unknowns rather than infer a memory failure from the test's name.

## Change

The existing accepted projector diagnostic records native child status, signal, error and available phase facts in assertion context. The cap, admission path and success assertions remain unchanged. PROJECTOR-NATIVE-TERMINATION stays open: this observability change does not establish the original CI cause or clear its failure.
