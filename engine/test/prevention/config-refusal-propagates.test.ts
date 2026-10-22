/**
 * GUARD SUBJECT: a configuration refusal is never answered with a quiet default — no caller catches a config read
 * GUARD OWNS: every config read in engine/src, engine/scripts and server/ — the loader, the raw reader and decoder of kernel/config.ts, their absence doors, and every function that calls one directly
 * GUARD PLANT: wrap a config read in `try { … } catch { return defaults }`, in `bestEffort(() => …)`, or chain `.catch(…)` on it
 * GUARD DRIVEN: the loader itself (absent → the typed absence, planted alternate document → alternate_config_denied through IfPresent) and the CLI self-protection bootstrap in a working copy
 * GUARD LIVENESS: the detector flags each planted spelling before the universe is judged, and the universe holds the known readers
 *
 * THE CLASS. `loadPinnedConfigSnapshot` refuses a document for reasons the
 * operator must see: a planted alternate `*.config.json`, a link alias, a
 * mode, owner or identity violation, a schema breach. Seven callers used to
 * catch that and carry on — with section defaults, or (the CLI's
 * self-protection bootstrap) with the guardian switched OFF — so a planted
 * file silently downgraded the harness. The only legitimate "no config"
 * answer is an ABSENT document, decided once in the owner
 * (`loadPinnedConfigSnapshotIfPresent`, kernel/config.ts). This guard refuses
 * any other catch around a config read, so the class cannot recur by a new
 * caller: a direct call or a call to a direct wrapper inside a `try` whose
 * `catch` does not end by rethrowing, inside a best-effort callback, or with
 * a `.catch(…)` chained on it.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { parse } from "@babel/parser";

import { astChildren, astNode, babelParserPluginsForSourcePath, type AstNode } from "../../src/quality-packs/prevention/ast-helpers.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { bodyCallsWith, functionBody } from "../../src/shared/source-structure.ts";
import { walk } from "../../scripts/verification/source-walk.ts";
import { createRepositoryWorkingCopy, removeRepositoryLocalTemporaryDirectory } from "../support/repository-local-temporary.ts";

const ENGINE_ROOT = join(import.meta.dirname, "..", "..");
const LOADER = "loadPinnedConfigSnapshot";
/**
 * Every document-reading export of the config owner. The `IfPresent` doors are
 * seeds too: they already answered the one legitimate "none", so a catch
 * around them can only be swallowing a refusal.
 */
const OWNER_READERS = [
  LOADER,
  "loadPinnedConfigSnapshotIfPresent",
  "readConfigDocumentRaw",
  "readConfigDocumentRawIfPresent",
  "decodeConfigDocumentRaw",
] as const;
const OWNER = "src/kernel/config.ts";
const SOURCE_EXTENSIONS = [".ts", ".mts"] as const;

type Source = Readonly<{ path: string; program: AstNode }>;

function parseSource(path: string, text: string): Source {
  const parsed = parse(text, {
    sourceType: "module",
    plugins: [...babelParserPluginsForSourcePath(path)] as never,
    errorRecovery: false,
  }) as unknown as { program: unknown };
  return { path, program: astNode(parsed.program)! };
}

const NAMED_DEFINITIONS = new Set(["FunctionDeclaration", "ClassMethod", "ClassPrivateMethod", "ObjectMethod"]);

/** The name a call invokes: `f()` → f, `a.b.f()` → f. */
function calleeName(call: AstNode): string | undefined {
  const callee = astNode(call.callee);
  if (callee?.type === "Identifier") return String(callee.name);
  if (callee?.type === "MemberExpression" && astNode(callee.property)?.type === "Identifier") {
    return String(astNode(callee.property)!.name);
  }
  return undefined;
}

