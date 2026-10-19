// @vitest-environment node
/**
 * Mechanical enforcement: no unused exports.
 *
 * "No dead exports." A value export that nothing else
 * references is dead code. This test collects every value export from
 * src/, server/, and tests/helpers/.ts files and verifies the exported name
 * is referenced in at least one OTHER file (src/, server/, tests/, shared/,
 * *.svelte).
 *
 * Method: full-codebase name-occurrence (word-boundary). An export is
 * flagged only if its name appears in NO file other than its declaration
 * file — i.e. nothing imports, calls, re-exports, or dynamically imports it.
 * This is conservative (catches genuinely dead symbols; a coincidental
 * same-name reuse would mask a dead export, which is safe). Re-export hubs
 * (server/canonical.ts, shared/types.ts) are excluded as sources.
 *
 * The `tests/helpers/` scan is deny-by-default for dead HELPER exports: a
 * shared helper that no test imports is dead code that accumulates when
 * helpers are refactored (a helper export is removed from consumers but
 * left in the owner). This catches that class — every helper export must
 * be consumed by at least one other file.
 */
import { describe, test } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { extname, relative, sep } from "node:path";
import { walk, buildTokenIndex, referencedElsewhere } from "../helpers/source-scan.ts";

import { modulePath } from "../helpers/module-resolver.ts";
/** The repository root the corpus is gathered from. */
const cwdRoot = (): string => process.cwd();

const SCAN_ROOTS = ["src", "server", "tests/helpers"] as const;
const SEARCH_ROOTS = ["src", "server", "tests", "shared"] as const;

const HUB_REL = new Set([modulePath("canonical.ts"), "shared/types.ts"]);

function exportedValueNames(src: string): string[] {
  const names = new Set<string>();
  for (const line of src.split("\n")) {
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*")) continue;
    let m = /^export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/.exec(t);
    if (m) { names.add(m[1]!); continue; }
    m = /^export\s+const\s+([A-Za-z_$][\w$]*)\s*=/.exec(t);
    if (m) { names.add(m[1]!); continue; }
    if (/^export\s+\{/.test(t) && !/^export\s+type\s+\{/.test(t)) {
      const inner = t.slice(t.indexOf("{") + 1, t.indexOf("}"));
      for (const part of inner.split(",")) {
        const trimmed = part.trim();
        if (trimmed.length === 0) continue;
        const asMatch = /\bas\s+([A-Za-z_$][\w$]*)/.exec(trimmed);
        names.add((asMatch ? asMatch[1]! : trimmed).replace(/:.+$/, "").trim());
      }
    }
  }
  return [...names];
}

describe("no unused value exports", () => {
  const searchFiles: string[] = [];
  for (const root of SEARCH_ROOTS) {
    try { searchFiles.push(...walk(root)); } catch { /* root may not exist */ }
  }
  // AND THE ROOT-LEVEL DECLARATIONS, which are four directory names away from
  // being invisible. `vitest.config.ts`, `svelte.config.ts` and both playwright
  // configs are real consumers of `tests/helpers`, and a corpus made of
  // directories cannot see them — so a helper imported ONLY by a config was
  // reported as dead, correctly by the rule and wrongly about the world.
  // Driven: `assertSpecPatternsAreLive`, imported by both playwright configs,
  // came back "unused". The fix is the corpus, not an exemption.
  for (const entry of readdirSync(cwdRoot(), { withFileTypes: true })) {
    if (entry.isFile() && extname(entry.name) === ".ts") searchFiles.push(entry.name);
  }
  const cwd = process.cwd();
  // ONE pass over the corpus, before any name is asked about. Everything
  // below is a map lookup — see the note above `buildTokenIndex`.
  const tokenIndex = buildTokenIndex(searchFiles, cwd);

  const dead: { file: string; name: string }[] = [];
  for (const root of SCAN_ROOTS) {
    for (const file of walk(root)) {
      const rel = relative(cwd, file).split(sep).join("/");
      if (HUB_REL.has(rel)) continue;
      if (extname(file) !== ".ts") continue;
      const src = readFileSync(file, "utf-8");
      for (const name of exportedValueNames(src)) {
        // Count non-method-call occurrences in the declaration file. The
        // declaration itself accounts for 1; a method call like
        // `store.<name>()` is excluded (preceded by `.`) so a coincidental
        // name collision with an underlying object's method does NOT mask
        // a dead wrapper export. If the non-method count is 1, the symbol
        // is never used even internally (truly dead).
        const ownRe = new RegExp(`(?<!\\.)\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
        const ownCount = (src.match(ownRe) ?? []).length;
        if (ownCount > 1) continue; // used internally — not dead code
        if (!referencedElsewhere(name, rel, tokenIndex, searchFiles, cwd)) {
          dead.push({ file: rel, name });
        }
      }
    }
  }

  test("every value export is referenced in at least one other file", () => {
    if (dead.length > 0) {
      const detail = dead.map((d) => `${d.file}: export ${d.name}`).join("\n");
      throw new Error(
        `Unused value exports found — remove the export or wire a consumer:\n${detail}`,
      );
    }
  });
});
