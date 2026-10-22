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
 * URL includes the deployment base path (`/bridlewise-testing/...`) while the
 * built files do not, so the crawler strips `--baseurl` before resolving.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, resolve, sep } from "node:path";
import { decodeHtmlEntities, htmlWithout } from "../../shared/markup.ts";
import { isEntryPoint } from "../../engine/src/runtime/entry-point.ts";

const HTML_TAG = /<[a-zA-Z][^>]*>/gu;
const LINK_ATTRIBUTE = /\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/giu;
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu;

function toPosix(path) {
  return path.split(sep).join("/");
}

/** Every `.html` page under `siteRoot`, as site-relative POSIX paths. */
export function htmlPages(siteRoot) {
  const root = resolve(siteRoot);
  const out = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else if (entry.isFile() && entry.name.endsWith(".html")) {
        out.push(toPosix(full.slice(root.length)).replace(/^\/+/u, ""));
      }
    }
  };
  visit(root);
  return out.sort();
}

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
export function resolveSiteHref(href, pageUrl, { baseurl = "" } = {}) {
  const raw = decodeHtmlEntities(href.trim());
  if (raw.length === 0) return { kind: "empty" };
  if (raw.startsWith("#")) return { kind: "anchor" };
  if (EXTERNAL.test(raw)) return { kind: "external" };

  const hashIndex = raw.indexOf("#");
  const withoutHash = hashIndex === -1 ? raw : raw.slice(0, hashIndex);
  const queryIndex = withoutHash.indexOf("?");
  const pathPart = queryIndex === -1 ? withoutHash : withoutHash.slice(0, queryIndex);
  if (pathPart.length === 0) return { kind: "anchor" };

  let decoded;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    decoded = pathPart;
  }

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

/** Candidate built files for a site-root-relative URL. Never escapes `siteRoot`. */
export function candidateSiteFiles(siteRoot, sitePath) {
  const root = resolve(siteRoot);
  const relativePath = sitePath.replace(/^\/+/u, "");
  const segments = relativePath.split("/").filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === "..")) return [];
  const exact = resolve(root, ...segments);
  if (exact !== root && !exact.startsWith(`${root}${sep}`)) return [];
  if (relativePath.length === 0 || sitePath.endsWith("/")) return [join(exact, "index.html")];
  return [exact, join(exact, "index.html"), `${exact}.html`];
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Crawl the built site. Answers every internal link inspected and the ones
 * that resolve to nothing; an empty `unresolved` is the pass.
 */
export function crawlSiteLinks({ siteRoot, baseurl = "" }) {
  const pages = htmlPages(siteRoot);
  const unresolved = [];
  let links = 0;
  for (const page of pages) {
    const pageUrl = pageUrlForSitePath(page);
    const html = htmlWithout(readFileSync(join(resolve(siteRoot), ...page.split("/")), "utf8"), { comments: true });
    // Attributes are read from real tags only: prose or inline code can SHOW
    // the text `href="/src/x"` without linking it (a design essay quotes one),
    // and scanning the raw text would invent a broken link that is not one.
    for (const tag of html.matchAll(HTML_TAG)) {
      for (const match of tag[0].matchAll(LINK_ATTRIBUTE)) {
        const href = match[1] ?? match[2] ?? "";
        const resolved = resolveSiteHref(href, pageUrl, { baseurl });
        if (resolved.kind !== "internal") {
          if (resolved.kind === "unresolved") {
            unresolved.push({ page, href, resolved: resolved.reason });
          }
          continue;
        }
        links += 1;
        const candidates = candidateSiteFiles(siteRoot, resolved.path);
        if (candidates.length === 0 || !candidates.some((candidate) => isFile(candidate))) {
          unresolved.push({ page, href, resolved: resolved.path });
        }
      }
    }
  }
  return { pages: pages.length, links, unresolved };
}

function parseArgs(argv) {
  const options = { site: "_site", baseurl: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--site") options.site = argv[++index];
    else if (arg === "--baseurl") options.baseurl = argv[++index] ?? "";
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!existsSync(options.site)) throw new Error(`site root does not exist: ${options.site}`);
  return options;
}

if (isEntryPoint(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = crawlSiteLinks({ siteRoot: options.site, baseurl: options.baseurl });
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
