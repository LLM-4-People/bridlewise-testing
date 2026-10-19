import { posix } from "node:path";

import { parse } from "@babel/parser";

import type { AuthoritySource } from "./contracts.ts";
import { isRecord } from "./shared.ts";

export type AstNode = Readonly<{ type: string; [key: string]: unknown }>;
export type ImportBinding = Readonly<{
  sourcePath: string;
  exportName: string;
  kind: "named" | "default" | "namespace";
  declaration: AstNode;
}>;
export type ModuleFacts = Readonly<{
  source: AuthoritySource;
  program: AstNode;
  nodes: readonly AstNode[];
  parents: ReadonlyMap<AstNode, AstNode>;
  constants: ReadonlyMap<string, AstNode>;
  exports: ReadonlyMap<string, string>;
  imports: ReadonlyMap<string, ImportBinding>;
  reExports: ReadonlyMap<string, ImportBinding>;
}>;

export function parseTypeScriptModules(
  sources: readonly AuthoritySource[],
  violations: string[],
): ReadonlyMap<string, ModuleFacts> {
  const modules = new Map<string, ModuleFacts>();
  const parsedPrograms = new Map<string, AstNode>();
  for (const source of sources) {
    if (source.language !== "typescript") continue;
    try {
      const parsed = parse(source.source, {
        sourceType: "module",
        plugins: ["typescript", "jsx"],
        errorRecovery: false,
        attachComment: false,
        ranges: false,
        tokens: false,
      }) as unknown as { program?: unknown };
      const program = astNode(parsed.program);
      if (!program || program.type !== "Program") throw new Error("not a program");
      parsedPrograms.set(source.path, program);
    } catch {
      violations.push(`authority_source_parse_failed:${source.path}`);
    }
  }
  const availablePaths = new Set(parsedPrograms.keys());
  for (const source of sources) {
    const program = parsedPrograms.get(source.path);
    if (program) modules.set(source.path, moduleFacts(source, program, availablePaths, violations));
  }
  for (const module of modules.values()) {
    const imports = module.imports as Map<string, ImportBinding>;
    for (const [localName, binding] of imports) {
      imports.set(localName, resolveForwardedBinding(binding, modules, new Set()));
    }
  }
  return modules;
}

export function astNode(value: unknown): AstNode | undefined {
  return isRecord(value) && typeof value.type === "string" ? value as AstNode : undefined;
}

export function astNodeArray(value: unknown): readonly AstNode[] {
  return Array.isArray(value) ? value.map(astNode).filter((entry): entry is AstNode => entry !== undefined) : [];
}

export function astChildren(node: AstNode): AstNode[] {
  const children: AstNode[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (["loc", "start", "end", "extra", "errors", "comments", "tokens"].includes(key)) continue;
    const direct = astNode(value);
    if (direct) children.push(direct);
    else if (Array.isArray(value)) {
      for (const entry of value) {
        const child = astNode(entry);
        if (child) children.push(child);
      }
    }
  }
  return children;
}

export function identifierResolvesToImport(
  identifierNode: AstNode,
  module: ModuleFacts,
  binding: ImportBinding,
): boolean {
  if (!isIdentifierReference(identifierNode, module)) return false;
  const name = String(identifierNode.name);
  let scope = nearestLexicalScope(identifierNode, module.parents);
  while (scope && scope.type !== "Program") {
    if (scopeDeclaresName(scope, name, module)) return false;
    scope = nearestLexicalScope(scope, module.parents);
  }
  return module.imports.get(name) === binding;
}

export function isIdentifierReference(node: AstNode, module: ModuleFacts): boolean {
  const parent = module.parents.get(node);
  if (!parent) return false;
  if (["ImportSpecifier", "ImportDefaultSpecifier", "ImportNamespaceSpecifier"].includes(parent.type)) return false;
  if (isInsideBindingPattern(node, module)) return false;
  if ((parent.type === "FunctionDeclaration" || parent.type === "FunctionExpression" ||
    parent.type === "ClassDeclaration" || parent.type === "ClassExpression" ||
    parent.type === "TSTypeAliasDeclaration" || parent.type === "TSInterfaceDeclaration") && parent.id === node) {
    return false;
  }
  if ((parent.type === "ObjectProperty" && parent.shorthand !== true || parent.type === "ObjectMethod") &&
    parent.key === node && !parent.computed) return false;
  if ((parent.type === "MemberExpression" || parent.type === "OptionalMemberExpression") &&
    parent.property === node && !parent.computed) return false;
  return true;
}

function nearestLexicalScope(node: AstNode, parents: ReadonlyMap<AstNode, AstNode>): AstNode | undefined {
  let current = parents.get(node);
  while (current) {
    if (LEXICAL_SCOPE_TYPES.has(current.type)) return current;
    current = parents.get(current);
  }
  return undefined;
}

