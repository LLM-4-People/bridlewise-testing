// @vitest-environment node
/**
 * ONE GEOMETRY, ONE PALETTE: the brand mark is declared once
 * (`src/cockpit/shell/brand-mark.ts`, each part naming its token) and every
 * consumer derives from it.
 *
 *   A. `Brand.svelte` draws exactly the declared parts, judged on Svelte's own
 *      parse (the parser the markup guards use), never on spelling: one tile
 *      `rect`, the rein `path`, one `path` per record line from an `{#each}`
 *      over the declaration, and the beam `circle`. Each element carries
 *      exactly the attributes that read its part (its geometry and
 *      `inkOf(<the part>.ink)`), nothing else; the styles paint no part.
 *   B. The icon generator (`scripts/generate-pwa-icons.mjs`) paints each part
 *      with the value of the token the declaration names for it. Driven with a
 *      PLANTED palette (a distinct value per token), every part of the SVG and
 *      a pixel inside every part of the PNG must carry its own token's planted
 *      value, so a remap that recolours a part fails. It restates no colour in
 *      any spelling.
 *   C. No other file in the tree carries the mark's geometry (a copy of the
 *      rein, the beam or the record lines) except the generated icon.
 *
 * Every finding function is pure and mutation-tested below: each plant must
 * land (the planted source differs from the real one) and must be named.
 * The committed icons and the service worker's digest are judged against
 * their generators' output in tests/prevention/pwa.test.ts.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { parse } from "svelte/compiler";
import { describe, expect, test } from "vitest";

import { sourceViewOf } from "../../engine/scripts/verification/source-view.ts";
// @ts-expect-error -- a .mjs module has no declaration file in the TS program (as in pwa.test.ts).
import { markColors, markPng, markSvg } from "../../scripts/generate-pwa-icons.mjs";
import { BRAND_MARK, strokePath } from "../../src/cockpit/shell/brand-mark.ts";
import { read } from "../helpers/source-scan.ts";

const BRAND = "src/cockpit/shell/Brand.svelte";
const GENERATOR = "scripts/generate-pwa-icons.mjs";
const OWNER = "src/cockpit/shell/brand-mark.ts";
/** The generated copies of the geometry (their bytes are the generator's, judged in pwa.test.ts). */
const GENERATED = new Set(["public/icons/icon.svg"]);
/** The names Brand.svelte must take from the declaration, and nowhere else. */
const DECLARED_NAMES = ["BRAND_MARK", "inkOf", "strokePath"] as const;

/** One drawn element: its tag and EXACTLY its attributes, each the expression that reads its part. */
type Drawn = Readonly<{ name: string; attributes: Readonly<Record<string, string>> }>;
/** The drawing Brand.svelte must be: each part, in paint order, read from the declaration. */
const DRAWING: readonly (Drawn | Readonly<{ each: string; as: string; body: Drawn }>)[] = [
  { name: "rect", attributes: { width: "BRAND_MARK.grid", height: "BRAND_MARK.grid", rx: "BRAND_MARK.tileRadius", "style:fill": "inkOf(BRAND_MARK.tile)" } },
  { name: "path", attributes: { d: "strokePath(BRAND_MARK.rein)", "stroke-width": "BRAND_MARK.stroke", "style:stroke": "inkOf(BRAND_MARK.rein.ink)" } },
  { each: "BRAND_MARK.lines", as: "line", body: { name: "path", attributes: { d: "strokePath(line)", "stroke-width": "BRAND_MARK.stroke", "style:stroke": "inkOf(line.ink)" } } },
  { name: "circle", attributes: { cx: "BRAND_MARK.beam.at[0]", cy: "BRAND_MARK.beam.at[1]", r: "BRAND_MARK.beam.r", "style:fill": "inkOf(BRAND_MARK.beam.ink)" } },
];
const VIEW_BOX = "0 0 {BRAND_MARK.grid} {BRAND_MARK.grid}";

/** The legacy Svelte AST, as far as these checks read it. */
interface Expr { start: number; end: number }
interface ValuePart { type: string; data?: string; expression?: Expr }
interface Attr { type: string; name: string; value: true | ValuePart[] }
interface Node {
  type: string;
  name?: string;
  data?: string;
  attributes?: Attr[];
  children?: Node[];
  expression?: Expr;
  context?: { type: string; name?: string };
  else?: Node | null;
}
interface Declared { type: string; property?: string; value?: string; children?: Declared[]; block?: Declared; prelude?: unknown }
interface Statement { type: string; source?: { value: string }; specifiers?: { imported?: { name: string }; local: { name: string } }[]; declarations?: { id: unknown }[]; id?: { name: string } | null }

