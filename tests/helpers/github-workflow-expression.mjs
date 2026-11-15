import { data, Evaluator, Lexer, Parser } from "@actions/expressions";
import { Binary, ContextAccess, FunctionCall, Grouping, IndexAccess, Literal, Logical } from "@actions/expressions/ast";
import { TokenType } from "@actions/expressions/lexer";
import { truthy } from "@actions/expressions/result";

// GitHub's job-if contexts and status-function signatures. The SDK owns the
// expression grammar and built-ins; repository policy supplies the required job.
// https://github.com/actions/languageservices/blob/b71ac284fc6a7382c22ecbf3e0009a6ae216823b/workflow-parser/src/workflow-v1.0.json
const JOB_CONTEXTS = ["github", "inputs", "vars", "needs"];
const JOB_FUNCTIONS = [
  { name: "always", minArgs: 0, maxArgs: 0 },
  { name: "cancelled", minArgs: 0, maxArgs: 0 },
  { name: "failure", minArgs: 0, maxArgs: Number.MAX_SAFE_INTEGER },
  { name: "success", minArgs: 0, maxArgs: Number.MAX_SAFE_INTEGER },
];

/** The SDK owns every token and AST; conditions and whole-expression values share this parser. */
function parseJobExpression(condition) {
  if (typeof condition !== "string") throw new TypeError("a job expression must be a string");
  let source = condition.trim();
  if (source.startsWith("${{")) {
    if (!source.endsWith("}}")) throw new TypeError("a wrapped job expression must close");
    source = source.slice(3, -2).trim();
  }
  return new Parser(new Lexer(source).lex().tokens, JOB_CONTEXTS, JOB_FUNCTIONS).parse();
}

// Only always() has context-free status semantics. Other status functions
// require the runner's state and remain unsupported by this bounded evaluator.
const CONTEXT_FREE_STATUS_FUNCTIONS = new Map(JOB_FUNCTIONS.filter(({ name }) => name === "always")
  .map((definition) => [definition.name, { ...definition, call: () => new data.BooleanData(true) }]));

function evaluateParsedJobExpression(expression, context) {
  const values = JSON.parse(JSON.stringify(context), data.reviver);
  if (!(values instanceof data.Dictionary)) throw new TypeError("a job expression context must be a mapping");
  return new Evaluator(expression, values, CONTEXT_FREE_STATUS_FUNCTIONS).evaluate();
}

/** Only unconditional always() gates are admitted; other job-if forms need runner status semantics. */
export function evaluateAlwaysJobCondition(condition, context) {
  const expression = parseJobExpression(condition);
  const call = ungroup(expression);
  if (!(call instanceof FunctionCall) || !CONTEXT_FREE_STATUS_FUNCTIONS.has(call.functionName.lexeme.toLowerCase())) {
    throw new TypeError("the unconditional job gate must call always()");
  }
  return truthy(evaluateParsedJobExpression(expression, context));
}

/** Literal strings or one complete job-context expression; compound templates refuse. */
export function evaluateJobEnvironmentValue(value, context) {
  if (typeof value !== "string") throw new TypeError("a job environment value must be a string");
  if (!value.includes("${{")) return value;
  if (!value.startsWith("${{") || !value.endsWith("}}")) throw new TypeError("only whole-expression environment values are supported");
  return evaluateParsedJobExpression(parseJobExpression(value), context).coerceString();
}

function ungroup(node) {
  while (node instanceof Grouping) node = node.group;
  return node;
}

function stringLiteral(node) {
  node = ungroup(node);
  return node instanceof Literal && node.literal instanceof data.StringData ? node.literal.value : null;
}

function requiredJobResult(node, job) {
  node = ungroup(node);
  if (!(node instanceof IndexAccess) || stringLiteral(node.index) !== "result") return false;
  const dependency = ungroup(node.expr);
  if (!(dependency instanceof IndexAccess) || stringLiteral(dependency.index) !== job) return false;
  const context = ungroup(dependency.expr);
  return context instanceof ContextAccess && context.name.lexeme === "needs";
}

/**
 * Sufficient proof that a job condition requires this dependency to succeed.
 * Unsupported formulas refuse; this is not a complete equivalence/SAT solver.
 * In particular, a quoted/function/negated mention supplies no proof.
 */
export function jobConditionRequiresSuccess(condition, job) {
  if (typeof condition !== "string" || typeof job !== "string" || job.length === 0) return false;
  let expression;
  try { expression = parseJobExpression(condition); }
  catch { return false; }

  const requiresSuccess = (node) => {
    node = ungroup(node);
    if (node instanceof Logical) {
      if (node.operator.type === TokenType.AND) return node.args.some(requiresSuccess);
      if (node.operator.type === TokenType.OR) return node.args.length > 0 && node.args.every(requiresSuccess);
      return false;
    }
    return node instanceof Binary && node.operator.type === TokenType.EQUAL_EQUAL
      && (requiredJobResult(node.left, job) && stringLiteral(node.right) === "success"
        || requiredJobResult(node.right, job) && stringLiteral(node.left) === "success");
  };
  return requiresSuccess(expression);
}
