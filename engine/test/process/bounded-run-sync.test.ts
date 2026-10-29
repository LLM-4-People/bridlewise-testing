/**
 * THE ONE BOUNDED RUN FOR A SYNCHRONOUS CALLER (`runCpuBoundedSync`,
 * src/process/bounded-run-sync.ts): the same run as `runCpuBounded`,
 * answered without a promise. It is the same group, stall rule, CPU budget,
 * output bound and missing-command answer, from a file and from a
 * `node --input-type=module -e` parent (whose worker must still start: #307's
 * class). An idle bridge never keeps its process alive. Every child these
 * tests start ends on its own.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { type SubprocessBounds } from "../../src/process/subprocess-bounds.ts";
import { runCpuBoundedSync } from "../../src/process/bounded-run-sync.ts";

const TIGHT: SubprocessBounds = { cpuBudgetMs: 400, stallMs: 600, hangBackstopMs: 120_000, pollMs: 50, killGraceMs: 200, outputBytes: 1 << 20 };
const BRIDGE = new URL("../../src/process/bounded-run-sync.ts", import.meta.url).href;
const NODE = process.execPath;

test("a synchronous run answers the command's status, its output and what it read on stdin", () => {
  const run = runCpuBoundedSync(NODE, ["-e", "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stdout.write(s.toUpperCase());process.stderr.write('e');process.exit(3)})"], { cwd: process.cwd(), input: Buffer.from("piped"), bounds: TIGHT });
  assert.equal(run.ending, "exited");
  assert.equal(run.status, 3);
  assert.ok(Buffer.isBuffer(run.stdout), "stdout is a Buffer again after the thread hop");
  assert.equal(run.stdout.toString("utf8"), "PIPED");
  assert.equal(run.stderr.toString("utf8"), "e");
});

test("a synchronous run is the same bounded run: a quiet command is a stall, a burning one is over budget, a missing one never started", () => {
  // A quiet child lives 3 s (well past the 600 ms window), then exits on its own.
  assert.equal(runCpuBoundedSync(NODE, ["-e", "setTimeout(()=>{},3000)"], { cwd: process.cwd(), bounds: TIGHT }).ending, "stalled");
  // A busy child burns at most 4 s of CPU (ten budgets), then exits on its own.
  const burning = runCpuBoundedSync(NODE, ["-e", "const u=()=>{const c=process.cpuUsage();return (c.user+c.system)/1000};const t=u()+4000;while(u()<t){}"], { cwd: process.cwd(), bounds: TIGHT });
  assert.equal(burning.ending, "cpu-exhausted");
  const missing = runCpuBoundedSync("bridlewise-no-such-command", [], { cwd: process.cwd(), bounds: TIGHT });
  assert.equal(missing.ending, "unstarted");
  assert.equal(missing.startError, "ENOENT");
});

test("a synchronous run's output bound stops the group", () => {
  // 64 KiB every 10 ms for at most 4 s: past the 64 KiB bound after two chunks, still running at every poll until
  // stopped, and it ends on its own.
  const run = runCpuBoundedSync(NODE, ["-e", "const b=Buffer.alloc(65536,120);let n=0;const t=setInterval(()=>{process.stdout.write(b);if(++n>=400)clearInterval(t)},10)"], { cwd: process.cwd(), bounds: { ...TIGHT, outputBytes: 1 << 16 } });
  assert.equal(run.ending, "output-exceeded");
});

/** A parent started with `parentOptions` runs one synchronous `git --version` and exits; answers its status and output. */
function fromParent(parentOptions: readonly string[]): ReturnType<typeof spawnSync> {
  const script = `const { runCpuBoundedSync } = await import(${JSON.stringify(BRIDGE)}); const run = runCpuBoundedSync(${JSON.stringify(NODE)}, ["-e", "console.log('answered')"], { cwd: process.cwd(), bounds: ${JSON.stringify(TIGHT)} }); process.stdout.write(run.ending + " " + run.stdout.toString());`;
  // No wall timeout of its own (the no-load rule): a parent that never ends is the suite's hang backstop's.
  return spawnSync(NODE, [...parentOptions, "-e", script], { encoding: "utf8" });
}

test("a `node --input-type=module -e` parent's bridge starts and answers, and an idle bridge lets its process exit", () => {
  const run = fromParent(["--input-type=module"]);
  assert.equal(run.status, 0, String(run.stderr));
  assert.equal(String(run.stdout).trim(), "exited answered");
});
