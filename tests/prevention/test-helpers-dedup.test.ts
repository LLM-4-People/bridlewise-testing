// @vitest-environment node
/**
 * Mechanical enforcement: test helpers that duplicate ANY `tests/helpers/*.ts`
 * must be imported, not re-defined.
 *
 * `tests/helpers/` is the single owner of every shared test primitive
 * (source-scan, error-scan, multi-user, data-loss, mock-http, http-server,
 * json-request). Before these modules existed, those primitives were
 * re-implemented in 40+ test files as byte-identical + near-duplicate copies
 * that had drifted. This test prevents re-introduction: a test file that
 * defines a function whose body is byte-identical (after whitespace
 * normalization) to a function exported from ANY helper module must import
 * it instead.
 *
 * A local function with a DIFFERENT body (a genuinely distinct variant) is
 * allowed — the test only flags exact duplicates, so a scan that needs a
 * different stripper semantics can keep its local copy. This is DYNAMIC
 * (no allowlist): the shared helpers + their exports are DISCOVERED at
 * run time by walking `tests/helpers/`, and the test files are discovered
 * by walking `tests/`. A newly added helper module is automatically
 * covered — no hand-maintained mirror that can rot when the helpers grow.
 */
import { describe, test, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, sep } from "node:path";

import { blankStringLiterals, stripCommentsOnlyFor, walk } from "../helpers/source-scan.ts";

const HELPERS_DIR = "tests/helpers";

/** `join` is excluded from the dead-import scan: `Array.prototype.join`
 * (`.join(`) is ubiquitous in test message formatting, so a word-boundary
 * check would mask a genuinely-dead `path.join` import; it is left to the
 * src/ scanner. */
const EXEMPT_NODE_BINDINGS: ReadonlySet<string> = new Set(["join"]);

interface DeadNodeImport {
  readonly file: string;
  readonly sym: string;
  readonly from: string;
}

/**
 * The `node:fs` / `node:path` bindings a file imports but never references.
 *
 * ── THE VIEW IS THE FIX ───────────────────────────────────────────────────
 *
 * This scan used to regex the RAW source, so a documented example — a comment
 * or fixture string spelling `import { join, resolve } from "node:path"` —
 * parsed as a real import and was reported dead, although the file imports
 * neither name. That is a guard reporting work nobody did: the false red that
 * teaches a reader to override it. Extraction therefore reads the shared
 * comment-stripped view (`stripCommentsOnlyFor`, so a doc/fence example is
 * gone) and accepts a match only where the string-blanked view
 * (`blankStringLiterals`) still shows the `import` keyword — so a statement
 * quoted inside a fixture string is refused too. Both views preserve the
 * file's exact length and newlines, so the match offsets are the raw file's
 * own. The module specifier deliberately stays readable: it IS a string
 * literal, and blanking it would hide whether this import names `node:fs` or
 * `node:path`.
 *
 * USAGE IS STILL CHECKED AGAINST THE RAW SOURCE, deliberately: a binding
 * referenced only from inside a template literal is still used, and blanking
 * strings for the reference check would report it as dead.
 */
