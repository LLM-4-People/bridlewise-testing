/**
 * Hostile fixture: allowlisted pair (Pass 3 confirms the mirror — no
 * finding). The test computes this function's exact hash, adds it to a
 * hostile allowlist, and asserts the detector returns zero findings.
 */
export function hostileAllowlistedHelper(value: string): string {
  const trimmed = value.trim();
  const lowered = trimmed.toLowerCase();
  const replaced = lowered.replace(/[^a-z0-9]+/g, "-");
  const cleaned = replaced.replace(/^-+|-+$/g, "");
  return cleaned || "fallback";
}
