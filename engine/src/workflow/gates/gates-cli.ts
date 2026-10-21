/**
 * `harness gates` — the verbs the generated CI calls, and the same verbs a
 * local run calls (local and CI differ only in where they run):
 *
 *   harness gates list
 *   harness gates population <web-tests|engine-tests>   (`--text`: one file per line)
 *   harness gates plan  --out <dir> [--github-output <file>]
 *   harness gates run   <gate> --plan <plan.json> --out <dir>
 *   harness gates shard <cell> --plan <plan.json> --out <dir>
 *   harness gates seal  --plan <plan.json> --results <dir> --out <dir> [--event <name>]
 *
 * `plan` lists the populations of the working tree and writes `plan.json`
 * (and, in CI, the matrix cells to `$GITHUB_OUTPUT`). `run` and `shard` write
 * one result each and exit 1 when the cell failed. `seal` reads the job
 * outcomes from `JOB_RESULTS` (the workflow's `toJSON(needs)`) and the event
 * from `--event` or `GITHUB_EVENT_NAME`, writes `receipt.json`, appends the
 * receipt table to `$GITHUB_STEP_SUMMARY` when CI provides one, and exits 1
 * unless the verdict is passed.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { InputError } from "../../kernel/errors.ts";
import { canonicalJson, deepFreeze } from "../../kernel/integrity.ts";
import { repositoryToplevel } from "../../git/repository-ownership.ts";
import { readMeasuredTree, readRepositoryHeadSha } from "../../shared/tree-identity.ts";
import { wrapResult, type CommandAnswer } from "../command-result.ts";
import { GATE_CATALOGUE, type Population } from "./catalogue.ts";
import { matrixCells, parsePlan, planGates, type GatePlan } from "./plan.ts";
import { listPopulation } from "./populations.ts";
import { runLightGate, runShard } from "./run.ts";
import { parseJobOutcomes, readResults, renderReceipt, sealReceipt } from "./seal.ts";

const VERBS = ["list", "population", "plan", "run", "shard", "seal"] as const;

function repositoryRootOf(engineRoot: string): string {
  const top = repositoryToplevel(engineRoot, "directory");
  if (top === undefined) throw new InputError(`${engineRoot} is not inside a git working tree`, "gate_repository_unknown");
  return top;
}

function readPlanFile(path: string): GatePlan {
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new InputError(`cannot read the plan ${path} (${(error as Error).message})`, "gate_plan_invalid");
  }
  return parsePlan(document);
}

function options(verb: string, argv: readonly string[], declared: Readonly<Record<string, "string">>, positionals: number): Readonly<{ values: Readonly<Record<string, string | undefined>>; positionals: readonly string[] }> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args: [...argv], options: Object.fromEntries(Object.keys(declared).map((name) => [name, { type: "string" as const }])), allowPositionals: true, strict: true });
  } catch (error) {
    throw new InputError(`gates ${verb}: ${(error as Error).message}`, "input_error");
  }
  if (parsed.positionals.length !== positionals) throw new InputError(`gates ${verb} takes ${positionals} positional argument(s)`, "input_error");
  return { values: parsed.values as Record<string, string | undefined>, positionals: parsed.positionals };
}

function required(verb: string, values: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = values[name];
  if (value === undefined || value === "") throw new InputError(`gates ${verb} requires --${name}`, "input_error");
  return value;
}

/** Plans the working tree of the repository holding `engineRoot`. */
export async function planWorkingTree(repositoryRoot: string): Promise<GatePlan> {
  const headSha = readRepositoryHeadSha(repositoryRoot);
  const treeId = readMeasuredTree(repositoryRoot);
  if (headSha === null || treeId === null) throw new InputError(`cannot read the head commit and tree of ${repositoryRoot}`, "gate_repository_unknown");
  const populations = await Promise.all(
    [...new Set(GATE_CATALOGUE.flatMap((gate) => (gate.population === undefined ? [] : [gate.population])))].map((population: Population) => listPopulation(repositoryRoot, population)),
  );
  return planGates({ headSha, treeId, populations });
}

