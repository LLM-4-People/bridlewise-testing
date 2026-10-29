import { dirname, relative, resolve, sep } from "node:path";

import { parse as parseTypeScriptAst } from "@babel/parser";

import { canonicalHash, sha256 } from "../../../src/kernel/integrity.ts";
import { ROOT_POLICY } from "../../../src/kernel/root-policy.ts";
import { engineModuleSourceRelative } from "../../../src/shared/module-location.ts";
import { DEFAULT_GOVERNED_SOURCE_PARSE_CACHE_MAX_ENTRIES, DEFAULT_GOVERNED_SOURCE_VIOLATIONS_CACHE_MAX_ENTRIES } from "../../../src/workflow/workflow-config.ts";
import { babelParserPluginsForSourcePath } from "../../../src/quality-packs/prevention/ast-helpers.ts";
import {
  governedStaticArgumentIndexes,
  isForbiddenEffectSurfaceIdentifier,
  isSupportedJavaScriptSourcePath,
  isUnqualifiedRuntimeExecutionSink,
} from "../../verification/effect-surface.ts";

export function isForbiddenEffectIdentifier(identifier: string): boolean {
  return isForbiddenEffectSurfaceIdentifier(identifier);
}

function normalizedPolicyMarker(value: string): string {
  return value.replaceAll(/[^a-z0-9]/giu, "").toLocaleLowerCase("en-US");
}

export function containsExternalApplicationReference(value: string): boolean {
  return new RegExp("open[\\s._/@-]{0,4}" + "code", "iu").test(value);
}

export function containsUniqueHistoricalSchemaMarker(value: string): boolean {
  return new RegExp("session[\\s._-]{0,3}(?:message|input|context[\\s._-]{0,3}epoch)", "iu").test(value);
}

export function containsCoupledLegacySourceSchema(value: string): boolean {
  const normalized = value.toLocaleLowerCase("en-US");
  const tableNames = ["session", "message", "part"] as const;
  const hasEveryTable = tableNames.every((name) => new RegExp(
    "\\b(?:create\\s+table|from|join|into|update|references)\\s+[\"'`\\[]?" + name + "\\b",
    "iu",
  ).test(value));
  return hasEveryTable && normalized.includes("session" + "_id") && normalized.includes("message" + "_id");
}

type TypeScriptAstNode = Readonly<{ type: string; [key: string]: unknown }>;

// Content-hash memoization of the Babel parse in verifyGovernedTypeScriptSource.
// The function parses each governed TypeScript source file with Babel. This
// is the THIRD Babel parse of every src/ + scripts/ file in verifyS1Structure
// (after analyzeArchitectureSource + extractBoundedTopLevelStaticLiteral).
// Candidates created by makeRuntimeCandidate share the same file contents
// (copy-on-write reflinks), so a mutated candidate that changed only one file
// hits the cache for every OTHER file. The cache stores the parsed program;
// the AST analysis (which mutates the violations array) still runs per call.
const GOVERNED_SOURCE_PARSE_CACHE_MAX_ENTRIES = DEFAULT_GOVERNED_SOURCE_PARSE_CACHE_MAX_ENTRIES;
const governedSourceParseCache = new Map<string, TypeScriptAstNode | undefined>();

export function clearGovernedSourceParseCache(): void {
  governedSourceParseCache.clear();
  governedSourceViolationsCache.clear();
}

// Content-hash memoization of the violations produced by
// verifyGovernedTypeScriptSource. The analysis walks the parsed AST to check
// effects, imports, and policy conformance — the dominant remaining cost per
// source file after the parse cache. For a mutated candidate that changed
// only one file, all other files hit the cache: their violations are pushed
// from the cache instead of re-analyzing the AST. The cache key includes the
// allowed effect identifiers (which depend on the module's registered
// effects) so a module with different allowed effects does not get a false
// cache hit.
const GOVERNED_SOURCE_VIOLATIONS_CACHE_MAX_ENTRIES = DEFAULT_GOVERNED_SOURCE_VIOLATIONS_CACHE_MAX_ENTRIES;
const governedSourceViolationsCache = new Map<string, readonly string[]>();

import { createFilesystemCache, analysisSemanticsId } from "../../verification/filesystem-cache.ts";
import { DEFAULT_GOVERNED_SOURCE_VIOLATIONS_FILESYSTEM_CACHE_MAX_ENTRIES } from "../../../src/workflow/workflow-config.ts";

const governedSourceViolationsFilesystemCache = createFilesystemCache({
  directory: "harness-governed-cache",
  maxEntries: DEFAULT_GOVERNED_SOURCE_VIOLATIONS_FILESYSTEM_CACHE_MAX_ENTRIES,
});

function validateStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((v) => typeof v === "string") ? value as readonly string[] : undefined;
}

export function verifyGovernedTypeScriptSource(
  path: string,
  source: string,
  violations: string[],
  enforceProductionEffects = path.startsWith("src/"),
  allowedEffectIdentifiers: ReadonlySet<string> = new Set(),
): void {
  const contentHash = sha256(Buffer.from(source, "utf8"));
  const effectsHash = canonicalHash([...allowedEffectIdentifiers].sort());
  // The cached violations are a function of the analyzed bytes, the policy
  // inputs (the effect-set + enforcement-mode hashes) AND the analyzer that
  // produced them: an entry written before the analyzer's behavior changed
  // must never be served after it, or a fixed check would keep answering
  // from before the fix. The salt is the analyzer's own bytes plus the
  // classifier module the walk calls into (effect-surface.ts supplies the
  // parse plugin list and the effect/sink classifiers that shape the
  // violations). Unavailable bytes bypass result caches, including writes on
  // early returns. The local source parse cache is independent.
  const semanticsId = analysisSemanticsId(import.meta.url, new URL("../../verification/effect-surface.ts", import.meta.url));
  const cacheKey = semanticsId === undefined ? undefined : `${path}\u0000${contentHash}\u0000${enforceProductionEffects}\u0000${effectsHash}\u0000${semanticsId}`;
  const cached = cacheKey === undefined ? undefined : governedSourceViolationsCache.get(cacheKey);
  if (cached !== undefined) {
    violations.push(...cached);
    return;
  }
  // Filesystem-backed cache: shared across serial-phase processes.
  const filesystemCached = cacheKey === undefined ? undefined : governedSourceViolationsFilesystemCache.read<readonly string[]>(cacheKey, validateStringArray);
  if (cacheKey !== undefined && filesystemCached !== undefined) {
    governedSourceViolationsCache.set(cacheKey, filesystemCached);
    violations.push(...filesystemCached);
    return;
  }
  const violationsStart = violations.length;
  const program = parseGovernedTypeScriptSource(path, source);
  if (program === undefined) {
    violations.push(`governed-static-analysis-parse:${path}`);
    cacheGovernedSourceViolations(cacheKey, violations, violationsStart);
    return;
  }
  const scope: StaticAstScope = {
    bindings: new Map(),
    variableNames: new Set(),
    variableInitializers: new Map(),
    mutatedNames: collectMutatedAstNames(program),
    pureIntrinsicGetterFactories: new Set(),
    validatedIntrinsicReceivers: new Map(),
    exactUint8ArrayValues: new Set(),
  };
  const context: GovernedAstContext = {
    path,
    effectLabel: path.startsWith("src/") ? path.slice("src/".length) : path,
    enforceProductionEffects,
    enforceUniversalPolicyDefinitions:
      path !== engineModuleSourceRelative("root-policy.ts") && path !== "scripts/tooling/s1-verification.ts",
    allowedEffectIdentifiers,
    violations,
  };
  analyzeAstStatementList(astNodeArray(program.body), scope, context);
  cacheGovernedSourceViolations(cacheKey, violations, violationsStart);
}

function cacheGovernedSourceViolations(cacheKey: string | undefined, violations: string[], violationsStart: number): void {
  if (cacheKey === undefined) return;
  if (governedSourceViolationsCache.size >= GOVERNED_SOURCE_VIOLATIONS_CACHE_MAX_ENTRIES) {
    const oldest = governedSourceViolationsCache.keys().next();
    if (!oldest.done) governedSourceViolationsCache.delete(oldest.value);
  }
  const slice = violations.slice(violationsStart);
  governedSourceViolationsCache.set(cacheKey, slice);
  governedSourceViolationsFilesystemCache.write(cacheKey, slice);
}

function parseGovernedTypeScriptSource(path: string, source: string): TypeScriptAstNode | undefined {
  if (Buffer.byteLength(source, "utf8") > ROOT_POLICY.forensics.limits.maximumInputBytes) return undefined;
  const parseHash = sha256(Buffer.from(source, "utf8"));
  const parseCacheKey = `${path}\u0000${parseHash}`;
  if (governedSourceParseCache.has(parseCacheKey)) {
    return governedSourceParseCache.get(parseCacheKey);
  }
  let program: TypeScriptAstNode | undefined;
  try {
    const parsed = parseTypeScriptAst(source, {
      sourceType: "module",
      plugins: [...babelParserPluginsForSourcePath(path)],
      errorRecovery: false,
      attachComment: false,
      tokens: false,
    }) as unknown as { program?: unknown };
    program = astNode(parsed.program);
  } catch {
    program = undefined;
  }
  if (program !== undefined && (!program || program.type !== "Program" ||
    !astWithinNodeBudget(program, ROOT_POLICY.forensics.limits.maximumNodes))) {
    program = undefined;
  }
  if (governedSourceParseCache.size >= GOVERNED_SOURCE_PARSE_CACHE_MAX_ENTRIES) {
    const oldest = governedSourceParseCache.keys().next();
    if (!oldest.done) governedSourceParseCache.delete(oldest.value);
  }
  governedSourceParseCache.set(parseCacheKey, program);
  return program;
}
interface StaticAstObject {
  readonly [key: string]: StaticAstValue;
}
type StaticAstValue =
  | string
  | number
  | boolean
  | null
  | readonly StaticAstValue[]
  | StaticAstObject;
