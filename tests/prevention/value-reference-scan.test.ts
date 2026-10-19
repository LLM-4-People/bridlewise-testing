// @vitest-environment node
/**
 * THE SCANNER THAT THE OWNER-BYPASS GUARDS STAND ON.
 *
 * Several prevention tests answer the same question — "does any file outside
 * the owner reach this engine directly?" — and each of them is only as strong
 * as its answer to "what counts as reaching it". That sub-answer used to live
 * in three independently-written regexes, each knowing a different subset of
 * the module syntax, so a bypass only had to be spelled in a form its scanner
 * had never read. One of them was defeated exactly that way during review: a
 * route that reached the symbol-search engine through `await import(…)` left
 * the single-path guard fully green.
 *
 * So the detector is now one shared function, and this file is its own test.
 * A guard's guard is worth having: every assertion below is a spelling that
 * has to be recognised, and the negative half is what stops the fix from
 * being "return true", which would report bypasses that are not there and
 * train everyone to ignore it.
 */
import { describe, test, expect } from "vitest";

import { valueReferencesModule, referencesModule } from "../helpers/source-scan.ts";

const M = "intelligence/symbol-search.ts";
/** The other shape callers pass: a subsystem PREFIX, not a whole path. */
const PREFIX = "engine/src/intelligence/";

describe("value references to a module are recognised in every form that reaches its values", () => {
  const reaches: readonly (readonly [string, string])[] = [
    ["named import", `import { hybridSearchSymbols } from "../x/intelligence/symbol-search.ts";`],
    ["default import", `import engine from "../x/intelligence/symbol-search.ts";`],
    ["namespace import", `import * as engine from "../x/intelligence/symbol-search.ts";`],
    ["side-effect import", `import "../x/intelligence/symbol-search.ts";`],
    ["re-export star", `export * from "../x/intelligence/symbol-search.ts";`],
    ["re-export named", `export { hybridSearchSymbols } from "../x/intelligence/symbol-search.ts";`],
    ["re-export renamed", `export { hybridSearchSymbols as search } from "../x/intelligence/symbol-search.ts";`],
    ["dynamic import", `const m = await import("../x/intelligence/symbol-search.ts");`],
    ["dynamic import, then-style", `import("../x/intelligence/symbol-search.ts").then((m) => m.hybridSearchSymbols);`],
    ["require", `const m = require("../x/intelligence/symbol-search.ts");`],
    [
      "mixed brace list where only SOME specifiers are types",
      `import { type Bm25Index, hybridSearchSymbols } from "../x/intelligence/symbol-search.ts";`,
    ],
    [
      "named import broken across many lines",
      `import {\n  hybridSearchSymbols,\n  findSymbolUsage,\n  buildBm25Index,\n} from "../x/intelligence/symbol-search.ts";`,
    ],
    [
      "value import that follows a type-only import of the same module",
      `import type { Bm25Index } from "../x/intelligence/symbol-search.ts";\nimport { buildBm25Index } from "../x/intelligence/symbol-search.ts";`,
    ],
  ];

  for (const [label, source] of reaches) {
    test(`reaches the module: ${label}`, () => {
      expect(valueReferencesModule(source, M), `"${label}" reaches the module's values but was not recognised`).toBe(true);
    });
  }

  const doesNotReach: readonly (readonly [string, string])[] = [
    ["type-only import", `import type { Bm25Index } from "../x/intelligence/symbol-search.ts";`],
    ["brace list of only type specifiers", `import { type Bm25Index, type HybridSearchResult } from "../x/intelligence/symbol-search.ts";`],
    ["type-only re-export", `export type { Bm25Index } from "../x/intelligence/symbol-search.ts";`],
    ["commented-out import", `// import { hybridSearchSymbols } from "../x/intelligence/symbol-search.ts";`],
    [
      "block-commented import",
      `/*\nimport { hybridSearchSymbols } from "../x/intelligence/symbol-search.ts";\n*/`,
    ],
    ["the path named in prose", `// the engine lives at intelligence/symbol-search.ts and is owned by the bridge`],
    ["a different module entirely", `import { searchMemory } from "../x/intelligence/memory-search.ts";`],
  ];

  for (const [label, source] of doesNotReach) {
    test(`does not reach the module: ${label}`, () => {
      expect(valueReferencesModule(source, M), `"${label}" does not reach the module's values but was reported as a bypass`).toBe(false);
    });
  }

  test("a subsystem PREFIX matches, not only a whole module path", () => {
    // Both shapes are in use: this file's own guard passes a whole path, the
    // bridge-owner guards pass a directory prefix. An implementation that
    // anchored the fragment to the END of the specifier matched nothing at
    // all for the prefix callers — it reported a clean tree while a route
    // reached two subsystems directly, which is the worst kind of green.
    const source = `import * as engine from "../../engine/src/intelligence/repository-map.ts";`;
    expect(valueReferencesModule(source, PREFIX)).toBe(true);
    expect(referencesModule(source, PREFIX)).toBe(true);
  });

  test("a prose string that merely NAMES the module is not attributed to a nearby import", () => {
    // The bound that stops the fix from over-reaching. The specifier here
    // belongs to no import statement; the `import` above it belongs to a
    // different module and has already been terminated.
    const source = [
      `import { readFileSync } from "node:fs";`,
      `const hint = "see integration/src/intelligence/symbol-search.ts for the ranker";`,
    ].join("\n");
    expect(valueReferencesModule(source, M)).toBe(false);
    expect(referencesModule(source, M)).toBe(false);
  });

  test("referencesModule counts a TYPE reference, valueReferencesModule does not", () => {
    // The two functions differ in exactly one thing, and that difference is
    // the reason both exist: some owners forbid even naming the type.
    const source = `import type { Bm25Index } from "../x/intelligence/symbol-search.ts";`;
    expect(valueReferencesModule(source, M)).toBe(false);
    expect(referencesModule(source, M)).toBe(true);
  });

  test("a type-only import does not mask a value import LATER in the same file", () => {
    // The failure this pins is subtle and was real in an earlier regex: a lazy
    // clause that starts at one statement's keyword and runs to a LATER
    // statement's specifier reads the whole pair as one type-only import.
    const source = [
      `import type { HybridSearchResult } from "../x/intelligence/symbol-search.ts";`,
      `import { readFileSync } from "node:fs";`,
      `import { hybridSearchSymbols } from "../x/intelligence/symbol-search.ts";`,
    ].join("\n");
    expect(valueReferencesModule(source, M)).toBe(true);
  });
});
