/**
 * THE DOOR'S BOUNDS, in one place: what GitHub accepts in a check run, how
 * much the door reads before it judges, and how the streamer paces itself.
 * Each value is a protocol limit or a display bound, never a judgement: a
 * clipped message says it was clipped, and a list read short is refused by
 * the reader, never judged on a part.
 */
import { deepFreeze } from "../../kernel/integrity.ts";

export const DOOR_LIMITS = deepFreeze({
  /** Pages of an API list the door reads before it judges (each page is 100 entries). */
  readPages: 20,
  /** GitHub takes at most 50 annotations per check-run request; the rest are appended by later updates. */
  annotationsPerRequest: 50,
  /** A check run's title, summary and annotation message, in characters (GitHub's own caps, with headroom). */
  titleCharacters: 255,
  summaryCharacters: 65_000,
  annotationMessageCharacters: 60_000,
  /** One failed test's message carried into an annotation, in characters. */
  testMessageCharacters: 1_000,
  /** How many failing jobs the live title names, and how many refusals the verdict's title names. */
  failingJobsNamed: 5,
  refusalsNamed: 6,
  /** A commit named in a finding: its abbreviated sha, in characters. */
  commitShaCharacters: 12,
  /** The streamer's cadence and its bound (display only; the job's own ceiling is 15 minutes). */
  streamIntervalMs: 20_000,
  streamBudgetMs: 12 * 60_000,
} as const);
