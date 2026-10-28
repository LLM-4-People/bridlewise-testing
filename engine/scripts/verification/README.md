# Verification scripts

The verification library: the gates the `harness check` command and the test
runner's auto-heal preflight execute against the tree. Each module owns one
verification family and reports typed violations; nothing here mutates
source.

## What each file does

- `architecture.ts` — verifies the architecture manifest against the source
  tree (modules, layers, effects, drift).
- `catch-blocks.ts` — the ONE catch classifier both repositories' catch
  guards use (engine `no-empty-catch-blocks`, `no-unhandled-errors`; web
  `no-empty-catch`): finds every `try/catch` and inline `.catch(...)` block
  through the sanctioned source view and classifies it `empty`, `unhandled`
  or `handled` (throws or rejects its promise, returns, CALLS a central
  handler — the engine's or the web's, never console output — or uses the
  caught binding; `void e` and a bare `e;` discard it) and reports
  `handledBy`, so a subsystem can hold a stricter policy on the same reading
  (the memory rule). A handler named in a comment or string is not handling.
- `candidate-format.ts` — the candidate-format gate: refuses byte-order
  marks, wrong final newlines, and other non-canonical file bytes.
- `candidate-manifest.ts` — THE CANDIDATE MANIFEST: the engine runner's setup door (`buildCandidateManifest`) certifies a tree before a test runs; `--root . --verdict` answers only whether it would accept the tree, which `harness check`'s candidate-format step asks. It ships, so a product tree's check asks the same door.
- `effect-surface.ts` — classifies each module's filesystem and process
  effects for the architecture manifest.
- `filesystem-cache.ts` — a generic filesystem-backed cache for
  pure-function verification results shared across processes.
- `gitignore-anchoring.ts` — refuses ignore rules that match at every depth
  by accident.
- `official-fragment-manifest.ts` — the schema for the pinned official
  source fragments (OpenAI, MCP) the protocol slices vendor.
- `ratchet.ts` — THE ONE shrink-only ratchet for accepted-debt baselines
  (`{schema, entries: [{key, reason}]}`): judges a guard's findings for new,
  stale and GROWN entries against the baseline as committed at `HEAD`, and
  the commit guard refuses a staged baseline that grew or carries an entry
  with no reason (the inline-literal and web unhandled-catch baselines use it).
- `ratchet-baselines.ts` — THE RATCHET BASELINES AND THEIR GENERATOR (a2b-design H2): every shrink-only baseline declared in `ROOT_POLICY.verification.ratchetBaselines` (a generated output) with the scan its guard judges (the engine's inline-literal defaults, the web's unhandled catches, the repository's dead Markdown links — `src/workflow/record-links.ts` — the guards call the same function). `harness sync` prunes each baseline (an entry no finding matches is removed; a key is NEVER added), `harness check` reports a stale entry as drift and fails on new debt (`ratchet-baselines` step), and `--introduce <id> --reason <tracker id>` writes a new baseline once (refused when it exists).
- `repository-git.ts` — what the candidate manifest reads of git: the repository probe, the tree entries, a file's git mode and its blob id.
- `shipped-hooks.ts` — THE SHIPPED HOOKS GENERATOR (PROMO34FIX-HOOK-GENERATOR): every canonical `.githooks/<hook>` (`SHIPPED_HOOK_FILES`, `src/kernel/verification-paths.ts`) written whole from its owner (`staged-move-loss.ts` `shippedHookText`: a guarded hook's prose and body, the trigger's `promotionTriggerHookText`); `harness sync` writes them (a new one executable), `harness check` reports one that differs (`shipped-hooks` step); a tree without the hooks folder is converged by absence.
- `decision-index.ts` — THE DECISION INDEX GENERATOR (wf-1b3a-design M1): `docs/decisions/README.md`'s index block rebuilt from the decision files' front matter and titles (`tracker-entries.ts` `renderDecisionIndex`); `harness sync` writes it, `harness check` reports it stale (`decision-index` step); a tree without the decisions folder is converged by absence.
- `commit-trailers.ts` — THE ONE READER of a commit's trailers (git's own
  parse, `git interpret-trailers --parse`; the key exact) the commit doors
  share.
