/**
 * THE brand mark's geometry AND its palette: one declaration on a 32-unit
 * grid, each part naming the token that colours it. Read by the cockpit's
 * `Brand.svelte` (each part painted with `inkOf(part.ink)`, the live theme's
 * value) and by `scripts/generate-pwa-icons.mjs` (the icon files, in the
 * token owner's Carbon values). Nothing else restates a coordinate or a
 * part's colour (tests/cockpit/brand-mark-owner.test.ts).
 *
 * The mark is the bridle: a rein (the vertical stroke) with three record
 * lines, and the one live beam where the rein is held. Each part names the
 * token that colours it; no colour value lives here.
 */
type Point = readonly [number, number];
interface Stroke { readonly from: Point; readonly to: Point; readonly ink: string }
interface Mark {
  readonly grid: number;
  readonly tileRadius: number;
  readonly stroke: number;
  readonly tile: string;
  readonly rein: Stroke;
  readonly lines: readonly Stroke[];
  readonly beam: { readonly at: Point; readonly r: number; readonly ink: string };
}

const MARK: Mark = {
  grid: 32,
  tileRadius: 6,
  stroke: 1.6,
  tile: "--ground-0",
  rein: { from: [8, 7], to: [8, 25], ink: "--ink-1" },
  lines: [
    { from: [14, 10], to: [25, 10], ink: "--ink-2" },
    { from: [14, 16], to: [21, 16], ink: "--ink-2" },
    { from: [14, 22], to: [25, 22], ink: "--ink-2" },
  ],
  beam: { at: [8, 16], r: 2.5, ink: "--beam" },
};

export const BRAND_MARK: Mark = Object.freeze(MARK);

/** An SVG path for one stroke of the mark. */
export function strokePath(stroke: Stroke): string {
  return `M${stroke.from[0]} ${stroke.from[1]}L${stroke.to[0]} ${stroke.to[1]}`;
}

/** A part's colour as the cockpit paints it: the token the geometry names, read live (the theme decides its value). */
export function inkOf(token: string): string {
  return `var(${token})`;
}
