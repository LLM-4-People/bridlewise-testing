---
id: L-2026-11-14-admit-projector-linking-inside-owned-release
date: 2026-11-14
source: projector admission-order control and Engine CI for pull request 810
kind: tooling
status: acted
acted_in: [engine/src/workflow/forge/projector/confined.ts, engine/test/forge/projector.test.ts]
---

## Observation

The projector linked its modules before obtaining its admitted run hold. That preparation could run outside the declared admission boundary, and a linking exception occurred before the existing owned release/error path. A non-allocating control through the real adapter distinguishes the old order from the repair by observing the actual admitted hold at linking.

## Lesson

Admission must precede the work it bounds, including fallible preparation. Keep that preparation inside the existing owner's release/error path so the original exception and cleanup remain observable. An ordering repair does not establish a separate historical kill cause or prove the lifetime of an OOM observer.

## Change

confinedCall obtains the admitted hold before linkProgram, and linking runs inside its existing owned release/error handling. The new guard checks admission at linking, exact exception preservation and registry release; no parallel admission owner or cap increase is introduced. The original memory case and its assertions remain unchanged. The broader surviving-owner/delegated-child goal and the retained SIGKILL cause remain open under PROJECTOR-NATIVE-TERMINATION.
