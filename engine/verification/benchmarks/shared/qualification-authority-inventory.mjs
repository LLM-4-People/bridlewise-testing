#!/usr/bin/env node

import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { ARCHITECTURE_MANIFEST } from "../../../src/architecture-manifest.ts";
import { canonicalHash, canonicalJson, sha256 } from "../../../src/kernel/integrity.ts";
import { assertNoDuplicateJsonObjectKeys } from "../../../src/kernel/json-integrity.ts";
import { ROOT_POLICY } from "../../../src/kernel/root-policy.ts";
import {
  listSafeRepositoryTree,
  readSafeRepositoryFile
} from "../../../scripts/verification/safe-repository-reader.ts";
import {
  QUALIFICATION_AUTHORITY_INVENTORY_SCHEMA_VERSION,
  QUALIFICATION_AUTHORITY_OWNER,
  defineQualificationTrustBaseLease,
  qualifyQualificationSourceCarrier
} from "./qualification-authority-contract.mjs";
import {
  QUALIFICATION_PARSER_SOURCE_EXTENSIONS,
  astChildren,
  astNode,
  astNodeArray,
  createQualificationParserBoundary,
  portableAstSpan
} from "./qualification-parser.mjs";
import Ajv2020 from "ajv/dist/2020.js";

const MODULE_PATH = "verification/benchmarks/shared/qualification-authority-inventory.mjs";
const GENERATED_PATH = "verification/benchmarks/shared/qualification-authority-inventory.v5.json";
const INVENTORY_SCHEMA_PATH = "verification/benchmarks/shared/qualification-authority-inventory.schema.json";
const AUTHORITY_PATH = "verification/benchmarks/shared/qualification-authority.mjs";
const CONTRACT_PATH = "verification/benchmarks/shared/qualification-authority-contract.mjs";
const ROOT = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const MAXIMUM_FILE_BYTES = ROOT_POLICY.verification.testDiscovery.maximumSourceBytes;
const TREE_LIMITS = Object.freeze({
  maximumDepth: ROOT_POLICY.verification.testDiscovery.maximumDepth,
  maximumEntries: ROOT_POLICY.verification.testDiscovery.maximumEntries
});
const EXCLUDED_TOP_LEVEL_DIRECTORIES = new Set([
  ".bridlewise", ".git", ".repair-lease", ".ruff_cache", "node_modules", "repair-checkpoints"
]);
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function byteCompare(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function byteSort(values) {
  return values.toSorted(byteCompare);
}

function strictJson(bytes, sourceId) {
  const text = STRICT_UTF8.decode(bytes);
  if (text.codePointAt(0) === 0xfeff || text.includes("\0")) {
    fail("qualification_inventory_json_encoding_invalid");
  }
  assertNoDuplicateJsonObjectKeys(
    text,
    `${sourceId} contains duplicate JSON keys`,
    "qualification_inventory_json_duplicate_key"
  );
  return JSON.parse(text);
}

function rootIdentity(root) {
  const stats = lstatSync(root, { bigint: true, throwIfNoEntry: false });
  if (!stats?.isDirectory() || stats.isSymbolicLink() || realpathSync(root) !== root) {
    fail("qualification_inventory_repository_root_unsafe");
  }
  return Object.freeze({
    device: stats.dev,
    inode: stats.ino,
    mode: stats.mode,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs
  });
}

function sameRootIdentity(left, right) {
  return Object.keys(left).every((key) => left[key] === right[key]);
}

function rootDirectorySnapshot(root) {
  return readdirSync(root, { withFileTypes: true }).map((entry) => Object.freeze({
    name: entry.name,
    kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other"
  })).toSorted((left, right) => byteCompare(left.name, right.name));
}

function supportedSourcePath(path) {
  return QUALIFICATION_PARSER_SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension));
}

function enumerateRepositorySources(root) {
  const identityBefore = rootIdentity(root);
  const entriesBefore = rootDirectorySnapshot(root);
  const paths = [];
  for (const entry of entriesBefore) {
    if (entry.kind === "other") fail("qualification_inventory_repository_entry_unsupported");
    if (entry.kind === "file") {
      if (supportedSourcePath(entry.name)) paths.push(entry.name);
      continue;
    }
    if (EXCLUDED_TOP_LEVEL_DIRECTORIES.has(entry.name)) continue;
    const tree = listSafeRepositoryTree(root, entry.name, TREE_LIMITS);
    paths.push(...tree.filter((item) => item.kind === "file" && supportedSourcePath(item.path))
      .map((item) => item.path));
  }
  const entriesAfter = rootDirectorySnapshot(root);
  const identityAfter = rootIdentity(root);
  if (!sameRootIdentity(identityBefore, identityAfter) || canonicalJson(entriesBefore) !== canonicalJson(entriesAfter)) {
    fail("qualification_inventory_repository_root_changed");
  }
  if (paths.length === 0 || paths.length > TREE_LIMITS.maximumEntries || new Set(paths).size !== paths.length) {
    fail("qualification_inventory_source_universe_invalid");
  }
  return Object.freeze(byteSort(paths));
}

function readSource(root, path) {
  const read = readSafeRepositoryFile(root, path, MAXIMUM_FILE_BYTES);
  return Object.freeze({
    path,
    ...qualifyQualificationSourceCarrier(path),
    byteLength: read.bytes.length,
    sha256: sha256(read.bytes),
    bytes: Buffer.from(read.bytes)
  });
}

function walkProgram(program) {
  const nodes = [];
  const parents = new Map();
  const depths = new Map([[program, 0]]);
  const pending = [program];
  while (pending.length > 0) {
    const node = pending.pop();
    nodes.push(node);
    if (nodes.length > ROOT_POLICY.verification.testDiscovery.maximumAstNodes) {
      fail("qualification_inventory_ast_node_limit");
    }
    const depth = depths.get(node);
    if (depth > ROOT_POLICY.verification.testDiscovery.maximumAstDepth) {
      fail("qualification_inventory_ast_depth_limit");
    }
    for (const child of astChildren(node)) {
      parents.set(child, node);
      depths.set(child, depth + 1);
      pending.push(child);
    }
  }
  return Object.freeze({ nodes: Object.freeze(nodes), parents });
}

function literalName(node) {
  return node?.type === "Identifier" ? String(node.name) :
    node?.type === "StringLiteral" ? String(node.value) : undefined;
}

function bindingNames(pattern) {
  if (!pattern) return [];
  if (pattern.type === "Identifier") return [String(pattern.name)];
  if (pattern.type === "RestElement") return bindingNames(astNode(pattern.argument));
  if (pattern.type === "AssignmentPattern") return bindingNames(astNode(pattern.left));
  if (pattern.type === "ArrayPattern") return astNodeArray(pattern.elements).flatMap(bindingNames);
  if (pattern.type === "ObjectPattern") return astNodeArray(pattern.properties).flatMap((property) =>
    property.type === "RestElement" ? bindingNames(astNode(property.argument)) : bindingNames(astNode(property.value))
  );
  return [];
}

