// @vitest-environment node
/**
 * EVERY ENTRY AT THIS ROOT IS EITHER **IGNORED BY A RULE** OR **DECLARED**,
 * AND EITHER ANSWER IS AN OBLIGATION ON THE GIT INDEX.
 *
 * ── THE DEFECT, MEASURED ──────────────────────────────────────────────────
 *
 * The root `.gitignore` carried `**\/.bridlewise/`, written for the harness
 * state directory that holds the database encryption key and both databases.
 * A run renamed that directory aside under a SUFFIX —
 * `.bridlewise.fresh-evidence-<epoch>/` — and the pattern names one
 * spelling, so nothing matched it. Nine files were committed: `db-key`,
 * `web.db`, `timeline.db` with its `-shm` and `-wal`, the ledger id, the a11y
 * cache and two test-result summaries. `git status` was clean the whole time,
 * because an ignored path is invisible to it and a tracked one is only
 * visible while it differs from the index.
 *
 * The ignore rule is now broadened, which fixes that instance. This guard is
 * for the CLASS, and the class is "something arrived at this root and nobody
 * had to say what it was".
 *
 * ── DESIGN POINT 1: THE POPULATION IS WALKED, NEVER LISTED ────────────────
 *
 * The subject is `readdirSync(root)` UNIONED with the first path segment of
 * every `git ls-files` entry. Neither `DECLARED_ROOT` nor `.gitignore`
 * supplies the population; both only classify what the walk finds.
 *
 * This is not a stylistic preference. A guard driven from a list can only
 * report a DELETION — it iterates names it already knows. The failure that
 * actually happened was an ADDITION, and a list-driven guard would have
 * checked its known names, found every one intact, and passed. So the walk is
 * the subject and classification is deny-by-default: an entry the walk finds
 * that no rule names and no declaration covers is RED, and the only ways to
 * clear it are to say what the thing is or to give it an ignore rule.
 *
 * Two walking instruments rather than one, because each is blind where the
 * other sees. `readdirSync` cannot see an entry that is in the index and
 * missing from disk; `git ls-files` cannot see an entry that is on disk and
 * ignored — which is exactly the state the offending directory sat in for the
 * hours before it was committed. Both must contribute, and a run where either
 * returns nothing is refused rather than passed: an empty universe certifies
 * every rule for free.
 *
 * ── DESIGN POINT 2: THE CLASSIFIER IS GIT, NOT A SECOND LIST ──────────────
 *
 *   ignored by a rule   ⇒  ABSENT from the index
 *   declared here       ⇒  PRESENT in the index
 *   both                ⇒  RED — two owners of one question
 *   neither             ⇒  RED — deny by default
 *
 * The ABSENT half is the assertion that turns a committed database red, and
 * it used to be carried by an `ignored-runtime` class listing six names by
 * hand. `tests/declared-root.ts` records in full why that list was collapsed;
 * the short version is that it was a SECOND OWNER of the question
 * `.gitignore` already answers, it red on the repository's own supported
 * operations, it could not pass on a fresh clone, and one of its six entries
 * was an epoch that can only ever exist on one machine. Asking git's matcher
 * instead moves the obligation from six names to every ignored entry there
 * will ever be, and leaves nothing to keep up to date.
 *
 * The PRESENT direction is not decoration either. It catches the mirror-image
 * failure this repository has already suffered once: `coverage/`, written
 * unanchored for a report directory, swallowed `src/lib/coverage/` and a
 * source file the component registry imports left the index. An ignore rule
 * broadened too far shows up here twice over — as a `product` entry that is
 * no longer indexed, and as an entry that is both ignored and declared.
 *
 * ── "IS IT IGNORED" AND "DID ANYBODY NAME IT" ARE TWO QUESTIONS OF GIT ────
 *
 * Both are asked of git's matcher, and they must be asked SEPARATELY, because
 * `check-ignore -v` reports the rule that WON — git resolves last-match-wins,
 * and the epoch shape rule is the last rule in this repository's `.gitignore`.
 * So the deciding rule for `.bridlewise.fresh-evidence-<epoch>` is a shape,
 * even though `**\/.bridlewise.*` — written for that family after that very
 * directory's db-key was committed — names it perfectly well five blocks
 * earlier. Reading the naming answer off the deciding rule therefore asks
 * "which rule won", and the two questions disagree for exactly the entries
 * that matter.
 *
 * The naming question is asked over the same rules with every SHAPE rule
 * removed — a rule whose own text spells no place cannot be what named
 * something. See `patternStem` and `namedAmong`. The predecessor of that pair was
 * a test on the ENTRY'S NAME rather than on the rules, and it conferred
 * silence on `node_modules.<label>-<epoch>` and CHAINED off entries this guard
 * was reporting as unnamed in the same run; both are driven on a real
 * filesystem in the plants below.
 *
 * ── THE IGNORE INSTRUMENT CARRIES A WITNESS, OR ITS SILENCE MEANS NOTHING ─
 *
 * `git check-ignore` answering "nothing is ignored" and `git check-ignore`
 * pointed at the wrong tree are the same empty set — and the empty set is a
 * LEGITIMATE answer here, because a fresh clone that has never been installed
 * or run has no ignored root entry at all. A floor would therefore be wrong;
 * a witness is not. Every observation probes one path the rules certainly
 * match and one they certainly do not, in the SAME call, and refuses when
 * either answer is wrong.
 *
 * WHAT THE WITNESS ACTUALLY PROTECTS TODAY IS SMALLER THAN THAT READS, and it
 * is written down because an overstated guarantee is the thing a later reader
 * builds on. Breaking the instrument reds exactly one test — the one whose
 * SUBJECT is the witness — while the live arm stays green, because `ignored`
 * is never empty on any tree this suite can actually run in: it needs
 * `node_modules` to exist at all, and a clean clone that has installed
 * measures `{.bridlewise, node_modules}`. So the witness is insurance
 * against a tree the suite has never met (a fresh, uninstalled checkout run by
 * hand), not a check that fires on this one. It stays for that case; it is not
 * evidence that the live arm has been proven honest.
 *
 * `--no-index` IS DEFENSIVE HERE, NOT LOAD-BEARING, AND THIS PARAGRAPH USED TO
 * CLAIM OTHERWISE. It said the flag was load-bearing "for the same reason it is
 * in `gitignore-anchoring.test.ts`" — that without it `check-ignore` reports
 * nothing for a path already in the index, so the ignored-AND-indexed arm could
 * never fire. DRIVEN: remove the flag and this file is still 16/16 green. The
 * reason is the probe SHAPE. `check-ignore` skips a path that is an index
 * ENTRY, and neither probe form ever is: `<entry>/.declared-root-probe` is a
 * path nobody has created, and a bare `<entry>` naming a directory is a prefix
 * of index entries rather than one of them. The flag does real work in
 * `gitignore-anchoring.test.ts`, whose probes are ordinary paths, and it is
 * kept here so that a future probe which IS an index entry cannot silently
 * change the question — but a reader must not take it as evidence that this
 * file's arms have been tested against the index-consulting behaviour, because
 * they have not been reached by it.
 *
 * ── WHY `.git` IS NOT WALKED, AND WHY THAT IS NOT AN EXEMPTION ────────────
 *
 * It is on disk, no index can contain it, and no ignore rule can name it —
 * `git check-ignore --no-index .git/probe` matches nothing, because git does
 * not apply exclude patterns inside its own directory. So it satisfies
 * neither classification and would be a permanent red. It is removed from the
 * population by NAME DERIVED FROM `git rev-parse --git-dir` rather than by a
 * literal, and both facts that justify removing it are asserted below rather
 * than believed.
 *
 * ── THE KNOWN GAP: THIS GUARD IS DEPTH-1 ONLY ─────────────────────────────
 *
 * It classifies the root's immediate children and nothing beneath them.
 * `engine/` is ONE declared entry, and everything inside it is invisible to
 * this file — measured today, `git ls-files 'engine/scripts/exp*' | wc -l`
 * reports **122** files that this guard says nothing whatsoever about, and
 * `readdirSync("engine")` reports 32 entries it never looks at.
 *
 * That limit is deliberate, and it is written down because an undocumented
 * deliberate limit and an accidental hole are indistinguishable to everyone
 * downstream — a green run here would otherwise be read as "the tree is
 * declared", which is false by roughly three orders of magnitude (3,220
 * tracked files, `git ls-files | wc -l`).
 *
 * THE REMEDY IS NOT TO RECURSE FROM HERE, and it is no longer "the engine
 * needs its own `declared-root.ts`" either — an earlier draft of this header
 * prescribed that, and a per-directory declaration file only moves the
 * hand-written list one level down and multiplies it. The depth-unbounded
 * half of this invariant needs no declaration at all, because git already
 * holds both answers at every depth: a path is TRACKED or it is IGNORED, and
 * anything that is neither is undeclared wherever it sits. That arm lives in
 * `tests/prevention/tracked-source-owner.test.ts`, which already owns "the
 * ignore rules and the index agree, in both directions". What stays here is
 * the half git cannot answer — WHAT a tracked root entry is for.
 *
 * ── WHY THIS IS A FILE OF ITS OWN AND NOT AN EDIT ─────────────────────────
 *
 * `gitignore-anchoring.test.ts` is the closest neighbour and its charter is a
 * different direction: "no ignore rule reaches further than the place it
 * names", and "none stops short of the moved-aside rename". Both are
 * questions about the PATTERNS. This is a question about the ENTRIES.
 * `tracked-source-owner.test.ts` asks whether the index and the rules agree
 * about a path; this asks what a path is FOR, which neither git nor a pattern
 * can say. Neither could have failed on this defect.
 *
 * The one guard that WAS blind inside its own subject —
 * `encryption-and-dedup-prevention.test.ts`, whose describe block reads "the
 * persisted encryption key is gitignored (never committed)" while it asserted
 * only that `.gitignore` CONTAINS a substring — is repaired in place rather
 * than duplicated here. It now asks the index, at every depth, which is the
 * half this depth-1 walk cannot cover.
 */
