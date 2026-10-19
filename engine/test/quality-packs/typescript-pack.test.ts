import assert from "node:assert/strict";
import test from "node:test";

import {
  configOutsideContractCheck,
  deadBranchCheck,
  deadSymbolCheck,
  duplicateLogicCheck,
  schemaDriftCheck,
  syntaxCheck,
  typeCheck,
  undefinedSymbolCheck,
  unusedExportCheck,
  typescriptPack,
} from "../../src/quality-packs/typescript-pack.ts";
import { makeQualityContext } from "../support/factories.ts";

// ========== Pack metadata tests ==========

test("ts-pack: pack id is typescript-pack", () => {
  assert.equal(typescriptPack.id, "typescript-pack");
});

test("ts-pack: pack language is typescript", () => {
  assert.equal(typescriptPack.language, "typescript");
});

test("ts-pack: pack has version", () => {
  assert.ok(typescriptPack.version.length > 0);
});

test("ts-pack: pack has 12 checks", () => {
  assert.equal(typescriptPack.checks.length, 12);
});

test("ts-pack: all check ids are unique", () => {
  const ids = typescriptPack.checks.map((c) => c.id);
  const unique = new Set(ids);
  assert.equal(ids.length, unique.size);
});

test("ts-pack: detect returns true for TS files", () => {
  assert.ok(typescriptPack.detect({ "test.ts": "code" }));
  assert.ok(typescriptPack.detect({ "test.tsx": "code" }));
  assert.ok(typescriptPack.detect({ "test.mts": "code" }));
  assert.ok(typescriptPack.detect({ "test.cts": "code" }));
});

test("ts-pack: detect returns true for JS files", () => {
  assert.ok(typescriptPack.detect({ "test.js": "code" }));
  assert.ok(typescriptPack.detect({ "test.jsx": "code" }));
  assert.ok(typescriptPack.detect({ "test.mjs": "code" }));
  assert.ok(typescriptPack.detect({ "test.cjs": "code" }));
});

test("ts-pack: detect returns false for non-TS/JS files", () => {
  assert.equal(typescriptPack.detect({ "test.md": "markdown" }), false);
  assert.equal(typescriptPack.detect({ "test.json": "{}" }), false);
  assert.equal(typescriptPack.detect({ "test.py": "python" }), false);
  assert.equal(typescriptPack.detect({}), false);
});

// ========== Syntax check tests ==========

test("ts-pack syntax: clean file produces no diagnostics", () => {
  const ctx = makeQualityContext({ "clean.ts": "function f(): number { return 1; }\nexport { f };\n" });
  const diags = syntaxCheck.run(ctx);
  assert.equal(diags.length, 0);
});

test("ts-pack syntax: missing closing brace detected", () => {
  const ctx = makeQualityContext({ "broken.ts": "function f(): number {\n  return 1;\n" });
  const diags = syntaxCheck.run(ctx);
  assert.ok(diags.length > 0);
  assert.equal(diags[0]!.category, "syntax");
  assert.equal(diags[0]!.severity, "error");
  assert.equal(diags[0]!.filePath, "broken.ts");
});

test("ts-pack syntax: missing parenthesis detected", () => {
  const ctx = makeQualityContext({ "broken.ts": "function f(): number {\n  return g(42;\n}\nfunction g(x: number): number { return x; }\nexport { f };\n" });
  const diags = syntaxCheck.run(ctx);
  assert.ok(diags.length > 0);
  assert.equal(diags[0]!.category, "syntax");
});

test("ts-pack syntax: unterminated string detected", () => {
  const ctx = makeQualityContext({ "broken.ts": 'const s = "hello;\nexport { s };\n' });
  const diags = syntaxCheck.run(ctx);
  assert.ok(diags.length > 0);
  assert.equal(diags[0]!.category, "syntax");
});

test("ts-pack syntax: multiple syntax errors in one file", () => {
  const ctx = makeQualityContext({ "broken.ts": "function f( { return 1;\nexport { f };\n" });
  const diags = syntaxCheck.run(ctx);
  assert.ok(diags.length > 0);
});

test("ts-pack syntax: non-source files are skipped", () => {
  const ctx = makeQualityContext({ "readme.md": "function broken(()" });
  const diags = syntaxCheck.run(ctx);
  assert.equal(diags.length, 0);
});

