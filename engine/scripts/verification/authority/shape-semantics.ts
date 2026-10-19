import { deepFreeze } from "../../../src/kernel/integrity.ts";
import { staticString } from "./literal-semantics.ts";
import { codePointCompare } from "./shared.ts";
import {
  astNode,
  astNodeArray,
  identifierResolvesToImport,
  type AstNode,
  type ModuleFacts,
} from "./typescript-adapter.ts";

export type ShapeField = Readonly<{
  valueType: string;
  optional: boolean;
  readonly: boolean;
  validators: readonly string[];
  nested: Shape | null;
}>;
export type Shape = Readonly<{ [key: string]: ShapeField }>;

export function zodShape(call: AstNode, module: ModuleFacts, resolving: Set<string>): Shape | undefined {
  if (!isZodStrictObjectCall(call, module)) return undefined;
  const argument = astNodeArray(call.arguments)[0];
  return argument?.type === "ObjectExpression" ? structuralObjectShape(argument, module, resolving, "zod") : undefined;
}

export function objectShape(object: AstNode, module: ModuleFacts, resolving: Set<string>): Shape | undefined {
  return structuralObjectShape(object, module, resolving, "object");
}

function structuralObjectShape(
  object: AstNode,
  module: ModuleFacts,
  resolving: Set<string>,
  mode: "object" | "zod",
): Shape | undefined {
  const result: Record<string, ShapeField> = {};
  for (const property of astNodeArray(object.properties)) {
    if (property.type === "SpreadElement") {
      const argument = astNode(property.argument);
      if (argument?.type !== "Identifier") return undefined;
      const name = String(argument.name);
      if (resolving.has(name)) return undefined;
      const initializer = module.constants.get(name);
      if (!initializer || initializer.type !== "ObjectExpression") return undefined;
      resolving.add(name);
      const spread = structuralObjectShape(initializer, module, resolving, mode);
      resolving.delete(name);
      if (!spread) return undefined;
      Object.assign(result, spread);
      continue;
    }
    if (property.type !== "ObjectProperty" && property.type !== "ObjectMethod") return undefined;
    const key = staticPropertyName(property, module);
    if (key === undefined || Object.hasOwn(result, key)) return undefined;
    if (property.type === "ObjectMethod") {
      result[key] = shapeField("function");
      continue;
    }
    const value = astNode(property.value);
    const descriptor = mode === "zod"
      ? value ? zodValueShape(value, module, resolving) : undefined
      : value ? runtimeValueShape(value, module, resolving) : undefined;
    if (!descriptor) return undefined;
    result[key] = descriptor;
  }
  return sortedShape(result);
}

export function typeShape(node: AstNode | undefined, module: ModuleFacts, resolving: Set<string>): Shape | undefined {
  if (!node) return undefined;
  if (node.type === "TSTypeLiteral") return typeMembersShape(astNodeArray(node.members), module, resolving);
  if (node.type === "TSIntersectionType") {
    const merged: Record<string, ShapeField> = {};
    for (const member of astNodeArray(node.types)) {
      const shape = typeShape(member, module, resolving);
      if (!shape) return undefined;
      Object.assign(merged, shape);
    }
    return sortedShape(merged);
  }
  if (node.type === "TSTypeReference") {
    const typeName = astNode(node.typeName);
    const parameters = astNode(node.typeParameters ?? node.typeArguments);
    if (typeName?.type === "Identifier" && typeName.name === "Readonly") {
      const shape = typeShape(astNodeArray(parameters?.params)[0], module, resolving);
      return shape ? mapShapeFields(shape, (field) => ({ ...field, readonly: true })) : undefined;
    }
    if (typeName?.type === "Identifier") {
      const name = String(typeName.name);
      if (resolving.has(name)) return undefined;
      resolving.add(name);
      const declaration = module.nodes.find((candidate) => {
        const id = astNode(candidate.id);
        return id?.type === "Identifier" && id.name === name &&
          ["TSTypeAliasDeclaration", "TSInterfaceDeclaration"].includes(candidate.type);
      });
      const shape = declaration?.type === "TSTypeAliasDeclaration"
        ? typeShape(astNode(declaration.typeAnnotation), module, resolving)
        : declaration?.type === "TSInterfaceDeclaration" && astNodeArray(declaration.extends).length === 0
          ? interfaceBodyShape(astNode(declaration.body), module, resolving) : undefined;
      resolving.delete(name);
      return shape;
    }
  }
  return undefined;
}

export function interfaceBodyShape(
  body: AstNode | undefined,
  module: ModuleFacts,
  resolving: Set<string>,
): Shape | undefined {
  return body?.type === "TSInterfaceBody" ? typeMembersShape(astNodeArray(body.body), module, resolving) : undefined;
}

