/**
 * Shared types for the unified context + memory + awareness system.
 *
 * The unified system manages four concerns together:
 *   - context window (trim-as-you-go)
 *   - memory store (trimmed turns + codebase facts + awareness snapshots)
 *   - awareness engine (dynamic codebase signals)
 *   - injection controller (decides what enters the bounded context each turn)
 *
 * These types are the contracts passed between those components. They are
 * deliberately small and serialization-friendly so the full state can be
 * persisted to evidence files.
 */

/** A message kind in the context window. */
export type MessageKind =
  | "system" // persistent system prompt
  | "awareness" // per-turn awareness block (replaced each turn)
  | "memory" // per-turn critical-context memory injection (replaced each turn)
  | "user" // user / scripted content
  | "assistant" // model response
  | "tool_result" // tool dispatch result (sent as user role to the API)
  | "critical_context" // enforced memory injection (probe cascade)
  | "summary"; // EXP435: per-turn conversation summary block (replaced each turn, always in context)

/** One message in the context window. */
export interface TurnMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
  /** Estimated token count of `content`. */
  readonly tokens: number;
  /** Turn index when the message was added (1-based; 0 = pre-turn). */
  readonly turn: number;
  /** Message kind for trim / injection logic. */
  readonly kind: MessageKind;
  /** Whether this turn carries a planted codebase fact (boosts relevance). */
  readonly hasFact: boolean;
  /** Module names referenced in this turn (for hot-module retrieval). */
  readonly moduleTags: readonly string[];
}

/** Kind of memory entry. */
export type MemoryKind = "fact" | "turn" | "awareness";

/** One memory store entry. */
export interface MemoryEntry {
  readonly id: number;
  readonly turn: number;
  readonly turns: number[];
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
  readonly hash: string;
  /** L2-normalized TF-IDF vector (term -> weight). Mutable: recomputed by the store. */
  tfidf: Map<string, number>;
  readonly tokens: number;
  readonly kind: MemoryKind;
  readonly tags: readonly string[];
  /** Ebbinghaus strength S (grows on access via FSRS-4 reinforcement). */
  strength: number;
  /** Number of times this entry was retrieved (for FSRS-4). */
  accessCount: number;
  /** Last turn at which this entry was accessed. */
  lastAccessedTurn: number;
  /** Wall-clock storedAt (ms). */
  readonly storedAt: number;
}

/** Result of a memory retrieval. */
export interface RetrievedMemory {
  readonly id: number;
  readonly turn: number;
  readonly turns: readonly number[];
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
  readonly similarity: number;
  /** Combined score (similarity + boosts). */
  readonly score: number;
  readonly retention: number;
  readonly strength: number;
  readonly kind: MemoryKind;
  readonly tags: readonly string[];
  readonly hash: string;
}

/** A trimmed turn (saved to memory before eviction). */
export interface TrimmedTurn {
  readonly turn: number;
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
  readonly kind: MessageKind;
  readonly tokens: number;
  /** Relevance score that caused eviction (lower = less relevant). */
  readonly relevanceScore: number;
}

/** A planted fact (planted in early turns, probed later). */
export interface PlantedFact {
  readonly turn: number;
  readonly factId: string;
  readonly content: string;
  readonly tags: readonly string[];
  readonly probe: string;
  /** Tokens that must appear in the probe answer for it to be correct. */
  readonly expectContains: readonly string[];
}

/** A probe result. */
export interface ProbeResult {
  readonly checkpoint: number;
  readonly turn: number;
  readonly factId: string;
  readonly question: string;
  readonly expected: string;
  readonly answer: string;
  readonly correct: boolean;
  readonly level: number;
  readonly natural: boolean;
  readonly bypassed: boolean;
  readonly llmCalls: number;
  readonly retrievedCount: number;
}

/** Awareness snapshot stored in memory (criterion: dynamic awareness in memory). */
export interface AwarenessMemoryPayload {
  readonly turn: number;
  readonly fileCount: number;
  readonly functionCount: number;
  readonly moduleCount: number;
  readonly totalLoc: number;
  readonly complexityMean: number;
  readonly complexityMax: number;
  readonly hotspotCount: number;
  readonly topComplex: readonly string[];
  readonly hotModules: readonly string[];
  readonly compactBlock: string;
}
