/**
 * Hostile fixture: `.js`-of-`.ts` import.
 * The import specifier `./foo.js` resolves to `./foo.ts` (which exists as
 * a sibling file). The detector must flag this as a `.js`-of-`.ts` import
 * because `tsconfig.json` enables `rewriteRelativeImportExtensions: true`.
 */
import { fooValue } from "./foo.js";
export function hostileJsOfTsImport(): string {
  return fooValue;
}
