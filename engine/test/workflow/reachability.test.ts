/**
 * THE REACHABILITY WALK (src/workflow/reachability.ts), driven pure over
 * in-memory trees: every edge kind it follows, every edge it reports instead
 * of following, and what is never an edge (a specifier in a comment or
 * inside another string, a directory URL, a builtin). The synthetic closure
 * arms of the retired product census moved here with the walk
 * (merge-door-final §19 PROMO-1).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { moduleSpecifiers, reachabilityChain, reachabilityClosure, spawnedScripts, type ReachabilityInput } from "../../src/workflow/reachability.ts";

function walk(files: Readonly<Record<string, string>>, overrides: Partial<ReachabilityInput> = {}) {
  let rounds = 0;
  const result = reachabilityClosure({
    entryPoints: ["src/main.ts"],
    files: Object.keys(files),
    readTexts: (paths) => {
      rounds += 1;
      return new Map(paths.map((path) => [path, files[path] ?? null]));
    },
    ...overrides,
  });
  return { result, rounds };
}

test("every edge kind is followed: static, re-export, side-effect, dynamic, type-only, a URL worker, a glob, a stylesheet @import, a Svelte script", () => {
  const { result, rounds } = walk({
    "src/main.ts": [
      'import { a } from "./a.ts";',
      'export * from "./b";',
      'import "./side.ts";',
      'const lazy = () => import("./lazy.ts");',
      'import type { T } from "./types.ts";',
      'const worker = new URL("./worker.ts", import.meta.url);',
      'const pages = import.meta.glob("./pages/*.svelte");',
      'import "./style.css";',
    ].join("\n"),
    "src/a.ts": "export const a = 1;\n",
    "src/b/index.ts": "export const b = 1;\n",
    "src/side.ts": "",
    "src/lazy.ts": "",
    "src/types.ts": "export type T = 1;\n",
    "src/worker.ts": "",
    "src/pages/One.svelte": '<script lang="ts">import { helper } from "../helper.ts";</script>\n<p>{"import x from \'./not-an-edge.ts\'"}</p>\n',
    "src/pages/nested/Two.svelte": "",
    "src/helper.ts": "",
    "src/style.css": "/* @import \"./commented.css\"; */\n@import url(\"./base.css\");\n",
    "src/base.css": "",
    "src/commented.css": "",
    "src/unreached.ts": "",
  });
  assert.deepEqual([...result.closure].sort(), [
    "src/a.ts", "src/b/index.ts", "src/base.css", "src/helper.ts", "src/lazy.ts", "src/main.ts", "src/pages/One.svelte",
    "src/side.ts", "src/style.css", "src/types.ts", "src/worker.ts",
  ]);
  assert.deepEqual(result.unresolved, []);
  assert.ok(rounds <= 4, `the walk reads by rounds, not by file (${String(rounds)} rounds)`);
  assert.deepEqual(reachabilityChain(result, "src/helper.ts"), ["src/main.ts", "src/pages/One.svelte", "src/helper.ts"]);
});

test("a specifier in a comment, inside another string or a template is never an edge; a directory URL names no module", () => {
  const specifiers = moduleSpecifiers("src/x.ts", [
    "// import { a } from \"./commented.ts\";",
    "/* import \"./block.ts\"; */",
    'const prose = "nothing you asked for exists, import it from \'./prose.ts\'";',
    "const template = `import { b } from \"./template.ts\"`;",
    'const home = new URL("../../", import.meta.url);',
    'import { real } from "./real.ts";',
  ].join("\n"));
  assert.deepEqual(specifiers, { imports: ["./real.ts"], urls: ["../../"], globs: [], opaque: [] });
  const { result } = walk({ "src/main.ts": 'const home = new URL("../", import.meta.url);\nconst missing = new URL("./gone.wasm", import.meta.url);\n', "src/x.ts": "" });
  assert.deepEqual(result.unresolved, [{ importer: "src/main.ts", specifier: "./gone.wasm" }], "a directory URL is no edge; a missing file URL is unresolved");
});

test("what the walk cannot follow is reported, never dropped: an unresolved edge, an edge into an excluded path, a missing or excluded entry, every package", () => {
  const { result } = walk({
    "src/main.ts": 'import "./gone.ts";\nimport "../dev/tool.ts";\nimport z from "zod";\nimport { x } from "@scope/pkg/sub";\nimport fs from "node:fs";\nimport path from "path";\nimport "./icon.svg?url";\n',
    "src/icon.svg": "<svg/>",
    "dev/tool.ts": 'import "../src/main.ts";\n',
    "dev/entry.ts": "",
  }, { entryPoints: ["src/main.ts", "src/absent.ts", "dev/entry.ts"], isExcluded: (path) => path.startsWith("dev/") });
  assert.deepEqual(result.missingEntries, ["src/absent.ts", "dev/entry.ts"]);
  assert.deepEqual(result.unresolved, [{ importer: "src/main.ts", specifier: "./gone.ts" }]);
  assert.deepEqual(result.intoExcluded, [{ importer: "src/main.ts", specifier: "../dev/tool.ts", target: "dev/tool.ts" }]);
  assert.deepEqual(result.bareImports, [{ importer: "src/main.ts", specifier: "zod" }, { importer: "src/main.ts", specifier: "@scope/pkg/sub" }], "builtins are never packages");
  assert.ok(result.closure.has("src/icon.svg"), "a ?query suffix is dropped before resolution");
  assert.equal(result.closure.has("dev/tool.ts"), false);
});

