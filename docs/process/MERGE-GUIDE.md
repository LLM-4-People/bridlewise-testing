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

`npm run ws -- merge <id>` (= `node engine/src/cli.ts harness workspace merge
<id>`, the integrator in `engine/src/workflow/workspace-manager.ts`) lands a
validated workspace on its target branch — one of
`workspaceIsolation.landTargets` (this repository: `testing` only; `master`
never). It lands locally and the caller pushes. Under the repository's merge
lock (merges queue):

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

## 2. The commands

```bash
node src/cli.ts harness workspace create --agent <name> --write-set <path…> [--target <branch>] [--base <ref>]
node src/cli.ts harness workspace validate <id> [--full]
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
| `promotion_usage` | input | 2 | Run `harness promote <status|plan|explain|apply|forge-publish|rollback|hold|release-hold|auto> [--profile <name>] [--source <rev>]` (apply: `--no-publish`, `--no-push`, `--accept-target-edits <path>… --reason <text>`, `--allow-deletions --reason <text>`, `--release-hold --reason <text>`, `--auto`; rollback: `--to <promotion commit> --reason <text>`; hold and release-hold: `--reason <text>`; auto: `--refs <refs>`; forge-publish: `--out <file>`). |
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
| `promotion_forge_published` | ok | 0 | Attest the projection receipt (its digest is the attestation's subject); the product branch on the forge is the published commit. |
| `promotion_forge_nothing_pending` | precondition | 3 | Build the promotion in this job first (`harness promote apply --no-publish`): forge-publish carries the profile's pending commit. |
| `promotion_forge_target_moved` | precondition | 3 | Another publication landed on the product branch since this promotion was built: run the publish job again; it rebuilds on the new head. |
| `promotion_source_unproven_commit` | integrity | 6 | Stop and keep the evidence: the pending commit is not a promotion commit (no Projected-From or Promotion-Profile trailer, or parents other than [product tip, source]); never publish it. |
| `promotion_forge_refused` | precondition | 3 | The forge refused the publication (the forge code and remedy are named): fix the publisher App's permission or the repository's rules, then run the job again. |
| `promotion_forge_errored` | errored | 4 | None: the forge failed or a budget is spent (the forge code says which, and when to resume); run the job again later — nothing was published, or the next run finds the branch moved and rebuilds. |
| `promotion_forge_mismatch` | integrity | 6 | Stop and keep the evidence: the forge stored or signed something other than the built commit (a blob, the tree, an unverified commit, or a branch not at the published commit); report it with the request ids. |
| `promotion_unexpected` | integrity | 6 | Stop and keep the evidence: the landing ended on an error no code names (its message is given, the candidate is kept); report it. |
