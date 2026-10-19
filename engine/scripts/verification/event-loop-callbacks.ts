/**
 * THE EVENT-LOOP CALLBACK CENSUS (SCALE-CR1 C3, SCALE-CR1-FIX N3/M8): every
 * callback the event loop runs on its own must be registered through
 * `guarded(owner, fn)` (`engine/src/process/fault-policy.ts`).
 *
 * A synchronous throw inside a timer, an emitter listener, an event-target
 * listener or a completion callback has no caller to catch it: it is an
 * uncaught exception, and the fault policy ends the process on one
 * (fail-stop, exit 70). The census found 133 such registrations in `server/`
 * and `engine/src/` with no guard; one throwing body in any of them was a
 * whole-server crash.
 *
 * ── WHAT IS A REGISTRATION ────────────────────────────────────────────────
 *
 *  - a TIMER: `setTimeout`, `setInterval`, `setImmediate`, `queueMicrotask`,
 *    called bare or as a member (`globalThis.setTimeout`, `timers.setImmediate`),
 *    and `process.nextTick` — the callback is the first argument (a delay or
 *    a value there is the promise API, which takes no callback);
 *  - a LISTENER: a method named `on`, `once`, `addListener`,
 *    `prependListener`, `prependOnceListener` or `addEventListener`, by name
 *    or computed (`emitter["on"]`), with at least two arguments (the second);
 *  - a SOURCE'S listener: `watch`, `createServer` or `listen` (the last
 *    argument, when it is a callback and not the only argument);
 *  - a NODE-STYLE COMPLETION CALLBACK: the last argument of a call to one of
 *    {@link COMPLETION_CALLBACK_APIS} (`stream.write(data, cb)`,
 *    `scrypt(…, cb)`, `fs.readFile(p, cb)`, `https.get(url, cb)`, …), when it
 *    is a function written in place or a name bound to one;
 *  - an `on<event>` PROPERTY HANDLER: `ws.onmessage = fn`.
 *
 * Parsed with the repository's JavaScript parser (`@babel/parser`), so
 * comments and strings never count; an optional chain (`child.stdout?.on(…)`)
 * is the same registration.
 *
 * ── WHAT IS ACCEPTED ──────────────────────────────────────────────────────
 *
 *  - `guarded(owner, fn)` written in place;
 *  - a NAME whose binding — resolved through the lexical scopes, so a
 *    same-named binding in another function is a different name — is
 *    `const name = guarded(…)`, or a `let` initialised so and never assigned
 *    anything but another `guarded(…)`;
 *  - a PROMISE SETTLER, which cannot throw: a name whose binding is a
 *    parameter of the executor of a `new Promise(…)` (a nested parameter of
 *    the same name shadows it), passed as is or called alone with literal or
 *    plain-name arguments (`setTimeout(resolve, ms)`, `() => resolve("x")`).
 *
 * Anything else is a finding. There is no allowlist: a body "proven total"
 * today is one edit away from throwing, and the guard costs one call.
 */
import { parse } from "@babel/parser";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { experimentExclusion, walk } from "./source-walk.ts";

export type EventLoopCallbackFinding = Readonly<{
  /** Repository-relative path. */
  path: string;
  line: number;
  /** The registering call: `setTimeout`, `on`, `addEventListener`, `write`, `onmessage =`, … */
  registration: string;
  /** The callback's source, whitespace-collapsed and clipped. */
  callback: string;
}>;

const TIMER_REGISTRATIONS: ReadonlySet<string> = new Set(["setTimeout", "setInterval", "setImmediate", "queueMicrotask"]);
const LISTENER_REGISTRATIONS: ReadonlySet<string> = new Set(["on", "once", "addListener", "prependListener", "prependOnceListener", "addEventListener"]);
const SOURCE_REGISTRATIONS: ReadonlySet<string> = new Set(["watch", "createServer", "listen"]);
/**
 * Node's callback-last APIs whose callback the event loop runs later (a
 * stream's write/end, a server's close, a child's exec, the fs/crypto/zlib/dns
 * async forms, an http request, an IPC send). Named by method, so the
 * namespace it is reached through does not matter.
 */