function topLevelDeclarations(program) {
  const declarations = new Map();
  for (const statementValue of astNodeArray(program.body)) {
    const statement = statementValue.type === "ExportNamedDeclaration" ? astNode(statementValue.declaration) : statementValue;
    if (statement?.type === "VariableDeclaration") {
      for (const declarator of astNodeArray(statement.declarations)) {
        const init = astNode(declarator.init);
        for (const name of bindingNames(astNode(declarator.id))) declarations.set(name, { declarator, init });
      }
    } else if (["FunctionDeclaration", "ClassDeclaration"].includes(statement?.type)) {
      const id = astNode(statement.id);
      if (id?.type === "Identifier") declarations.set(String(id.name), { declarator: statement, init: statement });
    }
  }
  return declarations;
}

function uniqueVariableDeclarations(nodes) {
  const declarations = new Map();
  const ambiguous = new Set();
  for (const node of nodes) {
    if (node.type !== "VariableDeclarator") continue;
    const init = astNode(node.init);
    for (const name of bindingNames(astNode(node.id))) {
      if (declarations.has(name)) ambiguous.add(name);
      else declarations.set(name, { declarator: node, init });
    }
  }
  for (const name of ambiguous) declarations.delete(name);
  return declarations;
}

function importAttributes(node) {
  const attributes = astNodeArray(node.attributes ?? node.assertions).map((attribute) => {
    const key = literalName(astNode(attribute.key));
    const value = literalName(astNode(attribute.value));
    if (key === undefined || value === undefined) fail("qualification_inventory_import_attribute_unsupported");
    return Object.freeze({ key, value });
  });
  return Object.freeze(attributes);
}

function resolveModuleSpecifier(fromPath, specifier, availablePaths) {
  if (typeof specifier !== "string" || specifier.length === 0 || specifier.normalize("NFC") !== specifier) {
    return Object.freeze({ resolution: "invalid", target: null });
  }
  if (!specifier.startsWith(".")) return Object.freeze({ resolution: "external", target: null });
  const clean = specifier.split(/[?#]/u, 1)[0];
  const base = posix.normalize(posix.join(posix.dirname(fromPath), clean));
  if (base === ".." || base.startsWith("../") || base.startsWith("/")) {
    return Object.freeze({ resolution: "outside-repository", target: null });
  }
  const candidates = [base];
  if (!QUALIFICATION_PARSER_SOURCE_EXTENSIONS.some((extension) => base.endsWith(extension))) {
    candidates.push(...QUALIFICATION_PARSER_SOURCE_EXTENSIONS.map((extension) => base + extension));
    candidates.push(...QUALIFICATION_PARSER_SOURCE_EXTENSIONS.map((extension) => `${base}/index${extension}`));
  }
  const matches = candidates.filter((candidate) => availablePaths.has(candidate));
  return matches.length === 1 ? Object.freeze({ resolution: "internal", target: matches[0] }) :
    Object.freeze({ resolution: matches.length === 0 ? "missing" : "ambiguous", target: null });
}

function declarationExportNames(declaration) {
  if (!declaration) return [];
  if (["FunctionDeclaration", "ClassDeclaration", "TSTypeAliasDeclaration", "TSInterfaceDeclaration",
    "TSEnumDeclaration"].includes(declaration.type)) {
    const id = astNode(declaration.id);
    return id?.type === "Identifier" ? [String(id.name)] : [];
  }
  if (declaration.type === "VariableDeclaration") {
    return astNodeArray(declaration.declarations).flatMap((entry) => bindingNames(astNode(entry.id)));
  }
  return [];
}

function staticSpecifier(expression, facts, resolving = new Set(), depth = 0) {
  if (!expression || depth > ROOT_POLICY.verification.testDiscovery.maximumStaticEvaluationDepth) return null;
  if (expression.type === "StringLiteral") return String(expression.value);
  if (expression.type === "TemplateLiteral" && astNodeArray(expression.expressions).length === 0) {
    return astNodeArray(expression.quasis).map((quasi) => String(quasi.value?.cooked ?? quasi.value?.raw ?? "")).join("");
  }
  if (expression.type === "BinaryExpression" && expression.operator === "+") {
    const left = staticSpecifier(astNode(expression.left), facts, resolving, depth + 1);
    const right = staticSpecifier(astNode(expression.right), facts, resolving, depth + 1);
    return left === null || right === null ? null : left + right;
  }
  if (expression.type === "Identifier") {
    const name = String(expression.name);
    if (resolving.has(name)) return null;
    const declaration = facts.declarations.get(name);
    if (!declaration?.init) return null;
    return staticSpecifier(declaration.init, facts, new Set([...resolving, name]), depth + 1);
  }
  return null;
}

function importBindingFacts(node, edge) {
  return astNodeArray(node.specifiers).map((specifier) => {
    const local = astNode(specifier.local);
    if (local?.type !== "Identifier") fail("qualification_inventory_import_binding_unsupported");
    if (specifier.type === "ImportSpecifier") {
      const imported = literalName(astNode(specifier.imported));
      if (imported === undefined) fail("qualification_inventory_import_binding_unsupported");
      return [String(local.name), { kind: "named", importedName: imported, edge }];
    }
    if (specifier.type === "ImportDefaultSpecifier") {
      return [String(local.name), { kind: "default", importedName: "default", edge }];
    }
    if (specifier.type === "ImportNamespaceSpecifier") {
      return [String(local.name), { kind: "namespace", importedName: "*", edge }];
    }
    fail("qualification_inventory_import_binding_unsupported");
  });
}

function propertyName(member) {
  const property = astNode(member?.property);
  if (!member?.computed && property?.type === "Identifier") return String(property.name);
  if (member?.computed && property?.type === "StringLiteral") return String(property.value);
  return null;
}

function isCreateRequireCallee(callee, facts, createRequireNames, moduleNamespaces) {
  if (callee?.type === "Identifier" && createRequireNames.has(String(callee.name))) return true;
  if (callee?.type !== "MemberExpression" && callee?.type !== "OptionalMemberExpression") return false;
  const object = astNode(callee.object);
  return object?.type === "Identifier" && moduleNamespaces.has(String(object.name)) &&
    propertyName(callee) === "createRequire";
}

function loaderAliases(facts) {
  const createRequireNames = new Set();
  const moduleNamespaces = new Set();
  for (const [local, binding] of facts.imports) {
    if (!['node:module', 'module'].includes(binding.edge.specifier)) continue;
    if (binding.kind === "named" && binding.importedName === "createRequire") createRequireNames.add(local);
    if (binding.kind === "namespace" || binding.kind === "default") moduleNamespaces.add(local);
  }
  for (const { declarator, init } of facts.declarations.values()) {
    const id = astNode(declarator.id);
    if (id?.type !== "ObjectPattern" || init?.type !== "Identifier" ||
      !moduleNamespaces.has(String(init.name))) continue;
    for (const property of astNodeArray(id.properties)) {
      if (literalName(astNode(property.key)) === "createRequire") {
        for (const name of bindingNames(astNode(property.value))) createRequireNames.add(name);
      }
    }
  }
  const loaders = new Set(/\.(?:cjs|cts)$/u.test(facts.source.path) ? ["require"] : []);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, declaration] of facts.declarations) {
      const init = declaration.init;
      const alias = init?.type === "Identifier" && loaders.has(String(init.name));
      const created = init?.type === "CallExpression" &&
        isCreateRequireCallee(astNode(init.callee), facts, createRequireNames, moduleNamespaces);
      if ((alias || created) && !loaders.has(name)) {
        loaders.add(name);
        changed = true;
      }
    }
  }
  return loaders;
}

