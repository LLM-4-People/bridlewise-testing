/**
 * Machine-condition capture.
 *
 * A latency number without its machine conditions is not evidence. This
 * module snapshots the conditions BEFORE and AFTER every bench run and
 * stamps them into the report, so a slow number on a saturated box can
 * never be mistaken for a product defect.
 *
 * It also computes a `quiet` verdict: whether the machine was calm enough
 * for the numbers to mean anything. The bench prints a loud banner when it
 * is not, rather than silently producing numbers that look like findings.
 */

import { cpus, loadavg, totalmem, freemem, arch, platform, release } from "node:os";
import { execFileSync } from "node:child_process";

export type MachineSnapshot = {
  readonly at: string;
  readonly platform: string;
  readonly release: string;
  readonly arch: string;
  readonly cpuModel: string;
  readonly cpuCount: number;
  readonly load1: number;
  readonly load5: number;
  readonly load15: number;
  /** load1 divided by cpu count — >0.5 means meaningful contention. */
  readonly loadPerCpu: number;
  readonly totalMemMb: number;
  readonly freeMemMb: number;
  readonly nodeVersion: string;
  /** Top CPU consumers at snapshot time, "pid pcpu comm" strings. */
  readonly topProcesses: readonly string[];
  /** True when the box looks calm enough to trust sub-10ms numbers. */
  readonly quiet: boolean;
  /** Human explanation when `quiet` is false. */
  readonly quietNote: string;
};

function topProcesses(limit: number): readonly string[] {
  try {
    const out = execFileSync(
      "ps",
      ["-eo", "pid,pcpu,comm", "--sort=-pcpu"],
      { encoding: "utf8", timeout: 5000 },
    );
    return out
      .trim()
      .split("\n")
      .slice(1, limit + 1)
      .map((line) => line.trim().replace(/\s+/g, " "));
  } catch {
    return [];
  }
}

export function snapshotMachine(): MachineSnapshot {
  const cores = cpus();
  const [l1 = 0, l5 = 0, l15 = 0] = loadavg();
  const perCpu = cores.length > 0 ? l1 / cores.length : l1;
  // The quiet bar: less than half a core of ambient load per CPU, and no
  // single non-bench process burning a whole core.
  const top = topProcesses(8);
  const hotOther = top.filter((line) => {
    const parts = line.split(" ");
    const pcpu = Number(parts[1] ?? 0);
    const pid = Number(parts[0] ?? 0);
    return pcpu > 80 && pid !== process.pid;
  });
  const quiet = perCpu < 0.5 && hotOther.length === 0;
  const notes: string[] = [];
  if (perCpu >= 0.5) notes.push(`load1/cpu = ${perCpu.toFixed(2)} (>= 0.50)`);
  if (hotOther.length > 0) notes.push(`hot processes: ${hotOther.join("; ")}`);

  return {
    at: new Date().toISOString(),
    platform: platform(),
    release: release(),
    arch: arch(),
    cpuModel: cores[0]?.model ?? "unknown",
    cpuCount: cores.length,
    load1: l1,
    load5: l5,
    load15: l15,
    loadPerCpu: perCpu,
    totalMemMb: Math.round(totalmem() / 1024 / 1024),
    freeMemMb: Math.round(freemem() / 1024 / 1024),
    nodeVersion: process.version,
    topProcesses: top,
    quiet,
    quietNote: notes.length > 0 ? notes.join(" | ") : "machine looks quiet",
  };
}

/** One line summarising conditions, for the top of a printed report. */
export function machineLine(m: MachineSnapshot): string {
  return (
    `${m.platform} ${m.arch} · ${m.cpuCount} cores · node ${m.nodeVersion} · ` +
    `load ${m.load1.toFixed(2)}/${m.load5.toFixed(2)}/${m.load15.toFixed(2)} ` +
    `(${m.loadPerCpu.toFixed(2)}/cpu) · free ${m.freeMemMb}MB · ` +
    `${m.quiet ? "QUIET" : "NOT QUIET — " + m.quietNote}`
  );
}
