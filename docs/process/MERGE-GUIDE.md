# Merge and promotion guide

This is the public-floor runbook for moving finished work: a feature branch
into `testing` (§1b), and `testing` into `master` by promotion (§3–§5). It
grants no integration role to work in another workspace. The rule it serves is
[UR-12](../decisions/UR-12-master-changes-only-through-the-promotion-door.md):
the product branch changes only through the promotion door. The design behind
it is [PROMO-DIR](../decisions/PROMO-DIR-a-generic-promotion-primitive.md) and
[PROMO-UD](../decisions/PROMO-UD-promotion-choices.md); the loop every change
follows is [WORKFLOW.md](WORKFLOW.md).

> [!WARNING]
> Bridlewise is an experimental developer preview, not production ready. Do not
> use it on sensitive, proprietary, regulated, or production codebases.

## 1. The model

- **Work happens on `testing`.** Every edit, test, guard, record and tool
  lives there, and reaches it only through a workspace merge (§1b) or the
  committer's certified commits.
- **`product` is a promotion of `main`** (on GitHub, the one repository;
  [PROMO-GH](../decisions/PROMO-GH-the-product-is-promoted-on-land.md)). Its
  tree is a pure function of a `main` commit S and the promotion profile S
  carries (`promotion/main-to-product.json`): what the product's entry points
  reach, what the profile includes, the files of its overlay folder, and the
  derived package manifests and lockfiles. Nothing is merged, so nothing
  conflicts and nothing is settled by hand.
- **Never edit `product` directly**, and never use its checkout as a work
  tree. A direct edit is refused at the next promotion
  (`promotion_target_edits`) and handed back as a patch to land on `main`
  (§4).
- **Never merge `product` into `main`.** The promotion refuses a source that
  holds a promotion commit (`promotion_never_rule`): the rule is structural,
  not a convention.

## 1b. Feature → `testing`: the workspace merge — refusals and the land

A feature workspace lands on its target's UPSTREAM trunk on the forge — one
of `workspaceIsolation.landTargets`, which name the forge's trunk (this
repository: `main` on GitHub), never a local branch name: any local branch
whose upstream is that trunk lands there, and a target whose upstream is
another trunk, another remote, or none is refused at create. There are two
ways to land, side by side: `ws land` through the forge's merge queue (§1c),
and the local integrator, `npm run ws -- merge <id>` (= `node
engine/src/cli.ts harness workspace merge <id>`, in
`engine/src/workflow/workspace-manager.ts`), which lands locally and leaves
the push to the caller. Under the repository's merge lock (merges queue):

1. **Preconditions.** Validated (`ws validate`), the target still a land
   target, the lease live, the worktree intact and clean at the validated
   HEAD. The changed set is the diff from the fork point (`merge-base(T,
   HEAD)`) to HEAD; every authored change lies inside the lease (a pure
   regeneration is exempt); nothing merged since the fork point touches an
   authored change (`dynamic-overlap`: rebase); no other pending lease covers
   one; the fork point within `baseStalenessCommits`.