function scopeDeclaresName(scope: AstNode, name: string, module: ModuleFacts): boolean {
  if (FUNCTION_SCOPE_TYPES.has(scope.type)) {
    if (astNodeArray(scope.params).some((parameter) => patternBindsName(parameter, name))) return true;
    const id = astNode(scope.id);
    if (id?.type === "Identifier" && id.name === name) return true;
  }
  if (scope.type === "ClassDeclaration" || scope.type === "ClassExpression") {
    const id = astNode(scope.id);
    if (id?.type === "Identifier" && id.name === name) return true;
  }
  if (scope.type === "CatchClause") {
    const parameter = astNode(scope.param);
    if (parameter && patternBindsName(parameter, name)) return true;
  }
  return module.nodes.some((candidate) => {
    if (candidate.type !== "VariableDeclarator" && candidate.type !== "FunctionDeclaration" &&
      candidate.type !== "ClassDeclaration") return false;
    const id = astNode(candidate.id);
    return id !== undefined && patternBindsName(id, name) && bindingScope(candidate, module.parents) === scope;
  });
}

const FUNCTION_SCOPE_TYPES = new Set([
  "FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression",
  "ClassMethod", "ClassPrivateMethod", "ObjectMethod", "TSDeclareMethod",
]);
const LEXICAL_SCOPE_TYPES = new Set([
  "Program", "BlockStatement", "CatchClause", "ClassDeclaration", "ClassExpression",
  "ForStatement", "ForInStatement", "ForOfStatement", "StaticBlock", "SwitchStatement",
  ...FUNCTION_SCOPE_TYPES,
]);

function bindingScope(declaration: AstNode, parents: ReadonlyMap<AstNode, AstNode>): AstNode | undefined {
  const variableDeclaration = declaration.type === "VariableDeclarator" ? parents.get(declaration) : undefined;
  if (variableDeclaration?.type === "VariableDeclaration" && variableDeclaration.kind === "var") {
    let current = parents.get(variableDeclaration);
    while (current) {
      if (current.type === "Program" || FUNCTION_SCOPE_TYPES.has(current.type)) return current;
      current = parents.get(current);
    }
    return undefined;
  }
  return nearestLexicalScope(declaration, parents);
}

function isInsideBindingPattern(node: AstNode, module: ModuleFacts): boolean {
  let current: AstNode = node;
  let parent = module.parents.get(current);
  while (parent) {
    if (parent.type === "VariableDeclarator" && parent.id === current) return true;
    if (FUNCTION_SCOPE_TYPES.has(parent.type) && astNodeArray(parent.params).includes(current)) return true;
    if (parent.type === "CatchClause" && parent.param === current) return true;
    if (!["ObjectPattern", "ArrayPattern", "ObjectProperty", "AssignmentPattern", "RestElement", "TSParameterProperty"]
      .includes(parent.type)) return false;
    current = parent;
    parent = module.parents.get(current);
  }
  return false;
}

function patternBindsName(pattern: AstNode, name: string): boolean {
  if (pattern.type === "Identifier") return pattern.name === name;
  if (pattern.type === "ObjectPattern") {
    return astNodeArray(pattern.properties).some((property) => {
      if (property.type === "RestElement") {
        const argument = astNode(property.argument);
        return argument !== undefined && patternBindsName(argument, name);
      }
      const value = astNode(property.value);
      return value !== undefined && patternBindsName(value, name);
    });
  }
  if (pattern.type === "ArrayPattern") {
    return astNodeArray(pattern.elements).some((element) => patternBindsName(element, name));
  }
  if (pattern.type === "AssignmentPattern") {
    const left = astNode(pattern.left);
    return left !== undefined && patternBindsName(left, name);
  }
  if (pattern.type === "RestElement" || pattern.type === "TSParameterProperty") {
    const argument = astNode(pattern.argument ?? pattern.parameter);
    return argument !== undefined && patternBindsName(argument, name);
  }
  return false;
}

