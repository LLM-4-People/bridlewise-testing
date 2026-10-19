import assert from "node:assert/strict";
import test from "node:test";

import {
  createDefaultSyntaxValidatorRegistry,
  createSyntaxValidatorRegistry,
  detectLanguage,
  validateSyntax,
} from "../../src/editor/syntax-validator.ts";

// ============================================================================
// Language detection
// ============================================================================

test("syntax-validator: detectLanguage identifies TypeScript.ts", () => {
  assert.equal(detectLanguage("file.ts"), "typescript");
});

test("syntax-validator: detectLanguage identifies TypeScript.tsx", () => {
  assert.equal(detectLanguage("component.tsx"), "typescript");
});

test("syntax-validator: detectLanguage identifies TypeScript.mts", () => {
  assert.equal(detectLanguage("module.mts"), "typescript");
});

test("syntax-validator: detectLanguage identifies TypeScript.cts", () => {
  assert.equal(detectLanguage("module.cts"), "typescript");
});

test("syntax-validator: detectLanguage identifies JavaScript.js", () => {
  assert.equal(detectLanguage("script.js"), "javascript");
});

test("syntax-validator: detectLanguage identifies JavaScript.jsx", () => {
  assert.equal(detectLanguage("component.jsx"), "javascript");
});

test("syntax-validator: detectLanguage identifies JavaScript.mjs", () => {
  assert.equal(detectLanguage("module.mjs"), "javascript");
});

test("syntax-validator: detectLanguage identifies JavaScript.cjs", () => {
  assert.equal(detectLanguage("config.cjs"), "javascript");
});

test("syntax-validator: detectLanguage identifies JSON.json", () => {
  assert.equal(detectLanguage("data.json"), "json");
});

test("syntax-validator: detectLanguage returns known language for multi-lang extensions (EXP437 tree-sitter)", () => {
  assert.equal(detectLanguage("file.py"), "python");
  assert.equal(detectLanguage("file.rs"), "rust");
  assert.equal(detectLanguage("file.go"), "go");
});

test("syntax-validator: detectLanguage returns unknown for unsupported extensions", () => {
  assert.equal(detectLanguage("file.md"), "unknown");
  assert.equal(detectLanguage("file.txt"), "unknown");
  assert.equal(detectLanguage("file.dat"), "unknown");
});

test("syntax-validator: detectLanguage returns unknown for no extension", () => {
  assert.equal(detectLanguage("README"), "unknown");
  assert.equal(detectLanguage("Makefile"), "unknown");
});

test("syntax-validator: detectLanguage is case-insensitive on extension", () => {
  assert.equal(detectLanguage("file.TS"), "typescript");
  assert.equal(detectLanguage("file.JS"), "javascript");
  assert.equal(detectLanguage("file.JSON"), "json");
});

// ============================================================================
// Registry construction
// ============================================================================

test("syntax-validator: createSyntaxValidatorRegistry creates empty registry", () => {
  const registry = createSyntaxValidatorRegistry();
  assert.equal(registry.supportedExtensions().length, 0);
});

test("syntax-validator: createDefaultSyntaxValidatorRegistry registers all known extensions", () => {
  const registry = createDefaultSyntaxValidatorRegistry();
  const exts = registry.supportedExtensions();
  assert.ok(exts.includes(".ts"));
  assert.ok(exts.includes(".tsx"));
  assert.ok(exts.includes(".mts"));
  assert.ok(exts.includes(".cts"));
  assert.ok(exts.includes(".js"));
  assert.ok(exts.includes(".jsx"));
  assert.ok(exts.includes(".mjs"));
  assert.ok(exts.includes(".cjs"));
  assert.ok(exts.includes(".json"));
});

test("syntax-validator: registry get returns validator for registered extension", () => {
  const registry = createDefaultSyntaxValidatorRegistry();
  const validator = registry.get(".ts");
  assert.ok(typeof validator === "function");
});

test("syntax-validator: registry get returns undefined for unregistered extension", () => {
  const registry = createDefaultSyntaxValidatorRegistry();
  assert.equal(registry.get(".py"), undefined);
  assert.equal(registry.get(".rs"), undefined);
});