const COMPLETION_CALLBACK_APIS: ReadonlySet<string> = new Set([
  "write", "end", "close", "send", "connect", "pipeline", "finished",
  "exec", "execFile",
  "readFile", "writeFile", "appendFile", "readdir", "stat", "lstat", "fstat", "access", "mkdir", "mkdtemp", "rm", "rmdir",
  "unlink", "rename", "open", "read", "fsync", "fdatasync", "copyFile", "realpath", "chmod", "truncate", "ftruncate",
  "scrypt", "pbkdf2", "randomBytes", "randomFill", "randomInt", "generateKeyPair", "hkdf", "lookup",
  "gzip", "gunzip", "deflate", "inflate", "deflateRaw", "inflateRaw", "brotliCompress", "brotliDecompress", "unzip",
]);
/**
 * `get`/`request` take a completion callback only on node's HTTP clients; a
 * router's `get(path, handler)` is not one. Counted when the callee is reached
 * through a binding imported from one of these modules.
 */
const HTTP_CLIENT_APIS: ReadonlySet<string> = new Set(["get", "request"]);
const HTTP_CLIENT_MODULES: ReadonlySet<string> = new Set(["node:http", "node:https", "http", "https"]);
/** An `on<event>` handler property (`onmessage`, `onerror`, …). */
const PROPERTY_HANDLER = /^on[a-z]+$/u;
/** What a callback argument looks like (an object of options is not one). */
const CALLBACK_SHAPES: ReadonlySet<string> = new Set(["ArrowFunctionExpression", "FunctionExpression", "Identifier", "CallExpression", "MemberExpression"]);
const FUNCTION_SHAPES: ReadonlySet<string> = new Set(["ArrowFunctionExpression", "FunctionExpression"]);
const GUARD = "guarded";

type Node = Readonly<Record<string, unknown>> & { type: string; start: number; end: number; loc: { start: { line: number } } };

function isNode(value: unknown): value is Node {
  return value !== null && typeof value === "object" && typeof (value as { type?: unknown }).type === "string";
}

function children(node: Node): readonly Node[] {
  const out: Node[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key === "leadingComments" || key === "trailingComments" || key === "innerComments") continue;
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) out.push(item);
    } else if (isNode(value)) out.push(value);
  }
  return out;
}

function isGuardCall(node: Node | undefined): boolean {
  if (node === undefined) return false;
  const callee = node.callee as Node | undefined;
  return node.type === "CallExpression" && callee?.type === "Identifier" && callee.name === GUARD;
}

// ── Lexical scopes (just enough to resolve a name to its binding) ──────────

/** What a name is bound to: a guarded callback, a promise settler, a function, or anything else. */
type BindingKind = "guarded" | "settler" | "function" | "other";
type Binding = { kind: BindingKind; readonly reassignable: boolean; readonly importedFrom?: string };
type Scope = Readonly<{ parent: Scope | undefined; bindings: Map<string, Binding>; isFunction: boolean }>;

const FUNCTION_NODES: ReadonlySet<string> = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "ObjectMethod", "ClassMethod", "ClassPrivateMethod"]);
const BLOCK_NODES: ReadonlySet<string> = new Set(["BlockStatement", "ForStatement", "ForInStatement", "ForOfStatement", "CatchClause", "SwitchStatement", "StaticBlock"]);

function resolveBinding(scope: Scope | undefined, name: string): Binding | undefined {
  for (let current = scope; current !== undefined; current = current.parent) {
    const binding = current.bindings.get(name);
    if (binding !== undefined) return binding;
  }
  return undefined;
}

function functionScopeOf(scope: Scope): Scope {
  let current = scope;
  while (!current.isFunction && current.parent !== undefined) current = current.parent;
  return current;
}

/** Every identifier a binding pattern declares (`{ a, b: [c] }`, `...rest`, `x = 1`). */
function patternNames(pattern: Node): readonly string[] {
  switch (pattern.type) {
    case "Identifier": return [pattern.name as string];
    case "AssignmentPattern": return patternNames(pattern.left as Node);
    case "RestElement": return patternNames(pattern.argument as Node);
    case "ArrayPattern": return (pattern.elements as readonly (Node | null)[]).flatMap((element) => element === null ? [] : patternNames(element));
    case "ObjectPattern": return (pattern.properties as readonly Node[]).flatMap((property) => patternNames((property.type === "RestElement" ? property : property.value) as Node));
    case "TSParameterProperty": return patternNames(pattern.parameter as Node);
    default: return [];
  }
}

