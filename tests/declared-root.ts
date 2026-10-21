/**
 * EVERY ENTRY AT THIS REPOSITORY'S ROOT **THAT GIT MUST HOLD** — and nothing
 * else.
 *
 * ── WHAT THIS MODULE IS AND IS NOT ────────────────────────────────────────
 *
 * It is NOT the population. The population is WALKED, by
 * `tests/prevention/declared-root-inventory.test.ts`, from `readdirSync` and
 * the git index. This module supplies only the CLASSIFICATION of what the
 * walk finds, and an entry the walk turns up that no ignore rule names and no
 * declaration here covers is a RED — deny by default.
 *
 * That split is the whole design, and it is a direct consequence of the
 * defect that produced this file. A guard driven from a LIST can only ever
 * report a DELETION: it iterates names it already knows and checks they are
 * still there. The failure that actually happened was an ADDITION —
 * `.bridlewise.fresh-evidence-<epoch>/` appeared beside `.bridlewise/`,
 * the root ignore rule named the unsuffixed spelling only, so nine files
 * including the database encryption key and both databases were committed
 * with `git status` clean throughout. A list would have iterated its known
 * names, found every one of them intact, and said nothing.
 *
 * ── THE CLASS IS AN OBLIGATION ON THE INDEX ───────────────────────────────
 *
 * A class here is not a label. It is a claim about the git index that the
 * guard enforces, and all three make the same one:
 *
 *   product  ⇒  PRESENT in the index. The program is built from it.
 *   proof    ⇒  PRESENT in the index. It verifies the program.
 *   record   ⇒  PRESENT in the index. It documents what happened.
 *
 * They are distinguished for the reader, not for the check — the check treats
 * them identically. They differ in what a future round is allowed to do:
 * `product` and `proof` are load-bearing, `record` is a thing that may be
 * archived or deleted once its round is closed.
 *
 * ── `product` IS DERIVED, NEVER DECLARED ──────────────────────────────────
 *
 * What ships is the promotion profile's answer (`promotion/*.json`, the
 * projection `harness promote` runs; `tests/helpers/promotion-view.ts`): a
 * root entry is product iff a shipped path lies under it. A declaration
 * here therefore states a class ONLY for an entry that does not ship (`proof`
 * or `record`) and none for one that does — the inventory guard reds both
 * disagreements by name (a class on a shipped entry is a second answer to
 * the profile's question; a missing class on an entry that does not ship
 * leaves it unexplained). Two declared classes were wrong the day this rule
 * landed and nobody could see it: `cockpit-dev.html` and the test and
 * template tsconfigs were "product" yet never shipped.
 *
 * ── THERE IS NO `ignored-runtime` CLASS, AND ITS ABSENCE IS THE POINT ─────
 *
 * There was one. It named six entries — `.bridlewise`, its suffixed
 * sibling, `.dev`, `.git`, `node_modules`, `test-results` — and asserted the
 * mirror obligation: ABSENT from the index. That obligation is the valuable
 * half of this file and it is **not** gone; it moved to the instrument that
 * can hold the whole population instead of six names. Three measurements
 * killed the hand-written version:
 *
 *   1. **The repository's own supported operations red it.** One run of
 *      `scripts/harness-root/merge-round.mjs` writes `.merge.lock` and
 *      `MERGE-ROUND-REPORT.json` at this root. Both have dedicated anchored
 *      ignore rules — the repository *expects* them — and neither was
 *      declared, so a sanctioned operation produced two `UNDECLARED ROOT
 *      ENTRY` problems. Declaring those two would have closed two instances
 *      of a class with sixteen more anchored rules in it, every one of them
 *      a trap armed for the day somebody runs the operation.
 *
 *   2. **It could not pass on a fresh clone**, which was its own acceptance
 *      test. Four of the six entries do not exist until somebody installs and
 *      runs, so a clone produced four `DECLARED ROOT ENTRY … no longer
 *      exists` reds. Relaxing the arm for those four would have deleted the
 *      check that a declaration cannot outlive its subject.
 *
 *   3. **One of the six was a literal that can only ever be true on one
 *      machine** — `.bridlewise.fresh-evidence-1785461259`, an epoch typed
 *      by an operator during one incident. A name no other checkout will ever
 *      carry is a note, not a declaration, and the ignore file had already
 *      met this exact problem and answered it with a SHAPE rule rather than a
 *      second literal.
 *
 * All three are the same defect: **`.gitignore` and this file were two owners
 * of one question** — "which root entries are runtime state git must not
 * hold". Two owners of one question drift, and this pair drifted in the worst
 * direction, because the file that git actually obeys was the one that stayed
 * right. So the question has one owner now, and it is `.gitignore`: the guard
 * asks git's own matcher which entries are ignored, and enforces
 * ABSENT-FROM-THE-INDEX over every one of them rather than over six.
 *
 * AND THE RUNG IS 5, NOT 2. The collapse was recorded as making the bad state
 * "unrepresentable", and that is the wrong word for what was achieved. Rung 2
 * means the TYPE cannot express the bad state; the bad state here is a
 * filesystem fact — a directory sitting at this root — and no type in this
 * program has ever been able to express or forbid it. Removing a member from
 * a union did not make anything unrepresentable; it stopped the guard asking a
 * question. What the collapse actually achieved is rung 5 with a GIT-DERIVED
 * universe instead of a hand-written one, which is a real and large
 * improvement over rung 5 with a list — the universe can no longer be wrong by
 * omission — and it is worth naming honestly, because a verdict of "rung 2"
 * tells the next reader not to look for holes in the universe. There was one:
 * see `UNNAMED IGNORED ROOT ENTRY` in the guard.
 *
 * The consequences are worth stating, because they are the reason this is a
 * collapse rather than a relaxation:
 *
 *   - **There is no list of runtime entries to forget to update.** A
 *     supported operation that writes a root path with an ignore rule is
 *     classified the moment it lands. One that writes a path with NO rule is
 *     still a RED, from the deny-by-default arm below — which is the honest
 *     answer, because such a path is also sitting in front of `git add -A`.
 *   - **A declaration here for an ignored entry is itself a RED.** That is
 *     what keeps the collapse collapsed: re-adding `test-results` to this
 *     file re-creates the second owner, and the guard says so by name.
 *   - **`.git` is not declared and is not walked.** It is git's own store,
 *     no index can contain it, and no ignore rule can name it — measured:
 *     `git check-ignore --no-index .git/probe` matches nothing. The guard
 *     derives the name from `git rev-parse --git-dir` rather than writing
 *     `.git` down, and asserts both of those facts rather than assuming them.
 *
 * ── AN ENTRY IS CLASSIFIED AS IT STANDS, NEVER AS IT IS ABOUT TO BE ───────
 *
 * An earlier version of this file carried nine entries annotated as residue
 * "the clean-root work will remove" — `experiments/`, `.bkp/`, five stray
 * merge manifests, a scratch probe that wrote to the live database, and an
 * empty directory skeleton. They were classified as they ACTUALLY STOOD, and
 * that was the right call: a declaration written against a PLANNED state is
 * green on a tree that does not exist, and the plan is the one thing that
 * slips.
 *
 * MOST of them are gone now, and their declarations went with them in the
 * same commit — which is the rule this section really states. TWO ARE NOT
 * GONE, and the sentence that said all nine were was false the day it was
 * written: `.bkp/` is still an empty directory at this root, and
 * `.bridlewise.fresh-evidence-<epoch>/` is still beside it. Their
 * declarations went anyway, and correctly — the first is now named by
 * `/.bkp/` and the second is that rename's moved-aside sibling, so both are
 * declared by the rules rather than by this file. The prose was describing
 * the DECLARATIONS being gone and claiming the DIRECTORIES were, which is the
 * exact shape this section exists to warn about: a description written
 * against a planned tree. The guard's
 * list-driven half reds on a declaration that outlived what it described, so
 * removing a root entry and leaving its line here is not a tidy-up someone
 * can defer; it is a red. That coupling is deliberate: it is what stops this
 * file from drifting into a description of a tree nobody has any more.
 *
 * The nine reds it produced are the evidence that the half works, and they
 * read `DECLARED ROOT ENTRY "<name>" no longer exists`.
 */

