import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";

import { detectDuplicateBodies } from "../../src/quality-packs/prevention/duplicate-body-detector.ts";

/**
 * D3 regression test — split-idiom delimiter-mismatch false positive (FINDING 1).
 *
 * Round 2 Verifier 1 found a MEDIUM finding: the split-idiom normalization emitted
 * `SPLIT ID STR` for BOTH `str.split(",")` and a hand-rolled split on `" "` — the
 * delimiter StringLiteral was normalized to `STR` (losing the value), so two
 * functions with DIFFERENT delimiters but otherwise identical bodies produced
 * the SAME token stream → Jaccard exactly 1.0 → caught at production-relaxed
 * (FP). Verifier 2 CONFIRMED + made the finding STRONGER (Jaccard is exactly
 * 1.0, not <1.0; the "not caught at strict" was the minTokenCount=100 filter,
 * not Jaccard rejection).
 *
 * The fix-up (Round 2): emit `STR_<delim-value>` in the 3 split-idiom sites
 * (CallExpression line 763, FunctionDeclaration split-span line 791,
 * VariableDeclaration split-init line 817). Different delimiters now produce
 * different tokens → Jaccard < 1.0 → not caught (FP fixed). Same delimiters
 * produce the same token → Jaccard 1.0 → still caught (T4b preserved).
 *
 * This test locks in the fix so the FP cannot reappear:
 * - `processComma` (source.split(",")) vs `processSpace` (hand-rolled on " ")
 * MUST produce 0 findings at production-relaxed (the FP).
 * - `processComma` (source.split(",")) vs `processCommaHand` (hand-rolled on ",")
 * MUST produce findings at production-relaxed (T4b preserved — same delimiter).
 * - The FP MUST also be absent at strict mt=30 (where Jaccard was exactly 1.0
 * before the fix — Verifier 2's stronger finding).
 *
 * Round 2 Verifier 3 found a LOW finding: the long/pipe path emitted
 * `STR_<sha8>` (first 8 hex chars of sha256 — 32 bits), and a brute-force
 * search found colliding long/pipe delimiter pairs in seconds (birthday ~65k
 * for 50% at 2^32 space) → Jaccard 1.0 → FP at production-relaxed. The
 * Round 2 fix-up #2 changed sha8 → sha16 (first 16 hex chars — 64 bits,
 * 2^64 space, birthday ~4.3e9 for 50% — effectively impossible to hit by
 * accident; a deliberate ~4B-string search is required for a 50% collision,
 * far beyond any realistic delimiter pool of 1-10 distinct delimiters per
 * codebase). The 5th test below locks in the sha16 collision-resistance:
 * the verifier's sha8-colliding pair (which produces a FP pre-fix) MUST NOT
 * collide at sha16 (the fix's effect) and MUST NOT produce a FP at any
 * production threshold.
 *
 * Residual sha16 surface (documented, not tested infeasible — would require
 * a ~4.3-billion-string brute-force search for a 50% birthday collision): a
 * future deliberate-attacker scenario could craft sha16-colliding delimiters
 * → FP at production-relaxed. The mitigation path is sha16 → sha24 or sha32
 * (a one-line change, same as sha8 → sha16). The current sha16 length is the
 * documented trade-off: 64 bits reduces the risk by 2^32× over sha8 while
 * keeping the canonical token at a readable 21-char width (`STR_` + 16 hex).
 *
 * Sources: Round 2 verifier probe `probes/round2-verifier-control-pairs.mjs`
 * (CONTROL SPLIT-A) + fix-up probe `probes/round2-fixup-split-delim-probe.mjs`
 * + Round 2 Verifier 3 probe `probes/round2-fixup-v3-sha8-collision-probe.mjs`
 * + brute-force search `probes/round2-fixup-v3-sha8-collision-search.mjs`.
 * The split-idiom normalization is a functor-application equivalence (category
 * theory — `arr.split(delim)` is a functor application of the split operation;
 * the delimiter is the functor's parameter, which must be preserved in the
 * canonical form to avoid collapsing non-equivalent applications).
 */

