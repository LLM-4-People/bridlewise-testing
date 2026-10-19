// @vitest-environment node
/**
 * EVERY STRIPPER PRINTS WHAT IT EXTRACTED, OVER REAL SOURCE, ONCE.
 *
 * ── THE RULE, AND WHY THE STRIPPERS WERE NEVER HELD TO IT ─────────────────
 *
 * A helper that replaces a weak mechanism must be driven over real source and
 * its output PRINTED before any call site trusts it. That rule was written for
 * body-matchers, after two agents independently took the wrong brace for a
 * function body on the same day. The strippers are the same shape — a scan
 * asks one what the code is, and every assertion afterwards is about whatever
 * came back — and nothing had ever made one of them show its work.
 *
 * It cost a real finding. `stripCommentsRegex` was two `String.replace` calls
 * and was NOT string-aware: a glob pattern in source contains `/*`, which
 * opened a block comment to the regex, and everything up to the next `*​/`
 * anywhere in the file was deleted. The scan then reported a store-reset
 * loader ABSENT that was sitting right there. The failure is silent and
 * permissive — a deleted span cannot contain a violation — so the guard
 * passes while checking less.
 *
 * ── WHAT THIS FILE DOES ───────────────────────────────────────────────────
 *
 * It measures the population that can trigger the class, over the real tree,
 * and prints it. Then it drives each stripper over the exact source that broke
 * one of them and asserts on WHAT SURVIVED, not on a length. Every fixture is
 * a real repository file chosen by measurement, never a string typed here —
 * a stripper that is only ever shown hand-written source is a stripper that
 * has been shown the easy case.
 */
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";

import {
  blankStringLiterals,
  codeStructureOnly,
  parseExports,
  stripBlockAndOwnLineComments,
  stripCommentsAndStringsDropFor,
  stripCommentsAndStringsFor,
  stripCommentsOnly,
  stripCommentsOnlyFor,
  stripCssBlockComments,
  stripHtmlComments,
  stripTemplateComments,
  walk,
} from "../helpers/source-scan.ts";
import { sourceViewOf } from "../../engine/scripts/verification/source-view.ts";

import { modulePath } from "../helpers/module-resolver.ts";
/** The file whose glob literal defeated the regex stripper. */
const GLOB_BEARING = modulePath("reset-all.ts");

/**
 * Every first-party file holding a comment-opening sequence INSIDE a string
 * literal — the population that can trigger this class at all.
 *
 * Located with `blankStringLiterals`, which preserves offsets exactly, so a
 * sequence present in the original and absent from the blanked view is by
 * definition inside a string. That is a different instrument from the
 * strippers being judged.
 */
function filesWithCommentSequencesInStrings(): readonly string[] {
  const files = ["src", "server", "shared", "tests"].flatMap((root) =>
    walk(root, { exts: [".ts", ".svelte", ".mjs", ".cjs", ".js"] }),
  );
  const hazardous: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const blanked = blankStringLiterals(source, file);
    if (blanked.length !== source.length) {
      throw new Error(
        `blankStringLiterals changed the length of ${file} (${source.length} → ${blanked.length}). ` +
        `Offset-preservation is what makes it usable as an independent instrument here.`,
      );
    }
    for (let i = 0; i + 1 < source.length; i += 1) {
      const two = source.slice(i, i + 2);
      if (two !== "/*" && two !== "*/" && two !== "//") continue;
      if (blanked.slice(i, i + 2) !== two) {
        hazardous.push(file);
        break;
      }
    }
  }
  return hazardous;
}