type ConstantAstBinding = Readonly<{
  kind: "constant";
  initializer: TypeScriptAstNode;
  scope: StaticAstScope;
}>;
type ImportedAstBinding = Readonly<{
  kind: "import";
  source: string;
  importedName: string;
  fromPath: string;
}>;
type StaticAstBinding = ConstantAstBinding | ImportedAstBinding;
type StaticAstScope = {
  readonly parent?: StaticAstScope;
  readonly bindings: Map<string, StaticAstBinding | typeof DYNAMIC_AST_BINDING>;
  readonly variableNames: Set<string>;
  readonly variableInitializers: Map<string, TypeScriptAstNode | undefined>;
  readonly mutatedNames: ReadonlySet<string>;
  readonly pureIntrinsicGetterFactories: Set<string>;
  readonly validatedIntrinsicReceivers: Map<string, "array-buffer" | "typed-array">;
  readonly exactUint8ArrayValues: Set<string>;
};
type GovernedAstContext = Readonly<{
  path: string;
  effectLabel: string;
  enforceProductionEffects: boolean;
  enforceUniversalPolicyDefinitions: boolean;
  allowedEffectIdentifiers: ReadonlySet<string>;
  violations: string[];
}>;

const UNKNOWN_AST_VALUE = Symbol("unknown-ast-value");
const DYNAMIC_AST_BINDING = Symbol("dynamic-ast-binding");
const AST_EVALUATION_MAXIMUM_DEPTH = 64;
const STATIC_PROCESS_MEMBERS = new Set([
  "argv", "cpuUsage", "cwd", "emitWarning", "exit", "exitCode", "execPath", "getgid", "getgroups",
  "getMaxListeners", "getuid", "hrtime", "kill", "memoryUsage", "pid", "platform", "ppid",
  "resourceUsage", "stderr", "stdout", "threadCpuUsage", "uptime", "version",
]);
const READ_ONLY_PROCESS_VERSION_CAPABILITIES = new Set(["icu", "unicode"]);
/**
 * Process members a governed source may READ but never write, call or mutate:
 * `execArgv` (the worker bootstrap reads whether its parent ran on eval input).
 * A write, a delete, an update or a mutating method call on one is
 * `process-member-write-unmodeled`.
 */
const READ_ONLY_PROCESS_MEMBERS = new Set(["execArgv"]);
const ARRAY_MUTATING_METHODS = new Set(["copyWithin", "fill", "pop", "push", "reverse", "shift", "sort", "splice", "unshift"]);
const UNREGISTERED_POLICY_DEFINITION_MARKERS = new Set([
  "directeffectentrypoint", "directeffectgateway", "rawentrypoint", "unregisteredentrypoint",
]);
const PARALLEL_POLICY_DEFINITION_MARKERS = new Set([
  "alignmentcheckpointstore", "alignmentmonitorstore", "bypasspolicy", "effectgateway", "goalalignmentstore",
  "localguard", "localpolicyguard", "localpolicyregistry", "operationenvelope", "parallelpolicydefinitions",
  "policycompiler", "policyregistry", "policywaiver", "skippolicy", "undocumentedexception",
]);

export function isTypeScriptLikePath(path: string): boolean {
  return isSupportedJavaScriptSourcePath(path);
}

export function isGovernedTypeScriptPath(path: string): boolean {
  return (path.startsWith("src/") || path.startsWith("scripts/")) && isTypeScriptLikePath(path);
}

function analyzeAstStatementList(
  statements: readonly TypeScriptAstNode[],
  scope: StaticAstScope,
  context: GovernedAstContext,
  depth = 0,
): void {
  for (const statement of statements) predeclareAstStatement(statement, scope, context.path);
  for (const statement of statements) analyzeGovernedAstNode(statement, scope, context, false, depth + 1);
}

function predeclareAstStatement(statement: TypeScriptAstNode, scope: StaticAstScope, fromPath: string): void {
  const declaration = statement.type === "ExportNamedDeclaration" ? astNode(statement.declaration) : statement;
  if (!declaration) return;
  if (declaration.type === "VariableDeclaration") {
    const immutable = declaration.kind === "const";
    for (const declarator of astNodeArray(declaration.declarations)) {
      registerAstDeclarator(declarator, scope, immutable);
      registerExactUint8ArrayValue(declarator, scope, immutable);
    }
    return;
  }
  if (["FunctionDeclaration", "ClassDeclaration"].includes(declaration.type)) {
    const identifier = astNode(declaration.id);
    if (identifier?.type === "Identifier") {
      const name = String(identifier.name);
      if (declaration.type === "FunctionDeclaration" && isPureIntrinsicGetterFactory(declaration)) {
        scope.pureIntrinsicGetterFactories.add(name);
      }
      registerDynamicAstBinding(scope, name);
    }
    return;
  }
  if (declaration.type === "ImportDeclaration") {
    const sourceNode = astNode(declaration.source);
    const source = sourceNode?.type === "StringLiteral" ? String(sourceNode.value) : undefined;
    for (const specifier of astNodeArray(declaration.specifiers)) {
      const local = astNode(specifier.local);
      if (local?.type !== "Identifier" || source === undefined) continue;
      const imported = astNode(specifier.imported);
      const importedName = specifier.type === "ImportDefaultSpecifier"
        ? "default"
        : specifier.type === "ImportNamespaceSpecifier"
          ? "*"
          : imported?.type === "Identifier" || imported?.type === "StringLiteral"
            ? String(imported.name ?? imported.value)
            : undefined;
      if (importedName === undefined) {
        registerDynamicAstBinding(scope, String(local.name));
      } else {
        scope.bindings.set(String(local.name), { kind: "import", source, importedName, fromPath });
      }
    }
  }
}

function registerAstDeclarator(
  declarator: TypeScriptAstNode,
  scope: StaticAstScope,
  immutable: boolean,
): void {
  const identifier = astNode(declarator.id);
  const initializer = astNode(declarator.init);
  for (const name of astBindingNames(identifier)) {
    scope.variableNames.add(name);
    scope.variableInitializers.set(name, identifier?.type === "Identifier" ? initializer : undefined);
  }
  if (immutable && identifier?.type === "Identifier" && initializer &&
    !scope.mutatedNames.has(String(identifier.name))) {
    const name = String(identifier.name);
    const existing = scope.bindings.get(name);
    if (existing === undefined) scope.bindings.set(name, { kind: "constant", initializer, scope });
    else if (existing === DYNAMIC_AST_BINDING || existing.kind !== "constant" ||
      existing.initializer !== initializer) {
      scope.bindings.set(name, DYNAMIC_AST_BINDING);
    }
    return;
  }
  for (const name of astBindingNames(identifier)) registerDynamicAstBinding(scope, name);
}

function registerDynamicAstBinding(scope: StaticAstScope, name: string): void {
  scope.bindings.set(name, DYNAMIC_AST_BINDING);
}

function astBindingNames(pattern: TypeScriptAstNode | undefined, depth = 0): readonly string[] {
  if (!pattern || depth > AST_EVALUATION_MAXIMUM_DEPTH) return [];
  if (pattern.type === "Identifier") return [String(pattern.name)];
  const names: string[] = [];
  for (const child of astChildNodes(pattern)) names.push(...astBindingNames(child, depth + 1));
  return names;
}