function moduleFacts(
  source: AuthoritySource,
  program: AstNode,
  availablePaths: ReadonlySet<string>,
  violations: string[],
): ModuleFacts {
  const nodes: AstNode[] = [];
  const parents = new Map<AstNode, AstNode>();
  const pending: Array<{ node: AstNode; parent?: AstNode }> = [{ node: program }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes.push(current.node);
    if (current.parent) parents.set(current.node, current.parent);
    for (const child of astChildren(current.node)) pending.push({ node: child, parent: current.node });
  }
  const constants = new Map<string, AstNode>();
  const exports = new Map<string, string>();
  const imports = new Map<string, ImportBinding>();
  const reExports = new Map<string, ImportBinding>();
  for (const node of nodes) {
    if (node.type === "VariableDeclaration" && node.kind === "const" && isTopLevelDeclaration(node, parents)) {
      for (const declaration of astNodeArray(node.declarations)) {
        const id = astNode(declaration.id);
        const init = astNode(declaration.init);
        if (id?.type === "Identifier" && init) constants.set(String(id.name), init);
      }
    }
    if (node.type === "ImportDeclaration") {
      const importSource = astNode(node.source);
      if (importSource?.type !== "StringLiteral") continue;
      const sourcePath = resolveImport(source.path, String(importSource.value), availablePaths, violations);
      if (!String(importSource.value).startsWith(".") && String(importSource.value) !== "zod") {
        violations.push(`authority_import_resolution_unsupported:${source.path}:${String(importSource.value)}`);
      }
      for (const specifier of astNodeArray(node.specifiers)) {
        const local = astNode(specifier.local);
        const imported = astNode(specifier.imported);
        if (local?.type !== "Identifier") continue;
        if (specifier.type === "ImportSpecifier" && (imported?.type === "Identifier" || imported?.type === "StringLiteral")) {
          imports.set(String(local.name), {
            sourcePath,
            exportName: String(imported.name ?? imported.value),
            kind: "named",
            declaration: node,
          });
        } else if (specifier.type === "ImportDefaultSpecifier") {
          imports.set(String(local.name), { sourcePath, exportName: "default", kind: "default", declaration: node });
        } else if (specifier.type === "ImportNamespaceSpecifier") {
          imports.set(String(local.name), { sourcePath, exportName: "*", kind: "namespace", declaration: node });
        }
      }
    }
  }
  for (const statement of astNodeArray(program.body)) {
    if (statement.type !== "ExportNamedDeclaration") continue;
    const exportSource = astNode(statement.source);
    const forwardedPath = exportSource?.type === "StringLiteral"
      ? resolveImport(source.path, String(exportSource.value), availablePaths, violations)
      : undefined;
    const declaration = astNode(statement.declaration);
    if (declaration?.type === "VariableDeclaration") {
      for (const declarator of astNodeArray(declaration.declarations)) {
        const id = astNode(declarator.id);
        if (id?.type === "Identifier") exports.set(String(id.name), String(id.name));
      }
    } else if (["TSTypeAliasDeclaration", "TSInterfaceDeclaration", "FunctionDeclaration", "ClassDeclaration"]
      .includes(declaration?.type ?? "")) {
      const id = astNode(declaration?.id);
      if (id?.type === "Identifier") exports.set(String(id.name), String(id.name));
    }
    for (const specifier of astNodeArray(statement.specifiers)) {
      const local = astNode(specifier.local);
      const exported = astNode(specifier.exported);
      if (local?.type === "Identifier" && (exported?.type === "Identifier" || exported?.type === "StringLiteral")) {
        const exportedName = String(exported.name ?? exported.value);
        if (forwardedPath) {
          reExports.set(exportedName, {
            sourcePath: forwardedPath,
            exportName: String(local.name),
            kind: "named",
            declaration: statement,
          });
        } else {
          exports.set(exportedName, String(local.name));
        }
      }
    }
  }
  return { source, program, nodes, parents, constants, exports, imports, reExports };
}

function resolveForwardedBinding(
  binding: ImportBinding,
  modules: ReadonlyMap<string, ModuleFacts>,
  resolving: Set<string>,
): ImportBinding {
  if (binding.kind !== "named") return binding;
  const key = JSON.stringify([binding.sourcePath, binding.exportName]);
  if (resolving.has(key)) return binding;
  const forwarded = modules.get(binding.sourcePath)?.reExports.get(binding.exportName);
  if (!forwarded) return binding;
  resolving.add(key);
  const resolved = resolveForwardedBinding(forwarded, modules, resolving);
  resolving.delete(key);
  return resolved;
}

function isTopLevelDeclaration(node: AstNode, parents: ReadonlyMap<AstNode, AstNode>): boolean {
  let current = parents.get(node);
  if (current?.type === "ExportNamedDeclaration") current = parents.get(current);
  return current?.type === "Program";
}

function resolveImport(
  fromPath: string,
  specifier: string,
  availablePaths: ReadonlySet<string>,
  violations: string[],
): string {
  if (!specifier.startsWith(".")) return specifier;
  const base = posix.normalize(posix.join(posix.dirname(fromPath), specifier));
  const extension = posix.extname(base);
  const candidates = extension === ".js"
    ? [base, `${base.slice(0, -3)}.ts`, `${base.slice(0, -3)}.tsx`]
    : extension === ".mjs"
      ? [base, `${base.slice(0, -4)}.mts`]
    : extension.length > 0
      ? [base]
      : [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];
  const matches = candidates.filter((candidate) => availablePaths.has(candidate));
  if (matches.length > 1) {
    violations.push(`authority_import_ambiguous:${fromPath}:${specifier}`);
    return `ambiguous:${base}`;
  }
  if (matches.length === 0) {
    violations.push(`authority_import_unresolved:${fromPath}:${specifier}`);
    return base;
  }
  return matches[0]!;
}
