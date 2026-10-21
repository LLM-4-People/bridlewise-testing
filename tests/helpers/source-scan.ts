/**
 * Shared source-scan helpers for the prevention test suite.
 *
 * The prevention tests repeatedly need the same primitives: walk a directory
 * tree, read a file as a UTF-8 string, and strip comments + string-literal
 * interiors so a source scan matches actual code instead of documentation
 * that mentions the forbidden pattern. Before this module, those primitives
 * were re-implemented in 40+ test files as near-duplicate (and sometimes
 * byte-identical) copies that had already drifted into several subtly
 * different implementations. This module is the single owner: every
 * prevention test imports from here so a fix to a shared helper fixes every
 * consumer, and a new test gets a tested helper instead of a fresh copy.
 *
 * The strippers come in distinct semantic variants because callers need
 * different things (drop vs preserve string contents; strip HTML comments
 * or not; CSS block-only). Each variant has ONE canonical implementation
 * here, named for what it does, so a consumer imports the exact behavior it
 * needs and call sites stay stable via import aliases.
 */
import { readFileSync, existsSync, statSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve as resolvePath, sep } from "node:path";
import {
  blankSourceText,
  isTemplateSource,
  lexSpans,
  readSourceView,
  renderSpans,
  sourceViewOf,
} from "../../engine/scripts/verification/source-view.ts";
// The ownership-pruned walk, its index-coverage oracle and the owned-entry
// door live engine-side so both suites share ONE implementation.
export {
  gitTrackedPaths,
  repositoryOwnedEntries,
  ScanUniverseError,
  SOURCE_EXTS,
  walk,
  walkTs,
} from "../../engine/scripts/verification/source-walk.ts";
import { walk, SOURCE_EXTS } from "../../engine/scripts/verification/source-walk.ts";

/**
 * Read a file as a UTF-8 string. The single file-read utility for tests so the
 * encoding is decided once at the lowest level (a caller never has to remember
 * `"utf8"`). Relative paths resolve against the process working directory
 * (vitest runs from the web-interface root).
 */
export function read(rel: string): string {
  return readFileSync(rel, "utf8");
}

/**
 * Convert an absolute or joined path to a relative, forward-slash path (the
 * shape the prevention tests compare against). Stable across platforms
 * (backslashes on Windows are normalized to `/`).
 */
export function relpath(f: string): string {
  return relative(".", f).split(sep).join("/");
}


/**
 * All `.ts` + `.svelte` files under a root as relative, forward-slash paths.
 * The common wrapper over `walk` for scans that compare against relative
 * paths (e.g. `src/lib/chat/ChatPanel.svelte`).
 *
 * THE EXTENSIONS ARE NAMED RATHER THAN DEFAULTED, and the difference is not
 * cosmetic. `walk` now refuses a caller that took the default over a root the
 * index disagrees with, because a default is a claim about source in general
 * rather than a decision about this root. This wrapper HAS decided, and the
 * decision is in its own name: its consumers scan for TypeScript and Svelte
 * constructs — a type assertion, a `satisfies`, a component directive — none of
 * which a `.mjs` file can contain. A consumer that needs plain JS modules in
 * its universe calls `walk` with `SOURCE_EXTS` and says so there.
 *
 * ── THE POPULATION THIS LEAVES BEHIND, AND WHO OWNS IT ────────────────────
 *
 * Naming the extensions here is a decision with a cost, and the cost is
 *  measured rather than waved at. `sourceFiles("engine/src")` returns fewer
 *  `.ts` files than `walk("engine/src", { exts: SOURCE_EXTS })` returns total;
 *  the difference is tracked `.mjs`, of which a couple import
 *  `node:child_process` — `shared/workflow/e2e-runner.mjs`,
 *  `tools/concurrent/long-task-wrapper.mjs`.
 *  Subprocess creation is emphatically not a TypeScript construct, so for the
 * confinement question those 25 files are a real gap and not a decision.
 *
 * IT IS A UNIVERSE GAP AND NOT A PROVEN ESCAPE, driven rather than assumed:
 * the confinement guard's population is the RUNTIME reachability closure of
 * `server/`, which holds 362 files and ZERO `.mjs`; none of the four is in it.
 * So widening this wrapper would not change that guard's verdict — it reads a
 * closure, not this list — and it would push `.mjs` into the several consumers
 * that scan for type assertions, `satisfies` and component directives, where a
 * plain JS module can only produce noise. The narrowing stays.
 *
 * ── WHY THE GAP CANNOT BE CLOSED BY A BETTER WALKER, WHICH IS THE POINT ───
 *
 * `engine/src/tools/concurrent/long-task-runner.ts:170` reaches its wrapper
 * with `resolve(dirname(new URL(import.meta.url).pathname),
 * "long-task-wrapper.mjs")`. That is a PATH STRING evaluated at runtime, never
 * an import — so the edge exists in the running program and in no import graph,
 * at any extension setting. Every reachability instrument in this suite walks
 * module specifiers, so none of them can see it, and neither widening this
 * wrapper nor widening the closure's extension set would put the wrapper in the
 * population. A scan cannot follow an edge that is not written as an edge.
 *
 * That is the mechanism, and it is the reason the answer is not "scan harder".
 * The structural answer is the one the confinement guard's own ladder note
 * already names — confine the PARENT, since the restriction is inherited across
 * fork/exec/clone, which covers a child launched from a path string exactly as
 * it covers one launched from an import. Until that lands, this paragraph is
 * the record of what is NOT covered, so a green confinement run is not read as
 * a statement about these four files.
 */
export function sourceFiles(root: string): string[] {
  return walk(root, { exts: [".ts", ".svelte"] }).map(relpath);
}

// ───────────────────────────────────────────────────────────────────────────
// THE DOOR THAT ENUMERATES, AND THE FLOOR THAT BELONGS AT IT.
//
// ── THE FAILURE ────────────────────────────────────────────────────────────
//
// `for (const f of readdirSync(DIR).filter(…)) expect(read(f)).not.toMatch(…)`
// is the most common guard shape in this suite, and it has no bottom. When the
// list is empty the loop body never runs, every assertion inside it is skipped,
// and the test reports PASS in a fraction of a millisecond having examined
// nothing. There is no failure mode to see: green, fast, and blind look
// exactly like green, fast, and clean.
//
// DRIVEN: renaming `allowedProjectRoots` — which is a CONFIG FIELD, not a test
// concern — emptied one such filter, and the guard that exists to stop a route
// re-implementing the allowed-roots check passed in 0 ms with 45/45 still
// green in its own file. Nothing anywhere went red. The narrowing term is a
// CLAIM ABOUT THE WORLD ("a route that touches this spelling"), and a claim
// that stops being true stops being checked instead of failing.
//
// ── WHY THE FLOOR GOES HERE AND NOT AT EACH LOOP ──────────────────────────
//
// One neighbour of that guard, four lines away, does have a floor —
// `expect(routes.length).toBeGreaterThan(0)` — which is why the shape is
// visibly a decision each author makes rather than a property of the
// enumeration. A floor written at the loop is a floor someone must remember;
// there are eight of these in one file alone. Put it at the door and forgetting
// stops being possible.
//
// ── WHY AN ANCHOR AND NOT A COUNT ─────────────────────────────────────────
//
// `narrowed.length > 0` is the wrong floor for a narrowing guard, because ZERO
// IS OFTEN THE CORRECT ANSWER: "no route re-implements the check" is exactly
// what a healthy tree looks like. The question a count cannot separate is
// whether the term still MEANS anything. So the caller names the owner where
// the spelling lives, and an absent spelling refuses — after which an empty
// narrowing is an honest report about the tree rather than a report about a
// rename.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Every source file under `directory`, refusing an empty answer.
 *
 * For the guards whose population IS the directory (no narrowing term). The
 * walk already refuses a missing or unreadable root and cross-checks its answer
 * against git's index; this adds the one case those cannot see — a root that
 * exists, is readable, is tracked-empty, and yields nothing to iterate.
 *
 * @param subject what the caller believes it is enumerating, quoted back in
 *   the refusal so the message names the guard rather than the helper.
 * @param exts which extensions make up the population. Defaults to `.ts`, the
 *   backend/state narrowing every existing caller wants. A COMPONENT guard's
 *   population is `.svelte`, and it names that here rather than growing a
 *   second door beside this one — the floor has to be at the door, and a door
 *   that only enumerates one extension pushes every other caller back to a
 *   bare `walk` with no floor at all.
 */