2. **In the workspace.** Detached at the target's tip, `git merge --no-ff
   --no-commit --no-autostash` of the branch; a conflict on a generated output
   whose branch side is regeneration only resolves to the target's side; any
   other conflict is reported (`textual-conflict`). The `regenerate` phase
   (`harness sync --with-bundle`) may write only generated outputs.
3. **One merge commit, through the hooks** — the tree landing's commit
   (`engine/src/workflow/tree-landing.ts`): `pre-commit` and `commit-msg` run
   as for any commit, then the commit's tree, parents and objects are checked.
4. **The merge gates** (`phases.merge`), unless `validate --full` qualified
   that exact tree: a suite gate passes iff its judged run has no new and no
   changed failure against a clean run of the target's own tree.
5. **The land** — the tree landing's: `git merge --ff-only --no-autostash` in
   the checkout holding the target (git refuses, nothing moved, when that
   would touch the checkout's own work; a checkout a crash left torn mid
   fast-forward is completed with git alone), or a compare-and-swap of the
   ref when no checkout holds it. An `--overlay` workspace is adopted into the
   checkout it snapshotted.
6. **After the land**: the qualifying runs imported into the landing
   checkout's ledgers, the timeline import, the worktree and branch removed, a
   hashed receipt. Then push `testing`.

A failure before the land leaves every checkout untouched and the workspace
`active` (or `validating` when git refused the land itself). An integrator
that dies leaves it `merging`: `ws recover <id>` finishes or rolls back.

A feature workspace's target must track an upstream branch on a remote
(`branch.<target>.remote`/`.merge`): `create` refuses one that does not
(`workspace_target_untracked`), and one whose remote is not the forge's
trunk repository (`workspace_forge_remote_unknown`). `publish` re-makes the branch's new commits
on the forge as signed twins through the Git Data API (moving the forge
branch only from where the workspace left it: another writer's commits are
refused, `branch_moved_by_another_writer`) and opens or regenerates the DRAFT
pull request; `ready` takes it out of draft once its published tree passed
`validate`, and any later round that publishes a new head returns it to
draft. Records are stored per version: each older store (v4, before the
stacks; v3, before the land; v2, before the forge), which older code still
uses, is read and migrated in memory through one chain (v2 → v3 → v4 → v5)
and never written. A workspace only an older store knows is read-only to
this version until the recorded P7 cutover: every verb that would change it
refuses (`workspace_owned_by_v<N>_checkout`, naming its record and worktree)
— act on it from the checkout of the version that made it.

## 1c. Feature → `main` on the forge: `ws land`

`npm run ws -- land <id>` puts a workspace's pull request in the forge's
MERGE QUEUE and waits for the queue's verdict. Auto-merge is never used.

1. **Preconditions.** Validated, published, ready, and nothing unpublished:
   the worktree's HEAD is the published head, clean, and its tree is the one
   `validate` passed. Then the harness's own judgement, against the trunk as
   the forge holds it now: the land target, the lease, the overlay's
   checkout, every changed path inside the lease, nothing merged on the
   trunk since the fork point touching one, the staleness budget, the
   pending leases. A refusal sends the record back to `active`.
2. **The request.** The pull request is read once. If it is closed, or its
   head is not the published one, the land is refused before anything is
   asked (`workspace_pull_request_closed`, `workspace_published_head_moved`).
   Otherwise the record becomes `merging`, naming the one head that may
   land, and GraphQL `enqueuePullRequest` is sent with that head as
   `expectedHeadOid`. If it is already queued at that head, nothing is
   asked: the land only waits.
   - GitHub refuses the enqueue (not mergeable, a check or a review
     missing): `workspace_enqueue_refused`, and the record goes back to
     `validating`.
   - GitHub answers that it queued another head: `workspace_land_foreign_head`.
3. **The wait.** The pull request is read once every `landing.pollIntervalMs`
   (each read covers its whole state). Leaving the queue without merging
   (`workspace_land_dequeued`), a moved head (`workspace_published_head_moved`)
   or a close ends the land, and the record goes back to `active`. After
   `landing.timeoutMs` the wait stops with `workspace_land_pending`: the
   record stays `merging`, `ws land` resumes the wait, and `ws recover`
   looks once.
4. **After the merge** (under the merge lock): the trunk is fetched.
   - If the trunk does not hold the merge commit: `workspace_land_unconfirmed`
     (retriable).
   - If the merge commit's second parent is not EXACTLY the head that was
     asked for: `workspace_land_foreign_head`, and no receipt is written.
   Otherwise the local target follows the trunk: the overlay's adoption, or
   the tree landing's fast-forward or ref swap. If git refuses the follow,
   the refusal is recorded, never thrown, because the land already
   happened. Then the qualifying runs and the timeline are imported, the
   worktree and the local branch are removed, and the hashed LAND receipt
   is written. Finishing is idempotent: a land that another land or a
   recover already finished answers its receipt.

`ws abort` closes the workspace's open pull request with a comment and keeps
its branch.

## 1d. Stacks: an ordered chain of workspaces, each landed by `ws land`

`ws create --agent <name> --write-set <path…> --stack-on <id>` starts a
workspace on another one's published head, for work too large for one
review. The child takes its parent's target and names no target, base or
overlay of its own. The parent must be live (`active` or `validating`) and
published (`workspace_stack_invalid`, `workspace_stack_parent_ended`,
`workspace_not_published`).

- **Judged from the parent while the parent is open.** `validate` and
  `publish` take the child's change from the parent's published head. The
  publisher re-makes only the child's own commits: the parent's signed
  twins are already on the forge. A child may lease its parent's paths,
  because a stack is ordered by construction, and a parent's land never
  waits for its own children's leases. A sibling stays a rival.
- **One pull request per part, always against the trunk.** It is never
  opened against the parent's branch: the repository deletes a landed
  branch (`delete_branch_on_merge`), and the pull requests based on it
  would close with it. Until the parent lands, the child's pull request
  also carries the parent's commits. Its body names the parent ("Stacked
  on #N") and lists only the child's own commits.
- **One way to land.** `ws land` (and `ws merge`) of a child refuses until
  its parent has landed (`workspace_stack_parent_unlanded`). After that,
  the child is an ordinary workspace: the trunk holds its parent's head,
  the fork point is that head, and its own change lands through the merge
  queue with its own receipt.
- **A parent that moves or ends.** A parent that publishes another head
  leaves its child refused (`workspace_stack_parent_moved`) until the child
  is rebased onto that head. A parent that ends without landing leaves its
  child with nothing to stand on (`workspace_stack_parent_ended`).

## 2. The commands

```bash
node src/cli.ts harness workspace create --agent <name> --write-set <path…> [--target <branch>] [--base <ref>]
node src/cli.ts harness workspace create --agent <name> --write-set <path…> --stack-on <id>
node src/cli.ts harness workspace validate <id> [--full]
node src/cli.ts harness workspace publish <id> | ready <id>
node src/cli.ts harness workspace land <id>
node src/cli.ts harness workspace merge <id>
node src/cli.ts harness workspace recover <id> | abort <id> [--quarantine]
```

Run them from the engine package root of the development checkout. See
[engine/src/workflow/README.md](../../engine/src/workflow/README.md) for the
full workspace command list and the registry/config leaves.

## 3. `testing` → `master`: `harness promote`

`npm run promote -- <verb>` (= `node engine/src/cli.ts harness promote
<verb>`, from any checkout of the repository; the promoter is
`engine/src/workflow/promotion/`):

| Verb | What it does |
|---|---|
| `status` | The source and target tips, the commits waiting (and the oldest one's age), the pending and hold refs, the last run's state and result, and the preflight (git, node and each command's tool, the work folder's filesystem and free space, `core.hooksPath`). Changes nothing. |
| `plan [--diff] [--patch]` | What `master` would become: every added, modified and deleted path with its reason, the derived manifests and lockfiles, the target's direct edits, the refusals and the advisories. Writes objects only. |
| `explain <path>…` | Why a path ships or not: the import chain from an entry point, the include, the companion rule, the exclusion. |
| `apply` | The promotion, end to end (below). |
| `rollback --to <promotion commit> --reason <text>` | §5. |
| `hold --reason <text>` / `release-hold --reason <text>` | §5. |
| `auto --refs <refs>` | The trigger hook's entry (§3.3); never run by hand. |

Every answer is one envelope (`{ok, code, class, message, remedy, data}`; add
`--text` for a report: the one output option of every harness verb) and the
process exits with its class's code (§7).

### 3.1 What `apply` does

1. **Lock and reconcile.** One promotion per target ref (a repository-wide
   lock; a live holder is never broken). The remote's source, target and hold
   are read and fetched; a local `master` behind its remote is fast-forwarded
   first (a `--no-publish` run moves nothing: it builds on the remote's tip),
   ahead of it (an earlier promotion published with `--no-push`) is carried,
   apart from it is `promotion_target_diverged`; S must be ordered with the
   remote's `testing` (`promotion_source_diverged`). A hold stops the run
   (§5).
2. **Plan** (as `plan`). Its refusals stand, except two that an explicit,
   reasoned flag accepts: `--accept-target-edits <exactly the plan's list>
   --reason <text>` and `--allow-deletions --reason <text>`. Nothing to
   promote ends the run (`promotion_up_to_date`, `promotion_unchanged`).
3. **Build and certify**, in a disposable worktree beside the repository (on
   its filesystem, under `workspaceIsolation.workspaceRoot`): the candidate
   holds `master`'s tip with the projected tree; the profile's `setup`
   commands run, its `converge` commands are driven to a fixed point (only
   generated outputs may change), its `verify` gates run on the exact tree,
   and ONE `git commit` records it — the repository's commit hooks certify
   it like any commit, never `--no-verify`. The commit has `master`'s tip and
   S as parents, S's committer as author and committer at S's date, and the
   trailers `Projected-From`, `Promotion-Profile` (and
   `Promotion-Accepted-Target-Edits`). It is pinned by
   `refs/bridlewise/promotion/<profile>/pending` and described by a receipt:
   the plan, the overrides and their reasons, the convergence, every command
   with its evidence (argv, attempts, duration, the load it met), the
   toolchain. `--no-publish` stops here.
4. **Publish** — the remote first: ONE `git push --atomic` of the commit to
   `master`, its receipt, and `testing` when the remote's `testing` lags S
   (never forced); `ls-remote` must then read the commit. A push rejected
   because the remote moved re-plans once. Then the checkout that holds
   `master` is fast-forwarded (a torn fast-forward is completed with git
   alone — only when every path in the way already holds the commit's bytes
   and is staged as the old tip or the commit records it: a version staged
   there that is neither is that checkout's own work, and parks the
   promotion). `--no-push` publishes locally only (the next run pushes it).
5. **Finish** — in the checkout that holds `master`: the configuration
   document's mode restored (0600), the candidate's pinned build outputs (the
   bundle, the guardian binary) installed as one journaled transaction, the
   index baseline checked, and the setup commands its new tree needs named
   (`depsStale`: never run there, it may be serving). The pin goes, the
   candidate goes.

**A rerun IS the resume.** Every decision is derived from the refs and the
trailers: a crash at any point is finished by running `apply` again (a pinned
commit is published, a published one landed, a landed one finished), and the
same inputs rebuild the same commit. There is no resume or abort verb.

**Parking.** When the checkout that holds `master` has its own edits on paths
the promotion changes, the remote is already right, and nothing there is
touched: `promotion_parked` (exit 7) names the paths. Commit them on
`testing` or discard them there, then run `apply` again (or `git merge
--ff-only` there) — nothing is rebuilt.

### 3.2 Where it runs

Any checkout: the `testing` checkout, the `master` checkout (the profile is
found through `master`'s last `Promotion-Profile` trailer), a workspace, a
fresh clone. S's own committed promoter promotes S: when the invoking
checkout is not clean at S, `apply` re-executes itself in the promoter home
(a detached worktree at S beside the repository, its engine dependencies
installed by the profile's own setup).

### 3.3 Hands-free: the trigger

The tracked `.githooks/reference-transaction` hook (its text is
`engine/src/workflow/promotion/trigger-hook.ts`'s, and the commit guard
refuses any other: a hook that fails in git's `prepared` state would abort
every ref update) runs `harness promote auto --refs "$refs" --text` in the
background after a push or a fetch moves a remote-tracking ref. `auto` starts
one unattended `apply --auto` for each profile whose source that ref is and
whose `trigger` is `on-source-publish`: the run publishes the target directly,
after its own gates certify the projected tree.
`auto` never decides on the local hold ref (a mirror of the remote's): the
run reads the remote's hold and answers it as "not now" (`promotion_held`,
exit 0). An unattended run never waits for a lock (the target's, or the
promoter home's): while another run holds it, it answers
`promotion_locked` (exit 0) and that holder owes the newer source. **Latest
wins**: every `apply` — whatever it answered, a failure included, except a
hold or a coalesced run — ends, once its locks are released and in its
top-level process, by fetching the remote's `testing`; when it holds a commit
the run's S does not contain, the trigger's own rules decide over that tip and
start one more unattended run. When the previous run of a profile did not end
ok, the next push prints ONE line on stderr naming it and `harness promote
status --profile <name>`. The promoter's own fetches and pushes never
trigger anything.

## 4. The first promotion, and direct edits of `master`

Since the last promotion — or, the first time, since the merge base — any
path `master` changed that the projection does not reproduce is a **target
edit**: `plan` lists each one and writes the reverse patch
(`<registry>/promotion/<profile>/target-edits-<T>-<S>.patch`). Either land the
patch on `testing` (the next promotion reproduces those bytes with nothing to
accept, and records it — even when nothing else changed — so later `testing`
edits of those paths are never read as the target's again), or overwrite them
once, deliberately: `apply --accept-target-edits <the exact
list> --reason <text>` (the trailer and the receipt record it; a different
list is refused).

The first promotion is not a special mode: the coordinator reviews `plan
--diff --text` (the added modules, the deletions, the derived manifests, the
target-edit list with each diff, and the advisories), then runs `apply
--accept-target-edits <exact list> --reason "bootstrap: master adopts
testing's shared files"`, then switches the profile's `trigger` to
`on-source-publish` on `testing`.

