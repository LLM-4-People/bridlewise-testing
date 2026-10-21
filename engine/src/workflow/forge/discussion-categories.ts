/**
 * THE DISCUSSION CATEGORIES (github-only §10.5): the nine categories of the
 * trunk's Discussions, each with its GitHub format. GitHub has no API that
 * creates a category, so the maintainer creates them once in the UI (the Apps
 * page lists them, runbook §U Session 1 item 6) and `harness forge audit`
 * compares the live categories with this table.
 */
import { deepFreeze } from "../../kernel/integrity.ts";

/** GitHub's category formats, as its UI names them. */
export type DiscussionFormat = "announcement" | "open-ended" | "question-answer" | "poll";

export type DiscussionCategory = Readonly<{ name: string; format: DiscussionFormat; purpose: string }>;

export const FORGE_DISCUSSION_CATEGORIES: readonly DiscussionCategory[] = deepFreeze([
  { name: "Announcements", format: "announcement", purpose: "milestone closes, major changes, the pinned \"Follow along\" (the publisher posts)" },
  { name: "Floor log", format: "announcement", purpose: "one thread per milestone, one comment per land (the publisher posts)" },
  { name: "Releases", format: "announcement", purpose: "one per release (the release train posts)" },
  { name: "Decisions", format: "announcement", purpose: "one per decision record; everyone can comment" },
  { name: "RFCs", format: "open-ended", purpose: "a proposal for a new decision (with a form)" },
  { name: "Ideas", format: "open-ended", purpose: "ideas; /track turns one into a record (with a form)" },
  { name: "Q&A", format: "question-answer", purpose: "questions with verified answers" },
  { name: "Show and tell", format: "open-ended", purpose: "people's own uses of the harness" },
  { name: "Polls", format: "poll", purpose: "sentiment checks; results are signals, never decisions" },
] satisfies DiscussionCategory[]);
