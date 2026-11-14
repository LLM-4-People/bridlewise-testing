#!/usr/bin/env node
/**
 * THE BUILT SITE'S INTERNAL-LINK CRAWLER — guard the ARTIFACT, not the source.
 *
 * The assembly check proves a copied Markdown page names pages the plan
 * publishes. It cannot prove Jekyll emitted what the plan expected: a
 * permalink override, a page excluded by `published: false`, a page a plugin
 * dropped, or a hand-written site URL can all leave an `href` pointing at
 * nothing. This walks the BUILT `_site` and asks one question of every
 * internal `href`/`src`:
 *
 *   does it resolve to a built page (`dir/index.html`), an asset, or a
 *   permitted external URL?
 *
 * A miss fails the run with the page and href, before the artifact is
 * uploaded. The exact shape that shipped broken — a floor page linking
 * `/floor/trackers/TASKS.md` — fails here because no such built file exists.
 *
 * Jekyll's `permalink: pretty` means an internal URL usually names a DIRECTORY
 * (`/floor/roadmap/`); the page is `floor/roadmap/index.html`. A root-relative
 * URL includes the deployment base path (`/<repository>/...`) while the
 * built files do not, so the crawler strips `--baseurl` before resolving.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { decodeHtmlEntities } from "../../shared/markup.ts";
import { bootstrapProcess, isEntryPoint } from "../../engine/src/runtime/cli-debug.ts";
import { siteDocumentLinks } from "./site-html.mjs";
import { siteLinkPath } from "../../engine/src/workflow/site-sources.ts";
import { existingSiteFiles, htmlPages } from "./files.mjs";
export { candidateSiteFiles, existingSiteFiles, htmlPages } from "./files.mjs";

const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu;

/**
 * The URL a built page answers at. `index.html` is the directory page, so the
 * base for relative links is the directory URL, not the file's location.
 */
export function pageUrlForSitePath(sitePath) {
  const path = sitePath.replace(/^\/+/u, "");
  if (path === "index.html") return "/";
  if (path.endsWith("/index.html")) return `/${path.slice(0, -"index.html".length)}`;
  return `/${path}`;
}

/**
 * Resolve one href against the page URL. Answers a classification plus, for
 * an internal URL, the site-root-relative path (base path removed).
 */
export function resolveSiteHref(href, pageUrl, { baseurl = "", siteOrigin = null } = {}) {
  return resolveDecodedSiteHref(decodeHtmlEntities(href), pageUrl, { baseurl, siteOrigin });
}

function resolveDecodedSiteHref(href, pageUrl, { baseurl = "", siteOrigin = null } = {}) {
  let raw = href.trim();
  if (raw.length === 0) return { kind: "empty" };
  if (raw.startsWith("#")) return { kind: "anchor" };
  if (EXTERNAL.test(raw)) {
    if (siteOrigin === null || !/^(?:https?:|\/\/)/iu.test(raw)) return { kind: "external" };
    const url = new URL(raw, siteOrigin);
    if (url.origin !== new URL(siteOrigin).origin) return { kind: "external" };
    raw = `${url.pathname}${url.search}${url.hash}`;
  }

  const hashIndex = raw.indexOf("#");
  const withoutHash = hashIndex === -1 ? raw : raw.slice(0, hashIndex);
  const queryIndex = withoutHash.indexOf("?");
  const pathPart = queryIndex === -1 ? withoutHash : withoutHash.slice(0, queryIndex);
  if (pathPart.length === 0) return { kind: "anchor" };

  const decoded = siteLinkPath(pathPart).path;

  let sitePath;
  if (decoded.startsWith("/")) {
    const base = baseurl.replace(/\/+$/u, "");
    if (base.length > 0) {
      if (decoded === base) sitePath = "/";
      else if (decoded.startsWith(`${base}/`)) sitePath = decoded.slice(base.length);
      else return { kind: "unresolved", reason: "outside the deployment base path" };
    } else {
      sitePath = decoded;
    }
  } else {
    const baseDirectory = pageUrl.endsWith("/") ? pageUrl : posix.dirname(pageUrl);
    sitePath = posix.normalize(posix.join("/", baseDirectory, decoded));
  }
  return { kind: "internal", path: sitePath };
}

/**
 * Crawl the built site. Answers every internal link inspected and the ones
 * that resolve to nothing; an empty `unresolved` is the pass.
 */
export function crawlSiteLinks({ siteRoot, baseurl = "", siteOrigin = null }) {
  const pages = htmlPages(siteRoot);
  const unresolved = [];
  let links = 0;
  for (const page of pages) {
    const pageUrl = pageUrlForSitePath(page);
    const html = readFileSync(join(resolve(siteRoot), ...page.split("/")), "utf8");
    // Parse actual HTML, including unquoted/recovered attributes and template
    // contents; source examples and script text do not become invented links.
    for (const href of siteDocumentLinks(html)) {
        const resolved = resolveDecodedSiteHref(href, pageUrl, { baseurl, siteOrigin });
        if (resolved.kind !== "internal") {
          if (resolved.kind === "unresolved") {
            unresolved.push({ page, href, resolved: resolved.reason });
          }
          continue;
        }
        links += 1;
        if (existingSiteFiles(siteRoot, resolved.path).length === 0) {
          unresolved.push({ page, href, resolved: resolved.path });
        }
    }
  }
  return { pages: pages.length, links, unresolved };
}

function parseArgs(argv) {
  const options = { site: "_site", baseurl: "", siteOrigin: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--site") options.site = argv[++index];
    else if (arg === "--baseurl") options.baseurl = argv[++index] ?? "";
    else if (arg === "--site-origin") options.siteOrigin = argv[++index];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!existsSync(options.site)) throw new Error(`site root does not exist: ${options.site}`);
  return options;
}

if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = crawlSiteLinks({ siteRoot: options.site, baseurl: options.baseurl, siteOrigin: options.siteOrigin });
    if (result.unresolved.length === 0) {
      process.stdout.write(
        `site links: clean (${result.pages} page(s), ${result.links} internal link(s))\n`,
      );
    } else {
      process.stderr.write(
        `site links: ${result.unresolved.length} unresolved internal link(s) in ${result.pages} page(s)\n`,
      );
      for (const entry of result.unresolved) {
        process.stderr.write(`  ${entry.page}: ${entry.href} → ${entry.resolved}\n`);
      }
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`site links failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