## 5. Rollback and hold

- `rollback --to <promotion commit> --reason <text>` restores `master` to what
  an earlier promotion shipped with a NEW commit (its tree, one parent: the
  tip; `Promotion-Restores`), built, certified and published like a
  promotion — never a forced push. It sets the profile's **hold**, pushed
  atomically with it (the hold is in force here only once the rollback is
  pinned: a failed build leaves none behind; a rerun of an unpublished one
  pushes both). A rollback touches `master` and the hold only: it never reads
  or pushes `testing`. A rollback of a rollback is refused; so is the tip.
- While held, an unattended run answers `promotion_held` (exit 0) and a manual
  `apply` refuses unless given `--release-hold --reason <text>` (a human says
  the defect is fixed).
- `hold --reason` pauses without a rollback; `release-hold --reason` resumes.
  The remote's hold is the one in force: a hold set or released elsewhere
  counts at the next run.

## 6. The profile

`promotion/<name>.json` on the source branch (read from the source commit,
never a working tree; validated strictly, every value stated; see
[promotion/README.md](../../promotion/README.md)):

- `source.ref`, `target.ref`, `remote` (`null`: local only), `trigger`
  (`manual` | `on-source-publish`);
- `boundary`: `entryPoints` (the product's roots; their import closure
  ships), `include` (paths shipped without an import edge), `exclude` (never
  shipped, never walked; an import into one is a refusal), `companions`,
  `spawnCalls`;
