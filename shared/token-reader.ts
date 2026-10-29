/**
 * THE TOKEN OWNER, READ AS DATA — for every surface outside the cockpit.
 *
 * `src/cockpit/tokens.css` is the ONE design system: every colour, face,
 * space and duration is declared there once. The cockpit consumes it as a
 * stylesheet. The other surfaces cannot: the Pages site is a separate static
 * build, an SVG drawn for a GitHub README is served without any stylesheet
 * (GitHub strips CSS), and an icon or social image is a file of concrete
 * colours. Each used to restate the palette it needed, and each copy drifted
 * (the site's Logbook ground was `#f4f0e6` while the owner's is `#f6f4ef`).
 *
 * This module is the one door between the owner and those surfaces:
 *
 * - `readTokenOwner(css)` parses the owner into its declarations: the base
 *   (every plain top-level `:root` block, in order — Carbon), the Logbook
 *   re-derivation (`:root[data-cockpit-theme="light"]`), the top-level
 *   `@media` remaps, and the `@font-face` blocks.
 * - `themeTokens(owner, theme)` is one theme's full declaration map.
 * - `resolveToken(values, name)` follows `var()` to the authored value.
 * - `concreteColor(value)` turns an authored colour (hex, `rgb[a]()`,
 *   `oklch()`, `color-mix(in srgb, …)`) into `#rrggbb[aa]`, for a file that
 *   cannot hold a CSS colour function.
 * - `tokenSheet(owner, used, options)` writes the stylesheet a static surface
 *   loads: only the tokens its own CSS reads (and what those read), with the
 *   lead theme on `:root` and the other behind `[data-theme]`.
 *
 * Nothing here holds a colour or a length. A name the owner does not declare
 * is a typed refusal (`TokenOwnerError`), never a quiet substitute.
 */

/** The owner's two themes: Logbook (paper) and Carbon. The list owns the type. */
export const THEMES = Object.freeze(["logbook", "carbon"] as const);
export type ThemeName = typeof THEMES[number];

/** The owner's own selector for its light re-derivation. */
const LOGBOOK_SELECTOR = ':root[data-cockpit-theme="light"]';

export interface MediaRemap {
  readonly query: string;
  readonly values: ReadonlyMap<string, string>;
}

export interface TokenOwner {
  /** Every plain top-level `:root` declaration, in order (the Carbon base). */
  readonly base: ReadonlyMap<string, string>;
  /** The Logbook theme's re-derived declarations only. */
  readonly logbook: ReadonlyMap<string, string>;
  /** Top-level `@media (…) { :root { … } }` remaps, in order. */
  readonly media: readonly MediaRemap[];
  /** Every `@font-face` block, verbatim (comments removed). */
  readonly fontFaces: readonly string[];
}

export type TokenRefusal =
  | "token_owner_unreadable"
  | "token_undeclared"
  | "token_cycle"
  | "token_color_unsupported"
  | "token_face_display_missing";

export class TokenOwnerError extends Error {
  readonly code: TokenRefusal;
  constructor(code: TokenRefusal, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
    this.name = "TokenOwnerError";
  }
}

interface Block {
  readonly prelude: string;
  readonly body: string;
}

/** The top-level `prelude { body }` blocks of a comment-free stylesheet. */
function blocksOf(css: string): Block[] {
  const blocks: Block[] = [];
  let index = 0;
  while (index < css.length) {
    const open = css.indexOf("{", index);
    if (open === -1) {
      if (css.slice(index).trim() !== "") throw new TokenOwnerError("token_owner_unreadable", `trailing text outside a block: ${css.slice(index).trim().slice(0, 60)}`);
      break;
    }
    let depth = 1;
    let cursor = open + 1;
    while (cursor < css.length && depth > 0) {
      const char = css[cursor];
      if (char === "{") depth += 1;
      else if (char === "}") depth -= 1;
      cursor += 1;
    }
    if (depth !== 0) throw new TokenOwnerError("token_owner_unreadable", `an unclosed block opens at offset ${String(open)}`);
    blocks.push({ prelude: css.slice(index, open).trim(), body: css.slice(open + 1, cursor - 1) });
    index = cursor;
  }
  return blocks;
}

