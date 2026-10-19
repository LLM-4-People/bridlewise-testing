import assert from "node:assert/strict";
import test from "node:test";

import { canonicalHash, sha256 } from "../../src/kernel/integrity.ts";
import {
  createDevelopmentConfig,
  createProductionConfig,
  generateMatrix,
  NO_PROMPT_SENT_SHA256,
  NO_TOOLS_SENT_SHA256,
} from "../../src/evaluation/matrix-generator.ts";
import { SEED_SCENARIOS, SEED_PROJECTS } from "../../src/evaluation/scenarios.ts";
import {
  CHEP_CANONICAL_PHASE_CONFIG,
  CHEP_PROTOCOL_ID,
  CHEP_SCHEMA_VERSION,
  CHEP_TARGET_SCORED_SCENARIOS,
} from "../../src/evaluation/types.ts";
import type { ConditionArm } from "../../src/evaluation/types.ts";
import { validateMatrix } from "../../src/evaluation/semantic-validators.ts";
import { devMatrix } from "../support/matrix.ts";

test("evaluation/matrix-generator: development matrix has correct schema version", () => {
  const m = devMatrix();
  assert.equal(m.schema_version, CHEP_SCHEMA_VERSION);
  assert.equal(m.protocol_id, CHEP_PROTOCOL_ID);
});

test("evaluation/matrix-generator: development matrix has matrix_id matching mtx_ pattern", () => {
  const m = devMatrix();
  assert.match(m.matrix_id, /^mtx_[0-9a-f]{64}$/);
});

test("evaluation/matrix-generator: development matrix is preregistered", () => {
  const m = devMatrix();
  assert.equal(m.matrix_state, "preregistered");
});

test("evaluation/matrix-generator: models are exactly the CHEP pair", () => {
  const m = devMatrix();
  assert.deepEqual(m.models, ["google/gemma-4-26B-A4B", "zai-org/GLM-5.2-NVFP4"]);
});

test("evaluation/matrix-generator: AGN-4 custom models are used by generateMatrix", () => {
  const cfg = createDevelopmentConfig(SEED_SCENARIOS, SEED_PROJECTS, 4096, ["alpha/model-1", "beta/model-2"]);
  const m = generateMatrix(cfg);
  assert.deepEqual(m.models, ["alpha/model-1", "beta/model-2"]);
  for (const t of m.tests) {
    const cells = m.cells.filter((c) => c.test_id === t.test_id);
    assert.equal(cells.length, 2, `test ${t.test_id} should have 2 cells (one per model)`);
    const models = new Set(cells.map((c) => c.model_id));
    assert.ok(models.has("alpha/model-1"));
    assert.ok(models.has("beta/model-2"));
  }
});

test("evaluation/matrix-generator: AGN-4 default models are the CHEP pair", () => {
  const cfg = createDevelopmentConfig(SEED_SCENARIOS, SEED_PROJECTS);
  assert.deepEqual([...cfg.models], ["google/gemma-4-26B-A4B", "zai-org/GLM-5.2-NVFP4"]);
});

test("evaluation/matrix-generator: AGN-4 custom models pass semantic validation", () => {
  const cfg = createDevelopmentConfig(SEED_SCENARIOS, SEED_PROJECTS, 4096, ["alpha/model-1", "beta/model-2"]);
  const m = generateMatrix(cfg);
  const report = validateMatrix(m);
  const exactModels = report.findings.find((f) => f.invariant === "exact_models_only")!;
  assert.ok(exactModels.passed, `exact_models_only should pass for custom models: ${exactModels.detail}`);
  const twoModelCross = report.findings.find((f) => f.invariant === "complete_two_model_cross_for_every_test")!;
  assert.ok(twoModelCross.passed, `complete_two_model_cross should pass for custom models: ${twoModelCross.detail}`);
});

test("evaluation/matrix-generator: AGN-4 single-model config is rejected by factory", () => {
  assert.throws(
    () => createDevelopmentConfig(SEED_SCENARIOS, SEED_PROJECTS, 4096, []),
    /at least one model id/u,
  );
});

test("evaluation/matrix-generator: repetitions is exactly 3", () => {
  const m = devMatrix();
  assert.equal(m.repetitions_per_model_test_cell, 3);
});

test("evaluation/matrix-generator: target scored scenarios is 1024", () => {
  const m = devMatrix();
  assert.equal(m.target_unique_scored_scenarios, CHEP_TARGET_SCORED_SCENARIOS);
});