- `transforms`: the derived package manifests (scripts kept by name,
  devDependencies kept by use) and lockfiles (re-resolved by a registry
  command);
- `phases`: `setup`, `converge`, `verify` — registry command names
  (`workspaceIsolation.commands`);
- `safety.maxDeletedFraction`.

Changing what ships is a commit on `testing` to this file, judged at every
change by the source-side guard. A second pair is a second file.

## 7. Codes

`engine/src/workflow/promotion/codes.ts` is the single source; this table is
held to it (`engine/test/workflow/promotion/merge-guide.test.ts`). Exit codes:
0 ok, 2 input, 3 precondition, 4 errored, 5 failed, 6 integrity, 7 parked; an
unattended run (`--auto`) exits 0 for the answers marked "auto 0".

| Code | Class | Exit | What to do |
|---|---|---|---|
| `promotion_planned` | ok | 0 | Review the plan; nothing was written to any ref, checkout or index. |
| `promotion_up_to_date` | ok | 0 | Nothing to do: the target already carries this source commit. |
| `promotion_unchanged` | ok | 0 | Nothing to do: the projection of this source equals the target (only unprojected paths or regenerated values changed). |
| `promotion_status` | ok | 0 | Read the status; nothing was changed. |
| `promotion_explained` | ok | 0 | Read the reason chain for each path. |
| `promotion_committed` | ok | 0 | Review the commit (its receipt names every command that certified it); the pending ref pins it and nothing was published: the target ref, the remote and every checkout are untouched. |
| `promotion_published` | ok | 0 | Nothing to do: the target (and its remote) carry the promotion commit, and the checkout holding the target was fast-forwarded; `status` shows whether its dependencies need a reinstall (depsStale). |
| `promotion_not_due` | ok | 0 | Nothing to do: no promotion profile is triggered by the refs that moved, or the trigger was the promoter's own fetch or push. |
| `promotion_triggered` | ok | 0 | A promotion was started in the background: `status` shows its phase and its result. |
| `promotion_rolled_back` | ok | 0 | The target was restored and automatic promotion is held: fix the defect on the source, then `release-hold --reason <text>`. |
| `promotion_hold_set` | ok | 0 | Automatic promotion is paused for this profile until `release-hold --reason <text>`. |
| `promotion_hold_released` | ok | 0 | Automatic promotion resumes at the next source publication (or run `apply`). |
| `promotion_not_held` | ok | 0 | Nothing to release: no hold is set for this profile. |
| `promotion_usage` | input | 2 | Run `harness promote <status|plan|explain|apply|rollback|hold|release-hold|auto> [--profile <name>] [--source <rev>]` (apply: `--no-publish`, `--no-push`, `--accept-target-edits <path>… --reason <text>`, `--allow-deletions --reason <text>`, `--release-hold --reason <text>`, `--auto`; rollback: `--to <promotion commit> --reason <text>`; hold and release-hold: `--reason <text>`; auto: `--refs <refs>`). |
| `promotion_profile_missing` | input | 2 | Add the profile `<profile directory>/<name>.json` on the source branch (see promotion/README.md), or name an existing one with --profile. |
| `promotion_profile_invalid` | input | 2 | Fix the profile on the source branch: the JSON pointer names the field and the rule it breaks. |
| `promotion_source_missing` | input | 2 | Name a source revision that exists (--source <rev>), or create the profile's source branch. |
| `promotion_target_missing` | input | 2 | Create the profile's target branch (or fetch it from the profile's remote): a promotion builds on the target's tip. |
| `promotion_source_json_invalid` | precondition | 3 | Fix the named JSON file on the source (a package.json, a lockfile or a tsconfig): the projection must read it to resolve imports, packages and aliases. |
| `promotion_entry_missing` | precondition | 3 | Fix on the source: restore the entry point, or correct `boundary.entryPoints` in the profile. |
| `promotion_unresolved_import` | precondition | 3 | Fix on the source: the importer names a module the tree does not hold (a dangling import ships broken code). |
| `promotion_import_into_excluded` | precondition | 3 | Fix on the source: product code must not import a path the profile excludes (move the module into the product, or the import out of it). |
| `promotion_dependency_undeclared` | precondition | 3 | Fix on the source: declare the package in the owning package.json (`dependencies` for a runtime import). |
| `promotion_overlay_invalid` | precondition | 3 | Fix the overlay folder on the source: each of its files ships at its path without the folder prefix, so it must be a regular file that is not a module, at a path the profile does not exclude and the projection does not already carry. |
| `promotion_gitlink_unsupported` | precondition | 3 | Exclude the submodule path in the profile: a gitlink cannot be projected. |
| `promotion_manifest_script_missing` | precondition | 3 | The profile keeps a script the source manifest does not declare (a typo or a rename): correct the transform's `scripts` list, or restore the script. |
| `promotion_manifest_script_emptied` | precondition | 3 | Every segment of a kept script was pruned: add the script's file to `boundary.entryPoints`, or drop the script from the transform's `scripts` list. |
| `promotion_manifest_script_unparseable` | precondition | 3 | Rewrite the kept script as `&&`-joined commands: `;`, `||`, pipes, substitutions and redirections cannot be projected. |
| `promotion_manifest_bin_ambiguous` | precondition | 3 | Two devDependencies provide the command a kept script runs: remove the ambiguous one from the source manifest. |
| `promotion_transform_failed` | failed | 5 | The transform's command failed on the derived inputs: read the output tail and fix the manifest on the source. |
| `promotion_transform_errored` | errored | 4 | None: the machine was busy or offline (the retries are exhausted); run it again later. |
| `promotion_never_rule` | precondition | 3 | The source was merged with the target after a promotion: restore the source from its reflog (never force-push without the coordinator). |
| `promotion_target_edits` | precondition | 3 | The target was edited directly since the last promotion: land the written patch on the source, or (apply) accept the exact list with a reason. |
| `promotion_deletion_budget` | precondition | 3 | The projection deletes more of the target than the profile's safety budget allows: review `plan --diff` (a boundary typo?) before an explicit, reasoned override. |
| `promotion_projection_mismatch` | integrity | 6 | Stop and keep the evidence: the written tree does not hold exactly the planned entries (the error names the tree); report it, never promote it. |
| `promotion_source_unavailable` | precondition | 3 | This process has no promotion source installed (the web server does not run git): use the engine CLI, `npm run promote`. |
| `promotion_locked` | precondition | 3 (auto 0) | Another promotion of this target is running (it holds the target's lock): wait for it, then run again (a rerun resumes from the refs). |
| `promotion_held` | precondition | 3 (auto 0) | Automatic promotion is held (after a rollback, or by `hold`): fix the source, then `release-hold --reason <text>`, or `apply --release-hold --reason <text>` once. |
| `promotion_parked` | parked | 7 (auto 0) | The remote carries the promotion, but the checkout holding the target has local edits on the paths it changes (named): commit them on the source or discard them there, then run again (or `git merge --ff-only` there) — nothing is rebuilt. |
| `promotion_target_index_locked` | errored | 4 (auto 0) | None: another git holds the target checkout's index (git's index lock); the promotion is published and the next run lands it. The promoter never deletes a lock. |
| `promotion_target_diverged` | precondition | 3 | The target's local branch and its remote have both moved apart: reconcile the named refs by hand (never force), then run again. |
| `promotion_source_diverged` | precondition | 3 | The source's local branch and its remote have both moved apart: reconcile them on the source (never force), then run again. |
| `promotion_push_rejected` | precondition | 3 | The remote moved twice during the promotion (the push was re-planned once): inspect the remote; never force. |
| `promotion_push_errored` | errored | 4 | None: the remote was not reached (the network, a busy server); the commit stays pinned and the next run pushes the same commit. |
| `promotion_remote_errored` | errored | 4 | None: the remote was not reached while reading its refs (the network, a busy server); run again later. |
| `promotion_remote_refused` | precondition | 3 | The remote refused (a permission, a protected branch, its hook: git's words are named): fix the remote's access or rules; the commit stays pinned. |
| `promotion_post_publish_mismatch` | integrity | 6 | Stop and keep the evidence: after a successful push the remote's target is not the promotion commit; inspect the remote (`git ls-remote`) and report it. |
| `promotion_rollback_invalid` | precondition | 3 | Name a promotion commit of this profile on the target's first-parent history that is not the current tip and is not itself a rollback (a rollback of a rollback is refused): `git log --first-parent <target>` lists them. |
| `promotion_work_root_filesystem` | input | 2 | Set `workspaceIsolation.workspaceRoot` to a folder on the repository's filesystem (never a tmpfs): the candidate and the promoter home live there. |
| `promotion_work_path_occupied` | precondition | 3 | A folder this run must create (the candidate or the promoter home: its path is named) exists and is not this repository's: remove it if nothing runs there, or give this checkout its own `workspaceIsolation.workspaceRoot`. |
| `promotion_home_setup_failed` | failed | 5 | A setup command of the source's own engine failed in the promoter home (the folder is named): read its output tail and fix on the source; the next run re-runs it. |
| `promotion_home_setup_errored` | errored | 4 | None: a setup command of the promoter home was ended by the environment (a busy or offline machine; the retries are exhausted); run it again later — the next run re-runs it. |
| `promotion_promoter_failed` | failed | 5 | The source's own promoter, re-executed in the promoter home, ended without an answer (its exit code and last line are named): a defect in the source's engine; run the same verb from a checkout clean at the source to see it, and fix on the source. |
| `promotion_promoter_errored` | errored | 4 | None: the source's promoter in the promoter home was ended by the environment (its ceiling or a signal); run it again later (a rerun resumes from the refs). |
| `promotion_setup_failed` | failed | 5 | A setup command failed on the projected tree: read its output tail and the kept candidate (its path is named), and fix on the source. |
| `promotion_setup_errored` | errored | 4 | None: a setup command was ended by the environment (a busy or offline machine; the retries are exhausted); run it again later. |
| `promotion_gate_failed` | failed | 5 | A converge or verify command failed on the exact tree: read its output tail and the kept candidate, and fix on the source. |
| `promotion_gate_errored` | errored | 4 | None: a converge or verify command was ended by the environment (a busy or offline machine; the retries are exhausted); run it again later. |
| `promotion_not_converged` | failed | 5 | The converge commands do not reach a fixed point on the projected tree (the named files keep changing): fix the generator on the source. |
| `promotion_undeclared_write` | failed | 5 | A command wrote a path no generator declares (or a gate changed the tree it judges): register the output with its generator, or stop the command writing it. |
| `promotion_commit_refused` | failed | 5 | The repository's commit hook refused the certified tree (its words are named): the gates missed what it checks — fix on the source and add the check as a gate. |
| `promotion_objects_missing` | integrity | 6 | Stop and keep the evidence: the promotion commit reaches objects the store lacks; report it, never publish it. |
| `promotion_candidate_mismatch` | integrity | 6 | Stop and keep the evidence: the candidate or its commit does not hold the tree and parents that were computed; report it, never publish it. |
| `promotion_git_errored` | errored | 4 | None: a git step of the landing was ended by the environment (its ceiling, a signal, a full disk); run it again later (`workspaceGit.timeouts` bounds each step). |
| `promotion_git_failed` | integrity | 6 | Stop and keep the evidence: a git step of the landing refused (its operation and words are named, the candidate is kept); report it, never publish it. |
| `promotion_pending_conflict` | integrity | 6 | Stop and keep the evidence: another run pinned the pending ref while this one held the target's lock; report it, never publish either commit. |
| `promotion_release_due` | ok | 0 | The train departs: build the assets from the product commit, assemble and attest them, and publish the release immutable. |
| `promotion_release_not_due` | ok | 0 | Nothing to do now: each reason names what the next release waits for. |
| `promotion_release_notes_written` | ok | 0 | The notes are the release's body: publish them with the release, unedited. |
| `promotion_release_assembled` | ok | 0 | Attest each asset (its digest is listed), then publish the release immutable. |
| `promotion_release_usage` | input | 2 | Run `harness release <plan|notes|assemble> --releases <records.jsonl>` (plan: `[--now <iso time>] [--manual]`; notes: `--repository <forge>/<owner>/<name> --out <file> [--now <iso time>] [--manual]`; assemble: `--out <empty folder> --bundle <file> --guardian <file> --sbom <file> --docs-site <file> [--now <iso time>] [--manual]`). |
| `promotion_release_settings_missing` | input | 2 | Declare `promotion.release` in the configuration (the product's profile, the train mode, the minimum interval, the tag prefix, the Discussions category, the prior releases' address). |
| `promotion_release_product_missing` | input | 2 | Promote first (the product ref is the target of the release profile), or fetch the product branch. |
| `promotion_release_source_unproven` | integrity | 6 | Stop and keep the evidence: the product tip carries no Projected-From trailer, so something other than the publisher wrote it; inspect the product branch, never release it. |
| `promotion_release_tag_lightweight` | integrity | 6 | Stop and keep the evidence: a release tag on the product's line is lightweight, so the train did not make it (it creates annotated, immutable tags only; the tags ruleset requires them); find who made it, never release over it. |
| `promotion_release_version_invalid` | precondition | 3 | Fix on main: the root package.json declares the product's semantic version, and a release version never goes back. |
| `promotion_release_assets_incomplete` | failed | 5 | Build every named input (the engine bundle, the guardian, the SBOM, the documentation site) and assemble again: a release never ships without one. |
| `promotion_unexpected` | integrity | 6 | Stop and keep the evidence: the landing ended on an error no code names (its message is given, the candidate is kept); report it. |
