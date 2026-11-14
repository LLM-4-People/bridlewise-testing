/**
 * THE ONE SITE BUILDER — the Pages site of the one repository, from one source.
 *
 * Three steps, each a pure function of its inputs:
 *
 * 1. `buildSiteSource` — the Jekyll source: this tree's `docs/` copied, its
 *    source-relative page bodies preserved for the configured renderer,
 *    a front matter given to every plain Markdown page
 *    (its body wrapped as raw text: a GitHub Markdown page holds no Liquid),
 *    the redirect pages for older URLs, the `/docs/v/` versions page and
 *    `versions.json` listing the released docs snapshots, and the deployment
 *    base path written into `_config.yml`, and the design system's generated
 *    assets (`site-design.mjs`).
 * 2. Jekyll (`actions/jekyll-build-pages`) turns that source into `_site`.
 * 3. `finishSite` — actual rendered attributes resolved through the source-ID
 *    publish plan, then each release's PRE-BUILT docs snapshot (built at release
 *    time with the base path `<base>/docs/v/<version>`, an immutable release
 *    asset) merged at `_site/docs/v/<version>/`, then the whole output judged: the
 *    internal link crawl over every page (snapshots included) and the design
 *    coverage over the pages this build rendered.
 *
 * `buildRedirectSite` writes the organisation site's tree that answers the
 * old site (`LEGACY_SITE_URL`, from the repository identity) once the repository is renamed (Pages
 * URLs do not follow a rename): every old URL lands, in one hop, where the
 * plan's landing map (`landingPath`) sends it under the current site.
 *
 * Nothing here reads another repository or a network: the inputs are this
 * tree and the snapshot folder the workflow downloaded and verified.
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";

import { isMap, isScalar, parseDocument } from "yaml";

import { escapeHtml } from "../../shared/markup.ts";
import { identityOverlapIndex, resolveLocation } from "../../engine/src/filesystem/path-identity.ts";
import { buildAtlas } from "./atlas.mjs";
import { coverage } from "./design-coverage.mjs";
import { relativePosix, stableJson } from "./files.mjs";
import { COORDINATES, LEGACY_SITE_URL, SITE_URL } from "./repository.mjs";
import { crawlSiteLinks, htmlPages, pageUrlForSitePath } from "./site-links.mjs";
import { SITE_LINK_PREFIX, SITE_LINKS, readSiteSourceReference, siteLinkPath, siteSourceReference } from "../../engine/src/workflow/site-sources.ts";
import { CONTENT_INCLUDE, pageContentInclude, rewriteRenderedPageLinks } from "./site-html.mjs";
import { writeSiteDesign } from "./site-design.mjs";
import { builtPolicyViolations, judgeSiteStyles } from "./site-style.mjs";
import { BUILDER_OWNED_CONFIG_KEYS, DOCS_ROOT, RELEASE_VERSION as VERSION, SITE_PLAN_FILE, SITE_SOURCE_ROOT, inVersionsFolder, landingMap, landingPath, legacyAliases, readSiteDocumentFiles, rewritePageLinks, rewriteTarget, servedStatic, sitePathUnderBase, siteSourceViolations, sitePlan, sitePlanProjection, siteUrlForPage, siteUrlForPermalink, versionsFolder } from "./site-pages.mjs";
import { buildStatus } from "./status.mjs";

/** The site folder that holds the released snapshots; the source must not publish into it. */
export const VERSIONS_FOLDER = versionsFolder();
/** One forwarding script for every moved page; the rendered canonical link supplies its destination. */
export const MOVED_SCRIPT = "assets/js/moved.js";

function fail(message) {
  throw new Error(message);
}