test("evaluation/matrix-generator: sampling temperature is 0", () => {
  const m = devMatrix();
  assert.equal(m.sampling.temperature, 0);
  assert.equal(m.sampling.request_cache, false);
  assert.equal(m.sampling.adaptive_reasoning_policy, "disabled-or-omitted-uniformly");
});

test("evaluation/matrix-generator: 4 phases defined", () => {
  const m = devMatrix();
  assert.equal(m.phases.length, 4);
  assert.equal(m.phases[0]!.phase, "P0-shakedown");
  assert.equal(m.phases[1]!.phase, "P1-baseline");
  assert.equal(m.phases[2]!.phase, "P2-development");
  assert.equal(m.phases[3]!.phase, "P3-holdout");
});

test("evaluation/matrix-generator: P0 is not counted and not holdout", () => {
  const m = devMatrix();
  assert.equal(m.phases[0]!.counted_toward_target, false);
  assert.equal(m.phases[0]!.holdout, false);
  assert.equal(m.phases[0]!.tuning_allowed, false);
});

test("evaluation/matrix-generator: P1 is counted and not holdout", () => {
  const m = devMatrix();
  assert.equal(m.phases[1]!.counted_toward_target, true);
  assert.equal(m.phases[1]!.holdout, false);
  assert.equal(m.phases[1]!.tuning_allowed, false);
});

test("evaluation/matrix-generator: P2 is counted and tuning allowed", () => {
  const m = devMatrix();
  assert.equal(m.phases[2]!.counted_toward_target, true);
  assert.equal(m.phases[2]!.holdout, false);
  assert.equal(m.phases[2]!.tuning_allowed, true);
});

test("evaluation/matrix-generator: P3 is counted and holdout", () => {
  const m = devMatrix();
  assert.equal(m.phases[3]!.counted_toward_target, true);
  assert.equal(m.phases[3]!.holdout, true);
  assert.equal(m.phases[3]!.tuning_allowed, false);
});

test("evaluation/matrix-generator: phase scenario counts match config", () => {
  const m = devMatrix();
  for (const phase of m.phases) {
    const actual = m.scenarios.filter((s) => s.phase === phase.phase).length;
    assert.equal(actual, phase.unique_scenario_count, `phase ${phase.phase} count mismatch`);
  }
});

test("evaluation/matrix-generator: all scenario IDs unique", () => {
  const m = devMatrix();
  const ids = m.scenarios.map((s) => s.scenario_id);
  assert.equal(new Set(ids).size, ids.length);
});

test("evaluation/matrix-generator: P0 scenarios are not scored", () => {
  const m = devMatrix();
  for (const s of m.scenarios.filter((s) => s.phase === "P0-shakedown")) {
    assert.equal(s.scored, false);
    assert.equal(s.holdout.access_class, "retired-shakedown");
    assert.equal(s.holdout.tuning_access_prohibited, true);
  }
});

test("evaluation/matrix-generator: scored scenarios are scored", () => {
  const m = devMatrix();
  for (const s of m.scenarios.filter((s) => s.phase !== "P0-shakedown")) {
    assert.equal(s.scored, true);
  }
});

test("evaluation/matrix-generator: P3 scenarios are holdout", () => {
  const m = devMatrix();
  for (const s of m.scenarios.filter((s) => s.phase === "P3-holdout")) {
    assert.equal(s.holdout.is_holdout, true);
    assert.equal(s.holdout.access_class, "sealed-holdout");
    assert.equal(s.holdout.tuning_access_prohibited, true);
  }
});

test("evaluation/matrix-generator: non-P3 scenarios are not holdout", () => {
  const m = devMatrix();
  for (const s of m.scenarios.filter((s) => s.phase !== "P3-holdout")) {
    assert.equal(s.holdout.is_holdout, false);
  }
});

test("evaluation/matrix-generator: 8 conditions defined", () => {
  const m = devMatrix();
  assert.equal(m.conditions.length, 8);
});

test("evaluation/matrix-generator: conditions cover all 8 arms", () => {
  const m = devMatrix();
  const arms = new Set(m.conditions.map((c) => c.arm));
  assert.equal(arms.size, 8);
  assert.ok(arms.has("D0-direct"));
  assert.ok(arms.has("R1-reference"));
  assert.ok(arms.has("N1-noop"));
  for (const arm of ["A1", "A2", "A3", "A4", "A5"] as const) {
    assert.ok(arms.has(arm as ConditionArm), `missing arm ${arm}`);
  }
});

