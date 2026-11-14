---
id: L-2026-11-13-contributor-entry-truth
date: 2026-11-13
source: public contributor entry review
kind: doc
status: acted
acted_in: [docs/community/templates/PULL_REQUEST_TEMPLATE.md.tmpl, .github/PULL_REQUEST_TEMPLATE.md, docs/community/replies/welcome-pull-request.md.tmpl]
---

## Observation

The pull request template and welcome reply repeated a blanket sign-off repair
command. That command can rewrite published commits and can add a certification
the contributor is not entitled to make. The welcome reply also promised that
one approved fork run makes every later run automatic, which the declared
first-time-contributor policy does not establish.

## Lesson

Contribution mechanics have one owner in CONTRIBUTING. Other entry points link
that owner and report the current approval state instead of making promises
about future runs or duplicating history-repair commands.

## Change

The generated pull request template links the setup gates and commit
instructions. The welcome reply points to the same commit instructions, asks
for maintainer help with published commits, and explains that later pushes may
also need approval. The community generator remains the owner of the rendered
pull request template; its existing convergence and reply-template checks judge
the result.
