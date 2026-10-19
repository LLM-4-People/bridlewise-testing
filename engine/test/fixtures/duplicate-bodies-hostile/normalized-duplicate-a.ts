/**
 * Hostile fixture: normalized cross-file duplicate (Pass 2 must catch).
 * Same AST structure as normalized-duplicate-b.ts but with different
 * identifier names. After normalization (Identifier→ID, StringLiteral→STR),
 * the token sequences are identical, so the normalized hash matches and
 * Pass 2 (with jaccardThreshold=1.0) catches the pair.
 *
 * The function has ≥30 normalized AST nodes so it passes the minTokenCount
 * threshold (the hostile sub-test uses minTokenCount=30, the default).
 */
export function validateProfileAlpha(config: { name: string; version: number; enabled: boolean; count: number; ratio: number }): boolean {
  if (config.name === "") return false;
  if (config.version === 0) return false;
  if (config.enabled === false) return false;
  if (config.count < 0) return false;
  if (config.ratio > 1) return false;
  return true;
}