/** What a root entry is for. Every class obliges git to HOLD the entry. `product` is derived (see the header). */
export type RootClass = "product" | "proof" | "record";

export type RootDeclaration = Readonly<{
  /** Declared only for an entry the promotion profile does not ship (see the header). */
  readonly class?: Exclude<RootClass, "product">;
  /**
   * One line saying what this entry is. It is required and it is asserted
   * non-empty: an entry declared with no reason is a name somebody added to
   * make a red go away, which is the failure mode a deny-by-default guard
   * invites and the only one it cannot see by itself.
   */
  readonly because: string;
}>;

export const DECLARED_ROOT: Readonly<Record<string, RootDeclaration>> = {
  // ── THE PROGRAM ─────────────────────────────────────────────────────────
  ".gitignore": {
    because: "The rules deciding what this index holds — the two defending the harness state directory and its suffixed siblings, and the anchored rules retiring `experiments/`, `.bkp/` and stray merge manifests.",
  },
  "engine": {
    because: "The harness engine, in-tree since the monorepo assembly; carries its own `.gitignore` and its own root.",
  },
  "index.html": {
    because: "The application's entry document, which vite builds from.",
  },
  "package-lock.json": {
    because: "The resolved dependency graph, which makes an install reproducible.",
  },
  "package.json": {
    because: "Declares this package's scripts and dependencies.",
  },
  "README.md": {
    class: "record",
    because: "The floor's contributor orientation, kept in the testing repository and deliberately not shipped over the product README.",
  },
  "public": {
    because: "Assets served verbatim — the PWA manifest, its icons and the service worker.",
  },
  "scripts": {
    because:
      "Operational entry points (the dev-server pair, the icon generator, the database key tool) plus " +
      "the development tooling that lives on this branch (the web suite's budget measurement, the evidence " +
      "sweep, the retained round tooling). What ships is the promotion profile's answer.",
  },
  "server": {
    because: "The backend — routes, database client, tool execution and the redaction boundary.",
  },
  "shared": {
    because: "Contracts both halves import, so a shape is declared once rather than agreed twice.",
  },
  "src": {
    because: "The Svelte client, including the cockpit surfaces.",
  },
  "svelte.config.ts": {
    because: "Svelte compiler configuration for the client build.",
  },
  "tsconfig.json": {
    because: "The client program's declaration — its `include` patterns are load-bearing and held live by a guard.",
  },
  "tsconfig.server.json": {
    because: "The server program's declaration.",
  },
  "tsconfig.templates.json": {
    class: "proof",
    because: "The template program's declaration.",
  },
  "tsconfig.tests.json": {
    class: "proof",
    because: "The test program's declaration.",
  },
  "vite.config.ts": {
    because: "The build's configuration — the dev server, the build and the preview read it; the test runner's configuration extends it.",
  },

  // ── WHAT VERIFIES THE PROGRAM ───────────────────────────────────────────
  ".githooks": {
    because: "The tracked commit hooks: pre-commit and pre-merge-commit hand over to the commit guard (it refuses, among others, a commit dropping a tracked file that was not declared deleted), commit-msg hands it the message (a commit acting on a workflow lesson names it in a Lesson: trailer), post-commit consumes the deletion declarations a commit used; the pointer at them is per-clone and cannot be shipped.",
  },
  "bench": {
    class: "proof",
    because: "The benchmark harness — `bench/fixtures/scale.ts` builds the scale databases `tests/performance/` measures against, and `bench-fixture-drift.test.ts` scans its `*.bench.ts` sources; its RUN REPORTS are artefacts and are ignored.",
  },
  "playwright.config.ts": {
    class: "proof",
    because: "Declares the browser-driven suite.",
  },
  "promotion": {
    class: "proof",
    because: "The promotion profiles (`harness promote`): what of this branch ships to which branch, and the gates a promotion runs; read from the source commit, never shipped.",
  },
  "playwright.perf.config.ts": {
    class: "proof",
    because: "Declares the browser-driven performance profile the regression gate reads.",
  },
  "tests": {
    class: "proof",
    because: "Every suite, including the prevention guards that run unprompted.",
  },
  "vitest.config.ts": {
    class: "proof",
    because: "The web test runner's configuration: extends `vite.config.ts` and hands the runner the globs declared in `tests/test-include.ts`.",
  },

  // ── WHAT RECORDS WHAT HAPPENED ──────────────────────────────────────────
  //
  // Records are tracked here like everything else on this branch; what ships
  // is the promotion profile's answer, so no record needs a branch-shaped
  // obligation (the floor model that gave `experiments/` and the root design
  // record one retired with the merge door, PROMO-4).
  "DESIGN.md": {
    class: "record",
    because: "The design record of the harness: how the current architecture came to be, kept beside the work it describes.",
  },
  "docs": {
    class: "record",
    because: "Documentation and the cutover's own analysis tooling and manifests.",
  },
  // ── PUBLIC REPOSITORY SURFACES ──────────────────────────────────────────
  // The public snapshot carries community, CI, and contributor files that the
  // private tree did not. They do not ship in the product projection, so each
  // one states its proof or record class here.
  "AGENTS.md": {
    class: "record",
    because: "The public agent briefing: the process links, working rules, and commands an agent with no prior context must read first.",
  },
  ".devcontainer": {
    class: "proof",
    because: "The disposable development container that installs both dependency trees and runs the cockpit on loopback.",
  },
  ".editorconfig": {
    class: "proof",
    because: "The formatting contract shared by editors and generated files.",
  },
  ".gitattributes": {
    class: "proof",
    because: "The line-ending and archive rules git applies to the tracked tree.",
  },
  ".github": {
    class: "proof",
    because: "The public CI, CodeQL, secret scan, Pages, and failure-reporting workflows.",
  },
  ".node-version": {
    class: "proof",
    because: "The runtime pin read by version managers and CI setup.",
  },
  ".nvmrc": {
    class: "proof",
    because: "The same runtime pin for nvm users; kept in step with the supported Node range.",
  },
  "CHANGELOG.md": {
    class: "record",
    because: "The public history of preview releases and their verification.",
  },
  "CITATION.cff": {
    class: "record",
    because: "The citable identity, licence, and version of the public repository.",
  },
  "CODE_OF_CONDUCT.md": {
    class: "record",
    because: "The participation rules for a public repository.",
  },
  "CONTRIBUTING.md": {
    class: "record",
    because: "The contribution contract, including evidence and review expectations.",
  },
  "GOVERNANCE.md": {
    class: "record",
    because: "The public decision and maintainership model.",
  },
  "LICENSE": {
    class: "record",
    because: "The AGPL-3.0-only licence text for the public repository.",
  },
  "Makefile": {
    class: "proof",
    because: "The guardian build and test entry points used by the public gate.",
  },
  "NOTICE": {
    class: "record",
    because: "The public attribution notice.",
  },
  "SECURITY.md": {
    class: "record",
    because: "The private vulnerability-reporting path and the supported-version statement.",
  },
  "SUPPORT.md": {
    class: "record",
    because: "The public support boundary for a preview with no support contract.",
  },
  "THIRD_PARTY_NOTICES.md": {
    class: "record",
    because: "The third-party licence inventory for the public repository.",
  },
  "bin": {
    class: "proof",
    because: "The public CLI launcher used by the quickstart and the local workflow verbs.",
  },
};
