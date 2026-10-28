# .githooks

The repository's tracked git hooks. Git deliberately does not track
`core.hooksPath`, so this folder ships the hook and
`engine/scripts/bootstrap-hooks.ts` points each clone's git at it — running
`node engine/scripts/bootstrap-hooks.ts .` once per checkout installs it.

The shipped hooks whose text is canonical — `pre-commit`, `pre-merge-commit`,
`commit-msg` and `reference-transaction` (`SHIPPED_HOOK_FILES`,
`engine/src/kernel/verification-paths.ts`) — are GENERATED, whole: `harness
sync` writes each from its owner (`shippedHookText`,
`engine/scripts/verification/staged-move-loss.ts`; the generator
`engine/scripts/verification/shipped-hooks.ts`) and `harness check` reports
one that differs (`shipped-hooks` step). Change a hook's owner, never its
file.

## What each file does

- `pre-commit` — refuses a commit that would silently drop a tracked file
  from the index (a plain `mv` into an ignored path plus `git add -A`
  stages a deletion with nothing standing in for it; each refused deletion
  names its typed code, `staged_move_loss` or the declaration's verdict).
  A DELIBERATE deletion whose bytes also sit at an ignored path (a `.bkp/`
  backup, a frozen snapshot) is declared first, never forced and never
  "fixed" by deleting the kept copy:
  `cd engine && node src/cli.ts harness deletions declare <path>…`
  (repository-relative, literal paths, each already gone from the disk;
  `--paths-file <file>` takes one per line, `--paths-file-nul <file>` the
  NUL-separated list `git diff -z --name-only` writes, and `--` ends the
  options) records each path with the blob HEAD holds there, HEAD, how many
  times HEAD had moved and the ignored copies of the file, in this checkout's
  own git directory, under a cross-process lock. The hook then accepts exactly
  that deletion, prints `DECLARED DELETIONS` with the copies that stay on
  disk, and refuses a declaration that is `declared_deletion_mismatched` (the
  file changed), `declared_deletion_stale` (HEAD moved since — even a
  `reset --soft` back to the same commit), `declared_deletion_expired`
  (something is at the path again), `declared_deletion_copies_changed` (a
  copy it did not record: the file came back and was moved again) or
  `declared_deletions_foreign` (another git directory's record). The
  declarations are read from the git being committed (under `--git-dir` too).
  The ignored population is what `git add -A` skipped on this machine
  (`.git/info/exclude` and `core.excludesFile` included); a deletion is read
  with rename detection off (a similar new file never hides it), a regular
  file replaced at its path (a typechange, e.g. by a symlink) counts as
  deleted, and a deletion whose exact blob is staged at another path (a
  `git mv`) is accounted for. `harness deletions status` shows them and
  `harness deletions clear` withdraws them. It also refuses a commit that
  disables a tracked hook: one that removes an executable hook's execute bit
  (git silently skips a hook it cannot execute), deletes a guarded hook
  (`git rm --cached`, a `git mv` away), or stages a guarded hook whose text no
  longer hands over to `commit-guard.ts` — each would disable this guard in
  every clone. "Hands over" is a comparison with the one canonical text
  (`staged-move-loss.ts` `guardHookBody`: `#!/bin/sh`, `set -e`, the root from
  git, `exec` of `"$root/engine/scripts/commit-guard.ts"` with the hook's
  arguments); only blank lines and comments outside that body may differ. Every
  other leg judges the STAGED tree — the index THIS commit records (the
  hook's `GIT_INDEX_FILE`: `git commit -a`, `-- <path>` and `-i <path>` hand
  the hook a temporary index), materialized under
  `.bridlewise/state/commit-guard/` without its intent-to-add (`git add -N`)
  entries, which the commit does not carry — never the working tree (it also
  WARNS, never refuses, when index entries changed since the recorded index
  baseline and are not part of this commit: `harness index repair`
  restores them exactly): it refuses a
  commit when either tree's `npm run typecheck` fails there (both legs run in
  parallel; a staged rename or move counts BOTH its old and new path, so a
  move of a source to a non-code path still runs the legs; a killed guard's
  materialization is swept by the next one), and, when any staged path is under `engine/`, unless the staged
  checker's `harness check --skip-typecheck` passes (the architecture
  manifest, root-policy pins, config-contract artifact and hash bindings must
  match their STAGED sources; regenerate with
  `cd engine && node src/cli.ts harness sync --with-bundle` and stage the
  outputs with their sources). It also prints a **baseline
  warning** — never a refusal — when the latest judged full-suite run in
  `.bridlewise/web-test-results/run-history.json` recorded failures, or
  when the ledger is empty/unreadable: piling commits onto a red (or
  never-certified) baseline has gone unnoticed for days before. It
  delegates to `engine/scripts/commit-guard.ts`, the single owner of the
  checks. It works the same in a LINKED WORKTREE (this checkout is one) and
  under `git --git-dir … --work-tree …`: git hands the hook `GIT_DIR` there,
  and the guard locates its own engine by asking git about the engine's
  directory alone, never with the hook's environment (otherwise the engine
  leg silently re-ran the web one).
