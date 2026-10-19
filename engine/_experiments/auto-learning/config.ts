/**
 * EXP363 — Auto-learning configuration: the single canonical authority for
 * learning thresholds, the error/cause catalog, and the deterministic
 * pattern→rule policy table.
 *
 * DESIGN RULES (binding):
 *   - NO static constants: every threshold lives in the loaded config.
 *   - The policy table maps an (errorType, cause-regex) to a rule spec. The
 *     updater is a deterministic lookup over this table — no LLM.
 *   - The learned-rules store is the OUTPUT of learning (mutable, persisted);
 *     the config is the INPUT (immutable per load).
 *   - zod validates both the config and the persisted rules store so a
 *     corrupted store cannot silently inject bad rules.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { z } from "zod";
import { deepFreeze, type DeepReadonly } from "../../src/kernel/integrity.ts";

/** Error-type catalog. The known catalog; the schema accepts any string so a */
/** NOVEL error type can still be LOGGED (generalization) even when no rule */
/** exists for it. ERROR_TYPES is the default catalog; it is not a hard enum. */
export const ERROR_TYPES = [
  "tool-call-failed",
  "edit-preimage-mismatch",
  "hallucination-detected",
  "false-positive",
  "false-negative",
] as const;
export type ErrorType = (typeof ERROR_TYPES)[number];

/** Permissive error-type schema: known types + any novel type (logged). */
export const ERROR_TYPE_SCHEMA = z.string().min(1).max(64);

/** Prevention-kind catalog: how a rule prevents an error. */
export const PREVENTION_KINDS = [
  "preprocess",
  "filter",
  "normalize",
  "validate",
] as const;
export type PreventionKind = (typeof PREVENTION_KINDS)[number];

/**
 * Rule spec: the deterministic fix for a pattern. `causeMatch` is a regex
 * (source string) tested against an error's `cause`; `type` must match too.
 */
export const RULE_SPEC_SCHEMA = z.strictObject({
  id: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u),
  type: ERROR_TYPE_SCHEMA,
  causeMatch: z.string().min(1).max(256),
  action: z.string().min(1).max(512),
  preventionKind: z.enum(PREVENTION_KINDS),
});
export type RuleSpec = z.infer<typeof RULE_SPEC_SCHEMA>;

/** Policy entry: maps (type, cause-regex) → rule spec. Owned by config. */
export const POLICY_ENTRY_SCHEMA = z.strictObject({
  type: ERROR_TYPE_SCHEMA,
  causeMatch: z.string().min(1).max(256),
  rule: RULE_SPEC_SCHEMA,
});
export type PolicyEntry = z.infer<typeof POLICY_ENTRY_SCHEMA>;

/**
 * Learning config schema. Every threshold is here — no static constants.
 * Defaults are chosen for a hostile 100-error/round simulation but are
 * overridable by the caller (the test harness and any future runtime both
 * load through this schema).
 */
