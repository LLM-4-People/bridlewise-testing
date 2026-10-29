/**
 * THE WORDS A SURFACE RENDERS: the messaging source (engine/src/workflow/
 * messaging.ts) together with the repository's and the site's addresses,
 * which are not words and are never restated in it: their one declaration is
 * `package.json` `repository.url`, read through the site's coordinates owner
 * (scripts/floor/repository.mjs, the same reader the Pages build uses).
 *
 * A page the site build serves names neither address at all: it reads
 * `site.repository_url` and the site's own relative URLs (render.ts).
 */
import { readMessaging, type Messaging } from "../../src/workflow/messaging.ts";
// @ts-expect-error -- the site's coordinates owner is plain Node ESM with no declaration file (as in tests/prevention/pwa.test.ts).
import { coordinatesOf } from "../../../scripts/floor/repository.mjs";

export type Words = Messaging & Readonly<{
  /** `https://github.com/<owner>/<repository>`, no trailing slash. */
  repositoryUrl: string;
  /** The site's root, with a trailing slash. */
  siteUrl: string;
}>;

/** The messaging source of the repository at `root`, with its addresses from `package.json`. */
export function readWords(root: string): Words {
  const coordinates = (coordinatesOf as (root: string) => { repositoryUrl: string; siteUrl: string })(root);
  return Object.freeze({ ...readMessaging(root), repositoryUrl: coordinates.repositoryUrl, siteUrl: coordinates.siteUrl });
}
