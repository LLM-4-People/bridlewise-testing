/**
 * THE DECLARED OWNERS OF A DIRECT PROCESS SPAWN.
 *
 * Every process the repository starts runs through one door: the one bounded
 * run (`runCpuBounded` / `runCpuBoundedSync`, src/process/), or the git door
 * built on it (`gitOutput`, src/git/git-door.ts). A module may take a value
 * from `node:child_process` only when it is declared in {@link SPAWN_OWNERS},
 * with the reason it cannot use that door: it IS the door, it confines or
 * measures the process itself, the process is long-lived by design, or it runs
 * where the engine cannot load. A type-only import starts nothing and is not
 * counted.
 *
 * THIS IS A CONSISTENCY AID, NOT A SECURITY BOUNDARY. It keeps the
 * repository's own, cooperative code on the one door, and it reads syntax: a
 * module determined to start a process can always find a form no syntax
 * check follows. The boundary against hostile code is the kernel's: #634's
 * confinement of every test and command run. Out of its scope by design: a
 * loader hook (`module.register`), which changes what any import means, is
 * #634's to contain. The scan names every form it reads ({@link SpawnForm}).
 * The forms it cannot read reliably — a computed module specifier, a
 * `binding`/`_linkedBinding` call on `process` however it is reached, the
 * `vm` module, an eval'd worker or one whose options are not an inline object
 * literal, the `cluster` module — are REFUSED outside
 * {@link UNREADABLE_LOADERS}, each declared with its reason, never let
 * through.
 *
 * `engine/test/prevention/spawn-owners.test.ts` refuses a form outside its
 * list, and an entry whose file no longer holds the form, so the lists stay
 * exact; each form has a planted case and a mutation that disables it. Test
 * code (the suites' own folders and `*.test.*` files) is out of scope: the
 * test runners bound each test process.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parse } from "@babel/parser";

import { trackedFiles } from "../../src/git/repository-ownership.ts";

/** Repository-relative path → why it spawns directly. */
export const SPAWN_OWNERS: Readonly<Record<string, string>> = Object.freeze({
  // ── The doors themselves and the process infrastructure under them ─────────
  "engine/src/process/supervised-run.ts": "the one bounded run, the test-run supervisor and the one detached launch: the door every other spawn goes through",
  "engine/src/process/subprocess-bounds.ts": "applies the kernel CPU limit to this process (prlimit): part of the one bounded run's own mechanism",
  "engine/src/process/instrument-lock.ts": "places a run in its own systemd scope (busctl): the instrument lock is imported by the bounded run's adoption, so routing through the run would be a cycle",
  "engine/src/process/pinned-process-internal.ts": "the pinned, closed-environment exec of the workspace git port, with its own output and time bounds (#329 moves its calls onto the bounded run)",
  "engine/src/filesystem/self-protection/guardian-binary.ts": "starts the Landlock guardian, which confines the command it runs: the confinement launcher",
  "engine/src/filesystem/self-protection/confined-run.ts": "runs a command inside the Landlock guardian: the confinement launcher",
  "engine/src/shared/run-cpu.ts": "the CPU calibration child: a measurement of CPU work must run unwrapped",
  "server/safety/landlock-runner.ts": "the web server's confined runner, the one door for the web tool's commands",
  // ── Long-lived or supervised by design ─────────────────────────────────────
  "engine/src/intelligence/process-farm.ts": "forked analysis workers under the farm's own crash supervisor",
  "engine/src/tools/built-in-tools.ts": "the agent's command tool: streams a confined command's output under the tool's own bounds",
  "engine/src/tools/concurrent/long-task-runner.ts": "long-running tasks under systemd (systemd-run, systemctl): long-lived by design",
  "engine/src/tools/concurrent/long-task-wrapper.mjs": "the wrapper systemd starts for a long-running task: long-lived by design",
  "scripts/dev-all.ts": "the development servers: long-lived by design",
  "scripts/sd.mjs": "starts and probes the development stack (systemd-run, the dev servers): long-lived by design",
  "scripts/testing/perf-profile.ts": "starts the profiled server stack as a long-lived process group, stopped through the one terminator",
  "bench/run.ts": "runs each benchmark suite as the measured process, its output live",
  "bench/wire/server.ts": "the server under load: long-lived for the benchmark",
  // ── Where the engine cannot load ───────────────────────────────────────────
  "bin/bridlewise.mjs": "the published launcher: hands the process to the engine CLI before anything of the engine is loaded",
  "engine/src/shared/workflow/e2e-runner.mjs": "a standalone utility kept OUTSIDE the harness module graph (engine/test/runtime/cli-debug.test.ts, entrypoint-recording-wiring.test.ts), so it cannot load the bounded run: the merge gate's e2e suite under its own suite bound",
  "scripts/check-docs-links.mjs": "runs before any dependency is installed (the docs-links job), so it cannot load the bounded run: one fixed `git ls-files`",
  "scripts/test-shard-manifest.mjs": "runs in the shard merge job, which installs no package, so it cannot load the bounded run: fixed `git` reads",
  // ── Fixtures, experiments and frozen records ───────────────────────────────
  "engine/scripts/exp409/run-escalate.mjs": "a frozen experiment (exp409), kept as its record",
  "engine/scripts/exp409/sweep.mjs": "a frozen experiment (exp409), kept as its record",
  "engine/scripts/exp435/compare.mjs": "a frozen experiment (exp435), kept as its record",
  "engine/_experiments/unified/awareness/engine.ts": "a frozen experiment, kept as its record",
  "engine/verification/benchmarks/coordination/migration-write-authority/repository-facts.mjs": "a frozen benchmark record (its commands are the measured evidence)",
  "engine/verification/benchmarks/coordination/migration-write-authority/test-contracts.mjs": "a frozen benchmark record (its commands are the measured evidence)",
  "engine/verification/benchmarks/security/s3-key-anchor-qualification/run-all.mjs": "a frozen qualification record: deliberate crash and descriptor fixtures",
  "engine/verification/benchmarks/security/s3-key-anchor-qualification/src/anchor-qualification.mjs": "a frozen qualification record: deliberate crash and descriptor fixtures",
  "engine/verification/benchmarks/storage/s3-sqlite-adapter-benchmark/benchmark.mjs": "a frozen benchmark record",
  "engine/verification/benchmarks/storage/s3-sqlite-adapter-benchmark/install-check.mjs": "a frozen benchmark record",
  "engine/verification/benchmarks/storage/s3-sqlite-adapter-benchmark/superseded/v1-7ee3f532-7a58ace4/expanded-runner/verification/benchmarks/storage/s3-sqlite-adapter-benchmark/benchmark.mjs": "a superseded benchmark record",
  "engine/verification/benchmarks/storage/s3-sqlite-adapter-benchmark/superseded/v1-7ee3f532-7a58ace4/expanded-runner/verification/benchmarks/storage/s3-sqlite-adapter-benchmark/install-check.mjs": "a superseded benchmark record",
  "engine/verification/benchmarks/storage/s4-storage-qualification/qualification.mjs": "a frozen qualification record",
});