export function nonEmptySourceFilesUnder(
  directory: string,
  subject: string,
  exts: readonly string[] = [".ts"],
): readonly string[] {
  const files = walk(directory, { exts });
  if (files.length === 0) {
    throw new Error(
      `nonEmptySourceFilesUnder(): ${subject} enumerated NO ${exts.join("|")} file under ` +
      `${relpath(directory)}. ` +
      `Every assertion in the loop this feeds would be skipped and the guard would pass ` +
      `having examined nothing. Either the files moved — say where — or this directory is ` +
      `no longer the population and the guard needs a different one.`,
    );
  }
  return files;
}

/**
 * The files under `directory` whose source mentions `term`, with the term's own
 * liveness proven first.
 *
 * The returned list MAY be empty, and that is the point: once `term` has been
 * shown to still exist where it is defined, an empty narrowing is a real
 * statement about the tree. Without that proof the same empty list is
 * indistinguishable from a rename, and the guard downstream cannot tell which
 * it received.
 *
 * @param narrow.term the spelling that selects — a substring or a pattern.
 * @param narrow.livingIn the file that DEFINES the term. A term absent from its
 *   own owner refuses, because the narrowing has stopped selecting for the
 *   reason the guard believes it selects.
 * @param subject what the caller believes it is narrowing to.
 *
 * THE LIVENESS PROOF READS THE OWNER'S **CODE**, NOT ITS BYTES. A raw-byte
 * `includes` is satisfied by a doc comment, so the rename this door exists to
 * catch — one that updates the declaration and leaves the old spelling in the
 * paragraph above it — passed the refusal and then selected nothing. Comments
 * and string interiors are blanked by the shared lexer before the term is
 * sought, so only a surviving DECLARATION counts as the term still living
 * here. The rename must reach the code for the narrowing to stay meaningful,
 * which is exactly the claim the caller is making.
 */
export function sourceFilesMentioning(
  directory: string,
  narrow: Readonly<{ term: string | RegExp; livingIn: string }>,
  subject: string,
): readonly string[] {
  const owner = readSourceView(narrow.livingIn).code();
  const present = typeof narrow.term === "string"
    ? owner.includes(narrow.term)
    : narrow.term.test(owner);
  if (!present) {
    throw new Error(
      `sourceFilesMentioning(): ${subject} narrows by ${String(narrow.term)}, and that ` +
      `spelling no longer occurs in the CODE of its owner ${relpath(narrow.livingIn)} ` +
      `(comments and string interiors do not count). The narrowing ` +
      `now selects nothing for a reason that has nothing to do with the tree being clean, ` +
      `so every assertion downstream would be skipped in silence. Follow the rename here, ` +
      `or derive the term from the owner instead of spelling it.`,
    );
  }
  return nonEmptySourceFilesUnder(directory, subject).filter((file) => {
    const source = readFileSync(file, "utf8");
    return typeof narrow.term === "string" ? source.includes(narrow.term) : narrow.term.test(source);
  });
}

// ───────────────────────────────────────────────────────────────────────────
// THE LEXER MOVED OUT. IT IS NOW SHARED WITH THE OTHER REPOSITORY.
//
// "What is a comment, what is a string, what is a template" is answered ONCE,
// in `scripts/verification/source-view.ts`, and both repositories import that
// answer. It used to live here, which meant every scanner on the harness side
// either did without it or grew its own — and a second state machine is a
// second set of blind spots that a violation only has to pick between.
//
// The variants below are unchanged in behaviour: they still each decide only
// WHAT TO PRINT for a span. What they no longer do is decide what a span is.
// ───────────────────────────────────────────────────────────────────────────

/**
 * THE STRIPPER FAMILY'S PATH CONTRACT. The mode is a property of the FILE,
 * owned by `isTemplateSource`, so every door that reads FILE content takes
 * the path as a REQUIRED second argument and dispatches on it. A bare
 * FRAGMENT names its own mode the same way: a probe path (`probe.ts`,
 * `probe.svelte`) passed as the path argument. There is deliberately NO
 * path-less spelling of these doors: a call that omits the path is a
 * typecheck error, through every import alias, so the file-content misuse
 * (a `.ts` read through the template view, a `.svelte` read through the
 * flat walk — both measured on this tree) cannot be spelled rather than
 * being scanned for. The fragment doors that keep a 1-argument form
 * (`stripCommentsOnly`, `stripTemplateComments`, `codeStructureOnly`,
 * `stripCssBlockComments`) each hardcode ONE mode and say so in their
 * docstrings; their file-content callers must hold populations of that
 * mode's files only.
 */

/**
 * WHAT A DROP VIEW PRINTS FOR A SPAN IT DROPS: its newlines, and nothing
 * else. Every view below removes spans but keeps the file's LINES, so a line
 * any caller counts on its output is the line the file holds (a4-design H1:
 * a 4-line doc comment above a hit moved it to line 2 in five views, and
 * guards reported the drifted line).
 */
function droppedLines(text: string): string {
  return text.replace(/[^\n]/gu, "");
}

/** A dropped string or template: one space (a token scan must not run into its neighbour), or its newlines when it spans lines. */
function blankedLiteral(text: string): string {
  return text.includes("\n") ? droppedLines(text) : " ";
}

/**
 * The most-thorough per-file view: JS/TS line + block comments, HTML
 * (Svelte template) comments, and string-literal interiors, with each
 * string replaced by a single space so a token scan does not match a
 * string-literal occurrence. Handles Svelte files (HTML comments in the
 * template, TS in `<script>`, CSS in `<style>`) and code files alike —
 * the mode is picked from the path, never guessed from the bytes.
 */
export function stripCommentsAndStringsFor(src: string, path: string): string {
  return renderSpans(src, isTemplateSource(path), (kind, text) =>
    kind === "string" || kind === "template" ? blankedLiteral(text) : kind === "regex" ? text : droppedLines(text),
  );
}