test("evaluation/matrix-generator: D0-direct has 0 agents", () => {
  const m = devMatrix();
  const d0 = m.conditions.find((c) => c.arm === "D0-direct")!;
  assert.equal(d0.topology.agent_count, 0);
  assert.equal(d0.topology.roles.length, 0);
  assert.equal(d0.topology.communication_graph, "none");
});

test("evaluation/matrix-generator: A1-A5 topologies have correct agent and role counts", () => {
  const m = devMatrix();
  for (const arm of ["A1", "A2", "A3", "A4", "A5"] as const) {
    const count = parseInt(arm.slice(1));
    const cond = m.conditions.find((c) => c.arm === arm)!;
    assert.equal(cond.topology.agent_count, count, `${arm} agent_count mismatch`);
    assert.equal(cond.topology.roles.length, count, `${arm} roles length mismatch`);
  }
});

test("evaluation/matrix-generator: R1-reference uses reference-1.0 harness version", () => {
  const m = devMatrix();
  const r1 = m.conditions.find((c) => c.arm === "R1-reference")!;
  assert.equal(r1.harness_version, "reference-1.0");
});

test("evaluation/matrix-generator: non-R1 conditions use candidate-v0", () => {
  const m = devMatrix();
  for (const c of m.conditions.filter((c) => c.arm !== "R1-reference")) {
    assert.equal(c.harness_version, "candidate-v0");
  }
});

test("evaluation/matrix-generator: all conditions have model_specific_branching=false", () => {
  const m = devMatrix();
  for (const c of m.conditions) {
    assert.equal(c.model_specific_branching, false);
  }
});

test("evaluation/matrix-generator: all conditions have adaptive_assignment=false", () => {
  const m = devMatrix();
  for (const c of m.conditions) {
    assert.equal(c.adaptive_assignment, false);
  }
});

test("evaluation/matrix-generator: deterministic_orchestrator=true for all", () => {
  const m = devMatrix();
  for (const c of m.conditions) {
    assert.equal(c.topology.deterministic_orchestrator, true);
    assert.equal(c.topology.model_backed_orchestrator, false);
  }
});

test("evaluation/matrix-generator: at least 1 budget policy", () => {
  const m = devMatrix();
  assert.ok(m.budget_policies.length >= 1);
});

test("evaluation/matrix-generator: at least 1 fault profile", () => {
  const m = devMatrix();
  assert.ok(m.fault_profiles.length >= 1);
});

test("evaluation/matrix-generator: natural-no-injection fault profile has 0 events", () => {
  const m = devMatrix();
  const natural = m.fault_profiles.find((f) => f.profile_kind === "natural-no-injection");
  assert.ok(natural !== undefined);
  assert.equal(natural.events.length, 0);
});

test("evaluation/matrix-generator: budget policies have content_hash", () => {
  const m = devMatrix();
  for (const bp of m.budget_policies) {
    assert.match(bp.content_hash, /^[0-9a-f]{64}$/);
    const { content_hash, ...rest } = bp;
    assert.equal(canonicalHash(rest), content_hash, "budget policy content_hash mismatch");
  }
});

test("evaluation/matrix-generator: fault profiles have content_hash", () => {
  const m = devMatrix();
  for (const fp of m.fault_profiles) {
    assert.match(fp.content_hash, /^[0-9a-f]{64}$/);
    const { content_hash, ...rest } = fp;
    assert.equal(canonicalHash(rest), content_hash, "fault profile content_hash mismatch");
  }
});

test("evaluation/matrix-generator: conditions have content_hash", () => {
  const m = devMatrix();
  for (const c of m.conditions) {
    assert.match(c.content_hash, /^[0-9a-f]{64}$/);
    const { content_hash, ...rest } = c;
    assert.equal(canonicalHash(rest), content_hash, `condition ${c.condition_id} content_hash mismatch`);
  }
});

test("evaluation/matrix-generator: scenarios have content_hash", () => {
  const m = devMatrix();
  for (const s of m.scenarios) {
    assert.match(s.content_hash, /^[0-9a-f]{64}$/);
    const { content_hash, ...rest } = s;
    assert.equal(canonicalHash(rest), content_hash, `scenario ${s.scenario_id} content_hash mismatch`);
  }
});

