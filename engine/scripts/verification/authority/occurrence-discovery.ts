import { canonicalDomainHash, deepFreeze, sha256 } from "../../../src/kernel/integrity.ts";
import type {
  AuthorityOccurrence,
  AuthorityRegistry,
  AuthorityRoleException,
  AuthorityRoute,
} from "./contracts.ts";
import {
  AUTHORITY_EXCEPTION_SELECTOR_PATTERN,
  exceptionKey,
  exceptionRoleProven,
} from "./exceptions.ts";
import {
  type ResolvedAuthority,
} from "./semantic-resolution.ts";
import { staticString } from "./literal-semantics.ts";
import {
  interfaceBodyShape,
  isZodShapeArgument,
  isZodStrictObjectCall,
  objectShape,
  staticPropertyName,
  type Shape,
  type ShapeField,
  typeShape,
  zodShape,
} from "./shape-semantics.ts";
import { deduplicateOccurrences, selectorForNode } from "./occurrence-selectors.ts";
import {
  SHA256_PATTERN,
  codePointCompare,
  exactPath,
  isRecord,
  nonempty,
  nonemptyEvidenceLinks,
  sameOrdered,
} from "./shared.ts";
import {
  astChildren,
  astNode,
  astNodeArray,
  identifierResolvesToImport,
  isIdentifierReference,
  type AstNode,
  type ImportBinding,
  type ModuleFacts,
} from "./typescript-adapter.ts";

type ShapeCandidate = Readonly<{
  path: string;
  selector: string;
  node: AstNode;
  shape: Shape;
  kind: "object" | "type" | "zod";
  materializedAuthorityIds: readonly string[];
}>;
type LiteralCandidate = Readonly<{
  path: string;
  selector: string;
  node: AstNode;
  value: string;
}>;

export function discoverAuthorityOccurrences(
  registry: AuthorityRegistry,
  modules: ReadonlyMap<string, ModuleFacts>,
  resolved: ReadonlyMap<string, ResolvedAuthority>,
  violations: string[],
): readonly AuthorityOccurrence[] {
  validateSupportedAuthoritySyntax(modules, resolved, violations);
  return discoverOccurrences(registry, modules, resolved, violations);
}

function validateSupportedAuthoritySyntax(
  modules: ReadonlyMap<string, ModuleFacts>,
  resolved: ReadonlyMap<string, ResolvedAuthority>,
  violations: string[],
): void {
  for (const module of modules.values()) {
    for (const node of module.nodes) {
      if (isZodStrictObjectCall(node, module) && zodShape(node, module, new Set()) === undefined) {
        for (const authority of resolved.values()) {
          if (authority.route.kind === "zod-strict-object" && node !== authority.ownerNode) {
            violations.push(`authority_shape_unsupported:${authority.route.id}:${module.source.path}:` +
              selectorForNode(module, node, "zod"));
          }
        }
      }
      if (node.type === "ObjectExpression" && objectShape(node, module, new Set()) === undefined) {
        for (const authorityId of referencedMaterializationAuthorityIds(
          node, module, [...resolved.values()].map((entry) => entry.route),
        )) {
          violations.push(`authority_shape_unsupported:${authorityId}:${module.source.path}:` +
            selectorForNode(module, node, "object"));
        }
        const keys = staticObjectKeys(node, module);
        for (const authority of resolved.values()) {
          if (authority.route.kind === "zod-strict-object" &&
            keys.some((key) => Object.hasOwn(authority.value as Shape, key))) {
            violations.push(`authority_shape_unsupported:${authority.route.id}:${module.source.path}:` +
              selectorForNode(module, node, "object"));
          }
        }
      }
      if ((node.type === "TSTypeAliasDeclaration" || node.type === "TSInterfaceDeclaration") &&
        (node.type === "TSTypeAliasDeclaration"
          ? typeShape(astNode(node.typeAnnotation), module, new Set())
          : interfaceBodyShape(astNode(node.body), module, new Set())) === undefined) {
        const fragments = [...staticStringFragments(node), ...staticDeclaredKeys(node, module)];
        for (const authority of resolved.values()) {
          if (authority.route.kind === "zod-strict-object" &&
            fragments.some((fragment) => Object.hasOwn(authority.value as Shape, fragment))) {
            violations.push(`authority_shape_unsupported:${authority.route.id}:${module.source.path}:` +
              selectorForNode(module, node, "type"));
          }
        }
      }
      if (!isStringConstruction(node) || staticString(node, module.constants, new Set()) !== undefined ||
        !isAssignedValue(node, module)) continue;
      const fragments = staticStringFragments(node).join("");
      for (const authority of resolved.values()) {
        if (authority.route.kind !== "literal" || module.source.path === authority.route.owner.path &&
          node === authority.ownerNode) continue;
        const expected = authority.value as string;
        const familyPrefix = versionFamilyPrefix(expected);
        const familyBase = familyPrefix?.slice(0, -2);
        // Unknown assigned string computations are blocking even when their
        // literal fragments are encoded; the analyzer cannot prove inequality.
        if (fragments.includes(expected) ||
          familyPrefix !== undefined && fragments.includes(familyPrefix) ||
          familyBase !== undefined && fragments.includes(familyBase)) {
          violations.push(`authority_literal_unsupported:${authority.route.id}:${module.source.path}:` +
            selectorForNode(module, node, "literal"));
        }
      }
    }
  }
}

