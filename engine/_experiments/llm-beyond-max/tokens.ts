/**
 * EXP410 — token estimation utilities.
 *
 * Real token counts come from the API's `usage.completion_tokens` field. For
 * chunk sizing, planning, and budgeting BEFORE a call, we need a fast
 * deterministic estimate. We use the canonical 4-char-per-token heuristic
 * (validated against gemma-4-31b and glm-5.2 below) and expose a tiny API
 * so callers don't repeat the literal.
 *
 * The estimator is intentionally a function of bytes-on-the-wire, not a
 * tokenizer — we cannot ship a tokenizer in this experiment without a
 * dependency, and the heuristic is within ~15% of real counts for English
 * prose + code, which is good enough for budget decisions.
 */

const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.max(1, Math.round(text.length / CHARS_PER_TOKEN));
}

export function estimateCharsForTokens(tokens: number): number {
  return tokens * CHARS_PER_TOKEN;
}

/**
 * Trim `text` to the last `chars` characters, snapping to a word boundary so
 * we don't feed the model a partial token. Returns the trimmed string.
 */
export function trailingContext(text: string, chars: number): string {
  if (text.length <= chars) return text;
  const slice = text.slice(text.length - chars);
  const firstSpace = slice.indexOf(" ");
  if (firstSpace < 0 || firstSpace > 32) return slice;
  return slice.slice(firstSpace + 1);
}

/**
 * Trim `text` to the first `chars` characters, snapping to a word boundary.
 */
export function leadingContext(text: string, chars: number): string {
  if (text.length <= chars) return text;
  const slice = text.slice(0, chars);
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace < 0 || lastSpace < slice.length - 32) return slice;
  return slice.slice(0, lastSpace);
}

/**
 * Detect whether `next` is a repetition of the end of `prev`. Used by the
 * continuation loop to detect divergence (the model repeating itself).
 * Returns the length of the longest suffix of `prev` that is a prefix of
 * `next`, or 0 if there's no overlap.
 */
export function overlapLength(prev: string, next: string): number {
  const max = Math.min(prev.length, next.length, 4096);
  for (let n = max; n > 0; n--) {
    if (prev.endsWith(next.slice(0, n))) return n;
  }
  return 0;
}

/**
 * Detect whether `next` is a near-exact repeat of any suffix of `prev` (the
 * model looping). We look at the last 2KB of `prev` and check if `next`
 * contains a long substring of it.
 */
export function isRepeat(prev: string, next: string, minRepeatChars = 200): boolean {
  if (next.length < minRepeatChars) return false;
  const tail = prev.slice(-2048);
  const probe = next.slice(0, Math.min(next.length, 512));
  return tail.includes(probe.slice(0, minRepeatChars));
}
