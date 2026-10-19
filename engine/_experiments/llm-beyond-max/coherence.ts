/**
 * EXP410 — coherence and reliability checks.
 *
 * Deterministic checks that the stitched output is coherent: no
 * catastrophic repetition, no obvious divergence, structural integrity
 * (code blocks balanced, headings present, etc.). These checks power the
 * reliability test (Task 5) and the per-task verification gates.
 *
 * All checks return a score in [0, 1] or a boolean + a reason. They are
 * intentionally conservative — false alarms on creative prose are worse
 * than missing a subtle repeat.
 */

export type CoherenceReport = Readonly<{
  /** Overall coherence score in [0, 1]. 1.0 = perfectly coherent. */
  score: number;
  /** Repetition score in [0, 1]. 1.0 = no repetition. */
  repetitionScore: number;
  /** Estimated unique-token fraction. */
  uniqueFraction: number;
  /** Number of detected repeat loops (substring ≥200 chars appearing 3+ times). */
  repeatLoops: number;
  /** Longest repeated substring (chars). */
  longestRepeatChars: number;
  /** Code-block balance: count of ``` fences (should be even). */
  codeFenceCount: number;
  /** Number of markdown headings. */
  headingCount: number;
  /** Diagnostics for the consumer. */
  notes: readonly string[];
}>;

export function assessCoherence(content: string): CoherenceReport {
  const notes: string[] = [];
  // Unique token fraction (whitespace-split tokens).
  const tokens = content.split(/\s+/u).filter((t) => t.length > 0);
  const tokenSet = new Set<string>();
  for (const t of tokens) tokenSet.add(t.toLowerCase());
  const uniqueFraction = tokens.length > 0 ? tokenSet.size / tokens.length : 1;
  // Repeat loops: substrings of length 200+ appearing 3+ times.
  const repeatLoops = countRepeatLoops(content, 200, 3);
  // Longest repeated substring (sampled, not exhaustive — O(n^2) worst case).
  const longestRepeatChars = longestRepeatedSubstring(content, 80, 4096);
  // Repetition score: penalize repeat loops + low unique fraction.
  let repetitionScore = 1.0;
  if (repeatLoops > 0) repetitionScore = Math.max(0, 1 - repeatLoops * 0.15);
  if (uniqueFraction < 0.4) repetitionScore *= 0.5;
  else if (uniqueFraction < 0.55) repetitionScore *= 0.75;
  // Code fence balance.
  const codeFenceCount = countFences(content);
  // Headings.
  const headingCount = countHeadings(content);
  if (codeFenceCount % 2 !== 0) {
    notes.push("unbalanced code fences");
    repetitionScore *= 0.9;
  }
  // Overall score.
  let score = repetitionScore;
  if (repeatLoops >= 4) score *= 0.5;
  if (longestRepeatChars > 500) {
    notes.push(`long repeat substring (${longestRepeatChars} chars)`);
    score *= 0.85;
  }
  notes.push(`unique=${uniqueFraction.toFixed(3)} loops=${repeatLoops} longest=${longestRepeatChars}`);
  return Object.freeze({
    score: round(score, 3),
    repetitionScore: round(repetitionScore, 3),
    uniqueFraction: round(uniqueFraction, 3),
    repeatLoops,
    longestRepeatChars,
    codeFenceCount,
    headingCount,
    notes: Object.freeze(notes),
  });
}

/**
 * Count the number of 200+ char substrings that appear 3+ times. Uses a
 * rolling hash to keep the cost O(n·k) for k = substring length.
 */
function countRepeatLoops(content: string, minLen: number, minCount: number): number {
  if (content.length < minLen * minCount) return 0;
  const seen = new Map<string, number>();
  const step = Math.max(1, Math.floor(minLen / 4));
  for (let i = 0; i + minLen <= content.length; i += step) {
    const s = content.slice(i, i + minLen);
    seen.set(s, (seen.get(s) ?? 0) + 1);
  }
  let loops = 0;
  for (const [, c] of seen) {
    if (c >= minCount) loops++;
  }
  return loops;
}

function longestRepeatedSubstring(content: string, minLen: number, maxLen: number): number {
  if (content.length < minLen * 2) return 0;
  // Binary search on length using a Set.
  let lo = minLen;
  let hi = Math.min(maxLen, Math.floor(content.length / 2));
  let best = 0;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (hasRepeatedOfLength(content, mid)) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function hasRepeatedOfLength(content: string, len: number): boolean {
  if (content.length < len * 2) return false;
  const seen = new Set<string>();
  for (let i = 0; i + len <= content.length; i += Math.max(1, Math.floor(len / 8))) {
    const s = content.slice(i, i + len);
    if (seen.has(s)) return true;
    seen.add(s);
  }
  return false;
}

function countFences(content: string): number {
  let n = 0;
  for (let i = 0; i + 3 <= content.length; i++) {
    if (content.slice(i, i + 3) === "```") {
      n++;
      i += 2;
    }
  }
  return n;
}

function countHeadings(content: string): number {
  let n = 0;
  for (const line of content.split("\n")) {
    if (/^#{1,6}\s/u.test(line.trim())) n++;
  }
  return n;
}

function round(x: number, d: number): number {
  const m = 10 ** d;
  return Math.round(x * m) / m;
}
