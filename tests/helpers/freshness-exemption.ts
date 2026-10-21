/**
 * THE ONE OWNER OF `@freshness-exempt <reason>` QUALITY.
 *
 * ── Why a reason is judged at all ─────────────────────────────────────────
 *
 * A `@freshness-exempt` marker is an EXEMPTION from the generated-artifact
 * freshness gate: it says "this reader may trust the artifact without binding
 * it to a content identity". An exemption is a claim about the world, so it
 * carries the same evidence burden as a detection, and a marker whose reason is
 * absent, a placeholder, or a sentence that names nothing the reader actually
 * uses is a silent waiver wearing the marker's clothes.
 *
 * Before this module there were two answers to "is the reason good": the
 * freshness census checked only that it was NON-EMPTY, and the dossier ratchet
 * did not check it at all. Two owners of one judgement is the defect this
 * estate argues against, so the verdict lives here once and both consumers
 * import it:
 *
 *   - `tests/prevention/generated-artifact-freshness.test.ts` — every marker in
 *     the guard estate must pass.
 *   - `tests/helpers/dossier-floor.ts` — the ratchet refuses a floor whose
 *     guards carry a dishonest exemption.
 *
 * ── What "names nothing the test actually needs" means, mechanically ─────
 *
 * The reason must share at least one SIGNIFICANT token with the reader's own
 * CODE (comments stripped, string literals kept): an identifier, a path
 * segment, or a literal the test uses. A reason made of generic vocabulary
 * ("because the test needs it") shares no such token once the generic test
 * words are removed, so it is refused. The rule is a proxy for "names the
 * artifact or the fact that makes it exempt", and it is deliberately the
 * weakest rule that still rejects prose that could be pasted onto any marker.
 *
 * The parser is anchored on the same shape the census has always used — a
 * `*`-prefixed comment line beginning `@freshness-exempt` — so a marker that
 * was invisible to the census cannot start counting here.
 */

import { stripCommentsOnly } from "../../engine/scripts/verification/source-view.ts";

/** One `@freshness-exempt` marker found on a comment line. */
export interface FreshnessExemption {
  /** 1-based line number in the source. */
  readonly line: number;
  readonly reason: string;
}

/** One quality complaint about a marker, line-anchored. */
export interface FreshnessExemptionProblem {
  readonly line: number;
  readonly message: string;
}

/**
 * The marker's PREFIX, deliberately without a capture-the-rest wildcard: the
 * reason is the line's tail, sliced after this match. A `(.*)` here would be a
 * greedy unbounded run between two anchors, which the proximity census counts
 * as a distance claim — a helper that parses annotations owes the census no
 * new debt.
 */
const MARKER_PREFIX = /^\s*\*\s*@freshness-exempt(?:\s+|$)/u;

/**
 * Reasons that are placeholders rather than explanations, normalized to
 * lowercase words. Matched as the WHOLE reason — a real sentence beginning
 * "none of ..." is allowed, because it says something the reader can check.
 */
const PLACEHOLDER_REASONS = new Set([
  "na",
  "n a",
  "none",
  "nil",
  "null",
  "todo",
  "tbd",
  "fixme",
  "xxx",
  "placeholder",
  "test",
  "tests",
  "exempt",
  "exemption",
  "because",
  "reason",
  "unknown",
  "misc",
  "ok",
  "okay",
  "fine",
  "safe",
  "no reason",
  "not needed",
  "as needed",
  "it is fine",
  "it is safe",
  "self written",
]);

/**
 * Words that appear in every test file and therefore cannot witness that a
 * reason names THIS reader's subject. Removed from the code vocabulary before
 * the overlap test, so "the test needs it" cannot borrow `test`, and a sentence
 * built from language keywords cannot borrow `this`.
 */