test("evaluation/matrix-generator: tests have content_hash", () => {
  const m = devMatrix();
  for (const t of m.tests) {
    assert.match(t.content_hash, /^[0-9a-f]{64}$/);
    const { content_hash, ...rest } = t;
    assert.equal(canonicalHash(rest), content_hash, `test ${t.test_id} content_hash mismatch`);
  }
});

test("evaluation/matrix-generator: cells have content_hash", () => {
  const m = devMatrix();
  for (const c of m.cells) {
    assert.match(c.content_hash, /^[0-9a-f]{64}$/);
    const { content_hash, ...rest } = c;
    assert.equal(canonicalHash(rest), content_hash, `cell ${c.cell_id} content_hash mismatch`);
  }
});

test("evaluation/matrix-generator: prompt variants have content_hash", () => {
  const m = devMatrix();
  for (const pv of m.prompt_variants) {
    assert.match(pv.content_hash, /^[0-9a-f]{64}$/);
    const { content_hash, ...rest } = pv;
    assert.equal(canonicalHash(rest), content_hash, `prompt variant ${pv.prompt_variant_id} content_hash mismatch`);
  }
});

test("evaluation/matrix-generator: all cells have temperature 0", () => {
  const m = devMatrix();
  for (const c of m.cells) {
    assert.equal(c.temperature, 0);
  }
});

test("evaluation/matrix-generator: all tests have temperature 0", () => {
  const m = devMatrix();
  for (const t of m.tests) {
    assert.equal(t.temperature, 0);
  }
});

test("evaluation/matrix-generator: each cell has exactly 3 runs", () => {
  const m = devMatrix();
  for (const c of m.cells) {
    assert.equal(c.runs.length, 3);
    assert.equal(c.runs[0]!.replicate, 1);
    assert.equal(c.runs[1]!.replicate, 2);
    assert.equal(c.runs[2]!.replicate, 3);
  }
});

test("evaluation/matrix-generator: all runs have status planned", () => {
  const m = devMatrix();
  for (const c of m.cells) {
    for (const r of c.runs) {
      assert.equal(r.status, "planned");
    }
  }
});

test("evaluation/matrix-generator: all runs have fresh_execution", () => {
  const m = devMatrix();
  for (const c of m.cells) {
    for (const r of c.runs) {
      assert.equal(r.fresh_execution.fresh_request, true);
      assert.equal(r.fresh_execution.response_cache_disabled, true);
      assert.equal(r.fresh_execution.clean_state_verified, true);
    }
  }
});

test("evaluation/matrix-generator: each test has both model cells", () => {
  const m = devMatrix();
  for (const t of m.tests) {
    const cells = m.cells.filter((c) => c.test_id === t.test_id);
    assert.equal(cells.length, 2, `test ${t.test_id} has ${cells.length} cells`);
    const models = new Set(cells.map((c) => c.model_id));
    assert.ok(models.has("google/gemma-4-26B-A4B"));
    assert.ok(models.has("zai-org/GLM-5.2-NVFP4"));
  }
});

test("evaluation/matrix-generator: each scored scenario has 3 tests", () => {
  const m = devMatrix();
  const scoredScenarios = m.scenarios.filter((s) => s.scored);
  for (const s of scoredScenarios) {
    const tests = m.tests.filter((t) => t.scenario_id === s.scenario_id);
    assert.equal(tests.length, 3, `scenario ${s.scenario_id} has ${tests.length} tests`);
  }
});

test("evaluation/matrix-generator: P0 scenarios have 0 tests", () => {
  const m = devMatrix();
  const p0Scenarios = m.scenarios.filter((s) => s.phase === "P0-shakedown");
  for (const s of p0Scenarios) {
    const tests = m.tests.filter((t) => t.scenario_id === s.scenario_id);
    assert.equal(tests.length, 0, `P0 scenario ${s.scenario_id} has ${tests.length} tests`);
  }
});

test("evaluation/matrix-generator: cell count = tests * models", () => {
  const m = devMatrix();
  assert.equal(m.cells.length, m.tests.length * 2);
});

test("evaluation/matrix-generator: run count = cells * 3", () => {
  const m = devMatrix();
  const totalRuns = m.cells.reduce((sum, c) => sum + c.runs.length, 0);
  assert.equal(totalRuns, m.cells.length * 3);
});

