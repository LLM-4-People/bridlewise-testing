/**
 * THE SEAL — every cell's result merged into ONE receipt
 * (`bridlewise-gate-receipt/v1`), with the refusals the old shard merge made
 * (`scripts/test-shard-merge.mjs`) moved into the gates owner:
 *
 *   - a planned cell with no result (missing), two results for one cell
 *     (duplicate), a result for no planned cell (unexpected);
 *   - a result for another commit, tree or catalogue (wrong-commit);
 *   - a failed or refused cell;
 *   - a shard whose files are not exactly its planned files, and a population
 *     whose shards do not cover it exactly once;
 *   - an action gate whose job did not succeed on an event it runs on, or ran
 *     on one it does not.
 *
 * The verdict is `passed` only when every REQUIRED gate passed and nothing
 * was refused; a `signal` gate's outcome is recorded and shown, never judged.
 * The receipt names every population exclusion with its reason, so an
 * excluded file is visible on every verdict.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { InputError } from "../../kernel/errors.ts";
import { canonicalHash, deepFreeze } from "../../kernel/integrity.ts";
import { schemaId } from "../../kernel/product-identity.ts";
import { GATE_CATALOGUE, type Gate } from "./catalogue.ts";
import type { GatePlan } from "./plan.ts";
import { GATE_RESULT_SCHEMA, type GateResult } from "./cell-run.ts";

export const GATE_RECEIPT_SCHEMA = schemaId("gate-receipt", 1);

/** A job's outcome as GitHub reports it in `toJSON(needs)`. */
export type JobOutcome = "success" | "failure" | "cancelled" | "skipped";

export type GateVerdict = Readonly<{
  id: string;
  role: Gate["role"];
  status: "passed" | "failed" | "not-run" | "reused";
  cells: readonly Readonly<{ cell: string; status: "passed" | "failed" | "missing"; tests?: number; refusal?: string }>[];
}>;

export type GateReceipt = Readonly<{
  schemaVersion: typeof GATE_RECEIPT_SCHEMA;
  headSha: string;
  treeId: string;
  catalogueDigest: string;
  planDigest: string;
  event: string;
  verdict: "passed" | "failed";
  gates: readonly GateVerdict[];
  refusals: readonly string[];
  exclusions: readonly Readonly<{ population: string; path: string; reason: string; evidence: string }>[];
  tests: number;
}>;

/** Reads every `*.result.json` under `directory` (results of every job, merged into one folder). */
export function readResults(directory: string): readonly unknown[] {
  return readdirSync(directory, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".result.json"))
    .toSorted()
    .map((name) => {
      try {
        return JSON.parse(readFileSync(join(directory, name), "utf8")) as unknown;
      } catch {
        return { unreadable: name };
      }
    });
}

export type SealInputs = Readonly<{
  plan: GatePlan;
  results: readonly unknown[];
  /** The CI jobs' outcomes (`toJSON(needs)`), for the action gates. */
  jobs: Readonly<Record<string, Readonly<{ result: JobOutcome }>>>;
  /** The event the run answers (`pull_request`, `merge_group`, …). */
  event: string;
  catalogue?: readonly Gate[];
}>;

