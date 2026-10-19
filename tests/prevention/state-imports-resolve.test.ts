// @vitest-environment node
/**
 * Mechanical enforcement: every named import of `state/projects` resolves
 * to a real export.
 *
 * Regression root cause (exp499): EXP497 added three Svelte components
 * (IntelligencePanel, EditorPanel, GitPanel) that imported `selectedProject`
 * from `state/projects`, but that module only exports `currentProject`.
 * The bad import broke `vite build` with [MISSING_EXPORT], so no JS bundle
 * was produced and the web UI stopped rendering.
 *
 * This test scans every `.ts` and `.svelte` file under `src/` for named
 * imports whose module specifier resolves to `src/state/projects.ts`, then
 * asserts each imported name is among the module's value exports. It would
 * have failed on the broken commit and catches future import/export drift
 * on the canonical projects-state module.
 */
import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { walk } from "../helpers/source-scan.ts";

const STATE_FILE = join(process.cwd(), "src", "state", "projects.ts");

/** Exported value (non-type) names from a module source string. */
function exportedValueNames(src: string): Set<string> {
  const names = new Set<string>();
  for (const line of src.split("\n")) {
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*")) continue;
    let m = /^export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/.exec(t);
    if (m) { names.add(m[1]!); continue; }
    m = /^export\s+const\s+([A-Za-z_$][\w$]*)\b/.exec(t);
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
  return names;
}

/** Import bindings imported from a specifier ending in `state/projects`. */
function importedNamesFromProjects(src: string): string[] {
  const names: string[] = [];
  // Match: import { A, B as C, type D } from "...state/projects"
  const re = /import\s*\{([^}]*)\}\s*from\s*["']([^"']*state\/projects)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    for (const part of m[1]!.split(",")) {
      const trimmed = part.trim();
      if (trimmed.length === 0) continue;
      if (/^type\s+/.test(trimmed)) continue; // type-only imports don't need value exports
      const asMatch = /\bas\s+([A-Za-z_$][\w$]*)/.exec(trimmed);
      names.push((asMatch ? asMatch[1]! : trimmed).replace(/:.+$/, "").trim());
    }
  }
  return names;
}

describe("state/projects named imports resolve to real exports", () => {
  const exports = exportedValueNames(readFileSync(STATE_FILE, "utf-8"));

  const consumers = walk(join(process.cwd(), "src"));
  const offenders: { file: string; name: string }[] = [];
  for (const file of consumers) {
    // Skip the state module itself.
    if (file === STATE_FILE) continue;
    const src = readFileSync(file, "utf-8");
    for (const name of importedNamesFromProjects(src)) {
      if (!exports.has(name)) {
        offenders.push({ file: file.split(sep).join("/"), name });
      }
    }
  }

  test(`every named import of state/projects resolves (exports: ${[...exports].join(", ")})`, () => {
    if (offenders.length > 0) {
      const detail = offenders
        .map((o) => `${o.file}: imports "${o.name}" which is not exported by src/state/projects.ts`)
        .join("\n");
      throw new Error(
        `Unresolved named imports of state/projects found — fix the import or add the export:\n${detail}`,
      );
    }
  });

  test("the canonical selection export is named currentProject (not selectedProject)", () => {
    // Guards against the exact regression: a component naming the derived
    // project atom `selectedProject` instead of the canonical `currentProject`.
    expect(exports.has("currentProject")).toBe(true);
  });
});