export function buildScopeAnalysis(program) {
  const scopeOf = new Map();
  const scopes = [];
  let nextId = 0;
  function newScope(parent, kind) {
    const scope = { id: nextId++, parent, kind, bindings: new Map() };
    scopes.push(scope);
    return scope;
  }
  function nearestFunction(scope) {
    let current = scope;
    while (current !== null && current.kind !== "function" && current.kind !== "program") current = current.parent;
    return current;
  }
  function visit(node, inherited) {
    if (node === null || typeof node !== "object" || Array.isArray(node) || typeof node.type !== "string") return;
    if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") {
      const fnScope = newScope(inherited, "function");
      scopeOf.set(node, fnScope);
      for (const param of astNodeArray(node.params)) {
        for (const name of bindingNames(param)) fnScope.bindings.set(name, { kind: "param", node: param });
      }
      if (node.type === "FunctionDeclaration") {
        const id = astNode(node.id);
        if (id?.type === "Identifier") nearestFunction(inherited).bindings.set(String(id.name), { kind: "function", node });
      }
      const id = astNode(node.id);
      if (id) visit(id, inherited);
      for (const param of astNodeArray(node.params)) visit(param, fnScope);
      const body = astNode(node.body);
      if (body?.type === "BlockStatement") {
        const blockScope = newScope(fnScope, "block");
        scopeOf.set(body, blockScope);
        visit(body, blockScope);
      } else if (body) {
        scopeOf.set(body, fnScope);
        visit(body, fnScope);
      }
      return;
    }
    if (node.type === "BlockStatement") {
      const blockScope = newScope(inherited, "block");
      scopeOf.set(node, blockScope);
      for (const child of astChildren(node)) visit(child, blockScope);
      return;
    }
    if (node.type === "CatchClause") {
      const catchScope = newScope(inherited, "block");
      scopeOf.set(node, catchScope);
      const param = astNode(node.param);
      if (param) {
        for (const name of bindingNames(param)) catchScope.bindings.set(name, { kind: "catch", node: param });
        visit(param, catchScope);
      }
      const body = astNode(node.body);
      if (body) { scopeOf.set(body, catchScope); visit(body, catchScope); }
      return;
    }
    scopeOf.set(node, inherited);
    if (node.type === "VariableDeclaration") {
      const target = node.kind === "var" ? nearestFunction(inherited) : inherited;
      for (const declarator of astNodeArray(node.declarations)) {
        for (const name of bindingNames(astNode(declarator.id))) target.bindings.set(name, { kind: node.kind, node: declarator });
      }
    } else if (node.type === "ClassDeclaration") {
      const id = astNode(node.id);
      if (id?.type === "Identifier") inherited.bindings.set(String(id.name), { kind: "class", node });
    }
    for (const child of astChildren(node)) visit(child, inherited);
  }
  const root = newScope(null, "program");
  scopeOf.set(program, root);
  for (const child of astChildren(program)) visit(child, root);
  return Object.freeze({ scopeOf, scopes });
}

export function lookupScopeBinding(scopeOf, useNode, name) {
  let scope = scopeOf.get(useNode) ?? null;
  while (scope !== null) {
    if (scope.bindings.has(name)) return { scope, binding: scope.bindings.get(name) };
    scope = scope.parent;
  }
  return null;
}

export function resolvesToProcessEnv(facts, node, seen = new Set()) {
  if (!node) return false;
  if (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") {
    const object = astNode(node.object);
    if (object?.type === "Identifier" && String(object.name) === "process" && propertyName(node) === "env") {
      return lookupScopeBinding(facts.scopeOf, object, "process") === null;
    }
    return false;
  }
  if (node.type === "Identifier") {
    const name = String(node.name);
    if (seen.has(name)) return false;
    seen.add(name);
    const found = lookupScopeBinding(facts.scopeOf, node, name);
    if (found) {
      const init = astNode(found.binding.node.init);
      return resolvesToProcessEnv(facts, init, seen);
    }
    return false;
  }
  return false;
}

export function resolveScopedImportedBinding(modules, module, name, useNode, seen = new Set()) {
  if (seen.has(name)) return Object.freeze({ status: "alias-cycle", target: null });
  seen.add(name);
  const direct = module.imports.get(name);
  if (direct) return resolveImportedBinding(modules, module, name);
  const found = lookupScopeBinding(module.scopeOf, useNode, name);
  if (found) {
    const init = astNode(found.binding.node.init);
    if (init?.type === "Identifier") {
      return resolveScopedImportedBinding(modules, module, String(init.name), found.binding.node, seen);
    }
  }
  return Object.freeze({ status: "not-internal-import", target: null });
}
function environmentFacts(facts) {
  const accesses = [];
  for (const node of facts.nodes) {
    if (node.type === "VariableDeclarator") {
      const id = astNode(node.id);
      if (id?.type === "ObjectPattern" && resolvesToProcessEnv(facts, astNode(node.init))) {
        for (const property of astNodeArray(id.properties)) {
          if (property.type === "RestElement") continue;
          const name = literalName(astNode(property.key));
          accesses.push(Object.freeze({ name: name ?? null, form: "destructure", span: portableAstSpan(property, facts.offsetMap) }));
        }
      }
    }
    if (node.type !== "MemberExpression" && node.type !== "OptionalMemberExpression") continue;
    const object = astNode(node.object);
    if (!resolvesToProcessEnv(facts, object)) continue;
    accesses.push(Object.freeze({
      name: propertyName(node),
      form: node.computed ? "computed-member" : "member",
      span: portableAstSpan(node, facts.offsetMap)
    }));
  }
  return Object.freeze(accesses.toSorted((left, right) =>
    left.span.startByte - right.span.startByte || String(left.name).localeCompare(String(right.name))
  ));
}