import { describe, expect, test } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative } from "node:path";

import {
  declaredRulesAt,
  movedAsideSpelling,
  namingRulesAt,
} from "../../engine/scripts/verification/gitignore-anchoring.ts";
import { DECLARED_ROOT, type RootDeclaration } from "../declared-root.ts";
import { promotionView } from "../helpers/promotion-view.ts";
import { createTempDir } from "../helpers/temp-dir.ts";

/**
 * The root entries this branch SHIPS — product, derived from the promotion
 * profile (`tests/helpers/promotion-view.ts`), never declared: a root entry is
 * product iff a path the profile projects lies under it.
 */
const SHIPPED_ROOT_ENTRIES: ReadonlySet<string> = promotionView().shippedRootEntries;

/** What the instruments saw, kept apart so a failure can name which one. */
type RootObservation = Readonly<{
  /** Every immediate child of the root, from the filesystem. */
  readonly onDisk: ReadonlySet<string>;
  /** The first path segment of every tracked path, from the git index. */
  readonly indexed: ReadonlySet<string>;
  /** The subset of the above that some ignore rule names, from git's matcher. */
  readonly ignored: ReadonlySet<string>;
  /**
   * For each ignored entry, the PATTERN git says decided it.
   *
   * "Is this ignored" and "did anybody say what this is" are two questions,
   * and collapsing the second into the first is what this field exists to
   * undo. It is reported in the failure text; it is NOT the naming verdict —
   * see `named`.
   */
  readonly ignoredBy: ReadonlyMap<string, string>;
  /**
   * The subset of the population some rule NAMES, as opposed to merely
   * reaches — asked of git's matcher over the naming rules alone.
   *
   * ── WHY THIS IS NOT `ignoredBy` READ THROUGH A PREDICATE ─────────────────
   *
   * `git check-ignore -v` reports the rule that DECIDED the path, and git's
   * decision is last-match-wins. The epoch SHAPE rule is the last rule in this
   * repository's `.gitignore`, so it decides every name that carries a
   * timestamp — including `.bridlewise.fresh-evidence-<epoch>`, which the
   * rule `**\/.bridlewise.*` five blocks earlier was written for BY NAME
   * after that directory's db-key was committed. Judging the naming question
   * on the deciding rule therefore asks "which rule won", not "did anybody say
   * what this is", and the two answers differ for exactly the entries that
   * matter.
   *
   * So the question is asked separately, of the same matcher, over a rule set
   * with the shape rules removed. See `namedAmong`.
   */
  readonly named: ReadonlySet<string>;
}>;

/**
 * One path the rules must match and one they must not, in the tree being
 * observed. §36: an absence assertion needs a witness, and here the absence
 * ("no root entry is ignored") is a legitimate answer on a fresh clone — so a
 * floor cannot be the check and a witness has to be.
 */
type IgnoreWitness = Readonly<{ readonly matched: string; readonly unmatched: string }>;

/**
 * The subset of `paths` some ignore rule matches, asked of GIT'S OWN MATCHER.
 *
 * `check-ignore` exits 1 when NOTHING matched, which is a verdict rather than
 * a failure, so the status is read as data and anything else is refused. A
 * `catch { return new Map() }` here would report a crashed git as "nothing is
 * ignored" and hand every arm below a finding it manufactured.
 *
 * `-v` IS WHAT MAKES THE SECOND QUESTION ANSWERABLE. Without it the answer is
 * a yes/no and every ignored entry looks alike; with it git names the pattern
 * that matched, which is the only thing that can distinguish an entry a rule
 * NAMES from one a shape rule merely reaches.
 */