/** The `--name: value` declarations of a block body, in order. */
function declarationsOf(body: string): Map<string, string> {
  const values = new Map<string, string>();
  let depth = 0;
  let start = 0;
  const take = (end: number): void => {
    const text = body.slice(start, end).trim();
    const colon = text.indexOf(":");
    const name = text.slice(0, colon).trim();
    if (colon > 0 && /^--[\w-]+$/u.test(name)) values.set(name, text.slice(colon + 1).replace(/\s+/gu, " ").trim());
  };
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === ";" && depth === 0) {
      take(index);
      start = index + 1;
    }
  }
  take(body.length);
  return values;
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//gu, "");
}

/** The owner's declarations (see the header). */
export function readTokenOwner(css: string): TokenOwner {
  const base = new Map<string, string>();
  const logbook = new Map<string, string>();
  const media: MediaRemap[] = [];
  const fontFaces: string[] = [];
  for (const block of blocksOf(stripComments(css))) {
    if (block.prelude === ":root") {
      for (const [name, value] of declarationsOf(block.body)) base.set(name, value);
    } else if (block.prelude === LOGBOOK_SELECTOR) {
      for (const [name, value] of declarationsOf(block.body)) logbook.set(name, value);
    } else if (block.prelude === "@font-face") {
      fontFaces.push(`@font-face {\n${block.body.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => `  ${line}`).join("\n")}\n}`);
    } else if (block.prelude.startsWith("@media")) {
      const values = new Map<string, string>();
      for (const inner of blocksOf(block.body)) {
        if (inner.prelude === ":root") for (const [name, value] of declarationsOf(inner.body)) values.set(name, value);
      }
      if (values.size > 0) media.push({ query: block.prelude.slice("@media".length).trim(), values });
    }
  }
  if (base.size === 0) throw new TokenOwnerError("token_owner_unreadable", "the owner declares no :root token");
  return { base, logbook, media, fontFaces };
}

/**
 * One theme's complete declaration map: the base, with Logbook's
 * re-derivations on top. Asking for Logbook of an owner that declares no
 * Logbook block is refused, never answered with Carbon.
 */
export function themeTokens(owner: TokenOwner, theme: ThemeName): ReadonlyMap<string, string> {
  if (theme === "carbon") return owner.base;
  if (owner.logbook.size === 0) throw new TokenOwnerError("token_owner_unreadable", `the owner declares no ${LOGBOOK_SELECTOR} theme`);
  return new Map([...owner.base, ...owner.logbook]);
}

const VAR = /var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/u;

/** `name`'s authored value with every `var()` followed, in `values`. */
export function resolveToken(values: ReadonlyMap<string, string>, name: string, trail: readonly string[] = []): string {
  if (trail.includes(name)) throw new TokenOwnerError("token_cycle", [...trail, name].join(" → "));
  const value = values.get(name);
  if (value === undefined) throw new TokenOwnerError("token_undeclared", `${name} is not declared by the token owner`);
  let resolved = value;
  for (let match = VAR.exec(resolved); match !== null; match = VAR.exec(resolved)) {
    const inner = values.has(match[1]!) ? resolveToken(values, match[1]!, [...trail, name]) : match[2];
    if (inner === undefined) throw new TokenOwnerError("token_undeclared", `${match[1]!} (read by ${name}) is not declared by the token owner`);
    resolved = resolved.slice(0, match.index) + inner + resolved.slice(match.index + match[0].length);
  }
  return resolved;
}

type Rgba = readonly [number, number, number, number];

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
const gammaEncode = (linear: number): number => (linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055);

