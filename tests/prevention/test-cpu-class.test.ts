// @vitest-environment node
/**
 * THE PER-TEST JUDGEMENT IS CPU WORK, AND IT CAN FAIL (TEST-CPU-CLASSES).
 *
 * The judgement (engine/scripts/tooling/test-cpu-class.ts) is driven here
 * through fake hooks, so each arm is a plant from outside the owner: a test
 * that burns CPU past a small ceiling is refused, the same work under a
 * larger class passes, and WAITING (wall time with no work) is never judged —
 * the load-independence this whole change exists for. The web door's wiring
 * is read from the config the runner loads.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  cpuClassOf,
  deadClassFiles,
  installTestCpuJudgement,
  type TestCpuClasses,
} from "../../engine/scripts/tooling/test-cpu-class.ts";
import { readTestCpuClasses, readTestHangBackstopMs, readWebSuiteWatchdog } from "../helpers/budget-config.ts";

const HERE = "tests/prevention/test-cpu-class.test.ts";
const REPOSITORY_ROOT = process.cwd();

/** Runs one fake test through the judgement: its hooks, then `body`, then the verdict. */
function judged(classes: TestCpuClasses, file: string, body: () => void): { error: unknown; reading: { cpuMs: number; wallMs: number } | null } {
  let before: (() => void) | undefined;
  let after: ((context: string) => void) | undefined;
  let reading: { cpuMs: number; wallMs: number } | null = null;
  installTestCpuJudgement<string>(
    { beforeEach: (hook) => { before = () => hook(file); }, afterEach: (hook) => { after = hook; } },
    classes,
    (context) => context,
    (_context, measured) => { reading = measured; },
  );
  before!();
  body();
  try {
    after!(file);
    return { error: null, reading };
  } catch (error) {
    return { error, reading };
  }
}

/** Burns about `ms` of this process's CPU. */
function burn(ms: number): void {
  const start = process.cpuUsage();
  let x = 0;
  while (true) {
    const used = process.cpuUsage(start);
    if ((used.user + used.system) / 1000 >= ms) break;
    for (let i = 0; i < 10_000; i += 1) x += i;
  }
  expect(x).toBeGreaterThan(0);
}

describe("the judgement", () => {
  const classes: TestCpuClasses = { defaultCeilingMs: 50, classes: [{ name: "heavy", ceilingMs: 5_000, files: [HERE] }] };

  test("work past the default ceiling FAILS, naming the work, the class and where it is declared", () => {
    const { error, reading } = judged(classes, "tests/unit/somewhere-else.test.ts", () => burn(150));
    expect(reading?.cpuMs).toBeGreaterThanOrEqual(140);
    expect(String(error)).toMatch(/did \d+ ms of CPU work, over its default class ceiling of 50 ms/u);
    expect(String(error)).toContain("testExecution.testCpuClasses");
  });

  test("the same work in a file its class was declared for passes", () => {
    const { error, reading } = judged(classes, HERE, () => burn(150));
    expect(error).toBeNull();
    expect(reading?.cpuMs).toBeGreaterThanOrEqual(140);
  });

  test("a CHILD's work counts: what a test spawns and reaps is its work", () => {
    const { error, reading } = judged(classes, "tests/unit/somewhere-else.test.ts", () => {
      const child = spawnSync(process.execPath, ["-e", "const s=process.cpuUsage();let x=0;while(true){const u=process.cpuUsage(s);if((u.user+u.system)/1000>=200)break;x++}"]);
      expect(child.status).toBe(0);
    });
    expect(reading?.cpuMs).toBeGreaterThanOrEqual(150);
    expect(String(error)).toMatch(/over its default class ceiling/u);
  });

  test("WAITING is not work: a test that sleeps far past its ceiling in wall time passes", () => {
    const { error, reading } = judged(classes, "tests/unit/somewhere-else.test.ts", () => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    });
    expect(error).toBeNull();
    expect(reading!.wallMs).toBeGreaterThanOrEqual(290);
    expect(reading!.cpuMs).toBeLessThan(50);
  });

  test("a file in no class is judged by the default; a declared file by its class", () => {
    expect(cpuClassOf(classes, HERE)).toEqual({ name: "heavy", ceilingMs: 5_000 });
    expect(cpuClassOf(classes, "tests/unit/x.test.ts")).toEqual({ name: "default", ceilingMs: 50 });
  });

  test("a class naming a file the repository does not hold is refused", () => {
    expect(deadClassFiles(classes, REPOSITORY_ROOT)).toBeNull();
    const gone = `tests/unit/gone-${Math.random().toString(36).slice(2)}.test.ts`;
    expect(deadClassFiles({ defaultCeilingMs: 1, classes: [{ name: "heavy", ceilingMs: 2, files: [gone] }] }, REPOSITORY_ROOT)).toContain(`heavy: ${gone}`);
  });
});

describe("the web door installs it", () => {
  test("the declared classes and the backstop are read from the config, and every class file exists", () => {
    const declared = readTestCpuClasses();
    expect("missing" in declared, JSON.stringify(declared)).toBe(false);
    if ("missing" in declared) return;
    expect(deadClassFiles(declared, REPOSITORY_ROOT)).toBeNull();
    const watchdog = readWebSuiteWatchdog();
    if ("missing" in watchdog) throw new Error(watchdog.missing);
    // A hung test is named by its backstop before the stall watchdog kills the run.
    expect(readTestHangBackstopMs()).toBeLessThan(watchdog.stallTimeoutMs);
  });

  test("vitest.config.ts loads the judgement for every test and bounds a test only by the backstop", () => {
    const config = readFileSync(join(REPOSITORY_ROOT, "vitest.config.ts"), "utf8");
    expect(config).toMatch(/setupFiles: \[[^\]]*"\.\/tests\/setup\/test-cpu-class\.ts"/u);
    expect(config).toMatch(/testTimeout:\s*TEST_HANG_BACKSTOP_MS/u);
    expect(config).toMatch(/hookTimeout:\s*TEST_HANG_BACKSTOP_MS/u);
  });

  test("this very test carries its reading", ({ task }) => {
    // The setup file's beforeEach ran before this body; its afterEach writes
    // the reading after it. A previous test in this file proves it was written.
    const previous = task.file.tasks.flatMap((one) => (one.type === "suite" ? one.tasks : [one]))
      .find((one) => one.name === "the declared classes and the backstop are read from the config, and every class file exists");
    expect(typeof previous?.meta.cpuMs).toBe("number");
    expect(typeof previous?.meta.wallMs).toBe("number");
  });
});