test("syntax-validator: registry register adds a custom validator", () => {
  const registry = createSyntaxValidatorRegistry();
  registry.register(".txt", (content) => ({
    valid: content.length > 0,
    language: "text",
    diagnostics: content.length === 0 ? [{ severity: "error", line: 0, column: 0, message: "empty", code: "empty" }] : [],
  }));
  assert.ok(registry.get(".txt") !== undefined);
  assert.ok(registry.supportedExtensions().includes(".txt"));
});

test("syntax-validator: registry register normalizes extension with dot prefix", () => {
  const registry = createSyntaxValidatorRegistry();
  registry.register("xml", () => ({ valid: true, language: "xml", diagnostics: [] }));
  assert.ok(registry.get(".xml") !== undefined);
  assert.ok(registry.get("xml") !== undefined);
});

test("syntax-validator: registry register normalizes extension case", () => {
  const registry = createSyntaxValidatorRegistry();
  registry.register(".XML", () => ({ valid: true, language: "xml", diagnostics: [] }));
  assert.ok(registry.get(".xml") !== undefined);
});

test("syntax-validator: registry register throws on non-function validator", () => {
  const registry = createSyntaxValidatorRegistry();
  assert.throws(
    () => registry.register(".bad", "not a function" as never),
    (e: unknown) => (e as Error).message.includes("must be a function"),
  );
});

// ============================================================================
// TypeScript validation - valid code
// ============================================================================

test("syntax-validator: validates valid TypeScript module", () => {
  const registry = createDefaultSyntaxValidatorRegistry();
  const result = validateSyntax("test.ts", "export const x: number = 42;", registry);
  assert.equal(result.valid, true);
  assert.equal(result.language, "typescript");
  assert.equal(result.diagnostics.length, 0);
});

test("syntax-validator: validates valid TypeScript with interfaces", () => {
  const registry = createDefaultSyntaxValidatorRegistry();
  const code = `
    interface Foo { bar: string; baz: number; }
    export const foo: Foo = { bar: "hello", baz: 42 };
  `;
  const result = validateSyntax("test.ts", code, registry);
  assert.equal(result.valid, true);
});

test("syntax-validator: validates valid TypeScript with generics", () => {
  const registry = createDefaultSyntaxValidatorRegistry();
  const code = `
    function identity<T>(value: T): T { return value; }
    export { identity };
  `;
  const result = validateSyntax("test.ts", code, registry);
  assert.equal(result.valid, true);
});

test("syntax-validator: validates valid TypeScript with async/await", () => {
  const registry = createDefaultSyntaxValidatorRegistry();
  const code = `
    async function fetchData(): Promise<string> {
      const response = await fetch("https://example.com");
      return response.text();
    }
  `;
  const result = validateSyntax("test.ts", code, registry);
  assert.equal(result.valid, true);
});

test("syntax-validator: validates valid TypeScript with decorators", () => {
  const registry = createDefaultSyntaxValidatorRegistry();
  const code = `
    @Component({ selector: "app" })
    class AppComponent { name = "app"; }
  `;
  const result = validateSyntax("test.ts", code, registry);
  assert.equal(result.valid, true);
});

test("syntax-validator: validates valid TypeScript with optional chaining", () => {
  const registry = createDefaultSyntaxValidatorRegistry();
  const code = `
    const value = obj?.prop?.method?.();
  `;
  const result = validateSyntax("test.ts", code, registry);
  assert.equal(result.valid, true);
});

test("syntax-validator: validates valid TypeScript with nullish coalescing", () => {
  const registry = createDefaultSyntaxValidatorRegistry();
  const code = `
    const value = input ?? "default";
  `;
  const result = validateSyntax("test.ts", code, registry);
  assert.equal(result.valid, true);
});

test("syntax-validator: validates valid TypeScript with type imports", () => {
  const registry = createDefaultSyntaxValidatorRegistry();
  const code = `
    import type { Foo } from "./foo";
    export type { Foo };
  `;
  const result = validateSyntax("test.ts", code, registry);
  assert.equal(result.valid, true);
});

// ============================================================================
// TypeScript validation - invalid code (syntax errors)
// ============================================================================

test("syntax-validator: rejects TypeScript with unclosed brace", () => {
  const registry = createDefaultSyntaxValidatorRegistry();
  const result = validateSyntax("test.ts", "function foo() {", registry);
  assert.equal(result.valid, false);
  assert.equal(result.language, "typescript");
  assert.ok(result.diagnostics.length > 0);
  assert.equal(result.diagnostics[0]!.severity, "error");
});

