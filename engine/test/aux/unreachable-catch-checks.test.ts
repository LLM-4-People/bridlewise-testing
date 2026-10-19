/**
 * Unreachable-catch check + code-health aggregate tests.
 *
 * Tests:
 * - Unreachable catch via try-without-throw (JS, Python, Rust patterns).
 * - Unreachable catch via subsumed-catch (Java order issue).
 * - Reachable catch NOT flagged (try body has a function call).
 * - Re-throw catch NOT flagged (catch re-throws → intentional).
 * - code-health aggregate groups sub-checks per file.
 * - No findings on clean code (no try/catch).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkUnreachableCatch } from "../../src/quality/checks/unreachable-catch.ts";
import { checkCodeHealth } from "../../src/quality/checks/code-health-aggregate.ts";
import type { ParsedFile, QualityConfig } from "../../src/quality/base.ts";
import { buildQualityConfig } from "../../src/quality/config.ts";

function pf(path: string, content: string): ParsedFile {
  return {
    path, language: "typescript", content,
    loc: content.split("\n").length,
    symbols: [], imports: [], exports: [], comments: [], parseErrors: [],
    lines: content.split("\n"),
  } as unknown as ParsedFile;
}

const config: QualityConfig = buildQualityConfig({ enabledChecks: [], enabledSignals: [], maxFiles: 0 });

test("unreachable-catch: unreachable-catch: try-without-throw (JS) is flagged", () => {
  const file = pf("test.ts", `
function f() {
  try {
    const x = 5;
    const y = 10;
    return x + y;
  } catch (e) {
    return 0;
  }
}
`);
  const findings = checkUnreachableCatch([file], config);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.checkId, "unreachable-catch");
  assert.match(findings[0]!.message, /try body has no statement/);
});

test("unreachable-catch: unreachable-catch: try-with-call is NOT flagged", () => {
  const file = pf("test.ts", `
function f() {
  try {
    const x = doSomething();
    return x;
  } catch (e) {
    return 0;
  }
}
`);
  const findings = checkUnreachableCatch([file], config);
  assert.equal(findings.length, 0, `expected 0 findings, got ${findings.length}`);
});

test("unreachable-catch: unreachable-catch: try-with-await is NOT flagged", () => {
  const file = pf("test.ts", `
async function f() {
  try {
    const x = await fetch("url");
    return x;
  } catch (e) {
    return null;
  }
}
`);
  const findings = checkUnreachableCatch([file], config);
  assert.equal(findings.length, 0, `expected 0 findings (await can throw), got ${findings.length}`);
});

test("unreachable-catch: unreachable-catch: catch that re-throws is NOT flagged", () => {
  const file = pf("test.ts", `
function f() {
  try {
    const x = 5;
    return x;
  } catch (e) {
    throw e;
  }
}
`);
  const findings = checkUnreachableCatch([file], config);
  assert.equal(findings.length, 0, `expected 0 findings (re-throw is intentional), got ${findings.length}`);
});

test("unreachable-catch: unreachable-catch: Python try-without-throw is flagged", () => {
  const file = pf("test.py", `
def f():
    try:
        x = 5
        y = 10
        return x + y
    except Exception:
        return 0
`);
  const findings = checkUnreachableCatch([file], config);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.checkId, "unreachable-catch");
});

test("unreachable-catch: unreachable-catch: Python try-with-call is NOT flagged", () => {
  const file = pf("test.py", `
def f():
    try:
        x = do_something()
        return x
    except Exception:
        return 0
`);
  const findings = checkUnreachableCatch([file], config);
  assert.equal(findings.length, 0);
});

test("unreachable-catch: unreachable-catch: subsumed-catch (Java order) is flagged", () => {
  const file = pf("Test.java", `
public class Test {
  void f() {
    try {
      doSomething();
    } catch (Exception e) {
      System.out.println("caught");
    } catch (IOException e) {
      System.out.println("never reached");
    }
  }
}
`);
  const findings = checkUnreachableCatch([file], config);
  // IOException is subsumed by Exception → the IOException catch is unreachable.
  assert.ok(findings.length >= 1, `expected >=1 finding, got ${findings.length}`);
  const subsumed = findings.find(f => /subsumed/.test(f.message));
  assert.ok(subsumed, "expected a subsumed-catch finding");
});

test("unreachable-catch: unreachable-catch: clean code has no findings", () => {
  const file = pf("test.ts", `
function f() {
  return 1 + 2;
}
function g() {
  try {
    return doSomething();
  } catch (e) {
    return 0;
  }
}
`);
  const findings = checkUnreachableCatch([file], config);
  assert.equal(findings.length, 0);
});

test("unreachable-catch: unreachable-catch: config override for supertypes", () => {
  const file = pf("Test.java", `
class T {
  void f() {
    try {
      doSomething();
    } catch (MyBase e) {
    } catch (MyChild e) {
    }
  }
}
`);
  // Without override: MyBase/MyChild not in DEFAULT_SUPERTYPES → 0 subsumed findings.
  const findings1 = checkUnreachableCatch([file], config);
  const subsumed1 = findings1.filter(f => /subsumed/.test(f.message));
  assert.equal(subsumed1.length, 0);

  // With override: MyBase → [MyChild] → 1 subsumed finding.
  const cfg2 = buildQualityConfig({
    enabledChecks: [], enabledSignals: [], maxFiles: 0,
    unreachableCatchSupertypes: { "MyBase": ["MyChild"] } as any,
  });
  const findings2 = checkUnreachableCatch([file], cfg2);
  const subsumed2 = findings2.filter(f => /subsumed/.test(f.message));
  assert.equal(subsumed2.length, 1);
});

test("unreachable-catch: code-health-aggregate: groups sub-checks per file", () => {
  const file = pf("test.ts", `
function f() {
  // TODO: fix this
  try {
    return doSomething();
  } catch (e) {
  }
  const magic = 42;
  switch (x) { case 1: break; case 2: break; }
}
`);
  // checkTodoComments uses f.comments — extract comments from content.
  const commentLines: number[] = [];
  file.content.split("\n").forEach((line, i) => {
    if (/TODO|FIXME|HACK|XXX|BUG|NOTE|OPTIMIZE|REFACTOR/i.test(line)) {
      commentLines.push(i);
    }
  });
  (file as any).comments = commentLines.map(l => ({
    filePath: "test.ts", line: l + 1, text: file.content.split("\n")[l] ?? "", kind: "line" as const,
  }));
  const findings = checkCodeHealth([file], config);
  assert.ok(findings.length >= 1, `expected >=1 finding, got ${findings.length}`);
  assert.equal(findings[0]!.checkId, "code-health");
  assert.match(findings[0]!.message, /code-health issue/);
  const subFindings = (findings[0]!.extra as any).subFindings as string[];
  assert.ok(subFindings.includes("todo-comment"), `expected todo-comment in subFindings, got ${JSON.stringify(subFindings)}`);
  assert.ok(subFindings.includes("empty-catch"), `expected empty-catch in subFindings, got ${JSON.stringify(subFindings)}`);
});

test("unreachable-catch: code-health-aggregate: no findings on clean file", () => {
  const file = pf("test.ts", `
function f() {
  return doSomething();
}
`);
  const findings = checkCodeHealth([file], config);
  assert.equal(findings.length, 0);
});

test("unreachable-catch: code-health-aggregate: skipCodeHealthAggregate disables it", () => {
  const file = pf("test.ts", `
function f() {
  // TODO: fix this
}
`);
  const cfg = buildQualityConfig({ enabledChecks: [], enabledSignals: [], maxFiles: 0, skipCodeHealthAggregate: true } as any);
  const findings = checkCodeHealth([file], cfg);
  assert.equal(findings.length, 0);
});