- `pre-merge-commit` — the same door for the merge commit git makes by
  itself (`git merge` without a conflict runs no `pre-commit`; git ≥ 2.24
  runs this hook instead), passing `--merge-commit`: a merge that brings a
  deliberate deletion with an ignored copy is refused with its own route:
  git leaves the merge in progress (`MERGE_HEAD` stays), so declare the
  deletion, then `git commit` completes the merge (the file was still on
  disk before the merge, so it could not be declared earlier). A conflicted
  merge finished with `git commit` or `git merge --continue` runs
  `pre-commit`.
- `commit-msg` — the same door in its message mode (`--message <file>`): a
  commit that turns a workflow lesson (`docs/trackers/workflow-lessons/`)
  to `status: acted` — acted in the index, not in `HEAD` — must carry one
  `Lesson: L-<id>` trailer per such lesson, so
  `git log --grep='^Lesson: L-<id>'` finds the commit that acted on it (the
  lesson itself names the tracked paths, never a commit id). git runs this
  hook for `git merge` too: a merge bringing in a branch whose own commit
  already acted AND named the lesson (a commit in `HEAD..MERGE_HEAD`) acts on
  nothing new, so it needs no trailer; a merge whose branch acted WITHOUT one
  is refused, stays in progress, and is concluded with `git commit` naming
  the lesson. The staged side is read with the hook's own
  `GIT_INDEX_FILE`; the trailers are git's own parse of the raw message
  (`git interpret-trailers --parse`: comment lines and everything below the
  `git commit -v` scissors line are not trailers), and the key is
  case-sensitive, as `git log --grep` is
  (`engine/scripts/verification/lesson-trailers.ts`). git tells this hook
  nothing of `--amend`, so an amend is judged by `post-commit`. The same
  mode judges test deletions (`engine/scripts/verification/test-deletions.ts`):
  every path the commit takes off the recognizable test surface — a rename
  too, every path of it — is named in its own `Test-deleted: <path>` trailer
  (repository-relative), and a trailer naming a test the commit keeps is
  refused (`test_deletion_undeclared`, `test_deletion_declared_not_deleted`).
  A merge is judged only on what it deletes from every parent, so a merge
  bringing in a named deletion needs no new trailer. `post-commit` reports an
  amend that dropped one, and the required `commit-records` workflow (main's
  definition and code, over every commit of a pull request and a merge
  group) refuses what a skipped hook let through. The same
  mode checks every `Flake-cause: <ledger identity> => <paths>[ @ <commit>]`
  trailer (`flakeCauseTrailerProblems`, engine/src/git/flake-cause-fixes.ts)
  and refuses a malformed one by name; whether a declared fix explains a
  suspect is the flaky memory's judgement, under FLAKE-REPRO, never the
  hook's. Frozen records: each frozen root's content is pinned in
  docs/frozen-records.json, and the hook checks the STAGED tree against it on
  EVERY commit, whatever paths the commit touches (a docs-only commit
  included), whichever index it used (`git commit -- <path>` included).
  `harness sync` only ADDS a new record's pin; an edited or removed record is
  refused until `harness frozen accept --reason <why> <path>…` re-pins it,
  recording the reason in the manifest.
- `post-commit` — after a commit lands, consumes the deletion declarations
  it used (`engine/scripts/post-commit.ts`), in the git that committed:
  every declaration whose path HEAD no longer holds is removed, every one
  whose path is on disk again expires, and the record goes when none is
  left. git ignores this hook's status. A deletion that landed without this
  hook (a merge commit `git merge` makes by itself, which runs only
  `post-merge`; a rebase) is consumed by its next run. A declaration the commit did
  not use stays behind, stale for good (HEAD moved), so the guard refuses it
  rather than re-using it. It then asks the commit just made, with its real
  parents and message, whether it acts on a lesson without its trailer (an
  `--amend` that dropped one, a `--no-verify` commit) and REPORTS it with the
  repair (`git commit --amend` naming the lesson); git ignores the status, so
  this is a report, not a refusal. It is not a guarded hook: losing it can
  only make a later deletion be refused, never accepted, and an unnamed
  lesson go unreported.

