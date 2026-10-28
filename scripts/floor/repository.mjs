/**
 * THE REPOSITORY AND ITS SITE — read from the repository's one declaration of
 * where it lives: `package.json` `repository.url` (the field the P1.10 rename
 * updates, and the one the community-file generator reads too). Nothing in the
 * site tooling, the site's pages or its configuration spells a repository
 * name or a site URL: the builder writes these values into `_config.yml`
 * (`repository_url`, `security_url`, `url`) and pages read them from there.
 *
 * The Pages URL is GitHub's rule for a project site: the owner, lower-cased,
 * under `github.io`, and the repository name as the base path.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const GITHUB_REPOSITORY_URL = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/u;

/**
 * The coordinates a `package.json` text declares, or a refusal naming the
 * field: a manifest with no GitHub `repository.url` has no site.
 */
export function repositoryCoordinates(manifestText) {
  const url = JSON.parse(manifestText)?.repository?.url;
  const match = typeof url === "string" ? GITHUB_REPOSITORY_URL.exec(url) : null;
  if (match === null) throw new Error(`package.json repository.url must be https://github.com/<owner>/<name>[.git], found ${JSON.stringify(url ?? null)}`);
  const [, owner, name] = match;
  const repositoryUrl = `https://github.com/${owner}/${name}`;
  const siteOrigin = `https://${owner.toLowerCase()}.github.io`;
  return Object.freeze({
    owner,
    name,
    repository: `${owner}/${name}`,
    repositoryUrl,
    defaultBranch: "main",
    siteOrigin,
    siteBaseurl: `/${name}`,
    siteUrl: `${siteOrigin}/${name}/`,
  });
}

/** The coordinates of the repository checked out at `root` (its `package.json`). */
export function coordinatesOf(root) {
  return repositoryCoordinates(readFileSync(join(root, "package.json"), "utf8"));
}

const COORDINATES = coordinatesOf(ROOT);

export const REPOSITORY = COORDINATES.repository;
export const REPOSITORY_URL = COORDINATES.repositoryUrl;
export const DEFAULT_BRANCH = COORDINATES.defaultBranch;
export const SITE_ORIGIN = COORDINATES.siteOrigin;
export const SITE_BASEURL = COORDINATES.siteBaseurl;
export const SITE_URL = COORDINATES.siteUrl;

/**
 * The base path the site answered at before the repository was renamed from
 * `bridlewise-testing` (a fact of its history, not a coordinate: Pages URLs
 * do not follow a rename, so the redirect site answers there).
 */
export const LEGACY_BASEURL = "/bridlewise-testing";

/**
 * The whole URL the site answered at before the rename: the owner's GitHub
 * Pages host (GitHub's rule: the owner, lower-cased, under `github.io`) and
 * {@link LEGACY_BASEURL}. After the rename the organisation site
 * (`<owner>.github.io`) is what answers there (`buildRedirectSite`).
 */
export function legacySiteUrl(coordinates = COORDINATES) {
  return `https://${coordinates.owner.toLowerCase()}.github.io${LEGACY_BASEURL}/`;
}
export const LEGACY_SITE_URL = legacySiteUrl();

/**
 * The names this project's public repositories have had: the source before
 * the rename, and the product repository it replaces. A page spelling either
 * would point at a repository that is not the one the site is built from.
 */
const NAMES_IN_HISTORY = Object.freeze([LEGACY_BASEURL.slice(1), "bridlewise"]);

/** A GitHub URL for a repository path on the default branch (`blob` for a file, `tree` for a folder). */
export function repositoryFileUrl(path, kind = "blob", coordinates = COORDINATES) {
  return `${coordinates.repositoryUrl}/${kind}/${coordinates.defaultBranch}/${path}`;
}

/**
 * Every spelled URL of this repository's own coordinates in `text`: its
 * GitHub URL and its Pages URL, under the current name and every name in its
 * history (case-insensitive, as GitHub and DNS treat them), each with its
 * kind:
 * - `site`: the Pages site;
 * - `object`: a GitHub object with its own id (an issue, a pull request, a
 *   discussion, a commit, a release tag, a run, an advisory); GitHub keeps
 *   such a link working through a rename, and a record cites it by id;
 * - `repository`: anything else — the repository itself, a file or folder in
 *   it, a settings or listing page.
 */
export function spelledUrls(text, coordinates) {
  const names = [...new Set([coordinates.name, ...NAMES_IN_HISTORY])].map((name) => name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  const owner = coordinates.owner.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  // Two named alternatives, so the kind is which one matched (never a
  // substring test on the text).
  const pattern = new RegExp(`(?:(?<github>github\\.com/${owner}/)|(?<pages>${owner}\\.github\\.io/))(?:${names.join("|")})(?![\\w.-])(?<path>/[^\\s)"'<>\\]]*)?`, "giu");
  // The id ends the path (a pull request's own tabs and a run's job aside):
  // no `..` or further segment can walk from an object to a file.
  const OBJECT = /^\/(?:(?:issues|discussions|commit|security\/advisories)\/[0-9A-Za-z-]+|pull\/\d+(?:\/(?:files|commits|checks))?|actions\/runs\/\d+(?:\/job\/\d+)?|releases\/tag\/[0-9A-Za-z._-]+)\/?(?:[#?][^\s]*)?$/u;
  return [...text.matchAll(pattern)].map((match) => ({
    url: match[0],
    kind: match.groups.pages !== undefined ? "site" : OBJECT.test(match.groups.path ?? "") ? "object" : "repository",
  }));
}
