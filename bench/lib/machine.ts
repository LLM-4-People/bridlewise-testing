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

import { cpus, totalmem, freemem, arch, platform, release } from "node:os";
import { execFileSync } from "node:child_process";

import { readAmbientLoadPerCpu } from "../../engine/src/shared/ambient-load.ts";

export type MachineSnapshot = {
  readonly at: string;
  readonly platform: string;
  readonly release: string;
  readonly arch: string;
  readonly cpuModel: string;
  /** Null when the OS would not answer; absence is never a zero. */
  readonly cpuCount: number | null;
  readonly load1: number | null;
  readonly load5: number | null;
  readonly load15: number | null;
  /**
   * The shared ambient reading's 1-minute leg per CPU — the SAME producer the
   * suite runner and the budget reporter read. This module used to divide
   * `l1 / cores.length` itself (and to default an unreadable sample to 0),
   * which was a second derivation of a registered quantity.
   */
  readonly loadPerCpu: number | null;
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
  // ONE ambient reading, from the shared producer: the raw legs are recorded
  // as read and the per-CPU figure is the producer's division, never a local
  // one. An unreadable sample or CPU count is null, and the quiet verdict is
  // then withheld (a box whose load could not be read is not shown as quiet).
  const ambient = readAmbientLoadPerCpu();
  const loads = ambient.loads;
  const perCpu = ambient.perCpu?.load1 ?? null;
  // The quiet bar: less than half a core of ambient load per CPU, and no
  // single non-bench process burning a whole core.
  const top = topProcesses(8);
  const hotOther = top.filter((line) => {
    const parts = line.split(" ");
    const pcpu = Number(parts[1] ?? 0);
    const pid = Number(parts[0] ?? 0);
    return pcpu > 80 && pid !== process.pid;
  });
  const quiet = perCpu !== null && perCpu < 0.5 && hotOther.length === 0;
  const notes: string[] = [];
  if (perCpu === null) notes.push("ambient load unreadable (loadavg or CPU count absent)");
  else if (perCpu >= 0.5) notes.push(`load1/cpu = ${perCpu.toFixed(2)} (>= 0.50)`);
  if (hotOther.length > 0) notes.push(`hot processes: ${hotOther.join("; ")}`);

  return {
    at: new Date().toISOString(),
    platform: platform(),
    release: release(),
    arch: arch(),
    cpuModel: cores[0]?.model ?? "unknown",
    cpuCount: ambient.cpuCount,
    load1: loads?.[0] ?? null,
    load5: loads?.[1] ?? null,
    load15: loads?.[2] ?? null,
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
  const cores = m.cpuCount === null ? "cores not measured" : `${String(m.cpuCount)} cores`;
  const legs =
    m.load1 === null || m.load5 === null || m.load15 === null
      ? "load not measured"
      : `load ${m.load1.toFixed(2)}/${m.load5.toFixed(2)}/${m.load15.toFixed(2)}`;
  const perCpu = m.loadPerCpu === null ? "ambient/cpu not measured" : `${m.loadPerCpu.toFixed(2)}/cpu`;
  return (
    `${m.platform} ${m.arch} · ${cores} · node ${m.nodeVersion} · ` +
    `${legs} (${perCpu}) · free ${m.freeMemMb}MB · ` +
    `${m.quiet ? "QUIET" : "NOT QUIET — " + m.quietNote}`
  );
}
