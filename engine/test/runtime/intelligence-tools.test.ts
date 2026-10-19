import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createIntelligenceTools } from "../../src/runtime/intelligence-tools.ts";
import { createTempDir } from "../support/temp-dir.ts";
import { initTreeSitterBackend } from "../../src/intelligence/tree-sitter-backend.ts";

await initTreeSitterBackend(["javascript", "typescript"]);

// ---------------------------------------------------------------------------
// Intelligence tools: a temp source tree is scanned by the real
// generateRepositoryMap so the symbol/dependency/reuse engines are exercised
// against actual extraction output (not hand-built fixtures).
// ---------------------------------------------------------------------------

function makeTempRepo(): string {
  const root = createTempDir("intel-tools-");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "utils.ts"),
    `export function add(a: number, b: number): number { return a + b; }\n` +
    `export const VERSION = "1.0.0";\n`);
  writeFileSync(join(root, "src", "app.ts"),
    `import { add } from "./utils.ts";\n` +
    `export function runAdd(x: number): number { return add(x, 1); }\n`);
  return root;
}

function callTool(tools: ReturnType<typeof createIntelligenceTools>, name: string, args: Record<string, unknown> = {}): unknown {
  const tool = tools.find((t) => t.definition.function.name === name);
  assert.ok(tool, `tool ${name} must be registered`);
  return JSON.parse(tool!.handler(args, { repositoryRoot: "" }));
}

test("intelligence-tools: registers exactly four tools", () => {
  const root = makeTempRepo();
  try {
    const tools = createIntelligenceTools({ repositoryRoot: root });
    const names = tools.map((t) => t.definition.function.name);
    assert.deepEqual(names.toSorted(), ["find_reuse", "get_dependency_graph", "get_repository_map", "search_code"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("intelligence-tools: get_repository_map returns file and symbol counts", () => {
  const root = makeTempRepo();
  try {
    const tools = createIntelligenceTools({ repositoryRoot: root });
    const result = callTool(tools, "get_repository_map") as { fileCount: number; moduleCount: number; totalSymbols: number };
    assert.equal(result.fileCount, 2);
    assert.equal(result.moduleCount, 2);
    assert.ok(result.totalSymbols >= 2, `expected at least 2 symbols; got ${result.totalSymbols}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("intelligence-tools: search_code finds a known function by name", () => {
  const root = makeTempRepo();
  try {
    const tools = createIntelligenceTools({ repositoryRoot: root });
    const result = callTool(tools, "search_code", { name: "add", matchMode: "exact" }) as { totalResults: number; results: ReadonlyArray<{ name: string; kind: string }> };
    assert.ok(result.totalResults >= 1, "expected at least one match for 'add'");
    assert.ok(result.results.some((r) => r.name === "add"), "results must include 'add'");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("intelligence-tools: find_reuse returns candidates for a similar name", () => {
  const root = makeTempRepo();
  try {
    const tools = createIntelligenceTools({ repositoryRoot: root });
    const result = callTool(tools, "find_reuse", { name: "add", limit: 5 }) as { totalCandidates: number; candidates: ReadonlyArray<{ name: string }> };
    assert.ok(result.totalCandidates >= 1, "expected at least one reuse candidate for 'add'");
    assert.ok(result.candidates.some((c) => c.name === "add"), "candidates must include 'add'");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("intelligence-tools: get_dependency_graph returns impact for a file", () => {
  const root = makeTempRepo();
  try {
    const tools = createIntelligenceTools({ repositoryRoot: root });
    const result = callTool(tools, "get_dependency_graph", { filePath: "src/utils.ts" }) as { filePath: string; directlyAffected: readonly string[]; totalAffected: number };
    assert.equal(result.filePath, "src/utils.ts");
    // app.ts imports utils.ts, so utils.ts has at least one reverse dependency
    assert.ok(result.directlyAffected.includes("src/app.ts"), "app.ts must depend on utils.ts");
    assert.ok(result.totalAffected >= 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("intelligence-tools: search_code rejects an invalid kind", () => {
  const root = makeTempRepo();
  try {
    const tools = createIntelligenceTools({ repositoryRoot: root });
    const tool = tools.find((t) => t.definition.function.name === "search_code")!;
    assert.throws(() => tool.handler({ kind: "not-a-kind" }, { repositoryRoot: root }), /kind must be a valid symbol kind/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("intelligence-tools: get_repository_map respects includeFiles=false", () => {
  const root = makeTempRepo();
  try {
    const tools = createIntelligenceTools({ repositoryRoot: root });
    const result = callTool(tools, "get_repository_map", { includeFiles: false }) as { fileCount: number; files?: unknown };
    assert.equal(result.fileCount, 2);
    assert.equal(result.files, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
