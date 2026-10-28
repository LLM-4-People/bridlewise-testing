---
id: GEN-AGGREGATES
date: 2026-10-28
by: coordinator
group: process
status: in-force
implementation: partial
route: GH-563
acted_in: [engine/src/architecture-modules.ts, engine/src/workflow/module-registrar.ts, engine/src/kernel/test-surface-manifest.ts, engine/scripts/tooling/verification/artifact-admission.ts, engine/scripts/verification/ratchet-baselines.ts, engine/src/workflow/promotion/tree-kind.ts, engine/test/prevention/adding-modules-merges.test.ts]
---
# No generated aggregate that two independent changes both rewrite

The merge queue dropped pull requests that touched unrelated code because
every branch rewrote the same committed generated aggregates (the
architecture manifest's per-module export counts and name hashes, the
artifact inventory's digests, the test-surface dispositions' whole-file
hash, the README consumer blocks), and the queue cannot regenerate them.

- **Derive at check time, or commit one line per decision.** What the tree
  says is derived when it is checked (the module census, the effective test
  dispositions, the artifact manifest); only decisions are committed, one
  line each, sorted, holding only what differs from the default. Two
  branches that add different modules change only their own files
  (`adding-modules-merges.test.ts` measures it with git's own three-way
  merge).
- **A silent default never passes.** `harness check` runs the derived
  architecture judge (S1's structural verifier over the census) as the
  shrink-only ratchet `architecture-judge`: every finding kind the judge
  emits is classified by name, gated or shown under the check that owns it,
  and a kind nobody classified is refused. Its baseline lives at a fixed
  path in code, shrinks only (judged against the base in the required job,
  by finding id, the same judgement as the commit guard), and is required in
  every tree but the declared product.
- **The product is a declaration, not an absence.** The product projection
  carries `TREE-KIND.txt` from the overlay; a tree is the product only with
  the declaration and none of the testing floor's facts (the judge, the
  baseline, `tests/`, `engine/test/`, the promotion profiles). A declaration
  beside any of them is refused and the gate runs.

**Accepted residual.** A change that deletes EVERY testing-floor fact (the
test trees, the promotion profiles, the judge — about 1,400 files) and adds
the declaration turns the gate off. It is accepted: the `Test-deleted:`
trailer rule refuses that deletion once `Commit records` is a required
check (#537), and no review would pass it.
