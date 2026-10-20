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
 *   1. duplicate derivation       a second module divides load by CPU count;
 *   2. zero-for-absent            the ambient-load producer falls back to 0;
 *   3. unregistered gate metric   a new `gate:` literal appears in a
 *                                 measurement-producing source;
 *   4. agnostic without proof     an entry claims agnostic with no
 *                                 normalisation;
 *   5. unregistered producer      a consumer's imported module exports a new
 *                                 measurement producer the registry omits.
 *
 * ── LIVENESS ─────────────────────────────────────────────────────────────
 *
 * The clean arm asserts a populated registry (23 metrics, 13 budgets, a
 * declared gate universe) and the producer universe discovers the shared
 * producers rather than passing because it looked at nothing. The plant arms
 * assert the EXACT failure code, not merely that something failed.
 */
import { expect, test } from "vitest";
import { resolve } from "node:path";

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
  expect(report.checked.producers).toBeGreaterThanOrEqual(10);
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

test("a zero fallback for an unreadable measurement is refused", () => {
  const source = WORLD.sources.get("engine/src/shared/ambient-load.ts");
  expect(source).toBeDefined();
  // The plant keeps the declared derivation but turns the unreadable load
  // sample into 0 — the exact historical shape that made a budget pass a
  // suite that lacked the reading.
  const planted = source!.replace("load1: toThousandths(load1 / cpuCount),", "load1: toThousandths(load1 / cpuCount) || 0,");
  expect(planted).not.toBe(source);
  const codes = failuresWith(withSource(WORLD, "engine/src/shared/ambient-load.ts", planted));
  expect(codes).toContain("zero-as-absent");
});

test("a gate that judges an unregistered measurement is a refusal, not a warning", () => {
  const source = WORLD.sources.get("engine/src/shared/run-history.ts");
  expect(source).toBeDefined();
  const planted = `${source}\nconst plantGate = { gate: "mystery-measurement", kind: "pass" };\n`;
  const codes = failuresWith(withSource(WORLD, "engine/src/shared/run-history.ts", planted));
  expect(codes).toContain("unregistered-gate");
});

test("an agnostic load claim with no normalisation step is refused", () => {
  const registry = MEASUREMENT_REGISTRY.map((entry): MetricEntry => entry.name === "perf.profile.measuredSurfaceHash"
    ? { ...entry, load: { kind: "agnostic", normalization: "", proof: "" } }
    : entry);
  const codes = failuresWith(WORLD, registry);
  expect(codes).toContain("agnostic-without-normalization");
});

test("a new measurement producer read by a consumer cannot slip past the registry", () => {
  const source = WORLD.sources.get("engine/src/shared/ambient-load.ts");
  expect(source).toBeDefined();
  const planted = `${source}\nexport function readPlantLatencyMs(): number {\n  return performance.now();\n}\n`;
  const codes = failuresWith(withSource(WORLD, "engine/src/shared/ambient-load.ts", planted));
  expect(codes).toContain("unregistered-producer");
});

test("a deleted producer is named, not silently accepted", () => {
  const codes = failuresWith(withoutSource(WORLD, "engine/src/shared/ambient-load.ts"));
  expect(codes).toContain("producer-missing");
});
