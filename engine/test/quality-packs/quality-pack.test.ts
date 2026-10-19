import assert from "node:assert/strict";
import test from "node:test";

import {
  createDiagnostic,
  createQualityPackRegistry,
  isDiagnosticCategory,
  isDiagnosticSeverity,
  mergeQualityResults,
  runQualityCheck,
  runQualityPack,
  runQualityPackWithCheckIds,
  DIAGNOSTIC_CATEGORIES,
  type Diagnostic,
  type QualityCheck,
  type QualityPack,
  QUALITY_PACK_SCHEMA_VERSION,
} from "../../src/quality-packs/quality-pack.ts";
import { makeQualityContext } from "../support/factories.ts";

function makeCheck(id: string, diagnostics: readonly Diagnostic[]): QualityCheck {
  return {
    id,
    description: `check ${id}`,
    category: "syntax",
    defaultSeverity: "error",
    run: () => diagnostics,
  };
}

const errorDiag: Diagnostic = {
  packId: "test-pack", checkId: "syntax", category: "syntax", severity: "error",
  code: "err1", message: "error", filePath: "a.ts", line: 1, column: 1,
  symbol: null, evidence: null, autoFixable: false,
};

const warningDiag: Diagnostic = {
  packId: "test-pack", checkId: "syntax", category: "syntax", severity: "warning",
  code: "warn1", message: "warning", filePath: "a.ts", line: 2, column: 2,
  symbol: null, evidence: null, autoFixable: false,
};

const infoDiag: Diagnostic = {
  packId: "test-pack", checkId: "syntax", category: "syntax", severity: "info",
  code: "info1", message: "info", filePath: "a.ts", line: 3, column: 3,
  symbol: null, evidence: null, autoFixable: false,
};

function makeTestPack(): QualityPack {
  return {
    id: "test-pack",
    language: "test-lang",
    version: "1.0.0",
    detect: (files) => Object.keys(files).length > 0,
    checks: [
      makeCheck("check-a", [errorDiag]),
      makeCheck("check-b", [warningDiag]),
      makeCheck("check-c", [infoDiag]),
      makeCheck("check-d", []),
    ],
  };
}

// ========== Schema version tests ==========

test("quality-pack: schema version is defined", () => {
  assert.equal(QUALITY_PACK_SCHEMA_VERSION, "bridlewise-quality-pack/v1");
});

// ========== createDiagnostic tests ==========

test("quality-pack: createDiagnostic with all fields", () => {
  const diag = createDiagnostic({
    packId: "p1", checkId: "c1", category: "syntax", severity: "error",
    code: "E001", message: "test error", filePath: "f.ts", line: 10,
    column: 5, symbol: "foo", evidence: "trace", autoFixable: true,
  });
  assert.equal(diag.packId, "p1");
  assert.equal(diag.checkId, "c1");
  assert.equal(diag.category, "syntax");
  assert.equal(diag.severity, "error");
  assert.equal(diag.code, "E001");
  assert.equal(diag.message, "test error");
  assert.equal(diag.filePath, "f.ts");
  assert.equal(diag.line, 10);
  assert.equal(diag.column, 5);
  assert.equal(diag.symbol, "foo");
  assert.equal(diag.evidence, "trace");
  assert.equal(diag.autoFixable, true);
  assert.ok(Object.isFrozen(diag));
});

test("quality-pack: createDiagnostic with defaults", () => {
  const diag = createDiagnostic({
    packId: "p1", checkId: "c1", category: "type", severity: "warning",
    code: "W001", message: "warn",
  });
  assert.equal(diag.filePath, null);
  assert.equal(diag.line, 0);
  assert.equal(diag.column, 0);
  assert.equal(diag.symbol, null);
  assert.equal(diag.evidence, null);
  assert.equal(diag.autoFixable, false);
});

test("quality-pack: createDiagnostic is frozen", () => {
  const diag = createDiagnostic({
    packId: "p", checkId: "c", category: "syntax", severity: "error",
    code: "x", message: "m",
  });
  assert.ok(Object.isFrozen(diag));
});

// ========== isDiagnosticCategory tests ==========