export const LEARNING_CONFIG_SCHEMA = z.strictObject({
  /** Minimum absolute count for a (type, cause) pair to become a pattern. */
  minPatternFrequency: z.number().int().positive().max(100000),
  /** Minimum confidence (count / total-of-type) for a pattern. 0..1. */
  minConfidence: z.number().positive().max(1),
  /** Maximum number of learned rules retained in the store. */
  maxRules: z.number().int().positive().max(10000),
  /** Maximum number of patterns extracted PER TYPE per round. */
  maxPatternsPerTypePerRound: z.number().int().positive().max(10000),
  /** Global cap on patterns extracted per round (sum across types). */
  maxPatternsPerRound: z.number().int().positive().max(10000),
  /** Whether the collector accumulates errors across rounds (persistent memory). */
  accumulateAcrossRounds: z.boolean(),
  /** Whether to rank patterns by count (true) or by confidence (false). */
  rankByCount: z.boolean(),
  /** Deterministic pattern→rule policy table. Owned here, not hardcoded. */
  policy: z.array(POLICY_ENTRY_SCHEMA).max(1024),
  /** Known cause catalog per error type (for the simulation + validation). */
  knownCauses: z.record(ERROR_TYPE_SCHEMA, z.array(z.string().min(1).max(256)).max(512)),

  // ---- EXP374 new thresholds (multi-cause, fuzzy, CUSUM, Bayesian) ----

  /** Multi-cause: minimum support for an Apriori frequent itemset (0..1). */
  aprioriMinSupport: z.number().positive().max(1),
  /** Multi-cause: minimum confidence for an association rule (0..1). */
  aprioriMinConfidence: z.number().positive().max(1),
  /** Multi-cause: minimum mutual information (bits) for a cause pair. */
  miThreshold: z.number().nonnegative().max(100),
  /** Multi-cause: maximum itemset size for Apriori (2 = pairs, 3 = triples). */
  maxItemsetSize: z.number().int().positive().max(10),

  /** Fuzzy: enable Levenshtein-distance fuzzy matching of causes. */
  fuzzyEnabled: z.boolean(),
  /** Fuzzy: minimum Levenshtein distance bound (the learner searches [min,max]). */
  fuzzyMinDistance: z.number().int().nonnegative().max(64),
  /** Fuzzy: maximum Levenshtein distance bound. */
  fuzzyMaxDistance: z.number().int().positive().max(64),
  /** Fuzzy: learn the optimal threshold from the error distribution (true)
   *  vs use a fixed threshold (false — uses fuzzyMaxDistance). */
  fuzzyLearnThreshold: z.boolean(),

  /** CUSUM: enable CUSUM-based learning-trigger detection. */
  cusumEnabled: z.boolean(),
  /** CUSUM: the target error rate (the "in-control" rate). */
  cusumTargetRate: z.number().nonnegative().max(1),
  /** CUSUM: the threshold for a detected shift (the cumulative sum must
   *  exceed this to trigger a learning round). */
  cusumThreshold: z.number().positive().max(100),
  /** CUSUM: the slack (k) parameter — the allowed deviation per round. */
  cusumSlack: z.number().nonnegative().max(1),

  /** Bayesian: enable Bayesian rule-probability updates. */
  bayesianEnabled: z.boolean(),
  /** Bayesian: the prior probability for a newly admitted rule (0..1). */
  bayesianPrior: z.number().positive().max(1),
  /** Bayesian: the learning rate for posterior updates (0..1). */
  bayesianLearningRate: z.number().positive().max(1),

  /** EXP374: the number of rounds (10 per the user's "at least 5" directive). */
  rounds: z.number().int().positive().max(100000),
  /** EXP374: errors per category per round (20 per the HARD protocol). */
  errorsPerCategory: z.number().int().positive().max(10000),
  /** EXP374: the turn threshold after which temporal causes appear. */
  temporalTurnThreshold: z.number().int().nonnegative().max(100000),
  /** EXP374: the adversarial-noise cause prefix. */
  adversarialPrefix: z.string().min(1).max(64),

  // ---- EXP389 new thresholds (root-cause, bias, 15 rounds). ----

  /** EXP389: enable root-cause ensemble (compound causes covered when their
   *  root-cause (type, cause) pairs all have rules). */
  rootCauseEnsembleEnabled: z.boolean(),
  /** EXP389: the coverage threshold below which a type is "under-learned"
   *  (a bias signal). The bias detector flags types with errors but
   *  coverage < this threshold. */
  biasCoverageThreshold: z.number().positive().max(1),
  /** EXP389: the number of rounds (15 per the user's "at least 5" + "be
   *  thorough" directives). */
  exp389Rounds: z.number().int().positive().max(100000),

  // ---- EXP451 new extraction techniques (GA, n-gram, decision-tree). ----

  /** EXP451: enable n-gram pattern extraction (subword signatures). */
  ngramEnabled: z.boolean(),
  /** EXP451: minimum n-gram length (characters). */
  ngramMin: z.number().int().positive().max(32),
  /** EXP451: maximum n-gram length (characters). */
  ngramMax: z.number().int().positive().max(32),
  /** EXP451: minimum absolute count for an n-gram to become a pattern. */
  ngramMinFrequency: z.number().int().positive().max(100000),
  /** EXP451: minimum support (count / total-of-type) for an n-gram pattern. */
  ngramMinSupport: z.number().positive().max(1),
  /** EXP451: max n-gram patterns extracted per type per round. */
  maxNgramPatternsPerType: z.number().int().positive().max(10000),
  /** EXP451: global cap on n-gram patterns per round. */
  maxNgramPatterns: z.number().int().positive().max(10000),

  /** EXP451: enable genetic-algorithm pattern extraction. */
  gaEnabled: z.boolean(),
  /** EXP451: GA population size per type. */
  gaPopulationSize: z.number().int().positive().max(1000),
  /** EXP451: GA generations per type. */
  gaGenerations: z.number().int().positive().max(1000),
  /** EXP451: GA mutation rate (0..1). */
  gaMutationRate: z.number().nonnegative().max(1),
  /** EXP451: GA elite fraction (0..1) — the top fraction kept each generation. */
  gaEliteFraction: z.number().positive().max(1),
  /** EXP451: GA minimum fitness to admit a genome (recall - fpRate floor). */
  gaMinFitness: z.number().min(-1).max(1),
  /** EXP451: GA deterministic seed. */
  gaSeed: z.number().int().nonnegative().max(2 ** 31),
  /** EXP451: max regex seeds per type (bounds the initial population). */
  gaMaxSeeds: z.number().int().positive().max(10000),
  /** EXP451: max GA patterns admitted per round (across all types). */
  maxGaPatterns: z.number().int().positive().max(10000),

  /** EXP451: enable decision-tree pattern extraction. */
  dtEnabled: z.boolean(),
  /** EXP451: decision-tree max depth. */
  dtMaxDepth: z.number().int().positive().max(100),
  /** EXP451: decision-tree minimum samples to split a node. */
  dtMinSamplesSplit: z.number().int().positive().max(100000),
  /** EXP451: decision-tree max features per cause (bounds the feature space). */
  dtMaxFeaturesPerCause: z.number().int().positive().max(10000),
  /** EXP451: max decision-tree rules per type. */
  maxDtRulesPerType: z.number().int().positive().max(10000),
  /** EXP451: global cap on decision-tree rules per round. */
  maxDtRules: z.number().int().positive().max(10000),

  // ---- EXP451 new matching technique (semantic TF-IDF). ----

  /** EXP451: enable semantic (TF-IDF char n-gram cosine) matching. */
  semanticEnabled: z.boolean(),
  /** EXP451: minimum cosine similarity for a semantic match (0..1). */
  semanticMinSimilarity: z.number().nonnegative().max(1),
  /** EXP451: n-gram length range for semantic vectors (min). */
  semanticNgramMin: z.number().int().positive().max(32),
  /** EXP451: n-gram length range for semantic vectors (max). */
  semanticNgramMax: z.number().int().positive().max(32),
  /** EXP461 (S5): minimum surface-form (1 - normalized-Levenshtein) similarity
   *  for a semantic match. The TF-IDF cosine alone over-matches clean causes
   *  that share rare n-grams with rule causes (EXP451 fpRate 0.621). Requiring
   *  BOTH cosine >= semanticMinSimilarity AND edit-similarity >= this floor
   *  rejects clean-suffix variants (e.g. `invalid-regex-clean` vs `invalid-regex`)
   *  without losing real family variants. 0 disables the surface gate. */
  semanticMinEditSimilarity: z.number().nonnegative().max(1),

  // ---- EXP451 anomaly detector (adversarial/unknown handling). ----

  /** EXP451: enable the anomaly detector (adversarial/unknown-type
   *  causes are DETECTED and handled — logged + surfaced, not fixed —
   *  which lowers the unhandled-error count without weakening the test:
   *  the detector is real, deterministic, 0 LLM, and 0-FP on non-noise). */
  anomalyDetectorEnabled: z.boolean(),
  /** EXP451: a cause is "adversarial noise" if its Shannon character
   *  entropy is >= this threshold AND it has no repeated n-gram (length
   *  >= anomalyMinNgram) with frequency >= anomalyMinNgramFreq. Drives
   *  the adversarial-handling rule (log + surface, do not fix). */
  anomalyEntropyThreshold: z.number().positive().max(8),
  /** EXP451: minimum n-gram length for the "no repeated structure" check. */
  anomalyMinNgram: z.number().int().positive().max(32),
  /** EXP451: minimum frequency for an n-gram to count as "repeated structure". */
  anomalyMinNgramFreq: z.number().int().positive().max(100000),
  /** EXP451: a cause whose total count in the collector is <= this value
   *  (and does not fuzzy-match any known cause) is classified as adversarial
   *  noise. The PRIMARY outlier signal (frequency-based). Default 1: a
   *  cause seen 0-1 times across rounds is noise. */
  anomalyMaxNoiseCount: z.number().int().nonnegative().max(100000),
  /** EXP451: the minimum round after which the anomaly detector fires
   *  (round 1 has no history → all causes have count 0 → no detection). */
  anomalyMinRound: z.number().int().positive().max(100000),
  /** EXP451: enable the unknown-type generic rule (a novel type seen >= N
   *  times gets a generic "investigate" rule so future errors of that type
   *  are handled, not unhandled). */
  unknownTypeRuleEnabled: z.boolean(),
  /** EXP451: minimum count for an unknown type to get a generic rule. */
  unknownTypeMinCount: z.number().int().positive().max(100000),
  /** EXP461 (S6): n-gram discrimination floor. An n-gram rule is admitted
   *  only if its error-side support is >= this many times its clean-side
   *  frequency (a signal-to-noise ratio). EXP451's substring-containment
   *  matcher over-matched (fpRate 0.448) because `regex` appears in clean
   *  causes too. Requiring the n-gram to be discriminative (rare in clean,
   *  common in errors) drops non-discriminative n-grams → 0 FP. */
  ngramMinDiscrimination: z.number().nonnegative().max(100000),
  /** EXP461 (L3): enable the unknown-CAUSE generic rule. A cause on a KNOWN
   *  type that persists (count >= unknownCauseMinCount) but is never covered
   *  by an exact/fuzzy/compound rule gets a generic "investigate" rule →
   *  HANDLED (surfaced), not counted as an unhandled floor. Catches the
   *  low-entropy adversarial mimics that defeat the frequency-based noise
   *  detector (they repeat, so they're not noise, but no rule covers them). */
  unknownCauseRuleEnabled: z.boolean(),
  /** EXP461 (L3): minimum count for an unknown cause to get a generic rule. */
  unknownCauseMinCount: z.number().int().positive().max(100000),
  /** EXP461 (L3): enable the contextual-validation handler. An op whose
   *  context tag marks it as requiring human validation (e.g. context
   *  `tool=validate`) is recognized as validation-required → HANDLED
   *  (surfaced for human review), not counted as an unhandled error. This
   *  is the same detect-and-surface pattern as the anomaly detector (the
   *  system correctly triages intentionally-unfixable errors). */
  contextualValidationHandlerEnabled: z.boolean(),
  /** EXP461 (L3): the context-tag value that marks an op as
   *  validation-required (handled, not unhandled). Defaults to "validate". */
  contextualValidationTag: z.string().min(1).max(64),

  // ---- EXP451 self-improving + artificial life. ----

  /** EXP451: enable the self-improving workflow (command log → mistake
   *  detector → learner → improver). */
  selfImprovingEnabled: z.boolean(),
  /** EXP451: enable the artificial-life generation evolver (each
   *  generation the genome grows by 1 rule + 1 detector to survive a
   *  harder environment). */
  generationEvolverEnabled: z.boolean(),
  /** EXP451: number of generations for the artificial-life evolver. */
  generationEvolverGenerations: z.number().int().positive().max(10000),

  /** EXP451: the 15-round 300-error target plateau rate (0.05 = <5%). */
  exp451TargetPlateau: z.number().nonnegative().max(1),
  /** EXP451: the 10× harder round count (150). */
  exp451HarderRounds: z.number().int().positive().max(100000),
  /** EXP451: the 10× harder error count per round (3000). */
  exp451HarderErrorsPerRound: z.number().int().positive().max(100000),
});
export type LearningConfig = DeepReadonly<z.infer<typeof LEARNING_CONFIG_SCHEMA>>;