test("a path alias resolves for importers under the directory that declares it, the most specific first", () => {
  const { result } = walk({
    "src/main.ts": 'import { c } from "@app/contracts";\nimport { u } from "@app/util/strings";\n',
    "lib/contracts.ts": "",
    "lib/util/strings.ts": "",
  }, {
    aliases: [
      { directory: "", pattern: "@app/contracts", targets: ["lib/contracts.ts"] },
      { directory: "", pattern: "@app/util/*", targets: ["lib/util/*"] },
      { directory: "other/", pattern: "@app/contracts", targets: ["nowhere.ts"] },
    ],
  });
  assert.deepEqual([...result.closure].sort(), ["lib/contracts.ts", "lib/util/strings.ts", "src/main.ts"]);
  assert.deepEqual(result.bareImports, []);
});

test("THE SPAWN ARM (moved from the census): a declared spawn call admits the script the tree carries and walks its imports; a script the tree lacks, or the walk may not enter, admits nothing", () => {
  const files = {
    "src/main.ts": 'import { drive } from "./spawn-driver.ts";\nconsole.log(drive);\n',
    "src/spawn-driver.ts": [
      "export const drive = true;",
      'runScriptSubprocess(root, "scripts/gen.ts", ["--emit"], 1000);',
      'runScriptSubprocess(\n  resolve(root, "x"),\n  "scripts/absent-runner.ts", ["--check"], 1000);',
      'runScriptSubprocess(root, "scripts/excluded/runner.ts");',
      'runScriptSubprocess(root, variableName);',
    ].join("\n"),
    "tools/scripts/gen.ts": 'import { dep } from "./gen-dep.ts";\nconsole.log(dep);\n',
    "tools/scripts/gen-dep.ts": "export const dep = true;\n",
    "tools/scripts/excluded/runner.ts": "",
  };
  const spawnCalls = [{ callee: "runScriptSubprocess", argument: 1, base: "tools/" }];
  assert.deepEqual(spawnedScripts("src/spawn-driver.ts", files["src/spawn-driver.ts"], spawnCalls), {
    scripts: ["tools/scripts/gen.ts", "tools/scripts/absent-runner.ts", "tools/scripts/excluded/runner.ts"],
    opaque: ["runScriptSubprocess(…, <computed argument 1>)"],
  });
  const { result } = walk(files, { spawnCalls, isExcluded: (path) => path.startsWith("tools/scripts/excluded/") });
  assert.deepEqual([...result.closure].sort(), ["src/main.ts", "src/spawn-driver.ts", "tools/scripts/gen-dep.ts", "tools/scripts/gen.ts"]);
  assert.deepEqual(result.intoExcluded, [], "a spawn into an excluded path is a conditional invocation, not an edge");
  assert.deepEqual(result.unresolved, []);
  assert.deepEqual(result.opaque, [{ importer: "src/spawn-driver.ts", detail: "runScriptSubprocess(…, <computed argument 1>)" }], "a spawn no literal names is reported");
});

test("PC-2: a regex literal after `=>`, after a statement head's `)` or after a keyword, and a backtick inside a template substitution, never swallow the edges after them", () => {
  const after = 'const w = new URL("./worker.ts", import.meta.url);\nconst m = await import("./lazy.ts");\nimport { s } from "./static.ts";\n';
  for (const [name, prefix] of [
    ["arrow", "const f = (s: string) => /'/.test(s);\n"],
    ["statement head", 'if (x) /"/.test(s);\n'],
    ["keyword", "function g() { return /`/.test(s); }\n"],
    ["nested template", "const a = `x ${cond ? `y` : `z`} w`;\n"],
    ["backtick string in a substitution", 'const a = `x ${"`"} y`;\n'],
  ] as const) {
    assert.deepEqual(moduleSpecifiers("src/a.ts", `${prefix}${after}`), { imports: ["./lazy.ts", "./static.ts"], urls: ["./worker.ts"], globs: [], opaque: [] }, name);
  }
  // Division stays division: the quote after it opens a string, not a regex's body.
  assert.deepEqual(moduleSpecifiers("src/a.ts", `const r = a / b; const q = c / 'd'; i++ / 2;\n${after}`).imports, ["./lazy.ts", "./static.ts"]);
});

