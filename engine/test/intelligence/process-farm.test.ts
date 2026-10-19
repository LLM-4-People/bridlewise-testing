/**
 * Crash isolation for parse/extract. Drives `runIsolatedProcess` against
 * stub children — no corpus, no native grammar. Each test pins one farm
 * contract: parent survives, every file gets a result, the culprit path
 * is named.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { runIsolatedProcess, type FarmFileResult } from "../../src/intelligence/process-farm.ts";
import { createTempDir } from "../support/temp-dir.ts";

const FAST = { initTimeoutMs: 300, maxInitFailures: 3 } as const;
const DRAIN_BOUND_MS = 2 * FAST.maxInitFailures * FAST.initTimeoutMs + 15_000;

function writeStub(behavior: string): string {
  const dir = createTempDir("prod-farm-stub-");
  const path = join(dir, "stub-child.mjs");
  writeFileSync(
    path,
    `
const BEHAVIOR = ${JSON.stringify(behavior)};
const ok = (f) => ({ path: f.path, ok: true, symbols: 1, imports: 0, exports: 0,
  lineCount: 1, byKind: {}, calls: 0, docstrings: 0, signatures: 0,
  diagnostics: [], detail: [], latencyMs: 0 });
process.on("message", (m) => {
  if (m.type === "init") {
    if (BEHAVIOR === "hang-on-init") return;
    if (BEHAVIOR === "crash-on-init") process.exit(1);
    for (const lang of m.languages ?? []) {
      process.send({ type: "loading", language: lang });
      if (BEHAVIOR === "crash-on-poison" && lang === "elm") process.exit(1);
    }
    process.send({ type: "ready" });
    return;
  }
  if (m.type === "parse-batch") {
    const files = m.files;
    const crashIdx = files.findIndex((f) => f.path.includes("__crashme__"));
    if (crashIdx >= 0 && BEHAVIOR === "crash-mid-batch") {
      const done = files.slice(0, crashIdx).map(ok);
      if (done.length > 0) process.send({ type: "batch-result", results: done });
      process.exit(1);
      return;
    }
    process.send({ type: "batch-result", results: files.map(ok) });
  }
});
`,
    "utf8",
  );
  return path;
}

const FILES = (n: number, prefix = "f") =>
  Array.from({ length: n }, (_, i) => ({ path: `${prefix}${i}.ts`, absolutePath: `/tmp/${prefix}${i}.ts` }));

async function runWithTimeout(
  files: readonly { path: string; absolutePath: string }[],
  childPath: string,
  opts: {
    workers?: number;
    perFileTimeoutMs?: number;
    onResult?: (r: FarmFileResult) => void;
    maxInitFailures?: number;
    initTimeoutMs?: number;
  } = {},
  timeoutMs = 20_000,
): Promise<{ settled: boolean; results: readonly FarmFileResult[] }> {
  const timeout = new Promise<readonly FarmFileResult[]>((_, rej) =>
    setTimeout(() => rej(new Error("farm did not settle (hang)")), timeoutMs),
  );
  try {
    const results = await Promise.race([
      runIsolatedProcess(files, ["typescript"], { ...opts, childPath }),
      timeout,
    ]);
    return { settled: true, results };
  } catch (e) {
    if (e instanceof Error && e.message.includes("did not settle")) return { settled: false, results: [] };
    throw e;
  }
}

test("farm: a child that hangs on init does not wedge the run", async () => {
  const child = writeStub("hang-on-init");
  const { settled, results } = await runWithTimeout(FILES(3), child, { workers: 1, ...FAST }, DRAIN_BOUND_MS);
  assert.ok(settled, "run wedged on a child that never readies");
  assert.equal(results.length, 3);
  assert.ok(results.every((r) => !r.ok));
});

test("farm: crash mid-batch is contained and names the culprit file", async () => {
  const child = writeStub("crash-mid-batch");
  const files = [
    { path: "a.ts", absolutePath: "/tmp/a.ts" },
    { path: "__crashme__.ts", absolutePath: "/tmp/__crashme__.ts" },
    { path: "b.ts", absolutePath: "/tmp/b.ts" },
  ];
  const { settled, results } = await runWithTimeout(files, child, { workers: 1, perFileTimeoutMs: 5_000 });
  assert.ok(settled, "parent died or wedged — isolation failed");
  assert.equal(results.length, 3);
  const crash = results.find((r) => r.path.includes("__crashme__"));
  assert.ok(crash !== undefined, "culprit path missing from results");
  assert.equal(crash!.path, "__crashme__.ts", "the result must name the culprit file");
  assert.equal(crash!.ok, false);
  assert.equal(crash!.errorName, "ParserCrash");
});

test("farm: a poison language is dropped and the rest of the files still parse", async () => {
  const child = writeStub("crash-on-poison");
  const files = [
    { path: "a.ts", absolutePath: "/tmp/a.ts" },
    { path: "b.ts", absolutePath: "/tmp/b.ts" },
  ];
  const timeout = new Promise<readonly FarmFileResult[]>((_, rej) =>
    setTimeout(() => rej(new Error("farm did not settle (hang)")), DRAIN_BOUND_MS),
  );
  const results = await Promise.race([
    runIsolatedProcess(files, ["typescript", "elm"], { workers: 1, ...FAST, childPath: child }),
    timeout,
  ]);
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.ok), "typescript files must survive dropping elm");
});

test("farm: mutation — a parent-killing crash would leave no results", async () => {
  const child = writeStub("crash-mid-batch");
  const files = [{ path: "__crashme__.ts", absolutePath: "/tmp/c.ts" }];
  const { settled, results } = await runWithTimeout(files, child, { workers: 1, perFileTimeoutMs: 5_000, ...FAST }, DRAIN_BOUND_MS);
  assert.ok(settled);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.ok, false);
});
