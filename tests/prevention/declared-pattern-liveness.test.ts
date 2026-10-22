// @vitest-environment node
import { describe, expect, test } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { globSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  checkRepository,
  checkTsconfigIncludeLiveness,
} from "../../engine/scripts/verification/tsconfig-include-liveness.ts";
import {
  deadPatterns,
  globMatchCounts,
  patternLivenessFailure,
} from "../../engine/scripts/verification/pattern-liveness.ts";
import { createTempDir } from "../helpers/temp-dir.ts";
import { TEST_INCLUDE } from "../test-include.ts";
import { DECLARED_ROOT } from "../declared-root.ts";
import { readRunCpu } from "../../engine/src/shared/run-cpu.ts";
import { loadavg } from "node:os";
import { spawn } from "node:child_process";
const psi = () => ["cpu", "memory", "io"].map((k) => { try { return `${k}:${readFileSync(`/proc/pressure/${k}`, "utf8").split("\n").map((l) => /total=(\d+)/u.exec(l)?.[1]).join(",")}`; } catch { return `${k}:?`; } }).join(" ");
function phase<T>(label: string, run: () => T): T {
  const w = performance.now(), c0 = readRunCpu(), s0 = process.cpuUsage();
  const v = run();
  const s = process.cpuUsage(s0), c1 = readRunCpu();
  console.error(`[noload-diag] ${label} wall=${(performance.now() - w).toFixed(0)} self=${((s.user + s.system) / 1000).toFixed(0)} child=${c0 && c1 ? c1.childCpuMs - c0.childCpuMs : "?"} load=${loadavg().map((n) => n.toFixed(1)).join("/")} at=${new Date().toISOString()} ${psi()}`);
  return v;
}

const WEB_ROOT = process.cwd();
const INTEGRATION_ROOT = join(WEB_ROOT, "engine");

describe("declared pattern liveness — both repositories", () => {
  test("every tsconfig include pattern in BOTH repositories selects at least one file", () => {
    const reports = [...checkRepository(WEB_ROOT), ...checkRepository(INTEGRATION_ROOT)];
    const patterns = reports.flatMap((r) => r.perPattern);
    expect(
      reports.length,
      "no tsconfig was examined — a liveness check with an empty subject agrees with everything",
    ).toBeGreaterThan(0);
    expect(
      patterns.length,
      "no include patterns were examined across either repository",
    ).toBeGreaterThan(0);
    const failures = reports.filter((r) => r.failure !== null).map((r) => r.failure);
    expect(
      failures,
      "a dead include pattern removes its files from the type program while tsc still exits 0",
    ).toEqual([]);
  });

  test("every test-runner glob the vitest config declares selects at least one file", async () => {
    const config = (await import("../../vitest.config.ts")) as unknown as {
      default: { test?: { include?: readonly string[] } };
    };
    const include = config.default.test?.include ?? [];
    expect(include.length, "vitest.config.ts declares no test.include globs").toBeGreaterThan(0);
    const matches = globMatchCounts(include, WEB_ROOT);
    expect(
      deadPatterns(matches),
      "a dead runner glob drops its whole tree from the suite; the total-count floor cannot see it",
    ).toEqual([]);
    expect(matches.reduce((n, m) => n + m.matched, 0)).toBeGreaterThan(0);
  });
});

describe("the rule can fail — planted from outside the owner", () => {
  test("a tsconfig whose include names a directory that is not there is REFUSED, and the message names it", () => {
    const dir = createTempDir("tsconfig-liveness-plant-");
    mkdirSync(join(dir, "alive"), { recursive: true });
    writeFileSync(join(dir, "alive", "one.ts"), "export const one = 1;\n");
    const absent = `gone-${Math.random().toString(36).slice(2)}`;
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({ include: ["alive/**/*.ts", `${absent}/**/*.ts`] }),
    );
    const report = checkTsconfigIncludeLiveness(join(dir, "tsconfig.json"));
    expect(report.failure).not.toBeNull();
    expect(String(report.failure)).toContain(`${absent}/**/*.ts`);
    expect(String(report.failure)).toContain("alive/**/*.ts");
    expect(report.perPattern.find(([p]) => p === "alive/**/*.ts")?.[1]).toBe(1);
  });

  test("an EMPTY declaration is a refusal, not a pass", () => {
    expect(patternLivenessFailure("probe", [])).toContain("declares NO patterns");
  });

  test("a repository with no tsconfig is a refusal, not an empty success", () => {
    const dir = createTempDir("tsconfig-liveness-empty-");
    let thrown: unknown;
    try {
      checkRepository(dir);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(String((thrown as Error).message)).toMatch(/no tsconfig\*\.json found/);
  });
});

