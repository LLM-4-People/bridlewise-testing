/**
 * A RUN NEVER OUTLIVES ITS LAUNCHER (`watchLauncher`, scripts/tooling/launcher-watch.ts;
 * the recorded command's `stop`, scripts/tooling/recorded-command.ts).
 *
 * Measured (step6-readiness-2 F-11): a SIGTERM to the engine `npm test`
 * wrapper left `run-tests.ts` orphaned. It finished the whole suite, recorded
 * a ledger row the wrapper's 143 had already contradicted, and held the
 * test-run lock two later runs refused against. Driven here, with a real
 * launcher that really exits:
 *
 *   - the watch fires once the launcher exits (the process is re-parented),
 *     with the launcher's pid, and never while the launcher lives;
 *   - a recorded command is stopped (SIGTERM) when its `stop` signal aborts,
 *     also when it was aborted before the command started, and the
 *     observation still completes;
 *   - the stop is reported once, for both runners: the audit event and the
 *     one sentence (`reportLauncherStop`).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { reportLauncherStop } from "../../scripts/tooling/launcher-watch.ts";
import { ensureTestProcessSupervisor } from "../../guardian/build.ts";
import { runRecordedCommand } from "../../scripts/tooling/recorded-command.ts";
import { configureDebugSystem, createCollectingSink, getAuditEvents, resetDebugSystem } from "../../src/shared/debug/debug-system.ts";
import { DEBUG_CONFIG_DEFAULTS } from "../../src/shared/debug/debug-config.ts";
import { isProcessAlive } from "../../src/process/process-facts.ts";
import { createTempDir } from "../support/temp-dir.ts";

const LAUNCHER_WATCH = pathToFileURL(join(import.meta.dirname, "..", "..", "scripts", "tooling", "launcher-watch.ts")).href;

async function until(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  for (let waited = 0; waited < timeoutMs; waited += 50) {
    if (condition()) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  return condition();
}

test("watchLauncher fires once the launcher exits, with the launcher's pid, and never while it lives", { timeout: 60_000 }, async (t) => {
  const dir = createTempDir("launcher-watch-");
  const started = join(dir, "started");
  const fired = join(dir, "fired");
  const script = join(dir, "watched.mjs");
  writeFileSync(script, [
    `const { watchLauncher } = await import(${JSON.stringify(LAUNCHER_WATCH)});`,
    `const { writeFileSync } = await import("node:fs");`,
    `watchLauncher((launcher) => { writeFileSync(${JSON.stringify(fired)}, String(launcher)); process.exit(0); }, 50);`,
    `writeFileSync(${JSON.stringify(started)}, JSON.stringify({ pid: process.pid, launcher: process.ppid }));`,
    "setInterval(() => {}, 1000);",
  ].join("\n"));
  // The launcher is a shell that starts the watched process and waits on it,
  // as `npm run` waits on its script; a SIGTERM ends the shell alone.
  const launcher = spawn("sh", ["-c", '"$0" "$1" & wait', process.execPath, script], { stdio: "ignore" });
  assert.ok(await until(() => existsSync(started), 20_000), "the watched process never started");
  const facts = JSON.parse(readFileSync(started, "utf8")) as { pid: number; launcher: number };
  // A failed assertion must not leave the watched process spinning.
  t.after(() => { if (isProcessAlive(facts.pid)) process.kill(facts.pid, "SIGKILL"); });
  assert.equal(facts.launcher, launcher.pid, "the fixture's launcher is not the shell");
  await new Promise((resolveWait) => setTimeout(resolveWait, 400));
  assert.equal(existsSync(fired), false, "the watch fired while its launcher was alive");
  launcher.kill("SIGTERM");
  assert.ok(await until(() => existsSync(fired), 10_000), "the launcher exited and the watch never fired");
  assert.equal(readFileSync(fired, "utf8"), String(launcher.pid));
  assert.ok(await until(() => !isProcessAlive(facts.pid), 10_000), "the watched process kept running");
});

/** The engine worker's launch runs only supervised (`recorded-command.ts`): the same bounds here. */
const SUPERVISION = { supervisor: ensureTestProcessSupervisor(), hardCeilingMs: 60_000, killGraceMs: 5_000 } as const;

test("a recorded command is stopped with SIGTERM when its stop signal aborts — also when it aborted before the start — and the observation completes", { timeout: 90_000 }, async () => {
  const dir = createTempDir("recorded-command-stop-");
  // A command that runs until it is stopped — and ends ITSELF (exit 9) well
  // inside the test's timeout, so a stop that is never delivered fails the
  // assertions below instead of leaving a spinning process behind.
  const untilStopped = "setTimeout(() => process.exit(9), 20_000); setInterval(() => {}, 1000)";
  const stop = new AbortController();
  const running = runRecordedCommand({ arguments: ["-e", untilStopped], cwd: dir, stop: stop.signal, supervision: SUPERVISION });
  setTimeout(() => stop.abort(), 200);
  const observation = await running;
  assert.equal(observation.closeObserved, true);
  assert.equal(observation.signal, "SIGTERM");

  const early = new AbortController();
  early.abort();
  const stoppedFirst = await runRecordedCommand({ arguments: ["-e", untilStopped], cwd: dir, stop: early.signal, supervision: SUPERVISION });
  assert.equal(stoppedFirst.signal, "SIGTERM", "a stop requested before the start was not honoured");

  const finished = await runRecordedCommand({ arguments: ["-e", "process.exit(3)"], cwd: dir, stop: new AbortController().signal, supervision: SUPERVISION });
  assert.deepEqual([finished.exitCode, finished.signal], [3, null], "an unaborted stop changed an ordinary run");
});

test("reportLauncherStop: both runners' one report — the audit event through central logging and the one sentence", () => {
  // wf-del2-design D9: the web runner spelled the sentence itself and logged
  // nothing; both now call this.
  const written: string[] = [];
  configureDebugSystem({ ...DEBUG_CONFIG_DEFAULTS, sinks: { ...DEBUG_CONFIG_DEFAULTS.sinks, enabledSinks: ["collecting"] }, audit: { ...DEBUG_CONFIG_DEFAULTS.audit, enabled: true, categories: [] } }, [createCollectingSink()]);
  try {
    reportLauncherStop(4242, 1234, (text) => written.push(text));
    const [event] = getAuditEvents();
    assert.equal(event?.category, "test-run-stopped");
    assert.deepEqual(event?.context, { reason: "launcher-exited", launcherPid: 4242, wallClockMs: 1234 });
    assert.deepEqual(written, ["[run-tests] STOPPED: the launcher (pid 4242) exited, so this run was stopped and certifies nothing; no result was recorded.\n"]);
  } finally {
    resetDebugSystem();
  }
});
