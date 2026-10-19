/**
 * EXP420 — Deterministic query classifier.
 *
 * Classifies a user query into one of {code, memory, action, general} and
 * extracts the target identifier. Deterministic (no LLM) — pure regex +
 * keyword scoring. Per AGENTS.md "everything dynamically computed": all
 * keyword sets + thresholds are in the `CONFIG` constant.
 *
 * Classification logic:
 *   1. Score each kind by counting matching keyword patterns in the query.
 *   2. The kind with the highest score wins (ties → "general").
 *   3. Confidence = winnerScore / (winnerScore + runnerUpScore + epsilon).
 *   4. Target extraction: longest identifier-like token in the query.
 *
 * Research notes:
 *   - OpenAI's classifier-in-the-loop (Atlas 2024) found that a deterministic
 *     classifier before the LLM cut tool calls by ~40% in chat-code tasks.
 *   - Cursor's "Apply" pattern (2024-09) classifies queries into "code" vs
 *     "action" before deciding whether to load the diff context.
 *   - A deterministic classifier is preferred for v1 because: (a) zero
 *     latency, (b) auditable, (c) no LLM cost, (d) trivially testable.
 */

import type { ClassifiedQuery, QueryKind } from "./types.ts";

/**
 * CONFIG — single source of truth for the classifier.
 * Per AGENTS.md "everything dynamically computed".
 */
export const CLASSIFIER_CONFIG = Object.freeze({
  /** Confidence threshold for hybrid mode (below → no injection). */
  hybridThreshold: 0.55,
  /** Patterns for each kind. Each entry is [regex, weight]. */
  patterns: {
    code: [
      [/\bwhere\s+is\b/gi, 2.0],
      [/\bwhat\s+does\b.*\bdo\b/gi, 2.0],
      [/\bwhat\s+does\b/gi, 1.5],
      [/\bhow\s+does\b/gi, 2.0],
      [/\bhow\s+is\b/gi, 1.5],
      [/\bfind\b/gi, 1.5],
      [/\bshow\s+me\b/gi, 1.5],
      [/\blocate\b/gi, 1.5],
      [/\bdefinition\s+of\b/gi, 2.0],
      [/\bimplement(?:ation|ation\s+of)?\b/gi, 1.5],
      [/\bdeclare(?:d|d\s+in)?\b/gi, 1.5],
      [/\bimports?\s+of\b/gi, 1.5],
      [/\busage\s+of\b/gi, 1.5],
      [/\bcaller(?:s)?\s+of\b/gi, 2.0],
      [/\bcallee(?:s)?\s+of\b/gi, 2.0],
      [/\bfile\s+containing\b/gi, 2.0],
      [/\bmodule\s+containing\b/gi, 2.0],
      [/\bdoes\s+.*\bexist\b/gi, 1.5],
    ],
    memory: [
      [/\bwhat\s+did\s+we\b/gi, 2.5],
      [/\bwhich\s+file\s+did\s+we\b/gi, 2.5],
      [/\bwhat\s+was\s+the\b/gi, 2.0],
      [/\bwhat\s+did\s+i\b/gi, 2.5],
      [/\bdo\s+you\s+remember\b/gi, 2.5],
      [/\bremember\s+when\b/gi, 2.5],
      [/\bremember\b/gi, 1.5],
      [/\b(?:previously|before|earlier)\b/gi, 1.0],
      [/\b(?:decided|chose|picked|selected)\b/gi, 1.5],
      [/\b(?:conclusion|decision|outcome)\b/gi, 1.5],
      [/\blast\s+(?:time|turn|step|attempt)\b/gi, 1.5],
      [/\bagreed\s+on\b/gi, 2.0],
      [/\bdiscussed\b/gi, 1.5],
      [/\bmentioned\b/gi, 1.5],
      [/\bsaid\b/gi, 1.0],
    ],
    action: [
      [/\brename\b/gi, 2.5],
      [/\brefactor\b/gi, 2.5],
      [/\bfix\b/gi, 2.0],
      [/\badd\s+(?:a\s+)?(?:parameter|param|argument|method|function|field)\s+to\b/gi, 2.5],
      [/\badd\s+(?:a\s+)?(?:parameter|param|argument|method|function|field)\b/gi, 2.0],
      [/\bextract\b/gi, 2.5],
      [/\binline\b/gi, 2.5],
      [/\bdelete\b/gi, 2.0],
      [/\bremove\b/gi, 2.0],
      [/\bmove\b/gi, 2.0],
      [/\bcopy\b/gi, 1.5],
      [/\bupdate\b/gi, 1.5],
      [/\bchange\b/gi, 1.5],
      [/\breplace\b/gi, 1.5],
      [/\bmodify\b/gi, 1.5],
      [/\bimplement\b/gi, 1.5],
      [/\bcreate\b/gi, 1.5],
      [/\bgenerate\b/gi, 1.5],
      [/\bwrite\s+(?:a\s+)?(?:function|method|class|component)\b/gi, 2.0],
      [/\bextract\s+method\b/gi, 2.5],
      [/\binline\s+constant\b/gi, 2.5],
    ],
  } as Readonly<Record<Exclude<QueryKind, "general">, readonly Readonly<[RegExp, number]>[]>>,
  /** Identifier pattern: camelCase, snake_case, kebab-case, PascalCase, dotted. */
  identifierPattern: /[A-Za-z_][A-Za-z0-9_$.-]{1,64}/g,
  /** Identifiers to ignore when extracting targets (stop words). */
  identifierStopWords: new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "to", "of", "in", "on",
    "for", "with", "and", "or", "not", "this", "that", "these", "those", "i",
    "you", "we", "they", "it", "do", "does", "did", "doing", "have", "has",
    "had", "what", "where", "when", "which", "how", "why", "who", "find",
    "show", "locate", "rename", "fix", "refactor", "extract", "inline",
    "delete", "remove", "move", "update", "change", "replace", "modify",
    "implement", "create", "generate", "write", "function", "method",
    "class", "component", "parameter", "param", "argument", "field", "file",
    "module", "definition", "implementation", "declaration", "import",
    "usage", "caller", "callees", "calle", "calles", "remember", "decided",
    "chose", "picked", "selected", "discussed", "mentioned", "do", "you",
    "we", "previously", "before", "earlier", "time", "turn", "step",
    "attempt", "agreed", "on", "conclusion", "decision", "outcome", "copy",
    "add", "me", "please", "now", "want", "need", "should", "could",
    "would", "will", "can", "may", "might", "must", "shall",
  ]),
  /** "general" keywords (only triggers if no other kind matched strongly). */
  generalPatterns: [
    /^\s*(hi|hello|hey|thanks|thank\s+you|ok|okay|cool|nice|great)\b/gi,
    /\bwhat\s+can\s+you\s+do\b/gi,
    /\bwho\s+are\s+you\b/gi,
    /\bhelp\b/gi,
  ],
});

