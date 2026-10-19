/**
 * EXP410 — LLM output beyond max window.
 *
 * Central configuration for the beyond-max generator. Every knob is declared
 * here with a default, a type, a validation range, and a description. The
 * orchestrator modules (chunker, continuation, outline-expand, map-reduce,
 * sliding-window, stream-accumulator) consume this contract — they never read
 * literals or env vars directly.
 *
 * Design rules honored:
 *   - one canonical owner per concept (this file);
 *   - everything dynamically computed (chunk size, overlap, retry budget);
 *   - no band-aids, no scattered literals.
 */

export type ModelId = "gemma-4-31b" | "glm-5.2" | "glm-5.2-fast";

export type LlmApiConfig = Readonly<{
  baseUrl: string;
  apiKey: string;
  /** Per-request cap (the model's "max output window"). Triggers finish_reason="length". */
  maxOutputTokens: number;
  temperature: number;
  /** Per-request timeout in ms. */
  requestTimeoutMs: number;
  /** Bounded retry budget for transient 429/5xx. */
  maxRetries: number;
  /** Minimum ms between consecutive calls (per-client pacing to avoid 429s). 0 disables. */
  minInterCallMs: number;
}>;

export type ContinuationPolicy = Readonly<{
  /** Maximum number of continuation rounds before we give up. */
  maxContinuations: number;
  /** Tokens of trailing context to feed back to the model when continuing. */
  trailingContextChars: number;
  /** Abort the whole run if a continuation produces no new content. */
  abortOnNoProgress: boolean;
  /** Abort if the same content is repeated across N consecutive continuations. */
  repeatAbortWindow: number;
}>;

export type ChunkerConfig = Readonly<{
  /** Number of chunks to split a task into. */
  chunkCount: number;
  /** Tokens of summary of prior chunks to include in each next chunk's prompt. */
  summaryChars: number;
}>;

export type OutlineExpandConfig = Readonly<{
  /** Max sections in the outline. */
  maxSections: number;
  /** Max tokens per section expansion. */
  maxTokensPerSection: number;
}>;

export type MapReduceConfig = Readonly<{
  /** Concurrency for the map phase (1 = sequential). */
  concurrency: number;
  /** Whether to invoke the LLM for the reduce step (true) or just concatenate (false). */
  llmReduce: boolean;
}>;

export type SlidingWindowConfig = Readonly<{
  /** Tokens of overlap between consecutive windows. */
  overlapTokens: number;
  /** Max tokens per window. */
  windowTokens: number;
}>;

export type ParallelChunkerConfig = Readonly<{
  /** Number of sections to split the outline into. */
  sectionCount: number;
  /** Max tokens per section expansion. */
  maxTokensPerSection: number;
  /** Worker pool size (matches the API's shared concurrency budget). */
  concurrency: number;
}>;

export type DedupConfig = Readonly<{
  /** Dedup mode: "none" | "line" | "block". */
  mode: "none" | "line" | "block";
  /** Jaccard threshold for block near-dup (1.0 = exact). */
  blockSimilarityThreshold: number;
  /** Lines shorter than this are not deduped (braces, blank lines). */
  minLineLengthForDedup: number;
}>;

export type CompressionConfig = Readonly<{
  /** Compression mode: "none" | "minify". */
  mode: "none" | "minify";
  /** Strip `// line comments`. */
  stripLineComments: boolean;
  /** Strip `/* block comments *\/` (including JSDoc). */
  stripBlockComments: boolean;
  /** Collapse runs of whitespace. */
  collapseWhitespace: boolean;
  /** Remove blank lines. */
  removeBlankLines: boolean;
}>;

export type BeyondMaxConfig = Readonly<{
  api: LlmApiConfig;
  model: ModelId;
  continuation: ContinuationPolicy;
  chunker: ChunkerConfig;
  outlineExpand: OutlineExpandConfig;
  mapReduce: MapReduceConfig;
  slidingWindow: SlidingWindowConfig;
  parallelChunker: ParallelChunkerConfig;
  dedup: DedupConfig;
  compression: CompressionConfig;
}>;

const DEFAULT_API: LlmApiConfig = Object.freeze({
  baseUrl: "https://api.example.invalid/v1",
  apiKey: "",
  maxOutputTokens: 500,
  temperature: 0,
  requestTimeoutMs: 120_000,
  maxRetries: 3,
  minInterCallMs: 1500,
});

const DEFAULT_CONTINUATION: ContinuationPolicy = Object.freeze({
  maxContinuations: 200,
  trailingContextChars: 800,
  abortOnNoProgress: true,
  repeatAbortWindow: 3,
});

const DEFAULT_CHUNKER: ChunkerConfig = Object.freeze({
  chunkCount: 10,
  summaryChars: 1200,
});

const DEFAULT_OUTLINE_EXPAND: OutlineExpandConfig = Object.freeze({
  maxSections: 20,
  maxTokensPerSection: 800,
});

const DEFAULT_MAP_REDUCE: MapReduceConfig = Object.freeze({
  concurrency: 4,
  llmReduce: false,
});

const DEFAULT_SLIDING_WINDOW: SlidingWindowConfig = Object.freeze({
  overlapTokens: 100,
  windowTokens: 500,
});

const DEFAULT_PARALLEL_CHUNKER: ParallelChunkerConfig = Object.freeze({
  sectionCount: 10,
  maxTokensPerSection: 1000,
  concurrency: 5,
});

const DEFAULT_DEDUP: DedupConfig = Object.freeze({
  mode: "line",
  blockSimilarityThreshold: 0.9,
  minLineLengthForDedup: 8,
});

