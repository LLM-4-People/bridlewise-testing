/**
 * THE SITE'S PUBLISH PLAN AND LINK MAP — one owner.
 *
 * The one Pages site is built from ONE source: this repository's `docs/`
 * tree. Markdown and front-matter HTML pages share one plan. The route
 * declaration names live-only page identities and the docs home; the
 * repository identity supplies the docs prefix. A snapshot drops live-only
 * pages and uses its own root for docs. Every built page receives its derived
 * permalink. Two pages answering one URL refuse; no producer silently wins.
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
 * The rendered stage in `scripts/floor/site.mjs` resolves actual attributes
 * after the configured Markdown engine runs. The source gate checks this
 * plan and coordinate ownership, without approximating that renderer.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { htmlWithout } from "../../shared/markup.ts";
import { SERVED_HTML } from "../../shared/site-page.ts";
import { DOCS_ROOT, PAGE_CONTENT, PAGE_ROUTES, SITE_LINK_PREFIX, SITE_URL_HISTORY, hasFrontMatter, pagePath, readPage, readSiteRoutes, readSiteSources, relativePageKey, siteLinkPath, siteRecord } from "../../engine/src/workflow/site-sources.ts";
export { DOCS_ROOT, PAGE_ROUTES, SITE_URL_HISTORY, hasFrontMatter, readPage };

import { COORDINATES, generatedRepositoryIdentity, repositoryFileUrl, siteCoordinates, spelledUrls } from "./repository.mjs";
import { existingSiteFiles, htmlPages, sha256File } from "./files.mjs";

/** The source checkout of this tooling, independent of its caller's current directory. */
export const SITE_SOURCE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
/** The released documentation namespace accepts semantic-version directory names. */
export const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/u;
/** The builder's served source-ID projection; consumers do not maintain another route registry. */
export const SITE_PLAN_FILE = "site-pages.json";
const SITE_PLAN_SCHEMA = "bridlewise-site-publish-plan/v1";

export function sitePlanProjection({ plan, baseurl, release = null }) {
  return { schemaVersion: SITE_PLAN_SCHEMA, phase: "source", baseurl, release, coordinates: plan.coordinates,
    pages: Object.fromEntries([...plan.bySource.values()].filter((page) => page.output).map((page) => [page.docsPath, { permalink: page.permalink, artifact: page.artifact === true,
      sourceSha256: sha256File(page.file) }])),
    previousPages: plan.history.pages };
}

/**
 * One reader for the generated artifact plan; a phase is a build state, never a qualification receipt.
 * @param {import("../../engine/src/workflow/site-sources.ts").SitePlanProjectionOptions} options
 * @returns {import("../../engine/src/workflow/site-sources.ts").SitePlanProjectionRecord}
 */
export function readSitePlanProjection({ site, phase = null, root = null, baseurl = null, release = null, coordinates = COORDINATES }) {
  const record = siteRecord(site, SITE_PLAN_FILE);
  const mapping = (value, check) => value !== null && typeof value === "object" && !Array.isArray(value) && Object.entries(value).every(([key, item]) => relativePageKey(key) && check(item));
  if (record === null || typeof record !== "object" || Array.isArray(record)
    || record.schemaVersion !== SITE_PLAN_SCHEMA || !["source", "links-resolved"].includes(record.phase)
    || typeof record.baseurl !== "string" || !(record.baseurl === "" || pagePath(record.baseurl))
    || !(record.release === null || (typeof record.release === "string" && RELEASE_VERSION.test(record.release)))
    || record.coordinates === null || typeof record.coordinates !== "object" || Array.isArray(record.coordinates) || !Object.keys(COORDINATES).every((key) => typeof record.coordinates[key] === "string")
    || !mapping(record.pages, (page) => page !== null && typeof page === "object" && pagePath(page.permalink) && typeof page.artifact === "boolean" && typeof page.sourceSha256 === "string" && /^[a-f0-9]{64}$/u.test(page.sourceSha256))
    || !mapping(record.previousPages, pagePath)) throw new Error(`${SITE_PLAN_FILE} is not a generated site publish plan`);
  if (phase !== null && record.phase !== phase) throw new Error(`${SITE_PLAN_FILE} has phase ${record.phase}; expected ${phase}`);
  if (baseurl !== null && record.baseurl !== baseurl) throw new Error(`${SITE_PLAN_FILE} does not describe deployment ${baseurl}`);
  if (root !== null) {
    const expected = sitePlanProjection({ plan: sitePlan({ root, coordinates, snapshot: release !== null }), baseurl: baseurl ?? record.baseurl, release });
    if (JSON.stringify(record) !== JSON.stringify({ ...expected, phase: record.phase })) throw new Error("the built source-ID plan does not match this source and deployment");
  }
  return record;
}

