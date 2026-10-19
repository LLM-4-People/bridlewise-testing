// @vitest-environment node
/**
 * NO SPELLING COMPARISON DECIDES CONTAINMENT IN THE CONFINEMENT OWNERS
 * (secc-design M2, secd-design M5): whether a location is under, or is, a
 * protected one is answered by `engine/src/filesystem/path-identity.ts`
 * (device + inode, the candidate's own resolved spelling, caseless on DrvFs)
 * and asked through the keep-out policy. A second, spelling-based answer
 * beside it is what let `/mnt/wslg/distro/...`, a case-folded DrvFs segment
 * and a bind mount through before.
 *
 * THE OWNERS ARE DERIVED, NOT LISTED: every file of the engine, the web
 * server and the scripts that imports an identity question (a path-identity,
 * keep-out, key-home, database-files, fs-gate or checkout-write-door symbol,
 * directly or through the server's canonical hub). A new owner is scanned
 * the day it imports one (the SEC-d list was written by hand and missed
 * `server/blocks/custody.ts`).
 *
 * THE SHAPES ARE JUDGED BY PROVENANCE, NOT BY A VARIABLE NAME: a value is a
 * PATH when it is typed `ResolvedAbsolutePath`/`AdmittedKeyHome`, comes from a
 * path call (`resolve`, `join`, `dirname`, `realpathSync`, `resolveLocation`,
 * `homedir`, `tmpdir`…) or a path property, or is named like one — and the
 * guard fails, in every owner, on:
 *   - `p.startsWith(x)` / `p.endsWith(x)` with `x` not a constant string
 *     (`candidate.startsWith(`${root}/`)`, a prefix built beforehand, an
 *     `ancestor.endsWith("/") ? …` choice);
 *   - `p.indexOf(q) === 0`, `p.slice(0, n) === q` (the same test, spelled
 *     differently);
 *   - `===` / `!==` between two paths (spelling identity), except the
 *     root-termination idiom `dirname(x) === x`;
 *   - `relative(a, b)` compared with `..` or starting with it.
 * Comparisons that are not containment decisions are declared below, each
 * with its reason. Mutation arms: every shape the SEC-d guard missed (the
 * verifier's probe) planted into a real owner is caught.
 */
import { describe, expect, test } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { modulePath } from "../helpers/module-resolver.ts";
import { walk } from "../../engine/scripts/verification/source-walk.ts";

const ts = createRequire(import.meta.url)("typescript5") as typeof import("typescript5");
type TsNode = import("typescript5").Node;
type TsExpression = import("typescript5").Expression;
type TsSourceFile = import("typescript5").SourceFile;
const ROOT = process.cwd();

/** The one owner of identity itself: it implements the spelled fallback the others must not repeat. */
const IDENTITY_OWNER = modulePath("path-identity.ts");

/** Modules whose import makes a file a confinement owner. */
const OWNER_MODULES = /(?:^|\/)(?:path-identity|keep-out|key-home|database-files|fs-gate|checkout-write-door|host-facts)\.ts$/u;
/** Symbols (through any hub) whose import makes a file a confinement owner. */
const OWNER_SYMBOLS: ReadonlySet<string> = new Set([
  "resolveLocation", "identityOverlapIndex", "createPathLocator", "staysWithinRegion", "assertResolvesWithinRegion",
  "keepOutPolicyFor", "keepOutInForce", "serverKeepOutPolicy", "serverKeepOutFacts", "projectKeepOut", "resolveWithinProject",
  "projectRootRefusals", "isWithinAllowedRoots", "assertWithinAllowedRoots", "admitKeyHome", "admitHarnessKeyHome",
  "legacyInstallIn", "databaseFamily", "pathHasSecondName",
]);

/**
 * Comparisons that are NOT containment decisions, each with its reason, as
 * `<file>: <expression text>`.
 */
const NOT_CONTAINMENT: Readonly<Record<string, string>> = {
  // A configured source compared with the one already admitted: a different
  // spelling of the same file is REFUSED (an owner conflict), never admitted.
  "server/db/bootstrap-key.ts: previous.dbPath !== normalized.dbPath": "an owner-conflict refusal (the safe direction)",
  // The registry's own record of the database, left out of the database's
  // pairing: a record spelled otherwise is only asked again for a ledger the
  // database does not have (never an admission).
  "server/db/key-rotation.ts: store !== dbPath": "excluding the database's own record from its key pairing",
  // A file-name suffix of the marker a runner holds open (its identity is the
  // write door's own question, recorded for WF-1b3: match the marker by inode).
  "engine/src/filesystem/checkout-write-door.ts: target.endsWith(MARKER_SUFFIX)": "the runner marker's file-name suffix",
  // A recorded manifest key under a recorded folder (an operator's folder, a
  // manifest's evidence folder): a lookup among the manifest's own keys (each a
  // validated repository-relative shape), never a decision about where a place
  // on the disk lies (every read and write of the disk is contained by
  // descriptor and identity, `openContainedFolder`).
  "engine/src/workflow/evidence-store.ts: key.startsWith(`${folder}/`)": "relating recorded manifest keys to a recorded folder",
};