test("evaluation/matrix-generator: all scenario project refs resolve", () => {
  const m = devMatrix();
  const projectIds = new Set(m.projects.map((p) => p.project_id));
  for (const s of m.scenarios) {
    assert.ok(projectIds.has(s.project_id), `scenario ${s.scenario_id} references unknown project ${s.project_id}`);
  }
});

test("evaluation/matrix-generator: all test scenario refs resolve", () => {
  const m = devMatrix();
  const scenarioIds = new Set(m.scenarios.map((s) => s.scenario_id));
  for (const t of m.tests) {
    assert.ok(scenarioIds.has(t.scenario_id), `test ${t.test_id} references unknown scenario ${t.scenario_id}`);
  }
});

test("evaluation/matrix-generator: all test condition refs resolve", () => {
  const m = devMatrix();
  const conditionIds = new Set(m.conditions.map((c) => c.condition_id));
  for (const t of m.tests) {
    assert.ok(conditionIds.has(t.condition_id), `test ${t.test_id} references unknown condition ${t.condition_id}`);
  }
});

test("evaluation/matrix-generator: all test budget refs resolve", () => {
  const m = devMatrix();
  const budgetIds = new Set(m.budget_policies.map((b) => b.budget_policy_id));
  for (const t of m.tests) {
    assert.ok(budgetIds.has(t.budget_policy_id), `test ${t.test_id} references unknown budget ${t.budget_policy_id}`);
  }
});

test("evaluation/matrix-generator: all test fault refs resolve", () => {
  const m = devMatrix();
  const faultIds = new Set(m.fault_profiles.map((f) => f.fault_profile_id));
  for (const t of m.tests) {
    assert.ok(faultIds.has(t.fault_profile_id), `test ${t.test_id} references unknown fault ${t.fault_profile_id}`);
  }
});

test("evaluation/matrix-generator: all cell test refs resolve", () => {
  const m = devMatrix();
  const testIds = new Set(m.tests.map((t) => t.test_id));
  for (const c of m.cells) {
    assert.ok(testIds.has(c.test_id), `cell ${c.cell_id} references unknown test ${c.test_id}`);
  }
});

test("evaluation/matrix-generator: all prompt variant scenario refs resolve", () => {
  const m = devMatrix();
  const scenarioIds = new Set(m.scenarios.map((s) => s.scenario_id));
  for (const pv of m.prompt_variants) {
    assert.ok(scenarioIds.has(pv.scenario_id), `prompt ${pv.prompt_variant_id} references unknown scenario ${pv.scenario_id}`);
  }
});

test("evaluation/matrix-generator: each scenario has a prompt variant", () => {
  const m = devMatrix();
  for (const s of m.scenarios) {
    const pvs = m.prompt_variants.filter((pv) => pv.scenario_id === s.scenario_id);
    assert.ok(pvs.length >= 1, `scenario ${s.scenario_id} has no prompt variants`);
  }
});

test("evaluation/matrix-generator: scenarios cover 8+ language families", () => {
  const m = devMatrix();
  const langs = new Set(m.scenarios.map((s) => s.taxonomy.language_family));
  assert.ok(langs.size >= 8, `only ${langs.size} languages: ${[...langs].join(", ")}`);
});

test("evaluation/matrix-generator: scenarios have valid difficulty bands", () => {
  const m = devMatrix();
  for (const s of m.scenarios) {
    assert.ok(["tiny", "small", "medium", "large", "highly_complex"].includes(s.difficulty.band));
  }
});

test("evaluation/matrix-generator: scenarios have 2+ human baselines", () => {
  const m = devMatrix();
  for (const s of m.scenarios) {
    assert.ok(s.difficulty.human_baselines.length >= 2);
  }
});

test("evaluation/matrix-generator: scenarios have 3 reviews", () => {
  const m = devMatrix();
  for (const s of m.scenarios) {
    assert.equal(s.reviews.length, 3);
  }
});

test("evaluation/matrix-generator: scenarios have verifier with 4+ controls", () => {
  const m = devMatrix();
  for (const s of m.scenarios) {
    assert.ok(s.verifier.controls.length >= 4);
  }
});

test("evaluation/matrix-generator: verifier has keyword_matching_primary=false", () => {
  const m = devMatrix();
  for (const s of m.scenarios) {
    assert.equal(s.verifier.keyword_matching_primary, false);
  }
});

test("evaluation/matrix-generator: verifier has functional_execution=true", () => {
  const m = devMatrix();
  for (const s of m.scenarios) {
    assert.equal(s.verifier.functional_execution, true);
  }
});

