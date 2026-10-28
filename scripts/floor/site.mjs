/**
 * THE ONE SITE BUILDER — the Pages site of the one repository, from one source.
 *
 * Three steps, each a pure function of its inputs:
 *
 * 1. `buildSiteSource` — the Jekyll source: this tree's `docs/` copied, its
 *    pages' relative links rewritten by the publish plan
 *    (`site-pages.mjs`), a front matter given to every plain Markdown page
 *    (its body wrapped as raw text: a GitHub Markdown page holds no Liquid),
 *    the redirect pages for older URLs, the `/v/` versions page and
 *    `versions.json` listing the released docs snapshots, and the deployment
 *    base path written into `_config.yml`, and the design system's generated
 *    assets (`site-design.mjs`).
 * 2. Jekyll (`actions/jekyll-build-pages`) turns that source into `_site`.
 * 3. `finishSite` — each release's PRE-BUILT docs snapshot (built at release
 *    time with the base path `<base>/v/<version>`, an immutable release
 *    asset) merged at `_site/v/<version>/`, then the whole output judged: the
 *    internal link crawl over every page (snapshots included) and the design
 *    coverage over the pages this build rendered.
 *
 * `buildRedirectSite` writes the static site that answers the old
 * `/bridlewise-testing/` base path (Pages URLs do not follow a repository
 * rename): every old URL lands on the same path under the current site.
 *
 * Nothing here reads another repository or a network: the inputs are this
 * tree and the snapshot folder the workflow downloaded and verified.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join, resolve } from "node:path";

import { isMap, isScalar, parseDocument } from "yaml";

import { escapeHtml } from "../../shared/markup.ts";
import { buildAtlas } from "./atlas.mjs";
import { coverage } from "./design-coverage.mjs";
import { stableJson } from "./files.mjs";
import { LEGACY_BASEURL, SITE_URL, coordinatesOf } from "./repository.mjs";
import { crawlSiteLinks } from "./site-links.mjs";
import { writeSiteDesign } from "./site-design.mjs";
import { builtPolicyViolations, judgeSiteStyles } from "./site-style.mjs";
import { BUILDER_OWNED_CONFIG_KEYS, DOCS_ROOT, legacyAliases, rewritePageLinks, siteLinkTargets, siteSourceViolations, sitePlan, siteUrlForPermalink } from "./site-pages.mjs";
import { buildStatus } from "./status.mjs";

/**
 * Site paths Jekyll writes itself, so the source holds no file for them: each
 * with the plugin or rule that writes it.
 */
const JEKYLL_WRITES = Object.freeze(new Map([["/sitemap.xml", "jekyll-sitemap (docs/_config.yml plugins)"]]));

/**
 * The one markup owner, served to the browser pages that render markup
 * (`docs/run/run-demo.js` imports it): generated at build time from
 * `shared/markup.ts` with its types stripped, so the page runs the same code
 * and the tree holds no second copy.
 */
export const BROWSER_MARKUP_MODULE = "assets/js/markup.js";
const MARKUP_OWNER = "shared/markup.ts";

/** A released version the versions folder may hold: its tag's semantic version, without the tag's `v` (`v0.1.0` → `0.1.0`, served at `/v/0.1.0/`). */
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/u;
/** The site folder that holds the released snapshots; the source must not publish into it. */
export const VERSIONS_FOLDER = "v";
/** The file beside each moved page that forwards the reader to its new place. */
export const MOVED_SCRIPT = "moved.js";

function fail(message) {
  throw new Error(message);
}

/**
 * The site configuration READ AS YAML (the repository's one YAML reader): its
 * document and top-level keys, or the reasons it cannot be read. A repeated
 * key is a reason, never "the last one wins".
 */
export function readSiteConfig(text) {
  const document = parseDocument(text, { uniqueKeys: true, prettyErrors: false });
  const errors = [...document.errors, ...document.warnings].map((error) => error.message.split("\n")[0]);
  if (errors.length === 0 && !isMap(document.contents)) errors.push("the document is not a mapping");
  return { document, errors, keys: errors.length > 0 ? [] : document.contents.items.map((pair) => (isScalar(pair.key) ? String(pair.key.value) : String(pair.key))) };
}

/**
 * `text` (a site configuration) with `values` set, through the one YAML
 * reader. Only the keys the builder owns, and only where the source declares
 * none of them: it never adds a plugin, a gem or a theme behind the tracked
 * configuration's back, and no value has two owners.
 */
