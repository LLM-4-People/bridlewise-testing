/**
 * PNG frames → one palette GIF, with Node built-ins only.
 *
 * The ffmpeg Playwright ships (`~/.cache/ms-playwright/ffmpeg-*`) decodes the
 * run's WebM and writes PNG frames, but it carries no GIF encoder and no
 * palette filter (measured: its encoders are `png` and `libvpx` only). So the
 * capture asks it for 8-bit RGB PNG frames and this module does the rest:
 *
 *   decodePngRgb   — the one PNG shape ffmpeg is asked for (8-bit RGB, not interlaced);
 *   buildPalette   — ONE global palette for the whole animation (median cut
 *                    over a 15-bit histogram of every frame), so colours never
 *                    shimmer between frames;
 *   encodeGif      — GIF89a, no dithering (flat UI colours stay flat), each
 *                    frame after the first stores only the rectangle that
 *                    changed, unchanged pixels transparent: small files.
 *
 * Every function is pure (bytes in, bytes out); a format it was not built
 * for is refused by name, never guessed.
 */
import { inflateSync } from "node:zlib";

export interface RgbFrame {
  readonly width: number;
  readonly height: number;
  /** width × height × 3 bytes, row-major RGB. */
  readonly rgb: Uint8Array;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function decodePngRgb(png: Uint8Array): RgbFrame {
  if (PNG_SIGNATURE.some((byte, index) => png[index] !== byte)) throw new Error("png_unsupported: not a PNG file");
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Uint8Array[] = [];
  while (offset < png.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      const [bitDepth, colorType, , , interlace] = data.subarray(8, 13);
      if (bitDepth !== 8 || colorType !== 2 || interlace !== 0) {
        throw new Error(`png_unsupported: bit depth ${String(bitDepth)}, colour type ${String(colorType)}, interlace ${String(interlace)} (8-bit RGB, not interlaced, is the one shape asked for)`);
      }
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  if (width === 0 || height === 0) throw new Error("png_unsupported: no IHDR");
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 3;
  if (raw.length !== (stride + 1) * height) throw new Error(`png_unsupported: ${raw.length} inflated bytes for ${width}x${height}`);
  const rgb = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = y * stride;
    const prev = out - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= 3 ? rgb[out + x - 3]! : 0;
      const b = y > 0 ? rgb[prev + x]! : 0;
      const c = x >= 3 && y > 0 ? rgb[prev + x - 3]! : 0;
      const value = line[x]!;
      let predicted: number;
      switch (filter) {
        case 0: predicted = 0; break;
        case 1: predicted = a; break;
        case 2: predicted = b; break;
        case 3: predicted = (a + b) >> 1; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default: throw new Error(`png_unsupported: filter ${String(filter)}`);
      }
      rgb[out + x] = (value + predicted) & 0xff;
    }
  }
  return { width, height, rgb };
}

/** The 15-bit bucket of one RGB colour. */
function bucket(r: number, g: number, b: number): number {
  return ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
}

/**
 * One palette for every frame: median cut over the 15-bit colour histogram.
 * Answers at most `size` RGB entries (flat array) and a 32768-entry lookup
 * from bucket to palette index (nearest entry).
 */
function buildPalette(frames: readonly RgbFrame[], size = 255): { palette: Uint8Array; lookup: Uint8Array } {
  const histogram = new Uint32Array(32768);
  // Per-bucket colour sums: a palette entry is the true mean of its pixels, so a flat UI colour survives exactly.
  const sums = new Float64Array(32768 * 3);
  for (const frame of frames) {
    for (let i = 0; i < frame.rgb.length; i += 3) {
      const b = bucket(frame.rgb[i]!, frame.rgb[i + 1]!, frame.rgb[i + 2]!);
      histogram[b]! += 1;
      sums[b * 3]! += frame.rgb[i]!; sums[b * 3 + 1]! += frame.rgb[i + 1]!; sums[b * 3 + 2]! += frame.rgb[i + 2]!;
    }
  }
  const mean = (b: number, c: number): number => sums[b * 3 + c]! / histogram[b]!;
  const used: number[] = [];
  for (let i = 0; i < histogram.length; i++) if (histogram[i]! > 0) used.push(i);
  const channel = (b: number, c: number): number => (c === 0 ? b >> 10 : c === 1 ? (b >> 5) & 31 : b & 31);
  let boxes: number[][] = [used];
  while (boxes.length < size) {
    let pick = -1;
    let pickRange = 0;
    let pickChannel = 0;
    boxes.forEach((box, index) => {
      if (box.length < 2) return;
      for (let c = 0; c < 3; c++) {
        let lo = 31;
        let hi = 0;
        for (const b of box) { const v = channel(b, c); if (v < lo) lo = v; if (v > hi) hi = v; }
        if (hi - lo > pickRange) { pickRange = hi - lo; pick = index; pickChannel = c; }
      }
    });
    if (pick < 0) break;
    const box = boxes[pick]!.toSorted((x, y) => channel(x, pickChannel) - channel(y, pickChannel) || x - y);
    const total = box.reduce((sum, b) => sum + histogram[b]!, 0);
    let acc = 0;
    let cut = 1;
    for (; cut < box.length - 1; cut++) { acc += histogram[box[cut - 1]!]!; if (acc * 2 >= total) break; }
    boxes = [...boxes.slice(0, pick), box.slice(0, cut), box.slice(cut), ...boxes.slice(pick + 1)];
  }
  const palette = new Uint8Array(boxes.length * 3);
  boxes.forEach((box, index) => {
    let r = 0; let g = 0; let b = 0; let n = 0;
    for (const entry of box) { r += sums[entry * 3]!; g += sums[entry * 3 + 1]!; b += sums[entry * 3 + 2]!; n += histogram[entry]!; }
    palette[index * 3] = Math.round(r / n); palette[index * 3 + 1] = Math.round(g / n); palette[index * 3 + 2] = Math.round(b / n);
  });
  const lookup = new Uint8Array(32768);
  for (const entry of used) {
    const r = mean(entry, 0); const g = mean(entry, 1); const b = mean(entry, 2);
    let best = 0; let bestDistance = Infinity;
    for (let i = 0; i < boxes.length; i++) {
      const d = (palette[i * 3]! - r) ** 2 + (palette[i * 3 + 1]! - g) ** 2 + (palette[i * 3 + 2]! - b) ** 2;
      if (d < bestDistance) { bestDistance = d; best = i; }
    }
    lookup[entry] = best;
  }
  return { palette, lookup };
}

