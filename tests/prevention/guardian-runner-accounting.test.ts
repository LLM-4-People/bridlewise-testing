// @vitest-environment node
/**
 * THE GUARDIAN RUNNER'S ACCOUNTING — a test that did not run is not a pass.
 *
 * The runner used to give the static-libc test, when `cc -static` was
 * unavailable, `TOTAL+1; PASS+1; echo "PASS: test 20 SKIP"`, and its summary
 * printed ALL TESTS PASS. A later repair stopped counting a skip as a pass but
 * still returned 0, so `.github/workflows/ci.yml`'s "Test guardian" step was
 * green while tests 18/19/20/22/35/36 had not run at all (the environment
 * prerequisite was missing). A skipped security suite certified the commit.
 *
 * This file reads the runner's ONE accounting block from the real script and
 * drives it in bash: a skip increments SKIP and never PASS, the summary exits
 * NON-ZERO while a skip exists, and an empty or inconsistent denominator is a
 * failure. The CI-side log check (`require-pass-log.sh`) is driven over real
 * logs beside it, and a source scan requires every shell pipeline in the two
 * workflows to run under `pipefail` — the other green-masking shape
 * (`false | tee -a …` exits 0 under `bash -e` without it).
 */
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createTempDir } from "../helpers/temp-dir.ts";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const SCRIPT_PATH = "engine/guardian/tests/run-tests.sh";
const PASS_CHECK_PATH = "engine/guardian/tests/require-pass-log.sh";
const SCRIPT = readFileSync(SCRIPT_PATH, "utf8");
const START = "# --- accounting helpers";
const END = "# --- end accounting helpers ---";
const from = SCRIPT.indexOf(START);
const to = SCRIPT.indexOf(END);
const HELPERS = SCRIPT.slice(from, to);

const WORKFLOWS = [".github/workflows/ci.yml", ".github/workflows/test-shards.yml"] as const;

function runAgainstHelpers(body: string): { readonly stdout: string; readonly status: number } {
  const program = `set -uo pipefail\nPASS=0; FAIL=0; SKIP=0; TOTAL=0\n${HELPERS}\n${body}\n`;
  const result = spawnSync("bash", ["-c", program], { encoding: "utf8" });
  return { stdout: result.stdout, status: result.status ?? -1 };
}

