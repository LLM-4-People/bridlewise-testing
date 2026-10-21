// @vitest-environment node
/**
 * Mechanical enforcement: no unused imports.
 *
 * Detects named imports (`import { X } from "..."`) and default imports
 * (`import X from "..."`) that are never referenced in the importing file.
 * An import is "unused" if the imported binding name does not appear as a
 * word boundary anywhere else in the file after the import statement.
 *
 * Type-only imports (`import type { X }`) are checked too: if X is only used
 * in type positions it still counts as "used" (it appears as a word). The
 * scanner uses word-boundary matching so a `Foo` import is not masked by a
 * `FoodProcessor` identifier.
 *
 * Known-safe exclusions:
 * Side-effect imports (`import "..."`) — no bindings, intentionally for
 * side effects.
 * Re-export files (`export... from "..."`) — the binding is re-exported,
 * not consumed locally.
 * `.svelte` files: Svelte components use bindings in template markup
 * (`<Foo />`) which IS word-boundary matched, so they are scanned.
 *
 * This is conservative: it does NOT flag namespace imports (`import * as N`)
 * because `N` is used via `N.member` (word-boundary match catches `N` in that
 * form).
 */
import { describe, test } from "vitest";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { walk, blankStringLiterals, SOURCE_EXTS } from "../helpers/source-scan.ts";

const ROOTS = ["src", "server", "tests", "shared", "scripts"] as const;

type ImportBinding = { name: string; file: string; line: number };

/**
 * Extract named + default import bindings from a source file.
 *
 * Statements are matched across NEWLINES, because an import list is often
 * written one binding per line:
 *
 *     import {
 *       join,
 *       resolve,
 *     } from "node:path";
 *
 * The scanner used to read one line at a time (`/import\s+\{([^}]*)\}/` on a
 * single line), so a multi-line import was invisible: a binding nobody used
 * could sit there forever, and the guard reported a clean file. Strings are
 * blanked first so fixtures mentioning `import …` are not read as imports;
 * comment lines are excluded by anchoring every pattern at line start, where
 * only a real statement (or a commented-out one, which starts with `//` or
 * `*`) can be.
 */
function extractImports(rawSrc: string, file: string): ImportBinding[] {
  const out: ImportBinding[] = [];
  const source = blankStringLiterals(rawSrc, file);
  const lineAt = (index: number): number => source.slice(0, index).split("\n").length;
  const add = (name: string, index: number): void => {
    const trimmed = name.trim();
    if (trimmed.length > 0) out.push({ name: trimmed, file, line: lineAt(index) });
  };
  const addNamed = (block: string, index: number): void => {
    for (const part of block.replace(/\/\/[^\n]*/gu, "").split(",")) {
      const t = part.trim();
      if (t.length === 0) continue;
      if (/^import\s*$/u.test(t)) continue;
      const cleaned = t.replace(/^type\s+/u, "");
      const asMatch = /\bas\s+([A-Za-z_$][\w$]*)/u.exec(cleaned);
      add((asMatch ? asMatch[1]! : cleaned).replace(/:.+$/u, ""), index);
    }
  };

  // Side-effect imports (`import "..."`) carry no binding and no pattern
  // below matches them; re-exports start with `export` and are not imports.
  // Named: import { A, B as C, type D } from "..." (any line breaks allowed).
  for (const match of source.matchAll(/^import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["'][^"']+["']/gmu)) {
    addNamed(match[1] ?? "", match.index ?? 0);
  }
  // Default: import X from "..." and import X, { Y } from "...".
  for (const match of source.matchAll(/^import\s+(?:type\s+)?([A-Za-z_$][\w$]*)\s*(?:,\s*\{([^}]*)\}\s*)?from\s*["'][^"']+["']/gmu)) {
    add(match[1] ?? "", match.index ?? 0);
    addNamed(match[2] ?? "", match.index ?? 0);
  }
  // Namespace: import * as N from "..." — N is used via N.member.
  for (const match of source.matchAll(/^import\s+(?:type\s+)?\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*["'][^"']+["']/gmu)) {
    add(match[1] ?? "", match.index ?? 0);
  }
  return out;
}

/** Check if `name` appears as a word boundary anywhere after the import line.
 * Deliberately scans the RAW source: a binding referenced only from inside a
 * template literal is still referenced, and blanking strings here would
 * report it as dead. */
function isUsed(src: string, name: string): boolean {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\b${esc}\\b`);
  // Count occurrences in the whole file. The import itself accounts for at
  // least 1; if there is exactly 1, the binding is never used after import.
  const matches = src.match(new RegExp(`\\b${esc}\\b`, "g"));
  return matches !== null && matches.length > 1;
}

describe("no unused imports", () => {
  const unused: { name: string; file: string; line: number }[] = [];
  for (const root of ROOTS) {
    // THE EXTENSIONS ARE NAMED, NOT DEFAULTED. `scripts/` is in ROOTS above and
    // holds five tracked `.mjs` files that the default `[".ts", ".svelte"]`
    // silently excluded — an unused import in any of them was unreachable by
    // this guard for its whole life. The shared walker now refuses a defaulted
    // extension set over a root the index disagrees with, and this is the
    // decision that refusal asks for.
    for (const file of walk(root, { exts: SOURCE_EXTS })) {
      const rel = relative(process.cwd(), file);
      const src = readFileSync(file, "utf8");
      for (const imp of extractImports(src, rel)) {
        if (!isUsed(src, imp.name)) {
          unused.push(imp);
        }
      }
    }
  }

  test("a multi-line import list is parsed binding by binding", () => {
    // The shape that was invisible: one binding per line. A guard reading a
    // single line at a time never saw either name, so a dead import here was
    // never reported and a used one could not vouch for its neighbours.
    const src = [
      "import {",
      "  usedByTheBody,",
      "  deadOnArrival,",
      '} from "./module.ts";',
      "",
      "export const value = usedByTheBody();",
      "",
    ].join("\n");
    const bindings = extractImports(src, "fixture.ts");
    expect(bindings.map((binding) => binding.name)).toEqual(["usedByTheBody", "deadOnArrival"]);
    expect(bindings.map((binding) => binding.line)).toEqual([1, 1]);
    expect(isUsed(src, "usedByTheBody")).toBe(true);
    expect(isUsed(src, "deadOnArrival")).toBe(false);
  });

  test("an import written inside a fixture string is not a real import", () => {
    const src = [
      "const fixture = `import {",
      "  deadOnArrival,",
      '} from "./module.ts";`;',
      "export const value = fixture;",
      "",
    ].join("\n");
    expect(extractImports(src, "fixture.ts")).toEqual([]);
  });

  test("every imported binding is referenced in its file", () => {
    const detail = unused
      .map((u) => `  ${u.file}:${u.line}  import { ${u.name} }`)
      .join("\n");
    expect(unused, `Unused imports found — remove them or wire a consumer:\n${detail}`).toEqual([]);
  });
});
