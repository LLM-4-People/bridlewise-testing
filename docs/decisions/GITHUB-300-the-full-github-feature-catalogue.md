---
id: GITHUB-300
date: 2026-10-21
by: user
group: github
status: in-force
implementation: partial
route: P3.1
acted_in: [.github/workflows/ci.yml, .github/workflows/codeql.yml, engine/src/workflow/gates/catalogue.ts]
covers: [GITHUB-500]
---
# GitHub as an active part of the harness: the full feature catalogue

Using a few GitHub features by habit leaves useful ones unused and lets
others be adopted without thought. So every GitHub feature is looked at on
purpose: adopted with a concrete use, or rejected with a stated reason, and
GitHub becomes a working part of the harness rather than a place code is
stored.

The user, 2026-10-21: "actually, push github at 300%", then "actually, push
github at 500%".

- Go through the full GitHub feature catalogue: adopt each feature with a
  concrete use or reject it with a reason. Reliable features only
  ([UR-17](UR-17-no-fallbacks.md)).
- GitHub becomes an active part of the harness: the merge queue as the door,
  live check runs, a projection of the tracker, self-updating pull requests,
  attested reviews, release trains and a live dashboard.
- (500%) Four parallel deep-research tracks (security and supply chain;
  public progress automation; CI, merge queue and reuse; topology, docs,
  development containers, packages and APIs) feed one architect, who keeps one
  coherent design.

## What is live (checked 2026-10-21, not asserted)

- **The merge queue is the door to `main`.** The repository ruleset `trunk`
  (id 25593191) is `active` on the default branch with a `merge_queue` rule
  (merge method `MERGE`, grouping `ALLGREEN`, up to 4 entries merged per
  group). The same ruleset requires a pull request (review threads resolved),
  refuses deletion and non-fast-forward pushes, and requires five checks:
  `Typecheck, public tests, build`, `Secret and privacy scan`,
  `Relative Markdown links`, `Analyze JavaScript and TypeScript
  (javascript-typescript)` and `Full suite shards / Merge one qualification
  receipt`. Check it yourself:
  `gh api repos/LLM-4-People/bridlewise-testing/rulesets/25593191`.
- **The checks run in the queue.** `ci.yml` and `codeql.yml` run on
  `merge_group` (pull request #43, merged as `805c43ea`). Both are generated
  from the gate catalogue, whose lint refuses a gating workflow that skips
  the queue. The secret scan, the docs links and the suites' shards are gates
  of `ci.yml` (pull request #67).
- **Release tags are protected** by the ruleset `protect-release-tags`
  (id 25439901, `active`).

## What is missing

- The feature catalogue (every GitHub feature adopted with a use or rejected
  with a reason) is written in the design but not published here.
- No live check runs of the harness's own, no projection of the tracker, no
  release train and no live dashboard yet (P3–P5).
- The workflows are still hand-written; the generated pipeline (P3.1)
  replaces them.
