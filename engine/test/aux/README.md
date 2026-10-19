# aux

The `engine/test/aux/` folder of the development surface.

## What each file does

- `awareness.test.ts` — eXP430 — Awareness module tests.
- `unreachable-catch-checks.test.ts` — unreachable-catch check + code-health aggregate tests.
- `learning-benchmark.test.ts` — auto-learning benchmark (rounds, plateau, false positives, performance).
- `lint-rule-checks.test.ts` — lint-rule checks: each fires on a known-bad snippet and not on the cleaned-up form.
- `exposure.test.ts` — eXP430 — shared exposure system tests.
- `learning.test.ts` — eXP430 — Learning module tests.
- `quality.test.ts` — eXP430 — Quality module tests.
- `safety.test.ts` — eXP430 — Safety module tests.

## Where it lives and what consumes it

The folder lives at `engine/test/aux/`.
