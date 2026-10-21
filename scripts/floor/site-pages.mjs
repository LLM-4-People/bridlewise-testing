/**
 * THE FLOOR SITE'S PUBLISH PLAN AND LINK MAP — one owner.
 *
 * The site is assembled from two checkouts: the product documentation mirror
 * (`--product <product>/docs`) and this testing checkout. A page published on
 * the site has a SOURCE file in one of them and a PERMALINK (Jekyll
 * `permalink: pretty`, or the page's own front matter). A relative Markdown
 * link in a copied testing page is written for GitHub, where it resolves
 * against the repository tree; the site page lives at its pretty URL, one or
 * more path segments away from the source file. The same link therefore
 * cannot be right in both places unless one side is rewritten.
 *
 * This module is that mapping, used by:
 *   - `assembleFloorSite` (scripts/floor/site.mjs) to publish the pages and
 *     rewrite the copied testing pages' relative links to their site URLs;
 *   - `scripts/check-docs-links.mjs`, so a floor page linking to a docs path
 *     the assembler does not publish fails in the normal test run;
 *   - the site-link crawler's fixtures (the mapping explains the expected
 *     `/floor/trackers/TASKS.md` pre-fix shape).
 *
 * THE COMMITTED SOURCE IS NEVER TOUCHED. GitHub keeps rendering the relative
 * paths; only the assembled copy is rewritten.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve, sep } from "node:path";

/** The testing repository a non-published relative target is linked to. */
export const TESTING_REPO_URL = "https://github.com/LLM-4-People/bridlewise-testing";
export const TESTING_REPO_BRANCH = "main";

/**
 * The testing trees the assembler copies wholesale. `siteRoot` is where the
 * tree lands in the Jekyll source, which is also where its permalinks start.
 * Adding a tree here is the ONE change that makes its pages publishable.
 */
export const FLOOR_COPY_ROOTS = Object.freeze([
  Object.freeze({ docsRoot: "docs/floor", siteRoot: "floor" }),
  Object.freeze({ docsRoot: "docs/trackers", siteRoot: "trackers" }),
]);

/**
 * Testing pages copied OVER the product mirror at the site root. The hub
 * replaces the product home, and the product entry page is the floor's own.
 */
export const FLOOR_OVERLAY_PAGES = Object.freeze([
  Object.freeze({ docsPath: "docs/index.md", sitePath: "index.md" }),
  Object.freeze({ docsPath: "docs/product.md", sitePath: "product.md" }),
]);