// ~250 char body: uses source.split(",") (library form). Well above minBodySize=80
// + minTokenCount=30. The body after the split is intentionally identical to the
// hand-rolled form so the ONLY token difference is the delimiter value.
const PROCESS_COMMA = `
export function processComma(source) {
  const lines = source.split(",");
  const results = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      const match = trimmed.match(/^[A-Z]/);
      if (match) {
        results.push({ raw: trimmed, first: match[0], index: results.length });
      } else {
        results.push({ raw: trimmed, first: null, index: results.length });
      }
    }
  }
  return results;
}
`;

// Hand-rolled split on " " (DIFFERENT delimiter). Same body after the split.
// Before the fix: both emitted `SPLIT ID STR` → Jaccard 1.0 → caught (FP).
// After the fix: `SPLIT ID STR_,` vs `SPLIT ID STR_ ` → Jaccard < 1.0 → not caught.
const PROCESS_SPACE_HANDROLLED = `
export function processSpace(source) {
  const lines = [];
  let cur = "";
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === " ") {
      lines.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  lines.push(cur);
  const results = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      const match = trimmed.match(/^[A-Z]/);
      if (match) {
        results.push({ raw: trimmed, first: match[0], index: results.length });
      } else {
        results.push({ raw: trimmed, first: null, index: results.length });
      }
    }
  }
  return results;
}
`;

// Hand-rolled split on "," (SAME delimiter). Same body after the split.
// This is the T4b sanity case: same delimiter → same `STR_,` token → Jaccard 1.0 → caught.
const PROCESS_COMMA_HANDROLLED = `
export function processCommaHand(source) {
  const lines = [];
  let cur = "";
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === ",") {
      lines.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  lines.push(cur);
  const results = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      const match = trimmed.match(/^[A-Z]/);
      if (match) {
        results.push({ raw: trimmed, first: match[0], index: results.length });
      } else {
        results.push({ raw: trimmed, first: null, index: results.length });
      }
    }
  }
  return results;
}
`;

function verdict(findings: readonly { file: string; cluster: string }[], origPath: string, mutPath: string): boolean {
  const byCluster = new Map<string, { file: string }[]>();
  for (const f of findings) {
    const list = byCluster.get(f.cluster) ?? [];
    list.push({ file: f.file });
    byCluster.set(f.cluster, list);
  }
  for (const [, fs] of byCluster) {
    if (fs.some((f) => f.file === origPath) && fs.some((f) => f.file === mutPath)) return true;
  }
  return false;
}

test("split-idiom delimiter-mismatch: DIFFERENT delimiters NOT caught at production-relaxed (FINDING 1 FP fixed)", () => {
  const sources = [
    { path: "process-comma.ts", content: PROCESS_COMMA },
    { path: "process-space.ts", content: PROCESS_SPACE_HANDROLLED },
  ];
  // Production-relaxed: jaccardThreshold 0.9, minTokenCount 30, minBodySize 80.
  const result = detectDuplicateBodies({
    sources,
    allowlistCross: [],
    allowlistSameFile: [],
    jaccardThreshold: 0.9,
    minTokenCount: 30,
    minBodySize: 80,
  });
  assert.equal(
    result.findings.length,
    0,
    "DIFFERENT delimiters (comma vs space) must NOT be caught at production-relaxed. " +
      "Before the Round 2 fix-up, both forms emitted `SPLIT ID STR` (delimiter " +
      "normalized to `STR`, losing the value) → Jaccard 1.0 → FP. The fix emits " +
      "`STR_<delim-value>` so different delimiters produce different tokens.",
  );
});

test("split-idiom delimiter-mismatch: DIFFERENT delimiters NOT caught at strict mt=30 (Jaccard was exactly 1.0 before fix)", () => {
  const sources = [
    { path: "process-comma.ts", content: PROCESS_COMMA },
    { path: "process-space.ts", content: PROCESS_SPACE_HANDROLLED },
  ];
  // Strict with minTokenCount=30 (lower filter — reveals the Jaccard=1.0 FP that
  // Verifier 2 found; at mt=100 the bodies are filtered out, hiding the FP).
  const result = detectDuplicateBodies({
    sources,
    allowlistCross: [],
    allowlistSameFile: [],
    jaccardThreshold: 1.0,
    minTokenCount: 30,
    minBodySize: 80,
  });
  assert.equal(
    result.findings.length,
    0,
    "DIFFERENT delimiters must NOT be caught at strict thr=1.0 mt=30. " +
      "Verifier 2 CONFIRMED the Jaccard was exactly 1.0 (not <1.0) before the fix — " +
      "the FP was STRONGER than Verifier 1 claimed.",
  );
});