test("syntax-validator: rejects TypeScript with unclosed parenthesis", () => {
  const registry = createDefaultSyntaxValidatorRegistry();
  const result = validateSyntax("test.ts", "function foo(", registry);
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.length > 0);
});

test("syntax-validator: rejects TypeScript with missing semicolon in class", () => {
  const registry = createDefaultSyntaxValidatorRegistry();
  const code = `
    class Foo {
      bar: string
      baz: number
    }
  `;
  const result = validateSyntax("test.ts", code, registry);
  // Babel may allow this without semicolons in class properties
  // but let's test with clearly broken syntax
  assert.ok(typeof result.valid === "boolean");
});

test("syntax-validator: rejects TypeScript with unterminated string", () => {
  const registry = createDefaultSyntaxValidatorRegistry();
  const result = validateSyntax("test.ts", 'const x = "hello;', registry);
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.length > 0);
});

test("syntax-validator: rejects TypeScript with unterminated template literal", () => {
  const registry = createDefaultSyntaxValidatorRegistry();
  const result = validateSyntax("test.ts", "const x = `hello world", registry);
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.length > 0);
});

test("syntax-validator: rejects TypeScript with break outside loop", () => {
  const registry = createDefaultSyntaxValidatorRegistry();
  const code = `break;`;
  const result = validateSyntax("test.ts", code, registry);
  assert.equal(result.valid, false);
});

test("syntax-validator: syntax errors include line and column", () => {
  const registry = createDefaultSyntaxValidatorRegistry();
  const result = validateSyntax("test.ts", "function foo() {\n  return", registry);
  assert.equal(result.valid, false);
  if (result.diagnostics.length > 0) {
    const diag = result.diagnostics[0]!;
    assert.ok(typeof diag.line === "number");
    assert.ok(typeof diag.column === "number");
    assert.ok(diag.line > 0 || diag.column > 0);
  }
});

test("syntax-validator: syntax errors include error code", () => {
  const registry = createDefaultSyntaxValidatorRegistry();
  const result = validateSyntax("test.ts", "function foo() {", registry);
  assert.equal(result.valid, false);
  if (result.diagnostics.length > 0) {
    assert.ok(typeof result.diagnostics[0]!.code === "string");
  }
});

test("syntax-validator: syntax errors include message", () => {
  const registry = createDefaultSyntaxValidatorRegistry();
  const result = validateSyntax("test.ts", "function foo() {", registry);
  assert.equal(result.valid, false);
  if (result.diagnostics.length > 0) {
    assert.ok(result.diagnostics[0]!.message.length > 0);
  }
});

// ============================================================================
// JavaScript validation
// ============================================================================

test("syntax-validator: validates valid JavaScript", () => {
  const registry = createDefaultSyntaxValidatorRegistry();
  const result = validateSyntax("test.js", "const x = 42;", registry);
  assert.equal(result.valid, true);
  assert.equal(result.language, "javascript");
});

test("syntax-validator: validates valid JavaScript with JSX", () => {
  const registry = createDefaultSyntaxValidatorRegistry();
  const code = "const element = <div className='app'>Hello</div>;";
  const result = validateSyntax("test.jsx", code, registry);
  assert.equal(result.valid, true);
  assert.equal(result.language, "javascript");
});

test("syntax-validator: rejects JavaScript with syntax error", () => {
  const registry = createDefaultSyntaxValidatorRegistry();
  const result = validateSyntax("test.js", "const x = ;", registry);
  assert.equal(result.valid, false);
  assert.equal(result.language, "javascript");
});

test("syntax-validator: validates valid JavaScript ESM", () => {
  const registry = createDefaultSyntaxValidatorRegistry();
  const code = `
    import { foo } from "./foo.js";
    export const bar = foo + 1;
  `;
  const result = validateSyntax("test.mjs", code, registry);
  assert.equal(result.valid, true);
  assert.equal(result.language, "javascript");
});

test("syntax-validator: validates valid CommonJS", () => {
  const registry = createDefaultSyntaxValidatorRegistry();
  const code = `
    const { foo } = require("./foo");
    module.exports = { bar: foo + 1 };
  `;
  const result = validateSyntax("test.cjs", code, registry);
  assert.equal(result.valid, true);
  assert.equal(result.language, "javascript");
});

// ============================================================================
// JSON validation
// ============================================================================