/** The parameters of a `new Promise(executor)` executor, or undefined when `node` is not one. */
function promiseExecutor(node: Node): Node | undefined {
  if (node.type !== "NewExpression") return undefined;
  const callee = node.callee as Node;
  if (callee.type !== "Identifier" || callee.name !== "Promise") return undefined;
  const executor = (node.arguments as readonly Node[])[0];
  return executor !== undefined && FUNCTION_SHAPES.has(executor.type) ? executor : undefined;
}

/**
 * Pass 1: the scope of every scope-creating node, with its declarations (var
 * and function hoisted to the function scope) and every reassignment, so a
 * `let` once guarded and later assigned something else is no guard.
 */
function buildScopes(program: Node): Map<Node, Scope> {
  const scopes = new Map<Node, Scope>();
  const executors = new Set<Node>();
  const assignments: Array<Readonly<{ scope: Scope; name: string; value: Node | undefined }>> = [];
  const declare = (scope: Scope, name: string, binding: Binding): void => { scope.bindings.set(name, binding); };
  const walkNode = (node: Node, scope: Scope): void => {
    let inner = scope;
    if (node.type === "NewExpression") {
      const executor = promiseExecutor(node);
      if (executor !== undefined) executors.add(executor);
    }
    if (FUNCTION_NODES.has(node.type)) {
      if (node.type === "FunctionDeclaration" && isNode(node.id)) declare(scope, node.id.name as string, { kind: "function", reassignable: true });
      inner = { parent: scope, bindings: new Map(), isFunction: true };
      if (node.type === "FunctionExpression" && isNode(node.id)) declare(inner, node.id.name as string, { kind: "function", reassignable: false });
      const settler = executors.has(node);
      for (const param of (node.params as readonly Node[]) ?? []) {
        for (const name of patternNames(param)) declare(inner, name, { kind: settler && param.type === "Identifier" ? "settler" : "other", reassignable: true });
      }
      scopes.set(node, inner);
    } else if (node.type === "Program") {
      inner = { parent: undefined, bindings: new Map(), isFunction: true };
      scopes.set(node, inner);
    } else if (BLOCK_NODES.has(node.type)) {
      inner = { parent: scope, bindings: new Map(), isFunction: false };
      if (node.type === "CatchClause" && isNode(node.param)) for (const name of patternNames(node.param)) declare(inner, name, { kind: "other", reassignable: true });
      scopes.set(node, inner);
    }
    if (node.type === "VariableDeclaration") {
      const kind = node.kind as string;
      const target = kind === "var" ? functionScopeOf(scope) : scope;
      for (const declarator of node.declarations as readonly Node[]) {
        const id = declarator.id as Node;
        const init = isNode(declarator.init) ? declarator.init : undefined;
        if (id.type === "Identifier") {
          const bound: BindingKind = isGuardCall(init) ? "guarded" : init !== undefined && FUNCTION_SHAPES.has(init.type) ? "function" : "other";
          declare(target, id.name as string, { kind: bound, reassignable: kind !== "const" });
        } else for (const name of patternNames(id)) declare(target, name, { kind: "other", reassignable: kind !== "const" });
      }
    }
    if (node.type === "ClassDeclaration" && isNode(node.id)) declare(scope, node.id.name as string, { kind: "other", reassignable: true });
    if (node.type === "ImportDeclaration") {
      const from = (node.source as Node).value as string;
      for (const specifier of node.specifiers as readonly Node[]) declare(scope, (specifier.local as Node).name as string, { kind: "other", reassignable: false, importedFrom: from });
    }
    if (node.type === "AssignmentExpression" && (node.left as Node).type === "Identifier") {
      assignments.push({ scope, name: (node.left as Node).name as string, value: node.right as Node });
    }
    if (node.type === "UpdateExpression" && (node.argument as Node).type === "Identifier") {
      assignments.push({ scope, name: (node.argument as Node).name as string, value: undefined });
    }
    for (const child of children(node)) walkNode(child, inner);
  };
  walkNode(program, { parent: undefined, bindings: new Map(), isFunction: true });
  // A reassignment that is not another guard taints the binding it reaches.
  for (const assignment of assignments) {
    const binding = resolveBinding(assignment.scope, assignment.name);
    if (binding !== undefined && (binding.kind === "guarded" || binding.kind === "settler") && !isGuardCall(assignment.value)) binding.kind = "other";
  }
  return scopes;
}