/**
 * Repository-relative path → why it holds a form the scan cannot read (a
 * computed module specifier, `process.binding`, the `vm` module, an eval'd
 * worker, the `cluster` module). Filled from the tree's own scan.
 */
export const UNREADABLE_LOADERS: Readonly<Record<string, string>> = Object.freeze({
  "engine/src/awareness/languages/tree-sitter-base.ts": "requires the tree-sitter grammar package each language names, through a bound createRequire",
  "engine/src/memory/tool-result-retrieval.ts": "imports the optional embeddings package through a constant held in a variable, so a tree without it still builds: never a name from outside",
  "engine/src/memory/unified/unified-embeddings.ts": "imports the optional embeddings package through a constant held in a variable, so a tree without it still builds: never a name from outside",
  "engine/src/process/worker-bootstrap.ts": "the worker prelude imports a thread's entry, admitted only from DECLARED_WORKER_ENTRIES and refused typed otherwise",
  "engine/src/quality/languages/shared/tree-sitter-loader.ts": "requires a language grammar package by its name in the loader's own grammar table",
  "engine/src/shared/memory/retrieval/embeddings.ts": "imports the optional embeddings package through a constant held in a variable, so a tree without it still builds: never a name from outside",
  "engine/traceability/sources/s2/mcp-jsonrpc.ts": "a recorded excerpt of the MCP schema (an S2 source record), fragments that are not a complete module: never loaded",
  "engine/traceability/sources/s2/mcp-tools.ts": "a recorded excerpt of the MCP schema (an S2 source record), fragments that are not a complete module: never loaded",
  "scripts/sd.mjs": "loads the dev server's config module by its path in the checkout it starts (also a spawn owner: the dev stack)",
  "scripts/template-check.ts": "requires a template package's bin by the path it resolved, to check that template",
  "server/safety/artifact-check.ts": "compiles an artifact's script with vm.Script only to read its syntax error, never to run it",
});