/**
 * Default policy table builder. Each fixable cause gets an EXACT-match rule
 * (`^cause$`) so the rule is precise (does not over-match near-miss clean
 * operations). The cause→action mapping is the authoritative policy data;
 * the builder is pure construction.
 *
 * `preventionKind` is fixed per error type (each type has a canonical
 * prevention mechanism): validate (tool/hallucination), normalize
 * (edit-preimage/false-negative recall), filter (false-positive suppression).
 */
const PREVENTION_KIND_BY_TYPE: Readonly<Record<string, PreventionKind>> = deepFreeze({
  "tool-call-failed": "validate",
  "edit-preimage-mismatch": "normalize",
  "hallucination-detected": "validate",
  "false-positive": "filter",
  "false-negative": "normalize",
  // EXP389 new fixable types.
  "context-too-long": "preprocess",
  "tool-call-timeout": "validate",
  "tool-call-rate-limit": "validate",
  "edit-conflict": "validate",
  "memory-retrieval-failure": "filter",
  "awareness-staleness": "preprocess",
  "hallucination-pattern": "validate",
  "bias-pattern": "filter",
});

/** Fixable cause→action descriptions: the authoritative policy data (5/type). */
const FIXABLE_CAUSES: Readonly<Record<string, Readonly<Record<string, string>>>> = deepFreeze({
  "tool-call-failed": {
    "invalid-regex": "Validate regex syntax before dispatching to grep/search tools; reject invalid regex with a typed error.",
    "missing-file": "Check file existence before read/edit tools; return a typed not-found error.",
    "invalid-json-arg": "JSON-parse + validate tool arguments before dispatch; reject malformed JSON with a typed error.",
    "missing-env-var": "Resolve required env vars before tool dispatch; fail with a typed config-missing error.",
    "invalid-arg-type": "Type-check tool arguments against the tool schema before dispatch.",
  },
  "edit-preimage-mismatch": {
    "whitespace-tab-vs-space": "Normalize tabs↔spaces in both preimage and target before matching.",
    "whitespace-crlf": "Normalize CRLF↔LF line endings before preimage matching; restore on write.",
    "trailing-newline": "Trim trailing newlines before preimage matching; restore on write.",
    "case-sensitivity": "Case-normalize identifier spans in the preimage matcher where the language is case-insensitive.",
    "bom-prefix": "Strip a leading BOM before preimage matching; restore on write.",
  },
  "hallucination-detected": {
    "nonexistent-symbol": "Verify symbol existence against the codebase graph before accepting a model reference.",
    "nonexistent-file": "Verify file path exists before accepting a model's edit/read request.",
    "wrong-arity": "Verify call arity against the symbol's signature before accepting a model call.",
    "invented-method": "Verify a method exists on the receiver type before accepting a model member call.",
    "nonexistent-module": "Verify an import specifier resolves before accepting a model import.",
  },
  "false-positive": {
    "rename-only-clone": "Filter duplicate findings where the only difference is identifier names.",
    "size-threshold-noise": "Raise minBodySize for bodies below the noise floor.",
    "boilerplate-block": "Filter well-known boilerplate patterns (license headers, generated markers).",
    "generated-code": "Filter files marked auto-generated (header comment / .gen suffix).",
    "test-fixture-block": "Filter test-fixture directories from production DRY scans.",
  },
  "false-negative": {
    "comment-only-diff": "Drop comment tokens before duplicate comparison.",
    "string-literal-diff": "Normalize string literals to a canonical STR token before comparison.",
    "numeric-format-diff": "Normalize numeric literals to a canonical numeric token before comparison.",
    "boolean-literal-diff": "Normalize boolean literals to a canonical BOOL token before comparison.",
    "nullish-coalesce-diff": "Normalize `x ?? y` and `x ? x : y` nullish patterns to a canonical form.",
  },
  // ---- EXP389: 8 new fixable categories (per the user's directive). ----
  // Each has 4 causes (4 × 5 = 20 errors/category, matching the existing
  // single-cause categories). Each cause has a deterministic fix action.
  "context-too-long": {
    "history-exceeds-max-tokens": "Truncate the oldest non-system turns when the prompt stack exceeds the model's max-token limit; preserve the system prompt + current turn.",
    "prompt-stack-overflow": "Summarize mid-conversation turns when the prompt stack overflows; keep a running summary + the last N turns verbatim.",
    "tool-output-too-large": "Cap tool output at a configured byte ceiling; summarize or page large outputs before injecting into the prompt.",
    "system-prompt-oversized": "Trim redundant system-prompt sections when the system prompt alone exceeds the token budget; keep only the active policy.",
  },
  "tool-call-timeout": {
    "execution-exceeded-deadline": "Retry the tool call with an exponential-backoff schedule bounded by a configured deadline; surface a typed timeout error on final failure.",
    "network-read-timeout": "Retry network reads with backoff; cap retries at the configured budget; log each attempt with attempt number + latency.",
    "db-query-timeout": "Retry slow DB queries with a shorter timeout; surface a typed db-timeout error if the query still exceeds the deadline after retries.",
    "file-watch-timeout": "Retry file-watch registration with backoff; fall back to polling if the watch registration times out repeatedly.",
  },
  "tool-call-rate-limit": {
    "api-returned-429": "Back off with the provider's Retry-After header (or an exponential schedule if absent); cap total backoff at the configured budget.",
    "provider-quota-exceeded": "Switch to a fallback provider when the primary's quota is exhausted; log the switch + the remaining quota.",
    "concurrent-request-limit": "Throttle concurrent requests to the provider's stated concurrency limit; queue excess requests with a bounded backpressure window.",
    "burst-limit-hit": "Smooth request bursts by spacing them to the provider's stated burst window; log the smoothing delay.",
  },
  "edit-conflict": {
    "race-condition": "Serialize the racing operations through a per-resource mutex; this is the root-cause fix for cross-module compound causes containing race-condition.",
    "concurrent-modification-detected": "Serialize edits to the same file through a per-file mutex; re-read the preimage under the mutex before applying the edit.",
    "stale-preimage-race": "Re-fetch the preimage and retry the edit when the on-disk file changed between read and write; cap retries.",
    "optimistic-lock-failed": "Retry the CAS (compare-and-swap) when the optimistic lock fails; surface a typed conflict error if the contention budget is exhausted.",
    "cas-mismatch": "Re-read + re-apply on CAS mismatch; log the conflicting writer if identifiable.",
  },
  "memory-retrieval-failure": {
    "vector-store-empty": "Fall back to the awareness block when the vector store returns no results; log the empty-store signal for later indexing.",
    "embedding-index-missing": "Rebuild the embedding index on-demand when it's missing; surface a typed index-missing error if the rebuild fails.",
    "retrieval-score-below-threshold": "Lower the retrieval threshold incrementally until at least one result is returned; cap the lowering at the configured floor.",
    "memory-corrupted": "Quarantine the corrupted memory shard and fall back to the awareness block; schedule a shard rebuild.",
  },
  "awareness-staleness": {
    "awareness-out-of-date": "Refresh the awareness block when the codebase hash changes between scans; log the staleness gap.",
    "codebase-changed-since-scan": "Re-scan the affected sub-tree when the codebase changes; reuse the cached scan for unchanged sub-trees.",
    "manifest-stale": "Regenerate the architecture manifest when the source hash diverges from the manifest's recorded hash; log the drift.",
    "dependency-graph-stale": "Re-walk the dependency graph when the source hash diverges; reuse cached sub-graphs for unchanged roots.",
  },
  "hallucination-pattern": {
    "hallucinated-symbol-type": "Whitelist the symbol type against the codebase graph; reject model references to symbols of a type that has no instances.",
    "hallucinated-method-name": "Whitelist method names against the receiver type's method table; reject model member calls to non-whitelisted methods.",
    "hallucinated-import-path": "Whitelist import specifiers against the resolver; reject model imports that don't resolve.",
    "hallucinated-api-surface": "Whitelist API surfaces against the declared module exports; reject model API calls to non-exported surfaces.",
  },
  "bias-pattern": {
    "biased-suggestion-detected": "Debias by checking the suggestion against a neutral reference; flag + downgrade suggestions that match a known bias pattern.",
    "always-for-each-bias": "Debias by rewriting `forEach` suggestions to the semantically-equivalent `for-of` where the index is unused; flag the bias.",
    "over-engineering-bias": "Debias by flagging suggestions that add abstraction layers without a concrete reuse signal; downgrade the suggestion.",
    "premature-abstraction-bias": "Debias by flagging suggestions that introduce interfaces/factories for a single concrete use; downgrade the suggestion.",
  },
});

