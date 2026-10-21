// @vitest-environment node
/**
 * THE MEASUREMENT CONTRACT, REPO-WIDE — one guard over every judged,
 * recorded or quoted signal.
 *
 * ── THE CLASS ─────────────────────────────────────────────────────────────
 *
 * A signal the floor judges is only evidence if it is:
 *
 *   DYNAMIC        derived from the run's own facts;
 *   RESILIENT      absent, never zero, when unreadable, and never silently
 *                  swapped for another quantity;
 *   LOAD-AGNOSTIC  or declares its sensitivity and the bound past which the
 *                  verdict defers;
 *   SINGLE-OWNER   computed once at the lowest chokepoint and read by every
 *                  consumer from there.
 *
 * Each clause used to be prose beside the code. The registry
 * (`engine/src/shared/measurement-registry.ts`) is now the declaration and
 * the checker (`engine/scripts/verification/measurement-contract.ts`) is the
 * mechanical half. This file drives the checker over the real tree and over
 * in-memory plants, never over a tracked source file (two guards once chose
 * the same canary and raced it to zero bytes).
 *
 * ── THE PLANTS (each must produce its named failure) ─────────────────────
 *
 *   1. duplicate derivation       a second module divides load by CPU count,
 *                                 INCLUDING one hidden behind a regex literal;
 *   2. zero-for-absent            the ambient-load producer returns a zero
 *                                 measurement from its unreadable branch;
 *   3. unregistered gate metric   a new `gate:` literal appears in a new file
 *                                 and in single-quoted / template spellings;
 *   4. agnostic without proof     an entry claims agnostic with no
 *                                 normalisation;
 *   5. unregistered producer      a module outside the old four prefixes
 *                                 exports a measurement producer a consumer
 *                                 imports;
 *   6. forbidden quantity         a producer whose return type is an object
 *                                 still has its BODY read;
 *   7. the shard weight producer  inserting `cpuUsage(` into the function
 *                                 that subtracts the timestamps is refused.
 *
 * ── LIVENESS ─────────────────────────────────────────────────────────────
 *
 * The clean arm asserts a populated registry (24 metrics, 13 budgets, a
 * declared gate universe) and the producer universe discovers the shared
 * producers rather than passing because it looked at nothing. The plant arms
 * assert the EXACT failure code, not merely that something failed.
 */
import { expect, test } from "vitest";
import { resolve } from "node:path";

import { readAmbientLoadPerCpu } from "../../engine/src/shared/ambient-load.ts";
import { modulePathMatching } from "../helpers/module-resolver.ts";

import {
  CPU_METRIC_PLACEHOLDERS,
  MEASUREMENT_FINDINGS,
  MEASUREMENT_REGISTRY,
  type MetricEntry,
} from "../../engine/src/shared/measurement-registry.ts";
import {
  loadMeasurementWorld,
  validateMeasurementContract,
  withSource,
  withoutSource,
} from "../../engine/scripts/verification/measurement-contract.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const WORLD = loadMeasurementWorld(ROOT);

function failuresWith(world = WORLD, registry: readonly MetricEntry[] = MEASUREMENT_REGISTRY): string[] {
  return validateMeasurementContract(world, { registry }).failures.map((failure) => failure.code);
}