export function sealReceipt(inputs: SealInputs): GateReceipt {
  const catalogue = inputs.catalogue ?? GATE_CATALOGUE;
  const { plan } = inputs;
  const refusals: string[] = [];
  const byCell = new Map<string, GateResult>();
  for (const raw of inputs.results) {
    const result = raw as Partial<GateResult> & { unreadable?: string };
    if (result.unreadable !== undefined) {
      refusals.push(`unreadable result ${result.unreadable}`);
      continue;
    }
    if (result.schemaVersion !== GATE_RESULT_SCHEMA || typeof result.cell !== "string" || typeof result.gate !== "string") {
      refusals.push(`a result of another shape (${String(result.schemaVersion)})`);
      continue;
    }
    if (byCell.has(result.cell)) {
      refusals.push(`duplicate result for cell ${result.cell}`);
      continue;
    }
    if (result.headSha !== plan.headSha || result.treeId !== plan.treeId || result.catalogueDigest !== plan.catalogueDigest) {
      refusals.push(`cell ${result.cell}: result for another commit, tree or catalogue (${String(result.headSha)} / ${String(result.treeId)})`);
      continue;
    }
    byCell.set(result.cell, result as GateResult);
  }
  const gates: GateVerdict[] = [];
  const planned = new Set<string>();
  let tests = 0;
  for (const gate of catalogue) {
    if (!plan.gates.some((entry) => entry.id === gate.id)) {
      refusals.push(`gate ${gate.id} of the catalogue is not in the plan`);
      continue;
    }
    if (gate.class === "action") {
      const action = gate.action!;
      const outcome = inputs.jobs[gate.id]?.result;
      const applies = (action.events as readonly string[]).includes(inputs.event);
      if (!applies) {
        if (outcome !== undefined && outcome !== "skipped") refusals.push(`action gate ${gate.id} ran (${outcome}) on ${inputs.event}, an event it does not run on`);
        gates.push({ id: gate.id, role: gate.role, status: "not-run", cells: [] });
        continue;
      }
      const status = outcome === "success" ? "passed" : "failed";
      gates.push({ id: gate.id, role: gate.role, status, cells: [{ cell: gate.id, status: outcome === undefined ? "missing" : status, ...(outcome === "success" ? {} : { refusal: `job ${gate.id} ended ${String(outcome ?? "without a result")}` }) }] });
      continue;
    }
    if (plan.reuse !== undefined) {
      // Every light and suite gate is reused: the door's proven verdict for this exact K stands for it.
      gates.push({ id: gate.id, role: gate.role, status: "reused", cells: [] });
      continue;
    }
    const cellIds = gate.class === "light" ? [gate.id] : plan.cells.filter((cell) => cell.gate === gate.id).map((cell) => cell.cell);
    if (gate.class === "suite" && cellIds.length === 0) refusals.push(`suite ${gate.id} has no planned cell`);
    const cells = cellIds.map((cellId) => {
      planned.add(cellId);
      const result = byCell.get(cellId);
      if (result === undefined) return { cell: cellId, status: "missing" as const, refusal: "no result" };
      if (result.gate !== gate.id) return { cell: cellId, status: "failed" as const, refusal: `the result names gate ${result.gate}` };
      if (gate.class === "suite") {
        const plannedFiles = plan.cells.find((cell) => cell.cell === cellId)!.files;
        if (result.status === "passed") {
          const ran = result.suite?.files ?? [];
          if (ran.length !== plannedFiles.length || ran.some((path, index) => path !== plannedFiles[index])) {
            return { cell: cellId, status: "failed" as const, refusal: "the shard's files are not its planned files" };
          }
          tests += result.suite!.tests;
          return { cell: cellId, status: "passed" as const, tests: result.suite!.tests };
        }
      }
      return result.status === "passed"
        ? { cell: cellId, status: "passed" as const }
        : { cell: cellId, status: "failed" as const, refusal: result.refusal ?? `${result.steps.at(-1)?.command ?? "a command"}: ${result.steps.at(-1)?.message ?? "failed"}` };
    });
    const status = cells.length > 0 && cells.every((cell) => cell.status === "passed") ? "passed" : "failed";
    gates.push({ id: gate.id, role: gate.role, status, cells });
  }
  for (const cellId of byCell.keys()) if (!planned.has(cellId)) refusals.push(`unexpected result for cell ${cellId}`);
  for (const population of new Set(plan.cells.map((cell) => cell.gate))) {
    const covered = plan.cells.filter((cell) => cell.gate === population).flatMap((cell) => cell.files);
    if (new Set(covered).size !== covered.length) refusals.push(`suite ${population}: a file is planned in two shards`);
  }
  for (const listing of plan.reuse === undefined ? plan.populations : []) {
    const suite = catalogue.find((gate) => gate.population === listing.population);
    if (suite === undefined) continue;
    const covered = new Set(plan.cells.filter((cell) => cell.gate === suite.id).flatMap((cell) => cell.files));
    const uncovered = listing.files.filter((path) => !covered.has(path));
    if (uncovered.length > 0 || covered.size !== listing.files.length) refusals.push(`suite ${suite.id}: the shards do not cover its population exactly once`);
  }
  const verdict = refusals.length === 0 && gates.every((gate) => gate.role !== "required" || gate.status !== "failed") ? "passed" : "failed";
  return deepFreeze({
    schemaVersion: GATE_RECEIPT_SCHEMA,
    headSha: plan.headSha,
    treeId: plan.treeId,
    catalogueDigest: plan.catalogueDigest,
    planDigest: canonicalHash(plan),
    event: inputs.event,
    verdict,
    gates,
    refusals,
    exclusions: plan.populations.flatMap((listing) => listing.excluded.map((entry) => ({ population: listing.population, ...entry }))),
    tests,
  });
}

/** Parses `toJSON(needs)` from the environment, refusing another shape. */
export function parseJobOutcomes(text: string | undefined): Readonly<Record<string, Readonly<{ result: JobOutcome }>>> {
  if (text === undefined || text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new InputError("JOB_RESULTS is not JSON (it carries toJSON(needs))", "gate_seal_input_invalid");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new InputError("JOB_RESULTS is not an object of jobs", "gate_seal_input_invalid");
  const outcomes: Record<string, { result: JobOutcome }> = {};
  for (const [job, value] of Object.entries(parsed as Record<string, unknown>)) {
    const result = (value as { result?: unknown } | null)?.result;
    if (result !== "success" && result !== "failure" && result !== "cancelled" && result !== "skipped") throw new InputError(`job ${job} has no known result`, "gate_seal_input_invalid");
    outcomes[job] = { result };
  }
  return deepFreeze(outcomes);
}

/** The receipt as a human table (the job summary and, later, the door's check). */
export function renderReceipt(receipt: GateReceipt): string {
  const lines = [
    `## Gates: ${receipt.verdict === "passed" ? "passed" : "FAILED"}`,
    "",
    `Tree \`${receipt.treeId}\` at \`${receipt.headSha}\` (${receipt.event}); ${receipt.tests} suite test(s).`,
    "",
    "| Gate | Role | Status | Cells |",
    "|---|---|---|---|",
    ...receipt.gates.map((gate) => `| ${gate.id} | ${gate.role} | ${gate.status} | ${gate.cells.map((cell) => `${cell.cell}: ${cell.status}${cell.refusal === undefined ? "" : ` (${cell.refusal})`}`).join("; ") || "—"} |`),
  ];
  if (receipt.refusals.length > 0) lines.push("", "### Refusals", "", ...receipt.refusals.map((refusal) => `- ${refusal}`));
  if (receipt.exclusions.length > 0) lines.push("", "### Excluded test files", "", ...receipt.exclusions.map((entry) => `- \`${entry.path}\` (${entry.population}): ${entry.reason}`));
  return `${lines.join("\n")}\n`;
}
