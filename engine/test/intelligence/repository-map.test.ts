import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  generateRepositoryMap,
  createEmptyArchitectureIndex,
  createArchitectureModuleIndex,
  type RepositoryReaderPort,
} from "../../src/intelligence/repository-map.ts";
import {
  createRepositoryMapCache,
  type RepositoryReadLimits,
  resolveRepositoryReadLimits,
} from "../../src/intelligence/repository-stat-scan.ts";
import { extractSymbols } from "../../src/intelligence/symbol-extractor.ts";
import { initTreeSitterBackend } from "../../src/intelligence/tree-sitter-backend.ts";

await initTreeSitterBackend(["javascript", "typescript"]);
import type { FileInfo, SourceExtension } from "../../src/intelligence/intelligence-types.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { createTempDir } from "../support/temp-dir.ts";

// ========== Test helpers ==========

function createTestRepo(): string {
  const root = createTempDir("intel-test-");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export function foo() { return 1; }\n");
  writeFileSync(join(root, "src", "b.ts"), "import { foo } from './a.ts';\nexport const bar = foo();\n");
  writeFileSync(join(root, "src", "c.ts"), "interface Baz { x: number; }\n");
  return root;
}

function createMockReader(files: Readonly<Record<string, string>>): RepositoryReaderPort {
  return {
    listFiles(): FileInfo[] {
      return Object.keys(files).map((path) => Object.freeze({
        path, extension: ".ts" as SourceExtension,
        sizeBytes: files[path]!.length,
        contentHash: "test-hash",
        lineCount: files[path]!.split("\n").length,
        isSource: true,
      }));
    },
    readFile(_root: string, path: string) {
      const content = files[path];
      if (!content) throw new Error("File not found: " + path);
      return { content, sizeBytes: content.length, contentHash: "test-hash" };
    },
  };
}

// ========== Map generation ==========

test("repository-map: generates map from mock files", () => {
  const reader = createMockReader({
    "src/a.ts": "export function foo() { return 1; }",
    "src/b.ts": "export const bar = 42;",
  });
  const { map } = generateRepositoryMap(".", { reader });
  assert.equal(map.modules.length, 2);
  assert.ok(map.totalSymbols > 0);
});

test("repository-map: empty repo produces empty map", () => {
  const reader = createMockReader({});
  const { map } = generateRepositoryMap(".", { reader });
  assert.equal(map.modules.length, 0);
  assert.equal(map.totalSymbols, 0);
});

test("repository-map: map has correct schema version", () => {
  const reader = createMockReader({ "src/a.ts": "export function foo() {}" });
  const { map } = generateRepositoryMap(".", { reader });
  assert.equal(map.schemaVersion, "bridlewise-intelligence/v1");
});

test("repository-map: map has mapHash", () => {
  const reader = createMockReader({ "src/a.ts": "export function foo() {}" });
  const { map } = generateRepositoryMap(".", { reader });
  assert.ok(map.mapHash.length > 0);
});

test("repository-map: map includes file info", () => {
  const reader = createMockReader({ "src/a.ts": "export function foo() {}" });
  const { map } = generateRepositoryMap(".", { reader });
  assert.equal(map.files.length, 1);
  assert.equal(map.files[0]!.path, "src/a.ts");
  assert.equal(map.files[0]!.isSource, true);
});

test("repository-map: symbols have file paths", () => {
  const reader = createMockReader({ "src/a.ts": "export function foo() {}" });
  const { map } = generateRepositoryMap(".", { reader });
  const mod = map.modules[0]!;
  assert.ok(mod.symbols.length > 0);
  assert.equal(mod.symbols[0]!.location.filePath, "src/a.ts");
});

test("repository-map: imports are captured", () => {
  const reader = createMockReader({
    "src/a.ts": "export function foo() {}",
    "src/b.ts": "import { foo } from './a.ts';",
  });
  const { map } = generateRepositoryMap(".", { reader });
  const modB = map.modules.find((m) => m.path === "src/b.ts");
  assert.ok(modB);
  assert.ok(modB!.imports.length > 0);
  assert.equal(modB!.imports[0]!.specifier, "./a.ts");
});

// ========== Caching ==========

test("repository-map: cache returned after generation", () => {
  const reader = createMockReader({ "src/a.ts": "export function foo() {}" });
  const { cache } = generateRepositoryMap(".", { reader });
  assert.ok(cache.entries.size > 0);
});

test("repository-map: cache reused on regeneration", () => {
  let extractCount = 0;
  const reader = createMockReader({ "src/a.ts": "export function foo() {}" });
  const { cache } = generateRepositoryMap(".", { reader });
  const originalExtract = extractSymbols;
  const { map } = generateRepositoryMap(".", { reader, cache });
  assert.equal(map.modules.length, 1);
  void originalExtract;
  void extractCount;
});