test("the clean tree satisfies every clause, and the guard looked at a populated universe", () => {
  const report = validateMeasurementContract(WORLD);
  expect(report.failures).toEqual([]);
  // LIVENESS: an empty registry, an unread tree or a zero-gate scan would
  // satisfy "no failures" trivially. The declared and discovered populations
  // must be populated.
  expect(report.checked.metrics).toBeGreaterThanOrEqual(20);
  expect(report.checked.budgets).toBe(13);
  expect(report.checked.sources).toBeGreaterThan(500);
  expect(report.checked.gates).toBeGreaterThanOrEqual(10);
  // The REGISTERED count and the DISCOVERED universe are reported apart: a
  // sum of the two cannot tell "the scan found nothing" from "the scan found
  // only registered producers", which is exactly how this assertion passed
  // while the discovery returned zero.
  expect(report.checked.registeredProducers).toBeGreaterThanOrEqual(20);
  expect(report.checked.discoveredProducers.length).toBeGreaterThanOrEqual(3);
  expect(report.checked.discoveredProducers).toContain("engine/src/shared/test-costs.ts::summarizeTestCosts");
  expect(report.checked.discoveredProducers).toContain("scripts/testing/performance-measurements.ts::performanceMeasurements");
  // The findings are the honest load-sensitivity record, not failures.
  const findingIds = report.findings.map((finding) => finding.id);
  expect(findingIds).toContain("F-PERF-LATENCY-NO-BOUND");
  expect(findingIds).toContain("F-SHARD-WEIGHT-WALL-CLOCK");
  expect(findingIds).toContain("F-AMBIENT-NO-DEFERRAL");
  expect(MEASUREMENT_FINDINGS.every((finding) => finding.detail.length > 100)).toBe(true);
  // The CPU metric is reserved, not guessed: one placeholder, marked, and its
  // stable producer exists.
  expect(CPU_METRIC_PLACEHOLDERS).toHaveLength(1);
  expect(CPU_METRIC_PLACEHOLDERS[0]!.load.kind).toBe("placeholder");
  expect(CPU_METRIC_PLACEHOLDERS[0]!.producer.symbol).toBe("readRunCpu");
});

test("a duplicate derivation of a registered number is refused", () => {
  const plant = withSource(
    WORLD,
    "engine/src/shared/plant-duplicate-derivation.ts",
    "export function readPlantLoad(): number {\n  const loads = loadavg();\n  return loads[0] / cpuCount;\n}\n",
  );
  const codes = failuresWith(plant);
  expect(codes).toContain("duplicate-derivation");
});

test("a duplicate derivation hidden behind a regex literal is still a duplicate", () => {
  // The regex's escaped slash followed by its closing delimiter is `//`. The
  // REMOVED comment stripper was not regex-aware: it read that pair as the
  // start of a line comment and dropped the rest of the line. The duplicate
  // therefore has to sit on THAT line. On a later line the old view still saw
  // it, so the plant proved nothing about the regex fix and passed under both
  // views.
  const plantSource = "const URL_RE = /https?:\\/\\//; export function readPlantLoad(): number { const loads = loadavg(); return loads[0] / 1; }\n";
  const naiveLineComment = plantSource.indexOf("//");
  expect(naiveLineComment).toBeGreaterThan(-1);
  // NEGATIVE CONTROL: the old line-comment read keeps only the prefix before
  // `//`, so it loses the duplicate. If this assertion fails the plant no
  // longer exercises the defect it names.
  expect(plantSource.slice(0, naiveLineComment)).not.toContain("loads[0] / 1");
  // The lexed view keeps the regex literal, so the check still sees it.
  expect(failuresWith(withSource(WORLD, "engine/src/shared/plant-regex-duplicate.ts", plantSource))).toContain("duplicate-derivation");
});

test("a second loadavg() sample is a duplicate even when it never divides", () => {
  // The recorded raw leg is the same ambient fact, not a new quantity: two
  // direct readers used to sample `loadavg()` themselves and their shape
  // (`loadavg()[0]!`) matched none of the division spellings, so the scan
  // could not see them.
  const plant = withSource(
    WORLD,
    "engine/src/shared/plant-direct-load.ts",
    "export function readPlantLoadNow(): number | null {\n  return loadavg()[0] ?? null;\n}\n",
  );
  expect(failuresWith(plant)).toContain("duplicate-derivation");
});

test("the bench's old per-CPU division is a duplicate of the shared producer", () => {
  const bench = WORLD.sources.get("bench/lib/machine.ts");
  expect(bench).toBeDefined();
  const planted = `${bench}\nexport function plantBenchPerCpu(): number {\n  const l1 = 1;\n  const cores = [1, 2];\n  return cores.length > 0 ? l1 / cores.length : l1;\n}\n`;
  expect(failuresWith(withSource(WORLD, "bench/lib/machine.ts", planted))).toContain("duplicate-derivation");
});

