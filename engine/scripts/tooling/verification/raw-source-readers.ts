/**
 * THE GUARD-OF-GUARDS: WHO IS ALLOWED TO READ SOURCE BYTES WITHOUT THE DOOR.
 *
 * ── WHY THIS EXISTS, AND WHY `source-view.ts` ALONE IS NOT ENOUGH ─────────
 *
 * `source-view.ts` is a TYPE. It closes the door a caller would otherwise walk
 * through by habit: a `SourceView` is branded, is not a `string`, and cannot be
 * matched against without naming a view. Its own header says what it cannot do,
 * and says it in the first person:
 *
 *   > `readFileSync(p).toString()` still yields bytes … A scanner that shells
 *   > out to `grep`/`rg` never enters this module at all … Either half alone is
 *   > a door with a corridor beside it, and this file is the first half.
 *
 * This is the second half. A type cannot refuse a caller that never names it;
 * only a scan over the byte-reading callers can. So:
 *
 *   * `source-view.ts` makes the WRONG VIEW unrepresentable (rung 2).
 *   * this module makes NO VIEW AT ALL refusable (rung 4/5), by deny-by-default
 *     over the files that read bytes and match a pattern against them.
 *
 * ── THE UNIVERSE, AND WHY IT IS THIS ONE ──────────────────────────────────
 *
 * A file is a RAW SOURCE MATCHER when BOTH hold, in its `code()` view (so a
 * `readFileSync` written inside a comment or quoted in a template is not
 * evidence of anything — the detector goes through the very door it guards):
 *
 *   1. it calls a byte-reading fs function (`readFileSync` / `readFile`,
 *      through any receiver, awaited or not), AND
 *   2. the value that read produced is the SUBJECT OF A MATCHER — `.match`,
 *      `.matchAll`, `.includes`, `.indexOf`, `.search`, `.replace`, `.split`,
 *      or passed to a `RegExp`'s `.test` / `.exec` — either through a binding
 *      it was assigned to, or inline on the call's result.
 *
 * Condition 2 is DATAFLOW, not co-occurrence, and the difference is the whole
 * instrument. §34: a count's UNIT is part of its population, so here are three
 * defensible ones over the SAME tree at the SAME instant, all three produced by
 * THIS module (`scanForRawSourceMatchers`, 2,196 files scanned, rc 0):
 *
 *   | unit (UNIT = FILES in every row)                      | files |
 *   |-------------------------------------------------------|-------|
 *   | `readsBytes` — calls a byte reader at all             |  441  |
 *   | `readValueReachesMatcher` — the read's value is matched |  207  |
 *   | `found` — … and the file also ENUMERATES the tree     |  110  |
 *
 * They differ by 4×, and each is honestly called "the files that match against
 * raw source". This module GUARDS the third, and the reason is a mechanism and
 * not a budget: a file that both walks the tree and matches the bytes it finds
 * is asking a question OF PROGRAM TEXT IT DISCOVERED — exactly the shape §29
 * was measured on, where five tests matched `/from\s+["']@harness\//` against a
 * string-blanked view and passed unconditionally. A file that reads ONE known
 * artifact it was handed — a receipt, a lock file, a config — and splits it is
 * not making a claim about program text.
 *
 * THAT NARROWING IS A STATED LIMIT AND NOT A CLEAN BILL OF HEALTH: 97 files
 * (207 − 110) reach a matcher from a byte read WITHOUT enumerating, and this
 * guard does not refuse them. The two wider units are returned by the scan and
 * asserted by the permanent test, so the limit is measured rather than
 * described — a stated limit nobody can re-derive is a sentence.
 *
 * ── DENY BY DEFAULT ───────────────────────────────────────────────────────
 *
 * Every member of the universe must appear in one of two hand-declared
 * records, or the guard refuses it. Both are `Record<Union, Reason>` and NEVER
 * `readonly string[]` — §31b, the `OUTLET_IDS` lesson: a subset array stays
 * assignable, so a hand-written `readonly string[]` allowlist silently accepts
 * having lost a member. A `Record` keyed by a declared union cannot: drop a key
 * and the object literal no longer satisfies the type; add a key that is not in
 * the union and the literal is excess. The allowlist is exactly the shape that
 * lesson was learned on, so it is exactly the shape that must not be an array.
 *
 * ── WHAT THIS CANNOT DO. KEPT IN SOURCE, NOT IN A REPORT ──────────────────
 *
 * The corridor is real and naming it is the point:
 *
 *   * `readFileSync(p).toString()` through a `Buffer`, or bytes carried through
 *     a helper of the file's own — the dataflow here is ONE HOP over a direct
 *     binding. A read whose value is returned from a local function and matched
 *     by the caller is invisible to condition 2.
 *   * A scanner that SHELLS OUT — `execFileSync("grep", …)`, `rg`, `git grep` —
 *     never calls an fs function at all, so it is not in the universe on
 *     condition 1. This is not hypothetical: `grep` treats a file holding a NUL
 *     byte as binary, prints nothing and exits 0, which is a silently smaller
 *     universe with a clean exit code.
 *   * A file that reads bytes through a DIFFERENT repository's helper.
 *
 * `source-view.ts` closes the habitual door; this closes the enumerating one.
 * Both halves together still leave the two corridors above, and a reader who
 * needs to believe there are none is reading the wrong file.
 *
 * DEPENDENCY-FREE APART FROM ITS OWN DOOR: node built-ins plus
 * `source-view.ts`, like its neighbours. Imported from both repositories.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { readSourceView, type SourceView } from "../../verification/source-view.ts";

/** Byte-reading fs functions, through any receiver, awaited or not. */
const BYTE_READ = /\b(?:readFileSync|readFile)\s*\(/gu;

/**
 * A byte read whose value is BOUND to a name. The optional type annotation is
 * matched up to the `=` because `const src: string = …` is a common spelling
 * and `[^=;\n]` cannot cross it.
 *
 * DRIVEN, AND THE FIRST SPELLING WAS WRONG IN THE DIRECTION THAT MATTERS. It
 * required `const|let|var` on the same statement, so the DECLARE-THEN-ASSIGN
 * form was invisible:
 *
 *     let source: string;
 *     try { source = readFileSync(file, "utf8"); } catch { continue; }
 *     for (const specifier of specifiersOf(source)) …
 *
 * That is `consumer-plants.ts` — a shipped scanner in this very directory,
 * which reads bytes, enumerates both repositories and matches specifiers
 * against them. The guard-of-guards did not see its own neighbour. The keyword
 * is optional now, which is why the guarded universe is 110 files and not 102.
 */
const BOUND_READ =
  /(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*(?::\s*[^=;\n]+)?=\s*(?:await\s+)?(?:[A-Za-z_$][\w$]*\s*\.\s*)*(?:readFileSync|readFile)\s*\(/gu;

/**
 * The matchers. `split` and `startsWith` are here deliberately: the defect this
 * whole family exists for was found as `.includes("allowedProjectRoots")` over
 * raw bytes, and a line-splitter that then matches each line has merely moved
 * the match one statement down.
 */
const MATCHER_METHODS = [
  "match", "matchAll", "includes", "indexOf", "search", "replace", "split",
  "startsWith", "endsWith",
] as const;

/** Directory enumeration — the second half of "it discovered this file". */
const ENUMERATES =
  /\b(?:readdirSync|readdir|globSync|opendirSync|opendir)\s*\(|\bglob\s*\(|["']ls-files["']|\bfindSourceFiles\s*\(|\bwalk\s*\(/u;

/** One piece of evidence, with the line a reader will open. */
export interface Evidence {
  /** 1-based line in the FILE — `SourceView` blanks rather than deletes. */
  readonly line: number;
  /** The matched text, trimmed, for a report that can be acted on. */
  readonly text: string;
}

export interface RawSourceMatcher {
  /** Absolute path. */
  readonly path: string;
  /** Every byte-reading call site. */
  readonly reads: readonly Evidence[];
  /** Every place a read's own value is matched. Empty means co-occurrence only. */
  readonly matches: readonly Evidence[];
  /** Evidence the file enumerates the tree. Empty means it reads what it was handed. */
  readonly enumerations: readonly Evidence[];
}

/**
 * Does this file BELONG TO THE GUARDED UNIVERSE — reads bytes, matches the
 * value it read, and discovered the file itself?
 *
 * Separated from `classifyRawSourceMatcher` so the two WIDER units stay
 * computable by the same instrument. A stated limit nobody can measure is a
 * sentence; this one is asserted.
 */
export function isGuardedUniverse(candidate: RawSourceMatcher): boolean {
  return candidate.matches.length > 0 && candidate.enumerations.length > 0;
}

/**
 * The finding at `index`, with the line a reader will open AND the line's text.
 *
 * ── THE REPORTING VIEW IS NOT THE DETECTING VIEW, AND THAT IS DELIBERATE ──
 *
 * Detection runs over `code()`, where quoted-string interiors are blanked. The
 * first draft also took the REPORTED text from `code()`, and the plant caught
 * it immediately: the guard offered the operator
 *
 *     if (source.includes("                   ")) report(name);
 *
 * — a line that does not exist in any file, cannot be searched for, and hides
 * the very literal that makes the finding actionable. §31c: the remedy text is
 * part of the guard, and advice an operator cannot follow is a guard talking to
 * itself.
 *
 * So the text comes from `codeWithStrings()`, which keeps quoted interiors. The
 * two views agree on every offset — that is the invariant `SourceView` exists
 * for, blanking rather than deleting — so ONE index is valid in both, and no
 * second read, second lex or `.raw()` is needed to say what a line holds.
 */
function evidenceAt(view: SourceView, index: number): Evidence {
  const reported = view.codeWithStrings();
  const lineStart = reported.lastIndexOf("\n", index) + 1;
  let lineEnd = reported.indexOf("\n", index);
  if (lineEnd === -1) lineEnd = reported.length;
  return { line: view.lineAt(index), text: reported.slice(lineStart, lineEnd).trim() };
}

/** Escape a binding name for use inside a `RegExp`. */
function escapeName(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Classify one file. Returns `null` only when it reads no bytes at all — the
 * two narrowing conditions are reported as EMPTY ARRAYS rather than absence, so
 * a caller can count the wider units without a second instrument (§30: prefer
 * the instrument that already had to be correct).
 *
 * Takes a `SourceView` rather than a path so a prevention test can drive it
 * over a planted string WITHOUT writing a file into a tracked directory — §28a
 * one level out, and the exact defect T4 records against a prevention test that
 * planted its probe into `tests/prevention/`.
 */
export function classifyRawSourceMatcher(view: SourceView): RawSourceMatcher | null {
  // `code()`: comments and string/template INTERIORS blanked. A `readFileSync`
  // named in a doc comment is prose, and one quoted in a fixture is data.
  const code = view.code();

  const reads: Evidence[] = [];
  for (const hit of code.matchAll(BYTE_READ)) reads.push(evidenceAt(view, hit.index));
  if (reads.length === 0) return null;

  // Condition 2, first form: the read was bound, and the binding is matched.
  const bindings = new Set<string>();
  for (const hit of code.matchAll(BOUND_READ)) bindings.add(hit[1]!);

  const matches: Evidence[] = [];
  for (const name of bindings) {
    const escaped = escapeName(name);
    const asSubject = new RegExp(
      `\\b${escaped}\\s*\\.\\s*(?:${MATCHER_METHODS.join("|")})\\s*\\(`,
      "gu",
    );
    for (const hit of code.matchAll(asSubject)) matches.push(evidenceAt(view, hit.index));
    // …or handed to a RegExp: `RE.test(src)`, `RE.exec(src)`.
    const asArgument = new RegExp(`\\.\\s*(?:test|exec)\\s*\\(\\s*${escaped}\\s*[,)]`, "gu");
    for (const hit of code.matchAll(asArgument)) matches.push(evidenceAt(view, hit.index));
  }

  // Condition 2, second form: matched inline on the call's own result.
  const inline = new RegExp(
    `\\b(?:readFileSync|readFile)\\s*\\([^;]*?\\)\\s*\\.\\s*(?:${MATCHER_METHODS.join("|")})\\s*\\(`,
    "gu",
  );
  for (const hit of code.matchAll(inline)) matches.push(evidenceAt(view, hit.index));

  // `codeWithStrings()` on purpose: `git ls-files` IS a string literal, and the
  // `code()` view blanks its interior. This is the same class of mistake §29
  // records — five guards scanned for a module specifier over a view that
  // blanks the very string it lives in.
  const withStrings = view.codeWithStrings();
  const enumerations: Evidence[] = [];
  for (const hit of withStrings.matchAll(new RegExp(ENUMERATES.source, "gu"))) {
    enumerations.push(evidenceAt(view, hit.index));
  }

  return { path: view.path, reads, matches, enumerations };
}

const SOURCE_EXTENSION = /\.(?:ts|tsx|mts|cts|js|mjs|svelte)$/u;
const SKIP_DIRECTORY = new Set(["node_modules", ".git", "dist", "build", "coverage"]);

function walkTree(directory: string, out: string[]): string[] {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIRECTORY.has(name)) continue;
    const path = join(directory, name);
    let stats;
    try {
      stats = statSync(path);
    } catch {
      // A file that vanished between `readdirSync` and `statSync` is a race,
      // not a universe. Anything else would be a shrunken universe wearing an
      // exception, so only the vanish is tolerated — and it is tolerated by
      // skipping ONE entry, never by abandoning the directory.
      continue;
    }
    if (stats.isDirectory()) walkTree(path, out);
    else if (SOURCE_EXTENSION.test(name)) out.push(path);
  }
  return out;
}

/** A repository and the subdirectories of it that hold source. */
export interface ScanRoot {
  readonly name: string;
  readonly root: string;
  readonly sources: readonly string[];
}

export interface RawReaderScan {
  readonly scanned: readonly string[];
  /** THE GUARDED UNIVERSE: reads bytes, matches the value, enumerates the tree. */
  readonly found: readonly RawSourceMatcher[];
  /** WIDER UNIT 1: calls a byte-reading fs function at all, matcher or not. */
  readonly readsBytes: readonly RawSourceMatcher[];
  /** WIDER UNIT 2: the read's own value reaches a matcher, enumerating or not. */
  readonly readValueReachesMatcher: readonly RawSourceMatcher[];
  /** Plain-words reason the scan cannot be believed, or `null`. */
  readonly failure: string | null;
}

/**
 * Scan every root for raw source matchers.
 *
 * REFUSES AN EMPTY UNIVERSE ON BOTH INPUTS. Zero files scanned and zero
 * matchers found are the two ways this instrument reports success while having
 * examined nothing, and they are different failures:
 *
 *   * zero files scanned — the roots moved, or the walk went blind.
 *   * zero matchers found — the DETECTOR went blind. This one is not a
 *     hypothetical floor: `source-tree-immutable.ts` reads bytes to hash them
 *     and always will, so a healthy tree can never legitimately answer zero.
 *     An empty answer here is the instrument breaking, and without this refusal
 *     it is indistinguishable from a perfectly clean tree.
 */
export function scanForRawSourceMatchers(roots: readonly ScanRoot[]): RawReaderScan {
  const scanned: string[] = [];
  for (const scanRoot of roots) {
    for (const source of scanRoot.sources) walkTree(join(scanRoot.root, source), scanned);
  }
  const empty = { found: [], readsBytes: [], readValueReachesMatcher: [] } as const;
  if (scanned.length === 0) {
    return {
      scanned,
      ...empty,
      failure:
        `raw-source-readers: scanned ZERO files across ${String(roots.length)} root(s). ` +
        "An empty universe agrees with every claim about it; either the roots moved or " +
        "this walk has gone blind.",
    };
  }
  const readsBytes: RawSourceMatcher[] = [];
  for (const path of scanned) {
    let view: SourceView;
    try {
      view = readSourceView(path);
    } catch {
      continue;
    }
    const classified = classifyRawSourceMatcher(view);
    if (classified !== null) readsBytes.push(classified);
  }
  const readValueReachesMatcher = readsBytes.filter((c) => c.matches.length > 0);
  const found = readValueReachesMatcher.filter(isGuardedUniverse);
  if (found.length === 0) {
    return {
      scanned,
      ...empty,
      failure:
        `raw-source-readers: scanned ${String(scanned.length)} files and found ZERO raw source ` +
        "matchers. This tree cannot honestly answer zero — at minimum the byte-hashing reader " +
        "in the web test setup is one — so an empty answer is this DETECTOR having gone blind, " +
        "which is otherwise indistinguishable from a clean tree.",
    };
  }
  return {
    scanned,
    found,
    readsBytes,
    readValueReachesMatcher,
    failure: null,
  };
}

// ── THE ALLOWLIST. DENY BY DEFAULT. ───────────────────────────────────────
//
// Two records, two different things, and conflating them is how a debt becomes
// a decision by attrition:
//
//   LEGITIMATE_RAW_READERS  — bytes are the CORRECT input, with the reason.
//   UNMIGRATED_SCANNERS     — bytes are the WRONG input and this file has not
//                             been moved yet. Recorded debt, not permission.
//
// Anything in the universe and in NEITHER record is refused.
//
// ── WHY A `Record`, AND NEVER A `readonly string[]` ───────────────────────
//
// §31b, the `OUTLET_IDS` lesson, and the allowlist is exactly the shape that
// lesson was learned on. Given `type K = "a" | "b" | "c"`:
//
//   const bad: readonly K[] = ["a", "b"];        // ← compiles. A SUBSET IS
//                                                //   ASSIGNABLE. The guard is
//                                                //   now green about "c" and
//                                                //   the compiler is silent.
//   const good: Record<K, Reason> = { a: …, b: … };  // ← ERROR: "c" missing.
//
// So the union IS the universe and the record must cover it. Dropping a key is
// a compile error; adding one the union does not name is excess-property error.
// Neither can be done by accident, which is the only property that matters in
// an allowlist.
//
// ── WHY THE KEY IS `repo:relative/path`, GIVEN §24 ────────────────────────
//
// §24: a guard keyed to a FILE PATH is a guard keyed to today's layout. True,
// and here the consequence runs the SAFE way: move a raw reader and its key no
// longer matches, so it drops out of the record and is REFUSED as unlisted.
// The reason has to move with the file, in the same commit, or the guard is
// red. A guard keyed to a path is dangerous when the path falling out makes it
// QUIETER — this one gets louder.
//
// The key is repo-qualified because the universe spans both repositories
// (§28b: a fingerprint holding ONE index let a test append to the sibling
// repo's tracked source and exit 0), and the two trees have colliding relative
// paths.

/** Why a file is allowed to read source bytes without the door. */
export interface Reason {
  /** In plain words, and specific to this file. Never "legacy" or "special". */
  readonly why: string;
}

/**
 * A file whose raw reads are WRONG and not yet moved. The kind is a single
 * value on purpose: it is not a justification, it is a label saying there is
 * none, and a hundred fabricated per-file justifications would be worse than
 * one honest one (§5 — nothing fake, ever).
 */
export interface MigrationDebt {
  readonly kind: "unmigrated-scanner";
  /** Where the migration is tracked, so the debt has an address. */
  readonly task: string;
}

const TASK_102: MigrationDebt = { kind: "unmigrated-scanner", task: "#102" };

export type LegitimateRawReader =
  | "integration:scripts/verification/consumer-plants.ts"
  | "integration:src/git/working-copy.ts"
  | "integration:test/git/flake-reproduction.test.ts"
  | "integration:test/timeline/timeline-recorder.test.ts"
  | "integration:test/prevention/no-unconfined-recursive-removal.test.ts"
  | "integration:test/timeline/timeline-sealing.test.ts"
  | "integration:test/workflow/evidence-store.test.ts"
  | "integration:test/workflow/working-copy.test.ts"
  | "web:tests/helpers/vm-isolation-witness.ts"
  | "web:tests/prevention/template-mode-lexing.test.ts"
  | "web:tests/setup/source-tree-immutable.ts"
  | "web:scripts/check-docs-links.mjs"
  | "web:scripts/check-secrets.mjs"
  | "web:scripts/floor/site.mjs";

/**
 * The readers that must have bytes, each with the reason WRITTEN DOWN.
 *
 * Not an exemption list. An exemption says "this one is allowed to be wrong";
 * every entry here says why raw bytes are the CORRECT input for that file, and
 * a reader who disagrees has something specific to disagree with.
 */
export const LEGITIMATE_RAW_READERS: Record<LegitimateRawReader, Reason> = {
  "web:scripts/check-docs-links.mjs": {
    why:
      "The subject is the bytes of Markdown documents, including fenced code " +
      "and link targets, so a source view would blank the spans being checked. " +
      "It enumerates the tracked tree and reads each document whole; the raw " +
      "document is the input, not program text.",
  },
  "web:scripts/check-secrets.mjs": {
    why:
      "The scanner's subject is the exact bytes of tracked files plus the " +
      "synthetic-fixture allowlist. A source view would blank or rewrite the " +
      "credential-shaped strings it must detect, so the raw bytes are the " +
      "correct input and the report names paths rather than code semantics.",
  },
  "web:scripts/floor/site.mjs": {
    why:
      "The site assembler copies product documentation, Markdown, CSS, and " +
      "configuration byte for byte into the Pages source tree. A view would " +
      "change the artifact it assembles, so it must read and write the same " +
      "bytes the product repository ships.",
  },
  "web:tests/helpers/vm-isolation-witness.ts": {
    why:
      "The population witness reproduces Vitest's first environment directive " +
      "match over original file bytes, including comments and strings. A source " +
      "view would blank syntax that the installed runner still recognizes, " +
      "changing the expected process/context partition. Its TS/CJS dependency " +
      "fixtures also require exact bytes and length at an equal effective " +
      "timestamp; transformed source cannot establish that cache witness.",
  },
  "integration:scripts/verification/consumer-plants.ts": {
    why:
      "It deliberately OVER-INCLUDES, and says so in its own header: a " +
      "specifier written inside a template or a comment is counted, because " +
      "erring toward running MORE consumer plants is the safe direction for " +
      "a tool whose failure mode is a missed plant. A view that blanks those " +
      "spans would make it quieter, which is the wrong way for this one " +
      "instrument to be wrong.",
  },
  "web:tests/setup/source-tree-immutable.ts": {
    why:
      "It hashes the bytes. An immutability receipt over a view that BLANKS " +
      "comments would certify a file nobody has on disk: edit a comment and " +
      "the hash would not move, which is the precise failure the receipt " +
      "exists to catch. Raw bytes are not a shortcut here, they are the " +
      "subject.",
  },

  "integration:src/git/working-copy.ts": {
    why:
      "Nothing it reads is source it analyses: the one line-split read is a " +
      "git object store's alternates file (administrative data, one object " +
      "directory per line), the other reads a working file's bytes to compare " +
      "content identity between a checkout and its copy, and its enumeration " +
      "is git's object directories and the copy's staging folder. A view " +
      "that blanks comments and strings would compare bytes nobody has on disk.",
  },

  "integration:test/git/flake-reproduction.test.ts": {
    why:
      "Nothing it reads is program text: it reads the reproduction door's kept " +
      "attempt files, whose names are the sha256 of their EXACT bytes (and must " +
      "end with one newline), so a view that blanked comments or strings would " +
      "check bytes nobody wrote; its enumeration is the attempts folder.",
  },

  "integration:test/prevention/no-unconfined-recursive-removal.test.ts": {
    why:
      "Its subjects are COMMANDS, not program text: a tracked shell script is " +
      "read whole as the one command it is, and a test source is parsed by the " +
      "one parser (`parseSourceModule`) for the string values it holds, which " +
      "are then judged as commands. A view would blank exactly those strings, " +
      "and a shell script is no language a view models. Reading bytes " +
      "over-includes (a commented `rm` in a script is judged too), the safe " +
      "direction for a guard whose failure mode is a missed removal of a home.",
  },
  "integration:test/timeline/timeline-recorder.test.ts": {
    why:
      "Its at-rest witness reads the raw bytes of the ledger's own database " +
      "files (the SQLite main file and its write-ahead log) in a temporary " +
      "folder and asserts that a planted token and password are ABSENT from " +
      "them. What is on disk is the property under test; a database file is " +
      "not source, and no view models it.",
  },
  "integration:test/timeline/timeline-sealing.test.ts": {
    why:
      "Its at-rest witness lists the temporary folder a sealed ledger was " +
      "written to and reads the raw bytes of every file there (the SQLite " +
      "main file, its write-ahead log and shared memory) to assert that a " +
      "secret crossing a seal chunk boundary is ABSENT whole and in pieces. " +
      "The bytes on disk are the property under test; a database file is not " +
      "source, and no view models it.",
  },

  "integration:test/workflow/evidence-store.test.ts": {
    why:
      "It reads the artifacts the evidence store wrote into a fixture " +
      "repository the test itself made (the manifest, the stored objects, the " +
      "generated ignore block) and asks that fixture's own index which paths " +
      "it holds. What is on disk in that fixture is the property under test; " +
      "none of it is program text of this repository.",
  },
  "integration:test/workflow/working-copy.test.ts": {
    why:
      "Nothing it reads is source it analyses: the matcher leg the " +
      "classifier sees splits the invocation-token lines of a fixture " +
      "command's own OUTPUT file in a temporary repository, and the file's " +
      "other reads and enumerations are the same class — retry counters, " +
      "planted markers and per-attempt correlation tokens written by " +
      "commands the test itself launches, plus the git object-store " +
      "directories those fixtures create. The bytes on disk are the " +
      "property under test; a fixture output is not source, and no view " +
      "models it.",
  },

  "web:tests/prevention/template-mode-lexing.test.ts": {
    why:
      "It tests THE OWNER OF THE VIEWS ITSELF. The mode-lexing suite feeds " +
      "lexSpans the file's raw text and asserts span boundaries against the " +
      "bytes they cover (span text sliced from the source, comment positions " +
      "matched against the raw text, the code view compared to the input " +
      "verbatim), so its input must be the same bytes the lexer reads — a " +
      "pre-blanked view would be circular: it would test the views against " +
      "the views. The bytes are the subject.",
  },
};

export type UnmigratedScanner =
  | "integration:scripts/concurrent/worker-handlers.mjs"
  | "integration:scripts/tooling/s1-verification.ts"
  | "integration:scripts/verification/tsconfig-include-liveness.ts"
  | "integration:src/filesystem/immutable-receipt.ts"
  | "integration:src/intelligence/file-slice.ts"
  | "integration:src/intelligence/quick-view.ts"
  | "integration:src/workflow/module-registrar.ts"
  | "integration:src/workflow/test-result-collector.ts"
  | "integration:test/architecture/dead-package-scanner.test.ts"
  | "integration:test/architecture/no-math-random-ids.test.ts"
  | "integration:test/authority-graph/authority-graph-boundary.test.ts"
  | "integration:test/config/config-consistency.test.ts"
  | "integration:test/content-addressed-evidence/contract.test.ts"
  | "integration:test/errors.test.ts"
  | "integration:test/foundation-cascade.test.ts"
  | "integration:test/mcp/no-static-constants.test.ts"
  | "integration:test/prevention/config-consumption-contract.test.ts"
  | "integration:test/prevention/disposition-manifest-one-writer.test.ts"
  | "integration:test/prevention/editor-defaults-ssot-prevention.test.ts"
  | "integration:test/prevention/entrypoint-recording-wiring.test.ts"
  | "integration:test/prevention/integration-backend-owner-1.test.ts"
  | "integration:test/prevention/integration-remaining-owner.test.ts"
  | "integration:test/prevention/integration-shared-owner.test.ts"
  | "integration:test/prevention/integration-tools-quality-owner.test.ts"
  | "integration:test/prevention/link-containment-owner.test.ts"
  | "integration:test/prevention/no-destructive-test-writes.test.ts"
  | "integration:test/prevention/no-duplicate-function-bodies.test.ts"
  | "integration:test/prevention/no-generic-errors.test.ts"
  | "integration:test/prevention/no-hardcoded-configurables.test.ts"
  | "integration:test/prevention/no-hand-maintained-pins.test.ts"
  | "integration:test/prevention/no-hardcoded-success.test.ts"
  | "integration:test/prevention/prevention-review.test.ts"
  | "integration:test/prevention/registration-procedure-doc.test.ts"
  | "integration:test/prevention/static-literal-extraction-cache.test.ts"
  | "integration:test/shared-suite/exposure-action-args.test.ts"
  | "integration:test/shared-suite/exposure-registrations.test.ts"
  | "integration:test/verification/hash-binding-registry.test.ts"
  | "integration:test/verification/recursive-test-inventory.test.ts"
  | "integration:test/workflow/atomic-write-consistency.test.ts"
  | "integration:test/workflow/test-result-collector-concurrency.test.ts"
  | "web:server/routes/file-tree.ts"
  | "web:tests/cockpit/room-door-owner.test.ts"
  | "web:tests/helpers/source-scan.ts"
  | "web:tests/performance/lib/perf-harness.ts"
  | "web:tests/prevention/async-db-facade-owner.test.ts"
  | "web:tests/prevention/auth-owner.test.ts"
  | "web:tests/prevention/centralized-config.test.ts"
  | "web:tests/prevention/client-api-owner.test.ts"
  | "web:tests/prevention/config-handler-dedup.test.ts"
  | "web:tests/prevention/cross-user-run-scoping.test.ts"
  | "web:tests/prevention/db-transaction-owner.test.ts"
  | "web:tests/prevention/error-debug-owner.test.ts"
  | "web:tests/prevention/error-handling-consistency.test.ts"
  | "web:tests/prevention/backend-feature-wiring.test.ts"
  | "web:tests/prevention/filesystem-owner.test.ts"
  | "web:tests/prevention/frontend-components-deep.test.ts"
  | "web:tests/prevention/frontend-store-owner.test.ts"
  | "web:tests/prevention/frontend-stores-deep.test.ts"
  | "web:tests/prevention/git-bridge-owner.test.ts"
  | "web:tests/prevention/integration-rule-refs-ratchet.test.ts"
  | "web:tests/prevention/intelligence-bridge-owner.test.ts"
  | "web:tests/prevention/no-dead-css-selectors.test.ts"
  | "web:tests/prevention/no-duplicate-constants.test.ts"
  | "web:tests/prevention/no-hardcoded-config-values.test.ts"
  | "web:tests/prevention/no-proximity-window-assertions.test.ts"
  | "web:tests/prevention/no-raw-sql-outside-db.test.ts"
  | "web:tests/prevention/no-rule-refs.test.ts"
  | "web:tests/prevention/no-scattered-helpers.test.ts"
  | "web:tests/prevention/no-throw-new-error.test.ts"
  | "web:tests/prevention/no-unused-exports.test.ts"
  | "web:tests/prevention/no-unused-imports.test.ts"
  | "web:tests/prevention/project-delete-safety.test.ts"
  | "web:tests/prevention/secret-intelligence-owner.test.ts"
  | "web:tests/prevention/source-structure-parser-differential.test.ts"
  | "web:tests/prevention/sse-event-owner.test.ts"
  | "web:tests/prevention/state-imports-resolve.test.ts"
  | "web:tests/prevention/test-helpers-dedup.test.ts"
  | "web:tests/prevention/test-naming-structure.test.ts"
  | "web:tests/prevention/tool-registry-owner.test.ts"
  | "web:tests/unit/cross-user-path-access.test.ts"
  | "web:tests/unit/sole-writer.test.ts";

export const UNMIGRATED_SCANNERS: Record<UnmigratedScanner, MigrationDebt> = {
  "integration:scripts/concurrent/worker-handlers.mjs": TASK_102,
  "integration:scripts/tooling/s1-verification.ts": TASK_102,
  "integration:scripts/verification/tsconfig-include-liveness.ts": TASK_102,
  "integration:src/filesystem/immutable-receipt.ts": TASK_102,
  "integration:src/intelligence/file-slice.ts": TASK_102,
  "integration:src/intelligence/quick-view.ts": TASK_102,
  "integration:src/workflow/module-registrar.ts": TASK_102,
  "integration:src/workflow/test-result-collector.ts": TASK_102,
  "integration:test/architecture/dead-package-scanner.test.ts": TASK_102,
  "integration:test/architecture/no-math-random-ids.test.ts": TASK_102,
  "integration:test/authority-graph/authority-graph-boundary.test.ts": TASK_102,
  "integration:test/config/config-consistency.test.ts": TASK_102,
  "integration:test/content-addressed-evidence/contract.test.ts": TASK_102,
  "integration:test/errors.test.ts": TASK_102,
  "integration:test/foundation-cascade.test.ts": TASK_102,
  "integration:test/mcp/no-static-constants.test.ts": TASK_102,
  "integration:test/prevention/config-consumption-contract.test.ts": TASK_102,
  "integration:test/prevention/disposition-manifest-one-writer.test.ts": TASK_102,
  "integration:test/prevention/editor-defaults-ssot-prevention.test.ts": TASK_102,
  "integration:test/prevention/entrypoint-recording-wiring.test.ts": TASK_102,
  "integration:test/prevention/integration-backend-owner-1.test.ts": TASK_102,
  "integration:test/prevention/integration-remaining-owner.test.ts": TASK_102,
  "integration:test/prevention/integration-shared-owner.test.ts": TASK_102,
  "integration:test/prevention/integration-tools-quality-owner.test.ts": TASK_102,
  "integration:test/prevention/link-containment-owner.test.ts": TASK_102,
  "integration:test/prevention/no-destructive-test-writes.test.ts": TASK_102,
  "integration:test/prevention/no-duplicate-function-bodies.test.ts": TASK_102,
  "integration:test/prevention/no-generic-errors.test.ts": TASK_102,
  "integration:test/prevention/no-hardcoded-configurables.test.ts": TASK_102,
  "integration:test/prevention/no-hand-maintained-pins.test.ts": TASK_102,
  "integration:test/prevention/no-hardcoded-success.test.ts": TASK_102,
  "integration:test/prevention/prevention-review.test.ts": TASK_102,
  "integration:test/prevention/registration-procedure-doc.test.ts": TASK_102,
  "integration:test/prevention/static-literal-extraction-cache.test.ts": TASK_102,
  "integration:test/shared-suite/exposure-action-args.test.ts": TASK_102,
  "integration:test/shared-suite/exposure-registrations.test.ts": TASK_102,
  "integration:test/verification/hash-binding-registry.test.ts": TASK_102,
  "integration:test/verification/recursive-test-inventory.test.ts": TASK_102,
  "integration:test/workflow/atomic-write-consistency.test.ts": TASK_102,
  "integration:test/workflow/test-result-collector-concurrency.test.ts": TASK_102,
  "web:server/routes/file-tree.ts": TASK_102,
  "web:tests/cockpit/room-door-owner.test.ts": TASK_102,
  "web:tests/helpers/source-scan.ts": TASK_102,
  "web:tests/performance/lib/perf-harness.ts": TASK_102,
  "web:tests/prevention/async-db-facade-owner.test.ts": TASK_102,
  "web:tests/prevention/auth-owner.test.ts": TASK_102,
  "web:tests/prevention/centralized-config.test.ts": TASK_102,
  "web:tests/prevention/client-api-owner.test.ts": TASK_102,
  "web:tests/prevention/config-handler-dedup.test.ts": TASK_102,
  "web:tests/prevention/cross-user-run-scoping.test.ts": TASK_102,
  "web:tests/prevention/db-transaction-owner.test.ts": TASK_102,
  "web:tests/prevention/error-debug-owner.test.ts": TASK_102,
  "web:tests/prevention/error-handling-consistency.test.ts": TASK_102,
  "web:tests/prevention/backend-feature-wiring.test.ts": TASK_102,
  "web:tests/prevention/filesystem-owner.test.ts": TASK_102,
  "web:tests/prevention/frontend-components-deep.test.ts": TASK_102,
  "web:tests/prevention/frontend-store-owner.test.ts": TASK_102,
  "web:tests/prevention/frontend-stores-deep.test.ts": TASK_102,
  "web:tests/prevention/git-bridge-owner.test.ts": TASK_102,
  "web:tests/prevention/integration-rule-refs-ratchet.test.ts": TASK_102,
  "web:tests/prevention/intelligence-bridge-owner.test.ts": TASK_102,
  "web:tests/prevention/no-dead-css-selectors.test.ts": TASK_102,
  "web:tests/prevention/no-duplicate-constants.test.ts": TASK_102,
  "web:tests/prevention/no-hardcoded-config-values.test.ts": TASK_102,
  "web:tests/prevention/no-proximity-window-assertions.test.ts": TASK_102,
  "web:tests/prevention/no-raw-sql-outside-db.test.ts": TASK_102,
  "web:tests/prevention/no-rule-refs.test.ts": TASK_102,
  "web:tests/prevention/no-scattered-helpers.test.ts": TASK_102,
  "web:tests/prevention/no-throw-new-error.test.ts": TASK_102,
  "web:tests/prevention/no-unused-exports.test.ts": TASK_102,
  "web:tests/prevention/no-unused-imports.test.ts": TASK_102,
  "web:tests/prevention/project-delete-safety.test.ts": TASK_102,
  "web:tests/prevention/secret-intelligence-owner.test.ts": TASK_102,
  "web:tests/prevention/source-structure-parser-differential.test.ts": TASK_102,
  "web:tests/prevention/sse-event-owner.test.ts": TASK_102,
  "web:tests/prevention/state-imports-resolve.test.ts": TASK_102,
  "web:tests/prevention/test-helpers-dedup.test.ts": TASK_102,
  "web:tests/prevention/test-naming-structure.test.ts": TASK_102,
  "web:tests/prevention/tool-registry-owner.test.ts": TASK_102,
  "web:tests/unit/cross-user-path-access.test.ts": TASK_102,
  "web:tests/unit/sole-writer.test.ts": TASK_102,
};

/** The allowlist key for a file, as both records spell it. */
export function readerKey(repository: string, relativePath: string): string {
  return `${repository}:${relativePath}`;
}

/** Every key either record holds — the declared universe, in one place. */
export function allowedKeys(): readonly string[] {
  return [...Object.keys(LEGITIMATE_RAW_READERS), ...Object.keys(UNMIGRATED_SCANNERS)];
}

export interface AllowlistVerdict {
  /** In the universe and in NEITHER record. The refusal. */
  readonly unlisted: readonly string[];
  /**
   * Listed and NO LONGER in the universe. Also a refusal, and the one that
   * keeps the debt honest: a scanner that migrates must have its entry DELETED
   * in the same commit, or the record silently accumulates keys that certify
   * nothing. §25 — the universe that shrank while reporting the same result.
   */
  readonly stale: readonly string[];
  /** How much recorded debt remains. It may only ever go down. */
  readonly debtRemaining: number;
}

/**
 * Compare the scanned universe against the two records.
 *
 * `keysFound` are the allowlist keys of the files the scan put in the guarded
 * universe. Taking keys rather than a scan result keeps this pure, so a plant
 * can drive it over a hand-built set without touching either tree.
 */
export function allowlistVerdict(keysFound: readonly string[]): AllowlistVerdict {
  const legitimate = new Set(Object.keys(LEGITIMATE_RAW_READERS));
  const unmigrated = new Set(Object.keys(UNMIGRATED_SCANNERS));
  const found = new Set(keysFound);
  const unlisted = [...found].filter((k) => !legitimate.has(k) && !unmigrated.has(k)).sort();
  const stale = [...legitimate, ...unmigrated].filter((k) => !found.has(k)).sort();
  return { unlisted, stale, debtRemaining: unmigrated.size };
}

/**
 * The refusal message, or `null`. It NAMES the files and says what to do —
 * §31c: a guard's remedy text is part of the guard, and advice that does not
 * survive being followed is a guard certifying what it just rejected.
 */
export function rawReaderFailure(verdict: AllowlistVerdict): string | null {
  const parts: string[] = [];
  if (verdict.unlisted.length > 0) {
    parts.push(
      `${String(verdict.unlisted.length)} file(s) read source bytes, match the value they read, and ` +
        "enumerate the tree, while appearing in NEITHER allowlist:\n" +
        verdict.unlisted.map((k) => `    ${k}`).join("\n") +
        "\n  Move the file onto `readSourceView(path)` from `source-view.ts` and name the view it " +
        "matches — `code()` when the question is about real code, `codeWithStrings()` when the " +
        "subject lives inside a quoted string (a module specifier IS a string literal), `prose()` " +
        "when the question is whether something appears only in a comment. A file that genuinely " +
        "needs bytes goes in LEGITIMATE_RAW_READERS with the reason written out — and the reason " +
        "has to say why bytes are the CORRECT input, not that the migration is inconvenient.",
    );
  }
  if (verdict.stale.length > 0) {
    parts.push(
      `${String(verdict.stale.length)} allowlist entry/ies name a file that is NO LONGER in the ` +
        "universe:\n" +
        verdict.stale.map((k) => `    ${k}`).join("\n") +
        "\n  Delete the entry AND its union member. If the file was migrated, that deletion is the " +
        "receipt. If it was moved or renamed, the entry has to move with it — an allowlist that " +
        "keeps a key for a file nobody can find is an allowlist nobody can audit.",
    );
  }
  return parts.length === 0 ? null : parts.join("\n\n");
}
