/**
 * A REPRODUCTION SHIM for the engine runner (`harness flake reproduce
 * --preload engine/test/support/flake-shim-cpu-frequency-scaling.ts`, the
 * FLAKE-REPRO decision): every `os.cpus()` call answers the real CPUs with a
 * current clock speed that alternates between two values, 1200 and 3400 MHz.
 * It recreates, on any machine and every run, what frequency scaling does on
 * a hosted runner between two calls in one process (#429): the speed Linux
 * reports is the core's CURRENT frequency, and it moves. The CPU list,
 * models and counts are untouched: only the instantaneous speed varies.
 *
 * Preloaded into every test file's process of a reproduction run; never
 * imported by a test.
 */
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";

const SCALED_SPEEDS_MHZ = [1200, 3400] as const;
const real = os.cpus.bind(os);
let calls = 0;
os.cpus = (): os.CpuInfo[] => {
  const speed = SCALED_SPEEDS_MHZ[calls % SCALED_SPEEDS_MHZ.length]!;
  calls += 1;
  return real().map((cpu) => ({ ...cpu, speed }));
};
// The named ESM export (`import { cpus } from "node:os"`) follows the patched one.
syncBuiltinESMExports();
