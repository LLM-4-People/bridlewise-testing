// @vitest-environment node
/**
 * Mechanical enforcement: no hardcoded `Math.max/min(<literal>)` thresholds
 * outside the config/constant owners.
 *
 * "Hardcoded values are PROHIBITED unless it is a
 * configurable, but then it MUST go to our configuration file. No
 * `Math.max(2,...)` or `Math.max(28,...)` with magic numbers in source."
 *
 * The timeline-specific `timeline-no-hardcoded-magic.test.ts` enforced this
 * for the old timeline tree. This test GENERALIZES it to every `.ts`/`.svelte`
 * under `src/` and `server/`: a `Math.max(<literal>)` / `Math.min(<literal>)`
 * whose FIRST argument is an integer literal >= 2 is a design threshold that
 * must be a named constant (imported from the single config/constant owner)
 * never an inline magic number.
 *
 * Precision (rule: "if a detection has too many false positives, exclude it
 * or make it configurable"):
 * Only the FIRST argument is checked. `Math.min(scaleW, scaleH, 2)` (the
 * `2` is a later arg) is NOT flagged — it is a fit-scale cap, not a
 * standalone threshold, and the first arg is a variable.
 * Literals < 2 (`Math.max(0, x)`, `Math.max(1, x)`) are degenerate-value
 * guards (zero/one floors), not design thresholds — NOT flagged.
 * Decimal thresholds < 2 (`Math.max(0.3, x)`) are NOT flagged (only
 * integer literals >= 2 match).
 * A named-constant first arg (`Math.max(MIN_BAR_WIDTH_PCT, x)`) is NOT
 * flagged — that is the REQUIRED pattern (the literal lives in the
 * constant owner).
 * Comments (line `//`, C-style block and template `<!-- -->` comments) are
 * blanked first so a rule quote like "No Math.max(2,...)" in a doc comment is
 * not flagged. Every class reads the SAME per-file view — the source-view
 * owner's `codeWithStringsAndTemplates()`: comments blanked in place (the
 * template-aware lexer for `.svelte`), offsets and newlines preserved — so the
 * line a finding names is the line the file holds. (The comment-DROPPING
 * stripper this replaced deleted the newlines inside block comments, and every
 * finding below one named a line earlier than its own.)
 *
 * The single owners for the named constants this test mandates:
 * `shared/constants.ts` (shared thresholds; the old tree's owners left
 * at the cutover)
 * `server/quality-bridge.ts` (quality scoring weights)
 * `bridlewise.config.json` via `server/harness-config.ts` accessors
 * (graph zoom/canvas clamps, EXP474 retrieval knobs, …)
 */
import { describe, expect, test } from "vitest";
import { relative } from "node:path";
import { walk } from "../helpers/source-scan.ts";
import { readSourceView, sourceViewOf, type SourceView } from "../../engine/scripts/verification/source-view.ts";

const ROOTS = ["src", "server"] as const;

type Finding = Readonly<{ file: string; line: number; text: string }>;

/** Every `pattern` hit in a view's comment-blanked text, at its TRUE line (the view owner's one `matches`). */
function hitsIn(view: SourceView, pattern: RegExp, file: string): Finding[] {
  return view.matches(pattern, "codeWithStringsAndTemplates").map((hit) => ({ file, line: hit.line, text: hit.text }));
}

/** The scanned population, read ONCE through the sanctioned reader. */
const SOURCES: readonly Readonly<{ file: string; view: SourceView }>[] = ROOTS.flatMap((root) =>
  walk(root).map((file) => ({ file: relative(process.cwd(), file), view: readSourceView(file) })));

