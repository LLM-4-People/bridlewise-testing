import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  extractErrorContext,
  extractErrorMessage,
  extractErrorSourceLocation,
  HarnessError,
  InputError,
  SecurityError,
} from "../src/kernel/errors.ts";
import { engineModulePathMatching } from "./support/module-resolver.ts";
import { walk } from "../scripts/verification/source-walk.ts";

/**
 * DRY-5 regression: `extractMessage` / the `error instanceof Error?
 * error.message: String(error)` pattern was implemented 5 times and inlined
 * 20 more. The fix made `extractErrorMessage` in `src/errors.ts` the single
 * owner. This test verifies the canonical extractor handles every error shape
 * AND mechanically scans `src/` to prove no other source file defines a
 * competing `extractMessage` / `extractErrorMessage` function.
 */

test("extractErrorMessage: returns message for Error", () => {
  assert.equal(extractErrorMessage(new Error("boom")), "boom");
});

test("extractErrorMessage: returns message for HarnessError subclass", () => {
  assert.equal(extractErrorMessage(new InputError("bad input")), "bad input");
  assert.equal(extractErrorMessage(new SecurityError("denied")), "denied");
  assert.equal(
    extractErrorMessage(new HarnessError("x", "code", true, { a: 1 })),
    "x",
  );
});

test("extractErrorMessage: returns String(value) for non-Error primitives", () => {
  assert.equal(extractErrorMessage("plain string"), "plain string");
  assert.equal(extractErrorMessage(42), "42");
  assert.equal(extractErrorMessage(0), "0");
  assert.equal(extractErrorMessage(-1), "-1");
  assert.equal(extractErrorMessage(true), "true");
  assert.equal(extractErrorMessage(false), "false");
  assert.equal(extractErrorMessage(null), "null");
  assert.equal(extractErrorMessage(undefined), "undefined");
});

test("extractErrorMessage: returns String(object) for plain objects", () => {
  assert.equal(extractErrorMessage({ a: 1 }), "[object Object]");
  assert.equal(extractErrorMessage([1, 2]), "1,2");
  assert.equal(extractErrorMessage({ toString: () => "custom" }), "custom");
});

test("extractErrorMessage: handles errors with empty messages", () => {
  assert.equal(extractErrorMessage(new Error("")), "");
  assert.equal(extractErrorMessage(new HarnessError("")), "");
});

test("extractErrorMessage: preserves message of nested cause-style errors", () => {
  const inner = new Error("inner cause");
  const outer = new Error("outer");
  assert.equal(extractErrorMessage(inner), "inner cause");
  assert.equal(extractErrorMessage(outer), "outer");
});

test("extractErrorMessage: symbol throws/converts via String", () => {
  const sym = Symbol("s");
  // String(Symbol(...)) works; extractErrorMessage must not throw.
  assert.equal(extractErrorMessage(sym), "Symbol(s)");
});

// ---------------------------------------------------------------------------
// Mechanical prevention: no other source file may define extractMessage or
// extractErrorMessage. src/errors.ts is the single owner.
// ---------------------------------------------------------------------------

function listTsFiles(dir: string): string[] {
  return walk(dir, { exts: [".ts"] });
}

test("mechanical: only the kernel errors.ts defines extractErrorMessage / extractMessage", () => {
  const srcDir = join(process.cwd(), "src");
  const files = listTsFiles(srcDir);
  const defPattern = /(?:export\s+)?function\s+(extractMessage|extractErrorMessage)\b/u;
  // The owner's current location, resolved from the tree — a fold leaves this
  // guard untouched because the path is never spelled.
  const ownerPath = engineModulePathMatching("kernel/errors.ts");
  const offenders: string[] = [];
  for (const file of files) {
    const rel = file.replace(process.cwd() + "/", "");
    const text = readFileSync(file, "utf8");
    const matches = text.match(new RegExp(defPattern, "gu"));
    if (matches === null) continue;
    if (file === ownerPath) continue;
    offenders.push(`${rel}: ${matches.join(", ")}`);
  }
  assert.deepEqual(
    offenders,
    [],
    `Only the kernel errors.ts may define extractMessage/extractErrorMessage. Offenders: ${offenders.join("; ")}`,
  );
});

test("mechanical: the kernel errors.ts does define extractErrorMessage", () => {
  const text = readFileSync(engineModulePathMatching("kernel/errors.ts"), "utf8");
  assert.ok(
    /export\s+function\s+extractErrorMessage\b/u.test(text),
    "the kernel errors.ts must export extractErrorMessage (the canonical owner)",
  );
});

