---
id: TEST-EFF
date: 2026-10-15
by: user
group: process
status: in-force
implementation: pending
route: TEST-10X
covers: [Q-TXL1, Q-TXL2, Q-TXL3, Q-TXL4]
---
# The test-efficiency decisions

The test suites, and each lab's own copy of the same tooling, had grown slow
and duplicated. These decisions make the work cheaper without weakening any
gate: one runner where there were several, reuse where it is proven safe, and
a fixed order so a known slowdown is fixed before it can become the baseline.

The user, 2026-10-15: "go as per your recommandations, but further optimize".

- **The web budget floor:** the web batch merges with the floor derived by the
  budget tool. Its known CPU regression is fixed in the web writer's next
  rounds, and the per-file CPU budgets
  ([Q-TX2](Q-TX2-budgets-count-cpu-work.md), [Q-TX4](Q-TX4-per-file-test-budgets.md))
  are seeded only after those fixes, so the regression is never frozen in.
- **Batched chat reads:** the product loads chats in one batched request; the
  performance check is revised on purpose, not loosened.
- **A worker's import of the guard** is loaded from its own small module.
- **Q-TXL1:** one mutation runner in the harness tooling, used by every lab
  (replacing their seven).
- **Q-TXL2:** the memory and browser labs reuse unchanged harness results
  under the reuse rules of [Q-TX1](Q-TX1-reuse-a-proven-deterministic-result.md).
- **Q-TXL3:** one owner per confinement property, settled at the sandbox
  transfer.
- **Q-TXL4:** sandbox attack fixtures already owned by a hostile test are
  removed once the mutation matrix proves they kill no unique mutant.
- **"further optimize":** every lane implements its efficiency worklist,
  ordered by saving per hour.

What is missing: not built yet in this repository: there is no shared
mutation runner, no cross-lab result reuse, and no per-file budget seeding.
