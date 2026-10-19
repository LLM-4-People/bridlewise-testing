/**
 * Hostile fixture: `import` declaration in `.cjs`.
 * The detector must flag `import` in a `.cjs` file (CommonJS doesn't support
 * ESM import declarations). Plain JS syntax (no TypeScript annotations).
 */
import { readFileSync } from "node:fs";
export function hostileImportInCjs() {
  return readFileSync("/dev/null", "utf8");
}