/**
 * The DROP view of the source AT THIS PATH: JS/TS line + block comments and
 * string-literal interiors removed entirely (no space placeholder), regex
 * literals kept — with the mode picked from the path, so a `.ts` member of
 * a mixed walk gets the flat code walk (byte-identical to the old flat-only
 * form) and a `.svelte` member gets the template walk with its HTML
 * comments, script comments and strings removed. Scans that rely on the
 * exact no-space output over code files keep that output byte-for-byte;
 * only the template half of a mixed population changes, from the phantom
 * span factory the flat walk made of markup to the honest template view.
 */
export function stripCommentsAndStringsDropFor(src: string, path: string): string {
  return renderSpans(src, isTemplateSource(path), (kind, text) => (kind === "regex" ? text : droppedLines(text)));
}

/**
 * The COMMENTS-ONLY views: every comment the file's mode carries blanked,
 * string and template literals preserved whole. `stripCommentsOnlyFor` picks
 * the mode from the path (markup comments exist only in template files);
 * `stripCommentsOnly` is the flat code-mode fragment door.
 *
 * THE IMPLEMENTATION LIVES ENGINE-SIDE, and this module re-exports it. The
 * copy that used to live here had its own state machine, and it read the `//`
 * inside a regex literal (`/https?:\/\//`) as the start of a line comment —
 * so a guard scanning for a token after that line saw a smaller file than the
 * one on disk. The view owner already lexes regex literals; two implementations
 * of "what is a comment" were always going to disagree, so there is now one.
 * A caller whose content came from a file still holds `stripCommentsOnlyFor`,
 * because a `.svelte` template and a `.ts` module are read in different modes.
 */
export { stripCommentsOnly, stripCommentsOnlyFor } from "../../engine/scripts/verification/source-view.ts";

/**
 * Remove Svelte-template HTML comments (`<!-- … -->`) only, keeping code
 * comments and every string literal byte-for-byte.
 *
 * THE OWNER OF THIS QUESTION. A scanner that regexes a `.svelte` TEMPLATE for
 * markup — every control-shaped guard (`switch-verb-owner`, the mouse-path
 * owner, the desk/editor verb owners, the chord-glyph scan) — must read the
 * template with its comments removed: a comment that SPELLS a tag
 * (`<!-- rides the real <button> rows -->`) is not a rendered control, and a
 * scan over raw text reds on a control that does not exist. That false red
 * was fixed twice by rewording the comment, which pays the same cost on every
 * future comment that names a tag. One helper, every template scanner through
 * it, so the class closes once.
 *
 * A SIBLING OF THE CODE STRIPPERS ABOVE, NOT A MODE OF THEM, deliberately:
 * `stripCommentsAndStringsFor` BLANKS string interiors, which would empty an
 * attribute string the template scan is matching (`data-verb-id="…"` is a
 * template attribute, not a JS string literal), and it keeps comment
 * PLACEHOLDERS, which a tag regex can still match. "What is a markup comment"
 * is answered once, by the shared lexer (which also keeps an apostrophe in
 * comment prose — `the row's owner` — from opening a string that eats the
 * rest of the scan). This variant decides only the one thing the lexer does
 * not: markup comments are REMOVED (not blanked), everything else stays.
 *
 * TEMPLATE MODE, named by the path like every file-content door: in code
 * mode there are no markup comments to remove, which is the honest answer
 * for a `.ts` file.
 */
export function stripHtmlComments(src: string, path: string): string {
  return renderSpans(src, isTemplateSource(path), (kind, text) =>
    kind === "html-comment" ? droppedLines(text) : text,
  );
}

/**
 * The TEMPLATE-SCAN VIEW: markup comments removed, then every JS/TS comment
 * the code half carries (`//`, `/* *\/`) removed too — string and template
 * literals kept intact, because the attributes a template scan matches ARE
 * string interiors.
 *
 * THE CHOKE POINT FOR CONTROL-SHAPED SCANS. Six template scanners each grew
 * their own `.replace(/<!--…/`, `.replace(/\/\*…/`, `.replace(/\/\/…/`
 * chain, and the copies had already drifted: one stripped trailing `//`
 * comments (so `onclick={x} // the verb` lost its handler), one stripped
 * `//` inside string literals (so a URL in an attribute opened a phantom
 * comment). A scanner that asks "is this tag a live control" comes through
 * here, so the next scanner cannot pick a weaker view by habit.
 *
 * The one thing this helper does NOT decide is strings: they survive whole,
 * so an attribute value is still readable by the caller's regex. That is the
 * view a control scan needs and no other scan is offered it by accident —
 * the name says the subject, not the mechanism.
 *
 * A FRAGMENT DOOR: the template walk, hardcoded. A caller whose content
 * came from a file may use it only over template files (`.svelte`
 * populations, where the template walk IS the file's mode); code-file
 * content and mixed populations take `stripCommentsOnlyFor(src, path)`.
 */
export function stripTemplateComments(src: string): string {
  return renderSpans(src, true, (kind, text) => {
    if (kind === "string" || kind === "template" || kind === "regex") return text;
    return droppedLines(text);
  });
}

/**
 * Strip block comments and OWN-LINE `//` comments, keeping string literals
 * and keeping TRAILING line comments.
 *
 * ── WHY THIS VARIANT EXISTS AT ALL ────────────────────────────────────────
 *
 * Two callers need a view where a string literal is still code — a scan for
 * an on-screen glyph, or for a `fetch(` call, has to see the string, because
 * that is where the thing it looks for lives. And one of them is
 * deliberately strict about trailing comments: `code(); // ⌘N` counts as
 * code, so a glyph mention has to sit on its own comment line. That is a
 * rule, not an accident, and it is why this is not simply the same call as
 * the comments-only stripper.
 *
 * ── WHY IT IS NO LONGER A REGEX, WHICH IS THE POINT ───────────────────────
 *
 * It used to be two `String.replace` calls, and it was NOT STRING-AWARE. A
 * glob pattern in source — `import.meta.glob("./**\/*.ts")` — contains `/*`,
 * which opened a block comment to the regex; everything up to the next `*\/`
 * anywhere in the file was deleted, and the scan then reported a loader
 * ABSENT that was right there. The population — first-party files containing a
 * `/*`, `*\/` or `//` sequence INSIDE a string literal — is COUNTED AND
 * PRINTED by `stripper-view-owner.test.ts` on every run, so read it from a
 * receipt rather than from here.
 *
 * AND THIS PARAGRAPH DEMONSTRATED ITS OWN LESSON. A number written into prose
 * was carried at 211 while the tree held 210; the regex-literal fix moved it
 * again, and the replacement — 121 — was ALSO stale by the time anyone
 * checked, because the receipt prints 122. Three figures, three drifts, in the
 * sentence explaining why figures drift. So no value is quoted here at all
 * now: run the receipt. Every consumer of this helper scans a tree that holds
 * some of these files. The failure is silent and in the permissive direction —
 * the deleted span cannot contain a violation, so the guard passes.
 *
 * So the comment spans are located in the STRING-BLANKED view, which
 * `blankStringLiterals` produces at exactly the same length, and then cut
 * from the ORIGINAL text. One owner decides what a string is; this function
 * only decides what a comment is. A caller's line-based reporting is
 * unaffected by that choice because the span offsets are shared.
 *
 * The name says the behaviour now, not the implementation. `Regex` described
 * how it worked, which is precisely the detail that was wrong.
 *
 * TEMPLATE MODE, named by the path like every file-content door (its blanked
 * view comes from `blankStringLiterals`, which carries the same note).
 */