/** The name of the definition a function node is: a declaration, a method, or a `const f = () => …`. */
function definitionName(node: AstNode, parent: AstNode | undefined): string | undefined {
  if (node.type === "FunctionDeclaration") return astNode(node.id)?.name as string | undefined;
  if (node.type === "ClassMethod" || node.type === "ObjectMethod" || node.type === "ClassPrivateMethod") {
    const key = astNode(node.key);
    return key?.type === "Identifier" ? String(key.name) : undefined;
  }
  if ((node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") && parent?.type === "VariableDeclarator") {
    return astNode(parent.id)?.name as string | undefined;
  }
  return undefined;
}

function visit(node: AstNode, ancestors: AstNode[], onNode: (node: AstNode, ancestors: readonly AstNode[]) => void): void {
  onNode(node, ancestors);
  ancestors.push(node);
  for (const child of astChildren(node)) visit(child, ancestors, onNode);
  ancestors.pop();
}

/**
 * The functions that call the loader DIRECTLY (the readers a caller could
 * swallow), by name. An EXPORTED reader is matched in every file; a
 * module-private one only in its own file, so a private `run()` that reads the
 * config does not make every `run()` in the engine a reader.
 */
export type ConfigReaders = Readonly<{ exported: ReadonlySet<string>; privateByFile: ReadonlyMap<string, ReadonlySet<string>> }>;

/** Whether the definition at `ancestors[index]` is reachable from other files. */
function isExported(ancestors: readonly AstNode[], index: number): boolean {
  const node = ancestors[index]!;
  if (node.type !== "FunctionDeclaration" && node.type !== "ArrowFunctionExpression" && node.type !== "FunctionExpression") {
    return true; // a method: callable through any instance, so matched everywhere
  }
  const holder = node.type === "FunctionDeclaration" ? ancestors[index - 1] : ancestors[index - 3];
  return holder?.type === "ExportNamedDeclaration" || holder?.type === "ExportDefaultDeclaration";
}

export function configReaders(sources: readonly Source[]): ConfigReaders {
  const exported = new Set<string>(OWNER_READERS);
  const privateByFile = new Map<string, Set<string>>();
  for (const source of sources) {
    if (source.path === OWNER) continue;
    visit(source.program, [], (node, ancestors) => {
      const callee = node.type === "CallExpression" ? calleeName(node) : undefined;
      if (callee === undefined || !(OWNER_READERS as readonly string[]).includes(callee)) return;
      for (let index = ancestors.length - 1; index >= 0; index -= 1) {
        const name = definitionName(ancestors[index]!, ancestors[index - 1]);
        if (name === undefined) continue;
        if (isExported(ancestors, index)) {
          exported.add(name);
        } else {
          const own = privateByFile.get(source.path) ?? new Set<string>();
          own.add(name);
          privateByFile.set(source.path, own);
        }
        return;
      }
    });
  }
  return { exported, privateByFile };
}

/** Whether `node` (anywhere below) reads the identifier `name`. */
function mentions(node: AstNode, name: string): boolean {
  if (node.type === "Identifier" && node.name === name) return true;
  return astChildren(node).some((child) => mentions(child, name));
}

function isNonZeroNumber(node: AstNode | undefined): boolean {
  return node?.type === "NumericLiteral" && node.value !== 0;
}

/** `{ …, status: "fail", … }`, possibly wrapped in one call (`deepFreeze({…})`). */
function isFailResult(node: AstNode | undefined): boolean {
  const object = node?.type === "CallExpression" ? astNode((node.arguments as unknown[])[0]) : node;
  return object?.type === "ObjectExpression" && (object.properties as unknown[]).map(astNode).some((property) =>
    property?.type === "ObjectProperty" && astNode(property.key)?.name === "status" &&
    astNode(property.value)?.type === "StringLiteral" && astNode(property.value)?.value === "fail");
}

/**
 * A handler that does not swallow: it ends by rethrowing, or it is a FAILURE
 * BOUNDARY — it reports the caught error (reads its binding) and ends by
 * failing: a non-zero return or exit code, or a `status: "fail"` result. A
 * catch that carries on with defaults, a dev mode or `undefined` is neither.
 */
function propagates(parameter: AstNode | undefined, body: AstNode | undefined): boolean {
  const statements = ((body?.body as unknown[] | undefined) ?? []).map(astNode);
  const last = statements.at(-1);
  if (last?.type === "ThrowStatement") return true;
  const binding = parameter?.type === "Identifier" ? String(parameter.name) : undefined;
  if (binding === undefined || body === undefined || !mentions(body, binding)) return false;
  if (last?.type === "ReturnStatement") return isNonZeroNumber(astNode(last.argument)) || isFailResult(astNode(last.argument));
  const expression = last?.type === "ExpressionStatement" ? astNode(last.expression) : undefined;
  if (expression?.type === "AssignmentExpression") {
    const target = astNode(expression.left);
    return target?.type === "MemberExpression" && astNode(target.property)?.name === "exitCode" && isNonZeroNumber(astNode(expression.right));
  }
  if (expression?.type === "CallExpression" && calleeName(expression) === "exit") {
    return isNonZeroNumber(astNode((expression.arguments as unknown[])[0]));
  }
  return false;
}

/** Every call of a config reader that a caller swallows, as `path:line — how`. */
export function swallowedConfigReads(sources: readonly Source[], readers: ConfigReaders): readonly string[] {
  const hits: string[] = [];
  for (const source of sources) {
    if (source.path === OWNER) continue;
    visit(source.program, [], (node, ancestors) => {
      if (node.type !== "CallExpression") return;
      const name = calleeName(node);
      if (name === undefined || !(readers.exported.has(name) || readers.privateByFile.get(source.path)?.has(name) === true)) return;
      const line = (node.loc as { start: { line: number } } | undefined)?.start.line ?? 0;
      const where = `${source.path}:${line} ${name}()`;
      let child: AstNode = node;
      for (let index = ancestors.length - 1; index >= 0; index -= 1) {
        const ancestor = ancestors[index]!;
        if (ancestor.type === "MemberExpression" && astNode(ancestor.object) === child &&
          astNode(ancestor.property)?.name === "catch") {
          const handler = astNode(((ancestors[index - 1]?.arguments as unknown[] | undefined) ?? [])[0]);
          const handlerBody = astNode(handler?.body);
          if (handlerBody?.type !== "BlockStatement" || !propagates(astNode((handler!.params as unknown[])[0]), handlerBody)) {
            hits.push(`${where} — .catch() chained on a config read does not fail`);
            return;
          }
        }
        if (ancestor.type === "TryStatement" && astNode(ancestor.block) === child) {
          const handler = astNode(ancestor.handler);
          if (handler !== undefined && !propagates(astNode(handler.param), astNode(handler.body))) {
            hits.push(`${where} — inside a try whose catch does not rethrow`);
            return;
          }
        }
        if ((ancestor.type === "ArrowFunctionExpression" || ancestor.type === "FunctionExpression")) {
          const holder = ancestors[index - 1];
          if (holder?.type === "CallExpression" && (holder.arguments as unknown[]).includes(ancestor) &&
            /^bestEffort/u.test(calleeName(holder) ?? "")) {
            hits.push(`${where} — inside ${calleeName(holder)}()`);
            return;
          }
        }
        if (NAMED_DEFINITIONS.has(ancestor.type) || definitionName(ancestor, ancestors[index - 1]) !== undefined) return;
        child = ancestor;
      }
    });
  }
  return hits;
}

const REPOSITORY_ROOT = join(ENGINE_ROOT, "..");

/** The engine's src/scripts (paths relative to the engine) and the web server
 * (paths relative to the repository, `server/…`): every config reader lives
 * in one of them. */
function engineSources(): readonly Source[] {
  const engine = ["src", "scripts"].flatMap((root) => walk(join(ENGINE_ROOT, root), { exts: [...SOURCE_EXTENSIONS] }))
    .map((file) => parseSource(relative(ENGINE_ROOT, file).split("\\").join("/"), readFileSync(file, "utf8")));
  const server = walk(join(REPOSITORY_ROOT, "server"), { exts: [...SOURCE_EXTENSIONS] })
    .map((file) => parseSource(relative(REPOSITORY_ROOT, file).split("\\").join("/"), readFileSync(file, "utf8")));
  return [...engine, ...server];
}

test("config-refusal-propagates: the detector flags each swallowing spelling and leaves propagation alone", () => {
  const plant = (text: string) => {
    const sources = [parseSource("planted.ts", text)];
    return swallowedConfigReads(sources, configReaders(sources));
  };
  const loader = LOADER;
  const swallowed = [
    `function a() { try { return ${loader}().document; } catch { return undefined; } }`,
    `const a = () => bestEffort(() => ${loader}().document.performance) ?? DEFAULTS;`,
    `function r() { return ${loader}().document.harness; }\nfunction b() { try { return r(); } catch (e) { console.warn(e); return DEFAULT_TIMEOUT_MS; } }`,
    `async function c() { return (async () => ${loader}())().catch(() => undefined); }`,
    `function e() { try { return ${loader}(); } catch (error) { console.warn(error); return DEFAULTS; } }`,
    `function d() { try { if (x) { const s = ${loader}(); use(s); } } catch { /* dev mode */ } }`,
    "function f(p) { try { return readConfigDocumentRawIfPresent(p) ?? {}; } catch { return {}; } }",
    "function g(t) { try { return decodeConfigDocumentRaw(t); } catch (error) { warn(error); return {}; } }",
  ];
  for (const text of swallowed) assert.equal(plant(text).length, 1, `must be flagged:\n${text}`);
  const propagated = [
    `function a() { return ${loader}().document.harness?.x ?? 1; }`,
    `function a() { try { return ${loader}(); } catch (error) { cleanup(); throw error; } }`,
    `function a() { try { return ${loader}(); } finally { cleanup(); } }`,
    `function main() { try { ${loader}(); return 0; } catch (error) { report(error); return 1; } }`,
    `function step() { try { ${loader}(); } catch (error) { return deepFreeze({ step: "x", status: "fail", message: String(error) }); } }`,
    `function r() { return ${loader}(); }\nr().then(() => 0).catch((error) => { report(error); process.exit(1); });`,
    `function a() { const run = () => ${loader}(); try { other(); } catch { return 0; } return run(); }`,
  ];
  for (const text of propagated) assert.deepEqual(plant(text), [], `must not be flagged:\n${text}`);
});

test("config-refusal-propagates: no config read in the engine is caught, wrapped best-effort, or .catch()-ed", () => {
  const sources = engineSources();
  const readers = configReaders(sources);
  // Liveness: the universe really holds the readers this guard exists for.
  for (const known of ["readTestExecutionConfig", "configuredPerformanceConfig", "isDevMode"]) {
    assert.ok(readers.exported.has(known), `the scan no longer sees the config reader ${known}`);
  }
  // …and the web server's one read door (module-private) answers through the
  // owner's DATA-form inspection: a refusal arrives as a value, so nothing
  // there can catch one (wf1b-design L3 removed its re-derived catch).
  // Asked of the door's OWN body (the structural scope owner), not of a byte
  // window between it and whatever function happens to follow it.
  const serverDoor = functionBody(readFileSync(join(REPOSITORY_ROOT, "server", "kernel", "harness-config.ts"), "utf8"), "readConfigDocumentIfPresent");
  assert.ok(bodyCallsWith(serverDoor, "inspectConfigDocument", ["configPath"]),
    "the server's config read door no longer answers through the owner's inspection");
  assert.equal(readers.privateByFile.get("server/kernel/harness-config.ts"), undefined,
    "the server's config owner calls a THROWING reader again: route it through inspectConfigDocument");
  assert.deepEqual(swallowedConfigReads(sources, readers), [],
    "a configuration refusal must propagate; only kernel/config.ts decides the absent case (loadPinnedConfigSnapshotIfPresent)");
});

test("config-refusal-propagates: absent is the typed absence; a planted alternate document is refused, CLI included", () => {
  // The loader pins the configuration of the checkout its own module lives
  // in, so the refusal is driven in a working copy of the engine sources.
  const copy = createRepositoryWorkingCopy("config-refusal-", {
    include: (path) => path.startsWith("engine/src/") || path.startsWith("shared/") ||
      path === `engine/${ROOT_POLICY.configuration.basename}` || path === "engine/package.json",
  });
  try {
    const configModule = pathToFileURL(join(copy.engineRoot, "src", "kernel", "config.ts")).href;
    const probe = (): string => {
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", [
        `const { loadPinnedConfigSnapshotIfPresent } = await import(${JSON.stringify(configModule)});`,
        "try { process.stdout.write(loadPinnedConfigSnapshotIfPresent() === undefined ? 'absent' : 'loaded'); }",
        "catch (error) { process.stdout.write(error.code ?? String(error)); }",
      ].join("\n")], { cwd: copy.engineRoot, encoding: "utf8", timeout: 120_000 });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
    assert.equal(probe(), "loaded");
    const stray = join(copy.engineRoot, "stray-copy.config.json");
    writeFileSync(stray, "{}\n", { mode: 0o600 });
    assert.equal(probe(), "alternate_config_denied");
    // The CLI's self-protection bootstrap: a refused document is a refusal,
    // never "dev mode, unprotected".
    const cli = spawnSync(process.execPath, [join(copy.engineRoot, "src", "cli.ts"), "--version"], {
      cwd: copy.engineRoot, encoding: "utf8", timeout: 120_000,
    });
    assert.notEqual(cli.status, 0);
    assert.match(`${cli.stdout}${cli.stderr}`, /alternate_config_denied/u);
    assert.doesNotMatch(cli.stderr, /self_protection_disabled_dev_mode/u);
    rmSync(stray);
    rmSync(join(copy.engineRoot, ROOT_POLICY.configuration.basename));
    assert.equal(probe(), "absent");
  } finally {
    removeRepositoryLocalTemporaryDirectory(copy.root);
  }
});