test("PC-2: CommonJS and TypeScript requires are edges; glob arrays and {a,b} alternatives expand; a computed or empty edge is reported as opaque", () => {
  assert.deepEqual(moduleSpecifiers("src/a.cjs", 'const h = require("./helper.cjs");\nfunction require(x) { return x; }\n'), { imports: ["./helper.cjs"], urls: [], globs: [], opaque: [] });
  assert.deepEqual(moduleSpecifiers("src/a.ts", 'import fs = require("./legacy.ts");\n').imports, ["./legacy.ts"]);
  assert.deepEqual(moduleSpecifiers("src/a.ts", "const a = await import(name);\nconst b = await import(`./t.ts`);\nconst c = require(dynamic);\nconst g = import.meta.glob(pattern);\n"), {
    imports: ["./t.ts"], urls: [], globs: [], opaque: ["import(<computed>)", "require(<computed>)", "import.meta.glob(<computed>)"],
  });
  const { result } = walk({
    "src/main.ts": 'const pages = import.meta.glob(["./pages/*.svelte", "./extra/{a,b}.ts"]);\nconst none = import.meta.glob("./nowhere/*.ts");\nconst legacy = require("./legacy.cjs");\n',
    "src/pages/One.svelte": "",
    "src/extra/a.ts": "",
    "src/extra/b.ts": "",
    "src/extra/c.ts": "",
    "src/legacy.cjs": "",
  });
  assert.deepEqual([...result.closure].sort(), ["src/extra/a.ts", "src/extra/b.ts", "src/legacy.cjs", "src/main.ts", "src/pages/One.svelte"]);
  assert.deepEqual(result.opaque, [{ importer: "src/main.ts", detail: 'import.meta.glob("./nowhere/*.ts") matches nothing' }]);
});

test("a recursive glob reaches every depth below its folder, the folder itself included (the census's `**` dropped its separator and matched nothing)", () => {
  const { result } = walk({
    "src/main.ts": 'const stores = import.meta.glob("./state/**/*.ts", { eager: true });\nconst any = import.meta.glob("./deep/**");\n',
    "src/state/a.ts": "",
    "src/state/sub/b.ts": "",
    "src/statex.ts": "",
    "src/deep/x/y.json": "",
  });
  assert.deepEqual([...result.closure].sort(), ["src/deep/x/y.json", "src/main.ts", "src/state/a.ts", "src/state/sub/b.ts"]);
  assert.deepEqual(result.opaque, []);
});

test("PC-2: a symbolic link reaches its target; a link naming nothing is unresolved; seeds are walked without being entries", () => {
  const links: Readonly<Record<string, string>> = { "p/link.ts": "../lib/real.ts", "p/dangling.ts": "../lib/gone.ts" };
  const { result } = walk({
    "src/main.ts": 'import "../p/link.ts";\nimport "../p/dangling.ts";\n',
    "p/link.ts": "../lib/real.ts",
    "p/dangling.ts": "../lib/gone.ts",
    "lib/real.ts": "export const x = 1;\n",
    "extra/seed.ts": 'import "./dep.ts";\n',
    "extra/dep.ts": "",
  }, { linkTarget: (path) => links[path] ?? null, seeds: ["extra/seed.ts", "extra/absent.ts"] });
  assert.deepEqual([...result.closure].sort(), ["extra/dep.ts", "extra/seed.ts", "lib/real.ts", "p/dangling.ts", "p/link.ts", "src/main.ts"]);
  assert.deepEqual(reachabilityChain(result, "lib/real.ts"), ["src/main.ts", "p/link.ts", "lib/real.ts"]);
  assert.deepEqual(result.unresolved, [{ importer: "p/dangling.ts", specifier: "../lib/gone.ts" }]);
  assert.deepEqual(result.missingEntries, [], "a seed the tree lacks is not a missing entry");
  assert.equal(result.reachedFrom.has("extra/seed.ts"), false);
  assert.equal(result.reachedFrom.get("extra/dep.ts"), "extra/seed.ts");
});

test("every code extension the language owner counts is walked: an .mts and a .cts module's own imports are followed", () => {
  const { result } = walk({
    "src/main.ts": 'import "./esm.mts";\nimport "./cjs.cts";\n',
    "src/esm.mts": 'import "./from-esm.ts";\n',
    "src/cjs.cts": 'import "./from-cjs.ts";\n',
    "src/from-esm.ts": "",
    "src/from-cjs.ts": "",
    "src/unreached.mts": 'import "./never.ts";\n',
  });
  for (const path of ["src/esm.mts", "src/cjs.cts", "src/from-esm.ts", "src/from-cjs.ts"]) assert.ok(result.closure.has(path), path);
  assert.equal(result.closure.has("src/unreached.mts"), false, "a near-miss: nothing imports it");
});