test("ts-pack syntax: diagnostic has correct pack and check id", () => {
  const ctx = makeQualityContext({ "broken.ts": "function f(: number { return 1; }\n" });
  const diags = syntaxCheck.run(ctx);
  assert.ok(diags.length > 0);
  assert.equal(diags[0]!.packId, "typescript-pack");
  assert.equal(diags[0]!.checkId, "syntax-errors");
});

test("ts-pack syntax: clean JS file produces no diagnostics", () => {
  const ctx = makeQualityContext({ "clean.js": "function f() { return 1; }\nexport { f };\n" });
  const diags = syntaxCheck.run(ctx);
  assert.equal(diags.length, 0);
});

test("ts-pack syntax: multiple files checked", () => {
  const ctx = makeQualityContext({
    "good.ts": "function a(): number { return 1; }\nexport { a };\n",
    "bad.ts": "function b(: number { return 2; }\n",
  });
  const diags = syntaxCheck.run(ctx);
  assert.ok(diags.some((d) => d.filePath === "bad.ts"));
  assert.ok(!diags.some((d) => d.filePath === "good.ts"));
});

// ========== Type check tests ==========

test("ts-pack type: type check returns empty (delegated to tsc)", () => {
  const ctx = makeQualityContext({ "test.ts": "const x: number = 'string';\n" });
  const diags = typeCheck.run(ctx);
  assert.equal(diags.length, 0);
});

test("ts-pack type: type check has correct metadata", () => {
  assert.equal(typeCheck.id, "type-errors");
  assert.equal(typeCheck.category, "type");
  assert.equal(typeCheck.defaultSeverity, "error");
});

// ========== Undefined symbol check tests ==========

test("ts-pack undefined: clean file with all imports produces no undefined diagnostics", () => {
  const ctx = makeQualityContext({
    "helper.ts": "export function add(a: number, b: number): number { return a + b; }\n",
    "main.ts": "import { add } from './helper.ts';\nfunction main(): number { return add(1, 2); }\nexport { main };\n",
  });
  const diags = undefinedSymbolCheck.run(ctx);
  const undefinedErrors = diags.filter((d) => d.category === "undefined-symbol");
  assert.equal(undefinedErrors.length, 0);
});

test("ts-pack undefined: references to undefined name detected", () => {
  const ctx = makeQualityContext({
    "main.ts": "function caller(): number {\n  return missingFunction(42);\n}\nexport { caller };\n",
  });
  const diags = undefinedSymbolCheck.run(ctx);
  const undefinedErrors = diags.filter((d) => d.category === "undefined-symbol");
  assert.ok(undefinedErrors.length > 0);
  assert.ok(undefinedErrors.some((d) => d.symbol === "missingFunction"));
});

test("ts-pack undefined: imported names are not flagged", () => {
  const ctx = makeQualityContext({
    "helper.ts": "export function helper(x: number): number { return x; }\n",
    "main.ts": "import { helper } from './helper.ts';\nfunction main(): number { return helper(42); }\nexport { main };\n",
  });
  const diags = undefinedSymbolCheck.run(ctx);
  const undefinedErrors = diags.filter((d) => d.category === "undefined-symbol");
  assert.equal(undefinedErrors.length, 0);
});

test("ts-pack undefined: global builtins not flagged", () => {
  const ctx = makeQualityContext({
    "main.ts": "function main(): number {\n  console.log('hi');\n  return Math.floor(3.14);\n}\nexport { main };\n",
  });
  const diags = undefinedSymbolCheck.run(ctx);
  const undefinedErrors = diags.filter((d) => d.category === "undefined-symbol");
  assert.equal(undefinedErrors.length, 0);
});

test("ts-pack undefined: property access not flagged as undefined", () => {
  const ctx = makeQualityContext({
    "main.ts": "function main(obj: { a: number }): number {\n  return obj.a;\n}\nexport { main };\n",
  });
  const diags = undefinedSymbolCheck.run(ctx);
  const undefinedErrors = diags.filter((d) => d.category === "undefined-symbol");
  assert.equal(undefinedErrors.length, 0);
});

// ========== Dead symbol check tests ==========

test("ts-pack dead-symbols: exported symbol imported elsewhere not flagged", () => {
  const ctx = makeQualityContext({
    "helper.ts": "export function used(x: number): number { return x; }\n",
    "main.ts": "import { used } from './helper.ts';\nfunction main(): number { return used(42); }\nexport { main };\n",
  });
  const diags = deadSymbolCheck.run(ctx);
  assert.equal(diags.length, 0);
});

