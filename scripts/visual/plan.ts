/**
 * THE VISUAL REGRESSION PLAN — which pages are shot, in which themes and at
 * which sizes, and what is volatile on them. Pure data and pure judgements;
 * `screens.ts` runs it. What every page must hold (it fits, it does not
 * shift, it has its landmarks, its faces loaded, its colours are tokens) is
 * the one rendered table's (`scripts/rendered/rules.ts`), judged on every
 * built page; this check only compares pictures.
 *
 * The comparison is deterministic by construction: the base commit's site
 * and the head commit's site are built from their own trees and shot by the
 * same browser on the same machine in the same run, so identical markup and
 * styles give identical bytes. No baseline image is stored anywhere.
 */

import { THEMES as OWNER_THEMES, type ThemeName } from "../../shared/token-reader.ts";

export type Theme = ThemeName;

export interface Viewport {
  readonly name: string;
  readonly width: number;
  readonly height: number;
}

/** The site's key pages: the front door, the reading pages, the ledgers, the generated dashboards. */
export const PAGES: readonly string[] = Object.freeze([
  "/",
  "/quickstart/",
  "/architecture/",
  "/security/",
  "/decisions/",
  "/floor/",
  "/floor/status/",
  "/floor/roadmap/",
]);

/** Both of the owner's themes: Logbook leads (no attribute); Carbon is the remembered choice. */
export const THEMES: readonly Theme[] = OWNER_THEMES;


export const VIEWPORTS: readonly Viewport[] = Object.freeze([
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "phone", width: 390, height: 844 },
]);

/**
 * What differs between two commits without being design: a commit id, a
 * build time, a snapshot's time and source commit (both sites carry offline
 * floor snapshots, so no live run enters a picture). Masked in both shots (painted one flat box),
 * so the comparison judges the page, not the clock.
 */
export const VOLATILE_SELECTORS: readonly string[] = Object.freeze([
  "[data-volatile]",
  "[data-commit]",
  "[data-floor-status] dd",
  // The fallback callout quotes the offline snapshot's reason, which carries its generation time.
  "[data-status-fallback]",
  ".stamp",
  "time",
]);

/** Motion is frozen for a shot: a moving page has no single picture. */
export const FREEZE_CSS = "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }";

/**
 * Chromium rasterising one way every time. No GPU process (`--disable-gpu`
 * alone still spawns one); one raster thread and no partial raster, because
 * threaded tile raster painted a rounded border's edge differently on 1 load
 * in 24 (measured: 12 pixels of 11.1 million on the quickstart page; with
 * these flags, 24 of 24 loads across three launches were byte-identical);
 * an sRGB colour profile and greyscale text, so no host setting enters the
 * picture.
 */
export const BROWSER_ARGS: readonly string[] = Object.freeze([
  "--disable-gpu", "--disable-gpu-compositing", "--in-process-gpu",
  "--num-raster-threads=1", "--disable-partial-raster", "--disable-skia-runtime-opts",
  "--force-color-profile=srgb", "--disable-lcd-text", "--font-render-hinting=none",
]);

/** One shot's identity: page, theme, viewport. */
export interface Shot {
  readonly page: string;
  readonly theme: Theme;
  readonly viewport: Viewport;
}

/** The whole matrix, in a stable order. */
export function shots(pages: readonly string[] = PAGES): readonly Shot[] {
  return pages.flatMap((page) => THEMES.flatMap((theme) => VIEWPORTS.map((viewport) => ({ page, theme, viewport }))));
}

/** A shot's file name: stable, readable, one per matrix cell. */
export function shotName(shot: Shot): string {
  const page = shot.page === "/" ? "home" : shot.page.replace(/^\/|\/$/gu, "").replace(/[^a-z0-9]+/giu, "-").toLowerCase();
  return `${page}--${shot.theme}--${shot.viewport.name}.png`;
}

export type Verdict = "same" | "changed" | "added" | "removed" | "unstable";

/** A compared shot, as the report and the gate read it. */
export interface Comparison {
  readonly name: string;
  readonly verdict: Verdict;
  readonly changedPixels: number;
  readonly totalPixels: number;
}

/**
 * The gate: an unstable shot always fails; a visual
 * change fails unless the change was declared (the pull request carries the
 * `visual-change` label), because a page that changes look without anyone
 * saying so is how a design stops being one.
 */
export function gate(comparisons: readonly Comparison[], { changeDeclared }: { changeDeclared: boolean }): Readonly<{ pass: boolean; reasons: readonly string[] }> {
  const reasons: string[] = [];
  for (const comparison of comparisons) {
    if (comparison.verdict === "unstable") reasons.push(`${comparison.name}: two shots of the same page differ, so the page has no single picture (nondeterministic render)`);
  }
  const changed = comparisons.filter((comparison) => comparison.verdict === "changed" || comparison.verdict === "added" || comparison.verdict === "removed");
  if (changed.length > 0 && !changeDeclared) {
    reasons.push(`${String(changed.length)} shot(s) changed and the change is not declared: review the report, then add the \`visual-change\` label to accept it`);
  }
  return { pass: reasons.length === 0, reasons };
}