/** OKLCH (L 0..1, C, h degrees) → sRGB 0..1 (the CSS Color 4 conversion, gamut-clamped). */
function oklchToRgb(lightness: number, chroma: number, hue: number): [number, number, number] {
  const radians = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(radians);
  const b = chroma * Math.sin(radians);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    clamp01(gammaEncode(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
    clamp01(gammaEncode(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
    clamp01(gammaEncode(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)),
  ];
}

function percentOrNumber(text: string, scale: number): number {
  const trimmed = text.trim();
  return trimmed.endsWith("%") ? (Number(trimmed.slice(0, -1)) / 100) * scale : Number(trimmed);
}

/** Split a colour function's arguments at top-level commas or spaces (and a `/` alpha). */
function argumentsOf(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (depth === 0 && (char === "," || char === " " || char === "/")) {
      if (current.trim() !== "") parts.push(current.trim());
      if (char === "/") parts.push("/");
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim() !== "") parts.push(current.trim());
  return parts;
}

function parseColor(value: string): Rgba {
  const text = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,8})$/u.exec(text)?.[1];
  if (hex !== undefined && [3, 4, 6, 8].includes(hex.length)) {
    const full = hex.length <= 4 ? [...hex].map((digit) => digit + digit).join("") : hex;
    const channel = (index: number): number => Number.parseInt(full.slice(index * 2, index * 2 + 2), 16) / 255;
    return [channel(0), channel(1), channel(2), full.length === 8 ? channel(3) : 1];
  }
  const open = text.indexOf("(");
  const fn = open > 0 && text.endsWith(")") ? text.slice(0, open) : "";
  if (/^[a-z-]+$/u.test(fn)) {
    const body = text.slice(open + 1, -1);
    const args = argumentsOf(body);
    const alphaAt = args.indexOf("/");
    const alpha = alphaAt === -1 ? undefined : percentOrNumber(args[alphaAt + 1]!, 1);
    const channels = alphaAt === -1 ? args : args.slice(0, alphaAt);
    if (fn === "rgb" || fn === "rgba") {
      const [r, g, b, a] = channels.map((part, index) => (index < 3 ? percentOrNumber(part, 255) / 255 : percentOrNumber(part, 1)));
      return [r!, g!, b!, alpha ?? a ?? 1];
    }
    if (fn === "oklch") {
      const [l, c, h] = channels;
      const [r, g, b] = oklchToRgb(percentOrNumber(l!, 1), percentOrNumber(c!, 0.4), Number(h));
      return [r, g, b, alpha ?? 1];
    }
    if (fn === "color-mix" && channels[0] === "in" && channels[1] === "srgb") {
      // color-mix(in srgb, A p%, B [q%]) — the CSS Color 5 mix with
      // premultiplied alpha; a missing percentage is the complement.
      const operands = body.slice(body.indexOf(",") + 1).split(/,(?![^(]*\))/u).map((part) => part.trim());
      const parsed = operands.map((operand) => {
        const pct = /\s(\d+(?:\.\d+)?)%$/u.exec(operand);
        return { color: parseColor(pct === null ? operand : operand.slice(0, pct.index)), weight: pct === null ? undefined : Number(pct[1]) / 100 };
      });
      if (parsed.length !== 2) throw new TokenOwnerError("token_color_unsupported", value);
      const [first, second] = parsed as [typeof parsed[0], typeof parsed[0]];
      const p1 = first.weight ?? (second.weight === undefined ? 0.5 : 1 - second.weight);
      const p2 = second.weight ?? 1 - p1;
      const mixedAlpha = first.color[3] * p1 + second.color[3] * p2;
      const channel = (index: number): number => (mixedAlpha === 0 ? 0 : (first.color[index]! * first.color[3] * p1 + second.color[index]! * second.color[3] * p2) / mixedAlpha);
      return [channel(0), channel(1), channel(2), mixedAlpha];
    }
  }
  if (text === "transparent") return [0, 0, 0, 0];
  throw new TokenOwnerError("token_color_unsupported", `${value} is not a colour this reader converts (hex, rgb[a], oklch, color-mix in srgb, transparent)`);
}

/** An authored colour as `#rrggbb` (opaque) or `#rrggbbaa`. */
export function concreteColor(value: string): string {
  const [r, g, b, a] = parseColor(value);
  const byte = (channel: number): string => Math.round(clamp01(channel) * 255).toString(16).padStart(2, "0");
  return `#${byte(r)}${byte(g)}${byte(b)}${a < 1 ? byte(a) : ""}`;
}

/** One theme's colour token, followed through `var()` and made concrete. */
export function themeColor(owner: TokenOwner, theme: ThemeName, name: string): string {
  return concreteColor(resolveToken(themeTokens(owner, theme), name));
}

/** Every `--name` a stylesheet (or any source) reads through `var()`. */
export function readNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of stripComments(source).matchAll(/var\(\s*(--[\w-]+)/gu)) names.add(match[1]!);
  return names;
}

