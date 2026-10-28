/**
 * THE PROJECTOR'S SCENARIOS ON THE PROVING GROUND (runbook P5; V-25, V-28):
 * the real projector — `computeProjection` confined by the guardian, then
 * `applyProjection` through the GitHub store — on the proving ground, as the
 * publisher App (the one author whose issues the store trusts). The input is
 * a FIXTURE board, not this repository's tracker: its objects carry the
 * `PG25-`/`PG28-` ids and their own lanes, so the two scenarios never touch
 * each other's objects (each sees the other's as orphans, which a run only
 * reports). Reruns are expected: the proving ground keeps the objects.
 *
 * - V-25 (idempotent): one run brings the proving ground to D (verified); a
 *   second run of the same D writes nothing and is verified.
 * - V-28 (a silent drop is caught): one Task issue whose `type` the run writes
 *   under a publisher token WITHOUT push access (`issues: write`,
 *   `metadata: read`), the case where GitHub accepts an issue's type and
 *   drops it; the run's re-read must fail `projection_unverified` naming
 *   `issue/PG28-PROBE.type`. With the full publisher token GitHub keeps the
 *   type (the type is enabled and the publisher has push), so V-28 runs on
 *   the narrowed one; whether GitHub drops it there is what the first live
 *   run settles, and a kept type is V-28's typed fail, never a pass.
 *
 * Each scenario returns its verdict (`../proving-ground-api.ts`, tested
 * offline); `run.ts` prints it. No offline test loads this folder.
 */
import { join } from "node:path";

import { TRACKER_BOARD } from "../../../src/kernel/verification-paths.ts";
import { configuredForge } from "../../../src/workflow/forge/configured-forge.ts";
import { applyProjection, type ProjectionReceipt } from "../../../src/workflow/forge/projector/apply.ts";
import { hostConfinement } from "../../../src/workflow/forge/projector/confined.ts";
import { githubProjectionStore } from "../../../src/workflow/forge/projector/github-store.ts";
import { laneLabel, PROJECTION_INPUT_SCHEMA, type InputItem, type ProjectionInput } from "../../../src/workflow/forge/projector/model.ts";
import { computeProjection } from "../../../src/workflow/forge/projector/projection.ts";
import { v25Verdict, v28Verdict, type ProvingGround, type Verdict } from "../proving-ground-api.ts";

const ENGINE_ROOT = join(import.meta.dirname, "..", "..", "..");
/** The fixture board's source identity (a fixture, not a commit of this repository): the same D on every run. */
const FIXTURE_SOURCE = "5eed".repeat(10);
/** The most writes one scenario run makes; the fixture needs far fewer. */
const ALLOWANCE = 50;
/** The field V-28 expects GitHub to drop. */
export const V28_CANDIDATE = "issue/PG28-PROBE.type";

const item = (id: string, lane: string, overrides: Partial<InputItem> = {}): InputItem => ({
  id, type: "Task", title: `Proving ground: ${id}`, state: "open", resolution: null, lane, milestone: null, parent: null, blockedBy: [], decisions: [], tests: [], evidence: null,
  body: `The projector's proving-ground fixture item ${id}.`, path: `${TRACKER_BOARD.items}/${id}.md`, ...overrides,
});

function fixtureInput(ground: ProvingGround, lane: string, items: readonly InputItem[]): ProjectionInput {
  return {
    schema: PROJECTION_INPUT_SCHEMA, source: FIXTURE_SOURCE, ledger: null, repositoryUrl: `${ground.webUrl}/${ground.owner}/${ground.name}`,
    items, lanes: [{ lane, color: "5319e7", description: `Proving-ground fixture lane ${lane}` }], decisions: [], recordedEvidence: [], mainRuns: [],
  };
}

/** One projector run of `input` on the proving ground (`previous`: the foreign-edit baseline, `null` for none). */
async function projectOnce(ground: ProvingGround, input: ProjectionInput, previous: ProjectionReceipt | null): Promise<ProjectionReceipt> {
  const { projection } = computeProjection(input, hostConfinement(ENGINE_ROOT));
  const store = githubProjectionStore(ground.client, { repository: `${ground.owner}/${ground.name}`, maxPages: configuredForge().request.maxPages });
  return applyProjection(projection, store, { allowance: ALLOWANCE, previous, foreignEdit: "auto" });
}

/** The proving ground's issues of one fixture lane: the evidence a verdict links. */
function laneEvidence(ground: ProvingGround, lane: string): string {
  return `${ground.webUrl}/${ground.owner}/${ground.name}/issues?q=${encodeURIComponent(`is:issue label:"${laneLabel(lane)}"`)}`;
}

export async function v25(ground: ProvingGround): Promise<Verdict> {
  const lane = "proving-v25";
  const input = fixtureInput(ground, lane, [
    item("PG25-M", lane, { type: "Milestone", title: "Proving ground: the V-25 milestone", state: null, lane: null }),
    item("PG25-WS", lane, { type: "Workstream", milestone: "PG25-M" }),
    item("PG25-T1", lane, { milestone: "PG25-M", parent: "PG25-WS", blockedBy: ["PG25-T2"] }),
    item("PG25-T2", lane, { milestone: "PG25-M", parent: "PG25-WS", state: "closed", resolution: "completed" }),
  ]);
  const first = await projectOnce(ground, input, null);
  const second = await projectOnce(ground, input, first);
  return v25Verdict({ first, second }, [laneEvidence(ground, lane)]);
}

export async function v28(ground: ProvingGround): Promise<Verdict> {
  const lane = "proving-v28";
  const input = fixtureInput(ground, lane, [item("PG28-PROBE", lane)]);
  // No baseline: each run judges GitHub against D afresh, so a rerun writes the dropped type again and catches the drop again.
  const receipt = await projectOnce(ground, input, null);
  return v28Verdict({ receipt, candidate: V28_CANDIDATE }, [laneEvidence(ground, lane)]);
}
