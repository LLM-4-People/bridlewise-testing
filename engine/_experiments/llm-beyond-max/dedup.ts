/**
 * EXP410 — output dedup.
 *
 * Post-process LLM-generated output to remove duplicate content. With
 * parallel chunked generation, each chunk is independent — the model may
 * emit the same import statements at the top of each chunk, or repeat
 * boilerplate. Dedup removes these duplicates while preserving the first
 * occurrence (which is the canonical one).
 *
 * Three modes (declared in `config.dedup`):
 *   1. `line` — remove duplicate lines (keep first occurrence).
 *   2. `block` — remove duplicate blocks (paragraphs / functions / classes
 *      separated by blank lines). A block is a maximal run of non-blank
 *      lines. Duplicate blocks (identical or near-identical by Jaccard on
 *      line-hashes) are removed.
 *   3. `none` — no dedup (for baseline measurement).
 *
 * The dedup is deterministic and O(n) for line-mode, O(n·k) for block-mode
 * (k = number of blocks; we hash each block and compare). Block-level
 * near-dup uses a Jaccard similarity over the SET of lines in each block;
 * two blocks with Jaccard ≥ threshold are considered duplicates.
 *
 * Reports: how many chars / lines / blocks were removed.
 */

export type DedupMode = "none" | "line" | "block";

export type DedupReport = Readonly<{
  mode: DedupMode;
  originalChars: number;
  originalLines: number;
  originalBlocks: number;
  dedupedChars: number;
  dedupedLines: number;
  dedupedBlocks: number;
  removedLines: number;
  removedBlocks: number;
  charReductionPct: number;
  lineReductionPct: number;
  blockReductionPct: number;
}>;

export type DedupOptions = Readonly<{
  mode: DedupMode;
  /** Jaccard threshold for block near-dup. 1.0 = exact match, 0.9 = allow minor edits. */
  blockSimilarityThreshold: number;
  /** Lines shorter than this are not deduped (e.g. blank lines, braces). */
  minLineLengthForDedup: number;
}>;

export function dedup(text: string, opts: DedupOptions): Readonly<{ content: string; report: DedupReport }> {
  if (opts.mode === "none") {
    return { content: text, report: makeReport("none", text, text, 0, 0, countLines(text), countLines(text), countBlocks(text), countBlocks(text)) };
  }
  if (opts.mode === "line") {
    const { content, removed } = dedupLines(text, opts.minLineLengthForDedup);
    const originalLines = countLines(text);
    const dedupedLines = originalLines - removed;
    return { content, report: makeReport("line", text, content, removed, 0, originalLines, dedupedLines, countBlocks(text), countBlocks(content)) };
  }
  // block mode
  const { content, removedBlocks } = dedupBlocks(text, opts.blockSimilarityThreshold, opts.minLineLengthForDedup);
  const originalBlocks = countBlocks(text);
  const dedupedBlocks = originalBlocks - removedBlocks;
  return { content, report: makeReport("block", text, content, 0, removedBlocks, countLines(text), countLines(content), originalBlocks, dedupedBlocks) };
}

/** Remove duplicate lines (keep first occurrence). Lines shorter than `minLen` pass through. */
export function dedupLines(text: string, minLen: number): Readonly<{ content: string; removed: number }> {
  const lines = text.split("\n");
  const seen = new Set<string>();
  let removed = 0;
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length < minLen) {
      out.push(line);
      continue;
    }
    // Use the trimmed line as the key (so indentation differences don't
    // bypass dedup). This catches `   import X` vs `import X`.
    if (seen.has(trimmed)) {
      removed++;
      continue;
    }
    seen.add(trimmed);
    out.push(line);
  }
  return { content: out.join("\n"), removed };
}

/** Remove duplicate blocks (blank-line-separated). Uses Jaccard on the SET of lines. */
export function dedupBlocks(text: string, similarityThreshold: number, minLineLen: number): Readonly<{ content: string; removedBlocks: number }> {
  const blocks = splitBlocks(text);
  const seenLineSets: Set<string>[] = [];
  const out: string[] = [];
  let removedBlocks = 0;
  for (const block of blocks) {
    const lineHashes = block
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length >= minLineLen);
    if (lineHashes.length === 0) {
      out.push(block);
      continue;
    }
    const lineSet = new Set(lineHashes);
    let isDup = false;
    for (const existing of seenLineSets) {
      if (jaccard(lineSet, existing) >= similarityThreshold) {
        isDup = true;
        break;
      }
    }
    if (isDup) {
      removedBlocks++;
      continue;
    }
    seenLineSets.push(lineSet);
    out.push(block);
  }
  // Re-join with blank lines (the original block separator).
  return { content: out.join("\n\n"), removedBlocks };
}

/** Count lines (split on `\n`). */
export function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split("\n").length;
}

/** Count blocks (maximal runs of non-blank lines). */
export function countBlocks(text: string): number {
  if (text.trim().length === 0) return 0;
  return splitBlocks(text).length;
}

/** Split text into blocks separated by blank lines. */
function splitBlocks(text: string): string[] {
  return text
    .split(/\n\s*\n+/u)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
}

/** Jaccard similarity over two sets: |A∩B| / |A∪B|. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  const smaller = a.size < b.size ? a : b;
  const larger = a.size < b.size ? b : a;
  for (const x of smaller) if (larger.has(x)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function makeReport(
  mode: DedupMode,
  original: string,
  deduped: string,
  removedLines: number,
  removedBlocks: number,
  originalLines: number,
  dedupedLines: number,
  originalBlocks: number,
  dedupedBlocks: number,
): DedupReport {
  const originalChars = original.length;
  const dedupedChars = deduped.length;
  return Object.freeze({
    mode,
    originalChars,
    originalLines,
    originalBlocks,
    dedupedChars,
    dedupedLines,
    dedupedBlocks,
    removedLines,
    removedBlocks,
    charReductionPct: originalChars > 0 ? round((1 - dedupedChars / originalChars) * 100, 2) : 0,
    lineReductionPct: originalLines > 0 ? round((removedLines / originalLines) * 100, 2) : 0,
    blockReductionPct: originalBlocks > 0 ? round((removedBlocks / originalBlocks) * 100, 2) : 0,
  });
}

function round(x: number, d: number): number {
  const m = 10 ** d;
  return Math.round(x * m) / m;
}