function typeMembersShape(
  members: readonly AstNode[],
  module: ModuleFacts,
  resolving: Set<string>,
): Shape | undefined {
  const result: Record<string, ShapeField> = {};
  for (const member of members) {
    if (member.type !== "TSPropertySignature") return undefined;
    const key = staticPropertyName(member, module);
    if (key === undefined || Object.hasOwn(result, key)) return undefined;
    const annotation = astNode(member.typeAnnotation);
    const value = astNode(annotation?.typeAnnotation);
    const descriptor = value ? typeValueShape(value, module, resolving) : undefined;
    if (!descriptor) return undefined;
    result[key] = { ...descriptor, optional: member.optional === true, readonly: member.readonly === true };
  }
  return sortedShape(result);
}

function zodValueShape(node: AstNode, module: ModuleFacts, resolving: Set<string>): ShapeField | undefined {
  if (isZodStrictObjectCall(node, module)) {
    const nested = zodShape(node, module, resolving);
    return nested ? shapeField("object", { nested }) : undefined;
  }
  if (node.type !== "CallExpression") return undefined;
  const callee = astNode(node.callee);
  if (callee?.type !== "MemberExpression" || callee.computed) return undefined;
  const property = astNode(callee.property);
  if (property?.type !== "Identifier") return undefined;
  const operation = String(property.name);
  const receiver = astNode(callee.object);
  if (receiver?.type === "Identifier" && isZodImportIdentifier(receiver, module)) {
    if (["string", "number", "boolean", "bigint", "date", "unknown", "any", "never"].includes(operation)) {
      return shapeField(operation);
    }
    if (operation === "literal") {
      const literal = astNodeArray(node.arguments)[0];
      return literal ? shapeField(`literal:${literalValue(literal)}`) : undefined;
    }
    if (operation === "array") {
      const element = astNodeArray(node.arguments)[0];
      const descriptor = element ? zodValueShape(element, module, resolving) : undefined;
      return descriptor ? shapeField(`array:${descriptor.valueType}`, { nested: descriptor.nested }) : undefined;
    }
    if (operation === "union") {
      const arrayNode = astNodeArray(node.arguments)[0];
      if (arrayNode?.type !== "ArrayExpression") return undefined;
      const members = astNodeArray(arrayNode.elements).map((entry) => zodValueShape(entry, module, resolving));
      if (members.some((entry) => entry === undefined)) return undefined;
      return shapeField(`union:${members.map((entry) => entry!.valueType).toSorted(codePointCompare).join("|")}`);
    }
    return undefined;
  }
  if (!receiver) return undefined;
  const base = zodValueShape(receiver, module, resolving);
  if (!base) return undefined;
  if (operation === "optional" || operation === "nullish") return { ...base, optional: true };
  if (operation === "readonly") return { ...base, readonly: true };
  if (["min", "max", "length", "regex", "email", "url", "uuid", "int", "positive", "nonnegative"].includes(operation)) {
    const validator = `${operation}:${astNodeArray(node.arguments).map(literalValue).join(",")}`;
    return { ...base, validators: [...base.validators, validator].toSorted(codePointCompare) };
  }
  if (["describe", "brand", "default", "catch"].includes(operation)) return base;
  return undefined;
}

function runtimeValueShape(node: AstNode, module: ModuleFacts, resolving: Set<string>): ShapeField | undefined {
  if (node.type === "StringLiteral" || node.type === "TemplateLiteral") return shapeField("string");
  if (node.type === "NumericLiteral") return shapeField("number");
  if (node.type === "BooleanLiteral") return shapeField("boolean");
  if (node.type === "NullLiteral") return shapeField("null");
  if (node.type === "ArrayExpression") {
    const elements = astNodeArray(node.elements);
    if (elements.length === 0) return shapeField("array:unknown");
    const descriptors = elements.map((element) => runtimeValueShape(element, module, resolving));
    if (descriptors.some((entry) => entry === undefined)) return undefined;
    const types = [...new Set(descriptors.map((entry) => entry!.valueType))].toSorted(codePointCompare);
    return shapeField(`array:${types.length === 1 ? types[0] : `union:${types.join("|")}`}`);
  }
  if (node.type === "ObjectExpression") {
    const nested = objectShape(node, module, resolving);
    return nested ? shapeField("object", { nested }) : undefined;
  }
  if (node.type === "Identifier") {
    if (node.name === "undefined") return shapeField("undefined");
    const initializer = module.constants.get(String(node.name));
    if (!initializer || resolving.has(String(node.name))) return shapeField("unknown");
    resolving.add(String(node.name));
    const descriptor = runtimeValueShape(initializer, module, resolving);
    resolving.delete(String(node.name));
    return descriptor;
  }
  return shapeField("unknown");
}

