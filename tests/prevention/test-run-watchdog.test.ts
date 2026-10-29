// @vitest-environment node
/**
 * A TEST RUN MUST NEVER HANG FOREVER — and the layer that guarantees it must
 * be the one that actually can.
 *
 * ── WHAT HAPPENED ──────────────────────────────────────────────────────────
 *
 * Six orphaned vitest workers ran `artifact-runtime-errors.test.ts` at ~102%
 * CPU EACH for up to 1h16m after the run that spawned them had finished —
 * roughly 600% of a twelve-core machine — and corrupted every measurement
 * taken that day. A mutation had raised a cap, turning `for (i < CAP + 3)`
 * into a synchronous spin.
 *
 * ── THE TRAP THIS FILE EXISTS TO KEEP CLOSED ───────────────────────────────
 *
 * "Add a testTimeout" is the obvious fix and it does not work. MEASURED, on
 * this repo, against a real synchronous spin with `testTimeout: 30_000`
 * configured: raw vitest ran it for the FULL 75 SECONDS of an external cap
 * and never timed it out. Under the watchdog, the same spin died at 20,077ms
 * against a 20,000ms budget, with exit code 1.
 *
 * The reason is structural, not a vitest bug: a synchronous loop blocks its
 * worker, and every in-runtime timeout is a callback waiting for a turn on
 * the event loop that is blocked. The killer cannot run. Only a process that
 * is not the hung one — holding a clock and a PID — can end it.
 *
 * So the ORDER of the layers is itself load-bearing, and this file pins it:
 *   1. the watchdog OUTSIDE the runtime (scripts/run-tests.ts on the native
 *      subreaper supervisor): it kills on no-output-for-N-seconds (a fixed
 *      180 s wall clock killed healthy runs on a loaded machine) and at a
 *      hard ceiling whatever the load, and either kill takes EVERY
 *      descendant, detached ones included — there is no wall-clock verdict
 *      (the CPU budget judges speed);
 *   2. `pool: "forks"`, so a stuck worker is externally killable at all;
 *   3. `testTimeout`, for the async-hang case it genuinely does cover;
 *   4. naming orphaned strays before a run (never killing them: KILL-OWNED-ONLY);
 *   5. no unbounded loop whose bound is a mutable constant (below).
 */
import { describe, expect, test } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";

import { TEST_HANG_BACKSTOP_MS } from "../test-budget.ts";
import type { SuiteWatchdog } from "../../engine/src/workflow/workflow-config.ts";
import { readWebSuiteWatchdog } from "../helpers/budget-config.ts";
import { strayVitest, superviseRun } from "../../scripts/run-tests.ts";
import { superviseCommand } from "../../engine/src/process/supervised-run.ts";
import { ensureTestProcessSupervisor } from "../../engine/guardian/build.ts";
import { qualificationInvocation, supervisedCommandOutcome, QUALIFICATION_INVOCATION_ENV } from "../../engine/src/shared/run-history.ts";
import { allProcessIds, commandLineOf, isProcessAlive, parentOf } from "../../engine/src/process/process-facts.ts";
import { readSourceView, sourceViewOf, type SourceView } from "../../engine/scripts/verification/source-view.ts";
import { createTempDir } from "../helpers/temp-dir.ts";
import { walk, relpath, SOURCE_EXTS } from "../helpers/source-scan.ts";

const WATCHDOG: SuiteWatchdog = { stallTimeoutMs: 1_500, hardCeilingMs: 60_000, killGraceMs: 500 };
const quiet = { checkout: process.cwd(), write: () => undefined, watchIntervalMs: 100 } as const;

/** The native supervisor this process started (the one child running the supervisor binary). */
function supervisorPid(): number | undefined {
  // Through the process-facts owner: a process that exits while listed simply
  // has no parent or command line, so it is not our supervisor.
  return allProcessIds().find((pid) =>
    parentOf(pid) === process.pid && (commandLineOf(pid)?.[0] ?? "").endsWith("test-process-supervisor"));
}

