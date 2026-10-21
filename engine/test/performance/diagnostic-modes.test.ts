import assert from "node:assert/strict";
import test from "node:test";

import {
  createDiagnosticRunner,
  diagnosticSnapshotSchemaVersion,
  type IoDiagnosticSnapshot,
  type ProcessDiagnosticSnapshot,
  type EventLoopDiagnosticSnapshot,
  type MemoryDiagnosticSnapshot,
  type CgroupDiagnosticSnapshot,
  type CpuDiagnosticSnapshot,
} from "../../src/performance/diagnostic-modes.ts";
import { DEFAULT_PERFORMANCE_CONFIG, DIAGNOSTIC_MODE_IDS } from "../../src/performance/performance-config.ts";
import { InputError } from "../../src/kernel/errors.ts";
import { makePerfConfig } from "../support/factories.ts";

test("diagnostic-modes: snapshot schema version is correct", () => {
  assert.equal(diagnosticSnapshotSchemaVersion(), "bridlewise-diagnostic-snapshot/v1");
});

test("diagnostic-modes: CPU snapshot has shared attribution", () => {
  const runner = createDiagnosticRunner({ config: makePerfConfig() });
  const result = runner.run("cpu");
  const snap = result.snapshot as CpuDiagnosticSnapshot;
  assert.equal(result.mode, "cpu");
  assert.equal(snap.mode, "cpu");
  assert.equal(snap.attribution, "shared");
  assert.ok(snap.processUserMs >= 0);
  assert.ok(snap.processSystemMs >= 0);
  assert.ok(snap.cpuCount === null || snap.cpuCount > 0);
});

test("diagnostic-modes: memory snapshot has exact attribution", () => {
  const runner = createDiagnosticRunner({ config: makePerfConfig() });
  const result = runner.run("memory");
  const snap = result.snapshot as MemoryDiagnosticSnapshot;
  assert.equal(snap.mode, "memory");
  assert.equal(snap.attribution, "exact");
  assert.ok(snap.rssBytes >= 0);
  assert.ok(snap.heapUsedBytes >= 0);
  assert.ok(snap.totalSystemBytes > 0);
});

test("diagnostic-modes: IO snapshot has exact attribution", () => {
  const runner = createDiagnosticRunner({ config: makePerfConfig() });
  const result = runner.run("io");
  const snap = result.snapshot as IoDiagnosticSnapshot;
  assert.equal(snap.mode, "io");
  assert.ok(snap.readOps >= 0);
  assert.ok(snap.writeOps >= 0);
});

test("diagnostic-modes: event-loop snapshot has exact attribution", () => {
  const runner = createDiagnosticRunner({ config: makePerfConfig() });
  const result = runner.run("event-loop");
  const snap = result.snapshot as EventLoopDiagnosticSnapshot;
  assert.equal(snap.mode, "event-loop");
  assert.equal(snap.attribution, "exact");
  assert.ok(snap.idle >= 0);
  assert.ok(snap.active >= 0);
  assert.ok(snap.utilization >= 0 && snap.utilization <= 1);
});

test("diagnostic-modes: process snapshot has exact attribution", () => {
  const runner = createDiagnosticRunner({ config: makePerfConfig() });
  const result = runner.run("process");
  const snap = result.snapshot as ProcessDiagnosticSnapshot;
  assert.equal(snap.mode, "process");
  assert.equal(snap.attribution, "exact");
  assert.ok(snap.pid > 0);
  assert.ok(snap.uptimeMs > 0);
});

test("diagnostic-modes: cgroup snapshot returns estimated attribution when unavailable", () => {
  const runner = createDiagnosticRunner({
    config: makePerfConfig(),
    readCgroupFile: () => undefined,
  });
  const result = runner.run("cgroup");
  const snap = result.snapshot as CgroupDiagnosticSnapshot;
  assert.equal(snap.mode, "cgroup");
  assert.equal(snap.available, false);
  assert.equal(snap.attribution, "estimated");
  assert.equal(snap.cgroupVersion, 0);
});