function constantStrings(sf: TsSourceFile): ReadonlySet<string> {
  const names = new Set<string>();
  const visit = (node: TsNode): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined
      && (ts.isStringLiteralLike(node.initializer) || (ts.isAsExpression(node.initializer) && ts.isStringLiteralLike(node.initializer.expression)))) names.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}

const PATH_TYPE = /\b(?:ResolvedAbsolutePath|AdmittedKeyHome)\b/u;
const PATH_CALLS: ReadonlySet<string> = new Set(["resolve", "join", "dirname", "realpathSync", "resolveLocation", "namedBelow", "resolvedParent", "homedir", "tmpdir", "fileURLToPath", "normalize", "harnessRoot", "keyHomeLocation"]);
const PATH_NAME = /(?:path|dir|root|home|abs|resolved|target|candidate|location|folder|parent|ancestor|base|mount|store)$/iu;

/** The shapes this guard refuses in one source text, as `<line>: <expression>`. */
export function spellingComparisons(file: string, source: string): readonly string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const text = (node: TsNode): string => node.getText(sf);
  const constants = constantStrings(sf);
  const declaredPaths = new Set<string>();
  /** Variables holding `dirname(<x>)`, by name → the text of `<x>` (the root-termination idiom). */
  const dirnameOf = new Map<string, string>();
  const unwrap = (node: TsExpression): TsExpression => (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) ? unwrap(node.expression) : node);
  const calleeName = (node: TsExpression): string | undefined => {
    const callee = unwrap(node);
    if (ts.isIdentifier(callee)) return callee.text;
    if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
    return undefined;
  };
  const isPath = (node: TsExpression): boolean => {
    const expression = unwrap(node);
    if (ts.isIdentifier(expression)) return declaredPaths.has(expression.text) || PATH_NAME.test(expression.text);
    if (ts.isCallExpression(expression)) return PATH_CALLS.has(calleeName(expression.expression) ?? "");
    if (ts.isPropertyAccessExpression(expression)) return PATH_NAME.test(expression.name.text);
    if (ts.isTemplateExpression(expression)) return expression.templateSpans.some((span) => isPath(span.expression));
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) return isPath(expression.left) || isPath(expression.right);
    if (ts.isConditionalExpression(expression)) return isPath(expression.whenTrue) || isPath(expression.whenFalse);
    return false;
  };
  const isConstant = (node: TsExpression): boolean => {
    const expression = unwrap(node);
    return ts.isStringLiteralLike(expression) || ts.isNumericLiteral(expression) || ["undefined", "null"].includes(text(expression))
      || (ts.isIdentifier(expression) && constants.has(expression.text));
  };
  const collect = (node: TsNode): void => {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && ts.isIdentifier(node.name)) {
      const typed = node.type !== undefined && PATH_TYPE.test(text(node.type));
      const derived = ts.isVariableDeclaration(node) && node.initializer !== undefined && isPath(node.initializer);
      if (typed || derived) declaredPaths.add(node.name.text);
      if (ts.isVariableDeclaration(node) && node.initializer !== undefined && ts.isCallExpression(unwrap(node.initializer))) {
        const call = unwrap(node.initializer) as import("typescript5").CallExpression;
        if (calleeName(call.expression) === "dirname" && call.arguments[0] !== undefined) dirnameOf.set(node.name.text, text(call.arguments[0]));
      }
    }
    ts.forEachChild(node, collect);
  };
  // Twice: a path derived from a path declared later in the file.
  collect(sf);
  collect(sf);
  const found: string[] = [];
  const report = (node: TsNode): void => { found.push(`${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}: ${text(node)}`); };
  // `dirname(x) === x` (or a variable holding `dirname(x)` against `x`): the walk reached the root.
  const isDirnameIdiom = (left: TsExpression, right: TsExpression): boolean =>
    [left, right].some((side) => ts.isCallExpression(unwrap(side)) && calleeName((unwrap(side) as import("typescript5").CallExpression).expression) === "dirname")
    || dirnameOf.get(text(left)) === text(right) || dirnameOf.get(text(right)) === text(left);
  const visit = (node: TsNode): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.arguments[0] !== undefined) {
      const method = node.expression.name.text, receiver = node.expression.expression, argument = node.arguments[0];
      const relativeUp = method === "startsWith" && /^["'`]\.\.(?:\/)?["'`]$/u.test(text(argument)) && (ts.isCallExpression(unwrap(receiver)) && calleeName((unwrap(receiver) as import("typescript5").CallExpression).expression) === "relative" || ts.isIdentifier(unwrap(receiver)) && /rel/iu.test(text(receiver)));
      if (relativeUp || ((method === "startsWith" || method === "endsWith") && (isPath(receiver) || isPath(argument)) && !isConstant(argument))) report(node);
    }
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(node.operatorToken.kind)) {
      const left = unwrap(node.left), right = unwrap(node.right);
      const indexOfZero = [left, right].some((side) => ts.isCallExpression(side) && calleeName(side.expression) === "indexOf" && ts.isPropertyAccessExpression(side.expression) && (isPath(side.expression.expression) || side.arguments.some((arg) => isPath(arg))))
        && [left, right].some((side) => text(side) === "0");
      const sliceCompare = [left, right].some((side) => ts.isCallExpression(side) && calleeName(side.expression) === "slice" && ts.isPropertyAccessExpression(side.expression) && isPath(side.expression.expression)) && !isConstant(left) && !isConstant(right);
      const relativeUp = [left, right].some((side) => ts.isCallExpression(side) && calleeName(side.expression) === "relative") && [left, right].some((side) => /^["'`]\.\.["'`]$/u.test(text(side)));
      const spelling = !isConstant(left) && !isConstant(right) && isPath(left) && isPath(right) && !isDirnameIdiom(left, right);
      if (indexOfZero || sliceCompare || relativeUp || spelling) report(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** The folder's production sources, through the one shared walk (tests are not owners). */
function productionSources(folder: string): readonly string[] {
  return walk(join(ROOT, folder), { exts: [".ts", ".mts"] }).map((path) => relative(ROOT, path)).filter((file) => !file.endsWith(".test.ts"));
}

/** Every file importing an identity question (a module or a symbol of it, through any hub). */
function derivedOwners(): readonly string[] {
  return ["engine/src", "server", "scripts"].flatMap(productionSources).filter((file) => {
    if (file === IDENTITY_OWNER || /^engine\/scripts\/exp/u.test(file)) return false;
    const sf = ts.createSourceFile(file, readFileSync(join(ROOT, file), "utf8"), ts.ScriptTarget.Latest, true);
    return sf.statements.some((statement) => {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return false;
      if (OWNER_MODULES.test(statement.moduleSpecifier.text)) return true;
      const bindings = statement.importClause?.namedBindings;
      return bindings !== undefined && ts.isNamedImports(bindings) && bindings.elements.some((element) => OWNER_SYMBOLS.has((element.propertyName ?? element.name).text));
    }) || OWNER_MODULES.test(file);
  });
}

describe("the confinement owners decide containment by identity only", () => {
  test("no owner compares path spellings for containment or identity", () => {
    const owners = derivedOwners();
    // The derivation sees the owners it must (the SEC-d list, and the one it missed).
    for (const expected of ["fs-gate.ts", "keep-out.ts", "key-rotation.ts", "landlock-runner.ts", "custody.ts"].map(modulePath)) {
      expect(owners, expected).toContain(expected);
    }
    const offenders = owners.flatMap((file) => spellingComparisons(file, readFileSync(join(ROOT, file), "utf8"))
      .filter((hit) => NOT_CONTAINMENT[`${file}: ${hit.slice(hit.indexOf(": ") + 2)}`] === undefined).map((hit) => `${file}:${hit}`));
    expect(offenders).toEqual([]);
  });

  test("MUTATION: every shape — the SEC-d guard's and the four it missed — planted into a real owner is caught", () => {
    const owner = modulePath("fs-gate.ts");
    const real = readFileSync(join(ROOT, owner), "utf8");
    for (const planted of [
      "export const p1 = (candidate: string, root: string) => candidate.startsWith(`${root}/`);",
      "export const p2 = (candidate: string, root: string) => candidate.startsWith(root + sep);",
      "export const p3 = (candidate: string, rootDir: string) => relative(rootDir, candidate).startsWith(\"..\");",
      "export const p4 = (candidate: string, rootDir: string) => relative(rootDir, candidate) === \"..\";",
      "export const p5 = (candidatePath: string, homeDir: string) => candidatePath === homeDir;",
      // The four the name-based guard missed (secd-design M5, the verifier's probe):
      "export const m1 = (candidate: string, ancestor: string) => candidate === ancestor || candidate.startsWith(ancestor.endsWith(\"/\") ? ancestor : `${ancestor}/`);",
      "export const m2 = (candidate: string, root: string) => { const prefix = `${root}/`; return candidate.startsWith(prefix); };",
      "export const m3 = (a: ResolvedAbsolutePath, b: ResolvedAbsolutePath) => a === b;",
      "export const m4 = (candidate: string, root: string) => candidate.indexOf(root + \"/\") === 0;",
      "export const m5 = (x: ResolvedAbsolutePath, y: string) => x.slice(0, y.length) === y;",
    ]) {
      expect(spellingComparisons(owner, `${real}\n${planted}\n`).length, planted).toBeGreaterThan(spellingComparisons(owner, real).length);
    }
    // The root-termination idiom is not a containment decision.
    expect(spellingComparisons(owner, "const up = (dir: string) => { const parent = dirname(dir); return parent === dir; };")).toEqual([]);
  });
});
