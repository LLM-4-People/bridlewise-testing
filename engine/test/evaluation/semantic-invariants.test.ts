import assert from "node:assert/strict";
import test from "node:test";

import { validateMatrix } from "../../src/evaluation/semantic-validators.ts";
import type { MatrixDocument } from "../../src/evaluation/types.ts";
import { devMatrix } from "../support/matrix.ts";

test("evaluation/semantic-validators: validates a clean development matrix (structural invariants pass)", () => {
  const m = devMatrix();
  const report = validateMatrix(m);
  const structuralInvariants = report.findings.filter((f) =>
    f.invariant !== "unique_scored_scenario_count"
  );
  assert.ok(structuralInvariants.every((f) => f.passed));
});

test("evaluation/semantic-validators: report has findings for all invariants", () => {
  const m = devMatrix();
  const report = validateMatrix(m);
  const invariantNames = report.findings.map((f) => f.invariant);
  assert.ok(invariantNames.includes("exact_models_only"));
  assert.ok(invariantNames.includes("numeric_temperature_zero_everywhere"));
  assert.ok(invariantNames.includes("exactly_three_runs_per_model_test_cell"));
  assert.ok(invariantNames.includes("complete_two_model_cross_for_every_test"));
  assert.ok(invariantNames.includes("unique_ids_and_referential_integrity"));
  assert.ok(invariantNames.includes("all_content_ids_recompute"));
  assert.ok(invariantNames.includes("phase_counts_match"));
  assert.ok(invariantNames.includes("no_holdout_identity_in_earlier_phases"));
  assert.ok(invariantNames.includes("no_model_specific_harness_branching"));
  assert.ok(invariantNames.includes("no_adaptive_treatment_assignment"));
  assert.ok(invariantNames.includes("topology_role_count_matches_agent_count"));
  assert.ok(invariantNames.includes("at_least_eight_language_families"));
  assert.ok(invariantNames.includes("prompt_references_match_scenarios"));
  assert.ok(invariantNames.includes("condition_budget_fault_references_resolve"));
  assert.ok(invariantNames.includes("run_ids_and_schedule_keys_recompute"));
  assert.ok(invariantNames.includes("same_cell_api_seed_across_three_runs"));
  assert.ok(invariantNames.includes("no_selective_retained_fourth_run"));
});

test("evaluation/semantic-validators: exact_models_only passes on valid matrix", () => {
  const m = devMatrix();
  const report = validateMatrix(m);
  const finding = report.findings.find((f) => f.invariant === "exact_models_only")!;
  assert.ok(finding.passed);
});

test("evaluation/semantic-validators: detects wrong model count", () => {
  const m = devMatrix();
  const tampered: MatrixDocument = { ...m, models: ["google/gemma-4-26B-A4B", "wrong/model"] as unknown as MatrixDocument["models"] };
  const report = validateMatrix(tampered);
  const finding = report.findings.find((f) => f.invariant === "exact_models_only")!;
  assert.equal(finding.passed, false);
});

test("evaluation/semantic-validators: detects non-zero temperature in sampling", () => {
  const m = devMatrix();
  const tampered: MatrixDocument = {
    ...m,
    sampling: { ...m.sampling, temperature: 0.1 as unknown as 0 },
  };
  const report = validateMatrix(tampered);
  const finding = report.findings.find((f) => f.invariant === "numeric_temperature_zero_everywhere")!;
  assert.equal(finding.passed, false);
});

test("evaluation/semantic-validators: detects non-zero temperature in cell", () => {
  const m = devMatrix();
  const tampered: MatrixDocument = {
    ...m,
    cells: m.cells.map((c, i) => i === 0 ? { ...c, temperature: 1 as unknown as 0 } : c),
  };
  const report = validateMatrix(tampered);
  const finding = report.findings.find((f) => f.invariant === "numeric_temperature_zero_everywhere")!;
  assert.equal(finding.passed, false);
});

test("evaluation/semantic-validators: detects wrong run count", () => {
  const m = devMatrix();
  const tampered: MatrixDocument = {
    ...m,
    cells: m.cells.map((c, i) => i === 0 ? { ...c, runs: c.runs.slice(0, 2) as unknown as typeof c.runs } : c),
  };
  const report = validateMatrix(tampered);
  const finding = report.findings.find((f) => f.invariant === "exactly_three_runs_per_model_test_cell")!;
  assert.equal(finding.passed, false);
});

