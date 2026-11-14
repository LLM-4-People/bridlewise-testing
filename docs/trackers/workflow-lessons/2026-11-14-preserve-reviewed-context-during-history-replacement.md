---
id: L-2026-11-14-preserve-reviewed-context-during-history-replacement
date: 2026-11-14
source: reviewed checkout-context source and published commit custody
kind: process
status: acted
acted_in: [engine/src/process/environment-projection.ts, engine/test/process/environment-projection.test.ts]
---

## Observation

Checkout qualification discarded the user-manager routing used by management processes. Its reviewed fix shared those context names at the existing environment projection owner. The original published change could not satisfy commit-record gates, while its working tree also held unfinished identity-profile work.

## Lesson

Recover reviewed source from committed objects and preserve unfinished files, the index and recovery references before an authorized replacement. Quarantine and a new native commit must use the normal workflow; replacing a pull request does not waive source checks or inherited failures.

## Change

Checkout-command inheritance now reuses the same user-manager context group as systemd launch inheritance. Model commands retain their narrower environment. The regression covers absent and partial context while rejecting credentials and lock-token authority. The replacement carries only that reviewed context fix; the unfinished identity profile remains preserved under its prior owner.
