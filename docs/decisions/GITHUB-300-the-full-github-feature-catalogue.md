---
id: GITHUB-300
date: 2026-10-21
by: user
group: github
status: in-force
implementation: pending
route: P3.1
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

What is missing: not built yet. The feature catalogue and the design are
written but not published in this repository; there is no merge queue (no
workflow runs on `merge_group`), no live check runs, no tracker projection and
no release train. The generated pipeline (P3.1) starts it.