test("evaluation/matrix-generator: verifier has separate_inaccessible_verifier=true", () => {
  const m = devMatrix();
  for (const s of m.scenarios) {
    assert.equal(s.verifier.separate_inaccessible_verifier, true);
  }
});

test("evaluation/matrix-generator: endpoint profile has correct runtime target", () => {
  const m = devMatrix();
  assert.equal(m.endpoint_profile.runtime_target, "https://provider-not-configured.invalid/v1");
  assert.equal(m.endpoint_profile.adapter_protocol, "openai-compatible-v1");
  assert.equal(m.endpoint_profile.credentials_in_matrix, false);
  assert.equal(m.endpoint_profile.model_fallback_allowed, false);
});

test("evaluation/matrix-generator: generator has correct master seed", () => {
  const m = devMatrix();
  assert.equal(m.generator.master_seed_hex, "4825f13e3c194ca6dc53f8127d9000ed5658a202abe188058750c325f952da3d");
  assert.equal(m.generator.generator_version, "CHEP-GEN-1.0");
  assert.equal(m.generator.canonicalization, "RFC8785-JCS");
  assert.equal(m.generator.hash_algorithm, "SHA-256");
});

// prompt-registry F-PR-11: the matrix reports the identity of what a run
// SENDS — one user message, no system prompt, no role prompt, no tools — never
// a seed-derived placeholder that looked like a prompt identity.
test("evaluation/matrix-generator: prompt and tool-schema identities are those of what a run sends, never placeholders", () => {
  const m = devMatrix();
  assert.ok(m.conditions.length > 0);
  for (const condition of m.conditions) {
    assert.equal(condition.system_prompt_sha256, NO_PROMPT_SENT_SHA256, "no system prompt is sent");
    assert.equal(condition.system_prompt_sha256, sha256(""));
    assert.equal(condition.tool_schema_sha256, NO_TOOLS_SENT_SHA256, "no tools are sent");
    for (const role of condition.topology.roles) assert.equal(role.role_prompt_sha256, NO_PROMPT_SENT_SHA256, `${role.role_id} sends no prompt`);
  }
});

test("evaluation/matrix-generator: matrix_payload_sha256 is 64 hex chars", () => {
  const m = devMatrix();
  assert.match(m.matrix_payload_sha256, /^[0-9a-f]{64}$/);
});

test("evaluation/matrix-generator: generation is deterministic (same config → same matrix)", () => {
  const m1 = devMatrix();
  const m2 = devMatrix();
  assert.equal(m1.matrix_id, m2.matrix_id);
  assert.equal(m1.matrix_payload_sha256, m2.matrix_payload_sha256);
  assert.deepEqual(m1.scenarios.map((s) => s.scenario_id), m2.scenarios.map((s) => s.scenario_id));
});

test("evaluation/matrix-generator: different configs produce different matrices", () => {
  const m1 = devMatrix();
  const m2 = generateMatrix({
    ...createDevelopmentConfig(SEED_SCENARIOS, SEED_PROJECTS),
    createdAt: "2026-07-18T00:00:00.000Z",
  });
  assert.notEqual(m1.matrix_id, m2.matrix_id);
  assert.notEqual(m1.matrix_payload_sha256, m2.matrix_payload_sha256);
});

test("evaluation/matrix-generator: structural invariants pass on development matrix", () => {
  const m = devMatrix();
  const report = validateMatrix(m);
  const structuralInvariants = report.findings.filter((f) =>
    f.invariant !== "unique_scored_scenario_count"
  );
  const failed = structuralInvariants.filter((f) => !f.passed);
  assert.equal(failed.length, 0, `structural invariants failed: ${failed.map((f) => f.invariant).join(", ")}`);
});

test("evaluation/matrix-generator: unique_scored_scenario_count fails on dev (expected, only 10 scored)", () => {
  const m = devMatrix();
  const report = validateMatrix(m);
  const finding = report.findings.find((f) => f.invariant === "unique_scored_scenario_count")!;
  assert.equal(finding.passed, false, "dev matrix has fewer scored scenarios than target 1024");
});

test("evaluation/matrix-generator: development config has small phase counts", () => {
  const cfg = createDevelopmentConfig(SEED_SCENARIOS, SEED_PROJECTS);
  assert.equal(cfg.phaseCounts["P0-shakedown"], 3);
  assert.equal(cfg.phaseCounts["P1-baseline"], 5);
  assert.equal(cfg.phaseCounts["P2-development"], 3);
  assert.equal(cfg.phaseCounts["P3-holdout"], 2);
});

