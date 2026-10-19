/**
 * Hostile fixture: `__dirname` in ESM.
 * The detector must flag `__dirname` in a `.ts` ESM file (non-type position).
 */
export function hostileDirname(): string {
  return __dirname;
}
