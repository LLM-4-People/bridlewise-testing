/**
 * THE REPOSITORY AND ITS SITE — the coordinates the site tooling uses, read
 * from the ONE repository identity (`engine/src/workflow/forge/repository-identity.ts`,
 * derived from the forge section's trunk; the P1.10 rename changes that one
 * value), through the plain JSON `harness sync` generates from it
 * (`.github/forge/repository-identity.json`): the site tooling and the link
 * check run with no dependency installed. That module owns the address rules, the Pages rule among them; this
 * one only shapes them for the site. Nothing in the site tooling, the site's
 * pages or its configuration spells a repository name or a site URL: the
 * builder writes these values into `_config.yml` (`repository_url`,
 * `security_url`, `url`) and pages read them from there.
 */
import { readFileSync } from "node:fs";

/**
 * THE ONE READER of the generated repository identity (owner, name,
 * fullName, webUrl, pagesUrl, pagesBasePath, docsUrl, organisationRepositories). A
 * missing or malformed file is a loud failure (run harness sync), never a
 * guess.
 */
export function generatedRepositoryIdentity() {
  const path = new URL("../../.github/forge/repository-identity.json", import.meta.url);
  const identity = JSON.parse(readFileSync(path, "utf8"));
  const text = (value) => typeof value === "string" && value !== "";
  const repository = (value) => typeof value === "object" && value !== null && [value.name, value.fullName, value.webUrl, value.pagesUrl, value.docsUrl].every(text);
  // The base path is empty on the site's own host (`site`), `/name` on the forge's Pages domain.
  if (![identity.owner, identity.name, identity.fullName, identity.webUrl, identity.pagesUrl, identity.docsUrl].every(text) || typeof identity.pagesBasePath !== "string"
    || !Array.isArray(identity.organisationRepositories) || !identity.organisationRepositories.every(text)
    || !repository(identity.product) || !(identity.preview === null || repository(identity.preview))) {
    throw new Error(`${path.pathname} is not the generated repository identity: run harness sync`);
  }
  return Object.freeze(identity);
}

/** The site's coordinates for a repository identity (`repositoryIdentity(settings)`'s answer). */
export function siteCoordinates(identity) {
  return Object.freeze({
    owner: identity.owner,
    name: identity.name,
    repository: identity.fullName,
    repositoryUrl: identity.webUrl,
    defaultBranch: "main",
    siteOrigin: new URL(identity.pagesUrl).origin,
    siteBaseurl: identity.pagesBasePath,
    siteUrl: identity.pagesUrl,
    // The site's own host when the trunk declares one (`site.host`), else none: its project site is on the forge's domain.
    siteHost: identity.pagesBasePath === "" ? new URL(identity.pagesUrl).host : "",
    docsUrl: identity.docsUrl,
    // The product's repository and the preview repository: identities of their own (the forge section's flags).
    productRepository: identity.product.fullName,
    productRepositoryUrl: identity.product.webUrl,
    previewRepositoryUrl: identity.preview === null || identity.preview === undefined ? "" : identity.preview.webUrl,
  });
}

/** This checkout's coordinates: the configured repository identity. */
export const COORDINATES = siteCoordinates(generatedRepositoryIdentity());

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
 * - `site`: the Pages site (on the forge's Pages domain, or the site's own
 *   host when the trunk declares one: `bridlewise.llm4people.dev`);
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
  const spelled = [...text.matchAll(pattern)].map((match) => ({
    url: match[0],
    kind: match.groups.pages !== undefined ? "site" : OBJECT.test(match.groups.path ?? "") ? "object" : "repository",
  }));
  // The site's own host (a custom domain), spelled by hand: the site's address too, whatever the path.
  if (coordinates.siteHost !== undefined && coordinates.siteHost !== "") {
    const host = coordinates.siteHost.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    for (const match of text.matchAll(new RegExp(`(?<![\\w.-])${host}(?![\\w-])(?:/[^\\s)"'<>\\]]*)?`, "giu"))) spelled.push({ url: match[0], kind: "site" });
  }
  return spelled;
}
