---
id: GITHUB-ONLY
date: 2026-10-21
by: user
group: github
status: in-force
implementation: partial
route: P2.1
acted_in: [.github/workflows/ci.yml, .github/workflows/test-shards.yml, .github/workflows/pages.yml, tests/public/workflow-policy.test.mjs]
---
# GitHub is the only host

Work spread over two code hosts is work nobody can see in one place, with two
sets of permissions to secure and two copies that can disagree. So everything
moves to one host, GitHub, and the rules that protect it are enforced by
GitHub itself rather than by local scripts alone.

The user, 2026-10-21: "github should be the only repo, set it up as best as
possible, i need the ci, automation, the repos, the docs, all of it to be very
novel, smart, dynamic, one source of truth, implemented at the lowest choking
point, look up the internet. from now on, we must commit things to github as
much as possible, if possible all of it. you are allowed to rewrite/recreate/redo
anything not properly done."

- The GitHub organization is the ONLY host; the earlier self-hosted host is
  retired after the migration.
- Everything goes to GitHub, private where it must be: the harness, the
  coordination notes, the labs, the specs and the reports.
- Enforcement is server-side: rulesets, required checks, a merge queue, push
  protection, and a least-privilege GitHub App as the door.
- CI and docs are generated from the harness's own sources.
- Anything not done properly may be redone.

A gating workflow (one the merge queue runs) never filters its triggers: a
filtered trigger leaves its required check pending on what the filter skips
(`tests/public/workflow-policy.test.mjs`). One `pull_request` `types` list is
no filter: one that holds every one of GitHub's default types (opened,
synchronize, reopened) skips nothing the unfiltered trigger runs on and only
adds events, such as a label change that re-judges the visual check (#762);
any narrower list is still refused. Added events bring one hazard, refused by
the same test: a run on an added event reports a required job's newest check
at the same head, and a job skipped there (by its own condition, a skipped
dependency, its steps' conditions, or a script that exits early) counts as
passing. No reading of conditions or scripts rules that out, so the rule is
structural: a workflow that adds `pull_request` types hosts no job the forge
requires (read from the forge's own ruleset declaration), whether by its
name, as a reusable workflow's caller, or through a reusable workflow it
calls, and a computed job name there is refused because it cannot be judged.

Done so far: this repository is on GitHub, its CI runs on GitHub Actions
(`.github/workflows/ci.yml`, with the sharded full suite in
`.github/workflows/test-shards.yml`) and its docs site is published from it
(`.github/workflows/pages.yml`).

Still missing: the workflow files are written by hand, not generated from the
harness's sources; repository settings and rulesets are not yet kept as code
(the forge, P2.1); the GitHub App door does not exist yet (P3); the earlier
host is not yet retired (P7).
