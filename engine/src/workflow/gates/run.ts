/**
 * RUNNING ONE GATE CELL — `harness gates run <gate>` (a light gate) and
 * `harness gates shard <cell>` (one shard of a suite), locally and in CI
 * alike: the same catalogue, the same commands, the same result document.
 *
 * Before anything runs, the job's tree must be the tree the plan was made
 * for (`headSha` and `treeId`): a job that checked out, built or edited
 * something else would otherwise report on a tree nobody planned.
 *
 * Each step is an argument vector spawned without a shell from the
 * repository root, its output forwarded to this process and appended to the
 * cell's log (`<out>/<cell>.log`, the `{gateLog}` placeholder). The first
 * failing step ends the cell. The result (`<out>/<cell>.result.json`,
 * `bridlewise-gate-result/v1`) is written on every ending — passed, failed or
 * refused — so the seal can name what happened rather than only that a file
 * is missing.
 *
 * A web shard runs the web runner (`scripts/run-tests.ts`) on exactly its
 * planned files with vitest's JSON reporter, and passes only when that
 * report's rows record every planned file green (`vitest-report.ts`). The
 * engine suite runs the engine runner on its whole inventory and passes only
 * when the runner exits 0 and its own summary says it passed.
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { InputError } from "../../kernel/errors.ts";
import { canonicalJson, deepFreeze } from "../../kernel/integrity.ts";
import { schemaId } from "../../kernel/product-identity.ts";
import { readMeasuredTree, readRepositoryHeadSha } from "../../shared/tree-identity.ts";
import { GATE_CATALOGUE, gateById, type Gate } from "./catalogue.ts";
import type { GatePlan, ShardCell } from "./plan.ts";
import { judgeVitestReport } from "./vitest-report.ts";

export const GATE_RESULT_SCHEMA = schemaId("gate-result", 1);

export type StepOutcome = Readonly<{ argv: readonly string[]; exitCode: number | null; signal: string | null }>;

export type SuiteOutcome = Readonly<{
  population: string;
  files: readonly string[];
  tests: number;
  /** For a web shard, each file's test count from the judged report; empty for a whole-inventory run. */
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
  /** Why the cell failed without a failing step: a refused identity, a refused report. */
  refusal?: string;
  startedAt: string;
  finishedAt: string;
  steps: readonly StepOutcome[];
  suite?: SuiteOutcome;
}>;

/** The placeholder a step argument uses for the cell's own log. */
export const GATE_LOG_PLACEHOLDER = "{gateLog}";

export type RunEnvironment = Readonly<{
  repositoryRoot: string;
  outDirectory: string;
  /** Spawns one step; injected by tests. Resolves the exit code (null when killed) and signal. */
  spawnStep?: (argv: readonly string[], cwd: string, log: string) => Promise<Readonly<{ exitCode: number | null; signal: string | null }>>;
  /** Reads the job's tree identity; injected by tests. */
  identity?: (repositoryRoot: string) => Readonly<{ headSha: string | null; treeId: string | null }>;
  now?: () => Date;
}>;

function defaultIdentity(repositoryRoot: string): Readonly<{ headSha: string | null; treeId: string | null }> {
  return { headSha: readRepositoryHeadSha(repositoryRoot), treeId: readMeasuredTree(repositoryRoot) };
}

/** Spawns `argv` without a shell, forwarding its output and appending it to `log`. */
function defaultSpawnStep(argv: readonly string[], cwd: string, log: string): Promise<Readonly<{ exitCode: number | null; signal: string | null }>> {
  return new Promise((resolvePromise) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    const forward = (sink: NodeJS.WriteStream) => (chunk: Buffer): void => {
      sink.write(chunk);
      appendFileSync(log, chunk);
    };
    child.stdout.on("data", forward(process.stdout));
    child.stderr.on("data", forward(process.stderr));
    child.on("error", (error) => {
      appendFileSync(log, `gate step did not start: ${error.message}\n`);
      resolvePromise({ exitCode: null, signal: null });
    });
    child.on("close", (code, signal) => resolvePromise({ exitCode: code, signal }));
  });
}

function writeResult(outDirectory: string, result: GateResult): string {
  const path = join(outDirectory, `${result.cell}.result.json`);
  writeFileSync(path, `${canonicalJson(result)}\n`, { mode: 0o644 });
  return path;
}

type CellRun = Readonly<{ gate: Gate; cell: string; steps: readonly (readonly string[])[]; finish?: (outcome: Readonly<{ ok: boolean }>) => Readonly<{ refusal?: string; suite?: SuiteOutcome }> }>;

