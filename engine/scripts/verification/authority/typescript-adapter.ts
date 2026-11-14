import { posix } from "node:path";

import { parse } from "@babel/parser";

import type { AuthoritySource } from "./contracts.ts";
import { astNode, astNodeArray, moduleScopeFacts, type AstNode, type ModuleScopeFacts } from "../../../src/quality-packs/prevention/ast-helpers.ts";

export type ImportBinding = Readonly<{
  sourcePath: string;
  exportName: string;
  kind: "named" | "default" | "namespace";
  declaration: AstNode;
}>;
export type ModuleFacts = ModuleScopeFacts & Readonly<{
  source: AuthoritySource;
  program: AstNode;
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

function moduleFacts(
  source: AuthoritySource,
  program: AstNode,
  availablePaths: ReadonlySet<string>,
  violations: string[],
): ModuleFacts {
  const { nodes, parents } = moduleScopeFacts(program);
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