const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]s|tsx|jsx)$/u;
const CHILD_PROCESS = new Set(["child_process", "node:child_process"]);
const VM = new Set(["vm", "node:vm"]);
const CLUSTER = new Set(["cluster", "node:cluster"]);

/**
 * Every form the scan reads. The first four take a value from
 * `node:child_process` (owned by {@link SPAWN_OWNERS}); the rest are the forms
 * it cannot read reliably (owned by {@link UNREADABLE_LOADERS}).
 */
export const SPAWN_FORMS = Object.freeze([
  "static-import",
  "re-export",
  "dynamic-import",
  "named-call",
  "computed-import",
  "computed-require",
  "process-binding",
  "vm-module",
  "eval-worker",
  "opaque-worker-options",
  "cluster-module",
  "unparsable",
] as const);
export type SpawnForm = typeof SPAWN_FORMS[number];
const CHILD_PROCESS_FORMS: ReadonlySet<SpawnForm> = new Set(["static-import", "re-export", "dynamic-import", "named-call"]);

/** Whether `path` (repository-relative) is test code, out of this guard's scope. */
export function isTestSource(path: string): boolean {
  return /(?:^|\/)(?:test|tests)\//u.test(path) || /\.test\.[cm]?[jt]sx?$/u.test(path);
}

type AstNode = Readonly<{ type: string; [key: string]: unknown }>;

function isNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

/** A specifier the scan can read: a string literal, or a template literal with no expression. */
function staticSpecifier(node: unknown): string | undefined {
  if (!isNode(node)) return undefined;
  if (node.type === "StringLiteral" && typeof node["value"] === "string") return node["value"];
  if (node.type === "TemplateLiteral" && Array.isArray(node["expressions"]) && node["expressions"].length === 0) {
    const quasis = node["quasis"];
    const first: unknown = Array.isArray(quasis) ? quasis.at(0) : undefined;
    const cooked = isNode(first) ? (first["value"] as { cooked?: unknown } | undefined)?.cooked : undefined;
    return typeof cooked === "string" ? cooked : undefined;
  }
  return undefined;
}

function memberName(node: AstNode): string | undefined {
  const property = node["property"];
  if (!isNode(property)) return undefined;
  if (node["computed"] !== true && property.type === "Identifier") return property["name"] as string;
  return staticSpecifier(property);
}

function isIdentifier(node: unknown, name: string): boolean {
  return isNode(node) && node.type === "Identifier" && node["name"] === name;
}

/** Whether `node` is a `createRequire(…)` call. */
function isCreateRequireCall(node: unknown): boolean {
  if (!isNode(node) || node.type !== "CallExpression") return false;
  const inner = node["callee"];
  return isIdentifier(inner, "createRequire") || (isNode(inner) && inner.type === "MemberExpression" && memberName(inner) === "createRequire");
}

/**
 * A callee that loads a module by name: `require`, `module.require`,
 * `createRequire(…)` (called at once, or through a name it was bound to:
 * `loaders`) and `process.getBuiltinModule`.
 */
function isModuleLoader(callee: unknown, loaders: ReadonlySet<string>): boolean {
  if (!isNode(callee)) return false;
  if (isIdentifier(callee, "require")) return true;
  if (callee.type === "Identifier" && loaders.has(callee["name"] as string)) return true;
  if (callee.type === "MemberExpression" || callee.type === "OptionalMemberExpression") {
    const name = memberName(callee);
    return name === "require" || (name === "getBuiltinModule" && isIdentifier(callee["object"], "process"));
  }
  return isCreateRequireCall(callee);
}

