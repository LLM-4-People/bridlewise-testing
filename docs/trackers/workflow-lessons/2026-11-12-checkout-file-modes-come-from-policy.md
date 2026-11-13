---
id: L-2026-11-12-checkout-file-modes-come-from-policy
date: 2026-11-12
source: PR 780 local qualification and a contained real-Git worktree reproduction
kind: guard
status: pending
route: TEST-10X
---

## Observation

Git records whether a file is executable, while the creator's umask controls
the remaining checkout permission bits. Creating a worktree under umask 077
left tracked source owner-only. The shared checkout settler repaired the
configuration document but left source unreadable to the group. Git's
shared-repository setting did not repair the working-tree source in the
recorded control.

## Lesson

Establish the file-mode contract at the common point after checkout creation
and tree moves. Derive the population from the shared index reader and modes
from their existing policy owners. Settle through the shared descriptor mode
owner only when a mode differs, preserving bytes, inodes and settled ctimes.
Never widen an arbitrary recursive filesystem census: untracked and ignored
private files remain private, and replaced links are refused.

## Change awaiting qualification

The checkout settler applies the raw-file policy to tracked regular files,
preserves Git executable modes, and retains the loader's exact private config
mode. The contained mode operation pins its parent chain, rejects shared or
nonregular leaves, and asks the write door about the held descriptor. Missing
tracked files and their index entries remain untouched. Independent review,
full qualification and normal landing remain required before this lesson is
acted. A focused result does not close the original full qualification failure
or establish the unavoidable self-evolution execution gate.