export function stripBlockAndOwnLineComments(src: string, path: string): string {
  // The one lexer decides what a comment and a string are; this view decides
  // only which comments go: every block comment, and a line comment that
  // stands on its own line (a trailing one is kept). What goes leaves its
  // newlines, like every drop view here.
  let out = "";
  let cursor = 0;
  for (const span of lexSpans(src, isTemplateSource(path))) {
    const text = src.slice(span.start, span.end);
    const ownLine = span.kind === "line-comment" && /^[ \t]*$/u.test(src.slice(src.lastIndexOf("\n", span.start - 1) + 1, span.start));
    if (span.kind !== "block-comment" && !ownLine) continue;
    out += src.slice(cursor, span.start) + droppedLines(text);
    cursor = span.end;
  }
  return out + src.slice(cursor);
}

/**
 * Blank the CONTENTS of every string literal, preserving the file's exact
 * length and every newline in it.
 *
 * The variants above all shift or collapse line numbers, which is fine for a
 * whole-file pattern scan and useless for a LINE-BASED one: a scan that
 * reports `file:line` has to be looking at the same lines the reader will.
 * The line-based scans consequently did not strip strings at all, so a source
 * snippet inside a test fixture — `` `import { X } from "y"` `` — parsed as a
 * real import statement and was reported as an unused import that the file
 * never had. A guard that reports work nobody did is a guard people learn to
 * override.
 *
 * Comments are left alone: the line-based scans already skip comment LINES,
 * and dropping comment text here would shift nothing but would hide the
 * `//` markers those scans look for. They are still LEXED, though, and HTML
 * comments are lexed too — an apostrophe in Svelte template prose inside
 * `<!-- … -->` (`the row's roving-focus owner`) otherwise opens a string that
 * runs on for the rest of the file. Printing them verbatim keeps every offset.
 *
 * TEMPLATE MODE, named by the path like every file-content door — over a
 * `.ts` source the template mode would leave string interiors UNBLANKED
 * (a quote is prose in markup), and this view's whole promise is that every
 * string interior is blanked, so a per-file caller must name the path.
 */
export function blankStringLiterals(src: string, path: string): string {
  return renderSpans(src, isTemplateSource(path), (kind, text) => {
    if (kind !== "string" && kind !== "template") return text;
    const quote = text[0]!;
    const closed = text.length > 1 && text.endsWith(quote);
    const body = closed ? text.slice(1, -1) : text.slice(1);
    // Per UTF-16 CODE UNIT, not per code point: this function's whole promise
    // is that offsets survive it, and a spread would collapse a surrogate pair
    // into one element and shift every offset after it.
    return quote + blankSourceText(body) + (closed ? quote : "");
  });
}

/**
 * Blank EVERYTHING that is not code structure — comments, string and
 * template literals, and regex literals — preserving the file's exact length
 * and every newline, so offsets and line numbers in the view are the raw
 * file's own.
 *
 * The view a CALL-SHAPE scan reads. The majority variant
 * ({@link stripCommentsAndStringsFor}) keeps regex literals because token scans
 * look for them, and collapses each string to one space because its readers
 * never balance delimiters. A scan that finds where a call ENDS needs the
 * opposite of both: no literal of any kind may contribute a paren (a depth
 * walk then lands on the call's own close paren, exactly), and nothing may
 * shift an offset. Pure TS/JS — no Svelte template comments.
 */
export function codeStructureOnly(src: string): string {
  return renderSpans(src, false, (_kind, text) => blankSourceText(text));
}

/**
 * Strip CSS block comments only. Used by CSS-token + dead-CSS
 * scans that operate on a `<style>` block (no line comments in CSS, no
 * string-literal handling needed).
 */
export function stripCssBlockComments(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] === "/" && s[i + 1] === "*") {
      const close = s.indexOf("*/", i + 2);
      const end = close === -1 ? s.length : close + 2;
      // The comment's newlines stay, like every drop view's.
      out += droppedLines(s.slice(i, end));
      i = end;
      continue;
    }
    out += s[i]!;
    i += 1;
  }
  return out;
}


/**
 * Does `source` pull RUNTIME VALUES out of the module whose specifier ends
 * with `moduleSuffix`?
 *
 * Owner-bypass scans all ask this one question — "who reaches the engine
 * without going through its owner?" — and three of them had grown their own
 * regex to answer it. Each regex knew a different subset of the syntax, so
 * each had a different blind spot, and a bypass only had to pick the spelling
 * its scanner had never heard of. Verified by mutation: a route reaching the
 * symbol-search engine through `await import(…)` passed the scan that knew
 * only `import … from`, with every other assertion green — the duplicate-path
 * defect those scans exist to catch, wearing a syntax they did not read.
 *
 * FIVE forms reach a module's values, and all five count here:
 *   `import … from "M"`   `import "M"`   `export … from "M"` (incl. `export *`)
 *   `import("M")`         `require("M")`
 *
 * Type-only forms are excluded — `import type`, `export type`, and a brace
 * list whose every specifier is `type X` — because a type reference is erased
 * before anything runs and so creates no second path.
 *
 * This is a source scan, which is the weakest rung of enforcement: it is only
 * as good as the universe it walks and the syntax it knows. It stops there
 * because the two modules live in separate packages with no build step that
 * could refuse the reference, so nothing stronger is available from a test.
 * Callers must walk their file set DYNAMICALLY for the same reason.
 */
export function valueReferencesModule(source: string, moduleFragment: string): boolean {
  for (const clause of moduleClauses(source, moduleFragment)) {
    if (clause.kind !== "static") return true; // dynamic import / require
    if (!isTypeOnlyClause(clause.text)) return true;
  }
  return false;
}

/**
 * The VALUE names `source` re-exports from the module matching
 * `moduleFragment` — `export { a, b } from "M"`, minus any `type`
 * specifiers, minus `export type { … } from "M"` entirely.
 *
 * A re-export is the quiet way to add a second path to an owned subsystem:
 * it reads as an index file rather than as a bypass, and a scan that looks
 * only for `import` never sees it. Returning the NAMES rather than a boolean
 * lets a caller ask the question that actually matters — whether what was
 * re-exported is behaviour or merely a constant.
 *
 * `export * from "M"` re-exports everything and names nothing, so it is
 * reported as the single name `*`; a caller treating that as behaviour is
 * correct, because it certainly includes any.
 */
export function reExportedValuesFrom(source: string, moduleFragment: string): string[] {
  const names: string[] = [];
  for (const clause of moduleClauses(source, moduleFragment)) {
    if (clause.keyword !== "export" || clause.kind !== "static") continue;
    if (/^\s*type\s/.test(clause.text)) continue;
    if (/^\s*\*/.test(clause.text)) {
      names.push("*");
      continue;
    }
    const braces = clause.text.match(/\{([\s\S]*)\}/);
    if (braces === null) continue;
    for (const spec of braces[1]!.split(",")) {
      const trimmed = spec.trim();
      if (trimmed.length === 0 || /^type\s/.test(trimmed)) continue;
      // `X as Y` re-exports X's binding under the name Y; X is the name the
      // owner module declares, which is what a caller needs to look up.
      names.push(trimmed.split(/\s+as\s+/)[0]!.trim());
    }
  }
  return names;
}