/** The names a module binds to a `createRequire(…)` result. */
function boundLoaders(program: unknown): ReadonlySet<string> {
  const names = new Set<string>();
  const pending: unknown[] = [program];
  while (pending.length > 0) {
    const node = pending.pop();
    if (Array.isArray(node)) { pending.push(...node); continue; }
    if (!isNode(node)) continue;
    if (node.type === "VariableDeclarator" && isCreateRequireCall(node["init"]) && isNode(node["id"]) && node["id"].type === "Identifier") names.add(node["id"]["name"] as string);
    if (node.type === "AssignmentExpression" && isCreateRequireCall(node["right"]) && isNode(node["left"]) && node["left"].type === "Identifier") names.add(node["left"]["name"] as string);
    for (const [key, value] of Object.entries(node)) {
      if (key === "loc" || key === "start" || key === "end" || key === "extra" || key.endsWith("Comments")) continue;
      if (typeof value === "object" && value !== null) pending.push(value);
    }
  }
  return names;
}

/** Whether `node` reaches `process`: the identifier, or a member named `process` on anything (`globalThis.process`). */
function reachesProcess(node: unknown): boolean {
  if (!isNode(node)) return false;
  if (node.type === "Identifier") return node["name"] === "process";
  if (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") return memberName(node) === "process";
  if (node.type === "TSNonNullExpression" || node.type === "TSAsExpression" || node.type === "ParenthesizedExpression") return reachesProcess(node["expression"]);
  return false;
}

/** Whether a `new Worker(…)` spells its arguments through the one worker spawn: `...bootstrappedWorker(…)`. */
function isBootstrappedSpread(argument: unknown): boolean {
  if (!isNode(argument) || argument.type !== "SpreadElement") return false;
  const spread = argument["argument"];
  return isNode(spread) && spread.type === "CallExpression" && isIdentifier(spread["callee"], "bootstrappedWorker");
}

function isWorkerConstructor(callee: unknown): boolean {
  return isIdentifier(callee, "Worker") || (isNode(callee) && callee.type === "MemberExpression" && memberName(callee) === "Worker");
}

/** Whether an object literal holds `eval: true`. */
function holdsEvalTrue(node: unknown): boolean {
  if (!isNode(node) || node.type !== "ObjectExpression") return false;
  return ((node["properties"] as readonly unknown[] | undefined) ?? []).some((property) =>
    isNode(property) && property.type === "ObjectProperty" && (isIdentifier(property["key"], "eval") || staticSpecifier(property["key"]) === "eval") &&
    isNode(property["value"]) && property["value"].type === "BooleanLiteral" && property["value"]["value"] === true);
}

/** Every form `source` (a module's text) holds, in syntax order of discovery; `disabled` switches one form off (the guard's own mutation test). */
export function spawnFormsIn(source: string, path: string, disabled?: SpawnForm): ReadonlySet<SpawnForm> {
  const found = new Set<SpawnForm>();
  const hit = (form: SpawnForm): void => { if (form !== disabled) found.add(form); };
  let ast: ReturnType<typeof parse>;
  try {
    ast = parse(source, {
      sourceType: "unambiguous",
      errorRecovery: true,
      plugins: /\.[cm]?tsx?$/u.test(path) ? ["typescript", ...(path.endsWith("x") ? ["jsx" as const] : [])] : ["jsx"],
    });
  } catch {
    // A module the scan cannot parse holds forms nobody can read: refused unless declared.
    hit("unparsable");
    return found;
  }
  const loaders = boundLoaders(ast.program);
  const pending: unknown[] = [ast.program];
  while (pending.length > 0) {
    const node = pending.pop();
    if (Array.isArray(node)) {
      pending.push(...node);
      continue;
    }
    if (!isNode(node)) continue;
    if (node.type === "ImportDeclaration") {
      const specifier = staticSpecifier(node["source"]) ?? "";
      const listed = node["specifiers"];
      const specifiers = Array.isArray(listed) ? listed.filter(isNode) : undefined;
      const typeOnly = node["importKind"] === "type" || (specifiers !== undefined && specifiers.length > 0 && specifiers.every((entry) => entry["importKind"] === "type"));
      if (!typeOnly && CHILD_PROCESS.has(specifier)) hit("static-import");
      if (!typeOnly && VM.has(specifier)) hit("vm-module");
      if (!typeOnly && CLUSTER.has(specifier)) hit("cluster-module");
    }
    if ((node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") && node["exportKind"] !== "type") {
      const specifier = staticSpecifier(node["source"]) ?? "";
      if (CHILD_PROCESS.has(specifier)) hit("re-export");
      if (VM.has(specifier)) hit("vm-module");
      if (CLUSTER.has(specifier)) hit("cluster-module");
    }
    if (node.type === "ImportExpression" || (node.type === "CallExpression" && isNode(node["callee"]) && node["callee"].type === "Import")) {
      const argument = node.type === "ImportExpression" ? node["source"] : (node["arguments"] as readonly unknown[] | undefined)?.[0];
      const specifier = staticSpecifier(argument);
      if (specifier === undefined) hit("computed-import");
      else if (CHILD_PROCESS.has(specifier)) hit("dynamic-import");
      else if (VM.has(specifier)) hit("vm-module");
      else if (CLUSTER.has(specifier)) hit("cluster-module");
    } else if (node.type === "CallExpression" || node.type === "OptionalCallExpression") {
      const callee = node["callee"];
      const argument = (node["arguments"] as readonly unknown[] | undefined)?.[0];
      const specifier = staticSpecifier(argument);
      if (specifier !== undefined && CHILD_PROCESS.has(specifier)) hit("named-call");
      if (isModuleLoader(callee, loaders)) {
        if (specifier === undefined) hit("computed-require");
        else if (VM.has(specifier)) hit("vm-module");
        else if (CLUSTER.has(specifier)) hit("cluster-module");
      }
      if (isNode(callee) && (callee.type === "MemberExpression" || callee.type === "OptionalMemberExpression") &&
        ["binding", "_linkedBinding"].includes(memberName(callee) ?? "") && reachesProcess(callee["object"])) hit("process-binding");
    }
    if (node.type === "NewExpression" && isWorkerConstructor(node["callee"])) {
      const args = (node["arguments"] as readonly unknown[] | undefined) ?? [];
      if (holdsEvalTrue(args[1])) hit("eval-worker");
      // The one worker spawn's spread is read through its owner (worker-bootstrap.ts); any other options that are
      // not an inline object literal (a variable, a spread, a call) cannot be read for `eval: true`.
      const opaque = isBootstrappedSpread(args[0])
        ? args.length > 1
        : args.some((argument) => isNode(argument) && argument.type === "SpreadElement") || (args[1] !== undefined && !(isNode(args[1]) && args[1].type === "ObjectExpression"));
      if (opaque) hit("opaque-worker-options");
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "loc" || key === "start" || key === "end" || key === "extra" || key === "comments" || key.endsWith("Comments")) continue;
      if (typeof value === "object" && value !== null) pending.push(value);
    }
  }
  return found;
}

/** Whether `source` takes a value from `node:child_process` in any form the scan reads. */
export function importsChildProcessValue(source: string, path: string): boolean {
  return [...spawnFormsIn(source, path)].some((form) => CHILD_PROCESS_FORMS.has(form));
}

/** Every tracked non-test source file of the repository at `repositoryRoot`, with the forms it holds: the child_process takers and the unreadable loaders, each sorted. */
export function spawnFormHolders(repositoryRoot: string): Readonly<{ spawners: readonly string[]; unreadable: readonly string[] }> {
  const spawners: string[] = [];
  const unreadable: string[] = [];
  for (const path of trackedFiles(repositoryRoot) ?? []) {
    if (!SOURCE_EXTENSIONS.test(path) || path.endsWith(".d.ts") || isTestSource(path)) continue;
    const forms = spawnFormsIn(readFileSync(join(repositoryRoot, path), "utf8"), path);
    if ([...forms].some((form) => CHILD_PROCESS_FORMS.has(form))) spawners.push(path);
    if ([...forms].some((form) => !CHILD_PROCESS_FORMS.has(form))) unreadable.push(path);
  }
  return { spawners: spawners.toSorted(), unreadable: unreadable.toSorted() };
}
