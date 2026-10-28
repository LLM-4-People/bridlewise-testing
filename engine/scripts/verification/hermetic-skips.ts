/**
 * THE HERMETIC SKIP FINDER (UR-20, UR-24; LIVE-SUITE): every place a hermetic
 * test decides, at run time and from the host it runs on, not to run — found
 * by its SHAPE in the syntax tree, never by its words (security S1', design
 * NH4-R). The guard (engine/test/prevention/hermetic-suites-have-no-skips.test.ts)
 * admits NONE: every site the shapes found was fixed at its cause (a host
 * requirement asserted by name through engine/test/support/host-requirement.ts,
 * tree content asserted present, a world-dependent arm moved to the live
 * suite), so the owned set is empty and shrink-only means it stays so.
 *
 * The shapes:
 *   - a `.skip`, `.skipIf`, `.runIf` or `.todo` on a test declarer or a test
 *     context, called or chosen (`cond ? it : it.skip`);
 *   - a `{ skip }` or `{ todo }` option handed to a declarer, inline or held in
 *     a variable;
 *   - a call of a helper whose name says it skips (`skipUnlessLinux(t)`);
 *   - a RETURN inside a test or suite body (at any depth outside nested
 *     functions: a `try`, an `else`, a nested block) guarded by an `if` whose
 *     condition asks the HOST — `process` (its platform, env, uid, arch), a
 *     file's presence or a stat, an `os` probe, the path separator, a name
 *     that says it is a host capability (`host…`, `has…`, `can…`,
 *     `supports…`, `…Available`, WSL), or a value the test did not compute
 *     itself: a binding of the module or an enclosing suite (a probe, or a
 *     flag a hook set), or a local whose value came from any of these;
 *   - a test REGISTERED only under such a condition (`if (linux) { test(…) }`).
 * Bodies are every declarer's callback (`.each(…)(…)` and node's `t.test`
 * subtests included) and a named body the declarer is handed.
 */
import { readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { effectiveDispositionEntries, parseTestSurfaceDispositionManifestText } from "../../src/kernel/test-surface-manifest.ts";
import { listRecognizableTestPaths } from "../test-inventory.ts";
import { astNode, astNodeArray, parseSourceModule, walkAst, type AstNode } from "../../src/quality-packs/prevention/ast-helpers.ts";
import { TEST_INCLUDE } from "../../../tests/test-include.ts";
import { walk } from "./source-walk.ts";

/** The callees that declare a test or a suite. */
const DECLARERS: ReadonlySet<string> = new Set(["test", "it", "describe", "suite"]);
/** The members that skip or defer a test. */
const SKIPPING_MEMBERS: ReadonlySet<string> = new Set(["skip", "skipIf", "runIf", "todo"]);
/** The option keys that skip or defer a test. */
const SKIPPING_OPTIONS: ReadonlySet<string> = new Set(["skip", "todo"]);
/** Calls that ask the host: a file's presence or kind, an `os` fact, a process fact. */
const HOST_CALLS: ReadonlySet<string> = new Set(["existsSync", "statSync", "lstatSync", "accessSync", "which", "platform", "arch", "getuid", "geteuid", "userInfo", "release", "type", "homedir", "cpus"]);
/** Names that say they are a host capability or fact. */
const HOST_NAMES = /^(?:host[A-Z]|has[A-Z]|can[A-Z]|supports[A-Z]|isWsl|isWSL|isRoot|isLinux)|[Aa]vailable$|[Ww]sl|WSL|^sep$|^EOL$/u;
/** The modules whose member calls ask the host (`os.platform()`, `fs.existsSync(…)`). */
const HOST_MODULES: ReadonlySet<string> = new Set(["os", "fs", "process"]);
/** The members of `process` that describe the host (its pid, cwd or argv describe the run, not the machine). */
const HOST_PROCESS_MEMBERS: ReadonlySet<string> = new Set(["platform", "env", "getuid", "geteuid", "getgid", "arch", "versions", "release", "config", "features"]);

/** One site: its line, the test (or suite) it is in, and its shape. */
export type SkipSite = Readonly<{ line: number; title: string; shape: string }>;

function nameOf(node: AstNode | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (node.type === "Identifier") return String(node.name);
  if (node.type === "StringLiteral") return String(node.value);
  if (node.type === "MemberExpression") return nameOf(astNode(node.object));
  if (node.type === "CallExpression") return nameOf(astNode(node.callee));
  return undefined;
}

/** The property name of a member expression (`a.b` → b), or undefined. */
function memberName(node: AstNode | undefined): string | undefined {
  if (node?.type !== "MemberExpression" || node.computed === true) return undefined;
  const property = astNode(node.property);
  return property?.type === "Identifier" ? String(property.name) : undefined;
}

const FUNCTION_TYPES: ReadonlySet<string> = new Set(["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration", "ObjectMethod", "ClassMethod"]);

/** Every site of one source. */
export function skipSites(path: string, source: string): readonly SkipSite[] {
  const program = parseSourceModule(path, source, { errorRecovery: true });
  const sites: SkipSite[] = [];
  const line = (node: AstNode): number => (node.loc as { start?: { line?: number } } | undefined)?.start?.line ?? 0;
  // The module's own bindings: imports, and top-level declarations (a function, a const, a let).
  const moduleBindings = new Map<string, AstNode | undefined>();
  const root = astNode((program as unknown as { program?: unknown }).program) ?? (program as unknown as AstNode);
  for (const statement of astNodeArray(root.body)) {
    collectBindings(statement, moduleBindings);
  }
  /** A declarer call's title (its first string or template argument), for the site's key. */
  const titleOf = (call: AstNode): string => {
    const first = astNodeArray(call.arguments)[0];
    if (first?.type === "StringLiteral") return String(first.value);
    if (first?.type === "TemplateLiteral") return astNodeArray(first.quasis).map((quasi) => String((quasi.value as { cooked?: string }).cooked ?? "")).join("${…}");
    return "<untitled>";
  };
  /** Whether `condition` asks the host, given the locals of the body it is in (`locals`) and the suite-level bindings (`outer`). */
  const asksHost = (condition: AstNode | undefined, locals: ReadonlyMap<string, AstNode | undefined>, outer: ReadonlyMap<string, AstNode | undefined>, seen: Set<string> = new Set(), throughLocal = false): boolean => {
    if (condition === undefined) return false;
    let found = false;
    walkAst(condition, (node) => {
      if (found) return;
      if (node.type === "MemberExpression") {
        const object = astNode(node.object);
        if (object?.type === "Identifier" && object.name === "process" && HOST_PROCESS_MEMBERS.has(memberName(node) ?? "")) found = true;
      }
      if (node.type === "CallExpression") {
        const callee = astNode(node.callee);
        // A bare host call (an imported `existsSync`, `platform`), or one on a host module (`os.platform()`); a method of
        // the test's own object (`backend.release(…)`) is not the host.
        const receiver = callee?.type === "MemberExpression" ? astNode(callee.object) : undefined;
        const name = callee?.type === "Identifier" ? String(callee.name)
          : receiver?.type === "Identifier" && HOST_MODULES.has(String(receiver.name)) ? memberName(callee) : undefined;
        if (name !== undefined && HOST_CALLS.has(name)) found = true;
      }
      if (node.type === "Identifier") {
        const name = String(node.name);
        if (HOST_NAMES.test(name)) { found = true; return; }
        if (locals.has(name)) {
          if (seen.has(name)) return;
          seen.add(name);
          // A local's own value asks the host only through a direct host source (a module's fixture constant it
          // was computed from is the test's data, not a decision about the host).
          if (asksHost(locals.get(name), locals, outer, seen, true)) found = true;
          return;
        }
        // A VALUE bound by the module or an enclosing suite, read by the guard itself: decided outside the test (a
        // probe's result, a flag a hook set).
        if (!throughLocal && (isValueBinding(outer, name) || isValueBinding(moduleBindings, name))) found = true;
      }
    });
    return found;
  };
  /** The returns of one body (not inside a nested function) guarded by an `if` that asks the host. */
  const silentReturns = (body: AstNode, outer: ReadonlyMap<string, AstNode | undefined>, title: string): void => {
    const locals = new Map<string, AstNode | undefined>();
    const visit = (node: AstNode, guards: readonly AstNode[]): void => {
      if (FUNCTION_TYPES.has(node.type)) return;
      if (node.type === "VariableDeclaration") collectBindings(node, locals);
      if (node.type === "ReturnStatement") {
        if (guards.some((guard) => asksHost(guard, locals, outer))) sites.push({ line: line(node), title, shape: "an early return on the host" });
        return;
      }
      if (node.type === "IfStatement" || node.type === "ConditionalExpression") {
        const guard = astNode(node.test);
        const inner = guard === undefined ? guards : [...guards, guard];
        for (const branch of [astNode(node.consequent), astNode(node.alternate)]) if (branch !== undefined) visit(branch, inner);
        return;
      }
      for (const [key, value] of Object.entries(node)) {
        if (key === "loc" || key === "start" || key === "end" || key === "extra") continue;
        if (Array.isArray(value)) for (const child of value) { const c = astNode(child); if (c !== undefined) visit(c, guards); }
        else { const c = astNode(value); if (c !== undefined) visit(c, guards); }
      }
    };
    visit(body, []);
  };
  /** The function a declarer is handed: inline, or a named body of this module. */
  const bodyOf = (argument: AstNode): AstNode | undefined => {
    if (argument.type === "ArrowFunctionExpression" || argument.type === "FunctionExpression") return astNode(argument.body);
    if (argument.type === "Identifier") {
      const bound = moduleBindings.get(String(argument.name));
      if (bound !== undefined && (bound.type === "ArrowFunctionExpression" || bound.type === "FunctionExpression" || bound.type === "FunctionDeclaration")) return astNode(bound.body);
    }
    return undefined;
  };
  /** Whether `call` declares a test or suite (a declarer, its member, `.each(…)(…)`, a test context's `t.test`). */
  const declares = (call: AstNode, contexts: ReadonlySet<string>): boolean => {
    const callee = astNode(call.callee);
    if (callee === undefined) return false;
    if (callee.type === "Identifier") return DECLARERS.has(String(callee.name));
    if (callee.type === "MemberExpression") {
      const member = memberName(callee);
      const receiver = astNode(callee.object);
      if (member === "test" && receiver?.type === "Identifier" && contexts.has(String(receiver.name))) return true; // node's `t.test(…)` subtests
      return DECLARERS.has(nameOf(callee) ?? "") && member !== undefined && !SKIPPING_MEMBERS.has(member);
    }
    if (callee.type === "CallExpression") return declares(callee, contexts); // `it.each(table)(title, body)`
    return false;
  };
  /** Each declarer call, its body walked with the bindings of every enclosing suite body. */
  const scan = (node: AstNode, outer: ReadonlyMap<string, AstNode | undefined>, title: string, registering: readonly AstNode[], contexts: ReadonlySet<string>): void => {
    if (node.type === "CallExpression") {
      const callee = astNode(node.callee);
      const member = memberName(callee);
      if (member !== undefined && SKIPPING_MEMBERS.has(member)) sites.push({ line: line(node), title, shape: `.${member}(…)` });
      const calleeName = callee?.type === "Identifier" ? String(callee.name) : member;
      // A helper that skips: named so, and handed the test's own context (`skipUnlessLinux(t)`).
      const handedContext = astNodeArray(node.arguments).some((argument) => argument.type === "Identifier" && contexts.has(String(argument.name)));
      if (calleeName !== undefined && /^skip/iu.test(calleeName) && !SKIPPING_MEMBERS.has(calleeName) && handedContext) sites.push({ line: line(node), title, shape: `a skipping helper ${calleeName}(…)` });
      if (declares(node, contexts)) {
        const own = titleOf(node);
        if (registering.some((guard) => asksHost(guard, new Map(), outer))) sites.push({ line: line(node), title: own, shape: "a test registered only on the host" });
        for (const argument of astNodeArray(node.arguments)) {
          const options = argument.type === "Identifier" ? moduleBindings.get(String(argument.name)) ?? outer.get(String(argument.name)) : argument;
          if (options?.type === "ObjectExpression") {
            for (const property of astNodeArray(options.properties)) {
              const key = astNode(property.key);
              if ((property.type === "ObjectProperty" || property.type === "ObjectMethod") && property.computed !== true && key !== undefined && SKIPPING_OPTIONS.has(nameOf(key) ?? "")) {
                sites.push({ line: line(property), title: own, shape: `a { ${nameOf(key)!} } option` });
              }
            }
          }
          const body = bodyOf(argument);
          if (body === undefined) continue;
          silentReturns(body, outer, own);
          // A suite body's own bindings are outside every test of it; the body's first parameter is the test's context.
          const inner = new Map(outer);
          for (const statement of body.type === "BlockStatement" ? astNodeArray(body.body) : []) collectBindings(statement, inner);
          const fn = argument.type === "Identifier" ? moduleBindings.get(String(argument.name)) : argument;
          const parameter = astNodeArray(fn?.params)[0];
          scan(body, inner, own, [], parameter?.type === "Identifier" ? new Set([...contexts, String(parameter.name)]) : contexts);
        }
        return;
      }
    }
    if (node.type === "MemberExpression") {
      const member = memberName(node);
      if (member !== undefined && SKIPPING_MEMBERS.has(member) && DECLARERS.has(nameOf(node) ?? "")) {
        sites.push({ line: line(node), title, shape: `a chosen .${member}` });
      }
    }
    if (FUNCTION_TYPES.has(node.type) && node !== program) {
      // A helper function's own returns are its business; its declarer calls are still found.
      for (const value of [astNode(node.body)]) if (value !== undefined) scan(value, outer, title, [], contexts);
      return;
    }
    if (node.type === "IfStatement") {
      const guard = astNode(node.test);
      for (const branch of [astNode(node.consequent), astNode(node.alternate)]) if (branch !== undefined) scan(branch, outer, title, guard === undefined ? registering : [...registering, guard], contexts);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "loc" || key === "start" || key === "end" || key === "extra" || key === "comments" || key === "leadingComments" || key === "trailingComments" || key === "innerComments") continue;
      if (Array.isArray(value)) for (const child of value) { const c = astNode(child); if (c !== undefined) scan(c, outer, title, registering, contexts); }
      else { const c = astNode(value); if (c !== undefined) scan(c, outer, title, registering, contexts); }
    }
  };
  scan(program as AstNode, new Map(), "<module>", [], new Set());
  // One site per statement and shape (a `.skip` member that is also called is one site).
  const seen = new Set<string>();
  return sites.filter((site) => {
    const key = `${String(site.line)}\u0000${site.shape.replace(/^a chosen (\.\w+)$/u, "$1(…)")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.line - b.line || a.shape.localeCompare(b.shape));
}

/** Whether `name` is bound in `bindings` to a VALUE: a variable whose initializer is not a function (an import or a function declaration is code, not a decision). */
function isValueBinding(bindings: ReadonlyMap<string, AstNode | undefined>, name: string): boolean {
  if (!bindings.has(name)) return false;
  const bound = bindings.get(name);
  if (bound === undefined) return VALUE_DECLARED.get(bindings)?.has(name) ?? false;
  return !FUNCTION_TYPES.has(bound.type);
}

/** The names each binding map holds as an UNINITIALIZED variable (`let ready;`, set later by a hook): a value, not an import. */
const VALUE_DECLARED = new WeakMap<ReadonlyMap<string, AstNode | undefined>, Set<string>>();

/** The names a statement binds, into `into`, each with its initializer (or the declaration itself for a function). */
function collectBindings(statement: AstNode, into: Map<string, AstNode | undefined>): void {
  const declaration = statement.type === "ExportNamedDeclaration" ? astNode(statement.declaration) : statement;
  if (declaration === undefined) return;
  if (declaration.type === "ImportDeclaration") {
    for (const specifier of astNodeArray(declaration.specifiers)) {
      const local = astNode(specifier.local);
      if (local?.type === "Identifier") into.set(String(local.name), undefined);
    }
  }
  if (declaration.type === "FunctionDeclaration") {
    const id = astNode(declaration.id);
    if (id?.type === "Identifier") into.set(String(id.name), declaration);
  }
  if (declaration.type === "VariableDeclaration") {
    for (const declarator of astNodeArray(declaration.declarations)) {
      const id = astNode(declarator.id);
      if (id?.type === "Identifier" && astNode(declarator.init) === undefined) {
        const declared = VALUE_DECLARED.get(into) ?? new Set<string>();
        declared.add(String(id.name));
        VALUE_DECLARED.set(into, declared);
      }
      if (id?.type === "Identifier") into.set(String(id.name), astNode(declarator.init));
      else if (id !== undefined) walkAst(id, (inner) => { if (inner.type === "Identifier") into.set(String(inner.name), astNode(declarator.init)); });
    }
  }
}

/**
 * THE HERMETIC POPULATION, repository-relative: every engine source the
 * disposition registry calls `canonical-node-test`, every web source the
 * vitest include collects, and every Playwright spec (`*.spec.ts` under the
 * web tests).
 */
export function hermeticSources(repositoryRoot: string): readonly string[] {
  const engineRoot = join(repositoryRoot, "engine");
  const manifest = parseTestSurfaceDispositionManifestText(readFileSync(join(engineRoot, ROOT_POLICY.verification.testDiscovery.dispositionRegistry.manifestPath), "utf8"));
  // Every canonical source: an entry's, or the default a qualified Node test source takes without one.
  const engine = effectiveDispositionEntries(listRecognizableTestPaths(engineRoot), manifest)
    .filter((entry) => entry.disposition === "canonical-node-test").map((entry) => `engine/${entry.path}`);
  const web: string[] = [];
  for (const pattern of TEST_INCLUDE) {
    const shape = /^([a-z0-9/_-]+)\/\*\*\/\*\.test\.ts$/u.exec(pattern);
    if (shape === null) throw new Error(`the web include ${pattern} is not of the "<dir>/**/*.test.ts" shape the hermetic finder reads: teach it the new shape`);
    const directory = join(repositoryRoot, shape[1]!);
    if (!isDirectory(directory)) throw new Error(`the web include ${pattern} names no folder (${directory}): the hermetic population cannot be read`);
    for (const file of walk(directory, { exts: [".ts"] })) if (file.endsWith(".test.ts")) web.push(relative(repositoryRoot, file).split("\\").join("/"));
  }
  const specs = walk(join(repositoryRoot, "tests"), { exts: [".ts"] }).filter((file) => file.endsWith(".spec.ts")).map((file) => relative(repositoryRoot, file).split("\\").join("/"));
  return [...new Set([...engine, ...web, ...specs])].toSorted();
}

function isDirectory(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
}

/** Every site of the hermetic population, `path:line`, its test and its shape. */
export function hermeticSkipFindings(repositoryRoot: string): readonly string[] {
  return hermeticSources(repositoryRoot).flatMap((path) =>
    skipSites(path, readFileSync(join(repositoryRoot, path), "utf8")).map((site) => `${path}:${String(site.line)} (${site.title}): ${site.shape}`));
}
