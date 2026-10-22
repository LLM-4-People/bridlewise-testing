/**
 * `harness gates` — the verbs the generated CI calls, and the same verbs a
 * local run calls (local and CI differ only in where they run):
 *
 *   harness gates list
 *   harness gates population <web-tests|engine-tests>   (`--text`: one file per line)
 *   harness gates plan  --out <dir> [--github-output <file>]
 *   harness gates setup <registry command>…
 *   harness gates run   <gate> --plan <plan.json> --out <dir>
 *   harness gates shard <cell> --plan <plan.json> --out <dir>
 *   harness gates seal  --plan <plan.json> --results <dir> --out <dir> [--event <name>]
 *
 * `plan` lists the populations of the working tree and writes `plan.json`
 * (and, in CI, the matrix cells to `$GITHUB_OUTPUT`). `setup` runs the named
 * registry setup commands (the bundle, the guardian binaries) through the one
 * runner, fail-fast. `run` and `shard` write one result each and exit 1 when
 * the cell failed. Every command runs through the ONE command runner
 * (`../checkout-setup.ts`) over the ONE registry (`workspaceIsolation`). `seal` reads the job
 * outcomes from `JOB_RESULTS` (the workflow's `toJSON(needs)`) and the event
 * from `--event` or `GITHUB_EVENT_NAME`, writes `receipt.json`, appends the
 * receipt table to `$GITHUB_STEP_SUMMARY` when CI provides one, and exits 1
 * unless the verdict is passed.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { INPUT_ERROR_CODE, InputError } from "../../kernel/errors.ts";
import { canonicalJson, deepFreeze } from "../../kernel/integrity.ts";
import { repositoryToplevel } from "../../git/repository-ownership.ts";
import { readMeasuredTree, readRepositoryHeadSha } from "../../shared/tree-identity.ts";
import { wrapResult, type CommandAnswer } from "../command-result.ts";
import { GATE_CATALOGUE, type Population } from "./catalogue.ts";
import { workingTreeKey } from "./key.ts";
import { catalogueDigest, matrixCells, parsePlan, planGates, type GatePlan } from "./plan.ts";
import { listPopulation } from "./populations.ts";
import { testProcessSupervisorBinary } from "../../../guardian/build.ts";
import { loadPinnedConfigSnapshot } from "../../kernel/config.ts";
import { checkoutCommandRunner, configuredCheckoutCommandRunner, runDeclaredCommands } from "../checkout-setup.ts";
import { registryCommand, runLightGate, runShard, type RunEnvironment } from "./cell-run.ts";
import { parseJobOutcomes, readResults, renderReceipt, sealReceipt } from "./seal.ts";

/**
 * What CI hands a gates verb through the environment (GitHub's own variables,
 * and the seal step's `needs` outcomes): read by name, never as configuration.
 */
const CI_EVENT_VARIABLE = "GITHUB_EVENT_NAME";
const JOB_RESULTS_VARIABLE = "JOB_RESULTS";
const STEP_SUMMARY_VARIABLE = "GITHUB_STEP_SUMMARY";

const VERBS = ["list", "population", "plan", "setup", "run", "shard", "seal"] as const;

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
    throw new InputError(`gates ${verb}: ${(error as Error).message}`, INPUT_ERROR_CODE);
  }
  if (parsed.positionals.length !== positionals) throw new InputError(`gates ${verb} takes ${positionals} positional argument(s)`, INPUT_ERROR_CODE);
  return { values: parsed.values as Record<string, string | undefined>, positionals: parsed.positionals };
}

function required(verb: string, values: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = values[name];
  if (value === undefined || value === "") throw new InputError(`gates ${verb} requires --${name}`, INPUT_ERROR_CODE);
  return value;
}

/** Plans the working tree of the repository holding `engineRoot`. */
async function planWorkingTree(repositoryRoot: string): Promise<GatePlan> {
  const headSha = readRepositoryHeadSha(repositoryRoot);
  const treeId = readMeasuredTree(repositoryRoot);
  if (headSha === null || treeId === null) throw new InputError(`cannot read the head commit and tree of ${repositoryRoot}`, "gate_repository_unknown");
  const populations = await Promise.all(
    [...new Set(GATE_CATALOGUE.flatMap((gate) => (gate.population === undefined ? [] : [gate.population])))].map((population: Population) => listPopulation(repositoryRoot, population)),
  );
  return planGates({ headSha, treeId, key: workingTreeKey(repositoryRoot, treeId, catalogueDigest()), populations });
}

