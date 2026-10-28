/**
 * THE SITE'S PUBLISH PLAN AND LINK MAP — one owner.
 *
 * The one Pages site is built from ONE source: this repository's `docs/`
 * tree. Every Markdown file under `docs/` is a page unless its front matter
 * says `published: false`; its URL is its front-matter `permalink`, or the
 * pretty URL its path gives (`docs/a/b.md` → `/a/b/`; an `index.md` or a
 * `README.md` is its folder's page). Two pages answering one URL is a refusal,
 * never a silent winner.
 *
 * A relative link in a page is written for GitHub, where it resolves against
 * the repository tree; the site page lives at its pretty URL, one or more
 * path segments away from the source file. The builder rewrites the BUILT
 * copy (the committed Markdown is never touched) by one rule:
 *   - a published docs page → its site URL;
 *   - a file the site serves under `docs/` (an asset) → its site URL;
 *   - anything else in the repository (an unpublished page, a script, a test,
 *     a workflow) → its GitHub URL;
 *   - a target that does not exist → an error naming the page and the link.
 *
 * Used by `scripts/floor/site.mjs` (the builder) and
 * `scripts/check-docs-links.mjs` (the same rule judged in the normal test run,
 * so a link the build would refuse is red before any build).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { posix, resolve } from "node:path";

import { coordinatesOf, repositoryFileUrl, spelledUrls } from "./repository.mjs";

/** The site's only source folder, repository-relative. */
export const DOCS_ROOT = "docs";

/**
 * Pages that moved, as `old URL → new URL` (site-relative, with their
 * trailing slash). Each old URL is served as a redirect page, never as a
 * second copy of the content.
 */
export const MOVED_PAGES = Object.freeze(new Map([
  ["/product/", "/"],
  ["/roadmap/", "/floor/roadmap/"],
]));