function ignoredAmong(root: string, paths: readonly string[]): ReadonlyMap<string, string> {
  if (paths.length === 0) return new Map();
  const result = spawnSync("git", ["check-ignore", "--stdin", "--no-index", "-z", "-v"], {
    cwd: root,
    input: `${paths.join("\0")}\0`,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(
      `git check-ignore failed in ${root} (status ${String(result.status)}): ${result.stderr}`,
    );
  }
  // `-v -z` emits four NUL-terminated fields per match: source, line number,
  // pattern, pathname. Read in groups rather than by position from the end, so
  // a pattern containing a separator cannot shift the parse.
  const fields = result.stdout.split("\0");
  const matched = new Map<string, string>();
  for (let at = 0; at + 3 < fields.length; at += 4) {
    matched.set(fields[at + 3] ?? "", fields[at + 2] ?? "");
  }
  matched.delete("");
  return matched;
}

/**
 * The spellings an entry can be ignored under.
 *
 * A rule ending in `/` is directory-only, and `check-ignore` never stats — so
 * asking it about the bare name `coverage` returns nothing even though
 * `/coverage/` is right there in the file. Driven: `coverage` and
 * `playwright-report` both come back unmatched, while `coverage/probe` and
 * `playwright-report/probe` match at `.gitignore:61` and `:57`. Both
 * spellings are therefore asked, so the answer does not depend on whether the
 * thing happens to exist as a directory right now — the property a fresh
 * clone breaks.
 *
 * A SYMLINK GETS THE BARE NAME AND NOTHING ELSE, and that is measured rather
 * than defensive. `git check-ignore` refuses to look through one: driven on a
 * clone whose `node_modules` was a symlink, `node_modules/.declared-root-probe`
 * exited **128** with `fatal: pathspec … is beyond a symbolic link`, which
 * this instrument correctly turns into a refusal — and a refusal is a guard
 * that cannot run. The bare name is also the only honest question to ask of
 * one: `engine/.gitignore` records the same measurement from the other side,
 * that `/large-codebases` must carry NO trailing slash precisely because it is
 * a symlink and a directory-only rule does not match one. So a symlinked root
 * entry ignored only by a directory-only rule is reported UNIGNORED here, and
 * that is the truth rather than a gap.
 */
function ignoreProbesFor(entry: string, isSymbolicLink: boolean): readonly string[] {
  return isSymbolicLink ? [entry] : [entry, `${entry}/.declared-root-probe`];
}

/**
 * The subset of `paths` that a rule NAMES — git's own matcher, asked over the
 * declaring file's rules with every SHAPE rule taken out.
 *
 * ── WHY THE QUESTION IS ASKED THIS WAY ────────────────────────────────────
 *
 * The predecessor of this function was a pure NAME test: an entry was treated
 * as named when it looked like `<some ignored entry>.<label>-<10+ digits>`.
 * Nothing in it checked that a rename had happened, that the base was itself
 * named by anything, or that any rule covered the result — so it conferred
 * silence on `node_modules.evil-<epoch>` (nothing names it), and it CHAINED:
 * `payload-<epoch>` is reported unnamed, and `payload-<epoch>.x-<epoch>` was
 * then exempt for being that reported entry's sibling. Both driven on a real
 * filesystem below.
 *
 * A name cannot carry that claim, because the claim is about the RULES. So it
 * is asked of the rules: a naming rule is one whose own text spells a place
 * (`patternStem` is non-empty), and an entry is named when git — not a prefix
 * comparison here — still ignores it once only those rules remain.
 *
 * `--no-index` and a scratch repository make this pure pattern matching: no
 * file has to exist, which is what lets the same question be asked of a fresh
 * clone, of this tree, and of a plant.
 *
 * ONLY THE DECLARING FILE'S OWN RULES COUNT, AND THAT IS DELIBERATE. A root
 * entry ignored solely by a personal `core.excludesFile` or by
 * `.git/info/exclude` is reported UNNAMED here, because neither is tracked and
 * "the rule is the declaration" means a declaration every checkout carries. An
 * operator's local exclude is not a statement this repository has made.
 */
function namedAmong(root: string, probesOf: ReadonlyMap<string, readonly string[]>): ReadonlySet<string> {
  // `namingRulesAt` is the existing owner of "what does this `.gitignore`
  // declare, and which of its rules name a place" — consulted rather than
  // re-derived here, and it keeps this file off the bytes of a rules file that
  // no source view applies to.
  const naming = namingRulesAt(root);
  const scratch = createTempDir("ch-web-root-naming-");
  execFileSync("git", ["init", "-q"], { cwd: scratch, stdio: "pipe" });
  writeFileSync(join(scratch, ".gitignore"), `${naming.join("\n")}\n`);
  const matched = ignoredAmong(scratch, [...probesOf.values()].flat());
  return new Set(
    [...probesOf.keys()].filter((entry) =>
      (probesOf.get(entry) ?? []).some((probe) => matched.has(probe)),
    ),
  );
}

/** Git's own directory, derived rather than spelled — see the header. */
function gitDirEntry(root: string): string {
  const dir = execFileSync("git", ["rev-parse", "--git-dir"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  // A primary checkout answers `.git` (a relative path under this root). A
  // LINKED WORKTREE answers an ABSOLUTE path OUTSIDE this root, and git's own
  // on-disk entry here is the `.git` POINTER FILE — which the old
  // `split("/")[0]` turned into `""`, leaving `.git` in the walk and the
  // whole arm red on the one tree work happens in. A root-level `.git` that
  // is a FILE is git's worktree pointer by git's own invariant (nothing else
  // creates one), so the shape check is the verification.
  const relativeDir = isAbsolute(dir) ? relative(root, dir) : dir;
  if (!relativeDir.startsWith("..") && !isAbsolute(relativeDir)) {
    return relativeDir.split("/")[0] ?? "";
  }
  if (!lstatSync(join(root, ".git")).isFile()) {
    throw new Error(
      `git rev-parse --git-dir named a directory outside this root (${dir}), ` +
        `and the on-disk .git entry is not the pointer file a linked worktree holds — ` +
        `git's own entry here is unrecognised rather than absent`,
    );
  }
  return ".git";
}

/** `readdirSync`, `git ls-files` and `git check-ignore`, over `root`. */
function observe(root: string, witness: IgnoreWitness): RootObservation {
  const indexed = new Set(
    execFileSync("git", ["ls-files", "-z"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
      .split("\0")
      .filter((entry) => entry.length > 0)
      .map((entry) => entry.split("/")[0] ?? ""),
  );
  indexed.delete("");
  const gitDir = gitDirEntry(root);
  const onDisk = new Set(readdirSync(root).filter((entry) => entry !== gitDir));
  indexed.delete(gitDir);

  const population = [...new Set([...onDisk, ...indexed])];
  const symbolic = (entry: string): boolean => {
    try {
      return lstatSync(join(root, entry)).isSymbolicLink();
    } catch {
      return false;
    }
  };
  const probesOf = new Map(population.map((entry) => [entry, ignoreProbesFor(entry, symbolic(entry))]));
  const matched = ignoredAmong(root, [
    ...[...probesOf.values()].flat(),
    witness.matched,
    witness.unmatched,
  ]);
  // THE WITNESS, CHECKED BEFORE ANY VERDICT IS FORMED. An instrument pointed
  // at the wrong tree answers "nothing is ignored", and so does a clone that
  // has never been run — the two are the same empty set, and only a path the
  // rules certainly match can tell them apart.
  if (!matched.has(witness.matched)) {
    throw new Error(
      `git reported ${witness.matched} as NOT ignored in ${root}, so this instrument is not ` +
        `reading that tree's rules and every "not ignored" answer below would be about the ` +
        `instrument rather than about the tree.`,
    );
  }
  if (matched.has(witness.unmatched)) {
    throw new Error(
      `git reported ${witness.unmatched} as ignored in ${root}, so this instrument answers yes ` +
        `to everything and could never report an undeclared entry.`,
    );
  }

  // A NEGATION-DECIDED PATH IS NOT IGNORED, AND THE INSTRUMENT MUST SAY SO.
  // `git check-ignore -v` reports the pattern that DECIDED a path, which can
  // be a negation: last-match-wins, and a trailing `!` rule re-admits the
  // path, so git's own verdict for it is "not ignored". Reading that record
  // into `ignored` would manufacture "tracked AND ignored" for exactly the
  // paths a rule deliberately re-admits (an archive under its own `!` rule)
  // — the instrument answering the opposite of git.
  // A deciding pattern starting with `!` is therefore dropped from BOTH maps.
  const ignored = new Set(
    population.filter((entry) =>
      (probesOf.get(entry) ?? []).some(
        (probe) => matched.has(probe) && !(matched.get(probe) ?? "").startsWith("!"),
      ),
    ),
  );
  const ignoredBy = new Map<string, string>();
  for (const entry of ignored) {
    const probe = (probesOf.get(entry) ?? []).find(
      (candidate) => matched.has(candidate) && !(matched.get(candidate) ?? "").startsWith("!"),
    );
    ignoredBy.set(entry, matched.get(probe ?? "") ?? "");
  }
  return { onDisk, indexed, ignored, ignoredBy, named: namedAmong(root, probesOf) };
}

/**
 * The refusal, or `null` when every walked entry is classified exactly once
 * and its class's index obligation holds.
 *
 * A pure function of the observations and the declarations, so a plant can
 * drive the REAL path with a supplied population — the alternative, asserting
 * inline against the live tree, can only ever be exercised by being satisfied.
 */
function rootInventoryFailure(
  subject: string,
  observed: RootObservation,
  declared: Readonly<Record<string, RootDeclaration>>,
  shipped: ReadonlySet<string>,
): string | null {
  // AN EMPTY UNIVERSE IS A REFUSAL, ON EITHER WALKING INSTRUMENT. A readdir
  // that returned nothing is a broken walk, not an empty root; an index that
  // returned nothing means the PRESENT obligation would be violated by every
  // entry at once. The IGNORED set is deliberately NOT floored: zero ignored
  // entries is the correct answer on a clone nobody has installed or run, and
  // the instrument's honesty is established by its witness instead.
  if (observed.onDisk.size === 0) {
    return `${subject}: the filesystem walk returned no entry. That is a broken walk, not an empty root.`;
  }
  if (observed.indexed.size === 0) {
    return `${subject}: the git index returned no tracked path, so neither index obligation means anything here.`;
  }

  const population = [...new Set([...observed.onDisk, ...observed.indexed])].sort();
  const problems: string[] = [];

  for (const entry of population) {
    const declaration = declared[entry];
    const ignored = observed.ignored.has(entry);
    const indexed = observed.indexed.has(entry);

    if (ignored) {
      if (indexed) {
        problems.push(
          `ROOT ENTRY "${entry}" IS IGNORED BY A RULE AND IS IN THE GIT INDEX. ` +
            `An ignored path is written by a program, a tool or a checkout and must never be ` +
            `committed — this is the shape that put a database encryption key in this ` +
            `repository's history. Remove it with \`git rm -r --cached ${entry}\`, or delete ` +
            `the rule if the file really does belong to the program.`,
        );
      }
      if (declaration !== undefined) {
        // THE ARM THAT KEEPS THE COLLAPSE COLLAPSED. An ignore rule and a
        // declaration are two owners of one question, and this pair has
        // already drifted once, in the direction where the file git obeys
        // stayed right and the file a test reads went stale.
        problems.push(
          `ROOT ENTRY "${entry}" is IGNORED by a rule AND declared ${declaration.class ?? "(product)"} in ` +
            `tests/declared-root.ts — two owners of one question. An ignore rule already says ` +
            `this entry is runtime state git must not hold, and it says it to git rather than ` +
            `only to a test. Delete the declaration; the rule is the declaration.`,
        );
      }
      // ── THE HALF THE COLLAPSE LOST, AND IT IS SECURITY-ADJACENT ─────────
      //
      // "The rule is the declaration" is right, and it is only right when the
      // rule NAMES the entry. Before the `ignored-runtime` class was
      // collapsed, classification was `declared[entry] === undefined ⇒
      // UNDECLARED` with no ignore matcher at all, so EVERY root entry needed
      // a named owner and a reason. Collapsing it introduced `if (ignored) {
      // continue }`, which is a tightening on the index obligation and a real
      // loosening here: an entry that arrives under a SHAPE rule is now
      // matched, silent in `git status`, and named by nobody.
      //
      // The two interact, which is what makes it worth a rule rather than a
      // note. The same change widened the epoch pattern to `<name>-<10+
      // digits><anything>`, so `payload-1785461259/` and
      // `credentials-1785461259.json` are both ignored at this root today
      // while no rule and no declaration says a word about either.
      //
      // ── THE EXEMPTION THIS ARM USED TO CARRY, AND WHY IT IS GONE ────────
      //
      // It was a pure NAME test: `<any ignored entry>.<label>-<10+ digits>`
      // was treated as named, on the theory that such a name can only be the
      // moved-aside sibling of something already covered. A name cannot carry
      // that theory. DRIVEN on a real filesystem, at a real clone root,
      // through this very function: `node_modules.evil-<epoch>/` was silent
      // (nothing in this repository names it), and the exemption CHAINED —
      // `payload-<epoch>` is reported here as unnamed, and
      // `payload-<epoch>.x-<epoch>` was then exempt for being that reported
      // entry's sibling. An unnamed base was conferring naming on a child.
      //
      // The claim is about the RULES, so it is asked of the rules
      // (`namedAmong`): git's own matcher, over the tracked rules with every
      // SHAPE rule removed. `.bridlewise.fresh-evidence-<epoch>` stays quiet
      // because `**\/.bridlewise.*` — written for that family after its
      // db-key was committed — names it, which is a fact about this
      // repository's `.gitignore` rather than about the spelling of a
      // timestamp. Remove that one rule and the entry reds; the plant below
      // drives exactly that, because an exemption owes the same evidence as a
      // detection.
      const pattern = observed.ignoredBy.get(entry) ?? "";
      if (!observed.named.has(entry)) {
        problems.push(
          `UNNAMED IGNORED ROOT ENTRY "${entry}" — git ignores it, but every rule that matches ` +
            `it names a SHAPE rather than a place (the one that decided it is "${pattern}"). ` +
            `Being ignored answers "must git hold this"; it does not answer "what is this". ` +
            `Give it a rule that names it — a rule whose text spells the place, like ` +
            `\`/${entry}\` or a family rule such as \`**/<something>.*\` — with a comment ` +
            `saying what it is, because the rule is the declaration and its comment is the ` +
            `reason. Or delete it. A moved-aside \`<dir>.<label>-<epoch>\` rename is NOT ` +
            `exempt by its shape: the rule that covers the family it belongs to is what makes ` +
            `it named, and if no such rule exists then nobody has said what this directory is.`,
        );
      }
      continue;
    }

    if (declaration === undefined) {
      // THE ARM THE DEFECT WOULD HAVE COME THROUGH. Deny by default: the walk
      // found something, no rule names it, and nobody said what it is.
      problems.push(
        `UNDECLARED ROOT ENTRY "${entry}" — it is ${
          observed.onDisk.has(entry) ? "on disk" : "not on disk"
        } and ${
          indexed ? "in the git index" : "absent from the git index"
        }, and NO ignore rule names it. Nothing may arrive at this root without saying what it ` +
          `is: add it to tests/declared-root.ts (proof or record; no class when the promotion ` +
          `profile ships it), with one line saying why. If it is runtime state written by a tool, give it an ignore rule ` +
          `INSTEAD — the rule is the declaration, and it is the half git obeys. The last entry ` +
          `that arrived here with neither was a harness state directory whose encryption key ` +
          `was committed.`,
      );
      continue;
    }

    // PRODUCT IS DERIVED (tests/declared-root.ts): the promotion profile says what
    // ships, so a declared class on a shipped entry is a second answer to its
    // question, and an entry that does not ship must say what it is instead.
    const ships = shipped.has(entry);
    if (ships && declaration.class !== undefined) {
      problems.push(
        `ROOT ENTRY "${entry}" SHIPS (the promotion profile projects a path under it), so it is ` +
          `product by derivation — and it is declared ${declaration.class}. Drop the class: what ` +
          `ships is the profile's answer (promotion/*.json), never a second one here.`,
      );
    }
    if (!ships && declaration.class === undefined) {
      problems.push(
        `ROOT ENTRY "${entry}" does NOT ship (the promotion profile projects nothing under it) and ` +
          `declares no class — so nothing says what it is. Declare it proof or record, or make ` +
          `the profile ship it if the program needs it.`,
      );
    }
    const spelled = declaration.class ?? "product";
    if (declaration.because.trim().length === 0) {
      problems.push(
        `ROOT ENTRY "${entry}" is declared ${spelled} with an EMPTY because — a name ` +
          `added to silence this check is not a declaration.`,
      );
    }
    if (!indexed) {
      problems.push(
        `ROOT ENTRY "${entry}" is declared ${spelled} — which obliges git to hold it — ` +
          `and NO tracked path begins with it. Either it was never added, or an ignore rule ` +
          `reaches further than its author could see and has swallowed it. Ask ` +
          `\`git check-ignore -v ${entry}\` which rule is doing it.`,
      );
    }
  }

  const walked = new Set(population);
  for (const entry of Object.keys(declared).sort()) {
    if (walked.has(entry)) continue;
    // The list-driven half, which the walk cannot supply: a declaration that
    // outlived what it described. It survives the collapse intact, and it can
    // now be strict — every remaining class obliges git to HOLD the entry, so
    // a declared entry that is neither on disk nor in the index is wrong on
    // every machine rather than only on one that has never been installed.
    problems.push(
      `DECLARED ROOT ENTRY "${entry}" no longer exists — it is neither on disk nor in the index. ` +
        `Remove its declaration, so this file keeps describing the tree that is here.`,
    );
  }

  if (problems.length === 0) return null;
  return (
    `${subject}: ${problems.length} problem(s) across ${population.length} walked root ` +
    `entr(ies), ${observed.ignored.size} of them ignored by a rule, and ` +
    `${Object.keys(declared).length} declaration(s):\n` +
    problems.map((p) => `  - ${p}`).join("\n")
  );
}

/** A declaration set built from pairs, so a plant needs no literal object. */
function declarationsFrom(
  pairs: readonly (readonly [string, RootDeclaration])[],
): Readonly<Record<string, RootDeclaration>> {
  return Object.fromEntries(pairs);
}

const ROOT = process.cwd();

/**
 * This repository's witness pair.
 *
 * `.bridlewise/db-key` is the path the whole guard exists because of, and
 * `**\/.bridlewise/` is not going anywhere; `src/cockpit/` holds tracked
 * source, so a rule reaching it would be the `coverage/` defect returning.
 * Neither path needs to EXIST — `--no-index` makes this pure pattern
 * matching, which is what lets the witness work on a fresh clone.
 */
const WITNESS: IgnoreWitness = {
  matched: ".bridlewise/db-key",
  unmatched: "src/cockpit/nothing-ignores-this.ts",
};

describe("every entry at this repository's root is ignored by a rule or declared", () => {
  test("the walk reaches every instrument, and the ignore matcher carries its witness", () => {
    // `observe` THROWS on a dead witness, so calling it is the assertion —
    // stated here rather than only implied, because the arm below reads its
    // result and a silent instrument would make that read meaningless.
    const observed = observe(ROOT, WITNESS);
    expect(observed.onDisk.size, "readdirSync returned nothing").toBeGreaterThan(0);
    expect(observed.indexed.size, "git ls-files returned nothing").toBeGreaterThan(0);

    // AND THE `.git` REMOVAL IS MEASURED, NOT ASSUMED — both halves of the
    // reason the header gives for it. §8: an exemption carries the same
    // evidence burden as a detection.
    const gitDir = gitDirEntry(ROOT);
    // COMPARED AGAINST THE RAW FILESYSTEM, NEVER AGAINST ITSELF. A first
    // draft asserted only `!observed.onDisk.has(gitDir)`, which a derivation
    // returning any name at all satisfies — the removal and the name it
    // removes both came from the same mutated expression, so the assertion
    // held while `.git` sat in the population. Driven: it stayed green while
    // the arm below reported `UNDECLARED ROOT ENTRY ".git"`.
    expect(
      readdirSync(ROOT),
      "git rev-parse --git-dir named something this root does not contain",
    ).toContain(gitDir);
    expect(observed.onDisk.has(gitDir), `${gitDir} was not removed from the walk`).toBe(false);
    expect(
      readdirSync(ROOT).length - observed.onDisk.size,
      "the walk and the raw listing differ by something other than git's own directory",
    ).toBe(1);
    expect(
      ignoredAmong(ROOT, [`${gitDir}/probe`]).size,
      `${gitDir}/probe is matched by an ignore rule, so git's own directory is NOT unnameable ` +
        `and removing it from the walk needs a different reason than the one recorded`,
    ).toBe(0);
    expect(
      execFileSync("git", ["ls-files", "-z", "--", gitDir], { cwd: ROOT, encoding: "utf8" }),
      `the index holds a path under ${gitDir}, so it is not "the store no index can contain"`,
    ).toBe("");
  });

  test("no root entry is unclassified, and every class's index obligation holds", () => {
    const failure = rootInventoryFailure(
      "this repository's root",
      observe(ROOT, WITNESS),
      DECLARED_ROOT,
      SHIPPED_ROOT_ENTRIES,
    );
    expect(failure, failure ?? "").toBeNull();
    // LIVENESS of the derivation: a profile that shipped nothing would leave every entry "not shipped" and the arm free.
    expect([...SHIPPED_ROOT_ENTRIES], "the promotion profile ships no root entry — the derivation is broken").toEqual(expect.arrayContaining(["engine", "server", "src", "package.json"]));
  });

  test("every declaration carries a one-line reason, and a declared class is proof or record (product is derived)", () => {
    const classes = new Set(["proof", "record"]);
    for (const [entry, declaration] of Object.entries(DECLARED_ROOT)) {
      if (declaration.class !== undefined) expect(classes, `${entry} has an unknown class`).toContain(declaration.class);
      expect(declaration.because.trim().length, `${entry} has an empty because`).toBeGreaterThan(0);
      expect(declaration.because, `${entry}'s because is not one line`).not.toContain("\n");
    }
  });

  test("THE OPERATION THAT USED TO RED THIS GUARD: a merge round's own output is classified", () => {
    // `scripts/harness-root/merge-round.mjs` writes `.merge.lock` at its top
    // and `MERGE-ROUND-REPORT.json` on every exit path, both at this root.
    // Neither was declared, so ONE run of a supported operation produced two
    // `UNDECLARED ROOT ENTRY` problems — and sixteen more anchored rules in
    // the same file were the same trap, armed for whoever ran the operation
    // that writes them. The names come from the RULES rather than from this
    // test, so a rule that is deleted or renamed reds here instead of
    // quietly shrinking what is checked.
    const observed = observe(ROOT, WITNESS);
    const written = [".merge.lock", "MERGE-ROUND-REPORT.json"];
    const matched = ignoredAmong(ROOT, written.flatMap((e) => ignoreProbesFor(e, false)));
    for (const entry of written) {
      expect(
        ignoreProbesFor(entry, false).some((probe) => matched.has(probe)),
        `${entry} is written at this root by a supported operation and NO ignore rule names it`,
      ).toBe(true);
      expect(
        Object.hasOwn(DECLARED_ROOT, entry),
        `${entry} is ignored by a rule AND declared — the two-owner shape this guard refuses`,
      ).toBe(false);
    }
    // …and the live verdict really is quiet about them, whether or not a
    // merge round has run on this machine.
    expect(rootInventoryFailure("post-merge-round", observed, DECLARED_ROOT, SHIPPED_ROOT_ENTRIES)).toBeNull();
  });
});

describe("PLANTS: each arm is driven with a violation supplied from outside", () => {
  // Every plant below feeds the SAME function the live assertion calls, with a
  // population built here rather than filtered inside the rule — a plant the
  // rule could recognise by name is not a plant.
  const declared = declarationsFrom([["src", { because: "the program" }]]);
  /** The plants' shipped root entries: `src` ships (so it declares no class). */
  const SHIPPED = new Set(["src"]);
  const clean: RootObservation = {
    onDisk: new Set(["src", ".dev"]),
    indexed: new Set(["src"]),
    ignored: new Set([".dev"]),
    // The rule NAMES it, which is what makes it a benign shape rather than
    // an entry that merely got caught by something.
    ignoredBy: new Map([[".dev", "/.dev/"]]),
    named: new Set([".dev"]),
  };

  test("the benign shape it is compared against is green", () => {
    expect(rootInventoryFailure("plant", clean, declared, SHIPPED)).toBeNull();
  });

  test("PLANT: a negation-decided entry is NOT ignored — the instrument reads git's verdict, not its pattern list", () => {
    // The instrument fix, driven on a real scratch repository rather than
    // asserted as prose: a `.gitignore` whose LAST matching rule for a path
    // is a negation makes git's verdict "not ignored", and `check-ignore -v`
    // still names the negation as the deciding pattern. An instrument that
    // read the pattern list instead of the verdict would report the path
    // ignored — manufacturing "tracked AND ignored" for exactly the
    // re-admitted floor-byte shape.
    const scratch = createTempDir("ch-web-root-negation-");
    execFileSync("git", ["init", "-q", "-b", "testing"], { cwd: scratch, stdio: "pipe" });
    writeFileSync(
      join(scratch, ".gitignore"),
      "/archive/\n!/archive/\n/kept-out/\n",
      { encoding: "utf8" },
    );
    mkdirSync(join(scratch, "archive"), { recursive: true });
    writeFileSync(join(scratch, "archive", "record.txt"), "tracked\n");
    mkdirSync(join(scratch, "kept-out"), { recursive: true });
    execFileSync("git", ["add", "-A"], { cwd: scratch, stdio: "pipe" });
    execFileSync("git", ["-c", "user.email=root@test", "-c", "user.name=root", "commit", "-qm", "plant"], {
      cwd: scratch,
      stdio: "pipe",
    });
    const observed = observe(scratch, {
      matched: "kept-out/probe",
      unmatched: "visible/never-ignored",
    });
    expect([...observed.ignored].sort()).toEqual(["kept-out"]);
    expect(observed.indexed.has("archive"), "the re-admitted archive is tracked").toBe(true);
    expect(observed.indexed.has("kept-out"), "the ignored entry is untracked").toBe(false);
    // The re-admitted entry classifies as the record it is declared, with no
    // "ignored" problem manufactured for it.
    const scratchDeclared = declarationsFrom([
      [".gitignore", { because: "the rules" }],
      ["archive", { class: "record", because: "the re-admitted archive" }],
    ]);
    const failure = rootInventoryFailure(
      "plant",
      observed,
      scratchDeclared,
      new Set([".gitignore"]),
    );
    expect(failure, failure ?? "").toBeNull();
  });

  test("product is derived: a class on a shipped entry and no class on an entry that does not ship are both refused, by name", () => {
    const classed = rootInventoryFailure("plant", clean, declarationsFrom([["src", { class: "proof", because: "the program" }]]), SHIPPED) ?? "";
    expect(classed).toContain('ROOT ENTRY "src" SHIPS (the promotion profile projects a path under it)');
    const unclassed = rootInventoryFailure("plant", clean, declared, new Set()) ?? "";
    expect(unclassed).toContain('ROOT ENTRY "src" does NOT ship');
    expect(rootInventoryFailure("plant", clean, declared, SHIPPED)).toBeNull();
    expect(rootInventoryFailure("plant", clean, declarationsFrom([["src", { class: "record", because: "an archive" }]]), new Set())).toBeNull();
  });

  test("an ignored entry no rule NAMES is refused, and a named one is not", () => {
    // The half the `ignored-runtime` collapse lost. All four below are ignored
    // and invisible to `git status`; the difference is whether anybody ever
    // said what they are, and that difference arrives here as `named`.
    // Where `named` comes FROM is the real question, and it is driven against
    // git's matcher on a real filesystem in the arm after this one.
    const shape = "**/*-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]*";
    const withShapeMatches: RootObservation = {
      onDisk: new Set([
        "src",
        ".dev",
        ".bridlewise.evidence-1785461259",
        "payload-1785461259",
        "credentials-1785461259.json",
      ]),
      indexed: new Set(["src"]),
      ignored: new Set([
        ".dev",
        ".bridlewise.evidence-1785461259",
        "payload-1785461259",
        "credentials-1785461259.json",
      ]),
      // Every one of the last three was DECIDED by the shape rule — which is
      // precisely why the deciding rule cannot answer the naming question.
      ignoredBy: new Map([
        [".dev", "/.dev/"],
        [".bridlewise.evidence-1785461259", shape],
        ["payload-1785461259", shape],
        ["credentials-1785461259.json", shape],
      ]),
      named: new Set([".dev", ".bridlewise.evidence-1785461259"]),
    };
    const failure = rootInventoryFailure("plant", withShapeMatches, declared, SHIPPED) ?? "";
    expect(failure).toContain('UNNAMED IGNORED ROOT ENTRY "payload-1785461259"');
    expect(failure).toContain('UNNAMED IGNORED ROOT ENTRY "credentials-1785461259.json"');
    // `/.dev/` names its entry, and `**\/.bridlewise.*` names the suffixed
    // family the moved-aside rename produces. Neither is reported, or the arm
    // would be refusing a rename this repository has a rule for.
    expect(failure).not.toContain('UNNAMED IGNORED ROOT ENTRY ".dev"');
    expect(failure).not.toContain(
      'UNNAMED IGNORED ROOT ENTRY ".bridlewise.evidence-1785461259"',
    );
    // And exactly two, so a rule that reported every ignored entry would be
    // indistinguishable from one that discriminates.
    expect(failure.split("UNNAMED IGNORED ROOT ENTRY").length - 1).toBe(2);
    // THE ARM READS `named` AND NOTHING ELSE. Same observation, naming
    // withdrawn from the one entry a shape rule decided: it must appear, or
    // the field is being computed and discarded.
    const withoutNaming = rootInventoryFailure(
      "plant",
      { ...withShapeMatches, named: new Set([".dev"]) },
      declared,
      SHIPPED,
    );
    expect(withoutNaming ?? "").toContain(
      'UNNAMED IGNORED ROOT ENTRY ".bridlewise.evidence-1785461259"',
    );
  });

  test("an entry no rule names and no declaration covers is refused", () => {
    const failure = rootInventoryFailure(
      "plant",
      { ...clean, onDisk: new Set([...clean.onDisk, ".residue-probe"]) },
      declared,
      SHIPPED,
    );
    expect(failure ?? "").toContain('UNDECLARED ROOT ENTRY ".residue-probe"');
    // ...and it is refused for arriving on DISK ALONE, which is the state the
    // committed directory was in before anybody added it.
    expect(failure ?? "").toContain("on disk and absent from the git index");
    expect(failure ?? "").toContain("NO ignore rule names it");
  });

  test("an entry indexed but never declared is refused too", () => {
    const failure = rootInventoryFailure(
      "plant",
      { ...clean, indexed: new Set([...clean.indexed, "surprise.json"]) },
      declared,
      SHIPPED,
    );
    expect(failure ?? "").toContain('UNDECLARED ROOT ENTRY "surprise.json"');
    expect(failure ?? "").toContain("not on disk and in the git index");
  });

  test("an IGNORED entry that IS in the index is refused — the defect itself", () => {
    const failure = rootInventoryFailure(
      "plant",
      { ...clean, indexed: new Set([...clean.indexed, ".dev"]) },
      declared,
      SHIPPED,
    );
    expect(failure ?? "").toContain('".dev" IS IGNORED BY A RULE AND IS IN THE GIT INDEX');
    expect(failure ?? "").toContain("git rm -r --cached .dev");
  });

  test("an IGNORED entry that is ALSO declared is refused — the two-owner shape", () => {
    // This is the arm that keeps the `ignored-runtime` list from growing back
    // one entry at a time, which is exactly how it grew the first time.
    const failure = rootInventoryFailure(
      "plant",
      clean,
      declarationsFrom([
        ...Object.entries(declared),
        [".dev", { class: "record", because: "local dev scratch" }],
      ]),
      SHIPPED,
    );
    expect(failure ?? "").toContain('".dev" is IGNORED by a rule AND declared record');
    expect(failure ?? "").toContain("two owners of one question");
  });

  test("a product entry that has left the index is refused — the mirror image", () => {
    const failure = rootInventoryFailure(
      "plant",
      { ...clean, indexed: new Set(["nothing-matching"]) },
      declared,
      SHIPPED,
    );
    expect(failure ?? "").toContain('"src" is declared product');
    expect(failure ?? "").toContain("git check-ignore -v src");
  });

  test("a declaration whose entry no longer exists is refused", () => {
    const failure = rootInventoryFailure(
      "plant",
      clean,
      declarationsFrom([
        ...Object.entries(declared),
        ["deleted-long-ago", { class: "record", because: "gone" }],
      ]),
      SHIPPED,
    );
    expect(failure ?? "").toContain('DECLARED ROOT ENTRY "deleted-long-ago" no longer exists');
  });

  test("A FRESH CLONE IS GREEN — the acceptance test this guard used to fail", () => {
    // Nothing installed, nothing run: no `node_modules`, no `.dev`, no
    // `test-results`, no harness state, no moved-aside sibling of it. Every
    // walked entry is tracked and declared, and the IGNORED set is EMPTY —
    // which the rule must accept, because on this tree it is the truth. The
    // five reds this shape used to produce were `DECLARED ROOT ENTRY … no
    // longer exists`, one of them for an epoch that exists on one machine.
    const fresh: RootObservation = {
      onDisk: new Set(["src"]),
      indexed: new Set(["src"]),
      ignored: new Set(),
      ignoredBy: new Map(),
      named: new Set(),
    };
    expect(rootInventoryFailure("fresh clone", fresh, declared, SHIPPED)).toBeNull();
  });

  test("a declaration with an empty reason is refused", () => {
    const failure = rootInventoryFailure(
      "plant",
      clean,
      declarationsFrom([["src", { because: "   " }]]),
      SHIPPED,
    );
    expect(failure ?? "").toContain("EMPTY because");
  });

  test("an empty universe from either walking instrument is refused, not passed", () => {
    expect(rootInventoryFailure("plant", { ...clean, onDisk: new Set() }, declared, SHIPPED) ?? "").toContain(
      "broken walk",
    );
    expect(
      rootInventoryFailure("plant", { ...clean, indexed: new Set() }, declared, SHIPPED) ?? "",
    ).toContain("no tracked path");
  });

  test("PLANTS ON A REAL FILESYSTEM: this repository's own rules, at a real clone root", () => {
    // ── WHY THIS ARM EXISTS AND THE SYNTHETIC ONES ARE NOT ENOUGH ──────────
    //
    // Every plant above hands `rootInventoryFailure` an observation built in
    // this file, which means every one of them asserts what the pure function
    // does with an answer it was GIVEN. The question this guard actually gets
    // wrong is where that answer comes FROM — `observe`, git's matcher, and
    // this repository's real rules — and a hand-built `RootObservation` cannot
    // reach it. Three escapes lived through a full set of synthetic plants for
    // exactly that reason, and all three are driven below on a disk.
    //
    // The rules are THIS repository's bytes, read rather than restated, so the
    // arm cannot certify a `.gitignore` nobody ships. The tree is a real git
    // repository and every plant is a real directory or file.
    const root = createTempDir("ch-web-root-realplants-");
    const run = (...args: readonly string[]): void => {
      execFileSync("git", [...args], { cwd: root, stdio: "pipe" });
    };
    run("init", "-q");
    run("config", "user.email", "guard@example.invalid");
    run("config", "user.name", "guard");
    const rules = `${declaredRulesAt(ROOT).join("\n")}\n`;
    writeFileSync(join(root, ".gitignore"), rules);
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "keep.ts"), "export const keep = 1;\n");
    run("add", ".gitignore", "src/keep.ts");
    run("commit", "-q", "-m", "plant");

    const plantDeclarations = declarationsFrom([
      ["src", { because: "the program" }],
      [".gitignore", { because: "the rules under test" }],
    ]);
    const plantShipped = new Set(["src", ".gitignore"]);

    // The moved-aside spellings come from the OWNER of "what name does W-08's
    // rename produce", not from a literal typed here, so a change to that
    // shape reaches this arm instead of leaving it asserting a dead spelling.
    const EPOCH = 1785461259;
    const liveEvidence = movedAsideSpelling(".bridlewise", "fresh-evidence", EPOCH);
    const harnessAside = movedAsideSpelling(".bridlewise", "anything", 9999999999);
    const modulesAside = movedAsideSpelling("node_modules", "evil", EPOCH);
    const chained = movedAsideSpelling(`payload-${String(EPOCH)}`, "x", EPOCH);

    for (const directory of [
      // THE BASES, PRESENT ON DISK. Both are load-bearing rather than
      // scenery: the exemption this arm replaced looked its base up in the
      // IGNORED SET, so a plant that omits the base cannot reproduce the
      // escape at all — the old predicate finds no base and reports the child
      // for the wrong reason, which reads exactly like a pass. Caught by
      // driving the old predicate back in and watching only one of the two
      // assertions fail.
      ".bridlewise",
      "node_modules",
      `payload-${String(EPOCH)}`,
      liveEvidence,
      harnessAside,
      modulesAside,
      chained,
    ]) {
      mkdirSync(join(root, directory), { recursive: true });
    }
    writeFileSync(join(root, ".bridlewise", "db-key"), "not-a-real-key\n");
    // The bytes that made this a security defect rather than an untidiness,
    // in the two places the class puts them.
    writeFileSync(join(root, harnessAside, "db-key"), "not-a-real-key\n");
    writeFileSync(join(root, liveEvidence, "db-key"), "not-a-real-key\n");
    writeFileSync(join(root, `credentials-${String(EPOCH)}.json`), "{}\n");

    const observed = observe(root, WITNESS);
    // LIVENESS BEFORE VERDICT: the plants must actually be in the walk and in
    // the ignored set, or every "not reported" below is a claim about an empty
    // population. §36 — an absence assertion needs a witness.
    for (const entry of [
      `payload-${String(EPOCH)}`,
      `credentials-${String(EPOCH)}.json`,
      liveEvidence,
      harnessAside,
      modulesAside,
      chained,
    ]) {
      expect(observed.onDisk.has(entry), `${entry} was not walked`).toBe(true);
      expect(observed.ignored.has(entry), `${entry} is not ignored by this repository's rules`)
        .toBe(true);
    }

    const failure = rootInventoryFailure("real plants", observed, plantDeclarations, plantShipped) ?? "";

    // ── THE THREE THAT ESCAPED THE NAME-SHAPE EXEMPTION ────────────────────
    //
    // `node_modules.<label>-<epoch>` — the rename W-08 prescribes, applied to
    // a directory this repository has NO family rule for. The old exemption
    // read the name, found `node_modules` in the ignored set, and went quiet;
    // nothing in this tree says what such a directory is or what is in it.
    expect(failure, "a moved-aside sibling of an entry with no family rule escaped").toContain(
      `UNNAMED IGNORED ROOT ENTRY "${modulesAside}"`,
    );
    // …and the CHAIN. `payload-<epoch>` is itself reported unnamed one line
    // below, and the old exemption still let it confer naming on a child.
    expect(failure, "an entry this very run reports as unnamed conferred naming on a child")
      .toContain(`UNNAMED IGNORED ROOT ENTRY "${chained}"`);
    expect(failure).toContain(`UNNAMED IGNORED ROOT ENTRY "payload-${String(EPOCH)}"`);
    expect(failure).toContain(`UNNAMED IGNORED ROOT ENTRY "credentials-${String(EPOCH)}.json"`);

    // ── AND THE ONE THAT MUST STAY QUIET ───────────────────────────────────
    //
    // `.bridlewise.fresh-evidence-<epoch>` is on this workspace's disk and
    // out of the index by the user's decision. It is quiet because
    // `**\/.bridlewise.*` names the family — a rule with a comment saying
    // what such a directory is — and NOT because its name ends in digits.
    // `.bridlewise.<anything>-<epoch>` is quiet for the same reason and it
    // is the same claim: that rule was written after this exact directory's
    // db-key was committed, and it says every suffixed sibling of the harness
    // state directory is that state under another spelling.
    expect(failure).not.toContain(`UNNAMED IGNORED ROOT ENTRY "${liveEvidence}"`);
    expect(failure).not.toContain(`UNNAMED IGNORED ROOT ENTRY "${harnessAside}"`);
    expect(
      failure.split("UNNAMED IGNORED ROOT ENTRY").length - 1,
      "the arm reported a different number of unnamed entries than the plants supply",
    ).toBe(4);

    // ── THE EXEMPTION CARRIES A DETECTION'S EVIDENCE ───────────────────────
    //
    // "Quiet because a rule names the family" is a claim about the rules, so
    // the rule is removed and the claim is re-measured. Nothing else changes:
    // the directories stay on disk, the shape rule still ignores them, and the
    // entries must now be reported. Without this, "the exemption is attributed
    // to `**\/.bridlewise.*`" would be prose.
    const withoutFamilyRule = rules
      .split("\n")
      .filter((line) => line.trim() !== "**/.bridlewise.*")
      .join("\n");
    expect(
      withoutFamilyRule.length,
      "the family rule was not found in this repository's .gitignore, so the mutation is inert",
    ).toBeLessThan(rules.length);
    writeFileSync(join(root, ".gitignore"), withoutFamilyRule);
    const mutated = rootInventoryFailure(
      "real plants, family rule removed",
      observe(root, WITNESS),
      plantDeclarations,
      plantShipped,
    ) ?? "";
    expect(mutated, "removing the family rule changed no answer").toContain(
      `UNNAMED IGNORED ROOT ENTRY "${liveEvidence}"`,
    );
    expect(mutated).toContain(`UNNAMED IGNORED ROOT ENTRY "${harnessAside}"`);
    // …and the control, so the mutation is proven TARGETED rather than a
    // matcher that fell over: `.bridlewise` itself is named by its own rule
    // and stays quiet, and the four already-unnamed entries are unchanged.
    expect(mutated).not.toContain('UNNAMED IGNORED ROOT ENTRY ".bridlewise"');
    expect(mutated.split("UNNAMED IGNORED ROOT ENTRY").length - 1).toBe(6);
  });

  test("PLANT: the ignore matcher's WITNESS refuses a tree whose rules it cannot read", () => {
    // A real repository with a real (empty) rules file, driven through the
    // SAME `observe` the live assertion calls, so only the input varies. It
    // is the one shape a floor can never catch: zero ignored entries is the
    // CORRECT answer on a fresh clone, so "the matcher saw nothing" and "the
    // matcher is dead" are the same number and only the witness separates
    // them.
    const root = createTempDir("ch-web-root-witness-");
    const run = (...args: readonly string[]): void => {
      execFileSync("git", [...args], { cwd: root, stdio: "pipe" });
    };
    run("init", "-q");
    run("config", "user.email", "guard@example.invalid");
    run("config", "user.name", "guard");
    writeFileSync(join(root, ".gitignore"), "");
    run("add", ".gitignore");
    run("commit", "-q", "-m", "plant");

    expect(() => observe(root, WITNESS)).toThrow(
      /reported \.bridlewise\/db-key as NOT ignored/u,
    );

    // …and the OTHER direction: a matcher that says yes to everything is
    // refused too, so the witness cannot be satisfied by a broadened rule.
    writeFileSync(join(root, ".gitignore"), "*\n");
    expect(() => observe(root, WITNESS)).toThrow(
      /reported src\/cockpit\/nothing-ignores-this\.ts as ignored/u,
    );

    // And the control: rules that answer both halves correctly let `observe`
    // through, so the two throws above are about the witness rather than
    // about a scratch repository nothing can observe.
    writeFileSync(join(root, ".gitignore"), "**/.bridlewise/\n");
    expect(observe(root, WITNESS).indexed.has(".gitignore")).toBe(true);

    // A SYMLINKED ROOT ENTRY MUST NOT STOP THE WALK. Found by driving this
    // guard inside a real clone rather than by reading it: `git check-ignore`
    // exits 128 — `fatal: pathspec 'x/.declared-root-probe' is beyond a
    // symbolic link` — the moment a probe reaches through one, and this
    // instrument turns a non-0/1 status into a refusal, so the whole guard
    // became unrunnable rather than wrong. It is not a hypothetical shape:
    // `engine/.gitignore` records that `/large-codebases` IS a symlink at its
    // root. The entry is still classified, by the only question git will
    // answer about a symlink — its bare name.
    mkdirSync(join(root, "real-target"), { recursive: true });
    symlinkSync(join(root, "real-target"), join(root, "linked-entry"));
    writeFileSync(join(root, ".gitignore"), "**/.bridlewise/\nlinked-entry\n");
    const withLink = observe(root, WITNESS);
    expect(withLink.onDisk.has("linked-entry")).toBe(true);
    expect(
      withLink.ignored.has("linked-entry"),
      "a symlinked root entry named by a slashless rule was not classified as ignored",
    ).toBe(true);
  });
});
