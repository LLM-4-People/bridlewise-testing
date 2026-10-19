/**
 * Tokenizer + token estimation shared by the memory store and the
 * context manager.
 *
 * The tokenizer is a lowercase word splitter with stopword removal — the
 * same scheme used by EXP351/353/360. It is deliberately dependency-free
 * so the memory store stays portable.
 */
import { createHash } from "node:crypto";

const STOPWORDS = new Set<string>([
  "the", "a", "an", "and", "or", "but", "if", "then", "else", "for", "of", "to",
  "in", "on", "at", "by", "with", "from", "as", "is", "are", "was", "were", "be",
  "been", "being", "this", "that", "these", "those", "it", "its", "i", "you",
  "he", "she", "we", "they", "them", "his", "her", "their", "our", "your", "my",
  "me", "him", "us", "do", "does", "did", "done", "doing", "have", "has", "had",
  "having", "will", "would", "can", "could", "should", "shall", "may", "might",
  "must", "not", "no", "nor", "so", "than", "too", "very", "just", "about", "into",
  "over", "under", "again", "further", "once", "here", "there", "when", "where",
  "why", "how", "all", "any", "both", "each", "few", "more", "most", "other",
  "some", "such", "only", "own", "same", "what", "which", "who", "whom", "answer",
  "question", "plain", "text", "give", "call", "respond", "json", "tool", "continue",
]);
/** Tokenize text into lowercase word tokens (length > 1, non-stopword). */
export function tokenize(text: string): readonly string[] {
  const lower = String(text).toLowerCase();
  const raw = lower.split(/[^a-z0-9_]+/).filter((t) => t.length > 1);
  const out: string[] = [];
  for (const t of raw) {
    if (STOPWORDS.has(t)) continue;
    out.push(t);
  }
  return out;
}

/** Term frequency map for a token list. */
export function termFrequency(tokens: readonly string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
  const len = tokens.length || 1;
  for (const [k, v] of m) m.set(k, v / len);
  return m;
}

/** Estimate tokens for a string (~4 chars/token, GPT-style). */
export function estimateTokens(s: string): number {
  return Math.ceil(String(s).length / 4);
}

/** Semantic hash of a token list (SHA-256 of sorted unique tokens). */
export function semanticHash(tokens: readonly string[]): string {
  const unique = Array.from(new Set(tokens)).sort();
  return createHash("sha256").update(unique.join(" ")).digest("hex").slice(0, 16);
}
