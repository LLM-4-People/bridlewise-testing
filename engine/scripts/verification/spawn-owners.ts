/**
 * THE DECLARED OWNERS OF A DIRECT PROCESS SPAWN.
 *
 * Every process the repository starts runs through one door: the one bounded
 * run (`runCpuBounded` / `runCpuBoundedSync`, src/process/), or the git door
 * built on it (`gitOutput`, src/git/git-door.ts). A module may import
 * `node:child_process` for a value (a static or dynamic import, a re-export,
 * a `require`) only when it is declared here, with the reason it cannot use
 * that door: it IS the door, it confines or measures the process itself, the
 * process is long-lived by design, or it runs where the engine cannot load.
 * A type-only import starts nothing and is not counted.
 *
 * `engine/test/prevention/spawn-owners.test.ts` refuses a direct spawn
 * outside this list, and an entry whose file no longer spawns, so the list
 * stays exact. Test code (the suites' own folders and `*.test.*` files) is
 * out of scope: the test runners bound each test process.
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

const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]s|tsx|jsx)$/u;
const CHILD_PROCESS = new Set(["child_process", "node:child_process"]);

/** Whether `path` (repository-relative) is test code, out of this guard's scope. */
export function isTestSource(path: string): boolean {
  return /(?:^|\/)(?:test|tests)\//u.test(path) || /\.test\.[cm]?[jt]sx?$/u.test(path);
}

type AstNode = Readonly<{ type: string; [key: string]: unknown }>;

function isNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

function literalSource(node: unknown): string | undefined {
  return isNode(node) && node.type === "StringLiteral" && typeof node["value"] === "string" ? node["value"] : undefined;
}

/** Whether `source` (a module's text) takes a VALUE from `node:child_process`: an import that is not type-only, a re-export, a dynamic import or a `require`. */
export function importsChildProcessValue(source: string, path: string): boolean {
  const ast = parse(source, {
    sourceType: "unambiguous",
    errorRecovery: true,
    plugins: /\.[cm]?tsx?$/u.test(path) ? ["typescript", ...(path.endsWith("x") ? ["jsx" as const] : [])] : ["jsx"],
  });
  const pending: unknown[] = [ast.program];
  while (pending.length > 0) {
    const node = pending.pop();
    if (Array.isArray(node)) {
      pending.push(...node);
      continue;
    }
    if (!isNode(node)) continue;
    if (node.type === "ImportDeclaration" && CHILD_PROCESS.has(literalSource(node["source"]) ?? "")) {
      const listed = node["specifiers"];
      const specifiers = Array.isArray(listed) ? listed.filter(isNode) : undefined;
      const typeOnly = node["importKind"] === "type" || (specifiers !== undefined && specifiers.length > 0 && specifiers.every((specifier) => specifier["importKind"] === "type"));
      if (!typeOnly) return true;
    }
    if ((node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") &&
      CHILD_PROCESS.has(literalSource(node["source"]) ?? "") && node["exportKind"] !== "type") return true;
    if (node.type === "CallExpression" || node.type === "ImportExpression") {
      const callee = node["callee"];
      const argument = node.type === "ImportExpression" ? node["source"] : (node["arguments"] as readonly unknown[] | undefined)?.[0];
      const dynamicImport = node.type === "ImportExpression" || (isNode(callee) && callee.type === "Import");
      const requireCall = isNode(callee) && callee.type === "Identifier" && callee["name"] === "require";
      if ((dynamicImport || requireCall) && CHILD_PROCESS.has(literalSource(argument) ?? "")) return true;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "loc" || key === "start" || key === "end" || key === "extra" || key === "comments" || key.endsWith("Comments")) continue;
      if (typeof value === "object" && value !== null) pending.push(value);
    }
  }
  return false;
}

/** Every tracked non-test source file of the repository at `repositoryRoot` that takes a value from `node:child_process`, sorted. */
export function directSpawnImporters(repositoryRoot: string): readonly string[] {
  const files = trackedFiles(repositoryRoot) ?? [];
  return files
    .filter((path) => SOURCE_EXTENSIONS.test(path) && !path.endsWith(".d.ts") && !isTestSource(path))
    .filter((path) => {
      const text = readFileSync(join(repositoryRoot, path), "utf8");
      return text.includes("child_process") && importsChildProcessValue(text, path);
    })
    .toSorted();
}