test("split-idiom delimiter-mismatch: SAME delimiter still caught at production-relaxed (T4b preserved)", () => {
  const sources = [
    { path: "process-comma.ts", content: PROCESS_COMMA },
    { path: "process-comma-hand.ts", content: PROCESS_COMMA_HANDROLLED },
  ];
  // Production-relaxed: same delimiter → same `STR_,` token → Jaccard 1.0 → caught.
  const result = detectDuplicateBodies({
    sources,
    allowlistCross: [],
    allowlistSameFile: [],
    jaccardThreshold: 0.9,
    minTokenCount: 30,
    minBodySize: 80,
  });
  assert.ok(
    verdict(result.findings, "process-comma.ts", "process-comma-hand.ts"),
    "SAME delimiter (comma vs comma) MUST still be caught at production-relaxed. " +
      "The fix preserves T4b because same delimiter → same `STR_<value>` token.",
  );
});

test("split-idiom delimiter-mismatch: SAME delimiter still caught at strict mt=30 (T4b preserved at strict)", () => {
  const sources = [
    { path: "process-comma.ts", content: PROCESS_COMMA },
    { path: "process-comma-hand.ts", content: PROCESS_COMMA_HANDROLLED },
  ];
  // Strict with minTokenCount=30: same delimiter → Jaccard 1.0 → caught.
  const result = detectDuplicateBodies({
    sources,
    allowlistCross: [],
    allowlistSameFile: [],
    jaccardThreshold: 1.0,
    minTokenCount: 30,
    minBodySize: 80,
  });
  assert.ok(
    verdict(result.findings, "process-comma.ts", "process-comma-hand.ts"),
    "SAME delimiter (comma vs comma) MUST still be caught at strict thr=1.0 mt=30. " +
      "T4b is preserved at strict because same delimiter → same `STR_<value>` token.",
  );
});

/**
 * Round 2 Verifier 3's sha8-colliding long-delimiter pair (found by brute-force
 * search via `probes/round2-fixup-v3-sha8-collision-search.mjs` in seconds;
 * persisted to `/tmp/bridlewise/r2v3-probes/sha8-collision.json` at verifier time
 * + hardcoded here so the test is self-contained). Both strings are 40 chars
 * long (> 32 → triggers the long/pipe path) and produce the same first-8-hex
 * of sha256 (`6bc0db57`) → same `STR_<sha8>` token → Jaccard 1.0 → FP at
 * production-relaxed + strict mt=30 (pre-fix). The fix (sha8 → sha16) makes
 * their `STR_<sha16>` tokens differ (`6bc0db57deea0674` vs `6bc0db57fe3d3cb1`)
 * → Jaccard < 1.0 → not caught (FP fixed).
 */
const SHA8_COLLIDING_S1 = "delimiter-value-50991xxxxxxxxxxxxxxxxxxx";
const SHA8_COLLIDING_S2 = "delimiter-value-90196xxxxxxxxxxxxxxxxxxx";

// ~250 char body: uses source.split(<long-delim>) (library form with a long
// delimiter → exercises the sha8/sha16 path, not the short `STR_<value>` path).
function makeLibForm(name: string, delim: string): string {
  return `
export function ${name}(source) {
  const lines = source.split(${JSON.stringify(delim)});
  const results = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      const match = trimmed.match(/^[A-Z]/);
      if (match) {
        results.push({ raw: trimmed, first: match[0], index: results.length });
      } else {
        results.push({ raw: trimmed, first: null, index: results.length });
      }
    }
  }
  return results;
}
`;
}