function analyzeModule(source, parser, availablePaths, violations) {
  const parsed = parser.parseModule(source.bytes, source.path);
  const walked = walkProgram(parsed.program);
  const facts = {
    source,
    offsetMap: parsed.offsetMap,
    scopeOf: buildScopeAnalysis(parsed.program).scopeOf,
    program: parsed.program,
    nodes: walked.nodes,
    parents: walked.parents,
    declarations: topLevelDeclarations(parsed.program),
    uniqueDeclarations: uniqueVariableDeclarations(walked.nodes),
    imports: new Map(),
    exports: new Map(),
    starExports: [],
    edges: [],
    dynamicArguments: new Map()
  };
  for (const node of facts.nodes) {
    if (node.type === "ImportDeclaration") {
      const specifier = literalName(astNode(node.source));
      if (specifier === undefined) fail("qualification_inventory_static_import_unsupported");
      const resolved = resolveModuleSpecifier(source.path, specifier, availablePaths);
      const edge = Object.freeze({
        from: source.path,
        kind: astNodeArray(node.specifiers).length === 0 ? "side-effect-import" : "static-import",
        specifier,
        resolution: resolved.resolution,
        target: resolved.target,
        attributes: importAttributes(node),
        span: portableAstSpan(node, parsed.offsetMap)
      });
      facts.edges.push(edge);
      for (const [local, binding] of importBindingFacts(node, edge)) facts.imports.set(local, binding);
    }
    if (node.type === "ExportAllDeclaration" || node.type === "ExportNamedDeclaration" && node.source) {
      const specifier = literalName(astNode(node.source));
      if (specifier === undefined) fail("qualification_inventory_reexport_unsupported");
      const resolved = resolveModuleSpecifier(source.path, specifier, availablePaths);
      const edge = Object.freeze({
        from: source.path,
        kind: node.type === "ExportAllDeclaration" ? "barrel-export-all" : "named-reexport",
        specifier,
        resolution: resolved.resolution,
        target: resolved.target,
        attributes: importAttributes(node),
        span: portableAstSpan(node, parsed.offsetMap)
      });
      facts.edges.push(edge);
      if (node.type === "ExportAllDeclaration") facts.starExports.push(edge);
      for (const exportSpecifier of astNodeArray(node.specifiers)) {
        const exported = literalName(astNode(exportSpecifier.exported));
        const local = literalName(astNode(exportSpecifier.local));
        if (exported === undefined) fail("qualification_inventory_reexport_binding_unsupported");
        facts.exports.set(exported, {
          kind: exportSpecifier.type === "ExportNamespaceSpecifier" ? "namespace-reexport" : "reexport",
          edge,
          importedName: local ?? "*"
        });
      }
    }
    if (node.type === "ExportNamedDeclaration" && !node.source) {
      for (const name of declarationExportNames(astNode(node.declaration))) {
        facts.exports.set(name, { kind: "local", localName: name });
      }
      for (const specifier of astNodeArray(node.specifiers)) {
        const exported = literalName(astNode(specifier.exported));
        const local = literalName(astNode(specifier.local));
        if (exported === undefined || local === undefined) fail("qualification_inventory_export_binding_unsupported");
        facts.exports.set(exported, { kind: "local", localName: local });
      }
    }
    if (node.type === "ExportDefaultDeclaration") {
      const declaration = astNode(node.declaration);
      const id = astNode(declaration?.id);
      facts.exports.set("default", {
        kind: "local",
        localName: id?.type === "Identifier" ? String(id.name) : "<default>"
      });
    }
  }
  const loaders = loaderAliases(facts);
  for (const node of facts.nodes) {
    let kind;
    let argument;
    if (node.type === "ImportExpression") {
      kind = "dynamic-import";
      argument = astNode(node.source);
    } else if (node.type === "CallExpression" || node.type === "OptionalCallExpression") {
      const callee = astNode(node.callee);
      if (callee?.type === "Import") {
        kind = "dynamic-import";
        argument = astNodeArray(node.arguments)[0];
      } else if (callee?.type === "Identifier" && loaders.has(String(callee.name))) {
        kind = "require";
        argument = astNodeArray(node.arguments)[0];
      } else if ((callee?.type === "MemberExpression" || callee?.type === "OptionalMemberExpression") &&
        astNode(callee.object)?.type === "Identifier" &&
        loaders.has(String(astNode(callee.object).name)) && propertyName(callee) === "resolve") {
        kind = "require-resolve";
        argument = astNodeArray(node.arguments)[0];
      }
    }
    if (kind === undefined) continue;
    const specifier = staticSpecifier(argument, facts);
    const resolved = specifier === null ? { resolution: "unresolved-expression", target: null } :
      resolveModuleSpecifier(source.path, specifier, availablePaths);
    const edge = Object.freeze({
      from: source.path,
      kind,
      specifier,
      resolution: resolved.resolution,
      target: resolved.target,
      attributes: Object.freeze([]),
      span: portableAstSpan(node, parsed.offsetMap)
    });
    facts.edges.push(edge);
    facts.dynamicArguments.set(edge, argument);
  }
  facts.environment = environmentFacts(facts);
  for (const edge of facts.edges) {
    if (["missing", "ambiguous", "invalid", "outside-repository"].includes(edge.resolution)) {
      violations.push(`module_edge_${edge.resolution}:${source.path}:${edge.span.startByte}`);
    }
  }
  return facts;
}

function resolveExport(modules, modulePath, exportName, resolving = new Set()) {
  const key = `${modulePath}\0${exportName}`;
  if (resolving.has(key)) return Object.freeze({ status: "cycle", target: null });
  const module = modules.get(modulePath);
  if (!module) return Object.freeze({ status: "missing-module", target: null });
  const binding = module.exports.get(exportName);
  if (binding?.kind === "local") {
    return Object.freeze({
      status: "resolved",
      target: Object.freeze({ modulePath, exportName, localName: binding.localName })
    });
  }
  if (binding?.kind === "reexport" && binding.edge.target) {
    return resolveExport(modules, binding.edge.target, binding.importedName, new Set([...resolving, key]));
  }
  if (binding?.kind === "namespace-reexport" && binding.edge.target) {
    return Object.freeze({
      status: "resolved-namespace",
      target: Object.freeze({ modulePath: binding.edge.target, exportName: "*", localName: "*" })
    });
  }
  const candidates = module.starExports.filter((edge) => edge.target).map((edge) =>
    resolveExport(modules, edge.target, exportName, new Set([...resolving, key]))
  ).filter((result) => result.target);
  const identities = new Map(candidates.map((result) => [canonicalJson(result.target), result]));
  return identities.size === 1 ? [...identities.values()][0] :
    Object.freeze({ status: identities.size === 0 ? "missing-export" : "ambiguous-export", target: null });
}

