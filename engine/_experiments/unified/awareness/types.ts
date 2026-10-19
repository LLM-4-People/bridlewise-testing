/**
 * Shared types for the dynamic awareness engine. These are produced by
 * the language adapters and consumed by the signal modules.
 *
 * The engine never reads raw source files twice: it walks the tree once,
 * invokes the language adapter per file (cached by mtime+size), and
 * feeds the resulting `FileAnalysis` to every signal. Signal modules are
 * pure functions of `(fileAnalyses, config)` — they never touch the
 * filesystem or re-read source.
 */
import type { AwarenessConfig, LanguageConfig } from "./config.ts";

/** A single function/method definition found by the language adapter. */
export type FunctionRecord = Readonly<{
  /** Path relative to the codebase root, using forward slashes. */
  filePath: string;
  /** Function/method name (or "<anonymous>"). */
  name: string;
  /** 1-based start line. */
  line: number;
  /** Body length in lines (0 if unknown). */
  bodyLines: number;
  /** Body length in characters. */
  bodyChars: number;
  /** Normalized tokens (used for clone detection + entropy). */
  tokens: readonly string[];
  /** Cyclomatic complexity (1 + number of decision points). */
  complexity: number;
  /** Number of parameters with type annotations. */
  typedParameters: number;
  /** Total parameter count. */
  parameterCount: number;
  /** Whether the return type is annotated. */
  hasReturnAnnotation: boolean;
}>;

/** An import statement found by the language adapter. */
export type ImportRecord = Readonly<{
  /** File making the import. */
  filePath: string;
  /** Raw specifier (e.g. "./foo", "@babel/core", "react", "os"). */
  specifier: string;
  /** Names imported (may be empty for side-effect imports). */
  importedNames: readonly string[];
  /** Resolved path if intra-codebase, else null. */
  resolvedPath: string | null;
}>;

/** An export found by the language adapter. */
export type ExportRecord = Readonly<{
  /** File making the export. */
  filePath: string;
  /** Exported name. */
  name: string;
  /** Whether this is the default export. */
  isDefault: boolean;
}>;

/** Per-file analysis produced by a language adapter. */
export type FileAnalysis = Readonly<{
  /** Path relative to the codebase root, forward slashes. */
  filePath: string;
  /** Language id from `LanguageConfig.id`. */
  languageId: string;
  /** Total line count (excludes final newline-only lines). */
  lineCount: number;
  /** Whether the file has any type annotations. */
  hasTypeAnnotations: boolean;
  /** Fraction of function params with type annotations (0–1). */
  typedParameterFraction: number;
  /** Functions in this file. */
  functions: readonly FunctionRecord[];
  /** Imports in this file. */
  imports: readonly ImportRecord[];
  /** Exports in this file. */
  exports: readonly ExportRecord[];
  /** Counts of code-health issues per category. */
  health: Readonly<Record<string, number>>;
  /** Token-stream for entropy (concatenated identifiers + literals). */
  tokenStream: readonly string[];
  /** File content hash (sha256 hex). */
  contentHash: string;
}>;

/** Per-module aggregate (a "module" = a directory under the source root). */
export type ModuleRecord = Readonly<{
  /** Module path (directory) relative to root, forward slashes. */
  path: string;
  /** Module name (last path segment, or root name). */
  name: string;
  /** Number of source files in this module. */
  fileCount: number;
  /** Number of functions in this module. */
  functionCount: number;
  /** Total LOC in this module. */
  lineCount: number;
  /** PageRank score (set by architecture signal). */
  pagerank: number;
  /** Number of distinct modules that import this module (in-degree). */
  inDegree: number;
  /** Number of distinct modules this module imports (out-degree). */
  outDegree: number;
  /** Most recent mtime among files in this module (ms since epoch). */
  latestMtimeMs: number;
}>;

