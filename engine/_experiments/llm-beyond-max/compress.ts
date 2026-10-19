/**
 * EXP410 — compressed output that we uncompress.
 *
 * The user asked: "can we also have dedup on the output, or actually get
 * a compressed output that we uncompress?"
 *
 * Two strategies are implemented here:
 *
 * 1. MINIFY (lossless): apply a deterministic minifier to the LLM output.
 *    Removes comments, JSDoc, and collapses whitespace. The output is
 *    smaller; prettify restores a readable form. This simulates "the LLM
 *    emits a compressed form; the harness uncompresses it".
 *
 * 2. PRETTIFY (the uncompress step): expand a minified form back to a
 *    readable form by adding newlines after `;`, `{`, `}` and indenting.
 *    Not a full TypeScript formatter (no token-aware rules) — it's a
 *    simple structural pretty-printer that's good enough for measurement.
 *
 * 3. MINIFY-PROMPT: a system prompt that asks the LLM to emit ALREADY-
 *    minified output (no JSDoc, no comments, minimal whitespace). When
 *    the LLM cooperates, this saves tokens at the API layer (fewer output
 *    tokens = faster generation + lower cost). The harness then
 *    prettifies.
 *
 * Reports: original chars, minified chars, prettified chars, and the
 * compression ratio (minified / original). When the LLM cooperates with
 * the minify prompt, the API-level savings is the metric of interest.
 *
 * Limitations: the minifier is a regex-based pass — it does NOT parse
 * TypeScript. Strings and template literals containing `//` or `/*` may
 * be incorrectly stripped. This is acceptable for EXP410 measurement;
 * a token-aware minifier would be the production form.
 */

export type CompressionMode = "none" | "minify";

export type CompressionReport = Readonly<{
  mode: CompressionMode;
  originalChars: number;
  minifiedChars: number;
  prettifiedChars: number;
  /** minified / original. Lower = more compression. */
  compressionRatio: number;
  /** (1 - minified/original) * 100. Higher = more savings. */
  charSavingsPct: number;
  /** Pretttified / minified. Higher = more expansion. */
  expansionRatio: number;
}>;

export type CompressionOptions = Readonly<{
  mode: CompressionMode;
  /** Strip `// line comments`. */
  stripLineComments: boolean;
  /** Strip C-style block comments (including JSDoc). */
  stripBlockComments: boolean;
  /** Collapse runs of whitespace to a single space. */
  collapseWhitespace: boolean;
  /** Remove blank lines. */
  removeBlankLines: boolean;
}>;

export const DEFAULT_COMPRESSION: CompressionOptions = Object.freeze({
  mode: "minify",
  stripLineComments: true,
  stripBlockComments: true,
  collapseWhitespace: true,
  removeBlankLines: true,
});

/**
 * System prompt that asks the LLM to emit minified TypeScript. The LLM
 * is told: no JSDoc, no comments, minimal whitespace, no markdown
 * fences. When the LLM cooperates, the output is already compressed.
 */
export const MINIFY_SYSTEM_PROMPT =
  "You are a TypeScript code generator. Emit ONLY minified TypeScript: no JSDoc, no comments, no markdown fences, no explanation. Use minimal whitespace (single space where needed, no indentation). Put one statement per line where needed for readability but do not add extra blank lines. Do not stop early.";

/**
 * Minify a string. Lossy if the input contains `//` or `/*` inside string
 * literals (the regex will strip them). For EXP410 measurement only.
 */
export function minify(text: string, opts: CompressionOptions): string {
  if (opts.mode === "none") return text;
  let out = text;
  if (opts.stripBlockComments) {
    out = out.replace(/\/\*[\s\S]*?\*\//gu, "");
  }
  if (opts.stripLineComments) {
    out = out.replace(/(^|[^:])\/\/[^\n]*/gu, "$1");
  }
  if (opts.removeBlankLines) {
    out = out.replace(/\n\s*\n+/gu, "\n");
  }
  if (opts.collapseWhitespace) {
    out = out.replace(/[ \t]+/gu, " ");
    out = out.replace(/[ \t]+\n/gu, "\n");
    out = out.replace(/\n[ \t]+/gu, "\n");
  }
  return out.trim();
}

/**
 * Prettify a minified string: add newlines after `;`, `{`, `}` and indent
 * based on brace nesting. Not a full formatter — a simple structural
 * pretty-printer for measurement.
 */
export function prettify(text: string): string {
  let out = text;
  // Add newlines after `;` (but not inside for-loops — heuristic: if the
  // next non-space char is `)` it's a for-loop, skip).
  out = out.replace(/;(?!\s*\))/gu, ";\n");
  // Add newlines after `{` and before `}`.
  out = out.replace(/\{(?!\s*\n)/gu, "{\n");
  out = out.replace(/(?<!\n)\}/gu, "\n}");
  // Indent based on brace nesting.
  const lines = out.split("\n");
  let depth = 0;
  const out2: string[] = [];
  for (let line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    // Count closing braces at the START of the line (dedent before printing).
    const closeMatches = trimmed.match(/^\}+/);
    if (closeMatches) depth = Math.max(0, depth - closeMatches[0].length);
    out2.push("  ".repeat(depth) + trimmed);
    // Count opening braces (anywhere) minus closing braces (anywhere) for next depth.
    const opens = (trimmed.match(/\{/g) ?? []).length;
    const closes = (trimmed.match(/\}/g) ?? []).length;
    depth = Math.max(0, depth + opens - closes);
  }
  return out2.join("\n");
}

/**
 * Compress + report: minify the input, then prettify the minified form,
 * and report the compression + expansion ratios.
 */
export function compressAndReport(text: string, opts: CompressionOptions): Readonly<{ minified: string; prettified: string; report: CompressionReport }> {
  if (opts.mode === "none") {
    return {
      minified: text,
      prettified: text,
      report: makeReport("none", text.length, text.length, text.length),
    };
  }
  const minified = minify(text, opts);
  const prettified = prettify(minified);
  return {
    minified,
    prettified,
    report: makeReport(opts.mode, text.length, minified.length, prettified.length),
  };
}

function makeReport(mode: CompressionMode, originalChars: number, minifiedChars: number, prettifiedChars: number): CompressionReport {
  return Object.freeze({
    mode,
    originalChars,
    minifiedChars,
    prettifiedChars,
    compressionRatio: originalChars > 0 ? round(minifiedChars / originalChars, 3) : 1,
    charSavingsPct: originalChars > 0 ? round((1 - minifiedChars / originalChars) * 100, 2) : 0,
    expansionRatio: minifiedChars > 0 ? round(prettifiedChars / minifiedChars, 3) : 1,
  });
}

function round(x: number, d: number): number {
  const m = 10 ** d;
  return Math.round(x * m) / m;
}
