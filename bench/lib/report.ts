/**
 * Bench report accumulation + emission.
 *
 * A run produces ONE JSON document (machine conditions + every measurement)
 * and ONE printed table. The JSON is the regression guard's input: a later
 * run can be diffed against a stored baseline mechanically, which is the
 * whole reason this harness is committed rather than thrown away.
 *
 * Report identity: `suite/case` names must be STABLE across runs. A renamed
 * case looks like a new measurement and breaks the diff, so names are
 * treated as part of the contract.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Stats } from "./stats.ts";
import { ms, band, BUDGET } from "./stats.ts";
import { snapshotMachine, machineLine, type MachineSnapshot } from "./machine.ts";

export type Measurement = {
  readonly suite: string;
  readonly name: string;
  /** Free-form scale descriptor, e.g. "10k messages" — part of the identity. */
  readonly scale: string;
  readonly stats: Stats;
  /** Optional payload weight in bytes, when the case measures a response. */
  readonly bytes?: number;
  /** Optional row/item count the case processed — for per-item math. */
  readonly items?: number;
  /** Which latency budget this case is judged against. */
  readonly budgetMs?: number;
  /** Anything the case wants recorded alongside the number. */
  readonly notes?: string;
};

export type BenchReport = {
  readonly version: 1;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly machineBefore: MachineSnapshot;
  readonly machineAfter: MachineSnapshot;
  readonly gitHead: string;
  readonly measurements: readonly Measurement[];
};

export class Reporter {
  private readonly measurements: Measurement[] = [];
  private readonly machineBefore = snapshotMachine();
  private readonly startedAt = new Date().toISOString();

  private readonly gitHead: string;

  constructor(gitHead: string = "unknown") {
    this.gitHead = gitHead;
    if (!this.machineBefore.quiet) {
      console.warn(
        "\n!! MACHINE NOT QUIET — numbers below include contention !!\n" +
          `   ${this.machineBefore.quietNote}\n` +
          "   Treat these as an upper bound, not as product latency.\n",
      );
    }
    console.log(`machine: ${machineLine(this.machineBefore)}\n`);
  }

  add(m: Measurement): void {
    this.measurements.push(m);
    const b = m.budgetMs ?? BUDGET.VIEW_MS;
    const verdict = m.stats.p95Ms <= b ? "ok  " : "OVER";
    const perItem =
      m.items && m.items > 0 ? ` ${((m.stats.p50Ms / m.items) * 1000).toFixed(1)}µs/item` : "";
    console.log(
      `  ${verdict} ${m.suite}/${m.name} [${m.scale}] ` +
        `p50=${ms(m.stats.p50Ms)} p95=${ms(m.stats.p95Ms)} p99=${ms(m.stats.p99Ms)} ` +
        `max=${ms(m.stats.maxMs)} n=${m.stats.n} ${band(m.stats.p95Ms)}${perItem}` +
        (m.bytes !== undefined ? ` ${(m.bytes / 1024).toFixed(1)}KB` : "") +
        (m.stats.meaningful ? "" : " (AT NOISE FLOOR)"),
    );
    if (m.notes) console.log(`       ${m.notes}`);
  }

  /** Record a non-latency observation (a size, a count) as a note-only row. */
  note(suite: string, name: string, text: string): void {
    console.log(`  note ${suite}/${name}: ${text}`);
  }

  finish(outPath: string): BenchReport {
    const report: BenchReport = {
      version: 1,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      machineBefore: this.machineBefore,
      machineAfter: snapshotMachine(),
      gitHead: this.gitHead,
      measurements: this.measurements,
    };
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
    console.log(`\nreport written: ${outPath}`);
    return report;
  }
}

/** Load a previously written report, for baseline diffing. */
export function loadReport(path: string): BenchReport | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as BenchReport;
}

/**
 * Diff two reports on p95, keyed by suite/name/scale. Returns rows sorted
 * worst-regression-first. This is the regression guard's core: a CI check
 * fails when any row regresses beyond a tolerance.
 */
export function diffReports(
  baseline: BenchReport,
  current: BenchReport,
): ReadonlyArray<{
  readonly key: string;
  readonly baselineP95Ms: number;
  readonly currentP95Ms: number;
  readonly ratio: number;
}> {
  const key = (m: Measurement): string => `${m.suite}/${m.name}[${m.scale}]`;
  const base = new Map(baseline.measurements.map((m) => [key(m), m]));
  const rows: Array<{ key: string; baselineP95Ms: number; currentP95Ms: number; ratio: number }> = [];
  for (const m of current.measurements) {
    const b = base.get(key(m));
    if (!b) continue;
    rows.push({
      key: key(m),
      baselineP95Ms: b.stats.p95Ms,
      currentP95Ms: m.stats.p95Ms,
      ratio: b.stats.p95Ms > 0 ? m.stats.p95Ms / b.stats.p95Ms : Number.NaN,
    });
  }
  rows.sort((a, b) => b.ratio - a.ratio);
  return rows;
}

/** Default output directory for reports (gitignored artefacts). */
export const BENCH_OUT_DIR = join(process.cwd(), "bench", ".out");