function analyzeGovernedAstNode(
  node: TypeScriptAstNode,
  scope: StaticAstScope,
  context: GovernedAstContext,
  exported: boolean,
  depth = 0,
): void {
  if (depth > AST_EVALUATION_MAXIMUM_DEPTH) {
    context.violations.push(`governed-static-analysis-depth:${context.path}`);
    return;
  }
  if (context.enforceUniversalPolicyDefinitions) {
    if ([
      "ClassDeclaration", "FunctionDeclaration", "TSInterfaceDeclaration", "TSTypeAliasDeclaration",
    ].includes(node.type)) {
      const identifier = astNode(node.id);
      if (identifier?.type === "Identifier") {
        inspectUniversalPolicyDefinitionName(String(identifier.name), context);
      }
    }
    if (["ClassMethod", "ClassPrivateMethod", "ObjectMethod", "TSMethodSignature"].includes(node.type)) {
      const name = staticAstPropertyName(node, scope);
      if (name !== UNKNOWN_AST_VALUE) inspectUniversalPolicyDefinitionName(name, context);
    }
    if (node.type === "ObjectExpression") {
      for (const property of astNodeArray(node.properties)) {
        if (property.type !== "ObjectProperty") continue;
        const name = staticAstPropertyName(property, scope);
        if (name !== UNKNOWN_AST_VALUE) inspectUniversalPolicyDefinitionName(name, context);
      }
    }
  }
  inspectProcessVersionCapabilityMutation(node, scope, context);
  if (node.type === "ExportNamedDeclaration") {
    const declaration = astNode(node.declaration);
    if (declaration) analyzeGovernedAstNode(declaration, scope, context, true, depth + 1);
    for (const specifier of astNodeArray(node.specifiers)) {
      const local = astNode(specifier.local);
      if (local?.type === "Identifier") {
        inspectGovernedAstExpression(local, scope, context.path, context.violations);
        if (isAstVariableName(scope, String(local.name)) &&
          evaluateStaticAst(local, scope) === UNKNOWN_AST_VALUE) {
          const binding = resolveStaticAstBinding(scope, String(local.name));
          const initializer = binding !== undefined && binding !== DYNAMIC_AST_BINDING &&
            binding.kind === "constant" ? binding.initializer : undefined;
          const initializerScope = binding !== undefined && binding !== DYNAMIC_AST_BINDING &&
            binding.kind === "constant" ? binding.scope : scope;
          if (!initializer || !isExplicitlyTrustedUnknownExport(initializer, initializerScope, context.path)) {
            context.violations.push(`governed-export-unmodeled:${context.path}`);
          }
        }
      }
    }
    return;
  }
  if (node.type === "ExportDefaultDeclaration") {
    const declaration = astNode(node.declaration);
    if (declaration) inspectGovernedAstExpression(declaration, scope, context.path, context.violations);
    if (declaration && !["ClassDeclaration", "FunctionDeclaration", "TSDeclareFunction"].includes(declaration.type) &&
      (declaration.type !== "Identifier" || isAstVariableName(scope, String(declaration.name))) &&
      evaluateStaticAst(declaration, scope) === UNKNOWN_AST_VALUE) {
      const binding = declaration.type === "Identifier"
        ? resolveStaticAstBinding(scope, String(declaration.name))
        : undefined;
      const initializer = binding !== undefined && binding !== DYNAMIC_AST_BINDING && binding.kind === "constant"
        ? binding.initializer
        : declaration;
      const initializerScope = binding !== undefined && binding !== DYNAMIC_AST_BINDING && binding.kind === "constant"
        ? binding.scope
        : scope;
      if (!isExplicitlyTrustedUnknownExport(initializer, initializerScope, context.path)) {
        context.violations.push(`governed-export-unmodeled:${context.path}`);
      }
    }
    if (declaration) analyzeGovernedAstNode(declaration, scope, context, false, depth + 1);
    return;
  }
  if (node.type === "VariableDeclaration") {
    const immutable = node.kind === "const";
    for (const declarator of astNodeArray(node.declarations)) {
      if (context.enforceUniversalPolicyDefinitions) {
        const identifier = astNode(declarator.id);
        if (identifier?.type === "Identifier") {
          inspectUniversalPolicyDefinitionName(String(identifier.name), context);
        }
      }
      registerAstDeclarator(declarator, scope, immutable);
      inspectProcessDestructuring(declarator, scope, context);
      const initializer = astNode(declarator.init);
      if (initializer && exported) {
        inspectGovernedAstExpression(initializer, scope, context.path, context.violations);
        if (evaluateStaticAst(initializer, scope) === UNKNOWN_AST_VALUE &&
          !isExplicitlyTrustedUnknownExport(initializer, scope, context.path)) {
          context.violations.push(`governed-export-unmodeled:${context.path}`);
        }
      }
      if (initializer) analyzeGovernedAstNode(initializer, scope, context, false, depth + 1);
    }
    return;
  }
  if (node.type === "Program") {
    analyzeAstStatementList(astNodeArray(node.body), scope, context, depth + 1);
    return;
  }
  if (node.type === "BlockStatement") {
    analyzeAstStatementList(
      astNodeArray(node.body),
      {
        parent: scope,
        bindings: new Map(),
        variableNames: new Set(),
        variableInitializers: new Map(),
        mutatedNames: scope.mutatedNames,
        pureIntrinsicGetterFactories: new Set(),
        validatedIntrinsicReceivers: new Map(),
        exactUint8ArrayValues: new Set(),
      },
      context,
      depth + 1,
    );
    return;
  }
  if (isFunctionAstNode(node)) {
    const functionScope: StaticAstScope = {
      parent: scope,
      bindings: new Map(),
      variableNames: new Set(),
      variableInitializers: new Map(),
      mutatedNames: scope.mutatedNames,
      pureIntrinsicGetterFactories: new Set(),
      validatedIntrinsicReceivers: new Map(),
      exactUint8ArrayValues: new Set(),
    };
    for (const parameter of astNodeArray(node.params)) {
      for (const name of astBindingNames(parameter)) registerDynamicAstBinding(functionScope, name);
    }
    const body = astNode(node.body);
    if (body) analyzeGovernedAstNode(body, functionScope, context, false, depth + 1);
    return;
  }
  if (node.type === "CallExpression" || node.type === "OptionalCallExpression") {
    inspectGovernedAstCall(node, scope, context);
  } else if (node.type === "NewExpression") {
    const callee = unwrapAstExpression(astNode(node.callee));
    if (callee && isMemberAstNode(callee)) inspectGovernedAstMember(callee, scope, context, true);
    for (const argument of astNodeArray(node.arguments)) {
      inspectGovernedAstExpression(argument, scope, context.path, context.violations);
    }
  } else if (node.type === "TaggedTemplateExpression") {
    const tag = unwrapAstExpression(astNode(node.tag));
    if (tag && isMemberAstNode(tag)) inspectGovernedAstMember(tag, scope, context, true);
    const quasi = astNode(node.quasi);
    if (quasi) inspectGovernedAstExpression(quasi, scope, context.path, context.violations);
  } else if (isMemberAstNode(node)) {
    inspectGovernedAstMember(node, scope, context, false);
    if (context.path === "src/runtime-capabilities.ts" &&
      isExactReadOnlyProcessVersionCapability(node, scope)) return;
  } else if (node.type === "ImportExpression") {
    const sourceNode = astNode(node.source);
    const sourceValue = sourceNode ? evaluateStaticAst(sourceNode, scope) : UNKNOWN_AST_VALUE;
    if (typeof sourceValue !== "string") {
      context.violations.push(`module-acquisition-unmodeled:${context.effectLabel}`);
    }
  }
  for (const child of astChildNodes(node)) analyzeGovernedAstNode(child, scope, context, false, depth + 1);
  if (node.type === "IfStatement") registerIntrinsicReceiverValidation(node, scope);
}

function inspectUniversalPolicyDefinitionName(name: string, context: GovernedAstContext): void {
  const marker = normalizedPolicyMarker(name);
  if (UNREGISTERED_POLICY_DEFINITION_MARKERS.has(marker)) {
    context.violations.push(`universal-policy-unregistered-entrypoint:${context.path}`);
  } else if (PARALLEL_POLICY_DEFINITION_MARKERS.has(marker)) {
    context.violations.push(`universal-policy-parallel-authority:${context.path}`);
  }
}

function isExplicitlyTrustedUnknownExport(
  initializer: TypeScriptAstNode,
  scope: StaticAstScope,
  path: string,
): boolean {
  const expression = unwrapAstExpression(initializer);
  if (!expression) return false;
  if (isFunctionAstNode(expression) || expression.type === "ClassExpression") return true;
  if (expression.type !== "CallExpression" && expression.type !== "OptionalCallExpression") {
    return false;
  }
  const callee = unwrapAstExpression(astNode(expression.callee));
  if (!callee) return false;
  const name = staticAstCalleeName(callee, scope);
  if (isIdentityWrapperCall(callee, name, scope)) return true;
  if (callee.type === "Identifier") {
    const binding = resolveStaticAstBinding(scope, String(callee.name));
    if (binding !== undefined && binding !== DYNAMIC_AST_BINDING && binding.kind === "import" &&
      binding.importedName === "canonicalHash" && astImportTarget(binding) === engineModuleSourceRelative("integrity.ts")) {
      return true;
    }
    return path === engineModuleSourceRelative("forensic-contracts.ts") && String(callee.name) === "boundedCanonicalDecimal" &&
      binding === DYNAMIC_AST_BINDING;
  }
  if (!isMemberAstNode(callee)) return false;
  const receiver = unwrapAstExpression(astNode(callee.object));
  if (receiver?.type !== "Identifier") return false;
  const binding = resolveStaticAstBinding(scope, String(receiver.name));
  return binding !== undefined && binding !== DYNAMIC_AST_BINDING && binding.kind === "import" &&
    binding.source === "zod" && binding.importedName === "z";
}

function isFunctionAstNode(node: TypeScriptAstNode): boolean {
  return [
    "ArrowFunctionExpression", "ClassMethod", "ClassPrivateMethod", "FunctionDeclaration",
    "FunctionExpression", "ObjectMethod",
  ].includes(node.type);
}

function inspectProcessDestructuring(
  declarator: TypeScriptAstNode,
  scope: StaticAstScope,
  context: GovernedAstContext,
): void {
  const pattern = astNode(declarator.id);
  const initializer = unwrapAstExpression(astNode(declarator.init));
  if (pattern?.type !== "ObjectPattern" || !initializer || !isProcessAstExpression(initializer, scope)) return;
  for (const property of astNodeArray(pattern.properties)) {
    const propertyName = staticAstPropertyName(property, scope);
    if (propertyName === UNKNOWN_AST_VALUE) {
      context.violations.push(`process-member-unmodeled:${context.effectLabel}`);
    } else if (propertyName === "getBuiltinModule" || propertyName === "binding") {
      context.violations.push(`production-effect-api:${context.effectLabel}:process.${propertyName}`);
    } else if (propertyName === "env") {
      if (!context.allowedEffectIdentifiers.has("env")) {
        context.violations.push(`environment-configuration-source:${context.effectLabel}`);
      }
    }
  }
}