/**
 * The built artifact's document roles, from one projection read and the one
 * built-file resolver. A source-phase plan precedes live-artifact assembly;
 * a links-resolved artifact must hold every declared output. These file roles
 * grant no content policy, connection capability or source qualification.
 * @param {import("../../engine/src/workflow/site-sources.ts").SitePlanProjectionOptions} options
 * @returns {import("../../engine/src/workflow/site-sources.ts").SiteDocumentFiles}
 */
export function readSiteDocumentFiles(options) {
  const siteRoot = resolve(options.site);
  const projection = readSitePlanProjection(options);
  const problems = [];
  const owners = new Map();
  const planned = Object.entries(projection.pages).map(([sourceId, page]) => {
    const deferred = page.artifact && projection.phase === "source";
    const files = deferred ? [] : existingSiteFiles(siteRoot, page.permalink);
    const file = files.length === 1 ? files[0] : null;
    if (!deferred && file === null) problems.push(Object.freeze({ kind: "output", sourceId, permalink: page.permalink, message: `${sourceId} has no single built page at ${page.permalink}` }));
    if (file !== null) {
      const owner = owners.get(file);
      if (owner !== undefined) problems.push(Object.freeze({ kind: "collision", sourceId, permalink: page.permalink, message: `${owner} and ${sourceId} share the built page at ${page.permalink}` }));
      else owners.set(file, sourceId);
    }
    return Object.freeze({ ...page, sourceId, file });
  });
  const documentFiles = [...new Set([...htmlPages(siteRoot).map((relative) => join(siteRoot, relative)), ...owners.keys()])].sort();
  return Object.freeze({ projection, planned: Object.freeze(planned), documentFiles: Object.freeze(documentFiles), problems: Object.freeze(problems), errors: Object.freeze(problems.map((problem) => problem.message)) });
}

