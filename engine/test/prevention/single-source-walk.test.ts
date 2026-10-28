/**
 * GUARD SUBJECT: test code enumerates repository sources through the ONE ownership-pruned walk, never a hand-written recursive readdirSync walker
 * GUARD OWNS: every test source under engine/test and tests/ (fixtures and engine/test/support excluded) — the walker shape itself, not a name list
 * GUARD PLANT: define `function listTs(dir) { for (const e of readdirSync(dir)) … listTs(join(dir, e)) }`, or call `readdirSync(dir, { recursive: true })`
 * GUARD DRIVEN: the detector over planted sources (a declared walker, an arrow walker, a recursive-option read, and non-walkers that must pass)
 * GUARD LIVENESS: the planted walkers are flagged before the universe is judged, and the universe holds this guard's own file
 *
 * THE CLASS. About fifty engine guards each carried a private `readdirSync`
 * walker with its own skip list (`node_modules`, `.git`, `dist`, `build`,
 * `coverage`, dot-directories) and its own copy of the experiment exclusion,
 * so two guards over the same root judged different populations, and every
 * one of them read ignored research copies and build output. The shared walk
 * (`scripts/verification/source-walk.ts`) prunes by the repository's versioned
 * ignore rules, takes the experiment exclusion as a declared predicate, and
 * refuses a missing root or a universe smaller than the git index.
 *
 * A walker that must stay hand-written (a temp fixture, a third-party corpus
 * the repository ignores, a scan that needs every extension or ignored
 * residue) is listed in INTENTIONAL_WALKERS with the reason, where a reader
 * can argue with it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

import { parse } from "@babel/parser";

import { astChildren, astNode, babelParserPluginsForSourcePath, type AstNode } from "../../src/quality-packs/prevention/ast-helpers.ts";
import { walk } from "../../scripts/verification/source-walk.ts";

const REPOSITORY_ROOT = join(import.meta.dirname, "..", "..", "..");
const ENGINE_TEST_ROOT = join(REPOSITORY_ROOT, "engine", "test");
const WEB_TEST_ROOT = join(REPOSITORY_ROOT, "tests");
const TEST_SOURCE_EXTENSIONS = [".ts", ".mts", ".mjs"] as const;

/** Repository-relative path → why this walker is deliberately not the shared walk. */
const PENDING = "PENDING: a repository-source walker outside the A1b engine migration list; migrate it to walk() and delete this entry";

const INTENTIONAL_WALKERS: Readonly<Record<string, string>> = {
  // Walkers that cannot be the shared walk.
  "engine/test/filesystem/journaled-commit.test.ts": "the residue witness over a temporary fixture root must see EVERY file, dot-named staged copies included; not a source walk of this repository",
  "engine/test/aux/quality.test.ts": "reads a third-party corpus (large-codebases/express) the repository ignores; ownership pruning would empty it",
  "engine/test/safety/hallucination-benchmark.test.ts": "reads a third-party corpus (large-codebases/babel) the repository ignores; ownership pruning would empty it",
  "engine/test/prevention/no-editor-backup-files.test.ts": "hunts untracked/ignored backup residue of ANY extension; the shared walk prunes ignored paths and is extension-scoped",
  "engine/test/prevention/no-source-hardlinks.test.ts": "judges nlink of EVERY file (any extension) under the seeded roots, including workspace script roots outside this repository",
  "engine/test/verification/recursive-test-inventory.test.ts": "walks the temporary fixture repositories the test builds, not this repository",
  "engine/test/workflow/gating-never-subtracts.test.ts": "walks the temporary fixture root the test builds, not this repository",
  // Repository-source walkers not yet migrated.
  "tests/cockpit/a11y-hidden-focus-owner.test.ts": PENDING,
  "tests/helpers/module-resolver.ts": PENDING,
  "tests/prevention/absence-witness-owner.test.ts": PENDING,
  "tests/prevention/client-api-owner.test.ts": PENDING,
  "tests/prevention/filesystem-owner.test.ts": PENDING,
  "tests/prevention/generated-artifact-freshness.test.ts": PENDING,
  "tests/prevention/hallucination-safety-gate-owner.test.ts": PENDING,
  "tests/prevention/integration-rule-refs-ratchet.test.ts": PENDING,
  "tests/prevention/no-a11y-warnings.test.ts": PENDING,
  "tests/prevention/no-proximity-window-assertions.test.ts": PENDING,
  "tests/prevention/source-root-organization.test.ts": PENDING,
  "tests/prevention/source-structure-parser-differential.test.ts": PENDING,
  "tests/prevention/temp-dir-owner.test.ts": PENDING,
  "tests/prevention/test-isolation-owner.test.ts": PENDING,
  "tests/prevention/tree-identity-owner.test.ts": PENDING,
  "tests/unit/sole-writer.test.ts": PENDING,
};

function calleeName(call: AstNode): string | undefined {
  const callee = astNode(call.callee);
  if (callee?.type === "Identifier") return String(callee.name);
  if (callee?.type === "MemberExpression" && astNode(callee.property)?.type === "Identifier") {
    return String(astNode(callee.property)!.name);
  }
  return undefined;
}

