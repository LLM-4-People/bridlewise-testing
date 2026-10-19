// @vitest-environment node
/**
 * AN ESCAPED FAULT HAS ONE OWNER, AND ITS HANDLERS CANNOT THROW (SCALE-CR1 C2).
 *
 * ── The defect (reproduced) ──
 * The server's `unhandledRejection` listener formatted the reason with
 * `String(reason)` and its `uncaughtException` listener with
 * `err.stack ?? err.message`. A rejection with a null-prototype reason, a
 * thrown `undefined`, a Symbol, or an error whose `stack` getter throws each
 * threw INSIDE the listener, and the process ended with the cause lost. The
 * listeners were also installed after the boot's top-level `await`.
 *
 * ── The rule ──
 * Every process installs the policy first, through one of its three doors
 * (the CLI bootstrap `bootstrapProcess({ role })`, the worker prelude, the
 * server's first import `server/kernel/process-fault-policy.ts`). An uncaught
 * exception is logged, recorded in the ledger as a `process-fault` event (on
 * the server), and the process exits 70 for its supervisor. An unhandled
 * rejection or a guarded callback fault is counted and reported; the ROLE
 * decides the rest (SCALE-CR1-FIX H1): the server LIVES; a CLI or a worker
 * FAILS CLOSED with a sticky exit 70 (a tool's later `exitCode = 0` cannot
 * clear it — before, a gate whose failure surfaced only as a lost rejection
 * exited 0); a process with no role keeps Node's default. Each case runs in a
 * child process, so the exit is measured.
 */
import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createTempDir } from "../helpers/temp-dir.ts";
import { PROCESS_FAULT_EXIT_CODE } from "../../engine/src/process/fault-policy.ts";
import { describeFault, describeFaultLine } from "../../engine/src/shared/fault-description.ts";

const REPO = join(import.meta.dirname, "..", "..");

/** The hostile values, as source the driver evaluates (one per case). */
const FAULTS: Readonly<Record<string, string>> = {
  "a null-prototype reason": "Object.assign(Object.create(null), { detail: 'no prototype' })",
  "a thrown undefined": "undefined",
  "a Symbol": "Symbol('hostile')",
  "an error whose stack getter throws": "Object.defineProperty(new Error('stack trap'), 'stack', { get() { throw new Error('getter'); } })",
  "an object whose message getter throws": "({ get message() { throw new Error('getter'); }, name: 'Hostile' })",
};

function driver(mode: "reject" | "throw", fault: string): string {
  return [
    'import { writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    "const { OUT, REPO } = process.env;",
    // The server's own install, exactly as server/index.ts loads it (first).
    "await import(join(REPO, 'server/kernel/process-fault-policy.ts'));",
    "const policy = await import(join(REPO, 'engine/src/process/fault-policy.ts'));",
    mode === "throw"
      ? "const bridge = await import(join(REPO, 'server/observability/timeline-bridge.ts')); bridge.getTimelineRecorder();"
      : "",
    mode === "reject"
      ? `Promise.reject(${fault});`
      : `setTimeout(() => { throw ${fault}; }, 0);`,
    "await new Promise((resolve) => setTimeout(resolve, 200));",
    "writeFileSync(OUT, JSON.stringify({ survived: true, counts: policy.processFaultCounts(), last: policy.lastProcessFault() }));",
    "process.exit(0);",
  ].filter((line) => line.length > 0).join("\n");
}

function run(mode: "reject" | "throw", fault: string) {
  const root = createTempDir("ch-fault-policy-");
  const script = join(root, "driver.mjs");
  writeFileSync(script, driver(mode, fault));
  const out = join(root, "out.json");
  const timeline = join(root, "timeline.db");
  const child = spawnSync(process.execPath, [script], {
    cwd: root, encoding: "utf8", timeout: 120_000,
    env: { ...process.env, OUT: out, REPO, HARNESS_WEB_DB_PATH: join(root, "web.db"), HARNESS_WEB_TIMELINE_DB_PATH: timeline },
  });
  return { child, out, timeline };
}

