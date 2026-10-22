#!/usr/bin/env node
/**
 * The brand mark generator: ONE geometry, drawn in the design system's own
 * colours, written as every icon file the app and the manifest reference.
 *
 * The mark is the bridle: a rein (the vertical stroke) with three record
 * lines and the one live beam where they meet. Its geometry is declared once
 * in `src/cockpit/shell/brand-mark.ts` (a 32-unit grid, also drawn by the
 * cockpit's `Brand.svelte`) and its colours are read from the token owner,
 * `src/cockpit/tokens.css` (the Carbon `:root` block), so a palette change
 * there reaches the icons at the next run, and no hex is restated here.
 *
 * Outputs (all generated, never hand-edited):
 *   public/icons/icon.svg      the vector mark on its rounded Carbon tile
 *   public/icons/icon-192.png  raster, full-bleed tile (maskable-safe)
 *   public/icons/icon-512.png  raster, full-bleed tile (maskable-safe)
 *   public/sw.js               its icons-digest line only: a new icon set is a
 *                              new cache, so installed apps refresh (never a hand bump)
 *
 * PNGs are hand-encoded (signature, IHDR, zlib IDAT, IEND, CRC-32) from
 * Node built-ins only, with 4×4 supersampled coverage per pixel, so the
 * output is byte-deterministic. `tests/prevention/pwa.test.ts` re-renders
 * in memory and refuses a committed icon that differs.
 *
 *   node scripts/generate-pwa-icons.mjs           write the icons
 *   node scripts/generate-pwa-icons.mjs --check   exit 1 if any icon drifted
 */
// The one checkout writer (the checkout write door + atomic rename): a
// generator run under a test runner cannot rewrite the runner's checkout.
import { atomicWriteFile } from "../engine/src/filesystem/atomic-write.ts";
import { BRAND_MARK, strokePath } from "../src/cockpit/shell/brand-mark.ts";
import { deflateSync, crc32 } from "node:zlib";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOKENS = resolve(ROOT, "src", "cockpit", "tokens.css");
const OUT_DIR = resolve(ROOT, "public", "icons");

/** The one geometry, shared with the cockpit's `Brand.svelte`. */
const MARK = BRAND_MARK;

/** The Carbon (first `:root`) value of each token the mark uses, read from the owner. */
export function markColors(css = readFileSync(TOKENS, "utf8")) {
  const root = /:root\s*\{([\s\S]*?)\n\}/.exec(css.replace(/\/\*[\s\S]*?\*\//g, ""))?.[1];
  if (root === undefined) throw new Error(`[brand-mark] no :root block in ${TOKENS}`);
  const names = [MARK.tile, MARK.rein.ink, MARK.beam.ink, ...MARK.lines.map((l) => l.ink)];
  const colors = {};
  for (const name of names) {
    const hex = new RegExp(`${name}\\s*:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(root)?.[1];
    if (hex === undefined) throw new Error(`[brand-mark] ${name} is not a #rrggbb value in the Carbon :root of ${TOKENS}`);
    colors[name] = hex.toLowerCase();
  }
  return colors;
}

/** The vector mark: a rounded Carbon tile carrying the rein, the lines and the beam. */
export function markSvg(colors = markColors()) {
  const seg = (stroke) =>
    `<path d="${strokePath(stroke)}" stroke="${colors[stroke.ink]}" stroke-width="${MARK.stroke}" stroke-linecap="round"/>`;
  const g = MARK.grid;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${g} ${g}" width="512" height="512" role="img" aria-label="Bridlewise">`,
    `<rect width="${g}" height="${g}" rx="${MARK.tileRadius}" fill="${colors[MARK.tile]}"/>`,
    seg(MARK.rein),
    ...MARK.lines.map(seg),
    `<circle cx="${MARK.beam.at[0]}" cy="${MARK.beam.at[1]}" r="${MARK.beam.r}" fill="${colors[MARK.beam.ink]}"/>`,
    `</svg>`,
    "",
  ].join("\n");
}

const rgb = (hex) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));