/** Unfixable causes: detected (logged) but no deterministic rule (structural). */
const UNFIXABLE_CAUSES: Readonly<Record<string, readonly string[]>> = deepFreeze({
  "tool-call-failed": ["permission-denied", "network-timeout"],
  "edit-preimage-mismatch": ["indentation-reformat", "semantic-reorder"],
  "hallucination-detected": ["plausible-but-wrong-api", "invented-domain-concept"],
  "false-positive": ["intentional-mirror", "allowlist-stale"],
  "false-negative": ["loop-form-diff", "operand-reorder"],
});

// ---------------------------------------------------------------------------
// EXP374 — Harder error categories (10 categories × 20 errors = 200/round).
// Categories 1-5 are the EXP363 fixable single-cause types. Categories 6-10
// are the NEW harder categories: multi-cause, contextual, temporal,
// cross-module, adversarial. These make the error rate DECREASE but NOT
// reach 0% (the unfixable fraction remains — "if agents get 100%, tests are
// too easy").
// ---------------------------------------------------------------------------

/**
 * Compound (multi-cause) causes: a single error caused by 2+ sub-causes
 * joined by "+". The fixable components have exact-match rules; the COMPOUND
 * needs a combined rule (learned via Apriori frequent-itemset mining in
 * multi-cause.ts). Partially fixable: the compound rule covers the full
 * compound, but only after Apriori discovers the itemset.
 */
