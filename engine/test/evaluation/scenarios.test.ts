import assert from "node:assert/strict";
import test from "node:test";

import { SEED_SCENARIOS, SEED_PROJECTS, SEED_SCENARIO_COUNT } from "../../src/evaluation/scenarios.ts";
import { CHEP_MODELS } from "../../src/evaluation/types.ts";

test("evaluation/scenarios: exports at least 10 seed scenarios", () => {
  assert.ok(SEED_SCENARIOS.length >= 10, `expected >= 10 scenarios, got ${SEED_SCENARIOS.length}`);
  assert.equal(SEED_SCENARIO_COUNT, SEED_SCENARIOS.length);
});

test("evaluation/scenarios: all scenario IDs are unique", () => {
  const ids = SEED_SCENARIOS.map((s) => s.scenarioId);
  const unique = new Set(ids);
  assert.equal(unique.size, ids.length, "duplicate scenario IDs found");
});

test("evaluation/scenarios: all scenario IDs match scn_ pattern", () => {
  for (const s of SEED_SCENARIOS) {
    assert.match(s.scenarioId, /^scn_[0-9a-f]{64}$/, `invalid scenario ID: ${s.scenarioId}`);
  }
});

test("evaluation/scenarios: all project references resolve", () => {
  const projectIds = new Set(SEED_PROJECTS.map((p) => p.projectId));
  for (const s of SEED_SCENARIOS) {
    assert.ok(projectIds.has(s.projectRef), `scenario ${s.scenarioId} references unknown project ${s.projectRef}`);
  }
});

test("evaluation/scenarios: at least 3 simple (tiny) scenarios", () => {
  const tiny = SEED_SCENARIOS.filter((s) => s.difficulty === "tiny");
  assert.ok(tiny.length >= 3, `expected >= 3 tiny, got ${tiny.length}`);
});

test("evaluation/scenarios: at least 3 small scenarios", () => {
  const small = SEED_SCENARIOS.filter((s) => s.difficulty === "small");
  assert.ok(small.length >= 3, `expected >= 3 small, got ${small.length}`);
});

test("evaluation/scenarios: at least 2 medium scenarios", () => {
  const medium = SEED_SCENARIOS.filter((s) => s.difficulty === "medium");
  assert.ok(medium.length >= 2, `expected >= 2 medium, got ${medium.length}`);
});

test("evaluation/scenarios: at least 2 large or highly_complex scenarios", () => {
  const large = SEED_SCENARIOS.filter((s) => s.difficulty === "large" || s.difficulty === "highly_complex");
  assert.ok(large.length >= 2, `expected >= 2 large+, got ${large.length}`);
});

test("evaluation/scenarios: covers at least 8 language families", () => {
  const langs = new Set(SEED_SCENARIOS.map((s) => s.languageFamily));
  assert.ok(langs.size >= 8, `expected >= 8 language families, got ${langs.size}: ${[...langs].join(", ")}`);
});

test("evaluation/scenarios: covers diverse task families", () => {
  const families = new Set(SEED_SCENARIOS.map((s) => s.taskFamily));
  assert.ok(families.size >= 4, `expected >= 4 task families, got ${families.size}`);
});

test("evaluation/scenarios: all scenarios have prompt variants", () => {
  for (const s of SEED_SCENARIOS) {
    assert.ok(s.promptVariants.original.length > 0, `scenario ${s.scenarioId} has empty original prompt`);
    assert.ok(s.promptVariants.normalized.length > 0);
    assert.ok(s.promptVariants.paraphrase.length > 0);
  }
});

test("evaluation/scenarios: all scenarios have expected outputs", () => {
  for (const s of SEED_SCENARIOS) {
    assert.ok(s.expectedOutputs.length > 0, `scenario ${s.scenarioId} has empty expectedOutputs`);
  }
});

test("evaluation/scenarios: all scenarios have hidden oracles", () => {
  for (const s of SEED_SCENARIOS) {
    assert.ok(s.hiddenOracles.length > 0, `scenario ${s.scenarioId} has no hidden oracles`);
  }
});

test("evaluation/scenarios: all scenarios have agent fields", () => {
  for (const s of SEED_SCENARIOS) {
    assert.ok(s.agentFields.length > 0, `scenario ${s.scenarioId} has no agent fields`);
  }
});

test("evaluation/scenarios: at least 8 projects defined", () => {
  assert.ok(SEED_PROJECTS.length >= 8, `expected >= 8 projects, got ${SEED_PROJECTS.length}`);
});

test("evaluation/scenarios: all project IDs match prj_ pattern", () => {
  for (const p of SEED_PROJECTS) {
    assert.match(p.projectId, /^prj_[0-9a-f]{64}$/, `invalid project ID: ${p.projectId}`);
  }
});

test("evaluation/scenarios: all projects have OSI-approved license basis", () => {
  for (const p of SEED_PROJECTS) {
    assert.equal(p.licenseBasis, "OSI-approved", `project ${p.displayName} has non-OSI license basis: ${p.licenseBasis}`);
  }
});

test("evaluation/scenarios: project display names are unique", () => {
  const names = SEED_PROJECTS.map((p) => p.displayName);
  const unique = new Set(names);
  assert.equal(unique.size, names.length, "duplicate project display names");
});

test("evaluation/scenarios: all projects have content hash", () => {
  for (const p of SEED_PROJECTS) {
    assert.match(p.contentHash, /^[0-9a-f]{64}$/, `project ${p.displayName} has invalid content hash`);
  }
});

test("evaluation/scenarios: models are exactly the CHEP-1.0 pair", () => {
  assert.equal(CHEP_MODELS.length, 2);
  assert.equal(CHEP_MODELS[0], "google/gemma-4-26B-A4B");
  assert.equal(CHEP_MODELS[1], "zai-org/GLM-5.2-NVFP4");
});

test("evaluation/scenarios: all scenarios have valid difficulty and positive LOC counts", () => {
  for (let i = 0; i < SEED_SCENARIOS.length; i++) {
    const scenario = SEED_SCENARIOS[i]!;
    assert.ok(["tiny", "small", "medium", "large", "highly_complex"].includes(scenario.difficulty),
      `scenario ${i} has invalid difficulty: ${scenario.difficulty}`);
    assert.ok(scenario.repositorySizeLoc > 0, `scenario ${i} has non-positive LOC`);
    assert.ok(scenario.repositoryFileCount > 0, `scenario ${i} has non-positive file count`);
    assert.ok(scenario.estimatedComponentsTouched > 0, `scenario ${i} has non-positive components`);
  }
});
