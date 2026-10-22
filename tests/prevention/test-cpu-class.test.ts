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
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
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

const ts = createRequire(import.meta.url)("typescript5") as typeof import("typescript5");

/** The runner's test and hook functions a per-test timeout can ride on (an alias of any of them too). */
const TIMED_CALLS = new Set(["test", "it", "describe", "suite", "bench", "beforeAll", "afterAll", "beforeEach", "afterEach"]);
/** Hooks take (fn, timeout); tests and suites take (name, [options,] fn, timeout). */
const HOOKS = new Set(["beforeAll", "afterAll", "beforeEach", "afterEach"]);
/** The option names that set a per-test or per-hook WALL bound, in a test's options or the runner's config. */
const TIMEOUT_KEYS = new Set(["timeout", "testTimeout", "hookTimeout"]);

type TsNode = import("typescript5").Node;
type TsExpression = import("typescript5").Expression;

/**
 * Every per-test WALL timeout a source declares, read from the TypeScript
 * AST (spelling-proof: a regular expression cannot win this):
 *
 * - a trailing timeout ARGUMENT to a test, suite or hook, or to an ALIAS of
 *   one (`const slow = test.extend(…)`, `const t = it`): the last argument
 *   after the name (tests) or the function (hooks), unless it is a function —
 *   a literal, an arrow, a function expression, or a name declared as a
 *   function in the file;
 * - a `timeout`/`testTimeout`/`hookTimeout` PROPERTY — bare, quoted or
 *   computed — in an options object passed to such a call, directly or
 *   through a variable declared in the file;
 * - any `setConfig(…)` call (`vi.setConfig`) that sets one of them.
 */