describe("0. the supervisor's OWN death never leaves the run hanging or its descendants running (wf1c-correctness §5)", () => {
  const holder = (dir: string): string => [
    "const { spawn } = require('node:child_process'); const { writeFileSync } = require('node:fs');",
    "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });",
    `writeFileSync(${JSON.stringify(join(dir, "grandchild.pid"))}, String(g.pid));`,
    "setInterval(() => { process.stdout.write('.'); }, 200);",
  ].join("\n");

  for (const [signal, ending] of [["SIGKILL", "unverified"], ["SIGHUP", "signal"]] as const) {
    test(`DRIVEN: the supervisor ${signal === "SIGKILL" ? "KILLED without cleanup" : "hung up (a closed terminal)"}: the run resolves (${ending}) and the grandchild holding its pipes dies`, async () => {
      const dir = createTempDir("ch-watchdog-supervisor-death-");
      const running = superviseRun(process.execPath, ["-e", holder(dir)], WATCHDOG, quiet);
      for (let i = 0; i < 100 && !existsSync(join(dir, "grandchild.pid")); i += 1) await new Promise((r) => setTimeout(r, 50));
      const grandchild = Number(readFileSync(join(dir, "grandchild.pid"), "utf8"));
      const supervisor = supervisorPid();
      expect(supervisor, "the supervisor was not found among this process's children").toBeDefined();
      process.kill(supervisor!, signal);
      const run = await Promise.race([running, new Promise<"hung">((r) => setTimeout(() => r("hung"), 15_000))]);
      expect(run, "superviseRun never resolved after its supervisor died").not.toBe("hung");
      expect((run as Awaited<typeof running>).ending).toBe(ending);
      expect((run as Awaited<typeof running>).exitCode).toBe(1);
      for (let i = 0; i < 50 && isProcessAlive(grandchild); i += 1) await new Promise((r) => setTimeout(r, 100));
      expect(isProcessAlive(grandchild), "a descendant outlived its dead supervisor").toBe(false);
    });
  }
});

