/**
 * Central configuration for the dynamic codebase awareness engine.
 *
 * This is the SINGLE owner of every threshold, cap, top-N limit, signal
 * toggle, and language mapping used by the awareness engine. Per the user
 * directive ("everything should be dynamically computed, no static
 * variables/consts other than configurables"), every numeric/string
 * constant that is not derived from the actual codebase lives HERE, in
 * the central config, and is overridable by the caller. The signal
 * implementations never read hardcoded values from their own modules.
 *
 * Language keywords (e.g. `def`, `fn`, `func`) are NOT harness constants;
 * they are part of the target language's grammar and live in the
 * language adapters alongside the parser that uses them.
 */
import { deepFreeze } from "../../../src/kernel/integrity.ts";

/**
 * Configuration for one supported source language.
 *
 * `extensions` and `functionKeyword`/`typeAnnotationPattern` are part of
 * the language's grammar, not harness policy; they are colocated with the
 * adapter but exposed here so the engine's file walker can dispatch to the
 * right adapter without a hardcoded extension switch.
 */
export type LanguageConfig = Readonly<{
  /** Language id, e.g. "typescript", "python", "rust", "go". */
  id: string;
  /** Human-readable label used in the compact block. */
  label: string;
  /** File extensions, lowercase, leading dot. */
  extensions: readonly string[];
  /** Comment line prefixes used for TODO/FIXME scanning. */
  commentLinePrefixes: readonly string[];
}>;

/**
 * Per-signal thresholds and caps. Every value is overridable; the
 * defaults are deliberately conservative so the compact block stays
 * inside the 200–500 token budget on codebases from a few files up to
 * tens of thousands.
 */
export type AwarenessThresholds = Readonly<{
  /** Cyclomatic complexity at/above which a function is a "hotspot". */
  complexityHotspot: number;
  /** Numeric literal count threshold for "magic number" detection per file. */
  magicNumberAllowlist: readonly number[];
  /** Body size (chars) below which a function is skipped for clone detection. */
  cloneMinBodySize: number;
  /** Token count below which a function is skipped for clone detection. */
  cloneMinTokens: number;
  /** Jaccard similarity at/above which two function bodies are "clones". */
  cloneJaccardThreshold: number;
  /** Shingle size for Jaccard clone detection. */
  cloneShingleK: number;
  /** Shingles appearing in more than this many functions are non-discriminative. */
  cloneBucketCap: number;
  /** PageRank damping factor. */
  pagerankDamping: number;
  /** PageRank iteration count. */
  pagerankIterations: number;
  /** PageRank convergence tolerance (unused when iterations is fixed). */
  pagerankTolerance: number;
  /** Number of commits to scan for trending/debt signals (0 = no git). */
  gitHistoryDepth: number;
  /** Ebbinghaus decay rate per unit time (per day) for debt accrual. */
  debtDecayPerDay: number;
  /** Function call-count at/above which a high-complexity fn becomes a risk. */
  riskCallCountThreshold: number;
}>;

/**
 * Top-N limits for the compact representation. These bound the size of
 * each section so the total block stays inside the token budget.
 */
export type AwarenessTopN = Readonly<{
  topHubModules: number;
  topTrendingModules: number;
  topRiskHotspots: number;
  topCloneFamilies: number;
  topComplexFunctions: number;
  topModuleRoles: number;
  topRecentFiles: number;
  topRenyiOrders: number;
}>;

/**
 * Which signals to compute. Each toggle is overridable so callers can
 * disable expensive signals (e.g. clones on a 10k-file codebase).
 */
export type AwarenessSignalToggles = Readonly<{
  typeLevel: boolean;
  quality: boolean;
  drift: boolean;
  complexity: boolean;
  architecture: boolean;
  clones: boolean;
  entropy: boolean;
  dependencies: boolean;
  health: boolean;
  debt: boolean;
  moduleRoles: boolean;
  hotspots: boolean;
  trending: boolean;
  risk: boolean;
}>;

/**
 * The full awareness configuration. The engine reads ONLY from this
 * object; signal modules receive their slice via the engine.
 */
export type AwarenessConfig = Readonly<{
  /** Languages to detect and walk. Order = priority for the "primary language" label. */
  languages: readonly LanguageConfig[];
  /** Directories to skip during the walk. */
  excludedDirectoryNames: readonly string[];
  /** Maximum walk depth (safety cap). */
  maximumDepth: number;
  /** Maximum file entries (safety cap). */
  maximumEntries: number;
  /** Maximum file size in bytes (skip larger files). */
  maximumFileBytes: number;
  /** Whether to use git history for trending/debt (false if git unavailable). */
  useGitHistory: boolean;
  /** Thresholds. */
  thresholds: AwarenessThresholds;
  /** Top-N limits for the compact block. */
  topN: AwarenessTopN;
  /** Signal toggles. */
  signals: AwarenessSignalToggles;
  /** Target token budget for the compact block. */
  compactTokenBudget: number;
  /** Characters-per-token estimate for compactness measurement. */
  compactCharsPerToken: number;
}>;