function declaredWallTimeouts(file: string, text: string): readonly string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: string[] = [];
  const at = (node: TsNode): string => `${file}:${String(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1)}`;
  // Declarations by name, file-wide (the scope a test file's helpers live in).
  const initializers = new Map<string, TsExpression>();
  const functions = new Set<string>();
  const declare = (node: TsNode): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      initializers.set(node.name.text, node.initializer);
      if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) functions.add(node.name.text);
    }
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) functions.add(node.name.text);
    ts.forEachChild(node, declare);
  };
  declare(source);
  // The callee's base name (`test.skip.each(…)(…)` → test), through aliases declared in the file.
  const base = (expression: TsExpression, seen = new Set<string>()): string | undefined => {
    if (ts.isIdentifier(expression)) {
      if (TIMED_CALLS.has(expression.text)) return expression.text;
      const aliased = initializers.get(expression.text);
      if (aliased === undefined || seen.has(expression.text)) return undefined;
      seen.add(expression.text);
      return base(aliased, seen);
    }
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) return base(expression.expression, seen);
    if (ts.isCallExpression(expression)) return base(expression.expression, seen);
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isNonNullExpression(expression)) return base(expression.expression, seen);
    return undefined;
  };
  const isFunctionLike = (expression: TsExpression): boolean =>
    ts.isArrowFunction(expression) || ts.isFunctionExpression(expression) || (ts.isIdentifier(expression) && functions.has(expression.text));
  const keyOf = (property: import("typescript5").ObjectLiteralElementLike): string | undefined => {
    const name = property.name;
    if (name === undefined) return undefined;
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name) || ts.isNumericLiteral(name)) return name.text;
    if (ts.isComputedPropertyName(name)) {
      const inner = name.expression;
      if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) return inner.text;
      if (ts.isIdentifier(inner)) {
        const value = initializers.get(inner.text);
        if (value !== undefined && (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))) return value.text;
      }
    }
    return undefined;
  };
  // An options object, given directly or through a variable declared in the file.
  const optionsObject = (expression: TsExpression): import("typescript5").ObjectLiteralExpression | undefined => {
    if (ts.isObjectLiteralExpression(expression)) return expression;
    if (ts.isIdentifier(expression)) {
      const value = initializers.get(expression.text);
      return value !== undefined && ts.isObjectLiteralExpression(value) ? value : undefined;
    }
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)) return optionsObject(expression.expression);
    return undefined;
  };
  const timeoutKeys = (object: import("typescript5").ObjectLiteralExpression): readonly string[] =>
    object.properties.map(keyOf).filter((key): key is string => key !== undefined && TIMEOUT_KEYS.has(key));
  const visit = (node: TsNode): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      // `vi.setConfig({ testTimeout })` (or any setConfig): the runner-wide bound, set from a test.
      if ((ts.isPropertyAccessExpression(callee) && callee.name.text === "setConfig") || (ts.isIdentifier(callee) && callee.text === "setConfig")) {
        for (const argument of node.arguments) {
          const object = optionsObject(argument);
          if (object !== undefined && timeoutKeys(object).length > 0) found.push(`${at(node)} setConfig ${timeoutKeys(object).join(",")}`);
        }
      }
      const name = base(callee);
      // Only the CALL that runs a test or hook: `test.extend(…)` / `test.each(rows)` build one and are not it.
      const builds = ts.isPropertyAccessExpression(callee) && ["extend", "each", "for", "skipIf", "runIf"].includes(callee.name.text);
      if (name !== undefined && !builds) {
        const args = node.arguments;
        const firstAfter = HOOKS.has(name) ? 1 : 2;
        if (args.length > firstAfter) {
          const last = args[args.length - 1]!;
          if (!isFunctionLike(last) && optionsObject(last) === undefined) found.push(`${at(node)} trailing ${last.getText(source)}`);
        }
        for (const argument of args) {
          const object = optionsObject(argument);
          if (object !== undefined && timeoutKeys(object).length > 0) found.push(`${at(node)} option ${timeoutKeys(object).join(",")}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("no web test declares its own wall timeout", () => {
  test("every tracked web test leaves its bound to the one hang backstop", () => {
    const files = execFileSync("git", ["ls-files", "-z", "--", "tests/*.test.ts"], { cwd: REPOSITORY_ROOT, encoding: "utf8" })
      .split("\0").filter((file) => file.length > 0);
    expect(files.length, "the index yielded no web test file").toBeGreaterThan(300);
    const declared = files.flatMap((file) => declaredWallTimeouts(file, readFileSync(join(REPOSITORY_ROOT, file), "utf8")));
    expect(
      declared,
      "a per-test timeout is a WALL judgement (TEST-CPU-CLASSES): a test is judged by its CPU work against its file's class, " +
        "and only the hang backstop (testExecution.testHangBackstopMs) ends it. Remove the timeout, or declare the file in a class",
    ).toEqual([]);
  });

  test("PLANT: every spelling of a per-test wall bound is found, and nothing that is not one", () => {
    const planted = [
      /* 1 */ 'test("a", () => {}, 30_000);',
      /* 2 */ 'it("b", async () => {}, LIMIT);',
      /* 3 */ 'test("c", { timeout: 5000 }, () => {});',
      /* 4 */ 'beforeAll(() => {}, 60_000);',
      /* 5 */ 'describe.each([1])("d", () => {}, 1000);',
      /* 6 */ 'function body() {}',
      /* 7 */ 'test("named body", body, 2 * 1000);',
      /* 8 */ 'const slow = test.extend({});',
      /* 9 */ 'slow("an alias", () => {}, 9_000);',
      /* 10 */ 'test("quoted", { "timeout": 1 }, () => {});',
      /* 11 */ 'test("computed", { ["timeout"]: 1 }, () => {});',
      /* 12 */ 'const KEY = "timeout";',
      /* 13 */ 'test("computed by name", { [KEY]: 1 }, () => {});',
      /* 14 */ 'const options = { timeout: 1 };',
      /* 15 */ 'test("an options variable", options, () => {});',
      /* 16 */ 'vi.setConfig({ testTimeout: 1 });',
      /* 17 */ 'vi.setConfig({ "hookTimeout": 1 });',
      /* 18 */ 'it.skip("e", () => {}, BACKSTOP);',
      /* 19 */ 'afterEach(async function () {}, 1);',
      /* 20 */ 'test("clean", () => {});',
      /* 21 */ 'test("clean named body", body);',
      /* 22 */ 'test("clean options", { retry: 0 }, () => {});',
      /* 23 */ 'beforeEach(() => {});',
      /* 24 */ 'const t = it;',
      /* 25 */ 't("alias of it", () => {}, 5);',
      /* 26 */ 'spawnSync("node", [], { timeout: 1 });',
    ].join("\n");
    expect(declaredWallTimeouts("planted.test.ts", planted).map((line) => Number(line.split(" ")[0]!.split(":")[1]))).toEqual([
      1, 2, 3, 4, 5, 7, 9, 10, 11, 13, 15, 16, 17, 18, 19, 25,
    ]);
  });
});

