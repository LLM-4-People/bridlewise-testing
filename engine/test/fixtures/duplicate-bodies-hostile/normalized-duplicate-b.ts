/**
 * Hostile fixture: normalized cross-file duplicate (Pass 2 must catch).
 * Same AST structure as normalized-duplicate-a.ts but with different
 * identifier names (validateProfileBeta vs validateProfileAlpha, item vs
 * config, title vs name, etc.). After normalization the token sequences
 * are identical.
 */
export function validateProfileBeta(item: { name: string; version: number; enabled: boolean; count: number; ratio: number }): boolean {
  if (item.name === "") return false;
  if (item.version === 0) return false;
  if (item.enabled === false) return false;
  if (item.count < 0) return false;
  if (item.ratio > 1) return false;
  return true;
}
