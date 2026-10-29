# Candidate checkout (qualify a dirty tree without touching it)

`candidate-checkout.ts` builds a private, complete checkout of the checkout it
lives in, and is how a dirty tree is qualified (full suites, `harness sync`)
before it is committed. It never writes the source except `copy-back`.

```bash
node engine/scripts/tooling/candidate-checkout.ts create    --target ~/.local/state/<name>/repo
cd ~/.local/state/<name>/repo/engine && npm test          # the canonical receipt, in the candidate
node engine/scripts/tooling/candidate-checkout.ts refresh   --target ~/.local/state/<name>/repo  # after more live edits
node engine/scripts/tooling/candidate-checkout.ts diff      --target ~/.local/state/<name>/repo  # owned paths that differ
node engine/scripts/tooling/candidate-checkout.ts copy-back --target ~/.local/state/<name>/repo  # regenerated outputs -> source
node engine/scripts/tooling/candidate-checkout.ts snapshot  --name <task>-<label>              # the source's tree as a ref (index untouched)
node engine/scripts/tooling/candidate-checkout.ts create    --target ~/.local/state/<verifier>/repo --from <snapshot ref>  # exactly that tree (a refs/bridlewise/snapshots/ ref only; writes nothing to the source: no index baseline, no ref)
node engine/scripts/tooling/run-diff.ts --baseline <other candidate>/engine/.bridlewise/state/test-results/run-history.json \
  --current ~/.local/state/<name>/repo/engine/.bridlewise/state/test-results/run-history.json   # new / persisting / changed / fixed failures
rm -rf ~/.local/state/<name>                                               # disposable
```

The source's protected staged blobs are a recorded fact (`src/git/index-baseline.ts`):
`create` records the staged blobs HEAD does not hold (`.bridlewise/state/index-baseline.json`,
pinned by a ref so `git gc` keeps them), and every subcommand refuses a source
index that LOST one with no commit taking its place (`live_index_drifted`,
naming the paths). The repair and the deliberate re-record are the engine
CLI's `harness index repair` and `harness index record` (this tool owns no
index verb); a commit is never drift. The rule behind it — never reset an
index entry to HEAD — is in `CONTRIBUTING.md`.

`create`:
- copies every file the source owns with the one working-copy builder
  (`src/git/working-copy.ts`, git `stage-all`): its own repository, objects
  borrowed read-only from the source, the source HEAD, and the whole dirty tree
  staged in the candidate's OWN index (the source index is never touched);
- copies the source's `core.hooksPath`;
- applies the declared setup (`workspaceIsolation` in `engine/bridlewise.config.json`,
  `src/workflow/checkout-setup.ts`): `links` (e.g. `engine/large-codebases`), the
  config's required 0600 mode, then `phases.setup` — `npm ci` from the candidate's
  own lockfiles in both trees, the guardian plus its test binaries
  (`test_payload`, `test-process-supervisor`) and the bundle (no web module
  cache is warmed: a test run's caches live in its own scratch and go with it,
  decision TEST-CONFINEMENT-SELF-BIND);
- runs `harness sync --with-bundle` — the candidate's own engine, whose
  command repeats its pass until one changes no generated output (the ONE
  fixed-point loop, `convergeUntilStable` in
  `engine/src/workflow/checkout-setup.ts`, that a promotion's candidate
  settles with too; bounded by the number of outputs plus one;
  `harness_sync_not_converged` names the files still changing;
  `result.convergence` says what each pass rewrote) — and
  stages the regenerated outputs in the candidate. Every setup command runs
  under the native supervisor (its `timeoutMs` is its ceiling).

The target must be on the source's filesystem (`candidate_target_filesystem_mismatch`;
the harness refuses tmpfs roots; the check is the one owner's,
`assertSameFilesystem` in `engine/src/workflow/checkout-setup.ts`, shared with
the workspace root and a promotion's candidate) and absent or empty. `--no-setup` / `--no-sync`
skip those steps; missing target parents are created. `create` copies the
source's git identity (user.name/user.email as git resolves them there) into
the candidate's own config, and every other subcommand refuses a target that
holds no candidate (`candidate_target_missing`). `--prune <test path>`
(repeatable) names a test file deleted on purpose and is passed to `harness
sync` (a stale test path that is not named is still refused).

