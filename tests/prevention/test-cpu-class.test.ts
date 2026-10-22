// @vitest-environment node
/**
 * THE PER-TEST JUDGEMENT IS CPU WORK, AND IT CAN FAIL (TEST-CPU-CLASSES).
 *
 * The judgement (engine/scripts/tooling/test-cpu-class.ts) is driven here
 * through fake hooks, so each arm is a plant from outside the owner: a test
 * that burns CPU past a small ceiling is refused, the same work under a
 * larger class passes, and WAITING (wall time with no work) is never judged —
 * the load-independence this whole change exists for. The web door's wiring
 * is read from the config the runner loads, and the runtime check that no
 * test declares its own wall bound is driven by planted files in a real
 * nested run (tests/setup/test-cpu-class.ts).
 */
import { spawnSync } from "node:child_process";
import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";

import { testProcessSupervisorBinary } from "../../engine/guardian/build.ts";
import { runBoundedTestProcess } from "../../engine/src/process/supervised-run.ts";

import {
  cpuClassOf,
  deadClassFiles,
  installTestCpuJudgement,
  type TestCpuClasses,
} from "../../engine/scripts/tooling/test-cpu-class.ts";
import { readTestCpuClasses, readTestHangBackstopMs, readWebSuiteWatchdog, webSuiteKillGraceMs } from "../helpers/budget-config.ts";
import { createTempDir } from "../helpers/temp-dir.ts";
import { NESTED_RUNNER_LAUNCH_MS } from "../test-budget.ts";

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

/**
 * Runs the PLANTED test files through a real nested vitest run on this
 * suite's own config (its setup files, its two projects), and returns each
 * planted test's state and first error, by name. The planted files sit in a
 * temporary folder; the run's own wall bound is the nested-runner backstop.
 */
function plantedRun(files: Readonly<Record<string, string>>): Map<string, Readonly<{ state: string; error: string }>> {
  const directory = createTempDir("wall-bound-plants-");
  symlinkSync(resolve("node_modules"), join(directory, "node_modules"), "dir");
  for (const [name, text] of Object.entries(files)) writeFileSync(join(directory, name), text);
  const tests = Object.keys(files).filter((name) => name.endsWith(".test.ts")).map((name) => join(directory, name));
  const dom = tests.filter((file) => /@vitest-environment jsdom/u.test(readFileSync(file, "utf8")));
  const report = join(directory, "report.json");
  const configuration = join(directory, "vitest.config.mjs");
  writeFileSync(configuration, `import base from ${JSON.stringify(pathToFileURL(resolve("vitest.config.ts")).href)};
const files={dom:${JSON.stringify(dom)},node:${JSON.stringify(tests.filter((file) => !dom.includes(file)))}};
export default {...base,test:{...base.test,include:[],globalSetup:[],reporters:[['json',{outputFile:${JSON.stringify(report)}}]],
 projects:base.test.projects.map(project=>({...project,test:{...project.test,include:files[project.test.name],exclude:[],globalSetup:[]}}))}};`);
  const run = runBoundedTestProcess(testProcessSupervisorBinary(), process.execPath, [resolve("node_modules/vitest/vitest.mjs"), "run", "--config", configuration],
    { timeoutMs: NESTED_RUNNER_LAUNCH_MS, killGraceMs: webSuiteKillGraceMs() });
  expect(run.error, run.stderr).toBeUndefined();
  const parsed = JSON.parse(readFileSync(report, "utf8")) as { testResults: { assertionResults: { title: string; status: string; failureMessages: string[] }[] }[] };
  return new Map(parsed.testResults.flatMap((file) => file.assertionResults).map((result) => [result.title, { state: result.status, error: result.failureMessages[0] ?? "" }]));
}

describe("no web test declares its own wall bound: the runtime check", () => {
  test("PLANT: every spelling the review found fails the run naming its test, and the clean tests pass", () => {
    const LIMIT = "5_000";
    const results = plantedRun({
      "helpers.ts": `import { test } from "vitest";
export const slowTest = (name: string, fn: () => void) => test(name, fn, ${LIMIT});
export const importedOptions = { timeout: ${LIMIT} };
export function builtOptions() { return { timeout: ${LIMIT} }; }`,
      "aliased-import.test.ts": `import { it as check } from "vitest";\ncheck("an aliased import", () => {}, ${LIMIT});`,
      "namespace-import.test.ts": `import * as vt from "vitest";\nvt.test("a namespace import", () => {}, ${LIMIT});`,
      "spread-options.test.ts": `import { test } from "vitest";\nconst base = { timeout: ${LIMIT} };\ntest("spread options", { ...base }, () => {});`,
      "imported-options.test.ts": `import { test } from "vitest";\nimport { builtOptions, importedOptions } from "./helpers.ts";
test("imported options", importedOptions, () => {});\ntest("options built by a call", builtOptions(), () => {});`,
      "helper-wrapper.test.ts": `import { slowTest } from "./helpers.ts";\nslowTest("a wrapper in a helper", () => {});`,
      "element-access-setconfig.test.ts": `import { test, vi } from "vitest";\ntest("setConfig by element access", () => { vi["setConfig"]({ testTimeout: ${LIMIT} }); });`,
      "hook-bounds.test.ts": `import { afterEach, describe, test } from "vitest";
describe("a bounded hook", () => { afterEach(() => {}, ${LIMIT}); test("under a bounded afterEach", () => {}); });
describe("an unbounded hook", () => { afterEach(() => {}, 0); test("under an afterEach with no bound", () => {}); });`,
      "no-bound.test.ts": `import { test } from "vitest";\ntest("a test with no bound at all", () => {}, 0);`,
      "dom-aliased.test.ts": `// @vitest-environment jsdom\nimport { test as check } from "vitest";\ncheck("an aliased import in the DOM pool", () => {}, ${LIMIT});`,
      "clean.test.ts": `import { afterEach, test } from "vitest";\nafterEach(() => {});\ntest("clean", () => {});\ntest("clean options", { retry: 0 }, () => {});`,
    });
    const refused = [
      "an aliased import", "a namespace import", "spread options", "imported options", "options built by a call",
      "a wrapper in a helper", "setConfig by element access", "under a bounded afterEach", "under an afterEach with no bound",
      "a test with no bound at all", "an aliased import in the DOM pool",
    ];
    for (const title of refused) {
      expect(results.get(title)?.state, `${title}: ${JSON.stringify(results.get(title))}`).toBe("failed");
      expect(results.get(title)?.error, title).toMatch(/a per-test or per-hook wall timeout is not allowed: the only wall bound is the hang backstop/u);
    }
    expect(results.get("clean")?.state).toBe("passed");
    expect(results.get("clean options")?.state).toBe("passed");
  });

});
