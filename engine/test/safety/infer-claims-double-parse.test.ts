// Regression test for EXP447: inferClaimsFromCode double-parses.
// Root cause: inferClaimsFromCode always called @babel/parser even when the
// caller already had a parsed AST. Fix: accept an optional preParsedAst
// parameter so callers can pass the already-parsed AST and skip the re-parse.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "@babel/parser";
import { inferClaimsFromCode } from "../../src/safety/hallucination-semantic.ts";

const config = {
  semanticInferClaims: true,
  maxReferencesPerResponse: 100,
  semanticClaimJaccardThreshold: 0.85,
  semanticAutoCorrectSignature: false,
  semanticTypeAliasThreshold: 0.85,
} as never;

const codeWithAwait = `
async function handler() {
  await fetchData();
  if (isValid()) return true;
  try { processItem(); } catch (e: Error) {}
}
`;

test("inferClaimsFromCode without preParsedAst (backward-compatible) works", () => {
  const claims = inferClaimsFromCode(codeWithAwait, config);
  assert.ok(claims.length > 0, "should infer claims");
  const asyncClaim = claims.find((c) => c.field === "async");
  assert.ok(asyncClaim, "should find async claim for await fetchData()");
  assert.equal(asyncClaim?.ref, "fetchData");
});

test("inferClaimsFromCode with preParsedAst produces identical results", () => {
  const ast = parse(codeWithAwait, { sourceType: "module", errorRecovery: true, plugins: ["typescript"] });
  const claimsNoAst = inferClaimsFromCode(codeWithAwait, config);
  const claimsWithAst = inferClaimsFromCode(codeWithAwait, config, ast);
  // Results must be identical (same claims, same order).
  assert.equal(claimsWithAst.length, claimsNoAst.length,
    `preParsedAst must produce same number of claims: ${claimsWithAst.length} vs ${claimsNoAst.length}`);
  for (let i = 0; i < claimsNoAst.length; i++) {
    assert.deepEqual(claimsWithAst[i], claimsNoAst[i], `claim ${i} must match`);
  }
});

test("inferClaimsFromCode with preParsedAst does NOT re-parse (perf)", () => {
  // A preParsedAst of an empty program → no claims. If the function re-parsed
  // `code`, it would find claims from the real code. Passing a deliberately
  // empty AST proves the preParsedAst is used (not re-parsed).
  const emptyAst = parse(";", { sourceType: "module", errorRecovery: true });
  const claims = inferClaimsFromCode(codeWithAwait, config, emptyAst);
  assert.equal(claims.length, 0,
    "preParsedAst (empty program) must be used → no claims (proves no re-parse)");
  // Contrast: without preParsedAst, the same code DOES produce claims.
  const claimsReparse = inferClaimsFromCode(codeWithAwait, config);
  assert.ok(claimsReparse.length > 0, "without preParsedAst, code IS parsed → claims found");
});
