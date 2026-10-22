/**
 * THE GATE PLAN — what one CI run of a tree runs: every gate of the catalogue,
 * each suite's population, and the shard cells the populations split into.
 *
 * `planGates` is pure over its inputs (the catalogue, the populations, the
 * weights, the tree's identity), so two jobs that plan one tree agree byte for
 * byte; `plan.json` is uploaded once and every later job reads it rather than
 * planning again.
 *
 * SHARDS. A `files` suite's files are packed longest-first into shards of
 * equal weight (ties by path, the lowest shard first — deterministic). The
 * cell budget is the catalogue's `MAX_SHARDS`, shared by the suites in
 * proportion to their total weight.
 *
 * WEIGHTS. A file's weight is its per-file CPU work from the ledger. A tree
 * with no ledger yet is planned `unmeasured`: every file weighs one unit and
 * the plan says so (`weights.basis`), so a plan never cites a weight nobody
 * measured.
 */
import { InputError } from "../../kernel/errors.ts";
import { canonicalHash, deepFreeze } from "../../kernel/integrity.ts";
import { schemaId } from "../../kernel/product-identity.ts";
import { GATE_CATALOGUE, GATE_CATALOGUE_VERSION, MAX_SHARDS, POPULATION_EXCLUSIONS, type Gate } from "./catalogue.ts";
import { gateKey, type GateKeyDocument } from "./key.ts";
import type { PopulationListing } from "./populations.ts";

const GATE_PLAN_SCHEMA = schemaId("gate-plan", 1);

export type ShardCell = Readonly<{
  /** The cell id: `<gate>-<index>`; the artifact and matrix name. */
  cell: string;
  gate: string;
  index: number;
  of: number;
  title: string;
  weight: number;
  files: readonly string[];
}>;

export type PlanWeights = Readonly<{ basis: "unmeasured" }>;

export type GatePlan = Readonly<{
  schemaVersion: typeof GATE_PLAN_SCHEMA;
  catalogueVersion: typeof GATE_CATALOGUE_VERSION;
  /** The digest of the catalogue the plan was made from (gates and exclusions). */
  catalogueDigest: string;
  headSha: string;
  treeId: string;
  /** The reuse key's document (`key.ts`) and its digest K, as this job measured them. */
  key: GateKeyDocument;
  keyDigest: string;
  weights: PlanWeights;
  gates: readonly Readonly<{ id: string; class: Gate["class"]; role: Gate["role"]; reuse: Gate["reuse"] }>[];
  populations: readonly PopulationListing[];
  cells: readonly ShardCell[];
}>;

/** The digest of a catalogue: what a plan, a result and a receipt bind to. */
export function catalogueDigest(catalogue: readonly Gate[] = GATE_CATALOGUE): string {
  return canonicalHash({ version: GATE_CATALOGUE_VERSION, gates: catalogue, exclusions: POPULATION_EXCLUSIONS });
}

type Bin = { index: number; weight: number; files: string[] };