/** Admit a fresh generated destination; source data and previous output are never removed. */
function requireNewOutput(root, out) {
  const target = resolveLocation(resolve(out), "site output");
  if (lstatSync(target, { throwIfNoEntry: false }) !== undefined) fail(`site output must be a new directory; existing work is preserved: ${target}`);
  const source = resolveLocation(resolve(root, DOCS_ROOT), "documentation input");
  if (identityOverlapIndex().atOrUnder(target, source)) fail(`site output must stay outside its documentation input: ${target}`);
  return target;
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
  if (declared.length > 0) fail(`${DOCS_ROOT}/_config.yml declares ${declared.join(", ")}, which the builder writes from the repository identity and the deployment`);
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

function versionsPage(versions, baseurl, coordinates) {
  const folder = versionsFolder(coordinates);
  const rows = versions.map((version, index) => `| [${version}](${siteUrlForPermalink(`/${folder}/${version}/`, baseurl)}) | ${index === 0 ? "Latest release" : "Earlier release"} |`);
  return frontMatter({ layout: "default", page_class: "article", title: "Documentation versions", permalink: `/${folder}/` })
    + "# Documentation versions\n\n"
    + `The [current documentation](${siteUrlForPermalink(coordinates.docsPath, baseurl)}) follows \`main\`. Each release keeps the documentation it shipped with, built once from its release tag and published as an attested release asset; a snapshot never changes after its release.\n\n`
    + (versions.length === 0
      ? "No release has been published yet.\n"
      : `| Version | Status |\n|---|---|\n${rows.join("\n")}\n`);
}

function withPageAddress(text, page, href) {
  const opening = text.startsWith("---\r\n") ? 5 : 4;
  const end = text.indexOf("\n---", opening);
  if (end === -1) fail(`${page.docsPath} has unclosed front matter`);
  const { document, errors } = readSiteConfig(text.slice(opening, end));
  if (errors.length > 0) fail(`${page.docsPath} has unreadable front matter: ${errors.join("; ")}`);
  document.set("permalink", page.permalink);
  document.set("site_href", href);
  document.set("source_identity", page.docsPath);
  return `---\n${String(document)}---${text.slice(end + 4)}`;
}

function resolvedNavigation(value, options) {
  if (Array.isArray(value)) return value.map((item) => resolvedNavigation(item, options));
  if (value === null || typeof value !== "object") return value;
  if (["path", "href", "permalink", "sourceRef"].some((key) => Object.hasOwn(value, key))) fail("navigation declares a generated URL or source reference; declare its page key or asset instead");
  if (["page", "artifact", "asset"].filter((name) => Object.hasOwn(value, name)).length > 1) fail("navigation declares more than one target");
  if (typeof value.title === "string" && !Array.isArray(value.links) && typeof value.page !== "string" && typeof value.artifact !== "string" && typeof value.asset !== "string") fail(`navigation ${value.title} has no page key or asset`);
  const answer = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolvedNavigation(item, options)]));
  if (typeof value.page === "string" || typeof value.artifact === "string") {
    const key = typeof value.artifact === "string" ? value.artifact : `${DOCS_ROOT}/${value.page}`;
    const page = options.plan.bySource.get(key);
    if (page === undefined || page.permalink === null || (typeof value.artifact === "string") !== (page.artifact === true)) fail(`navigation names ${key}, which is not a published page of that kind`);
    answer.href = siteUrlForPage(page, options);
    answer.sourceRef = siteSourceReference(key);
    answer.permalink = page.permalink;
  } else if (typeof value.asset === "string") {
    if (!value.asset.startsWith("/") || value.asset.startsWith("//") || value.asset.split("/").includes("..")
      || !existsSync(join(options.outRoot, value.asset.slice(1)))) fail(`navigation names ${value.asset}, which is not a served asset`);
    answer.href = siteUrlForPermalink(value.asset, options.baseurl);
  }
  return answer;
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

