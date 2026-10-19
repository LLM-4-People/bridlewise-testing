/**
 * Dynamic awareness engine — the orchestrator.
 *
 * Walks the codebase, dispatches each file to its language adapter,
 * caches per-file analyses by (mtime, size), and feeds the analyses to
 * every signal module. The engine is the only module that touches the
 * filesystem; signal modules are pure.
 *
 * Per the user directive ("dynamically updated in real time"), the
 * engine's `compute()` method is called BEFORE each LLM turn. It
 * re-walks the tree, checks each file's mtime, and re-analyzes only
 * the files that changed. This makes the awareness block reflect the
 * CURRENT state of the codebase — if the LLM edited a file in turn 5,
 * turn 6's awareness block reflects the edit.
 *
 * The engine has no static state other than the cache. All
 * thresholds, toggles, and limits come from `AwarenessConfig`.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep, extname } from "node:path";
import { execSync } from "node:child_process";

import type { AwarenessConfig } from "./config.ts";
import type {
  AwarenessSnapshot,
  FileAnalysis,
  ModuleRecord,
  GitCommit,
  SignalContext,
} from "./types.ts";
import { SNAPSHOT_SCHEMA_VERSION } from "./types.ts";
import { ADAPTERS, GENERIC_ADAPTER, adapterForExtension, languageConfigMap } from "./languages/index.ts";
import type { LanguageAdapter } from "./languages/index.ts";

import { computeTypeLevel } from "./signals/type-level.ts";
import { computeComplexity } from "./signals/complexity.ts";
import { computeArchitecture } from "./signals/architecture.ts";
import { computeClones } from "./signals/clones.ts";
import { computeEntropy } from "./signals/entropy.ts";
import { computeDependencies } from "./signals/dependencies.ts";
import { computeHealth } from "./signals/health.ts";
import { computeQuality } from "./signals/quality.ts";
import { computeDrift } from "./signals/drift.ts";
import { computeDebt } from "./signals/debt.ts";
import { computeModuleRoles } from "./signals/module-roles.ts";
import { computeHotspots } from "./signals/hotspots.ts";
import { computeTrending } from "./signals/trending.ts";
import { computeRisk } from "./signals/risk.ts";
import { composeCompactBlock } from "./compact.ts";

/** Cache entry for one file. */
type CacheEntry = {
  mtimeMs: number;
  sizeBytes: number;
  analysis: FileAnalysis;
};