test("a bare raw READ is not proof of the declared COMPUTATION", () => {
  // The old declaration was ONE alternative list: `loadavg()` matched it, so
  // a producer that only sampled the load and moved the division to a helper
  // passed the body clause. COMPUTE patterns must match the body; READ
  // patterns are duplicate-scan only.
  const plantPath = "engine/src/shared/plant-read-only-producer.ts";
  const plant = [
    "export function readPlantLoad(): number | null {",
    "  const loads = loadavg();",
    "  return helper(loads, 2) ?? null;",
    "}",
    "function helper(loads: readonly number[], count: number): number | null {",
    "  return loads[0] === undefined ? null : loads[0] / count;",
    "}",
    "",
  ].join("\n");
  const entry: MetricEntry = {
    status: "registered",
    name: "plant.read-only",
    unit: "load",
    family: null,
    distinctFrom: [],
    producer: {
      module: plantPath,
      symbol: "readPlantLoad",
      compute: ["loads\\[0\\]\\s*/\\s*\\w+"],
      reads: ["loadavg\\(\\)"],
      forbids: [],
    },
    consumers: [],
    load: { kind: "sensitive", sensitivity: "host load", bound: null, finding: "F-AMBIENT-NO-DEFERRAL" },
    absent: { kind: "null", reason: "unreadable sample is null" },
    zero: { kind: "not-numeric", reason: "not numeric" },
  };
  const report = validateMeasurementContract(withSource(WORLD, plantPath, plant), {
    registry: [...MEASUREMENT_REGISTRY, entry],
  });
  expect(report.failures.map((failure) => failure.code)).toContain("derivation-not-in-producer");
});

test("a second copy of the formula in ANOTHER FUNCTION of the producer's module is refused", () => {
  // The duplicate scan used to skip the whole producer module, so the one
  // legitimate spelling and a planted second copy in a sibling function were
  // equally invisible. Only the producer symbol's own body span is exempt.
  const producerPath = modulePathMatching("ambient-load.ts");
  const source = WORLD.sources.get(producerPath);
  expect(source).toBeDefined();
  const planted = `${source}\nexport function plantSecondDivision(load1: number, cpuCount: number): number {\n  return load1 / cpuCount;\n}\n`;
  expect(failuresWith(withSource(WORLD, producerPath, planted))).toContain("duplicate-derivation");
});

test("an undeclared consumer of a registered producer is refused (the clause is total)", () => {
  // The declared consumer list is held complete by the import universe: a
  // module that imports or calls the producer symbol must say what it reads.
  // Removing the bench's declaration makes its import an undeclared use.
  const ambient = MEASUREMENT_REGISTRY.find((entry) => entry.name === "ambient.load.perCpu");
  expect(ambient).toBeDefined();
  const withoutBench: MetricEntry = {
    ...ambient!,
    consumers: ambient!.consumers.filter((consumer) => !("source" in consumer) || consumer.source !== "bench/lib/machine.ts"),
  };
  const registry = [...MEASUREMENT_REGISTRY.filter((entry) => entry.name !== "ambient.load.perCpu"), withoutBench];
  const failures = validateMeasurementContract(WORLD, { registry }).failures;
  expect(failures.map((failure) => failure.code)).toContain("undeclared-consumer");
  expect(
    failures.find((failure) => failure.code === "undeclared-consumer")?.message,
    "the refusal names the module whose use is undeclared",
  ).toContain("bench/lib/machine.ts");
});

