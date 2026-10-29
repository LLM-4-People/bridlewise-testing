/**
 * THE GENERATED FIGURES — SVG drawn in the design system for the site, INLINE
 * in the page: no colour in the markup, every mark a `fig-*` class the site's
 * stylesheet inks from the live theme's tokens, so a figure follows the theme
 * switch like the page around it. A figure whose numbers are counted (the
 * decision-status bar) is drawn when the site is built, from the records it
 * counts, and never committed: a committed count is an aggregate every change
 * to the records would rewrite (#527). Every figure is accessible: `role="img"`
 * with a `<title>` and a `<desc>` that states the figure's whole content in
 * words, so the picture never holds a fact the text does not.
 */
import { escapeHtml } from "./markup.ts";

/** A figure's refusal, by code. */
export class FigureError extends Error {
  readonly code: "figure_id_invalid" | "figure_ink_unknown";
  constructor(code: "figure_id_invalid" | "figure_ink_unknown", message: string) {
    super(`${code}: ${message}`);
    this.name = "FigureError";
    this.code = code;
  }
}

/** The shape of an inline figure's id prefix: it is spliced into ids and `url(#…)` references, so it is a plain name. */
const FIGURE_ID = /^[a-z][a-z\d-]*$/u;

const x = escapeHtml;
const n = (value: number): string => (Number.isInteger(value) ? String(value) : value.toFixed(2));

/**
 * The tokens a part may be inked with, each with the class the site's
 * stylesheet inks it by (`fig-fill-*` paints a part, `fig-line-*` outlines a
 * hatched one): the figure itself carries no colour, so it follows the theme
 * switch like the page around it.
 */
export const PART_INKS = Object.freeze({ "--ok": "ok", "--warn": "warn", "--alarm": "alarm", "--ink-2": "quiet" } as const);
export type PartInk = keyof typeof PART_INKS;

/** One part of a whole: its words, its count, the token that inks it, and whether it is hatched (a second encoding beside colour). */
export interface Part {
  readonly label: string;
  readonly count: number;
  readonly ink: PartInk;
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

/** The figure's facts in one sentence: its `<desc>`, so the picture never holds a fact the text does not. */
export function partBarSentence(bar: PartBar): string {
  return `${bar.title}, ${bar.subtitle}: ${bar.parts.map((part) => `${String(part.count)} ${part.label}`).join("; ")}. Source: ${bar.source}.`;
}

const WIDTH = 760;
const HEIGHT = 204;
const PAD = 24;
const BAR_Y = 64;
const BAR_H = 22;
const GAP = 2;

/**
 * A whole divided into its parts as one bar, as an INLINE SVG for the site:
 * every part drawn to scale with a surface gap between neighbours, labelled
 * directly underneath with its words and count (identity is never colour
 * alone; a hatched part is hatched too). No colour is in the markup: every
 * mark is a `fig-*` class the stylesheet inks from the live theme's tokens.
 * Drawn when the site is built, from the records it counts, never committed.
 * `id` prefixes the figure's own ids (one page may hold several figures).
 */
export function partBarInline(bar: PartBar, id: string): string {
  if (!FIGURE_ID.test(id)) throw new FigureError("figure_id_invalid", `${JSON.stringify(id)} is not a figure id (lower-case letters, digits and hyphens, starting with a letter)`);
  for (const part of bar.parts) {
    if (!Object.hasOwn(PART_INKS, part.ink)) throw new FigureError("figure_ink_unknown", `${JSON.stringify(part.ink)} inks no part (one of ${Object.keys(PART_INKS).join(", ")})`);
  }
  const total = bar.parts.reduce((sum, part) => sum + part.count, 0);
  const span = WIDTH - PAD * 2;
  const drawn = bar.parts.map((part, index) => ({ part, index })).filter(({ part }) => part.count > 0);
  const usable = span - GAP * (drawn.length - 1);
  const hatch = (index: number, size: number, ink: string): string =>
    `<pattern id="${id}-h${String(index)}-${String(size)}" width="${String(size)}" height="${String(size)}" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect class="fig-ground" width="${String(size)}" height="${String(size)}"/><rect class="fig-fill-${ink}" width="${String(size / 2)}" height="${String(size)}"/></pattern>`;
  const defs: string[] = [];
  const paint = (part: Part, index: number, size: number): string => {
    const ink = PART_INKS[part.ink];
    if (part.hatched !== true) return `class="fig-fill-${ink}"`;
    defs.push(hatch(index, size, ink));
    return `class="fig-line-${ink}" fill="url(#${id}-h${String(index)}-${String(size)})"`;
  };
  let at = PAD;
  const marks = drawn.map(({ part, index }) => {
    const width = total === 0 ? 0 : (usable * part.count) / total;
    const rect = `<rect x="${n(at)}" y="${n(BAR_Y)}" width="${n(Math.max(width, 1))}" height="${n(BAR_H)}" ${paint(part, index, 6)}/>`;
    at += width + GAP;
    return rect;
  });
  // The ends of the whole are rounded once, by clipping, so a part keeps square inner edges.
  defs.push(`<clipPath id="${id}-c"><rect x="${n(PAD)}" y="${n(BAR_Y)}" width="${n(span)}" height="${n(BAR_H)}" rx="4"/></clipPath>`);
  const column = span / bar.parts.length;
  const legend = bar.parts.map((part, index) => {
    const left = PAD + column * index;
    return [
      `<rect x="${n(left)}" y="110" width="12" height="12" rx="2" ${paint(part, index, 4)}/>`,
      `<text class="fig-count" x="${n(left + 20)}" y="121">${String(part.count)}</text>`,
      `<text class="fig-note" x="${n(left + 20)}" y="146">${x(part.label)}</text>`,
    ].join("");
  });
  return [
    `<svg class="fig" viewBox="0 0 ${n(WIDTH)} ${n(HEIGHT)}" role="img" aria-labelledby="${id}-t ${id}-d">`,
    `<title id="${id}-t">${x(`${bar.title}, ${bar.subtitle}`)}</title><desc id="${id}-d">${x(partBarSentence(bar))}</desc>`,
    `<rect class="fig-ground" width="${n(WIDTH)}" height="${n(HEIGHT)}" rx="6"/>`,
    `<defs>${defs.join("")}</defs>`,
    `<text class="fig-heading" x="${n(PAD)}" y="40">${x(bar.title)}</text>`,
    `<text class="fig-tag" x="${n(WIDTH - PAD)}" y="40" text-anchor="end">${x(bar.subtitle)}</text>`,
    `<g clip-path="url(#${id}-c)">${marks.join("")}</g>`,
    ...legend,
    `<line class="fig-rule" x1="${n(PAD)}" y1="168" x2="${n(WIDTH - PAD)}" y2="168"/>`,
    `<text class="fig-tag" x="${n(PAD)}" y="188">${x(bar.source)}</text>`,
    "</svg>",
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
