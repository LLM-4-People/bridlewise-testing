import { readFileSync } from "node:fs";
import { lexSpans, sourceViewOf } from "../../scripts/verification/source-view.ts";

/**
 * Shared source-scan helpers for the backend test suite (test-only). The
 * production source-scan module (`src/shared/source-scan.ts`) owns
 * experiment-path filtering; this module owns the export-name parsing the
 * prevention tests need to derive contract lists dynamically from their
 * owner source (instead of hand-maintaining a mirror that can silently rot
 * when the owner adds a new export).
 *
 * The single owner of "parse the exported public names from TypeScript
 * source" lives here so every prevention test that derives an export list
 * reuses one implementation (a fix to the parser fixes every consumer).
 */

/**
 * Strip JS/TS line + block comments and string-literal interiors so a scan
 * matches actual code instead of a name mentioned only in a docstring or
 * string. The contents are replaced with spaces so token offsets stay sane
 * for the regex matchers. Pure TS (no Svelte HTML comments) — the backend
 * sources scanned here are all `.ts`.
 */
function stripCommentsAndStrings(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    const c2 = src[i + 1];
    if (c === "/" && c2 === "/") {
      while (i < n && src[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && c2 === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += " ";
      i += 1;
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\") i += 2;
        else i += 1;
      }
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * Parse the exported PUBLIC names from TypeScript source — the names a
 * consumer could import from the module. Returns a de-duplicated, stable
 * (sorted) list. Handles:
 * - `export const/let/var NAME`, `export function NAME`,
 *   `export async function NAME`, `export class NAME`,
 *   `export type NAME`, `export interface NAME`
 * - `export { X }`, `export { X as Y }` (Y is the exported alias),
 *   `export { type X }` (type-only re-export specifier)
 * Comments + string-literal interiors are stripped first so an export name
 * mentioned only in a docstring or string does not produce a false positive.
 *
 * Limitations (acceptable for the contract tests here): `export const { a, b }
 * = obj` destructure exports and `export default <expr>` are not captured —
 * none of the scanned owner modules use those forms, and the contract tests
 * care about named exports.
 */
export function parseExports(src: string): string[] {
  const stripped = stripCommentsAndStrings(src);
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
      if (asMatch) {
        names.add(asMatch[1]!.trim());
      } else {
        names.add(spec);
      }
    }
  }
  return [...names].sort();
}

/**
 * Read a source file (UTF-8) and return its exported public names. The single
 * file-read + parse path so callers never hardcode the encoding or the parser.
 */
export function parseExportsFromFile(absPath: string): string[] {
  return parseExports(readFileSync(absPath, "utf8"));
}

/**
 * Parse only the `export const NAME` declarations from TypeScript source
 * (the consolidated value constants). Use this when a contract test pins
 * the const list of an owner module but should not pin the module's
 * functions or types (which are not "consolidated constants"). Returns a
 * de-duplicated, sorted list. Comments + strings are stripped first.
 */
export function parseConstExports(src: string): string[] {
  const stripped = stripCommentsAndStrings(src);
  const names = new Set<string>();
  for (const m of stripped.matchAll(/\bexport\s+const\s+(\w+)/g)) {
    names.add(m[1]!);
  }
  return [...names].sort();
}

/**
 * Read a source file (UTF-8) and return its `export const` names. The single
 * file-read + parse path so callers never hardcode the encoding or the parser.
 */
export function parseConstExportsFromFile(absPath: string): string[] {
  return parseConstExports(readFileSync(absPath, "utf8"));
}

/**
 * Strip JS/TS line + block comments but KEEP string-literal contents (so a
 * parser that needs the string value — e.g. the module path in an import's
 * `from` clause — can still read it). Used by `parseImportSpecifiers` where
 * the `from "..."` path must survive the strip.
 */
function stripCommentsOnly(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    const c2 = src[i + 1];
    if (c === "/" && c2 === "/") {
      while (i < n && src[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && c2 === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    // Skip over string contents without emitting them, but preserve the
    // quote chars + contents verbatim so the `from` path survives.
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i += 1;
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\") {
          out += src[i]!;
          out += src[i + 1] ?? "";
          i += 2;
          continue;
        }
        out += src[i]!;
        i += 1;
      }
      out += quote;
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * Parse the local binding names imported from a given module path. For
 * `import { A, B as C, type D } from "./git/git-port.ts"` it returns
 * `["A", "C", "D"]` (the local names a consumer uses; an `X as Y` clause
 * yields Y, the local binding). Multi-line import blocks are handled.
 * Returns only specifiers whose `from` clause matches `modulePathSubstring`
 * (a plain substring match, so a caller can pass the canonical owner path
 * without worrying about exact quote style). Comments are stripped (so a
 * docstring mentioning a module path does not match) but string contents
 * are preserved (so the `from` path is readable).
 *
 * Use this to derive the "shared between two modules" set dynamically: the
 * names a consumer actually imports from an owner ARE the shared contract —
 * a newly imported name is auto-covered, a dropped name stops being checked.
 */
export function parseImportSpecifiers(src: string, modulePathSubstring: string): string[] {
  const stripped = stripCommentsOnly(src);
  const names = new Set<string>();
  // `import { ... } from "...modulePathSubstring..."` — the `{ ... }` block
  // and the from clause may span multiple lines; match the whole statement.
  const importRe = /\bimport\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
  for (const m of stripped.matchAll(importRe)) {
    const body = m[1]!;
    const fromPath = m[2]!;
    if (!fromPath.includes(modulePathSubstring)) continue;
    for (let spec of body.split(",")) {
      spec = spec.trim();
      if (!spec) continue;
      // Drop the `type` modifier in `import { type X }`.
      spec = spec.replace(/^type\s+/, "");
      // `X as Y` → the local binding is Y.
      const asMatch = spec.match(/\bas\s+(.+)$/);
      names.add(asMatch ? asMatch[1]!.trim() : spec);
    }
  }
  return [...names].sort();
}

// ---------------------------------------------------------------------------
// Does a file reach a module's RUNTIME VALUES — in any of the five spellings?
//
// `parseImportSpecifiers` above reads exactly one form, `import { … } from "M"`.
// An owner-bypass scan built on it therefore asks "did anyone reach past the
// owner, spelled the one way I know", and a bypass only has to pick another
// spelling. The identical hole was found by mutation in the sibling web suite:
// a consumer reaching a canonical subsystem through `await import(…)` passed
// the scan with every other assertion green.
//
// Five forms reach a module's values and all five count here:
//   `import … from "M"`   `import "M"`   `export … from "M"` (incl. `export *`)
//   `import("M")`         `require("M")`
// A namespace import (`import * as m from "M"`) is the first form and is
// covered by it. Type-only forms are excluded: they are erased before
// anything runs, so they create no second path.
//
// This is a source scan, the weakest rung: only as good as the file set it is
// given and the syntax it knows. Callers must therefore walk their file set
// DYNAMICALLY, never from a written-down list.
// ---------------------------------------------------------------------------

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
 * Every import/export/require clause in `source` whose module specifier
 * contains `moduleFragment`. The fragment is matched as a SUBSTRING of the
 * specifier, so callers may pass a whole module path
 * (`intelligence/symbol-search.ts`) or a subsystem prefix
 * (`integration/src/intelligence/`) — both are how the owner scans ask the
 * question, and an implementation that only understood one of them silently
 * matched nothing for the other.
 */
function* moduleClauses(
  source: string,
  moduleFragment: string,
): Generator<Clause> {
  // The candidate specifiers are the QUOTED-STRING spans, and only those —
  // classified by the shared lexer (`lexSpans`), never a regex over a
  // comment-stripped view. That view registered a template literal spelling
  // an import as a consumer, accepted a `* import …` jsdoc-residual line as a
  // clause, and let an UNCLOSED block comment silently swallow every real
  // import below it. A specifier is a quoted string in code position; a
  // template interior and a comment are never one. An unclosed comment is a
  // loud refusal, not a truncated read.
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
        `end-of-file, so every import below it would vanish silently. Close the comment.`,
    );
  }
  // Offset-preserving comment-stripped view (strings kept) so a span's index
  // into the original source is an index into this view.
  const code = sourceViewOf(source, "<module-scan>").codeWithStrings();
  for (const span of spans) {
    if (span.kind !== "string") continue;
    const text = source.slice(span.start, span.end);
    const quote = text[0]!;
    const specifier = text.slice(1, text.length > 1 && text.endsWith(quote) ? -1 : undefined);
    if (!specifier.includes(moduleFragment)) continue;
    const clause = importClauseBefore(code, span.start);
    if (clause !== null) yield clause;
  }
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
}

function importClauseBefore(code: string, at: number): Clause | null {
  // The whole prefix, not a window: see the header comment. The nearest keyword
  // before the specifier is what we want, and the statement-boundary checks
  // below — not a character budget — decide whether it owns this specifier.
  const before = code.slice(0, at);
  let bestIndex = -1;
  let bestKeyword = "";
  for (const keyword of ["import", "export", "require"]) {
    const re = new RegExp(`(?:^|[^\\w$.])${keyword}\\b`, "g");
    for (const m of before.matchAll(re)) {
      if (m.index !== undefined && m.index >= bestIndex) {
        bestIndex = m.index;
        bestKeyword = keyword;
      }
    }
  }
  if (bestIndex === -1) return null;
  // A star-line (` * import …`, a jsdoc continuation that survived as code)
  // is not a clause: no real import statement begins with a bare `*` before
  // its keyword. Reject a clause whose keyword is immediately preceded
  // (ignoring whitespace) by `*`.
  const keywordStart = before.indexOf(bestKeyword, bestIndex);
  if (/\*\s*$/.test(before.slice(0, keywordStart))) return null;
  const text = before.slice(keywordStart + bestKeyword.length);
  if (/[;"'`]/.test(text)) return null;
  const keyword = bestKeyword as Clause["keyword"];
  if (keyword === "require") return { keyword, kind: "require", text };
  if (keyword === "import" && /^\s*\(/.test(text)) return { keyword, kind: "dynamic", text };
  return { keyword, kind: "static", text };
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