function discoverOccurrences(
  registry: AuthorityRegistry,
  modules: ReadonlyMap<string, ModuleFacts>,
  resolved: ReadonlyMap<string, ResolvedAuthority>,
  violations: string[],
): readonly AuthorityOccurrence[] {
  const occurrences: AuthorityOccurrence[] = [];
  const exceptionMap = validExceptionMap(registry, modules);
  for (const authority of resolved.values()) {
    occurrences.push({
      authorityId: authority.route.id,
      path: authority.route.owner.path,
      selector: `export:${authority.route.owner.exportName}`,
      occurrenceKind: authority.route.kind === "literal" ? "literal" : "shape",
      role: "authority",
      semanticFingerprint: authority.semanticFingerprint,
    });
    for (const module of modules.values()) {
      for (const [localName, binding] of module.imports) {
        if (binding.sourcePath !== authority.route.owner.path ||
          binding.exportName !== authority.route.owner.exportName) continue;
        if (!module.nodes.some((node) => node.type === "Identifier" && node.name === localName &&
          isIdentifierReference(node, module) && identifierResolvesToImport(node, module, binding))) continue;
        occurrences.push({
          authorityId: authority.route.id,
          path: module.source.path,
          selector: `import:${localName}`,
          occurrenceKind: "reference",
          role: "reference",
          semanticFingerprint: authority.semanticFingerprint,
        });
      }
      if (authority.route.kind === "literal") {
        const expected = authority.value as string;
        for (const candidate of literalCandidates(module)) {
          if (candidate.node === authority.ownerNode) continue;
          if (candidate.value !== expected && !sameVersionFamily(candidate.value, expected)) continue;
          const proposed = exceptionMap.get(exceptionKey(authority.route.id, candidate.path, candidate.selector));
          const candidateFingerprint = canonicalDomainHash("authority-graph/literal/v1", candidate.value);
          const exception = proposed && exceptionRoleProven(proposed, candidateFingerprint, resolved)
            ? proposed : undefined;
          occurrences.push({
            authorityId: authority.route.id,
            path: candidate.path,
            selector: candidate.selector,
            occurrenceKind: "literal",
            role: exception?.role ?? "duplicate",
            semanticFingerprint: candidateFingerprint,
          });
          if (!exception) {
            violations.push(`${candidate.value === expected ? "authority_literal_duplicate" : "authority_literal_stale"}` +
              `:${authority.route.id}:${candidate.path}:${candidate.selector}`);
          }
        }
      } else {
        const expected = authority.value as Shape;
        for (const candidate of shapeCandidates(module, registry.authorities)) {
          const materialized = candidate.kind === "object" &&
            candidate.materializedAuthorityIds.includes(authority.route.id);
          if (candidate.node === authority.ownerNode || !relatedShape(candidate.shape, expected, materialized)) continue;
          const proposed = exceptionMap.get(exceptionKey(authority.route.id, candidate.path, candidate.selector));
          const candidateFingerprint = canonicalDomainHash("authority-graph/shape/v1", candidate.shape);
          const exception = proposed && exceptionRoleProven(proposed, candidateFingerprint, resolved)
            ? proposed : undefined;
          occurrences.push({
            authorityId: authority.route.id,
            path: candidate.path,
            selector: candidate.selector,
            occurrenceKind: "shape",
            role: materialized ? "materialization" : exception?.role ?? "duplicate",
            semanticFingerprint: candidateFingerprint,
          });
          if (!materialized && !exception) {
            violations.push(`authority_shape_duplicate:${authority.route.id}:${candidate.path}:${candidate.selector}`);
          }
        }
      }
    }
  }
  return deepFreeze(deduplicateOccurrences(occurrences));
}

function literalCandidates(module: ModuleFacts): readonly LiteralCandidate[] {
  const candidates: LiteralCandidate[] = [];
  for (const node of module.nodes) {
    if (!isStringExpression(node) || !isValueExpression(node, module.parents.get(node))) continue;
    const parent = module.parents.get(node);
    if (parent && isStringExpression(parent) && staticString(parent, module.constants, new Set()) !== undefined) continue;
    const value = staticString(node, module.constants, new Set());
    if (value !== undefined) candidates.push({
      path: module.source.path,
      selector: selectorForNode(module, node, "literal"),
      node,
      value,
    });
  }
  return candidates;
}

