---
id: L-2026-11-15-native-git-authority-is-explicit
date: 2026-11-15
source: GitHub Projects projection source-identity dependency review
kind: guard
status: acted
acted_in: [engine/src/git/repository-ownership.ts, engine/src/git/tree-reader.ts, engine/test/git/tree-reader.test.ts]
---

## Observation

Git can present replacement objects, grafted ancestry or shallow boundaries
while a projection needs the identity of committed source. A configured
executable and timeout alone do not select that object interpretation.

## Lesson

Give consumers one explicit native view through the existing Git reader.
Apply its context after caller environment additions, and preserve the
ordinary view for consumers that deliberately need ordinary Git semantics.

## Change

The canonical repository-ownership owner supplies the native environment;
the existing tree reader exposes an immutable native repository wrapper.
Real hostile-view controls compare both interpretations, refuse missing
native parents, and check that an attempted optional-lock override cannot
refresh the index. The Projects host will compose this wrapper at its
existing configuration root after this predecessor is normally published.
