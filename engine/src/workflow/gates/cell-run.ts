/**
 * RUNNING ONE GATE CELL — `harness gates run <gate>` (a light gate) and
 * `harness gates shard <cell>` (one cell of a suite), locally and in CI
 * alike: the same catalogue, the same registry commands, the same runner,
 * the same result document.
 *
 * Before anything runs, the job's tree must be the tree the plan was made
 * for (`headSha` and `treeId`): a job that checked out, built or edited
 * something else would otherwise report on a tree nobody planned.
 *
 * Every command is a name in the ONE command registry
 * (`workspaceIsolation.commands`) run by the ONE command runner
 * (`../checkout-setup.ts`): under the native supervisor, its whole output
 * redacted into a log under the run's temp root, an errored run retried by
 * the runner's own policy (a FAILED run is never re-run). The first failing
 * command ends the cell. Each command's step records the CPU time its whole
 * process tree spent (`supervision.waitedCpuUs`, the supervisor's reaped
 * descendants) — never a wall-clock verdict.
 *
 * The result (`<out>/<cell>.result.json`, `bridlewise-gate-result/v1`) is
 * written on every ending — passed, failed or refused — so the seal names
 * what happened rather than only that a file is missing.
 *
 * A web cell runs its registry command with the vitest JSON report path and
 * exactly its planned files appended, and passes only when that report's
 * rows record every planned file green (`vitest-report.ts`). An engine cell
 * runs its registry command with the file listing its sources (`--cell`: the
 * runner dispatches them and withholds the rest of the inventory, counted
 * skipped) and passes only when the runner's cell rule passed and its
 * summary records the cell's tests passed and none failed.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { InputError } from "../../kernel/errors.ts";
import { canonicalJson, deepFreeze } from "../../kernel/integrity.ts";
import { schemaId } from "../../kernel/product-identity.ts";
import { readMeasuredTree, readRepositoryHeadSha } from "../../shared/tree-identity.ts";
import type { CheckoutCommand, CheckoutStep } from "../checkout-setup.ts";
import { GATE_CATALOGUE, gateById, type Gate } from "./catalogue.ts";
import type { GatePlan, ShardCell } from "./plan.ts";
import { judgeVitestReport } from "./vitest-report.ts";

export const GATE_RESULT_SCHEMA = schemaId("gate-result", 1);

export type StepOutcome = Readonly<{
  command: string;
  status: CheckoutStep["status"];
  failure?: CheckoutStep["failure"];
  message: string;
  /** CPU time of the command's whole process tree, in microseconds (null when the supervisor left no receipt). */
  cpuUs: number | null;
}>;

export type SuiteOutcome = Readonly<{
  population: string;
  files: readonly string[];
  tests: number;
  /** For a web cell, each file's test count from the judged report; empty for a whole-inventory run. */
  perFile: readonly Readonly<{ path: string; tests: number }>[];
}>;

export type GateResult = Readonly<{
  schemaVersion: typeof GATE_RESULT_SCHEMA;
  gate: string;
  cell: string;
  catalogueDigest: string;
  headSha: string;
  treeId: string;
  status: "passed" | "failed";
  /** Why the cell failed without a failing command: a refused identity, a refused report. */
  refusal?: string;
  startedAt: string;
  finishedAt: string;
  steps: readonly StepOutcome[];
  suite?: SuiteOutcome;
}>;

/** Runs one registry command (its declared form, or that form with arguments appended) and answers its step. */
export type CommandRunner = (name: string, command: CheckoutCommand) => Promise<CheckoutStep>;

export type RunEnvironment = Readonly<{
  repositoryRoot: string;
  outDirectory: string;
  /** The command registry (`workspaceIsolation.commands`). */
  registry: Readonly<Record<string, CheckoutCommand>>;
  /** The one runner (production: `checkoutCommandRunner` over the configured runner). */
  run: CommandRunner;
  /** Reads the job's tree identity; injected by tests. */
  identity?: (repositoryRoot: string) => Readonly<{ headSha: string | null; treeId: string | null }>;
  /** Where a command's progress is told (the CI log); silent when absent. */
  tell?: (line: string) => void;
  now?: () => Date;
}>;

function defaultIdentity(repositoryRoot: string): Readonly<{ headSha: string | null; treeId: string | null }> {
  return { headSha: readRepositoryHeadSha(repositoryRoot), treeId: readMeasuredTree(repositoryRoot) };
}

/** The registry command `name`, or the typed refusal naming the registry's commands. */
export function registryCommand(registry: Readonly<Record<string, CheckoutCommand>>, name: string): CheckoutCommand {
  const command = registry[name];
  if (command === undefined) throw new InputError(`the gate catalogue runs ${JSON.stringify(name)}, which the command registry (workspaceIsolation.commands) does not declare`, "gate_command_undeclared");
  return command;
}

