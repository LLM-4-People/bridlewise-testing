// @vitest-environment node
/**
 * Mechanical enforcement: no `new Error(...)` (or any other builtin
 * Error subclass: TypeError, RangeError, SyntaxError, ReferenceError,
 * EvalError, URIError) in src/ or server/.
 *
 * "No `throw new Error(...)` — use the typed hierarchy."
 * The web UI owns its typed hierarchy in server/errors.ts
 * (WebError, ConfigError, ValidationError, FileSystemError) and the
 * router owns BodySizeLimitError/BodyParseError. The client owns
 * ClientError/ClientTimeoutError (src/client.ts). Raw `new Error`
 * (or `new TypeError`, `new RangeError`, …) produces unstructured
 * failures that bypass the error-code routing.
 *
 * Assurance classes:
 *   A. No `new Error(` in any source file (the original check).
 *   B. No `new <BuiltinError>(` (TypeError, RangeError, SyntaxError,
 *      ReferenceError, EvalError, URIError) — a raw builtin throw is the
 *      same drift class as `new Error` (a previous round only caught
 *      `Error`, letting `new TypeError(...)` in src/main.ts slip
 *      through).
 *
 * The scan uses `isInsideStringOrComment` (the brace-matching,
 * string/comment-skipping helper shared with the error-mapping scan)
 * so a `new Error(` inside a comment or string literal (e.g. a doc
 * comment that mentions `new Error("msg")`, or a test fixture string)
 * is NOT flagged — only real code constructions are. This closes the
 * split-pattern gap (a prior round's regex `\bthrow\s+new\s+Error\s*\(`
 * only matched `throw new Error(` on one line; `const err = new
 * Error(...); throw err;` — the split pattern used in
 * server/schema/ui-schema.ts to bypass the regex — was NOT caught).
 * Scanning for ANY `new Error(` and skipping string/comment matches
 * catches both forms in ONE gate.
 */
import { describe, test } from "vitest";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { walk } from "../helpers/source-scan.ts";
import { isInsideStringOrComment } from "../helpers/error-scan.ts";

const ROOTS = ["src", "server"] as const;

/** `new Error(` — the original raw-Error check (any construction form). */
const ERROR_RE = /\bnew\s+Error\s*\(/g;
/** `new <BuiltinError>(` — TypeError, RangeError, SyntaxError,
 * ReferenceError, EvalError, URIError. These are raw builtin throws that
 * bypass the typed hierarchy (the same drift class as `new Error`). */
const BUILTIN_ERROR_RE =
  /\bnew\s+(?:TypeError|RangeError|SyntaxError|ReferenceError|EvalError|URIError)\s*\(/g;

function lineOf(src: string, idx: number): number {
  let n = 1;
  for (let i = 0; i < idx; i += 1) if (src[i] === "\n") n += 1;
  return n;
}

describe("no new Error (or builtin Error subclass) in source", () => {
  const errorFindings: { file: string; line: number; text: string }[] = [];
  const builtinFindings: { file: string; line: number; text: string }[] = [];
  for (const root of ROOTS) {
    for (const file of walk(root)) {
      const raw = readFileSync(file, "utf-8");
      const lines = raw.split("\n");
      ERROR_RE.lastIndex = 0;
      BUILTIN_ERROR_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = ERROR_RE.exec(raw)) !== null) {
        if (isInsideStringOrComment(raw, m.index)) continue;
        const lineNo = lineOf(raw, m.index);
        errorFindings.push({
          file: relative(process.cwd(), file),
          line: lineNo,
          text: lines[lineNo - 1]?.trim() ?? "",
        });
      }
      while ((m = BUILTIN_ERROR_RE.exec(raw)) !== null) {
        if (isInsideStringOrComment(raw, m.index)) continue;
        const lineNo = lineOf(raw, m.index);
        builtinFindings.push({
          file: relative(process.cwd(), file),
          line: lineNo,
          text: lines[lineNo - 1]?.trim() ?? "",
        });
      }
    }
  }

  test("A. src/ and server/ never construct raw Error (use the typed hierarchy)", () => {
    if (errorFindings.length > 0) {
      const detail = errorFindings.map((f) => `${f.file}:${f.line}  ${f.text}`).join("\n");
      throw new Error(
        `Raw \`new Error(...)\` found — use a typed error from server/errors.ts (or ClientError in src/client.ts):\n${detail}`,
      );
    }
  });

  test("B. src/ and server/ never construct a builtin Error subclass (TypeError/RangeError/...) — use the typed hierarchy", () => {
    if (builtinFindings.length > 0) {
      const detail = builtinFindings.map((f) => `${f.file}:${f.line}  ${f.text}`).join("\n");
      throw new Error(
        `Raw \`new <BuiltinError>(...)\` found — use a typed error (ClientError / server/errors.ts) instead:\n${detail}`,
      );
    }
  });
});