const GENERIC_CODE_WORDS = new Set([
  "test",
  "tests",
  "guard",
  "guards",
  "source",
  "sources",
  "file",
  "files",
  "read",
  "reads",
  "reader",
  "readers",
  "code",
  "assert",
  "asserts",
  "expect",
  "suite",
  "spec",
  "check",
  "checks",
  "write",
  "writes",
  "written",
  "data",
  "value",
  "values",
  "string",
  "strings",
  "line",
  "lines",
  "path",
  "paths",
  "needs",
  "needed",
  "because",
  "pass",
  "passes",
  // Language keywords: present in every program, so naming one is not naming
  // anything this reader needs.
  "this",
  "that",
  "true",
  "false",
  "null",
  "undefined",
  "const",
  "from",
  "import",
  "export",
  "function",
  "return",
  "async",
  "await",
  "else",
  "case",
  "default",
  "interface",
  "readonly",
  "number",
  "boolean",
  "never",
  "unknown",
  "let",
  "var",
  "new",
  "typeof",
  "instanceof",
  "class",
  "extends",
  "implements",
]);

/** The shortest reason that can name an artifact and say why it needs none. */
const MIN_REASON_CHARS = 40;
const MIN_REASON_WORDS = 6;

/** Lowercase alphanumeric words, the unit both sides of the overlap test use. */
function words(text: string): readonly string[] {
  return [...text.toLowerCase().matchAll(/[a-z0-9]+/gu)].map((match) => match[0]);
}

/**
 * The significant vocabulary of a reader's CODE. Comments are stripped (a
 * reason cannot earn its keep by citing the prose around it), string literals
 * and identifiers are kept, and camelCase / snake_case / kebab-case are split
 * into their parts so `FLOOR_PATH` and "floor" meet.
 */
function codeVocabulary(source: string): ReadonlySet<string> {
  const code = stripCommentsOnly(source);
  const vocabulary = new Set<string>();
  for (const match of code.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/gu)) {
    const split = match[0].replace(/([a-z0-9])([A-Z])/gu, "$1 $2");
    for (const part of split.toLowerCase().split(/[^a-z0-9]+/u)) {
      if (part.length < 4) continue;
      if (GENERIC_CODE_WORDS.has(part)) continue;
      vocabulary.add(part);
    }
  }
  return vocabulary;
}

/** Every `@freshness-exempt` marker in a source, in source order. */
export function freshnessExemptions(source: string): readonly FreshnessExemption[] {
  const found: FreshnessExemption[] = [];
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const match = MARKER_PREFIX.exec(line);
    if (match === null) continue;
    found.push({ line: index + 1, reason: line.slice(match[0].length).trim() });
  }
  return found;
}

/**
 * Judge one marker's reason. Returns the problems (empty means the reason is a
 * real claim): it must exist, must not be a placeholder, must be long enough to
 * say something, and must name at least one token from the reader's code.
 */
export function validateFreshnessExemption(
  exemption: FreshnessExemption,
  source: string,
  fileLabel: string,
): FreshnessExemptionProblem[] {
  const at = (message: string): FreshnessExemptionProblem[] => [{ line: exemption.line, message: `${fileLabel}: ${message}` }];
  const reason = exemption.reason;
  if (reason.length === 0) {
    return at(
      "@freshness-exempt has no reason — an exemption must say WHY the artifact needs no content binding",
    );
  }
  const normalized = words(reason).join(" ");
  if (PLACEHOLDER_REASONS.has(normalized)) {
    return at(
      `@freshness-exempt reason ${JSON.stringify(reason)} is a placeholder, not a reason — name the artifact and why it cannot go stale`,
    );
  }
  const tokens = words(reason);
  if (reason.length < MIN_REASON_CHARS || tokens.length < MIN_REASON_WORDS) {
    return at(
      `@freshness-exempt reason ${JSON.stringify(reason)} is too short to be a reason — name the artifact and why it needs no content binding`,
    );
  }
  const vocabulary = codeVocabulary(source);
  const shared = tokens.filter((token) => token.length >= 4 && vocabulary.has(token));
  if (shared.length === 0) {
    return at(
      `@freshness-exempt reason ${JSON.stringify(reason)} names nothing this reader actually uses — cite the artifact, path, or symbol that makes it exempt`,
    );
  }
  return [];
}

/** Judge every marker in a source. */
export function validateFreshnessExemptions(source: string, fileLabel: string): FreshnessExemptionProblem[] {
  return freshnessExemptions(source).flatMap((exemption) => validateFreshnessExemption(exemption, source, fileLabel));
}