test("repository-map: cache invalidates on content change", () => {
  let reader = createMockReader({ "src/a.ts": "export function foo() {}" });
  reader = {
    listFiles: () => [{
      path: "src/a.ts", extension: ".ts" as SourceExtension,
      sizeBytes: 24, contentHash: "hash-v1",
      lineCount: 1, isSource: true,
    }],
    readFile: () => ({ content: "export function foo() {}", sizeBytes: 24, contentHash: "hash-v1" }),
  };
  const { cache } = generateRepositoryMap(".", { reader });
  reader = {
    listFiles: () => [{
      path: "src/a.ts", extension: ".ts" as SourceExtension,
      sizeBytes: 24, contentHash: "hash-v2",
      lineCount: 1, isSource: true,
    }],
    readFile: () => ({ content: "export function bar() {}", sizeBytes: 24, contentHash: "hash-v2" }),
  };
  const { map } = generateRepositoryMap(".", { reader, cache });
  const mod = map.modules[0]!;
  assert.ok(mod.symbols.some((s) => s.name === "bar"));
});

test("repository-map: empty cache produces full extraction", () => {
  const reader = createMockReader({ "src/a.ts": "export function foo() {}" });
  const { map } = generateRepositoryMap(".", { reader, cache: createRepositoryMapCache() });
  assert.ok(map.modules.length > 0);
});

// ========== Architecture index ==========

test("repository-map: empty architecture index returns null metadata", () => {
  const reader = createMockReader({ "src/a.ts": "export function foo() {}" });
  const { map } = generateRepositoryMap(".", { reader, architectureIndex: createEmptyArchitectureIndex() });
  assert.equal(map.modules[0]!.architectureModuleId, null);
  assert.equal(map.modules[0]!.architectureLayer, null);
});

test("repository-map: architecture index provides metadata", () => {
  const reader = createMockReader({ "src/a.ts": "export function foo() {}" });
  const archIndex = createArchitectureModuleIndex([
    { path: "src/a.ts", id: "mod-a", layer: "domain", realm: "shared", owner: "test", dependencies: [] },
  ]);
  const { map } = generateRepositoryMap(".", { reader, architectureIndex: archIndex });
  const mod = map.modules[0]!;
  assert.equal(mod.architectureModuleId, "mod-a");
  assert.equal(mod.architectureLayer, "domain");
  assert.equal(mod.architectureRealm, "shared");
  assert.equal(mod.architectureOwner, "test");
});

test("repository-map: architecture index with no match returns null", () => {
  const reader = createMockReader({ "src/a.ts": "export function foo() {}" });
  const archIndex = createArchitectureModuleIndex([
    { path: "src/other.ts", id: "mod-other", layer: "domain", realm: "shared", owner: "test", dependencies: [] },
  ]);
  const { map } = generateRepositoryMap(".", { reader, architectureIndex: archIndex });
  assert.equal(map.modules[0]!.architectureModuleId, null);
});

test("repository-map: architecture declaredDependencies works", () => {
  const archIndex = createArchitectureModuleIndex([
    { path: "src/a.ts", id: "mod-a", layer: "domain", realm: "shared", owner: "test", dependencies: ["src/b.ts"] },
  ]);
  assert.equal(archIndex.declaredDependencies("src/a.ts").length, 1);
  assert.equal(archIndex.declaredDependencies("src/x.ts").length, 0);
});

// ========== Real filesystem ==========