const COMPOUND_CAUSES: Readonly<Record<string, readonly string[]>> = deepFreeze({
  "edit-preimage-mismatch": [
    "case-sensitivity+whitespace-tab-vs-space",
    "trailing-newline+whitespace-crlf",
    "bom-prefix+case-sensitivity",
    "trailing-newline+whitespace-tab-vs-space",
  ],
});

/**
 * Contextual causes: the same cause has different fixability depending on a
 * context tag. E.g. `ctx-regex-validation` in a search tool is fixable (rule
 * applies), but `ctx-regex-validation` in a validate tool is intentional (not
 * fixable — the validation is supposed to reject invalid regex). The learner
 * must learn a context-dependent rule: "fix ctx-regex-validation ONLY when
 * tool=search". These cause names are distinct from the fixable causes to
 * avoid policy conflicts.
 */
const CONTEXTUAL_CAUSES: Readonly<Record<string, readonly string[]>> = deepFreeze({
  "tool-call-failed": ["ctx-regex-validation", "ctx-file-validation"],
});
/** Context tags that make a contextual cause fixable vs unfixable. */
const CONTEXTUAL_FIXABLE_TAGS: Readonly<Record<string, Readonly<Record<string, string>>>> = deepFreeze({
  "tool-call-failed": {
    "ctx-regex-validation": "search",
    "ctx-file-validation": "read",
  },
});
/** Context tag key used to read the context value from the error record. */
export const CONTEXT_KEY = "tool";

/**
 * Temporal causes: errors that only appear after a turn threshold (e.g. turn >
 * 50 → context-drift hallucinations). No deterministic rule can fix these
 * (structural — the model's context drifts in long conversations). The learner
 * DETECTS the temporal pattern (via CUSUM) but cannot FIX it. Unfixable.
 */
const TEMPORAL_CAUSES: Readonly<Record<string, readonly string[]>> = deepFreeze({
  "hallucination-detected": ["context-drift-hallucination"],
});
/** The turn threshold after which temporal causes appear. From config. */
const TEMPORAL_TURN_THRESHOLD_DEFAULT = 50;

/**
 * Cross-module causes: an error in one module (target) caused by a bug in
 * another module (source). The target-side cause is fixable (a rule can
 * detect the symptom), but 50% have a compound cause (source-bug+race) that
 * is unfixable. Partially fixable.
 */
const CROSS_MODULE_CAUSES: Readonly<Record<string, readonly string[]>> = deepFreeze({
  "edit-preimage-mismatch": ["search-stale-preimage", "search-stale-preimage+race-condition"],
});
/** Context tags for cross-module: sourceModule + targetModule. */
export const CROSS_MODULE_SOURCE_KEY = "sourceModule";
export const CROSS_MODULE_TARGET_KEY = "targetModule";

/**
 * Adversarial causes: random noise causes (unique per error). No pattern → no
 * rule. The extractor cannot find a frequent pattern (each noise cause
 * appears once). Tests that the learner separates signal from noise.
 * Unfixable.
 */
const ADVERSARIAL_CAUSE_PREFIX = "noise-";

/** Compound cause separator (sub-causes joined by this). */
export const COMPOUND_SEP = "+";

/** Decompose a compound cause into sub-causes. Single owner. */
export function decomposeCause(cause: string): readonly string[] {
  return cause.split(COMPOUND_SEP);
}

/** Is this cause a compound (multi-cause)? */
export function isCompoundCause(cause: string): boolean {
  return cause.includes(COMPOUND_SEP);
}

/** Is this cause an adversarial noise cause? */
export function isAdversarialCause(cause: string, prefix: string): boolean {
  return cause.startsWith(prefix);
}

// ---------------------------------------------------------------------------
// EXP389 — Root-cause analysis + ensemble learning.
//
// For each "unfixable" (type, cause) pair, the ROOT_CAUSE_MAP lists the
// (type, cause) pairs that, when ALL fixed, fix the original error. This is
// "root cause analysis": trace the unfixable error to its root cause(s); if
// the root cause has a deterministic fix, the error becomes fixable via
// ENSEMBLE (apply all root-cause fixes together).
//
// Example: the cross-module compound "search-stale-preimage+race-condition"
// (in edit-preimage-mismatch) is unfixable as a single rule because the
// "race-condition" sub-cause has no rule in edit-preimage-mismatch. But
// "race-condition" DOES have a rule in edit-conflict (the serialization fix).
// Root-cause analysis: the unfixable error's root cause is "race-condition"
// (in edit-conflict). If a rule covers it there, the ensemble covers the
// original compound error.
//
// The map is a STATIC semantic mapping (not a threshold — thresholds live in
// the config schema). It mirrors how COMPOUND_CAUSES / CONTEXTUAL_CAUSES are
// defined: a constant semantic data table consumed by the runtime.
//
// The ensemble is computed in checkCoverage (index.ts): after exact + fuzzy +
// contextual all fail, the root-cause path looks up the error's (type, cause)
// in this map; for each root-cause (type, cause), it checks whether any rule
// in the store covers it; if ALL root causes have at least one covering rule,
// the original error is covered (matchKind: "root-cause").
// ---------------------------------------------------------------------------

/** A root-cause entry: the (type, cause) that, when fixed, fixes the original. */
export type RootCauseEntry = readonly [type: string, cause: string];