function configWith(text, values) {
  const foreign = Object.keys(values).filter((key) => !BUILDER_OWNED_CONFIG_KEYS.includes(key));
  if (foreign.length > 0) fail(`the builder owns only ${BUILDER_OWNED_CONFIG_KEYS.join(", ")}; it cannot set ${foreign.join(", ")}`);
  const { document, errors, keys } = readSiteConfig(text);
  if (errors.length > 0) fail(`${DOCS_ROOT}/_config.yml is unreadable: ${errors.join("; ")}`);
  const declared = keys.filter((key) => BUILDER_OWNED_CONFIG_KEYS.includes(key));
  if (declared.length > 0) fail(`${DOCS_ROOT}/_config.yml declares ${declared.join(", ")}, which the builder writes from package.json and the deployment`);
  for (const [key, value] of Object.entries(values)) document.set(key, value);
  return String(document);
}

function frontMatter(fields) {
  return `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n\n`;
}

function compareVersions(left, right) {
  const a = VERSION.exec(left);
  const b = VERSION.exec(right);
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(b[index]) - Number(a[index]);
    if (difference !== 0) return difference;
  }
  // A release outranks its pre-releases; pre-releases compare as text.
  if (a[4] === undefined || b[4] === undefined) return (a[4] === undefined ? 0 : 1) - (b[4] === undefined ? 0 : 1);
  return b[4].localeCompare(a[4]);
}

/**
 * The released snapshots in `versionsDir` (`<dir>/<version>/index.html`),
 * newest first. A name that is not a version, or a version with no
 * `index.html`, refuses: the folder is the workflow's verified download, so
 * anything else in it is a defect, not something to skip.
 */
export function readVersions(versionsDir) {
  if (versionsDir === null || versionsDir === undefined) return [];
  if (!existsSync(versionsDir) || !statSync(versionsDir).isDirectory()) fail(`the versions folder ${versionsDir} does not exist`);
  const versions = [];
  for (const entry of readdirSync(versionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !VERSION.test(entry.name)) fail(`the versions folder holds ${entry.name}, which is not a released version snapshot (<major>.<minor>.<patch>[-pre], the tag without its v)`);
    if (!existsSync(join(versionsDir, entry.name, "index.html"))) fail(`the snapshot ${entry.name} has no index.html: it is not a built docs site`);
    versions.push(entry.name);
  }
  return versions.sort(compareVersions);
}

function versionsPage(versions, baseurl) {
  const rows = versions.map((version, index) => `| [${version}](${siteUrlForPermalink(`/${VERSIONS_FOLDER}/${version}/`, baseurl)}) | ${index === 0 ? "Latest release" : "Earlier release"} |`);
  return frontMatter({ layout: "default", page_class: "article", title: "Documentation versions", permalink: `/${VERSIONS_FOLDER}/` })
    + "# Documentation versions\n\n"
    + `The [current documentation](${siteUrlForPermalink("/", baseurl)}) follows \`main\`. Each release keeps the documentation it shipped with, built once from its release tag and published as an attested release asset; a snapshot never changes after its release.\n\n`
    + (versions.length === 0
      ? "No release has been published yet.\n"
      : `| Version | Status |\n|---|---|\n${rows.join("\n")}\n`);
}

/**
 * Step 1 (see the header): the Jekyll source at `out` from the tree at
 * `root`, for the deployment base path `baseurl`, listing the snapshots of
 * `versionsDir` (or none).
 */
/**
 * The floor data a build writes: the atlas of the tree and its status, read
 * offline (a snapshot's status is its history; the Pages workflow refreshes
 * the live one online afterwards).
 */
export async function floorDataOf(root) {
  const atlas = buildAtlas({ root });
  return { atlas, status: await buildStatus({ root, offline: true, counts: atlas.counts }) };
}

