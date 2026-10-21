// @vitest-environment node
/**
 * THE GUARDIAN RUNNER'S ACCOUNTING — a test that did not run is not a pass.
 *
 * The runner used to give the static-libc test, when `cc -static` was
 * unavailable, `TOTAL+1; PASS+1; echo "PASS: test 20 SKIP"`, and its summary
 * exited 0 printing ALL TESTS PASS. A test that never ran was reported as a
 * pass by the same script `.github/workflows/ci.yml` calls through
 * `make test`, and the same script had three different skip conventions
 * (tests 35-36 skipped without incrementing the denominator, test 18's skip
 * also incremented FAIL).
 *
 * This file reads the runner's ONE accounting block from the real script and
 * drives it in bash: a skip increments SKIP and never PASS, the summary
 * refuses ALL TESTS PASS while a skip exists, and an inconsistent denominator
 * is a failure rather than a smaller pass. A source scan beside it keeps the
 * helpers from being bypassed by a hand-written `PASS=$((PASS+1))` on a SKIP
 * line.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const SCRIPT_PATH = "engine/guardian/tests/run-tests.sh";
const SCRIPT = readFileSync(SCRIPT_PATH, "utf8");
const START = "# --- accounting helpers";
const END = "# --- end accounting helpers ---";
const from = SCRIPT.indexOf(START);
const to = SCRIPT.indexOf(END);
const HELPERS = SCRIPT.slice(from, to);

function runAgainstHelpers(body: string): { readonly stdout: string; readonly status: number } {
  const program = `set -uo pipefail\nPASS=0; FAIL=0; SKIP=0; TOTAL=0\n${HELPERS}\n${body}\n`;
  const result = spawnSync("bash", ["-c", program], { encoding: "utf8" });
  return { stdout: result.stdout, status: result.status ?? -1 };
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

  test("a clean run says ALL TESTS PASS", () => {
    const run = runAgainstHelpers('pass "one"; pass "two"; summary');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("PASS 2/2");
    expect(run.stdout).toContain("ALL TESTS PASS");
  });

  test("a skipped test withholds ALL TESTS PASS and prints the skip count", () => {
    const run = runAgainstHelpers('pass "one"; skip "two (environment prerequisite)" ; summary');
    expect(run.status).toBe(0);
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

  test("no line reports a skip as a pass", () => {
    const offenders = SCRIPT.split("\n")
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(({ line }) => /\bSKIP\b/u.test(line) && /PASS=\$\(\(PASS\+1\)\)/u.test(line));
    expect(offenders).toEqual([]);
  });
});