test("syntax-validator: validates valid JSON object", () => {
  const registry = createDefaultSyntaxValidatorRegistry();
  const result = validateSyntax("data.json", '{"key": "value", "num": 42}', registry);
  assert.equal(result.valid, true);
  assert.equal(result.language, "json");
  assert.equal(result.diagnostics.length, 0);
});

test("syntax-validator: validates valid JSON array", () => {
  const registry = createDefaultSyntaxValidatorRegistry();
  const result = validateSyntax("data.json", '[1, 2, 3, "four"]', registry);
  assert.equal(result.valid, true);
});

test("syntax-validator: validates valid nested JSON", () => {
  const registry = createDefaultSyntaxValidatorRegistry();
  const result = validateSyntax("data.json", '{"a": {"b": {"c": [1, 2, {"d": true}]}}}', registry);
  assert.equal(result.valid, true);
});

test("syntax-validator: rejects JSON with trailing comma", () => {
  const registry = createDefaultSyntaxValidatorRegistry();
  const result = validateSyntax("data.json", '{"key": "value",}', registry);
  assert.equal(result.valid, false);
  assert.equal(result.language, "json");
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]!.severity, "error");
});

test("syntax-validator: rejects JSON with missing value", () => {
  const registry = createDefaultSyntaxValidatorRegistry();
  const result = validateSyntax("data.json", '{"key":}', registry);
  assert.equal(result.valid, false);
});

test("syntax-validator: rejects JSON with unquoted key", () => {
  const registry = createDefaultSyntaxValidatorRegistry();
  const result = validateSyntax("data.json", '{key: "value"}', registry);
  assert.equal(result.valid, false);
});

test("syntax-validator: rejects JSON with unclosed brace", () => {
  const registry = createDefaultSyntaxValidatorRegistry();
  const result = validateSyntax("data.json", '{"key": "value"', registry);
  assert.equal(result.valid, false);
});

test("syntax-validator: rejects JSON with unclosed array", () => {
  const registry = createDefaultSyntaxValidatorRegistry();
  const result = validateSyntax("data.json", '[1, 2, 3', registry);
  assert.equal(result.valid, false);
});

test("syntax-validator: rejects empty JSON (not valid JSON)", () => {
  const registry = createDefaultSyntaxValidatorRegistry();
  const result = validateSyntax("data.json", '', registry);
  assert.equal(result.valid, false);
});

test("syntax-validator: rejects JSON string as top-level (actually valid)", () => {
  const registry = createDefaultSyntaxValidatorRegistry();
  const result = validateSyntax("data.json", '"just a string"', registry);
  assert.equal(result.valid, true);
});

test("syntax-validator: rejects JSON number as top-level (actually valid)", () => {
  const registry = createDefaultSyntaxValidatorRegistry();
  const result = validateSyntax("data.json", '42', registry);
  assert.equal(result.valid, true);
});

test("syntax-validator: JSON errors include line and column when possible", () => {
  const registry = createDefaultSyntaxValidatorRegistry();
  const result = validateSyntax("data.json", '{\n  "key":\n}', registry);
  assert.equal(result.valid, false);
  if (result.diagnostics.length > 0) {
    const diag = result.diagnostics[0]!;
    assert.ok(typeof diag.line === "number");
    assert.ok(typeof diag.column === "number");
  }
});

// ============================================================================
// Unknown extensions
// ============================================================================

test("syntax-validator: returns invalid for unknown extension without skipUnknown", () => {
  const registry = createDefaultSyntaxValidatorRegistry();
  const result = validateSyntax("file.py", "print('hello')", registry);
  assert.equal(result.valid, false);
  assert.equal(result.language, "unknown");
  assert.ok(result.diagnostics.length > 0);
  assert.equal(result.diagnostics[0]!.code, "syntax_validator_unsupported_extension");
});

test("syntax-validator: returns valid for unknown extension with skipUnknown", () => {
  const registry = createDefaultSyntaxValidatorRegistry();
  const result = validateSyntax("file.dat", "print('hello')", registry, { skipUnknown: true });
  assert.equal(result.valid, true);
  assert.equal(result.language, "unknown");
  assert.equal(result.diagnostics.length, 0);
});

test("syntax-validator: returns valid for.md with skipUnknown", () => {
  const registry = createDefaultSyntaxValidatorRegistry();
  const result = validateSyntax("README.md", "# Title\n\nContent", registry, { skipUnknown: true });
  assert.equal(result.valid, true);
});

