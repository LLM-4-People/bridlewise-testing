# esm cjs hostile

The `engine/test/fixtures/esm-cjs-hostile/` folder of the development surface.

## What each file does

- `bare-require.ts` — hostile fixture: bare `require` in.
- `dirname.ts` — hostile fixture: `__dirname` in.
- `foo.ts` — hostile fixture: sibling `.ts` file for the `.js`-of-`.ts` import test. `js-of-ts-import.ts` imports `./foo.js` which resolves to this file.
- `import-in-cjs.cjs` — hostile fixture: `import` declaration in `.cjs`. The detector must flag `import` in a `.cjs` file.
- `import-meta-in-cjs.cjs` — hostile fixture: `import.meta` in `.cjs`. The detector must flag `import.meta` in a `.cjs` file.
- `js-of-ts-import.ts` — hostile fixture: `.js`-of-`.ts` import.
- `module-exports.ts` — hostile fixture: `module.exports =` in.

## Where it lives and what consumes it

The folder lives at `engine/test/fixtures/esm-cjs-hostile/`.