describe("1. the watchdog lives outside the runtime and kills on a STALL, never on a slow run", () => {
  test("DRIVEN: a silent spinning child AND its grandchild are killed, and the run FAILS", async () => {
    const dir = createTempDir("ch-watchdog-stall-");
    const grandchildPid = join(dir, "grandchild.pid");
    // The child spawns a spinning grandchild in the same group, then spins
    // itself: no output, no cooperation — the synchronous-spin shape.
    const script = [
      "const { spawn } = require('node:child_process'); const { writeFileSync } = require('node:fs');",
      "const g = spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore' });",
      `writeFileSync(${JSON.stringify(grandchildPid)}, String(g.pid));`,
      "for(;;){}",
    ].join("\n");
    const run = await superviseRun(process.execPath, ["-e", script], WATCHDOG, quiet);
    // The run's own ending names the bound that ended it; no wall clock judges it (NO-LOAD-BLOCK).
    expect(run.ending).toBe("stalled");
    expect(run.terminal.supervision?.interrupted).toBe(true);
    expect(run.terminal.supervision?.noOwnedChildren).toBe(true);
    expect(run.exitCode, "a killed run must never report the child's own exit code").toBe(1);
    expect(existsSync(grandchildPid)).toBe(true);
    const pid = Number(readFileSync(grandchildPid, "utf8"));
    for (let i = 0; i < 50 && isProcessAlive(pid); i += 1) await new Promise((r) => setTimeout(r, 100));
    expect(isProcessAlive(pid), "the GROUP was killed, not only the child").toBe(false);
  });

  test("DRIVEN: a DETACHED spinner (its own session) is killed too — the process group was never the boundary", async () => {
    const dir = createTempDir("ch-watchdog-detached-");
    const detachedPid = join(dir, "detached.pid");
    const script = [
      "const { spawn } = require('node:child_process'); const { writeFileSync } = require('node:fs');",
      "const g = spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore', detached: true }); g.unref();",
      `writeFileSync(${JSON.stringify(detachedPid)}, String(g.pid));`,
      "for(;;){}",
    ].join("\n");
    const run = await superviseRun(process.execPath, ["-e", script], WATCHDOG, quiet);
    expect(run.ending).toBe("stalled");
    const pid = Number(readFileSync(detachedPid, "utf8"));
    for (let i = 0; i < 50 && isProcessAlive(pid); i += 1) await new Promise((r) => setTimeout(r, 100));
    expect(isProcessAlive(pid), "a detached (setsid) descendant survived the kill").toBe(false);
    expect(run.killedDescendants).toContain(pid);
  });

  test("DRIVEN: a detached process a run leaves behind after a NORMAL exit is killed and named", async () => {
    const dir = createTempDir("ch-watchdog-straggler-");
    const stragglerPid = join(dir, "straggler.pid");
    const script = [
      "const { spawn } = require('node:child_process'); const { writeFileSync } = require('node:fs');",
      "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true }); g.unref();",
      `writeFileSync(${JSON.stringify(stragglerPid)}, String(g.pid));`,
    ].join("\n");
    const run = await superviseRun(process.execPath, ["-e", script], WATCHDOG, quiet);
    expect(run).toMatchObject({ ending: "exited", exitCode: 0 });
    const pid = Number(readFileSync(stragglerPid, "utf8"));
    expect(isProcessAlive(pid), "the straggler outlived its run").toBe(false);
    expect(run.killedDescendants).toContain(pid);
  });

  test("C3: actual focused wrapper refuses inner forced cleanup even when its outer command finishes normally", async () => {
    const dir = createTempDir("ch-focused-wrapper-completion-");
    // The wrapper runs the project's own vitest entry (the door's `vitestCommand`): a project folder of the test's own
    // whose `node_modules/vitest/vitest.mjs` is the substitute, the wrapper run there (its project is its cwd).
    const project = join(dir, "project");
    const entry = join(project, "node_modules", "vitest", "vitest.mjs");
    mkdirSync(dirname(entry), { recursive: true });
    for (const straggler of [false, true]) {
      const pidPath = join(dir, "focused-straggler.pid");
      const invocationPath = join(dir, "invocation.json");
      // Substitute only the wrapper's external command. Drive the real CLI
      // entrypoint, inner native supervisor, cleanup and final exit decision.
      writeFileSync(entry, [
        "import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(invocationPath)}, JSON.stringify({ argv: process.argv.slice(2), token: process.env.HARNESS_RUN_INVOCATION }));`,
        ...(straggler ? [
          "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true }); child.unref();",
          `writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));`,
        ] : []),
      ].join("\n"));
      const token = qualificationInvocation({});
      const output: string[] = [];
      const environment: NodeJS.ProcessEnv = { ...process.env, [QUALIFICATION_INVOCATION_ENV]: token };
      delete environment.HARNESS_MUTATION_RUN;
      const run = await superviseCommand({
        supervisor: ensureTestProcessSupervisor(), command: process.execPath,
        args: [join(process.cwd(), "scripts", "run-tests.ts"), "focused-fixture.test.ts"],
        // The OUTER stall clock is not this test's subject (the wrapper's own completion verdict is): a 1.5 s silence
        // bound on a wrapper that cold-starts a confined run killed it under load (FLAKY-WATCHDOG-C3), so it gets the
        // suite's ordinary bound; the ceiling still ends a hung wrapper.
        cwd: project, ...WATCHDOG, stallTimeoutMs: 60_000, env: environment,
        onStdout: (chunk) => { output.push(chunk.toString()); },
        onStderr: (chunk) => { output.push(chunk.toString()); },
      });
      expect(supervisedCommandOutcome(run, "outer focused-wrapper fixture").kind).toBe("pass");
      expect(run.ending).toBe("exited");
      // 70 is the CLI process-fault policy's EX_SOFTWARE exit: this wrapper
      // faulted closed. The fault's name and stack are written only to the
      // output captured above, so they must ride the failure — the recorded
      // FLAKY-WATCHDOG-C3 red was the bare `expected 70 to be +0` and named
      // no fault, which is why it could not be closed.
      expect(run.exitCode, `the focused wrapper exited ${String(run.exitCode)}; its own output:\n${output.join("")}`).toBe(straggler ? 1 : 0);
      expect(JSON.parse(readFileSync(invocationPath, "utf8"))).toEqual({ argv: ["run", "focused-fixture.test.ts", "--configLoader=runner"], token });
      if (straggler) {
        expect(output.join("")).toMatch(/web test command did not complete normally/u);
        expect(isProcessAlive(Number(readFileSync(pidPath, "utf8")))).toBe(false);
      } else expect(output.join("")).not.toMatch(/did not complete normally/u);
    }
  });

  test("DRIVEN: a run that keeps PRINTING outlives the stall limit — slow is not stalled", async () => {
    const script = "let n = 0; const t = setInterval(() => { process.stdout.write('.'); if (++n === 30) { clearInterval(t); process.exit(0); } }, 100);";
    const run = await superviseRun(process.execPath, ["-e", script], { ...WATCHDOG, stallTimeoutMs: 1_000 }, quiet);
    expect(run.ending).toBe("exited");
    expect(run.elapsedMs).toBeGreaterThan(2_000);
    expect(run.exitCode).toBe(0);
    expect(run.terminal.ending).toBe("exited");
    expect(run.terminal.outputComplete).toBe(true);
    expect(run.terminal.supervision?.noOwnedChildren).toBe(true);
    expect(run.terminal.supervision?.reaped.filter((child) => child.killed)).toHaveLength(0);
  });

  test("DRIVEN: a run that prints FOREVER is killed at the hard ceiling — whatever the load, and it fails", async () => {
    const script = "setInterval(() => process.stdout.write('.'), 100);";
    const run = await superviseRun(process.execPath, ["-e", script], { stallTimeoutMs: 60_000, hardCeilingMs: 2_000, killGraceMs: 500 }, quiet);
    // The ending names the hard ceiling: that is its path, never a wall clock (NO-LOAD-BLOCK).
    expect(run).toMatchObject({ ending: "ceiling", exitCode: 1 });
  });

  test("DRIVEN: the LAUNCHER exits (a SIGTERM to the `npm test` wrapper) — the run is stopped with everything it started, and it fails", async () => {
    // step6-readiness-2 F-11: the wrapper reported 143 while the orphaned
    // runner finished the whole suite and held the test-run lock.
    const dir = createTempDir("ch-watchdog-launcher-");
    const childPid = join(dir, "child.pid");
    const result = join(dir, "run.json");
    const runner = join(dir, "runner.mts");
    writeFileSync(runner, [
      `import { writeFileSync } from "node:fs";`,
      `import { superviseRun } from ${JSON.stringify(join(process.cwd(), "scripts", "run-tests.ts"))};`,
      `const child = ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(childPid)}, String(process.pid)); setInterval(() => process.stdout.write('.'), 100);`)};`,
      `const run = await superviseRun(process.execPath, ["-e", child], { stallTimeoutMs: 60_000, hardCeilingMs: 120_000, killGraceMs: 500 }, { checkout: process.cwd(), write: () => undefined, watchIntervalMs: 100, stopWhenLauncherExits: true });`,
      `writeFileSync(${JSON.stringify(result)}, JSON.stringify(run));`,
      "process.exit(0);",
    ].join("\n"));
    // The launcher waits on the runner the way `npm run` waits on its script;
    // a SIGTERM ends the launcher alone and orphans the runner.
    const launcher = spawn("sh", ["-c", '"$0" "$1" & wait', process.execPath, runner], { stdio: "ignore" });
    for (let i = 0; i < 200 && !existsSync(childPid); i += 1) await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(childPid), "the supervised child never started").toBe(true);
    const pid = Number(readFileSync(childPid, "utf8"));
    launcher.kill("SIGTERM");
    for (let i = 0; i < 200 && !existsSync(result); i += 1) await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(result), "the orphaned runner never stopped").toBe(true);
    expect(JSON.parse(readFileSync(result, "utf8"))).toMatchObject({ ending: "launcher-exited", exitCode: 1 });
    for (let i = 0; i < 50 && isProcessAlive(pid); i += 1) await new Promise((r) => setTimeout(r, 100));
    expect(isProcessAlive(pid), "the stopped run left its command running").toBe(false);
  });

  test("DRIVEN: the child's own failure is the run's failure", async () => {
    const run = await superviseRun(process.execPath, ["-e", "process.exit(3)"], WATCHDOG, quiet);
    expect(run).toMatchObject({ ending: "exited", exitCode: 3 });
  });

  test("`npm test` goes through it", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["test"]).toContain("scripts/run-tests.ts");
    // The raw escape hatch may exist, but it must not BE the default.
    expect(pkg.scripts["test"]).not.toBe("vitest run");
  });
});

describe("2. the watchdog's numbers come from the config, validated by the config contract", () => {
  test("stall < ceiling, and the per-test timeout is under the stall limit", () => {
    const configured = readWebSuiteWatchdog();
    expect("missing" in configured, JSON.stringify(configured)).toBe(false);
    if ("missing" in configured) return;
    expect(TEST_HANG_BACKSTOP_MS).toBeLessThan(configured.stallTimeoutMs);
    expect(configured.stallTimeoutMs).toBeLessThan(configured.hardCeilingMs);
    const cfg = readSourceView("vitest.config.ts").code();
    expect(cfg).toContain("TEST_HANG_BACKSTOP_MS");
    expect(cfg).not.toMatch(/testTimeout:\s*\d/);
  });
});

describe("3. strays are NAMED before a run, never killed, and only the right ones", () => {
  /** A cmdline that a REAL vitest process would have. */
  const realVitest = "node /x/node_modules/vitest/dist/workers/forks.js";
  /** Candidates sit in a DIFFERENT process group from the launcher, which is
   *  what a detached run genuinely does. */
  const otherGroup = (pid: number): number => (pid === 999 || pid === 777 ? 1 : 2);
  /** Orphaned: reparented to init. */
  const orphaned = (): number => 1;

  test("it names this project's orphaned vitest processes (KILL-OWNED-ONLY: the run did not start them, so it does not stop them)", () => {
    expect(strayVitest(() => [111, 222], () => process.cwd(), 999, () => realVitest, otherGroup, orphaned)).toEqual([111, 222]);
    expect(strayVitest.length, "the finder takes no kill: nothing it finds is signalled").toBe(0);
  });

  test("a LIVE run — one whose parent is still alive — is not a stray", () => {
    // Another agent, a watch mode, or a colleague's terminal running vitest in this very directory.
    expect(strayVitest(() => [111], () => process.cwd(), 999, () => realVitest, otherGroup, () => 4242)).toEqual([]);
  });

  test("a process that merely MENTIONS vitest is not one", () => {
    expect(strayVitest(() => [111], () => process.cwd(), 999, () => "/bin/bash -c ps -eo args | grep -i vitest", () => 1)).toEqual([]);
  });

  test("nothing in its OWN process group is one", () => {
    expect(strayVitest(() => [111], () => process.cwd(), 999, () => realVitest, () => 42)).toEqual([]);
  });

  test("a vitest running in a DIFFERENT project is not one", () => {
    expect(strayVitest(() => [111], () => "/some/other/project", 999, () => realVitest, otherGroup, orphaned)).toEqual([]);
  });

  test("it never names itself", () => {
    expect(strayVitest(() => [777], () => process.cwd(), 777, () => realVitest, otherGroup, orphaned)).toEqual([]);
  });
});

/**
 * 5. NO UNBOUNDED LOOP WHOSE BOUND IS A MUTABLE CONSTANT.
 *
 * This is the shape that produced the original spin: a loop written as
 * `for (let i = 0; i < CAP + 3; i += 1)` where `CAP` is a `let`. Raise `CAP`
 * anywhere — a mutation, a config change, a test helper — and the loop's exit
 * condition moves with it, forever.
 *
 * The scanner is a pure function over a source VIEW so its own self-checks
 * can run it over synthetic source (`sourceViewOf`), which is what makes them
 * prove something; the tree is read through the sanctioned reader.
 */
export function findMutableBoundLoops(view: SourceView): string[] {
  const findings: string[] = [];
  // CODE ONLY. The first version scanned raw text and flagged
  // `artifact-runtime-errors.test.ts` — the very file that spun for 1h16m —
  // because a TEST NAME contains the words "while(true) parent.postMessage".
  // A scanner that reads prose reports defects that do not exist, and a guard
  // that cries wolf on its own documentation is one that gets deleted. The
  // source-view owner's `code()` blanks comments and string/template interiors
  // with the lexer every scanner shares (a private regex stripper here was a
  // second, weaker lexer).
  const src = view.code();
  // A `while` loop with a literal `true` condition and no `break` anywhere.
  // Checked FIRST and unconditionally: an early return on "this file declares
  // no mutable caps" would skip it, which it did — caught by the self-check
  // below, which is the whole reason the scanner is a pure function.
  if (/while\s*\(\s*true\s*\)/.test(src) && !/\bbreak\b/.test(src)) {
    findings.push("while(true) with no break");
  }
  // `let`/`var` declarations in this file — the mutable names.
  const mutable = new Set<string>();
  for (const m of src.matchAll(/^\s*(?:let|var)\s+([A-Z][A-Z0-9_]*)\b/gm)) {
    mutable.add(m[1]!);
  }
  if (mutable.size === 0) return findings;
  // A `for` loop whose condition compares against one of them.
  for (const m of src.matchAll(/for\s*\([^;]*;\s*[^;]*?\b([A-Z][A-Z0-9_]*)\b[^;]*;/g)) {
    const name = m[1]!;
    if (mutable.has(name)) findings.push(name);
  }
  return findings;
}


describe("5. no test contains an unbounded loop with a mutable bound", () => {
  test("every test file is clean", () => {
    const offenders: string[] = [];
    for (const file of walk("tests", { exts: SOURCE_EXTS })) {
      if (!file.endsWith(".ts")) continue;
      const found = findMutableBoundLoops(readSourceView(file));
      for (const f of found) offenders.push(`${relpath(file)}: ${f}`);
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});

describe("mutation: the run-watchdog guards fail when the rule is removed", () => {
  /** A planted source, through the fixture door of the same view owner. */
  const scan = (text: string): string[] => findMutableBoundLoops(sourceViewOf(text, "planted.test.ts"));

  test("the scanner catches a loop bounded by a mutable constant", () => {
    // The ORIGINAL shape, verbatim in spirit: raise CAP and the loop never
    // ends.
    const bad = `let CAP = 10;\nfor (let i = 0; i < CAP + 3; i += 1) { work(i); }`;
    expect(scan(bad)).toContain("CAP");
  });

  test("a const bound is NOT flagged — it cannot move", () => {
    const good = `const CAP = 10;\nfor (let i = 0; i < CAP + 3; i += 1) { work(i); }`;
    expect(scan(good)).toEqual([]);
  });

  test("the scanner catches while(true) with no break", () => {
    expect(scan(`while (true) { i += 1; }`)).toContain(
      "while(true) with no break",
    );
  });

  test("while(true) WITH a break is not flagged", () => {
    expect(scan(`while (true) { if (done) break; }`)).toEqual([]);
  });

  test("a while(true) inside a STRING is not flagged", () => {
    // The real false positive this fixed: a test named
    // "HOSTILE: `while(true) parent.postMessage(...)` keeps a bounded number"
    // in artifact-runtime-errors.test.ts.
    const prose = 'test("HOSTILE: while (true) parent.postMessage(x)", () => { ok(); });';
    expect(scan(prose)).toEqual([]);
  });

  test("a while(true) inside a COMMENT is not flagged", () => {
    expect(scan(`// while (true) { spin(); }\nconst x = 1;`)).toEqual([]);
  });

  test("…but real code beside that prose IS still flagged", () => {
    // The stripper must not become a way to hide a real spin.
    const mixed = 'const name = "while (true) is bad";\nwhile (true) { spin(); }';
    expect(scan(mixed)).toContain("while(true) with no break");
  });

});
