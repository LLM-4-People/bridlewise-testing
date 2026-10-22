/**
 * THE GATE RATCHET (github-only §3.1, §5.3 c; D-GP-3 carried over) — CI
 * cannot be weakened by the change it judges. The door runs `main`'s code,
 * never the pull request's, and asks two questions of the tree:
 *
 *   1. Does the tree change the pipeline's OWNER (the gate catalogue and its
 *      generator, `GENERATOR_SOURCES`)? If NOT, every file under
 *      `.github/workflows/` must be byte-equal to what main's generator emits,
 *      and the folder must hold nothing else: a hand-edited workflow is
 *      refused (V-7), whatever it changes.
 *   2. If it DOES (a CI-changing tree), the tree's gate set — as its own CI
 *      plan reports it — must keep every gate main requires, still required:
 *      a gate may be added, never dropped or demoted to a signal. Weakening
 *      needs a decision record and the maintainer's ruleset edit (the
 *      break-glass path, audited), never a pull request. A CI-changing tree
 *      is also never reuse-eligible (§5.4): its receipt always runs cold.
 *
 * Pure: the door hands it the tree's files and main's generator output.
 */
import { deepFreeze } from "../../kernel/integrity.ts";
import { GENERATED_WORKFLOW_FILES } from "../../kernel/verification-paths.ts";
import type { Gate } from "../gates/catalogue.ts";


export type RatchetFinding = Readonly<{ rule: "workflow-hand-edit" | "workflow-foreign" | "workflow-missing" | "gate-dropped" | "gate-demoted"; path?: string; gate?: string; detail: string }>;

export type RatchetInputs = Readonly<{
  /** Whether the tree's generator sources differ from main's (the door compares their git object ids). */
  generatorChanged: boolean;
  /** The tree's workflow folder: every file name under `.github/workflows/` with its text. */
  treeWorkflows: ReadonlyMap<string, string>;
  /** Main's generator output for each generated file name (`workflowText`). */
  mainWorkflows: ReadonlyMap<string, string>;
  /** Main's catalogue (the door's own). */
  mainCatalogue: readonly Gate[];
  /** The tree's gates as its CI plan reports them. */
  treeGates: readonly Readonly<{ id: string; role: Gate["role"] }>[];
}>;

export type RatchetVerdict = Readonly<{ ciChanging: boolean; findings: readonly RatchetFinding[] }>;

export function judgeRatchet(inputs: RatchetInputs): RatchetVerdict {
  const findings: RatchetFinding[] = [];
  if (!inputs.generatorChanged) {
    for (const [name, text] of inputs.treeWorkflows) {
      const path = `${GENERATED_WORKFLOW_FILES.directory}/${name}`;
      const expected = inputs.mainWorkflows.get(name);
      if (expected === undefined) findings.push({ rule: "workflow-foreign", path, detail: "a workflow no generator owns (every workflow is generated from the gate catalogue)" });
      else if (text !== expected) findings.push({ rule: "workflow-hand-edit", path, detail: "differs from main's generator output while the catalogue and generator are unchanged: a hand edit (edit engine/src/workflow/gates/ and run harness sync)" });
    }
    for (const name of inputs.mainWorkflows.keys()) {
      if (!inputs.treeWorkflows.has(name)) findings.push({ rule: "workflow-missing", path: `${GENERATED_WORKFLOW_FILES.directory}/${name}`, detail: "a generated workflow the tree deleted" });
    }
  }
  const treeRoles = new Map(inputs.treeGates.map((gate) => [gate.id, gate.role]));
  for (const gate of inputs.mainCatalogue.filter((entry) => entry.role === "required")) {
    const role = treeRoles.get(gate.id);
    if (role === undefined) findings.push({ rule: "gate-dropped", gate: gate.id, detail: `main requires ${gate.id} and the tree's plan drops it (weakening needs a decision record and the maintainer's ruleset edit)` });
    else if (role !== "required") findings.push({ rule: "gate-demoted", gate: gate.id, detail: `main requires ${gate.id} and the tree demotes it to ${role}` });
  }
  return deepFreeze({ ciChanging: inputs.generatorChanged, findings });
}