/** The full awareness snapshot — all signals computed at one point in time. */
export type AwarenessSnapshot = Readonly<{
  /** Engine schema version (constant — see SNAPSHOT_SCHEMA_VERSION below). */
  schemaVersion: string;
  /** ISO timestamp when the snapshot was computed. */
  computedAt: string;
  /** Codebase root path. */
  rootPath: string;
  /** Languages detected and their file counts (sorted desc). */
  languageMix: readonly Readonly<{ languageId: string; label: string; fileCount: number; lineCount: number }>[];
  /** Primary language id (highest file count). */
  primaryLanguageId: string | null;
  /** File counts. */
  fileCount: number;
  /** Function count. */
  functionCount: number;
  /** Module count. */
  moduleCount: number;
  /** Total LOC across all source files. */
  totalLoc: number;
  /** Per-module aggregates. */
  modules: readonly ModuleRecord[];
  /** Per-file analyses (the raw material for signals). */
  fileAnalyses: readonly FileAnalysis[];
  /** Type-level signal. */
  typeLevel: Readonly<{ level: "typed" | "untyped" | "mixed"; typedFileFraction: number; typedParameterFraction: number }> | null;
  /** Quality signal. */
  quality: Readonly<{ issueDensity: number; issuesPerKloc: number; totalIssues: number; topCategories: readonly Readonly<{ category: string; count: number }>[] }> | null;
  /** Drift signal. */
  drift: Readonly<{ schemaVersion: string | null; dependencyDrift: number; changedDependencyFiles: readonly string[] }> | null;
  /** Complexity signal. */
  complexity: Readonly<{ mean: number; median: number; p95: number; max: number; hotspotCount: number; distribution: readonly number[]; topFunctions: readonly FunctionRecord[] }> | null;
  /** Architecture signal. */
  architecture: Readonly<{ type: "monolith" | "modular" | "microservices"; hubModules: readonly ModuleRecord[]; edgeCount: number; density: number }> | null;
  /** Clones signal. */
  clones: Readonly<{ familyCount: number; cloneCoverage: number; topFamilies: readonly Readonly<{ representative: string; members: number; avgJaccard: number }>[] }> | null;
  /** Entropy signal. */
  entropy: Readonly<{ shannon: number; renyiSpectrum: readonly Readonly<{ order: number; entropy: number }>[]; tokenCount: number }> | null;
  /** Dependencies signal. */
  dependencies: Readonly<{ circularCount: number; cycles: ReadonlyArray<readonly string[]>; graphDensity: number; missingSymbolCount: number }> | null;
  /** Health signal. */
  health: Readonly<{ todoCount: number; emptyCatchCount: number; magicNumberCount: number; deadExportCount: number; total: number }> | null;
  /** Ebbinghaus debt signal. */
  debt: Readonly<{ totalDebt: number; topDebts: readonly Readonly<{ filePath: string; ageDays: number; debt: number; kind: string }>[] }> | null;
  /** Module-roles signal. */
  moduleRoles: Readonly<{ roles: readonly Readonly<{ role: string; moduleCount: number; functionCount: number }>[] }> | null;
  /** Hotspots signal. */
  hotspots: Readonly<{ topComplex: readonly FunctionRecord[]; topDependedOn: readonly ModuleRecord[] }> | null;
  /** Trending signal. */
  trending: Readonly<{ topRecentFiles: readonly Readonly<{ filePath: string; ageDays: number }>[]; topTrendingModules: readonly ModuleRecord[] }> | null;
  /** Risk signal. */
  risk: Readonly<{ topRisks: readonly Readonly<{ filePath: string; name: string; complexity: number; callCount: number; riskScore: number }>[] }> | null;
  /** Compact block text (filled by compact.ts). */
  compactBlock: string;
  /** Estimated token count of the compact block. */
  compactTokens: number;
  /** Wall-clock time to compute this snapshot (ms). */
  computeTimeMs: number;
  /** Number of files re-analyzed (cache miss) for this snapshot. */
  reanalyzedFiles: number;
  /** Number of files reused from cache. */
  cachedFiles: number;
}>;

/** Schema version (the only hardcoded constant in this module — it identifies the snapshot shape itself). */
export const SNAPSHOT_SCHEMA_VERSION = "bridlewise-awareness/v1" as const;

/** Context passed to each signal module. */
export type SignalContext = Readonly<{
  config: AwarenessConfig;
  languageConfigs: ReadonlyMap<string, LanguageConfig>;
  fileAnalyses: readonly FileAnalysis[];
  modules: readonly ModuleRecord[];
  rootPath: string;
  /** Git history (commit → changed files) if `useGitHistory` is true and git is available. */
  gitHistory: readonly GitCommit[];
  /** Helper to read a file's content (used by drift/debt; cached). */
  readFile: (filePath: string) => string | null;
  /** Wall-clock start time of the snapshot, for age calculations. */
  nowMs: number;
}>;

/** One git commit in the recent history of the codebase. */
export type GitCommit = Readonly<{
  /** Commit hash (short). */
  hash: string;
  /** Author timestamp in ms since epoch. */
  timestampMs: number;
  /** Files changed in this commit (relative paths, forward slashes). */
  changedFiles: readonly string[];
}>;

/** A signal module — a pure function from context to a partial snapshot. */
export type SignalModule<K extends keyof AwarenessSnapshot = keyof AwarenessSnapshot> = Readonly<{
  /** Signal id, matches a toggle in `AwarenessSignalToggles`. */
  id: string;
  /** Compute the signal; returns the partial snapshot value (or null). */
  compute: (ctx: SignalContext) => Partial<Pick<AwarenessSnapshot, K>>;
}>;
