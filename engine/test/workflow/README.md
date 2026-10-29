# workflow

The `engine/test/workflow/` folder of the development surface.

## What each file does

- `atomic-write-consistency.test.ts` — the `atomic-write-consistency.test` module.
- `auto-generator.test.ts` — the `auto-generator.test` module.
- `auto-heal.test.ts` — the `auto-heal.test` module.
- `candidate-checkout.test.ts` — the candidate CLI driven on a working copy: missing target parents, refresh keeping the candidate's regenerated outputs (and taking real source edits), copy-back refusing a moved, conflicting or incomplete candidate before writing.
- `deps-adopt.test.ts` — the adoption: the bump derived from the files (npm specs, Actions pins), every unrecognised change refused, a drifted trunk refused, the registry moving action pins, the order (workspace, manifest, lockfile and install commands, sync, commit, publish, then close), the lockfile never copied, and nothing created for a pull request that is not Dependabot's or is closed.
- `candidate-format-check.test.ts` — `harness check` asks the engine runner's own setup door (`scripts/verification/candidate-manifest.ts --verdict`): a tree the runner would refuse at setup (an extra final newline, #417) fails the check, naming the file; a fresh copy passes.
- `evidence-store.test.ts` — the evidence store driven on planted repositories and private stores: ingest through the immutable owner (one object per payload, 0600 in 0700, the one-line-per-entry manifest; idempotent, other bytes for a recorded path refused), verify (missing, corrupt, unsafe; a link inside the store refused), materialize (recorded modes, an identical file left alone, refusals that write nothing, the generated ignore rule), containment (entries outside their folder, in `.git` or the hooks, linked parents for materialize and ingest, the exposed action), the private-home placement and location (under test without the variable: refused) and the keep-out entry, and the `harness evidence` verbs.
- `flaky-burn-down.test.ts` — the burn-down list: an owned entry passes and is said, a new suspect fails, a closed, missing or mis-naming owner fails, an entry added without its owner row fails (read from git history), and an entry stays after its suspect leaves the window.
- `file-mode-contract.test.ts` — the `file-mode-contract.test` module.
- `format-command.test.ts` — the `format-command.test` module.
- `gating-never-subtracts.test.ts` — a WITHHELD TEST IS A SKIPPED TEST, NEVER A SUBTRACTED ONE. This is the regression test for the largest hole the suite has had.
- `harness-commands-cli-fixes.test.ts` — the `harness-commands-cli-fixes.test` module.
- `harness-commands-timeouts.test.ts` — the `harness-commands-timeouts.test` module.
- `community-categories.test.ts` — the Discussion-category audit: no drift when the repository matches the registry; each kind of drift named with what to do; the live read is one GraphQL query on the fake GitHub; the verb refuses what it does not know.
- `community-labels.test.ts` — the one label declaration: it holds the community, Dependabot, lane and forge-marker labels once each, and refuses a colour GitHub would not store or a name declared twice in any case.
- `community-health-files.test.ts` — the community sources' refusals (role table, intake registry), the one YAML emitter, and the generated health files and forms: `harness sync` writes them, `harness check` names a hand edit or a stale form, and this repository's own files are current.
- `community-cli.test.ts` — the `harness community` door: an unknown verb or missing arguments are the typed usage refusal; `credit` answers this repository's contributors with the tooling excluded.
- `community-executor.test.ts` — the IssueOps executor on the fake GitHub: the permission answer mapped to the role ladder, one reply per command comment (a re-delivered event edits it; another author's marker is never edited), a bot's or a plain comment costing no request, a triager's `/accept` answering a record with no issue state written, and `/explain` reading the door's check run.
- `community-issue-ops.test.ts` — the IssueOps decision: the first-line command grammar, the role table's authorisation, each command's arguments, triage commands answering a record (never an issue state), typed text neutralised, and the reply templates agreeing with their keys.
- `community-record.test.ts` — the intake record landed: a typed title made a plain YAML scalar, the item in the tracker's own format (its reader accepts it; an existing id or a dangling parent refused), the board regenerated, and the commit published as a signed twin on `intake/<id>` with one ready pull request that a re-run finds again (GH-3's fake forge over a real bare repository).
- `community-welcome.test.ts` — the newcomer's welcome (issue and scheduled pull-request pass, once each, GitHub's count deciding "first", never a bot), the first-landing thank-you, credit (authors and co-authors by email, tooling excluded, a release's newcomers), and moderation (the spam signal by mode and window, a lock due on the declared day, the maintainer's interaction limit) on the fake GitHub.
- `harness-commands.test.ts` — the `harness-commands.test` module.
- `inventory-test-run.test.ts` — the `inventory-test-run.test` module.
- `module-registrar-scan.test.ts` — the `module-registrar-scan.test` module.
- `module-registrar.test.ts` — the `module-registrar.test` module.
- `parked-patches.test.ts` — every patch kept under `docs/trackers/patches/` still applies to the tree (`git apply --check`), and the check refuses a stale one.
- `resource-lock.test.ts` — the `resource-lock.test` module.
- `reachability.test.ts` — the reachability walk over in-memory trees: every edge kind (static, re-export, side-effect, dynamic, type-only, a URL worker, a glob, a stylesheet `@import`, a Svelte script), what is never an edge (a comment, another string, a template, a directory URL, a builtin), what is reported (unresolved, into an excluded path, missing entries, packages, opaque edges), path aliases, the declared spawn arm (moved from the census), the tokenizer cases that once swallowed edges (a regex after `=>`, a statement head or a keyword; a backtick inside a template substitution), `require`, glob arrays, `{a,b}` and `**` at every depth, symbolic links and seeds.
- `record-links.test.ts` — the one Markdown link extraction and resolution (a file or folder of the tree, `evidence:<recorded path>`, schemes and anchors not judged, a relative link into stored evidence told how to link it) and the repository scan the `dead-markdown-links` ratchet keys.
- `repository-registry.test.ts` — the repository registry: under the common dir, named by the product, its areas, and one registry from a linked worktree and the main checkout.
- `run-diff.test.ts` — two ledgers' judged rows diff into new / persisting / fixed; a row with no failure list is `unmeasured`; a missing row is typed.
- `test-execution-config.test.ts` — the `test-execution-config.test` module.
- `test-inventory-binding.test.ts` — the `test-inventory-binding.test` module.
- `test-result-collector-concurrency.test.ts` — the `test-result-collector-concurrency.test` module.
- `test-result-collector.test.ts` — the `test-result-collector.test` module.
- `site-prose.test.ts` — record prose on a site page: the structure written back from the one parser's tree, relative and absolute links through the page's href, an unsafe scheme as text, destination percent-encoding, and the site escape's single-pass round trip (a reference decoded once, never twice).
- `tracker-items.test.ts` — the structured tracker: every way an item file breaks `bridlewise-tracker-item/v1` is refused and the whole set refused typed, an item's links reaching the board from the board's folder, no spelling of an item (raw HTML, Liquid, an attribute list, a javascript: link, an unclosed fence) publishing markup on the board while the owners judge still reads a test's path, the board's lane and Done order, check and sync on a scratch tree, and this repository's board equal to its items row for row.
- `tracker-status.test.ts` — the roadmap state computed from evidence: closed items shipped or not planned, blocked while a blocker is not shipped, in progress when a sub-item landed (transitively) or a decision it carries out is built or partly built, planned otherwise; a Milestone's state from its members; a decision's progress from its front matter.
- `tree-landing.test.ts` — the tree landing's postconditions over a port whose answers the test chooses: a candidate that does not hold the computed tree, a commit recording another tree or other parents, a commit reaching missing objects (each refused, typed), a hook's refusal answered as `commit_refused` with its words, and a git step's failure typed by the phase runner (the machine's `git_errored` over both git doors, git's refusal `git_failed`; a commit the machine ended is never `commit_refused`) (the real flow is `promotion/apply.test.ts`'s).
- `harness-prune.test.ts` — a deleted test is refused with its typed code (surviving a trailing runtime warning) and the exact `--prune` command; a named prune goes through, a present file cannot be pruned.
- `working-copy.test.ts` — the working-copy builder (mirror, stage-all, staged, narrowed; canonical alternates, no store freshening, the git staging view, remotes), refresh (keeping authored paths) and differences, the checkout setup, the command runner (its errored/failed classes — an environmental code counts only on a line that reports it — the errored-class retries inside the runner, a ceiling retried, a workspace phase riding out an errored install, and the runner's log line per attempt), the `workspaceIsolation` setup schema and the dead-command rule's owner (`unconsumedCommands`), and a copy of this checkout answering the conservation identity as the checkout does.

## Where it lives and what consumes it

The folder lives at `engine/test/workflow/`.