/** The method name a callee names, by identifier or by a string written as a computed member. */
function memberName(callee: Node): string | undefined {
  if (callee.type !== "MemberExpression" && callee.type !== "OptionalMemberExpression") return undefined;
  const property = callee.property as Node;
  if (callee.computed !== true) return property.type === "Identifier" ? property.name as string : undefined;
  return property.type === "StringLiteral" ? property.value as string : undefined;
}

/** The registering call's name and the callback argument, or undefined when the call registers nothing. */
function registrationOf(call: Node, scope: Scope): Readonly<{ name: string; callback: Node }> | undefined {
  const callee = call.callee as Node;
  const args = (call.arguments as readonly Node[]) ?? [];
  const named = callee.type === "Identifier" ? callee.name as string : memberName(callee);
  if (named === undefined) return undefined;
  if (TIMER_REGISTRATIONS.has(named)) {
    const first = args[0];
    return first !== undefined && CALLBACK_SHAPES.has(first.type) ? { name: named, callback: first } : undefined;
  }
  if (named === "nextTick" && callee.type !== "Identifier" && (callee.object as Node).type === "Identifier" && (callee.object as Node).name === "process") {
    return args[0] === undefined ? undefined : { name: "process.nextTick", callback: args[0] };
  }
  // A listener handed to the call that creates its source: a folder watch, a
  // server's request handler, a listen callback (the LAST argument, when it is
  // a function written in place or a name).
  if (SOURCE_REGISTRATIONS.has(named)) {
    const last = args.at(-1);
    return last !== undefined && args.length >= 2 && CALLBACK_SHAPES.has(last.type) ? { name: named, callback: last } : undefined;
  }
  if (callee.type === "Identifier" ? false : LISTENER_REGISTRATIONS.has(named) && args.length >= 2) {
    return { name: named, callback: args[1]! };
  }
  const httpClient = HTTP_CLIENT_APIS.has(named) && HTTP_CLIENT_MODULES.has(
    resolveBinding(scope, ((callee.type === "Identifier" ? callee : callee.object) as Node).name as string ?? "")?.importedFrom ?? "");
  // The callback may be the only argument (`stream.end(cb)`, `server.close(cb)`).
  if ((COMPLETION_CALLBACK_APIS.has(named) || httpClient) && args.length >= 1) {
    const last = args.at(-1)!;
    if (FUNCTION_SHAPES.has(last.type) || isGuardCall(last)) return { name: named, callback: last };
    if (last.type === "Identifier") {
      const binding = resolveBinding(scope, last.name as string);
      if (binding !== undefined && binding.kind !== "other") return { name: named, callback: last };
    }
  }
  return undefined;
}

/** A settle call alone: `resolve(x)` whose callee is a settler binding and whose arguments are literals or plain names. */
function isSettleCall(node: Node, scope: Scope): boolean {
  if (node.type !== "CallExpression") return false;
  const callee = node.callee as Node;
  if (callee.type !== "Identifier" || resolveBinding(scope, callee.name as string)?.kind !== "settler") return false;
  return (node.arguments as readonly Node[]).every((arg) => arg.type === "Identifier" || arg.type.endsWith("Literal") && (arg.type !== "TemplateLiteral" || (arg.expressions as readonly unknown[]).length === 0));
}

function accepted(callback: Node, scope: Scope, scopes: ReadonlyMap<Node, Scope>): boolean {
  if (isGuardCall(callback)) return true;
  if (callback.type === "Identifier") {
    const kind = resolveBinding(scope, callback.name as string)?.kind;
    return kind === "guarded" || kind === "settler";
  }
  if (callback.type === "ArrowFunctionExpression" && (callback.params as readonly unknown[]).length === 0) {
    const inner = scopes.get(callback) ?? scope;
    const body = callback.body as Node;
    if (isSettleCall(body, inner)) return true;
    if (body.type === "BlockStatement") {
      const statements = body.body as readonly Node[];
      const blockScope = scopes.get(body) ?? inner;
      return statements.length === 1 && statements[0]!.type === "ExpressionStatement" && isSettleCall(statements[0]!.expression as Node, blockScope);
    }
  }
  return false;
}