function shapeCandidates(module: ModuleFacts, routes: readonly AuthorityRoute[]): readonly ShapeCandidate[] {
  const candidates: ShapeCandidate[] = [];
  for (const node of module.nodes) {
    let shape: Shape | undefined;
    let kind: ShapeCandidate["kind"] | undefined;
    if (node.type === "TSTypeAliasDeclaration") {
      shape = typeShape(astNode(node.typeAnnotation), module, new Set());
      kind = "type";
    } else if (node.type === "TSInterfaceDeclaration") {
      if (astNodeArray(node.extends).length === 0) shape = interfaceBodyShape(astNode(node.body), module, new Set());
      kind = "type";
    } else if (isZodStrictObjectCall(node, module)) {
      shape = zodShape(node, module, new Set());
      kind = "zod";
    } else if (node.type === "ObjectExpression" && !isZodShapeArgument(node, module.parents.get(node), module)) {
      shape = objectShape(node, module, new Set());
      kind = "object";
    }
    if (!shape || !kind || Object.keys(shape).length === 0) continue;
    candidates.push({
      path: module.source.path,
      selector: selectorForNode(module, node, kind),
      node,
      shape,
      kind,
      materializedAuthorityIds: kind === "object"
        ? referencedMaterializationAuthorityIds(node, module, routes) : [],
    });
  }
  return candidates;
}

function referencedMaterializationAuthorityIds(
  node: AstNode,
  module: ModuleFacts,
  routes: readonly AuthorityRoute[],
): readonly string[] {
  const parent = module.parents.get(node);
  if (parent?.type !== "CallExpression" && parent?.type !== "OptionalCallExpression") return [];
  if (astNodeArray(parent.arguments)[0] !== node) return [];
  const callee = astNode(parent.callee);
  if (callee?.type !== "MemberExpression" && callee?.type !== "OptionalMemberExpression") return [];
  const method = astNode(callee.property);
  if (callee.computed || method?.type !== "Identifier" ||
    !["parse", "parseAsync", "safeParse", "safeParseAsync"].includes(String(method.name))) return [];
  const contract = astNode(callee.object);
  if (!contract) return [];
  let binding: ImportBinding | undefined;
  let exportName: string | undefined;
  if (contract.type === "Identifier") {
    binding = module.imports.get(String(contract.name));
    exportName = binding?.exportName;
    if (!binding || !identifierResolvesToImport(contract, module, binding)) return [];
  } else if (contract.type === "MemberExpression" && !contract.computed) {
    const namespace = astNode(contract.object);
    const property = astNode(contract.property);
    if (namespace?.type !== "Identifier" || property?.type !== "Identifier") return [];
    binding = module.imports.get(String(namespace.name));
    if (!binding || binding.kind !== "namespace" || !identifierResolvesToImport(namespace, module, binding)) return [];
    exportName = String(property.name);
  } else {
    return [];
  }
  return routes.filter((route) => route.kind === "zod-strict-object" &&
    route.owner.path === binding.sourcePath && route.owner.exportName === exportName
  ).map((route) => route.id).toSorted(codePointCompare);
}

function validExceptionMap(
  registry: AuthorityRegistry,
  modules: ReadonlyMap<string, ModuleFacts>,
): ReadonlyMap<string, AuthorityRoleException> {
  const map = new Map<string, AuthorityRoleException>();
  const authorityIds = new Set(registry.authorities.map((authority) => authority.id));
  for (const exception of registry.roleExceptions) {
    const module = modules.get(exception.path);
    if (!authorityIds.has(exception.authorityId) || !exactPath(exception.path) ||
      !AUTHORITY_EXCEPTION_SELECTOR_PATTERN.test(exception.selector) ||
      !SHA256_PATTERN.test(exception.sourceSha256) || !module || sha256(module.source.source) !== exception.sourceSha256 ||
      !nonempty(exception.rationale) || !nonemptyEvidenceLinks(exception.evidenceLinks) ||
      !["mutation", "historical", "distinct-domain"].includes(exception.role) ||
      exception.role === "distinct-domain" &&
        (!exception.distinctAuthorityId || exception.distinctAuthorityId === exception.authorityId ||
          !authorityIds.has(exception.distinctAuthorityId)) ||
      exception.role !== "distinct-domain" && exception.distinctAuthorityId !== undefined) continue;
    map.set(exceptionKey(exception.authorityId, exception.path, exception.selector), exception);
  }
  return map;
}

