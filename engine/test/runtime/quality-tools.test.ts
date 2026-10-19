import assert from "node:assert/strict";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createQualityTools } from "../../src/runtime/quality-tools.ts";
import type { RepositoryMap } from "../../src/intelligence/intelligence-types.ts";
import { createTempDir } from "../support/temp-dir.ts";

function makeTempRepo(): string {
  const root = createTempDir("quality-tools-");
  writeFileSync(join(root, "broken.ts"), `function f( { return 1; }\n`);
  writeFileSync(join(root, "clean.ts"), `export function add(a: number, b: number): number { return a + b; }\n`);
  return root;
}

function callTool(tools: ReturnType<typeof createQualityTools>, name: string, args: Record<string, unknown>): unknown {
  const tool = tools.find((t) => t.definition.function.name === name);
  assert.ok(tool, `tool ${name} must be registered`);
  return JSON.parse(tool!.handler(args, { repositoryRoot: "" }));
}

test("quality-tools: registers exactly one tool", () => {
  const root = makeTempRepo();
  try {
    const tools = createQualityTools({ repositoryRoot: root });
    assert.equal(tools.length, 1);
    assert.equal(tools[0]!.definition.function.name, "run_quality_check");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("quality-tools: run_quality_check detects syntax errors in a broken file", () => {
  const root = makeTempRepo();
  try {
    const tools = createQualityTools({ repositoryRoot: root });
    const result = callTool(tools, "run_quality_check", { files: ["broken.ts"] }) as {
      packsRun: number;
      results: ReadonlyArray<{
        packId: string;
        exitCode: number;
        summary: { failed: number; totalDiagnostics: number };
        checkResults: ReadonlyArray<{ checkId: string; status: string; diagnostics: ReadonlyArray<{ category: string; severity: string }> }>;
      }>;
    };
    assert.equal(result.packsRun, 1);
    const pack = result.results[0]!;
    assert.equal(pack.packId, "typescript-pack");
    assert.equal(pack.exitCode, 1);
    assert.ok(pack.summary.failed >= 1, "expected at least one failing check");
    const syntax = pack.checkResults.find((c) => c.checkId === "syntax-errors");
    assert.ok(syntax, "syntax-errors check must be present");
    assert.ok(syntax!.diagnostics.some((d) => d.category === "syntax" && d.severity === "error"), "expected a syntax error diagnostic");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("quality-tools: run_quality_check passes a clean file's syntax", () => {
  const root = makeTempRepo();
  try {
    const tools = createQualityTools({ repositoryRoot: root });
    const result = callTool(tools, "run_quality_check", { files: ["clean.ts"] }) as {
      packsRun: number;
      results: ReadonlyArray<{
        exitCode: number;
        checkResults: ReadonlyArray<{ checkId: string; status: string; diagnostics: readonly unknown[] }>;
      }>;
    };
    const pack = result.results[0]!;
    const syntax = pack.checkResults.find((c) => c.checkId === "syntax-errors")!;
    assert.equal(syntax.status, "pass");
    assert.equal(syntax.diagnostics.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("quality-tools: run_quality_check reports no pack for non-source files", () => {
  const root = createTempDir("quality-nopack-");
  try {
    writeFileSync(join(root, "readme.md"), `# hello\n`);
    const tools = createQualityTools({ repositoryRoot: root });
    const result = callTool(tools, "run_quality_check", { files: ["readme.md"] }) as { packsRun: number; message: string };
    assert.equal(result.packsRun, 0);
    assert.match(result.message, /No quality pack/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("quality-tools: run_quality_check rejects an absolute path argument", () => {
  const root = makeTempRepo();
  try {
    const tools = createQualityTools({ repositoryRoot: root });
    const tool = tools[0]!;
    assert.throws(() => tool.handler({ files: ["/etc/passwd"] }, { repositoryRoot: root }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// MINOR-9: whole-repo mode, non-existent file, MAX_FILES limit, MINOR-7 caching
// ---------------------------------------------------------------------------

test("quality-tools: run_quality_check with files omitted scans the whole repo", () => {
  const root = makeTempRepo();
  try {
    const tools = createQualityTools({ repositoryRoot: root });
    const result = callTool(tools, "run_quality_check", {}) as {
      packsRun: number;
      results: ReadonlyArray<{ packId: string; exitCode: number }>;
    };
    assert.ok(result.packsRun >= 1, "whole-repo mode must run at least one pack");
    assert.equal(result.results[0]!.packId, "typescript-pack");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("quality-tools: run_quality_check rejects a non-existent file", () => {
  const root = makeTempRepo();
  try {
    const tools = createQualityTools({ repositoryRoot: root });
    assert.throws(
      () => callTool(tools, "run_quality_check", { files: ["does-not-exist.ts"] }),
      /does-not-exist\.ts|ENOENT|no such file/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("quality-tools: run_quality_check rejects more than MAX_FILES (256) entries", () => {
  const root = makeTempRepo();
  try {
    const tools = createQualityTools({ repositoryRoot: root });
    const many = Array.from({ length: 257 }, (_v, i) => `file${i}.ts`);
    assert.throws(
      () => callTool(tools, "run_quality_check", { files: many }),
      /exceed maximum of 256/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("quality-tools: whole-repo map is cached — second call does not re-scan (MINOR-7)", () => {
  const root = makeTempRepo();
  try {
    let scanCalls = 0;
    const fakeMap = {
      schemaVersion: "bridlewise-repository-map/v1",
      rootPath: root,
      generatedAt: "2026-01-01T00:00:00Z",
      files: [{ path: "clean.ts", extension: "ts" as const, sizeBytes: 10, contentHash: "h", lineCount: 1, isSource: true }],
      modules: [],
      totalSymbols: 0,
      totalDependencies: 0,
      mapHash: "fake",
    } as unknown as RepositoryMap;
    const tools = createQualityTools({
      repositoryRoot: root,
      mapProvider: () => { scanCalls += 1; return fakeMap; },
    });
    callTool(tools, "run_quality_check", {});
    callTool(tools, "run_quality_check", {});
    assert.equal(scanCalls, 1, "the repository map must be generated once and cached for subsequent whole-repo calls");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// FIX 6 (MINOR): the `qualityPacks.enabled` config field selects which packs
// the runtime registers. When absent/empty, the runtime defaults to the
// TypeScript pack (backwards compat). When provided, only packs whose id is
// in the list are registered.
// ---------------------------------------------------------------------------

test("quality-tools: enabledPacks=[\"typescript-pack\"] registers the typescript pack (FIX 6)", () => {
  const root = makeTempRepo();
  try {
    const tools = createQualityTools({ repositoryRoot: root, enabledPacks: ["typescript-pack"] });
    const result = callTool(tools, "run_quality_check", { files: ["clean.ts"] }) as {
      packsRun: number;
      results: ReadonlyArray<{ packId: string }>;
    };
    assert.equal(result.packsRun, 1);
    assert.equal(result.results[0]!.packId, "typescript-pack");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("quality-tools: enabledPacks=[] defaults to the typescript pack (FIX 6 backwards compat)", () => {
  const root = makeTempRepo();
  try {
    const tools = createQualityTools({ repositoryRoot: root, enabledPacks: [] });
    const result = callTool(tools, "run_quality_check", { files: ["clean.ts"] }) as {
      packsRun: number;
      results: ReadonlyArray<{ packId: string }>;
    };
    assert.equal(result.packsRun, 1, "empty enabledPacks must default to the typescript pack");
    assert.equal(result.results[0]!.packId, "typescript-pack");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("quality-tools: enabledPacks=[\"unknown-pack\"] registers no packs (FIX 6)", () => {
  const root = makeTempRepo();
  try {
    const tools = createQualityTools({ repositoryRoot: root, enabledPacks: ["unknown-pack"] });
    const result = callTool(tools, "run_quality_check", { files: ["clean.ts"] }) as {
      packsRun: number;
      message: string;
    };
    assert.equal(result.packsRun, 0, "an unknown pack id must register no packs");
    assert.match(result.message, /No quality pack/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("quality-tools: enabledPacks excludes the typescript pack when not listed (FIX 6)", () => {
  const root = makeTempRepo();
  try {
    // typescript-pack is NOT in the enabled list, so it must not be registered.
    const tools = createQualityTools({ repositoryRoot: root, enabledPacks: ["some-other-pack"] });
    const result = callTool(tools, "run_quality_check", { files: ["clean.ts"] }) as {
      packsRun: number;
      message: string;
    };
    assert.equal(result.packsRun, 0, "typescript-pack must be skipped when not in enabledPacks");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("quality-tools: the typescript-pack is registered by default (FIX 6 backwards compat)", () => {
  const root = makeTempRepo();
  try {
    const tools = createQualityTools({ repositoryRoot: root });
    const result = callTool(tools, "run_quality_check", { files: ["clean.ts"] }) as {
      packsRun: number;
      results: ReadonlyArray<{ packId: string }>;
    };
    assert.equal(result.packsRun, 1);
    assert.equal(result.results[0]!.packId, "typescript-pack");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
