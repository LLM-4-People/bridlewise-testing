/**
 * THE WORDS A SURFACE RENDERS: the messaging source (engine/src/workflow/
 * messaging.ts) together with the repository's and the site's addresses,
 * which are not words and are never restated in it: their one declaration is
 * the repository identity (the forge section, generated as
 * .github/forge/repository-identity.json), read through the site's
 * coordinates owner (scripts/floor/repository.mjs, the same reader the Pages
 * build uses).
 *
 * A page the site build serves names neither address at all: it reads
 * `site.repository_url` and the site's own relative URLs (render.ts).
 */
import { readMessaging, type Messaging } from "../../src/workflow/messaging.ts";
// @ts-expect-error -- the site's coordinates owner is plain Node ESM with no declaration file (as in tests/prevention/pwa.test.ts).
import { COORDINATES } from "../../../scripts/floor/repository.mjs";

export type Words = Messaging & Readonly<{
  /** `https://github.com/<owner>/<repository>`, no trailing slash. */
  repositoryUrl: string;
  /** The site's root, with a trailing slash. */
  siteUrl: string;
}>;

/** The messaging source of the repository at `root`, with its addresses from the repository identity. */
export function readWords(root: string): Words {
  const coordinates = COORDINATES as Readonly<{ repositoryUrl: string; siteUrl: string }>;
  return Object.freeze({ ...readMessaging(root), repositoryUrl: coordinates.repositoryUrl, siteUrl: coordinates.siteUrl });
}
