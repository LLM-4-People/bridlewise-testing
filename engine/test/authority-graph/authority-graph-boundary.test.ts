import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import { astNode, bindingNames, isIdentifierReference, identifierResolvesToImport, moduleScopeFacts, parseSourceModule, walkAst, type AstNode } from "../../src/quality-packs/prevention/ast-helpers.ts";

import * as authorityGraphPublic from "../../scripts/verification/authority-graph.ts";
import {
  AUTHORITY_EXTERNAL_PROBE_COVERAGE,
  AUTHORITY_LEGACY_FAMILY_COVERAGE,
  AUTHORITY_TEST_FAMILY_IDS,
} from "../support/authority-graph-test-catalog.ts";

test("[AG-B001] authority graph exposes one public facade and acyclic cohesive internals", () => {
  assert.deepEqual(Object.keys(authorityGraphPublic).toSorted(), [
    "AUTHORITY_LOCK_SCHEMA_VERSION",
    "AUTHORITY_REGISTRY_SCHEMA_VERSION",
    "AUTHORITY_SOURCE_INVENTORY_PROVENANCE",
    "AUTHORITY_SOURCE_INVENTORY_SCHEMA_VERSION",
    "AUTHORITY_UNIVERSE_DIMENSIONS",
    "TYPESCRIPT_AUTHORITY_ADAPTER_ID",
    "analyzeAuthorityGraph",
    "authoritySourceInventoryEntry",
    "createAuthoritySourceInventory",
  ]);
  const moduleDirectory = new URL("../../scripts/verification/authority/", import.meta.url);
  // Derive the authority module set DYNAMICALLY from the owner directory —
  // every `.ts` file in `scripts/verification/authority/` is an authority
  // module that must satisfy the acyclicity + facade-isolation + unique-
  // implementation invariants below. A new module added to the directory is
  // automatically covered (deny-by-default); no hand-maintained list that
  // would silently rot or force a stale mirror update.
  const modules = readdirSync(moduleDirectory).filter((entry) => entry.endsWith(".ts")).toSorted();
  assert.ok(modules.length > 0, "the authority module directory must contain at least one .ts module");
  const sources = new Map(modules.map((moduleName) => [
    moduleName,
    readFileSync(new URL(moduleName, moduleDirectory), "utf8"),
  ]));
  for (const moduleName of modules.filter((entry) => entry !== "lock-compiler.ts")) {
    const source = sources.get(moduleName)!;
    assert.equal(source.includes("authority-graph.ts"), false, `${moduleName} deep-imports the facade`);
    assert.equal(source.includes("lock-compiler.ts"), false, `${moduleName} creates a compiler back-edge`);
  }
  const graph = new Map(modules.map((moduleName) => {
    const dependencies = [...sources.get(moduleName)!.matchAll(/from\s+["']\.\/([^"'/]+\.ts)["']/gu)]
      .map((match) => match[1]!)
      .filter((dependency) => modules.includes(dependency));
    return [moduleName, dependencies] as const;
  }));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (moduleName: string): void => {
    assert.equal(visiting.has(moduleName), false, `authority module cycle reaches ${moduleName}`);
    if (visited.has(moduleName)) return;
    visiting.add(moduleName);
    for (const dependency of graph.get(moduleName) ?? []) visit(dependency);
    visiting.delete(moduleName);
    visited.add(moduleName);
  };
  for (const moduleName of modules) visit(moduleName);

  const uniqueImplementations = [
    "resolveAuthorities", "staticString", "zodShape", "objectShape", "typeShape",
    "astNode", "astNodeArray", "astChildren", "moduleScopeFacts", "identifierResolvesToDeclaration",
    "identifierResolvesToImport", "isIdentifierReference", "isZodStrictObjectCall",
    "discoverAuthorityOccurrences", "compareAuthorityOccurrences",
  ];
  const allSource = [...sources.values(), readFileSync(new URL("../../src/quality-packs/prevention/ast-helpers.ts", import.meta.url), "utf8")].join("\n");
  for (const name of uniqueImplementations) {
    const declarations = [...allSource.matchAll(new RegExp(`function\\s+${name}\\s*\\(`, "gu"))];
    assert.equal(declarations.length, 1, `${name} has ${declarations.length} implementations`);
  }

  const testDirectory = new URL("./", import.meta.url);
  const authorityTests = readdirSync(testDirectory).filter((entry) =>
    entry.startsWith("authority-graph-") && entry.endsWith(".test.ts"));
  const declaredIds = authorityTests.flatMap((file) => [
    ...readFileSync(new URL(file, testDirectory), "utf8").matchAll(/test\("\[([A-Z0-9-]+)\]/gu),
  ].map((match) => match[1]!)).toSorted();
  assert.equal(new Set(declaredIds).size, declaredIds.length, "authority test IDs must be unique");
  assert.deepEqual(declaredIds, [...AUTHORITY_TEST_FAMILY_IDS].toSorted());
  assert.equal(AUTHORITY_LEGACY_FAMILY_COVERAGE.length, 25);
  for (const [legacyFamily, replacementIds] of AUTHORITY_LEGACY_FAMILY_COVERAGE) {
    assert.ok(replacementIds.length > 0, `${legacyFamily} lost all replacement coverage`);
    for (const id of replacementIds) {
      assert.ok(AUTHORITY_TEST_FAMILY_IDS.includes(id), `${legacyFamily} references unknown ${id}`);
    }
  }
  assert.equal(AUTHORITY_EXTERNAL_PROBE_COVERAGE.length, 57);
  assert.equal(new Set(AUTHORITY_EXTERNAL_PROBE_COVERAGE.map(([scenario]) => scenario)).size, 57);
  for (const [probeScenario, replacementIds] of AUTHORITY_EXTERNAL_PROBE_COVERAGE) {
    assert.ok(replacementIds.length > 0, `${probeScenario} lost all governed coverage`);
    for (const id of replacementIds) {
      assert.ok(AUTHORITY_TEST_FAMILY_IDS.includes(id), `${probeScenario} references unknown ${id}`);
    }
  }
});


test("shared scope facts skip token and comment metadata while retaining real parent identities", () => {
  const first: AstNode = { type: "Identifier", name: "first" };
  const last: AstNode = { type: "Identifier", name: "last" };
  const token: AstNode = { type: "Identifier", name: "not-a-reference" };
  const comment: AstNode = { type: "Identifier", name: "not-a-declaration" };
  const program: AstNode = { type: "Program", body: [first, last], tokens: [token], comments: [comment], leadingComments: [comment] };
  const scope = moduleScopeFacts(program);
  assert.deepEqual(scope.nodes, [program, last, first], "scope traversal retains its LIFO sibling order");
  assert.equal(scope.parents.get(first), program);
  assert.equal(scope.parents.get(last), program);
  assert.equal(scope.parents.has(token), false);
  assert.equal(scope.parents.has(comment), false);
  assert.equal(astNode(Object.assign([], { type: "Identifier", name: "tagged-array" })), undefined, "authority AST admission stays record-only");
  assert.deepEqual(bindingNames({ type: "Identifier" }), [], "a malformed node never invents an undefined binding");
});

test("shared binding owner retains TypeScript parameter-property shadowing of imported identities", () => {
  const program = parseSourceModule("scope.ts", 'import { source } from "./owner.ts"; class Owner { constructor(public source: unknown) { source; } } source;');
  const scope = moduleScopeFacts(program);
  const parameter = scope.nodes.find((node) => node.type === "TSParameterProperty");
  assert.ok(parameter);
  assert.deepEqual(bindingNames(parameter), ["source"]);
  const binding = { declaration: program };
  const module = { ...scope, imports: new Map([["source", binding]]) };
  const references = scope.nodes.filter((node) => node.type === "Identifier" && node.name === "source" && isIdentifierReference(node, scope));
  assert.equal(references.length, 2, "both local and imported reads must be present");
  assert.deepEqual(references.map((node) => identifierResolvesToImport(node, module, binding)).toSorted(), [false, true]);
});


test("shared AST walk preserves the committed optional leave callback after each subtree", () => {
  const first: AstNode = { type: "Identifier", name: "first" };
  const last: AstNode = { type: "Identifier", name: "last" };
  const program: AstNode = { type: "Program", body: [first, last] };
  const entered: AstNode[] = [];
  const left: AstNode[] = [];
  walkAst(program, (node) => entered.push(node), (node) => left.push(node));
  assert.deepEqual(entered, [program, first, last]);
  assert.deepEqual(left, [first, last, program]);
});