/** Capture the current publish plan once, before changing its URL rule. An existing record is never overwritten. */
export function captureSiteUrls({ root, out = resolve(root, SITE_URL_HISTORY) }) {
  const plan = sitePlan({ root });
  if (plan.collisions.length > 0) throw new Error(`cannot capture a colliding publish plan: ${plan.collisions.join("; ")}`);
  const history = {
    schemaVersion: "bridlewise-site-url-history/v1",
    generator: "node scripts/build-site.mjs capture-urls (the previous publish plan, captured before its URL rule changes)",
    pages: Object.fromEntries([...plan.bySource.values()].filter((page) => page.permalink !== null).map((page) => [page.docsPath, page.permalink])),
    aliases: Object.fromEntries(legacyAliases(plan)),
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(history, null, 2)}\n`, { flag: "wx" });
  return { out, pages: Object.keys(history.pages).length, aliases: Object.keys(history.aliases).length };
}


/** The versions folder belongs to documentation, under the identity's docs path. */
export function versionsFolder(coordinates = COORDINATES) {
  return `${coordinates.docsPath.replace(/^\/+|\/+$/gu, "")}/v`.replace(/^\//u, "");
}

/** Strip one exact deployment prefix; a sibling path is outside it. */
export function sitePathUnderBase(path, baseurl) {
  const base = baseurl.replace(/\/+$/u, "");
  if (base === "") return path;
  if (path === base) return "/";
  return path.startsWith(`${base}/`) ? path.slice(base.length) : null;
}

/** The exact policy and render surface of one served page, from trusted source routes and verified versions. */
export function sitePolicyResolver({ root = SITE_SOURCE_ROOT, baseurl, versions = [], coordinates = null }) {
  const identity = coordinates ?? siteCoordinates(generatedRepositoryIdentity(root));
  if (!Array.isArray(versions) || !versions.every((version) => typeof version === "string" && RELEASE_VERSION.test(version))) throw new Error("site policy versions are not verified version names");
  const artifacts = readSiteRoutes(root).artifacts.map((entry) => ({ ...entry, pathname: new URL(entry.outputPath, identity.siteOrigin).pathname }));
  const basePath = new URL(baseurl === "" ? "/" : baseurl, identity.siteOrigin).pathname.replace(/\/+$/u, "");
  const folder = versionsFolder(identity);
  return (path) => {
    const filePath = path.startsWith("/") ? path : `/${path.split("/").map(encodeURIComponent).join("/")}`;
    const pathname = new URL(filePath, identity.siteOrigin).pathname;
    const sitePath = sitePathUnderBase(pathname, path.startsWith("/") ? basePath : "");
    if (sitePath === null) throw new Error(`site page ${path} is outside deployment ${baseurl}`);
    const versionRoot = `/${folder}/`;
    const candidate = sitePath.startsWith(versionRoot) ? sitePath.slice(versionRoot.length).split("/")[0] : null;
    if (candidate !== null && !["", "index.html", "versions.json"].includes(candidate) && !versions.includes(candidate)) throw new Error(`site page ${path} names unverified documentation version ${candidate}`);
    const version = candidate !== null && versions.includes(candidate) ? candidate : undefined;
    const artifact = version === undefined ? artifacts.find((entry) => sitePath.startsWith(entry.pathname)) : undefined;
    return Object.freeze({
      baseurl: version !== undefined ? siteUrlForPermalink(`/${folder}/${version}`, baseurl)
        : artifact !== undefined ? siteUrlForPermalink(artifact.outputPath, baseurl).replace(/\/+$/u, "") : baseurl,
      connections: artifact?.connections ?? "site",
      surface: artifact?.surface ?? "site",
      cspRequired: true,
    });
  };
}

/** Resolve one page; bulk static/rendered judges reuse sitePolicyResolver to read trusted inputs once. */
export function sitePagePolicy({ pagePath: path, ...options }) {
  return sitePolicyResolver(options)(path);
}

const MARKDOWN_LINK = /(!?\[[^\]]*\]\()([^)\s]+)((?:\s+"[^"]*")?\))/gu;
const EXTERNAL_OR_ABSOLUTE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#|\{\{|\{%|<)/iu;
const FENCE = /^\s*(?:```|~~~)/u;


function normalizePermalink(permalink) {
  const withLeading = permalink.startsWith("/") ? permalink : `/${permalink}`;
  // A page file (`/404.html`) keeps its extension; a pretty page closes with
  // a slash. Both are spelled the way Jekyll publishes them.
  if (withLeading.endsWith("/") || /\.[a-z0-9]+$/iu.test(withLeading)) return withLeading;
  return `${withLeading}/`;
}