/** The source of an attribute value, as written: text kept, each expression as `{…}` (or bare when it is the whole value). */
function valueText(source: string, value: Attr["value"]): string {
  if (value === true) return "true";
  const text = value.map((part) => (part.type === "Text" ? part.data ?? "" : `{${source.slice(part.expression!.start, part.expression!.end)}}`)).join("");
  const only = value.length === 1 && value[0]!.type !== "Text";
  return (only ? text.slice(1, -1) : text).replace(/\s+/gu, " ").trim();
}

/** A Svelte element's attributes as name → value text; a directive other than `style:` keeps its kind in its name. */
function attributesOf(source: string, node: Node): Record<string, string> {
  const out: Record<string, string> = {};
  for (const attr of node.attributes ?? []) {
    const key = attr.type === "Attribute" ? attr.name : attr.type === "StyleDirective" ? `style:${attr.name}` : `${attr.type}:${attr.name}`;
    out[key] = valueText(source, attr.value);
  }
  return out;
}

/** The meaningful children of a node: whitespace text and comments are not drawing. */
function drawnChildren(node: Node): Node[] {
  return (node.children ?? []).filter((child) => !(child.type === "Text" && (child.data ?? "").trim() === "") && child.type !== "Comment");
}

function* walk(node: Node | null | undefined): Generator<Node> {
  if (!node) return;
  yield node;
  for (const child of node.children ?? []) yield* walk(child);
  yield* walk(node.else);
}

/** Every identifier a top-level statement declares (imports, variables, functions, classes). */
function declaredNames(statement: Statement): string[] {
  if (statement.type === "ImportDeclaration") return (statement.specifiers ?? []).map((s) => s.local.name);
  if ((statement.type === "FunctionDeclaration" || statement.type === "ClassDeclaration") && statement.id) return [statement.id.name];
  if (statement.type === "VariableDeclaration") {
    const names: string[] = [];
    const pattern = (p: unknown): void => {
      const n = p as { type?: string; name?: string; properties?: { value?: unknown; argument?: unknown }[]; elements?: unknown[]; left?: unknown; argument?: unknown };
      if (n?.type === "Identifier" && n.name) names.push(n.name);
      else if (n?.type === "ObjectPattern") for (const prop of n.properties ?? []) pattern(prop.value ?? prop.argument);
      else if (n?.type === "ArrayPattern") for (const el of n.elements ?? []) pattern(el);
      else if (n?.type === "AssignmentPattern") pattern(n.left);
      else if (n?.type === "RestElement") pattern(n.argument);
    };
    for (const d of statement.declarations ?? []) pattern(d.id);
    return names;
  }
  return [];
}

/** Findings for one drawn element against its expected part. */
function drawnFindings(source: string, node: Node | undefined, expected: Drawn, where: string): string[] {
  if (node?.type !== "Element" || node.name !== expected.name) return [`${where}: expected <${expected.name}>, found ${node ? `${node.type} ${node.name ?? ""}`.trim() : "nothing"}`];
  const actual = attributesOf(source, node);
  const findings: string[] = [];
  for (const [name, value] of Object.entries(expected.attributes)) {
    if (!(name in actual)) findings.push(`${where} <${expected.name}>: ${name} is missing (expected ${value})`);
    else if (actual[name] !== value) findings.push(`${where} <${expected.name}>: ${name} is ${actual[name]}, not ${value}`);
  }
  for (const name of Object.keys(actual)) if (!(name in expected.attributes)) findings.push(`${where} <${expected.name}>: carries ${name}, which reads no part of the declaration`);
  if (drawnChildren(node).length > 0) findings.push(`${where} <${expected.name}>: has children`);
  return findings;
}