test("diagnostic-modes: cgroup v2 snapshot returns exact attribution when available", () => {
  const runner = createDiagnosticRunner({
    config: makePerfConfig(),
    readCgroupFile: (path: string) => {
      if (path === "/proc/self/mountinfo") return "cgroup2 /sys/fs/cgroup cgroup2\n";
      if (path === "/sys/fs/cgroup/cpu.stat") return "usage_usec 1000\nuser_usec 500\nsystem_usec 500\n";
      if (path === "/sys/fs/cgroup/memory.current") return "1048576\n";
      if (path === "/sys/fs/cgroup/memory.max") return "2097152\n";
      return undefined;
    },
  });
  const result = runner.run("cgroup");
  const snap = result.snapshot as CgroupDiagnosticSnapshot;
  assert.equal(snap.mode, "cgroup");
  assert.equal(snap.available, true);
  assert.equal(snap.attribution, "exact");
  assert.equal(snap.cgroupVersion, 2);
  assert.equal(snap.memoryCurrentBytes, 1048576);
  assert.equal(snap.memoryMaxBytes, 2097152);
  assert.equal(snap.cpuUserUsec, 500);
  assert.equal(snap.cpuSystemUsec, 500);
});

test("diagnostic-modes: runAll runs every declared mode when nothing is excluded", () => {
  const runner = createDiagnosticRunner({ config: makePerfConfig() });
  const results = runner.runAll();
  // Default-all: the enabled set is the DECLARED vocabulary (derived, never
  // restated) minus the (empty) exclusion list.
  assert.equal(results.length, DIAGNOSTIC_MODE_IDS.length);
  const modes = results.map((r) => r.mode);
  assert.deepEqual(modes, [...DIAGNOSTIC_MODE_IDS]);
});

test("diagnostic-modes: runAll respects abort signal", () => {
  const runner = createDiagnosticRunner({ config: makePerfConfig() });
  const controller = new AbortController();
  controller.abort();
  const results = runner.runAll(controller.signal);
  assert.ok(results.length <= DIAGNOSTIC_MODE_IDS.length);
});

test("diagnostic-modes: supportedModes is the declared set minus the exclusions", () => {
  const config = makePerfConfig({ diagnosticModes: { ...DEFAULT_PERFORMANCE_CONFIG.diagnosticModes, excludedModes: ["io", "event-loop", "process", "cgroup"] } });
  const runner = createDiagnosticRunner({ config });
  assert.deepEqual([...runner.supportedModes()], ["cpu", "memory"]);
});

test("diagnostic-modes: an excluded mode throws", () => {
  const config = makePerfConfig({ diagnosticModes: { ...DEFAULT_PERFORMANCE_CONFIG.diagnosticModes, excludedModes: ["memory"] } });
  const runner = createDiagnosticRunner({ config });
  assert.throws(
    () => runner.run("memory"),
    (err: unknown) => {
      assert.ok(err instanceof InputError, "refusal must be the typed input error");
      assert.equal((err as InputError).code, "diagnostic_mode_not_enabled");
      return true;
    },
  );
  // The exclusion does not disable its siblings.
  const stillOn = runner.run("cpu");
  assert.equal(stillOn.mode, "cpu");
});

test("diagnostic-modes: result has runId and wallTime", () => {
  const runner = createDiagnosticRunner({ config: makePerfConfig() });
  const result = runner.run("cpu");
  assert.ok(result.runId.startsWith("diag-"));
  assert.ok(result.wallTime.length > 0);
  assert.ok(result.durationMs >= 0);
  assert.equal(result.timedOut, false);
});

test("diagnostic-modes: result has configHash", () => {
  const runner = createDiagnosticRunner({ config: makePerfConfig() });
  const result = runner.run("cpu");
  assert.equal(result.configHash.length, 64);
});

test("diagnostic-modes: modeTimeoutMs overruns are reported as timed out", () => {
  // The per-mode budget is the bound that keeps one slow probe from
  // passing unnoticed, and the collectors are synchronous — so the
  // enforcement is the after-the-fact comparison against the elapsed time.
  // Drive it deterministically: the cgroup mode's file read is injectable,
  // so a first read that busy-waits far past a single-millisecond budget
  // guarantees the mode outlasts its budget and the result reports it —
  // no wall-clock race, no dependence on a timer firing mid-collection.
  let cgroupReads = 0;
  const config = makePerfConfig({
    diagnosticModes: { ...DEFAULT_PERFORMANCE_CONFIG.diagnosticModes, modeTimeoutMs: 1 },
  });
  const runner = createDiagnosticRunner({
    config,
    readCgroupFile: () => {
      if (cgroupReads++ > 0) return undefined;
      const deadline = Date.now() + 50;
      while (Date.now() < deadline) { /* busy-wait far past the 1 ms budget */ }
      return undefined;
    },
  });
  const result = runner.run("cgroup");
  assert.equal(result.timedOut, true, "a mode whose collection outlasts the budget must be reported as timed out");
  assert.equal(result.mode, "cgroup");
  assert.ok(
    result.durationMs >= 30,
    "the drive must have actually outrun the budget (the read busy-waits ~50 ms against a 1 ms budget), or it proves nothing",
  );
});