function outcomeOf(step: CheckoutStep): StepOutcome {
  return deepFreeze({
    command: step.step,
    status: step.status,
    ...(step.failure === undefined ? {} : { failure: step.failure }),
    message: step.message,
    cpuUs: step.evidence?.terminal?.supervision?.waitedCpuUs ?? null,
  });
}

function writeResult(outDirectory: string, result: GateResult): void {
  writeFileSync(join(outDirectory, `${result.cell}.result.json`), `${canonicalJson(result)}\n`, { mode: 0o644 });
}

type CellCommand = Readonly<{ name: string; extra: (logs: ReadonlyMap<string, string>) => readonly string[] }>;
type CellRun = Readonly<{ gate: Gate; cell: string; commands: readonly CellCommand[]; finish?: (outcome: Readonly<{ ok: boolean }>) => Readonly<{ refusal?: string; suite?: SuiteOutcome }> }>;

async function runCell(plan: GatePlan, cellRun: CellRun, environment: RunEnvironment): Promise<GateResult> {
  const now = environment.now ?? (() => new Date());
  const tell = environment.tell ?? (() => undefined);
  const startedAt = now().toISOString();
  mkdirSync(environment.outDirectory, { recursive: true });
  const base = { schemaVersion: GATE_RESULT_SCHEMA, gate: cellRun.gate.id, cell: cellRun.cell, catalogueDigest: plan.catalogueDigest, headSha: plan.headSha, treeId: plan.treeId } as const;
  const identity = (environment.identity ?? defaultIdentity)(environment.repositoryRoot);
  if (identity.headSha !== plan.headSha || identity.treeId !== plan.treeId) {
    const result: GateResult = deepFreeze({
      ...base,
      status: "failed",
      refusal: `the job's tree (${String(identity.headSha)} / ${String(identity.treeId)}) is not the planned tree (${plan.headSha} / ${plan.treeId})`,
      startedAt,
      finishedAt: now().toISOString(),
      steps: [],
    });
    tell(`${cellRun.cell}: refused: ${result.refusal!}`);
    writeResult(environment.outDirectory, result);
    return result;
  }
  const steps: StepOutcome[] = [];
  const logs = new Map<string, string>();
  let ok = true;
  for (const entry of cellRun.commands) {
    const declared = registryCommand(environment.registry, entry.name);
    const extra = entry.extra(logs);
    const command: CheckoutCommand = extra.length === 0 ? declared : { ...declared, argv: [...declared.argv, ...extra] };
    tell(`${cellRun.cell}: ${entry.name}: ${command.argv.join(" ")} (in ${command.cwd})`);
    const step = await environment.run(entry.name, command);
    for (const line of [step.message, ...step.details]) tell(`${cellRun.cell}: ${entry.name}: ${line}`);
    steps.push(outcomeOf(step));
    if (step.evidence?.logPath !== undefined) logs.set(entry.name, step.evidence.logPath);
    if (step.status !== "pass") {
      ok = false;
      break;
    }
  }
  const finished = cellRun.finish?.({ ok }) ?? {};
  const status = ok && finished.refusal === undefined ? "passed" : "failed";
  const result: GateResult = deepFreeze({
    ...base,
    status,
    ...(finished.refusal === undefined ? {} : { refusal: finished.refusal }),
    startedAt,
    finishedAt: now().toISOString(),
    steps,
    ...(finished.suite === undefined ? {} : { suite: finished.suite }),
  });
  tell(`${cellRun.cell}: ${status}${finished.refusal === undefined ? "" : ` (${finished.refusal})`}`);
  writeResult(environment.outDirectory, result);
  return result;
}

/** Runs the light gate `gateId` of the plan's catalogue. */
export async function runLightGate(plan: GatePlan, gateId: string, environment: RunEnvironment, catalogue: readonly Gate[] = GATE_CATALOGUE): Promise<GateResult> {
  const gate = gateById(gateId, catalogue);
  if (gate.class !== "light") throw new InputError(`gate ${gateId} is a ${gate.class} gate; only a light gate runs as one command list (a suite runs by cell)`, "gate_not_runnable");
  if (!plan.gates.some((entry) => entry.id === gateId)) throw new InputError(`gate ${gateId} is not in the plan`, "gate_not_planned");
  return runCell(plan, {
    gate,
    cell: gate.id,
    commands: gate.commands.map((entry) => ({
      name: entry.command,
      extra: (logs) => {
        if (entry.logOf === undefined) return [];
        const log = logs.get(entry.logOf);
        if (log === undefined) throw new InputError(`${entry.command} takes the log of ${entry.logOf}, which kept none`, "gate_log_missing");
        return [log];
      },
    })),
  }, environment);
}