async function runCell(plan: GatePlan, run: CellRun, environment: RunEnvironment): Promise<GateResult> {
  const now = environment.now ?? (() => new Date());
  const startedAt = now().toISOString();
  mkdirSync(environment.outDirectory, { recursive: true });
  const log = join(environment.outDirectory, `${run.cell}.log`);
  writeFileSync(log, "");
  const base = { schemaVersion: GATE_RESULT_SCHEMA, gate: run.gate.id, cell: run.cell, catalogueDigest: plan.catalogueDigest, headSha: plan.headSha, treeId: plan.treeId } as const;
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
    writeResult(environment.outDirectory, result);
    return result;
  }
  const spawnStep = environment.spawnStep ?? defaultSpawnStep;
  const outcomes: StepOutcome[] = [];
  let ok = true;
  for (const step of run.steps) {
    const argv = step.map((argument) => argument.split(GATE_LOG_PLACEHOLDER).join(log));
    const ended = await spawnStep(argv, environment.repositoryRoot, log);
    outcomes.push({ argv, exitCode: ended.exitCode, signal: ended.signal });
    if (ended.exitCode !== 0) {
      ok = false;
      break;
    }
  }
  const finished = run.finish?.({ ok }) ?? {};
  const status = ok && finished.refusal === undefined ? "passed" : "failed";
  const result: GateResult = deepFreeze({
    ...base,
    status,
    ...(finished.refusal === undefined ? {} : { refusal: finished.refusal }),
    startedAt,
    finishedAt: now().toISOString(),
    steps: outcomes,
    ...(finished.suite === undefined ? {} : { suite: finished.suite }),
  });
  writeResult(environment.outDirectory, result);
  return result;
}

/** Runs the light gate `gateId` of the plan's catalogue. */
export async function runLightGate(plan: GatePlan, gateId: string, environment: RunEnvironment, catalogue: readonly Gate[] = GATE_CATALOGUE): Promise<GateResult> {
  const gate = gateById(gateId, catalogue);
  if (gate.class !== "light") throw new InputError(`gate ${gateId} is a ${gate.class} gate; only a light gate runs as one step list (a suite runs by shard)`, "gate_not_runnable");
  if (!plan.gates.some((entry) => entry.id === gateId)) throw new InputError(`gate ${gateId} is not in the plan`, "gate_not_planned");
  return runCell(plan, { gate, cell: gate.id, steps: gate.steps }, environment);
}

/** The web runner on exactly `files`, writing vitest's JSON report to `reportPath`. */
function webShardSteps(files: readonly string[], reportPath: string): readonly (readonly string[])[] {
  return [["node", "--experimental-strip-types", "scripts/run-tests.ts", "--project=node", "--project=dom", "--reporter=default", "--reporter=json", `--outputFile=${reportPath}`, ...files]];
}

/** The engine summary the engine runner writes, repository-relative. */
export const ENGINE_SUMMARY_PATH = "engine/.bridlewise/state/test-results/latest-summary.json";

function engineFinish(repositoryRoot: string, cell: ShardCell, population: string): (outcome: Readonly<{ ok: boolean }>) => Readonly<{ refusal?: string; suite?: SuiteOutcome }> {
  return ({ ok }) => {
    if (!ok) return {};
    const path = join(repositoryRoot, ENGINE_SUMMARY_PATH);
    if (!existsSync(path)) return { refusal: `the engine runner exited 0 but wrote no summary at ${ENGINE_SUMMARY_PATH}` };
    const summary = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (summary.status !== "passed") return { refusal: `the engine summary says ${String(summary.status)}` };
    const tests = summary.testCount;
    if (typeof tests !== "number" || !Number.isSafeInteger(tests) || tests <= 0 || summary.passCount !== tests || summary.failCount !== 0) {
      return { refusal: `the engine summary's counts are not all passed (${String(summary.passCount)}/${String(tests)}, ${String(summary.failCount)} failed)` };
    }
    return { suite: { population, files: cell.files, tests, perFile: [] } };
  };
}

/** Runs the shard `cellId` of the plan. */
export async function runShard(plan: GatePlan, cellId: string, environment: RunEnvironment, catalogue: readonly Gate[] = GATE_CATALOGUE): Promise<GateResult> {
  const cell = plan.cells.find((candidate) => candidate.cell === cellId);
  if (cell === undefined) throw new InputError(`no cell ${JSON.stringify(cellId)} in the plan (known: ${plan.cells.map((entry) => entry.cell).join(", ")})`, "gate_not_planned");
  const gate = gateById(cell.gate, catalogue);
  const population = gate.population!;
  if (population === "web-tests") {
    const reportPath = join(environment.outDirectory, `${cell.cell}.vitest.json`);
    return runCell(plan, {
      gate,
      cell: cell.cell,
      steps: webShardSteps(cell.files, reportPath),
      finish: ({ ok }) => {
        if (!existsSync(reportPath)) return ok ? { refusal: "the web runner exited 0 but wrote no vitest report" } : {};
        const judged = judgeVitestReport(JSON.parse(readFileSync(reportPath, "utf8")), environment.repositoryRoot, cell.files);
        if (!judged.ok) return { refusal: judged.refusal };
        return { suite: { population, files: cell.files, tests: judged.tests, perFile: judged.files } };
      },
    }, environment);
  }
  if (gate.split !== "whole") throw new InputError(`suite ${gate.id}: the engine runner runs only its whole inventory`, "gate_not_runnable");
  return runCell(plan, { gate, cell: cell.cell, steps: [["npm", "--prefix", "engine", "test"]], finish: engineFinish(environment.repositoryRoot, cell, population) }, environment);
}