test("quality-pack: isDiagnosticCategory returns true for valid categories", () => {
  for (const cat of DIAGNOSTIC_CATEGORIES) {
    assert.ok(isDiagnosticCategory(cat), `should be true for ${cat}`);
  }
});

test("quality-pack: isDiagnosticCategory returns false for invalid", () => {
  assert.equal(isDiagnosticCategory("invalid"), false);
  assert.equal(isDiagnosticCategory(""), false);
  assert.equal(isDiagnosticCategory(null), false);
  assert.equal(isDiagnosticCategory(42), false);
});

// ========== isDiagnosticSeverity tests ==========

test("quality-pack: isDiagnosticSeverity returns true for valid severities", () => {
  assert.ok(isDiagnosticSeverity("error"));
  assert.ok(isDiagnosticSeverity("warning"));
  assert.ok(isDiagnosticSeverity("info"));
});

test("quality-pack: isDiagnosticSeverity returns false for invalid", () => {
  assert.equal(isDiagnosticSeverity("critical"), false);
  assert.equal(isDiagnosticSeverity(""), false);
  assert.equal(isDiagnosticSeverity(null), false);
});

// ========== Registry tests ==========

test("quality-pack: registry register and resolve", () => {
  const registry = createQualityPackRegistry();
  const pack = makeTestPack();
  registry.register(pack);
  assert.equal(registry.resolve("test-lang"), pack);
  assert.ok(registry.has("test-lang"));
});

test("quality-pack: registry resolve returns null for unknown language", () => {
  const registry = createQualityPackRegistry();
  assert.equal(registry.resolve("unknown"), null);
  assert.equal(registry.has("unknown"), false);
});

test("quality-pack: registry list returns all packs sorted by language", () => {
  const registry = createQualityPackRegistry();
  const pack1 = { ...makeTestPack(), id: "p1", language: "typescript" };
  const pack2 = { ...makeTestPack(), id: "p2", language: "javascript" };
  registry.register(pack1);
  registry.register(pack2);
  const list = registry.list();
  assert.equal(list.length, 2);
  assert.equal(list[0]!.language, "javascript");
  assert.equal(list[1]!.language, "typescript");
});

test("quality-pack: registry resolveForFiles returns applicable packs", () => {
  const registry = createQualityPackRegistry();
  const pack = makeTestPack();
  registry.register(pack);
  const applicable = registry.resolveForFiles({ "test.ts": "code" });
  assert.equal(applicable.length, 1);
  assert.equal(applicable[0], pack);
});

test("quality-pack: registry resolveForFiles returns empty for no matches", () => {
  const registry = createQualityPackRegistry();
  const pack: QualityPack = {
    id: "ts-only", language: "typescript", version: "1",
    detect: (files) => Object.keys(files).some((f) => f.endsWith(".ts")),
    checks: [makeCheck("c", [])],
  };
  registry.register(pack);
  const applicable = registry.resolveForFiles({ "test.md": "markdown" });
  assert.equal(applicable.length, 0);
});

test("quality-pack: registry rejects duplicate language", () => {
  const registry = createQualityPackRegistry();
  registry.register(makeTestPack());
  assert.throws(() => registry.register(makeTestPack()), /already registered/);
});

test("quality-pack: registry rejects pack without id", () => {
  const registry = createQualityPackRegistry();
  const badPack = { ...makeTestPack(), id: "" };
  assert.throws(() => registry.register(badPack), /id is required/);
});

test("quality-pack: registry rejects pack without language", () => {
  const registry = createQualityPackRegistry();
  const badPack = { ...makeTestPack(), language: "" };
  assert.throws(() => registry.register(badPack), /language is required/);
});

test("quality-pack: registry rejects pack without checks", () => {
  const registry = createQualityPackRegistry();
  const badPack = { ...makeTestPack(), checks: [] };
  assert.throws(() => registry.register(badPack), /at least one check/);
});

test("quality-pack: registry rejects pack with duplicate check ids", () => {
  const registry = createQualityPackRegistry();
  const badCheck = makeCheck("check-a", []);
  const badPack = { ...makeTestPack(), checks: [makeCheck("check-a", []), badCheck] };
  assert.throws(() => registry.register(badPack), /Duplicate check id/);
});