function resolveImportedBinding(modules, module, localName) {
  const binding = module.imports.get(localName);
  if (!binding?.edge.target) return Object.freeze({ status: "not-internal-import", target: null });
  if (binding.kind === "namespace") {
    return Object.freeze({
      status: "resolved-namespace",
      target: Object.freeze({ modulePath: binding.edge.target, exportName: "*", localName: "*" })
    });
  }
  return resolveExport(modules, binding.edge.target, binding.importedName);
}

function resolvedCallTarget(modules, module, call) {
  const callee = astNode(call.callee);
  if (callee?.type === "Identifier") {
    return resolveScopedImportedBinding(modules, module, String(callee.name), call);
  }
  if (callee?.type !== "MemberExpression" && callee?.type !== "OptionalMemberExpression") {
    return Object.freeze({ status: "unsupported-callee", target: null });
  }
  const object = astNode(callee.object);
  const member = propertyName(callee);
  if (object?.type !== "Identifier" || member === null) {
    return Object.freeze({ status: "unsupported-callee", target: null });
  }
  const namespace = resolveScopedImportedBinding(modules, module, String(object.name), call);
  if (namespace.status === "resolved-namespace") return resolveExport(modules, namespace.target.modulePath, member);
  if (namespace.status === "resolved") return Object.freeze({ status: "property-call-not-namespace-export", target: null });
  return Object.freeze({ status: "property-call-not-import-namespace", target: null });
}

function staticValue(modules, module, node, resolving = new Set(), depth = 0) {
  if (!node || depth > ROOT_POLICY.verification.testDiscovery.maximumStaticEvaluationDepth) {
    fail("qualification_inventory_static_value_unsupported");
  }
  if (["StringLiteral", "NumericLiteral", "BooleanLiteral"].includes(node.type)) return node.value;
  if (node.type === "NullLiteral") return null;
  if (node.type === "BinaryExpression" && node.operator === "+") {
    const left = staticValue(modules, module, astNode(node.left), resolving, depth + 1);
    const right = staticValue(modules, module, astNode(node.right), resolving, depth + 1);
    if (!["string", "number"].includes(typeof left) || !["string", "number"].includes(typeof right)) {
      fail("qualification_inventory_static_binary_unsupported");
    }
    return left + right;
  }
  if (node.type === "TemplateLiteral" && astNodeArray(node.expressions).length === 0) {
    return astNodeArray(node.quasis).map((quasi) => String(quasi.value?.cooked ?? quasi.value?.raw ?? "")).join("");
  }
  if (node.type === "ArrayExpression") {
    return astNodeArray(node.elements).map((entry) => staticValue(modules, module, entry, resolving, depth + 1));
  }
  if (node.type === "ObjectExpression") {
    const output = {};
    for (const property of astNodeArray(node.properties)) {
      if (property.type !== "ObjectProperty" || property.computed && astNode(property.key)?.type !== "StringLiteral") {
        fail("qualification_inventory_static_object_unsupported");
      }
      const key = literalName(astNode(property.key));
      if (key === undefined || Object.hasOwn(output, key)) fail("qualification_inventory_static_object_invalid");
      output[key] = staticValue(modules, module, astNode(property.value), resolving, depth + 1);
    }
    return output;
  }
  if (node.type === "CallExpression") {
    const callee = astNode(node.callee);
    const args = astNodeArray(node.arguments);
    if (callee?.type === "MemberExpression" && astNode(callee.object)?.type === "Identifier" &&
      astNode(callee.object).name === "Object" && propertyName(callee) === "freeze" && args.length === 1) {
      return staticValue(modules, module, args[0], resolving, depth + 1);
    }
  }
  if (node.type === "Identifier") {
    const name = String(node.name);
    const localKey = `${module.source.path}\0${name}`;
    if (resolving.has(localKey)) fail("qualification_inventory_static_value_cycle");
    const declaration = module.uniqueDeclarations.get(name) ?? module.declarations.get(name);
    if (declaration?.init) {
      return staticValue(modules, module, declaration.init, new Set([...resolving, localKey]), depth + 1);
    }
    const imported = resolveImportedBinding(modules, module, name);
    if (imported.target) {
      const targetModule = modules.get(imported.target.modulePath);
      const targetDeclaration = targetModule?.declarations.get(imported.target.localName);
      if (targetDeclaration?.init) {
        return staticValue(modules, targetModule, targetDeclaration.init, new Set([...resolving, localKey]), depth + 1);
      }
    }
  }
  if (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") {
    const object = astNode(node.object);
    const key = propertyName(node);
    if (key !== null) {
      const value = staticValue(modules, module, object, resolving, depth + 1);
      if (value !== null && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, key)) {
        return value[key];
      }
    }
  }
  fail("qualification_inventory_static_value_unsupported");
}

function dynamicSpecifierTemplate(modules, module, node, resolving = new Set(), depth = 0) {
  if (!node || depth > ROOT_POLICY.verification.testDiscovery.maximumStaticEvaluationDepth) return "*";
  try {
    const value = staticValue(modules, module, node, resolving, depth);
    if (typeof value === "string") return value;
  } catch {
    // The deliberately narrow template evaluator below retains unknown portions as wildcards.
  }
  if (node.type === "TemplateLiteral") {
    const quasis = astNodeArray(node.quasis);
    const expressions = astNodeArray(node.expressions);
    let output = "";
    for (let index = 0; index < quasis.length; index += 1) {
      output += String(quasis[index].value?.cooked ?? quasis[index].value?.raw ?? "");
      if (index < expressions.length) {
        output += dynamicSpecifierTemplate(modules, module, expressions[index], resolving, depth + 1);
      }
    }
    return output;
  }
  if (node.type === "BinaryExpression" && node.operator === "+") {
    return dynamicSpecifierTemplate(modules, module, astNode(node.left), resolving, depth + 1) +
      dynamicSpecifierTemplate(modules, module, astNode(node.right), resolving, depth + 1);
  }
  if (node.type === "Identifier") {
    const name = String(node.name);
    const key = `${module.source.path}\0${name}`;
    if (resolving.has(key)) return "*";
    const nextResolving = new Set([...resolving, key]);
    const declaration = module.uniqueDeclarations.get(name) ?? module.declarations.get(name);
    if (declaration?.init) {
      return dynamicSpecifierTemplate(modules, module, declaration.init, nextResolving, depth + 1);
    }
    const imported = resolveImportedBinding(modules, module, name).target;
    const targetModule = imported && modules.get(imported.modulePath);
    const targetDeclaration = targetModule?.declarations.get(imported?.localName);
    return targetDeclaration?.init ?
      dynamicSpecifierTemplate(modules, targetModule, targetDeclaration.init, nextResolving, depth + 1) : "*";
  }
  if (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") {
    if (propertyName(node) === "href") {
      return dynamicSpecifierTemplate(modules, module, astNode(node.object), resolving, depth + 1);
    }
    return "*";
  }
  if (node.type === "CallExpression" || node.type === "OptionalCallExpression") {
    const callee = astNode(node.callee);
    const args = astNodeArray(node.arguments);
    if (callee?.type === "Identifier" && ["pathToFileURL", "fileURLToPath"].includes(String(callee.name)) &&
      args.length >= 1) {
      return dynamicSpecifierTemplate(modules, module, args[0], resolving, depth + 1);
    }
    if (callee?.type === "Identifier" && ["join", "resolve"].includes(String(callee.name)) &&
      args.length >= 1) {
      return args.map((argument) => dynamicSpecifierTemplate(
        modules, module, argument, resolving, depth + 1
      )).join("/");
    }
    if ((callee?.type === "MemberExpression" || callee?.type === "OptionalMemberExpression") &&
      ["join", "resolve"].includes(propertyName(callee)) && args.length >= 1) {
      return args.map((argument) => dynamicSpecifierTemplate(
        modules, module, argument, resolving, depth + 1
      )).join("/");
    }
    return "*";
  }
  return "*";
}