/** Findings for the in-app mark: it draws exactly the declaration's parts, each painted with its own ink. */
export function brandFindings(source: string): string[] {
  const ast = parse(source) as unknown as { html: Node; instance?: { content: { body: Statement[] } }; module?: { content: { body: Statement[] } }; css?: Declared };
  const findings: string[] = [];
  // The script takes the three names from the declaration, and nothing else declares them.
  const statements = [...(ast.instance?.content.body ?? []), ...(ast.module?.content.body ?? [])];
  const owner = statements.find((s) => s.type === "ImportDeclaration" && s.source?.value === "./brand-mark.ts");
  for (const name of DECLARED_NAMES) {
    if (!owner?.specifiers?.some((s) => s.local.name === name && s.imported?.name === name)) findings.push(`does not import ${name} from ./brand-mark.ts`);
  }
  for (const statement of statements) {
    if (statement === owner) continue;
    for (const name of declaredNames(statement)) if ((DECLARED_NAMES as readonly string[]).includes(name)) findings.push(`declares its own ${name}`);
  }
  // Exactly one <svg>, and its drawing is the declaration's, part by part.
  const svgs = [...walk(ast.html)].filter((n) => n.type === "Element" && n.name === "svg");
  if (svgs.length !== 1) return [...findings, `draws ${svgs.length} <svg> elements, not one`];
  const svg = svgs[0]!;
  const viewBox = attributesOf(source, svg).viewBox;
  if (viewBox !== VIEW_BOX) findings.push(`<svg> viewBox is ${viewBox ?? "missing"}, not ${VIEW_BOX}`);
  const drawn = drawnChildren(svg);
  if (drawn.length !== DRAWING.length) findings.push(`<svg> draws ${drawn.length} parts, not the declaration's ${DRAWING.length}`);
  DRAWING.forEach((part, index) => {
    const node = drawn[index];
    const where = `part ${index + 1}`;
    if (!("each" in part)) {
      findings.push(...drawnFindings(source, node, part, where));
      return;
    }
    if (node?.type !== "EachBlock") {
      findings.push(`${where}: expected {#each ${part.each} as ${part.as}}, found ${node ? node.type : "nothing"}`);
      return;
    }
    const over = source.slice(node.expression!.start, node.expression!.end);
    if (over !== part.each) findings.push(`${where}: {#each} runs over ${over}, not ${part.each}`);
    if (node.context?.type !== "Identifier" || node.context.name !== part.as) findings.push(`${where}: {#each} names its item other than ${part.as}`);
    if (node.else) findings.push(`${where}: {#each} has an {:else}`);
    const body = drawnChildren(node);
    if (body.length !== 1) findings.push(`${where}: {#each} draws ${body.length} elements per line, not one`);
    findings.push(...drawnFindings(source, body[0], part.body, `${where} {#each}`));
  });
  // The styles paint no part: every fill or stroke is the declaration's (`fill: none` only unpaints).
  const declarations = (node: Declared | undefined): Declared[] => (node ? [node, ...(node.children ?? []).flatMap(declarations), ...declarations(node.block)] : []);
  for (const d of declarations(ast.css)) {
    if (d.type === "Declaration" && /^(?:fill|stroke)$/u.test(d.property ?? "") && (d.value ?? "").trim() !== "none") findings.push(`its styles paint a part (${d.property}: ${d.value}): the palette is the declaration's`);
  }
  if (COLOUR_LITERAL.some((pattern) => pattern.test(source))) findings.push("it carries a colour literal");
  return findings;
}