function inspectGovernedAstCall(
  call: TypeScriptAstNode,
  scope: StaticAstScope,
  context: GovernedAstContext,
): void {
  const callee = unwrapAstExpression(astNode(call.callee));
  if (!callee) return;
  const calleeName = staticAstCalleeName(callee, scope);
  const pureBuilder = isPureStaticBuilderCall(callee, calleeName, scope);
  if (!pureBuilder) {
    for (const argument of astNodeArray(call.arguments)) {
      inspectGovernedAstExpression(argument, scope, context.path, context.violations);
    }
  }
  if (callee.type === "Import") {
    const argument = astNodeArray(call.arguments)[0];
    if (!argument || typeof evaluateStaticAst(argument, scope) !== "string") {
      context.violations.push(`module-acquisition-unmodeled:${context.effectLabel}`);
    }
  }
  if (callee.type === "Identifier" && String(callee.name) === "require") {
    const argument = astNodeArray(call.arguments)[0];
    if (!argument || typeof evaluateStaticAst(argument, scope) !== "string") {
      context.violations.push(`module-acquisition-unmodeled:${context.effectLabel}`);
    }
  }
  if (isMemberAstNode(callee)) inspectGovernedAstMember(callee, scope, context, true);
  if (isReflectApplyAstCall(callee, calleeName, scope) && context.enforceProductionEffects) {
    const admittedPureIntrinsic = isAdmittedPureIntrinsicApply(call, scope);
    if (!admittedPureIntrinsic) {
      context.violations.push(`production-effect-api:${context.effectLabel}:Reflect.apply`);
    }
    const appliedArguments = astNodeArray(call.arguments)[2];
    if (!appliedArguments || (evaluateStaticAst(appliedArguments, scope) === UNKNOWN_AST_VALUE &&
      !admittedPureIntrinsic)) {
      context.violations.push(`production-effect-sink-unmodeled:${context.effectLabel}`);
    }
  }
  if (calleeName !== UNKNOWN_AST_VALUE && context.enforceProductionEffects &&
    isForbiddenEffectSurfaceIdentifier(calleeName) && !context.allowedEffectIdentifiers.has(calleeName)) {
    context.violations.push(`production-effect-api:${context.effectLabel}:${calleeName}`);
  }
  if (calleeName === UNKNOWN_AST_VALUE && isMemberAstNode(callee) && context.enforceProductionEffects) {
    context.violations.push(`production-effect-sink-unmodeled:${context.effectLabel}`);
  }
  const ambiguousMemberSink = calleeName !== UNKNOWN_AST_VALUE && ["prepare", "query", "run"].includes(calleeName);
  const staticArgumentIndexes = calleeName === UNKNOWN_AST_VALUE
    ? undefined
    : governedStaticArgumentIndexes(calleeName);
  if (staticArgumentIndexes !== undefined && (!ambiguousMemberSink || isMemberAstNode(callee))) {
    const argumentsList = astNodeArray(call.arguments);
    for (const index of staticArgumentIndexes) {
      const argument = argumentsList[index];
      if (!argument) continue;
      if (evaluateStaticAst(argument, scope) === UNKNOWN_AST_VALUE &&
        isUnmodeledStaticAstConstruction(argument, scope)) {
        context.violations.push(`governed-sink-unmodeled:${context.path}`);
      }
    }
  }
  if (calleeName !== UNKNOWN_AST_VALUE && isUnqualifiedRuntimeExecutionSink(calleeName)) {
    const executable = astNodeArray(call.arguments)[0];
    const executableValue = executable ? evaluateStaticAst(executable, scope) : UNKNOWN_AST_VALUE;
    if (executableValue === UNKNOWN_AST_VALUE &&
      (!executable || !isCentralPolicyGitExecutable(executable, scope) &&
        !isImportedCurrentNodeExecutable(executable, scope) &&
        !isProcessExecPathMember(executable, scope) &&
        !isGovernedRuntimeExecutionSinkPath(context.path))) {
      context.violations.push(`standalone-runtime-sink-unmodeled:${context.path}`);
    } else if (executableValue !== UNKNOWN_AST_VALUE) {
      inspectResolvedStaticAstValue(executableValue, context.path, context.violations);
    }
  }
}

function inspectGovernedAstMember(
  member: TypeScriptAstNode,
  scope: StaticAstScope,
  context: GovernedAstContext,
  callTarget: boolean,
): void {
  const object = unwrapAstExpression(astNode(member.object));
  const memberName = staticAstMemberName(member, scope);
  const objectIdentity = object ? resolveAstIntrinsicIdentity(object, scope) : undefined;
  if (objectIdentity === "process") {
    if (memberName === UNKNOWN_AST_VALUE) {
      context.violations.push(`process-member-unmodeled:${context.effectLabel}`);
      return;
    }
    if (memberName === "getBuiltinModule" || memberName === "binding") {
      context.violations.push(`production-effect-api:${context.effectLabel}:process.${memberName}`);
      return;
    }
    if (memberName === "env") {
      if (!context.allowedEffectIdentifiers.has("env")) {
        context.violations.push(`environment-configuration-source:${context.effectLabel}`);
      }
    } else if (READ_ONLY_PROCESS_MEMBERS.has(memberName)) {
      if (callTarget) context.violations.push(`process-member-write-unmodeled:${context.effectLabel}`);
    } else if (!STATIC_PROCESS_MEMBERS.has(memberName)) {
      context.violations.push(`process-member-unmodeled:${context.effectLabel}`);
    }
  } else if (callTarget && object && isMemberAstNode(object) && isReadOnlyProcessMember(object, scope) &&
    ARRAY_MUTATING_METHODS.has(String(memberName))) {
    // `process.execArgv.push(…)`: a read-only member mutated through its own method.
    context.violations.push(`process-member-write-unmodeled:${context.effectLabel}`);
  } else if (objectIdentity === "process-versions") {
    if (context.path !== "src/runtime-capabilities.ts" ||
      !isExactReadOnlyProcessVersionCapability(member, scope) || callTarget) {
      context.violations.push(`process-member-unmodeled:${context.effectLabel}`);
    }
  } else if (objectIdentity === "process-environment") {
    context.violations.push(memberName === UNKNOWN_AST_VALUE
      ? `environment-acquisition-unmodeled:${context.effectLabel}`
      : `environment-configuration-source:${context.effectLabel}`);
  }
  if (callTarget && memberName !== UNKNOWN_AST_VALUE && context.enforceProductionEffects &&
    isForbiddenEffectSurfaceIdentifier(memberName) && !context.allowedEffectIdentifiers.has(memberName)) {
    context.violations.push(`production-effect-api:${context.effectLabel}:${memberName}`);
  } else if (callTarget && memberName === UNKNOWN_AST_VALUE && context.enforceProductionEffects) {
    context.violations.push(`production-effect-sink-unmodeled:${context.effectLabel}`);
  }
}

function inspectProcessVersionCapabilityMutation(
  node: TypeScriptAstNode,
  scope: StaticAstScope,
  context: GovernedAstContext,
): void {
  const target = node.type === "AssignmentExpression" || node.type === "AssignmentPattern" ||
    node.type === "ForInStatement" || node.type === "ForOfStatement"
    ? astNode(node.left)
    : node.type === "UpdateExpression" || node.type === "UnaryExpression" && node.operator === "delete"
      ? astNode(node.argument)
      : undefined;
  if (target && (astContainsExactProcessVersionCapability(target, scope) || astContainsReadOnlyProcessMember(target, scope))) {
    context.violations.push(`process-member-write-unmodeled:${context.effectLabel}`);
  }
}

/** Whether `member` is `process.<a read-only member>` (see {@link READ_ONLY_PROCESS_MEMBERS}). */
function isReadOnlyProcessMember(member: TypeScriptAstNode, scope: StaticAstScope): boolean {
  const object = unwrapAstExpression(astNode(member.object));
  const name = staticAstMemberName(member, scope);
  return object !== undefined && resolveAstIntrinsicIdentity(object, scope) === "process" && name !== UNKNOWN_AST_VALUE && READ_ONLY_PROCESS_MEMBERS.has(name);
}

/** Whether a write target holds `process.<a read-only member>` or a part of one (`process.execArgv[0]`). */
function astContainsReadOnlyProcessMember(root: TypeScriptAstNode, scope: StaticAstScope): boolean {
  for (let node: TypeScriptAstNode | undefined = root; node !== undefined && isMemberAstNode(node); node = unwrapAstExpression(astNode(node.object))) {
    if (isReadOnlyProcessMember(node, scope)) return true;
  }
  return false;
}

function astContainsExactProcessVersionCapability(
  root: TypeScriptAstNode,
  scope: StaticAstScope,
): boolean {
  const pending = [root];
  const visited = new Set<TypeScriptAstNode>();
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (visited.has(node)) continue;
    visited.add(node);
    if (isMemberAstNode(node) && isExactReadOnlyProcessVersionCapability(node, scope)) return true;
    pending.push(...astChildNodes(node));
  }
  return false;
}

function isExactReadOnlyProcessVersionCapability(
  member: TypeScriptAstNode,
  scope: StaticAstScope,
): boolean {
  if (!isMemberAstNode(member) || member.computed === true) return false;
  const capability = staticAstMemberName(member, scope);
  if (capability === UNKNOWN_AST_VALUE || !READ_ONLY_PROCESS_VERSION_CAPABILITIES.has(capability)) return false;
  const versionsMember = unwrapAstExpression(astNode(member.object));
  if (!versionsMember || !isMemberAstNode(versionsMember) || versionsMember.computed === true ||
    staticAstMemberName(versionsMember, scope) !== "versions") return false;
  const processIdentifier = unwrapAstExpression(astNode(versionsMember.object));
  return processIdentifier?.type === "Identifier" && String(processIdentifier.name) === "process" &&
    resolveStaticAstBinding(scope, "process") === undefined;
}

type AstIntrinsicIdentity = "global-this" | "process" | "process-environment" | "process-versions";

function resolveAstIntrinsicIdentity(
  node: TypeScriptAstNode,
  scope: StaticAstScope,
  active = new Set<TypeScriptAstNode>(),
): AstIntrinsicIdentity | undefined {
  const expression = unwrapAstExpression(node);
  if (!expression || active.has(expression)) return undefined;
  active.add(expression);
  try {
    if (expression.type === "Identifier") {
      const name = String(expression.name);
      const binding = resolveStaticAstBinding(scope, name);
      if (binding === undefined) {
        if (name === "globalThis") return "global-this";
        if (name === "process") return "process";
        return undefined;
      }
      if (binding === DYNAMIC_AST_BINDING || binding.kind !== "constant") return undefined;
      return resolveAstIntrinsicIdentity(binding.initializer, binding.scope, active);
    }
    if (!isMemberAstNode(expression)) return undefined;
    const object = astNode(expression.object);
    if (!object) return undefined;
    const objectIdentity = resolveAstIntrinsicIdentity(object, scope, active);
    const memberName = staticAstMemberName(expression, scope);
    if (memberName === UNKNOWN_AST_VALUE) return undefined;
    if (objectIdentity === "global-this" && memberName === "process") return "process";
    if (objectIdentity === "global-this" && memberName === "globalThis") return "global-this";
    if (objectIdentity === "process" && memberName === "env") return "process-environment";
    if (objectIdentity === "process" && memberName === "versions" && expression.computed !== true) {
      return "process-versions";
    }
    return undefined;
  } finally {
    active.delete(expression);
  }
}