/**
 * Every import/export/require clause in `source` whose module specifier
 * contains `moduleFragment`. The fragment is matched as a SUBSTRING of the
 * specifier, so callers may pass a whole module path
 * (`intelligence/symbol-search.ts`) or a subsystem prefix
 * (`integration/src/intelligence/`) — both are how the owner scans ask the
 * question, and an implementation that only understood one of them silently
 * matched nothing for the other.
 *
 * `undefined` means EVERY clause, which is what the import-graph walk needs:
 * it does not know which specifiers it is looking for until it has read them.
 */
function* moduleClauses(
  source: string,
  moduleFragment: string | undefined,
): Generator<Clause> {
  // THE CANDIDATE SPECIFIERS ARE THE QUOTED-STRING SPANS, AND ONLY THOSE.
  //
  // The old implementation regex-matched quotes over a comment-stripped view.
  // That view is lossy in three shapes, all driven:
  //
  //   * a TEMPLATE literal spelling an import (`const s = `import … from
  //     "./x"``) registered `./x` as a consumer — the template's interior is
  //     not a module specifier, but the stripped view preserved it;
  //   * a `* import …` star-line residual (a jsdoc-continuation line outside
  //     any comment) registered its module — the clause scan found `import`
  //     and accepted it;
  //   * an UNCLOSED block comment blanked the rest of the file, silently
  //     swallowing every real import below it — the dangerous direction,
  //     because the README consumer graph then under-reports.
  //
  // So the candidates come from the shared lexer (`lexSpans`), which already
  // classifies every span: a specifier is a QUOTED string (kind "string") in
  // code position — never a template, never a comment. An unclosed block
  // comment is a loud refusal, not a truncated view.
  const spans = lexSpans(source, false);
  const last = spans[spans.length - 1];
  if (
    last !== undefined &&
    last.kind === "block-comment" &&
    last.end === source.length &&
    !source.slice(last.start, last.end).endsWith("*/")
  ) {
    throw new Error(
      `moduleClauses(): an unclosed block comment (opened at index ${last.start}) runs to ` +
        `end-of-file, so every import below it would vanish from the graph silently. ` +
        `Close the comment; the graph refuses to read a truncated file.`,
    );
  }
  // The comment-stripped, strings-preserved view the clause scan matches
  // against. It is OFFSET-PRESERVING (comments blanked to spaces, never
  // deleted — `sourceViewOf(...).codeWithStrings()`), so a span's index into
  // the original source is an index into this view, and `import` inside a
  // comment is blank and cannot be mistaken for a keyword.
  const code = sourceViewOf(source, "<module-scan>").codeWithStrings();
  // The keyword positions are a property of the view, not of any one span:
  // collected once here so every span below binary-searches instead of
  // re-scanning the prefix (see `KeywordSighting` for the measured cost and
  // the equivalence argument).
  const sightings = keywordSightingsIn(code);
  for (const span of spans) {
    if (span.kind !== "string") continue;
    const text = source.slice(span.start, span.end);
    const quote = text[0]!;
    // The specifier is the string's interior (delimiters excluded).
    const specifier = text.slice(1, text.length > 1 && text.endsWith(quote) ? -1 : undefined);
    if (moduleFragment !== undefined && !specifier.includes(moduleFragment)) continue;
    const clause = importClauseBefore(code, span.start, sightings);
    if (clause !== null) yield { ...clause, specifier };
  }
}

/**
 * WHICH EDGES A MODULE WALK FOLLOWS — and why the caller has to say.
 *
 * `"runtime"` drops type-only clauses, because TypeScript erases them and so
 * they create no path anything can travel while the program runs. That is the
 * right question for a CAPABILITY guard: a type reference cannot start a
 * process.
 *
 * `"all"` keeps them, because a COMPILER still has to resolve them. `tsc -p
 * tsconfig.server.json` follows `import type` and fails on a specifier it
 * cannot find, so a guard asking "does the server's program resolve" that
 * walked runtime edges only would have skipped `shared/block-contract.ts`
 * — whose single cross-repository import is type-only — and certified a
 * closure with the interesting edge removed.
 *
 * The parameter is REQUIRED for the reason §8b records about stripped views:
 * a walk that silently picks the narrower universe answers "nothing is wrong"
 * and "nothing was looked at" with the same value. Two questions, two names,
 * and the call site says which one it is asking.
 */
export type ModuleEdges = "runtime" | "all";

/**
 * Every module specifier `source` reaches, under the chosen edge kind.
 */
export function moduleSpecifiers(source: string, edges: ModuleEdges): readonly string[] {
  const out: string[] = [];
  for (const clause of moduleClauses(source, undefined)) {
    if (edges === "runtime" && clause.kind === "static" && isTypeOnlyClause(clause.text)) continue;
    out.push(clause.specifier);
  }
  return out;
}

/**
 * Does `source` reference the module at all — value OR type?
 *
 * The stricter question, for owners where even a type reference is a bypass
 * because it means someone reached past the owner to describe the shape of
 * what it hides. Same syntax coverage as `valueReferencesModule`; only the
 * type-only exemption is dropped.
 */
export function referencesModule(source: string, moduleFragment: string): boolean {
  for (const _clause of moduleClauses(source, moduleFragment)) return true;
  return false;
}

/**
 * The `import`/`export`/`require` clause that owns the specifier at `at`, or
 * null when the specifier belongs to no such statement. Found by scanning
 * BACKWARDS to the nearest keyword rather than by matching a whole statement,
 * so a brace list broken across many lines is read correctly.
 *
 * The scan has NO fixed look-back window. An earlier version sliced the prior
 * 600 characters and matched within that, which silently dropped any statement
 * whose clause spans more than 600 characters — a long export list, or a
 * comment-heavy one such as a canonical hub's annotated re-export. The edge
 * then vanished from the graph with no diagnostic, the exact silently-shrinking
 * universe a capability guard cannot survive. The whole file is scanned instead;
 * the statement-boundary checks below are what keep an unrelated string from
 * being misattributed, not the size of the window.
 *
 * The clause must reach the specifier without crossing a `;` or another
 * string literal. Without that bound, an ordinary string that merely NAMES
 * the module — a log line, an error message — is attributed to whatever
 * import happens to sit above it, and the guard reports a bypass that is not
 * there. A guard that cries wolf is unwired within a week, so a false
 * positive costs about as much as a false negative.
 */
interface Clause {
  /** The statement keyword that owns the specifier. */
  readonly keyword: "import" | "export" | "require";
  /** How the module is reached: a static form, `import()`, or `require()`. */
  readonly kind: "static" | "dynamic" | "require";
  /** The text between the keyword and the specifier. */
  readonly text: string;
  /** The module specifier itself, as written. */
  readonly specifier: string;
}