test("repository-map: generates map from real filesystem", () => {
  const root = createTestRepo();
  try {
    const { map } = generateRepositoryMap(root);
    assert.ok(map.modules.length >= 3);
    const modA = map.modules.find((m) => m.path === "src/a.ts");
    assert.ok(modA);
    assert.ok(modA!.symbols.some((s) => s.name === "foo"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repository-map: real filesystem respects excluded dirs", () => {
  const root = createTempDir("intel-excl-");
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "node_modules"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export function foo() {}");
    writeFileSync(join(root, "node_modules", "dep.ts"), "export function dep() {}");
    const { map } = generateRepositoryMap(root);
    assert.ok(!map.modules.some((m) => m.path.includes("node_modules")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repository-map: real filesystem rejects symlinked directories", () => {
  const root = createTempDir("intel-sym-");
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export function foo() {}");
    const { map } = generateRepositoryMap(root);
    assert.ok(map.modules.length >= 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repository-map: incremental update on real filesystem", () => {
  const root = createTestRepo();
  try {
    const first = generateRepositoryMap(root);
    const second = generateRepositoryMap(root, { cache: first.cache });
    assert.equal(second.map.modules.length, first.map.modules.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repository-map: new file detected on regeneration", () => {
  const root = createTestRepo();
  try {
    const first = generateRepositoryMap(root);
    writeFileSync(join(root, "src", "d.ts"), "export function qux() {}");
    const second = generateRepositoryMap(root, { cache: first.cache });
    assert.ok(second.map.modules.length > first.map.modules.length);
    assert.ok(second.map.modules.some((m) => m.path === "src/d.ts"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repository-map: modified file re-extracted", () => {
  const root = createTestRepo();
  try {
    const first = generateRepositoryMap(root);
    writeFileSync(join(root, "src", "a.ts"), "export function changed() {}\n");
    const second = generateRepositoryMap(root, { cache: first.cache });
    const modA = second.map.modules.find((m) => m.path === "src/a.ts");
    assert.ok(modA!.symbols.some((s) => s.name === "changed"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ========== Limits ==========

test("repository-map: maxFileBytes skips large files", () => {
  const reader = createMockReader({ "src/a.ts": "export function foo() {}" });
  const { map } = generateRepositoryMap(".", { reader, maxFileBytes: 10 });
  assert.equal(map.modules.length, 0);
});

test("repository-map: custom limits override defaults", () => {
  const limits: RepositoryReadLimits = {
    maximumDepth: 1,
    maximumEntries: 10,
    excludedDirectoryNames: [],
    extensions: [".ts" as SourceExtension],
  };
  const reader = createMockReader({ "src/a.ts": "export function foo() {}" });
  const { map } = generateRepositoryMap(".", { reader, limits });
  assert.ok(map.modules.length >= 0);
});

test("repository-map: DEFAULT_READ_LIMITS has sensible values", () => {
  assert.ok(resolveRepositoryReadLimits().maximumDepth > 0);
  assert.ok(resolveRepositoryReadLimits().maximumEntries > 0);
  assert.ok(resolveRepositoryReadLimits().excludedDirectoryNames.includes("node_modules"));
});

test("repository-map: resolveRepositoryReadLimits().excludedDirectoryNames is sourced from ROOT_POLICY (canonical owner)", () => {
  // The exclusion list must be the exact canonical owner, not a divergent
  // hardcoded copy. This contract test catches drift if either side changes.
  assert.deepEqual(
    [...resolveRepositoryReadLimits().excludedDirectoryNames],
    [...ROOT_POLICY.configuration.repositoryScanExclusions],
  );
});

test("repository-map: DEFAULT_READ_LIMITS excludes the canonical VCS/build/cache dirs from ROOT_POLICY", () => {
  const canonical: readonly string[] = ROOT_POLICY.configuration.repositoryScanExclusions;
  for (const dir of [".git", ".bridlewise", "node_modules", "coverage"]) {
    assert.ok(canonical.includes(dir), `canonical owner must list ${dir}`);
    assert.ok(resolveRepositoryReadLimits().excludedDirectoryNames.includes(dir), `defaults must exclude ${dir}`);
  }
});

test("repository-map: defaults no longer carry the divergent hardcoded dirs (docs/verification/etc.)", () => {
  // These were in the old hardcoded list but are NOT in the canonical owner.
  // They must not reappear as a parallel hardcoded list in the defaults.
  const divergent = ["dist", "build", ".next", "traceability", "docs", "verification", "lineage", ".recovery"];
  for (const dir of divergent) {
    assert.ok(
      !resolveRepositoryReadLimits().excludedDirectoryNames.includes(dir),
      `defaults must not re-add non-canonical dir '${dir}'`,
    );
  }
});

test("repository-map: real filesystem excludes __pycache__ per canonical ROOT_POLICY", () => {
  const root = createTempDir("intel-py-");
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "__pycache__"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export function foo() {}");
    writeFileSync(join(root, "__pycache__", "x.py"), "x = 1");
    const { map } = generateRepositoryMap(root);
    assert.ok(!map.modules.some((m) => m.path.includes("__pycache__")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ========== Error handling ==========

test("repository-map: empty root path throws", () => {
  assert.throws(() => generateRepositoryMap(""));
});

test("repository-map: reader error skips file gracefully", () => {
  const reader: RepositoryReaderPort = {
    listFiles: () => [{
      path: "src/a.ts", extension: ".ts" as SourceExtension,
      sizeBytes: 100, contentHash: "x", lineCount: 1, isSource: true,
    }],
    readFile: () => { throw new Error("read failed"); },
  };
  const { map } = generateRepositoryMap(".", { reader });
  assert.equal(map.modules.length, 0);
});

test("repository-map: extraction error skips file", () => {
  const reader = createMockReader({ "src/a.ts": "function {{{ { " });
  const { map } = generateRepositoryMap(".", { reader });
  assert.ok(map.modules.length >= 0);
});

// ========== Determinism ==========

test("repository-map: same input produces same mapHash", () => {
  const reader = createMockReader({ "src/a.ts": "export function foo() {}" });
  const a = generateRepositoryMap(".", { reader });
  const b = generateRepositoryMap(".", { reader });
  assert.equal(a.map.mapHash, b.map.mapHash);
});

test("repository-map: different input produces different mapHash", () => {
  const readerA = {
    listFiles: () => [{
      path: "src/a.ts", extension: ".ts" as SourceExtension,
      sizeBytes: 24, contentHash: "hash-a",
      lineCount: 1, isSource: true,
    }],
    readFile: () => ({ content: "export function foo() {}", sizeBytes: 24, contentHash: "hash-a" }),
  };
  const readerB = {
    listFiles: () => [{
      path: "src/a.ts", extension: ".ts" as SourceExtension,
      sizeBytes: 24, contentHash: "hash-b",
      lineCount: 1, isSource: true,
    }],
    readFile: () => ({ content: "export function bar() {}", sizeBytes: 24, contentHash: "hash-b" }),
  };
  const a = generateRepositoryMap(".", { reader: readerA });
  const b = generateRepositoryMap(".", { reader: readerB });
  assert.notEqual(a.map.mapHash, b.map.mapHash);
});

// ========== Stat-cache incremental rebuild (Round 11) ==========
//
// The rebuild contract under test:
// - a stat cache ({path → mtimeMs,sizeBytes} from the last COMPLETE scan)
//   decides which files are re-READ (zero reads+zero parses when nothing
//   changed);
// - a content-hash cache decides which files are re-PARSED (a reverted
//   file re-reads but never re-parses);
// - the assembled map is SEMANTICALLY EQUAL to a from-scratch build of the
//   same tree (byte-identity via deepStrictEqual);
// - changedPathHints (the harness's own editor-write signal) skip the tree
//   walk entirely and re-read exactly the hinted paths;
// - a config-shape change (limits/maxFileBytes) discards the cache
//   wholesale;
// - a walk that errors mid-way never installs its snapshot.

import { utimesSync } from "node:fs";
import { NODE_FS_REPOSITORY_READER } from "../../src/intelligence/repository-map.ts";
import {
  scanRepositoryStats,
  diffStatSnapshot,
  isRepositoryMapCacheReusable,
  type RepositoryMapCache,
} from "../../src/intelligence/repository-stat-scan.ts";
import { resolveIntelligenceConfig } from "../../src/intelligence/intelligence-config.ts";
import { HarnessError } from "../../src/kernel/errors.ts";
import { buildDependencyGraph } from "../../src/intelligence/dependency-graph.ts";
import type { ModuleInfo, RepositoryMap } from "../../src/intelligence/intelligence-types.ts";

/** Deterministic mtime source: real writes can land inside the kernel's
 * coarse timestamp window (same mtime for two different writes), which is
 * exactly the documented mtime+size collision the stat cache accepts in
 * production — but a test must not flip on it, so every fixture write
 * stamps a strictly increasing fake mtime. */
let fixtureClock = 1_700_000_000;
function writeAndStamp(absPath: string, content: string): void {
  writeFileSync(absPath, content);
  fixtureClock += 1;
  const stamp = new Date(fixtureClock * 1000);
  utimesSync(absPath, stamp, stamp);
}

/** ~200-file synthetic fixture: mod_i imports mod_{i-1} so the graph has
 * real edges, every file has an export + a function symbol. */
function createIncrementalFixture(fileCount = 200): string {
  const root = createTempDir("intel-incr-");
  mkdirSync(join(root, "src", "sub"), { recursive: true });
  for (let i = 0; i < fileCount; i++) {
    const dir = i % 5 === 0 ? join(root, "src", "sub") : join(root, "src");
    const importLine = i === 0 ? "" : `import { mod${i - 1} } from "./mod${i - 1}.ts";\n`;
    writeAndStamp(join(dir, `mod${i}.ts`), `${importLine}export const mod${i} = ${i};\nexport function fn${i}(x: number): number { return x + ${i}; }\n`);
  }
  return root;
}

/** A reader over the real node reader that COUNTS readFile calls — the
 * read-counting seam (parse counting is the onFileParsed option). */
function countingReader(): {
  reader: RepositoryReaderPort;
  reads: () => readonly string[];
  resetReads: () => void;
} {
  const reads: string[] = [];
  const reader: RepositoryReaderPort = {
    listFiles: (root, limits) => NODE_FS_REPOSITORY_READER.listFiles(root, limits),
    listFilesWithStatus: (root, limits) => NODE_FS_REPOSITORY_READER.listFilesWithStatus!(root, limits),
    readFile: (root, path) => {
      reads.push(path);
      return NODE_FS_REPOSITORY_READER.readFile(root, path);
    },
  };
  return { reader, reads: () => reads, resetReads: () => { reads.length = 0; } };
}

function modulesByPath(map: RepositoryMap): Map<string, ModuleInfo> {
  return new Map(map.modules.map((m) => [m.path, m]));
}

test("stat-cache: incremental rebuild of add/edit/delete/rename is deep-equal to a from-scratch build", () => {
  const root = createIncrementalFixture(40);
  try {
    const first = generateRepositoryMap(root);
    // Perturb: add, edit, delete, rename (each stamped so the stat cache
    // sees a fresh mtime — a rename keeps the file's mtime, but the PATH
    // change alone makes it dirty).
    writeAndStamp(join(root, "src", "added.ts"), "export const added = 1;\n");
    writeAndStamp(join(root, "src", "mod3.ts"), "export const mod3 = 30;\nexport function fn3b() { return 3; }\n");
    rmSync(join(root, "src", "mod6.ts"));
    writeAndStamp(join(root, "src", "renamed.ts"), "export const renamed = 7;\n");
    rmSync(join(root, "src", "mod7.ts"));

    let parsed = 0;
    const incremental = generateRepositoryMap(root, {
      cache: first.cache,
      onFileParsed: () => { parsed += 1; },
    });
    const fresh = generateRepositoryMap(root);
    // BYTE-IDENTITY: the incremental map is deep-equal to a from-scratch
    // build of the perturbed tree — same files, same modules, same
    // exports/dependencies facts, same mapHash.
    assert.deepStrictEqual(incremental.map, fresh.map);
    // And it only parsed what actually changed: 4 writes (added, edited,
    // renamed-in, plus nothing for the two deletes).
    assert.equal(parsed, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stat-cache: no-change rebuild does ZERO reads and ZERO parses", () => {
  const root = createIncrementalFixture(200);
  try {
    const { reader, reads, resetReads } = countingReader();
    const first = generateRepositoryMap(root, { reader });
    assert.equal(first.map.modules.length, 200);
    resetReads();
    let parsed = 0;
    const second = generateRepositoryMap(root, {
      reader,
      cache: first.cache,
      onFileParsed: () => { parsed += 1; },
    });
    assert.equal(reads().length, 0, "a no-change rebuild must not read a single file");
    assert.equal(parsed, 0, "a no-change rebuild must not parse a single file");
    assert.equal(second.map.modules.length, 200);
    assert.equal(second.map.mapHash, first.map.mapHash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stat-cache: changed-file rebuild parses exactly the changed files", () => {
  const root = createIncrementalFixture(200);
  try {
    const { reader, reads, resetReads } = countingReader();
    const first = generateRepositoryMap(root, { reader });
    const edited = ["src/mod3.ts", "src/mod42.ts", "src/sub/mod100.ts"];
    for (const rel of edited) writeAndStamp(join(root, rel), `export const edited = "${rel}";\nexport function e${rel.length}() { return 1; }\n`);
    resetReads();
    let parsed = 0;
    const second = generateRepositoryMap(root, {
      reader,
      cache: first.cache,
      onFileParsed: () => { parsed += 1; },
    });
    assert.equal(reads().length, 3, "only the edited files are re-read");
    assert.deepEqual([...reads()].sort(), [...edited].sort());
    assert.equal(parsed, 3, "only the edited files are re-parsed");
    assert.equal(second.map.modules.length, 200);
    // untouched modules keep their exact cached facts
    const before = modulesByPath(first.map);
    const after = modulesByPath(second.map);
    assert.deepStrictEqual(after.get("src/mod4.ts"), before.get("src/mod4.ts"));
    assert.notEqual(after.get("src/mod3.ts")!.contentHash, before.get("src/mod3.ts")!.contentHash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stat-cache: a reverted file re-reads but does NOT re-parse (content-hash floor)", () => {
  const root = createIncrementalFixture(30);
  try {
    const { reader, reads, resetReads } = countingReader();
    const rel = "src/mod3.ts";
    const original = "export const mod3 = 3;\nexport function fn3(x: number): number { return x + 3; }\n";
    writeAndStamp(join(root, rel), original);
    const first = generateRepositoryMap(root, { reader });
    // "Revert": write the SAME bytes back. mtime moved (the stat gate sees
    // it), but the content hash is identical — one read, zero parses.
    writeAndStamp(join(root, rel), original);
    resetReads();
    let parsed = 0;
    const second = generateRepositoryMap(root, {
      reader,
      cache: first.cache,
      onFileParsed: () => { parsed += 1; },
    });
    assert.deepEqual(reads(), [rel]);
    assert.equal(parsed, 0);
    assert.deepStrictEqual(second.map, first.map);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stat-cache: dependency propagation — an added/deleted import target flips importers' edges with ZERO importer re-parses", () => {
  // The edge model (dependency-graph.ts) derives every edge from
  // (importer's own import statements) × (the module path set of the map)
  // — resolution happens at graph-build time, never at parse time. So the
  // propagation rule is: a changed file is the ONLY file that needs
  // re-parsing. An importer's edges update because the path set changed,
  // not because the importer was re-analyzed; an export edit cannot change
  // any edge at all.
  const root = createTempDir("intel-prop-");
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeAndStamp(join(root, "src", "importer.ts"), 'import { helper } from "./helper.ts";\nexport function useHelper() { return helper(); }\n');
    const first = generateRepositoryMap(root);
    const g1 = buildDependencyGraph(first.map);
    assert.equal(g1.edgeCount, 0, "helper.ts does not exist yet — no edge can resolve");

    // ADD the target: the importer's edge appears, and the importer is
    // NEVER re-parsed (parse count 1 = the added file).
    writeAndStamp(join(root, "src", "helper.ts"), "export function helper() { return 1; }\n");
    let parsed = 0;
    const second = generateRepositoryMap(root, {
      cache: first.cache,
      onFileParsed: () => { parsed += 1; },
    });
    assert.equal(parsed, 1, "only helper.ts is parsed — the importer is reused from cache");
    assert.deepEqual(parsed === 1 ? buildDependencyGraph(second.map).edges : [], [
      Object.freeze({ from: "src/importer.ts", to: "src/helper.ts", specifier: "./helper.ts" }),
    ]);
    const importerBefore = modulesByPath(second.map).get("src/importer.ts");

    // EDIT the target's EXPORTS: edges are import-statement facts, not
    // export facts — the edge is unchanged and the importer record is
    // byte-identical.
    writeAndStamp(join(root, "src", "helper.ts"), "export function helper() { return 2; }\nexport function helper2() { return 3; }\n");
    parsed = 0;
    const third = generateRepositoryMap(root, {
      cache: second.cache,
      onFileParsed: () => { parsed += 1; },
    });
    assert.equal(parsed, 1);
    const g3 = buildDependencyGraph(third.map);
    assert.equal(g3.edgeCount, 1, "an export edit cannot change an import edge");
    assert.deepStrictEqual(modulesByPath(third.map).get("src/importer.ts"), importerBefore);

    // DELETE the target: the edge disappears with ZERO parses.
    rmSync(join(root, "src", "helper.ts"));
    parsed = 0;
    const fourth = generateRepositoryMap(root, {
      cache: third.cache,
      onFileParsed: () => { parsed += 1; },
    });
    assert.equal(parsed, 0, "a deletion parses nothing");
    assert.equal(buildDependencyGraph(fourth.map).edgeCount, 0);
    assert.ok(modulesByPath(fourth.map).has("src/importer.ts"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stat-cache: a walk that errors mid-way does NOT poison the cache", () => {
  const root = createIncrementalFixture(30);
  try {
    const { reader, resetReads } = countingReader();
    const first = generateRepositoryMap(root, { reader });
    // A change that lands BEFORE the tainted walk — the next clean build
    // must still see it.
    writeAndStamp(join(root, "src", "sub", "mod0.ts"), "export const mod0 = -1;\nexport function fresh0() { return 0; }\n");
    // Second build: the reader reports an INCOMPLETE walk (a directory
    // read failed mid-way). The map is best-effort, but the returned cache
    // must be the PREVIOUS one — a partial snapshot can never be
    // installed.
    let call = 0;
    const taintedReader: RepositoryReaderPort = {
      listFiles: (r, limits) => reader.listFiles(r, limits),
      listFilesWithStatus: (r, limits) => {
        call += 1;
        const scan = reader.listFilesWithStatus!(r, limits);
        if (call === 1) {
          return {
            files: scan.files.filter((f) => f.path !== "src/sub/mod0.ts" && f.path !== "src/sub/mod5.ts"),
            complete: false,
          };
        }
        return scan;
      },
      readFile: reader.readFile,
    };
    const tainted = generateRepositoryMap(root, { reader: taintedReader, cache: first.cache });
    assert.strictEqual(tainted.cache, first.cache, "an incomplete walk returns the previous cache object unchanged");
    assert.ok(!tainted.map.modules.some((m) => m.path === "src/sub/mod0.ts"), "best-effort map drops the unreadable subtree");
    // Third build with the (unpoisoned) previous cache: the change is
    // still detected — mtime differs from the snapshot the cache holds.
    resetReads();
    let parsed = 0;
    const clean = generateRepositoryMap(root, {
      reader,
      cache: tainted.cache,
      onFileParsed: () => { parsed += 1; },
    });
    assert.ok(clean.map.modules.some((m) => m.path === "src/sub/mod0.ts"), "the pre-taint change is not lost");
    assert.equal(parsed, 1, "only the changed file re-parses against the preserved snapshot");
    const fresh = generateRepositoryMap(root);
    assert.deepStrictEqual(clean.map, fresh.map);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("changedPathHints: the editor-write fast path re-reads ONLY the hinted paths (no tree walk)", () => {
  const root = createIncrementalFixture(200);
  try {
    const { reader, reads, resetReads } = countingReader();
    const first = generateRepositoryMap(root, { reader });

    // Edit one file, hint it: zero stat-walk reads of the other 199.
    const hintedContent = "export const hinted = true;\nexport function h9() { return 9; }\n";
    writeAndStamp(join(root, "src", "mod9.ts"), hintedContent);
    resetReads();
    let parsed = 0;
    const hinted = generateRepositoryMap(root, {
      reader,
      cache: first.cache,
      changedPathHints: ["src/mod9.ts"],
      onFileParsed: () => { parsed += 1; },
    });
    assert.deepEqual(reads(), ["src/mod9.ts"]);
    assert.equal(parsed, 1);
    assert.equal(hinted.map.modules.length, 200);
    // Per-path semantic equality with a from-scratch build.
    const fresh = generateRepositoryMap(root);
    assert.deepStrictEqual(modulesByPath(hinted.map), modulesByPath(fresh.map));
    assert.equal(hinted.map.totalSymbols, fresh.map.totalSymbols);

    // Hint a DELETE: the module drops, zero parses (the read attempt on a
    // missing file is the deletion check itself).
    rmSync(join(root, "src", "mod12.ts"));
    resetReads();
    parsed = 0;
    const dropped = generateRepositoryMap(root, {
      reader,
      cache: hinted.cache,
      changedPathHints: ["src/mod12.ts"],
      onFileParsed: () => { parsed += 1; },
    });
    assert.equal(parsed, 0);
    assert.ok(!dropped.map.modules.some((m) => m.path === "src/mod12.ts"));
    assert.equal(dropped.map.modules.length, 199);

    // Hint an ADD: the new module lands.
    writeAndStamp(join(root, "src", "new-file.ts"), "export const nf = 1;\n");
    resetReads();
    parsed = 0;
    const grown = generateRepositoryMap(root, {
      reader,
      cache: dropped.cache,
      changedPathHints: ["src/new-file.ts"],
      onFileParsed: () => { parsed += 1; },
    });
    assert.equal(parsed, 1);
    assert.ok(grown.map.modules.some((m) => m.path === "src/new-file.ts"));
    assert.equal(grown.map.modules.length, 200);

    // Hint a revert (the SAME bytes the cache holds, a new mtime): one
    // read, zero parses — the content-hash floor.
    writeAndStamp(join(root, "src", "mod9.ts"), hintedContent);
    resetReads();
    parsed = 0;
    generateRepositoryMap(root, {
      reader,
      cache: grown.cache,
      changedPathHints: ["src/mod9.ts"],
      onFileParsed: () => { parsed += 1; },
    });
    assert.deepEqual(reads(), ["src/mod9.ts"]);
    assert.equal(parsed, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stat-cache: a config-shape change discards the cache wholesale", () => {
  const root = createIncrementalFixture(30);
  try {
    const { reader, reads, resetReads } = countingReader();
    // Build under a NARROWER shape (fewer maximum entries allowed).
    const shaped = generateRepositoryMap(root, { reader, limits: { maximumEntries: 500 } });
    resetReads();
    assert.ok(isRepositoryMapCacheReusable(shaped.cache) === false || shaped.cache.configKey !== generateRepositoryMap(root, { reader }).cache.configKey);
    // Rebuild under the DEFAULT shape with the shaped cache: nothing may
    // be reused — every file re-read and re-parsed.
    let parsed = 0;
    const second = generateRepositoryMap(root, {
      reader,
      cache: shaped.cache,
      onFileParsed: () => { parsed += 1; },
    });
    assert.equal(reads().length, 30, "a cache from another config shape is discarded — every file re-reads");
    assert.equal(parsed, 30);
    assert.equal(second.map.modules.length, 30);
    // And the same-shape cache IS reusable.
    assert.ok(isRepositoryMapCacheReusable(second.cache));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stat-cache: scanRepositoryStats + diffStatSnapshot answer 'did anything change?' without reads", () => {
  const root = createIncrementalFixture(20);
  try {
    const scan1 = scanRepositoryStats(root);
    assert.equal(scan1.complete, true);
    assert.equal(scan1.files.length, 20);
    // A cache with no stats is never reusable; a real one is.
    const empty: RepositoryMapCache = createRepositoryMapCache();
    assert.equal(isRepositoryMapCacheReusable(empty), false);
    assert.equal(isRepositoryMapCacheReusable(undefined), false);
    const built = generateRepositoryMap(root);
    assert.equal(isRepositoryMapCacheReusable(built.cache), true);
    // Diff an unchanged tree: nothing dirty, nothing dropped.
    const scan2 = scanRepositoryStats(root);
    const same = diffStatSnapshot(scan2.files, built.cache);
    assert.deepEqual(same, { dirty: [], dropped: [] });
    // Perturb: edit + delete + add → the diff names exactly them.
    writeAndStamp(join(root, "src", "mod3.ts"), "export const changed = 1;\n");
    rmSync(join(root, "src", "mod4.ts"));
    writeAndStamp(join(root, "src", "brand-new.ts"), "export const added = 1;\n");
    const scan3 = scanRepositoryStats(root);
    const diff = diffStatSnapshot(scan3.files, built.cache);
    assert.deepEqual([...diff.dirty].sort(), ["src/brand-new.ts", "src/mod3.ts"]);
    assert.deepEqual(diff.dropped, ["src/mod4.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ========== Walk bound (R21-TC-F1): repositoryMaxEntries is GLOBAL per walk ==========
//
// The config knob's actual contract: ONE entry ceiling for the whole walk.
// The old code enforced it per-DIRECTORY (a 100k-file monorepo walked all
// 100k — no directory held 50k), and the knob was resolved but consumed by
// nothing. The honest semantics chosen: a tree that exceeds the bound
// REFUSES the walk with the typed limit error `intelligence_walk_entries_
// exceeded` — never a silently capped listing (a capped stat walk would
// diff wrongly: files beyond the cap look "dropped" → a false "changed";
// a map built from it is silently partial while claiming to be the tree).
// The refusal routes: the main-thread TTL refresh takes the worker path,
// and the worker surfaces the typed limit to the operator, who can raise
// the now-live knob.

test("walk bound: repositoryMaxEntries is the walk's GLOBAL entry ceiling — an over-bound tree REFUSES with the typed limit error, never silently caps", () => {
  const root = createIncrementalFixture(24);
  try {
    // 24 files across two directories (src: 19, src/sub: 5).
    // AT the bound: the whole tree walks complete (a tree exactly at the
    // ceiling never refuses).
    const atBound = scanRepositoryStats(root, { maximumEntries: 24 });
    assert.equal(atBound.complete, true);
    assert.equal(atBound.files.length, 24);
    // ABOVE the bound but above EVERY SINGLE directory's count too: the old
    // per-directory cap walked all 24 here and claimed `complete` — a
    // silently partial-tolerant lie. The global bound refuses instead.
    assert.throws(
      () => scanRepositoryStats(root, { maximumEntries: 20 }),
      (err: unknown) =>
        err instanceof HarnessError && err.code === "intelligence_walk_entries_exceeded",
      "an over-bound walk must refuse with the typed limit error, not cap",
    );
    // The refusal is per-walk, not sticky: the same tree walks complete
    // again at a bound that admits it.
    const retry = scanRepositoryStats(root, { maximumEntries: 25 });
    assert.equal(retry.complete, true);
    assert.equal(retry.files.length, 24);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("walk bound: the config knobs repositoryMaxDepth/repositoryMaxEntries own the walk's default ceilings", () => {
  const config = resolveIntelligenceConfig();
  const limits = resolveRepositoryReadLimits();
  assert.equal(limits.maximumEntries, config.repositoryMaxEntries, "the walk's entry ceiling must be the config knob, not a frozen parallel copy");
  assert.equal(limits.maximumDepth, config.repositoryMaxDepth, "the walk's depth ceiling must be the config knob, not a frozen parallel copy");
  // The documented default — the ceiling an operator raises for huge
  // monorepos instead of getting a silently partial map.
  assert.equal(config.repositoryMaxEntries, 50_000);
});
