/**
 * THE GENERATED FIGURES — SVG drawn in the design system for surfaces that
 * strip every stylesheet (a README on GitHub, a release page, a social card).
 *
 * A figure is drawn once per theme, its colours made concrete from the one
 * token owner through `token-reader.ts` (an SVG served as an image loads no
 * stylesheet and no font), and published as a light/dark pair that a
 * `<picture>` element chooses between. Every figure is accessible: `role="img"`
 * with a `<title>` and a `<desc>` that states the figure's whole content in
 * words, so the picture never holds a fact the text does not.
 *
 * Text is set in the design system's face first, then the reader's own sans:
 * an image cannot load a web font, so layouts leave room for a wider fallback
 * and never fit text tightly.
 */
import { escapeHtml } from "./markup.ts";
import { THEMES, themeColor, type ThemeName, type TokenOwner } from "./token-reader.ts";

/** A figure's refusal, by code. */
export class FigureError extends Error {
  readonly code: "figure_id_invalid";
  constructor(code: "figure_id_invalid", message: string) {
    super(`${code}: ${message}`);
    this.name = "FigureError";
    this.code = code;
  }
}

/** The shape of an inline figure's id prefix: it is spliced into ids and `url(#…)` references, so it is a plain name. */
const FIGURE_ID = /^[a-z][a-z\d-]*$/u;

/** Each theme as a `<picture>` source names it. */
export const FIGURE_SCHEMES: Readonly<Record<ThemeName, "light" | "dark">> = Object.freeze({ logbook: "light", carbon: "dark" });

const SANS = "'IBM Plex Sans', 'IBM Plex Sans Variable', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";
const MONO = "'IBM Plex Mono', 'IBM Plex Mono Variable', ui-monospace, 'SF Mono', 'Cascadia Code', monospace";

const x = escapeHtml;
const n = (value: number): string => (Number.isInteger(value) ? String(value) : value.toFixed(2));

/** A figure's frame: the accessible SVG root around `body`, on the theme's ground. */
export function figureDocument(o: Readonly<{ width: number; height: number; title: string; desc: string; body: string; ground: string }>): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${n(o.width)}" height="${n(o.height)}" viewBox="0 0 ${n(o.width)} ${n(o.height)}" role="img" aria-labelledby="t d">`,
    `<title id="t">${x(o.title)}</title>`,
    `<desc id="d">${x(o.desc)}</desc>`,
    `<rect width="${n(o.width)}" height="${n(o.height)}" rx="6" fill="${o.ground}"/>`,
    o.body,
    "</svg>",
    "",
  ].join("\n");
}

/** One part of a whole: its words, its count, the token that inks it, and whether it is hatched (a second encoding beside colour). */
export interface Part {
  readonly label: string;
  readonly count: number;
  readonly ink: string;
  readonly hatched?: boolean;
}

export interface PartBar {
  /** The figure's headline, e.g. "175 decision records". */
  readonly title: string;
  /** What the parts divide, e.g. "by how far each is built". */
  readonly subtitle: string;
  readonly parts: readonly Part[];
  /** Where the numbers come from (set in mono at the foot). */
  readonly source: string;
}

/** The figure's facts in one sentence: its `<desc>`, its alt text and its table view. */
export function partBarSentence(bar: PartBar): string {
  return `${bar.title}, ${bar.subtitle}: ${bar.parts.map((part) => `${String(part.count)} ${part.label}`).join("; ")}. Source: ${bar.source}.`;
}

const WIDTH = 760;
const PAD = 24;
const BAR_Y = 64;
const BAR_H = 22;
const GAP = 2;

/**
 * A whole divided into its parts as one bar: every part drawn to scale with a
 * surface gap between neighbours, labelled directly underneath with its words
 * and count (identity is never colour alone; a hatched part is hatched too).
 */
