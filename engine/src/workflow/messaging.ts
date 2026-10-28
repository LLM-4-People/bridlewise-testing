/**
 * THE MESSAGING SOURCE — the project's public words and identity in one file
 * (`docs/brand/messaging.json`): the name, the promise, the
 * summary, what this repository is, the honest status line, the licence, the
 * site's description, and the name's own story (the dictionary entry). Every
 * generated surface reads it: the README's and the site home's front blocks
 * and the site's title and description (written by `harness sync`, judged by
 * `harness check`), the org profile, the release-note header, the claims page,
 * the roadmap and (through DESIGN's renderers) the social images. None
 * restates a word of it. It is a REQUIRED input: a tree that carries the brand
 * generator and not this file is refused, by name, never passed in silence. The addresses are not words: the
 * repository's and the site's come from `package.json` `repository.url`,
 * their one declaration (scripts/floor/repository.mjs).
 *
 * It lives in the runtime layer so `harness check` and the builder-layer
 * renderers (engine/scripts/brand/) share one reader, and one statement of the
 * files the front doors are made from (`frontDoorInput`).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { InputError } from "../kernel/errors.ts";

export const MESSAGING_PATH = "docs/brand/messaging.json";
export const MESSAGING_SCHEMA = "bridlewise-messaging/v1";
/** The longest description the site's pages carry as their meta description. */
const DESCRIPTION_MAX = 350;

export type Messaging = Readonly<{
  name: string;
  /** The one-line promise (concept A): what every surface leads with. */
  promise: string;
  /** Two sentences: what it is, and what makes it different. */
  summary: string;
  /** One or two sentences: what THIS repository is, in the same words every front door uses. */
  repository: string;
  /** The developer-preview line every surface carries, verbatim. */
  status: string;
  license: string;
  /** The repository description (GitHub: at most 350 characters). */
  description: string;
  /** The name's own story (concept B): a cited dictionary entry and the line it supports. */
  about: Readonly<{ word: string; partOfSpeech: string; definition: string; source: string; sourceUrl: string; line: string }>;
}>;

const TEXT_FIELDS = ["name", "promise", "summary", "repository", "status", "license", "description"] as const;
const ABOUT_FIELDS = ["word", "partOfSpeech", "definition", "source", "sourceUrl", "line"] as const;

/** Every way `document` breaks the messaging format. */
export function messagingViolations(document: unknown): readonly string[] {
  if (typeof document !== "object" || document === null || Array.isArray(document)) return ["the source is not a JSON object"];
  const record = document as Record<string, unknown>;
  const problems: string[] = [];
  // The repository's and the site's addresses are not words: package.json repository.url is their one declaration.
  const known = ["schema", "about", ...TEXT_FIELDS];
  for (const key of Object.keys(record)) if (!known.includes(key)) problems.push(`${key} is not a field of the messaging source`);
  if (record.schema !== MESSAGING_SCHEMA) problems.push(`schema must be ${MESSAGING_SCHEMA}`);
  for (const field of TEXT_FIELDS) if (typeof record[field] !== "string" || (record[field] as string).trim().length === 0) problems.push(`${field} is required`);
  if (typeof record.description === "string" && record.description.length > DESCRIPTION_MAX) problems.push(`description is ${record.description.length} characters; GitHub allows ${DESCRIPTION_MAX}`);
  if (typeof record.status === "string" && !/developer preview/iu.test(record.status)) problems.push("status must say it is a developer preview");
  if (typeof record.description === "string" && !/developer preview/iu.test(record.description)) problems.push("description must say it is a developer preview");
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
  if (!existsSync(join(root, MESSAGING_PATH))) {
    throw new InputError(`${MESSAGING_PATH} is missing: the README's and the site's front doors, the site's title and description and the claims are made from it`, "messaging_source_missing");
  }
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(join(root, MESSAGING_PATH), "utf8"));
  } catch (error) {
    throw new InputError(`${MESSAGING_PATH} cannot be read as JSON (${error instanceof Error ? error.message : String(error)})`, "messaging_source_invalid");
  }
  const problems = messagingViolations(document);
  if (problems.length > 0) throw new InputError(`${MESSAGING_PATH} breaks ${MESSAGING_SCHEMA}:\n${problems.join("\n")}`, "messaging_source_invalid");
  return Object.freeze(document as Messaging);
}

/** The claims register, beside the messaging source. */
export const CLAIMS_PATH = "docs/brand/claims.json";
/** The decision records a designed claim names. */
const DECISIONS_DIRECTORY = "docs/decisions";
/** The files the front doors are written into, and the readers outside the engine they are made with. */
const FRONT_DOOR_FILES = Object.freeze(["README.md", "docs/index.md", "docs/floor/claims.md", "package.json", "scripts/floor/repository.mjs"]);

/** The repository file a claim's evidence names (its `#anchor` dropped), or null for an https address. */
export function evidencePath(evidence: string): string | null {
  return evidence.startsWith("https://") ? null : evidence.split("#")[0]!;
}

/**
 * Every repository path the front doors are made from, beyond the engine: the
 * two sources (`docs/brand/`), the decision records, the files the blocks are
 * written into, the addresses' owner, and every file a claim cites as its
 * evidence (read from the register of the checkout this module is in). A
 * generator test's repository copy carries exactly these
 * (`GENERATOR_INPUTS_BEYOND_ENGINE`).
 */
export function frontDoorInput(path: string): boolean {
  if (path.startsWith("docs/brand/") || path.startsWith(`${DECISIONS_DIRECTORY}/`) || FRONT_DOOR_FILES.includes(path)) return true;
  return citedEvidence().has(path);
}

let cited: ReadonlySet<string> | undefined;
function citedEvidence(): ReadonlySet<string> {
  if (cited === undefined) {
    const register = JSON.parse(readFileSync(join(fileURLToPath(new URL("../../..", import.meta.url)), CLAIMS_PATH), "utf8")) as { claims?: readonly { evidence?: unknown }[] };
    cited = new Set((register.claims ?? []).flatMap((claim) => (typeof claim.evidence === "string" ? [evidencePath(claim.evidence)] : [])).filter((path): path is string => path !== null));
  }
  return cited;
}
