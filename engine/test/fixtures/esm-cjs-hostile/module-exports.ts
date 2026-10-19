/**
 * Hostile fixture: `module.exports =` in ESM.
 * The detector must flag `module.exports` assignment in a `.ts` ESM file
 * where `module` is a free identifier (not a local binding).
 */
export function hostileModuleExports(): void {
  module.exports = { hostile: true };
}