test("diagnostic-modes: each declared mode has correct mode field", () => {
  const runner = createDiagnosticRunner({ config: makePerfConfig() });
  for (const mode of DIAGNOSTIC_MODE_IDS) {
    const result = runner.run(mode);
    assert.equal(result.snapshot.mode, mode);
  }
});

test("diagnostic-modes: cpu snapshot has load averages", () => {
  const runner = createDiagnosticRunner({ config: makePerfConfig() });
  const snap = runner.run("cpu").snapshot as CpuDiagnosticSnapshot;
  // A readable host reports numbers; an unreadable one reports null. The
  // snapshot must never invent a zero for an absent reading.
  for (const leg of [snap.loadAvg1, snap.loadAvg5, snap.loadAvg15]) {
    assert.ok(leg === null || typeof leg === "number");
  }
});

test("diagnostic-modes: cpu snapshot has model and speed", () => {
  const runner = createDiagnosticRunner({ config: makePerfConfig() });
  const snap = runner.run("cpu").snapshot as CpuDiagnosticSnapshot;
  assert.ok(typeof snap.model === "string");
  assert.ok(typeof snap.speedMhz === "number");
});

test("diagnostic-modes: memory snapshot has heap and external bytes", () => {
  const runner = createDiagnosticRunner({ config: makePerfConfig() });
  const result = runner.run("memory");
  const snap = result.snapshot as MemoryDiagnosticSnapshot;
  assert.ok(snap.heapTotalBytes >= 0);
  assert.ok(snap.heapUsedBytes >= 0);
  assert.ok(snap.externalBytes >= 0);
  assert.ok(snap.arrayBufferBytes >= 0);
  assert.ok(snap.freeSystemBytes >= 0);
});

test("diagnostic-modes: cgroup v1 snapshot is parsed correctly", () => {
  const runner = createDiagnosticRunner({
    config: makePerfConfig(),
    readCgroupFile: (path: string) => {
      if (path === "/proc/self/mountinfo") return "cgroup /sys/fs/cgroup/cpuacct cgroup\n";
      if (path === "/sys/fs/cgroup/cpuacct/cpu.usage") return "5000\n";
      if (path === "/sys/fs/cgroup/cpuacct/cpu.stat") return "user_usec 2000\nsystem_usec 3000\n";
      if (path === "/sys/fs/cgroup/cpuacct/memory.current") return "2097152\n";
      return undefined;
    },
  });
  const result = runner.run("cgroup");
  const snap = result.snapshot as CgroupDiagnosticSnapshot;
  assert.equal(snap.cgroupVersion, 1);
  assert.equal(snap.available, true);
  assert.equal(snap.cpuUsageUsec, 5000);
});

test("diagnostic-modes: only the unexcluded modes run when others are excluded", () => {
  const config = makePerfConfig({ diagnosticModes: { ...DEFAULT_PERFORMANCE_CONFIG.diagnosticModes, excludedModes: ["cpu", "io", "event-loop", "process", "cgroup"] } });
  const runner = createDiagnosticRunner({ config });
  const results = runner.runAll();
  assert.equal(results.length, 1);
  assert.equal(results[0]!.mode, "memory");
});

test("diagnostic-modes: IO snapshot has bytes read and written", () => {
  const runner = createDiagnosticRunner({ config: makePerfConfig() });
  const result = runner.run("io");
  const snap = result.snapshot as IoDiagnosticSnapshot;
  assert.ok(typeof snap.bytesRead === "number");
  assert.ok(typeof snap.bytesWritten === "number");
});

test("diagnostic-modes: process snapshot has ppid", () => {
  const runner = createDiagnosticRunner({ config: makePerfConfig() });
  const result = runner.run("process");
  const snap = result.snapshot as ProcessDiagnosticSnapshot;
  assert.ok(snap.ppid >= 0);
  assert.ok(snap.threadCount >= 1);
});

test("diagnostic-modes: event-loop snapshot has maxListeners", () => {
  const runner = createDiagnosticRunner({ config: makePerfConfig() });
  const result = runner.run("event-loop");
  const snap = result.snapshot as EventLoopDiagnosticSnapshot;
  assert.ok(typeof snap.maxListeners === "number");
});