function isProcessAstExpression(node: TypeScriptAstNode, scope: StaticAstScope): boolean {
  return resolveAstIntrinsicIdentity(node, scope) === "process";
}

function inspectGovernedAstExpression(
  expression: TypeScriptAstNode,
  scope: StaticAstScope,
  path: string,
  violations: string[],
  depth = 0,
): void {
  if (depth > AST_EVALUATION_MAXIMUM_DEPTH) {
    violations.push(`governed-static-analysis-depth:${path}`);
    return;
  }
  const value = evaluateStaticAst(expression, scope);
  if (value !== UNKNOWN_AST_VALUE) inspectResolvedStaticAstValue(value, path, violations);
  const unwrapped = unwrapAstExpression(expression);
  if (!unwrapped) return;
  if (unwrapped.type === "ObjectExpression") {
    for (const property of astNodeArray(unwrapped.properties)) {
      if (property.type === "ObjectProperty") {
        const key = staticAstPropertyName(property, scope);
        const valueNode = astNode(property.value);
        const propertyValue = valueNode ? evaluateStaticAst(valueNode, scope) : UNKNOWN_AST_VALUE;
        if (typeof key === "string" && typeof propertyValue === "string" &&
          isCompetingAuthorityPair(key, propertyValue)) {
          violations.push(`evidence-graph-competing-authority:${path}`);
        }
        if (valueNode) inspectGovernedAstExpression(valueNode, scope, path, violations, depth + 1);
      } else {
        const argument = astNode(property.argument);
        if (argument) inspectGovernedAstExpression(argument, scope, path, violations, depth + 1);
      }
    }
  } else if (unwrapped.type === "ArrayExpression" || unwrapped.type === "TemplateLiteral") {
    for (const child of astChildNodes(unwrapped)) {
      inspectGovernedAstExpression(child, scope, path, violations, depth + 1);
    }
  } else if (unwrapped.type === "CallExpression" || unwrapped.type === "OptionalCallExpression") {
    const callee = unwrapAstExpression(astNode(unwrapped.callee));
    const calleeName = callee ? staticAstCalleeName(callee, scope) : UNKNOWN_AST_VALUE;
    if (callee && isPureStaticBuilderCall(callee, calleeName, scope)) {
      for (const argument of astNodeArray(unwrapped.arguments)) {
        inspectGovernedAstExpression(argument, scope, path, violations, depth + 1);
      }
      if (isMemberAstNode(callee)) {
        const receiver = astNode(callee.object);
        if (receiver) inspectGovernedAstExpression(receiver, scope, path, violations, depth + 1);
      }
    }
  }
}

