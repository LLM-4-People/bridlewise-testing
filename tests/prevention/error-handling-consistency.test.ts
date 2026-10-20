// @vitest-environment node
/**
 * Mechanical enforcement: ERROR HANDLING CONSISTENCY.
 *
 * The coordinator observed that the "audit all bugs" agent had to iterate
 * heavily to match different error-catch patterns across tests. This
 * suggested error handling was INCONSISTENT — which could mean some tests
 * were FAKING COVERAGE by catching the wrong (or any) error type, masking
 * real failures.
 *
 * This suite mechanically enforces THREE consistency invariants. ALL use
 * DYNAMIC discovery:
 *
 * (E1) NO bare `.toThrow` / `.rejects.toThrow` / `.rejects.toThrowError`
 * in tests. A bare assertion (no error type / message / regex argument)
 * passes on ANY error — so a function that throws the WRONG typed
 * error (or a raw `Error` after a typed-error regression) still makes the
 * test pass. This is the "faking coverage" pattern. Every error
 * assertion MUST verify the SPECIFIC expected error (type, message,
 * or regex). `.not.toThrow` is exempt (it asserts NO error).
 * (E2) NO `throw new Error(` in server/ + src/ outside comments. Re-affirms
 * the typed-hierarchy rule — every throw must use a typed
 * error from server/errors.ts. Consolidates no-throw-new-error.test.ts
 * + error-debug-owner.test.ts A3 into one consistency gate.
 * (E3) ERROR MAPPING COMPLETENESS — every error CLASS in server/errors.ts
 * that declares a `statusCode` property is honored by the router
 * (statusForError checks `statusCode` first), AND every error class
 * whose default code has NO `statusCode` is mapped via CODE_STATUS_MAP
 * (or the invalid_/missing_ prefix convention). No error code that
 * can reach the router falls through to a silent 500.
 *
 * NOTE on silent-swallow (E4): a "catch { return fallback } without
 * webWarn" detector was considered but rejected — it produces false
 * positives on legitimate validation/existence patterns where the return
 * value IS the signal (e.g. `verifyPassword` returns `false` on a malformed
 * hash; `resolveWithinProject` callers return `null` for "not found"; zod
 * parse returns `null` for "invalid args"). The config/db/file-tree/mcp
 * silent swallows found this round were FIXED by adding `webWarn` (documented
 * in ALL-BUGS-AND-ISSUES.md EHC-10/11/18/19/12/13/14); the remaining
 * `catch {` blocks are documented validation/existence patterns. Per
 * WORKFLOW.md §9, a mechanical test with unavoidable false positives is NOT
 * added; the behavioral fixes are pinned by the existing no-empty-catch
 * gate (empty bodies) + the typed-throw + mapping gates above.
 *
 * Reuse: the brace-matching + comment-stripping helpers are shared
 * with no-empty-catch.test.ts's approach (no second parser). The dynamic
 * walk is the same `readdirSync` pattern used by every prevention test.
 */
import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { walk, SOURCE_EXTS } from "../helpers/source-scan.ts";
import { parseErrorClassStatusCode, scanDynamicErrorCodeFallbacks, scanThrownErrorCodes, findUnmapped500DefaultCodes, isInsideStringOrComment } from "../helpers/error-scan.ts";
import { createTempDir } from "../helpers/temp-dir.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

// ── Dynamic discovery ──

const SOURCE_ROOTS = ["src", "server"] as const;
const TEST_ROOTS = ["tests"] as const;
const SERVER_ROOT = "server";
const ERRORS_FILE = modulePathMatching("server/kernel/errors.ts");

function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

function lineOf(src: string, idx: number): number {
  let n = 1;
  for (let i = 0; i < idx; i += 1) if (src[i] === "\n") n += 1;
  return n;
}

// ── (E1) No bare.toThrow /.rejects.toThrow in tests ──

/**
 * A "bare" throw assertion is `.toThrow` or `.rejects.toThrow` (or
 * `.toThrowError`) with NO argument — it matches ANY error. We detect
 * `toThrow(` followed by `)` with only whitespace between (no string,
 * regex, class, or message). `.not.toThrow` is exempt.
 *
 * We also catch the multi-line form:
 * expect(...).toThrow(
 * );
 */