function everyNode(node: AstNode, visit: (node: AstNode) => void): void {
  visit(node);
  for (const child of astChildren(node)) everyNode(child, visit);
}

/** The name a function node is known by: a declaration, a named expression, or `const f = () => …`. */
function functionName(node: AstNode, parent: AstNode | undefined): string | undefined {
  if ((node.type === "FunctionDeclaration" || node.type === "FunctionExpression") && astNode(node.id) !== undefined) {
    return String(astNode(node.id)!.name);
  }
  if ((node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") && parent?.type === "VariableDeclarator") {
    return astNode(parent.id)?.name as string | undefined;
  }
  return undefined;
}

function isRecursiveOption(argument: AstNode | undefined): boolean {
  return argument?.type === "ObjectExpression" && (argument.properties as unknown[]).map(astNode).some((property) =>
    property?.type === "ObjectProperty" && astNode(property.key)?.name === "recursive" &&
    astNode(property.value)?.type === "BooleanLiteral" && astNode(property.value)?.value === true);
}

/** Every hand-written directory walker in `text`, as `name@line`. */
export function directoryWalkers(path: string, text: string): readonly string[] {
  const parsed = parse(text, {
    sourceType: "module",
    plugins: [...babelParserPluginsForSourcePath(path)] as never,
    errorRecovery: false,
  }) as unknown as { program: unknown };
  const hits: string[] = [];
  const visit = (node: AstNode, parent: AstNode | undefined): void => {
    const line = (node.loc as { start: { line: number } } | undefined)?.start.line ?? 0;
    const name = functionName(node, parent);
    if (name !== undefined) {
      let reads = false;
      let recurses = false;
      everyNode(node, (inner) => {
        if (inner.type !== "CallExpression") return;
        const callee = calleeName(inner);
        if (callee === "readdirSync") reads = true;
        if (callee === name && astNode(inner.callee)?.type === "Identifier") recurses = true;
      });
      if (reads && recurses) hits.push(`${name}@${line}`);
    }
    if (node.type === "CallExpression" && calleeName(node) === "readdirSync" &&
      (node.arguments as unknown[]).map(astNode).some(isRecursiveOption)) {
      hits.push(`readdirSync-recursive@${line}`);
    }
    for (const child of astChildren(node)) visit(child, node);
  };
  visit(astNode(parsed.program)!, undefined);
  return hits;
}

test("single-source-walk: the detector flags each walker shape and leaves plain reads alone", () => {
  const walkers = [
    "function listTs(dir) { for (const e of readdirSync(dir)) { if (isDir(e)) listTs(join(dir, e)); } }",
    "const walk = (dir) => { for (const e of fs.readdirSync(dir)) walk(join(dir, e)); };",
    "const all = readdirSync(root, { recursive: true, withFileTypes: true });",
  ];
  for (const text of walkers) assert.equal(directoryWalkers("planted.ts", text).length, 1, `must be flagged:\n${text}`);
  const plain = [
    "const names = readdirSync(dir).filter((name) => name.endsWith('.ts'));",
    "function files(dir) { return walk(dir, { exts: ['.ts'] }); }",
    "function count(n) { return n === 0 ? 0 : count(n - 1); }",
  ];
  for (const text of plain) assert.deepEqual(directoryWalkers("planted.ts", text), [], `must not be flagged:\n${text}`);
});

test("single-source-walk: no test source walks directories by hand outside the declared exceptions", () => {
  const files = [
    ...walk(ENGINE_TEST_ROOT, { exts: [...TEST_SOURCE_EXTENSIONS], ignore: ["fixtures"] })
      .filter((file) => !relative(ENGINE_TEST_ROOT, file).startsWith("support/")),
    ...walk(WEB_TEST_ROOT, { exts: [...TEST_SOURCE_EXTENSIONS], ignore: ["fixtures"] }),
  ];
  const paths = files.map((file) => relative(REPOSITORY_ROOT, file).split("\\").join("/"));
  assert.ok(paths.includes("engine/test/prevention/single-source-walk.test.ts"), "the scan no longer reaches this guard");
  const found = new Map<string, readonly string[]>();
  files.forEach((file, index) => {
    const hits = directoryWalkers(file, readFileSync(file, "utf8"));
    if (hits.length > 0) found.set(paths[index]!, hits);
  });
  const undeclared = [...found].filter(([path]) => INTENTIONAL_WALKERS[path] === undefined)
    .map(([path, hits]) => `${path}: ${hits.join(", ")}`);
  const stale = Object.keys(INTENTIONAL_WALKERS).filter((path) => !found.has(path));
  assert.deepEqual(undeclared, [],
    "enumerate sources with walk() from scripts/verification/source-walk.ts (declare a narrowing with `ignore`/`exclude`), " +
      "or declare the walker in INTENTIONAL_WALKERS with the reason it cannot be the shared walk");
  assert.deepEqual(stale, [], "an INTENTIONAL_WALKERS entry names a file that no longer walks by hand; remove it");
});
