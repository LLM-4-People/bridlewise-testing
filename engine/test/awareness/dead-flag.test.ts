// Regression test for the `expensiveSignals` awareness gate.
//
// History: EXP446 removed a DEAD `expensiveSignals` flag (benchmark scripts
// passed `expensiveSignals: false` but AwarenessConfig had no such field →
// silently ignored). EXP446 replaced it with fine-grained
// `signals: { clones: false,... }` toggles.
//
// EXP462 re-introduced `expensiveSignals` as a LIVE, wired coarse gate over
// the 44 new expensive network signals (O(n²)–O(n³)). It is NOT dead: it is
// declared in AwarenessConfig, threaded through `configureAwareness`, and
// consumed by the engine's `expGate`. The fine-grained `signals.*` toggles
// remain the per-signal authority (each expensive signal checks
// `config.signals.<name> && expGate(id)`).
//
// This test guards the regression that originally motivated EXP446: a flag
// that callers pass but the harness silently ignores. It now asserts the
// positive — `expensiveSignals` is declared AND consumed (live, not dead) —
// plus the fine-grained per-signal authority still exists.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("expensiveSignals is declared in AwarenessConfig (live configurable, not dead)", () => {
  const src = readFileSync("src/awareness/config.ts", "utf8");
  assert.match(src, /expensiveSignals:\s*boolean/,
    "AwarenessConfig must declare expensiveSignals as a configurable field");
  // configureAwareness must thread the override through (not silently drop it).
  assert.match(src, /expensiveSignals:\s*override\.expensiveSignals\s*\?\?\s*base\.expensiveSignals/,
    "configureAwareness must apply override.expensiveSignals (a dead flag would drop it)");
});

test("expensiveSignals is consumed by the engine expGate (wired, not silently ignored)", () => {
  const engine = readFileSync("src/awareness/engine.ts", "utf8");
  // The gate must reference config.expensiveSignals — a dead flag would not
  // appear in the engine at all (the original EXP446 bug).
  assert.match(engine, /config\.expensiveSignals/,
    "engine must consume config.expensiveSignals (proves the flag is not dead)");
  assert.match(engine, /EXPENSIVE_SIGNAL_IDS\.has/,
    "engine must gate expensive signals via EXPENSIVE_SIGNAL_IDS + expensiveSignals");
});

test("fine-grained per-signal toggles remain the per-signal authority", () => {
  const engine = readFileSync("src/awareness/engine.ts", "utf8");
  // Each expensive signal must ALSO check its fine-grained toggle
  // (config.signals.<name>) — the coarse gate is additive, not a replacement.
  assert.match(engine, /config\.signals\.bellClones\s*&&\s*expGate/,
    "expensive signals must be gated by BOTH the fine toggle and the coarse gate");
});