function runPassCheck(logBody: string | null): { readonly stdout: string; readonly stderr: string; readonly status: number } {
  const directory = createTempDir("bw-guardian-pass-");
  try {
    const log = join(directory, "guardian-tests.log");
    if (logBody !== null) writeFileSync(log, logBody);
    const result = spawnSync("bash", [PASS_CHECK_PATH, logBody === null ? join(directory, "missing.log") : log], { encoding: "utf8" });
    return { stdout: result.stdout, stderr: result.stderr, status: result.status ?? -1 };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Every shell pipeline (`a | b`) in a workflow's `run:` blocks must sit in a
 * step that set `pipefail` (or reads `PIPESTATUS`) before the pipeline. A
 * `| tee` under `bash -e` alone reports tee's status, so a failing command
 * exits 0.
 */
function unguardedPipelines(workflow: string): readonly string[] {
  return unguardedPipelinesIn(readFileSync(workflow, "utf8"), workflow);
}

/** The scan itself, over text, so a planted unguarded pipeline proves it is not vacuous. */
function unguardedPipelinesIn(text: string, name: string): readonly string[] {
  const offenders: string[] = [];
  let inRun = false;
  let guarded = false;
  for (const line of text.split("\n")) {
    if (/^ {6}- name:/u.test(line)) {
      inRun = false;
      guarded = false;
      continue;
    }
    if (/^ {8}run: \|$/u.test(line)) {
      inRun = true;
      guarded = false;
      continue;
    }
    if (!inRun) continue;
    if (line.trim().length === 0) continue;
    if (!/^ {10,}/u.test(line)) {
      inRun = false;
      continue;
    }
    if (/set -o pipefail|PIPESTATUS/u.test(line)) guarded = true;
    if (/\s\|\s/u.test(line) && !/^\s*#/u.test(line) && !guarded) offenders.push(`${name}: ${line.trim()}`);
  }
  return offenders;
}

describe("the guardian runner's accounting block", () => {
  test("the block exists and the summary is the one the script ends with", () => {
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    expect(HELPERS).toContain("skip()");
    expect(HELPERS).toContain("summary()");
    expect(SCRIPT.trimEnd().endsWith("exit 1")).toBe(true);
    expect(SCRIPT).toContain("if summary; then");
  });

  test("a skip increments SKIP, never PASS", () => {
    const run = runAgainstHelpers("skip \"test 20 (cc -static unavailable)\"; echo \"STATE $PASS $FAIL $SKIP $TOTAL\"");
    expect(run.stdout).toContain("SKIP: test 20");
    expect(run.stdout).toContain("STATE 0 0 1 1");
    expect(run.stdout).not.toContain("PASS:");
  });

  test("a clean run says ALL TESTS PASS and prints SKIP 0", () => {
    const run = runAgainstHelpers('pass "one"; pass "two"; summary');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("PASS 2/2");
    expect(run.stdout).toContain("SKIP 0");
    expect(run.stdout).toContain("ALL TESTS PASS");
  });

  test("a skipped test withholds ALL TESTS PASS, prints the skip count, and EXITS NON-ZERO", () => {
    // The round-5 defect: this branch printed the right words and returned 0,
    // so `make test` reported success while the suite had not run.
    const run = runAgainstHelpers('pass "one"; skip "two (environment prerequisite)" ; summary');
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("PASS 1/2");
    expect(run.stdout).toContain("SKIP 1");
    expect(run.stdout).toContain("NOT ALL TESTS PASSED");
    expect(run.stdout.split("\n")).not.toContain("ALL TESTS PASS");
  });

  test("a failure is exit 1 and is never softened by a skip", () => {
    const run = runAgainstHelpers('pass "one"; fail "two"; skip "three"; summary');
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("FAIL 1");
  });

  test("an inconsistent denominator refuses the claim", () => {
    // The old shape that made the bug invisible: a test incremented the
    // denominator but neither PASS nor FAIL, so PASS/TOTAL just read smaller.
    const run = runAgainstHelpers("TOTAL=1; summary");
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("INCOMPLETE ACCOUNTING");
    expect(run.stdout.split("\n")).not.toContain("ALL TESTS PASS");
  });

  test("a vacuous run refuses: zero tests is not a pass", () => {
    const run = runAgainstHelpers("summary");
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("NO TESTS RAN");
    expect(run.stdout.split("\n")).not.toContain("ALL TESTS PASS");
  });

  test("no line reports a skip as a pass", () => {
    const offenders = SCRIPT.split("\n")
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(({ line }) => /\bSKIP\b/u.test(line) && /PASS=\$\(\(PASS\+1\)\)/u.test(line));
    expect(offenders).toEqual([]);
  });
});

describe("the CI pass-log check", () => {
  test("accepts a real pass and prints the count", () => {
    const run = runPassCheck("PASS 42/42\nSKIP 0\nALL TESTS PASS\n");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("PASS 42/42 with SKIP 0");
  });

  test("refuses a run that skipped", () => {
    const run = runPassCheck("PASS 40/42\nSKIP 2\nNOT ALL TESTS PASSED — 2 test(s) did not run\n");
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("skip count");
  });

  test("refuses a missing SKIP 0 line even when the marker says pass", () => {
    const run = runPassCheck("PASS 2/2\nALL TESTS PASS\n");
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("skip count");
  });

  test("refuses a partial or vacuous pass count", () => {
    for (const log of ["PASS 1/2\nSKIP 0\nALL TESTS PASS\n", "PASS 0/0\nSKIP 0\nALL TESTS PASS\n"]) {
      const run = runPassCheck(log);
      expect(run.status).toBe(1);
      expect(run.stderr).toMatch(/partial run|passed no tests/u);
    }
  });

  test("refuses a missing log", () => {
    const run = runPassCheck(null);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("no readable log");
  });
});

describe("the workflows cannot mask a failure behind a pipeline", () => {
  test("the scan catches a planted `false | tee` and clears it once the step sets pipefail", () => {
    const header = "jobs:\n  gate:\n    steps:\n      - name: planted\n        run: |\n";
    expect(unguardedPipelinesIn(`${header}          false | tee -a out\n`, "planted.yml")).toHaveLength(1);
    expect(unguardedPipelinesIn(`${header}          set -o pipefail\n          false | tee -a out\n`, "planted.yml")).toEqual([]);
  });

  test("every shell pipeline in ci.yml and test-shards.yml runs under pipefail", () => {
    expect(WORKFLOWS.flatMap((workflow) => unguardedPipelines(workflow))).toEqual([]);
  });

  test("the Test guardian step requires a real pass count and zero skips from the log", () => {
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
    const start = workflow.indexOf("- name: Test guardian");
    const end = workflow.indexOf("- name: Record the guardian build stamp");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const step = workflow.slice(start, end);
    expect(step).toContain("set -o pipefail");
    expect(step).toContain("make -C engine/guardian test | tee");
    expect(step).toContain('require-pass-log.sh "$log"');
  });
});