function deadNodeImportsIn(file: string, src: string): DeadNodeImport[] {
  // Comments blanked, strings kept readable for the specifier.
  const withoutComments = stripCommentsOnlyFor(src, file);
  // Comments and string interiors blanked: a match's keyword is spaces here
  // when the "statement" is only quoted inside a fixture string.
  const code = stripCommentsOnlyFor(blankStringLiterals(src, file), file);
  const rel = file.split(sep).join("/");
  const IMPORT_RE = /\bimport\s*\{([^}]*)\}\s*from\s*("node:fs"|"node:path")\s*;?/g;
  const dead: DeadNodeImport[] = [];
  let im: RegExpExecArray | null;
  while ((im = IMPORT_RE.exec(withoutComments)) !== null) {
    if (!code.startsWith("import", im.index)) continue;
    const fromMod = im[2]!;
    const syms = im[1]!.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    // Offsets are shared with the raw source (all views keep its length), so
    // the statement is cut from the raw text the usage check reads.
    const withoutThisImport = src.slice(0, im.index) + src.slice(im.index + im[0].length);
    for (const sym of syms) {
      if (EXEMPT_NODE_BINDINGS.has(sym)) continue;
      if (!new RegExp(`\\b${sym.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(withoutThisImport)) {
        dead.push({ file: rel, sym, from: fromMod });
      }
    }
  }
  return dead;
}

/** Discover every `.ts` file under `tests/helpers/` (the shared helper
 * modules). Dynamic so a new helper is automatically covered. */
function discoverHelperFiles(): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(HELPERS_DIR)) {
    if (!entry.endsWith(".ts")) continue;
    const full = join(HELPERS_DIR, entry);
    if (!statSync(full).isFile()) continue;
    out.push(full);
  }
  return out;
}

function findFn(lines: readonly string[], name: string): number {
  const re = new RegExp(`^(?:export\\s+)?(?:async\\s+)?function ${name}\\b`);
  for (let i = 0; i < lines.length; i++) if (re.test(lines[i]!)) return i;
  return -1;
}

function findClose(lines: readonly string[], start: number): number {
  for (let i = start + 1; i < lines.length; i++) if (lines[i] === "}") return i;
  return -1;
}

/** Extract + normalize a top-level function body (the lines BETWEEN the
 * signature line and the closing `}` at column 0, excluding the signature
 * itself so `export function foo` and `function foo` with the same body
 * compare equal). Returns "" if not found. Normalization trims trailing
 * whitespace per line + drops leading/trailing blank lines so a reformat
 * does not evade the check. */
function bodyOf(src: string, name: string): string {
  const lines = src.split("\n");
  const fn = findFn(lines, name);
  if (fn === -1) return "";
  const close = findClose(lines, fn);
  if (close === -1) return "";
  const body = lines.slice(fn + 1, close).map((l) => l.replace(/\s+$/, ""));
  while (body.length > 0 && body[0]!.trim() === "") body.shift();
  while (body.length > 0 && body[body.length - 1]!.trim() === "") body.pop();
  return body.join("\n");
}

// Dynamically parse every helper module's exports (name -> normalized body),
// keyed by the helper file path so a duplicate's report can name the owner.
interface HelperExport { readonly file: string; readonly name: string; readonly body: string; }
const HELPER_FILES = discoverHelperFiles();
// A helper may RE-EXPORT a primitive whose one implementation lives in a
// shared module both suites use (`walk` lives in
// engine/scripts/verification/source-walk.ts). The re-exported names are
// helpers too, owned by that module's bytes, so a test that copies them is
// still a duplicate.
const HELPER_EXPORTS: ReadonlyArray<HelperExport> = HELPER_FILES.flatMap((file) => {
  const src = readFileSync(file, "utf8");
  const own = Array.from(src.matchAll(/^export (?:async\s+)?function (\w+)\b/gm)).map((m) => ({
    file,
    name: m[1]!,
    body: bodyOf(src, m[1]!),
  }));
  const reExported = Array.from(src.matchAll(/^export \{([^}]*)\} from "(\.[^"]+)";/gm)).flatMap((m) => {
    const owner = join(dirname(file), m[2]!);
    const ownerSource = readFileSync(owner, "utf8");
    return m[1]!.split(",").map((name) => name.trim()).filter((name) => /^\w+$/u.test(name))
      .map((name) => ({ file: owner, name, body: bodyOf(ownerSource, name) }));
  });
  return [...own, ...reExported];
});
const HELPER_NAME_TO_OWNER = new Map<string, string>(
  HELPER_EXPORTS.filter((e) => e.body !== "").map((e) => [e.name, e.file]),
);
const HELPER_BODIES = new Map<string, string>(
  HELPER_EXPORTS.filter((e) => e.body !== "").map((e) => [e.body, e.file]),
);
const ALL_HELPER_NAMES = new Set(HELPER_EXPORTS.map((e) => e.name));

// Walk the test tree (excludes the helper files themselves via the ignore
// option so a helper's own internal functions are not self-flagged).
function walkTestsSync(dir: string): string[] {
  return walk(dir, { exts: [".ts", ".mjs"], ignore: ["helpers"] });
}
const TEST_FILES = walkTestsSync("tests");

describe("test helpers are not duplicated across test files (single owner: tests/helpers/*.ts)", () => {
  test("the helpers directory exports at least the source-scan primitives (sanity — dynamic discovery)", () => {
    expect(HELPER_FILES.length, "tests/helpers/ must contain at least the source-scan + multi-user + mock-http + http-server + json-request helpers").toBeGreaterThanOrEqual(5);
    for (const name of ["read", "walk", "walkTs", "sourceFiles", "stripCommentsAndStringsFor", "stripCommentsAndStringsDropFor", "stripCommentsOnlyFor", "stripCommentsOnly", "cssBlock", "relpath"]) {
      expect(ALL_HELPER_NAMES, `source-scan.ts must export ${name}`).toContain(name);
    }
    // mock-http + http-server + json-request helpers must be present.
    for (const name of ["mockReq", "createMockRes", "startHttpTestServer", "jsonRequest"]) {
      expect(ALL_HELPER_NAMES, `tests/helpers/ must export ${name} (the shared HTTP test primitives)`).toContain(name);
    }
  });

  const duplicates: { file: string; name: string; sharedMatch: string; owner: string }[] = [];
  for (const file of TEST_FILES) {
    const src = readFileSync(file, "utf8");
    const rel = file.split(sep).join("/");
    // Any top-level `function NAME(` in a test file whose body matches a
    // shared export body is an exact duplicate (should import instead).
    const localFns = Array.from(src.matchAll(/^(?:export\s+)?function (\w+)\b/gm)).map((m) => m[1]!);
    for (const name of localFns) {
      const body = bodyOf(src, name);
      if (body === "") continue;
      const owner = HELPER_BODIES.get(body);
      if (owner !== undefined) {
        const sharedName = [...HELPER_EXPORTS].find((e) => e.body === body && e.file === owner)!.name;
        duplicates.push({ file: rel, name, sharedMatch: sharedName, owner });
      }
    }
  }

  test("no test file defines a function byte-identical to ANY helper export (dynamic — covers all tests/helpers/*.ts)", () => {
    expect(
      duplicates,
      duplicates.map((d) => `${d.file}: function ${d.name} duplicates ${d.owner} ${d.sharedMatch} (import it instead)`).join("\n"),
    ).toEqual([]);
  });

  test("at least 55 test files import from tests/helpers/source-scan.ts (the migration is not regressed)", () => {
    const importers = TEST_FILES.filter((f) => {
      const src = readFileSync(f, "utf8");
      return /from\s+["'][^"']*helpers\/source-scan\.ts["']/.test(src);
    });
    expect(importers.length, "at least 55 test files import from source-scan.ts (+ walk/walkTs migration)").toBeGreaterThanOrEqual(55);
  });

  test("no test file redefines the shared tree-walk primitives (walk / walkTs) at top level — import them instead", () => {
    // The shared owner exports `walk` + `walkTs` as the canonical recursive
    // directory walkers. A test file that defines its own top-level
    // `function walk(` or `function walkTs(` is re-implementing the shared
    // walker. Top-level (column 0) only — a nested closure that happens to
    // be named `walk` is a local detail, not a scattered primitive.
    const redefinitions: { file: string; name: string }[] = [];
    const TOP_LEVEL_WALK_RE = /^(?:export\s+)?(?:async\s+)?function\s+(walk|walkTs)\s*\(/gm;
    for (const file of TEST_FILES) {
      const src = readFileSync(file, "utf8");
      let m: RegExpExecArray | null;
      while ((m = TOP_LEVEL_WALK_RE.exec(src)) !== null) {
        redefinitions.push({ file: file.split(sep).join("/"), name: m[1]! });
      }
    }
    expect(
      redefinitions,
      redefinitions.map((r) => `${r.file}: redefines shared tree-walk primitive "${r.name}" (import from helpers/source-scan.ts instead)`).join("\n"),
    ).toEqual([]);
  });

  test("no test file defines a top-level function sharing a name with ANY helper export (deny-by-default — covers all helpers)", () => {
    // Deny-by-default: every name exported by ANY helper in tests/helpers/
    // is owned by that helper. A test file that defines its own top-level
    // `function read(`/`function cssBlock(`/`function mockReq(`/`function
    // createMockRes(`/`function startHttpTestServer(`/`function jsonRequest(`
    // (etc.) shadows the shared primitive — a naming collision that reads
    // as "use the shared one" but runs a distinct local copy (the same
    // "wired but inert" class as a broken shared primitive). The fix is to
    // import the shared primitive (when behavior-equivalent) OR rename the
    // local to a non-colliding name (when it is a genuinely distinct
    // variant). Top-level (column 0) only — a nested closure sharing a
    // name is a local detail, not a shadow of the shared export.
    const TOP_LEVEL_FN_RE = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
    const shadows: { file: string; name: string; owner: string }[] = [];
    for (const file of TEST_FILES) {
      const src = readFileSync(file, "utf8");
      let m: RegExpExecArray | null;
      while ((m = TOP_LEVEL_FN_RE.exec(src)) !== null) {
        const owner = HELPER_NAME_TO_OWNER.get(m[1]!);
        if (owner !== undefined) {
          shadows.push({ file: file.split(sep).join("/"), name: m[1]!, owner });
        }
      }
    }
    expect(
      shadows,
      shadows.map((s) => `${s.file}: top-level function "${s.name}" shadows a ${s.owner} export (import it, or rename the local variant)`).join("\n"),
    ).toEqual([]);
  });

  test("no test file imports a node:fs / node:path symbol it does not use (dead imports accumulate after migrations)", () => {
    // Migrations that replace a local walker with the shared `walk` often
    // leave the old `readdirSync` / `statSync` / `existsSync` (and path
    // `extname` / `relative` / `sep`) imports behind — dead code that is not
    // caught by the src/ + server/ unused-imports scan. This denies
    // re-accumulation: every imported symbol from `node:fs` or `node:path`
    // must appear (word boundary) somewhere outside its import statement.
    const dead = TEST_FILES.flatMap((file) => deadNodeImportsIn(file, readFileSync(file, "utf8")));
    expect(
      dead,
      dead.map((d) => `${d.file}: imports ${d.sym} from ${d.from} but never uses it`).join("\n"),
    ).toEqual([]);
  });

  test("a documented example import is not a real import — but a real dead one still is", () => {
    // The shape that reddened the guard-of-guards: an import EXAMPLE inside a
    // doc comment (and a fixture string telling the same story) parsed as a
    // real binding, so a file that imports only `relative` was accused of a
    // dead `join` / `resolve`. Neither binding exists in code, so neither may
    // be reported.
    const documented = [
      "/**",
      " * Migrated with:",
      " *",
      " *     import {",
      " *       join,",
      " *       resolve,",
      ' *     } from "node:path";',
      " */",
      'const EXAMPLE = `import { readFileSync } from "node:fs";`;',
      'import { relative } from "node:path";',
      'export const here = relative(".", ".");',
    ].join("\n");
    expect(deadNodeImportsIn("tests/fixture.ts", documented)).toEqual([]);

    // THE NEGATIVE HALF: a REAL unused binding is still a finding, so this
    // cannot pass by silencing the scan.
    const realDead = 'import { readFileSync, statSync } from "node:fs";\nreadFileSync("x");\n';
    expect(deadNodeImportsIn("tests/fixture.ts", realDead)).toEqual([
      { file: "tests/fixture.ts", sym: "statSync", from: '"node:fs"' },
    ]);
  });
});
