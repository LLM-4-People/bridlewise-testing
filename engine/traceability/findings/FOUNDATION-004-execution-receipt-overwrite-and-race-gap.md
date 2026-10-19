# FOUNDATION-004 — Execution receipts allowed destructive reuse and lacked attempt evidence

Status: **open-blocking**
Owner: `verification-foundation`
Affected surfaces: builder test execution, evidence retention, verification replay

## Observed finding

The first broad candidate-format run wrote a failing
`bridlewise-s1-test-receipt/v3` to
`/tmp/bridlewise-format-guard-receipt-1.json`. It discovered 119 tests: 108
passed and 12 failed. Its integrity hash was
`8faf9d57dbeceacf8c4efd704356fa596744c0e5012675dc5171379c057b931a`.
A later passing run reused the pathname. The runner implemented a temporary
write followed by replacing rename, so the passing receipt destroyed the
failing bytes. A bounded search found no surviving exact copy. The missing JSON
has not been reconstructed.

The receipt also represented deterministic test content, not a unique
execution. It did not bind a run identity, start event, end time, duration,
exact stdout/stderr blobs, early runner errors, incomplete attempts, or an
immutable terminal outcome. Fixed package-script paths made an exclusive-only
writer usable once rather than repeatable.

## Current bounded repair

The builder now separates:

1. deterministic centrally versioned test-result receipt content with normalized
   runner-summary facts and centrally derived exact failure reason codes;
   historical v1/v2 references remain recognizable but are never
   reinterpreted as v3 (v2 omitted the facts needed to reject fabricated or
   mutually impossible runner-summary reasons);
2. a unique immutable start event written before child setup;
3. exact parent-observed stdout, stderr, and result-pipe blobs with independent
   completeness;
4. an immutable terminal event binding the start, result, streams, outcome,
   timing, runtime, command, and root-policy identity; and
5. a scanner that reports start-only attempts as incomplete rather than
   inferring success; and
6. a shared versioned command-effect contract that requires read-only defaults
   for build, generate, and check commands and explicit invocation for every
   declared mutation effect. The MWA author-receipt builder now derives by
   default and checks read-only; its explicit write mode is unavailable and
   fails closed until production `MigrationWriteAuthority` exists.

The same contract now governs the secret-span author-receipt and evidence
commands. Their derive and check modes are import-safe and read-only; legacy,
unknown and write forms fail closed. Tests instantiate the production file
authority against absent disposable repository trees, compare the complete
tree identity before and after each mode, and require scope cleanup.

A central command-effect inventory now scans supported JavaScript, TypeScript
and Python sources, closes bounded local dependencies transitively, checks
declaration parsing, import-safe qualified entrypoints, effect-contract
completeness, architecture roots and exact source/effect registrations for
blocked external commands. Parse failure, dynamic acquisition and unmodeled
effects remain blockers. Registration makes a blocker visible; it is not
execution permission or qualification.

The shared writer exposes exclusive-path, content-addressed, and unique-attempt
modes under one configured repository-local, user-owned mode-0700 private state
authority. It uses descriptor-held no-follow traversal, mode-0600 files,
same-directory exclusive linking, file and directory fsync, post-link
inode/owner/mode/link/byte checks, second directory fsync, explicit collision
semantics, and ambiguous-state preservation. Package commands allocate unique
attempts inside the namespace, so repeated checks do not delete evidence.

This is still explicitly builder test evidence with machine status
`durable-local-creation-unadmitted`. Root policy sets repository-artifact
admission, canonical-ledger admission, release-readiness use, and finding-removal
use to `false`. `.bridlewise/` is centrally excluded from candidate scans and
the never-push minimum. It is not the future canonical ledger. Other producers
are inventoried in
`docs/research/verification/receipt-producer-inventory.md` but are not silently
claimed as migrated.

## Required removal

1. Qualify start, result, stream, and terminal creation under concurrent,
   fail-to-pass, same-path, crash, fsync, disk-full, partial-write, rename,
   symlink, ownership, and restart schedules at least three times.
2. Prove the recovery scanner distinguishes complete, incomplete, unsafe, and
   ambiguous outcomes without deleting or overwriting evidence.
3. Capture parent-observed process stdout/stderr and bind them to the terminal
   event, including failures before result construction.
4. Admit execution evidence through the future canonical append-only ledger
   authority without creating a competing log or receipt store.
5. Migrate every in-scope receipt producer through a separately inventoried,
   reviewed write set; do not silently claim unrelated benchmark writers.
6. Complete independent replay before changing this status.
7. Migrate every build/generate/check producer to the shared effect contract and
   prove default, check, rejected mutation, and pre/post identity behavior x3.
8. Qualify or remediate every blocked command and unmodeled effect; an exact
   blocked registration alone cannot satisfy producer migration.

Items 1 through 3 are implemented and await the frozen-subject independent x3
replay. Items 4 and 5 remain capability blockers; therefore this finding remains
open even if the durable local overwrite/race defect qualifies independently.

## Preserved evidence

- `traceability/evidence/verification/candidate-format/first-broad-run-failure.md`
  records the exact retained metadata and exact-byte loss.
- `traceability/evidence/verification/candidate-format/pre-foundation-004-success-receipt.json`
  is the byte-preserved successful receipt that survived before the producer
  changed; its file SHA-256 is
  `920b20eb20b7a55f4243a0a1ef5550cc1de776dbc9243498d5dcba6ce73b7d1e`.

## Governance

- Deadline: `before-canonical-test-execution-receipts-or-readiness-evidence`
- Blocked capabilities: `canonical-test-execution-receipt`,
  `test-evidence-ledger-admission`, `receipt-based-finding-removal`,
  `receipt-based-release-readiness`
- Permanent regression:
  `immutable-start-result-stream-terminal-recovery-and-command-effect-defaults-x3`
- Removal verification: `independent-crash-concurrency-parent-capture-and-ledger-admission-replay`