export async function buildSiteSource({ root, out, baseurl, versionsDir = null, release = null, floorData = floorDataOf }) {
  const repositoryRoot = resolve(root);
  const outRoot = resolve(out);
  const docs = join(repositoryRoot, DOCS_ROOT);
  if (!existsSync(join(docs, "_config.yml"))) fail(`${DOCS_ROOT}/_config.yml is missing: the tree at ${repositoryRoot} holds no site`);
  if (existsSync(join(docs, VERSIONS_FOLDER))) fail(`${DOCS_ROOT}/${VERSIONS_FOLDER}/ exists: that folder is the released snapshots' place on the site`);
  const violations = siteSourceViolations({ root: repositoryRoot });
  if (violations.length > 0) fail(`the site source refuses (${String(violations.length)}):\n  ${violations.join("\n  ")}`);
  const plan = sitePlan({ root: repositoryRoot });
  const coordinates = coordinatesOf(repositoryRoot);
  // A release snapshot is built once, at release time, for its own place on
  // the site (`<base>/v/<version>`); it carries no versions list of its own
  // and links the live one.
  if (release !== null) {
    if (!VERSION.test(release)) fail(`--release ${release} is not a version (<major>.<minor>.<patch>[-pre], the tag without its v)`);
    if (versionsDir !== null) fail("a release snapshot lists no versions: --release and --versions do not go together");
    if (!baseurl.endsWith(`/${VERSIONS_FOLDER}/${release}`)) fail(`a release snapshot is served at <base>/${VERSIONS_FOLDER}/${release}, not at ${baseurl}`);
  }
  const siteBase = release === null ? baseurl : baseurl.slice(0, -`/${VERSIONS_FOLDER}/${release}`.length);
  const versions = readVersions(versionsDir);

  rmSync(outRoot, { recursive: true, force: true });
  cpSync(docs, outRoot, { recursive: true, filter: (from) => !["_site", ".jekyll-cache"].includes(from.split(/[\\/]/u).pop()) });

  const errors = [];
  let rewrittenLinks = 0;
  let frontMatterPages = 0;
  for (const page of plan.pages.values()) {
    if (page.permalink === null) continue;
    const target = join(outRoot, ...page.docsPath.slice(DOCS_ROOT.length + 1).split("/"));
    const result = rewritePageLinks(readFileSync(target, "utf8"), { pageDocsPath: page.docsPath, root: repositoryRoot, baseurl, plan });
    errors.push(...result.errors);
    rewrittenLinks += result.rewritten;
    let text = result.text;
    if (!page.frontMatter) {
      // A plain Markdown page is a GitHub document: Jekyll must render it as
      // a page (it copies a file with no front matter verbatim) and must not
      // read its text as Liquid (`${{ … }}` in a workflow example is prose).
      if (text.includes("{% endraw %}")) {
        errors.push(`${page.docsPath}: a plain Markdown page cannot contain {% endraw %}`);
        continue;
      }
      const heading = /^#\s+(.+?)\s*$/mu.exec(text)?.[1]?.replace(/[*_`]/gu, "");
      text = frontMatter({ layout: "default", page_class: "article", title: heading ?? page.docsPath.split("/").pop().replace(/\.md$/u, ""), permalink: page.permalink })
        + `{% raw %}\n${text}\n{% endraw %}\n`;
      frontMatterPages += 1;
    }
    writeFileSync(target, text);
  }
  if (errors.length > 0) fail(`${errors.length} link(s) name nothing:\n  ${errors.join("\n  ")}`);

  // The older URL shapes get real pages: a redirect header needs a plugin
  // this build does not load. Same shell as every page, so an old link lands
  // on something that looks like the site; a reader without scripts gets the
  // visible link.
  let redirectedPaths = 0;
  for (const [alias, permalink] of legacyAliases(plan)) {
    const directory = join(outRoot, ...alias.split("/").filter(Boolean));
    // The page's own source file may sit at this spelling (`docs/a/b.md` for
    // `/a/b.md`): Jekyll renders it at `/a/b/` and serves nothing there, and
    // a redirect folder cannot take a file's name.
    if (existsSync(directory) && !statSync(directory).isDirectory()) continue;
    mkdirSync(directory, { recursive: true });
    const target = siteUrlForPermalink(permalink, baseurl);
    const name = permalink.replace(/\/$/u, "").split("/").pop() || "home";
    writeFileSync(
      join(directory, "index.html"),
      frontMatter({ layout: "default", page_class: "article", title: `Moved: ${name}` })
        + `<div class="callout-warning" role="status">\n  <p>This page moved to <a href="${escapeHtml(target)}">${escapeHtml(target)}</a>.</p>\n</div>\n`
        // The forward is a file beside the page, not an inline script: the
        // page's Content-Security-Policies run only files under the site's path.
        + `<script src="${MOVED_SCRIPT}"></script>\n`,
    );
    writeFileSync(join(directory, MOVED_SCRIPT), `location.replace(${JSON.stringify(target)});\n`);
    redirectedPaths += 1;
  }

  if (release === null) {
    mkdirSync(join(outRoot, VERSIONS_FOLDER), { recursive: true });
    writeFileSync(join(outRoot, VERSIONS_FOLDER, "index.md"), versionsPage(versions, baseurl));
    writeFileSync(join(outRoot, "versions.json"), `${JSON.stringify({ current: "main", versions: versions.map((version) => ({ version, path: `/${VERSIONS_FOLDER}/${version}/` })) }, null, 2)}\n`);
  }

  // Every coordinate a page reads comes from the repository's one
  // declaration (package.json) and the deployment's base path.
  const configPath = join(outRoot, "_config.yml");
  writeFileSync(configPath, configWith(readFileSync(configPath, "utf8"), {
    url: coordinates.siteOrigin,
    baseurl,
    repository: coordinates.repository,
    repository_url: coordinates.repositoryUrl,
    security_url: `${coordinates.repositoryUrl}/blob/${coordinates.defaultBranch}/SECURITY.md`,
    versions_url: `${siteBase.replace(/\/$/u, "")}/${VERSIONS_FOLDER}/`,
    release_version: release ?? "",
  }));
  const markupModule = join(outRoot, ...BROWSER_MARKUP_MODULE.split("/"));
  mkdirSync(join(markupModule, ".."), { recursive: true });
  writeFileSync(markupModule, `// GENERATED from ${MARKUP_OWNER} by scripts/floor/site.mjs (types stripped); edit the owner.\n${stripTypeScriptTypes(readFileSync(join(repositoryRoot, MARKUP_OWNER), "utf8"))}`);
  // The floor pages read their data from floor/data; every build writes it
  // ({@link floorDataOf}), so a release snapshot is a whole site.
  const { atlas, status } = await floorData(repositoryRoot);
  mkdirSync(join(outRoot, "floor/data"), { recursive: true });
  writeFileSync(join(outRoot, "floor/data/atlas.json"), stableJson(atlas));
  writeFileSync(join(outRoot, "floor/data/status.json"), stableJson(status));
  // The design system's generated half: the token sheet, fonts, icon, mark
  // and figures, from their one owners (`site-design.mjs`).
  writeSiteDesign({ root: repositoryRoot, outRoot, baseurl });
  // Every stylesheet this source hands Jekyll reads the owner's tokens and
  // declares none of its own, and no layout, include or HTML page carries a
  // style or loads from elsewhere (`site-style.mjs`).
  const style = judgeSiteStyles({ root: repositoryRoot, sourceRoot: outRoot });
  if (style.findings.length > 0) fail(`${String(style.findings.length)} style finding(s): the site's sheets and markup read the one design system (scripts/floor/site-style.mjs):\n  ${style.findings.join("\n  ")}`);

  // Every site path a page or layout names must be one this source builds:
  // a page, a redirect, the versions page, a served file, or one Jekyll
  // writes itself. The built crawl (finish) judges the output again; this
  // check is what makes a release snapshot whole before it is ever merged.
  const built = new Set([...plan.byPermalink.keys(), ...legacyAliases(plan).map(([alias]) => alias), ...(release === null ? [`/${VERSIONS_FOLDER}/`] : [])]);
  const served = (sitePath) => {
    if (built.has(sitePath) || built.has(`${sitePath}/`) || JEKYLL_WRITES.has(sitePath)) return true;
    const relative = sitePath.replace(/^\/+/u, "");
    if (relative.split("/").some((segment) => /^[_.]/u.test(segment) && segment !== ".well-known")) return false;
    const file = join(outRoot, ...relative.split("/"));
    return existsSync(file) && (statSync(file).isFile() || existsSync(join(file, "index.html")));
  };
  const missing = [];
  const pagesAndLayouts = [
    ...[...plan.byPermalink.values()].map((page) => ({ path: page.docsPath.slice(DOCS_ROOT.length + 1), url: page.permalink })),
    ...readdirSync(join(outRoot, "_layouts")).map((name) => ({ path: `_layouts/${name}`, url: null })),
  ];
  for (const { path, url } of pagesAndLayouts) {
    for (const target of siteLinkTargets(readFileSync(join(outRoot, ...path.split("/")), "utf8"), url)) {
      if (!served(target)) missing.push(`${path}: ${target}`);
    }
  }
  if (missing.length > 0) fail(`${String(missing.length)} site link(s) name a path this ${release === null ? "site" : `release ${release} snapshot`} does not build:\n  ${[...new Set(missing)].join("\n  ")}`);

  return {
    out: outRoot,
    baseurl,
    pages: [...plan.byPermalink.keys()].length,
    rewrittenLinks,
    frontMatterPages,
    redirectedPaths,
    versions,
    release,
  };
}