// ========== runQualityCheck tests ==========

test("quality-pack: runQualityCheck returns pass for no errors", () => {
  const pack = makeTestPack();
  const check = makeCheck("passing", []);
  const result = runQualityCheck(pack, check, makeQualityContext({}));
  assert.equal(result.status, "pass");
  assert.equal(result.diagnostics.length, 0);
  assert.equal(result.message, null);
  assert.ok(result.duration >= 0);
});

test("quality-pack: runQualityCheck returns fail for error diagnostics", () => {
  const pack = makeTestPack();
  const check = makeCheck("failing", [errorDiag]);
  const result = runQualityCheck(pack, check, makeQualityContext({}));
  assert.equal(result.status, "fail");
  assert.equal(result.diagnostics.length, 1);
});

test("quality-pack: runQualityCheck returns pass for warning-only diagnostics", () => {
  const pack = makeTestPack();
  const check = makeCheck("warning-only", [warningDiag]);
  const result = runQualityCheck(pack, check, makeQualityContext({}));
  assert.equal(result.status, "pass");
  assert.equal(result.diagnostics.length, 1);
});

test("quality-pack: runQualityCheck handles thrown error as tool-error", () => {
  const pack = makeTestPack();
  const check: QualityCheck = {
    id: "throwing",
    description: "throws",
    category: "syntax",
    defaultSeverity: "error",
    run: () => { throw new Error("boom"); },
  };
  const result = runQualityCheck(pack, check, makeQualityContext({}));
  assert.equal(result.status, "tool-error");
  assert.equal(result.diagnostics.length, 0);
  assert.ok(result.message !== null);
  assert.ok(result.message!.includes("boom"));
});

test("quality-pack: runQualityCheck handles non-array return as tool-error", () => {
  const pack = makeTestPack();
  const check: QualityCheck = {
    id: "bad-return",
    description: "returns non-array",
    category: "syntax",
    defaultSeverity: "error",
    run: () => "not an array" as unknown as readonly Diagnostic[],
  };
  const result = runQualityCheck(pack, check, makeQualityContext({}));
  assert.equal(result.status, "tool-error");
  assert.ok(result.message!.includes("non-array"));
});

// ========== runQualityPack tests ==========

test("quality-pack: runQualityPack runs all checks and summarizes", () => {
  const pack = makeTestPack();
  const result = runQualityPack(pack, makeQualityContext({}));
  assert.equal(result.packId, "test-pack");
  assert.equal(result.checkResults.length, 4);
  assert.equal(result.summary.totalChecks, 4);
  assert.equal(result.summary.passed, 3);
  assert.equal(result.summary.failed, 1);
  assert.equal(result.summary.totalDiagnostics, 3);
  assert.equal(result.summary.errors, 1);
  assert.equal(result.summary.warnings, 1);
  assert.equal(result.summary.infos, 1);
  assert.equal(result.exitCode, 1);
  assert.ok(Object.isFrozen(result));
});

test("quality-pack: runQualityPack with no error checks has exitCode 0", () => {
  const pack: QualityPack = {
    id: "clean-pack", language: "ts", version: "1.0.0",
    detect: (f) => Object.keys(f).length > 0,
    checks: [makeCheck("a", []), makeCheck("b", [warningDiag])],
  };
  const result = runQualityPack(pack, makeQualityContext({}));
  assert.equal(result.exitCode, 0);
  assert.equal(result.summary.passed, 2);
  assert.equal(result.summary.failed, 0);
});

// ========== runQualityPackWithCheckIds tests ==========

test("quality-pack: runQualityPackWithCheckIds runs only specified checks", () => {
  const pack = makeTestPack();
  const result = runQualityPackWithCheckIds(pack, ["check-a", "check-d"], makeQualityContext({}));
  assert.equal(result.checkResults.length, 2);
  assert.equal(result.checkResults[0]!.checkId, "check-a");
  assert.equal(result.checkResults[1]!.checkId, "check-d");
});

