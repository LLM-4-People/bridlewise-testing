# FOUNDATION-002 — Candidate format verification omitted untracked files

Status: **verified removed**
Owner: `verification-foundation`
Affected surfaces: builder verification, candidate receipts, artifact admission

## Observed finding

Before the candidate was staged, the repository-level `git diff --check`
command returned no diagnostics because Git does not include untracked paths in
that check. After `git add -A`, `git diff --cached --check` reported authored
Markdown two-space hard breaks in these files:

- `docs/research/evaluation/harness-eval-design.md`;
- `docs/research/security/s3-key-anchor-qualification/REPORT.md`;
- `docs/research/storage/s3-ledger-design.md`;
- `traceability/findings/FOUNDATION-001-missing-test-inventory-generator.md`.

It also reported an extra blank line at end of file in each of these authored
benchmark sources:

- `verification/benchmarks/storage/s3-sqlite-adapter-benchmark/adapters/better-sqlite3.mjs`;
- `verification/benchmarks/storage/s3-sqlite-adapter-benchmark/adapters/node-sqlite.mjs`;
- `verification/benchmarks/storage/s3-sqlite-adapter-benchmark/bench-worker.mjs`;
- `verification/benchmarks/storage/s3-sqlite-adapter-benchmark/common.mjs`;
- `verification/benchmarks/storage/s3-sqlite-adapter-benchmark/install-check.mjs`;
- `verification/benchmarks/storage/s3-sqlite-adapter-benchmark/schema.mjs`.

That Git diagnostic was evidence of the blind spot, not proof that the list was
exhaustive. It did not establish candidate-wide handling for carriage returns,
NUL, invalid UTF-8, missing final newline, binary files, unsafe paths, symlinks,
generated text, rejected sensitive paths, or preserved exact-source bytes.

Independent inspection also identified two immutable upstream fragments with
otherwise noncanonical endings:
`traceability/sources/s2/openai-chat-stream.yaml` and
`traceability/sources/s2/mcp-tools.ts`. Their exact paths and digests are bound
by `traceability/sources/s2/manifest.json`; changing them would corrupt source
evidence. They require a fail-closed manifest-derived exception, not a path
glob or blanket research exemption.

## Root cause

The candidate manifest enumerated tracked and nonignored untracked paths, but
it only hashed bytes. The official check relied on Git diff diagnostics that
do not cover the complete candidate before staging. Artifact admission also
used replacement-character heuristics instead of the same fatal UTF-8 decoder.

## Required removal

1. Keep `scripts/candidate-manifest.ts#buildCandidateManifest` as the only Git
   candidate enumerator.
2. Apply one centrally configured, reusable byte-format rule to every candidate
   file before a manifest or test receipt can be produced.
3. Reject unsafe or sensitive paths before reading their contents; reject
   symlinks, hardlinks, special files, ambiguous binary classification, and
   moving-snapshot drift.
4. Treat authored and generated text identically. Markdown hard breaks must use
   explicit markup rather than trailing spaces.
5. Permit immutable source deviations only when an unchanged committed source
   authority validates the exact path, role, and digest.
6. Prove staged, unstaged, untracked, binary, generated, rejected, path, line
   ending, final-newline, Markdown, and exact-source cases with hostile tests.
7. Normalize authored files only after the guard first demonstrates their
   rejection, then regenerate every affected evidence and artifact identity.
8. Complete an independent replay before changing this status.

## Closure evidence

- The reviewed implementation is frozen by
  `traceability/evidence/verification/candidate-format/frozen-subject-9cd2bc38391b.json`.
  Its exact file SHA-256 is
  `57985ce599c07fe80f6d4320537134820551afac9fe335c84547aea603e300af`;
  all 74 declared file identities independently matched, producing subject hash
  `9cd2bc38391b6bcd498d6b984d4b1caacfd2c2766bdf3845c4b48b8502072325`.
- The 22-test candidate-format matrix and six-test immutable-receipt matrix
  passed together as 28 of 28 tests in three independent repetitions. The full
  frozen-subject suite independently passed 137 of 137 tests with deterministic
  result SHA-256
  `c7163968feadda631edaf7d120df0bb8cd4736d5d8849c2b718c166fa4449eed`.
- Before authored-file cleanup, the new candidate command deterministically
  reported the four Markdown groups and six benchmark EOF violations above.
- The same run did not report the two exact manifest-bound upstream fragments.
- Independent pre-review then found and reproduced four further false-green or
  unsafe paths: ancestor-symlink traversal before descendant reads, a
  hardlinked official authority read before the main file gate, warning-only
  Git stderr that omitted unreadable untracked content, and repo-controlled
  `core.fsmonitor` execution. The shared descriptor reader and centralized Git
  probe boundary now have hostile regressions for each case.
- Independent archive replay disproved the outer archive's claimed bytewise
  order and reproduced admission of a three-byte fake gzip. Valid archive
  admission is now suspended. Exact archive bytes are retained only as rejected
  fixtures; normalized searchable runner projections reconstruct all ten old
  digests through one shared routine.
- The complete independent verdict, hostile replay matrix, artifact replay, and
  residual limits are bound in
  `traceability/evidence/verification/candidate-format/independent-review.json`
  with SHA-256
  `c5187d911c0102fd61a2d0cc34a4194145de6da6655ce1650fa581f1ae74d50e`.
  Author x3 execution references are preserved separately as corroboration and
  are explicitly ineligible for canonical-ledger admission, finding removal,
  or release-readiness authority.
- The first broad failing receipt remains unavailable and was not reconstructed;
  `traceability/evidence/verification/candidate-format/first-broad-run-failure.md`
  preserves only the contemporaneous facts and the explicit evidence gap.

Removal is restricted to the frozen subject above. Linux `/proc/self/fd` and
mount information remain required by the safe repository reader, general valid
gzip/tar evidence admission remains suspended, `FOUNDATION-003` and
`FOUNDATION-004` remain open, and publication remains blocked. Those explicit
limits do not restore this candidate-format blind spot.

## Governance

- Deadline: `before-next-candidate-receipt-or-semantic-checkpoint`
- Blocked capabilities: `candidate-receipt`, `artifact-inventory-freeze`,
  `semantic-checkpoint`, `release-readiness`
- Permanent regression: `candidate-wide-format-path-and-source-preservation-matrix-x3`
- Removal verification: `independent-clean-and-mutated-candidate-replay-plus-canonical-cascade-audit`