/** The pretty URL a docs-relative Markdown path gives (`index.md` and `README.md` are their folder's page). */
export function prettyPermalink(docsPath) {
  const relative = docsPath.replace(/^docs\//u, "").replace(/\.(?:md|html?|xhtml)$/iu, "");
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

/**
 * THE PUBLISH PLAN of the tree at `root`: every docs Markdown file with its
 * permalink (`null` when `published: false`), and a map from each published
 * permalink to its page. Two pages answering one URL refuse the plan.
 */
export function sitePlan({ root, coordinates = COORDINATES, snapshot = false }) {
  const pages = new Map();
  const bySource = new Map();
  const byPermalink = new Map();
  const collisions = [];
  const { routes, history, sources, inputs } = readSiteSources(root);
  const docsPrefix = snapshot ? "" : coordinates.docsPath.replace(/\/+$/u, "");
  const include = (page) => {
    if (page.permalink !== null && !pagePath(page.permalink)) collisions.push(`${page.docsPath} publishes a non-canonical site path ${page.permalink}`);
    if (bySource.has(page.docsPath)) {
      collisions.push(`${page.docsPath} is declared as more than one page producer`);
      return;
    }
    bySource.set(page.docsPath, page);
    if (!page.artifact) pages.set(page.docsPath, page);
    if (!page.output) return;
    const owner = byPermalink.get(page.permalink);
    if (owner !== undefined) collisions.push(`${owner.docsPath} and ${page.docsPath} both publish ${page.permalink}`);
    else byPermalink.set(page.permalink, page);
  };
  for (const { docsPath, file, data, frontMatter } of sources) {
    const published = String(data["published"]).toLowerCase() !== "false";
    const key = docsPath.slice(DOCS_ROOT.length + 1);
    const live = Object.hasOwn(routes.livePages, key);
    const pretty = live ? normalizePermalink(routes.livePages[key]) : key === routes.docsHome ? "/"
      : typeof data["permalink"] === "string" && data["permalink"].length > 0 ? normalizePermalink(data["permalink"]) : prettyPermalink(docsPath);
    const permalink = !published
      ? null
      : live ? pretty : siteUrlForPermalink(pretty, docsPrefix);
    const output = published && !(snapshot && live);
    const page = { docsPath, file, permalink, pretty, live, output, frontMatter };
    include(page);
  }
  const artifacts = routes.artifacts.map((entry) => ({ ...entry, docsPath: entry.sourceEntry, file: resolve(root, entry.sourceEntry), permalink: entry.outputPath, pretty: entry.outputPath, live: true, output: !snapshot, artifact: true, frontMatter: false }));
  for (const artifact of artifacts) {
    if (inVersionsFolder(artifact.outputPath, coordinates)) collisions.push(`${artifact.sourceEntry}'s artifact namespace is reserved for verified documentation versions`);
    for (const page of byPermalink.values()) {
      if (page.permalink.startsWith(artifact.outputPath)) collisions.push(`${artifact.sourceEntry}'s artifact namespace ${artifact.outputPath} contains ${page.docsPath}`);
    }
    include(artifact);
  }
  for (const key of [routes.docsHome, ...Object.keys(routes.livePages)].filter((name) => name !== null)) {
    const page = pages.get(`${DOCS_ROOT}/${key}`);
    if (page === undefined || page.permalink === null) collisions.push(`${PAGE_ROUTES} names ${key}, which is not a published page`);
  }
  const previousPages = new Map(Object.entries(history.pages).map(([key, path]) => [path, bySource.get(key)]));
  for (const key of Object.keys(history.pages)) {
    const page = bySource.get(key);
    if (page === undefined || page.permalink === null) collisions.push(`${SITE_URL_HISTORY} names ${key}, which no longer publishes: preserve or explicitly migrate that page identity before publishing`);
  }
  for (const [alias, oldTarget] of Object.entries(history.aliases)) {
    const owner = byPermalink.get(alias);
    const target = previousPages.get(oldTarget);
    if (alias.endsWith("/") && owner !== undefined && target?.permalink !== alias) collisions.push(`${owner.docsPath} publishes ${alias}, which the previous plan serves as a moved-page redirect`);
  }
  return { pages, bySource, byPermalink, artifacts, collisions, coordinates, history, previousPages, snapshot, docsPrefix, docsHome: routes.docsHome, inputs, rootPages: new Set([...bySource.values()].filter((page) => page.live).map((page) => page.permalink)) };
}

/** The published page for a docs-relative Markdown path, or `null` when the site does not publish it. */
export function publishedDocsPage({ docsPath, root, plan = sitePlan({ root }) }) {
  const page = plan.pages.get(docsPath);
  if (page === undefined || page.permalink === null) return null;
  return { sourceFile: page.file, permalink: page.permalink, live: page.live };
}

/** A page target under this build, or its live site when a snapshot links a live-only page. */
export function siteUrlForPage(page, { baseurl = "", liveBaseurl = baseurl, plan }) {
  return siteUrlForPermalink(page.permalink, plan.snapshot && page.live ? liveBaseurl : baseurl);
}

/** Whether Jekyll serves a static file at this docs-relative path (it skips `_`- and `.`-prefixed names but `.well-known`). */
export function servedStatic(docsRelative) {
  return docsRelative.split("/").every((segment) => segment === ".well-known" || !/^[_.]/u.test(segment));
}

/**
 * Rewrite one relative target by the header's rule: `{ target }` (the link to
 * write) or `{ error }` (the link names nothing).
 */
export function rewriteTarget(target, { pageDocsPath, root, baseurl = "", liveBaseurl = baseurl, plan }) {
  if (EXTERNAL_OR_ABSOLUTE.test(target)) return { target };
  const { path: pathPart, suffix } = siteLinkPath(target);
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
  const published = plan.bySource.get(repoPath);
  if (published !== undefined && published.permalink !== null) return { target: `${siteUrlForPage(published, { baseurl, liveBaseurl, plan })}${suffix}` };
  if (repoPath === DOCS_ROOT || repoPath.startsWith(`${DOCS_ROOT}/`)) {
    if (directory) {
      for (const name of new Set([...(repoPath === DOCS_ROOT && typeof plan.docsHome === "string" ? [plan.docsHome] : []), "index.md", "README.md"])) {
        const page = publishedDocsPage({ docsPath: posix.join(repoPath, name), root, plan });
        if (page !== null) return { target: `${siteUrlForPage(page, { baseurl, liveBaseurl, plan })}${suffix}` };
      }
    } else if (published === undefined) {
      const docsRelative = repoPath.slice(DOCS_ROOT.length + 1);
      if (servedStatic(docsRelative)) return { target: `${siteUrlForPermalink(`/${docsRelative}`, baseurl)}${suffix}` };
    }
  }
  return { target: `${repositoryFileUrl(repoPath, directory ? "tree" : "blob", plan.coordinates)}${suffix}` };
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
  const prose = htmlWithout(markdown, { comments: true, elements: ["script", "style", "pre", "code", "textarea", "xmp", "plaintext"], preserveOffsets: true }).split("\n");
  const lines = markdown.split("\n").map((line, index) => {
    if (FENCE.test(line)) {
      fenced = !fenced;
      return line;
    }
    if (fenced) return line;
    let result = line;
    const replacements = [];
    for (const match of prose[index].matchAll(MARKDOWN_LINK)) {
      const target = match[2];
      const answer = rewriteTarget(target, options);
      if (answer.error !== undefined) {
        errors.push(answer.error);
        continue;
      }
      if (answer.target !== target) {
        const start = match.index + match[1].length;
        replacements.push({ start, end: start + target.length, target: answer.target });
        rewritten += 1;
      }
    }
    for (const replacement of replacements.reverse()) result = result.slice(0, replacement.start) + replacement.target + result.slice(replacement.end);
    return result;
  });
  const text = lines.join("\n");
  return { text, rewritten, errors };
}

/**
 * The redirect pages the site serves for older URL shapes: each page's
 * GitHub-style `.md` spelling, the trackers' former `/floor/trackers/` home,
 * and the captured previous plan. Answers `[alias, permalink]` pairs; an alias that
 * is itself a page's URL is never redirected.
 */
function computeAliases(plan) {
  const aliases = new Map();
  for (const [oldPath, page] of plan.previousPages) {
    if (page?.output === true) aliases.set(oldPath, page.permalink);
  }
  for (const [oldPath, target] of Object.entries(plan.history.aliases)) {
    const page = plan.previousPages.get(target);
    if (page?.output === true) aliases.set(oldPath, page.permalink);
  }
  for (const page of plan.byPermalink.values()) {
    if (page.artifact) continue;
    if (page.permalink === "/" || !page.permalink.endsWith("/")) continue;
    aliases.set(`${page.permalink.replace(/\/$/u, "")}.md`, page.permalink);
    if (page.docsPath.startsWith(`${DOCS_ROOT}/trackers/`)) {
      const base = page.docsPath.split("/").pop().replace(/\.md$/u, "");
      aliases.set(`/floor/trackers/${base}.md`, page.permalink);
      aliases.set(`/floor/trackers/${base}/`, page.permalink);
    }
  }
  return [...aliases].filter(([alias]) => !plan.byPermalink.has(alias)).sort(([a], [b]) => a.localeCompare(b));
}

/** The generated redirect pairs, read from the same cached landing map as every publisher. */
export function legacyAliases(plan) {
  return [...landingMap(plan)];
}

const LANDING_MAPS = new WeakMap();

/**
 * THE LANDING MAP of a plan, the one answer to "where does an old site path
 * land now": every {@link legacyAliases} pair (the `.md` spellings, the
 * trackers' former home and captured old URLs), frozen and computed once
 * per plan. The trunk's redirect pages and the organisation's redirect site
 * (`buildRedirectSite`) both read it, so an old link lands in ONE hop.
 */
export function landingMap(plan) {
  let map = LANDING_MAPS.get(plan);
  if (map === undefined) {
    map = Object.freeze(new Map(computeAliases(plan)));
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
export const BUILDER_OWNED_CONFIG_KEYS = Object.freeze(["url", "baseurl", "repository", "repository_url", "security_url", "product_repository", "product_repository_url", "docs_url", "preview_repository_url", "versions_url", "release_version", "relative_links"]);

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
/** Whether a site path belongs to the identity's released documentation namespace, including its versions list. */
export function inVersionsFolder(sitePath, coordinates = COORDINATES) {
  const folder = `/${versionsFolder(coordinates)}`;
  return sitePath === folder || sitePath.startsWith(`${folder}/`);
}
const TEXT_FILE = /\.(?:md|markdown|txt|json|ya?ml|xml|js|css|svg)$/iu;

function textFiles(root) {
  const out = [];
  const visit = (relative) => {
    for (const entry of readdirSync(resolve(root, ...relative.split("/")), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && (TEXT_FILE.test(entry.name) || SERVED_HTML.test(entry.name))) out.push(child);
    }
  };
  visit(DOCS_ROOT);
  return out;
}

/**
 * Source plan, reserved-builder syntax and repository-coordinate ownership.
 * Actual page URLs and version references are judged on rendered attributes
 * by the mandatory site finalizer, after Jekyll decides what is a link.
 * This fast structural reader still needs no installed dependencies.
 */
export function siteSourceViolations({ root, coordinates = COORDINATES }) {
  const plan = sitePlan({ root, coordinates });
  const violations = [...plan.collisions];
  for (const path of textFiles(root)) {
    const text = readFileSync(resolve(root, ...path.split("/")), "utf8");
    if (text.includes(PAGE_CONTENT.start) || text.includes(PAGE_CONTENT.end)) violations.push(`${path}: authored source contains a reserved rendered-content delimiter`);
    if (text.toLowerCase().includes(SITE_LINK_PREFIX)) violations.push(`${path}: authored source contains a reserved builder link marker`);
    const record = RECORD_ROOTS.some(({ root: recordRoot }) => path.startsWith(recordRoot));
    text.split("\n").forEach((line, index) => {
      for (const { url, kind } of spelledUrls(line, plan.coordinates)) {
        if (record && kind === "object") continue;
        violations.push(record
          ? `${path}:${String(index + 1)}: spells ${url}; a record cites a repository file or folder by a relative link and the site by its own pages (only a GitHub object — an issue, a pull request, a discussion, a commit, a release, a run — is cited by URL)`
          : `${path}:${String(index + 1)}: spells the repository's own URL (${url}); use site.repository_url, site.url and site.baseurl, or a relative link (the repository identity is the one source)`);
      }
    });

  }
  return violations;
}