test("evaluation/semantic-validators: detects missing model cross", () => {
  const m = devMatrix();
  const tampered: MatrixDocument = {
    ...m,
    cells: m.cells.slice(0, m.cells.length - 1),
  };
  const report = validateMatrix(tampered);
  const finding = report.findings.find((f) => f.invariant === "complete_two_model_cross_for_every_test")!;
  assert.equal(finding.passed, false);
});

test("evaluation/semantic-validators: detects broken referential integrity (scenario)", () => {
  const m = devMatrix();
  const tampered: MatrixDocument = {
    ...m,
    tests: m.tests.map((t, i) => i === 0 ? { ...t, scenario_id: "scn_nonexistent" } : t),
  };
  const report = validateMatrix(tampered);
  const finding = report.findings.find((f) => f.invariant === "unique_ids_and_referential_integrity")!;
  assert.equal(finding.passed, false);
});

test("evaluation/semantic-validators: detects broken referential integrity (condition)", () => {
  const m = devMatrix();
  const tampered: MatrixDocument = {
    ...m,
    tests: m.tests.map((t, i) => i === 0 ? { ...t, condition_id: "cnd_nonexistent" } : t),
  };
  const report = validateMatrix(tampered);
  const finding = report.findings.find((f) => f.invariant === "unique_ids_and_referential_integrity")!;
  assert.equal(finding.passed, false);
});

test("evaluation/semantic-validators: detects broken content hash on scenario", () => {
  const m = devMatrix();
  const tampered: MatrixDocument = {
    ...m,
    scenarios: m.scenarios.map((s, i) => i === 0 ? { ...s, content_hash: "0".repeat(64) } : s),
  };
  const report = validateMatrix(tampered);
  const finding = report.findings.find((f) => f.invariant === "all_content_ids_recompute")!;
  assert.equal(finding.passed, false);
});

test("evaluation/semantic-validators: detects broken content hash on test", () => {
  const m = devMatrix();
  const tampered: MatrixDocument = {
    ...m,
    tests: m.tests.map((t, i) => i === 0 ? { ...t, content_hash: "0".repeat(64) } : t),
  };
  const report = validateMatrix(tampered);
  const finding = report.findings.find((f) => f.invariant === "all_content_ids_recompute")!;
  assert.equal(finding.passed, false);
});

test("evaluation/semantic-validators: detects broken content hash on cell", () => {
  const m = devMatrix();
  const tampered: MatrixDocument = {
    ...m,
    cells: m.cells.map((c, i) => i === 0 ? { ...c, content_hash: "0".repeat(64) } : c),
  };
  const report = validateMatrix(tampered);
  const finding = report.findings.find((f) => f.invariant === "all_content_ids_recompute")!;
  assert.equal(finding.passed, false);
});

test("evaluation/semantic-validators: detects broken content hash on condition", () => {
  const m = devMatrix();
  const tampered: MatrixDocument = {
    ...m,
    conditions: m.conditions.map((c, i) => i === 0 ? { ...c, content_hash: "0".repeat(64) } : c),
  };
  const report = validateMatrix(tampered);
  const finding = report.findings.find((f) => f.invariant === "all_content_ids_recompute")!;
  assert.equal(finding.passed, false);
});

test("evaluation/semantic-validators: detects phase count mismatch", () => {
  const m = devMatrix();
  const tampered: MatrixDocument = {
    ...m,
    phases: m.phases.map((p, i) => i === 0 ? { ...p, unique_scenario_count: 999 } : p) as unknown as MatrixDocument["phases"],
  };
  const report = validateMatrix(tampered);
  const finding = report.findings.find((f) => f.invariant === "phase_counts_match")!;
  assert.equal(finding.passed, false);
});

test("evaluation/semantic-validators: detects holdout in non-P3 phase", () => {
  const m = devMatrix();
  const tampered: MatrixDocument = {
    ...m,
    scenarios: m.scenarios.map((s) =>
      s.phase === "P1-baseline" ? { ...s, holdout: { ...s.holdout, is_holdout: true } } : s
    ),
  };
  const report = validateMatrix(tampered);
  const finding = report.findings.find((f) => f.invariant === "no_holdout_identity_in_earlier_phases")!;
  assert.equal(finding.passed, false);
});