export async function buildSiteSource({ root, out, baseurl, versionsDir = null, release = null, floorData = floorDataOf, coordinates = COORDINATES }) {
  const repositoryRoot = resolve(root);
  const docs = join(repositoryRoot, DOCS_ROOT);
  if (!existsSync(join(docs, "_config.yml"))) fail(`${DOCS_ROOT}/_config.yml is missing: the tree at ${repositoryRoot} holds no site`);
  if (existsSync(join(docs, "v"))) fail(`${DOCS_ROOT}/v/ exists: that folder is the released snapshots' place on the site`);
  const violations = siteSourceViolations({ root: repositoryRoot, coordinates });
  if (violations.length > 0) fail(`the site source refuses (${String(violations.length)}):\n  ${violations.join("\n  ")}`);
  const plan = sitePlan({ root: repositoryRoot, coordinates, snapshot: release !== null });
  const folder = versionsFolder(coordinates);
  // A release snapshot is built once, at release time, for its own place on
  // the site (`<base>/docs/v/<version>`); it carries no versions list of its own
  // and links the live one.
  if (release !== null) {
    if (!VERSION.test(release)) fail(`--release ${release} is not a version (<major>.<minor>.<patch>[-pre], the tag without its v)`);
    if (versionsDir !== null) fail("a release snapshot lists no versions: --release and --versions do not go together");
    if (!baseurl.endsWith(`/${folder}/${release}`)) fail(`a release snapshot is served at <base>/${folder}/${release}, not at ${baseurl}`);
  }
  const siteBase = release === null ? baseurl : baseurl.slice(0, -`/${folder}/${release}`.length);
  const versions = readVersions(versionsDir);
  const outRoot = requireNewOutput(repositoryRoot, out);
  const omittedPages = new Set([...plan.pages.values()].filter((page) => !page.output && page.live).map((page) => page.file));
  cpSync(docs, outRoot, { recursive: true, filter: (from) => !omittedPages.has(from) && !["_site", ".jekyll-cache"].includes(from.split(/[\\/]/u).pop()) });

  const errors = [];
  let rewrittenLinks = 0;
  let frontMatterPages = 0;
  for (const page of plan.pages.values()) {
    if (!page.output) continue;
    const target = join(outRoot, ...page.docsPath.slice(DOCS_ROOT.length + 1).split("/"));
    let text = readFileSync(target, "utf8");
    if (!page.frontMatter) {
      // A plain Markdown page is a GitHub document: Jekyll must render it as
      // a page (it copies a file with no front matter verbatim) and must not
      // read its text as Liquid (`${{ … }}` in a workflow example is prose).
      if (text.includes("{% endraw %}")) {
        errors.push(`${page.docsPath}: a plain Markdown page cannot contain {% endraw %}`);
        continue;
      }
      const heading = /^#\s+(.+?)\s*$/mu.exec(text)?.[1]?.replace(/[*_`]/gu, "");
      text = frontMatter({ layout: "default", page_class: "article", title: heading ?? page.docsPath.split("/").pop().replace(/\.md$/u, ""), permalink: page.permalink, site_href: siteUrlForPage(page, { baseurl, liveBaseurl: siteBase, plan }), source_identity: page.docsPath })
        + `{% raw %}\n${text}\n{% endraw %}\n`;
      frontMatterPages += 1;
    } else text = withPageAddress(text, page, siteUrlForPage(page, { baseurl, liveBaseurl: siteBase, plan }));
    writeFileSync(target, text);
  }
  if (errors.length > 0) fail(`${errors.length} link(s) name nothing:\n  ${errors.join("\n  ")}`);

  const navigationPath = join(outRoot, "_data/navigation.yml");
  if (existsSync(navigationPath)) {
    const navigation = readSiteConfig(readFileSync(navigationPath, "utf8"));
    if (navigation.errors.length > 0) fail(`navigation is unreadable: ${navigation.errors.join("; ")}`);
    navigation.document.contents = navigation.document.createNode(resolvedNavigation(navigation.document.toJS(), { plan, baseurl, liveBaseurl: siteBase, outRoot }));
    writeFileSync(navigationPath, String(navigation.document));
  }
  const llmsPath = join(outRoot, "llms.txt");
  if (existsSync(llmsPath)) {
    const result = rewritePageLinks(readFileSync(llmsPath, "utf8"), { pageDocsPath: `${DOCS_ROOT}/llms.txt`, root: repositoryRoot, baseurl, liveBaseurl: siteBase, plan });
    if (result.errors.length > 0) fail(`llms.txt names nothing:\n  ${result.errors.join("\n  ")}`);
    writeFileSync(llmsPath, result.text);
    rewrittenLinks += result.rewritten;
  }

  // The older URL shapes get real pages: a redirect header needs a plugin
  // this build does not load. Same shell as every page, so an old link lands
  // on something that looks like the site; a reader without scripts gets the
  // visible link.
  let redirectedPaths = 0;
  for (const [alias] of legacyAliases(plan)) {
    const permalink = landingPath(alias, plan);
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
      frontMatter({ layout: "default", page_class: "article", title: `Moved: ${name}`, permalink: alias.endsWith("/") ? alias : `${alias}/`, site_href: siteUrlForPermalink(alias.endsWith("/") ? alias : `${alias}/`, baseurl), canonical_url: permalink })
        + `<div class="callout-warning" role="status">\n  <p>This page moved to <a href="${escapeHtml(target)}">${escapeHtml(target)}</a>.</p>\n</div>\n`
        // Every alias uses the same external script under its build's scope.
        + `<script src="${siteUrlForPermalink(`/${MOVED_SCRIPT}`, baseurl)}"></script>\n`,
    );
    redirectedPaths += 1;
  }
  const movedScript = join(outRoot, MOVED_SCRIPT);
  if (existsSync(movedScript)) fail(`${MOVED_SCRIPT} is builder-owned; remove the authored copy before building`);
  mkdirSync(join(movedScript, ".."), { recursive: true });
  writeFileSync(movedScript, 'const movedUrl = document.querySelector(\'link[rel="canonical"]\')?.href;\nif (movedUrl) location.replace(movedUrl + location.search + location.hash);\n');

  if (release === null) {
    mkdirSync(join(outRoot, folder), { recursive: true });
    writeFileSync(join(outRoot, folder, "index.md"), versionsPage(versions, baseurl, coordinates));
    writeFileSync(join(outRoot, folder, "versions.json"), `${JSON.stringify({ current: "main", versions: versions.map((version) => ({ version, path: `/${folder}/${version}/` })) }, null, 2)}\n`);
  }

  // Every coordinate a page reads comes from the repository's one
  // identity (the forge section) and the deployment's base path.
  const configPath = join(outRoot, "_config.yml");
  writeFileSync(configPath, configWith(readFileSync(configPath, "utf8"), {
    url: coordinates.siteOrigin,
    baseurl,
    repository: coordinates.repository,
    repository_url: coordinates.repositoryUrl,
    security_url: `${coordinates.repositoryUrl}/blob/${coordinates.defaultBranch}/SECURITY.md`,
    product_repository: coordinates.productRepository,
    product_repository_url: coordinates.productRepositoryUrl,
    docs_url: coordinates.docsUrl,
    preview_repository_url: coordinates.previewRepositoryUrl,
    versions_url: SITE_LINKS.versions,
    release_version: release ?? "",
    relative_links: { enabled: false },
  }));
  // The floor pages read their data from floor/data; every build writes it
  // ({@link floorDataOf}), so a release snapshot keeps its own data and assets.
  const { atlas, status } = await floorData(repositoryRoot);
  mkdirSync(join(outRoot, "floor/data"), { recursive: true });
  writeFileSync(join(outRoot, "floor/data/atlas.json"), stableJson(atlas));
  writeFileSync(join(outRoot, "floor/data/status.json"), stableJson(status));
  // The design system's generated half: the token sheet, fonts, icon, mark
  // and figures, from their one owners (`site-design.mjs`).
  writeSiteDesign({ root: repositoryRoot, outRoot, baseurl });
  for (const [path, text] of [[CONTENT_INCLUDE, pageContentInclude()], [SITE_PLAN_FILE, `${JSON.stringify(sitePlanProjection({ plan, baseurl, release }), null, 2)}\n`]]) {
    const file = join(outRoot, path);
    if (existsSync(file)) fail(`${path} is builder-owned; remove the authored copy before building`);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, text);
  }
  // Every stylesheet this source hands Jekyll reads the owner's tokens and
  // declares none of its own, and no layout, include or HTML page carries a
  // style or loads from elsewhere (`site-style.mjs`).
  const style = judgeSiteStyles({ root: repositoryRoot, sourceRoot: outRoot });
  if (style.findings.length > 0) fail(`${String(style.findings.length)} style finding(s): the site's sheets and markup read the one design system (scripts/floor/site-style.mjs):\n  ${style.findings.join("\n  ")}`);

  // Jekyll decides which source constructs are actual links. The mandatory
  // rendered pass resolves those attributes before the merged artifact crawl.

  return {
    out: outRoot,
    baseurl,
    pages: [...plan.byPermalink.keys()].length,
    rewrittenLinks,
    frontMatterPages,
    artifacts: release === null ? plan.artifacts : [],
    redirectedPaths,
    versions,
    release,
  };
}