const MARKDOWN_LINK = /(!?\[[^\]]*\]\()([^)\s]+)((?:\s+"[^"]*")?\))/gu;
const EXTERNAL_OR_ABSOLUTE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#|\{\{|\{%|<)/iu;
const FENCE = /^\s*(?:```|~~~)/u;

/** Whether `text` opens with a YAML front matter block. */
export function hasFrontMatter(text) {
  return text.startsWith("---\n") || text.startsWith("---\r\n");
}

/** The page text and its front matter's top-level scalar fields. */
export function readPage(file) {
  const text = readFileSync(file, "utf8");
  const data = {};
  if (hasFrontMatter(text)) {
    const opening = text.startsWith("---\r\n") ? 4 : 3;
    const end = text.indexOf("\n---", opening);
    if (end !== -1) {
      for (const line of text.slice(opening, end).split(/\r?\n/u)) {
        const match = /^([A-Za-z0-9_-]+):\s*(.*)$/u.exec(line);
        if (match === null) continue;
        let value = match[2].trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        data[match[1]] = value;
      }
    }
  }
  return { text, data };
}

function normalizePermalink(permalink) {
  const withLeading = permalink.startsWith("/") ? permalink : `/${permalink}`;
  // A page file (`/404.html`) keeps its extension; a pretty page closes with
  // a slash. Both are spelled the way Jekyll publishes them.
  if (withLeading.endsWith("/") || /\.[a-z0-9]+$/iu.test(withLeading)) return withLeading;
  return `${withLeading}/`;
}

/** The pretty URL a docs-relative Markdown path gives (`index.md` and `README.md` are their folder's page). */
export function prettyPermalink(docsPath) {
  const relative = docsPath.replace(/^docs\//u, "").replace(/\.md$/iu, "");
  const folderPage = /(?:^|\/)(?:index|README)$/u.exec(relative);
  if (folderPage !== null) {
    const folder = relative.slice(0, folderPage.index);
    return folder.length === 0 ? "/" : `/${folder}/`;
  }
  return `/${relative}/`;
}

/** A site URL (with the deployment base path) for a page permalink. */
export function siteUrlForPermalink(permalink, baseurl = "") {
  const base = baseurl.replace(/\/+$/u, "");
  const path = permalink.startsWith("/") ? permalink : `/${permalink}`;
  if (base.length === 0) return path;
  return path === "/" ? `${base}/` : `${base}${path}`;
}

/** Resolve a link target against the page's docs path; `null` when it is not Markdown under docs/. */
export function resolveDocsTarget(pageDocsPath, target) {
  if (EXTERNAL_OR_ABSOLUTE.test(target)) return null;
  const withoutHash = target.split("#")[0].split("?")[0];
  if (!/\.md$/iu.test(withoutHash)) return null;
  const resolved = posix.normalize(posix.join(posix.dirname(pageDocsPath), withoutHash));
  return resolved.startsWith(`${DOCS_ROOT}/`) ? resolved : null;
}

function markdownFiles(root) {
  const out = [];
  const visit = (relative) => {
    const directory = resolve(root, ...relative.split("/"));
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && entry.name.endsWith(".md")) out.push(child);
    }
  };
  visit(DOCS_ROOT);
  return out;
}

/**
 * THE PUBLISH PLAN of the tree at `root`: every docs Markdown file with its
 * permalink (`null` when `published: false`), and a map from each published
 * permalink to its page. Two pages answering one URL refuse the plan.
 */
export function sitePlan({ root }) {
  const coordinates = coordinatesOf(root);
  const pages = new Map();
  const byPermalink = new Map();
  const collisions = [];
  for (const docsPath of markdownFiles(root)) {
    const file = resolve(root, ...docsPath.split("/"));
    const { text, data } = readPage(file);
    const published = String(data["published"]).toLowerCase() !== "false";
    const permalink = !published
      ? null
      : typeof data["permalink"] === "string" && data["permalink"].length > 0
        ? normalizePermalink(data["permalink"])
        : prettyPermalink(docsPath);
    const page = { docsPath, file, permalink, frontMatter: hasFrontMatter(text) };
    pages.set(docsPath, page);
    if (permalink === null) continue;
    const owner = byPermalink.get(permalink);
    if (owner !== undefined) collisions.push(`${owner.docsPath} and ${docsPath} both publish ${permalink}`);
    else byPermalink.set(permalink, page);
  }
  for (const [from] of MOVED_PAGES) {
    const owner = byPermalink.get(from);
    if (owner !== undefined) collisions.push(`${owner.docsPath} publishes ${from}, which the site serves as a moved-page redirect`);
  }
  return { pages, byPermalink, collisions, coordinates };
}

/** The published page for a docs-relative Markdown path, or `null` when the site does not publish it. */
export function publishedDocsPage({ docsPath, root, plan = sitePlan({ root }) }) {
  const page = plan.pages.get(docsPath);
  if (page === undefined || page.permalink === null) return null;
  return { sourceFile: page.file, permalink: page.permalink };
}

/** Whether Jekyll serves a static file at this docs-relative path (it skips `_`- and `.`-prefixed names but `.well-known`). */
function servedStatic(docsRelative) {
  return docsRelative.split("/").every((segment) => segment === ".well-known" || !/^[_.]/u.test(segment));
}

/**
 * Rewrite one relative target by the header's rule: `{ target }` (the link to
 * write) or `{ error }` (the link names nothing).
 */
export function rewriteTarget(target, { pageDocsPath, root, baseurl = "", plan }) {
  if (EXTERNAL_OR_ABSOLUTE.test(target)) return { target };
  const hashIndex = target.indexOf("#");
  const hash = hashIndex === -1 ? "" : target.slice(hashIndex);
  const pathPart = (hashIndex === -1 ? target : target.slice(0, hashIndex)).split("?")[0];
  if (pathPart.length === 0) return { target };
  const repoPath = posix.normalize(posix.join(posix.dirname(pageDocsPath), pathPart)).replace(/\/+$/u, "");
  if (repoPath === ".." || repoPath.startsWith("../")) {
    return { error: `${pageDocsPath}: link '${target}' leaves the repository` };
  }
  const file = resolve(root, ...repoPath.split("/"));
  if (!existsSync(file)) {
    return { error: `${pageDocsPath}: link '${target}' names ${repoPath}, which does not exist` };
  }
  const directory = statSync(file).isDirectory();
  if (repoPath === DOCS_ROOT || repoPath.startsWith(`${DOCS_ROOT}/`)) {
    if (directory) {
      for (const name of ["index.md", "README.md"]) {
        const page = publishedDocsPage({ docsPath: posix.join(repoPath, name), root, plan });
        if (page !== null) return { target: `${siteUrlForPermalink(page.permalink, baseurl)}${hash}` };
      }
    } else if (repoPath.endsWith(".md")) {
      const page = publishedDocsPage({ docsPath: repoPath, root, plan });
      if (page !== null) return { target: `${siteUrlForPermalink(page.permalink, baseurl)}${hash}` };
    } else {
      const docsRelative = repoPath.slice(DOCS_ROOT.length + 1);
      if (servedStatic(docsRelative)) return { target: `${siteUrlForPermalink(`/${docsRelative}`, baseurl)}${hash}` };
    }
  }
  return { target: `${repositoryFileUrl(repoPath, directory ? "tree" : "blob", plan.coordinates)}${hash}` };
}

/**
 * Rewrite every relative Markdown link of one page (links inside fenced code
 * are text, not links, and stay as written). Answers the new text, how many
 * links moved, and every link that names nothing.
 */
export function rewritePageLinks(markdown, options) {
  let rewritten = 0;
  const errors = [];
  let fenced = false;
  const lines = markdown.split("\n").map((line) => {
    if (FENCE.test(line)) {
      fenced = !fenced;
      return line;
    }
    if (fenced) return line;
    return line.replace(MARKDOWN_LINK, (whole, prefix, target, suffix) => {
      const answer = rewriteTarget(target, options);
      if (answer.error !== undefined) {
        errors.push(answer.error);
        return whole;
      }
      if (answer.target !== target) rewritten += 1;
      return `${prefix}${answer.target}${suffix}`;
    });
  });
  return { text: lines.join("\n"), rewritten, errors };
}

/**
 * The redirect pages the site serves for older URL shapes: each page's
 * GitHub-style `.md` spelling, the trackers' former `/floor/trackers/` home,
 * and {@link MOVED_PAGES}. Answers `[alias, permalink]` pairs; an alias that
 * is itself a page's URL is never redirected.
 */
export function legacyAliases(plan) {
  const aliases = new Map();
  for (const page of plan.byPermalink.values()) {
    if (page.permalink === "/" || !page.permalink.endsWith("/")) continue;
    aliases.set(`${page.permalink.replace(/\/$/u, "")}.md`, page.permalink);
    if (page.docsPath.startsWith(`${DOCS_ROOT}/trackers/`)) {
      const base = page.docsPath.split("/").pop().replace(/\.md$/u, "");
      aliases.set(`/floor/trackers/${base}.md`, page.permalink);
      aliases.set(`/floor/trackers/${base}/`, page.permalink);
    }
  }
  for (const [from, to] of MOVED_PAGES) aliases.set(from, to);
  return [...aliases].filter(([alias]) => !plan.byPermalink.has(alias)).sort(([a], [b]) => a.localeCompare(b));
}

const LANDING_MAPS = new WeakMap();

/**
 * THE LANDING MAP of a plan, the one answer to "where does an old site path
 * land now": every {@link legacyAliases} pair (the `.md` spellings, the
 * trackers' former home and {@link MOVED_PAGES}), frozen and computed once
 * per plan. The trunk's redirect pages and the organisation's redirect site
 * (`buildRedirectSite`) both read it, so an old link lands in ONE hop.
 */
export function landingMap(plan) {
  let map = LANDING_MAPS.get(plan);
  if (map === undefined) {
    map = Object.freeze(new Map(legacyAliases(plan)));
    LANDING_MAPS.set(plan, map);
  }
  return map;
}

/** Where the old site path `oldPath` lands now ({@link landingMap}): its alias's page, or the same path. */
export function landingPath(oldPath, plan) {
  return landingMap(plan).get(oldPath) ?? oldPath;
}

/**
 * The `_config.yml` keys the builder writes from the repository's one
 * declaration (`repository.mjs`) and the deployment: the builder refuses a
 * source config that declares one (a second owner of that value).
 */
export const BUILDER_OWNED_CONFIG_KEYS = Object.freeze(["url", "baseurl", "repository", "repository_url", "security_url", "versions_url", "release_version"]);

/**
 * The record collections under `docs/`: data and dated records the site
 * renders but other owners write. A record may cite a GitHub object by its
 * URL (GitHub keeps it working through a rename, and the id is the citation);
 * every other spelling of the repository's coordinates is refused there too.
 * The site's own pages, layout, configuration and text files may spell none.
 */
export const RECORD_ROOTS = Object.freeze([
  Object.freeze({ root: "docs/decisions/", why: "decision records cite the issue or pull request that decided them" }),
  Object.freeze({ root: "docs/community/", why: "the community generator's inputs (GH-9): feature and intake status cites the tracking issue" }),
  Object.freeze({ root: "docs/trackers/", why: "tracker items and their board cite the issue each one mirrors" }),
  Object.freeze({ root: "docs/findings/", why: "dated findings cite the issue or run that reproduced them" }),
]);

/**
 * Every site path a text names, as Jekyll would emit it, with the forms the
 * site uses or could: a Liquid literal through any filter chain
 * (`{{ '/p' | relative_url }}`, `| absolute_url`, `| append: … |
 * relative_url`, `| prepend: site.baseurl`), a path written after the base
 * (`{{ site.baseurl }}/p`, `{{ site.url }}{{ site.baseurl }}/p`), and — on a
 * page whose URL is known — a relative `href`/`src` or Markdown target,
 * resolved against that URL. Fenced code names nothing. Answers site-root
 * paths (`/p`).
 */
export function siteLinkTargets(text, pageUrl = null) {
  // Fenced code is text, not links (the same rule as the rewrite).
  let fenced = false;
  text = text.split("\n").map((line) => {
    if (FENCE.test(line)) {
      fenced = !fenced;
      return "";
    }
    return fenced ? "" : line;
  }).join("\n");
  const targets = [];
  for (const match of text.matchAll(/\{\{-?\s*(["'])(\/[^"'{}]*)\1\s*\|[^}]*?\}\}/gu)) {
    if (/\|\s*(?:relative_url|absolute_url|prepend:\s*site\.(?:baseurl|url))\b/u.test(match[0])) targets.push(match[2]);
  }
  for (const match of text.matchAll(/\{\{-?\s*site\.baseurl\s*-?\}\}(\/[^\s"'<>)\]]*)/gu)) targets.push(match[1]);
  if (pageUrl !== null) {
    for (const match of text.matchAll(/(?:(?<![\w-])(?:href|src)\s*=\s*["']|\]\()([^"'\s)]+)/gu)) {
      const target = match[1];
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#|\{)/iu.test(target)) continue;
      targets.push(posix.normalize(posix.join(pageUrl.endsWith("/") ? pageUrl : posix.dirname(pageUrl), target.split(/[?#]/u)[0])));
    }
  }
  return targets.map((target) => target.split(/[?#]/u)[0]);
}

/** Whether a site path lies in the released versions' folder (the `/v/` tree or `versions.json`). */
export function inVersionsFolder(sitePath) {
  return sitePath === "/v" || sitePath.startsWith("/v/") || sitePath === "/versions.json";
}
const TEXT_FILE = /\.(?:md|markdown|html?|txt|json|ya?ml|xml|js|css|svg)$/iu;

function textFiles(root) {
  const out = [];
  const visit = (relative) => {
    for (const entry of readdirSync(resolve(root, ...relative.split("/")), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && TEXT_FILE.test(entry.name)) out.push(child);
    }
  };
  visit(DOCS_ROOT);
  return out;
}

/**
 * Every way the tree at `root` would refuse the build — the docs-links half
 * of the site, the same question the builder asks:
 * - two pages for one URL, and a moved URL a page still publishes;
 * - a relative link of a published page that names nothing;
 * - a source file that spells the repository's own GitHub or Pages URL (the
 *   one declaration is `package.json`; pages read `site.repository_url`,
 *   `site.url` and `site.baseurl`, links into the tree stay relative);
 * - any link into the released versions' folder, in any form
 *   ({@link siteLinkTargets}): inside a release snapshot it would resolve
 *   under the snapshot, where no versions page exists (`site.versions_url`
 *   names the live one).
 * It reads no dependency, so `npm run docs:links` runs before any install;
 * the builder adds the configuration's own refusals (`site.mjs`).
 */
export function siteSourceViolations({ root }) {
  const plan = sitePlan({ root });
  const violations = [...plan.collisions];
  for (const page of plan.byPermalink.values()) {
    const { errors } = rewritePageLinks(readFileSync(page.file, "utf8"), { pageDocsPath: page.docsPath, root, plan });
    violations.push(...errors);
  }
  for (const path of textFiles(root)) {
    const text = readFileSync(resolve(root, ...path.split("/")), "utf8");
    const record = RECORD_ROOTS.some(({ root: recordRoot }) => path.startsWith(recordRoot));
    const page = plan.pages.get(path);
    const pageUrl = page === undefined ? null : page.permalink;
    // A fenced block is text: its lines name no link (judged per line below).
    let fence = false;
    const fenced = text.split("\n").map((line) => (FENCE.test(line) ? ((fence = !fence), true) : fence));
    text.split("\n").forEach((line, index) => {
      for (const { url, kind } of spelledUrls(line, plan.coordinates)) {
        if (record && kind === "object") continue;
        violations.push(record
          ? `${path}:${String(index + 1)}: spells ${url}; a record cites a repository file or folder by a relative link and the site by its own pages (only a GitHub object — an issue, a pull request, a discussion, a commit, a release, a run — is cited by URL)`
          : `${path}:${String(index + 1)}: spells the repository's own URL (${url}); use site.repository_url, site.url and site.baseurl, or a relative link (package.json repository.url is the one declaration)`);
      }
      for (const target of fenced[index] ? [] : siteLinkTargets(line, pageUrl)) {
        if (inVersionsFolder(target)) violations.push(`${path}:${String(index + 1)}: links ${target} in the versions folder, which a release snapshot resolves under itself; use site.versions_url`);
      }
    });
  }
  return violations;
}
