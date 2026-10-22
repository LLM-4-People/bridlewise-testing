// @vitest-environment node
/**
 * ONE GEOMETRY, ONE PALETTE: the brand mark is declared once
 * (`src/cockpit/shell/brand-mark.ts`, each part naming its token) and every
 * consumer derives from it.
 *
 *   A. `Brand.svelte` paints each part with `inkOf(<the part>.ink)` read from
 *      the declaration — never a token named in its own markup or styles, never
 *      a colour of its own, never a coordinate of its own.
 *   B. The icon generator (`scripts/generate-pwa-icons.mjs`) restates no
 *      colour: no hex, no RGB triplet; the values come from the token owner.
 *   C. No other file in the tree carries the mark's geometry (a copy of the
 *      rein, the beam or the record lines) except the generated icon.
 *
 * The scanners are pure functions, mutation-tested below with planted
 * violations in more than one place and near-misses that must pass. The
 * committed icons and the service worker's icons digest are judged against the
 * generator's own output in tests/prevention/pwa.test.ts.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import { BRAND_MARK, strokePath } from "../../src/cockpit/shell/brand-mark.ts";
import { read } from "../helpers/source-scan.ts";

const BRAND = "src/cockpit/shell/Brand.svelte";
const GENERATOR = "scripts/generate-pwa-icons.mjs";
const OWNER = "src/cockpit/shell/brand-mark.ts";
/** The generated copies of the geometry (their bytes are the generator's, judged in pwa.test.ts). */
const GENERATED = new Set(["public/icons/icon.svg"]);

/** Findings for the in-app mark: every paint is `inkOf(<part>.ink)` from the declaration, nothing restated. */
export function brandFindings(source: string): string[] {
  const findings: string[] = [];
  const styleAt = source.indexOf("<style");
  const markup = styleAt < 0 ? source : source.slice(0, styleAt);
  const style = styleAt < 0 ? "" : source.slice(styleAt);
  if (!/import\s*\{[^}]*\bBRAND_MARK\b[^}]*\}\s*from\s*"\.\/brand-mark\.ts"/u.test(source)) findings.push("does not read BRAND_MARK from brand-mark.ts");
  if (/\b(?:fill|stroke)\s*:/u.test(style.replace(/fill\s*:\s*none/gu, ""))) findings.push("its styles paint a part (fill/stroke): the palette is the declaration's");
  for (const m of markup.matchAll(/\binkOf\(([^)]*)\)/gu)) {
    if (!/^(?:BRAND_MARK\.(?:tile|rein\.ink|beam\.ink)|line\.ink)$/u.test(m[1]!.trim())) findings.push(`inkOf(${m[1]}) does not read a part's ink from the declaration`);
  }
  if (/--(?:ground|ink|beam|line|ok|warn|alarm)[\w-]*/u.test(markup.replace(/<script[\s\S]*?<\/script>/u, ""))) findings.push("its markup names a token itself");
  if (/#[0-9a-fA-F]{3,8}\b|rgba?\(|oklch\(/u.test(source)) findings.push("it carries a colour literal");
  if (/\b(?:d|cx|cy|r|rx|width|height)="[\d.\s A-Za-z-]+"/u.test(markup)) findings.push("its markup restates a coordinate");
  return findings;
}