/**
 * One keyword sighting in the code view: where a clause keyword was seen, and
 * which one it is.
 *
 * ── WHY THE SIGHTINGS ARE COLLECTED ONCE PER SCAN, NOT ONCE PER SPAN ───────
 *
 * Every string span in a module used to re-ask the same three questions
 * (`import`? `export`? `require`?) over a fresh copy of the whole prefix, and
 * a file with S string spans cost S × 3 full-prefix regex scans — quadratic in
 * file size. Measured over the four product roots (1,061 modules, 14 MB):
 * reading every file took 20ms while `moduleSpecifiers` took 4,893ms, almost
 * all of it in this rescan; the consumer-graph walk that parses the whole
 * tree once per asking file carried ~5s of that cost into three separate
 * guards, and every capability closure walk paid the same tax per file. The
 * keyword positions are a fixed property of the code view, so they are
 * collected in ONE pass and each span binary-searches the list.
 *
 * THE ANSWERS ARE IDENTICAL, AND HERE IS THE PROOF OBLIGATION: the old scan
 * ran `matchAll` over the prefix `code.slice(0, at)`, which reports a match
 * only when it fits entirely inside the prefix; the new list is filtered by
 * `sighting.at < at`. Those select the same set, because a keyword match
 * starting before `at` can never cross it: the character AT `at` is the
 * opening quote of a string span, a keyword is made of letters, and a regex
 * match whose letters landed on that quote does not exist. Every sighting
 * with `at < span start` is therefore fully contained in the prefix, which is
 * exactly the population the old scan could see.
 */
interface KeywordSighting {
  /** The match's start index — the non-word character before the keyword, or
   *  0 when the keyword opens the file. The same index `matchAll` reported. */
  readonly at: number;
  readonly keyword: "import" | "export" | "require";
}

/** Every clause-keyword sighting in `code`, ascending by position. */
function keywordSightingsIn(code: string): readonly KeywordSighting[] {
  const out: KeywordSighting[] = [];
  for (const keyword of ["import", "export", "require"] as const) {
    const re = new RegExp(`(?:^|[^\\w$.])${keyword}\\b`, "g");
    for (const m of code.matchAll(re)) {
      if (m.index !== undefined) out.push({ at: m.index, keyword });
    }
  }
  // Different keywords cannot share a start index (each match is the
  // non-word character plus that keyword's own letters), so the sort has no
  // ties to break and the "nearest keyword" is simply the last one before
  // the span.
  out.sort((a, b) => a.at - b.at);
  return out;
}

