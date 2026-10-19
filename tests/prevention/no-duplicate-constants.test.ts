// @vitest-environment node
/**
 * Mechanical enforcement: no duplicate constants.
 *
 * Detects `const NAME = <literal>` declarations (SCREAMING_SNAKE_CASE) with
 * the SAME name AND the SAME literal value appearing in two or more source
 * files under src/ and server/. A duplicate means the value has one owner
 * (typically `shared/constants.ts` or `bridlewise.config.json`) and
 * every other site must import from there — never re-declare inline.
 *
 * This catches the specific regression: `MAX_FILE_NAME_LENGTH = 256` declared
 * in both `server/project-context.ts` and `server/routes/file-tree.ts`. The
 * canonical owner is `shared/constants.ts`.
 *
 * Scope: only SCREAMING_SNAKE_CASE constants with literal values (strings,
 * numbers, booleans, null). This is conservative — it does not flag
 * near-duplicates (same value, different name) or computed values.
 */
import { describe, test } from "vitest";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { walk } from "../helpers/source-scan.ts";

const ROOTS = ["src", "server"] as const;

/**
 * Extract `const NAME = literal;` declarations where NAME is
 * SCREAMING_SNAKE_CASE. Returns [{ name, value, file }].
 */
function extractConstants(src: string, file: string): { name: string; value: string; file: string }[] {
  const out: { name: string; value: string; file: string }[] = [];
  // const NAME = "..." | '...' | `...` | 123 | 12.5 | true | false | null;
  const re =
    /\bconst\s+([A-Z][A-Z0-9_]+)\s*=\s*("[^"]*"|'[^']*'|`[^`]*`|\d+\.?\d*|true|false|null)\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    out.push({ name: m[1]!, value: m[2]!, file });
  }
  return out;
}

describe("no duplicate constants", () => {
  const byKey = new Map<string, { name: string; value: string; file: string }[]>();
  for (const root of ROOTS) {
    for (const file of walk(root, { exts: [".ts"] })) {
      const rel = relative(process.cwd(), file);
      const src = readFileSync(file, "utf8");
      for (const c of extractConstants(src, rel)) {
        const key = `${c.name}=${c.value}`;
        const list = byKey.get(key) ?? [];
        list.push(c);
        byKey.set(key, list);
      }
    }
  }

  const dupes = [...byKey.entries()].filter(([, locs]) => locs.length > 1);

  test("no two files declare the same SCREAMING_SNAKE constant with the same value", () => {
    if (dupes.length > 0) {
      const detail = dupes
        .map(([, locs]) => {
          const files = locs.map((l) => l.file).join(" == ");
          return `  ${locs[0]!.name} = ${locs[0]!.value}\n    ${files}`;
        })
        .join("\n");
      throw new Error(
        `Duplicate constants found — consolidate into one owner (shared/constants.ts):\n${detail}`,
      );
    }
  });
});
