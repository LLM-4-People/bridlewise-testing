---
id: L-2026-11-13-intentional-command-stops-are-not-retryable
date: 2026-11-13
source: normal validation ceiling and cooperative cancellation outcomes
kind: guard
status: acted
acted_in: [engine/src/workflow/checkout-setup.ts, engine/src/kernel/config-contracts.ts, engine/src/shared/exposure/registrations/harness-commands.ts, engine/src/workflow/promotion/apply.ts, engine/test/workflow/working-copy.test.ts, engine/test/workflow/checkout-cancellation.ts]
---

## Observation

A cooperative stop was classified as an environmental error and scheduled another attempt. A later normal validation hit its command ceiling and the same runner retried it unchanged. Keeping cancellation separate fixes one case, but every failure must remain visible instead of being replaced by a later pass.

## Lesson

Preserve the first command outcome at the existing execution owner. Keep cancellation, infrastructure errors and command failures distinct for diagnosis, with their native evidence. A new attempt needs a changed cause. Retire configuration controls when their policy is removed, and reject obsolete values rather than accepting settings that have no effect.

## Change

The shared runner returns one native attempt. The witnessed-stop classification and its graceful-shutdown control remain intact; ceilings, signals and environmental diagnostics retain their error meaning without scheduling more work. Regression controls verify physical attempts, first failure evidence and fail-fast phase behavior. The two former retry settings are removed from writable exposure and refused by the strict configuration schema, while a read-only signal states the effective policy. Promotion bounds count every possible invocation at its execution owner, including repeated direct entries, separate phases and distinct lockfile transforms; memoization may only reduce actual work.

Acted in the shared checkout runner, its aggregate consumers, and the configuration and exposure owners. The focused engine owners (214 tests), root exposure checks (15 tests), engine source/test typechecks and root test typechecks passed. Controlled regressions caught repeated attempts, invocation undercounts, lost cancellation classification and inherited test-worker protocol context. The ordinary driver preserves unrelated inherited environment values.

Cancellation with an absent receipt, cross-operation cancellation and initial command efficiency remain separate work. This does not qualify a full suite, budget, deployment or publication.
