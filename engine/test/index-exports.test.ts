import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import * as PublicApi from "../src/index.ts";

/**
 * INVARIANT #65: the public API barrel (src/index.ts) exports the key factory
 * functions used to embed the harness as a library. Every export must resolve
 * to a function so callers can construct the runtime without reaching into
 * internal modules. A missing or non-function export is a breaking API change.
 *
 * (NO static lists): the expected export names are DYNAMICALLY
 * discovered by parsing the `export {... } from` statements in src/index.ts at
 * test time — never hardcoded. If a new export is added to index.ts, this test
 * automatically covers it; if an export is removed, the test automatically
 * stops requiring it. A hardcoded list would silently miss new exports.
 *
 * (dead exports): the test also verifies there are no EXTRA runtime
 * value exports beyond those declared in the source (a stale export left in
 * the module but removed from the barrel would be caught).
 */

const INDEX_PATH = join(process.cwd(), "src", "index.ts");

/**
 * Parse the value (non-type) export names from the barrel source. Matches
 * `export { name1, name2,... } from "..."` statements, excluding
 * `export type {... }` type-only re-exports (which are erased at runtime).
 */
function discoverValueExports(source: string): string[] {
  const names: string[] = [];
  // Match `export { name1, name2 } from "..."` (value exports, NOT `export type`).
  const exportRegex = /^export\s+\{([^}]+)\}\s+from\s+["'][^"']+["']/gm;
  let match: RegExpExecArray | null;
  while ((match = exportRegex.exec(source)) !== null) {
    const nameList = match[1]!;
    for (const raw of nameList.split(",")) {
      const name = raw.trim();
      if (name.length === 0) continue;
      // Skip `type Foo` inline type exports (e.g. `export { type Foo, bar }`).
      if (name.startsWith("type ")) continue;
      names.push(name);
    }
  }
  return names;
}

test("PublicApi: all value exports declared in index.ts are present", () => {
  const source = readFileSync(INDEX_PATH, "utf8");
  const exports = discoverValueExports(source);
  assert.ok(exports.length > 0, "index.ts must declare at least one value export");
  for (const name of exports) {
    assert.ok(
      name in PublicApi,
      `src/index.ts declares export '${name}' but it is not present in the imported module (missing or broken re-export)`,
    );
  }
});

test("PublicApi: all value exports declared in index.ts are functions", () => {
  const source = readFileSync(INDEX_PATH, "utf8");
  const exports = discoverValueExports(source);
  for (const name of exports) {
    const value = (PublicApi as Record<string, unknown>)[name];
    assert.equal(
      typeof value,
      "function",
      `src/index.ts export '${name}' must be a function, got ${typeof value}`,
    );
  }
});

test("PublicApi: no extra runtime value exports beyond those declared in index.ts (dead export check)", () => {
  // a stale export left in the runtime module but removed from the
  // barrel source would be a dead export. Verify every own enumerable property
  // of the imported module is declared in the source.
  const source = readFileSync(INDEX_PATH, "utf8");
  const declared = new Set(discoverValueExports(source));
  const runtimeKeys = Object.keys(PublicApi).filter((k) => k !== "default");
  const extra = runtimeKeys.filter((k) => !declared.has(k));
  assert.deepEqual(
    extra,
    [],
    `Runtime module has value export(s) not declared in index.ts source (dead/stale exports): ${extra.join(", ")}. ` +
      `Fix: either add the export to index.ts or remove it from the source module. ` +
      `Rule: no dead/stale exports (prevention rule: no-dead-exports, ).`,
  );
});

test("PublicApi: barrel uses explicit named re-exports (no wildcard leakage)", () => {
  const source = readFileSync(INDEX_PATH, "utf8");
  assert.ok(
    !/^\s*export\s+\*/m.test(source),
    "src/index.ts must not use `export *` (explicit named re-exports only)",
  );
});