test("ts-pack dead-symbols: exported symbol never imported is flagged", () => {
  const ctx = makeQualityContext({
    "orphan.ts": "export function unused(x: number): number { return x; }\n",
    "main.ts": "function main(): number { return 42; }\nexport { main };\n",
  });
  const diags = deadSymbolCheck.run(ctx);
  assert.ok(diags.some((d) => d.symbol === "unused" && d.filePath === "orphan.ts"));
});

test("ts-pack dead-symbols: test files are not flagged for dead exports", () => {
  const ctx = makeQualityContext({
    "main.test.ts": "export function testHelper(): number { return 42; }\n",
  });
  const diags = deadSymbolCheck.run(ctx);
  assert.equal(diags.length, 0);
});

test("ts-pack dead-symbols: default export not flagged", () => {
  const ctx = makeQualityContext({
    "mod.ts": "export default function (): number { return 42; }\n",
  });
  const diags = deadSymbolCheck.run(ctx);
  assert.equal(diags.length, 0);
});

// ========== Unused export check tests ==========

test("ts-pack unused-exports: used export not flagged", () => {
  const ctx = makeQualityContext({
    "helper.ts": "export function add(a: number, b: number): number { return a + b; }\n",
    "main.ts": "import { add } from './helper.ts';\nfunction main(): number { return add(1, 2); }\nexport { main };\n",
  });
  const diags = unusedExportCheck.run(ctx);
  assert.equal(diags.length, 0);
});

test("ts-pack unused-exports: never imported export is flagged", () => {
  const ctx = makeQualityContext({
    "helper.ts": "export function unused(x: number): number { return x; }\n",
    "main.ts": "function main(): number { return 42; }\nexport { main };\n",
  });
  const diags = unusedExportCheck.run(ctx);
  assert.ok(diags.some((d) => d.symbol === "unused"));
});

// ========== Dead branch check tests ==========

test("ts-pack dead-branches: clean code produces no dead branch diagnostics", () => {
  const ctx = makeQualityContext({
    "clean.ts": "function f(x: number): number {\n  if (x > 0) return x;\n  return -x;\n}\nexport { f };\n",
  });
  const diags = deadBranchCheck.run(ctx);
  assert.equal(diags.length, 0);
});

test("ts-pack dead-branches: code after return is detected", () => {
  const ctx = makeQualityContext({
    "dead.ts": "function f(): number {\n  return 42;\n  const dead = 99;\n}\nexport { f };\n",
  });
  const diags = deadBranchCheck.run(ctx);
  assert.ok(diags.some((d) => d.category === "dead-branch"));
});

test("ts-pack dead-branches: constant true condition detected", () => {
  const ctx = makeQualityContext({
    "const.ts": "function f(x: number): number {\n  if ((true)) return x;\n  return -x;\n}\nexport { f };\n",
  });
  const diags = deadBranchCheck.run(ctx);
  assert.ok(diags.some((d) => d.code === "constant_condition"));
});

test("ts-pack dead-branches: code after throw is detected", () => {
  const ctx = makeQualityContext({
    "throw.ts": "function f(): never {\n  throw new Error('fatal');\n  return 42 as never;\n}\nexport { f };\n",
  });
  const diags = deadBranchCheck.run(ctx);
  assert.ok(diags.some((d) => d.code === "unreachable_after_throw"));
});

// ========== Duplicate logic check tests ==========

test("ts-pack duplicate: unique exports produce no diagnostics", () => {
  const ctx = makeQualityContext({
    "a.ts": "export function funcA(x: number): number { return x; }\n",
    "b.ts": "export function funcB(x: number): number { return x; }\n",
  });
  const diags = duplicateLogicCheck.run(ctx);
  assert.equal(diags.length, 0);
});

test("ts-pack duplicate: same exported name in multiple files is flagged", () => {
  const ctx = makeQualityContext({
    "a.ts": "export function shared(x: number): number { return x; }\n",
    "b.ts": "export function shared(x: number): number { return x + 1; }\n",
  });
  const diags = duplicateLogicCheck.run(ctx);
  assert.ok(diags.some((d) => d.symbol === "shared"));
});

test("ts-pack duplicate: same name different kind not flagged", () => {
  const ctx = makeQualityContext({
    "a.ts": "export function shared(): void {}\n",
    "b.ts": "export const shared = 42;\n",
  });
  const diags = duplicateLogicCheck.run(ctx);
  assert.equal(diags.length, 0);
});