// Hand-rolled split on the SAME long delimiter (so the bodies are semantically
// equivalent + structurally identical post-normalization except the delimiter
// value, which is the only token that distinguishes them).
function makeHandForm(name: string, delim: string): string {
  return `
export function ${name}(source) {
  const lines = [];
  let cur = "";
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === ${JSON.stringify(delim)}) {
      lines.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  lines.push(cur);
  const results = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      const match = trimmed.match(/^[A-Z]/);
      if (match) {
        results.push({ raw: trimmed, first: match[0], index: results.length });
      } else {
        results.push({ raw: trimmed, first: null, index: results.length });
      }
    }
  }
  return results;
}
`;
}

test("split-idiom delimiter-mismatch: sha8-colliding long delimiters NOT caught at any production threshold (Round 2 Verifier 3 FINDING 1 fixed)", () => {
  // Guard 1: the pair MUST still collide at sha8 — this is a regression guard.
  // If sha256 ever changes (e.g. a different hash algorithm), this test fails
  // loudly, and the test pair must be re-derived from a fresh brute-force
  // search (run `probes/round2-fixup-v3-sha8-collision-search.mjs`).
  const sha8 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 8);
  const sha16 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
  assert.equal(
    sha8(SHA8_COLLIDING_S1),
    sha8(SHA8_COLLIDING_S2),
    "Regression guard: the test pair MUST collide at sha8. If this fails, " +
      "sha256 changed and the test pair must be re-derived from a fresh " +
      "brute-force search (probes/round2-fixup-v3-sha8-collision-search.mjs).",
  );

  // Guard 2: the pair MUST NOT collide at sha16 — this is the fix's effect.
  // The first-8-hex collision does NOT extend to 16 hex chars.
  assert.notEqual(
    sha16(SHA8_COLLIDING_S1),
    sha16(SHA8_COLLIDING_S2),
    "Fix effect: the sha8-colliding pair MUST NOT collide at sha16. If this " +
      "fails, the sha16 length is too short (a deliberate ~4.3B-string search " +
      "would be required — verify the test pair was not deliberately crafted " +
      "to collide at sha16, which would be an attack, not a regression).",
  );

  const sources = [
    { path: "f1.ts", content: makeLibForm("f1", SHA8_COLLIDING_S1) },
    { path: "f2.ts", content: makeHandForm("f2", SHA8_COLLIDING_S2) },
  ];
  // Test ALL production thresholds where the FP was reproduced pre-fix:
  // - production-strict (1.0, mt=100): was caught=false pre-fix (size filter);
  // MUST stay caught=false post-fix (the fix doesn't introduce a new FP at mt=100).
  // - production-relaxed (0.9, mt=30): was caught=true pre-fix (FP);
  // MUST be caught=false post-fix (FP fixed).
  // - strict mt=30 (1.0, mt=30): was caught=true pre-fix (FP, Jaccard exactly 1.0);
  // MUST be caught=false post-fix (FP fixed — Verifier 3's strongest case).
  for (const c of [
    { name: "production-strict (1.0, mt=100)", jaccardThreshold: 1.0, minTokenCount: 100 },
    { name: "production-relaxed (0.9, mt=30)", jaccardThreshold: 0.9, minTokenCount: 30 },
    { name: "strict mt=30 (1.0, mt=30)", jaccardThreshold: 1.0, minTokenCount: 30 },
  ]) {
    const result = detectDuplicateBodies({
      sources,
      allowlistCross: [],
      allowlistSameFile: [],
      jaccardThreshold: c.jaccardThreshold,
      minTokenCount: c.minTokenCount,
      minBodySize: 80,
    });
    assert.equal(
      result.findings.length,
      0,
      `sha8-colliding long delimiters MUST NOT be caught at ${c.name}. ` +
        "Round 2 Verifier 3 found this pair produces a FP at production-relaxed " +
        "+ strict mt=30 pre-fix (sha8 collision → same `STR_<sha8>` token → " +
        "Jaccard 1.0). The fix-up #2 (sha8 → sha16) makes their `STR_<sha16>` " +
        "tokens differ → Jaccard < 1.0 → not caught (FP fixed).",
    );
  }
});
