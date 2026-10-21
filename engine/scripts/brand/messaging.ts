/**
 * THE MESSAGING SOURCE — the project's public identity in one file
 * (`docs/brand/messaging.json`): its name and the addresses every generated
 * surface links to. The README blocks, the site pages, the roadmap, the org
 * profile, the repository description and the social images read it; none
 * restates a name or a URL. Renaming the repository or moving the site is a
 * one-line change here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { InputError } from "../../src/kernel/errors.ts";

export const MESSAGING_PATH = "docs/brand/messaging.json";
export const MESSAGING_SCHEMA = "bridlewise-messaging/v1";

export type Messaging = Readonly<{
  name: string;
  /** `https://github.com/<owner>/<repository>`, no trailing slash. */
  repositoryUrl: string;
  /** The site's root, with a trailing slash. */
  siteUrl: string;
}>;

/** Every way `document` breaks the messaging format. */
export function messagingViolations(document: unknown): readonly string[] {
  if (typeof document !== "object" || document === null || Array.isArray(document)) return ["the source is not a JSON object"];
  const record = document as Record<string, unknown>;
  const problems: string[] = [];
  const known = ["schema", "name", "repositoryUrl", "siteUrl"];
  for (const key of Object.keys(record)) if (!known.includes(key)) problems.push(`${key} is not a field of the messaging source`);
  if (record.schema !== MESSAGING_SCHEMA) problems.push(`schema must be ${MESSAGING_SCHEMA}`);
  if (typeof record.name !== "string" || record.name.trim().length === 0) problems.push("name is required");
  if (typeof record.repositoryUrl !== "string" || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/u.test(record.repositoryUrl)) problems.push("repositoryUrl must be https://github.com/<owner>/<repository> with no trailing slash");
  if (typeof record.siteUrl !== "string" || !/^https:\/\/\S+\/$/u.test(record.siteUrl)) problems.push("siteUrl must be an https URL ending in /");
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
  const { name, repositoryUrl, siteUrl } = document as Messaging;
  return Object.freeze({ name, repositoryUrl, siteUrl });
}
