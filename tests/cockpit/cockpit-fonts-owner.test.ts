// @vitest-environment node
/**
 * The self-hosted fonts are declared once and shipped whole.
 *
 * `src/cockpit/tokens.css` is the one place an `@font-face` may appear (the
 * token owner's header says so), every face it declares must load a file
 * vendored in `public/fonts/`, every vendored font file must be declared (no
 * dead weight), and no stylesheet or markup anywhere in the web tree may pull
 * a font from a CDN. The scanner is a pure function, mutation-tested below
 * with planted violations in more than one place and near-misses that must
 * pass.
 */
import { existsSync, readdirSync } from "node:fs";
import { describe, expect, test } from "vitest";

import { read, relpath, walk } from "../helpers/source-scan.ts";

const TOKENS = "src/cockpit/tokens.css";
const FONT_DIR = "public/fonts";
const FONT_FILE = /\.(?:woff2?|ttf|otf|eot)$/i;

interface FontFace { family: string; style: string; src: string[] }

/** Every `@font-face` block in a stylesheet, with its family, style and url() sources. */
export function fontFaces(css: string): FontFace[] {
  const out: FontFace[] = [];
  for (const block of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const body = block[1]!;
    const family = /font-family\s*:\s*["']?([^"';]+)["']?\s*;/.exec(body)?.[1]?.trim() ?? "";
    const style = /font-style\s*:\s*([a-z]+)/.exec(body)?.[1] ?? "normal";
    const src = [...body.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((m) => m[1]!);
    out.push({ family, style, src });
  }
  return out;
}

/** Findings for one stylesheet or markup file: a font loaded from another origin, or a face outside the owner. */
export function fontFindings(path: string, text: string, owner: string): string[] {
  const findings: string[] = [];
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, "");
  if (/@font-face/.test(stripped) && path !== owner) findings.push(`${path}: @font-face outside ${owner}`);
  for (const face of fontFaces(text)) {
    for (const src of face.src) {
      if (/^(?:https?:)?\/\//i.test(src)) findings.push(`${path}: ${face.family} loads ${src} from another origin`);
    }
  }
  if (/fonts\.(?:googleapis|gstatic)\.com|use\.typekit\.net|fonts\.bunny\.net/i.test(stripped)) {
    findings.push(`${path}: references a font CDN`);
  }
  return findings;
}

describe("cockpit fonts: declared once, vendored whole, no CDN", () => {
  const css = read(TOKENS);
  const faces = fontFaces(css);

  test("the token owner declares Plex Sans and Plex Mono, roman and italic", () => {
    const keys = faces.map((f) => `${f.family}/${f.style}`).sort();
    expect(keys).toEqual([
      "IBM Plex Mono Variable/italic",
      "IBM Plex Mono Variable/normal",
      "IBM Plex Sans Variable/italic",
      "IBM Plex Sans Variable/normal",
    ]);
  });

  test("every declared source is a vendored file, and every vendored font file is declared", () => {
    const declared = faces.flatMap((f) => f.src);
    for (const src of declared) {
      expect(src.startsWith("/fonts/"), `${src} is served from public/fonts/`).toBe(true);
      expect(existsSync(`public${src}`), `public${src} exists`).toBe(true);
    }
    const vendored = readdirSync(FONT_DIR).filter((f) => FONT_FILE.test(f)).map((f) => `/fonts/${f}`).sort();
    expect(vendored).toEqual([...new Set(declared)].sort());
    expect(existsSync(`${FONT_DIR}/OFL.txt`), "the OFL licence travels with the fonts").toBe(true);
  });

  test("the stacks lead with the declared families", () => {
    expect(css).toMatch(/--face-sans:\s*"IBM Plex Sans Variable"/);
    expect(css).toMatch(/--face-mono:\s*"IBM Plex Mono Variable"/);
  });

  test("no stylesheet or markup in the web tree loads a font from elsewhere", () => {
    const files = [
      ...walk("src", { exts: [".css", ".svelte", ".html"] }),
      ...walk("public", { exts: [".css", ".html", ".js"] }),
      "index.html",
    ];
    expect(files.length, "population is live").toBeGreaterThan(40);
    const findings = files.flatMap((f) => fontFindings(relpath(f), read(f), TOKENS));
    expect(findings).toEqual([]);
  });

  test("mutation: planted violations are caught in more than one place; near-misses pass", () => {
    const cdnFace = '@font-face { font-family: "X"; src: url("https://fonts.gstatic.com/x.woff2"); }';
    expect(fontFindings("src/cockpit/rooms/A.svelte", cdnFace, TOKENS)).toHaveLength(3);
    expect(fontFindings("src/app.css", '@import url("https://fonts.googleapis.com/css2?family=Inter");', TOKENS)).toHaveLength(1);
    expect(fontFindings(TOKENS, '@font-face { font-family: "Y"; src: url("//cdn.example/y.woff2"); }', TOKENS)).toHaveLength(1);
    // Near-misses: the owner's own local face, a comment naming a CDN, prose about fonts.
    expect(fontFindings(TOKENS, '@font-face { font-family: "Z"; src: url("/fonts/z.woff2"); }', TOKENS)).toEqual([]);
    expect(fontFindings("src/a.css", "/* never fonts.googleapis.com */ .a { font-family: var(--face-sans); }", TOKENS)).toEqual([]);
    expect(fontFaces('@font-face { font-family: "Q"; font-style: italic; src: url(/fonts/q.woff2) format("woff2"); }'))
      .toEqual([{ family: "Q", style: "italic", src: ["/fonts/q.woff2"] }]);
  });
});
