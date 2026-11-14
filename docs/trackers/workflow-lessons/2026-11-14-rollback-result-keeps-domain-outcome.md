---
id: L-2026-11-14-rollback-result-keeps-domain-outcome
date: 2026-11-14
source: rollback command caller audit
kind: guard
status: acted
acted_in: [engine/src/timeline/rollback.ts, engine/src/timeline/timeline-types.ts, engine/test/timeline/rollback.test.ts, engine/test/workflow/harness-commands-cli-fixes.test.ts]
---

## Observation

The rollback controller recorded a failed terminal when restorations failed but returned only counts and a plan. The command envelope did not infer failure from those domain-specific counts. Real local timeline fixtures reproduced passing public envelopes for failed and partially failed rollbacks.

## Lesson

An operation's result must expose its execution verdict from the owner that judges its effects. Command adapters can consume that existing verdict without inventing numeric failure heuristics or interpreting historical reports as current failures.

## Change

The rollback controller computes one success verdict, uses it for the existing terminal outcome, and returns it through the shared RollbackResult type. The existing command envelope consumes that verdict. The persisted terminal schema and result-hash projection are unchanged. Public API tests cover failed, partial, successful, skipped-only and empty executions, preserving original records, chain integrity and historical listing behavior.