function findBareThrowAssertions(file: string): { line: number; snippet: string }[] {
  const src = readFileSync(file, "utf-8");
  const findings: { line: number; snippet: string }[] = [];
  // Match `.toThrow(`, `.rejects.toThrow(`, `.rejects.toThrowError(` NOT
  // preceded by `.not` on the same chain. Then check the char after `(`.
  const re = /\.toThrow(?:Error)?\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const idx = m.index;
    if (isInsideStringOrComment(src, idx)) continue;
    // Is this a `.not.toThrow(`? The `.` of `.toThrow` is at `idx`; the 4
    // chars immediately before it (skipping whitespace) should be `.not`
    // for a negation. Walk back over whitespace, then check the segment.
    let p = idx - 1;
    while (p >= 0 && /[ \t]/.test(src[p]!)) p -= 1;
    // `src[p]` is the char before `.toThrow`. For `.not.toThrow`, p points
    // at the `t` of `not`; `src.slice(p - 3, p + 1)` = `not.`? No — check
    // the 4 chars ending AT p (inclusive): for `.not.t` those are `.not`.
    if (p >= 3 && src.slice(p - 3, p + 1) === ".not") continue; // .not.toThrow — exempt
    // Now check the argument: the char(s) after `(`.
    let j = m.index + m[0].length;
    while (j < src.length && /[ \t\n\r]/.test(src[j]!)) j += 1;
    // Bare if the next non-space char is `)` (no argument) — a string/regex/
    // class/identifier argument means it's a specific assertion.
    if (src[j] === ")") {
      findings.push({
        line: lineOf(src, idx),
        snippet: src.slice(idx, Math.min(j + 1, idx + 50)),
      });
    }
  }
  return findings;
}

// ── (E1) tests ──

describe("error-handling consistency — (E1) no bare throw assertions in tests", () => {
  const findings: { file: string; line: number; snippet: string }[] = [];
  for (const root of TEST_ROOTS) {
    for (const file of walk(root, { exts: SOURCE_EXTS })) {
      for (const f of findBareThrowAssertions(file)) {
        findings.push({ file: relative(process.cwd(), file), line: f.line, snippet: f.snippet });
      }
    }
  }

  test("tests never use bare.toThrow/.rejects.toThrow (faking coverage)", () => {
    if (findings.length > 0) {
      const detail = findings.map((f) => `${f.file}:${f.line}  ${f.snippet}`).join("\n");
      throw new Error(
        `Bare error assertions found — these pass on ANY error, masking real failures (faking coverage). Assert the SPECIFIC error type/message/regex:\n${detail}`,
      );
    }
  });
});

// ── (E2) tests ──

describe("error-handling consistency — (E2) no throw new Error in source", () => {
  const findings: { file: string; line: number; text: string }[] = [];
  const re = /\bthrow\s+new\s+Error\s*\(/g;
  for (const root of SOURCE_ROOTS) {
    for (const file of walk(root, { exts: SOURCE_EXTS })) {
      const raw = readFileSync(file, "utf-8");
      const lines = raw.split("\n");
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(raw)) !== null) {
        // Char-level skip (consistent with no-throw-new-error.test.ts +
        // error-debug-owner A3): a `throw new Error(` inside a string
        // literal or a block/line comment is NOT a real throw. The prior
        // line-level `isCommentLine` helper missed inline comments + string
        // literals (a latent false-positive gap — the tests used different
        // skipping strategies). Use the shared char-level helper.
        if (isInsideStringOrComment(raw, m.index)) continue;
        const lineNo = lineOf(raw, m.index);
        findings.push({ file: relative(process.cwd(), file), line: lineNo, text: lines[lineNo - 1]?.trim() ?? "" });
      }
    }
  }

  test("src/ + server/ never throw raw Error (use the typed hierarchy)", () => {
    if (findings.length > 0) {
      const detail = findings.map((f) => `${f.file}:${f.line}  ${f.text}`).join("\n");
      throw new Error(`Raw \`throw new Error(...)\` found — use a typed error from ${ERRORS_FILE}:\n${detail}`);
    }
  });
});

// ── (E3) tests — mapping completeness ──

import { statusForCode } from "../../server/kernel/errors.ts";