test("a producer's body is read, not its object return type", () => {
  const plantPath = "engine/src/shared/plant-object-return.ts";
  const plant = `export function readPlantLoad(): Readonly<{ value: number | null }> { const loads = loadavg(); return { value: loads[0] ?? null }; }\n`;
  const entry: MetricEntry = {
    status: "registered",
    name: "plant.load",
    unit: "load",
    family: null,
    distinctFrom: [],
    producer: { module: plantPath, symbol: "readPlantLoad", compute: ["loads\\[0\\]"], reads: [], forbids: ["loadavg("] },
    consumers: [],
    load: { kind: "sensitive", sensitivity: "host load", bound: null, finding: "F-AMBIENT-NO-DEFERRAL" },
    absent: { kind: "null", reason: "unreadable sample is null" },
    zero: { kind: "not-numeric", reason: "not numeric" },
  };
  const codes = failuresWith(withSource(WORLD, plantPath, plant), [...MEASUREMENT_REGISTRY, entry]);
  expect(codes).toContain("forbidden-quantity");
});

test("a producer body is read through its code view, so a comment cannot keep the formula alive", () => {
  // The real computation moved to a helper; the named producer only delegates
  // and leaves the old formula in a COMMENT. Reading the raw body (comments
  // included) satisfied `derivation` here and certified a producer that no
  // longer computes the declared quantity. The module still spells the
  // arithmetic in `helper`, so only the body arm can refuse this plant.
  const plantPath = "engine/src/shared/plant-comment-producer.ts";
  const plant = [
    "export function readPlantLoad(): number | null {",
    "  // the formula this producer used to compute: widgets[0] / count",
    "  return helper() ?? null;",
    "}",
    "export function helper(): number | null {",
    "  const widgets = [1, 2];",
    "  return widgets[0] / 2;",
    "}",
    "",
  ].join("\n");
  const entry: MetricEntry = {
    status: "registered",
    name: "plant.load.comment",
    unit: "load",
    family: null,
    distinctFrom: [],
    producer: { module: plantPath, symbol: "readPlantLoad", compute: ["widgets\\[0\\]\\s*/\\s*\\w+"], reads: [], forbids: [] },
    consumers: [],
    load: { kind: "sensitive", sensitivity: "host load", bound: null, finding: "F-AMBIENT-NO-DEFERRAL" },
    absent: { kind: "null", reason: "unreadable sample is null" },
    zero: { kind: "not-numeric", reason: "not numeric" },
  };
  const report = validateMeasurementContract(withSource(WORLD, plantPath, plant), { registry: [...MEASUREMENT_REGISTRY, entry] });
  expect(report.failures.map((failure) => failure.code)).toContain("derivation-not-in-producer");
});

test("a zero assigned to the measurement's own field is a zero-for-absent", () => {
  const source = WORLD.sources.get(modulePathMatching("ambient-load.ts"));
  expect(source).toBeDefined();
  for (const zeroed of [
    "return { cpuCount, loads: null, perCpu: { load1: 0, load5: 0, load15: 0 } };",
    "return { cpuCount, loads: null, perCpu: 0 };",
  ]) {
    const planted = source!.replace("return { cpuCount, loads: null, perCpu: null };", zeroed);
    expect(planted).not.toBe(source);
    expect(failuresWith(withSource(WORLD, modulePathMatching("ambient-load.ts"), planted))).toContain("zero-as-absent");
  }
});

test("the ambient producer's injection points keep an unreadable sample absent", () => {
  expect(readAmbientLoadPerCpu(() => [NaN, 1, 1], () => 8)).toEqual({ cpuCount: 8, loads: null, perCpu: null });
  expect(readAmbientLoadPerCpu(() => { throw new Error("no loadavg"); }, () => 8)).toEqual({ cpuCount: 8, loads: null, perCpu: null });
  expect(readAmbientLoadPerCpu(() => [1, 1, 1], () => { throw new Error("no cpu count"); })).toEqual({ cpuCount: null, loads: [1, 1, 1], perCpu: null });
});