function importClauseBefore(
  code: string,
  at: number,
  sightings: readonly KeywordSighting[],
): Omit<Clause, "specifier"> | null {
  // The whole prefix, not a window: see the header comment. The nearest keyword
  // before the specifier is what we want, and the statement-boundary checks
  // below — not a character budget — decide whether it owns this specifier.
  //
  // The keyword positions arrive precomputed (see `KeywordSighting`): the last
  // sighting that starts before the span is the "nearest keyword", the same
  // one the per-span prefix scan used to find.
  let best = -1;
  for (let lo = 0, hi = sightings.length; lo < hi; ) {
    const mid = (lo + hi) >> 1;
    if (sightings[mid]!.at < at) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  if (best === -1) return null;
  const bestKeyword = sightings[best]!.keyword;
  // A STAR-LINE IS NOT A CLAUSE. A jsdoc-continuation line reads
  // ` * import … from "./x"`; when such a line survives as code (an unclosed
  // block's residue, or plain malformed source), the keyword scan finds
  // `import` and accepts the ` * ` before it as clause text. No real import
  // statement begins with a bare `*` at its line's start, so reject a clause
  // whose keyword is immediately preceded (ignoring whitespace) by `*`.
  const keywordStart = code.indexOf(bestKeyword, sightings[best]!.at);
  // The star-line test reads only the prefix's TAIL (`/\*\s*$/` — a `*`
  // with nothing but whitespace after it), so it is answered by walking
  // backwards from the keyword instead of materialising the prefix: skip
  // whitespace, then the nearest character must be the star. Same verdict as
  // the regex on the sliced prefix, without the copy.
  let walk = keywordStart - 1;
  while (walk >= 0 && /\s/.test(code[walk]!)) walk -= 1;
  if (code[walk] === "*") return null;
  const text = code.slice(keywordStart + bestKeyword.length, at);
  if (/[;"'`]/.test(text)) return null;
  const keyword = bestKeyword;
  // THE TEXT MUST LOOK LIKE AN IMPORT CLAUSE, not merely lack a semicolon.
  //
  // "nearest keyword, no `;` in between" accepts far too much: `export function
  // f() { return p.replace(".", "/") }` has `export`, then no semicolon, then a
  // string — so `"."` was attributed to an import statement and reported as a
  // module. Measured on the import graph: 45 phantom specifiers, several of
  // them BARE, which is the direction that matters because a capability guard
  // asks "who imports this module" of exactly that index and would have named
  // files that import nothing of the sort. A guard that reports work nobody did
  // is a guard people learn to override.
  if (keyword === "require" || (keyword === "import" && /^\s*\(/.test(text))) {
    return CALL_CLAUSE.test(text)
      ? { keyword, kind: keyword === "require" ? "require" : "dynamic", text }
      : null;
  }
  return STATIC_CLAUSE.test(text) ? { keyword, kind: "static", text } : null;
}

/** `import(` / `require(` with nothing but whitespace before the specifier. */
const CALL_CLAUSE = /^\s*\(\s*$/;

/**
 * Everything TypeScript allows between `import`/`export` and the specifier of
 * a static clause, and nothing else: an optional `type`, then a default
 * binding, a namespace, a brace list or a combination, then `from`. The bare
 * side-effect form (`import "M"`) is the empty case, which the outer optional
 * covers.
 */
const STATIC_CLAUSE =
  /^\s*(?:type\s+)?(?:(?:\*(?:\s+as\s+[A-Za-z_$][\w$]*)?|[A-Za-z_$][\w$]*(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+[A-Za-z_$][\w$]*))?|\{[^}]*\})\s*from\s*)?$/;

// ───────────────────────────────────────────────────────────────────────────
// THE IMPORT GRAPH — the default population for a capability guard.
//
// ── THE FAILURE THIS EXISTS TO END ─────────────────────────────────────────
//
// Every guard that has failed this project failed the same way: it scanned the
// wrong universe, and the universe was always "the directory I was thinking
// about". The subprocess guard scanned `server/` and asserted that exactly one
// module there can start a program. That sentence was FALSE while the guard
// was green 32/32, because the module that started the program was ONE IMPORT
// AWAY, in the other repository — reachable from `server/` on every request,
// invisible to a scan of `server/`. A bare `"child_process"` specifier escaped
// the same guard for the same reason at one remove: the text it looked for was
// a guess about spelling rather than a question about reachability.
//
// A directory is a filing decision. What a process can DO is decided by what
// it can REACH, and reachability is the import graph. So a capability guard's
// population is the transitive closure of its entry points, and a guard that
// wants a smaller population has to say so out loud.
//
// ── WHAT IT DOES AND DOES NOT KNOW ────────────────────────────────────────
//
// It resolves RELATIVE and ROOT-ABSOLUTE specifiers, against the importing
// FILE's directory — never against the process's working directory, which is a
// mistake §8b records having been made and which silently produces an empty
// answer. It crosses repository boundaries, because `../../harness-main-v1/...`
// is an ordinary relative path and the graph does not care that a package
// boundary was crossed; that boundary is exactly where the live violation hid.
//
// It does NOT descend into `node_modules`, and it does not resolve BARE
// specifiers to files. Both are recorded instead: `bareSpecifiers` maps a
// specifier to every reachable file that names it, which is how a guard asks
// "does anything reachable from here import a process-creating module, under
// ANY of its spellings" without having to enumerate the spellings.
//
// A COMPUTED specifier (`import(someVariable)`) cannot be resolved by any
// source scan; it is counted in `dynamicUnresolved` so its number is visible
// rather than assumed to be zero. That is the honest form of a blind spot: a
// quantity a guard can assert a bound on.
// ───────────────────────────────────────────────────────────────────────────

/** The extensions a specifier may be resolved to, in Node's own order. */
const RESOLVE_EXTS: readonly string[] = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx", ".svelte"];

export interface ReachableSources {
  /** Every source file reachable from the entry points, absolute, sorted. */
  readonly files: readonly string[];
  /** The entry points themselves, absolute (a subset of `files`). */
  readonly entrypoints: readonly string[];
  /** Bare specifier → the reachable files that name it at runtime. */
  readonly bareSpecifiers: ReadonlyMap<string, readonly string[]>;
  /** Relative specifiers that resolved to nothing — a stale import or a gap. */
  readonly unresolved: readonly string[];
  /** `import(expr)` / `require(expr)` sites no source scan can resolve. */
  readonly dynamicUnresolved: number;
}

/**
 * Every source file reachable from `entrypoints` by a RUNTIME import edge.
 *
 * Use this, not a directory walk, whenever a guard's subject is a CAPABILITY —
 * "who can start a process", "who can open a socket", "who can reach the
 * database". A capability travels along imports and stops at nothing else.
 *
 * @param entrypoints Absolute or cwd-relative paths of the files that are
 *   genuinely entered from outside: route modules, worker entry points, the
 *   server's own index. Pass the whole directory when every file in it is
 *   reachable from something — over-including the entry set is safe, because
 *   the closure only grows, and a guard that under-includes is the failure
 *   this helper exists to end.
 * @param edges `"runtime"` for a capability question (what can this program
 *   DO), `"all"` for a resolution question (what must a compiler find). See
 *   `ModuleEdges` for why this is not defaulted.
 */
export function sourceFilesReachableFrom(
  entrypoints: readonly string[],
  edges: ModuleEdges,
): ReachableSources {
  const seen = new Set<string>();
  const bare = new Map<string, string[]>();
  const unresolved: string[] = [];
  let dynamicUnresolved = 0;
  const queue: string[] = [];
  const starts: string[] = [];
  for (const entry of entrypoints) {
    const abs = resolvePath(entry);
    if (!existsSync(abs)) {
      // The same refusal as `walk`, for the same reason. A capability guard's
      // population is the transitive closure of its entry points, so an entry
      // point that has MOVED silently shrinks that closure — and a guard whose
      // entry set has all moved reports an empty closure and passes, which is
      // the strongest possible version of the defect this file exists to end.
      throw new Error(
        `sourceFilesReachableFrom(): entrypoint does not exist: ${entry} (resolved: ${abs}). ` +
        `A missing entrypoint shrinks the reachable closure with no diagnostic.`,
      );
    }
    starts.push(abs);
    if (seen.has(abs)) continue;
    seen.add(abs);
    queue.push(abs);
  }
  while (queue.length > 0) {
    const file = queue.pop()!;
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const specifier of moduleSpecifiers(source, edges)) {
      // An empty or interpolated specifier is a computed one wearing a string
      // literal's clothes; it names no file and must not be silently dropped.
      if (specifier.length === 0 || specifier.includes("${")) {
        dynamicUnresolved += 1;
        continue;
      }
      if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
        const sites = bare.get(specifier);
        if (sites === undefined) bare.set(specifier, [file]);
        else if (!sites.includes(file)) sites.push(file);
        continue;
      }
      // RESOLVED AGAINST THE IMPORTING FILE'S DIRECTORY. Resolving against
      // `process.cwd()` is the mistake that once turned ten importers into a
      // confident zero.
      const resolved = resolveModuleFile(join(dirname(file), specifier));
      if (resolved === null) {
        unresolved.push(`${relpath(file)} → ${specifier}`);
        continue;
      }
      if (resolved.includes("/node_modules/")) continue;
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      queue.push(resolved);
    }
  }
  return {
    files: [...seen].sort(),
    entrypoints: starts.sort(),
    bareSpecifiers: bare,
    unresolved: unresolved.sort(),
    dynamicUnresolved,
  };
}

/**
 * Node's own resolution, reduced to what a source scan can answer: the exact
 * path, then each known extension, then the directory's `index`. A specifier
 * written with a `.js` extension that only exists as `.ts` is handled too,
 * because that is the shape TypeScript's own ESM output uses and a resolver
 * that missed it would report a real importer as unresolved.
 */
function resolveModuleFile(candidate: string): string | null {
  const attempts: string[] = [candidate];
  const jsLike = candidate.match(/\.(js|mjs|cjs|jsx)$/);
  if (jsLike !== null) {
    const stem = candidate.slice(0, -jsLike[0].length);
    for (const ext of RESOLVE_EXTS) attempts.push(stem + ext);
  }
  for (const ext of RESOLVE_EXTS) attempts.push(candidate + ext);
  for (const ext of RESOLVE_EXTS) attempts.push(join(candidate, `index${ext}`));
  for (const attempt of attempts) {
    try {
      if (statSync(attempt).isFile()) return realpathSync(attempt);
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * The reachable files that name ANY of `specifiers` at runtime, whatever the
 * spelling. The bare-specifier index is the right place to ask this: a module
 * cannot be imported without being named, and `"child_process"` and
 * `"node:child_process"` are two names for one capability — a guard that
 * looked for only one of them was defeated by the other.
 */
export function reachableFilesImporting(
  reach: ReachableSources,
  specifiers: readonly string[],
): readonly string[] {
  const wanted = new Set(specifiers);
  const out = new Set<string>();
  for (const [specifier, sites] of reach.bareSpecifiers) {
    if (!wanted.has(specifier)) continue;
    for (const site of sites) out.add(site);
  }
  return [...out].sort();
}

/**
 * Both spellings of every Node built-in in `names` — `fs` and `node:fs`.
 * Derived rather than written twice, because writing a capability's spellings
 * out by hand is how one of them gets forgotten, which is exactly how a bare
 * `"child_process"` walked past the subprocess guard.
 */
export function builtinSpellings(names: readonly string[]): readonly string[] {
  return names.flatMap((name) => [name, `node:${name}`]);
}

/** A clause that names only types, and so is erased before anything runs. */
function isTypeOnlyClause(text: string): boolean {
  if (/^\s*type\s/.test(text)) return true;
  const braces = text.match(/\{([\s\S]*)\}/);
  if (braces === null) return false;
  const specifiers = braces[1]!
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  // An empty brace list imports nothing; a list is type-only when every one
  // of its specifiers is.
  return specifiers.length > 0 && specifiers.every((s) => /^type\s/.test(s));
}

/**
 * Extract the CSS rule body for a selector (the text between the `{` after the
 * selector and its matching closing `}`). Returns "" when the selector is
 * absent. Shared by the editor + tools + UX scans that inspect a `<style>`
 * rule without re-implementing brace matching.
 */
export function cssBlock(source: string, selector: string): string {
  const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{");
  const m = re.exec(source);
  if (m === null) return "";
  let depth = 0;
  let i = m.index + m[0].length;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      if (depth === 0) break;
      depth--;
    }
  }
  return source.slice(m.index + m[0].length, i);
}

/**
 * Parse the exported PUBLIC names from TypeScript source — the names a
 * consumer could import from the module. Returns a de-duplicated, sorted
 * list. Handles `export const/let/var/function/class/type/interface NAME`
 * and `export { X }` / `export { X as Y }` (Y is the exported alias) /
 * `export { type X }`. Comments + string-literal interiors are stripped
 * first so an export name mentioned only in a docstring or string does not
 * produce a false positive. Used by prevention tests that derive a contract
 * export list dynamically from its single owner source (deny-by-default: a
 * newly added export is automatically required of every consumer, with no
 * hand-maintained mirror that can rot when the owner grows).
 *
 * The strip is the path-aware view, because the mode is a property of the
 * file: the caller names the path the source came from, and a fragment
 * names its probe path (a TS fragment says probe.ts). Reading a .ts source
 * through the template view instead keeps its comments and strings as
 * prose, and every export-shaped mention inside them parses as a phantom
 * export.
 *
 * Limitations: `export const { a, b } = obj` destructure exports and
 * `export default <expr>` are not captured — none of the scanned owner
 * modules use those forms.
 */
export function parseExports(src: string, path: string): string[] {
  const stripped = stripCommentsAndStringsFor(src, path);
  const names = new Set<string>();
  for (const m of stripped.matchAll(/\bexport\s+(?:const|let|var)\s+(\w+)/g)) {
    names.add(m[1]!);
  }
  for (const m of stripped.matchAll(/\bexport\s+(?:async\s+)?function\s*\*?\s*(\w+)/g)) {
    names.add(m[1]!);
  }
  for (const m of stripped.matchAll(/\bexport\s+class\s+(\w+)/g)) {
    names.add(m[1]!);
  }
  for (const m of stripped.matchAll(/\bexport\s+type\s+(\w+)/g)) {
    names.add(m[1]!);
  }
  for (const m of stripped.matchAll(/\bexport\s+interface\s+(\w+)/g)) {
    names.add(m[1]!);
  }
  for (const block of stripped.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    const body = block[1]!;
    for (let spec of body.split(",")) {
      spec = spec.trim();
      if (!spec) continue;
      // Drop the `type` modifier in `export { type X }` (type-only re-export).
      spec = spec.replace(/^type\s+/, "");
      // `X as Y` → the exported name is Y; `X as default` → "default".
      const asMatch = spec.match(/\bas\s+(.+)$/);
      names.add(asMatch ? asMatch[1]!.trim() : spec);
    }
  }
  return [...names].sort();
}

/**
 * Read a source file (UTF-8) and return its exported public names. The single
 * file-read + parse path so callers never hardcode the encoding or the parser;
 * the file's own path picks the strip mode.
 */
export function parseExportsFromFile(rel: string): string[] {
  return parseExports(read(rel), rel);
}

/**
 * ── WHY THIS IS AN INDEX AND NOT A RESCAN ────────────────────────────────
 *
 * The original shape re-read and re-regexed THE WHOLE CODEBASE once per
 * candidate export name: ~460 names × 935 files × 10.1MB. Measured, in
 * isolation: **15.5s, of which `import` was 15.41s and `tests` was 14ms.**
 *
 * That is not merely slow, it is slow in the one place the scheduler cannot
 * see. Vitest orders files by their TEST duration, and this file's test
 * duration is 14ms — so it was sorted to the very end of the run, where its
 * 15s of collect-time work had nothing left to overlap with. Measured on the
 * full suite: every other file finished by **+26.9s**, this one started at
 * +26.9s and the run ended at **+41.5s**. Whether that tail was exposed or
 * absorbed is what made the suite's wall clock bimodal (~31s vs ~43s) across
 * a 35s budget that sat between the two.
 *
 * The work is a bag-of-words question, so it is answered with a bag of words
 * built ONCE. `\b` in JS uses `\w = [A-Za-z0-9_]`, so `\bname\b` matches a
 * text exactly when `name` is one of that text's maximal `[A-Za-z0-9_]`
 * runs — which is precisely membership in the token set. The equivalence is
 * asserted directly in `no-unused-exports-index.test.ts`, including the
 * cases where it does NOT hold (`$` is not a `\w` char, so a name containing
 * one is not a single token) — those take the original regex path.
 */

/** Tokens are maximal `\w` runs — the exact unit `\b…\b` delimits. */
const TOKEN_RE = /[A-Za-z0-9_]+/g;
/** A name the token index can answer for: a single `\w` run, no `$`. */
export const isTokenName = (name: string): boolean => /^[A-Za-z0-9_]+$/.test(name);

/**
 * The files containing a token, capped at two.
 *
 * Two is all any caller needs: the only question asked is "does a file OTHER
 * than the declaring one reference this name?", and two distinct files
 * guarantee one of them is not the declarer whatever the declarer is. Capping
 * keeps the index a few hundred KB instead of an inverted index over 1.5M
 * (token, file) pairs.
 */
export interface TokenSites {
  readonly first: string;
  readonly second: string | null;
}

/** token → up to two of the relative paths whose text contains it. */
export function buildTokenIndex(
  files: readonly string[],
  cwd: string,
  readText: (f: string) => string = (f) => readFileSync(f, "utf-8"),
): Map<string, TokenSites> {
  const index = new Map<string, TokenSites>();
  for (const file of files) {
    const rel = relative(cwd, file).split(sep).join("/");
    // A per-file Set first, so a token appearing 500 times in one file
    // records that file once rather than overwriting `second` with itself.
    const seen = new Set<string>();
    for (const m of readText(file).matchAll(TOKEN_RE)) seen.add(m[0]);
    for (const token of seen) {
      const sites = index.get(token);
      if (sites === undefined) index.set(token, { first: rel, second: null });
      else if (sites.second === null) index.set(token, { first: sites.first, second: rel });
      // Already two distinct files — nothing a third could add.
    }
  }
  return index;
}

/**
 * Is `name` referenced as a whole word by any file other than `ownRel`?
 *
 * A reference in another file may be a bare call (`foo()`), a destructured
 * import (`import { foo }`), or a module-namespace call (`mod.foo()`) — all
 * are legitimate references to the export, so all count (the `.foo()` form is
 * how an imported module's export is invoked).
 */
export function referencedElsewhere(
  name: string,
  ownRel: string,
  index: Map<string, TokenSites>,
  allFiles: readonly string[],
  cwd: string,
  readText: (f: string) => string = (f) => readFileSync(f, "utf-8"),
): boolean {
  if (isTokenName(name)) {
    const sites = index.get(name);
    if (sites === undefined) return false;
    // Two distinct files ⇒ at least one of them is not the declarer.
    if (sites.second !== null) return true;
    return sites.first !== ownRel;
  }
  // Not a single `\w` run (e.g. a name containing `$`): the token index
  // cannot answer, so ask the original question the original way.
  const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  for (const file of allFiles) {
    const rel = relative(cwd, file).split(sep).join("/");
    if (rel === ownRel) continue;
    if (re.test(readText(file))) return true;
  }
  return false;
}
