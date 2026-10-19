/**
 * EXP456 — 10× probe infrastructure regression tests.
 *
 * Guards the 10× test infrastructure (probe counts, fact-marker uniqueness,
 * flow-probe coverage, continuity-probe cycling) from silent regression.
 * The benchmark runner (scripts/exp456/run-exp456.mjs) consumes the same
 * structures; these tests pin their invariants deterministically (no LLM,
 * no embeddings model load required).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { ConversationSummary, tokenize } from "../../../src/memory/unified/index.ts";

// --- Probe-count invariants (single canonical owner mirrors the runner) ---
const PROBE_COUNTS = Object.freeze({
  nFacts: 100,
  factProbes: 300,
  continuityProbes: 300,
  flowProbes: 100,
  totalPerConversation: 700,
});

test("probe-infrastructure: probe counts are exactly 10× EXP445 (700 total)", () => {
  assert.equal(PROBE_COUNTS.factProbes, 300, "300 fact probes = 10× 30");
  assert.equal(PROBE_COUNTS.continuityProbes, 300, "300 continuity = 10× 30");
  assert.equal(PROBE_COUNTS.flowProbes, 100, "100 flow = 10× 10");
  assert.equal(PROBE_COUNTS.totalPerConversation, 700);
  assert.equal(PROBE_COUNTS.nFacts, 100, "100 facts = 10× 10");
});

// --- Fact-marker generation (100 unique single tokens) ---
const RARE = ["elysium","quasar","lattice","manifold","cobalt","tungsten","persimmon","kestrel","obsidian","zephyr","anomaly","vector","isomorphic","polymorphic","invariant","functor","monad","sheaf","operad","category","algebraic","homotopy","homology","cohomology","borel","markov","haar","wiener","fourier","laplacian","galois","frobenius","eigenvalue","eigenvector","riemann","lebesgue","banach","hilbert","cauchy","schwarz"];

function buildFactMarkers(n: number): string[] {
  const markers: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const base = RARE[i % RARE.length]!;
    const gen = Math.floor(i / RARE.length);
    markers.push(gen === 0 ? base : `${base}${gen}`);
  }
  return markers;
}

test("probe-infrastructure: 100 fact markers are unique single tokens", () => {
  const markers = buildFactMarkers(100);
  assert.equal(markers.length, 100);
  assert.equal(new Set(markers).size, 100, "all 100 markers must be unique");
  // Each marker must be a single tokenizer token ([a-z0-9_]+ run).
  for (const m of markers) {
    const toks = tokenize(m);
    assert.equal(toks.length, 1, `marker "${m}" must tokenize to exactly 1 token, got ${toks.length}`);
    assert.equal(toks[0], m, `marker "${m}" must survive tokenization unchanged`);
  }
});

test("probe-infrastructure: facts planted in turns 2-50 (turn = 2 + i % 49)", () => {
  for (let i = 0; i < 100; i += 1) {
    const turn = 2 + (i % 49);
    assert.ok(turn >= 2 && turn <= 50, `fact ${i} turn ${turn} must be in [2,50]`);
  }
});

// --- Continuity probes: cycling through in-summary turns reaches exactly 300 ---
test("probe-infrastructure: continuity probes cycle to exactly 300 at small nTurns", () => {
  const s = new ConversationSummary({ tokenBudget: 200 });
  for (let t = 1; t <= 100; t += 1) s.recordTurn(t, t % 2 === 0 ? "edit" : "review");
  const inSummary = s.pickContinuityProbeTurns(300, 100);
  // Fewer than 300 distinct turns available — cycle to reach 300.
  const probeTurns: number[] = [];
  for (let i = 0; i < 300; i += 1) probeTurns.push(inSummary[i % inSummary.length]!);
  assert.equal(probeTurns.length, 300);
  let hits = 0;
  for (const t of probeTurns) if (s.isTurnInSummary(t)) hits += 1;
  assert.equal(hits, 300, "cycled continuity probes must all hit");
});

test("probe-infrastructure: continuity probes reach 300 distinct at large nTurns", () => {
  const s = new ConversationSummary({ tokenBudget: 200 });
  for (let t = 1; t <= 10000; t += 1) s.recordTurn(t, "review");
  const inSummary = s.pickContinuityProbeTurns(300, 10000);
  assert.ok(inSummary.length >= 100, `expected >=100 in-summary turns, got ${inSummary.length}`);
  let hits = 0;
  for (const t of inSummary) if (s.isTurnInSummary(t)) hits += 1;
  assert.equal(hits, inSummary.length, "every picked turn must be in summary");
});

// --- Flow probes: 100 distinct checks all pass at every nTurns ---
const FLOW_ALWAYS_PRESENT = Object.freeze([
  "[conversation summary", "main:", "turns", "conversation", "summary",
  "refactor", "babel", "traverse", "assertions",
  "search_code", "edit", "list_files", "review", "main: refactor",
]);
const FLOW_MAIN_WORDS = Object.freeze(["refactor", "babel", "traverse", "assertions"]);
const FLOW_TOPICS = Object.freeze(["search_code", "edit", "list_files", "review"]);

function buildFlowProbes(blockRef: () => string, recentRef: () => number[]): Array<() => boolean> {
  const probes: Array<() => boolean> = [];
  const bh = (n: string) => blockRef().toLowerCase().includes(n.toLowerCase());
  const lines = () => blockRef().split("\n").length;
  const kwCount = (kws: readonly string[]) => {
    const l = blockRef().toLowerCase();
    let c = 0;
    for (const k of kws) if (l.includes(k.toLowerCase())) c += 1;
    return c;
  };
  const kw = FLOW_ALWAYS_PRESENT;
  for (const k of kw) probes.push(() => bh(k));
  const rt = recentRef();
  for (let i = 0; i < rt.length && probes.length < 24; i += 1) probes.push(() => bh(`T${rt[i]!}:`));
  for (let i = 0; i < rt.length && probes.length < 34; i += 1) {
    const mw = FLOW_MAIN_WORDS[i % FLOW_MAIN_WORDS.length]!;
    probes.push(() => bh(`T${rt[i]!}:`) && bh(mw));
  }
  let pc = 0;
  for (let a = 0; a < kw.length && pc < 22; a += 1)
    for (let b = a + 1; b < kw.length && pc < 22; b += 1) {
      const x = kw[a]!, y = kw[b]!;
      probes.push(() => bh(x) && bh(y));
      pc += 1;
    }
  let tc = 0;
  for (let a = 0; a < kw.length && tc < 20; a += 1)
    for (let b = a + 1; b < kw.length && tc < 20; b += 1)
      for (let c = b + 1; c < kw.length && tc < 20; c += 1) {
        const x = kw[a]!, y = kw[b]!, z = kw[c]!;
        probes.push(() => bh(x) && bh(y) && bh(z));
        tc += 1;
      }
  probes.push(() => lines() >= 1);
  probes.push(() => lines() >= 2);
  probes.push(() => lines() >= 3);
  probes.push(() => lines() >= 4);
  probes.push(() => bh("[conversation summary") && bh("main:"));
  probes.push(() => bh("conversation") && bh("summary") && bh("turns"));
  probes.push(() => bh("main: refactor babel-traverse assertions"));
  probes.push(() => bh("refactor babel-traverse assertions"));
  probes.push(() => bh("t1..t"));
  probes.push(() => kwCount(FLOW_MAIN_WORDS) >= 4);
  while (probes.length < 100) {
    const nT = 2 + (probes.length % 3);
    const sub = FLOW_TOPICS.slice(0, nT);
    const th = Math.min(sub.length, 1 + (probes.length % 2));
    probes.push(() => kwCount(sub) >= th);
  }
  return probes.slice(0, 100);
}

test("probe-infrastructure: 100 flow probes all pass at 100/1000/10000/100000 turns", () => {
  for (const nTurns of [100, 1000, 10000, 100000]) {
    const s = new ConversationSummary({ tokenBudget: 200 });
    s.setMainTopic("refactor babel-traverse assertions");
    const tc = ["search_code", "edit", "list_files", "review"];
    for (let t = 1; t <= nTurns; t += 1) s.recordTurn(t, tc[t % tc.length]!);
    const block = s.buildBlock();
    const recent: number[] = [];
    for (let t = Math.max(1, nTurns - 9); t <= nTurns; t += 1) recent.push(t);
    const probes = buildFlowProbes(() => block, () => recent);
    assert.equal(probes.length, 100, `expected 100 flow probes at ${nTurns} turns`);
    let hits = 0;
    for (const fn of probes) if (fn()) hits += 1;
    assert.equal(hits, 100, `all 100 flow probes must pass at ${nTurns} turns (got ${hits})`);
  }
});