/** `names` plus every token they read, transitively, in either theme. */
function closure(owner: TokenOwner, names: Iterable<string>): Set<string> {
  const pending = [...names];
  const seen = new Set<string>();
  const all = [owner.base, owner.logbook, ...owner.media.map((remap) => remap.values)];
  while (pending.length > 0) {
    const name = pending.pop()!;
    if (seen.has(name)) continue;
    if (!all.some((values) => values.has(name))) throw new TokenOwnerError("token_undeclared", `${name} is read but the token owner does not declare it`);
    seen.add(name);
    for (const values of all) {
      const value = values.get(name);
      if (value !== undefined) pending.push(...readNames(value));
    }
  }
  return seen;
}

export interface TokenSheetOptions {
  /** The surface's attribute for an explicit theme choice (`data-theme`). */
  readonly themeAttribute: string;
  /** The theme `:root` wears with no attribute (the lead theme). */
  readonly lead: ThemeName;
  /** Rewrites each `@font-face` `url(…)` to where the surface serves the file. */
  readonly fontUrl: (ownerUrl: string) => string;
  /** The line the sheet opens with, naming its generator. */
  readonly banner: string;
  /**
   * How the surface's faces load (`font-display`), when the surface's policy
   * is not the owner's: a loading policy, which follows how the surface
   * delivers its faces, never a design value.
   */
  readonly fontDisplay?: "optional" | "swap" | "block" | "fallback";
}

const COLOR_SCHEME: Readonly<Record<ThemeName, string>> = Object.freeze({ carbon: "dark", logbook: "light" });

function ruleOf(selector: string, entries: Iterable<readonly [string, string]>, indent = ""): string {
  const lines = [...entries].map(([name, value]) => `${indent}  ${name}: ${value};`);
  return `${indent}${selector} {\n${lines.join("\n")}\n${indent}}`;
}

/**
 * The stylesheet a static surface loads instead of restating the palette:
 * the owner's `@font-face` blocks (their URLs mapped), then `used` and what it
 * reads, as authored, in the lead theme on `:root` and the other theme's
 * differences behind `[attribute="<theme>"]`, then the owner's remaps.
 */
export function tokenSheet(owner: TokenOwner, used: Iterable<string>, options: TokenSheetOptions): string {
  const names = [...closure(owner, used)].sort();
  const other: ThemeName = options.lead === "carbon" ? "logbook" : "carbon";
  const lead = themeTokens(owner, options.lead);
  const second = themeTokens(owner, other);
  const leadEntries: [string, string][] = [["color-scheme", COLOR_SCHEME[options.lead]]];
  const secondEntries: [string, string][] = [["color-scheme", COLOR_SCHEME[other]]];
  for (const name of names) {
    const value = lead.get(name);
    if (value !== undefined) leadEntries.push([name, value]);
    const alternative = second.get(name);
    if (alternative !== undefined && alternative !== value) secondEntries.push([name, alternative]);
  }
  const faces = owner.fontFaces.map((face) => {
    const served = face.replace(/url\(\s*"([^"]+)"\s*\)/gu, (_, url: string) => `url("${options.fontUrl(url)}")`);
    if (options.fontDisplay === undefined) return served;
    if (!/font-display:\s*[a-z]+/u.test(served)) throw new TokenOwnerError("token_face_display_missing", `an @font-face of the owner names no font-display for the surface to set: ${served.slice(0, 80)}`);
    return served.replace(/font-display:\s*[a-z]+/u, `font-display: ${options.fontDisplay}`);
  });
  const remaps = owner.media
    .map((remap) => ({ query: remap.query, entries: [...remap.values].filter(([name]) => names.includes(name)) }))
    .filter((remap) => remap.entries.length > 0)
    .map((remap) => `@media ${remap.query} {\n${ruleOf(":root", remap.entries, "  ")}\n}`);
  return [
    `/* ${options.banner} */`,
    ...faces,
    ruleOf(":root", leadEntries),
    ruleOf(`:root[${options.themeAttribute}="${other}"]`, secondEntries),
    ...remaps,
    "",
  ].join("\n\n");
}
