/**
 * Hostile fixture: exact cross-file duplicate (Pass 1 must catch).
 * Identical to exact-duplicate-a.ts — the detector's Pass 1 (exact hash)
 * must group these two functions and flag them as a cross-file duplicate.
 */
export function hostileExactDuplicateHelper(value: string): string {
  const trimmed = value.trim();
  const lowered = trimmed.toLowerCase();
  const replaced = lowered.replace(/[^a-z0-9]+/g, "-");
  const cleaned = replaced.replace(/^-+|-+$/g, "");
  return cleaned || "fallback";
}