- `test-deletions.ts` — A DELETED TEST IS A NAMED DECISION: every path a
  commit takes off the recognizable test surface (renames included) is named
  in a `Test-deleted: <path>` trailer, and no trailer names a kept test. One
  judge, asked by the `commit-msg` door (the index), `post-commit` (an amend)
  and the required `commit-records` workflow (`--range <base>..<head>`, main's
  code over a pull request's or merge group's commits). Nothing is committed
  beside the trailer, so no list conflicts (#221); `harness sync --prune`
  stays only for the entry of a deleted test with an exception disposition.
- `pattern-liveness.ts` — per-pattern liveness: refuses a guard whose
  per-pattern universe silently dies while the scalar floor stays green.
- `safe-repository-reader.ts` — descriptor-verified, symlink- and
  mount-boundary-safe repository reads for verifiers.
- `slice-declarations.ts` — the schema and loader for the canonical slice
  declarations.
- `slice-projection-captured-values.ts` — the captured-value projections
  bound into the slice traces.
- `slice-projection-inputs.ts` — the input set each slice projection is
  derived from.
- `slice-projection-paths.ts` — re-exports the slice projection artifact
  paths from the kernel owner.
- `slice-projections.ts` — regenerates the slice projections and compares
  them against the checked artifacts.
- `slice-source-contracts.ts` — the source-side contracts the slice
  verifiers bind (vendored licenses, manifests, research receipts).
- `staged-move-loss.ts` — refuses a staged move that would drop a tracked
  file at the door every move passes through, read from the git being
  committed with rename detection off (a similar new file never hides a
  loss), a regular file replaced at its path counted as deleted and a blob
  staged at another path accounted for (`stagedDeletions`); the ignored copies
  come from the shared pairing (`src/git/ignored-copies.ts`, the machine-local
  ignore view). A deletion paired with an ignored copy passes only when it was
  DECLARED and the declaration is still pending with no copy it did not record
  (`judgeLosses`, `commitLossVerdict`; `src/git/declared-deletions.ts`); each
  refusal carries its typed code, and one made for the merge's own commit
  (`MERGE_COMMIT_FLAG`) names the merge route.
- `static-source.ts` — the static module-graph acquisition model: direct
  imports, re-exports, dynamic imports, and `require()` calls.
- `test-surface.ts` — verifies the test-surface disposition manifest through
  the runtime owner (the manifest has one owner, and it is not here).
- `source-walk.ts` — THE ownership-pruned source walk both suites use (`walk`, `walkTs`, `repositoryOwnedEntries`, `gitTrackedPaths`): prunes by the versioned ignore rules, takes declared narrowings (`ignore`, `exclude`, `experimentExclusion`), refuses a missing or ignored root, and refuses a result smaller than the git index for the same narrowing.
- `event-loop-callbacks.ts` — the event-loop callback census (SCALE-CR1 C3, SCALE-CR1-FIX N3): every timer (bare or a member, e.g. `globalThis.setTimeout`), emitter/event-target listener (by name or computed), watch/request/listen callback, node-style completion callback (`COMPLETION_CALLBACK_APIS`: a stream's write/end, exec, the fs/crypto/zlib/dns forms; `get`/`request` of a node HTTP client) and `on<event> =` handler in `server/` and `engine/src/` registered through `guarded(owner, fn)` (or a promise settler); names resolved through their LEXICAL SCOPES (a same-named binding elsewhere, a reassigned `let`, a shadowing parameter are not guards); parsed with `@babel/parser`. The fault policy's doors (`processDoorFindings`, SCALE-CR1-FIX H2): `installProcessFaultPolicy` only in `FAULT_POLICY_DOORS`, and every `new Worker(` spelled `new Worker(...bootstrappedWorker(…))`. And the user-defined SQL function census (`sqliteUserFunctions`: closing a database inside one is a SIGSEGV). Judged by `tests/prevention/guarded-callbacks.test.ts` (counts 0, no allowlist).

## Where it lives

The folder lives at `engine/scripts/verification/`.

## Runtime and erased module references

`architecture.ts` (Babel) and `static-source.ts` (independent tokens and bounded
context tracking) compare separate runtime-acquisition and erased-reference
sets. Runtime edges drive graph/effect checks; their union drives exact unknown
and excluded-target checks. Whole type imports/exports, import types and erased
ambient ancestors retain their source references without loading a module.
Ordinary import/export wrappers containing only inline `type` specifiers still
load their target under pinned Node24.18 stripping and TypeScript verbatim
emission. Source exported-name catalogs retain type names; they are not runtime
namespace inventories.

Every lexical caller supplies its actual source path. Shared source extensions
select TS versus JSX/TSX text handling, and the shape cache binds that path,
source bytes, analyzer bytes and shared extension-owner bytes. Both caches
require the erased channel to be a string array. JSX text is inert; embedded
expressions and runtime initializers remain acquisitions. Unknown acquisitions
remain explicit and may prevent admission. Value import-equals, export
assignment and angle assertions receive explicit strip-only profile refusal;
the enclosing verifier retains its coarse source-parse diagnostic, which does
not mean Babel grammar parsing itself failed. Ambient ancestors are erased
before those runtime-only checks, but their references and source names remain.

This is not complete TypeScript profile admission. Runtime enum, instantiated
namespace, parameter property and legacy identifier-module checks, namespace API
scope, inert-template/interpolation precision and independent literal-constant
loader resolution remain required repairs. Native stripping is a fixture oracle
for complete supported plain TypeScript, not production preprocessing for JSX,
TSX or tokenizer fragments. Unavailable analyzer source is independent of result
cache accessibility; the shared identity correction below enforces that boundary.

Analysis result caches require a successfully read analyzer/dependency identity.
If source bytes are unavailable, all four callers compute without result-cache
lookups, writes or eviction; failed identities are retried and successful ones
remain process-memoized. Existing local AST parse caches are separate. The shared
identity owner frames ordered URL memo tuples and ordered source-text tuples with
`canonicalJson`; URLs are not included in the semantic content digest. This
intentionally invalidates the old ambiguous NUL framing. Static literal result
keys retain property segments as an ordered array and hash current boundary and
binding values on each call, without retaining mutable argument identities.
These changes qualify identity and result reuse. Cached-value admission is
qualified below; concurrent capacity and persistence remain separate work.

Cached architecture and lexical results now require all declared fields and
nested value types, preserving explicit unknown targets and budget-refusal facts.
Literal success requires an own value containing finite canonical JSON data. S1
requires a result hash equal to its requested envelope identity and an ok flag
consistent with its complete string violation list. Malformed values trigger
fresh computation; shape checks cannot authenticate well-formed fabricated facts.

Counter/trim failures and unsuccessful atomic publication report through the
fixed central best-effort diagnostic, without raw errors or paths. Native cap-4
evidence proves serial overflow and delayed-reset lost counts; the current
protocol remains a required capacity repair, not an admitted strict cap.