/** The engine summary the engine runner writes, repository-relative. */
export const ENGINE_SUMMARY_PATH = "engine/.bridlewise/state/test-results/latest-summary.json";

/**
 * WHAT A RED ENGINE CELL SAID, from the runner's one summary: each failing
 * test with its first error (the summary records it, redacted), then the
 * runner's reasons. A hosted-runner red is read here, never re-run (#149).
 */
export function engineFailureReport(summary: Readonly<Record<string, unknown>>): readonly string[] {
  const failures = Array.isArray(summary.failures) ? summary.failures.filter((entry): entry is string => typeof entry === "string") : [];
  const messages = typeof summary.failureMessages === "object" && summary.failureMessages !== null ? summary.failureMessages as Readonly<Record<string, unknown>> : {};
  const reasons = Array.isArray(summary.reasons) ? summary.reasons.filter((entry): entry is string => typeof entry === "string") : [];
  return [
    ...failures.flatMap((identity) => {
      const message = messages[identity];
      return [`FAILED ${identity}`, ...(typeof message === "string" ? message.split("\n").map((line) => `    ${line}`) : ["    (the runner recorded no message for this failure)"])];
    }),
    ...reasons.map((reason) => `reason: ${reason}`),
  ];
}

function engineFinish(repositoryRoot: string, outDirectory: string, cell: ShardCell, population: string, tell: (line: string) => void): (outcome: Readonly<{ ok: boolean }>) => Readonly<{ refusal?: string; suite?: SuiteOutcome }> {
  return ({ ok }) => {
    const path = join(repositoryRoot, ENGINE_SUMMARY_PATH);
    if (!existsSync(path)) return ok ? { refusal: `the engine runner exited 0 but wrote no summary at ${ENGINE_SUMMARY_PATH}` } : {};
    // The runner's summary travels with the result, passed or failed, and its failures are told with their
    // messages (the log withholds a diagnostic line too long to redact whole; the summary keeps it, redacted).
    copyFileSync(path, join(outDirectory, `${cell.cell}.engine-summary.json`));
    const summary = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    for (const line of engineFailureReport(summary)) tell(`${cell.cell}: ${line}`);
    if (!ok) return {};
    // A cell's summary: its own rule's status (the runner's cell judgement), the whole inventory discovered,
    // and the cell's dispatched tests passed (the withheld rest is counted skipped, by design).
    if (summary.status !== "passed") return { refusal: `the engine summary says ${String(summary.status)}` };
    const passed = summary.passCount;
    if (typeof passed !== "number" || !Number.isSafeInteger(passed) || passed <= 0 || summary.failCount !== 0) {
      return { refusal: `the engine cell's summary records no passed test or a failure (${String(passed)} passed, ${String(summary.failCount)} failed)` };
    }
    return { suite: { population, files: cell.files, tests: passed, perFile: [] } };
  };
}

/** Runs the cell `cellId` of the plan. */
export async function runShard(plan: GatePlan, cellId: string, environment: RunEnvironment, catalogue: readonly Gate[] = GATE_CATALOGUE): Promise<GateResult> {
  const cell = plan.cells.find((candidate) => candidate.cell === cellId);
  if (cell === undefined) throw new InputError(`no cell ${JSON.stringify(cellId)} in the plan (known: ${plan.cells.map((entry) => entry.cell).join(", ")})`, "gate_not_planned");
  const gate = gateById(cell.gate, catalogue);
  const population = gate.population!;
  const name = gate.cellCommand!;
  if (population === "web-tests") {
    const reportPath = join(environment.outDirectory, `${cell.cell}.vitest.json`);
    return runCell(plan, {
      gate,
      cell: cell.cell,
      commands: [{ name, extra: () => [`--outputFile=${reportPath}`, ...cell.files] }],
      finish: ({ ok }) => {
        if (!existsSync(reportPath)) return ok ? { refusal: "the web runner exited 0 but wrote no vitest report" } : {};
        const judged = judgeVitestReport(JSON.parse(readFileSync(reportPath, "utf8")), environment.repositoryRoot, cell.files);
        if (!judged.ok) return { refusal: judged.refusal };
        return { suite: { population, files: cell.files, tests: judged.tests, perFile: judged.files } };
      },
    }, environment);
  }
  // The engine cell: its sources (engine-relative, as the inventory names them) listed for the runner's `--cell`.
  mkdirSync(environment.outDirectory, { recursive: true });
  const listPath = join(environment.outDirectory, `${cell.cell}.cell`);
  writeFileSync(listPath, `${cell.files.map((path) => path.replace(/^engine\//u, "")).join("\n")}\n`);
  return runCell(plan, { gate, cell: cell.cell, commands: [{ name, extra: () => [listPath] }], finish: engineFinish(environment.repositoryRoot, environment.outDirectory, cell, population, environment.tell ?? (() => undefined)) }, environment);
}
