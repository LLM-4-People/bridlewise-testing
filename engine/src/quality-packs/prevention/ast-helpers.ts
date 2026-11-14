import { parse, type ParserOptions } from "@babel/parser";

import { ARCHITECTURE_SOURCE_EXTENSIONS } from "../../shared/source-extensions.ts";
import { InputError } from "../../kernel/errors.ts";
export { shingles, jaccard } from "../../shared/similarity.ts";

/**
 * Shared AST walker helpers — THE ONE owner of the Babel child traversal.
 *
 * Consumed by the harness's own prevention detectors, the model-facing
 * quality packs, the architecture analyzer (`scripts/verification/
 * architecture.ts`) and the test inventory parser (`scripts/test-inventory.ts`),
 * which used to carry three more copies of the child walk and its key-skip
 * list. Scripts import this `src/` module (the allowed direction); nothing in
 * `src/` imports the verification layer. Scope and binding identities live
 * here so authority adapters and shipped analyzers share the same semantics.
 * `babelParserPluginsForSourcePath` retains the declared parallel with
 * `scripts/verification/effect-surface.ts` in
 * `test/prevention/duplicate-bodies-allowlist.json`.
 */

export type AstNode = Readonly<{ type: string; [key: string]: unknown }>;

export function astNode(value: unknown): AstNode | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) && typeof (value as { type?: unknown }).type === "string"
    ? value as AstNode
    : undefined;
}

export function astNodeArray(value: unknown): readonly AstNode[] {
  return Array.isArray(value) ? value.map(astNode).filter((entry): entry is AstNode => entry !== undefined) : [];
}

/**
 * The node keys that are metadata, never children: positions, parser extras,
 * the node type, and the comment and error arrays a parse may attach. The ONE
 * list every child traversal skips (the test inventory, the architecture
 * analyzer and the prevention detectors all walk through {@link astChildren}).
 */
const AST_NON_CHILD_KEYS: ReadonlySet<string> = new Set([
  "type", "start", "end", "loc", "range", "extra", "errors", "comments",
  "leadingComments", "trailingComments", "innerComments", "tokens",
]);

export function astChildren(node: AstNode): readonly AstNode[] {
  const children: AstNode[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (AST_NON_CHILD_KEYS.has(key)) continue;
    const child = astNode(value);
    if (child) children.push(child);
    else if (Array.isArray(value)) children.push(...astNodeArray(value));
  }
  return children;
}

export function bindingNames(pattern: AstNode | undefined): readonly string[] {
  if (pattern === undefined) return [];
  if (pattern.type === "Identifier") return typeof pattern.name === "string" ? [pattern.name] : [];
  if (pattern.type === "RestElement" || pattern.type === "TSParameterProperty") return bindingNames(astNode(pattern.argument ?? pattern.parameter));
  if (pattern.type === "AssignmentPattern") return bindingNames(astNode(pattern.left));
  if (pattern.type === "ArrayPattern") return astNodeArray(pattern.elements).flatMap(bindingNames);
  if (pattern.type === "ObjectPattern") {
    return astNodeArray(pattern.properties).flatMap((property) =>
      property.type === "RestElement"
        ? bindingNames(astNode(property.argument))
        : bindingNames(astNode(property.value)),
    );
  }
  return [];
}

export type ModuleScopeFacts = Readonly<{
  nodes: readonly AstNode[];
  parents: ReadonlyMap<AstNode, AstNode>;
}>;

/** Scope identities for an already parsed program; every consumer shares this walk. */
export function moduleScopeFacts(program: AstNode): ModuleScopeFacts {
  const nodes: AstNode[] = [];
  const parents = new Map<AstNode, AstNode>();
  const pending: Array<{ node: AstNode; parent?: AstNode }> = [{ node: program }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes.push(current.node);
    if (current.parent) parents.set(current.node, current.parent);
    for (const child of astChildren(current.node)) pending.push({ node: child, parent: current.node });
  }
  return { nodes, parents };
}

/** Prove this reference names the exact declaration, including local const aliases. */
export function identifierResolvesToDeclaration(
  identifier: AstNode,
  declaration: AstNode,
  module: ModuleScopeFacts,
): boolean {
  if (identifier.type !== "Identifier" || !isIdentifierReference(identifier, module)) return false;
  const name = String(identifier.name);
  const target = astNode(declaration.id ?? declaration.local);
  if (!target || !bindingNames(target).includes(name)) return false;
  const expectedScope = bindingScope(declaration, module.parents);
  let scope = nearestLexicalScope(identifier, module.parents);
  while (scope) {
    if (scope === expectedScope) return true;
    if (scopeDeclaresName(scope, name, module)) return false;
    scope = nearestLexicalScope(scope, module.parents);
  }
  return false;
}