`refresh` copies what changed in the source, but never overwrites or deletes a
file the candidate authors (the generated outputs and the pinned build outputs)
unless the SOURCE changed that file since the candidate's recorded base; a
changed lockfile or guardian source re-runs its setup command (each command's
`inputs`). `copy-back` refuses a source that moved outside the authored outputs
(`candidate_source_moved`: refresh first), a source whose authored output
changed since the base (`candidate_copy_back_conflict`) and a missing output
(`candidate_output_missing`), all before writing; it then commits them as ONE
journaled transaction (`src/filesystem/journaled-commit.ts`: the checkout write
door for every target, backups kept until the source's `harness check` passes,
a failed check rolls every file back — `candidate_copy_back_unverified`), and
records the new base. It then imports the candidate's judged suite runs OF
ITS CURRENT TREE (the engine and the web ledgers: rows whose run started after
the base's `treeSince` — the instant the candidate's tree last changed at
create, a refresh or a sync — not mutation runs, and newer than the source's
newest, each marked `importedFrom: <candidate>`; the result's `ledgers` says
how many): the source now holds the candidate's tree, so the commit guard's
BASELINE WARNING reads the qualification instead of a stale live row, and
names the candidate it was measured in. The rows of the candidate's earlier
rounds measured trees the source never holds and are never imported;
`withdraw-imports --target <dir> --since <ISO>` removes such rows imported
before this bound existed (the one ledger writer, `src/shared/run-history.ts`,
under the ledger's lock). The generated outputs include every README carrying a generated
consumer block (`harness sync` regenerates them). Every subcommand first recovers a copy-back a crash
interrupted (the journal `.bridlewise/state/journals/candidate-copy-back.json`
in the source), rolling it back — unless its owner is still running: then
`diff` reports `{"recoveredCopyBack":"in-progress"}` and leaves it, and every
other subcommand refuses `candidate_copy_back_in_progress`.

Beside the workspace flow: a writer works in a workspace (`npm run ws`),
where nothing needs a candidate; the candidate remains the way to qualify a
dirty tree that is not in one (or `ws create --overlay` moves it into one).
Both run the same declared setup (`src/workflow/checkout-setup.ts`: one
supervised command runner) and the same `harness sync` fixed point.

# The workspace flow replaced the checkpoint and composition tools

New work happens in a WORKSPACE (`npm run ws`, `engine/src/workflow/`:
[README](../../src/workflow/README.md); the flow:
[MERGE-GUIDE.md §1b](../../../docs/process/MERGE-GUIDE.md#1b-feature--testing-the-workspace-merge--refusals-and-the-land)):
its commits are its record, `ws snapshot` a recovery point, and the land a
gated fast-forward. With it, A5 deleted the tools it replaces (D-11):

- the repository checkpoint (`snapshot-working-tree.mjs`,
  `repository-snapshot.ts`, `repository-restore.ts`, `repository-artifacts.ts`):
  its one live use was the backup of the uncommitted tree, which step 6
  committed; `repository-git.ts` keeps what the candidate manifest reads
  (`probeRepositoryGit`, `repositoryTreeEntries`, `fileGitMode`,
  `gitBlobObjectId`);
- the owned-change composition (`merge-integration.mjs`,
  `repository-selection.ts`, `mergeRepositoryFiles`): git merge over
  snapshot JSON, with no applier, committer or plan generator — a workspace
  branch and the workspace merge replace it; its general fixes (the pinned
  process's SIGKILL timeout, the `openPinnedAbsoluteFile` file-leaf
  boundary) stay where their other consumers use them;
- the experiment seeder (`seed-experiment.mjs`), retired earlier by the
  experiment workflow.

## The engine suite's watchdog

`inventory-test-run.ts` dispatches every test file (each in its own process)
with the per-test bounds preloaded (`engine-test-bounds.ts`: each test judged by
its CPU work against its file's class, `testExecution.testCpuClasses`, and ended
only by the hang backstop, `testExecution.testHangBackstopMs`; a test that
declares its own wall timeout fails at run time) and a FILE-level watchdog
(`testExecution.engineSuiteWatchdog`): a phase that reports no test event for
`stallTimeoutMs`, or a run still going at `hardCeilingMs`, is aborted. Both are
hang bounds, never judgements of speed (NO-LOAD-BLOCK).
The per-test backstop cannot end a file whose cancelled test left a handle open
(measured: a run held for two hours by one file's never-closed servers). The
clock is the worker's, never the watched file's, so a hung file and a spinning
one are both killed. Each killed file is a named failure row (`<file> (killed by
the suite watchdog …)`), its unfinished tests are cancelled rows, and the receipt
reconciles them (`abortedFileCount`): a killed run is a failed run.

## A test is judged by its CPU work, never its wall time

`test-cpu-class.ts` is the one per-test judgement both suites install
(TEST-CPU-CLASSES, NO-LOAD-BLOCK L2): around each test it reads the process's
CPU and its reaped children's (`src/shared/run-cpu.ts`) and fails a test whose
work is over its file's class ceiling (`testExecution.testCpuClasses`: a
default and named classes, each listing its files). Wall time is recorded,
never judged; the one wall bound left is the hang backstop
(`testExecution.testHangBackstopMs`). The web suite installs it from
`tests/setup/test-cpu-class.ts`; the engine suite from `engine-test-bounds.ts`,
which the runner preloads into every test file's process (it also refuses, at
run time, any test, suite or hook that arms a wall timeout other than the
backstop).

## A test run dials nothing but this machine

`network-under-test.ts` loads `network-under-test-guard.mjs` into every process
that runs tests: the engine test worker (`refuseRemoteNetworkUnderTest`, right
after arming the checkout write door), each engine test file's process
(`inventory-test-run.ts` hands node:test `execArgv: [networkGuardImport()]`)
and each web worker (`tests/setup/test-setup.ts`). A guarded process connects
only to this machine: the guard wraps `net.Socket.prototype.connect` (the
platform fetch, http, tls, undici and WebSocket all connect through it); a
remote address fails the socket with `outbound_network_under_test`, and a name
connects only when its resolver's every answer is local. The guard is plain
JavaScript on node built-ins (a TypeScript preload cost ~35 ms per process). It
is not exported through `NODE_OPTIONS`: a node payload a test confines with the
guardian cannot read the harness tree, so such a preload kept it from starting. The ONE opt-in
for a deliberate live suite is the root policy's `verification.networkUnderTest`
(`HARNESS_LIVE_NETWORK_TESTS=1` in the run's environment opens exactly its
`liveHosts`; `src/process/live-network.ts`).

## Run diff

`run-diff.ts` (`npm run run-diff -- …`, root or engine) compares the failure
identities of two judged runs (any two run-history ledgers, one row each:
`path#-1` is the latest, `path@<timestamp>` the row recorded at that instant —
the stable name a report cites): new (re-run each alone before calling it
yours — a load flake reads the same), persisting, changed (a persisting
identity whose recorded failure digest moved: it fails DIFFERENTLY now, e.g. a
guard with more offenders), fixed — or `unmeasured` when a row recorded no
failure list. Each side is printed with its identity: tree (`headSha`), the
5-minute load, and where the row came from (an imported candidate row names
its candidate; a mid-edit or mutation run says so). A whole red web file (a
collection error, a hook) is its own `<file>::<module>` row. Arguments are
strict (an unknown flag or a malformed selector is a refusal). It is the
qualification receipt diff between a writer's candidate and the previous
qualified rows (`diffRunFailures`, `failureDigest`, `src/shared/run-history.ts`).

## The roadmap feed

`roadmap-feed.ts --at <commit> --repository-url https://github.com/<owner>/<repo> [--out <file>]`
writes `roadmap.json` (`bridlewise-roadmap-feed/v1`), the one data feed the
public roadmap renders, computed in the projector's sealed realm from that
commit and its items' first-parent history (`src/workflow/forge/projector/roadmap-feed.ts`).
The roadmap at any commit is this command at that commit.