/** Construct a new engine. Multiple engines can coexist (e.g. one per codebase). */
export function createAwarenessEngine(config: AwarenessConfig, adapters: readonly LanguageAdapter[] = ADAPTERS): {
  compute: (rootPath: string) => AwarenessSnapshot;
  clearCache: () => void;
  cacheSize: () => number;
} {
  const cache = new Map<string, CacheEntry>();
  const langConfigMap = languageConfigMap(adapters);

  /** Walk the codebase and return file analyses (using cache). */
  function walkAndAnalyze(rootPath: string): { analyses: FileAnalysis[]; reanalyzed: number; cached: number } {
    const rawAnalyses: FileAnalysis[] = [];
    let reanalyzed = 0;
    let cached = 0;
    let entries = 0;
    const stack: Array<{ dir: string; depth: number }> = [{ dir: rootPath, depth: 0 }];
    const excluded = new Set(config.excludedDirectoryNames);
    // Workspace package map: package.json "name" → relative directory.
    const workspacePackages = new Map<string, string>();
    while (stack.length > 0 && entries < config.maximumEntries) {
      const { dir, depth } = stack.pop()!;
      if (depth > config.maximumDepth) continue;
      let entries_ls: string[] = [];
      try { entries_ls = readdirSync(dir); } catch { continue; }
      for (const name of entries_ls) {
        if (excluded.has(name)) continue;
        const full = join(dir, name);
        let st;
        try { st = statSync(full); } catch { continue; }
        if (st.isDirectory()) {
          stack.push({ dir: full, depth: depth + 1 });
          const pkgPath = join(dir, name, "package.json");
          try {
            if (existsSyncFn(pkgPath)) {
              const pkgContent = readFileSync(pkgPath, "utf8");
              const pkg = JSON.parse(pkgContent) as { name?: string };
              if (typeof pkg.name === "string") {
                const rel = relative(rootPath, join(dir, name)).split(sep).join("/");
                workspacePackages.set(pkg.name, rel);
              }
            }
          } catch { /* ignore */ }
        } else if (st.isFile()) {
          entries += 1;
          if (entries > config.maximumEntries) break;
          if (st.size > config.maximumFileBytes) continue;
          const ext = extname(name).toLowerCase();
          const adapter = adapterForExtension(ext, adapters) ?? GENERIC_ADAPTER;
          if (adapter === GENERIC_ADAPTER) {
            const textExt = [".txt", ".md", ".json", ".toml", ".yaml", ".yml", ".ini", ".cfg", ".sh", ".bash"];
            if (!textExt.includes(ext)) continue;
          }
          const rel = relative(rootPath, full).split(sep).join("/");
          const key = rel;
          const cached_entry = cache.get(key);
          if (cached_entry && cached_entry.mtimeMs === st.mtimeMs && cached_entry.sizeBytes === st.size) {
            rawAnalyses.push(cached_entry.analysis);
            cached += 1;
            continue;
          }
          let content: string;
          try { content = readFileSync(full, "utf8"); } catch { continue; }
          let analysis: FileAnalysis;
          try {
            const a = adapter.analyze(rel, content);
            analysis = {
              ...a,
              filePath: rel,
              languageId: adapter.config.id,
              contentHash: sha256(content),
            };
          } catch {
            continue;
          }
          cache.set(key, { mtimeMs: st.mtimeMs, sizeBytes: st.size, analysis });
          rawAnalyses.push(analysis);
          reanalyzed += 1;
        }
      }
    }
    // Second pass: resolve intra-codebase imports using the FULL analysis set + workspace packages.
    const pathSet = new Set(rawAnalyses.map(a => a.filePath));
    const analyses = rawAnalyses.map(a => ({
      ...a,
      imports: a.imports.map(imp => {
        if (imp.resolvedPath) return imp;
        const resolved = resolveImport(imp.specifier, a.filePath, workspacePackages, pathSet);
        return { ...imp, resolvedPath: resolved };
      }),
    }));
    const currentPaths = new Set(analyses.map(a => a.filePath));
    for (const key of cache.keys()) {
      if (!currentPaths.has(key)) cache.delete(key);
    }
    return { analyses, reanalyzed, cached };
  }

  /** Compute modules (directories) from the file analyses. */
  function computeModules(analyses: readonly FileAnalysis[], mtimes: Map<string, number>): ModuleRecord[] {
    // Group by directory (the module = the directory of the file).
    const byDir = new Map<string, { files: number; fns: number; loc: number; latestMtimeMs: number; name: string }>();
    for (const a of analyses) {
      const dir = a.filePath.includes("/") ? a.filePath.split("/").slice(0, -1).join("/") : ".";
      const name = dir === "." ? "(root)" : dir.split("/").pop() ?? dir;
      const e = byDir.get(dir) ?? { files: 0, fns: 0, loc: 0, latestMtimeMs: 0, name };
      e.files += 1;
      e.fns += a.functions.length;
      e.loc += a.lineCount;
      e.latestMtimeMs = Math.max(e.latestMtimeMs, mtimes.get(a.filePath) ?? 0);
      byDir.set(dir, e);
    }
    // Also: if there are subdirectories that are themselves groups (e.g. "packages" → "packages/foo" → "packages/foo/src"), we want the SHALLOWEST module per chain.
    // For simplicity, use top-level directories (depth-1) as the modules.
    const modules: ModuleRecord[] = [];
    for (const [dir, e] of byDir) {
      // If a directory has only one child that's also a directory and there's no direct file, skip it.
      // Heuristic: collapse single-child chains.
      let finalDir = dir;
      let finalName = e.name;
      // Look for the "real" module — collapse to the topmost non-trivial directory.
      // For babel/packages/babel-parser/src → "babel-parser" (the part after "packages").
      // For tokio/tokio/src/io → "io".
      // For gin/binding → "binding".
      // Strategy: if the path contains "packages/" or "src/", take the segment AFTER it; else take the last segment.
      const path = dir.split("/");
      let effectiveName = finalName;
      for (let i = 0; i < path.length; i += 1) {
        const seg = path[i]!;
        if (seg === "packages" && i + 1 < path.length) {
          effectiveName = path[i + 1] ?? finalName;
          finalDir = path.slice(0, i + 2).join("/");
          break;
        }
        if (seg === "src") {
          // If src is followed by a sub-directory, that's the module name.
          if (i + 1 < path.length) {
            effectiveName = path[i + 1] ?? finalName;
            finalDir = path.slice(0, i + 2).join("/");
          } else if (i - 1 >= 0) {
            // File directly in src/ — use the previous segment (package name).
            effectiveName = path[i - 1] ?? finalName;
            finalDir = path.slice(0, i).join("/") || dir;
          }
          break;
        }
      }
      modules.push({
        path: finalDir,
        name: effectiveName,
        fileCount: e.files,
        functionCount: e.fns,
        lineCount: e.loc,
        pagerank: 0,
        inDegree: 0,
        outDegree: 0,
        latestMtimeMs: e.latestMtimeMs,
      });
    }
    // Merge modules with the same final path (after collapsing).
    const merged = new Map<string, ModuleRecord>();
    for (const m of modules) {
      const existing = merged.get(m.path);
      if (existing) {
        merged.set(m.path, {
          ...existing,
          fileCount: existing.fileCount + m.fileCount,
          functionCount: existing.functionCount + m.functionCount,
          lineCount: existing.lineCount + m.lineCount,
          latestMtimeMs: Math.max(existing.latestMtimeMs, m.latestMtimeMs),
        });
      } else {
        merged.set(m.path, m);
      }
    }
    return [...merged.values()];
  }

  /** Collect per-file mtimes (for trending fallback). */
  function collectMtimes(rootPath: string, analyses: readonly FileAnalysis[]): Map<string, number> {
    const out = new Map<string, number>();
    for (const a of analyses) {
      try {
        const st = statSync(join(rootPath, a.filePath));
        out.set(a.filePath, st.mtimeMs);
      } catch { /* skip */ }
    }
    return out;
  }

  /** Get recent git history (commit → changed files). */
  function getGitHistory(rootPath: string): GitCommit[] {
    if (!config.useGitHistory) return [];
    try {
      const depth = config.thresholds.gitHistoryDepth;
      // Get commit hashes + timestamps.
      const logFmt = "%H|%ct";
      const log = execSync(`git -C ${shellQuote(rootPath)} log -n ${depth} --no-merges --pretty=${shellQuote(logFmt)}`, { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], timeout: 10_000 });
      const commits = log.split("\n").filter(Boolean).map(line => {
        const [hash, ts] = line.split("|");
        return { hash: hash!.slice(0, 8), timestampMs: Number(ts) * 1000 };
      });
      // For each commit, get changed files (use diff-tree to avoid show/--no-patch conflict).
      const out: GitCommit[] = [];
      for (const c of commits) {
        try {
          const files = execSync(`git -C ${shellQuote(rootPath)} diff-tree --no-commit-id --name-only -r ${shellQuote(c.hash)}`, { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], timeout: 10_000 });
          const changed = files.split("\n").map(f => f.trim().replace(/\\/g, "/")).filter(f => f);
          out.push({ ...c, changedFiles: changed });
        } catch { /* skip this commit */ }
      }
      return out;
    } catch {
      return [];
    }
  }

  /** Read a file's content (used by drift/debt; cached via the cache). */
  function makeFileReader(rootPath: string, analyses: readonly FileAnalysis[]): (filePath: string) => string | null {
    return (filePath: string) => {
      const fa = analyses.find(a => a.filePath === filePath);
      if (fa) {
        // Re-read the file content (we don't cache the raw content, just the analysis).
        try { return readFileSync(join(rootPath, filePath), "utf8"); } catch { return null; }
      }
      // Manifest files not in analyses (e.g. package.json) — read directly.
      try { return readFileSync(join(rootPath, filePath), "utf8"); } catch { return null; }
    };
  }

  /** Compute the full awareness snapshot for the codebase at `rootPath`. */
  function compute(rootPath: string): AwarenessSnapshot {
    const t0 = Date.now();
    const { analyses, reanalyzed, cached } = walkAndAnalyze(rootPath);
    const mtimes = collectMtimes(rootPath, analyses);
    const modules = computeModules(analyses, mtimes);
    const gitHistory = getGitHistory(rootPath);
    const readFile = makeFileReader(rootPath, analyses);

    // Language mix.
    const langByCount = new Map<string, { languageId: string; label: string; fileCount: number; lineCount: number }>();
    for (const a of analyses) {
      const cfg = langConfigMap.get(a.languageId);
      const label = cfg?.label ?? a.languageId;
      const e = langByCount.get(a.languageId) ?? { languageId: a.languageId, label, fileCount: 0, lineCount: 0 };
      e.fileCount += 1;
      e.lineCount += a.lineCount;
      langByCount.set(a.languageId, e);
    }
    const languageMix = [...langByCount.values()].sort((a, b) => b.fileCount - a.fileCount);
    const primaryLanguageId = languageMix[0]?.languageId ?? null;
    const fileCount = analyses.length;
    const functionCount = analyses.reduce((n, a) => n + a.functions.length, 0);
    const totalLoc = analyses.reduce((n, a) => n + a.lineCount, 0);
    const moduleCount = modules.length;

    // Build context.
    const ctx: SignalContext = {
      config,
      languageConfigs: langConfigMap,
      fileAnalyses: analyses,
      modules,
      rootPath,
      gitHistory,
      readFile,
      nowMs: Date.now(),
    };

    // Compute base signals (no inter-signal dependencies).
    const typeLevel = config.signals.typeLevel ? computeTypeLevel(ctx).typeLevel : null;
    const complexity = config.signals.complexity ? computeComplexity(ctx).complexity : null;
    const architectureResult = config.signals.architecture ? computeArchitecture(ctx) : null;
    const architecture = architectureResult?.architecture ?? null;
    const clones = config.signals.clones ? computeClones(ctx).clones : null;
    const entropy = config.signals.entropy ? computeEntropy(ctx).entropy : null;
    const dependencies = config.signals.dependencies ? computeDependencies(ctx).dependencies : null;
    const health = config.signals.health ? computeHealth(ctx).health : null;
    const moduleRoles = config.signals.moduleRoles ? computeModuleRoles(ctx).moduleRoles : null;
    const drift = config.signals.drift ? computeDrift(ctx).drift : null;
    const debt = config.signals.debt ? computeDebt(ctx).debt : null;

    // Compute derived signals.
    const quality = config.signals.quality ? computeQuality(ctx, { health, complexity, dependencies, fileCount, totalLoc }).quality : null;
    const hotspots = config.signals.hotspots ? computeHotspots(ctx, { complexity, architecture }).hotspots : null;
    const trending = config.signals.trending ? computeTrending(ctx).trending : null;
    const risk = config.signals.risk ? computeRisk(ctx, { complexity }).risk : null;

    // Compose the snapshot (compact block filled below).
    const partial: Omit<AwarenessSnapshot, "compactBlock" | "compactTokens" | "computeTimeMs" | "reanalyzedFiles" | "cachedFiles"> = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      computedAt: new Date(ctx.nowMs).toISOString(),
      rootPath,
      languageMix,
      primaryLanguageId,
      fileCount,
      functionCount,
      moduleCount,
      totalLoc,
      modules,
      fileAnalyses: analyses,
      typeLevel,
      quality,
      drift,
      complexity,
      architecture,
      clones,
      entropy,
      dependencies,
      health,
      debt,
      moduleRoles,
      hotspots,
      trending,
      risk,
    };
    // Compose compact block.
    const { text, tokens } = composeCompactBlock({ ...partial, compactBlock: "", compactTokens: 0, computeTimeMs: 0, reanalyzedFiles: 0, cachedFiles: 0 } as AwarenessSnapshot, config.compactTokenBudget);

    return Object.freeze({
      ...partial,
      compactBlock: text,
      compactTokens: tokens,
      computeTimeMs: Date.now() - t0,
      reanalyzedFiles: reanalyzed,
      cachedFiles: cached,
    } as AwarenessSnapshot);
  }

  return {
    compute,
    clearCache: () => cache.clear(),
    cacheSize: () => cache.size,
  };
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Tiny wrapper to avoid `existsSync` import (used only in the walker). */
function existsSyncFn(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve an import specifier to a workspace-relative source file path.
 * Handles:
 *   - relative imports (`./foo`, `../foo`) — with .ts/.tsx/.js/.jsx inference.
 *   - workspace package imports (`@babel/parser` → `packages/babel-parser/src/index.ts`).
 *   - subpath imports (`@babel/parser/lib/foo` → `packages/babel-parser/src/foo.ts`).
 * Returns null if the import is external or cannot be resolved.
 */
function resolveImport(specifier: string, fromPath: string, workspacePackages: ReadonlyMap<string, string>, pathSet: ReadonlySet<string>): string | null {
  // Relative import.
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const base = fromPath.split("/").slice(0, -1).join("/");
    const joined = (base + "/" + specifier).replace(/\/+/g, "/");
    const parts = joined.split("/");
    const out: string[] = [];
    for (const p of parts) {
      if (p === ".") continue;
      if (p === "..") { out.pop(); continue; }
      out.push(p);
    }
    const clean = out.join("/");
    return resolveSourcePath(clean, pathSet);
  }
  // Workspace package import.
  if (workspacePackages.has(specifier)) {
    const pkgDir = workspacePackages.get(specifier)!;
    return resolveSourcePath(pkgDir + "/src/index", pathSet) ?? resolveSourcePath(pkgDir + "/src", pathSet);
  }
  // Workspace package subpath: `@scope/name/sub` → packages/<scope>-<name>/src/<sub>.
  const slashIdx = specifier.indexOf("/");
  if (slashIdx > 0 && specifier.startsWith("@")) {
    const pkgName = specifier.slice(0, slashIdx);
    const subpath = specifier.slice(slashIdx + 1);
    if (workspacePackages.has(pkgName)) {
      const pkgDir = workspacePackages.get(pkgName)!;
      return resolveSourcePath(pkgDir + "/src/" + subpath, pathSet);
    }
  }
  return null;
}

/** Try a few extensions + index files to find the source path. */
function resolveSourcePath(basePath: string, pathSet: ReadonlySet<string>): string | null {
  // TS-conv: a specifier ending in .js/.jsx/.mjs/.cjs refers to a .ts/.tsx/.mts/.cts source file.
  let base = basePath;
  if (base.endsWith(".js")) base = base.slice(0, -3);
  else if (base.endsWith(".jsx")) base = base.slice(0, -4);
  else if (base.endsWith(".mjs")) base = base.slice(0, -4);
  else if (base.endsWith(".cjs")) base = base.slice(0, -4);
  const candidates = [
    base + ".ts", base + ".tsx", base + ".mts", base + ".cts",
    base + ".js", base + ".jsx", base + ".mjs", base + ".cjs",
    base + ".py", base + ".rs", base + ".go",
    base + "/index.ts", base + "/index.tsx", base + "/index.js", base + "/index.jsx",
    base + "/index.py", base + "/index.rs", base + "/index.go",
    base + "/mod.rs", base + "/lib.rs",
    // Also try the original basePath (in case the specifier already had .ts/.py/.rs/.go).
    basePath,
  ];
  for (const c of candidates) {
    if (pathSet.has(c)) return c;
  }
  return null;
}