/**
 * Step 3 (see the header): merge each snapshot of `versionsDir` into
 * `site/v/<version>/`, then judge the whole output. Throws with every
 * unresolved link or design finding; answers the counts.
 */
export function finishSite({ site, baseurl, versionsDir = null }) {
  const siteRoot = resolve(site);
  if (!existsSync(join(siteRoot, "index.html"))) fail(`${siteRoot} is not a built site (no index.html)`);
  const versions = readVersions(versionsDir);
  for (const version of versions) {
    const destination = join(siteRoot, VERSIONS_FOLDER, version);
    if (existsSync(destination)) fail(`the built site already holds /${VERSIONS_FOLDER}/${version}/: a snapshot never overwrites a page`);
    cpSync(join(versionsDir, version), destination, { recursive: true });
  }
  const listed = JSON.parse(readFileSync(join(siteRoot, "versions.json"), "utf8")).versions.map((entry) => entry.version);
  if (JSON.stringify(listed) !== JSON.stringify(versions)) {
    fail(`the source listed the versions [${listed.join(", ")}] but the snapshot folder holds [${versions.join(", ")}]: build both steps from one folder`);
  }

  const links = crawlSiteLinks({ siteRoot, baseurl });
  const design = coverage(siteRoot, { exclude: versions.map((version) => `/${VERSIONS_FOLDER}/${version}/`) });
  const findings = [
    // An allow-list judged on what was built: every HTML file Pages serves
    // carries the site's two policies first, whatever produced it.
    ...builtPolicyViolations({ siteRoot, baseurl, versions }).map((finding) => `policy: ${finding}`),
    ...links.unresolved.map((entry) => `link: ${entry.page}: ${entry.href} → ${entry.resolved}`),
    ...[...design.missing].map(([name, pages]) => `design: .${name} has no CSS rule (${pages.slice(0, 3).join(", ")})`),
    ...[...design.unused].map(([name]) => `design: floor.css declares .${name} but no page uses it`),
  ];
  if (findings.length > 0) fail(`the built site refuses:\n  ${findings.join("\n  ")}`);
  return { pages: links.pages, links: links.links, versions, designPages: design.jekyllPages };
}

