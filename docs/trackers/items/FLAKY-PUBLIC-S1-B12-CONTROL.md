---
schema: bridlewise-tracker-item/v1
published: false
id: FLAKY-PUBLIC-S1-B12-CONTROL
type: Flake
state: open
lane: flaky-burn-down
opened: 2026-10-20
---

public re-owning of `FLAKY-S1-B12-CONTROL`; **needs private history, still owned**. The identity is `engine/test/s1-scenarios/b12.test.ts` `S1-B12-CONTROL`; the file is green at HEAD, but the private floor records a vacuous-pass race in the control (it calls `verifyS1Structure(REPOSITORY_ROOT)` on the live checkout and asserts only that no `universal-policy-*` violation is listed, while a manifest walk that meets an unreadable entry, a symlink or a hardlink can return early before that check), and no fix has been made. The public attempt `engine/traceability/flake-reproductions/attempts/e5f2e977b5b00eb82939d0b57a4bc05e88f35f79ca19ccb24c1c165b757dfbd9.json` (recorded 2026-10-10T14:03:33Z) refused this identity: "on the parent it failed 4 and passed 1 of 5 run(s) (9833610b600dec8b ×4): a deterministic reproduction fails every run — reproduce the condition with --statistical". No record names it. Missing artifact: the private statistical reproduction of the vacuous-pass condition (the 4-of-5 attempt) plus the control's walk-safety fix; the focused green is not a fix. The same file's `S1-B12-FAILURE` arm is a different identity, disposed with `FLAKY-PUBLIC-ENGINE-ONE-RUN-2026-10-09`. Guarded by `engine/test/prevention/flaky-test-memory.test.ts`.
