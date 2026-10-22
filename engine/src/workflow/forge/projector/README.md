# Projector

GitHub as a pure function of a commit (github-only §9.0): ONE owner computes
the complete desired GitHub state `D = project(S, L)` from the source commit S
(and the ledger commit L), and ONE apply algorithm makes GitHub equal to it —
writing only the difference, re-reading, verifying every git-owned field, and
answering a receipt for the ledger. Every trigger (a land, the hourly
reconcile, `--verify` on demand) runs the same algorithm.

Purity is a KERNEL boundary, not a convention. `project()` runs in a separate
process under the harness's one confinement owner, the guardian
(`src/filesystem/self-protection/confined-run.ts`):
- no file is readable but node's own binary and libraries, and none is writable (Landlock);
- the network is refused: no socket of any family, and no io_uring (seccomp);
- a CPU-time ceiling ends a runaway program by CPU work (RLIMIT_CPU);
- no environment reaches it;
- the program and its input arrive on stdin, and the answer leaves on stdout.

A write, a read of the harness or of `/proc`, or a connect is refused by the kernel (`projection_impure`). The clock is the one impurity no Linux boundary can refuse: `CLOCK_REALTIME` is a vDSO read, and a time namespace offsets only the monotonic and boot clocks. So every projection is computed twice, and two different answers are `projection_nondeterministic`.

What is projected today: one label per tracker lane, and one issue per tracker
item (title, type, lane label, sub-issue parent, `blocked_by` links, open or
closed with its reason, and a generated block whose marker carries the item's
id and digest, with permalinks at S). Every other field of a GitHub object is
GitHub-owned and never written.

## What each file does

- `model.ts` — THE MODEL (pure): D's objects (class, key, git-owned fields), the classes in write order, each field's write phase (create → link → state), the fields GitHub gives a just-created object (`BORN_FIELDS`), the input D is computed from (`ProjectionInput`), the item marker and the lane label.
- `project.ts` — `project(input)` (pure): the labels and the issues, sorted by class then key, every relative link of an item's body made a permalink at S, the record's own permalink in the footer; `projectText`, the confined program's text-in, text-out entry.
- `confined.ts` — THE CONFINED CALL: `linkProgram` links the declared pure modules into one stdin program. Types are stripped, relative imports are rewritten to `data:` URLs, and an undeclared, bare, built-in or literal-dynamic specifier is refused (`projection_import_refused`). `confinedCall` runs the program under the guardian and types its ending (`projection_confinement_refused`, `projection_impure`, `projection_cpu_exhausted`, `projection_failed`). `PROJECTION_PROGRAM` is the projection's module set, and `ProjectorConfinement` its harness, keep-out facts and CPU ceiling.
- `projection.ts` — D from two trees: `deterministicCall` (two confined runs that must agree),  `projectionInput` (the tracker items read from the source COMMIT through the tracker's one parser, `../../failure-owners.ts`, and the lanes' labels) and `computeProjection` (the sealed call, each marker's digest filled in, D's canonical digest).
- `store.ts` — THE STORE PORT the algorithm reads and writes GitHub through, in the projection's own terms (class, key, git-owned fields); the GitHub store is written on the forge port's client.
- `apply.ts` — THE ONE APPLY ALGORITHM: `planProjection` (the writes that make the live state equal D, in phase, class and key order, and the orphans), `applyProjection` (write within the run's allowance, paced; re-read; verify; the receipt `bridlewise-projection-receipt/v1`), `verifyProjection` and `projectionFailure` (`projection_unverified` before any refusal; a budget refusal is retryable and the next run resumes).

## Tests

`engine/test/forge/projector.test.ts` proves V-25 (a second run makes zero
writes), V-26 (by the kernel: a dynamic-import write, a harness or /proc read,
a connect and a fetch to a live server are refused, the server sees no
connection; the clock and randomness are refused by computing twice; the
link refuses undeclared modules; a CPU spin meets its ceiling; a NODE_OPTIONS
preload never reaches the program; a host without the guardian is a refusal) and V-28 (a field GitHub silently drops is `projection_unverified`),
the phase order, the resumable budget refusal, a refused write, orphans, and
that the input is read from the commit, never the working tree, against the
in-memory store `engine/test/forge/projection-store.ts`.
