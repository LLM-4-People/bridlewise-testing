/**
 * THE RUN-START AMBIENT LOAD — one reading, per CPU, or explicit absence.
 *
 * ── WHY THIS IS A SHARED OWNER AND NOT TWO DIVISIONS ─────────────────────
 *
 * The suite runner (`engine/scripts/tooling/run-tests.ts`) and the web budget
 * reporter (`tests/reporters/budget-reporter.ts`) both record the ambient
 * load at the moment a run starts. They used to spell the conversion
 * independently:
 *
 *     loads[0] / cpuCount                (run-tests.ts)
 *     this.loadAtStart / cpuCount        (budget-reporter.ts)
 *
 * Two files, one number, two chances to disagree about the CPU count, the
 * rounding, or what to do when `loadavg()` cannot answer. The measurement
 * contract calls that second derivation a defect; the registry
 * (`measurement-registry.ts`) names THIS function as the one producer and the
 * duplicate-derivation guard scans the tree for another loading of the same
 * pair.
 *
 * ── ABSENT, NEVER ZERO ───────────────────────────────────────────────────
 *
 * `loadavg()` answers all three legs or none on the platforms Node supports,
 * but the shape is still a sample of the OUTSIDE world. When it cannot be
 * read — or when the CPU count cannot be established — this function returns
 * `perCpu: null`. It never substitutes `0`, because a zero load reading is a
 * claim that the box was idle and the verdict would consume it as one. The
 * one-minute leg is also a decaying average sampled before the run, so it is
 * a COVARIATE (recorded, and consumed by the declared ambient-inflation
 * envelope), not a normaliser; see `budget-verdict.ts` for that model.
 *
 * The count itself is not a duration and does not depend on load: it is
 * reported beside the legs so a consumer can divide by the machine it
 * actually measured on, never by a constant.
 */
import { cpus, loadavg } from "node:os";

/** The three load-average legs, per CPU, rounded to the recorded precision. */
export interface AmbientLoadPerCpu {
  readonly load1: number;
  readonly load5: number;
  readonly load15: number;
}

/**
 * One run-start ambient reading. `perCpu` is null when the load sample (or
 * the CPU count) is unreadable; `cpuCount` is null only when the machine's
 * CPU count itself cannot be read. Neither absence is a zero.
 */
export interface AmbientLoadReading {
  readonly cpuCount: number | null;
  readonly perCpu: AmbientLoadPerCpu | null;
}

/** Three decimal places, the ledger's recorded precision (not a measurement). */
function toThousandths(value: number): number {
  return Number(value.toFixed(3));
}

/**
 * Read the run-start load once, all three legs from the same sample.
 *
 * The injection points exist so a guard can drive unreadable samples without
 * a machine that has no `/proc`; production callers use the defaults.
 */
export function readAmbientLoadPerCpu(
  readLoads: () => readonly number[] = loadavg,
  readCpuCount: () => number = () => cpus().length,
): AmbientLoadReading {
  let cpuCount: number | null;
  try {
    const count = readCpuCount();
    cpuCount = Number.isSafeInteger(count) && count > 0 ? count : null;
  } catch {
    cpuCount = null;
  }
  let loads: readonly number[];
  try {
    loads = readLoads();
  } catch {
    return { cpuCount, perCpu: null };
  }
  if (!Array.isArray(loads) || loads.length < 3) return { cpuCount, perCpu: null };
  const [load1, load5, load15] = loads;
  if (
    !Number.isFinite(load1) || load1 < 0
    || !Number.isFinite(load5) || load5 < 0
    || !Number.isFinite(load15) || load15 < 0
    || cpuCount === null
  ) {
    return { cpuCount, perCpu: null };
  }
  return {
    cpuCount,
    perCpu: {
      load1: toThousandths(load1 / cpuCount),
      load5: toThousandths(load5 / cpuCount),
      load15: toThousandths(load15 / cpuCount),
    },
  };
}
