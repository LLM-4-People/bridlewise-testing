/**
 * Hostile fixture: exact cross-file duplicate (Pass 1 must catch).
 * The function body is ≥80 chars so it's above the bodySize threshold.
 */
export function hostileExactDuplicateHelper(value: string): string {
  const trimmed = value.trim();
  const lowered = trimmed.toLowerCase();
  const replaced = lowered.replace(/[^a-z0-9]+/g, "-");
  const cleaned = replaced.replace(/^-+|-+$/g, "");
  return cleaned || "fallback";
}
