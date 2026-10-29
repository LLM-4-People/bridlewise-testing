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

What is projected today (no label: every label, the lanes' included, is declared once in `docs/community/labels.json` and applied by `harness forge apply`; an issue carries its lane's label only once it exists, `projection_label_missing` otherwise, never created on the way):
- one milestone per Milestone item: `<id> · <title>`, with its computed state and the reason in the description, closed once shipped;
- one issue per tracker item, Milestones included. Each carries:
  - title, type and lane label;
  - its milestone;
  - its sub-issue parent: the item's parent, else its Milestone's issue, so the hierarchy reads milestone → workstream → task;
  - `blocked_by` links;
  - open or closed with its reason (a Milestone's state is computed from its members);
  - a generated block. The marker carrying the item's id and digest comes first, every relative link becomes a permalink at S, and a footer gives the computed roadmap state with its evidence.

- MAIN-RED (not live yet: nothing appends main's runs to the ledger, and the GitHub store has not run against GitHub, #164): one issue per workflow judged on `main` in the ledger, keyed `MAIN-RED/<workflow>` and of type Bug. Its workflow's run is the one at the newest commit on main by ancestry, never the last appended. It is open and pinned while that run failed; its body names every failing test and the open records that own it, or UNOWNED, each through the markup owner's GitHub escape (no code span to break out of, no Markdown or HTML, no `@mention`), and stays under GitHub's 65,536-character body limit with a stable count of the tests it does not show. It closes as completed and unpins once main is green again. The failure-issue workflow stays until MAIN-RED is live.

Every other field of a GitHub object is GitHub-owned and never written.

**Foreign edits (V-27), judged per field.** A field no record holds (`PROJECTOR_OWNED_FIELDS`: an issue's generated block and pin, a milestone's computed description and state) is never a record change: an edit of it on GitHub is re-projected in every mode and never proposed. Each receipt records, for every object, the digest of each git-owned field as projected and observed.
- A field is foreign-edited when its live value differs both from D and from the value the previous receipt recorded for that field.
- A field with no recorded value is simply written. That covers a field newly owned by git and a first run.
- A projected object the previous receipt recorded that is gone from GitHub was deleted there, and that deletion is itself a foreign change.

The audit event `forge.projection.drift` reports each one, and the mode `forge.projection.foreignEdit` handles it:
- `approval` (the default): the edited field (or the deleted object) is not written. A proposal holds only the edited fields' live values, or the deletion.
- `auto`: the value is restored (the object recreated), and an issue gets a notice.
- `manual`: the change is reported only.

One held field never blocks another field or object. A held field keeps its baseline, so it stays foreign until one side meets the other, and the receipt is unverified (`projection_drift`) while anything is held.

## What each file does

- `model.ts` — THE MODEL (pure): D's objects (class, key, git-owned fields), the classes in write order, each field's write phase (create → link → state), the fields GitHub gives a just-created object (`BORN_FIELDS`), the input D is computed from (`ProjectionInput`), the item marker and the lane label.
- `project.ts` — `project(input)` (pure): the milestones and the issues, sorted by class then key, every relative link of an item's body made a permalink at S, the record's own permalink in the footer; `projectText`, the confined program's text-in, text-out entry.
- `confined.ts` — THE CONFINED CALL: `linkProgram` links the declared pure modules into one stdin program. Types are stripped, relative imports are rewritten to `data:` URLs, and an undeclared, bare, built-in or literal-dynamic specifier is refused (`projection_import_refused`). `confinedCall` runs the program under the guardian and types its ending (`projection_confinement_refused`, `projection_impure`, `projection_cpu_exhausted`, `projection_failed`). `PROJECTION_PROGRAM` is the projection's module set, and `ProjectorConfinement` its harness, keep-out facts and CPU ceiling.
- `projection.ts` — D from two trees: `deterministicCall` (two confined runs that must agree), `roadmapFeedInput` and `computeRoadmapFeed` (the feed's input — the items and decisions at S, S's date, a snapshot of every item's status facts at each first-parent landing that changed an item or a decision, read as written then — and its confined computation),  `projectionInput` (the tracker items read from the source COMMIT through the tracker's one parser, `../../failure-owners.ts`, each lane label refused unless S's `docs/community/labels.json` declares it — read through its owner's `readLabels` from S's tree, `projection_label_undeclared` naming each item, `projection_labels_missing` without the file — and main's health at the ledger commit with each failing test's owners from S's board, `ownersOf`) and `computeProjection` (the confined calls, each marker's digest filled in, D's canonical digest).
- `roadmap-feed.ts` — THE ROADMAP DATA FEED (pure, run confined like the projection, `ROADMAP_FEED_PROGRAM`): `roadmap.json`, `bridlewise-roadmap-feed/v1` (see below).
- `main-runs.ts` — WHAT THE PROJECTOR READS FROM THE LEDGER (L): `main-runs.jsonl`, rows `bridlewise-ledger-main-run/v1` `{ schema, workflow, commit, conclusion, runUrl, failedTests: [{ path, message }] }`, to be appended by the run's judge (not yet: no judge writes it today); `mainHealth` answers each workflow's row at the newest commit on main by ancestry (a re-run of one commit by its last row), accepts only this repository's own Actions run URLs, and refuses a malformed row (`ledger_row_invalid`) or rows on diverging commits (`ledger_rows_diverge`) typed, never skipping one.
- `store.ts` — THE STORE PORT the algorithm reads and writes GitHub through, in the projection's own terms (class, key, git-owned fields); the GitHub store is written on the forge port's client.
- `github-store.ts` — THE GITHUB STORE: `githubProjectionStore(client, { repository, maxPages })`, the store port on the forge port's `ForgeClient`. The repository's label names (case-insensitively, as GitHub names them: an issue's labels are sent as GitHub spells them, and one missing is refused `projection_label_missing`, never created), the milestones and marked issues THE PROJECTOR CREATED (their author is the publisher App's bot, from the App registry; anyone else's, marker or title notwithstanding, is never its own) are read as conditional REST lists, and the relations (sub-issue parent, blocked-by) and the pin through one paginated GraphQL query. Writes use REST (milestones, issues, comments, sub-issues, dependencies) and the pin uses GraphQL. A reporter's text above the marker is kept. A duplicate marker or milestone of its own, an unknown key or field, and a relation longer than a page are refused typed (`projection_store_*`).
- `apply.ts` — THE ONE APPLY ALGORITHM: foreign edits detected against the previous receipt and handled by mode (`ForeignEditMode`), `planProjection` (the writes that make the live state equal D, in phase, class and key order, and the orphans), `applyProjection` (write within the run's allowance, paced; re-read; verify; the receipt `bridlewise-projection-receipt/v1`), `verifyProjection` and `projectionFailure` (`projection_unverified` before any refusal; a budget refusal is retryable and the next run resumes).

## The roadmap feed (`bridlewise-roadmap-feed/v1`)

A pure function of a commit and its first-parent history, computed confined (twice); `engine/scripts/tooling/roadmap-feed.ts --at <commit>` prints it. No typed date is an input: every time in it is a git LANDING time. Its stable fields:

- `source`, `sourceDate` (S's committer date: the feed's "now"), `states` (the state vocabulary), `totals` (items per state);
- `milestones[]`: `id`, `title`, `order`, `state` and `because` (computed from the members), `members`, `counts` per state, `progress` (shipped over planned members), `criticalPath` (the longest chain of open work through `blocked-by`, the blocker first), `eta` (`done`; `unknown` with `because`; or `band` with `weeks.low`/`weeks.high` — weeks, never a date), `record` (permalink);
- the states: `shipped` (a close PROVEN by linked evidence), `claimed` (a close nothing proves), `in progress`, `planned`, `blocked`, `not planned`;
- `items[]`: `id`, `type`, `title`, `lane`, `milestone`, `parent`, `children`, `blockedBy`, `relates`, `horizon`, `order`, `owner`, `area`, `severity`, `state`, `because`, `landed` (`first`, `shipped`: the landing times at which it appeared and became shipped), `decisions`, `tests` (`path`, `url`), `rfc`, `gh`, `evidence`, `record`;
- `decisions[]`: `id`, `title`, `status`, `progress` (built, partly built, designed, standing, superseded), `carriedBy` (item ids);
- `history[]`: one entry per first-parent landing that moved a state (a landing that changed only a decision record or an evidence manifest included) — `commit`, `date`, `changes[]` (`id`, `from`, `to`; `null` for an item's first appearance or removal): burn-up, the roadmap at any commit and "what changed since" are replays of it;
- `throughput`: `weekly` (work items that became shipped per whole week, by the landing time that made them so, from the first such landing to S), `minimumWeeks`, `enoughHistory`, `windowEnds`.

Every state is computed (`src/workflow/tracker-status.ts`); nothing in the feed is typed by hand.

## Tests

`engine/test/forge/projector.test.ts` proves V-25 (a second run makes zero
writes; a changed record is never taken for a foreign edit), V-27 (a foreign
edit in each class — milestone, issue — handled per mode, judged per
field: a newly owned field written, one held field blocking nothing else, a
deletion proposed, recreated or reported), V-26 (by the kernel: a dynamic-import write, a harness or /proc read,
a connect and a fetch to a live server are refused, the server sees no
connection; the clock and randomness are refused by computing twice; the
link refuses undeclared modules; a CPU spin meets its ceiling; a NODE_OPTIONS
preload never reaches the program; a host without the guardian is a refusal) and V-28 (a field GitHub silently drops is `projection_unverified`),
the phase order, the resumable budget refusal, a refused write, orphans, and
that the input is read from the commit, never the working tree, against the
in-memory store `engine/test/forge/projection-store.ts`. `engine/test/forge/roadmap-feed.test.ts` proves the feed: computed states, progress, the critical path, decisions, the per-landing history, ETA bands that stay `unknown` without enough history, a past item read as written, and one digest per commit.