/** Longest-first packing of `files` into `count` bins of equal weight; ties by path, then the lowest bin. */
export function packShards(files: readonly Readonly<{ path: string; weight: number }>[], count: number): readonly Readonly<{ index: number; weight: number; files: readonly string[] }>[] {
  if (!Number.isSafeInteger(count) || count < 1 || count > files.length) {
    throw new InputError(`cannot pack ${files.length} file(s) into ${count} shard(s)`, "gate_plan_invalid");
  }
  const bins: Bin[] = Array.from({ length: count }, (_, offset) => ({ index: offset + 1, weight: 0, files: [] }));
  const ordered = [...files].toSorted((left, right) => right.weight - left.weight || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  for (const file of ordered) {
    let lightest = bins[0]!;
    for (const bin of bins) if (bin.weight < lightest.weight) lightest = bin;
    lightest.weight += file.weight;
    lightest.files.push(file.path);
  }
  return bins.map((bin) => ({ index: bin.index, weight: bin.weight, files: bin.files.toSorted() }));
}

/** Splits `budget` cells over the split suites in proportion to their weight: each at least one, never more than its files. */
export function allocateShards(suites: readonly Readonly<{ id: string; weight: number; files: number }>[], budget: number): ReadonlyMap<string, number> {
  if (suites.length === 0) return new Map();
  if (budget < suites.length) throw new InputError(`a budget of ${budget} cell(s) cannot hold ${suites.length} split suite(s)`, "gate_plan_invalid");
  const counts = new Map(suites.map((suite) => [suite.id, 1]));
  let left = budget - suites.length;
  // Hand out the remaining cells one at a time to the suite with the heaviest weight per cell.
  while (left > 0) {
    const candidates = suites.filter((suite) => counts.get(suite.id)! < suite.files);
    if (candidates.length === 0) break;
    const next = candidates.reduce((best, suite) => (suite.weight / counts.get(suite.id)! > best.weight / counts.get(best.id)! ? suite : best));
    counts.set(next.id, counts.get(next.id)! + 1);
    left -= 1;
  }
  return counts;
}

export type PlanInputs = Readonly<{
  headSha: string;
  treeId: string;
  key: GateKeyDocument;
  populations: readonly PopulationListing[];
  catalogue?: readonly Gate[];
}>;

const SHA = /^[0-9a-f]{40}$/u;

export function planGates(inputs: PlanInputs): GatePlan {
  const catalogue = inputs.catalogue ?? GATE_CATALOGUE;
  if (!SHA.test(inputs.headSha) || !SHA.test(inputs.treeId)) throw new InputError("a plan names a full commit sha and tree id", "gate_plan_invalid");
  if (inputs.key.treeId !== inputs.treeId) throw new InputError("the plan's key names another tree", "gate_plan_invalid");
  if (inputs.key.catalogue.digest !== catalogueDigest(catalogue)) throw new InputError("the plan's key names another catalogue", "gate_plan_invalid");
  const suites = catalogue.filter((gate) => gate.class === "suite");
  const listing = (gate: Gate): PopulationListing => {
    const found = inputs.populations.find((entry) => entry.population === gate.population);
    if (found === undefined) throw new InputError(`suite ${gate.id}: population ${String(gate.population)} was not listed`, "gate_plan_invalid");
    return found;
  };
  const weightOf = (_path: string): number => 1;
  const allocation = allocateShards(
    suites.map((gate) => {
      const files = listing(gate).files;
      return { id: gate.id, weight: files.reduce((sum, path) => sum + weightOf(path), 0), files: files.length };
    }),
    MAX_SHARDS,
  );
  const cells: ShardCell[] = [];
  for (const gate of suites) {
    const files = listing(gate).files;
    const count = allocation.get(gate.id)!;
    for (const shard of packShards(files.map((path) => ({ path, weight: weightOf(path) })), count)) {
      cells.push({ cell: `${gate.id}-${shard.index}`, gate: gate.id, index: shard.index, of: count, title: `${gate.title} ${shard.index}/${count}`, weight: shard.weight, files: shard.files });
    }
  }
  return deepFreeze({
    schemaVersion: GATE_PLAN_SCHEMA,
    catalogueVersion: GATE_CATALOGUE_VERSION,
    catalogueDigest: catalogueDigest(catalogue),
    headSha: inputs.headSha,
    treeId: inputs.treeId,
    key: inputs.key,
    keyDigest: gateKey(inputs.key),
    weights: { basis: "unmeasured" },
    gates: catalogue.map((gate) => ({ id: gate.id, class: gate.class, role: gate.role, reuse: gate.reuse })),
    populations: [...inputs.populations].toSorted((left, right) => (left.population < right.population ? -1 : 1)),
    cells,
  });
}

/** Parses a plan document, refusing any other shape (every consumer reads a validated plan). */
export function parsePlan(value: unknown): GatePlan {
  const plan = value as Partial<GatePlan> | null;
  const refuse = (what: string): never => {
    throw new InputError(`not a gate plan: ${what}`, "gate_plan_invalid");
  };
  if (typeof plan !== "object" || plan === null) refuse("not an object");
  if (plan!.schemaVersion !== GATE_PLAN_SCHEMA) refuse(`schema ${String(plan!.schemaVersion)}`);
  if (plan!.catalogueVersion !== GATE_CATALOGUE_VERSION) refuse(`catalogue ${String(plan!.catalogueVersion)}`);
  if (typeof plan!.headSha !== "string" || !SHA.test(plan!.headSha) || typeof plan!.treeId !== "string" || !SHA.test(plan!.treeId)) refuse("no head sha or tree id");
  if (typeof plan!.key !== "object" || plan!.key === null || plan!.keyDigest !== gateKey(plan!.key) || plan!.key.treeId !== plan!.treeId) refuse("its key document does not hash to its key, or names another tree");
  if (!Array.isArray(plan!.gates) || !Array.isArray(plan!.cells) || !Array.isArray(plan!.populations)) refuse("no gates, cells or populations");
  const cellIds = new Set<string>();
  for (const cell of plan!.cells!) {
    if (typeof cell.cell !== "string" || cellIds.has(cell.cell) || !Array.isArray(cell.files) || cell.files.length === 0) refuse(`cell ${String(cell.cell)}`);
    cellIds.add(cell.cell);
  }
  return deepFreeze(plan as GatePlan);
}

/** The matrix the CI `shard` job expands: one `{cell, gate, title}` per cell (the files stay in plan.json). */
export function matrixCells(plan: GatePlan): readonly Readonly<{ cell: string; gate: string; title: string }>[] {
  return plan.cells.map((cell) => ({ cell: cell.cell, gate: cell.gate, title: cell.title }));
}