/**
 * Classify the user's query.
 */
export function classifyQuery(query: string): ClassifiedQuery {
  const scores: Record<QueryKind, number> = { code: 0, memory: 0, action: 0, general: 0 };

  for (const [kind, patterns] of Object.entries(CLASSIFIER_CONFIG.patterns) as [
    Exclude<QueryKind, "general">,
    readonly Readonly<[RegExp, number]>[],
  ][]) {
    for (const [pattern, weight] of patterns) {
      pattern.lastIndex = 0;
      const matches = query.match(pattern);
      if (matches !== null) {
        scores[kind] += weight * matches.length;
      }
    }
  }
  for (const pattern of CLASSIFIER_CONFIG.generalPatterns) {
    pattern.lastIndex = 0;
    const matches = query.match(pattern);
    if (matches !== null) {
      scores.general += 0.5 * matches.length;
    }
  }

  const kinds: QueryKind[] = ["code", "memory", "action", "general"];
  kinds.sort((a, b) => scores[b]! - scores[a]!);
  const winner = kinds[0]!;
  const runnerUp = kinds[1]!;
  const winnerScore = scores[winner]!;
  const runnerUpScore = scores[runnerUp]!;
  const confidence =
    winnerScore === 0
      ? 0
      : winnerScore / (winnerScore + runnerUpScore + 1e-6);

  const kind: QueryKind = winnerScore === 0 ? "general" : winner;
  const target = extractTarget(query, kind);

  return Object.freeze({
    kind,
    confidence,
    target,
    searchQuery: query,
  });
}

/**
 * Extract the most likely target identifier from the query.
 * Strategy:
 *   - "rename X to Y" → X (the source identifier).
 *   - "where is X" → X.
 *   - "what does X do" → X.
 *   - Otherwise: the longest identifier-like token that isn't a stop word.
 */