import { modulePathMatching } from "../helpers/module-resolver.ts";
describe("error-handling consistency — (E3) error mapping completeness", () => {
  function parseErrorClasses(errorsSrc: string): { name: string; statusCode?: number | undefined; defaultCode?: string | undefined }[] {
    const classes: { name: string; statusCode?: number | undefined; defaultCode?: string | undefined }[] = [];
    const classRe = /export\s+class\s+(\w+Error)\s+extends\s+\w+/g;
    let cm: RegExpExecArray | null;
    while ((cm = classRe.exec(errorsSrc)) !== null) {
      const name = cm[1]!;
      const afterClass = errorsSrc.slice(cm.index! + cm[0]!.length);
      const nextClass = afterClass.search(/export\s+class\s+\w+Error\s+extends/);
      const classBody = nextClass >= 0 ? afterClass.slice(0, nextClass) : afterClass;
      const statusMatch = classBody.match(/readonly\s+statusCode\s*=\s*(\d+)/);
      // Default code: `constructor(message: string, code = "the_code")`.
      const codeMatch = classBody.match(/code\s*=\s*["']([a-z][a-z_]*)["']/);
      classes.push({
        name,
        statusCode: statusMatch ? parseInt(statusMatch[1]!, 10) : undefined,
        defaultCode: codeMatch ? codeMatch[1] : undefined,
      });
    }
    return classes;
  }

  test("every error class with a default code is mapped (statusCode or CODE_STATUS_MAP or prefix)", () => {
    const errorsSrc = readFileSync(ERRORS_FILE, "utf-8");
    const classes = parseErrorClasses(errorsSrc);
    expect(classes.length, "should discover at least one error class").toBeGreaterThan(0);
    const unmapped: string[] = [];
    for (const c of classes) {
      // A class with a statusCode is mapped via the router's first check.
      if (c.statusCode !== undefined) continue;
      // A class with NO default code (e.g. BodySizeLimitError uses a literal)
      // — skip (it carries its own statusCode or is mapped by code literal).
      if (c.defaultCode === undefined) continue;
      const code = c.defaultCode;
      // Mapped if in CODE_STATUS_MAP or uses invalid_/missing_ prefix.
      if (statusForCode(code) !== undefined) continue;
      if (code.startsWith("invalid_") || code.startsWith("missing_")) continue;
      unmapped.push(`${c.name} (default code "${code}")`);
    }
    expect(
      unmapped,
      `error classes with a default code must be mapped (statusCode, CODE_STATUS_MAP, or invalid_/missing_ prefix) — unmapped: ${unmapped.join(", ")}`,
    ).toEqual([]);
  });

  test("every error code THROWN in server/ by a 500-default class is mapped (dynamic discovery)", () => {
    // Re-affirms error-debug-owner.test.ts B3 from the consistency angle:
    // scan ALL server/.ts files for `new \w+Error(msg, "code")` thrown by a
    // class whose statusCode is 500 (or undefined). Those codes MUST be in
    // CODE_STATUS_MAP or use the invalid_/missing_ prefix — otherwise the
    // router silently returns 500 for what should be a client error.
    //
    // DENY-BY-DEFAULT: there is NO hardcoded class allowlist. Every error
    // class whose statusCode is undefined/500 (the router's 500 default)
    // is treated as a must-be-mapped class — a code it throws that is not
    // mapped (and does not use the invalid_/missing_ prefix) is flagged.
    // A new 500-default error class added to errors.ts is auto-caught; a
    // new code it throws is auto-caught. (Previously a hardcoded
    // `mustBeClientErrorClasses` allowlist silently exempted any class not
    // in the list — a new must-be-client-error class would slip past.)
    //
    // The scan logic (parse class → statusCode, walk server/ for thrown
    // codes, verify mapped) is shared with error-debug-owner B3 via
    // `tests/helpers/error-scan.ts` (No Scattered Helpers applies to tests
    // too — one scan, two consumers).
    const errorsSrc = readFileSync(ERRORS_FILE, "utf-8");
    const classStatusCode = parseErrorClassStatusCode(errorsSrc);
    const thrownCodes = scanThrownErrorCodes(SERVER_ROOT);
    expect(thrownCodes.length, "should discover at least one error code thrown in server/").toBeGreaterThan(0);
    const unmapped = findUnmapped500DefaultCodes(thrownCodes, classStatusCode, (c) => statusForCode(c) !== undefined);
    expect(
      unmapped,
      `every error code thrown by a 500-default class must be mapped (deny-by-default — no class allowlist) — unmapped: ${[...new Set(unmapped)].join(", ")}`,
    ).toEqual([]);
  });

  test("every DYNAMIC error-code fallback (`?? 'code'`) by a 500-default class is mapped (dynamic discovery)", () => {
    // The thrown-codes scan above only sees codes written as a plain string
    // literal (`new XError(msg, "code")`). A code threaded through a
    // variable with a nullish fallback (`new XError(msg, code ??
    // "the_fallback")`) slips past it — three such gaps were found and
    // mapped by hand before this arm existed, each one a code the router
    // would otherwise have reported as a bare 500. This arm scans
    // error-constructor argument lists for the fallback shape and applies
    // the SAME mapping rule (CODE_STATUS_MAP or invalid_/missing_ prefix,
    // deny-by-default — no class allowlist).
    const errorsSrc = readFileSync(ERRORS_FILE, "utf-8");
    const classStatusCode = parseErrorClassStatusCode(errorsSrc);
    const fallbacks = scanDynamicErrorCodeFallbacks(SERVER_ROOT);
    // Liveness: at least one dynamic fallback exists today (the db worker
    // relay); zero means the scan broke, not that the tree is clean.
    expect(fallbacks.length, "should discover at least one dynamic error-code fallback in server/").toBeGreaterThan(0);
    const unmapped = findUnmapped500DefaultCodes(fallbacks, classStatusCode, (c) => statusForCode(c) !== undefined);
    expect(
      unmapped,
      `every dynamic error-code fallback by a 500-default class must be mapped (deny-by-default) — unmapped: ${[...new Set(unmapped)].join(", ")}`,
    ).toEqual([]);
  });

  test("the dynamic-fallback scan refuses an unmapped planted code, and only reads the code region", () => {
    // Mutation verification against planted fixtures in a temp directory —
    // the live tree is never mutated. ConfigError is a real 500-default
    // class (no own statusCode), so its codes must be mapped.
    const errorsSrc = readFileSync(ERRORS_FILE, "utf-8");
    const classStatusCode = parseErrorClassStatusCode(errorsSrc);
    const isMapped = (c: string) => statusForCode(c) !== undefined;
    const plant = (name: string, source: string): string[] => {
      const dir = createTempDir("err-dynamic-code-plant-");
      writeFileSync(join(dir, name), source, "utf8");
      return findUnmapped500DefaultCodes(scanDynamicErrorCodeFallbacks(dir), classStatusCode, isMapped);
    };
    // The defect shape: an unmapped code in a nullish fallback is refused.
    const unmapped = plant(
      "planted.ts",
      'declare const err: { code?: string };\nthrow new ConfigError("boom", err.code ?? "zz_unmapped_fallback");\n',
    );
    expect(unmapped).toEqual(["ConfigError:zz_unmapped_fallback"]);
    // The mapped twin passes (a fallback that IS in CODE_STATUS_MAP).
    expect(
      plant("mapped.ts", 'declare const err: { code?: string };\nthrow new ConfigError("boom", err.code ?? "db_worker_error");\n'),
      "a mapped fallback code must not be flagged",
    ).toEqual([]);
    // A prefix-convention twin passes (invalid_/missing_ are mapped by convention).
    expect(
      plant("prefix.ts", 'declare const err: { code?: string };\nthrow new ConfigError("boom", err.code ?? "missing_planted_thing");\n'),
      "a missing_-prefixed fallback must not be flagged",
    ).toEqual([]);
    // The message region is NOT the code region: a fallback in the first
    // argument is not an error code and must not be flagged.
    expect(
      plant("message.ts", 'declare const input: { msg?: string };\nthrow new ConfigError(input.msg ?? "zz_unmapped_fallback");\n'),
      "a nullish fallback in the MESSAGE argument must not be flagged",
    ).toEqual([]);
    // A `?? "code"` inside a template literal is prose, not code — even in
    // the code region.
    expect(
      plant(
        "template.ts",
        'declare const x: string | undefined;\ndeclare const prefix: (s: string) => string | undefined;\nthrow new ConfigError("boom", prefix(`got ${x ?? "zz_unmapped_fallback"}`) ?? "invalid_config");\n',
      ),
      "a nullish fallback inside a template literal must not be flagged",
    ).toEqual([]);
    // A bare variable code with NO literal fallback is the documented
    // boundary: nothing to verify, nothing flagged.
    expect(
      plant("variable.ts", 'declare const code: string;\nthrow new ConfigError("boom", code);\n'),
      "a bare variable code has no literal fallback to verify",
    ).toEqual([]);
  });
});
