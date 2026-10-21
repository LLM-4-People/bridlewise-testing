// @vitest-environment node
/**
 * Mechanical enforcement: no duplicate function bodies.
 *
 * "Duplicate logic prohibited — no duplicate or similar
 * logics." This test extracts the body of every function/method/arrow
 * function under src/ and server/ (excluding tests), normalizes whitespace,
 * and flags exact duplicates whose normalized body is long enough to be a
 * real copy-paste (not a trivial getter). Two functions with identical
 * bodies of significant length must be unified into one shared helper.
 *
 * Detection is conservative: only EXACT (whitespace-normalized) duplicates
 * of at least MIN_BODY_LEN characters are flagged, so near-duplicates
 * (different logic) are not false positives.
 */
import { describe, test } from "vitest";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { SOURCE_EXTS, walk } from "../helpers/source-scan.ts";

const ROOTS = ["src", "server", "scripts"] as const;
const MIN_BODY_LEN = 150;

function matchBrace(src: string, openIdx: number): number {
  let depth = 1;
  let i = openIdx + 1;
  while (i < src.length && depth > 0) {
    const ch = src[i]!;
    if (ch === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl + 1;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      i = close === -1 ? src.length : close + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { i = skipString(src, i, ch); continue; }
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    i += 1;
  }
  return depth === 0 ? i - 1 : -1;
}

function skipString(src: string, i: number, quote: string): number {
  let j = i + 1;
  while (j < src.length) {
    const c = src[j]!;
    if (c === "\\") { j += 2; continue; }
    if (quote === "`" && c === "$" && src[j + 1] === "{") {
      const close = matchBrace(src, j + 1);
      j = close === -1 ? src.length : close + 1;
      continue;
    }
    if (c === quote) return j + 1;
    j += 1;
  }
  return src.length;
}

/** Normalize a body: strip comments, collapse all whitespace runs to one space. */
function normalize(body: string): string {
  let out = "";
  let i = 0;
  while (i < body.length) {
    const ch = body[i]!;
    if (ch === "/" && body[i + 1] === "/") {
      const nl = body.indexOf("\n", i);
      i = nl === -1 ? body.length : nl + 1;
      continue;
    }
    if (ch === "/" && body[i + 1] === "*") {
      const close = body.indexOf("*/", i + 2);
      i = close === -1 ? body.length : close + 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * Strip comments from source code (line comments + block comments) while
 * preserving strings. Used before regex extraction so words inside comments
 * don't create false method-regex matches.
 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    // Skip strings (don't strip comment-like sequences inside strings).
    if (ch === '"' || ch === "'" || ch === "`") {
      const end = skipString(src, i, ch);
      out += src.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl + 1;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      i = close === -1 ? src.length : close + 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Find named function/method bodies only (skip arrow callbacks — repeating
 * short arrow idioms like `.catch(err => log(err))` are not "duplicate logic").
 * Matches `function name(...) {` and `name(...) {` (method) declarations.
 */
function extractBodies(src: string): string[] {
  const bodies: string[] = [];
  // Strip comments BEFORE extraction so the method regex doesn't match
  // words inside comments (e.g. `// Lazy-loading (exp519):...` matched
  // `loading` as a method name and greedily consumed to the next `{`,
  // extracting a neighbor function's body as a false duplicate).
  const stripped = stripComments(src);
  // `function name(...) {` (named function declarations)
  const fnRe = /function\s+[A-Za-z_$][\w$]*\s*\([^)]*\)\s*(?::\s*[^{]*)?\{/g;
  let m: RegExpExecArray | null;
  while ((m = fnRe.exec(stripped)) !== null) {
    const braceIdx = m.index + m[0].length - 1;
    const close = matchBrace(stripped, braceIdx);
    if (close === -1) continue;
    bodies.push(stripped.slice(braceIdx + 1, close));
  }
  // `name(...) {` (class/object methods) — must be preceded by a non-word
  // boundary so we don't match call expressions like `foo() {` inside strings.
  const methodRe = /\b([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*(?::\s*[^{;}\n=]*)?\{/g;
  while ((m = methodRe.exec(stripped)) !== null) {
    // Skip if this is actually a `function name(` (already covered), a
    // control-flow keyword (if/for/while/switch/catch), or a method CALL
    // (`.filter(`, `.map(`, `.sort(`, …) — the preceding `.` means it is a
    // call expression, not a declaration, and `[^{]*` would otherwise
    // greedily consume to the next function's `{` and mis-extract its body.
    const head = stripped.slice(Math.max(0, m.index - 9), m.index);
    if (/function\s$/.test(head)) continue;
    // Skip control-flow keywords: check the MATCHED name (m[1]), not just
    // the text before it. `for (const n of nodes) {` has `for` as m[1],
    // so checking m[1] catches it; checking only `head` misses it because
    // the head is the text BEFORE `for`, not `for` itself.
    if (/\b(if|for|while|switch|catch|with|each)\b/.test(m[1]!)) continue;
    if (stripped[m.index - 1] === ".") continue;
    const braceIdx = m.index + m[0].length - 1;
    const close = matchBrace(stripped, braceIdx);
    if (close === -1) continue;
    bodies.push(stripped.slice(braceIdx + 1, close));
  }
  return bodies;
}

describe("no duplicate function bodies", () => {
  // Map normalized body -> list of {file, preview}
  const byBody = new Map<string, { file: string; preview: string }[]>();

  for (const root of ROOTS) {
    for (const file of walk(root, { exts: SOURCE_EXTS })) {
      const rel = relative(process.cwd(), file);
      for (const body of extractBodies(readFileSync(file, "utf-8"))) {
        const norm = normalize(body);
        if (norm.length < MIN_BODY_LEN) continue;
        const entry = { file: rel, preview: norm.slice(0, 80) };
        const list = byBody.get(norm) ?? [];
        list.push(entry);
        byBody.set(norm, list);
      }
    }
  }

  const dupes = [...byBody.entries()].filter(([, locs]) => locs.length > 1);

  test("no two functions share an identical (whitespace-normalized) body >= 150 chars", () => {
    if (dupes.length > 0) {
      const detail = dupes
        .map(([, locs]) => locs.map((l) => `${l.file}`).join(" == "))
        .join("\n");
      const previews = dupes.map(([, locs]) => `  [${locs[0]!.file}] ${locs[0]!.preview}…`).join("\n");
      throw new Error(
        `Duplicate function bodies found — extract a shared helper:\n${detail}\n\nPreview:\n${previews}`,
      );
    }
  });
});