function typeValueShape(node: AstNode, module: ModuleFacts, resolving: Set<string>): ShapeField | undefined {
  const primitive = new Map<string, string>([
    ["TSStringKeyword", "string"], ["TSNumberKeyword", "number"], ["TSBooleanKeyword", "boolean"],
    ["TSBigIntKeyword", "bigint"], ["TSUnknownKeyword", "unknown"], ["TSAnyKeyword", "any"],
    ["TSNeverKeyword", "never"], ["TSNullKeyword", "null"], ["TSUndefinedKeyword", "undefined"],
  ]).get(node.type);
  if (primitive) return shapeField(primitive);
  if (node.type === "TSLiteralType") {
    const literal = astNode(node.literal);
    return literal ? shapeField(`literal:${literalValue(literal)}`) : undefined;
  }
  if (node.type === "TSArrayType") {
    const element = astNode(node.elementType);
    const descriptor = element ? typeValueShape(element, module, resolving) : undefined;
    return descriptor ? shapeField(`array:${descriptor.valueType}`, { nested: descriptor.nested }) : undefined;
  }
  if (node.type === "TSTypeOperator" && node.operator === "readonly") {
    const annotation = astNode(node.typeAnnotation);
    const descriptor = annotation ? typeValueShape(annotation, module, resolving) : undefined;
    return descriptor ? { ...descriptor, readonly: true } : undefined;
  }
  if (node.type === "TSUnionType") {
    const members = astNodeArray(node.types).map((member) => typeValueShape(member, module, resolving));
    if (members.some((entry) => entry === undefined)) return undefined;
    return shapeField(`union:${members.map((entry) => entry!.valueType).toSorted(codePointCompare).join("|")}`);
  }
  const nested = typeShape(node, module, resolving);
  if (nested) return shapeField("object", { nested });
  if (node.type === "TSTypeReference") {
    const typeName = astNode(node.typeName);
    const parameters = astNode(node.typeParameters ?? node.typeArguments);
    if (typeName?.type === "Identifier" && ["Array", "ReadonlyArray"].includes(String(typeName.name))) {
      const parameter = astNodeArray(parameters?.params)[0];
      const descriptor = parameter ? typeValueShape(parameter, module, resolving) : undefined;
      return descriptor ? shapeField(`array:${descriptor.valueType}`, {
        nested: descriptor.nested,
        readonly: typeName.name === "ReadonlyArray",
      }) : undefined;
    }
  }
  return undefined;
}

function shapeField(valueType: string, overrides: Partial<Omit<ShapeField, "valueType">> = {}): ShapeField {
  return deepFreeze({
    valueType,
    optional: overrides.optional ?? false,
    readonly: overrides.readonly ?? false,
    validators: overrides.validators ?? [],
    nested: overrides.nested ?? null,
  });
}

function mapShapeFields(shape: Shape, transform: (field: ShapeField) => ShapeField): Shape {
  return sortedShape(Object.fromEntries(Object.entries(shape).map(([key, field]) => [key, transform(field)])));
}

function isZodImportIdentifier(identifierNode: AstNode, module: ModuleFacts): boolean {
  const binding = module.imports.get(String(identifierNode.name));
  return binding !== undefined && binding.sourcePath === "zod" &&
    (binding.kind === "namespace" || binding.kind === "named" && binding.exportName === "z") &&
    identifierResolvesToImport(identifierNode, module, binding);
}

export function isZodStrictObjectCall(node: AstNode, module?: ModuleFacts): boolean {
  if (node.type !== "CallExpression") return false;
  const callee = astNode(node.callee);
  if (callee?.type !== "MemberExpression" && callee?.type !== "OptionalMemberExpression") return false;
  const property = astNode(callee.property);
  if (callee.computed || property?.type !== "Identifier" || property.name !== "strictObject") return false;
  if (!module) return true;
  const receiver = astNode(callee.object);
  return receiver?.type === "Identifier" && isZodImportIdentifier(receiver, module);
}

export function isZodShapeArgument(node: AstNode, parent: AstNode | undefined, module: ModuleFacts): boolean {
  return parent !== undefined && isZodStrictObjectCall(parent, module) && astNodeArray(parent.arguments)[0] === node;
}

export function staticPropertyName(node: AstNode, module?: ModuleFacts): string | undefined {
  const key = astNode(node.key);
  if (node.computed) {
    if (key?.type === "StringLiteral") return String(key.value);
    return key && module ? staticString(key, module.constants, new Set()) : undefined;
  }
  if (key?.type === "Identifier") return String(key.name);
  if (key?.type === "StringLiteral" || key?.type === "NumericLiteral") return String(key.value);
  return undefined;
}

function literalValue(node: AstNode): string {
  if (["StringLiteral", "NumericLiteral", "BooleanLiteral", "BigIntLiteral"].includes(node.type)) {
    return `${node.type}:${String(node.value)}`;
  }
  if (node.type === "NullLiteral") return "null";
  return `unsupported:${node.type}`;
}

function sortedShape(shape: Record<string, ShapeField>): Shape {
  return deepFreeze(Object.fromEntries(Object.entries(shape).toSorted(([left], [right]) =>
    codePointCompare(left, right))));
}