/** A literal integer threshold >= 2 as the FIRST arg of Math.max/min. */
const MAGIC_RE = /Math\.(max|min)\(\s*([2-9]\d*|\d{2,})(\.\d+)?\b/;

describe("no hardcoded Math.max/min magic thresholds", () => {
  const findings = SOURCES.flatMap(({ file, view }) => hitsIn(view, MAGIC_RE, file));

  test("a finding names the line the file holds, below any block comment (planted)", () => {
    // The witness for the view: a multi-line block comment and a template
    // comment above the hit must not move the line it is reported on.
    const planted = `/**\n * one\n * two\n */\nconst a = 1;\nconst b = Math.min(3, a);\n`;
    expect(hitsIn(sourceViewOf(planted, "planted.ts"), MAGIC_RE, "planted.ts")).toEqual([{ file: "planted.ts", line: 6, text: "Math.min(3" }]);
    const svelte = `<script>\n  /* a\n     b */\n  const w = 1;\n</script>\n<!-- c\n     d -->\n<p>{Math.max(4, w)}</p>\n`;
    expect(hitsIn(sourceViewOf(svelte, "planted.svelte"), MAGIC_RE, "planted.svelte")).toEqual([{ file: "planted.svelte", line: 8, text: "Math.max(4" }]);
    expect(hitsIn(sourceViewOf("// Math.min(3, x)\n", "planted.ts"), MAGIC_RE, "planted.ts"), "a comment is not code").toEqual([]);
  });

  test("no Math.max/min with an inline integer-literal threshold >= 2 in src/ or server/", () => {
    if (findings.length > 0) {
      const detail = findings.map((f) => `  ${f.file}:${f.line}  ${f.text}`).join("\n");
      throw new Error(
        `Forbidden Math.max/Math.min inline magic-number thresholds — move the ` +
          `value into a named constant (ui-thresholds / *-view-config / harness-config / config file):\n${detail}`,
      );
    }
  });

  // Second class: `setTimeout(callback, <integer-literal>)` debounce/delay
  // values. A literal delay is a scattered configurable (the no-hardcoded-
  // configurables invariant); it must be a named constant imported from the
  // single config owner (client-config / harness-config / ui-thresholds).
  // `setTimeout(fn, 0)` is a scheduling pattern (defer to next tick — a
  // semantic invariant, NOT a configurable delay), so literals < 1 are NOT
  // flagged. Comments are stripped first so a doc reference is not flagged.
  //
  // Multi-line + nested parens: the callback may span lines and contain
  // nested function calls (e.g. `setTimeout(() => { persistSet(..., String(
  // Math.round(...))); }, 200)`). A regex cannot match balanced parens at
  // arbitrary depth, so a small char-scanner finds each `setTimeout(` call's
  // matching close paren, then checks whether the LAST top-level argument is
  // an integer literal >= 1.
  const setTimeoutFindings: Finding[] = [];

  /** Find the matching close paren for `(` at index `start` in `src`. */
  function matchCloseParen(src: string, start: number): number {
    let depth = 0;
    for (let i = start; i < src.length; i++) {
      const ch = src.charCodeAt(i);
      if (ch === 40) depth++;        // (
      else if (ch === 41) {           // )
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  /** Extract the last top-level argument (text after the last top-level
   * comma) from the args substring (inside the outer parens). */
  function lastTopLevelArg(args: string): string {
    let depth = 0;
    let lastComma = -1;
    for (let i = 0; i < args.length; i++) {
      const ch = args.charCodeAt(i);
      if (ch === 40 || ch === 91 || ch === 123) depth++;   // ( [ {
      else if (ch === 41 || ch === 93 || ch === 125) depth--; // ) ] }
      else if (ch === 44 && depth === 0) lastComma = i;      // ,
    }
    return lastComma === -1 ? args : args.slice(lastComma + 1);
  }

  const SET_TIMEOUT_RE = /\bsetTimeout\(/g;
  const LITERAL_DELAY_RE = /^\s*([1-9]\d*|\d{2,})(\.\d+)?\s*$/;

  for (const { file, view } of SOURCES) {
    const stripped = view.codeWithStringsAndTemplates();
    for (const sm of stripped.matchAll(SET_TIMEOUT_RE)) {
      const openParen = sm.index + sm[0].length - 1;
      const closeParen = matchCloseParen(stripped, openParen);
      if (closeParen === -1) continue;
      const args = stripped.slice(openParen + 1, closeParen);
      const lastArg = lastTopLevelArg(args).trim();
      if (LITERAL_DELAY_RE.test(lastArg)) {
        setTimeoutFindings.push({ file, line: view.lineAt(sm.index), text: `setTimeout(..., ${lastArg})` });
      }
    }
  }

  test("no setTimeout with an inline integer-literal delay >= 1 in src/ or server/ (use a named constant)", () => {
    if (setTimeoutFindings.length > 0) {
      const detail = setTimeoutFindings.map((f) => `  ${f.file}:${f.line}  ${f.text}`).join("\n");
      throw new Error(
        `Forbidden setTimeout inline literal delays — move the value into a ` +
          `named constant (client-config / harness-config / ui-thresholds):\n${detail}`,
      );
    }
  });

  // Third class (B3 fix): bare `return <integer literal>` config fallbacks.
  // A bare `return 1500` / `return 120_000` in an accessor is a hardcoded
  // config value masquerading as a fallback — invisible to the
  // Math.max/min + setTimeout scanners above. The config owners hold their
  // defaults in `DEFAULT_*` object literals (never a bare `return <literal>`),
  // so NO file exclusion is needed: a bare `return <integer>` outside the
  // config owners IS the violation. Deny-by-default: any new
  // `return <integer literal>` that is a config/limit/timeout value (>= 2)
  // — excluding HTTP status codes (100-599, semantic router values) and
  // degenerate guards (0/1) — is flagged. A config fallback must be a named
  // constant from the single config owner.
  const returnFallbackFindings: Finding[] = [];
  // A bare `return <integer literal>` (>= 2) NOT in the HTTP-status range.
  // HTTP statuses (100-599) are semantic router values (statusForError),
  // not config fallbacks — exempt. 0/1 are degenerate guards — exempt.
  const RETURN_LITERAL_RE = /\breturn\s+([2-9]\d*|\d{2,})(?:\s*_[\d_]+)?\b/;
  for (const { file, view } of SOURCES) {
    for (const hit of hitsIn(view, RETURN_LITERAL_RE, file)) {
      // Parse the integer value (handle underscores in numeric separators).
      const value = parseInt(RETURN_LITERAL_RE.exec(hit.text)![1]!.replace(/_/g, ""), 10);
      // Exempt HTTP status codes (100-599) — semantic router return values.
      if (value >= 100 && value <= 599) continue;
      returnFallbackFindings.push(hit);
    }
  }

  test("no bare `return <integer literal>` config fallbacks (>= 2, not HTTP status) in src/ or server/", () => {
    if (returnFallbackFindings.length > 0) {
      const detail = returnFallbackFindings.map((f) => `  ${f.file}:${f.line}  ${f.text}`).join("\n");
      throw new Error(
        `Forbidden bare \`return <integer literal>\` config fallbacks — move the ` +
          `value into a named constant from the single config owner (DEFAULT_* object literal, not a bare return):\n${detail}`,
      );
    }
  });

  // Fourth class (B15 fix): decimal design thresholds in the (1.0, 2.0) gap.
  // The MAGIC_RE above catches integer-literal thresholds >= 2 (with optional
  // decimal, e.g. 2.5). It intentionally EXCLUDES decimals < 2 — degenerate-
  // value guards like `Math.max(0.3, x)` (a zoom floor) or `Math.max(1.0, x)`
  // (a floor of 1) are NOT design thresholds. The gap is decimals in the
  // (1.0, 2.0) range (e.g. `Math.max(1.5, x)`) — a decimal ABOVE the
  // degenerate-guard floor of 1.0 is a design threshold that must be a
  // named constant, not an inline literal. Deny-by-default: any new inline
  // decimal threshold in (1.0, 2.0) is flagged (decimals >= 2.0 are caught
  // by MAGIC_RE; decimals <= 1.0 are degenerate guards).

  // A decimal literal with integer part 1 (1.0 < value < 2.0) as the FIRST
  // arg of Math.max/min. `1.0` itself is a floor of 1 (degenerate) — NOT
  // flagged (require a fractional part > 0).
  const DECIMAL_GAP_RE = /Math\.(max|min)\(\s*1\.([1-9]\d*)\b/;
  const decimalThresholdFindings = SOURCES.flatMap(({ file, view }) => hitsIn(view, DECIMAL_GAP_RE, file));

  test("no inline decimal design threshold in the (1.0, 2.0) gap (use a named constant)", () => {
    if (decimalThresholdFindings.length > 0) {
      const detail = decimalThresholdFindings.map((f) => `  ${f.file}:${f.line}  ${f.text}`).join("\n");
      throw new Error(
        `Forbidden inline decimal design thresholds in the (1.0, 2.0) gap — move the ` +
          `value into a named constant (ui-thresholds / *-view-config / harness-config):\n${detail}`,
      );
    }
  });
});