test("quality-pack: runQualityPackWithCheckIds with unknown check ids returns empty", () => {
  const pack = makeTestPack();
  const result = runQualityPackWithCheckIds(pack, ["unknown-check"], makeQualityContext({}));
  assert.equal(result.checkResults.length, 0);
  assert.equal(result.summary.totalChecks, 0);
  assert.equal(result.exitCode, 0);
});

test("quality-pack: runQualityPackWithCheckIds with empty array returns empty", () => {
  const pack = makeTestPack();
  const result = runQualityPackWithCheckIds(pack, [], makeQualityContext({}));
  assert.equal(result.checkResults.length, 0);
});

// ========== mergeQualityResults tests ==========

test("quality-pack: mergeQualityResults combines check results", () => {
  const pack = makeTestPack();
  const r1 = runQualityPackWithCheckIds(pack, ["check-a"], makeQualityContext({}));
  const r2 = runQualityPackWithCheckIds(pack, ["check-b"], makeQualityContext({}));
  const merged = mergeQualityResults("merged", [r1, r2]);
  assert.equal(merged.packId, "merged");
  assert.equal(merged.checkResults.length, 2);
  assert.equal(merged.summary.totalChecks, 2);
});

test("quality-pack: mergeQualityResults with empty array", () => {
  const merged = mergeQualityResults("empty", []);
  assert.equal(merged.checkResults.length, 0);
  assert.equal(merged.exitCode, 0);
});

// ========== Hostile/mutation tests ==========

test("quality-pack: registry is frozen", () => {
  const registry = createQualityPackRegistry();
  assert.ok(Object.isFrozen(registry));
});

test("quality-pack: diagnostic categories array is frozen", () => {
  assert.ok(Object.isFrozen(DIAGNOSTIC_CATEGORIES));
});

test("quality-pack: runQualityPack result is frozen", () => {
  const result = runQualityPack(makeTestPack(), makeQualityContext({}));
  assert.ok(Object.isFrozen(result));
});

test("quality-pack: check with mixed severities counts correctly", () => {
  const pack: QualityPack = {
    id: "mixed", language: "ts", version: "1",
    detect: (f) => Object.keys(f).length > 0,
    checks: [makeCheck("mixed", [errorDiag, warningDiag, infoDiag])],
  };
  const result = runQualityPack(pack, makeQualityContext({}));
  assert.equal(result.summary.errors, 1);
  assert.equal(result.summary.warnings, 1);
  assert.equal(result.summary.infos, 1);
  assert.equal(result.summary.totalDiagnostics, 3);
  assert.equal(result.exitCode, 1);
});

test("quality-pack: multiple failing checks all counted", () => {
  const pack: QualityPack = {
    id: "multi-fail", language: "ts", version: "1",
    detect: (f) => Object.keys(f).length > 0,
    checks: [
      makeCheck("fail1", [errorDiag]),
      makeCheck("fail2", [errorDiag, errorDiag]),
      makeCheck("pass", []),
    ],
  };
  const result = runQualityPack(pack, makeQualityContext({}));
  assert.equal(result.summary.failed, 2);
  assert.equal(result.summary.passed, 1);
  assert.equal(result.summary.totalDiagnostics, 3);
  assert.equal(result.exitCode, 1);
});

test("quality-pack: tool-error sets exitCode to 1", () => {
  const pack: QualityPack = {
    id: "error-pack", language: "ts", version: "1",
    detect: (f) => Object.keys(f).length > 0,
    checks: [{
      id: "throwing", description: "throws", category: "syntax",
      defaultSeverity: "error",
      run: () => { throw new Error("fail"); },
    }],
  };
  const result = runQualityPack(pack, makeQualityContext({}));
  assert.equal(result.summary.toolErrors, 1);
  assert.equal(result.exitCode, 1);
});

test("quality-pack: registry resolveForFiles with empty files returns empty", () => {
  const registry = createQualityPackRegistry();
  registry.register(makeTestPack());
  assert.equal(registry.resolveForFiles({}).length, 0);
});

test("quality-pack: registry list with no packs returns empty", () => {
  const registry = createQualityPackRegistry();
  assert.equal(registry.list().length, 0);
});
