import { isRecord } from "./shared.ts";
import { astNode, astNodeArray, type AstNode } from "./typescript-adapter.ts";

/** Deterministic, execution-free evaluation of the supported string subset. */
export function staticString(
  node: AstNode,
  constants: ReadonlyMap<string, AstNode>,
  resolving: Set<string>,
): string | undefined {
  if (node.type === "StringLiteral") return String(node.value);
  if (node.type === "TemplateLiteral") {
    const expressions = astNodeArray(node.expressions);
    const quasis = astNodeArray(node.quasis);
    let value = "";
    for (let index = 0; index < quasis.length; index += 1) {
      const rawQuasiValue = quasis[index]!.value;
      const quasiValue = isRecord(rawQuasiValue) ? rawQuasiValue : undefined;
      const cooked = quasiValue?.cooked;
      if (typeof cooked !== "string") return undefined;
      value += cooked;
      if (index < expressions.length) {
        const expression = staticString(expressions[index]!, constants, resolving);
        if (expression === undefined) return undefined;
        value += expression;
      }
    }
    return value;
  }
  if (node.type === "BinaryExpression" && node.operator === "+") {
    const left = astNode(node.left);
    const right = astNode(node.right);
    if (!left || !right) return undefined;
    const leftValue = staticString(left, constants, resolving);
    const rightValue = staticString(right, constants, resolving);
    return leftValue === undefined || rightValue === undefined ? undefined : leftValue + rightValue;
  }
  if (node.type === "Identifier") {
    const name = String(node.name);
    if (resolving.has(name)) return undefined;
    const initializer = constants.get(name);
    if (!initializer) return undefined;
    resolving.add(name);
    const value = staticString(initializer, constants, resolving);
    resolving.delete(name);
    return value;
  }
  if (node.type === "CallExpression") return staticCallString(node, constants, resolving);
  if (["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression"].includes(node.type)) {
    const expression = astNode(node.expression);
    return expression ? staticString(expression, constants, resolving) : undefined;
  }
  return undefined;
}

function staticCallString(
  node: AstNode,
  constants: ReadonlyMap<string, AstNode>,
  resolving: Set<string>,
): string | undefined {
  const callee = astNode(node.callee);
  const arguments_ = astNodeArray(node.arguments);
  const argument = arguments_[0];
  if (callee?.type === "Identifier" && callee.name === "String" && argument && arguments_.length === 1) {
    if (["NumericLiteral", "BooleanLiteral", "StringLiteral"].includes(argument.type)) return String(argument.value);
    return staticString(argument, constants, resolving);
  }
  if (callee?.type !== "MemberExpression" || callee.computed) return undefined;
  const property = astNode(callee.property);
  const receiver = astNode(callee.object);
  if (property?.type !== "Identifier" || !receiver) return undefined;
  if (receiver.type === "Identifier" && receiver.name === "String" && property.name === "fromCharCode" &&
    arguments_.every((entry) => entry.type === "NumericLiteral")) {
    return String.fromCharCode(...arguments_.map((entry) => Number(entry.value)));
  }
  if (receiver.type === "ArrayExpression" && property.name === "join") {
    const elements = astNodeArray(receiver.elements).map((entry) => staticString(entry, constants, resolving));
    const separator = argument ? staticString(argument, constants, resolving) : ",";
    return elements.some((entry) => entry === undefined) || separator === undefined
      ? undefined : elements.join(separator);
  }
  const receiverValue = staticString(receiver, constants, resolving);
  if (receiverValue !== undefined && property.name === "toLowerCase" && arguments_.length === 0) {
    return receiverValue.toLowerCase();
  }
  if (receiverValue !== undefined && property.name === "replace" && arguments_.length === 2) {
    const search = staticString(arguments_[0]!, constants, resolving);
    const replacement = staticString(arguments_[1]!, constants, resolving);
    return search === undefined || replacement === undefined ? undefined : receiverValue.replace(search, replacement);
  }
  if (property.name !== "toString" || arguments_.length !== 0 || receiver.type !== "CallExpression") return undefined;
  const fromCallee = astNode(receiver.callee);
  const fromObject = fromCallee?.type === "MemberExpression" ? astNode(fromCallee.object) : undefined;
  const fromProperty = fromCallee?.type === "MemberExpression" ? astNode(fromCallee.property) : undefined;
  const fromArguments = astNodeArray(receiver.arguments);
  if (fromObject?.type !== "Identifier" || fromObject.name !== "Buffer" ||
    fromProperty?.type !== "Identifier" || fromProperty.name !== "from" || fromArguments.length !== 2) {
    return undefined;
  }
  const encoded = staticString(fromArguments[0]!, constants, resolving);
  const encoding = staticString(fromArguments[1]!, constants, resolving);
  return encoded !== undefined && encoding === "base64" ? Buffer.from(encoded, "base64").toString() : undefined;
}
