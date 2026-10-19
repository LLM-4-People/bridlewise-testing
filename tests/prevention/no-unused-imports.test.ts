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

/** Extract named + default import bindings from a source file. Comment
 * lines (//, *, /*, <!--) are skipped so import-like patterns inside comment
 * examples (e.g. `// Named: import { A, B as C } from "..."`) are not parsed
 * as real imports. */
function extractImports(rawSrc: string, file: string): ImportBinding[] {
  const out: ImportBinding[] = [];
  // String CONTENTS are blanked first, line numbers intact. A test whose
  // fixtures are source snippets otherwise has every `import` inside its own
  // fixture strings read as a real import of a binding it never had — a
  // reported violation that does not exist, in a zero-tolerance guard.
  const lines = blankStringLiterals(rawSrc, file).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (/^(\/\/|\*|\/\*|<!--)/.test(trimmed)) continue;
    // Skip re-exports and side-effect imports.
    if (/^export\s/.test(trimmed)) continue;
    if (/^import\s+["']/.test(trimmed)) continue; // import "side-effect"
    // Named: import { A, B as C, type D } from "..."
    let m = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["'][^"']+["']/.exec(trimmed);
    if (m) {
      const names = m[1]!.split(",");
      for (const part of names) {
        const t = part.trim();
        if (t.length === 0) continue;
        // Skip `type X` — it's a type-only named import.
        const cleaned = t.replace(/^type\s+/, "");
        // `A as B` → use B (the local name).
        const asMatch = /\bas\s+([A-Za-z_$][\w$]*)/.exec(cleaned);
        const name = (asMatch ? asMatch[1]! : cleaned).replace(/:.+$/, "").trim();
        if (name.length > 0) out.push({ name, file, line: i + 1 });
      }
      continue;
    }
    // Default: import X from "..."
    m = /import\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s*from\s*["'][^"']+["']/.exec(trimmed);
    if (m) {
      out.push({ name: m[1]!, file, line: i + 1 });
      continue;
    }
    // Namespace: import * as N from "..."N is used via N.member, word match works.
    m = /import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*["'][^"']+["']/.exec(trimmed);
    if (m) {
      out.push({ name: m[1]!, file, line: i + 1 });
    }
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

  test("every imported binding is referenced in its file", () => {
    const detail = unused
      .map((u) => `  ${u.file}:${u.line}  import { ${u.name} }`)
      .join("\n");
    expect(unused, `Unused imports found — remove them or wire a consumer:\n${detail}`).toEqual([]);
  });
});
