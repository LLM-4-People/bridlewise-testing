/**
 * Shared error-mapping scan helpers for the prevention test suite.
 *
 * Two prevention tests (`error-handling-consistency` E3 + `error-debug-owner`
 * B3) both need the same three-step scan: (1) parse the error class →
 * statusCode map from `server/errors.ts`, (2) walk `server/` for every
 * `new XError(...)` throw site + extract the thrown code, (3) verify every
 * code thrown by a 500-default class is mapped. Before this module those
 * three steps were duplicated (near byte-identical) across the two test
 * files — a fix to the scan logic had to be made twice, and the two copies
 * had already drifted (one used a thorough string+comment skip, the other a
 * line-level comment skip). This module is the single owner: both tests
 * import from here so a fix to the shared scan fixes both consumers, and a
 * new test gets a tested helper instead of a fresh copy.
 */
import { readFileSync } from "node:fs";
import { walkTs } from "./source-scan.ts";

/**
 * The error class → statusCode map. `undefined` means the class has no
 * explicit `readonly statusCode = N` (the router's 500 default applies).
 */
export type ClassStatusCodeMap = Map<string, number | undefined>;

/** A thrown error code site: the class name + the code string literal. */
export interface ThrownCode {
  readonly className: string;
  readonly code: string;
}

/**
 * True when the character at `idx` in `src` is inside a JS/TS comment or
 * string literal. Used to skip doc comments that mention `new XError("msg")`
 * (those are NOT real throw sites — `errors.ts` defines classes + doc
 * comments, it does not throw them in production paths). Handles line
 * comments, block comments, single/double/backtick strings (incl. `${...}`
 * interpolation), so a throw site inside a template literal or a comment is
 * not parsed as a real throw.
 */
export function isInsideStringOrComment(src: string, idx: number): boolean {
  let i = 0;
  while (i < idx) {
    const ch = src[i]!;
    if (ch === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      if (nl === -1) return false;
      if (idx > i && idx < nl) return true;
      i = nl + 1;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      if (close === -1) return false;
      if (idx > i && idx < close + 2) return true;
      i = close + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const end = skipString(src, i, ch);
      if (idx > i && idx < end) return true;
      i = end;
      continue;
    }
    i += 1;
  }
  return false;
}

function skipString(src: string, i: number, quote: string): number {
  let j = i + 1;
  while (j < src.length) {
    const c = src[j]!;
    if (c === "\\") { j += 2; continue; }
    if (quote === "`" && c === "$" && src[j + 1] === "{") {
      const close = matchBrace(src, j + 1);
      j = close === -1 ? src.length : close + 1;
      continue;
    }
    if (c === quote) return j + 1;
    j += 1;
  }
  return src.length;
}

function matchBrace(src: string, openIdx: number): number {
  let depth = 1;
  let i = openIdx + 1;
  const n = src.length;
  while (i < n && depth > 0) {
    const ch = src[i]!;
    if (ch === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      i = close === -1 ? n : close + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { i = skipString(src, i, ch); continue; }
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    i += 1;
  }
  return depth === 0 ? i - 1 : -1;
}

/**
 * Parse the error class → statusCode map from `server/errors.ts`. Each
 * `export class XError extends ...` with a `readonly statusCode = N` body
 * field maps to N; a class without that field maps to `undefined` (the
 * router's 500 default).
 */
export function parseErrorClassStatusCode(errorsSrc: string): ClassStatusCodeMap {
  const classStatusCode: ClassStatusCodeMap = new Map();
  const classRe = /export\s+class\s+(\w+Error)\s+extends\s+\w+/g;
  let cm: RegExpExecArray | null;
  while ((cm = classRe.exec(errorsSrc)) !== null) {
    const name = cm[1]!;
    const afterClass = errorsSrc.slice(cm.index! + cm[0]!.length);
    const nextClass = afterClass.search(/export\s+class\s+\w+Error\s+extends/);
    const classBody = nextClass >= 0 ? afterClass.slice(0, nextClass) : afterClass;
    const statusMatch = classBody.match(/readonly\s+statusCode\s*=\s*(\d+)/);
    classStatusCode.set(name, statusMatch ? parseInt(statusMatch[1]!, 10) : undefined);
  }
  return classStatusCode;
}

/**
 * Walk `server/` (excluding `.test.ts`) for every `new XError(...)` throw
 * site + extract the thrown code (the 2nd argument string literal). Skips
 * matches inside comments/strings (doc comments that mention a throw are
 * not real throw sites). Returns the class name + code for each real throw.
 */
/**
 * The text between `(` at `openIndex` and its matching `)`.
 *
 * Parentheses inside string literals, template literals and comments are not
 * structure, so they do not count — an error message containing `":("` must
 * not close the call. Returns the remainder of the source when the call is
 * unterminated, which cannot happen in a file that compiles.
 */
function argumentListOf(source: string, openIndex: number): string {
  let depth = 0;
  let quote: string | null = null;
  let comment: "line" | "block" | null = null;
  for (let i = openIndex; i < source.length; i += 1) {
    const c = source[i]!;
    const next = source[i + 1];
    if (comment === "line") {
      if (c === "\n") comment = null;
      continue;
    }
    if (comment === "block") {
      if (c === "*" && next === "/") { comment = null; i += 1; }
      continue;
    }
    if (quote !== null) {
      if (c === "\\") { i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "/" && next === "/") { comment = "line"; i += 1; continue; }
    if (c === "/" && next === "*") { comment = "block"; i += 1; continue; }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex + 1, i);
    }
  }
  return source.slice(openIndex + 1);
}