export async function runGatesCli(engineRoot: string, argv: readonly string[]): Promise<CommandAnswer> {
  const [verb, ...rest] = argv;
  if (verb === undefined || !(VERBS as readonly string[]).includes(verb)) {
    throw new InputError(`harness gates <${VERBS.join("|")}> (got ${JSON.stringify(verb ?? "")})`, "input_error");
  }
  const repositoryRoot = repositoryRootOf(engineRoot);
  if (verb === "list") {
    options(verb, rest, {}, 0);
    return { result: wrapResult("gates", deepFreeze({ gates: GATE_CATALOGUE.map((gate) => ({ id: gate.id, class: gate.class, role: gate.role, title: gate.title })) }), { status: "pass" }) };
  }
  if (verb === "population") {
    const { positionals } = options(verb, rest, {}, 1);
    const name = positionals[0]!;
    if (name !== "web-tests" && name !== "engine-tests") throw new InputError(`gates population: unknown population ${JSON.stringify(name)} (web-tests, engine-tests)`, "input_error");
    const listing = await listPopulation(repositoryRoot, name);
    return {
      result: wrapResult("gates", deepFreeze({ population: listing.population, source: listing.source, files: listing.files, excluded: listing.excluded }), { status: "pass" }),
      text: () => `${listing.files.join("\n")}\n`,
    };
  }
  if (verb === "plan") {
    const { values } = options(verb, rest, { out: "string", "github-output": "string" }, 0);
    const out = resolve(required(verb, values, "out"));
    const plan = await planWorkingTree(repositoryRoot);
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "plan.json"), `${canonicalJson(plan)}\n`);
    if (values["github-output"] !== undefined) appendFileSync(values["github-output"], `cells=${JSON.stringify(matrixCells(plan))}\n`);
    return { result: wrapResult("gates", deepFreeze({ plan: join(out, "plan.json"), headSha: plan.headSha, treeId: plan.treeId, cells: plan.cells.map((cell) => ({ cell: cell.cell, files: cell.files.length, weight: cell.weight })) }), { status: "pass" }) };
  }
  if (verb === "run" || verb === "shard") {
    const { values, positionals } = options(verb, rest, { plan: "string", out: "string" }, 1);
    const plan = readPlanFile(required(verb, values, "plan"));
    const environment = { repositoryRoot, outDirectory: resolve(required(verb, values, "out")) };
    const result = verb === "run" ? await runLightGate(plan, positionals[0]!, environment) : await runShard(plan, positionals[0]!, environment);
    return { result: wrapResult("gates", deepFreeze({ cell: result.cell, status: result.status, ...(result.refusal === undefined ? {} : { refusal: result.refusal }) }), { status: result.status === "passed" ? "pass" : "fail" }) };
  }
  const { values } = options(verb, rest, { plan: "string", results: "string", out: "string", event: "string" }, 0);
  const plan = readPlanFile(required(verb, values, "plan"));
  const event = values.event ?? process.env.GITHUB_EVENT_NAME;
  if (event === undefined || event === "") throw new InputError("gates seal needs the event (--event, or GITHUB_EVENT_NAME in CI)", "input_error");
  const receipt = sealReceipt({ plan, results: readResults(resolve(required(verb, values, "results"))), jobs: parseJobOutcomes(process.env.JOB_RESULTS), event });
  const out = resolve(required(verb, values, "out"));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "receipt.json"), `${canonicalJson(receipt)}\n`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary !== undefined && summary !== "") appendFileSync(summary, renderReceipt(receipt));
  return {
    result: wrapResult("gates", deepFreeze({ verdict: receipt.verdict, refusals: receipt.refusals, failed: receipt.gates.filter((gate) => gate.status === "failed").map((gate) => gate.id) }), { status: receipt.verdict === "passed" ? "pass" : "fail" }),
    text: () => renderReceipt(receipt),
  };
}