export function identifierResolvesToImport(
  identifierNode: AstNode,
  module: ModuleScopeFacts & Readonly<{ imports: ReadonlyMap<string, object> }>,
  binding: object,
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

export function isIdentifierReference(node: AstNode, module: ModuleScopeFacts): boolean {
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

function scopeDeclaresName(scope: AstNode, name: string, module: ModuleScopeFacts): boolean {
  if (FUNCTION_SCOPE_TYPES.has(scope.type)) {
    if (astNodeArray(scope.params).some((parameter) => bindingNames(parameter).includes(name))) return true;
    const id = astNode(scope.id);
    if (id?.type === "Identifier" && id.name === name) return true;
  }
  if (scope.type === "ClassDeclaration" || scope.type === "ClassExpression") {
    const id = astNode(scope.id);
    if (id?.type === "Identifier" && id.name === name) return true;
  }
  if (scope.type === "CatchClause") {
    const parameter = astNode(scope.param);
    if (parameter && bindingNames(parameter).includes(name)) return true;
  }
  return module.nodes.some((candidate) => {
    if (candidate.type !== "VariableDeclarator" && candidate.type !== "FunctionDeclaration" &&
      candidate.type !== "ClassDeclaration") return false;
    const id = astNode(candidate.id);
    return id !== undefined && bindingNames(id).includes(name) && bindingScope(candidate, module.parents) === scope;
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

function isInsideBindingPattern(node: AstNode, module: ModuleScopeFacts): boolean {
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

export type BabelParserPlugin = "jsx" | "typescript" | ["typescript", { dts: boolean }];

/**
 * Per-file `@babel/parser` plugin selection. Handles `.ts/.tsx/.cts/.mts/.d.ts/
 *.d.mts/.d.cts/.jsx` (E6: do NOT hardcode the TypeScript plugin). Mirrored
 * from `scripts/verification/effect-surface.ts:93`; uses a typed `InputError`
 * instead of `throw new Error(...)` per the no-generic-errors prevention rule.
 */
export function babelParserPluginsForSourcePath(path: string): readonly BabelParserPlugin[] {
  const extension = ARCHITECTURE_SOURCE_EXTENSIONS.find((candidate) => path.endsWith(candidate));
  if (extension === undefined) {
    throw new InputError(`unsupported JavaScript source extension: ${path}`, "prevention_ast_unsupported_extension");
  }
  const declaration = path.endsWith(".d.ts") || path.endsWith(".d.mts") || path.endsWith(".d.cts");
  if (extension === ".tsx") return [["typescript", { dts: declaration }], "jsx"];
  if (extension === ".jsx") return ["jsx"];
  return extension === ".cts" || extension === ".mts" || extension === ".ts"
    ? [["typescript", { dts: declaration }]]
    : [];
}

/**
 * Parses one source FILE as a module with the plugins its extension needs,
 * and NAMES THE FILE when it does not parse. A bare parser error says only
 * "(815:2)", and the typed record a command emits then points at the parser's
 * own frame or at the command's entry point: a syntax error in
 * `src/evaluation/matrix-generator.ts` surfaced from `harness sync` as
 * `src/cli.ts` (wf1a-correctness, other findings 1), and the operator looked
 * in the wrong file. Refuses with `source_syntax_invalid`.
 */
export function parseSourceModule(path: string, source: string, options: Omit<ParserOptions, "sourceType" | "plugins"> = {}): AstNode {
  let parsed: { program?: unknown };
  try {
    parsed = parse(source, { ...options, sourceType: "module", plugins: [...babelParserPluginsForSourcePath(path)] }) as unknown as { program?: unknown };
  } catch (error) {
    const location = (error as { loc?: { line?: number; column?: number } }).loc;
    const where = location?.line === undefined ? "" : `:${String(location.line)}:${String((location.column ?? 0) + 1)}`;
    throw new InputError(`${path}${where}: ${(error as Error).message}`, "source_syntax_invalid", { sourcePath: path });
  }
  const program = astNode(parsed.program);
  if (program?.type !== "Program") throw new InputError(`${path}: did not parse as a module`, "source_syntax_invalid", { sourcePath: path });
  return program;
}

/**
 * Generic recursive AST visitor. Walks every node + child array, skipping
 * the `loc`/`range`/`start`/`end`/comment metadata keys. The single owner
 * of the Babel AST walk pattern — consumed by the D3 duplicate-body
 * detector, the EXP441 quick-view index, and the EXP441 file-slice index
 * (DRY: previously triplicated).
 * An optional leave callback runs after the same node's children, so scope
 * owners can maintain lexical frames without another child traversal.
 */
export function walkAst(node: unknown, visitor: (n: AstNode) => void, leave?: (n: AstNode) => void): void {
  if (!node || typeof node !== "object") return;
  const n = node as AstNode;
  if (typeof n.type !== "string") {
    for (const value of Object.values(n)) {
      if (Array.isArray(value)) for (const c of value) walkAst(c, visitor, leave);
      else if (value && typeof value === "object") walkAst(value, visitor, leave);
    }
    return;
  }
  visitor(n);
  for (const [key, value] of Object.entries(n)) {
    if (key === "loc" || key === "range" || key === "start" || key === "end") continue;
    if (Array.isArray(value)) for (const c of value) walkAst(c, visitor, leave);
    else if (value && typeof value === "object") walkAst(value, visitor, leave);
  }
  leave?.(n);
}