describe("the strippers show their work", () => {
  test("the population that can trigger this class is measured and printed", () => {
    const hazardous = filesWithCommentSequencesInStrings();
    // PRINTED, once, deliberately. The number is the reason this file exists:
    // it is not a corner case, and a reader who wants to know whether it still
    // matters can read it off a run instead of re-deriving it.
    console.log(
      `[stripper-view] ${hazardous.length} first-party files hold a comment-opening sequence ` +
      `inside a string literal; e.g. ${hazardous.slice(0, 5).join(", ")}`,
    );
    // A floor, not an exact count: the point is that the population is real
    // and non-trivial. Zero would mean the instrument stopped working.
    expect(hazardous.length).toBeGreaterThan(50);
    expect(hazardous).toContain(GLOB_BEARING);
  });

  test("the glob literal survives the stripper that once deleted the file around it", () => {
    const source = readFileSync(GLOB_BEARING, "utf8");
    const stripped = stripBlockAndOwnLineComments(source, GLOB_BEARING);

    // PRINTED: what the stripper actually handed the scan, around the literal
    // that broke it. A reader can see the view, not just trust a boolean.
    const at = stripped.indexOf("import.meta.glob");
    console.log(
      `[stripper-view] ${GLOB_BEARING} through stripBlockAndOwnLineComments, at the glob:\n` +
      `  ${JSON.stringify(stripped.slice(Math.max(0, at - 40), at + 120))}`,
    );

    // THE ASSERTION IS ABOUT WHAT SURVIVED. The glob call is code, the loader
    // registration below it is code, and the old regex deleted both.
    expect(at).toBeGreaterThanOrEqual(0);
    expect(stripped).toContain('import.meta.glob("./**/*.ts"');
    // And the CODE AROUND IT survived — the old failure deleted the loader's
    // neighbours, not the loader line alone. This file is 93% documentation,
    // so a length ratio would say nothing; the surviving declarations do.
    expect(stripped).toContain("loadedStoreModulePaths");
    expect(stripped).toContain("resetAllStores");
  });

  test("a block comment is still removed, so the fix did not disarm the stripper", () => {
    // The benign direction, on real source: a stripper that returns its input
    // unchanged would pass every "the code survived" assertion above.
    const source = readFileSync(GLOB_BEARING, "utf8");
    const stripped = stripBlockAndOwnLineComments(source, GLOB_BEARING);
    // Judged on PROSE that only ever appears in a comment, not on the `/**`
    // sequence — which the glob literal itself contains, and which a naive
    // assertion here would therefore have failed on for the right reason and
    // the wrong subject.
    expect(source).toContain("SINGLE owner of client-side store reset");
    expect(stripped).not.toContain("SINGLE owner of client-side store reset");
    expect(source).toContain("THE PATTERN IS RECURSIVE");
    expect(stripped).not.toContain("THE PATTERN IS RECURSIVE");
  });

  test("EVERY view keeps the file's lines: a comment or a string across lines above a hit leaves the hit on its own line (a4-design H1)", () => {
    // A 4-line doc comment, a 2-line template and a 2-line block comment, then the hit on line 10 (markup: line 9).
    const code = "/**\n * doc\n * more\n */\nconst t = `a\nb`; /* x\ny */\n\n\nconst HIT = 1;\n";
    const markup = "<!-- a\nb\nc -->\n{#if x}\n<p>\n</p>\n{/if}\n\nHIT\n";
    const lineOf = (text: string): number => text.slice(0, text.indexOf("HIT")).split("\n").length;
    for (const [name, view] of [
      ["stripCommentsAndStringsFor", stripCommentsAndStringsFor(code, "probe.ts")],
      ["stripCommentsAndStringsDropFor", stripCommentsAndStringsDropFor(code, "probe.ts")],
      ["stripCommentsOnlyFor", stripCommentsOnlyFor(code, "probe.ts")],
      ["stripCommentsOnly", stripCommentsOnly(code)],
      ["stripBlockAndOwnLineComments", stripBlockAndOwnLineComments(code, "probe.ts")],
      ["blankStringLiterals", blankStringLiterals(code, "probe.ts")],
      ["codeStructureOnly", codeStructureOnly(code)],
      ["stripCssBlockComments", stripCssBlockComments(code)],
      ["stripHtmlComments (markup)", stripHtmlComments(markup, "probe.svelte")],
      ["stripTemplateComments (markup)", stripTemplateComments(markup)],
      ["stripCommentsOnlyFor (markup)", stripCommentsOnlyFor(markup, "probe.svelte")],
    ] as const) {
      expect(lineOf(view), name).toBe(name.endsWith("(markup)") ? 9 : 10);
    }
    // THE one spelling of "every hit at its true line": the view owner's `matches`, flags kept.
    const view = sourceViewOf(code, "probe.ts");
    expect(view.matches(/hit/i, "code").map((hit) => [hit.line, hit.text])).toEqual([[10, "HIT"]]);
  });

  test("a trailing line comment is KEPT and an own-line one is removed", () => {
    // This variant's distinguishing rule, stated as behaviour rather than as
    // prose in a doc comment. One consumer depends on it: a glyph mentioned in
    // a trailing comment is a violation, and on its own comment line is not.
    const fixture = 'const a = 1; // trailing-marker\n// own-line-marker\nconst b = "// in-a-string";\n';
    // A TS fragment — the mode is named, never guessed from the bytes.
    const stripped = stripBlockAndOwnLineComments(fixture, "probe.ts");
    console.log(`[stripper-view] trailing/own-line rule → ${JSON.stringify(stripped)}`);
    expect(stripped).toContain("trailing-marker");
    expect(stripped).not.toContain("own-line-marker");
    // And the string literal is untouched, which is the whole reason this
    // variant is not simply the comments-only stripper.
    expect(stripped).toContain('"// in-a-string"');
  });

  test("each stripper's view of one real file is printed, and they differ as declared", () => {
    // The three variants exist because callers need different things. Their
    // differences are asserted on the SAME real file so a change to one shows
    // up as a change in the relationship, not only in its own test.
    const source = readFileSync(GLOB_BEARING, "utf8");
    const views = {
      blockAndOwnLine: stripBlockAndOwnLineComments(source, GLOB_BEARING),
      commentsOnly: stripCommentsOnly(source),
      commentsAndStrings: stripCommentsAndStringsFor(source, GLOB_BEARING),
    };
    for (const [name, view] of Object.entries(views)) {
      console.log(`[stripper-view] ${name}: ${view.length} of ${source.length} bytes survive`);
    }

    // Strings survive the first two and not the third — that is the declared
    // difference, and it is the one a caller picks between.
    expect(views.blockAndOwnLine).toContain("import.meta.glob");
    expect(views.commentsOnly).toContain("import.meta.glob");
    expect(views.commentsAndStrings).toContain("import.meta.glob");
    // The thorough variant blanks the SPECIFIER, which is exactly the trap a
    // module-scanning caller has to know about before choosing it.
    expect(views.commentsAndStrings).not.toContain("./**/*.ts");
    expect(views.commentsOnly).toContain("./**/*.ts");
  });

  test("an export-shaped mention in a docstring, comment or string does not parse as an export", () => {
    // The export parser is a stripper consumer INSIDE the shared helper, and
    // it once read its source through the template view — where a .ts file's
    // comments and strings are prose, so every export-shaped mention inside
    // them parsed as a PHANTOM export. The parser takes the path now, like
    // every per-file consumer; this is the probe that caught it, made
    // permanent. The fixture is a TS fragment, so it names its probe path.
    const ghostFixture = [
      "/**",
      " * The canonical shape is export const GHOST_FROM_DOCSTRING.",
      " */",
      "// export function GHOST_FROM_LINE_COMMENT() {}",
      'const mention = "export class GHOST_FROM_STRING";',
    ].join("\n");
    const withReal = ghostFixture + "\nexport const REAL_EXPORT = 1;\n";

    // PRINTED: the same bytes through both named modes, so a reader sees
    // where the ghosts live instead of trusting a boolean. Under the .ts
    // mode they are comment/string interior and are blanked; read as a
    // svelte template they are markup prose and they survive.
    const asCode = stripCommentsAndStringsFor(ghostFixture, "probe.ts");
    const asTemplate = stripCommentsAndStringsFor(ghostFixture, "probe.svelte");
    console.log(
      `[stripper-view] ghost fixture as probe.ts → ${JSON.stringify(asCode)}\n` +
      `[stripper-view] the same bytes as probe.svelte → ${JSON.stringify(asTemplate)}`,
    );

    // The ghosts are real prose in the template view — the mechanism, shown.
    expect(asTemplate).toContain("GHOST_FROM_DOCSTRING");
    expect(asTemplate).toContain("GHOST_FROM_LINE_COMMENT");
    expect(asTemplate).toContain("GHOST_FROM_STRING");

    // THE PARSER'S ANSWER, as a value: nothing in the ghost-only fixture,
    // and exactly the real export in the fixture that has one. A parser
    // that returned nothing for any input would pass the first assertion
    // and is caught by the second; a parser that saw the ghosts fails both.
    expect(parseExports(ghostFixture, "probe.ts")).toEqual([]);
    expect(parseExports(withReal, "probe.ts")).toEqual(["REAL_EXPORT"]);
  });
});