/**
 * The redirect for a path under the old base: the same path under the
 * current site (the query and fragment kept). A path outside the old base
 * answers `null`: the redirect site claims nothing else.
 */
export function redirectTarget(pathname, { from = LEGACY_BASEURL, to = SITE_URL } = {}) {
  const base = from.replace(/\/+$/u, "");
  if (pathname !== base && !pathname.startsWith(`${base}/`)) return null;
  return `${to.replace(/\/+$/u, "")}${pathname.slice(base.length) || "/"}`;
}

/**
 * The static redirect site for the old base path, at `out`: an
 * `<old base>/index.html` and a root `404.html` (Pages serves it for every
 * path the site lacks, which is every old deep link). Both run the same
 * mapping as {@link redirectTarget} — its source is embedded, not restated —
 * and show the destination as a link for a reader without scripts.
 */
export function buildRedirectSite({ out, from = LEGACY_BASEURL, to = SITE_URL }) {
  // Before the rename the old base IS the site: a redirect there would loop.
  if (new URL(to).pathname.replace(/\/+$/u, "") === from.replace(/\/+$/u, "")) {
    fail(`the site still answers at ${from} (package.json repository.url names it): there is nothing to redirect until the repository is renamed`);
  }
  const outRoot = resolve(out);
  rmSync(outRoot, { recursive: true, force: true });
  const script = `${redirectTarget.toString()}\n`
    + `var target = redirectTarget(location.pathname, ${JSON.stringify({ from, to })});\n`
    + "if (target !== null) location.replace(target + location.search + location.hash);\n";
  const page = (title) => `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n`
    + `<meta name="robots" content="noindex">\n<title>${escapeHtml(title)}</title>\n<link rel="canonical" href="${escapeHtml(to)}">\n`
    + `<script>\n${script}</script>\n</head>\n<body>\n<p>Bridlewise moved to <a href="${escapeHtml(to)}">${escapeHtml(to)}</a>.</p>\n</body>\n</html>\n`;
  const index = join(outRoot, ...from.split("/").filter(Boolean), "index.html");
  mkdirSync(join(index, ".."), { recursive: true });
  writeFileSync(index, page("Bridlewise moved"));
  writeFileSync(join(outRoot, "404.html"), page("Bridlewise moved"));
  return { out: outRoot, from, to, files: [index, join(outRoot, "404.html")] };
}
