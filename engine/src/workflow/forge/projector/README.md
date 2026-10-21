# Projector

GitHub as a pure function of a commit (github-only §9.0): ONE owner computes
the complete desired GitHub state `D = project(S, L)` from the source commit S
(and the ledger commit L), and ONE apply algorithm makes GitHub equal to it —
writing only the difference, re-reading, verifying every git-owned field, and
answering a receipt for the ledger. Every trigger (a land, the hourly
reconcile, `--verify` on demand) runs the same algorithm.

Purity is a boundary, not a convention: `project()` runs in a sealed realm in
a child process, where nothing that reads the network, the clock, randomness
or the locale exists, and every such touch is the typed `projection_impure`.

What is projected today: one label per tracker lane, and one issue per tracker
item (title, type, lane label, sub-issue parent, `blocked_by` links, open or
closed with its reason, and a generated block whose marker carries the item's
id and digest, with permalinks at S). Every other field of a GitHub object is
GitHub-owned and never written.

## What each file does

- `model.ts` — THE MODEL (pure): D's objects (class, key, git-owned fields), the classes in write order, each field's write phase (create → link → state), the fields GitHub gives a just-created object (`BORN_FIELDS`), the input D is computed from (`ProjectionInput`), the item marker and the lane label.
- `project.ts` — `project(input)` (pure): the labels and the issues, sorted by class then key, every relative link of an item's body made a permalink at S, the record's own permalink in the footer; `projectText`, the realm's text-in, text-out entry.
- `realm.ts` — THE SEALED REALM: `sealedCall` runs one exported function of a declared module set in a child process and a fresh realm (no network, clock, randomness, locale, timers or code from strings; only text crosses), and types its refusals (`projection_impure`, `projection_import_refused`, `projection_failed`); `PROJECTION_REALM`, the projection's module set.
- `realm-child.ts` — the realm's process: reads the request on stdin, poisons every impure global and method, loads the declared modules (types stripped; any other specifier refused), answers on stdout.
- `projection.ts` — D from two trees: `projectionInput` (the tracker items read from the source COMMIT through the tracker's one parser, `../../failure-owners.ts`, and the lanes' labels) and `computeProjection` (the sealed call, each marker's digest filled in, D's canonical digest).
- `store.ts` — THE STORE PORT the algorithm reads and writes GitHub through, in the projection's own terms (class, key, git-owned fields); the GitHub store is written on the forge port's client.
- `apply.ts` — THE ONE APPLY ALGORITHM: `planProjection` (the writes that make the live state equal D, in phase, class and key order, and the orphans), `applyProjection` (write within the run's allowance, paced; re-read; verify; the receipt `bridlewise-projection-receipt/v1`), `verifyProjection` and `projectionFailure` (`projection_unverified` before any refusal; a budget refusal is retryable and the next run resumes).

## Tests

`engine/test/forge/projector.test.ts` proves V-25 (a second run makes zero
writes), V-26 (two processes give one digest; every impure touch is refused
typed) and V-28 (a field GitHub silently drops is `projection_unverified`),
the phase order, the resumable budget refusal, a refused write, orphans, and
that the input is read from the commit, never the working tree, against the
in-memory store `engine/test/forge/projection-store.ts`.