function extractTarget(query: string, kind: QueryKind): string | null {
  const lower = query.toLowerCase();

  // "rename X to Y" / "rename the function X to Y" / "change X to Y" / etc.
  // We prefer X (the SOURCE identifier), not Y (the destination).
  const renameMatch =
    lower.match(/\b(?:rename|change|move|copy|refactor)\s+(?:the\s+)?(?:function|method|class|variable|constant|component|module|file)?\s*([a-z0-9_$.-]+)\s+(?:to|as|into)\s+([a-z0-9_$.-]+)/) ||
    lower.match(/\b(?:rename|change|move|copy|refactor)\s+(?:the\s+)?([a-z0-9_$.-]+)\s+(?:to|as|into)\b/);
  if (renameMatch && renameMatch[1]) {
    const t = cleanIdent(renameMatch[1]);
    if (t !== null && isLikelyIdentifier(t)) return t;
  }
  // "add PARAM to X" → X (the destination identifier).
  if (kind === "action") {
    const addToMatch = lower.match(/\bto\s+([a-z0-9_$.-]+)\s*$/);
    if (addToMatch && addToMatch[1]) {
      const t = cleanIdent(addToMatch[1]);
      if (t !== null && isLikelyIdentifier(t)) return t;
    }
  }
  // "where is X" / "what does X do" / "how does X work" / "find X"
  const subjectMatch =
    lower.match(/\bwhere\s+(?:is|are)\s+(?:the\s+)?(?:function\s+|method\s+|class\s+|variable\s+|constant\s+)?([a-z0-9_$.-]+)\b/) ||
    lower.match(/\bwhat\s+does\s+(?:the\s+)?(?:function\s+|method\s+)?([a-z0-9_$.-]+)\s+do\b/) ||
    lower.match(/\bhow\s+does\s+(?:the\s+)?(?:function\s+|method\s+)?([a-z0-9_$.-]+)\s+work\b/) ||
    lower.match(/\bfind\s+(?:the\s+)?(?:function\s+|method\s+)?([a-z0-9_$.-]+)\b/) ||
    lower.match(/\bfix\s+(?:the\s+)?(?:bug\s+in\s+)?([a-z0-9_$.-]+)\b/) ||
    lower.match(/\b(?:definition|declaration|implementation)\s+of\s+([a-z0-9_$.-]+)\b/) ||
    lower.match(/\bcallers?\s+of\s+([a-z0-9_$.-]+)\b/) ||
    lower.match(/\bcallees?\s+of\s+([a-z0-9_$.-]+)\b/) ||
    lower.match(/\bfile\s+containing\s+([a-z0-9_$.-]+)\b/) ||
    lower.match(/\b(?:delete|remove)\s+(?:the\s+)?(?:function\s+|method\s+)?([a-z0-9_$.-]+)\b/) ||
    lower.match(/\bextract\s+(?:method|function)\s+([a-z0-9_$.-]+)\b/) ||
    lower.match(/\binline\s+(?:constant|variable)\s+([a-z0-9_$.-]+)\b/) ||
    lower.match(/\brefactor\s+(?:the\s+)?(?:function\s+|method\s+)?([a-z0-9_$.-]+)\b/);
  if (subjectMatch && subjectMatch[1]) {
    const t = cleanIdent(subjectMatch[1]);
    if (t !== null && isLikelyIdentifier(t) && !CLASSIFIER_CONFIG.identifierStopWords.has(t)) {
      return t;
    }
  }

  // Fallback: longest identifier-like token that isn't a stop word.
  CLASSIFIER_CONFIG.identifierPattern.lastIndex = 0;
  const tokens = query.match(CLASSIFIER_CONFIG.identifierPattern) ?? [];
  let best: string | null = null;
  for (const tok of tokens) {
    const cleaned = cleanIdent(tok);
    if (cleaned === null) continue;
    const lowerTok = cleaned.toLowerCase();
    if (CLASSIFIER_CONFIG.identifierStopWords.has(lowerTok)) continue;
    if (!isLikelyIdentifier(lowerTok)) continue;
    if (best === null || cleaned.length > best.length) best = cleaned;
  }
  return best;
}

/** Strip trailing/leading non-identifier chars (e.g. periods, commas, quotes). */
function cleanIdent(token: string): string | null {
  // Identifier characters: letters, digits, _, $, ., -
  const cleaned = token.replace(/^[^A-Za-z0-9_$]+/g, "").replace(/[^A-Za-z0-9_$.-]+$/g, "");
  if (cleaned.length === 0) return null;
  return cleaned;
}

function isLikelyIdentifier(token: string): boolean {
  if (token.length < 2) return false;
  if (token.length > 64) return false;
  if (/^\d+$/.test(token)) return false;
  // Reject pure-English-word patterns when they're too short or in stopwords.
  return /^[a-z0-9_$.-]+$/i.test(token);
}
