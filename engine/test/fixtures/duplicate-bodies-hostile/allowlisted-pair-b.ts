/**
 * Hostile fixture: allowlisted pair mirror (Pass 3 confirms the mirror).
 * Identical to allowlisted-pair-a.ts. The test adds the pair to a hostile
 * allowlist and asserts zero findings.
 */
export function hostileAllowlistedHelper(value: string): string {
  const trimmed = value.trim();
  const lowered = trimmed.toLowerCase();
  const replaced = lowered.replace(/[^a-z0-9]+/g, "-");
  const cleaned = replaced.replace(/^-+|-+$/g, "");
  return cleaned || "fallback";
}
