/**
 * EXP447 — Hallucination benchmark (6 + 1 layers, EXP388 semantic improvement).
 *
 * Tests the EXP447 improvement: L7 SEMANTIC layer (EXP388's 0% semantic-miss
 * achievement, ported + improved). The EXP430 detector only had 6 layers
 * (structural grounding). EXP447 adds L7 SEMANTIC to close the 67% semantic
 * miss gap (an LLM that calls a REAL function but claims wrong return type /
 * wrong params / wrong async / wrong line).
 *
 * Benchmark (per protocol):
 * - 50 hallucination traps (structural) + 50 real prompts.
 * Target: 0% hallucination, 0% false block.
 * - 50 SEMANTIC traps (wrong return type, params, async, line, throws,
 * argCount) + 50 true-claim controls.
 * Target: 0% semantic miss, 0% false block on true claims.
 * - 50 auto-correction cases (typo + signature) — target 100% correction.
 * - All gates strong: each layer fires independently (EXP394).
 * - Improper usage: unknown error type, adversarial, empty index, multi-cause.
 * - Performance: CPU, RAM, latency per detection.
 * - 10× harder: 500 traps + 500 semantic traps.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  detectHallucination,
  emptyIndex,
  levenshtein,
  autoCorrectSignature,
  normalizeType,
  typeSimilarity,
} from "../../src/safety/hallucination-detector.ts";
import {
  buildSemanticIndexFromSources,
  verifySemanticClaims,
  emptySemanticIndex,
  type SemanticIndex,
  type SemanticClaim,
} from "../../src/safety/hallucination-semantic.ts";
import {
  resolveHallucinationConfig,
  HALLUCINATION_DEFAULT_CONFIG,
  HALLUCINATION_LAYERS,
  type HallucinationConfig,
} from "../../src/safety/hallucination-config.ts";
import {
  SYNTHETIC_SOURCES,
  SEMANTIC_INDEX,
  STRUCTURAL_INDEX,
  trapNames,
  realPrompts,
  buildSemanticTraps,
} from "./synthetic-source-fixtures.ts";
import { requireHost } from "../support/host-requirement.ts";
import { cpuWorkOf } from "../../src/shared/run-cpu.ts";

const HCFG: HallucinationConfig = resolveHallucinationConfig();

// ---------------------------------------------------------------------------
// SECTION 1: Structural hallucination traps (EXP354 baseline, unchanged)
// ---------------------------------------------------------------------------

test("hallucination-benchmark: halluc: 50 structural traps all blocked or corrected (0% miss)", () => {
  const traps = trapNames(50);
  let blocked = 0;
  let corrected = 0;
  for (const name of traps) {
    const resp = `${name}();\n`;
    const r = detectHallucination(resp, "test", STRUCTURAL_INDEX, HCFG);
    if (r.blocked) blocked++;
    if (r.corrected) corrected++;
  }
  assert.equal(blocked + corrected, 50, `50 traps: ${blocked} blocked + ${corrected} corrected (0% miss)`);
});

test("hallucination-benchmark: halluc: 50 real prompts not blocked (0% false block)", () => {
  const prompts = realPrompts(50);
  let blocked = 0;
  for (const resp of prompts) {
    const r = detectHallucination(resp, "test", STRUCTURAL_INDEX, HCFG);
    if (r.blocked) blocked++;
  }
  assert.equal(blocked, 0, `0 false blocks on 50 real prompts (got ${blocked})`);
});

// ---------------------------------------------------------------------------
// SECTION 2: SEMANTIC traps (EXP388/EXP447 improvement — the KEY improvement)
// ---------------------------------------------------------------------------

test("hallucination-benchmark: halluc L7-SEMANTIC: 50 semantic traps all BLOCK (0% semantic miss)", () => {
  const traps = buildSemanticTraps(50);
  let blocked = 0;
  let corrected = 0;
  for (const t of traps) {
    // The LLM calls a REAL function but declares a WRONG semantic claim.
    const claim: SemanticClaim = { ref: t.ref, field: t.field, value: t.wrongValue, inferred: false };
    const resp = `${t.ref}();\n`;
    const r = detectHallucination(resp, "test", STRUCTURAL_INDEX, HCFG, SEMANTIC_INDEX, [claim]);
    if (r.blocked) blocked++;
    if (r.corrected) corrected++;
  }
  // 0% semantic miss = every wrong claim is blocked OR auto-corrected.
  assert.equal(blocked + corrected, 50, `50 semantic traps: ${blocked} blocked + ${corrected} corrected (0% miss)`);
});

test("hallucination-benchmark: halluc L7-SEMANTIC: 50 true-claim controls not blocked (0% false block)", () => {
  const traps = buildSemanticTraps(50);
  let blocked = 0;
  for (const t of traps) {
    // The LLM declares the CORRECT claim — must NOT block.
    const claim: SemanticClaim = { ref: t.ref, field: t.field, value: (t.correctValue ?? "void"), inferred: false };
    const resp = `${t.ref}();\n`;
    const r = detectHallucination(resp, "test", STRUCTURAL_INDEX, HCFG, SEMANTIC_INDEX, [claim]);
    if (r.blocked) blocked++;
  }
  assert.equal(blocked, 0, `0 false blocks on 50 true claims (got ${blocked})`);
});

test("hallucination-benchmark: halluc L7-SEMANTIC: specific trap kinds all caught", () => {
  const traps = buildSemanticTraps(50);
  const byKind = new Map<string, { total: number; caught: number }>();
  for (const t of traps) {
    const k = t.field;
    const e = byKind.get(k) ?? { total: 0, caught: 0 };
    e.total++;
    const claim: SemanticClaim = { ref: t.ref, field: t.field, value: t.wrongValue, inferred: false };
    const r = detectHallucination(`${t.ref}();\n`, "test", STRUCTURAL_INDEX, HCFG, SEMANTIC_INDEX, [claim]);
    if (r.blocked || r.corrected) e.caught++;
    byKind.set(k, e);
  }
  for (const [kind, { total, caught }] of byKind) {
    assert.equal(caught, total, `kind ${kind}: ${caught}/${total} caught (0% miss)`);
  }
});

// ---------------------------------------------------------------------------
// SECTION 3: Auto-correction (Levenshtein + signature)
// ---------------------------------------------------------------------------

test("hallucination-benchmark: halluc L6-AUTO: typo correction via Levenshtein (realFunction)", () => {
  // Insert a typo close to a real name.
  const resp = `cloneNod();\n`;
  const r = detectHallucination(resp, "test", STRUCTURAL_INDEX, HCFG);
  assert.equal(r.blocked, false, "typo auto-corrected, not blocked");
  assert.equal(r.corrected, true, "correction applied");
  assert.ok(r.correctedText !== null, "corrected text returned");
});

test("hallucination-benchmark: halluc L6-SIG: arg-count correction (assertArrayExpression 5→2)", () => {
  const sig = autoCorrectSignature("assertArrayExpression", "argCount", 5, SEMANTIC_INDEX);
  assert.ok(sig !== null, "correction returned");
  assert.equal(sig!.to, "2", `corrected to 2 (got ${sig!.to})`);
});

test("hallucination-benchmark: halluc L6-SIG: param-name correction (cloneNode [ast,deep]→[node,deep,withoutLoc])", () => {
  const sig = autoCorrectSignature("cloneNode", "params", ["ast", "deep"], SEMANTIC_INDEX);
  assert.ok(sig !== null, "correction returned");
  assert.equal(sig!.to, "node, deep, withoutLoc", `corrected param names (got ${sig!.to})`);
});

test("hallucination-benchmark: halluc L6-SIG: 50 signature corrections (arg-count + param-name)", () => {
  let corrected = 0;
  const recs = SEMANTIC_INDEX.records;
  for (let i = 0; i < 50; i++) {
    const rec = recs[i % recs.length]!;
    const claim: SemanticClaim = { ref: rec.name, field: "argCount", value: rec.argCount + 3, inferred: false };
    const r = detectHallucination(`${rec.name}();\n`, "test", STRUCTURAL_INDEX, HCFG, SEMANTIC_INDEX, [claim]);
    if (r.corrected) corrected++;
  }
  assert.ok(corrected >= 45, `>=45/50 signature auto-corrections (got ${corrected})`);
});

// ---------------------------------------------------------------------------
// SECTION 4: All gates strong — independent triggers (EXP394)
// ---------------------------------------------------------------------------

test("hallucination-benchmark: halluc: 7 layers config independently toggleable (EXP394 all gates strong)", () => {
  for (const layer of HALLUCINATION_LAYERS) {
    const cfg: HallucinationConfig = resolveHallucinationConfig({
      layers: { ...HALLUCINATION_DEFAULT_CONFIG.layers, [layer]: false },
    });
    assert.equal(cfg.layers[layer], false, `${layer} independently disabled`);
    for (const other of HALLUCINATION_LAYERS) {
      if (other === layer) continue;
      assert.equal(cfg.layers[other], true, `${other} still enabled when ${layer} disabled`);
    }
  }
});

test("hallucination-benchmark: halluc: L7 SEMANTIC alone catches a wrong-claim without L3 grounding firing", () => {
  // A REAL function (passes grounding) but a WRONG semantic claim.
  const cfgGroundingOff: HallucinationConfig = resolveHallucinationConfig({
    layers: { ...HCFG.layers, grounding: false },
  });
  const claim: SemanticClaim = { ref: "cloneNode", field: "returns", value: "boolean", inferred: false };
  const r = detectHallucination("cloneNode();\n", "test", STRUCTURAL_INDEX, cfgGroundingOff, SEMANTIC_INDEX, [claim]);
  assert.equal(r.blocked, true, "L7 SEMANTIC catches wrong claim even with L3 grounding OFF (independent gate)");
});

test("hallucination-benchmark: halluc: L3 grounding alone catches a fake name without L7 SEMANTIC", () => {
  const cfgSemOff: HallucinationConfig = resolveHallucinationConfig({
    layers: { ...HCFG.layers, semantic: false },
  });
  const r = detectHallucination("fakeFunctionXYZ();\n", "test", STRUCTURAL_INDEX, cfgSemOff, SEMANTIC_INDEX);
  assert.equal(r.blocked, true, "L3 grounding catches fake name even with L7 SEMANTIC OFF (independent gate)");
});

test("hallucination-benchmark: halluc: L7 disabled → semantic claim ignored (layer independence)", () => {
  const cfgNoSem: HallucinationConfig = resolveHallucinationConfig({
    layers: { ...HCFG.layers, semantic: false },
  });
  const claim: SemanticClaim = { ref: "cloneNode", field: "returns", value: "boolean", inferred: false };
  const r = detectHallucination("cloneNode();\n", "test", STRUCTURAL_INDEX, cfgNoSem, SEMANTIC_INDEX, [claim]);
  assert.equal(r.blocked, false, "L7 OFF → semantic claim ignored (cloneNode is grounded)");
});

test("hallucination-benchmark: halluc: each layer's strength unchanged whether alone or with others (no weakening)", () => {
  // L7 with all others ON vs L7 alone (others OFF): both should block the same wrong claim.
  const claim: SemanticClaim = { ref: "cloneNode", field: "returns", value: "boolean", inferred: false };
  const allOn = detectHallucination("cloneNode();\n", "test", STRUCTURAL_INDEX, HCFG, SEMANTIC_INDEX, [claim]);
  const l7Alone = detectHallucination("cloneNode();\n", "test", STRUCTURAL_INDEX,
    resolveHallucinationConfig({ layers: { whitelist: false, structured: false, grounding: false, "pre-emptive": false, "post-hoc": false, "auto-correct": false, semantic: true } }),
    SEMANTIC_INDEX, [claim]);
  assert.equal(allOn.blocked, true, "all-on blocks the wrong claim");
  assert.equal(l7Alone.blocked, true, "L7 alone blocks the same wrong claim (no weakening)");
});

// ---------------------------------------------------------------------------
// SECTION 5: Claim inference (await X → async claim, if (X) → boolean claim)
// ---------------------------------------------------------------------------

test("hallucination-benchmark: halluc L7-INFER: await X infers an async=true claim (verifies against index)", () => {
  // await parseExpression — parseExpression is SYNC → the inferred
  // async=true claim should mismatch → BLOCK.
  const r = detectHallucination("await parseExpression('code');\n", "test", STRUCTURAL_INDEX, HCFG, SEMANTIC_INDEX);
  assert.equal(r.blocked, true, "await on a sync function infers a wrong async claim → BLOCK");
});

test("hallucination-benchmark: halluc L7-INFER: await asyncFetch infers a CORRECT async claim (no block)", () => {
  // asyncFetch IS async → the inferred async=true claim matches → no block.
  const r = detectHallucination("await asyncFetch('url');\n", "test", STRUCTURAL_INDEX, HCFG, SEMANTIC_INDEX);
  assert.equal(r.blocked, false, "await on an async function infers a correct async claim → no block");
});

test("hallucination-benchmark: halluc L7-INFER: inference disabled → await on sync function NOT blocked", () => {
  const cfgNoInfer: HallucinationConfig = resolveHallucinationConfig({ semanticInferClaims: false });
  const r = detectHallucination("await parseExpression('code');\n", "test", STRUCTURAL_INDEX, cfgNoInfer, SEMANTIC_INDEX);
  assert.equal(r.blocked, false, "inference OFF → await-on-sync not flagged (inference is the trigger)");
});

// ---------------------------------------------------------------------------
// SECTION 6: Improper usage + edge cases
// ---------------------------------------------------------------------------

test("hallucination-benchmark: halluc improper: empty index blocks all references (no silent pass)", () => {
  const empty = emptyIndex();
  const resp = 'import { realFunction } from "./mod.ts";\nrealFunction(42);\nfakeFunction();\n';
  const cfg: HallucinationConfig = resolveHallucinationConfig({ detectStringReferences: false });
  const r = detectHallucination(resp, "test", empty, cfg);
  assert.equal(r.blocked, true, "empty index blocks everything (fakeFunction not grounded)");
});

test("hallucination-benchmark: halluc improper: empty semantic index → no semantic findings (honest degradation)", () => {
  const emptySem = emptySemanticIndex();
  const claim: SemanticClaim = { ref: "cloneNode", field: "returns", value: "boolean", inferred: false };
  const r = detectHallucination("cloneNode();\n", "test", STRUCTURAL_INDEX, HCFG, emptySem, [claim]);
  // Empty semantic index → name not in index → skip (grounding layer handles it; no semantic block).
  assert.equal(r.blocked, false, "empty semantic index → no semantic block (honest, not crash)");
  assert.ok(!r.findings.some((f) => f.layer === "semantic"), "no semantic findings on empty index");
});

test("hallucination-benchmark: halluc improper: name in structural index but NOT in semantic index (index drift)", () => {
  // A function name present in the structural index (regex-built) but missing
  // from the semantic index (AST-built — e.g. a function the parser couldn't
  // extract). The semantic claim should be SKIPPED (not crash, not false-block).
  const partialSem: SemanticIndex = {
    byName: new Map([["cloneNode", SEMANTIC_INDEX.byName.get("cloneNode")!]]),
    records: SEMANTIC_INDEX.records.filter((r) => r.name === "cloneNode"),
    types: new Set(),
    imports: new Set(),
    exports: new Set(),
    paths: new Set(),
  };
  const claim: SemanticClaim = { ref: "assertArrayExpression", field: "returns", value: "boolean", inferred: false };
  const r = detectHallucination("assertArrayExpression();\n", "test", STRUCTURAL_INDEX, HCFG, partialSem, [claim]);
  // assertArrayExpression is NOT in the partial semantic index → semantic layer skips.
  // It's grounded in the structural index → no block.
  assert.equal(r.blocked, false, "name not in semantic index → claim skipped, no false block");
});

test("hallucination-benchmark: halluc improper: multi-cause — wrong return type AND wrong async (both reported)", () => {
  const claims: SemanticClaim[] = [
    { ref: "cloneNode", field: "returns", value: "boolean", inferred: false },
    { ref: "parseExpression", field: "async", value: true, inferred: false },
  ];
  const r = detectHallucination("cloneNode(); parseExpression();\n", "test", STRUCTURAL_INDEX, HCFG, SEMANTIC_INDEX, claims);
  assert.equal(r.blocked, true, "multi-cause semantic traps block");
  const semFindings = r.findings.filter((f) => f.layer === "semantic");
  assert.ok(semFindings.length >= 2, `>=2 semantic findings for multi-cause (got ${semFindings.length})`);
});

test("hallucination-benchmark: halluc improper: adversarial — claim on a name with multiple overloads", () => {
  // If a name has multiple records (overloads), a claim matches if ANY candidate matches.
  // Inject a duplicate record to simulate overloads.
  const base = SEMANTIC_INDEX.records[0]!;
  const overload = { ...base, returnType: "number" };
  const multiSem: SemanticIndex = {
    byName: new Map([[base.name, [base, overload]]]),
    records: [base, overload],
    types: new Set(),
    imports: new Set(),
    exports: new Set(),
    paths: new Set(),
  };
  // Claim returns=void matches the base record → no block.
  const r = detectHallucination(`${base.name}();\n`, "test", STRUCTURAL_INDEX, HCFG, multiSem,
    [{ ref: base.name, field: "returns", value: "void", inferred: false }]);
  assert.equal(r.blocked, false, "claim matches ANY overload candidate → no block");
});

test("hallucination-benchmark: halluc improper: null semantic index passed (no semantic layer runs)", () => {
  const r = detectHallucination("cloneNode();\n", "test", STRUCTURAL_INDEX, HCFG, null);
  assert.equal(r.blocked, false, "null semantic index → L7 skipped (cloneNode grounded)");
});

test("hallucination-benchmark: halluc improper: malformed response (not JSON, not code) — L2 warns, no crash", () => {
  const r = detectHallucination("just some prose, no code", "test", STRUCTURAL_INDEX, HCFG);
  assert.ok(r.findings.some((f) => f.layer === "structured" && f.severity === "warn") || r.referenceCount === 0,
    "L2 warns on non-JSON OR no references extracted; no crash");
});

// ---------------------------------------------------------------------------
// SECTION 7: Type normalization + similarity unit tests
// ---------------------------------------------------------------------------

test("hallucination-benchmark: halluc normalizeType: asserts X → void", () => {
  assert.equal(normalizeType("asserts node is X"), "void");
  assert.equal(normalizeType("asserts x"), "void");
});

test("hallucination-benchmark: halluc normalizeType: t.Node → Node (namespace stripped)", () => {
  assert.equal(normalizeType("t.Node"), "Node");
  assert.equal(normalizeType("ts.Map<string, number>"), "Map<string, number>");
});

test("hallucination-benchmark: halluc typeSimilarity: identical → 1, disjoint → 0", () => {
  assert.equal(typeSimilarity("Promise<string>", "Promise<string>"), 1);
  assert.equal(typeSimilarity("number", "string"), 0);
  assert.ok(typeSimilarity("Promise<string>", "Promise<number>") > 0.3, "partial similarity for shared Promise");
});

test("hallucination-benchmark: halluc levenshtein: standard distances", () => {
  assert.equal(levenshtein("", ""), 0);
  assert.equal(levenshtein("abc", "abc"), 0);
  assert.equal(levenshtein("abc", "abd"), 1);
  assert.equal(levenshtein("kitten", "sitting"), 3);
});

// ---------------------------------------------------------------------------
// SECTION 8: 10× HARDER (500 structural + 500 semantic traps)
// ---------------------------------------------------------------------------

test("hallucination-benchmark: halluc 10× HARDER: 500 structural traps 0% miss", () => {
  const traps = trapNames(500);
  let blocked = 0;
  let corrected = 0;
  for (const name of traps) {
    const r = detectHallucination(`${name}();\n`, "test", STRUCTURAL_INDEX, HCFG);
    if (r.blocked) blocked++;
    if (r.corrected) corrected++;
  }
  assert.equal(blocked + corrected, 500, `500 traps: ${blocked} blocked + ${corrected} corrected (0% miss)`);
});

test("hallucination-benchmark: halluc 10× HARDER: 500 real prompts 0% false block", () => {
  const prompts = realPrompts(500);
  let blocked = 0;
  for (const resp of prompts) {
    const r = detectHallucination(resp, "test", STRUCTURAL_INDEX, HCFG);
    if (r.blocked) blocked++;
  }
  assert.equal(blocked, 0, `0 false blocks on 500 real prompts (got ${blocked})`);
});

test("hallucination-benchmark: halluc 10× HARDER: 500 semantic traps 0% miss", () => {
  const traps = buildSemanticTraps(500);
  let caught = 0;
  for (const t of traps) {
    const claim: SemanticClaim = { ref: t.ref, field: t.field, value: t.wrongValue, inferred: false };
    const r = detectHallucination(`${t.ref}();\n`, "test", STRUCTURAL_INDEX, HCFG, SEMANTIC_INDEX, [claim]);
    if (r.blocked || r.corrected) caught++;
  }
  assert.equal(caught, 500, `500 semantic traps: ${caught} caught (0% miss)`);
});

test("hallucination-benchmark: halluc 10× HARDER: 500 true-claim controls 0% false block", () => {
  const traps = buildSemanticTraps(500);
  let blocked = 0;
  for (const t of traps) {
    const claim: SemanticClaim = { ref: t.ref, field: t.field, value: (t.correctValue ?? "void"), inferred: false };
    const r = detectHallucination(`${t.ref}();\n`, "test", STRUCTURAL_INDEX, HCFG, SEMANTIC_INDEX, [claim]);
    if (r.blocked) blocked++;
  }
  assert.equal(blocked, 0, `0 false blocks on 500 true claims (got ${blocked})`);
});

// ---------------------------------------------------------------------------
// SECTION 8b: EXP461 10× HARDER×10 — 5000 traps (structural + semantic) +
// 5000 real prompts + 5000 true-claim controls.
// ---------------------------------------------------------------------------

test("exp461-halluc 10× HARDER: 5000 structural traps 0% miss", () => {
  const traps = trapNames(5000);
  let blocked = 0;
  let corrected = 0;
  for (const name of traps) {
    const r = detectHallucination(`${name}();\n`, "test", STRUCTURAL_INDEX, HCFG);
    if (r.blocked) blocked++;
    if (r.corrected) corrected++;
  }
  assert.equal(blocked + corrected, 5000, `5000 traps: ${blocked} blocked + ${corrected} corrected (0% miss)`);
});

test("exp461-halluc 10× HARDER: 5000 real prompts 0% false block", () => {
  const prompts = realPrompts(5000);
  let blocked = 0;
  for (const resp of prompts) {
    const r = detectHallucination(resp, "test", STRUCTURAL_INDEX, HCFG);
    if (r.blocked) blocked++;
  }
  assert.equal(blocked, 0, `0 false blocks on 5000 real prompts (got ${blocked})`);
});

test("exp461-halluc 10× HARDER: 5000 semantic traps 0% miss", () => {
  const traps = buildSemanticTraps(5000);
  let caught = 0;
  for (const t of traps) {
    const claim: SemanticClaim = { ref: t.ref, field: t.field, value: t.wrongValue, inferred: false };
    const r = detectHallucination(`${t.ref}();\n`, "test", STRUCTURAL_INDEX, HCFG, SEMANTIC_INDEX, [claim]);
    if (r.blocked || r.corrected) caught++;
  }
  assert.equal(caught, 5000, `5000 semantic traps: ${caught} caught (0% miss)`);
});

test("exp461-halluc 10× HARDER: 5000 true-claim controls 0% false block", () => {
  const traps = buildSemanticTraps(5000);
  let blocked = 0;
  for (const t of traps) {
    const claim: SemanticClaim = { ref: t.ref, field: t.field, value: (t.correctValue ?? "void"), inferred: false };
    const r = detectHallucination(`${t.ref}();\n`, "test", STRUCTURAL_INDEX, HCFG, SEMANTIC_INDEX, [claim]);
    if (r.blocked) blocked++;
  }
  assert.equal(blocked, 0, `0 false blocks on 5000 true claims (got ${blocked})`);
});

// ---------------------------------------------------------------------------
// SECTION 9: Performance (CPU, RAM, latency)
// ---------------------------------------------------------------------------

test("hallucination-benchmark: halluc perf: per-detection latency < 5ms, memory bounded", () => {
  const memBefore = process.memoryUsage().rss;
  const N = 1000;
  // CPU work, never wall time (NO-LOAD-BLOCK).
  const totalMs = cpuWorkOf(() => {
    for (let i = 0; i < N; i++) {
      const claim: SemanticClaim = { ref: "cloneNode", field: "returns", value: i % 2 === 0 ? "boolean" : "T", inferred: false };
      detectHallucination("cloneNode();\n", "test", STRUCTURAL_INDEX, HCFG, SEMANTIC_INDEX, [claim]);
    }
  });
  const memAfter = process.memoryUsage().rss;
  const perDetectMs = totalMs / N;
  const memDeltaMb = (memAfter - memBefore) / 1024 / 1024;
  console.log(`    perf: ${N} detections in ${totalMs.toFixed(1)}ms (${perDetectMs.toFixed(3)}ms/detect), RSS delta ${memDeltaMb.toFixed(2)}MB`);
  assert.ok(perDetectMs < 5, `per-detection latency < 5ms (got ${perDetectMs.toFixed(3)}ms)`);
  assert.ok(memDeltaMb < 50, `RSS delta < 50MB (got ${memDeltaMb.toFixed(2)}MB)`);
});

test("hallucination-benchmark: halluc perf: semantic-index build from 20 sources < 1s", () => {
  const bigSources = Array.from({ length: 20 }, (_, i) => ({ path: `src/f${i}.ts`, content: SYNTHETIC_SOURCES[0]!.content }));
  let idx = buildSemanticIndexFromSources([]);
  // CPU work, never wall time (NO-LOAD-BLOCK).
  const ms = cpuWorkOf(() => { idx = buildSemanticIndexFromSources(bigSources); });
  console.log(`    perf: build semantic index from 20 sources in ${ms.toFixed(1)}ms, ${idx.records.length} records`);
  assert.ok(ms < 1000, `semantic index build < 1s (got ${ms.toFixed(1)}ms)`);
});

// ---------------------------------------------------------------------------
// SECTION 10: Real-codebase smoke (use the babel codebase if present)
// ---------------------------------------------------------------------------

test("hallucination-benchmark: halluc real-codebase: build semantic index from babel subset (smoke)", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const babelRoot = "./large-codebases/babel/packages/babel-traverse/src";
  requireHost(fs.existsSync(babelRoot), `the large-codebases corpus at ${babelRoot} (run "npm run corpus:fetch" to link the pinned subset)`);
  const files: { p: string; content: string }[] = [];
  function walk(dir: string): void {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!["__tests__", "test", "node_modules"].includes(e.name)) walk(full); }
      else if (e.name.endsWith(".ts")) files.push({ p: full, content: fs.readFileSync(full, "utf8") });
    }
  }
  walk(babelRoot);
  const t0 = process.hrtime.bigint();
  const idx = buildSemanticIndexFromSources(files.map((f) => ({ path: f.p, content: f.content })));
  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1e6;
  console.log(`    real-codebase: ${files.length} babel-traverse files → ${idx.records.length} functions in ${ms.toFixed(1)}ms`);
  assert.ok(idx.records.length > 0, `babel-traverse yielded >0 semantic records (got ${idx.records.length})`);
  // A real function with a known return type — verify a correct claim passes.
  const first = idx.records.find((r) => r.returnType !== null);
  if (first !== undefined) {
    const claim: SemanticClaim = { ref: first.name, field: "returns", value: first.returnType!, inferred: false };
    const mm = verifySemanticClaims([claim], idx, HCFG);
    assert.equal(mm.length, 0, `correct claim on real babel function "${first.name}" not blocked`);
  }
});