/** The registry and the one runner, as the configuration declares them (the native supervisor built first). */
function configuredRunner(repositoryRoot: string, tell: (line: string) => void): Pick<RunEnvironment, "registry" | "run" | "tell"> {
  const { document } = loadPinnedConfigSnapshot();
  const isolation = document.workspaceIsolation;
  if (isolation === undefined) throw new InputError("the configuration declares no workspaceIsolation section: the command registry the gates run is absent", "gate_registry_absent");
  const runner = configuredCheckoutCommandRunner(document, isolation, testProcessSupervisorBinary());
  return { registry: isolation.commands, run: checkoutCommandRunner(repositoryRoot, runner), tell };
}

export async function runGatesCli(engineRoot: string, argv: readonly string[], onProgress: (line: string) => void): Promise<CommandAnswer> {
  const [verb, ...rest] = argv;
  if (verb === undefined || !(VERBS as readonly string[]).includes(verb)) {
    throw new InputError(`harness gates <${VERBS.join("|")}> (got ${JSON.stringify(verb ?? "")})`, INPUT_ERROR_CODE);
  }
  const repositoryRoot = repositoryRootOf(engineRoot);
  if (verb === "list") {
    options(verb, rest, {}, 0);
    return { result: wrapResult("gates", deepFreeze({ gates: GATE_CATALOGUE.map((gate) => ({ id: gate.id, class: gate.class, role: gate.role, title: gate.title })) }), { status: "pass" }) };
  }
  if (verb === "population") {
    const { positionals } = options(verb, rest, {}, 1);
    const name = positionals[0]!;
    if (name !== "web-tests" && name !== "engine-tests") throw new InputError(`gates population: unknown population ${JSON.stringify(name)} (web-tests, engine-tests)`, INPUT_ERROR_CODE);
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
    writeFileSync(join(out, "keydoc.json"), canonicalJson(plan.key));
    return { result: wrapResult("gates", deepFreeze({ plan: join(out, "plan.json"), headSha: plan.headSha, treeId: plan.treeId, key: plan.keyDigest, cells: plan.cells.map((cell) => ({ cell: cell.cell, files: cell.files.length, weight: cell.weight })) }), { status: "pass" }) };
  }
  if (verb === "setup") {
    if (rest.length === 0 || rest.some((name) => name.startsWith("-"))) throw new InputError("gates setup takes the registry setup commands to run", INPUT_ERROR_CODE);
    const configured = configuredRunner(repositoryRoot, onProgress);
    for (const name of rest) registryCommand(configured.registry, name);
    const steps = await runDeclaredCommands({ commands: configured.registry }, "gate setup", rest, async (name, command) => {
      const step = await configured.run(name, command);
      for (const line of [step.message, ...step.details]) configured.tell!(`setup: ${name}: ${line}`);
      return step;
    });
    const failed = steps.filter((step) => step.status !== "pass").map((step) => step.step);
    return { result: wrapResult("gates", deepFreeze({ setup: steps.map((step) => ({ command: step.step, status: step.status })) }), { status: failed.length === 0 ? "pass" : "fail" }) };
  }
  if (verb === "run" || verb === "shard") {
    const { values, positionals } = options(verb, rest, { plan: "string", out: "string" }, 1);
    const plan = readPlanFile(required(verb, values, "plan"));
    const environment: RunEnvironment = { repositoryRoot, outDirectory: resolve(required(verb, values, "out")), ...configuredRunner(repositoryRoot, onProgress) };
    const result = verb === "run" ? await runLightGate(plan, positionals[0]!, environment) : await runShard(plan, positionals[0]!, environment);
    return { result: wrapResult("gates", deepFreeze({ cell: result.cell, status: result.status, ...(result.refusal === undefined ? {} : { refusal: result.refusal }) }), { status: result.status === "passed" ? "pass" : "fail" }) };
  }
  const { values } = options(verb, rest, { plan: "string", results: "string", out: "string", event: "string" }, 0);
  const plan = readPlanFile(required(verb, values, "plan"));
  const event = values.event ?? process.env[CI_EVENT_VARIABLE];
  if (event === undefined || event === "") throw new InputError("gates seal needs the event (--event, or GITHUB_EVENT_NAME in CI)", INPUT_ERROR_CODE);
  const receipt = sealReceipt({ plan, results: readResults(resolve(required(verb, values, "results"))), jobs: parseJobOutcomes(process.env[JOB_RESULTS_VARIABLE]), event });
  const out = resolve(required(verb, values, "out"));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "receipt.json"), `${canonicalJson(receipt)}\n`);
  const summary = process.env[STEP_SUMMARY_VARIABLE];
  if (summary !== undefined && summary !== "") appendFileSync(summary, renderReceipt(receipt));
  return {
    result: wrapResult("gates", deepFreeze({ verdict: receipt.verdict, refusals: receipt.refusals, failed: receipt.gates.filter((gate) => gate.status === "failed").map((gate) => gate.id) }), { status: receipt.verdict === "passed" ? "pass" : "fail" }),
    text: () => renderReceipt(receipt),
  };
}