export function scanThrownErrorCodes(serverDir: string): ThrownCode[] {
  const files = walkTs(serverDir).filter((f) => !f.endsWith(".test.ts"));
  const thrownCodes: ThrownCode[] = [];
  const startRe = /new\s+(\w+Error)\s*\(/g;
  const codeInSegmentRe = /,\s*["']([a-z][a-z_]*)["']/g;
  for (const f of files) {
    const src = readFileSync(f, "utf-8");
    let sm: RegExpExecArray | null;
    while ((sm = startRe.exec(src)) !== null) {
      if (isInsideStringOrComment(src, sm.index)) continue;
      const className = sm[1]!;
      // Bound the search to THIS constructor's own argument list, by
      // balancing parentheses from the `(` we just matched.
      //
      // The previous bound — "up to the next `new \w+Error(`, else 500
      // characters" — is not a boundary of the construct being read, so it
      // manufactured findings. A code-LESS constructor (`new ConfigError(msg)`)
      // opened a window that ran until the next error constructor anywhere in
      // the file, and any `, "lower_snake"` in between was reported as that
      // constructor's error code. A subprocess env allowlist four hundred
      // lines away supplied `ConfigError:http_proxy`, an error code that has
      // never existed — and the finding appeared only when an unrelated
      // constructor was added later in the file, so the guard's verdict
      // depended on code it was not reading.
      const segment = argumentListOf(src, sm.index! + sm[0]!.length - 1);
      codeInSegmentRe.lastIndex = 0;
      const cm2 = codeInSegmentRe.exec(segment);
      if (cm2 !== null) thrownCodes.push({ className, code: cm2[1]! });
    }
  }
  return thrownCodes;
}

/**
 * The argument-list text AFTER the first top-level comma — the region where
 * the error CODE argument lives — or null when the constructor takes a
 * single argument (message only, so there is no code position to scan).
 * Commas inside strings, templates, comments and nested brackets are not
 * structure.
 */
function afterFirstTopLevelComma(args: string): string | null {
  let depth = 0;
  let quote: string | null = null;
  let comment: "line" | "block" | null = null;
  for (let i = 0; i < args.length; i += 1) {
    const c = args[i]!;
    const next = args[i + 1];
    if (comment === "line") {
      if (c === "\n") comment = null;
      continue;
    }
    if (comment === "block") {
      if (c === "*" && next === "/") { comment = null; i += 1; }
      continue;
    }
    if (quote !== null) {
      if (c === "\\") { i += 1; continue; }
      if (quote === "`" && c === "$" && next === "{") {
        const close = matchBrace(args, i + 1);
        i = close === -1 ? args.length : close;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "/" && next === "/") { comment = "line"; i += 1; continue; }
    if (c === "/" && next === "*") { comment = "block"; i += 1; continue; }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") depth -= 1;
    else if (c === "," && depth === 0) return args.slice(i + 1);
  }
  return null;
}

/**
 * Every `?? "snake_case"` nullish fallback in `region` where the `??` is
 * real code (not inside a string, template or comment) and the fallback is a
 * lower_snake string literal — the shape of a dynamic error code's
 * last-resort value. A `??` followed by anything else (a number, a boolean,
 * an identifier) carries no code to verify and is skipped.
 */
function nullishCodeFallbacks(region: string): string[] {
  const out: string[] = [];
  let quote: string | null = null;
  let comment: "line" | "block" | null = null;
  for (let i = 0; i < region.length; i += 1) {
    const c = region[i]!;
    const next = region[i + 1];
    if (comment === "line") {
      if (c === "\n") comment = null;
      continue;
    }
    if (comment === "block") {
      if (c === "*" && next === "/") { comment = null; i += 1; }
      continue;
    }
    if (quote !== null) {
      if (c === "\\") { i += 1; continue; }
      if (quote === "`" && c === "$" && next === "{") {
        const close = matchBrace(region, i + 1);
        i = close === -1 ? region.length : close;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "/" && next === "/") { comment = "line"; i += 1; continue; }
    if (c === "/" && next === "*") { comment = "block"; i += 1; continue; }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "?" && next === "?") {
      const fallback = region.slice(i + 2).match(/^\s*(["'])([a-z][a-z_]*)\1/);
      if (fallback !== null) out.push(fallback[2]!);
      i += 1;
      continue;
    }
  }
  return out;
}

/**
 * Walk `server/` (excluding `.test.ts`) for DYNAMIC error codes with a
 * string-literal fallback: `new XError(msg, code ?? "the_fallback")`.
 * `scanThrownErrorCodes` only sees codes written as a plain string literal;
 * a code threaded through a variable with a `?? "fallback"` slips past it —
 * three such gaps were found and fixed by hand before this scan existed
 * (each one a code the router would have reported as a bare 500).
 *
 * The scan is bounded twice against false positives: only within
 * error-constructor argument lists (a `?? "fallback"` anywhere else in the
 * file is not an error code), and only after the first top-level comma (the
 * message argument's own fallbacks, e.g. `new XError(input.msg ??
 * "unknown_failure")`, are not codes). A snake_case nullish fallback inside
 * the code region — even nested in a helper call — IS treated as a code:
 * within the code position of an error constructor that is the only thing
 * it can sensibly be.
 *
 * A code carried by a bare variable with NO literal fallback
 * (`new XError(msg, code)`) cannot be verified from source and is the
 * documented boundary of this scan.
 */
export function scanDynamicErrorCodeFallbacks(serverDir: string): ThrownCode[] {
  const files = walkTs(serverDir).filter((f) => !f.endsWith(".test.ts"));
  const out: ThrownCode[] = [];
  const startRe = /new\s+(\w+Error)\s*\(/g;
  for (const f of files) {
    const src = readFileSync(f, "utf-8");
    let sm: RegExpExecArray | null;
    while ((sm = startRe.exec(src)) !== null) {
      if (isInsideStringOrComment(src, sm.index)) continue;
      const className = sm[1]!;
      const segment = argumentListOf(src, sm.index! + sm[0]!.length - 1);
      const codeRegion = afterFirstTopLevelComma(segment);
      if (codeRegion === null) continue;
      for (const code of nullishCodeFallbacks(codeRegion)) {
        out.push({ className, code });
      }
    }
  }
  return out;
}

/**
 * For each thrown code by a 500-default class (statusCode undefined or 500),
 * verify the code is mapped: either `isMapped(code)` returns true (the code
 * is in CODE_STATUS_MAP) OR the code uses the `invalid_`/`missing_` prefix
 * convention. Returns the list of unmapped `Class:code` entries (deny-by-
 * default — no class allowlist; every 500-default class is a must-be-mapped
 * class).
 */
export function findUnmapped500DefaultCodes(
  thrownCodes: readonly ThrownCode[],
  classStatusCode: ClassStatusCodeMap,
  isMapped: (code: string) => boolean,
): string[] {
  const unmapped: string[] = [];
  for (const { className, code } of thrownCodes) {
    const classStatus = classStatusCode.get(className);
    // A class with an explicit non-500 statusCode is mapped via the
    // router's first check (statusForError honors statusCode first).
    if (classStatus !== undefined && classStatus !== 500) continue;
    if (isMapped(code)) continue;
    if (code.startsWith("invalid_") || code.startsWith("missing_")) continue;
    unmapped.push(`${className}:${code}`);
  }
  return unmapped;
}

/**
 * EVERY thrown code must be in the taxonomy, whatever its class's status.
 *
 * The 500-default scan above was the only completeness check, and it
 * exempted a code carried by a class that declares its own `statusCode`.
 * That exemption held only while the error travelled UNWRAPPED: a route that
 * caught it and re-threw a status-less `WebError` (PUT /api/config did
 * exactly that with `forbidden_config_path`) resolved through
 * CODE_STATUS_MAP, found nothing, and answered 500. A code that the class
 * resolves is still a code the taxonomy must own — the map is the shared
 * vocabulary the client projects messages from, not only the fallback table
 * for status-less classes.
 */
export function findUnmappedThrownCodes(
  thrownCodes: readonly ThrownCode[],
  classStatusCode: ClassStatusCodeMap,
  isMapped: (code: string) => boolean,
): string[] {
  const unmapped: string[] = [];
  for (const { className, code } of thrownCodes) {
    if (isMapped(code)) continue;
    if (code.startsWith("invalid_") || code.startsWith("missing_")) continue;
    const classStatus = classStatusCode.get(className);
    unmapped.push(`${className}${classStatus === undefined ? "" : `(${String(classStatus)})`}:${code}`);
  }
  return unmapped;
}