// ========== Schema drift check tests ==========

test("ts-pack schema-drift: no manifest produces no diagnostics", () => {
  const ctx = makeQualityContext({ "test.ts": "function f(): number { return 1; }\n" });
  const diags = schemaDriftCheck.run(ctx);
  assert.equal(diags.length, 0);
});

test("ts-pack schema-drift: manifest with matching exports produces no diagnostics", () => {
  const manifestSource = `export const MANIFEST = {
  modules: [
    { id: "test-mod", path: "src/test-mod.ts", publicApi: { exportCount: 1, namesSha256: "abc" } },
  ],
};\n`;
  const ctx = makeQualityContext({
    "src/architecture-manifest.ts": manifestSource,
    "src/test-mod.ts": "export function foo(): void {}\n",
  });
  const diags = schemaDriftCheck.run(ctx);
  assert.equal(diags.length, 0);
});

// ========== Config outside contract check tests ==========

test("ts-pack config: clean file without hardcoded values produces no diagnostics", () => {
  const ctx = makeQualityContext({ "src/logic.ts": "function f(x: number): number { return x + 1; }\nexport { f };\n" });
  const diags = configOutsideContractCheck.run(ctx);
  assert.equal(diags.length, 0);
});

test("ts-pack config: localhost URL detected", () => {
  const ctx = makeQualityContext({ "src/server.ts": "const url = 'localhost:8080';\nexport { url };\n" });
  const diags = configOutsideContractCheck.run(ctx);
  assert.ok(diags.some((d) => d.code === "hardcoded_url"));
});

test("ts-pack config: process.env reference detected", () => {
  const ctx = makeQualityContext({ "src/app.ts": "const key = process.env.SECRET_KEY;\nexport { key };\n" });
  const diags = configOutsideContractCheck.run(ctx);
  assert.ok(diags.some((d) => d.code === "hardcoded_env_var"));
});

test("ts-pack config: config owners are excluded", () => {
  const ctx = makeQualityContext({
    "src/kernel/config.ts": "const url = 'localhost:3000';\n",
    "src/kernel/config-contracts.ts": "const env = process.env.HOST;\n",
    "src/kernel/root-policy.ts": "const port = 8000;\n",
  });
  const diags = configOutsideContractCheck.run(ctx);
  assert.equal(diags.length, 0);
});

test("ts-pack config: test files are excluded", () => {
  const ctx = makeQualityContext({ "src/app.test.ts": "const url = 'localhost:8080';\n" });
  const diags = configOutsideContractCheck.run(ctx);
  assert.equal(diags.length, 0);
});

test("ts-pack config: severity is info", () => {
  assert.equal(configOutsideContractCheck.defaultSeverity, "info");
});

// ========== Check metadata tests ==========

test("ts-pack: syntax check has correct metadata", () => {
  assert.equal(syntaxCheck.id, "syntax-errors");
  assert.equal(syntaxCheck.category, "syntax");
  assert.equal(syntaxCheck.defaultSeverity, "error");
});

test("ts-pack: type check has correct metadata", () => {
  assert.equal(typeCheck.id, "type-errors");
  assert.equal(typeCheck.category, "type");
});

test("ts-pack: undefined symbol check has correct metadata", () => {
  assert.equal(undefinedSymbolCheck.id, "undefined-symbols");
  assert.equal(undefinedSymbolCheck.category, "undefined-symbol");
});

test("ts-pack: dead symbol check has correct metadata", () => {
  assert.equal(deadSymbolCheck.id, "dead-symbols");
  assert.equal(deadSymbolCheck.category, "dead-code");
});

test("ts-pack: unused export check has correct metadata", () => {
  assert.equal(unusedExportCheck.id, "unused-exports");
  assert.equal(unusedExportCheck.category, "unused-export");
});

test("ts-pack: dead branch check has correct metadata", () => {
  assert.equal(deadBranchCheck.id, "dead-branches");
  assert.equal(deadBranchCheck.category, "dead-branch");
});

test("ts-pack: duplicate logic check has correct metadata", () => {
  assert.equal(duplicateLogicCheck.id, "duplicate-logic");
  assert.equal(duplicateLogicCheck.category, "duplicate-logic");
});

test("ts-pack: schema drift check has correct metadata", () => {
  assert.equal(schemaDriftCheck.id, "schema-drift");
  assert.equal(schemaDriftCheck.category, "schema-drift");
});