function resolveDynamicTemplate(template, availablePaths) {
  const withoutScheme = template.replace(/^file:\/\//u, "");
  const clean = withoutScheme.split(/[?#]/u, 1)[0].replaceAll("\\", "/");
  const wildcardIndex = clean.lastIndexOf("*");
  const suffix = clean.slice(wildcardIndex + 1).replace(/^\/+/, "");
  const candidateDomain = byteSort([...availablePaths]);
  const matches = candidateDomain.filter((path) =>
    clean === path || clean.endsWith(`/${path}`) || suffix.length > 0 && path.endsWith(suffix)
  );
  const normalizedSuffix = matches.length === 1 ? matches[0] :
    suffix.length > 0 && !suffix.startsWith("/") && !suffix.includes("\\") ? suffix : "<unresolved>";
  const evidence = Object.freeze({
    method: "unique-portable-suffix-over-complete-module-domain",
    normalizedPattern: `*${normalizedSuffix}`,
    candidateDomainCount: candidateDomain.length,
    candidateDomainIdentity: canonicalHash(candidateDomain),
    matchCount: matches.length
  });
  return matches.length === 1 ? Object.freeze({
    resolution: "internal-pattern",
    target: matches[0],
    evidence
  }) : Object.freeze({
    resolution: matches.length === 0 ? "unresolved-expression" : "ambiguous",
    target: null,
    evidence
  });
}

export function resolveQualificationPortableDynamicPattern(normalizedPattern, candidatePaths) {
  if (typeof normalizedPattern !== "string" || !normalizedPattern.startsWith("*") ||
    !Array.isArray(candidatePaths) || new Set(candidatePaths).size !== candidatePaths.length ||
    candidatePaths.some((path) => {
      try {
        qualifyQualificationSourceCarrier(path);
        return false;
      } catch {
        return true;
      }
    })) {
    fail("qualification_inventory_dynamic_pattern_input_invalid");
  }
  return resolveDynamicTemplate(normalizedPattern, new Set(candidatePaths));
}

function resolveDeferredDynamicEdges(modules, availablePaths, violations) {
  for (const module of modules.values()) {
    for (let index = 0; index < module.edges.length; index += 1) {
      const edge = module.edges[index];
      if (edge.resolution !== "unresolved-expression") continue;
      const template = dynamicSpecifierTemplate(modules, module, module.dynamicArguments.get(edge));
      const resolved = resolveDynamicTemplate(template, availablePaths);
      const replacement = Object.freeze({
        ...edge,
        resolution: resolved.resolution,
        target: resolved.target,
        resolutionEvidence: resolved.evidence
      });
      module.edges[index] = replacement;
      if (resolved.target === null) {
        violations.push(`module_edge_${resolved.resolution}:${module.source.path}:${edge.span.startByte}`);
      }
    }
  }
}

function jsonPointer(root, pointer) {
  let value = root;
  for (const token of pointer.slice(1).split("/").map((entry) => entry.replaceAll("~1", "/").replaceAll("~0", "~"))) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, token)) {
      fail("qualification_inventory_schema_pointer_missing");
    }
    value = value[token];
  }
  return value;
}

function schemaCohorts(schema, trustBasePointer) {
  const cohorts = [];
  const visited = new Set();
  function walk(value, schemaPointer, instancePointer) {
    if (value?.$ref !== undefined) {
      if (typeof value.$ref !== "string" || !value.$ref.startsWith("#/")) {
        fail("qualification_inventory_schema_ref_unsupported");
      }
      const targetPointer = value.$ref.slice(1);
      const key = `${targetPointer}\0${instancePointer}`;
      if (visited.has(key)) return;
      visited.add(key);
      walk(jsonPointer(schema, targetPointer), targetPointer, instancePointer);
      return;
    }
    if (value?.type === "object") {
      if (value.additionalProperties !== false || !Array.isArray(value.required) ||
        new Set(value.required).size !== value.required.length ||
        value.required.some((field) => typeof field !== "string" || value.properties?.[field] === undefined)) {
        fail("qualification_inventory_schema_cohort_open_or_incomplete");
      }
      cohorts.push(Object.freeze({
        schemaPointer,
        instancePointerPattern: instancePointer,
        requiredFields: Object.freeze([...value.required])
      }));
      for (const [field, child] of Object.entries(value.properties ?? {})) {
        walk(child, `${schemaPointer}/properties/${field}`, `${instancePointer}/${field}`);
      }
    } else if (value?.type === "array" && value.items !== undefined) {
      walk(value.items, `${schemaPointer}/items`, `${instancePointer}/*`);
    }
  }
  walk(jsonPointer(schema, trustBasePointer), trustBasePointer, "");
  return Object.freeze(cohorts);
}

