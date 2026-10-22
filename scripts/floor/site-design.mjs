/**
 * THE SITE'S DESIGN ASSETS — generated at build time from the one design
 * system, so the site holds no second copy of it.
 *
 * `writeSiteDesign` writes, into the Jekyll source the builder assembles:
 *
 * - `assets/css/tokens.css`: the token sheet (`shared/token-reader.ts`
 *   `tokenSheet`) — exactly the tokens the shell's stylesheets read, and what
 *   those read, from `src/cockpit/tokens.css`, with Logbook (paper) as the
 *   lead theme on `:root` and Carbon behind `[data-theme="carbon"]`. A
 *   stylesheet that reads a name the owner does not declare refuses the build
 *   (`token_undeclared`).
 * - `assets/fonts/`: the self-hosted IBM Plex files the owner's `@font-face`
 *   blocks name (`public/fonts/`), with their licence.
 * - `_includes/brand-mark.svg`: the mark drawn from its one geometry
 *   (`src/cockpit/shell/brand-mark.ts`), each part carrying a class the
 *   stylesheet inks from the live theme's tokens.
 * - `_includes/design-head.html`: the head's design links — the token sheet,
 *   a preload for each upright face (the first paint's text), and the lead
 *   theme's ground as the browser's `theme-color`.
 *
 * The layout includes the two includes; nothing here is committed.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { BRAND_MARK, strokePath } from "../../src/cockpit/shell/brand-mark.ts";
import { escapeHtml } from "../../shared/markup.ts";
import { readNames, readTokenOwner, themeColor, tokenSheet } from "../../shared/token-reader.ts";
import { SHARED_CSS } from "./design-coverage.mjs";

export const TOKEN_OWNER = "src/cockpit/tokens.css";
export const SITE_TOKEN_SHEET = "assets/css/tokens.css";
export const SITE_FONTS = "assets/fonts";
export const MARK_INCLUDE = "_includes/brand-mark.svg";
export const HEAD_INCLUDE = "_includes/design-head.html";
/** The site's attribute for an explicit theme choice; its absence is the lead theme. */
export const THEME_ATTRIBUTE = "data-theme";
export const LEAD_THEME = "logbook";

/** Where the app serves `public/`: the owner's `url("/fonts/…")` names `public/fonts/…`. */
const PUBLIC_ROOT = "public";
const FONT_LICENCE = "public/fonts/OFL.txt";

function write(outRoot, path, text) {
  const target = join(outRoot, ...path.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
}

/** Each `@font-face` source the owner declares: its `public/` path, served name and style. */
function fontFiles(owner) {
  return owner.fontFaces.map((face) => {
    const url = /url\(\s*"([^"]+)"\s*\)/u.exec(face)?.[1];
    if (url === undefined || !url.startsWith("/")) throw new Error(`the token owner's @font-face has no root-relative url: ${face}`);
    return { ownerUrl: url, source: `${PUBLIC_ROOT}${url}`, name: url.split("/").pop(), upright: /font-style:\s*normal/u.test(face) };
  });
}

/** The mark as an inline SVG whose parts the site inks by class (`brand-mark-*`). */
export function markInclude(mark = BRAND_MARK) {
  const stroke = (part, className) => `<path class="${className}" d="${strokePath(part)}" fill="none" stroke-width="${mark.stroke}" stroke-linecap="round"/>`;
  return [
    `<svg class="brand-mark" viewBox="0 0 ${mark.grid} ${mark.grid}" aria-hidden="true" focusable="false">`,
    stroke(mark.rein, "brand-mark-rein"),
    ...mark.lines.map((line) => stroke(line, "brand-mark-line")),
    `<circle class="brand-mark-beam" cx="${mark.beam.at[0]}" cy="${mark.beam.at[1]}" r="${mark.beam.r}"/>`,
    "</svg>",
  ].join("");
}

/** The stylesheets the shell loads, read from the assembled source. */
function shellStylesheets(outRoot) {
  return SHARED_CSS.map((path) => readFileSync(join(outRoot, ...path.split("/")), "utf8"));
}

/** Writes the design assets (see the header) into the Jekyll source at `outRoot`. */
export function writeSiteDesign({ root, outRoot }) {
  const owner = readTokenOwner(readFileSync(join(root, TOKEN_OWNER), "utf8"));
  const used = new Set(shellStylesheets(outRoot).flatMap((css) => [...readNames(css)]));
  const fontsUrl = `../${SITE_FONTS.split("/").pop()}`;
  write(outRoot, SITE_TOKEN_SHEET, tokenSheet(owner, used, {
    themeAttribute: THEME_ATTRIBUTE,
    lead: LEAD_THEME,
    fontUrl: (url) => `${fontsUrl}/${url.split("/").pop()}`,
    banner: `GENERATED from ${TOKEN_OWNER} by scripts/floor/site-design.mjs: edit the owner, never this file.`,
  }));

  const fonts = fontFiles(owner);
  mkdirSync(join(outRoot, ...SITE_FONTS.split("/")), { recursive: true });
  for (const font of fonts) copyFileSync(join(root, font.source), join(outRoot, ...SITE_FONTS.split("/"), font.name));
  copyFileSync(join(root, FONT_LICENCE), join(outRoot, ...SITE_FONTS.split("/"), "OFL.txt"));

  write(outRoot, MARK_INCLUDE, markInclude());
  const preloads = fonts
    .filter((font) => font.upright)
    .map((font) => `<link rel="preload" href="{{ '/${SITE_FONTS}/${font.name}' | relative_url }}" as="font" type="font/woff2" crossorigin>`);
  write(outRoot, HEAD_INCLUDE, [
    `<meta name="theme-color" content="${escapeHtml(themeColor(owner, LEAD_THEME, "--ground-0"))}">`,
    ...preloads,
    `<link rel="stylesheet" href="{{ '/${SITE_TOKEN_SHEET}' | relative_url }}">`,
    "",
  ].join("\n"));
  return { tokens: used.size, fonts: fonts.length };
}