/** Build declared live artifacts from trusted source builders, then copy their complete fresh outputs. */
export async function assembleLiveArtifacts({ root, site, outRoot, baseurl, builders, statusFile, coordinates = COORDINATES }) {
  const repositoryRoot = resolveLocation(resolve(root), "artifact source checkout");
  const siteRoot = resolveLocation(resolve(site), "built site");
  if (!lstatSync(siteRoot, { throwIfNoEntry: false })?.isDirectory()) fail("live artifacts need an existing built site directory");
  const plan = sitePlan({ root: repositoryRoot, coordinates });
  if (plan.collisions.length > 0) fail(`live artifacts require a valid publish plan: ${plan.collisions.join("; ")}`);
  const output = requireNewOutput(repositoryRoot, outRoot);
  const overlap = identityOverlapIndex();
  if (overlap.overlaps(output, repositoryRoot) || overlap.overlaps(output, siteRoot)) fail("live artifact build output must be outside the checkout and built site");
  const work = plan.artifacts.map((artifact, index) => {
    const builder = Object.hasOwn(builders, artifact.sourceEntry) ? builders[artifact.sourceEntry] : undefined;
    if (typeof builder !== "function") fail(`no trusted builder owns live artifact ${artifact.sourceEntry}`);
    const destination = join(siteRoot, artifact.outputPath.slice(1));
    if (lstatSync(destination, { throwIfNoEntry: false }) !== undefined) fail(`live artifact destination already exists; existing work is preserved: ${artifact.outputPath}`);
    return { artifact, builder, destination, out: join(output, String(index)) };
  });
  // Validate the whole plan before the first producer writes anything.
  mkdirSync(output, { recursive: true });
  const artifacts = [];
  for (const entry of work) {
    const result = await entry.builder({ root: repositoryRoot, out: entry.out, baseurl: siteUrlForPermalink(entry.artifact.outputPath, baseurl).replace(/\/+$/u, ""), ...(statusFile === undefined ? {} : { statusFile }) });
    if (result === null || typeof result !== "object" || typeof result.out !== "string" || resolveLocation(resolve(result.out), "artifact result") !== entry.out) fail(`live artifact ${entry.artifact.sourceEntry} returned a different output; an uploaded bundle is not accepted`);
    if (!lstatSync(join(entry.out, "index.html"), { throwIfNoEntry: false })?.isFile()) fail(`live artifact ${entry.artifact.sourceEntry} did not build a regular index.html`);
    cpSync(entry.out, entry.destination, { recursive: true, errorOnExist: true, force: false, filter: (file, destination) => {
      const item = lstatSync(file);
      if (!item.isFile() && !item.isDirectory()) fail(`live artifact ${entry.artifact.sourceEntry} contains a non-regular output entry`);
      const path = relativePosix(siteRoot, destination);
      if (!servedStatic(path)) fail(`live artifact ${entry.artifact.sourceEntry} contains output Jekyll will omit: ${path}`);
      return true;
    } });
    artifacts.push({ sourceEntry: entry.artifact.sourceEntry, outputPath: entry.artifact.outputPath });
  }
  return { artifacts };
}