export function partBarFigure(bar: PartBar, owner: TokenOwner, theme: ThemeName): string {
  const ink = (name: string): string => themeColor(owner, theme, name);
  const ground = ink("--ground-0");
  const total = bar.parts.reduce((sum, part) => sum + part.count, 0);
  const span = WIDTH - PAD * 2;
  const drawn = bar.parts.filter((part) => part.count > 0);
  const usable = span - GAP * (drawn.length - 1);
  let at = PAD;
  const defs: string[] = [];
  const marks = drawn.map((part, index) => {
    const width = total === 0 ? 0 : (usable * part.count) / total;
    const fill = ink(part.ink);
    let paint = fill;
    if (part.hatched === true) {
      const id = `h${String(index)}`;
      defs.push(`<pattern id="${id}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="${ground}"/><rect width="3" height="6" fill="${fill}"/></pattern>`);
      paint = `url(#${id})`;
    }
    const rect = `<rect x="${n(at)}" y="${n(BAR_Y)}" width="${n(Math.max(width, 1))}" height="${n(BAR_H)}" fill="${paint}"${part.hatched === true ? ` stroke="${fill}" stroke-width="1"` : ""}/>`;
    at += width + GAP;
    return rect;
  });
  // The ends of the whole are rounded once, by clipping, so a part keeps square inner edges.
  defs.push(`<clipPath id="c"><rect x="${n(PAD)}" y="${n(BAR_Y)}" width="${n(span)}" height="${n(BAR_H)}" rx="4"/></clipPath>`);
  const columns = bar.parts.length;
  const column = span / columns;
  const legend = bar.parts.map((part, index) => {
    const left = PAD + column * index;
    const fill = ink(part.ink);
    const swatch = part.hatched === true
      ? `<rect x="${n(left)}" y="110" width="12" height="12" rx="2" fill="url(#hl${String(index)})" stroke="${fill}" stroke-width="1"/>`
      : `<rect x="${n(left)}" y="110" width="12" height="12" rx="2" fill="${fill}"/>`;
    if (part.hatched === true) defs.push(`<pattern id="hl${String(index)}" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="4" height="4" fill="${ground}"/><rect width="2" height="4" fill="${fill}"/></pattern>`);
    return [
      swatch,
      `<text x="${n(left + 20)}" y="121" font-family="${SANS}" font-size="20" font-weight="600" fill="${ink("--ink-1")}" dy="0">${String(part.count)}</text>`,
      `<text x="${n(left + 20)}" y="146" font-family="${SANS}" font-size="13" fill="${ink("--ink-2")}">${x(part.label)}</text>`,
    ].join("");
  });
  const body = [
    `<defs>${defs.join("")}</defs>`,
    `<text x="${n(PAD)}" y="40" font-family="${SANS}" font-size="18" font-weight="600" fill="${ink("--ink-1")}">${x(bar.title)}</text>`,
    `<text x="${n(WIDTH - PAD)}" y="40" text-anchor="end" font-family="${SANS}" font-size="14" fill="${ink("--ink-2")}">${x(bar.subtitle)}</text>`,
    `<g clip-path="url(#c)">${marks.join("")}</g>`,
    ...legend,
    `<line x1="${n(PAD)}" y1="168" x2="${n(WIDTH - PAD)}" y2="168" stroke="${ink("--line-2")}" stroke-width="1" stroke-dasharray="3 3"/>`,
    `<text x="${n(PAD)}" y="188" font-family="${MONO}" font-size="12" fill="${ink("--ink-2")}">${x(bar.source)}</text>`,
  ].join("\n");
  return figureDocument({ width: WIDTH, height: 204, title: `${bar.title}, ${bar.subtitle}`, desc: partBarSentence(bar), body, ground });
}

/** A figure's two files' names: `<stem>-light.svg` and `<stem>-dark.svg`. */
export function figureFiles(stem: string): Readonly<Record<ThemeName, string>> {
  return Object.freeze(Object.fromEntries(THEMES.map((theme) => [theme, `${stem}-${FIGURE_SCHEMES[theme]}.svg`])) as Record<ThemeName, string>);
}

/**
 * The `<picture>` that shows a figure pair in the reader's scheme (GitHub
 * honours `prefers-color-scheme` on a README `<source>`), with the figure's
 * sentence as its alt text.
 */
export function figurePicture(directory: string, stem: string, alt: string): string {
  const files = figureFiles(stem);
  return [
    "<picture>",
    `  <source media="(prefers-color-scheme: dark)" srcset="${x(`${directory}/${files.carbon}`)}">`,
    `  <img alt="${x(alt)}" src="${x(`${directory}/${files.logbook}`)}" width="760">`,
    "</picture>",
  ].join("\n");
}

/** A boxes-and-arrows figure, declared as data (`docs/_data/figures/<name>.json`, schema `bridlewise-figure/v1`). */
export interface BoxFigure {
  readonly schema: "bridlewise-figure/v1";
  readonly kind: "boxes";
  readonly title: string;
  readonly desc: string;
  readonly width: number;
  readonly height: number;
  readonly heading: string;
  readonly aside: string;
  readonly foot: string;
  readonly boxes: readonly Readonly<{ x: number; y: number; w: number; h: number; title: string; lines: readonly string[]; tag?: string; accent?: boolean }>[];
  readonly edges: readonly Readonly<{ d: string; label?: string; at?: readonly [number, number]; muted?: boolean }>[];
}

