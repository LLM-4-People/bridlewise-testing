---
id: HARNESS-DRIVES
date: 2026-10-10
by: user
group: user-rules
status: in-force
implementation: pending
route: GIT-AUTO
---
# The harness drives; the model is the passenger

Every step a program can do exactly and repeatably is a step a language model
can get wrong, and it costs the model attention it should spend on the actual
work. So whatever can be done deterministically is done by the harness, and
the model is left to create.

The user, 2026-10-10: "everything that can mechanically/deterministically be
done by the harness we should handle it, so llm can focus on creating."

- Git is an automated module: opening a folder that is not a repository runs
  `git init`, and EVERY agent action on a repository is committed or tagged
  automatically.
- Every design asks "can the harness do this deterministically?"; if yes, the
  model never has to. Retroactive.
- Project-specific harness data lives in the project's `.bridlewise/` folder,
  git-ignored (checkpoints included).
- Two consequences have their own records:
  [PARTIAL-FAILURE](PARTIAL-FAILURE-tools-merge-partial-corrections.md) and
  [TESTS-TEST-THEMSELVES](TESTS-TEST-THEMSELVES-a-test-must-fail-on-the-old-code.md).

What is missing: not built yet. `engine/src/git/workspace-lifecycle.ts`
can initialize an empty folder as a repository, but nothing calls it when a
project is opened, and no agent action is committed or checkpointed
automatically. The git-auto design carries it out.