test("evaluation/semantic-validators: detects model_specific_branching=true", () => {
  const m = devMatrix();
  const tampered: MatrixDocument = {
    ...m,
    conditions: m.conditions.map((c, i) => i === 0 ? { ...c, model_specific_branching: true as unknown as false } : c),
  };
  const report = validateMatrix(tampered);
  const finding = report.findings.find((f) => f.invariant === "no_model_specific_harness_branching")!;
  assert.equal(finding.passed, false);
});

test("evaluation/semantic-validators: detects adaptive_assignment=true", () => {
  const m = devMatrix();
  const tampered: MatrixDocument = {
    ...m,
    conditions: m.conditions.map((c, i) => i === 0 ? { ...c, adaptive_assignment: true as unknown as false } : c),
  };
  const report = validateMatrix(tampered);
  const finding = report.findings.find((f) => f.invariant === "no_adaptive_treatment_assignment")!;
  assert.equal(finding.passed, false);
});

test("evaluation/semantic-validators: detects topology role count mismatch", () => {
  const m = devMatrix();
  const tampered: MatrixDocument = {
    ...m,
    conditions: m.conditions.map((c, i) =>
      i === 3 ? { ...c, topology: { ...c.topology, agent_count: 5 } } : c
    ),
  };
  const report = validateMatrix(tampered);
  const finding = report.findings.find((f) => f.invariant === "topology_role_count_matches_agent_count")!;
  assert.equal(finding.passed, false);
});

test("evaluation/semantic-validators: detects fewer than 8 language families", () => {
  const m = devMatrix();
  const tampered: MatrixDocument = {
    ...m,
    scenarios: m.scenarios.map((s) => ({ ...s, taxonomy: { ...s.taxonomy, language_family: "TypeScript" } })),
  };
  const report = validateMatrix(tampered);
  const finding = report.findings.find((f) => f.invariant === "at_least_eight_language_families")!;
  assert.equal(finding.passed, false);
});

test("evaluation/semantic-validators: detects broken prompt variant scenario ref", () => {
  const m = devMatrix();
  const tampered: MatrixDocument = {
    ...m,
    prompt_variants: m.prompt_variants.map((pv, i) => i === 0 ? { ...pv, scenario_id: "scn_nonexistent" } : pv),
  };
  const report = validateMatrix(tampered);
  const finding = report.findings.find((f) => f.invariant === "prompt_references_match_scenarios")!;
  assert.equal(finding.passed, false);
});

test("evaluation/semantic-validators: detects broken condition budget ref", () => {
  const m = devMatrix();
  const tampered: MatrixDocument = {
    ...m,
    conditions: m.conditions.map((c, i) => i === 0 ? { ...c, budget_policy_id: "bdg_nonexistent" } : c),
  };
  const report = validateMatrix(tampered);
  const finding = report.findings.find((f) => f.invariant === "condition_budget_fault_references_resolve")!;
  assert.equal(finding.passed, false);
});

test("evaluation/semantic-validators: detects broken condition fault ref", () => {
  const m = devMatrix();
  const tampered: MatrixDocument = {
    ...m,
    conditions: m.conditions.map((c, i) => i === 0 ? { ...c, fault_profile_id: "flt_nonexistent" } : c),
  };
  const report = validateMatrix(tampered);
  const finding = report.findings.find((f) => f.invariant === "condition_budget_fault_references_resolve")!;
  assert.equal(finding.passed, false);
});

test("evaluation/semantic-validators: detects duplicate run IDs", () => {
  const m = devMatrix();
  const firstRunId = m.cells[0]!.runs[0]!.run_id;
  const tampered: MatrixDocument = {
    ...m,
    cells: m.cells.map((c, i) =>
      i === 1 ? { ...c, runs: c.runs.map((r, j) => j === 0 ? { ...r, run_id: firstRunId } : r) as unknown as typeof c.runs } : c
    ) as MatrixDocument["cells"],
  };
  const report = validateMatrix(tampered);
  const finding = report.findings.find((f) => f.invariant === "run_ids_and_schedule_keys_recompute")!;
  assert.equal(finding.passed, false);
});

test("evaluation/semantic-validators: report includes timestamp", () => {
  const m = devMatrix();
  const report = validateMatrix(m);
  assert.ok(report.timestamp.length > 0);
});

test("evaluation/semantic-validators: each finding has invariant, passed, and detail", () => {
  const m = devMatrix();
  const report = validateMatrix(m);
  for (const f of report.findings) {
    assert.ok(typeof f.invariant === "string" && f.invariant.length > 0);
    assert.ok(typeof f.passed === "boolean");
    assert.ok(typeof f.detail === "string");
  }
});