test("evaluation/matrix-generator: production config has canonical phase counts", () => {
  const cfg = createProductionConfig(SEED_SCENARIOS, SEED_PROJECTS);
  assert.equal(cfg.phaseCounts, CHEP_CANONICAL_PHASE_CONFIG);
  assert.equal(cfg.phaseCounts["P0-shakedown"], 64);
  assert.equal(cfg.phaseCounts["P1-baseline"], 512);
  assert.equal(cfg.phaseCounts["P2-development"], 256);
  assert.equal(cfg.phaseCounts["P3-holdout"], 256);
});

test("evaluation/matrix-generator: production config total scenarios = 1088", () => {
  const cfg = createProductionConfig(SEED_SCENARIOS, SEED_PROJECTS);
  const total = Object.values(cfg.phaseCounts).reduce((a, b) => a + b, 0);
  assert.equal(total, 1088);
});

test("evaluation/matrix-generator: production config scored scenarios = 1024", () => {
  const cfg = createProductionConfig(SEED_SCENARIOS, SEED_PROJECTS);
  const scored = cfg.phaseCounts["P1-baseline"] + cfg.phaseCounts["P2-development"] + cfg.phaseCounts["P3-holdout"];
  assert.equal(scored, CHEP_TARGET_SCORED_SCENARIOS);
});

test("evaluation/matrix-generator: production tests = 1024 * 3 = 3072", () => {
  const cfg = createProductionConfig(SEED_SCENARIOS, SEED_PROJECTS);
  const scored = cfg.phaseCounts["P1-baseline"] + cfg.phaseCounts["P2-development"] + cfg.phaseCounts["P3-holdout"];
  assert.equal(scored * 3, 3072);
});

test("evaluation/matrix-generator: production cells = 3072 * 2 = 6144", () => {
  const cfg = createProductionConfig(SEED_SCENARIOS, SEED_PROJECTS);
  const scored = cfg.phaseCounts["P1-baseline"] + cfg.phaseCounts["P2-development"] + cfg.phaseCounts["P3-holdout"];
  assert.equal(scored * 3 * 2, 6144);
});

test("evaluation/matrix-generator: production runs = 6144 * 3 = 18432", () => {
  const cfg = createProductionConfig(SEED_SCENARIOS, SEED_PROJECTS);
  const scored = cfg.phaseCounts["P1-baseline"] + cfg.phaseCounts["P2-development"] + cfg.phaseCounts["P3-holdout"];
  assert.equal(scored * 3 * 2 * 3, 18432);
});

test("evaluation/matrix-generator: run IDs are unique", () => {
  const m = devMatrix();
  const runIds: string[] = [];
  for (const c of m.cells) {
    for (const r of c.runs) {
      runIds.push(r.run_id);
    }
  }
  assert.equal(new Set(runIds).size, runIds.length);
});

test("evaluation/matrix-generator: all run IDs match run_ pattern", () => {
  const m = devMatrix();
  for (const c of m.cells) {
    for (const r of c.runs) {
      assert.match(r.run_id, /^run_[0-9a-f]{64}$/);
    }
  }
});

test("evaluation/matrix-generator: all cell IDs match cel_ pattern", () => {
  const m = devMatrix();
  for (const c of m.cells) {
    assert.match(c.cell_id, /^cel_[0-9a-f]{64}$/);
  }
});

test("evaluation/matrix-generator: all test IDs match tst_ pattern", () => {
  const m = devMatrix();
  for (const t of m.tests) {
    assert.match(t.test_id, /^tst_[0-9a-f]{64}$/);
  }
});

test("evaluation/matrix-generator: all condition IDs match cnd_ pattern", () => {
  const m = devMatrix();
  for (const c of m.conditions) {
    assert.match(c.condition_id, /^cnd_[0-9a-f]{64}$/);
  }
});

test("evaluation/matrix-generator: all budget policy IDs match bdg_ pattern", () => {
  const m = devMatrix();
  for (const b of m.budget_policies) {
    assert.match(b.budget_policy_id, /^bdg_[0-9a-f]{64}$/);
  }
});

test("evaluation/matrix-generator: all fault profile IDs match flt_ pattern", () => {
  const m = devMatrix();
  for (const f of m.fault_profiles) {
    assert.match(f.fault_profile_id, /^flt_[0-9a-f]{64}$/);
  }
});