function parseProgram(source: string): Node {
  return parse(source, { sourceType: "module", plugins: ["typescript"], errorRecovery: false }).program as unknown as Node;
}

/** Every unguarded registration in one source text. */
export function unguardedCallbacksIn(source: string, path: string): readonly EventLoopCallbackFinding[] {
  const program = parseProgram(source);
  const scopes = buildScopes(program);
  const findings: EventLoopCallbackFinding[] = [];
  const report = (node: Node, registration: string, callback: Node): void => {
    findings.push({
      path, line: node.loc.start.line, registration,
      callback: source.slice(callback.start, callback.end).replace(/\s+/gu, " ").slice(0, 100),
    });
  };
  const visit = (node: Node, scope: Scope): void => {
    const inner = scopes.get(node) ?? scope;
    if (node.type === "CallExpression" || node.type === "OptionalCallExpression") {
      const registration = registrationOf(node, scope);
      if (registration !== undefined && !accepted(registration.callback, scope, scopes)) report(node, registration.name, registration.callback);
    }
    if (node.type === "AssignmentExpression" && node.operator === "=") {
      const left = node.left as Node;
      const right = node.right as Node;
      const name = memberName(left);
      if (name !== undefined && PROPERTY_HANDLER.test(name) && CALLBACK_SHAPES.has(right.type) && !accepted(right, scope, scopes)) report(node, `${name} =`, right);
    }
    for (const child of children(node)) visit(child, inner);
  };
  visit(program, scopes.get(program)!);
  return findings;
}

/**
 * The product code the event loop runs: `server/`, `engine/src/` and the
 * engine tool pool's worker code (`engine/scripts/concurrent/`, the threads
 * `src/tools/concurrent/worker-pool.ts` starts) — test files excluded — as
 * repository-relative paths and sources.
 */
function productSources(repositoryRoot: string): readonly Readonly<{ path: string; source: string }>[] {
  const engineRoot = join(repositoryRoot, "engine");
  return [
    ...walk(join(repositoryRoot, "server"), { exts: [".ts", ".mts", ".mjs"] }),
    ...walk(join(engineRoot, "src"), { exts: [".ts", ".mts", ".mjs"], exclude: experimentExclusion(engineRoot) }),
    ...walk(join(engineRoot, "scripts", "concurrent"), { exts: [".ts", ".mts", ".mjs"] }),
  ].filter((file) => !/\.test\.[cm]?[jt]s$/u.test(file) && !file.endsWith(".d.ts"))
    .map((file) => ({ path: relative(repositoryRoot, file).replaceAll("\\", "/"), source: readFileSync(file, "utf8") }));
}

/** The census over the product code the event loop runs. */
export function unguardedEventLoopCallbacks(repositoryRoot: string): readonly EventLoopCallbackFinding[] {
  return productSources(repositoryRoot).flatMap(({ path, source }) => unguardedCallbacksIn(source, path));
}

// ── No user-defined SQL functions (SCALE-CR1, the latent SIGSEGV) ──────────
//
// node:sqlite runs a function registered with `db.function(name, fn)` (or
// `db.aggregate`) INSIDE SQLite's own call stack; closing the database from
// inside one crashed the process with SIGSEGV (reproduced). Nothing registers
// one today; this keeps it that way. Matched by shape — a `.function(` or
// `.aggregate(` call whose first argument is a name written as a string —
// since no other API in this code base has that shape.

export type SqliteUserFunctionFinding = Readonly<{ path: string; line: number; registration: string }>;

const SQLITE_USER_FUNCTION_METHODS: ReadonlySet<string> = new Set(["function", "aggregate"]);