/** A colour in any CSS or numeric spelling: hex (3, 4, 6 or 8 digits), a colour function with its values, a 24/32-bit number. */
const COLOUR_LITERAL: readonly RegExp[] = [
  /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/u,
  /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(\s*[-+.\d]|\bcolor\(\s*[a-z]/u,
  /\b0x(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6})\b/u,
];
/** Three numbers in an array literal: an RGB triplet. The generator holds none (its channels come from parsed hex). */
const TRIPLET = /\[\s*(?:0x[0-9a-fA-F]+|\d+)\s*(?:,\s*(?:0x[0-9a-fA-F]+|\d+)\s*){2}\]/u;

/** Findings for the generator: no colour of its own in any spelling, the geometry from the declaration. Comments are prose. */
export function generatorFindings(source: string): string[] {
  const code = sourceViewOf(source, GENERATOR).codeWithStringsAndTemplates();
  const findings: string[] = [];
  if (COLOUR_LITERAL.some((pattern) => pattern.test(code))) findings.push("a colour literal");
  if (TRIPLET.test(code)) findings.push("an RGB triplet literal");
  if (!/from\s*["']\.\.\/src\/cockpit\/shell\/brand-mark\.ts["']/u.test(code)) findings.push("does not read the geometry from brand-mark.ts");
  return findings;
}

/** The generator's palette reader, typed for this file. */
const markColorsOf = (css: string): Record<string, string> => markColors(css) as Record<string, string>;

/** Each token the declaration names, with a distinct planted value no real token has. */
function plantedPalette(): Record<string, string> {
  const tokens = [...new Set([BRAND_MARK.tile, BRAND_MARK.rein.ink, ...BRAND_MARK.lines.map((l) => l.ink), BRAND_MARK.beam.ink])];
  const hex = (n: number): string => n.toString(16).padStart(2, "0");
  return Object.fromEntries(tokens.map((token, i) => [token, `#${hex(17 + i * 53)}${hex(29 + i * 47)}${hex(41 + i * 59)}`]));
}

/** The Carbon `:root` block the generator reads, carrying the planted values. */
function plantedTokens(palette: Record<string, string>): string {
  return `:root {\n${Object.entries(palette).map(([token, value]) => `  ${token}: ${value};`).join("\n")}\n}\n`;
}

/** Findings for one generated SVG: every part carries the planted value of the token the declaration names for it. */
export function svgPaintFindings(svg: string, palette: Record<string, string>): string[] {
  const ast = parse(svg) as unknown as { html: Node };
  const elements = [...walk(ast.html)].filter((n) => n.type === "Element" && n.name !== "svg");
  const paint = (n: Node): Record<string, string> => attributesOf(svg, n);
  const findings: string[] = [];
  const one = (what: string, matches: Node[], attribute: string, token: string): void => {
    if (matches.length !== 1) {
      findings.push(`${what}: drawn ${matches.length} times, not once`);
      return;
    }
    const value = paint(matches[0]!)[attribute];
    if (value !== palette[token]) findings.push(`${what}: ${attribute} is ${value ?? "missing"}, not ${token} (${palette[token]})`);
  };
  one("the tile", elements.filter((n) => n.name === "rect"), "fill", BRAND_MARK.tile);
  for (const [what, stroke] of [["the rein", BRAND_MARK.rein], ...BRAND_MARK.lines.map((l, i) => [`record line ${i + 1}`, l] as const)] as const) {
    one(what, elements.filter((n) => n.name === "path" && paint(n).d === strokePath(stroke)), "stroke", stroke.ink);
  }
  one("the beam", elements.filter((n) => n.name === "circle"), "fill", BRAND_MARK.beam.ink);
  const parts = 2 + BRAND_MARK.lines.length + 1;
  if (elements.length !== parts) findings.push(`the SVG draws ${elements.length} elements, not the declaration's ${parts}`);
  return findings;
}

/** The RGB pixels of a generated PNG (8-bit RGB, unfiltered rows: the generator writes no other kind). */
function pngPixels(png: Buffer): { size: number; at: (x: number, y: number) => string } {
  const size = png.readUInt32BE(16);
  if (png[24] !== 8 || png[25] !== 2) throw new Error("not an 8-bit RGB PNG");
  const idat: Buffer[] = [];
  for (let off = 8; off < png.length; ) {
    const length = png.readUInt32BE(off);
    if (png.toString("ascii", off + 4, off + 8) === "IDAT") idat.push(png.subarray(off + 8, off + 8 + length));
    off += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const row = size * 3 + 1;
  return {
    size,
    at: (x, y) => {
      if (raw[y * row] !== 0) throw new Error(`row ${y} is filtered; the generator writes unfiltered rows`);
      const off = y * row + 1 + x * 3;
      return `#${[raw[off]!, raw[off + 1]!, raw[off + 2]!].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
    },
  };
}

/** A point inside each part, on the declaration's grid: the tile's far corner, a quarter down the rein, each line's middle, the beam's centre. */
function partPoints(): { what: string; at: readonly [number, number]; token: string }[] {
  const lerp = (s: { from: readonly [number, number]; to: readonly [number, number] }, t: number): [number, number] => [s.from[0] + (s.to[0] - s.from[0]) * t, s.from[1] + (s.to[1] - s.from[1]) * t];
  return [
    { what: "the tile", at: [BRAND_MARK.grid - 1, BRAND_MARK.grid - 1], token: BRAND_MARK.tile },
    { what: "the rein", at: lerp(BRAND_MARK.rein, 0.25), token: BRAND_MARK.rein.ink },
    ...BRAND_MARK.lines.map((l, i) => ({ what: `record line ${i + 1}`, at: lerp(l, 0.5), token: l.ink })),
    { what: "the beam", at: BRAND_MARK.beam.at, token: BRAND_MARK.beam.ink },
  ];
}

/** Findings for one generated PNG: a pixel inside every part carries the planted value of that part's token. */
export function pngPaintFindings(png: Buffer, palette: Record<string, string>): string[] {
  const pixels = pngPixels(png);
  const scale = pixels.size / BRAND_MARK.grid;
  return partPoints().flatMap(({ what, at, token }) => {
    const value = pixels.at(Math.floor(at[0] * scale), Math.floor(at[1] * scale));
    return value === palette[token] ? [] : [`${what}: the pixel at (${at.join(", ")}) is ${value}, not ${token} (${palette[token]})`];
  });
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

/** `source` with `from` replaced by `to`; a plant that does not land is a broken test, never a pass. */
function plant(source: string, from: string, to: string): string {
  expect(source.includes(from), `the plant's anchor ${JSON.stringify(from)} is in the source`).toBe(true);
  return source.replace(from, to);
}

describe("one geometry, one palette", () => {
  test("A: Brand.svelte draws exactly the declared parts, each with its own ink", () => {
    expect(brandFindings(read(BRAND))).toEqual([]);
  });

  test("B: the generator paints every part with its own token's value, and restates no colour", () => {
    expect(generatorFindings(read(GENERATOR))).toEqual([]);
    const palette = plantedPalette();
    expect(new Set(Object.values(palette)).size, "the planted palette gives every token its own value").toBe(Object.keys(palette).length);
    const css = plantedTokens(palette);
    expect(svgPaintFindings(markSvg(markColorsOf(css)), palette)).toEqual([]);
    for (const size of [192, 512]) expect(pngPaintFindings(markPng(size, markColorsOf(css)), palette), `the ${size} PNG`).toEqual([]);
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

  test("mutation: Brand.svelte drawing something other than the mark is refused, by structure not spelling", () => {
    const brand = read(BRAND);
    const refused = (planted: string, finding: RegExp): void => {
      expect(planted, "the plant landed").not.toBe(brand);
      expect(brandFindings(planted).join("\n")).toMatch(finding);
    };
    // A coordinate in Svelte's expression spelling, a template literal, or a quoted attribute.
    refused(plant(brand, "d={strokePath(BRAND_MARK.rein)}", 'd={"M2 2L30 30"}'), /part 2 <path>: d is "M2 2L30 30", not strokePath\(BRAND_MARK\.rein\)/u);
    refused(plant(brand, "d={strokePath(BRAND_MARK.rein)}", "d={`M8 7L8 25`}"), /part 2 <path>: d is `M8 7L8 25`/u);
    refused(plant(brand, "cx={BRAND_MARK.beam.at[0]}", 'cx="8"'), /part 4 <circle>: cx is 8, not BRAND_MARK\.beam\.at\[0\]/u);
    // A part left undrawn: the record lines deleted.
    const each = brand.slice(brand.indexOf("    {#each"), brand.indexOf("{/each}") + "{/each}\n".length);
    refused(plant(brand, each, ""), /<svg> draws 3 parts, not the declaration's 4/u);
    // A part painted with another part's ink.
    refused(plant(brand, "style:fill={inkOf(BRAND_MARK.tile)}", "style:fill={inkOf(BRAND_MARK.beam.ink)}"), /part 1 <rect>: style:fill is inkOf\(BRAND_MARK\.beam\.ink\), not inkOf\(BRAND_MARK\.tile\)/u);
    refused(plant(brand, "style:stroke={inkOf(line.ink)}", "style:stroke={inkOf(BRAND_MARK.rein.ink)}"), /part 3 \{#each\} <path>: style:stroke is inkOf\(BRAND_MARK\.rein\.ink\)/u);
    // A token named in the markup, a class or an inline style that could paint, a part painted from the styles.
    refused(plant(brand, "inkOf(BRAND_MARK.tile)", 'inkOf("--ground-2")'), /style:fill is inkOf\("--ground-2"\)/u);
    refused(plant(brand, "<circle ", '<circle class="beam" '), /<circle>: carries class, which reads no part/u);
    refused(plant(brand, "<rect ", '<rect style="fill: var(--beam)" '), /<rect>: carries style, which reads no part/u);
    refused(plant(brand, "<style>", "<style>\n  rect { fill: var(--ground-2); }"), /its styles paint a part \(fill: var\(--ground-2\)\)/u);
    // An extra drawn element, and a second <svg>.
    refused(plant(brand, "  </svg>", '    <line x1="0" y1="0" x2="32" y2="32" />\n  </svg>'), /<svg> draws 5 parts/u);
    refused(plant(brand, "{#if wordmark}", "<svg></svg>{#if wordmark}"), /draws 2 <svg> elements, not one/u);
    // The names taken from somewhere else, or shadowed.
    refused(plant(brand, 'from "./brand-mark.ts"', 'from "./brand-mark-copy.ts"'), /does not import BRAND_MARK from \.\/brand-mark\.ts/u);
    refused(plant(brand, "import { BRAND_MARK, inkOf, strokePath }", "const inkOf = (t: string) => t;\n  import { BRAND_MARK, strokePath }"), /does not import inkOf from \.\/brand-mark\.ts\ndeclares its own inkOf/u);
    // A colour literal anywhere in the component, in any spelling.
    refused(plant(brand, "path { fill: none;", "path { fill: none; color: #8fd3ff;"), /colour literal/u);
    refused(plant(brand, "path { fill: none;", "path { fill: none; color: hsl(200 100% 78%);"), /colour literal/u);
    // Near-misses: the real component, a reordered attribute list, `fill: none`.
    expect(brandFindings(plant(brand, "width={BRAND_MARK.grid} height={BRAND_MARK.grid}", "height={BRAND_MARK.grid} width={BRAND_MARK.grid}"))).toEqual([]);
    expect(brandFindings(brand)).toEqual([]);
  });

  test("mutation: a generator that recolours a part, or restates a colour in any spelling, is refused", () => {
    const palette = plantedPalette();
    const colors = markColorsOf(plantedTokens(palette));
    const svg = markSvg(colors) as string;
    // The record lines painted with the beam's value (the remap the review planted): named in the SVG and in the PNG.
    const remapped = { ...colors, [BRAND_MARK.lines[0]!.ink]: colors[BRAND_MARK.beam.ink] };
    expect(svgPaintFindings(markSvg(remapped), palette).join("\n")).toMatch(/record line 1: stroke is .*, not --ink-2/u);
    expect(pngPaintFindings(markPng(192, remapped), palette).join("\n")).toMatch(/record line 1: the pixel/u);
    // The tile and the rein swapped.
    const swapped = { ...colors, [BRAND_MARK.tile]: colors[BRAND_MARK.rein.ink], [BRAND_MARK.rein.ink]: colors[BRAND_MARK.tile] };
    expect(pngPaintFindings(markPng(192, swapped), palette).join("\n")).toMatch(/the tile: .*\n.*the rein: /u);
    // A part dropped from the SVG, and a part drawn twice.
    const beam = svg.slice(svg.indexOf("<circle"), svg.indexOf("/>", svg.indexOf("<circle")) + 2);
    expect(svgPaintFindings(plant(svg, beam, ""), palette).join("\n")).toMatch(/the beam: drawn 0 times/u);
    expect(svgPaintFindings(plant(svg, beam, beam + beam), palette).join("\n")).toMatch(/the beam: drawn 2 times/u);
    // The literal rule, in every spelling the review probed; comments are prose.
    const generator = read(GENERATOR);
    for (const literal of ['"#8fd3ff"', '"#f00"', '"#ff0000ff"', '"rgb(255,0,0)"', '"hsl(0 100% 50%)"', "0xff0000", "`#8fd3ff`"]) {
      expect(generatorFindings(`${generator}\nconst BEAM = ${literal};`), literal).toContain("a colour literal");
    }
    for (const triplet of ["[255, 0, 0]", "[0x0d, 0x0f, 0x14]"]) expect(generatorFindings(`${generator}\nconst BG = ${triplet};`), triplet).toContain("an RGB triplet literal");
    expect(generatorFindings(`${generator}\n// the beam was #8fd3ff, rgb(143, 211, 255) in the Carbon tokens`)).toEqual([]);
    expect(generatorFindings(generator.replace("../src/cockpit/shell/brand-mark.ts", "./mark-copy.ts"))).toContain("does not read the geometry from brand-mark.ts");
  });

  test("mutation: a hand copy of the geometry elsewhere in the tree is caught; near-misses pass", () => {
    expect(geometryFindings("docs/assets/mark.svg", '<path d="M8 25V7" stroke="#e8ebef"/>')).toHaveLength(1);
    expect(geometryFindings("src/cockpit/boot/Logo.svelte", '<path d="M8 7L8 25"/>')).toHaveLength(1);
    expect(geometryFindings("docs/x.md", '<circle cx="8" cy="16" r="2.5" fill="#8fd3ff"/>')).toHaveLength(1);
    expect(geometryFindings("src/a.svelte", '<path d="M8 7L9 25"/><circle cx="8" cy="16" r="3"/>')).toEqual([]);
  });
});