/** Findings for the generator: no colour of its own. */
export function generatorFindings(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/[^\n]*/gu, "");
  const findings: string[] = [];
  if (/["'`]#[0-9a-fA-F]{6}\b/u.test(code)) findings.push("a hex colour literal");
  if (/\[\s*0x[0-9a-fA-F]{2}\s*,\s*0x[0-9a-fA-F]{2}\s*,\s*0x[0-9a-fA-F]{2}\s*\]/u.test(code)) findings.push("an RGB triplet literal");
  if (!/from\s*["']\.\.\/src\/cockpit\/shell\/brand-mark\.ts["']/u.test(code)) findings.push("does not read the geometry from brand-mark.ts");
  return findings;
}

/** The mark's geometry signatures, from the declaration itself: the rein (either direction) and the beam. */
function signatures(): RegExp[] {
  const [rx, ry] = BRAND_MARK.rein.from;
  const [tx, ty] = BRAND_MARK.rein.to;
  const [bx, by] = BRAND_MARK.beam.at;
  return [
    new RegExp(`M\\s*${rx}[ ,]+${ry}\\s*(?:L\\s*${tx}[ ,]+${ty}|V\\s*${ty})`, "u"),
    new RegExp(`M\\s*${tx}[ ,]+${ty}\\s*(?:L\\s*${rx}[ ,]+${ry}|V\\s*${ry})`, "u"),
    new RegExp(`cx="${bx}"\\s+cy="${by}"\\s+r="${BRAND_MARK.beam.r}"`, "u"),
  ];
}

/** Findings for one file of the tree: a copy of the mark's geometry outside the owner and its generated output. */
export function geometryFindings(path: string, text: string): string[] {
  if (path === OWNER || GENERATED.has(path)) return [];
  return signatures().some((signature) => signature.test(text)) ? [`${path}: restates the brand mark's geometry`] : [];
}

describe("one geometry, one palette", () => {
  test("A: Brand.svelte paints every part from the declaration", () => {
    expect(brandFindings(read(BRAND))).toEqual([]);
  });

  test("B: the generator restates no colour", () => {
    expect(generatorFindings(read(GENERATOR))).toEqual([]);
  });

  test("C: no tracked file outside the owner and the generated icon carries the geometry", () => {
    const files = execFileSync("git", ["ls-files", "-z", "--", "*.svg", "*.svelte", "*.ts", "*.mjs", "*.js", "*.html", "*.md", "*.css"], { encoding: "utf8" })
      .split("\0").filter((f) => f.length > 0 && !f.startsWith("tests/cockpit/brand-mark-owner"));
    expect(files.length, "population is live").toBeGreaterThan(500);
    const findings = files.flatMap((f) => {
      let text: string;
      try {
        text = readFileSync(f, "utf8");
      } catch {
        return [`${f}: listed by git but unreadable`];
      }
      return geometryFindings(f, text);
    });
    expect(findings).toEqual([]);
    expect(geometryFindings("public/icons/icon.svg", `<path d="${strokePath(BRAND_MARK.rein)}"/>`), "the generated icon is the geometry's own output").toEqual([]);
  });

  test("mutation: planted restatements are caught in each consumer; near-misses pass", () => {
    const brand = read(BRAND);
    // Plant 1: a part painted from the styles, with a token of its own choosing.
    expect(brandFindings(brand.replace("<style>", "<style>\n  rect { fill: var(--ground-2); }"))).toContain("its styles paint a part (fill/stroke): the palette is the declaration's");
    // Plant 2: a token named in the markup instead of the declaration's ink.
    expect(brandFindings(brand.replace("inkOf(BRAND_MARK.tile)", 'inkOf("--ground-2")')).join(" ")).toMatch(/does not read a part's ink/u);
    // Plant 3: a coordinate restated in the markup.
    expect(brandFindings(brand.replace("cx={BRAND_MARK.beam.at[0]}", 'cx="8"'))).toContain("its markup restates a coordinate");
    // Plant 4: a colour literal anywhere in the component.
    expect(brandFindings(brand.replace("path { fill: none;", "path { fill: none; color: #8fd3ff;"))).toContain("it carries a colour literal");
    // The generator: a hex, or the retired RGB triplet.
    const generator = read(GENERATOR);
    expect(generatorFindings(`${generator}\nconst BEAM = "#8fd3ff";`)).toContain("a hex colour literal");
    expect(generatorFindings(`${generator}\nconst BG = [0x0d, 0x0f, 0x14];`)).toContain("an RGB triplet literal");
    // The tree: a hand copy of the mark in another file, in either path direction or by its beam.
    expect(geometryFindings("docs/assets/mark.svg", '<path d="M8 25V7" stroke="#e8ebef"/>')).toHaveLength(1);
    expect(geometryFindings("src/cockpit/boot/Logo.svelte", '<path d="M8 7L8 25"/>')).toHaveLength(1);
    expect(geometryFindings("docs/x.md", '<circle cx="8" cy="16" r="2.5" fill="#8fd3ff"/>')).toHaveLength(1);
    // Near-misses: fill none, an unrelated path, a comment naming a hex, another circle.
    expect(brandFindings(brand)).toEqual([]);
    expect(generatorFindings(`${generator}\n// the beam was #8fd3ff in the Carbon tokens`)).toEqual([]);
    expect(geometryFindings("src/a.svelte", '<path d="M8 7L9 25"/><circle cx="8" cy="16" r="3"/>')).toEqual([]);
  });
});