test("a zero fallback for an unreadable measurement is refused", () => {
  const source = WORLD.sources.get(modulePathMatching("ambient-load.ts"));
  expect(source).toBeDefined();
  // The plant keeps the declared derivation but turns the unreadable load
  // sample into 0 — the exact historical shape that made a budget pass a
  // suite that lacked the reading.
  const planted = source!.replace("load1: toThousandths(load1 / cpuCount),", "load1: toThousandths(load1 / cpuCount) || 0,");
  expect(planted).not.toBe(source);
  const codes = failuresWith(withSource(WORLD, modulePathMatching("ambient-load.ts"), planted));
  expect(codes).toContain("zero-as-absent");
});

test("a gate that judges an unregistered measurement is a refusal, not a warning", () => {
  const source = WORLD.sources.get(modulePathMatching("run-history.ts"));
  expect(source).toBeDefined();
  const planted = `${source}\nconst plantGate = { gate: "mystery-measurement", kind: "pass" };\n`;
  const codes = failuresWith(withSource(WORLD, modulePathMatching("run-history.ts"), planted));
  expect(codes).toContain("unregistered-gate");
});

test("a gate in a new file, or in single-quoted or template spelling, is not invisible", () => {
  const inNewFile = withSource(WORLD, "engine/src/process/plant-gate.ts", "export const outcome = { gate: 'plant-single-quoted', kind: 'pass' };\n");
  expect(failuresWith(inNewFile)).toContain("unregistered-gate");
  const template = withSource(WORLD, "engine/scripts/tooling/plant-gate.ts", "export const outcome = { gate: `plant-template`, kind: 'pass' };\n");
  expect(failuresWith(template)).toContain("unregistered-gate");
});

test("an agnostic load claim with no normalisation step is refused", () => {
  const registry = MEASUREMENT_REGISTRY.map((entry): MetricEntry => entry.name === "perf.profile.measuredSurfaceHash"
    ? { ...entry, load: { kind: "agnostic", normalization: "", proof: "" } }
    : entry);
  const codes = failuresWith(WORLD, registry);
  expect(codes).toContain("agnostic-without-normalization");
});

test("a new measurement producer read by a consumer cannot slip past the registry", () => {
  const source = WORLD.sources.get(modulePathMatching("ambient-load.ts"));
  expect(source).toBeDefined();
  const planted = `${source}\nexport function readPlantLatencyMs(): number {\n  return performance.now();\n}\n`;
  const codes = failuresWith(withSource(WORLD, modulePathMatching("ambient-load.ts"), planted));
  expect(codes).toContain("unregistered-producer");
});

test("a measurement producer in a new product area cannot slip past the registry", () => {
  const producerPath = "engine/src/process/plant-producer.ts";
  const consumer = WORLD.sources.get("tests/performance/regression.test.ts");
  expect(consumer).toBeDefined();
  const planted = withSource(
    withSource(WORLD, producerPath, "export function readPlantLatencyMs(): number {\n  return performance.now();\n}\n"),
    "tests/performance/regression.test.ts",
    `${consumer}\nimport { readPlantLatencyMs } from "../../engine/src/process/plant-producer.ts";\nvoid readPlantLatencyMs;\n`,
  );
  expect(failuresWith(planted)).toContain("unregistered-producer");
});

test("the shard weight producer is the function that subtracts the timestamps", () => {
  const source = WORLD.sources.get("scripts/test-shard-manifest.mjs");
  expect(source).toBeDefined();
  const planted = source!.replace(
    "return Math.max(1, Math.round(result.endTime - result.startTime));",
    "const plantCpu = process.cpuUsage(); void plantCpu;\n  return Math.max(1, Math.round(result.endTime - result.startTime));",
  );
  expect(planted).not.toBe(source);
  expect(failuresWith(withSource(WORLD, "scripts/test-shard-manifest.mjs", planted))).toContain("forbidden-quantity");
});

test("a deleted producer is named, not silently accepted", () => {
  const codes = failuresWith(withoutSource(WORLD, modulePathMatching("ambient-load.ts")));
  expect(codes).toContain("producer-missing");
});