test("evaluation/matrix-generator: all allocation stratum IDs match str_ pattern", () => {
  const m = devMatrix();
  for (const t of m.tests) {
    assert.match(t.allocation_stratum_id, /^str_[0-9a-f]{64}$/);
  }
});

test("evaluation/matrix-generator: all prompt variant IDs match prm_ pattern", () => {
  const m = devMatrix();
  for (const pv of m.prompt_variants) {
    assert.match(pv.prompt_variant_id, /^prm_[0-9a-f]{64}$/);
  }
});

test("evaluation/matrix-generator: all project IDs match prj_ pattern", () => {
  const m = devMatrix();
  for (const p of m.projects) {
    assert.match(p.project_id, /^prj_[0-9a-f]{64}$/);
  }
});

test("evaluation/matrix-generator: oracle_solution artifact is sealed-holdout", () => {
  const m = devMatrix();
  for (const s of m.scenarios) {
    assert.equal(s.task.oracle_solution.access_class, "sealed-holdout");
  }
});

test("evaluation/matrix-generator: snapshot network_default is deny", () => {
  const m = devMatrix();
  for (const s of m.scenarios) {
    assert.equal(s.snapshot.network_default, "deny");
  }
});

test("evaluation/matrix-generator: snapshot platform is linux/amd64", () => {
  const m = devMatrix();
  for (const s of m.scenarios) {
    assert.equal(s.snapshot.platform_os, "linux");
    assert.equal(s.snapshot.platform_arch, "amd64");
  }
});

test("evaluation/matrix-generator: each scenario has 1+ dependency lock artifact", () => {
  const m = devMatrix();
  for (const s of m.scenarios) {
    assert.ok(s.snapshot.dependency_lock_artifacts.length >= 1);
  }
});

test("evaluation/matrix-generator: each scenario has SBOM", () => {
  const m = devMatrix();
  for (const s of m.scenarios) {
    assert.ok(s.snapshot.sbom);
    assert.match(s.snapshot.sbom.sha256, /^[0-9a-f]{64}$/);
  }
});

test("evaluation/matrix-generator: task has oracle_author_independent=true", () => {
  const m = devMatrix();
  for (const s of m.scenarios) {
    assert.equal(s.task.oracle_author_independent, true);
  }
});

test("evaluation/matrix-generator: task has real_project_work=true", () => {
  const m = devMatrix();
  for (const s of m.scenarios) {
    assert.equal(s.task.real_project_work, true);
  }
});

test("evaluation/matrix-generator: task has post_resolution_leakage_removed=true", () => {
  const m = devMatrix();
  for (const s of m.scenarios) {
    assert.equal(s.task.post_resolution_leakage_removed, true);
  }
});

test("evaluation/matrix-generator: eligible_prompt_kinds has at least 1 kind", () => {
  const m = devMatrix();
  for (const s of m.scenarios) {
    assert.ok(s.eligible_prompt_kinds.length >= 1);
  }
});

test("evaluation/matrix-generator: all scenario phases match a valid phase name", () => {
  const m = devMatrix();
  for (const s of m.scenarios) {
    assert.ok(["P0-shakedown", "P1-baseline", "P2-development", "P3-holdout"].includes(s.phase));
  }
});

test("evaluation/matrix-generator: API seed support is unsupported-omitted", () => {
  const m = devMatrix();
  for (const c of m.cells) {
    assert.equal(c.api_seed_support, "unsupported-omitted");
    assert.equal(c.api_seed, undefined);
  }
});

test("evaluation/matrix-generator: retained_result_slot is true for all runs", () => {
  const m = devMatrix();
  for (const c of m.cells) {
    for (const r of c.runs) {
      assert.equal(r.retained_result_slot, true);
    }
  }
});

test("evaluation/matrix-generator: schedule keys are 64 hex chars", () => {
  const m = devMatrix();
  for (const c of m.cells) {
    for (const r of c.runs) {
      assert.match(r.schedule_key, /^[0-9a-f]{64}$/);
    }
  }
});

test("evaluation/matrix-generator: runtime_block_id matches blk_ pattern", () => {
  const m = devMatrix();
  for (const c of m.cells) {
    for (const r of c.runs) {
      assert.match(r.runtime_block_id, /^blk_[0-9a-f]{64}$/);
    }
  }
});