/** GIF LZW: the image's palette indices as data sub-blocks. */
function lzw(indices: Uint8Array, minCodeSize: number): Uint8Array {
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  const bytes: number[] = [];
  let bitBuffer = 0;
  let bitCount = 0;
  let codeSize = minCodeSize + 1;
  const emit = (code: number): void => {
    bitBuffer |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) { bytes.push(bitBuffer & 0xff); bitBuffer >>>= 8; bitCount -= 8; }
  };
  let table = new Map<number, number>();
  let next = end + 1;
  emit(clear);
  let prefix = indices[0]!;
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i]!;
    const key = (prefix << 8) | k;
    const found = table.get(key);
    if (found !== undefined) { prefix = found; continue; }
    emit(prefix);
    if (next < 4096) {
      table.set(key, next++);
      if (next > 1 << codeSize && codeSize < 12) codeSize++;
    } else {
      emit(clear);
      table = new Map();
      next = end + 1;
      codeSize = minCodeSize + 1;
    }
    prefix = k;
  }
  emit(prefix);
  emit(end);
  if (bitCount > 0) bytes.push(bitBuffer & 0xff);
  const out: number[] = [minCodeSize];
  for (let i = 0; i < bytes.length; i += 255) {
    const block = bytes.slice(i, i + 255);
    out.push(block.length, ...block);
  }
  out.push(0);
  return Uint8Array.from(out);
}

/**
 * An animated GIF89a of `frames` (all the same size), `delayCs` hundredths of
 * a second per frame, looping forever. Palette index 255 is reserved as the
 * transparent "unchanged since the previous frame" colour.
 */
export function encodeGif(frames: readonly RgbFrame[], delayCs: number, lastDelayCs = delayCs): Uint8Array {
  const first = frames[0];
  if (first === undefined) throw new Error("gif_no_frames: an animation needs at least one frame");
  const { width, height } = first;
  if (frames.some((f) => f.width !== width || f.height !== height)) throw new Error("gif_frame_size_mismatch: every frame must share one size");
  const { palette, lookup } = buildPalette(frames, 255);
  const TRANSPARENT = 255;
  const table = new Uint8Array(256 * 3);
  table.set(palette);
  const parts: Uint8Array[] = [];
  const u16 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff];
  parts.push(Uint8Array.from([...Buffer.from("GIF89a"), ...u16(width), ...u16(height), 0xf7, 0, 0]), table);
  parts.push(Uint8Array.from([0x21, 0xff, 0x0b, ...Buffer.from("NETSCAPE2.0"), 0x03, 0x01, 0, 0, 0]));
  let previous: Uint8Array | null = null;
  frames.forEach((frame, frameIndex) => {
    const indices = new Uint8Array(width * height);
    for (let p = 0, i = 0; p < indices.length; p++, i += 3) indices[p] = lookup[bucket(frame.rgb[i]!, frame.rgb[i + 1]!, frame.rgb[i + 2]!)]!;
    let x0 = 0; let y0 = 0; let x1 = width - 1; let y1 = height - 1;
    if (previous !== null) {
      x0 = width; y0 = height; x1 = -1; y1 = -1;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const p = y * width + x;
        if (indices[p] !== previous[p]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
      if (x1 < 0) { x0 = 0; y0 = 0; x1 = 0; y1 = 0; }
    }
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    const rect = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = (y + y0) * width + (x + x0);
      rect[y * w + x] = previous !== null && previous[p] === indices[p] ? TRANSPARENT : indices[p]!;
    }
    previous = indices;
    const delay = frameIndex === frames.length - 1 ? lastDelayCs : delayCs;
    // Graphic control: disposal 1 (keep), transparent index set.
    parts.push(Uint8Array.from([0x21, 0xf9, 0x04, 0x05, ...u16(delay), TRANSPARENT, 0]));
    parts.push(Uint8Array.from([0x2c, ...u16(x0), ...u16(y0), ...u16(w), ...u16(h), 0]));
    parts.push(lzw(rect, 8));
  });
  parts.push(Uint8Array.from([0x3b]));
  return Buffer.concat(parts);
}
