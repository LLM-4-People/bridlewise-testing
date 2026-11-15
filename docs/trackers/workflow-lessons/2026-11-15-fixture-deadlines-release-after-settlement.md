---
id: L-2026-11-15-fixture-deadlines-release-after-settlement
date: 2026-11-15
source: Intelligence farm fixture deadline review
kind: tooling
status: acted
acted_in: [engine/test/intelligence/process-farm.test.ts]
---

## Observation

A fixture that races farm work against a timeout can retain its timer after
the work settles. Matching an error message also mistakes an operation's
own failure for the fixture's deadline.

## Lesson

Use the shared bounded-lifetime owner and release the deadline in finally.
Identify the fixture's own timeout by its error identity, and observe actual
timer handles when checking cleanup.

## Change

The farm fixture uses the existing deadline and awaitWithSignal owners.
Controls cover success, synchronous and asynchronous failures, and a real
timeout while retaining the four existing real farm cases. This changes
fixture lifetime only; production worker ownership remains separate.
