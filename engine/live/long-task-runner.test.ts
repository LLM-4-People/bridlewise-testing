import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, rmSync } from "node:fs";

import { LongTaskRunner, LongTaskUnavailableError } from "../src/tools/concurrent/long-task-runner.ts";
import { createTempDir } from "../test/support/temp-dir.ts";
import { requireHost } from "../test/support/host-requirement.ts";

function hasSystemd(): boolean {
  return LongTaskRunner.checkSystemd().ok;
}

test("long-task-runner: requires non-empty stateDir", () => {
  assert.throws(
    () => new LongTaskRunner({ stateDir: "" }),
    /stateDir/i,
  );
});

test("long-task-runner: checkSystemd returns {ok, reason?}", () => {
  const probe = LongTaskRunner.checkSystemd();
  assert.equal(typeof probe.ok, "boolean");
  if (!probe.ok) assert.equal(typeof probe.reason, "string");
});

test("long-task-runner: start throws LongTaskUnavailableError when systemd absent", () => {
  // HERMETIC: the systemctl it would use does not exist, so the refusal is measured on every host (it used to
  // return early on a host WITH systemd, so the refusal — thrown synchronously — was never run here).
  const stateDir = createTempDir("ltr-test-");
  try {
    const runner = new LongTaskRunner({ stateDir, systemctlPath: "/nonexistent/systemctl" });
    assert.throws(() => runner.start("echo hi", { name: "test-no-systemd" }), LongTaskUnavailableError);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("long-task-runner: start + check + kill a real 2s task (when systemd available)", async () => {
  requireHost(hasSystemd(), `a user systemd (systemd --user), which the long-task runner's units run under: ${LongTaskRunner.checkSystemd().reason ?? ""}`);
  const stateDir = createTempDir("ltr-real-");
  try {
    const runner = new LongTaskRunner({ stateDir, unitPrefix: "exp448-test", defaultHeartbeatMs: 1000 });
    const started = runner.start("sleep 2 && echo done", { name: "sleep-2s", heartbeatMs: 500, timeoutMs: 10000 });
    assert.ok(started.unitName.startsWith("exp448-test-"));
    assert.ok(existsSync(started.stateDir));
    // Wait for it to finish.
    await new Promise((r) => setTimeout(r, 3500));
    const status = runner.statusOf(started.unitName);
    assert.ok(["done-ok", "running", "unknown"].includes(status), `status was ${status}`);
    // Clean up.
    runner.kill(started.unitName);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("long-task-runner: start rejects empty command", () => {
  const runner = new LongTaskRunner({ stateDir: "/tmp/ltr-test-empty-cmd" });
  assert.throws(
    () => runner.start(""),
    /non-empty command/i,
  );
});

test("long-task-runner: failure path records non-zero exit code (when systemd available)", async () => {
  requireHost(hasSystemd(), `a user systemd (systemd --user), which the long-task runner's units run under: ${LongTaskRunner.checkSystemd().reason ?? ""}`);
  const stateDir = createTempDir("ltr-fail-");
  try {
    const runner = new LongTaskRunner({ stateDir, unitPrefix: "ltr-test-fail", defaultHeartbeatMs: 1000 });
    const started = runner.start("node -e \"process.exit(7)\"", { name: "fail-7", heartbeatMs: 500 });
    // Wait for the short task to finish and the wrapper to write the result.
    let status = "running";
    for (let i = 0; i < 20; i++) {
      status = runner.statusOf(started.unitName);
      if (status !== "running") break;
      await new Promise((r) => setTimeout(r, 400));
    }
    assert.equal(status, "done-fail", `expected done-fail, got ${status}`);
    const c = runner.check(started.unitName);
    assert.equal(c.done, true);
    assert.equal(c.exitCode, 7);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("long-task-runner: timeout path sets timedOut when task exceeds timeoutMs (when systemd available)", async () => {
  requireHost(hasSystemd(), `a user systemd (systemd --user), which the long-task runner's units run under: ${LongTaskRunner.checkSystemd().reason ?? ""}`);
  const stateDir = createTempDir("ltr-timeout-");
  try {
    const runner = new LongTaskRunner({ stateDir, unitPrefix: "ltr-test-to", defaultHeartbeatMs: 1000 });
    const started = runner.start("sleep 20", { name: "sleep-20", heartbeatMs: 500, timeoutMs: 1000 });
    // Wait for the timeout to fire (the wrapper kills the child after timeoutMs).
    let done = false;
    for (let i = 0; i < 30; i++) {
      const s = runner.check(started.unitName);
      if (s.done) { done = true; break; }
      await new Promise((r) => setTimeout(r, 400));
    }
    assert.ok(done, "task should be done after timeout");
    const c = runner.check(started.unitName);
    const result = c.result as { timedOut?: boolean; reason?: string };
    assert.equal(result.timedOut, true, "result.timedOut should be true");
    assert.equal(result.reason, "timeout", "result.reason should be 'timeout'");
    runner.kill(started.unitName);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("long-task-runner: list returns a running unit (when systemd available)", async () => {
  requireHost(hasSystemd(), `a user systemd (systemd --user), which the long-task runner's units run under: ${LongTaskRunner.checkSystemd().reason ?? ""}`);
  const stateDir = createTempDir("ltr-list-");
  try {
    const runner = new LongTaskRunner({ stateDir, unitPrefix: "ltr-test-list", defaultHeartbeatMs: 1000 });
    const started = runner.start("sleep 8", { name: "sleep-8", heartbeatMs: 500 });
    // Wait for the unit to appear in the list.
    let found = false;
    for (let i = 0; i < 15; i++) {
      const units = runner.list();
      if (units.includes(started.unitName)) { found = true; break; }
      await new Promise((r) => setTimeout(r, 400));
    }
    assert.ok(found, `list should include ${started.unitName}: ${JSON.stringify(runner.list())}`);
    runner.kill(started.unitName);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("long-task-runner: the unit's environment is the ONE command projection and no value is on the command line (secd-security SECD-V-B3)", async () => {
  const { chmodSync, readFileSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const dir = createTempDir("ltr-env-");
  try {
    // A systemd pair that records what it was handed (argv + env) and succeeds.
    const systemctl = join(dir, "systemctl"), systemdRun = join(dir, "systemd-run"), record = join(dir, "record.json");
    writeFileSync(systemctl, "#!/bin/sh\nexit 0\n");
    writeFileSync(systemdRun, `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));\n`);
    chmodSync(systemctl, 0o755);
    chmodSync(systemdRun, 0o755);
    const planted = "PLANTED-DB-KEY-value";
    const previous = process.env["HARNESS_WEB_DB_KEY"];
    process.env["HARNESS_WEB_DB_KEY"] = planted;
    try {
      const runner = new LongTaskRunner({ stateDir: join(dir, "state"), systemctlPath: systemctl, systemdRunPath: systemdRun });
      runner.start("echo hi", { name: "env-probe", env: { CALLER_SECRET: "PLANTED-CALLER-value" } });
    } finally {
      if (previous === undefined) delete process.env["HARNESS_WEB_DB_KEY"]; else process.env["HARNESS_WEB_DB_KEY"] = previous;
    }
    const { argv, env } = JSON.parse(readFileSync(record, "utf8")) as { argv: string[]; env: Record<string, string> };
    assert.ok(!argv.join(" ").includes("PLANTED"), `no value on the command line: ${argv.join(" ")}`);
    assert.ok(argv.includes("--setenv=CALLER_SECRET"), "names only");
    assert.equal(env["CALLER_SECRET"], "PLANTED-CALLER-value", "the value travels in systemd-run's environment");
    assert.equal(env["HARNESS_WEB_DB_KEY"], undefined, "the harness's own secrets never reach the unit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