function trackedTestFiles(root: string): readonly string[] {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter((p) => p.length > 0 && !p.startsWith("engine/") && /(^|\/)[^/]*\.test\.[^/]+$/u.test(p))
    .filter((p) => DECLARED_ROOT[p.split("/")[0]!]?.class !== "record");
}

function publicRunnerFiles(root: string): ReadonlySet<string> {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  const script = manifest.scripts?.["test:public"] ?? "";
  const words = script.split(/\s+/u);
  if (words[0] !== "node" || !words.includes("--test")) return new Set();
  const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  if (!/^\s*run: npm run test:public\s*$/mu.test(ci)) return new Set();
  const globs = words.slice(words.indexOf("--test") + 1).filter((word) => !word.startsWith("-"));
  return new Set(globs.flatMap((pattern) => globSync(pattern, { cwd: root })));
}

function nodeTestRun(
  root: string,
  file: string,
): Readonly<{ status: number | null; output: string; passedNames: readonly string[] }> {
  const result = spawnSync(
    "node",
    ["--experimental-strip-types", "--test", "--test-reporter=tap", file],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000,
      killSignal: "SIGKILL",
    },
  );
  if (result.error !== undefined) {
    throw new Error(
      `node --test ${file} in ${root} did not complete: ${result.error.message}. A killed or ` +
        `un-launched child produces no TAP, and reading "no passing names" off one would be a ` +
        `crash reported as a domain answer.`,
    );
  }
  const output = `${result.stdout}${result.stderr}`;
  const passedNames = output
    .split("\n")
    .map((line) => /^ok \d+ - (?<name>.+?)(?: # .*)?$/u.exec(line)?.groups?.["name"])
    .filter((name): name is string => name !== undefined);
  return { status: result.status, output, passedNames };
}

function ranSomething(file: string, passedNames: readonly string[]): boolean {
  const base = file.split("/").at(-1) ?? file;
  return passedNames.some((name) => name !== base && name !== file);
}

describe("every test file this repository holds is executed by something", () => {
  test("no test file is selected by no runner pattern and executed by nobody", async () => {
   for (let iteration = 0; iteration < 30; iteration += 1) {
    await new Promise((r) => setTimeout(r, 1500));
    phase(`glob#${iteration}`, () => new Set(TEST_INCLUDE.flatMap((pattern) => globSync(pattern, { cwd: WEB_ROOT }))));
    phase(`public#${iteration}`, () => publicRunnerFiles(WEB_ROOT));
    const tests = phase("ls-files", () => trackedTestFiles(WEB_ROOT));
    expect(tests.length, "the index yielded no test file at all").toBeGreaterThan(300);
    const selected = new Set(TEST_INCLUDE.flatMap((pattern) => globSync(pattern, { cwd: WEB_ROOT })));
    expect(selected.size, "the runner globs selected nothing").toBeGreaterThan(300);
    const publicRun = publicRunnerFiles(WEB_ROOT);
    expect(publicRun.size, "the test:public script selects nothing").toBeGreaterThan(5);

    const orphans = tests.filter((file) => !selected.has(file) && !publicRun.has(file));
    for (const orphan of orphans) {
      const log = join(createTempDir("noload-ps-"), "ps.txt");
      const sampler = spawn("sh", ["-c", `while :; do date +%T.%N >> ${log}; ps -e -o pid=,ppid=,stat=,wchan:24=,time=,etime=,args= | awk -v root=${process.pid} '{ line[$1]=$0; par[$1]=$2 } END { for (p in line) { q=p; while (q in par && q!=root && q>1) q=par[q]; if (q==root && p!=root) print line[p] } }' | grep -v -E ' (ps|awk|sleep|date) ' | cut -c1-220 >> ${log}; sleep 1; done`], { stdio: "ignore", detached: true });
      const t0 = performance.now();
      const run = phase(`node --test ${orphan} #${iteration}`, () => nodeTestRun(WEB_ROOT, orphan));
      process.kill(-sampler.pid!, "SIGKILL");
      const durations = [...run.output.matchAll(/^(?:not )?ok (\d+) - [^\n]*\n(?:[^\n]*\n){0,3}?\s+duration_ms: ([\d.]+)/gmu)].map((m) => `${m[1]}:${Number(m[2]).toFixed(0)}`);
      console.error(`[noload-diag] child durations (test:ms): ${durations.join(" ")} | total ${/duration_ms ([\d.]+)\s*$/u.exec(run.output)?.[1]}`);
      const ps = performance.now() - t0 > 3000 ? readFileSync(log, "utf8") : "(fast; not printed)";
      console.error(`[noload-diag] ps samples:\n${ps.length > 60000 ? ps.slice(0, 60000) : ps}`);
      expect(
        run.status,
        `${orphan} is matched by no runner pattern, so vitest never sees it, and running it as ` +
          `a node:test file did not succeed either — so nothing in this repository executes it ` +
          `and its assertions are decoration. Either move it under a declared glob in ` +
          `tests/test-include.ts, or make it pass as a node:test file:\n${run.output}`,
      ).toBe(0);
      expect(
        ranSomething(orphan, run.passedNames),
        `${orphan} ran green while declaring no test of its own, so its green is about the ` +
          `file loading and not about anything being checked:\n${run.output}`,
      ).toBe(true);
    }
   }
  }, 600_000);

  test("PLANT: the runner this arm uses reports a FAILING orphan rather than passing it", () => {
    const dir = createTempDir("orphan-runner-");
    const failing = join(dir, "orphan.test.mjs");
    writeFileSync(
      failing,
      'import test from "node:test";\nimport assert from "node:assert/strict";\n' +
        'test("planted", () => { assert.equal(1, 2); });\n',
    );
    const failed = nodeTestRun(dir, "orphan.test.mjs");
    expect(failed.status, "a node:test file with a failing assertion exited 0").not.toBe(0);

    const passing = join(dir, "ok.test.mjs");
    writeFileSync(passing, 'import test from "node:test";\ntest("planted", () => {});\n');
    const ok = nodeTestRun(dir, "ok.test.mjs");
    expect(ok.status).toBe(0);
    expect(ok.passedNames).toContain("planted");
    expect(ranSomething("ok.test.mjs", ok.passedNames)).toBe(true);

    const empty = join(dir, "empty.test.mjs");
    writeFileSync(empty, "// no tests here\n");
    const none = nodeTestRun(dir, "empty.test.mjs");
    expect(none.status).toBe(0);
    expect(none.passedNames).toEqual(["empty.test.mjs"]);
    expect(ranSomething("empty.test.mjs", none.passedNames)).toBe(false);
  }, 120_000);
});

describe("the fourth declaration class resolves testDir from its CONFIG, not the caller's cwd", () => {
  test("both Playwright configs load from a foreign directory and still select their own specs", () => {
    const foreign = createTempDir("playwright-foreign-cwd-");
    const expected: ReadonlyArray<readonly [string, string]> = [
      ["playwright.config.ts", "./tests"],
      ["playwright.perf.config.ts", "./tests/performance"],
    ];
    for (const [config, testDir] of expected) {
      const moduleUrl = pathToFileURL(join(WEB_ROOT, config)).href;
      const script = `import(${JSON.stringify(moduleUrl)}).then((m) => console.log(JSON.stringify(m.default.testDir)))`;
      const stdout = execFileSync(process.execPath, ["--experimental-strip-types", "-e", script], {
        cwd: foreign,
        encoding: "utf8",
        env: { ...process.env, TEST_WORKER_INDEX: "1" },
      });
      expect(JSON.parse(stdout.trim()), `${config} must load from ${foreign}`).toBe(testDir);
    }
  }, 120_000);
});