/** Default languages. Extendable via `AwarenessConfig.languages`. */
export const DEFAULT_LANGUAGES = deepFreeze([
  { id: "typescript", label: "TypeScript/JavaScript", extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"], commentLinePrefixes: ["//", "/*", "*"] },
  { id: "python",     label: "Python",                extensions: [".py"],                                                                 commentLinePrefixes: ["#"] },
  { id: "rust",       label: "Rust",                  extensions: [".rs"],                                                                commentLinePrefixes: ["//", "/*", "*"] },
  { id: "go",         label: "Go",                    extensions: [".go"],                                                                commentLinePrefixes: ["//", "/*", "*"] },
] as const) satisfies readonly LanguageConfig[];

/** Default excluded directory names (build artefacts, deps, VCS, test data, etc.). */
export const DEFAULT_EXCLUDED_DIRS = deepFreeze([
  // Build outputs and deps.
  "node_modules", ".git", "dist", "build", "target", "__pycache__",
  ".venv", "venv", "vendor", ".next", ".nuxt", "out", "bin", "obj",
  "coverage", ".cache", ".turbo", ".idea", ".vscode",
  ".yarn", ".pnp.cjs", ".pnp.js", "lib", "Lib",
  // Test data + fixtures + benchmarks (NOT production source).
  "__tests__", "__fixtures__", "__mocks__", "fixtures", "cypress",
  "cases", "baselines", "test-cases", "testdata", "test-data",
  "benchmark", "benchmarks", "codemods",
  // Misc editor/tooling.
  ".svelte-kit", ".parcel-cache", ".gradle", ".m2", ".dart_tool",
] as const);

/** Default thresholds, chosen to keep the compact block inside budget. */
export const DEFAULT_THRESHOLDS = deepFreeze({
  complexityHotspot: 15,
  magicNumberAllowlist: [0, 1, -1, 2, -2, 10, 60, 100, 1000, 3600, 0.5],
  cloneMinBodySize: 80,
  cloneMinTokens: 30,
  cloneJaccardThreshold: 0.9,
  cloneShingleK: 6,
  cloneBucketCap: 200,
  pagerankDamping: 0.85,
  pagerankIterations: 30,
  pagerankTolerance: 1e-6,
  gitHistoryDepth: 30,
  debtDecayPerDay: 0.05,
  riskCallCountThreshold: 5,
} as const) satisfies AwarenessThresholds;

/** Default Top-N limits. */
export const DEFAULT_TOP_N = deepFreeze({
  topHubModules: 5,
  topTrendingModules: 5,
  topRiskHotspots: 5,
  topCloneFamilies: 5,
  topComplexFunctions: 5,
  topModuleRoles: 5,
  topRecentFiles: 5,
  topRenyiOrders: 4,
} as const) satisfies AwarenessTopN;

/** Default signal toggles (all on). */
export const DEFAULT_SIGNAL_TOGGLES = deepFreeze({
  typeLevel: true,
  quality: true,
  drift: true,
  complexity: true,
  architecture: true,
  clones: true,
  entropy: true,
  dependencies: true,
  health: true,
  debt: true,
  moduleRoles: true,
  hotspots: true,
  trending: true,
  risk: true,
} as const) satisfies AwarenessSignalToggles;

/** Default awareness config. */
export const DEFAULT_CONFIG: AwarenessConfig = deepFreeze({
  languages: DEFAULT_LANGUAGES,
  excludedDirectoryNames: DEFAULT_EXCLUDED_DIRS,
  maximumDepth: 32,
  maximumEntries: 50_000,
  maximumFileBytes: 5_000_000,
  useGitHistory: true,
  thresholds: DEFAULT_THRESHOLDS,
  topN: DEFAULT_TOP_N,
  signals: DEFAULT_SIGNAL_TOGGLES,
  compactTokenBudget: 500,
  compactCharsPerToken: 4,
} as const) satisfies AwarenessConfig;

/**
 * Merge a partial override into the default config. Only the supplied
 * fields are overridden; nested objects are shallow-merged at the
 * `thresholds`/`topN`/`signals` level.
 */
export function configureAwareness(override: Readonly<Partial<AwarenessConfig>>): AwarenessConfig {
  const base: AwarenessConfig = DEFAULT_CONFIG;
  return deepFreeze({
    languages: override.languages ?? base.languages,
    excludedDirectoryNames: override.excludedDirectoryNames ?? base.excludedDirectoryNames,
    maximumDepth: override.maximumDepth ?? base.maximumDepth,
    maximumEntries: override.maximumEntries ?? base.maximumEntries,
    maximumFileBytes: override.maximumFileBytes ?? base.maximumFileBytes,
    useGitHistory: override.useGitHistory ?? base.useGitHistory,
    thresholds: { ...base.thresholds, ...override.thresholds },
    topN: { ...base.topN, ...override.topN },
    signals: { ...base.signals, ...override.signals },
    compactTokenBudget: override.compactTokenBudget ?? base.compactTokenBudget,
    compactCharsPerToken: override.compactCharsPerToken ?? base.compactCharsPerToken,
  } as const);
}
