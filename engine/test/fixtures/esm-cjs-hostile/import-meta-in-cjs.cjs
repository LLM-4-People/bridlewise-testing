/**
 * Hostile fixture: `import.meta` in `.cjs`.
 * The detector must flag `import.meta` in a `.cjs` file (CommonJS doesn't
 * support `import.meta`). Plain JS syntax (no TypeScript annotations).
 */
export function hostileImportMetaInCjs() {
  return import.meta.url;
}
