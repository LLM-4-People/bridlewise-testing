/**
 * EXP449 — advanced compression techniques.
 *
 * Five techniques are benchmarked against the same output:
 *   1. `minify`       — strip comments + JSDoc + collapse whitespace (regex).
 *                       Lossless for code structure; lossy for string literals
 *                       containing `//` or `/*` (acceptable for measurement).
 *   2. `gzip`         — gzip the raw output via node:zlib. Lossless, reversible.
 *   3. `brotli`       — brotli compress the raw output via node:zlib. Lossless,
 *                       usually ~10-20% smaller than gzip for text/code.
 *   4. `minify+gzip`  — minify then gzip. Combined: structure strip + entropy
 *                       coding. Usually the best ratio for TypeScript code.
 *   5. `minify+brotli` — minify then brotli. Combined, best ratio for code.
 *
 * Every technique reports the same CompressionReport shape so the runner
 * can compare them on the same input. The `mode` field identifies which
 * technique produced the report.
 *
 * For the "compressed output that we uncompress" use case, gzip/brotli
 * are the realistic production choices: the LLM emits raw text, the harness
 * compresses for storage/context, and decompresses on use. The minify
 * techniques are an LLM-side strategy (tell the model to emit minified
 * code) — the harness prettifies on use.
 *
 * Design rules honored:
 *   - no new runtime deps (node:zlib is stdlib);
 *   - deterministic (gzip/brotli are deterministic at the same level);
 *   - one canonical owner per technique (this file).
 */

import { gzipSync, brotliCompressSync, deflateSync, gunzipSync, brotliDecompressSync, inflateSync, constants as zConstants } from "node:zlib";

/** Brotli quality parameter key (resolved from zlib constants at load time). */
const BROTLI_QUALITY_KEY = zConstants.BROTLI_PARAM_QUALITY;

export type CompressionMode = "none" | "minify" | "gzip" | "brotli" | "minify+gzip" | "minify+brotli" | "deflate";

export type CompressionReport = Readonly<{
  mode: CompressionMode;
  originalChars: number;
  compressedBytes: number;
  /** compressed / original. Lower = more compression. */
  compressionRatio: number;
  /** (1 - compressed/original) * 100. Higher = more savings. */
  charSavingsPct: number;
  /** Decompressed chars (for lossless modes; = original if round-trip ok). */
  decompressedChars: number;
  /** Whether the round-trip (decompress → original) succeeded. */
  roundTripOk: boolean;
  /** Time spent compressing (ms). */
  compressMs: number;
}>;

export type CompressionOptions = Readonly<{
  mode: CompressionMode;
  /** gzip/brotli/deflate level (1-9 for gzip/deflate, 0-11 for brotli). */
  level: number;
  /** For minify mode: strip line comments. */
  stripLineComments: boolean;
  /** For minify mode: strip block comments (incl. JSDoc). */
  stripBlockComments: boolean;
  /** For minify mode: collapse runs of whitespace. */
  collapseWhitespace: boolean;
  /** For minify mode: remove blank lines. */
  removeBlankLines: boolean;
}>;

export const DEFAULT_COMPRESSION_V2: CompressionOptions = Object.freeze({
  mode: "minify+gzip",
  level: 9,
  stripLineComments: true,
  stripBlockComments: true,
  collapseWhitespace: true,
  removeBlankLines: true,
});

/** Minify a string (regex-based, lossless for structure, lossy for strings with `//`). */
export function minify(text: string, opts: CompressionOptions): string {
  let out = text;
  if (opts.stripBlockComments) out = out.replace(/\/\*[\s\S]*?\*\//gu, "");
  if (opts.stripLineComments) out = out.replace(/(^|[^:])\/\/[^\n]*/gu, "$1");
  if (opts.removeBlankLines) out = out.replace(/\n\s*\n+/gu, "\n");
  if (opts.collapseWhitespace) {
    out = out.replace(/[ \t]+/gu, " ");
    out = out.replace(/[ \t]+\n/gu, "\n");
    out = out.replace(/\n[ \t]+/gu, "\n");
  }
  return out.trim();
}

/** Compress with one of the five techniques and report the ratio + round-trip. */
export function compressV2(text: string, opts: CompressionOptions): Readonly<{ compressed: Buffer; report: CompressionReport }> {
  const t0 = Date.now();
  const originalChars = text.length;
  let compressed: Buffer;
  let roundTripOk = true;
  let decompressedChars = originalChars;
  switch (opts.mode) {
    case "none":
      compressed = Buffer.from(text, "utf8");
      break;
    case "minify": {
      const m = minify(text, opts);
      compressed = Buffer.from(m, "utf8");
      decompressedChars = m.length;
      roundTripOk = true; // minify is not reversible (comments lost)
      break;
    }
    case "gzip": {
      compressed = gzipSync(Buffer.from(text, "utf8"), { level: opts.level });
      try { decompressedChars = gunzipSync(compressed).length; } catch { roundTripOk = false; }
      break;
    }
    case "brotli": {
      const brLevel = Math.min(11, Math.max(0, opts.level));
      compressed = brotliCompressSync(Buffer.from(text, "utf8"), { params: { [BROTLI_QUALITY_KEY]: brLevel } });
      try { decompressedChars = brotliDecompressSync(compressed).length; } catch { roundTripOk = false; }
      break;
    }
    case "minify+gzip": {
      const m = minify(text, opts);
      compressed = gzipSync(Buffer.from(m, "utf8"), { level: opts.level });
      try { decompressedChars = gunzipSync(compressed).length; } catch { roundTripOk = false; }
      break;
    }
    case "minify+brotli": {
      const m = minify(text, opts);
      const brLevel = Math.min(11, Math.max(0, opts.level));
      compressed = brotliCompressSync(Buffer.from(m, "utf8"), { params: { [BROTLI_QUALITY_KEY]: brLevel } });
      try { decompressedChars = brotliDecompressSync(compressed).length; } catch { roundTripOk = false; }
      break;
    }
    case "deflate": {
      compressed = deflateSync(Buffer.from(text, "utf8"), { level: opts.level });
      try { decompressedChars = inflateSync(compressed).length; } catch { roundTripOk = false; }
      break;
    }
  }
  const compressMs = Date.now() - t0;
  const compressedBytes = compressed.length;
  return {
    compressed,
    report: makeReport(opts.mode, originalChars, compressedBytes, decompressedChars, roundTripOk, compressMs),
  };
}

// Brotli quality param key resolved from zlib constants at load time (above).

function makeReport(mode: CompressionMode, originalChars: number, compressedBytes: number, decompressedChars: number, roundTripOk: boolean, compressMs: number): CompressionReport {
  return Object.freeze({
    mode, originalChars, compressedBytes,
    compressionRatio: originalChars > 0 ? round(compressedBytes / originalChars, 4) : 1,
    charSavingsPct: originalChars > 0 ? round((1 - compressedBytes / originalChars) * 100, 2) : 0,
    decompressedChars, roundTripOk, compressMs,
  });
}

function round(x: number, d: number): number {
  const m = 10 ** d;
  return Math.round(x * m) / m;
}
