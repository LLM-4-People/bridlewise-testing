/**
 * A TEST STAGES IN A COPY OF THIS REPOSITORY ONLY THROUGH `stageInCopy`.
 *
 * A working copy of this repository (`createRepositoryWorkingCopy`) borrows
 * the canonical object store read-only (`objects/info/alternates`). A raw
 * `git add` in it hashes every changed file, and git FRESHENS (utimes) the
 * pack of any blob it is asked to write that already exists — a dirty file
 * whose bytes equal a historical blob. Two tests did exactly that on every
 * run and touched four packs of the canonical store (wf1a-correctness §5).
 * `stageInCopy` (`src/git/working-copy.ts`) stages against a private object
 * directory and never touches the borrowed store, and `snapshotWorkingTree`
 * commits the same way; they are the doors. A raw `git commit` in a copy
 * freshened five packs per run of the commit-guard facts test (measured).
 *
 * The guard is structural, not a proximity window: it parses each test file,
 * binds the names a `createRepositoryWorkingCopy(...)` result is assigned to,
 * and refuses any call whose argument list both names such a copy and runs
 * git's `add` subcommand.
 */
import assert from "node:assert/strict";
import { join, relative } from "node:path";
import test from "node:test";

import { parse } from "@babel/parser";

import { astChildren, astNode, type AstNode } from "../../src/quality-packs/prevention/ast-helpers.ts";
import { walk } from "../../scripts/verification/source-walk.ts";
import { readSourceView } from "../../scripts/verification/source-view.ts";

const ENGINE = join(import.meta.dirname, "..", "..");
const REPOSITORY = join(ENGINE, "..");

function everyNode(node: AstNode, visit: (node: AstNode) => void): void {
  visit(node);
  for (const child of astChildren(node)) everyNode(child, visit);
}

function stringLiterals(node: AstNode): readonly string[] {
  const found: string[] = [];
  everyNode(node, (inner) => {
    if (inner.type === "StringLiteral" && typeof inner["value"] === "string") found.push(inner["value"]);
  });
  return found;
}

function identifiers(node: AstNode): ReadonlySet<string> {
  const found = new Set<string>();
  everyNode(node, (inner) => {
    if (inner.type === "Identifier" && typeof inner["name"] === "string") found.add(inner["name"]);
  });
  return found;
}

/**
 * The git subcommands that WRITE objects — each one freshens the pack of any
 * object it writes that the borrowed store already holds (`commit` re-writes
 * unchanged subtrees whose cache-tree is invalid: five packs per run of the
 * commit-guard facts test, measured).
 */
const OBJECT_WRITING_SUBCOMMANDS: ReadonlySet<string> = new Set(["add", "commit", "write-tree", "commit-tree", "stash", "merge", "cherry-pick", "rebase", "am"]);

/** Calls in `source` that run an object-writing git subcommand with a copy of this repository among their arguments. */
export function rawStagesInCopies(source: string): readonly number[] {
  const program = astNode(parse(source, { sourceType: "module", plugins: ["typescript"], errorRecovery: true }).program)!;
  const copies = new Set<string>();
  everyNode(program, (node) => {
    const init = astNode(node["init"]);
    const id = astNode(node["id"]);
    if (node.type === "VariableDeclarator" && init?.type === "CallExpression" && id?.type === "Identifier" &&
      astNode(init["callee"])?.["name"] === "createRepositoryWorkingCopy") copies.add(String(id["name"]));
  });
  const lines: number[] = [];
  everyNode(program, (node) => {
    if (node.type !== "CallExpression") return;
    const argumentsNode = { type: "Arguments", body: node["arguments"] } as unknown as AstNode;
    const literals = stringLiterals(argumentsNode);
    const writeIndex = literals.findIndex((literal) => OBJECT_WRITING_SUBCOMMANDS.has(literal));
    const runsGit = astNode(node["callee"])?.["name"] === "git" || literals[0] === "git" || (literals[writeIndex - 1] ?? "").startsWith("-c");
    if (writeIndex < 0 || !runsGit) return;
    if ([...identifiers(argumentsNode)].some((name) => copies.has(name))) {
      lines.push((node as unknown as { loc?: { start: { line: number } } }).loc?.start.line ?? 0);
    }
  });
  return lines;
}

test("prevention: the raw-stage detector sees each spelling and does not cry wolf", () => {
  const copy = 'const copy = createRepositoryWorkingCopy("x-");\n';
  assert.equal(rawStagesInCopies(`${copy}spawnSync("git", ["add", "-A", "--", "engine"], { cwd: copy.root });`).length, 1);
  assert.equal(rawStagesInCopies(`${copy}git(copy.root, ["add", "--", artifact]);`).length, 1);
  assert.equal(rawStagesInCopies(`${copy}execFileSync("git", ["add", "."], { cwd: copy.engineRoot });`).length, 1);
  assert.equal(rawStagesInCopies(`${copy}stageInCopy(copy.root, ["engine"]);`).length, 0, "the door itself");
  assert.equal(rawStagesInCopies(`const root = plant();\ngit(root, "add", "-A");`).length, 0, "a planted repository owns its store");
  assert.equal(rawStagesInCopies(`${copy}git(copy.root, ["status"]);`).length, 0);
  assert.equal(rawStagesInCopies(`${copy}git(copy.root, ["commit", "-q", "-m", "x"]);`).length, 1, "a commit writes objects too");
  assert.equal(rawStagesInCopies(`${copy}snapshotWorkingTree(copy.root, { message: "x", advanceHead: true });`).length, 0, "the commit door itself");
});

test("prevention: no test runs a raw object-writing git command (`add`, `commit`, …) in a copy of this repository", () => {
  const files = [...walk(join(ENGINE, "test"), { exts: [".ts"] }), ...walk(join(REPOSITORY, "tests"), { exts: [".ts"] })];
  assert.ok(files.length > 100, "the scan sees the test trees");
  const offenders = files.flatMap((file) => {
    // Through the source-view owner: a copy named in a comment is not a copy,
    // and the parser reads the comment-blanked view (offsets and lines kept,
    // the git arguments' string literals intact).
    const view = readSourceView(file);
    if (!view.code().includes("createRepositoryWorkingCopy(")) return [];
    return rawStagesInCopies(view.codeWithStringsAndTemplates()).map((line) => `${relative(REPOSITORY, file)}:${line}`);
  });
  assert.deepEqual(offenders, [], "stage in a copy with stageInCopy and commit with snapshotWorkingTree (src/git/working-copy.ts), never a raw git add/commit");
});