const MARKDOWN_LINK = /(!?\[[^\]]*\]\()([^)\s]+)((?:\s+"[^"]*")?\))/gu;
const EXTERNAL_OR_ABSOLUTE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#|\{\{|\{%|<)/iu;

function toPosix(path) {
  return path.split(sep).join("/");
}

function readPage(file) {
  const text = readFileSync(file, "utf8");
  const data = {};
  const endOfOpening = text.startsWith("---\n") ? 3 : text.startsWith("---\r\n") ? 4 : -1;
  if (endOfOpening !== -1) {
    const end = text.indexOf("\n---", endOfOpening);
    if (end !== -1) {
      const block = text.slice(endOfOpening, end);
      for (const line of block.split(/\r?\n/u)) {
        const match = /^([A-Za-z0-9_-]+):\s*(.*)$/u.exec(line);
        if (match === null) continue;
        let value = match[2].trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
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

/** The pretty URL Jekyll derives from a docs-relative Markdown path. */
export function prettyPermalink(docsPath) {
  const relative = docsPath.replace(/^docs\//u, "").replace(/\.md$/iu, "");
  if (relative === "index") return "/";
  if (relative.endsWith("/index")) return `/${relative.slice(0, -"/index".length)}/`;
  return `/${relative}/`;
}

function pageSource({ docsPath, productRoot, testingRoot }) {
  const testingFile = resolve(testingRoot, ...docsPath.split("/"));
  for (const { docsRoot } of FLOOR_COPY_ROOTS) {
    if (docsPath.startsWith(`${docsRoot}/`)) {
      return existsSync(testingFile) ? { file: testingFile, owner: "testing" } : null;
    }
  }
  for (const overlay of FLOOR_OVERLAY_PAGES) {
    if (docsPath === overlay.docsPath) {
      return existsSync(testingFile) ? { file: testingFile, owner: "testing" } : null;
    }
  }
  // A top-level docs page is product documentation (the mirror is the
  // reference) or, when the mirror lacks it, the testing page is copied in as
  // a self-contained fallback. A subdirectory page is NOT published this way:
  // it may depend on assets and relative structure the copy would not carry.
  if (!/^docs\/[^/]+\.md$/iu.test(docsPath)) return null;
  if (productRoot !== undefined) {
    const productFile = resolve(productRoot, docsPath.slice("docs/".length));
    if (existsSync(productFile)) return { file: productFile, owner: "product" };
  }
  return existsSync(testingFile) ? { file: testingFile, owner: "testing-fallback" } : null;
}

/**
 * The published page for a docs-relative Markdown path, or `null` when the
 * assembler does not publish it. `productRoot` is optional: without it (the
 * docs-links check, which runs against this checkout alone) a top-level page
 * is judged publishable because the assembler mirrors it or copies the
 * testing fallback.
 */
export function publishedDocsPage({ docsPath, productRoot, testingRoot }) {
  const source = pageSource({ docsPath, productRoot, testingRoot });
  if (source === null) return null;
  const { data } = readPage(source.file);
  if (String(data["published"]).toLowerCase() === "false") return null;
  const permalink =
    typeof data["permalink"] === "string" && data["permalink"].length > 0
      ? normalizePermalink(data["permalink"])
      : prettyPermalink(docsPath);
  return { sourceFile: source.file, owner: source.owner, permalink };
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
  return resolved.startsWith("docs/") ? resolved : null;
}

/**
 * Rewrite one relative target. A relative non-Markdown target is repository
 * content the site does not serve (a test, a workflow, a script); the
 * assembled page keeps a working link by naming its GitHub location. The
 * committed Markdown stays relative, so GitHub renders it against the tree.
 *
 * `unpublishedDocs` is `"error"` for the floor's own pages (a link to a page
 * the plan does not publish is a 404 the assembly must refuse) and
 * `"github"` for a testing page copied as a product fallback: that page is
 * product documentation, and a process-document link it carries is served by
 * the repository, not the site.
 */
function rewriteTarget(target, { pageDocsPath, testingRoot, productRoot, baseurl, unpublishedDocs = "error" }) {
  if (EXTERNAL_OR_ABSOLUTE.test(target)) return target;
  const hashIndex = target.indexOf("#");
  const hash = hashIndex === -1 ? "" : target.slice(hashIndex);
  const pathPart = (hashIndex === -1 ? target : target.slice(0, hashIndex)).split("?")[0];
  if (pathPart.length === 0) return target;

  const docsTarget = resolveDocsTarget(pageDocsPath, pathPart);
  if (docsTarget !== null) {
    const page = publishedDocsPage({ docsPath: docsTarget, productRoot, testingRoot });
    if (page === null) {
      if (unpublishedDocs === "github") {
        const repoFile = resolve(testingRoot, ...docsTarget.split("/"));
        if (existsSync(repoFile)) {
          return `${TESTING_REPO_URL}/blob/${TESTING_REPO_BRANCH}/${docsTarget}${hash}`;
        }
      }
      throw new Error(
        `${pageDocsPath}: link '${target}' targets ${docsTarget}, which the floor site does not publish ` +
          "(see scripts/floor/site-pages.mjs's copy roots and overlay pages)",
      );
    }
    return `${siteUrlForPermalink(page.permalink, baseurl)}${hash}`;
  }

  // A relative non-Markdown target is repository content the site does not
  // serve (a test, a workflow, a script). The assembled page keeps a working
  // link by naming its GitHub location; the committed Markdown stays relative.
  const repoPath = posix.normalize(posix.join(posix.dirname(pageDocsPath), pathPart));
  if (repoPath.startsWith("docs/assets/")) {
    return `${siteUrlForPermalink(`/${repoPath.slice("docs/".length)}`, baseurl)}${hash}`;
  }
  const repoFile = resolve(testingRoot, ...repoPath.split("/"));
  if (!existsSync(repoFile)) {
    throw new Error(`${pageDocsPath}: link '${target}' names ${repoPath}, which does not exist in the testing checkout`);
  }
  const kind = statSync(repoFile).isDirectory() ? "tree" : "blob";
  return `${TESTING_REPO_URL}/${kind}/${TESTING_REPO_BRANCH}/${repoPath}${hash}`;
}

/**
 * Rewrite every relative Markdown link in one copied page. Absolute URLs,
 * site URLs, Liquid expressions, anchors and mailto links are untouched; a
 * docs page the assembler does not publish is an ASSEMBLY ERROR by default,
 * because publishing it would ship a 404. A copied product fallback passes
 * `unpublishedDocs: "github"` instead: its non-site links are repository
 * documents and the GitHub URL is where they live.
 */
export function rewritePageLinks(markdown, options) {
  let rewritten = 0;
  const text = markdown.replace(MARKDOWN_LINK, (whole, prefix, target, suffix) => {
    const next = rewriteTarget(target, options);
    if (next !== target) rewritten += 1;
    return `${prefix}${next}${suffix}`;
  });
  return { text, rewritten };
}

function markdownFiles(directory) {
  if (!existsSync(directory)) return [];
  const out = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "data") continue;
      out.push(...markdownFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Publish a testing fallback page the product mirror does not provide, and
 * answer the docs paths copied so the caller can rewrite them too. Only a
 * top-level page can be a fallback (see `pageSource`); its site path is the
 * same file name at the site root.
 */
export function materializeFloorFallbacks({ outRoot, productRoot, testingRoot }) {
  const copied = [];
  for (const page of floorPages({ testingRoot })) {
    for (const link of page.links) {
      const docsPath = resolveDocsTarget(page.docsPath, link);
      if (docsPath === null) continue;
      const published = publishedDocsPage({ docsPath, productRoot, testingRoot });
      if (published === null || published.owner !== "testing-fallback") continue;
      const sitePath = docsPath.slice("docs/".length);
      const destination = join(outRoot, ...sitePath.split("/"));
      if (!existsSync(destination)) {
        mkdirSync(dirname(destination), { recursive: true });
        copyFileSync(published.sourceFile, destination);
      }
      copied.push(docsPath);
    }
  }
  return [...new Set(copied)];
}

/**
 * Jekyll converts a Markdown file to a page only when it has YAML front
 * matter; without it the file is copied verbatim as a static asset and the
 * pretty URL the floor links to is never built. The tracker pages are plain
 * Markdown (`TASKS.md` starts with its heading), so the ASSEMBLED copy gets a
 * front matter block with the plan's permalink. The committed source is not
 * edited: GitHub renders it as before.
 *
 * A page that already has front matter is left alone (it may carry a permalink
 * the plan read, or `published: false`).
 */
/**
 * Legacy URL shapes that must keep working: links written before the trackers
 * moved out of `floor/` still say `floor/trackers/TASKS.md`, and GitHub-style
 * readers append `.md`. Each alias is a redirect, never a second page.
 */
export function legacyAliasesFor(docsPath, permalink) {
  const base = docsPath.split("/").pop().replace(/\.md$/u, "");
  const aliases = new Set([`${permalink.replace(/\/$/u, "")}.md`]);
  if (docsPath.startsWith("docs/trackers/")) {
    aliases.add(`/floor/trackers/${base}.md`);
    aliases.add(`/floor/trackers/${base}/`);
  }
  return [...aliases].filter((alias) => alias !== permalink);
}

export function materializePageFrontMatter({ outRoot, fallbackPages = [] }) {
  const pages = [];
  for (const { docsRoot, siteRoot } of FLOOR_COPY_ROOTS) {
    const directory = join(outRoot, siteRoot);
    for (const file of markdownFiles(directory)) {
      const relative = toPosix(file.slice(directory.length)).replace(/^\/+/u, "");
      pages.push({ file, docsPath: `${docsRoot}/${relative}` });
    }
  }
  for (const docsPath of fallbackPages) {
    pages.push({ file: join(outRoot, ...docsPath.slice("docs/".length).split("/")), docsPath });
  }

  let added = 0;
  for (const { file, docsPath } of pages) {
    const text = readFileSync(file, "utf8");
    if (text.startsWith("---\n") || text.startsWith("---\r\n")) continue;
    const heading = /^#\s+(.+?)\s*$/mu.exec(text)?.[1]?.replace(/[*_`]/gu, "");
    const title = heading ?? docsPath.split("/").pop().replace(/\.md$/u, "");
    const permalink = prettyPermalink(docsPath);
    writeFileSync(
      file,
      `---\nlayout: default\ntitle: ${JSON.stringify(title)}\npermalink: ${permalink}\n---\n\n${text}`,
    );
    added += 1;
  }
  return added;
}

/**
 * Serve the older URL shapes as real pages. A `redirect_from` header needs the
 * jekyll-redirect-from plugin, and this build proved it was not loaded (the
 * old URLs stayed 404), so the alias is written as a static page: a browser
 * landing on `/floor/trackers/TASKS.md/` is sent to the published page. The
 * directory form means Pages answers the no-slash spelling with a 301 first.
 */
export function materializeLegacyRedirects({ outRoot, baseurl = "", fallbackPages = [] }) {
  const pages = [];
  for (const { docsRoot, siteRoot } of FLOOR_COPY_ROOTS) {
    const directory = join(outRoot, siteRoot);
    for (const file of markdownFiles(directory)) {
      const relative = toPosix(file.slice(directory.length)).replace(/^\/+/u, "");
      pages.push({ docsPath: `${docsRoot}/${relative}` });
    }
  }
  for (const docsPath of fallbackPages) pages.push({ docsPath });
  const prefix = baseurl.replace(/\/$/u, "");
  let written = 0;
  for (const { docsPath } of pages) {
    const permalink = prettyPermalink(docsPath);
    for (const alias of legacyAliasesFor(docsPath, permalink)) {
      const target = `${prefix}${permalink}`;
      const directory = join(outRoot, ...alias.split("/").filter(Boolean));
      // A copied file may already sit at this spelling (a README, for one).
      // It is reachable as it stands, so an alias directory cannot take its
      // name and does not need to.
      if (existsSync(directory) && !statSync(directory).isDirectory()) continue;
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, "index.html"),
        `<!doctype html>\n<meta charset="utf-8">\n<title>Moved</title>\n` +
          `<link rel="canonical" href="${target}">\n` +
          `<meta http-equiv="refresh" content="0; url=${target}">\n` +
          `<p>This page moved to <a href="${target}">${target}</a>.</p>\n`,
      );
      written += 1;
    }
  }
  return written;
}

/** Rewrite the copied testing pages in place; answer how many links moved. */
export function rewriteCopiedDocsPages({ outRoot, productRoot, testingRoot, baseurl, fallbackPages = [] }) {
  let rewritten = 0;
  const trees = FLOOR_COPY_ROOTS.map(({ docsRoot, siteRoot }) => ({
    docsRoot,
    directory: join(outRoot, siteRoot),
  }));
  for (const { docsRoot, directory } of trees) {
    for (const file of markdownFiles(directory)) {
      const relative = toPosix(file.slice(directory.length)).replace(/^\/+/u, "");
      const pageDocsPath = `${docsRoot}/${relative}`;
      // A copied page with `published: false` is not in the site's output
      // (`docs/floor/README.md` is integration notes), so its links are not
      // the site's links and must not make the assembly fail.
      if (publishedDocsPage({ docsPath: pageDocsPath, productRoot, testingRoot }) === null) continue;
      const result = rewritePageLinks(readFileSync(file, "utf8"), {
        pageDocsPath,
        productRoot,
        testingRoot,
        baseurl,
      });
      if (result.rewritten > 0) writeFileSync(file, result.text);
      rewritten += result.rewritten;
    }
  }
  for (const docsPath of fallbackPages) {
    const file = join(outRoot, ...docsPath.slice("docs/".length).split("/"));
    if (!existsSync(file)) continue;
    const result = rewritePageLinks(readFileSync(file, "utf8"), {
      pageDocsPath: docsPath,
      productRoot,
      testingRoot,
      baseurl,
      unpublishedDocs: "github",
    });
    if (result.rewritten > 0) writeFileSync(file, result.text);
    rewritten += result.rewritten;
  }
  return rewritten;
}

/** Every copied testing page with its docs path and relative Markdown links. */
function floorPages({ testingRoot }) {
  const pages = [];
  for (const { docsRoot } of FLOOR_COPY_ROOTS) {
    const directory = resolve(testingRoot, ...docsRoot.split("/"));
    for (const file of markdownFiles(directory)) {
      const relative = toPosix(file.slice(directory.length)).replace(/^\/+/u, "");
      const docsPath = `${docsRoot}/${relative}`;
      const { text, data } = readPage(file);
      if (String(data["published"]).toLowerCase() === "false") continue;
      const links = [];
      for (const match of text.matchAll(MARKDOWN_LINK)) links.push(match[2]);
      pages.push({ docsPath, links });
    }
  }
  return pages;
}

/**
 * The docs-links guard: a floor/tracker page may only link to a docs page the
 * assembler publishes. Returns `{ page, target, docsPath }` for each link that
 * would 404 on the site.
 */
export function floorPageLinkViolations({ testingRoot }) {
  const violations = [];
  for (const page of floorPages({ testingRoot })) {
    for (const target of page.links) {
      const docsPath = resolveDocsTarget(page.docsPath, target);
      if (docsPath === null) continue;
      if (publishedDocsPage({ docsPath, testingRoot }) === null) {
        violations.push({ page: page.docsPath, target, docsPath });
      }
    }
  }
  return violations;
}