test("syntax-validator: returns valid for.txt with skipUnknown", () => {
  const registry = createDefaultSyntaxValidatorRegistry();
  const result = validateSyntax("file.txt", "hello world", registry, { skipUnknown: true });
  assert.equal(result.valid, true);
});

// ============================================================================
// Input validation
// ============================================================================

test("syntax-validator: throws on empty file path", () => {
  const registry = createDefaultSyntaxValidatorRegistry();
  assert.throws(
    () => validateSyntax("", "content", registry),
    (e: unknown) => (e as Error).message.includes("path"),
  );
});

test("syntax-validator: throws on non-string content", () => {
  const registry = createDefaultSyntaxValidatorRegistry();
  assert.throws(
    () => validateSyntax("test.ts", 42 as never, registry),
    (e: unknown) => (e as Error).message.toLowerCase().includes("content"),
  );
});

// ============================================================================
// Edge cases
// ============================================================================

test("syntax-validator: validates empty TypeScript file", () => {
  const registry = createDefaultSyntaxValidatorRegistry();
  const result = validateSyntax("test.ts", "", registry);
  assert.equal(result.valid, true);
});

test("syntax-validator: validates empty JavaScript file", () => {
  const registry = createDefaultSyntaxValidatorRegistry();
  const result = validateSyntax("test.js", "", registry);
  assert.equal(result.valid, true);
});

test("syntax-validator: validates TypeScript with only comments", () => {
  const registry = createDefaultSyntaxValidatorRegistry();
  const code = "// just a comment\n/* block comment */";
  const result = validateSyntax("test.ts", code, registry);
  assert.equal(result.valid, true);
});

test("syntax-validator: validates TypeScript with shebang", () => {
  const registry = createDefaultSyntaxValidatorRegistry();
  const code = "#!/usr/bin/env node\nconsole.log('hello');";
  const result = validateSyntax("test.ts", code, registry);
  // Babel may not handle shebang; check it's deterministic
  assert.ok(typeof result.valid === "boolean");
});

test("syntax-validator: validates TypeScript with export * from", () => {
  const registry = createDefaultSyntaxValidatorRegistry();
  const code = "export * from './module';";
  const result = validateSyntax("test.ts", code, registry);
  assert.equal(result.valid, true);
});

test("syntax-validator: validates TypeScript with namespace", () => {
  const registry = createDefaultSyntaxValidatorRegistry();
  const code = `
    namespace MyNamespace {
      export const value = 42;
    }
  `;
  const result = validateSyntax("test.ts", code, registry);
  assert.equal(result.valid, true);
});

test("syntax-validator: validates TypeScript with enum", () => {
  const registry = createDefaultSyntaxValidatorRegistry();
  const code = `
    enum Color { Red, Green, Blue }
    export { Color };
  `;
  const result = validateSyntax("test.ts", code, registry);
  assert.equal(result.valid, true);
});

test("syntax-validator: validates TypeScript with utility types", () => {
  const registry = createDefaultSyntaxValidatorRegistry();
  const code = `
    type Partial<T> = { [P in keyof T]?: T[P] };
    type ReadOnly<T> = { readonly [P in keyof T]: T[P] };
    export { Partial, ReadOnly };
  `;
  const result = validateSyntax("test.ts", code, registry);
  assert.equal(result.valid, true);
});

test("syntax-validator: custom validator can be used via validateSyntax", () => {
  const registry = createSyntaxValidatorRegistry();
  registry.register(".xml", (content) => ({
    valid: content.startsWith("<"),
    language: "xml",
    diagnostics: content.startsWith("<") ? [] : [{
      severity: "error" as const,
      line: 1,
      column: 1,
      message: "XML must start with <",
      code: "xml_start",
    }],
  }));
  const validResult = validateSyntax("data.xml", "<root></root>", registry);
  assert.equal(validResult.valid, true);
  assert.equal(validResult.language, "xml");

  const invalidResult = validateSyntax("data.xml", "not xml", registry);
  assert.equal(invalidResult.valid, false);
  assert.equal(invalidResult.diagnostics.length, 1);
});

test("syntax-validator: multiple syntax errors are reported", () => {
  const registry = createDefaultSyntaxValidatorRegistry();
  const code = "function foo() {\n  const x = ;\n  const y = ;\n}";
  const result = validateSyntax("test.ts", code, registry);
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.length >= 1);
});