/** Resolve actual attributes after Jekyll, whose configured Markdown grammar decides what is a link. */
export function resolveSitePageLinks({ root = SITE_SOURCE_ROOT, site, baseurl, release = null, coordinates = COORDINATES }) {
  const siteRoot = resolve(site);
  const plan = sitePlan({ root, coordinates, snapshot: release !== null });
  if (plan.collisions.length > 0) fail(`rendered links require a valid publish plan: ${plan.collisions.join("; ")}`);
  const documentFacts = readSiteDocumentFiles({ site: siteRoot, phase: "source", root, baseurl, release, coordinates });
  const recorded = documentFacts.projection;
  const folder = versionsFolder(coordinates);
  if (release !== null && (!VERSION.test(release) || !baseurl.endsWith(`/${folder}/${release}`))) fail("rendered release links need their exact documentation version base");
  const liveBaseurl = release === null ? baseurl : baseurl.slice(0, -`/${folder}/${release}`.length);
  const versionIndex = new URL(siteUrlForPermalink(`/${folder}/`, liveBaseurl), coordinates.siteOrigin).pathname;
  const resolveGlobalText = (text) => {
    let at = text.indexOf(SITE_LINKS.versions);
    while (at !== -1) {
      if (/^(?:[A-Za-z0-9/_%~-]|\.[A-Za-z0-9])/u.test(text.slice(at + SITE_LINKS.versions.length))) return { error: "unsupported builder link suffix in rendered text" };
      at = text.indexOf(SITE_LINKS.versions, at + SITE_LINKS.versions.length);
    }
    const target = text.replaceAll(SITE_LINKS.versions, versionIndex);
    return target.toLowerCase().includes(SITE_LINK_PREFIX) ? { error: "unsupported builder link marker remains in rendered text" } : { target };
  };
  const pagePaths = new Set([...plan.byPermalink.keys(), ...landingMap(plan).keys()]);
  const pending = [];
  const errors = [...documentFacts.errors];
  const authored = documentFacts.planned.filter((page) => !page.artifact);
  const authoredPages = new Map(authored.filter((page) => page.file !== null).map((page) => [page.file, plan.bySource.get(page.sourceId)]));
  let rewritten = 0;
  let verifiedReferences = 0;
  const pages = authored.length;
  for (const file of documentFacts.documentFiles) {
    const relative = relativePosix(siteRoot, file);
    if (plan.artifacts.some((artifact) => relative.startsWith(artifact.outputPath.slice(1)))) continue;
    const page = authoredPages.get(file);
    const original = readFileSync(file, "utf8");
    const result = rewriteRenderedPageLinks(original, (target, { authored, sourceReference }) => {
      if (sourceReference !== undefined) {
        let sourceId;
        try { sourceId = readSiteSourceReference(sourceReference); }
        catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
        const referenced = plan.bySource.get(sourceId);
        if (referenced === undefined || referenced.permalink === null) return { error: `builder source reference names no published source: ${sourceId}` };
        const expected = siteUrlForPage(referenced, { baseurl, liveBaseurl, plan });
        // The navigation producer emits a root-relative URL. Only that exact
        // source-plan path is vouched for; query and fragment remain intact.
        if (!target.startsWith("/") || target.startsWith("//") || siteLinkPath(target).path !== siteLinkPath(expected).path) return { error: `builder source reference ${sourceId} does not match URL ${target}; expected ${expected}` };
        return { target, sourceVerified: true };
      }
      if (target.toLowerCase().startsWith(SITE_LINK_PREFIX)) {
        const { path, suffix } = siteLinkPath(target);
        return path === SITE_LINKS.versions ? { target: `${versionIndex}${suffix}` } : { error: `unsupported builder link ${target}` };
      }
      if (page === undefined || !authored) return { target };
      let sitePath = target.startsWith("/") && !target.startsWith("//") ? target : null;
      if (/^(?:https?:|\/\/)/iu.test(target)) {
        const url = new URL(target, coordinates.siteOrigin);
        if (url.origin === coordinates.siteOrigin) sitePath = `${url.pathname}${url.search}${url.hash}`;
      }
      if (sitePath !== null) {
        const path = posix.normalize(siteLinkPath(sitePath).path);
        const underBase = sitePathUnderBase(path, baseurl);
        const logical = underBase ?? path;
        if (inVersionsFolder(logical, coordinates) || (underBase === null && path.startsWith(versionIndex))) return { error: `links ${target} in the versions folder without using site.versions_url` };
        if (path.endsWith("/") || pagePaths.has(logical) || pagePaths.has(`${logical}/`)) return { error: `spells the page URL ${target}; use a source-relative page link so the publish plan owns its placement` };
      }
      return rewriteTarget(target, { root, pageDocsPath: page.docsPath, baseurl, liveBaseurl, plan });
    }, { contentRequired: page !== undefined, resolveText: resolveGlobalText });
    errors.push(...result.errors.map((message) => `${page?.docsPath ?? relative}: ${message}`));
    const html = result.html;
    if (html.toLowerCase().includes(SITE_LINK_PREFIX)) errors.push(`${page?.docsPath ?? relative}: unsupported builder link marker remains in rendered output`);
    rewritten += result.rewritten;
    verifiedReferences += result.verifiedReferences;
    if (html !== original) pending.push({ file, html });
  }
  if (errors.length > 0) fail(`the rendered site refuses:\n  ${errors.join("\n  ")}`);
  for (const { file, html } of pending) writeFileSync(file, html);
  writeFileSync(join(siteRoot, SITE_PLAN_FILE), `${JSON.stringify({ ...recorded, phase: "links-resolved" }, null, 2)}\n`);
  return { pages, rewritten, verifiedReferences };
}