const DEFAULT_COMPRESSION: CompressionConfig = Object.freeze({
  mode: "minify",
  stripLineComments: true,
  stripBlockComments: true,
  collapseWhitespace: true,
  removeBlankLines: true,
});

const DEFAULT_CONFIG: BeyondMaxConfig = Object.freeze({
  api: DEFAULT_API,
  model: "gemma-4-31b",
  continuation: DEFAULT_CONTINUATION,
  chunker: DEFAULT_CHUNKER,
  outlineExpand: DEFAULT_OUTLINE_EXPAND,
  mapReduce: DEFAULT_MAP_REDUCE,
  slidingWindow: DEFAULT_SLIDING_WINDOW,
  parallelChunker: DEFAULT_PARALLEL_CHUNKER,
  dedup: DEFAULT_DEDUP,
  compression: DEFAULT_COMPRESSION,
});

export function defaultConfig(): BeyondMaxConfig {
  return DEFAULT_CONFIG;
}

/**
 * Apply a partial override on top of the default config. Only the supplied
 * fields are replaced; nested objects are merged one level deep.
 */
export function withOverrides(
  base: BeyondMaxConfig,
  overrides: Partial<{
    api: Partial<LlmApiConfig>;
    model: ModelId;
    continuation: Partial<ContinuationPolicy>;
    chunker: Partial<ChunkerConfig>;
    outlineExpand: Partial<OutlineExpandConfig>;
    mapReduce: Partial<MapReduceConfig>;
    slidingWindow: Partial<SlidingWindowConfig>;
    parallelChunker: Partial<ParallelChunkerConfig>;
    dedup: Partial<DedupConfig>;
    compression: Partial<CompressionConfig>;
  }>,
): BeyondMaxConfig {
  return Object.freeze({
    api: Object.freeze({ ...base.api, ...(overrides.api ?? {}) }),
    model: overrides.model ?? base.model,
    continuation: Object.freeze({ ...base.continuation, ...(overrides.continuation ?? {}) }),
    chunker: Object.freeze({ ...base.chunker, ...(overrides.chunker ?? {}) }),
    outlineExpand: Object.freeze({ ...base.outlineExpand, ...(overrides.outlineExpand ?? {}) }),
    mapReduce: Object.freeze({ ...base.mapReduce, ...(overrides.mapReduce ?? {}) }),
    slidingWindow: Object.freeze({ ...base.slidingWindow, ...(overrides.slidingWindow ?? {}) }),
    parallelChunker: Object.freeze({ ...base.parallelChunker, ...(overrides.parallelChunker ?? {}) }),
    dedup: Object.freeze({ ...base.dedup, ...(overrides.dedup ?? {}) }),
    compression: Object.freeze({ ...base.compression, ...(overrides.compression ?? {}) }),
  });
}

/**
 * Validate a config and return a typed error if a value is out of range.
 * Returns `null` when the config is valid.
 */
export function validateConfig(c: BeyondMaxConfig): string | null {
  if (c.api.maxOutputTokens < 50) return "api.maxOutputTokens must be >= 50";
  if (c.api.maxOutputTokens > 32_000) return "api.maxOutputTokens must be <= 32000";
  if (c.api.requestTimeoutMs < 1000) return "api.requestTimeoutMs must be >= 1000";
  if (c.api.maxRetries < 0 || c.api.maxRetries > 20) return "api.maxRetries must be in [0,20]";
  if (c.api.minInterCallMs < 0) return "api.minInterCallMs must be >= 0";
  if (c.api.minInterCallMs > 60_000) return "api.minInterCallMs must be <= 60000";
  if (c.continuation.maxContinuations < 1) return "continuation.maxContinuations must be >= 1";
  if (c.continuation.trailingContextChars < 50) return "continuation.trailingContextChars must be >= 50";
  if (c.continuation.repeatAbortWindow < 1) return "continuation.repeatAbortWindow must be >= 1";
  if (c.chunker.chunkCount < 1) return "chunker.chunkCount must be >= 1";
  if (c.chunker.summaryChars < 0) return "chunker.summaryChars must be >= 0";
  if (c.outlineExpand.maxSections < 1) return "outlineExpand.maxSections must be >= 1";
  if (c.outlineExpand.maxTokensPerSection < 50) return "outlineExpand.maxTokensPerSection must be >= 50";
  if (c.mapReduce.concurrency < 1) return "mapReduce.concurrency must be >= 1";
  if (c.slidingWindow.overlapTokens < 0) return "slidingWindow.overlapTokens must be >= 0";
  if (c.slidingWindow.windowTokens < 50) return "slidingWindow.windowTokens must be >= 50";
  if (c.slidingWindow.overlapTokens >= c.slidingWindow.windowTokens) {
    return "slidingWindow.overlapTokens must be < windowTokens";
  }
  if (c.parallelChunker.sectionCount < 1) return "parallelChunker.sectionCount must be >= 1";
  if (c.parallelChunker.maxTokensPerSection < 50) return "parallelChunker.maxTokensPerSection must be >= 50";
  if (c.parallelChunker.concurrency < 1) return "parallelChunker.concurrency must be >= 1";
  if (c.parallelChunker.concurrency > 32) return "parallelChunker.concurrency must be <= 32";
  if (c.dedup.blockSimilarityThreshold < 0.5 || c.dedup.blockSimilarityThreshold > 1) {
    return "dedup.blockSimilarityThreshold must be in [0.5, 1]";
  }
  if (c.dedup.minLineLengthForDedup < 0) return "dedup.minLineLengthForDedup must be >= 0";
  if (c.compression.mode !== "none" && c.compression.mode !== "minify") return "compression.mode must be 'none' or 'minify'";
  return null;
}
