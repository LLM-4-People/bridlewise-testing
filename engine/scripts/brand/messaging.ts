/**
 * THE MESSAGING SOURCE — the project's public words and identity in one file
 * (`docs/brand/messaging.json`): the name, the addresses, the promise, the
 * summary, the honest status line, the licence, the repository description
 * and topics, and the name's own story (the dictionary entry). Every
 * generated surface reads it: the README's front block, the org profile, the
 * repository metadata, the release-note header, the claims page, the roadmap
 * and (through DESIGN's renderers) the social images. None restates a word of
 * it. Where the repository and its site live is not a word: it comes from
 * the repository's one declaration (`package.json` `repository.url`, through
 * `shared/repository-coordinates.ts`), so no file spells the repository's URL.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { repositoryCoordinates } from "../../../shared/repository-coordinates.ts";
import { InputError } from "../../src/kernel/errors.ts";

export const MESSAGING_PATH = "docs/brand/messaging.json";
export const MESSAGING_SCHEMA = "bridlewise-messaging/v1";
/** GitHub's own limits for a repository's description and topics. */
const DESCRIPTION_MAX = 350;
const TOPICS_MAX = 20;
const TOPIC = /^[a-z0-9][a-z0-9-]{0,49}$/u;

export type Messaging = Readonly<{
  name: string;
  /** `https://github.com/<owner>/<repository>`, no trailing slash (from `package.json`, never the source). */
  repositoryUrl: string;
  /** The site's root, with a trailing slash (from `package.json`, never the source). */
  siteUrl: string;
  /** The one-line promise (concept A): what every surface leads with. */
  promise: string;
  /** Two sentences: what it is, and what makes it different. */
  summary: string;
  /** The developer-preview line every surface carries, verbatim. */
  status: string;
  license: string;
  /** The repository description (GitHub: at most 350 characters). */
  description: string;
  /** The repository topics (GitHub: at most 20, lower-case words joined by hyphens). */
  topics: readonly string[];
  /** The name's own story (concept B): a cited dictionary entry and the line it supports. */
  about: Readonly<{ word: string; partOfSpeech: string; definition: string; source: string; sourceUrl: string; line: string }>;
}>;

const TEXT_FIELDS = ["name", "promise", "summary", "status", "license", "description"] as const;
const ABOUT_FIELDS = ["word", "partOfSpeech", "definition", "source", "sourceUrl", "line"] as const;

/** Every way `document` breaks the messaging format. */
export function messagingViolations(document: unknown): readonly string[] {
  if (typeof document !== "object" || document === null || Array.isArray(document)) return ["the source is not a JSON object"];
  const record = document as Record<string, unknown>;
  const problems: string[] = [];
  const known = ["schema", "topics", "about", ...TEXT_FIELDS];
  for (const key of Object.keys(record)) if (!known.includes(key)) problems.push(`${key} is not a field of the messaging source`);
  if (record.schema !== MESSAGING_SCHEMA) problems.push(`schema must be ${MESSAGING_SCHEMA}`);
  for (const field of TEXT_FIELDS) if (typeof record[field] !== "string" || (record[field] as string).trim().length === 0) problems.push(`${field} is required`);
  if (typeof record.description === "string" && record.description.length > DESCRIPTION_MAX) problems.push(`description is ${record.description.length} characters; GitHub allows ${DESCRIPTION_MAX}`);
  if (typeof record.status === "string" && !/developer preview/iu.test(record.status)) problems.push("status must say it is a developer preview");
  if (typeof record.description === "string" && !/developer preview/iu.test(record.description)) problems.push("description must say it is a developer preview");
  if (!Array.isArray(record.topics) || record.topics.length === 0 || record.topics.length > TOPICS_MAX) problems.push(`topics must be 1 to ${TOPICS_MAX} topics`);
  else {
    for (const topic of record.topics) if (typeof topic !== "string" || !TOPIC.test(topic)) problems.push(`topic ${JSON.stringify(topic)} is not lower-case words joined by hyphens (at most 50 characters)`);
    if (new Set(record.topics).size !== record.topics.length) problems.push("a topic is listed twice");
  }
  const about = record.about as Record<string, unknown> | undefined;
  if (typeof about !== "object" || about === null) problems.push("about is required");
  else {
    for (const key of Object.keys(about)) if (!(ABOUT_FIELDS as readonly string[]).includes(key)) problems.push(`about.${key} is not a field of the name's story`);
    for (const field of ABOUT_FIELDS) if (typeof about[field] !== "string" || (about[field] as string).trim().length === 0) problems.push(`about.${field} is required`);
    if (typeof about.sourceUrl === "string" && !/^https:\/\/\S+$/u.test(about.sourceUrl)) problems.push("about.sourceUrl must be the https address the definition is quoted from");
  }
  // No promise words: the copy never names a date or a guarantee.
  for (const field of [...TEXT_FIELDS] as const) {
    const value = record[field];
    if (typeof value === "string" && /\b(?:guarantee[ds]?|will ship|coming soon|10x|blazing|revolutionary)\b|\b(?:19|20)\d\d-\d\d-\d\d\b/iu.test(value)) problems.push(`${field} makes a promise or names a date`);
  }
  return problems;
}

/** The messaging source of the repository at `root`, validated whole. */
export function readMessaging(root: string): Messaging {
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(join(root, MESSAGING_PATH), "utf8"));
  } catch (error) {
    throw new InputError(`${MESSAGING_PATH} cannot be read as JSON (${error instanceof Error ? error.message : String(error)})`, "messaging_source_invalid");
  }
  const problems = messagingViolations(document);
  if (problems.length > 0) throw new InputError(`${MESSAGING_PATH} breaks ${MESSAGING_SCHEMA}:\n${problems.join("\n")}`, "messaging_source_invalid");
  const coordinates = repositoryCoordinates(readFileSync(join(root, "package.json"), "utf8"));
  if (coordinates === null) throw new InputError("package.json repository.url names no GitHub repository: the public words have no address", "messaging_source_invalid");
  const { schema: _schema, ...words } = document as Record<string, unknown>;
  return Object.freeze({ ...words, repositoryUrl: coordinates.repositoryUrl, siteUrl: coordinates.siteUrl } as Messaging);
}
