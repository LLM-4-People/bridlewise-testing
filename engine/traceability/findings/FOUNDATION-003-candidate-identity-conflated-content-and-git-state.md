# FOUNDATION-003 — Candidate identity conflated content with mutable Git state

Status: **open-blocking**
Owner: `verification-foundation`
Affected surfaces: builder verification, test receipts, Git checkpoints

## Observed finding

The v1 candidate manifest computed one `candidateSetHash` over
`{baseCommit, files, deletions}`. Each file record included `source` and
`state`. Running `git add -A` changed 233 paths from
`untracked/untracked` to `tracked/added` without changing their bytes, so the
single hash changed even though the candidate content tree did not.

The exact pre-stage hash retained by the v2 test receipt was
`6101762789c9e3121643736ea2cf94814326bfa30d5f25cc593ad47fd9287d13`.
The exact post-stage observation was later recovered as
`df89ae67c0073e4153cd945e74d45e5591108ab4c6d8aae95f074fc03fb9077b`;
its canonical stdout SHA-256 was
`973d252472e157e7551c1b5d6ccd15f22923924320d918a6ebe79ab4354f87dd`.
The exact v1 owner bytes
were captured from the then-current Git index with SHA-256
`8484c840be283ff7d7994bc04c9868a10dd93987e76b0480ec9252af9b5f7f4e`.

The v1 hash also bound `baseCommit`, preventing it from serving as a stable
content-tree identity across a commit of identical final bytes. Conversely, a
content-only identity cannot attest index state, split staged/worktree state,
or final publication. One hash could not truthfully serve all three roles.

## Required model

1. `semanticTreeHash` is staging- and history-independent. It covers a
   domain-separated, sorted final candidate tree of normalized path, regular
   file type, Git-relevant mode, byte length, and SHA-256 only.
2. `formatVerificationHash` separately binds the format-policy revision and
   every per-path format outcome.
3. `workspace.stateHash` binds HEAD commit/tree/ref, exact stage-zero index
   entries, raw per-worktree index identity, worktree identities, and explicit
   derived states. Stage, unstage, split state, and commit are expected to
   change it.
4. Behavioral test receipts bind candidate-manifest schema, format-policy
   revision, semantic identity, and format-verification identity. Workspace
   publication eligibility is checked separately.
5. Final Git publication is non-self-referential: an explicit future
   checkpoint operation records the index tree, proves the created commit tree
   equals it, and binds the completed commit through an annotated tag or the
   append-only external event ledger. The canonical candidate-output SHA is
   computed outside the manifest.
6. Routine candidate inspection remains read-only. It records a prerequisite
   hash, not a falsely final commit or tag receipt.

## Current evidence

- `bridlewise-candidate-manifest/v2` implements the separated domains and
  rejects non-stage-zero or unsupported Git states.
- `bridlewise-s1-test-receipt/v3` binds the semantic and format identities.
- Hostile tests prove untracked-to-staged and staged-to-unstaged transitions
  preserve `semanticTreeHash` while changing workspace provenance; a commit of
  the same staged tree preserves semantic identity and changes base/workspace
  identity; staged-then-modified bytes block publication.
- Tests also cover content, add, delete, rename, executable mode, symlink,
  hardlink, invalid path, ignored files, and external publication-byte changes.
- The future authorized checkpoint/tag/ledger operation and lease/fence
  enforcement are not implemented, so this finding remains open.

## Governance

- Deadline: `before-git-checkpoint-publication-or-candidate-receipt-readiness`
- Blocked capabilities: `git-checkpoint-publication`, `candidate-receipt-readiness`,
  `semantic-checkpoint`, `release-readiness`
- Permanent regression: `candidate-semantic-workspace-publication-identity-matrix-x3`
- Removal verification: `independent-stage-unstage-split-commit-and-non-self-reference-replay`