/** Every user-defined SQL function registration in one source text. */
export function sqliteUserFunctionsIn(source: string, path: string): readonly SqliteUserFunctionFinding[] {
  const program = parseProgram(source);
  const findings: SqliteUserFunctionFinding[] = [];
  const visit = (node: Node): void => {
    if (node.type === "CallExpression" || node.type === "OptionalCallExpression") {
      const callee = node.callee as Node;
      const first = (node.arguments as readonly Node[])[0];
      if ((callee.type === "MemberExpression" || callee.type === "OptionalMemberExpression") && callee.computed !== true &&
        (callee.property as Node).type === "Identifier" && SQLITE_USER_FUNCTION_METHODS.has((callee.property as Node).name as string) &&
        first !== undefined && (first.type === "StringLiteral" || (first.type === "TemplateLiteral" && (first.expressions as readonly unknown[]).length === 0))) {
        findings.push({ path, line: node.loc.start.line, registration: (callee.property as Node).name as string });
      }
    }
    for (const child of children(node)) visit(child);
  };
  visit(program);
  return findings;
}

/** Every user-defined SQL function registration in the product code. */
export function sqliteUserFunctions(repositoryRoot: string): readonly SqliteUserFunctionFinding[] {
  return productSources(repositoryRoot).flatMap(({ path, source }) => sqliteUserFunctionsIn(source, path));
}

// ── The fault policy's doors (SCALE-CR1-FIX H2) ────────────────────────────
//
// The policy is installed by exactly three doors — the process bootstrap
// (`bootstrapProcess`), the worker threads' prelude, and the web server's
// first import — and every worker thread is started on the prelude
// (`new Worker(...bootstrappedWorker(entry, role, options))`). A hand install
// elsewhere is a second owner; a `new Worker(` without the prelude is a thread
// with no policy.

export type ProcessDoorFinding = Readonly<{ path: string; line: number; finding: "install-outside-doors" | "worker-without-prelude" }>;

/** The modules allowed to call `installProcessFaultPolicy(…)`. */
const FAULT_POLICY_DOORS: ReadonlySet<string> = new Set([
  "engine/src/runtime/cli-debug.ts",
  "engine/src/process/worker-bootstrap.ts",
  "server/kernel/process-fault-policy.ts",
]);

/** Whether a `new Worker(…)` call is exactly `new Worker(...bootstrappedWorker(…))`. */
function startsWithPrelude(node: Node): boolean {
  const args = node.arguments as readonly Node[];
  const spread = args[0];
  if (args.length !== 1 || spread?.type !== "SpreadElement") return false;
  const call = spread.argument as Node;
  return call.type === "CallExpression" && (call.callee as Node).type === "Identifier" && (call.callee as Node).name === "bootstrappedWorker";
}

/** The door findings of one source text. */
export function processDoorFindingsIn(source: string, path: string): readonly ProcessDoorFinding[] {
  const findings: ProcessDoorFinding[] = [];
  const visit = (node: Node): void => {
    if (node.type === "CallExpression" && (node.callee as Node).type === "Identifier" && (node.callee as Node).name === "installProcessFaultPolicy" && !FAULT_POLICY_DOORS.has(path)) {
      findings.push({ path, line: node.loc.start.line, finding: "install-outside-doors" });
    }
    if (node.type === "NewExpression") {
      const callee = node.callee as Node;
      const named = callee.type === "Identifier" ? callee.name : memberName(callee);
      if (named === "Worker" && !startsWithPrelude(node)) findings.push({ path, line: node.loc.start.line, finding: "worker-without-prelude" });
    }
    for (const child of children(node)) visit(child);
  };
  visit(parseProgram(source));
  return findings;
}

/** The door findings over every process the repository starts: the server, the engine (code and tooling), the scripts. */
export function processDoorFindings(repositoryRoot: string): readonly ProcessDoorFinding[] {
  const engineRoot = join(repositoryRoot, "engine");
  const tooling = [
    ...walk(join(engineRoot, "scripts"), { exts: [".ts", ".mts", ".mjs"], exclude: experimentExclusion(engineRoot) }),
    ...walk(join(repositoryRoot, "scripts"), { exts: [".ts", ".mts", ".mjs"] }),
  ].filter((file) => !/\.test\.[cm]?[jt]s$/u.test(file) && !file.endsWith(".d.ts"))
    .map((file) => ({ path: relative(repositoryRoot, file).replaceAll("\\", "/"), source: readFileSync(file, "utf8") }));
  return [...productSources(repositoryRoot), ...tooling].flatMap(({ path, source }) => processDoorFindingsIn(source, path));
}