function relatedShape(candidate: Shape, authority: Shape, materialization = false): boolean {
  const authorityKeys = Object.keys(authority);
  const candidateSubsetMinimum = authorityKeys.length === 1 ? 1 : 2;
  return shapeSubset(candidate, authority, materialization, candidateSubsetMinimum) ||
    shapeSubset(authority, candidate, materialization, authorityKeys.length);
}

function shapeSubset(candidate: Shape, target: Shape, materialization: boolean, minimumKeys: number): boolean {
  const keys = Object.keys(candidate);
  if (keys.length < minimumKeys) return false;
  for (const key of keys) {
    if (!Object.hasOwn(target, key)) return false;
    const left = candidate[key];
    const right = target[key];
    if (!left || !right || !compatibleShapeField(left, right, materialization)) return false;
  }
  return true;
}

function compatibleShapeField(left: ShapeField, right: ShapeField, materialization: boolean): boolean {
  if (!compatibleValueType(left.valueType, right.valueType, materialization) ||
    !materialization && left.optional !== right.optional) return false;
  if (left.validators.length > 0 && right.validators.length > 0 && !sameOrdered(left.validators, right.validators)) {
    return false;
  }
  if (left.nested === null || right.nested === null) return left.nested === right.nested;
  return relatedShape(left.nested, right.nested, materialization);
}

function compatibleValueType(left: string, right: string, materialization: boolean): boolean {
  if (left === right) return true;
  if (materialization && (left === "unknown" || right === "unknown")) return true;
  if (left === "array:unknown" && right.startsWith("array:")) return true;
  if (right === "array:unknown" && left.startsWith("array:")) return true;
  return false;
}

function isAssignedValue(node: AstNode, module: ModuleFacts): boolean {
  let current: AstNode | undefined = node;
  while (current) {
    if (current.type === "VariableDeclarator" || current.type === "ReturnStatement") return true;
    if (current.type === "ExpressionStatement") return false;
    current = module.parents.get(current);
  }
  return false;
}

function isValueExpression(node: AstNode, parent: AstNode | undefined): boolean {
  if (!parent) return false;
  if (["ImportDeclaration", "ExportAllDeclaration"].includes(parent.type) && parent.source === node) return false;
  if ((parent.type === "ObjectProperty" || parent.type === "ObjectMethod") && parent.key === node && !parent.computed) {
    return false;
  }
  return true;
}

function isStringExpression(node: AstNode): boolean {
  return node.type === "StringLiteral" || node.type === "TemplateLiteral" || node.type === "CallExpression" ||
    node.type === "BinaryExpression" && node.operator === "+" ||
    ["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression"].includes(node.type);
}

function isStringConstruction(node: AstNode): boolean {
  return isStringExpression(node) || node.type === "CallExpression";
}

function staticStringFragments(node: AstNode): readonly string[] {
  const fragments: Array<{ start: number; value: string }> = [];
  const pending = [node];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.type === "StringLiteral") {
      fragments.push({ start: Number(current.start ?? -1), value: String(current.value) });
    } else if (current.type === "TemplateElement") {
      const value = isRecord(current.value) ? current.value : {};
      fragments.push({ start: Number(current.start ?? -1), value: String(value.cooked ?? value.raw ?? "") });
    }
    pending.push(...astChildren(current));
  }
  return fragments.toSorted((left, right) => left.start - right.start).map((entry) => entry.value);
}

function versionFamilyPrefix(value: string): string | undefined {
  return /^(.*\/v)[1-9][0-9]*$/u.exec(value)?.[1];
}

function staticObjectKeys(node: AstNode, module: ModuleFacts): readonly string[] {
  return astNodeArray(node.properties).flatMap((property) => {
    if (property.type === "SpreadElement") return [];
    const key = staticPropertyName(property) ?? computedPropertyName(property, module);
    return key === undefined ? [] : [key];
  });
}

function staticDeclaredKeys(node: AstNode, module: ModuleFacts): readonly string[] {
  const keys: string[] = [];
  const pending = [node];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.type === "TSPropertySignature") {
      const key = staticPropertyName(current) ?? computedPropertyName(current, module);
      if (key !== undefined) keys.push(key);
    }
    pending.push(...astChildren(current));
  }
  return keys;
}

function computedPropertyName(node: AstNode, module: ModuleFacts): string | undefined {
  if (!node.computed) return undefined;
  const key = astNode(node.key);
  return key ? staticString(key, module.constants, new Set()) : undefined;
}

function sameVersionFamily(left: string, right: string): boolean {
  const version = /^(.*\/v)[1-9][0-9]*$/u;
  const leftMatch = version.exec(left);
  const rightMatch = version.exec(right);
  return left !== right && leftMatch?.[1] !== undefined && leftMatch[1] === rightMatch?.[1];
}