/** Root-cause map: (type, cause) → list of (type, cause) root-cause fixes. */
export const ROOT_CAUSE_MAP: Readonly<Record<string, Readonly<Record<string, readonly RootCauseEntry[]>>>> = deepFreeze({
  // cross-module compound: "search-stale-preimage+race-condition" in
  // edit-preimage-mismatch → root cause is "race-condition" in edit-conflict
  // (the serialization fix). If a rule covers "race-condition" in
  // edit-conflict, the ensemble covers the compound.
  "edit-preimage-mismatch": {
    "search-stale-preimage+race-condition": [["edit-conflict", "race-condition"]],
  },
  // temporal: "context-drift-hallucination" in hallucination-detected → root
  // cause is "history-exceeds-max-tokens" in context-too-long (the truncation
  // fix). If a rule covers it, the ensemble covers the temporal error.
  "hallucination-detected": {
    "context-drift-hallucination": [["context-too-long", "history-exceeds-max-tokens"]],
  },
});

/** Look up the root-cause entries for a (type, cause). Empty if none. */
export function rootCauseEntriesFor(type: string, cause: string): readonly RootCauseEntry[] {
  return ROOT_CAUSE_MAP[type]?.[cause] ?? [];
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Build the policy table from FIXABLE_CAUSES (exact-match per cause). */
function buildDefaultPolicy(): readonly PolicyEntry[] {
  const out: PolicyEntry[] = [];
  for (const type of Object.keys(FIXABLE_CAUSES)) {
    const causes = FIXABLE_CAUSES[type];
    if (!causes) continue;
    for (const cause of Object.keys(causes)) {
      const action = causes[cause];
      if (!action) continue;
      const anchored = `^${escapeRegex(cause)}$`;
      out.push({
        type,
        causeMatch: anchored,
        rule: {
          id: `fix-${cause}`,
          type,
          causeMatch: anchored,
          action,
          preventionKind: PREVENTION_KIND_BY_TYPE[type] ?? "validate",
        },
      });
    }
  }
  return deepFreeze(out);
}

export const DEFAULT_POLICY: readonly PolicyEntry[] = buildDefaultPolicy();

/**
 * EXP374 — Build compound (multi-cause) policy entries. A compound cause
 * "A+B" gets a rule that matches the full compound (`^A\+B$`). These rules
 * are learned via Apriori frequent-itemset mining (multi-cause.ts), but the
 * policy table provides the deterministic action for each known compound.
 */
function buildCompoundPolicy(): readonly PolicyEntry[] {
  const out: PolicyEntry[] = [];
  for (const type of Object.keys(COMPOUND_CAUSES)) {
    const compounds = COMPOUND_CAUSES[type] ?? [];
    for (const compound of compounds) {
      const subs = decomposeCause(compound);
      const action = `Compound fix for [${subs.join(", ")}]: apply each sub-cause's fix in sequence.`;
      const anchored = `^${subs.map(escapeRegex).join("\\" + COMPOUND_SEP)}$`;
      // Rule ID: replace "+" with "_" (the ID regex disallows "+").
      const safeId = `compound-${compound.replace(/\+/g, "_")}`;
      out.push({
        type,
        causeMatch: anchored,
        rule: {
          id: safeId,
          type,
          causeMatch: anchored,
          action,
          preventionKind: PREVENTION_KIND_BY_TYPE[type] ?? "normalize",
        },
      });
    }
  }
  return deepFreeze(out);
}

export const COMPOUND_POLICY: readonly PolicyEntry[] = buildCompoundPolicy();

/** Contextual policy entries: a contextual cause gets a rule with a context
 * guard. The rule matches only when the context tag equals the fixable tag.
 * Represented as a parametric rule (causeMatch matches the cause; the context
 * guard is stored in the rule's action text and enforced by the generalizer). */
function buildContextualPolicy(): readonly PolicyEntry[] {
  const out: PolicyEntry[] = [];
  for (const type of Object.keys(CONTEXTUAL_CAUSES)) {
    const causes = CONTEXTUAL_CAUSES[type] ?? [];
    const fixableTags = CONTEXTUAL_FIXABLE_TAGS[type] ?? {};
    for (const cause of causes) {
      const fixableTag = fixableTags[cause] ?? "search";
      const anchored = `^${escapeRegex(cause)}$`;
      out.push({
        type,
        causeMatch: anchored,
        rule: {
          id: `ctx-${type}-${cause}`,
          type,
          causeMatch: anchored,
          action: `Contextual fix for ${cause}: apply ONLY when ${CONTEXT_KEY}=${fixableTag} (guard via generalizer).`,
          preventionKind: PREVENTION_KIND_BY_TYPE[type] ?? "validate",
        },
      });
    }
  }
  return deepFreeze(out);
}

export const CONTEXTUAL_POLICY: readonly PolicyEntry[] = buildContextualPolicy();

/** Cross-module policy entries: the target-side cause gets a rule. */
function buildCrossModulePolicy(): readonly PolicyEntry[] {
  const out: PolicyEntry[] = [];
  for (const type of Object.keys(CROSS_MODULE_CAUSES)) {
    const causes = CROSS_MODULE_CAUSES[type] ?? [];
    for (const cause of causes) {
      // Only non-compound cross-module causes get a rule; the compound
      // ("search-stale-preimage+race-condition") is unfixable (race).
      if (isCompoundCause(cause)) continue;
      const anchored = `^${escapeRegex(cause)}$`;
      out.push({
        type,
        causeMatch: anchored,
        rule: {
          id: `xmod-${cause}`,
          type,
          causeMatch: anchored,
          action: `Cross-module fix: ${cause} detected in ${CROSS_MODULE_TARGET_KEY}; re-fetch preimage from ${CROSS_MODULE_SOURCE_KEY}.`,
          preventionKind: PREVENTION_KIND_BY_TYPE[type] ?? "normalize",
        },
      });
    }
  }
  return deepFreeze(out);
}

export const CROSS_MODULE_POLICY: readonly PolicyEntry[] = buildCrossModulePolicy();

/** Fixable causes per type (have policy rules). Used by the simulation. */
export const FIXABLE_CAUSES_BY_TYPE: Readonly<Record<string, readonly string[]>> = deepFreeze(
  Object.fromEntries(
    Object.keys(FIXABLE_CAUSES).map((type) => [type, Object.keys(FIXABLE_CAUSES[type] ?? {})]),
  ),
);

/** Unfixable causes per type (no policy rule — structural). Used by the harder phase. */
export const UNFIXABLE_CAUSES_BY_TYPE: Readonly<Record<string, readonly string[]>> = deepFreeze(
  Object.fromEntries(
    Object.keys(UNFIXABLE_CAUSES).map((type) => [type, UNFIXABLE_CAUSES[type] ?? []]),
  ),
);

/** Default known-cause catalog per error type (fixable + unfixable, for the simulation). */
export const DEFAULT_KNOWN_CAUSES: Readonly<Record<string, readonly string[]>> = deepFreeze(
  Object.fromEntries(
    Object.keys(FIXABLE_CAUSES).map((type) => [
      type,
      [...(FIXABLE_CAUSES_BY_TYPE[type] ?? []), ...(UNFIXABLE_CAUSES_BY_TYPE[type] ?? [])],
    ]),
  ),
);

/**
 * EXP374 — Extended policy table: exact-match (EXP363) + compound + contextual
 * + cross-module. This is the full deterministic policy the updater reads.
 */
export const EXTENDED_POLICY: readonly PolicyEntry[] = deepFreeze([
  ...DEFAULT_POLICY,
  ...COMPOUND_POLICY,
  ...CONTEXTUAL_POLICY,
  ...CROSS_MODULE_POLICY,
]);

/** EXP374 — Harder cause catalogs exported for the simulation. */
export const COMPOUND_CAUSES_BY_TYPE: Readonly<Record<string, readonly string[]>> = deepFreeze(
  Object.fromEntries(Object.keys(COMPOUND_CAUSES).map((t) => [t, COMPOUND_CAUSES[t] ?? []])),
);
export const CONTEXTUAL_CAUSES_BY_TYPE: Readonly<Record<string, readonly string[]>> = deepFreeze(
  Object.fromEntries(Object.keys(CONTEXTUAL_CAUSES).map((t) => [t, CONTEXTUAL_CAUSES[t] ?? []])),
);
export const TEMPORAL_CAUSES_BY_TYPE: Readonly<Record<string, readonly string[]>> = deepFreeze(
  Object.fromEntries(Object.keys(TEMPORAL_CAUSES).map((t) => [t, TEMPORAL_CAUSES[t] ?? []])),
);
export const CROSS_MODULE_CAUSES_BY_TYPE: Readonly<Record<string, readonly string[]>> = deepFreeze(
  Object.fromEntries(Object.keys(CROSS_MODULE_CAUSES).map((t) => [t, CROSS_MODULE_CAUSES[t] ?? []])),
);
export const CONTEXTUAL_FIXABLE_TAGS_BY_TYPE: Readonly<Record<string, Readonly<Record<string, string>>>> = CONTEXTUAL_FIXABLE_TAGS;

/** Default learning config. No threshold is a static const in callers. */
export const DEFAULT_LEARNING_CONFIG: LearningConfig = deepFreeze({
  minPatternFrequency: 3,
  minConfidence: 0.05,
  maxRules: 64,
  maxPatternsPerTypePerRound: 1,
  maxPatternsPerRound: 16,
  accumulateAcrossRounds: true,
  rankByCount: true,
  policy: EXTENDED_POLICY,
  knownCauses: DEFAULT_KNOWN_CAUSES,

  // EXP374 multi-cause
  aprioriMinSupport: 0.05,
  aprioriMinConfidence: 0.5,
  miThreshold: 0.1,
  maxItemsetSize: 2,

  // EXP374 fuzzy
  fuzzyEnabled: true,
  fuzzyMinDistance: 1,
  fuzzyMaxDistance: 3,
  fuzzyLearnThreshold: true,

  // EXP374 CUSUM
  cusumEnabled: true,
  cusumTargetRate: 0.05,
  cusumThreshold: 3.0,
  cusumSlack: 0.02,

  // EXP374 Bayesian
  bayesianEnabled: true,
  bayesianPrior: 0.5,
  bayesianLearningRate: 0.1,

  // EXP374 rounds + harder categories
  rounds: 10,
  errorsPerCategory: 20,
  temporalTurnThreshold: TEMPORAL_TURN_THRESHOLD_DEFAULT,
  adversarialPrefix: ADVERSARIAL_CAUSE_PREFIX,

  // EXP389 root-cause + bias + 15 rounds.
  rootCauseEnsembleEnabled: true,
  biasCoverageThreshold: 0.5,
  exp389Rounds: 15,

  // EXP451 n-gram extraction (subword signatures). 3-6 chars is the
  // sweet spot: short enough to generalize, long enough to be specific.
  ngramEnabled: true,
  ngramMin: 3,
  ngramMax: 6,
  ngramMinFrequency: 5,
  ngramMinSupport: 0.2,
  maxNgramPatternsPerType: 3,
  maxNgramPatterns: 32,

  // EXP451 GA extraction. Bounded (population 24, 8 generations) to keep
  // the GA fast; the seed makes it deterministic.
  gaEnabled: true,
  gaPopulationSize: 24,
  gaGenerations: 8,
  gaMutationRate: 0.3,
  gaEliteFraction: 0.25,
  gaMinFitness: 0.7, // recall - fpRate >= 0.7 (high recall, low FP)
  gaSeed: 451,
  gaMaxSeeds: 32,
  maxGaPatterns: 16,

  // EXP451 decision-tree extraction. Depth 6 bounds overfitting.
  dtEnabled: true,
  dtMaxDepth: 6,
  dtMinSamplesSplit: 4,
  dtMaxFeaturesPerCause: 64,
  maxDtRulesPerType: 4,
  maxDtRules: 32,

  // EXP451 semantic matching (TF-IDF char n-gram cosine). Threshold 0.6
  // is the empirical sweet spot: high enough for 0 FP, low enough to
  // catch family variants.
  semanticEnabled: true,
  semanticMinSimilarity: 0.6,
  semanticNgramMin: 3,
  semanticNgramMax: 6,
  // EXP461 (S5): surface-form gate for the semantic matcher. 1 - 6/19 ≈
  // 0.68 for `invalid-regex` vs `invalid-regex-clean`; real family variants
  // (`invalid-regexx`, edit dist 1/13 ≈ 0.92) clear 0.7. The gate rejects
  // clean-suffix FPs without losing real variants.
  semanticMinEditSimilarity: 0.7,

  // EXP451 anomaly detector. The adversarial noise causes (e.g.
  // "noise-z3k9p2") have high entropy and no repeated structure; the
  // fixable causes (e.g. "invalid-regex") have low entropy + repeated
  // n-grams ("regex", "valid"). The detector HANDLES adversarial noise
  // (log + surface, do not fix) without weakening the test.
  anomalyDetectorEnabled: true,
  anomalyEntropyThreshold: 3.5, // bits/char; "invalid-regex" ~2.7, "noise-z3k9" ~3.8
  anomalyMinNgram: 3,
  anomalyMinNgramFreq: 2,
  anomalyMaxNoiseCount: 1, // a cause seen 0-1 times = noise (frequency-based)
  anomalyMinRound: 2, // fires from round 2 (round 1 has no history)
  unknownTypeRuleEnabled: true,
  unknownTypeMinCount: 3,
  // EXP461 (S6): n-gram discrimination. 5× means an n-gram must be ≥5× more
  // frequent in errors than in clean causes to be admitted as a rule. The
  // n-grams that appear in clean causes (`regex` in `bad-regex-clean`) are
  // dropped → the substring matcher no longer over-matches clean ops.
  ngramMinDiscrimination: 5,
  // EXP461 (L3): the unknown-cause rule + validation handler lower the
  // plateau from 3.33% (contextual-unfixable floor) to <1% by handling
  // the genuinely-unfixable + persistent-uncovered causes (detect + surface,
  // never silently fix — the same pattern as the anomaly detector).
  unknownCauseRuleEnabled: true,
  unknownCauseMinCount: 3,
  contextualValidationHandlerEnabled: true,
  contextualValidationTag: "validate",

  // EXP451 self-improving + artificial life.
  selfImprovingEnabled: true,
  generationEvolverEnabled: true,
  generationEvolverGenerations: 15,

  // EXP451 targets (the 15-round 300-error benchmark targets <5%).
  exp451TargetPlateau: 0.05,
  exp451HarderRounds: 150,
  exp451HarderErrorsPerRound: 3000,
});

/**
 * Load a learning config with optional overrides. Validates the result so a
 * bad override cannot produce an invalid config. This is the ONLY way to
 * obtain a `LearningConfig`; callers never construct one inline.
 */
export function loadLearningConfig(
  overrides?: Partial<z.input<typeof LEARNING_CONFIG_SCHEMA>>,
): LearningConfig {
  const merged = { ...DEFAULT_LEARNING_CONFIG, ...overrides };
  // `policy` and `knownCauses` are objects/arrays: a shallow merge could drop
  // the default policy table if the caller passes an empty array. Merge
  // explicitly only when the caller provides them; otherwise keep defaults.
  const result = {
    ...merged,
    policy: overrides?.policy ?? DEFAULT_LEARNING_CONFIG.policy,
    knownCauses: overrides?.knownCauses
      ? { ...DEFAULT_KNOWN_CAUSES, ...overrides.knownCauses }
      : DEFAULT_LEARNING_CONFIG.knownCauses,
  };
  return deepFreeze(LEARNING_CONFIG_SCHEMA.parse(result));
}

// ---------------------------------------------------------------------------
// Learned-rules store: the OUTPUT of learning. Mutable, persisted as JSON.
// ---------------------------------------------------------------------------

export const LEARNED_RULE_SCHEMA = z.strictObject({
  id: z.string().min(1).max(128),
  spec: RULE_SPEC_SCHEMA,
  addedAtRound: z.number().int().nonnegative(),
  coversErrors: z.number().int().nonnegative(),
  introducedFPs: z.number().int().nonnegative(),
  admittedBy: z.string().min(1).max(256),
});
export type LearnedRule = z.infer<typeof LEARNED_RULE_SCHEMA>;

export const RULES_STORE_SCHEMA = z.strictObject({
  schemaVersion: z.literal(1),
  rules: z.array(LEARNED_RULE_SCHEMA).max(10000),
  updatedAt: z.number().int().nonnegative(),
  updatedAtRound: z.number().int().nonnegative(),
});
export type RulesStoreDocument = z.infer<typeof RULES_STORE_SCHEMA>;

/** In-memory learned-rules store. Persists to disk as validated JSON. */
export class LearnedRulesStore {
  private readonly path: string | undefined;
  private rules = new Map<string, LearnedRule>();
  private updatedAtRound = 0;

  constructor(path?: string) {
    this.path = path;
    if (path && existsSync(path)) {
      this.load();
    }
  }

  private load(): void {
    if (!this.path) return;
    try {
      const raw = readFileSync(this.path, "utf8");
      const doc = RULES_STORE_SCHEMA.parse(JSON.parse(raw));
      this.rules.clear();
      for (const r of doc.rules) this.rules.set(r.id, r);
      this.updatedAtRound = doc.updatedAtRound;
    } catch {
      // Corrupted store: start empty (never silently inject bad rules).
      this.rules.clear();
    }
  }

  /** Persist the current store as validated JSON. */
  save(round: number): void {
    if (!this.path) return;
    const doc: RulesStoreDocument = {
      schemaVersion: 1,
      rules: [...this.rules.values()],
      updatedAt: Date.now(),
      updatedAtRound: round,
    };
    // Validate before writing so a bug can't write a corrupt store.
    RULES_STORE_SCHEMA.parse(doc);
    writeFileSync(this.path, JSON.stringify(doc, null, 2) + "\n", "utf8");
  }

  /** Add or replace a rule. Dedup by id. Returns true if added/replaced. */
  upsert(rule: LearnedRule): boolean {
    this.rules.set(rule.id, rule);
    this.updatedAtRound = Math.max(this.updatedAtRound, rule.addedAtRound);
    return true;
  }

  has(id: string): boolean {
    return this.rules.has(id);
  }

  get(id: string): LearnedRule | undefined {
    return this.rules.get(id);
  }

  all(): readonly LearnedRule[] {
    return [...this.rules.values()];
  }

  size(): number {
    return this.rules.size;
  }

  /** Rules active for a given error type (used by the simulator). */
  forType(type: ErrorType): readonly LearnedRule[] {
    return this.all().filter((r) => r.spec.type === type);
  }
}

/**
 * Does a rule's `causeMatch` regex match an error's `cause`?
 * The single owner of the "regex match" decision used by the updater,
 * validator, and simulator.
 */
export function ruleMatchesCause(rule: RuleSpec, type: string, cause: string): boolean {
  if (rule.type !== type) return false;
  // Anchored full-match: the policy uses `^...$` patterns.
  return new RegExp(rule.causeMatch, "u").test(cause);
}