function compileLeaseInventory(root, modules, violations) {
  const declarations = new Map();
  const uses = [];
  for (const module of modules.values()) {
    for (const node of module.nodes) {
      if (node.type !== "CallExpression" && node.type !== "OptionalCallExpression") continue;
      const callTarget = resolvedCallTarget(modules, module, node);
      const target = callTarget.target;
      if (callTarget.status === "ambiguous-export" || callTarget.status === "alias-cycle") {
        violations.push("lease_call_unresolved:" + module.source.path + ":" + portableAstSpan(node, module.offsetMap).startByte);
      }
      if (!target) continue;
      if (target.modulePath === CONTRACT_PATH && target.exportName === "defineQualificationTrustBaseLease") {
        const parent = module.parents.get(node);
        if (parent?.type !== "VariableDeclarator" || astNode(parent.id)?.type !== "Identifier") {
          continue;
        }
        const localName = String(astNode(parent.id).name);
        if (module.declarations.get(localName)?.declarator !== parent) continue;
        const args = astNodeArray(node.arguments);
        if (args.length !== 1) {
          violations.push(`lease_declaration_argument_invalid:${module.source.path}:${node.start}`);
          continue;
        }
        try {
          const lease = defineQualificationTrustBaseLease(staticValue(modules, module, args[0]));
          const key = `${module.source.path}\0${localName}`;
          declarations.set(key, Object.freeze({ modulePath: module.source.path, localName, lease }));
        } catch (error) {
          violations.push(`lease_declaration_invalid:${module.source.path}:${node.start}:${error.code ?? "unknown"}`);
        }
      }
      if (target.modulePath === AUTHORITY_PATH && target.exportName === "deriveQualificationTrustBase") {
        const args = astNodeArray(node.arguments);
        const argument = args[0];
        let declarationKey;
        if (args.length === 1 && argument?.type === "Identifier") {
          const localName = String(argument.name);
          if (module.declarations.has(localName)) declarationKey = `${module.source.path}\0${localName}`;
          else {
            const imported = resolveImportedBinding(modules, module, localName).target;
            if (imported) declarationKey = `${imported.modulePath}\0${imported.localName}`;
          }
        }
        uses.push(Object.freeze({
          modulePath: module.source.path,
          span: portableAstSpan(node, module.offsetMap),
          declarationKey: declarationKey ?? null
        }));
      }
    }
  }
  const output = [];
  for (const [key, declaration] of declarations) {
    const matchingUses = uses.filter((use) => use.declarationKey === key);
    if (matchingUses.length !== declaration.lease.requiredUseCardinality) {
      violations.push(`lease_use_cardinality:${declaration.lease.leaseId}:${matchingUses.length}`);
    }
    const schemaBytes = readSafeRepositoryFile(
      root,
      declaration.lease.receiptSchemaRelativePath,
      MAXIMUM_FILE_BYTES
    ).bytes;
    const schema = strictJson(schemaBytes, declaration.lease.receiptSchemaRelativePath);
    let cohorts;
    try {
      cohorts = schemaCohorts(schema, declaration.lease.receiptTrustBaseJsonPointer);
    } catch (error) {
      violations.push(`lease_schema_invalid:${declaration.lease.leaseId}:${error.code ?? "unknown"}`);
      cohorts = Object.freeze([]);
    }
    const rootCohort = cohorts.find((cohort) => cohort.instancePointerPattern === "");
    const configuredFields = Object.values(declaration.lease.fieldInfluence).flat();
    const requiredFields = rootCohort?.requiredFields ?? [];
    for (const missing of requiredFields.filter((field) => !configuredFields.includes(field))) {
      violations.push(`lease_field_influence_missing:${declaration.lease.leaseId}:${missing}`);
    }
    for (const extra of configuredFields.filter((field) => !requiredFields.includes(field))) {
      violations.push(`lease_field_influence_extra:${declaration.lease.leaseId}:${extra}`);
    }
    const leaseConsumerPaths = reachableReverseConsumers(
      modules,
      new Set(matchingUses.map((use) => use.modulePath))
    );
    const environmentAccesses = Object.freeze(byteSort([...leaseConsumerPaths]).flatMap((modulePath) =>
      modules.get(modulePath).environment.map((access) => Object.freeze({ modulePath, ...access }))
    ).toSorted((left, right) =>
      byteCompare(left.modulePath, right.modulePath) || left.span.startByte - right.span.startByte
    ));
    for (const access of environmentAccesses.filter((entry) => entry.name === null)) {
      violations.push(`lease_environment_dynamic_access:${declaration.lease.leaseId}:${access.modulePath}:${access.span.startByte}`);
    }
    const compiledEnvironmentNames = Object.freeze(byteSort([...new Set(
      environmentAccesses.flatMap((entry) => entry.name === null ? [] : [entry.name])
    )]));
    const configuredEnvironmentNames = byteSort([...declaration.lease.environmentPolicy.names]);
    if (canonicalJson(compiledEnvironmentNames) !== canonicalJson(configuredEnvironmentNames)) {
      violations.push(`lease_environment_binding_mismatch:${declaration.lease.leaseId}`);
    }
    output.push(Object.freeze({
      leaseId: declaration.lease.leaseId,
      leaseIdentity: declaration.lease.leaseIdentity,
      declaration: Object.freeze({ modulePath: declaration.modulePath, localName: declaration.localName }),
      requiredUseCardinality: declaration.lease.requiredUseCardinality,
      uses: Object.freeze(matchingUses.map(({ declarationKey: _key, ...use }) => use)),
      rootPackages: declaration.lease.rootPackages,
      receiptSchema: Object.freeze({
        relativePath: declaration.lease.receiptSchemaRelativePath,
        sha256: sha256(schemaBytes),
        trustBaseJsonPointer: declaration.lease.receiptTrustBaseJsonPointer
      }),
      protocolCohorts: cohorts,
      fieldInfluence: declaration.lease.fieldInfluence,
      environmentBindings: Object.freeze({
        mode: declaration.lease.environmentPolicy.mode,
        names: compiledEnvironmentNames,
        accesses: environmentAccesses
      })
    }));
  }
  for (const use of uses.filter((entry) => entry.declarationKey === null || !declarations.has(entry.declarationKey))) {
    violations.push(`derive_without_lease:${use.modulePath}:${use.span.startByte}`);
  }
  return Object.freeze(output.toSorted((left, right) => byteCompare(left.leaseId, right.leaseId)));
}

function reachableReverseConsumers(modules, targetPaths) {
  const reverse = new Map();
  for (const module of modules.values()) {
    for (const edge of module.edges.filter((entry) => entry.target !== null)) {
      const incoming = reverse.get(edge.target) ?? [];
      incoming.push(Object.freeze({ from: module.source.path, edge }));
      reverse.set(edge.target, incoming);
    }
  }
  const reached = new Set(targetPaths);
  const pending = [...targetPaths];
  while (pending.length > 0) {
    const target = pending.shift();
    for (const incoming of reverse.get(target) ?? []) {
      if (!reached.has(incoming.from)) {
        reached.add(incoming.from);
        pending.push(incoming.from);
      }
    }
  }
  return reached;
}

function consumerInventory(modules, entrypoints) {
  const reached = reachableReverseConsumers(
    modules,
    new Set([AUTHORITY_PATH, CONTRACT_PATH].filter((path) => modules.has(path)))
  );
  const modulesOutput = byteSort([...reached]).map((path) => {
    const module = modules.get(path);
    return Object.freeze({
      path,
      originClass: module.source.originClass,
      entrypoint: entrypoints.has(path),
      directAuthorityEdge: module.edges.some((edge) => edge.target === AUTHORITY_PATH),
      directContractEdge: module.edges.some((edge) => edge.target === CONTRACT_PATH),
      environmentAccesses: module.environment
    });
  });
  const edges = [...reached].flatMap((path) => modules.get(path).edges.filter((edge) =>
    edge.target !== null && reached.has(edge.target)
  )).toSorted((left, right) =>
    byteCompare(left.from, right.from) || left.span.startByte - right.span.startByte
  );
  return Object.freeze({ modules: Object.freeze(modulesOutput), edges: Object.freeze(edges) });
}