// ---------------------------------------------------------------------------
// extractErrorSourceLocation / extractErrorContext: stack-derived actionable
// context (function/file/line/column), walking the cause chain for wrapper
// errors whose own stack has no source frame.
// ---------------------------------------------------------------------------

test("extractErrorSourceLocation: reads the throwing frame from the error's own stack", () => {
  const error = new Error("boom");
  error.stack = "Error: boom\n    at throwSite (/repo/src/work.ts:12:34)\n    at caller (/repo/src/main.ts:5:6)";
  const location = extractErrorSourceLocation(error);
  assert.equal(location.functionName, "throwSite");
  assert.equal(location.file, "/repo/src/work.ts");
  assert.equal(location.line, 12);
  assert.equal(location.column, 34);
});

test("extractErrorSourceLocation: skips anonymous/native frames to the application call site", () => {
  const error = new Error("Unexpected end of JSON input");
  error.stack = "SyntaxError: Unexpected end of JSON input\n    at JSON.parse (<anonymous>)\n    at parseSite (/repo/src/data.ts:40:12)";
  const location = extractErrorSourceLocation(error);
  assert.equal(location.functionName, "parseSite");
  assert.equal(location.file, "/repo/src/data.ts");
  assert.equal(location.line, 40);
});

test("extractErrorSourceLocation: decodes file: URLs in stack frames", () => {
  const error = new Error("url frame");
  error.stack = "Error: url frame\n    at load (file:///repo/src/loader.ts:7:3)";
  const location = extractErrorSourceLocation(error);
  assert.equal(location.file, "/repo/src/loader.ts");
  assert.equal(location.line, 7);
});

test("extractErrorSourceLocation: walks the cause chain when the wrapper's stack has no source frame", () => {
  const cause = new Error("assertion failed");
  cause.stack = "AssertionError: assertion failed\n    at TestContext.<anonymous> (/repo/test/demo.test.ts:4:10)";
  const wrapper = Object.assign(new Error("assertion failed"), { code: "ERR_TEST_FAILURE", cause });
  wrapper.stack = "Error [ERR_TEST_FAILURE]: assertion failed";
  const location = extractErrorSourceLocation(wrapper);
  assert.equal(location.file, "/repo/test/demo.test.ts");
  assert.equal(location.line, 4);
  assert.equal(location.column, 10);
});

test("extractErrorSourceLocation: prefers the outer error's own frame over a cause's frame", () => {
  const cause = new Error("inner");
  cause.stack = "Error: inner\n    at inner (/repo/src/inner.ts:1:1)";
  const outer = new Error("outer", { cause });
  outer.stack = "Error: outer\n    at outer (/repo/src/outer.ts:2:2)";
  const location = extractErrorSourceLocation(outer);
  assert.equal(location.functionName, "outer");
  assert.equal(location.file, "/repo/src/outer.ts");
});

test("extractErrorSourceLocation: cause cycles terminate and non-Errors report nulls", () => {
  const cyclic = new Error("cyclic");
  cyclic.stack = "Error: cyclic";
  Object.assign(cyclic, { cause: cyclic });
  assert.deepEqual(extractErrorSourceLocation(cyclic), { functionName: null, file: null, line: null, column: null });
  assert.deepEqual(extractErrorSourceLocation("plain string"), { functionName: null, file: null, line: null, column: null });
  assert.deepEqual(extractErrorSourceLocation(null), { functionName: null, file: null, line: null, column: null });
});

test("extractErrorContext: composes message, location, and stack with null honesty", () => {
  const error = new Error("context boom");
  error.stack = "Error: context boom\n    at site (/repo/src/site.ts:9:8)";
  const context = extractErrorContext(error);
  assert.equal(context.message, "context boom");
  assert.equal(context.function, "site");
  assert.equal(context.file, "/repo/src/site.ts");
  assert.equal(context.line, 9);
  assert.equal(context.column, 8);
  assert.equal(context.stack, error.stack);

  const plain = extractErrorContext("plain failure");
  assert.equal(plain.message, "plain failure");
  assert.equal(plain.function, null);
  assert.equal(plain.file, null);
  assert.equal(plain.line, null);
  assert.equal(plain.column, null);
  assert.equal(plain.stack, null);
  assert.equal(plain.code, null);
  assert.equal(plain.details, null);

  // A typed error's code and declared-safe details travel with the context
  // (a setup refusal once said "Candidate format rejected" and dropped WHICH file).
  const typed = extractErrorContext(new HarnessError("Candidate format rejected", "candidate_format_rejected", false, { violations: "[\"x\"]" }));
  assert.equal(typed.code, "candidate_format_rejected");
  assert.deepEqual(typed.details, { violations: "[\"x\"]" });
  assert.equal(extractErrorContext(new InputError("bare")).details, null, "no details is null, not {}");
});