describe("the process fault policy", () => {
  for (const [label, fault] of Object.entries(FAULTS)) {
    test(`an unhandled rejection with ${label} is counted and logged, and the process lives`, () => {
      const { child, out } = run("reject", fault);
      expect(child.status, child.stderr.slice(-2000)).toBe(0);
      const report = JSON.parse(readFileSync(out, "utf8")) as { survived: boolean; counts: { unhandledRejections: number }; last: string };
      expect(report.survived).toBe(true);
      expect(report.counts.unhandledRejections).toBe(1);
      expect(report.last).toMatch(/^unhandled rejection in promise: /u);
      expect(child.stderr).toMatch(/\[bridlewise process\] unhandled rejection in promise: .*"role":"server"/su);
    });

    test(`an uncaught exception with ${label} is logged, recorded in the ledger, and exits ${String(PROCESS_FAULT_EXIT_CODE)}`, () => {
      const { child, out, timeline } = run("throw", fault);
      expect(child.status, child.stderr.slice(-2000)).toBe(PROCESS_FAULT_EXIT_CODE);
      expect(() => readFileSync(out, "utf8"), "the process did not continue past the fault").toThrow(expect.objectContaining({ code: "ENOENT" }));
      expect(child.stderr).toMatch(/\[bridlewise process\] uncaught exception in uncaughtException: /u);
      const db = new DatabaseSync(timeline, { readOnly: true });
      try {
        const rows = db.prepare("SELECT event_type, outcome, error_category, error_code FROM event_log WHERE description = 'process-fault: uncaughtException'").all();
        expect(rows.map((row) => ({ ...row }))).toEqual([{ event_type: "error", outcome: "failed", error_category: "process", error_code: "process_uncaught_exception" }]);
      } finally { db.close(); }
    });
  }

  /** A child that bootstraps as `role` (or nothing), loses `fault`, then tries to exit 0. */
  function tool(bootstrap: string, fault: string) {
    const root = createTempDir("ch-fault-role-");
    const script = join(root, "tool.mjs");
    writeFileSync(script, [
      'import { join } from "node:path";',
      "const { REPO } = process.env;",
      bootstrap,
      "const policy = await import(join(REPO, 'engine/src/process/fault-policy.ts'));",
      fault,
      "await new Promise((resolve) => setTimeout(resolve, 100));",
      "process.stdout.write(JSON.stringify(policy.processFaultCounts()));",
      "process.exitCode = 0;",
      "process.exit(0);",
    ].join("\n"));
    return spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8", timeout: 120_000, env: { ...process.env, REPO } });
  }
  const CLI = "(await import(join(REPO, 'engine/src/runtime/cli-debug.ts'))).bootstrapProcess({ role: 'cli' });";

  test("a CLI that loses a rejection fails closed: exit 70 although the tool then exits 0 (H1)", () => {
    const child = tool(CLI, "Promise.reject(new Error('lost gate failure'));");
    expect(child.status, child.stderr.slice(-2000)).toBe(PROCESS_FAULT_EXIT_CODE);
    expect(JSON.parse(child.stdout)).toMatchObject({ unhandledRejections: 1 });
    expect(child.stderr).toMatch(/unhandled rejection in promise: Error: lost gate failure/u);
    expect(child.stderr.match(/unhandled rejection in promise/gu), "one report, never printed twice (one owner: reportAlwaysOn)").toHaveLength(1);
  });

  test("a CLI whose guarded timer throws fails closed: exit 70 although the tool then exits 0 (H1)", () => {
    const child = tool(CLI, "setTimeout(policy.guarded('probe.timer', () => { throw new TypeError('timer defect'); }), 0);");
    expect(child.status, child.stderr.slice(-2000)).toBe(PROCESS_FAULT_EXIT_CODE);
    expect(JSON.parse(child.stdout)).toMatchObject({ guardedCallbackFaults: 1 });
    expect(child.stderr).toMatch(/callback fault in probe\.timer: TypeError: timer defect/u);
  });

  test("a CLI that loses no fault exits with its own code (the policy changes nothing)", () => {
    const child = tool(CLI, "");
    expect(child.status, child.stderr.slice(-2000)).toBe(0);
  });

  test("a process with no role keeps Node's default: a guarded callback fault is re-raised and ends it", () => {
    const child = tool("", "setTimeout(policy.guarded('probe.timer', () => { throw new TypeError('host sees it'); }), 0);");
    expect(child.status, child.stderr.slice(-2000)).not.toBe(0);
    expect(child.stdout, "the process did not continue past the fault").toBe("");
    expect(child.stderr).toMatch(/host sees it/u);
  });

  test("a worker thread's lost fault fails the THREAD closed (exit 70); a server thread's lives on", () => {
    const child = tool("", `
      const { Worker } = await import('node:worker_threads');
      const { bootstrappedWorker } = await import(join(REPO, 'engine/src/process/worker-bootstrap.ts'));
      const { writeFileSync } = await import('node:fs');
      // The child runs in the test's own temporary folder (its cwd).
      const body = join(process.cwd(), 'body.mjs');
      writeFileSync(body, "import { setTimeout as sleep } from 'node:timers/promises'; Promise.reject(new Error('thread lost it')); await sleep(50);");
      const exitOf = (role) => new Promise((resolve) => { const w = new Worker(...bootstrappedWorker(body, role)); w.once('exit', resolve); });
      const codes = { worker: await exitOf('worker'), serverThread: await exitOf('server-thread') };
      process.stderr.write('CODES ' + JSON.stringify(codes) + '\\n');
    `);
    expect(child.status, child.stderr.slice(-2000)).toBe(0);
    expect(child.stderr).toMatch(/CODES \{"worker":70,"serverThread":0\}/u);
  });

  test("describeFault keeps every field it CAN read: one hostile getter loses only its own field", () => {
    const stackTrap = Object.defineProperty(new TypeError("kept message"), "stack", { get() { throw new Error("getter"); } });
    expect(describeFault(stackTrap)).toMatchObject({ kind: "error", name: "TypeError", message: "kept message" });
    expect(describeFault(stackTrap).stack).toBeUndefined();
    const codeTrap = Object.defineProperty(new Error("kept too"), "code", { get() { throw new Error("getter"); } });
    expect(describeFaultLine(codeTrap)).toBe("Error: kept too");
    expect(describeFaultLine(Object.assign(new RangeError("typed"), { code: "x_code" }))).toBe("RangeError [x_code]: typed");
    expect(describeFaultLine(Object.create(null))).toBe("[object Object]: [object Object]");
  });

  test("the server installs the policy as its FIRST import, before the settings preflight", () => {
    const source = readFileSync(join(REPO, "server", "index.ts"), "utf8");
    const imports = [...source.matchAll(/^import\s[^;]*?["']([^"']+)["'];?$/gmu)].map((match) => match[1]);
    expect(imports[0]).toBe("./kernel/process-fault-policy.ts");
    expect(imports[1]).toBe("./kernel/boot-settings-preflight.ts");
    expect(source, "the server registers no process-level fault listener of its own").not.toMatch(/process\.on\(\s*["'](uncaughtException|unhandledRejection)["']/u);
  });
});