function entrypointPaths() {
  const paths = Object.values(ARCHITECTURE_MANIFEST.compositionRoots).flat();
  if (new Set(paths).size !== paths.length) fail("qualification_inventory_entrypoint_duplicate");
  return new Set(paths);
}

let inventorySchemaValidator = null;

function inventorySchemaErrors(value) {
  if (inventorySchemaValidator === null) {
    const schemaBytes = readSafeRepositoryFile(ROOT, INVENTORY_SCHEMA_PATH, MAXIMUM_FILE_BYTES).bytes;
    const schema = strictJson(schemaBytes, INVENTORY_SCHEMA_PATH);
    inventorySchemaValidator = new Ajv2020({ allErrors: true, strict: true, $data: true }).compile(schema);
  }
  if (inventorySchemaValidator(value)) return [];
  return (inventorySchemaValidator.errors ?? []).map((err) =>
    "inventory_schema_invalid:" + (err.instancePath || "/") + ":" + err.schemaPath + ":" + err.keyword);
}

export function validateQualificationAuthorityInventorySchema(value) {
  return inventorySchemaErrors(value);
}

export function compileQualificationAuthorityInventory(repositoryRoot = ROOT) {
  const root = resolve(repositoryRoot);
  const parser = createQualificationParserBoundary(root);
  const paths = enumerateRepositorySources(root);
  const sources = paths.map((path) => readSource(root, path));
  const executableSources = sources.filter((source) =>
    source.moduleDisposition === "executable-first-party-module"
  );
  if (executableSources.some((source) => !["first-party-production", "first-party-nonproduction"]
    .includes(source.originClass))) {
    fail("qualification_inventory_executable_origin_invalid");
  }
  const availablePaths = new Set(executableSources.map((source) => source.path));
  const violations = [];
  const modules = new Map(executableSources.map((source) => [
    source.path,
    analyzeModule(source, parser, availablePaths, violations)
  ]));
  resolveDeferredDynamicEdges(modules, availablePaths, violations);
  const sourceRecords = Object.freeze(sources.map(({ bytes: _bytes, ...record }) => Object.freeze(record)));
  const moduleRecords = Object.freeze(executableSources.map(({ bytes: _bytes, moduleDisposition: _disposition,
    dispositionReason: _reason, ...record }) => Object.freeze(record)));
  const moduleEdges = Object.freeze([...modules.values()].flatMap((module) => module.edges)
    .toSorted((left, right) => byteCompare(left.from, right.from) || left.span.startByte - right.span.startByte));
  const consumers = consumerInventory(modules, entrypointPaths());
  const leases = compileLeaseInventory(root, modules, violations);
  const unresolvedDynamicEdges = Object.freeze(moduleEdges.filter((edge) =>
    ["dynamic-import", "require", "require-resolve"].includes(edge.kind) &&
    edge.resolution === "unresolved-expression"
  ));
  const productionSources = sourceRecords.filter((source) => source.originClass === "first-party-production");
  const nonproductionSources = sourceRecords.filter((source) => source.originClass === "first-party-nonproduction");
  const nonExecutableCarriers = sourceRecords.filter((source) =>
    source.moduleDisposition === "non-executable-carrier"
  );
  const withoutIdentity = Object.freeze({
    schemaVersion: QUALIFICATION_AUTHORITY_INVENTORY_SCHEMA_VERSION,
    status: violations.length === 0 ? "compiled-current" : "blocked",
    authorityOwner: QUALIFICATION_AUTHORITY_OWNER,
    generator: Object.freeze({ relativePath: MODULE_PATH }),
    parserBoundary: parser.binding,
    sourceSurface: Object.freeze({
      sourceCount: sourceRecords.length,
      productionSourceCount: productionSources.length,
      nonproductionSourceCount: nonproductionSources.length,
      executableSourceCount: moduleRecords.length,
      nonExecutableCarrierCount: nonExecutableCarriers.length,
      sourcesIdentity: canonicalHash(sourceRecords),
      sources: sourceRecords
    }),
    moduleGraph: Object.freeze({
      moduleCount: moduleRecords.length,
      modulesIdentity: canonicalHash(moduleRecords),
      modules: moduleRecords,
      edgeCount: moduleEdges.length,
      edgesIdentity: canonicalHash(moduleEdges),
      edges: moduleEdges,
      unresolvedDynamicEdges
    }),
    consumerInventory: consumers,
    leaseInventory: leases,
    violations: Object.freeze(byteSort(violations))
  });
  const inventory = Object.freeze({ ...withoutIdentity, inventoryIdentity: canonicalHash(withoutIdentity) });
  const schemaErrors = inventorySchemaErrors(inventory);
  if (schemaErrors.length > 0) fail("qualification_inventory_schema_invalid");
  return inventory;
}

export function verifyQualificationAuthorityInventory(value, repositoryRoot = ROOT) {
  const expected = compileQualificationAuthorityInventory(repositoryRoot);
  if (canonicalJson(value) !== canonicalJson(expected)) fail("qualification_inventory_projection_drift");
  if (expected.status !== "compiled-current" || expected.violations.length !== 0) {
    fail("qualification_inventory_projection_blocked");
  }
  return expected;
}

function execute(argv) {
  const inventory = compileQualificationAuthorityInventory(ROOT);
  const bytes = Buffer.from(`${canonicalJson(inventory)}\n`, "utf8");
  if (argv.length === 0 || argv.length === 1 && argv[0] === "--effect-mode=derive") {
    return bytes;
  }
  if (argv.length === 1 && argv[0] === "--effect-mode=check") {
    const current = readSafeRepositoryFile(ROOT, GENERATED_PATH, ROOT_POLICY.verification.testDiscovery.maximumInventoryBytes);
    if (!current.bytes.equals(bytes)) fail("qualification_inventory_projection_drift");
    verifyQualificationAuthorityInventory(strictJson(current.bytes, GENERATED_PATH), ROOT);
    return Buffer.from(`${canonicalJson({
      status: "current-read-only",
      relativePath: GENERATED_PATH,
      byteLength: bytes.length,
      sha256: sha256(bytes),
      inventoryIdentity: inventory.inventoryIdentity
    })}\n`, "utf8");
  }
  if (argv.length === 1 && argv[0] === "--effect-mode=write") {
    fail("production_migration_write_authority_unavailable");
  }
  fail("qualification_inventory_arguments_invalid");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    process.stdout.write(execute(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${canonicalJson({
      status: "blocked",
      code: error instanceof Error && typeof error.code === "string" ? error.code :
        error instanceof Error ? error.message : "qualification_inventory_internal_error"
    })}\n`);
    process.exitCode = 1;
  }
}
