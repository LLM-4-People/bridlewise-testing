/**
 * THE COMMUNITY BOTS' LIMITS: every length the community module bounds text
 * to, named once (the no-hardcoded-configurables and truncation-slice rules:
 * a limit lives in its config owner, never inline at a call site).
 */
import { deepFreeze } from "../../kernel/integrity.ts";

export const COMMUNITY_LIMITS = deepFreeze({
  /** The most characters of a person's typed text a bot reply quotes (one line). */
  typedTextMaxLength: 300,
  /** The most characters of an issue title a record carries. */
  recordTitleMaxLength: 120,
  /** How many characters of a commit sha a reply shows. */
  shortShaLength: 12,
  /** The `YYYY-MM-DD` day at the head of an ISO timestamp. */
  isoDayLength: 10,
  /** The longest first line a command may be (a longer one is no command). */
  commandLineMaxLength: 500,
} as const);
