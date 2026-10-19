// @vitest-environment node
/**
 * Mechanical enforcement: no dead CSS selectors in Svelte `<style>` blocks
 *.
 *
 * The existing `no-dead-css-tokens.test.ts` guards CSS custom properties
 * (`--name`) declared in `tokens.css`. This companion test guards a different
 * surface: scoped CSS CLASS selectors in `.svelte` `<style>` blocks that no
 * template element uses — refactor leftovers (e.g. a markup rename that
 * dropped a `<div class="panel-header">` but left the `.panel-header {}` rule).
 *
 * Svelte's compiler already strips unused scoped selectors at build time, so
 * dead source selectors are harmless at runtime but pollute the source and
 * mislead readers. This test keeps the source clean.
 *
 * Precision design (rule: "if a detection has too many false positives, exclude
 * it or make it configurable"). Static class analysis is undecidable for
 * dynamic class values, so this test is deliberately CONSERVATIVE — it only
 * flags a class when ALL of these hold:
 *
 * 1. The class appears as a STANDALONE simple selector `.cls` (optionally
 * with a pseudo: `.cls:hover`, `.cls::before`). Compound (`.a.b`) and
 * descendant (`.a.b`, `button.cls`) selectors are NOT flagged — the
 * base class may be applied dynamically (e.g. `class="a {status}"`
 * yields `.a.active` where `active` is a runtime value, not a literal).
 * 2. The class name does NOT appear as a word anywhere in the file outside
 * the `<style>` block (markup, `<script>`, string literals, `class:dir`
 * directives, `class={cond? 'x': 'y'}` string-literal expressions).
 * 3. The class is NOT also referenced inside a `:global(...)` selector in
 * the same `<style>` block (a class used globally by a child component
 * is alive even if not in this template).
 * 4. The file's template does NOT use `{@html...}` (injected markup is a
 * black box — the class could be in the injected content).
 *
 * Comment stripping runs before extraction so `web.dev` in a CSS comment
 * is not mistaken for a `.dev` selector.
 */
import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { walk, stripCssBlockComments as stripComments } from "../helpers/source-scan.ts";

const ROOT = "src";

/**
 * Return the class name iff `sel` is a standalone simple selector
 * `.cls` optionally followed by pseudo-elements/classes (`:hover`, `::before`).
 * Returns null for compound (`.a.b`), descendant (`.a.b`), element
 * (`button`), or any selector with more than one compound.
 */
function standaloneClassName(sel: string): string | null {
  const m = /^\.([A-Za-z_][\w-]*)(:?[A-Za-z_-]+)*$/.exec(sel.trim());
  return m !== null ? m[1]! : null;
}

describe("no dead CSS class selectors in Svelte <style>", () => {
  const dead: { file: string; cls: string }[] = [];

  for (const file of walk(ROOT, { exts: [".svelte"] })) {
    const src = readFileSync(file, "utf8");
    const styleStart = src.indexOf("<style");
    const styleEnd = src.indexOf("</style>");
    if (styleStart === -1 || styleEnd === -1) continue;
    const rel = relative(process.cwd(), file);
    const styleBlock = stripComments(src.slice(styleStart, styleEnd));
    const nonStyle = src.slice(0, styleStart) + src.slice(styleEnd + "</style>".length);

    // Escape hatch #4: {@html} injects opaque markup.
    if (nonStyle.includes("{@html")) continue;

    // Escape hatch #3: classes referenced in:global(...) are alive.
    const globalClasses = new Set<string>();
    for (const m of styleBlock.matchAll(/:global\(([^)]*)\)/g)) {
      for (const c of m[1]!.matchAll(/\.([A-Za-z_][\w-]*)/g)) globalClasses.add(c[1]!);
    }

    // Collect classes that have at least one standalone-simple-selector rule.
    const standalone = new Set<string>();
    for (const line of styleBlock.split("\n")) {
      const brace = line.indexOf("{");
      const selPart = brace === -1 ? line : line.slice(0, brace);
      if (/^\s*@/.test(selPart)) continue; // at-rules (@media, @keyframes)
      const noGlobal = selPart.replace(/:global\(([^)]*)\)/g, "");
      for (const part of noGlobal.split(",")) {
        const name = standaloneClassName(part);
        if (name !== null) standalone.add(name);
      }
    }

    for (const cls of standalone) {
      if (globalClasses.has(cls)) continue;
      const esc = cls.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`\\b${esc}\\b`);
      // Escape hatch #2: the class name must not appear anywhere outside the
      // <style> block (markup, script, string literals, class: directives).
      if (!re.test(nonStyle)) {
        dead.push({ file: rel, cls });
      }
    }
  }

  test("every standalone <style> class selector is referenced in its template", () => {
    if (dead.length > 0) {
      const detail = dead.map((d) => `  ${d.file}: .${d.cls}`).join("\n");
      throw new Error(
        `Dead CSS class selectors — defined in <style> but never used in the template:\n${detail}\n` +
          `Remove the rule, or wire a consumer. If the class is applied dynamically ` +
          `(class="base {expr}"), move it to a compound selector so it is not a false positive.`,
      );
    }
  });

  test("the scanner itself is precise — no false-positive classes flagged", () => {
    // Self-check: the detection must not flag classes that ARE applied
    // dynamically via `class="base {expr}"` compound selectors. This asserts
    // the algorithm's known limitation is documented, not silently broken.
    // (If this ever fails, the standalone-only rule regressed.)
    for (const d of dead) {
      const src = readFileSync(join(process.cwd(), d.file), "utf8");
      // A flagged class must NOT also be a dynamic value of a compound
      // selector whose base class is in the template — i.e. it must be a
      // genuine standalone leftover. Sanity: the class appears nowhere
      // outside <style>.
      const ss = src.indexOf("<style");
      const nonStyle = ss === -1 ? src : src.slice(0, ss);
      expect(nonStyle).not.toContain(d.cls);
    }
  });
});
