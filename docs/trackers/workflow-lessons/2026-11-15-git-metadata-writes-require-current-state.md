---
id: L-2026-11-15-git-metadata-writes-require-current-state
date: 2026-11-15
source: Shared Git configuration custody and native cleanup prerequisite review
kind: guard
status: acted
acted_in: [engine/src/git/worktree-port.ts, engine/test/workspaces/worktree-port.test.ts]
---

## Observation

Enabling an already enabled worktree-config extension replaced the shared
repository config file while preserving its bytes. Independent custody
checks correctly observed the new inode and timestamps. Branch retirement
also needs the tip that was reviewed. In owned native controls, a permitted
symbolic alias followed the deletion to its protected target; a name check
alone did not preserve the intended reference boundary.

## Lesson

Apply state-sensitive mutations at the shared Git owner. Let Git normalize
its own boolean values, select the repository's local scope explicitly, and
use Git's expected-old-value compare-and-swap for an agent branch. Keep
refusals visible and preserve unrelated worktree identity and marker writes.

## Change

The worktree port skips the common config write only for one normalized
local true value. Its native regression preserves raw bytes and canonical
file identity, enables missing or false values once, and retains malformed
or multivalue refusal semantics. The same port exposes expected-tip agent
branch deletion through its existing namespace and refusal owners. Both
agent-branch and generic recovery-ref deletion use one non-dereferencing
native operation with the expected tip. Hostile controls retain a moved
tip and the protected target behind a symbolic alias; existing namespace
refusals, source files and staged work remain intact.