/**
 * Step 3 (see the header): merge each snapshot of `versionsDir` into
 * `site/docs/v/<version>/`, then judge the whole output. Throws with every
 * unresolved link or design finding; answers the counts.
 */
export function finishSite({ site, baseurl, versionsDir = null, coordinates = COORDINATES, root = SITE_SOURCE_ROOT }) {
  const siteRoot = resolve(site);
  if (!existsSync(join(siteRoot, "index.html"))) fail(`${siteRoot} is not a built site (no index.html)`);
  const versions = readVersions(versionsDir);
  const folder = versionsFolder(coordinates);
  const listed = JSON.parse(readFileSync(join(siteRoot, folder, "versions.json"), "utf8")).versions.map((entry) => entry.version);
  if (JSON.stringify(listed) !== JSON.stringify(versions)) {
    fail(`the source listed the versions [${listed.join(", ")}] but the snapshot folder holds [${versions.join(", ")}]: build both steps from one folder`);
  }

  const plan = sitePlan({ root, coordinates });
  if (plan.collisions.length > 0) fail(`the source publish plan refuses:\n  ${plan.collisions.join("\n  ")}`);
  for (const artifact of plan.artifacts) {
    if (!existsSync(join(siteRoot, artifact.outputPath.slice(1), "index.html"))) fail(`the built site is missing live artifact ${artifact.sourceEntry} at ${artifact.outputPath}`);
  }
  for (const version of versions) {
    if (existsSync(join(siteRoot, folder, version))) fail(`the built site already holds /${folder}/${version}/: a snapshot never overwrites a page`);
  }
  resolveSitePageLinks({ root, site: siteRoot, baseurl, coordinates });
  for (const version of versions) cpSync(join(versionsDir, version), join(siteRoot, folder, version), { recursive: true });
  const links = crawlSiteLinks({ siteRoot, baseurl, siteOrigin: coordinates.siteOrigin });
  const plannedPages = new Set([...plan.byPermalink.keys(), ...legacyAliases(plan).map(([alias]) => alias.endsWith("/") ? alias : `${alias}/`), `/${folder}/`]);
  const plannedNamespaces = [...versions.map((version) => `/${folder}/${version}/`), ...plan.artifacts.map((artifact) => artifact.outputPath)];
  const unowned = htmlPages(siteRoot).map((path) => ({ path, url: pageUrlForSitePath(path) })).filter(({ url }) => !plannedPages.has(url) && !plannedNamespaces.some((prefix) => url.startsWith(prefix)));
  const design = coverage(siteRoot, { exclude: [...versions.map((version) => `/${folder}/${version}/`), ...plan.artifacts.map((artifact) => artifact.outputPath)] });
  const findings = [
    ...unowned.map(({ path }) => `plan: ${path} is not owned by the publish plan, a verified snapshot or a trusted live artifact`),
    // An allow-list judged on what was built: every HTML file Pages serves
    // carries the site's two policies first, whatever produced it.
    ...builtPolicyViolations({ siteRoot, baseurl, versions, coordinates, root }).map((finding) => `policy: ${finding}`),
    ...links.unresolved.map((entry) => `link: ${entry.page}: ${entry.href} → ${entry.resolved}`),
    ...[...design.missing].map(([name, pages]) => `design: .${name} has no CSS rule (${pages.slice(0, 3).join(", ")})`),
    ...[...design.unused].map(([name]) => `design: floor.css declares .${name} but no page uses it`),
  ];
  if (findings.length > 0) fail(`the built site refuses:\n  ${findings.join("\n  ")}`);
  return { pages: links.pages, links: links.links, versions, designPages: design.jekyllPages };
}