/** Distance from point p to segment a–b. */
function segmentDistance(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * The raster mark at `size`×`size`: a full-bleed tile (a maskable icon's
 * mask supplies the shape), every shape painted in order over 16 samples
 * per pixel. The mark sits inside the maskable safe zone (all marks within
 * 40% of the size from the centre).
 */
export function markPng(size, colors = markColors()) {
  const scale = size / MARK.grid;
  const half = MARK.stroke / 2;
  const shapes = [
    { ink: rgb(colors[MARK.rein.ink]), hit: (x, y) => segmentDistance(x, y, MARK.rein.from, MARK.rein.to) <= half },
    ...MARK.lines.map((l) => ({ ink: rgb(colors[l.ink]), hit: (x, y) => segmentDistance(x, y, l.from, l.to) <= half })),
    { ink: rgb(colors[MARK.beam.ink]), hit: (x, y) => Math.hypot(x - MARK.beam.at[0], y - MARK.beam.at[1]) <= MARK.beam.r },
  ];
  const tile = rgb(colors[MARK.tile]);
  const S = 4;
  const rowLen = size * 3;
  const raw = Buffer.alloc((rowLen + 1) * size);
  for (let y = 0; y < size; y++) {
    const rowOff = y * (rowLen + 1);
    raw[rowOff] = 0; // filter type 0 (None)
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0];
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const gx = (x + (sx + 0.5) / S) / scale;
          const gy = (y + (sy + 0.5) / S) / scale;
          let px = tile;
          for (const shape of shapes) if (shape.hit(gx, gy)) px = shape.ink;
          acc[0] += px[0];
          acc[1] += px[1];
          acc[2] += px[2];
        }
      }
      const off = rowOff + 1 + x * 3;
      raw[off] = Math.round(acc[0] / (S * S));
      raw[off + 1] = Math.round(acc[1] / (S * S));
      raw[off + 2] = Math.round(acc[2] / (S * S));
    }
  }
  const u32 = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n >>> 0, 0);
    return b;
  };
  const chunk = (type, data) => {
    const typeBuf = Buffer.from(type, "ascii");
    return Buffer.concat([u32(data.length), typeBuf, data, u32(crc32(Buffer.concat([typeBuf, data])))]);
  };
  // IHDR: width, height, bit depth 8, colour type 2 (RGB), compression 0, filter 0, interlace 0.
  const ihdr = Buffer.concat([u32(size), u32(size), Buffer.from([8, 2, 0, 0, 0])]);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

const SERVICE_WORKER = resolve(ROOT, "public", "sw.js");
export const ICONS_DIGEST_BLOCK = Object.freeze({
  begin: "// BEGIN GENERATED: the icons' digest (scripts/generate-pwa-icons.mjs)",
  end: "// END GENERATED: the icons' digest",
});

/** The icons' content digest (sha256 over each icon's name and bytes, in name order), 12 hex characters. */
export function iconsDigest(icons) {
  const hash = createHash("sha256");
  for (const [path, bytes] of [...icons.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    hash.update(basename(path));
    hash.update("\0");
    hash.update(bytes);
  }
  return hash.digest("hex").slice(0, 12);
}

/** The service worker's text with its icons-digest block set to `digest`; refused when the block is missing. */
export function withIconsDigest(sw, digest) {
  const begin = sw.indexOf(ICONS_DIGEST_BLOCK.begin);
  const end = sw.indexOf(ICONS_DIGEST_BLOCK.end);
  if (begin < 0 || end < begin) throw new Error(`[brand-mark] ${SERVICE_WORKER} carries no icons-digest block`);
  return `${sw.slice(0, begin + ICONS_DIGEST_BLOCK.begin.length)}\nconst ICONS_DIGEST = "${digest}";\n${sw.slice(end)}`;
}

/** Every file the generator owns, as path → bytes: the icons, and the service worker with their digest. */
export function markOutputs(colors = markColors(), sw = readFileSync(SERVICE_WORKER, "utf8")) {
  const icons = new Map([
    [resolve(OUT_DIR, "icon.svg"), Buffer.from(markSvg(colors), "utf8")],
    [resolve(OUT_DIR, "icon-192.png"), markPng(192, colors)],
    [resolve(OUT_DIR, "icon-512.png"), markPng(512, colors)],
  ]);
  return new Map([...icons, [SERVICE_WORKER, Buffer.from(withIconsDigest(sw, iconsDigest(icons)), "utf8")]]);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv.includes("--check");
  const drifted = [];
  for (const [out, bytes] of markOutputs()) {
    let current = null;
    try {
      current = readFileSync(out);
    } catch {
      current = null;
    }
    if (current !== null && current.equals(bytes)) continue;
    drifted.push(out);
    if (check) continue;
    // Served files: world-readable like every other file under public/.
    const result = atomicWriteFile(out, bytes, { exactMode: 0o644 });
    if (!result.success) throw new Error(`[brand-mark] could not write ${out}: ${result.reason ?? "unknown"}`);
  }
  console.log(JSON.stringify({ allCurrent: drifted.length === 0, status: check ? "checked" : "written", changed: drifted.map((p) => p.slice(ROOT.length + 1)) }));
  if (check && drifted.length > 0) process.exitCode = 1;
}