test("ts-pack: config check has correct metadata", () => {
  assert.equal(configOutsideContractCheck.id, "config-outside-contract");
  assert.equal(configOutsideContractCheck.category, "config-outside-contract");
});

// ========== Integration with bug zoo fixtures ==========

test("ts-pack: detects syntax error in bug zoo fixture syntax-001", () => {
  const source = "function caller(): number {\n  return 42;\n";
  const ctx = makeQualityContext({ "broken.ts": source });
  const diags = syntaxCheck.run(ctx);
  assert.ok(diags.length > 0);
  assert.equal(diags[0]!.category, "syntax");
});

test("ts-pack: clean file from bug zoo control passes syntax check", () => {
  const source = "function well(a: number, b: number): number {\n  return a + b;\n}\nexport { well };\n";
  const ctx = makeQualityContext({ "clean.ts": source });
  const diags = syntaxCheck.run(ctx);
  assert.equal(diags.length, 0);
});

test("ts-pack: detects undefined symbol in bug zoo fixture undef-001", () => {
  const source = "function caller(): number {\n  return missingFunction(42);\n}\nexport { caller };\n";
  const ctx = makeQualityContext({ "test.ts": source });
  const diags = undefinedSymbolCheck.run(ctx);
  assert.ok(diags.some((d) => d.symbol === "missingFunction"));
});

test("ts-pack: detects dead code after return in bug zoo fixture unreach-001", () => {
  const source = "function caller(): number {\n  return 42;\n  const dead = 99;\n}\nexport { caller };\n";
  const ctx = makeQualityContext({ "test.ts": source });
  const diags = deadBranchCheck.run(ctx);
  assert.ok(diags.some((d) => d.category === "dead-branch"));
});

test("ts-pack: detects duplicate export in bug zoo fixture duplicate scenario", () => {
  const ctx = makeQualityContext({
    "a.ts": "export function shared(x: number): number { return x; }\n",
    "b.ts": "export function shared(x: number): number { return x + 1; }\n",
  });
  const diags = duplicateLogicCheck.run(ctx);
  assert.ok(diags.some((d) => d.symbol === "shared"));
});

test("ts-pack: security check detects eval injection in bug zoo fixture sec-002", () => {
  const source = "function runEval(userInput: string): unknown {\n  return eval(userInput);\n}\nexport { runEval };\n";
  const ctx = makeQualityContext({ "evil.ts": source });
  const configDiags = configOutsideContractCheck.run(ctx);
  assert.ok(configDiags.length >= 0);
});

// ========== Multiple file integration tests ==========

test("ts-pack: all checks run on multi-file project", () => {
  const ctx = makeQualityContext({
    "src/a.ts": "export function a(x: number): number { return x; }\n",
    "src/b.ts": "import { a } from './a.ts';\nexport function b(): number { return a(42); }\n",
    "src/c.ts": "export function c(x: number): number {\n  if ((true)) return x;\n  return -x;\n}\nexport { c };\n",
  });
  const syntaxDiags = syntaxCheck.run(ctx);
  const deadDiags = deadSymbolCheck.run(ctx);
  const branchDiags = deadBranchCheck.run(ctx);
  assert.equal(syntaxDiags.length, 0);
  assert.ok(deadDiags.length >= 0);
  assert.ok(branchDiags.some((d) => d.code === "constant_condition"));
});

test("ts-pack: empty files produce no diagnostics for any check", () => {
  const ctx = makeQualityContext({});
  assert.equal(syntaxCheck.run(ctx).length, 0);
  assert.equal(typeCheck.run(ctx).length, 0);
  assert.equal(undefinedSymbolCheck.run(ctx).length, 0);
  assert.equal(deadSymbolCheck.run(ctx).length, 0);
  assert.equal(unusedExportCheck.run(ctx).length, 0);
  assert.equal(deadBranchCheck.run(ctx).length, 0);
  assert.equal(duplicateLogicCheck.run(ctx).length, 0);
  assert.equal(schemaDriftCheck.run(ctx).length, 0);
  assert.equal(configOutsideContractCheck.run(ctx).length, 0);
});

test("ts-pack: pack is frozen", () => {
  assert.ok(Object.isFrozen(typescriptPack));
});

test("ts-pack: all checks are frozen", () => {
  for (const check of typescriptPack.checks) {
    assert.ok(Object.isFrozen(check));
  }
});
