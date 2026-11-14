---
id: L-2026-11-14-contributor-identity-follows-native-git
date: 2026-11-14
source: standing user instruction to preserve configured Git author and committer
kind: doc
status: acted
acted_in: [docs/community/templates/CONTRIBUTING.md.tmpl, CONTRIBUTING.md]
---

## Observation

The contributor guide made cryptographic signing unconditional even though its
requirement is owned by the configured forge stage. It also did not explain how
a contributor can inspect both Git roles or choose the scope of an identity
change.

## Lesson

Contributor instructions must distinguish the committer's DCO sign-off from
cryptographic signing, link the owner of changing requirements, and let the
contributor control identity and signing settings. Agent custody does not
authorize replacing the author or committer.

## Change

The existing community template explains effective author and committer
inspection, repository-local and global identity settings, and their effect on
future commits. Its signing guidance links the forge stage policy. The existing
community generator produces the public guide; its convergence check and the
existing documentation liveness checks judge the rendered result.