/** Every way `value` breaks the boxes figure's shape (a typed refusal names them all). */
export function boxFigureViolations(value: unknown): readonly string[] {
  const problems: string[] = [];
  const figure = value as Partial<BoxFigure> | null;
  if (typeof figure !== "object" || figure === null) return ["the figure is not a JSON object"];
  if (figure.schema !== "bridlewise-figure/v1" || figure.kind !== "boxes") problems.push("schema must be bridlewise-figure/v1 and kind boxes");
  for (const key of ["title", "desc", "heading", "aside", "foot"] as const) if (typeof figure[key] !== "string" || figure[key].trim() === "") problems.push(`${key} is required text`);
  if (!(typeof figure.width === "number" && figure.width > 0 && typeof figure.height === "number" && figure.height > 0)) problems.push("width and height are positive numbers");
  if (!Array.isArray(figure.boxes) || figure.boxes.length === 0) problems.push("boxes is a non-empty list");
  else figure.boxes.forEach((box, index) => {
    if (![box.x, box.y, box.w, box.h].every((v) => typeof v === "number")) problems.push(`boxes[${String(index)}] needs x, y, w, h`);
    else if (box.x + box.w > (figure.width ?? 0) || box.y + box.h > (figure.height ?? 0)) problems.push(`boxes[${String(index)}] (${box.title}) leaves the figure`);
    if (typeof box.title !== "string" || !Array.isArray(box.lines)) problems.push(`boxes[${String(index)}] needs a title and lines`);
    else if (50 + (box.lines.length + (box.tag === undefined ? 0 : 1)) * 17 > box.h + 8) problems.push(`boxes[${String(index)}] (${box.title}) is too short for its lines${box.tag === undefined ? "" : " and tag"}`);
  });
  if (!Array.isArray(figure.edges)) problems.push("edges is a list");
  else figure.edges.forEach((edge, index) => {
    if (typeof edge.d !== "string" || !/^M [\d. ]+(?: L [\d. ]+)+$/u.test(edge.d)) problems.push(`edges[${String(index)}].d must be a straight path (M x y L x y …)`);
    if ((edge.label === undefined) !== (edge.at === undefined)) problems.push(`edges[${String(index)}] has a label and its place together, or neither`);
  });
  return problems;
}

/**
 * A boxes figure as an INLINE SVG for the site: no colour in it, every part a
 * `fig-*` class the site's stylesheet inks from the live theme's tokens, so
 * it follows the theme switch like the page around it. `id` prefixes the
 * figure's own ids (one page may hold several figures).
 */
export function boxFigureInline(figure: BoxFigure, id: string): string {
  if (!FIGURE_ID.test(id)) throw new FigureError("figure_id_invalid", `${JSON.stringify(id)} is not a figure id (lower-case letters, digits and hyphens, starting with a letter)`);
  const t = (cls: string, at: readonly [number, number], text: string, anchor = ""): string =>
    `<text class="${cls}" x="${n(at[0])}" y="${n(at[1])}"${anchor}>${x(text)}</text>`;
  const boxes = figure.boxes.map((box) => [
    `<rect class="${box.accent === true ? "fig-box fig-box-accent" : "fig-box"}" x="${n(box.x)}" y="${n(box.y)}" width="${n(box.w)}" height="${n(box.h)}" rx="4"/>`,
    t("fig-label", [box.x + 16, box.y + 26], box.title),
    ...box.lines.map((line, index) => t("fig-note", [box.x + 16, box.y + 46 + index * 17], line)),
    ...(box.tag === undefined ? [] : [t("fig-tag", [box.x + 16, box.y + 50 + box.lines.length * 17], box.tag)]),
  ].join(""));
  const edges = figure.edges.map((edge) => [
    `<path class="${edge.muted === true ? "fig-edge fig-edge-muted" : "fig-edge"}" d="${x(edge.d)}" marker-end="url(#${id}-${edge.muted === true ? "arrow-muted" : "arrow"})"/>`,
    ...(edge.label === undefined || edge.at === undefined ? [] : [t("fig-tag", edge.at, edge.label)]),
  ].join(""));
  const arrow = (name: string, cls: string): string => `<marker id="${id}-${name}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="${cls}" d="M 0 0 L 10 5 L 0 10 z"/></marker>`;
  return [
    `<svg class="fig" viewBox="0 0 ${n(figure.width)} ${n(figure.height)}" role="img" aria-labelledby="${id}-t ${id}-d">`,
    `<title id="${id}-t">${x(figure.title)}</title><desc id="${id}-d">${x(figure.desc)}</desc>`,
    `<defs>${arrow("arrow", "fig-arrow")}${arrow("arrow-muted", "fig-arrow-muted")}</defs>`,
    `<rect class="fig-ground" width="${n(figure.width)}" height="${n(figure.height)}" rx="6"/>`,
    t("fig-heading", [28, 34], figure.heading),
    t("fig-tag", [figure.width - 28, 34], figure.aside, ' text-anchor="end"'),
    `<line class="fig-rule" x1="28" y1="46" x2="${n(figure.width - 28)}" y2="46"/>`,
    ...boxes,
    ...edges,
    t("fig-tag", [28, figure.height - 20], figure.foot),
    "</svg>",
  ].join("\n");
}
