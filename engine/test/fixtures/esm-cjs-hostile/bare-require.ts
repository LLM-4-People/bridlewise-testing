/**
 * Hostile fixture: bare `require` in ESM.
 * The detector must flag `require("fs")` in a `.ts` ESM file where `require`
 * is NOT a `createRequire` alias.
 */
export function hostileBareRequire(): void {
  const fs = require("fs");
  void fs;
}
