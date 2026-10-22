/**
 * A REPRODUCTION SHIM (`harness flake reproduce --preload`, the FLAKE-REPRO
 * decision) for the agent-orchestration token-usage test: every
 * `Math.random()` draw made from `tests/unit/agent-orchestration.test.ts`
 * answers 0.027789805185527205, whose base-36 digits (`100k791r5v5d`) make
 * `run-orch-tokens-100k791r5v5d` read as a declared credential to the
 * timeline's identity check. It recreates, deterministically, the one draw in
 * about forty that refused the mirror of the orchestrated agent (#205, #222).
 * Every other caller draws as before; the test and the product are untouched.
 *
 * Preloaded into the reproduction run's vitest processes (the door's
 * NODE_OPTIONS); never imported by a test.
 */
const FLAGGED_DRAW = 0.027789805185527205;
const draw = Math.random;

Math.random = function drawnFromTheOrchestrationTest(): number {
  return /agent-orchestration\.test\.ts/u.test(new Error().stack ?? "") ? FLAGGED_DRAW : draw();
};