/**
 * Whether the whole URL `url` is `base` or lies under it: the same origin,
 * and the same path or a path below it (a trailing slash aside). A URL
 * that only shares a path with `base` on another host is not under it.
 */
export function urlUnder(url, base) {
  const target = new URL(url);
  const root = new URL(base);
  const path = target.pathname.replace(/\/+$/u, "");
  const rootPath = root.pathname.replace(/\/+$/u, "");
  return target.origin === root.origin && (path === rootPath || path.startsWith(`${rootPath}/`));
}

/**
 * The redirect for a whole URL under the old site `from`: where the landing
 * map (`landing`, plain `{ old path: new path }`, both URL-encoded by
 * `encodeURI`) sends its path under `to`,
 * or the same path, with the query and fragment kept. A URL outside `from`
 * (another host, a sibling path) answers `null`: the redirect site claims
 * nothing else. Self-contained: the organisation's `404.html` runs its very
 * source.
 */
export function redirectTarget(href, { from, to, landing }) {
  const url = new URL(href);
  const base = new URL(from);
  const basePath = base.pathname.replace(/\/+$/u, "");
  if (url.origin !== base.origin || (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`))) return null;
  const rest = url.pathname.slice(basePath.length) || "/";
  // The map's spelling: the path decoded, then encoded as `encodeURI` does
  // (a browser escapes a few characters it does not).
  let key = rest;
  try {
    key = encodeURI(decodeURI(rest));
  } catch {
    // A malformed escape is a path no page has: it lands as written.
  }
  const own = (name) => Object.prototype.hasOwnProperty.call(landing, name);
  const landed = own(key) ? landing[key] : own(`${key}/`) ? landing[`${key}/`] : rest;
  return `${to.replace(/\/+$/u, "")}${landed}${url.search}${url.hash}`;
}

/**
 * `value` as JSON for a `<script>` element. Nothing is escaped here (the one
 * markup owner is `shared/markup.ts`): every string the redirect site embeds
 * is a URL the URL parser or `encodeURI` spelled, which holds no `<` or `>`,
 * so no `</script>` or `<!--` can occur. One that did would refuse the build.
 */
function scriptJson(value) {
  const json = JSON.stringify(value);
  if (/[<>]/u.test(json)) fail(`the redirect site would embed markup in a script: ${json}`);
  return json;
}

/**
 * THE ORGANISATION SITE'S TREE, at `out`: what `<owner>.github.io` serves for
 * the old base once the repository is renamed. Every path is computed from
 * the plan of the tree at `root` and the identity (`from`, `to`); nothing is
 * kept by hand.
 * - `<old base>/<path>/index.html` for every pretty path an old link may
 *   name (each page's URL and each landing-map entry, the old base's root
 *   among them): it redirects to `to` + {@link landingPath}, in one hop and
 *   without scripts too (`meta refresh`), keeps the query and fragment when
 *   scripts run, and names that exact target as its `rel=canonical`.
 * - `404.html`: Pages serves it for every other path (an asset, a `.md`
 *   spelling, a path without its slash); it runs {@link redirectTarget}
 *   over the embedded landing map. A 404 response has no canonical.
 * - `.nojekyll`: the tree is served as written.
 * The loop guard compares whole URLs: a `to` that is `from` or lies under it
 * (before the rename the old base IS the site) refuses.
 */
export function buildRedirectSite({ root, out, from = LEGACY_SITE_URL, to = SITE_URL, coordinates = COORDINATES }) {
  if (urlUnder(to, from)) {
    fail(`the site still answers at ${to}, which is ${from} or under it: there is nothing to redirect until the repository is renamed (a redirect would loop)`);
  }
  const plan = sitePlan({ root: resolve(root), coordinates });
  const landing = Object.fromEntries([...landingMap(plan)].map(([oldPath, newPath]) => [encodeURI(oldPath), encodeURI(newPath)]));
  const oldSite = new URL(from).href;
  const newSite = new URL(to).href;
  const oldBase = new URL(oldSite).pathname.split("/").filter(Boolean);
  const site = newSite.replace(/\/+$/u, "");
  const outRoot = requireNewOutput(root, out);
  const head = (title) => `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${escapeHtml(title)}</title>\n`;
  const files = [];
  const oldPaths = [...new Set([...plan.byPermalink.keys(), ...Object.keys(landing)])].filter((path) => path.endsWith("/")).sort();
  for (const oldPath of oldPaths) {
    const segments = oldPath.split("/").filter(Boolean);
    if (segments.some((segment) => segment === "." || segment === "..")) fail(`the old path ${oldPath} is not a path under ${from}`);
    const target = `${site}${encodeURI(landingPath(oldPath, plan))}`;
    const file = join(outRoot, ...oldBase, ...segments, "index.html");
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, `${head("Bridlewise moved")}<meta http-equiv="refresh" content="0; url=${escapeHtml(target)}">\n<link rel="canonical" href="${escapeHtml(target)}">\n`
      + `<script>location.replace(${scriptJson(target)} + location.search + location.hash);</script>\n</head>\n<body>\n<p>This page moved to <a href="${escapeHtml(target)}">${escapeHtml(target)}</a>.</p>\n</body>\n</html>\n`);
    files.push(file);
  }
  const fallback = join(outRoot, "404.html");
  writeFileSync(fallback, `${head("Bridlewise moved")}<meta name="robots" content="noindex">\n`
    + `<script>\n${redirectTarget.toString()}\nvar target = redirectTarget(location.href, ${scriptJson({ from: oldSite, to: newSite, landing })});\nif (target !== null) location.replace(target);\n</script>\n`
    + `</head>\n<body>\n<p>Bridlewise moved to <a href="${escapeHtml(to)}">${escapeHtml(to)}</a>.</p>\n</body>\n</html>\n`);
  files.push(fallback);
  const nojekyll = join(outRoot, ".nojekyll");
  writeFileSync(nojekyll, "");
  files.push(nojekyll);
  return { out: outRoot, from, to, files };
}