function inspectResolvedStaticAstValue(
  value: StaticAstValue,
  path: string,
  violations: string[],
  depth = 0,
): void {
  if (depth > AST_EVALUATION_MAXIMUM_DEPTH) {
    violations.push(`governed-static-analysis-depth:${path}`);
    return;
  }
  if (typeof value === "string") {
    if (containsExternalApplicationReference(value)) {
      violations.push(`standalone-product-boundary-reference:${path}`);
    }
    if (containsUniqueHistoricalSchemaMarker(value)) {
      violations.push(`historical-source-schema-marker:${path}`);
    }
    if (containsCoupledLegacySourceSchema(value)) {
      violations.push(`historical-source-schema-coupling:${path}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) inspectResolvedStaticAstValue(entry, path, violations, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    inspectResolvedStaticAstValue(key, path, violations, depth + 1);
    if (typeof entry === "string" && isCompetingAuthorityPair(key, entry)) {
      violations.push(`evidence-graph-competing-authority:${path}`);
    }
    inspectResolvedStaticAstValue(entry, path, violations, depth + 1);
  }
}

function isCompetingAuthorityPair(key: string, value: string): boolean {
  const normalizedKey = key.replaceAll(/[^a-z0-9]/giu, "").toLocaleLowerCase("en-US");
  if (normalizedKey !== "sourceoftruth" && normalizedKey !== "authority") return false;
  const normalizedValue = value.replaceAll(/[^a-z0-9.]/giu, "").toLocaleLowerCase("en-US");
  if (normalizedValue === "canonicalappendonlyeventledger" ||
    normalizedValue === "storagearchitecture.sourceoftruth") return false;
  return ["timeline", "graph", "search", "memory", "attempt", "git", "operational", "projection"]
    .some((part) => normalizedValue.includes(part));
}

function evaluateStaticAst(
  expression: TypeScriptAstNode,
  scope: StaticAstScope,
  active = new Set<TypeScriptAstNode>(),
  depth = 0,
): StaticAstValue | typeof UNKNOWN_AST_VALUE {
  if (depth > AST_EVALUATION_MAXIMUM_DEPTH) return UNKNOWN_AST_VALUE;
  const node = unwrapAstExpression(expression);
  if (!node || active.has(node)) return UNKNOWN_AST_VALUE;
  active.add(node);
  try {
    if (node.type === "StringLiteral") return boundedStaticAstString(String(node.value));
    if (node.type === "NumericLiteral") return Number(node.value);
    if (node.type === "BooleanLiteral") return Boolean(node.value);
    if (node.type === "NullLiteral") return null;
    if (node.type === "Identifier") {
      const binding = resolveStaticAstBinding(scope, String(node.name));
      return !binding || binding === DYNAMIC_AST_BINDING || binding.kind !== "constant"
        ? UNKNOWN_AST_VALUE
        : evaluateStaticAst(binding.initializer, binding.scope, active, depth + 1);
    }
    if (node.type === "TemplateLiteral") {
      const quasis = astNodeArray(node.quasis);
      const expressions = astNodeArray(node.expressions);
      let output = "";
      for (let index = 0; index < quasis.length; index += 1) {
        const value = astRecord(quasis[index]!.value);
        const text = value?.cooked;
        if (typeof text !== "string") return UNKNOWN_AST_VALUE;
        output += text;
        const substitution = expressions[index];
        if (substitution) {
          const result = evaluateStaticAst(substitution, scope, active, depth + 1);
          if (!isStaticAstScalar(result)) return UNKNOWN_AST_VALUE;
          output += result === null ? "null" : String(result);
        }
        if (boundedStaticAstString(output) === UNKNOWN_AST_VALUE) return UNKNOWN_AST_VALUE;
      }
      return output;
    }
    if (node.type === "BinaryExpression" && node.operator === "+") {
      const left = astNode(node.left);
      const right = astNode(node.right);
      if (!left || !right) return UNKNOWN_AST_VALUE;
      const leftValue = evaluateStaticAst(left, scope, active, depth + 1);
      const rightValue = evaluateStaticAst(right, scope, active, depth + 1);
      if (!isStaticAstScalar(leftValue) || !isStaticAstScalar(rightValue)) return UNKNOWN_AST_VALUE;
      if (typeof leftValue === "string" || typeof rightValue === "string") {
        return boundedStaticAstString(String(leftValue) + String(rightValue));
      }
      return typeof leftValue === "number" && typeof rightValue === "number"
        ? leftValue + rightValue
        : UNKNOWN_AST_VALUE;
    }
    if (node.type === "ArrayExpression") {
      const output: StaticAstValue[] = [];
      const rawElements = Array.isArray(node.elements) ? node.elements : [];
      if (rawElements.length > ROOT_POLICY.forensics.limits.maximumNodes) return UNKNOWN_AST_VALUE;
      for (const rawElement of rawElements) {
        if (rawElement === null) {
          output.push(null);
          continue;
        }
        const element = astNode(rawElement);
        if (!element) return UNKNOWN_AST_VALUE;
        if (element.type === "SpreadElement") {
          const argument = astNode(element.argument);
          const result = argument ? evaluateStaticAst(argument, scope, active, depth + 1) : UNKNOWN_AST_VALUE;
          if (!Array.isArray(result)) return UNKNOWN_AST_VALUE;
          output.push(...result);
        } else {
          const result = evaluateStaticAst(element, scope, active, depth + 1);
          if (result === UNKNOWN_AST_VALUE) return UNKNOWN_AST_VALUE;
          output.push(result);
        }
      }
      return output;
    }
    if (node.type === "ObjectExpression") {
      const output = Object.create(null) as Record<string, StaticAstValue>;
      const properties = astNodeArray(node.properties);
      if (properties.length > ROOT_POLICY.forensics.limits.maximumNodes) return UNKNOWN_AST_VALUE;
      for (const property of properties) {
        if (property.type === "SpreadElement") {
          const argument = astNode(property.argument);
          const spread = argument ? evaluateStaticAst(argument, scope, active, depth + 1) : UNKNOWN_AST_VALUE;
          if (!isStaticAstObject(spread)) return UNKNOWN_AST_VALUE;
          Object.assign(output, spread);
          continue;
        }
        if (property.type !== "ObjectProperty") return UNKNOWN_AST_VALUE;
        const key = staticAstPropertyName(property, scope, active, depth + 1);
        const valueNode = astNode(property.value);
        const result = valueNode ? evaluateStaticAst(valueNode, scope, active, depth + 1) : UNKNOWN_AST_VALUE;
        if (key === UNKNOWN_AST_VALUE || result === UNKNOWN_AST_VALUE) return UNKNOWN_AST_VALUE;
        output[key] = result;
      }
      return output;
    }
    if (node.type === "CallExpression" || node.type === "OptionalCallExpression") {
      const callee = unwrapAstExpression(astNode(node.callee));
      if (!callee) return UNKNOWN_AST_VALUE;
      const name = staticAstCalleeName(callee, scope, active, depth + 1);
      const args = astNodeArray(node.arguments);
      if (isIdentityWrapperCall(callee, name, scope)) {
        return args[0] ? evaluateStaticAst(args[0], scope, active, depth + 1) : UNKNOWN_AST_VALUE;
      }
      if (!isMemberAstNode(callee) || name === UNKNOWN_AST_VALUE) return UNKNOWN_AST_VALUE;
      const receiverNode = astNode(callee.object);
      const receiver = receiverNode
        ? evaluateStaticAst(receiverNode, scope, active, depth + 1)
        : UNKNOWN_AST_VALUE;
      if (name === "join" && Array.isArray(receiver) && args.length <= 1) {
        const separator = args[0] ? evaluateStaticAst(args[0], scope, active, depth + 1) : ",";
        if (typeof separator !== "string" || receiver.some((entry) => !isStaticAstScalar(entry))) {
          return UNKNOWN_AST_VALUE;
        }
        return boundedStaticAstString(receiver.map((entry) => entry === null ? "" : String(entry)).join(separator));
      }
      if (name === "concat") {
        const values: StaticAstValue[] = [];
        for (const argument of args) {
          const result = evaluateStaticAst(argument, scope, active, depth + 1);
          if (result === UNKNOWN_AST_VALUE) return UNKNOWN_AST_VALUE;
          values.push(result);
        }
        if (typeof receiver === "string" && values.every((entry) => isStaticAstScalar(entry))) {
          return boundedStaticAstString(receiver + values.map((entry) => String(entry)).join(""));
        }
        if (Array.isArray(receiver)) {
          const result = [...receiver, ...values.flatMap((entry) => Array.isArray(entry) ? entry : [entry])];
          return result.length <= ROOT_POLICY.forensics.limits.maximumNodes ? result : UNKNOWN_AST_VALUE;
        }
      }
      return UNKNOWN_AST_VALUE;
    }
    if (isMemberAstNode(node)) {
      const objectNode = astNode(node.object);
      const objectValue = objectNode
        ? evaluateStaticAst(objectNode, scope, active, depth + 1)
        : UNKNOWN_AST_VALUE;
      const propertyName = staticAstMemberName(node, scope, active, depth + 1);
      if (propertyName === UNKNOWN_AST_VALUE) return UNKNOWN_AST_VALUE;
      if (Array.isArray(objectValue) && /^\d+$/u.test(propertyName)) {
        const index = Number(propertyName);
        return index < objectValue.length ? objectValue[index]! : UNKNOWN_AST_VALUE;
      }
      if (isStaticAstObject(objectValue) && Object.hasOwn(objectValue, propertyName)) {
        return objectValue[propertyName]!;
      }
    }
    return UNKNOWN_AST_VALUE;
  } finally {
    active.delete(node);
  }
}

function unwrapAstExpression(node: TypeScriptAstNode | undefined): TypeScriptAstNode | undefined {
  let current = node;
  while (current && [
    "ParenthesizedExpression", "TSAsExpression", "TSInstantiationExpression", "TSNonNullExpression",
    "TSSatisfiesExpression", "TSTypeAssertion", "TypeCastExpression",
  ].includes(current.type)) {
    current = astNode(current.expression);
  }
  return current;
}

function staticAstCalleeName(
  callee: TypeScriptAstNode,
  scope: StaticAstScope,
  active?: Set<TypeScriptAstNode>,
  depth?: number,
): string | typeof UNKNOWN_AST_VALUE {
  if (callee.type === "Identifier") return String(callee.name);
  return isMemberAstNode(callee)
    ? staticAstMemberName(callee, scope, active, depth)
    : UNKNOWN_AST_VALUE;
}

function staticAstMemberName(
  member: TypeScriptAstNode,
  scope: StaticAstScope,
  active = new Set<TypeScriptAstNode>(),
  depth = 0,
): string | typeof UNKNOWN_AST_VALUE {
  const property = astNode(member.property);
  if (!property) return UNKNOWN_AST_VALUE;
  if (member.computed !== true && property.type === "Identifier") return String(property.name);
  if (member.computed !== true && property.type === "PrivateName") {
    const identifier = astNode(property.id);
    return identifier?.type === "Identifier" ? `#${String(identifier.name)}` : UNKNOWN_AST_VALUE;
  }
  const value = evaluateStaticAst(property, scope, active, depth + 1);
  return typeof value === "string" || typeof value === "number" ? String(value) : UNKNOWN_AST_VALUE;
}

function staticAstPropertyName(
  property: TypeScriptAstNode,
  scope: StaticAstScope,
  active = new Set<TypeScriptAstNode>(),
  depth = 0,
): string | typeof UNKNOWN_AST_VALUE {
  const key = astNode(property.key);
  if (!key) return UNKNOWN_AST_VALUE;
  if (property.computed !== true && key.type === "Identifier") return String(key.name);
  if (property.computed !== true && key.type === "StringLiteral") return String(key.value);
  if (property.computed !== true && key.type === "NumericLiteral") return String(key.value);
  const value = evaluateStaticAst(key, scope, active, depth + 1);
  return typeof value === "string" || typeof value === "number" ? String(value) : UNKNOWN_AST_VALUE;
}

function isPureStaticBuilderCall(
  callee: TypeScriptAstNode,
  name: string | typeof UNKNOWN_AST_VALUE,
  scope: StaticAstScope,
): boolean {
  if (name === UNKNOWN_AST_VALUE) return false;
  if (isIdentityWrapperCall(callee, name, scope)) return true;
  if (!["concat", "join"].includes(name) || !isMemberAstNode(callee)) return false;
  const receiver = astNode(callee.object);
  const value = receiver ? evaluateStaticAst(receiver, scope) : UNKNOWN_AST_VALUE;
  return name === "join" ? Array.isArray(value) : Array.isArray(value) || typeof value === "string";
}

function isIdentityWrapperCall(
  callee: TypeScriptAstNode,
  name: string | typeof UNKNOWN_AST_VALUE,
  scope: StaticAstScope,
): boolean {
  if (callee.type === "Identifier") {
    const binding = resolveStaticAstBinding(scope, String(callee.name));
    if (binding !== undefined && binding !== DYNAMIC_AST_BINDING && binding.kind === "import" &&
      binding.importedName === "deepFreeze" && astImportTarget(binding) === engineModuleSourceRelative("integrity.ts")) {
      return true;
    }
  }
  if (name !== "freeze" || !isMemberAstNode(callee)) return false;
  const object = unwrapAstExpression(astNode(callee.object));
  return object?.type === "Identifier" && String(object.name) === "Object" &&
    resolveStaticAstBinding(scope, "Object") === undefined;
}

function astImportTarget(binding: ImportedAstBinding): string {
  if (!binding.source.startsWith(".")) return binding.source;
  return relative("/", resolve("/", dirname(binding.fromPath), binding.source)).split(sep).join("/");
}

function isCentralPolicyGitExecutable(expression: TypeScriptAstNode, scope: StaticAstScope): boolean {
  const properties: string[] = [];
  let current = unwrapAstExpression(expression);
  while (current && isMemberAstNode(current)) {
    const property = staticAstMemberName(current, scope);
    if (property === UNKNOWN_AST_VALUE) return false;
    properties.push(property);
    current = unwrapAstExpression(astNode(current.object));
  }
  if (current?.type !== "Identifier" || String(current.name) !== "ROOT_POLICY" ||
    properties.reverse().join(".") !== "verification.candidateFormat.gitIdentity.executablePath") {
    return false;
  }
  const binding = resolveStaticAstBinding(scope, "ROOT_POLICY");
  return binding !== undefined && binding !== DYNAMIC_AST_BINDING && binding.kind === "import" &&
    binding.importedName === "ROOT_POLICY" &&
    astImportTarget(binding) === engineModuleSourceRelative("root-policy.ts");
}

function isImportedCurrentNodeExecutable(expression: TypeScriptAstNode, scope: StaticAstScope): boolean {
  const node = unwrapAstExpression(expression);
  if (node?.type !== "Identifier" || String(node.name) !== "execPath") return false;
  const binding = resolveStaticAstBinding(scope, "execPath");
  return binding !== undefined && binding !== DYNAMIC_AST_BINDING && binding.kind === "import" &&
    binding.importedName === "execPath" && astImportTarget(binding) === "node:process";
}

function isProcessExecPathMember(expression: TypeScriptAstNode, scope: StaticAstScope): boolean {
  const node = unwrapAstExpression(expression);
  if (node?.type !== "MemberExpression" || node.computed === true) return false;
  const object = unwrapAstExpression(astNode(node.object));
  const property = astNode(node.property);
  const objectIdentity = object ? resolveAstIntrinsicIdentity(object, scope) : undefined;
  return objectIdentity === "process" && property?.type === "Identifier" && String(property.name) === "execPath";
}

const GOVERNED_RUNTIME_EXECUTION_SINK_PATHS = new Set([
  "src/process/pinned-process-internal.ts",
  "scripts/verification/command-effect-inventory.ts",
  "src/tools/built-in-tools.ts",
  "src/git/git-adapter.ts",
  "scripts/tooling/migration-write-authority-genesis.ts",
]);

function isGovernedRuntimeExecutionSinkPath(path: string): boolean {
  return GOVERNED_RUNTIME_EXECUTION_SINK_PATHS.has(path);
}

type PureIntrinsicApplyTarget = "array-buffer-getter" | "typed-array-getter" | "typed-array-setter";

function isAdmittedPureIntrinsicApply(call: TypeScriptAstNode, scope: StaticAstScope): boolean {
  const argumentsList = astNodeArray(call.arguments);
  if (argumentsList.length !== 3) return false;
  const [targetExpression, receiver, appliedArguments] = argumentsList;
  if (!targetExpression || !receiver || !appliedArguments || appliedArguments.type !== "ArrayExpression") return false;
  const target = pureIntrinsicApplyTarget(targetExpression, scope);
  if (!target) return false;
  const elements = astNodeArray(appliedArguments.elements);
  if (target === "typed-array-getter") {
    return elements.length === 0 && isValidatedIntrinsicReceiver(receiver, "typed-array", scope);
  }
  if (target === "array-buffer-getter") {
    return elements.length === 0 && isValidatedIntrinsicReceiver(receiver, "array-buffer", scope);
  }
  return elements.length === 1 && isExactUint8ArrayConstruction(receiver, scope) &&
    isValidatedIntrinsicReceiver(elements[0]!, "typed-array", scope);
}

function pureIntrinsicApplyTarget(
  expression: TypeScriptAstNode,
  scope: StaticAstScope,
  active = new Set<string>(),
): PureIntrinsicApplyTarget | undefined {
  const node = unwrapAstExpression(expression);
  if (!node) return undefined;
  if (node.type === "Identifier") {
    const name = String(node.name);
    if (active.has(name)) return undefined;
    const binding = resolveStaticAstBinding(scope, name);
    if (!binding || binding === DYNAMIC_AST_BINDING || binding.kind !== "constant") return undefined;
    active.add(name);
    const target = pureIntrinsicApplyTarget(binding.initializer, binding.scope, active);
    active.delete(name);
    return target;
  }
  if (staticIntrinsicMemberPath(node, scope) === "Uint8Array.prototype.set") return "typed-array-setter";
  if (node.type !== "CallExpression" && node.type !== "OptionalCallExpression") return undefined;
  const callee = unwrapAstExpression(astNode(node.callee));
  if (callee?.type !== "Identifier" || !hasPureIntrinsicGetterFactory(scope, String(callee.name))) {
    return undefined;
  }
  const argumentsList = astNodeArray(node.arguments);
  if (argumentsList.length !== 2) return undefined;
  const owner = intrinsicGetterOwner(argumentsList[0]!, scope);
  const property = evaluateStaticAst(argumentsList[1]!, scope);
  if (owner === "typed-array" && ["buffer", "byteLength", "byteOffset"].includes(String(property))) {
    return "typed-array-getter";
  }
  if (owner === "array-buffer" && ["detached", "resizable"].includes(String(property))) {
    return "array-buffer-getter";
  }
  return undefined;
}

function intrinsicGetterOwner(
  expression: TypeScriptAstNode,
  scope: StaticAstScope,
  active = new Set<string>(),
): "array-buffer" | "typed-array" | undefined {
  const node = unwrapAstExpression(expression);
  if (!node) return undefined;
  if (staticIntrinsicMemberPath(node, scope) === "ArrayBuffer.prototype") return "array-buffer";
  if (node.type === "Identifier") {
    const name = String(node.name);
    if (active.has(name)) return undefined;
    const binding = resolveStaticAstBinding(scope, name);
    if (!binding || binding === DYNAMIC_AST_BINDING || binding.kind !== "constant") return undefined;
    active.add(name);
    const owner = intrinsicGetterOwner(binding.initializer, binding.scope, active);
    active.delete(name);
    return owner;
  }
  if (node.type !== "CallExpression" && node.type !== "OptionalCallExpression") return undefined;
  const callee = unwrapAstExpression(astNode(node.callee));
  const argumentsList = astNodeArray(node.arguments);
  return callee && staticIntrinsicMemberPath(callee, scope) === "Object.getPrototypeOf" &&
    argumentsList.length === 1 && staticIntrinsicMemberPath(argumentsList[0], scope) === "Uint8Array.prototype"
    ? "typed-array"
    : undefined;
}

function staticIntrinsicMemberPath(
  expression: TypeScriptAstNode | undefined,
  scope: StaticAstScope,
): string | undefined {
  const node = unwrapAstExpression(expression);
  if (!node) return undefined;
  if (node.type === "Identifier") {
    const name = String(node.name);
    return resolveStaticAstBinding(scope, name) === undefined ? name : undefined;
  }
  if (!isMemberAstNode(node)) return undefined;
  const object = staticIntrinsicMemberPath(astNode(node.object), scope);
  const property = staticAstMemberName(node, scope);
  return object && property !== UNKNOWN_AST_VALUE ? `${object}.${property}` : undefined;
}

function isExactUint8ArrayConstruction(
  expression: TypeScriptAstNode,
  scope: StaticAstScope,
  active = new Set<string>(),
): boolean {
  const node = unwrapAstExpression(expression);
  if (node?.type === "Identifier") {
    const name = String(node.name);
    for (let current: StaticAstScope | undefined = scope; current; current = current.parent) {
      if (current.exactUint8ArrayValues.has(name)) return true;
    }
    if (active.has(name)) return false;
    const binding = resolveStaticAstBinding(scope, name);
    if (!binding || binding === DYNAMIC_AST_BINDING || binding.kind !== "constant") return false;
    active.add(name);
    const exact = isExactUint8ArrayConstruction(binding.initializer, binding.scope, active);
    active.delete(name);
    return exact;
  }
  const callee = node?.type === "NewExpression" ? unwrapAstExpression(astNode(node.callee)) : undefined;
  return callee?.type === "Identifier" && String(callee.name) === "Uint8Array" &&
    resolveStaticAstBinding(scope, "Uint8Array") === undefined;
}

function registerExactUint8ArrayValue(
  declarator: TypeScriptAstNode,
  scope: StaticAstScope,
  immutable: boolean,
): void {
  const identifier = astNode(declarator.id);
  const initializer = unwrapAstExpression(astNode(declarator.init));
  if (!immutable || identifier?.type !== "Identifier" || initializer?.type !== "NewExpression") return;
  const callee = unwrapAstExpression(astNode(initializer.callee));
  if (callee?.type === "Identifier" && String(callee.name) === "Uint8Array" &&
    resolveStaticAstBinding(scope, "Uint8Array") === undefined) {
    scope.exactUint8ArrayValues.add(String(identifier.name));
  }
}

function isValidatedIntrinsicReceiver(
  expression: TypeScriptAstNode,
  expected: "array-buffer" | "typed-array",
  scope: StaticAstScope,
): boolean {
  const node = unwrapAstExpression(expression);
  if (node?.type !== "Identifier") return false;
  const name = String(node.name);
  for (let current: StaticAstScope | undefined = scope; current; current = current.parent) {
    if (current.validatedIntrinsicReceivers.get(name) === expected) return true;
  }
  return false;
}

function registerIntrinsicReceiverValidation(statement: TypeScriptAstNode, scope: StaticAstScope): void {
  if (statement.alternate !== null && statement.alternate !== undefined) return;
  const consequent = astNode(statement.consequent);
  if (!consequent || !statementAlwaysThrows(consequent)) return;
  const test = astNode(statement.test);
  if (!test) return;
  const pending = [test];
  const visited = new Set<TypeScriptAstNode>();
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (visited.has(node)) continue;
    visited.add(node);
    if (node.type === "UnaryExpression" && node.operator === "!") {
      const call = unwrapAstExpression(astNode(node.argument));
      const validation = call ? intrinsicReceiverValidation(call, scope) : undefined;
      if (validation) scope.validatedIntrinsicReceivers.set(validation.name, validation.kind);
    }
    pending.push(...astChildNodes(node));
  }
}

function intrinsicReceiverValidation(
  expression: TypeScriptAstNode,
  scope: StaticAstScope,
): Readonly<{ kind: "array-buffer" | "typed-array"; name: string }> | undefined {
  if (expression.type !== "CallExpression" && expression.type !== "OptionalCallExpression") return undefined;
  const callee = unwrapAstExpression(astNode(expression.callee));
  if (!callee || !isMemberAstNode(callee)) return undefined;
  const receiver = unwrapAstExpression(astNode(callee.object));
  if (receiver?.type !== "Identifier") return undefined;
  const binding = resolveStaticAstBinding(scope, String(receiver.name));
  if (!binding || binding === DYNAMIC_AST_BINDING || binding.kind !== "import" ||
    binding.source !== "node:util" || binding.importedName !== "types") return undefined;
  const member = staticAstMemberName(callee, scope);
  const subject = astNodeArray(expression.arguments)[0];
  if (subject?.type !== "Identifier") return undefined;
  if (member === "isUint8Array") return { kind: "typed-array", name: String(subject.name) };
  if (member === "isArrayBuffer") return { kind: "array-buffer", name: String(subject.name) };
  return undefined;
}

function statementAlwaysThrows(statement: TypeScriptAstNode): boolean {
  if (statement.type === "ThrowStatement") return true;
  if (statement.type !== "BlockStatement") return false;
  const body = astNodeArray(statement.body);
  return body.length === 1 && body[0]?.type === "ThrowStatement";
}

function hasPureIntrinsicGetterFactory(scope: StaticAstScope, name: string): boolean {
  for (let current: StaticAstScope | undefined = scope; current; current = current.parent) {
    if (current.pureIntrinsicGetterFactories.has(name)) return true;
  }
  return false;
}

function isPureIntrinsicGetterFactory(declaration: TypeScriptAstNode): boolean {
  const parameters = astNodeArray(declaration.params);
  const owner = parameters[0];
  const property = parameters[1];
  const body = astNode(declaration.body);
  if (parameters.length !== 2 || owner?.type !== "Identifier" || property?.type !== "Identifier" ||
    body?.type !== "BlockStatement") return false;
  const statements = astNodeArray(body.body);
  const variable = statements[0];
  const guard = statements[1];
  const returned = statements[2];
  if (statements.length !== 3 || variable?.type !== "VariableDeclaration" || variable.kind !== "const" ||
    guard?.type !== "IfStatement" || returned?.type !== "ReturnStatement") return false;
  const declarations = astNodeArray(variable.declarations);
  const binding = declarations.length === 1 ? astNode(declarations[0]?.id) : undefined;
  const initializer = declarations.length === 1 ? unwrapAstExpression(astNode(declarations[0]?.init)) : undefined;
  const getterProperty = initializer && isMemberAstNode(initializer) ? astNode(initializer.property) : undefined;
  if (binding?.type !== "Identifier" || !initializer || !isMemberAstNode(initializer) ||
    initializer.computed === true || getterProperty?.type !== "Identifier" ||
    String(getterProperty.name) !== "get") return false;
  const descriptorCall = unwrapAstExpression(astNode(initializer.object));
  if (descriptorCall?.type !== "CallExpression" && descriptorCall?.type !== "OptionalCallExpression") return false;
  const descriptorCallee = unwrapAstExpression(astNode(descriptorCall.callee));
  const descriptorArguments = astNodeArray(descriptorCall.arguments);
  if (!descriptorCallee || intrinsicMemberPathWithoutBindings(descriptorCallee) !== "Object.getOwnPropertyDescriptor" ||
    descriptorArguments.length !== 2 || descriptorArguments[0]?.type !== "Identifier" ||
    descriptorArguments[1]?.type !== "Identifier" ||
    String(descriptorArguments[0].name) !== String(owner.name) ||
    String(descriptorArguments[1].name) !== String(property.name)) return false;
  const guardTest = unwrapAstExpression(astNode(guard.test));
  const guarded = guardTest?.type === "UnaryExpression" && guardTest.operator === "!"
    ? unwrapAstExpression(astNode(guardTest.argument))
    : undefined;
  const returnArgument = unwrapAstExpression(astNode(returned.argument));
  return guarded?.type === "Identifier" && returnArgument?.type === "Identifier" &&
    String(guarded.name) === String(binding.name) && String(returnArgument.name) === String(binding.name) &&
    guard.alternate == null && statementAlwaysThrows(astNode(guard.consequent)!);
}

function intrinsicMemberPathWithoutBindings(expression: TypeScriptAstNode | undefined): string | undefined {
  const node = unwrapAstExpression(expression);
  if (node?.type === "Identifier") return String(node.name);
  if (!node || !isMemberAstNode(node)) return undefined;
  const object = intrinsicMemberPathWithoutBindings(astNode(node.object));
  const property = astNode(node.property);
  const name = node.computed !== true && property?.type === "Identifier" ? String(property.name) :
    property?.type === "StringLiteral" ? String(property.value) : undefined;
  return object && name ? `${object}.${name}` : undefined;
}

function isReflectApplyAstCall(
  callee: TypeScriptAstNode,
  name: string | typeof UNKNOWN_AST_VALUE,
  scope: StaticAstScope,
): boolean {
  if (name !== "apply" || !isMemberAstNode(callee)) return false;
  const object = unwrapAstExpression(astNode(callee.object));
  return object?.type === "Identifier" && String(object.name) === "Reflect" &&
    resolveStaticAstBinding(scope, "Reflect") === undefined;
}

function resolveStaticAstBinding(
  scope: StaticAstScope,
  name: string,
): StaticAstBinding | typeof DYNAMIC_AST_BINDING | undefined {
  for (let current: StaticAstScope | undefined = scope; current; current = current.parent) {
    if (current.bindings.has(name)) return current.bindings.get(name);
  }
  return undefined;
}

function isAstVariableName(scope: StaticAstScope, name: string): boolean {
  for (let current: StaticAstScope | undefined = scope; current; current = current.parent) {
    if (current.variableNames.has(name)) return true;
    if (current.bindings.has(name)) return false;
  }
  return false;
}

function astVariableInitializer(scope: StaticAstScope, name: string): TypeScriptAstNode | undefined {
  for (let current: StaticAstScope | undefined = scope; current; current = current.parent) {
    if (current.variableNames.has(name)) return current.variableInitializers.get(name);
    if (current.bindings.has(name)) return undefined;
  }
  return undefined;
}

function isUnmodeledStaticAstConstruction(
  expression: TypeScriptAstNode,
  scope: StaticAstScope,
  active = new Set<TypeScriptAstNode>(),
  depth = 0,
): boolean {
  if (depth > AST_EVALUATION_MAXIMUM_DEPTH) return true;
  const node = unwrapAstExpression(expression);
  if (!node || active.has(node)) return true;
  active.add(node);
  try {
    if (node.type === "BinaryExpression") {
      const operands = [astNode(node.left), astNode(node.right)];
      return operands.every((operand) => operand !== undefined &&
        (evaluateStaticAst(operand, scope) !== UNKNOWN_AST_VALUE ||
          isUnmodeledStaticAstConstruction(operand, scope, active, depth + 1)));
    }
    if (node.type === "TemplateLiteral") {
      return astNodeArray(node.expressions).every((substitution) =>
        evaluateStaticAst(substitution, scope) !== UNKNOWN_AST_VALUE ||
        isUnmodeledStaticAstConstruction(substitution, scope, active, depth + 1)
      );
    }
    if (node.type === "ArrayExpression" || node.type === "ObjectExpression") {
      return true;
    }
    if (node.type === "Identifier") {
      const initializer = astVariableInitializer(scope, String(node.name));
      return initializer !== undefined &&
        isUnmodeledStaticAstConstruction(initializer, scope, active, depth + 1);
    }
    if (node.type === "CallExpression" || node.type === "OptionalCallExpression") {
      const callee = unwrapAstExpression(astNode(node.callee));
      if (!callee) return true;
      const name = staticAstCalleeName(callee, scope);
      return isIdentityWrapperCall(callee, name, scope) ||
        (isMemberAstNode(callee) && name !== UNKNOWN_AST_VALUE && ["concat", "join"].includes(name));
    }
    if (isMemberAstNode(node)) {
      const object = astNode(node.object);
      return object !== undefined && isUnmodeledStaticAstConstruction(object, scope, active, depth + 1);
    }
    return false;
  } finally {
    active.delete(node);
  }
}

function isStaticAstScalar(
  value: StaticAstValue | typeof UNKNOWN_AST_VALUE,
): value is string | number | boolean | null {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function isStaticAstObject(
  value: StaticAstValue | typeof UNKNOWN_AST_VALUE,
): value is StaticAstObject {
  return value !== UNKNOWN_AST_VALUE && value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMemberAstNode(node: TypeScriptAstNode): boolean {
  return node.type === "MemberExpression" || node.type === "OptionalMemberExpression";
}

function astNode(value: unknown): TypeScriptAstNode | undefined {
  return value !== null && typeof value === "object" && typeof (value as { type?: unknown }).type === "string"
    ? value as TypeScriptAstNode
    : undefined;
}

function astNodeArray(value: unknown): readonly TypeScriptAstNode[] {
  return Array.isArray(value) ? value.map(astNode).filter((entry): entry is TypeScriptAstNode => entry !== undefined) : [];
}

function astChildNodes(node: TypeScriptAstNode): readonly TypeScriptAstNode[] {
  const children: TypeScriptAstNode[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (["comments", "errors", "extra", "loc", "tokens", "type"].includes(key)) continue;
    const child = astNode(value);
    if (child) children.push(child);
    else children.push(...astNodeArray(value));
  }
  return children;
}

function astRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function boundedStaticAstString(value: string): string | typeof UNKNOWN_AST_VALUE {
  return Buffer.byteLength(value, "utf8") <= ROOT_POLICY.forensics.limits.maximumCanonicalBytes
    ? value
    : UNKNOWN_AST_VALUE;
}

function astWithinNodeBudget(root: TypeScriptAstNode, maximumNodes: number): boolean {
  const pending = [root];
  const visited = new Set<TypeScriptAstNode>();
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (visited.has(node)) continue;
    visited.add(node);
    if (visited.size > maximumNodes) return false;
    pending.push(...astChildNodes(node));
  }
  return true;
}

function collectMutatedAstNames(root: TypeScriptAstNode): ReadonlySet<string> {
  const names = new Set<string>();
  const aliases = new Map<string, Set<string>>();
  const linkAliases = (left: string, right: string): void => {
    if (left === right) return;
    const leftEdges = aliases.get(left) ?? new Set<string>();
    const rightEdges = aliases.get(right) ?? new Set<string>();
    leftEdges.add(right);
    rightEdges.add(left);
    aliases.set(left, leftEdges);
    aliases.set(right, rightEdges);
  };
  const mutatingMethods = new Set([
    "copyWithin", "fill", "pop", "push", "reverse", "shift", "sort", "splice", "unshift",
  ]);
  const pending = [root];
  const visited = new Set<TypeScriptAstNode>();
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (visited.has(node)) continue;
    visited.add(node);
    if (node.type === "AssignmentExpression" || node.type === "UpdateExpression") {
      const target = unwrapAstExpression(astNode(node.left) ?? astNode(node.argument));
      if (target?.type === "Identifier") names.add(String(target.name));
      else if (target && isMemberAstNode(target)) {
        const object = unwrapAstExpression(astNode(target.object));
        if (object?.type === "Identifier") names.add(String(object.name));
      }
      if (node.type === "AssignmentExpression" && target?.type === "Identifier") {
        const source = unwrapAstExpression(astNode(node.right));
        if (source?.type === "Identifier") linkAliases(String(target.name), String(source.name));
      }
    }
    if ((node.type === "CallExpression" || node.type === "OptionalCallExpression")) {
      const callee = unwrapAstExpression(astNode(node.callee));
      if (callee && isMemberAstNode(callee)) {
        const property = astNode(callee.property);
        const method = callee.computed !== true && property?.type === "Identifier"
          ? String(property.name)
          : property?.type === "StringLiteral" ? String(property.value) : undefined;
        const object = unwrapAstExpression(astNode(callee.object));
        if (method && mutatingMethods.has(method) && object?.type === "Identifier") {
          names.add(String(object.name));
        }
      }
    }
    if (node.type === "VariableDeclarator") {
      const target = unwrapAstExpression(astNode(node.id));
      const source = unwrapAstExpression(astNode(node.init));
      if (target?.type === "Identifier" && source?.type === "Identifier") {
        linkAliases(String(target.name), String(source.name));
      }
    }
    pending.push(...astChildNodes(node));
  }
  const pendingNames = [...names];
  while (pendingNames.length > 0) {
    const name = pendingNames.pop()!;
    for (const alias of aliases.get(name) ?? []) {
      if (names.has(alias)) continue;
      names.add(alias);
      pendingNames.push(alias);
    }
  }
  return names;
}