- `reference-transaction` — THE PROMOTION TRIGGER: after a push or a fetch
  moves a remote-tracking ref (git's `committed` state of a ref transaction
  touching `refs/remotes/…`), it starts `harness promote auto --refs <the
  moved refs>` in the background, which promotes each profile whose source
  that ref is and whose trigger is `on-source-publish`
  ([MERGE-GUIDE.md §3.3](../docs/process/MERGE-GUIDE.md#33-hands-free-the-trigger));
  `auto`'s `--text` report — one line per blocked
  promotion, nothing otherwise — is all the pusher sees on stderr. It must NEVER fail: git runs it in the `prepared`
  state of EVERY ref transaction (a commit, a checkout, a fetch, a push), and
  a non-zero exit there aborts the update ("ref updates aborted by hook") —
  one broken line would block every git operation in the repository. So it
  has no `set -e`, every step that can fail exits 0, it does nothing in any
  other state, nothing when node is absent, and nothing for the promoter's
  own fetches and pushes (they carry
  `ROOT_POLICY.workflow.promotion.runEnvironmentVariable`). Its text is the
  code's (`engine/src/workflow/promotion/trigger-hook.ts`): the commit guard
  refuses a staged copy whose code lines differ (comments and blank lines
  aside), deleted or not executable, exactly as for the guarded hooks, and
  both suites' installation checks judge the working copy the same way.

## In a workspace (`harness workspace`) and on a land

`core.hooksPath` is repository configuration (the common git dir's
`config`), so every worktree of the repository — every workspace — runs these
hooks; the commit guard runs in the worktree it is committing and needs that
worktree's dependencies, which a workspace's `setup` phase installs (`npm ci`
in both trees). The workspace MERGE is one `git commit` in the workspace that
concludes a `git merge --no-commit`: it runs `pre-commit` (the guard
certifies the merge's staged tree, regenerated outputs included) and
`commit-msg` (the lesson trailers; a branch commit that already named a lesson
covers it), exactly as for any commit. The LAND is `git merge --ff-only` (or a
compare-and-swap `update-ref`), which makes no commit and runs no commit hook:
it moves the target to a commit these hooks already judged. The guard's
baseline WARNING (the latest judged full-suite run in this checkout's
`.bridlewise/web-test-results/run-history.json`) reads a fresh worktree's
EMPTY ledger on every early commit: that is the correct answer — no full run
has judged that tree yet — and never a refusal.

## In a promotion candidate (`harness promote apply`)

A promotion's candidate is a worktree of the repository too, so the same
hooks run: its ONE commit (`git commit` concluding a `git merge -s ours
--no-commit` of the source, in the candidate's own index) runs `pre-commit`
and `commit-msg` on the exact projected and settled tree — the product tree
the target will hold — after the profile's setup installed its dependencies.
A refusal is `promotion_commit_refused` with the hook's words, and the words
of a passing hook are answered with the commit. A guard that refuses a product
tree for a reason that holds only on the development branch is a guard bug,
fixed in the guard (it certifies the target's commits too), never bypassed.

## What no hook certifies

`git cherry-pick`, `git revert` and `git rebase` (including `-x` and `-i`)
make commits WITHOUT running any commit hook — git's design, not a gap this
folder can close (a pick finished with `--continue` after a conflict runs
`pre-commit`). `git commit --no-verify` skips every hook deliberately. The
backstop for such commits is `cd engine && node src/cli.ts harness check`
(the typecheck and every generated fact) plus the suites, run on the result
before it is pushed. A working-tree `chmod -x`, `rm` or rewrite of a hook
disables it BEFORE git would run it, so no hook can see that either: both
suites' installation checks (`readHookInstallations` in
`engine/scripts/verification/staged-move-loss.ts`) refuse a guarded hook that
is missing, untracked, not executable or not handing over to the guard.

## Where it lives and what consumes it

The folder lives at `.githooks/`. Git consumes `pre-commit` on every commit,
`pre-merge-commit` on every automatic merge commit, `commit-msg` on every
commit message and `post-commit` after
every commit `git commit` makes, once `core.hooksPath` points here; nothing
imports them as modules. The list of guarded hooks is
`GUARDED_HOOKS` in `engine/scripts/verification/staged-move-loss.ts`.
