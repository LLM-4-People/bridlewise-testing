// @vitest-environment node
/**
 * THE ONE SITE'S LINK GUARD — unit proof for the crawler, the publish plan,
 * the rewrite and the builder's steps (source, finish with released
 * snapshots, the old-URL redirect).
 *
 * The Pages workflow runs the crawler against the REAL built `_site` (after
 * Jekyll). These tests drive the same resolver over small Jekyll-shaped
 * fixtures, including the exact shape the published site shipped:
 *
 *   a floor page at `/floor/roadmap/` linked `../trackers/TASKS.md`
 *   → `/floor/trackers/TASKS.md`, and Jekyll builds nothing there.
 *
 * They also prove the build-time rewrite maps the SOURCE-relative link to
 * the pretty URL the plan publishes (or the GitHub URL of what the site does
 * not serve), that the source plan refuses collisions, that rendered links
 * naming nothing fail the actual HTML gate, and that a released snapshot
 * merges only as a whole, verified site. Without these, the crawler
 * could be blind or the plan could drift and the first red would be a deploy.
 */
import { describe, expect, test } from "vitest";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import { escapeHtml } from "../../shared/markup.ts";

import { createTempDir } from "../helpers/temp-dir.ts";

// The site tooling is plain Node ESM (it runs from `node scripts/...` and has
// no build step). The test program checks the values it receives, not a
// duplicate declaration of the module's shape.
// @ts-expect-error -- a .mjs module has no declaration file in the TS program.
import { candidateSiteFiles, crawlSiteLinks, pageUrlForSitePath, resolveSiteHref } from "../../scripts/floor/site-links.mjs";
// @ts-expect-error -- a .mjs module has no declaration file in the TS program.
import { captureSiteUrls, landingMap, landingPath, legacyAliases, prettyPermalink, publishedDocsPage, readSiteDocumentFiles, rewritePageLinks, SITE_PLAN_FILE, sitePlanProjection, sitePolicyResolver, siteSourceViolations, sitePlan } from "../../scripts/floor/site-pages.mjs";
// @ts-expect-error -- the built HTML policy judge is plain Node ESM.
import { builtPolicyViolations } from "../../scripts/floor/site-style.mjs";
// @ts-expect-error -- the existing site DOM parser is plain Node ESM.
import { parseSiteHtml, siteDocumentLinks } from "../../scripts/floor/site-html.mjs";
import { sitePolicies } from "../../shared/site-page.ts";
// @ts-expect-error -- a .mjs module has no declaration file in the TS program.
import { assembleLiveArtifacts, buildRedirectSite, buildSiteSource, finishSite as finishSiteOwner, readVersions, redirectTarget, resolveSitePageLinks } from "../../scripts/floor/site.mjs";
import { PAGE_CONTENT, SITE_LINK_PREFIX, SITE_LINKS, SITE_SOURCE_ATTRIBUTE, siteSourceReference } from "../../engine/src/workflow/site-sources.ts";
// @ts-expect-error -- a .mjs module has no declaration file in the TS program.
import { checkSiteLinks } from "../../scripts/check-docs-links.mjs";
// @ts-expect-error -- a .mjs module has no declaration file in the TS program.
import { legacySiteUrl, siteCoordinates } from "../../scripts/floor/repository.mjs";
import { configuredForge } from "../../engine/src/workflow/forge/configured-forge.ts";
import { repositoryIdentity } from "../../engine/src/workflow/forge/repository-identity.ts";

function write(root: string, path: string, text: string): void {
  const file = join(root, ...path.split("/"));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function site(files: Readonly<Record<string, string>>): string {
  const root = createTempDir("floor-site-links-");
  for (const [path, text] of Object.entries(files)) write(root, path, text);
  return root;
}

function tree(files: Readonly<Record<string, string>>): string {
  const root = createTempDir("site-plan-");
  for (const [path, text] of Object.entries(files)) write(root, path, text);
  return root;
}

const BASE = "/bridlewise";
/**
 * A fixture's coordinates: the repository identity of a forge section that
 * names another organisation and trunk (a name unlike the real one proves
 * every coordinate the site uses is derived from the identity it is given).
 */
const FIXTURE = siteCoordinates(repositoryIdentity({ ...configuredForge(), organization: "Example-Org", repositories: [{ name: "site-repo", kind: "trunk", visibility: "public", product: true }] }));
const REAL_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * The builder over a fixture tree. A fixture holds no traceability inputs,
 * so its floor data is a stand-in; the real tree's builds (the release
 * snapshot test here, the floor-data test) write the real atlas and status.
 */
const source = (options: Record<string, unknown>) => buildSiteSource({ floorData: async () => ({ atlas: { fixture: true }, status: { fixture: true } }), coordinates: FIXTURE, ...options });

describe("A. the crawler resolves built pages, assets and external URLs", () => {
  test("a clean Jekyll-shaped fixture passes — pretty URLs, assets, relatives and externals", () => {
    const root = site({
      "index.html": [
        '<a href="/bridlewise/floor/roadmap/">Roadmap</a>',
        '<a href="/bridlewise/assets/floor/floor.css">CSS</a>',
        '<a href="https://github.com/LLM-4-People/bridlewise">GitHub</a>',
        '<a href="#top">Top</a>',
        '<a href="mailto:hello@example.test">Mail</a>',
        '<p>An essay that quotes <code>href="/src/styles/tokens.css"</code> is not a link.</p>',
        "",
      ].join("\n"),
      "floor/roadmap/index.html": [
        '<link rel="stylesheet" href="/bridlewise/assets/floor/floor.css">',
        '<a href="/bridlewise/trackers/TASKS/">TASKS</a>',
        '<a href="../evidence/">Evidence</a>',
        '<script src="/bridlewise/assets/floor/floor.js"></script>',
        "",
      ].join("\n"),
      "floor/evidence/index.html": '<a href="../roadmap/">back</a>\n',
      "trackers/TASKS/index.html": '<a href="../../floor/roadmap/">Roadmap</a>\n',
      "assets/floor/floor.css": "body {}\n",
      "assets/floor/floor.js": "export {};\n",
    });
    const result = crawlSiteLinks({ siteRoot: root, baseurl: BASE });
    expect(result.unresolved, JSON.stringify(result.unresolved)).toEqual([]);
    expect(result.pages).toBe(4);
    expect(result.links).toBeGreaterThan(4);
  });

  test("the shipped pre-fix shape is unresolved: /floor/trackers/TASKS.md", () => {
    // A page at /floor/roadmap/ linking ../trackers/TASKS.md resolves to
    // /floor/trackers/TASKS.md. Jekyll published no such file, which is the
    // 404 the crawler exists to catch.
    const relative = site({
      "floor/roadmap/index.html": '<a href="../trackers/TASKS.md">TASKS</a>\n',
    });
    const relativeResult = crawlSiteLinks({ siteRoot: relative, baseurl: BASE });
    expect(relativeResult.unresolved).toEqual([
      { page: "floor/roadmap/index.html", href: "../trackers/TASKS.md", resolved: "/floor/trackers/TASKS.md" },
    ]);

    const rootRelative = site({
      "floor/roadmap/index.html": '<a href="/bridlewise/floor/trackers/TASKS.md">TASKS</a>\n',
    });
    const rootResult = crawlSiteLinks({ siteRoot: rootRelative, baseurl: BASE });
    expect(rootResult.unresolved.map((entry: { resolved: string }) => entry.resolved)).toEqual(["/floor/trackers/TASKS.md"]);
  });

  test("the crawler reads recovered HTML and template contents, decoding attributes once", () => {
    const root = site({
      "index.html": `<img/src=/bridlewise/missing.png><A HREF=/bridlewise/upper/>Upper</A><template><a href=/bridlewise/template/>Template</a></template><noscript><a href=/bridlewise/noscript/>No script</a></noscript><pre><a href=/bridlewise/pre/>Real child</a></pre><img src="/bridlewise/assets/${escapeHtml(escapeHtml("a&b.png"))}"><script>const example = '<a href="/invented/">';</script><code>${escapeHtml('<a href="/escaped/">')}</code>`,
      [`assets/${escapeHtml("a&b.png")}`]: "fixture",
    });
    const result = crawlSiteLinks({ siteRoot: root, baseurl: BASE });
    expect(result.links).toBe(6);
    expect(result.unresolved.map((entry: { resolved: string }) => entry.resolved)).toEqual(["/missing.png", "/upper/", "/template/", "/noscript/", "/pre/"]);
  });

  test("a missing asset and a URL outside the base path both fail", () => {
    const root = site({
      "index.html": [
        '<img src="/bridlewise/assets/floor/missing.png" alt="">',
        '<a href="/some-other-site/page/">outside</a>',
        "",
      ].join("\n"),
    });
    const result = crawlSiteLinks({ siteRoot: root, baseurl: BASE });
    expect(result.unresolved).toHaveLength(2);
    expect(result.unresolved.map((entry: { resolved: string }) => entry.resolved)).toEqual([
      "/assets/floor/missing.png",
      "outside the deployment base path",
    ]);
  });

  test("absolute and protocol-relative links to this site remain subject to the crawl", () => {
    const root = site({
      "index.html": '<img src="https://pages.example.test/bridlewise/missing.png"><a href="//pages.example.test/bridlewise/absent/">missing page</a><a href="https://elsewhere.example.test/bridlewise/absent/">external</a><img src="https://pages.example.test/bridlewise/assets/kept.png">',
      "assets/kept.png": "fixture",
    });
    expect(crawlSiteLinks({ siteRoot: root, baseurl: BASE, siteOrigin: "https://pages.example.test" }).unresolved.map((entry: { resolved: string }) => entry.resolved)).toEqual(["/missing.png", "/absent/"]);
  });

  test("the resolver is by page URL, not by the HTML file's path (pretty URLs are directories)", () => {
    expect(pageUrlForSitePath("floor/roadmap/index.html")).toBe("/floor/roadmap/");
    expect(pageUrlForSitePath("index.html")).toBe("/");
    expect(resolveSiteHref("../trackers/TASKS/", "/floor/roadmap/", { baseurl: BASE })).toEqual({
      kind: "internal",
      path: "/floor/trackers/TASKS/",
    });
    expect(candidateSiteFiles("/site", "/floor/roadmap/")).toEqual([
      "/site/floor/roadmap/index.html",
    ]);
  });
});

/** A minimal one-repository tree: the site source is `docs/`, everything else is repository content. */
function repository(extra: Readonly<Record<string, string>> = {}): string {
  return tree({
    "README.md": "# Repository\n",
    "package.json": JSON.stringify({ name: "fixture" }),
    "engine/x.ts": "export {};\n",
    "shared/markup.ts": readFileSync(join(REAL_ROOT, "shared/markup.ts"), "utf8"),
    // The design system the builder generates the site's design assets from
    // (scripts/floor/site-design.mjs): the real token owner, the files its
    // @font-face blocks name, and the shell's two stylesheets.
    "src/cockpit/tokens.css": readFileSync(join(REAL_ROOT, "src/cockpit/tokens.css"), "utf8"),
    ...Object.fromEntries([...readFileSync(join(REAL_ROOT, "src/cockpit/tokens.css"), "utf8").matchAll(/url\("\/(fonts\/[^"]+)"\)/gu)].map((match) => [`public/${match[1]}`, "woff2"])),
    "public/fonts/OFL.txt": "licence\n",
    "docs/assets/css/style.css": "body { color: var(--ink-1); background: var(--ground-0); }\n",
    "docs/assets/floor/floor.css": "",
    "docs/_config.yml": "title: Fixture\nplugins:\n  - jekyll-sitemap\n",
    "docs/_layouts/default.html": "<html><body>{{ content }}</body></html>\n",
    "docs/_data/site-url-history.json": JSON.stringify({
      schemaVersion: "bridlewise-site-url-history/v1",
      pages: { "docs/index.md": "/", "docs/floor/roadmap.md": "/floor/roadmap/", "docs/trackers/TASKS.md": "/trackers/TASKS/", "docs/decisions/README.md": "/decisions/" },
      aliases: { "/product/": "/", "/roadmap/": "/floor/roadmap/" },
    }),
    "docs/index.md": "---\ntitle: Home\npermalink: /\n---\n\n# Home\n\n[Roadmap](floor/roadmap.md) · [Engine](../engine/x.ts)\n",
    "docs/floor/roadmap.md": "---\ntitle: Roadmap\npermalink: /floor/roadmap/\n---\n\n[TASKS](../trackers/TASKS.md#open) · [records](../decisions/) · [logo](../assets/logo.png) · [hidden](../hidden.md)\n",
    "docs/trackers/TASKS.md": "# Tasks\n\nA workflow example: `${{ github.sha }}` and {% raw-looking %} prose.\n\n```md\n[not a link](does-not-exist.md)\n```\n",
    "docs/decisions/README.md": "# Decisions\n\n[Back home](../index.md)\n",
    "docs/hidden.md": "---\npublished: false\n---\n\n# Hidden\n",
    "docs/assets/logo.png": "png",
    "docs/robots.txt": "---\n---\nSitemap: {{ site.url }}{{ site.baseurl }}/sitemap.xml\n",
    ...extra,
  });
}

describe("B. the publish plan: every docs page, one URL each", () => {
  test("pretty URLs: an index or README is its folder's page; front matter wins", () => {
    expect(prettyPermalink("docs/index.md")).toBe("/");
    expect(prettyPermalink("docs/decisions/README.md")).toBe("/decisions/");
    expect(prettyPermalink("docs/floor/index.md")).toBe("/floor/");
    expect(prettyPermalink("docs/trackers/TASKS.md")).toBe("/trackers/TASKS/");
    const plan = sitePlan({ coordinates: FIXTURE, root: repository() });
    expect(plan.collisions).toEqual([]);
    expect([...plan.byPermalink.keys()].sort()).toEqual(["/", "/decisions/", "/floor/roadmap/", "/trackers/TASKS/"]);
    expect(plan.pages.get("docs/hidden.md").permalink).toBeNull();
  });

  test("two pages for one URL are refused — by the plan, the builder and docs:links", async () => {
    // Two collision shapes in two places: a README beside an index, and a
    // front-matter permalink that takes another page's URL.
    const root = repository({
      "docs/README.md": "# Map\n",
      "docs/floor/other.md": "---\npermalink: /floor/roadmap/\n---\n\n# Other\n",
    });
    const plan = sitePlan({ coordinates: FIXTURE, root });
    expect(plan.collisions).toEqual([
      "docs/floor/other.md and docs/floor/roadmap.md both publish /floor/roadmap/",
      "docs/index.md and docs/README.md both publish /",
    ]);
    await expect(source({ root, out: join(root, ".site"), baseurl: "/bridlewise" })).rejects.toThrow(/the site source refuses \(2\)/u);
    expect(checkSiteLinks({ root })).toHaveLength(2);
    // Near miss: the same names in different folders are different URLs.
    expect(sitePlan({ coordinates: FIXTURE, root: repository({ "docs/floor/README.md": "# Floor\n", "docs/trackers/README.md": "# Trackers\n" }) }).collisions).toEqual([]);
  });

  test("a moved URL cannot also be a page", () => {
    const root = repository({ "docs/product.md": "# Product\n" });
    expect(sitePlan({ coordinates: FIXTURE, root }).collisions).toEqual([expect.stringContaining("docs/product.md publishes /product/")]);
  });
});

describe("C. the rewrite: site URL, GitHub URL, or a refusal", () => {
  test("pages, folders and assets become site URLs; repository files and unpublished pages become GitHub URLs", () => {
    const root = repository();
    const plan = sitePlan({ coordinates: FIXTURE, root });
    const roadmap = rewritePageLinks(readFileSync(join(root, "docs/floor/roadmap.md"), "utf8"), { pageDocsPath: "docs/floor/roadmap.md", root, baseurl: "/bridlewise", plan });
    expect(roadmap.errors).toEqual([]);
    expect(roadmap.text).toContain("[TASKS](/bridlewise/trackers/TASKS/#open)");
    expect(roadmap.text).toContain("[records](/bridlewise/decisions/)");
    expect(roadmap.text).toContain("[logo](/bridlewise/assets/logo.png)");
    expect(roadmap.text).toContain("[hidden](https://github.com/Example-Org/site-repo/blob/main/docs/hidden.md)");
    const qualified = rewritePageLinks("[TASKS](../trackers/TASKS.md?q=1#open)", { pageDocsPath: "docs/floor/roadmap.md", root, baseurl: "/bridlewise", plan });
    expect(qualified.text).toBe("[TASKS](/bridlewise/trackers/TASKS/?q=1#open)");
    const home = rewritePageLinks(readFileSync(join(root, "docs/index.md"), "utf8"), { pageDocsPath: "docs/index.md", root, baseurl: "/bridlewise", plan });
    expect(home.text).toContain("[Engine](https://github.com/Example-Org/site-repo/blob/main/engine/x.ts)");
    expect(publishedDocsPage({ docsPath: "docs/hidden.md", root, plan })).toBeNull();
  });

  test("rendered links naming nothing are refused; escaped code remains text", async () => {
    const root = repository({
      "docs/floor/broken.md": "# Broken\n\n[gone](../missing.md)\n",
      "docs/decisions/D-1.md": "---\nid: D-1\n---\n\n[out](../../../outside.md) and [script](../../scripts/none.mjs)\n",
    });
    // Source preparation preserves the configured renderer's input. Only actual rendered attributes are judged.
    expect(siteSourceViolations({ coordinates: FIXTURE, root })).toEqual([]);
    await expect(source({ root, out: join(root, ".site"), baseurl: BASE })).resolves.toBeDefined();
    const rendered = renderedFixture(root, FIXTURE, {
      "docs/floor/broken.md": '<a href="../missing.md">gone</a>',
      "docs/decisions/D-1.md": '<a href="../../../outside.md">out</a> and <a href="../../scripts/none.mjs">script</a>',
      "docs/trackers/TASKS.md": `<pre><code>[not a link](does-not-exist.md) ${escapeHtml('<a href="also-missing.md">')}</code></pre>`,
    });
    const refusal = (() => { try { resolveSitePageLinks({ root, site: rendered.site, baseurl: BASE, coordinates: FIXTURE }); return null; } catch (error) { return error; } })();
    expect(refusal).toBeInstanceOf(Error);
    const message = (refusal as Error).message;
    expect(message).toContain("link '../../../outside.md' leaves the repository");
    expect(message).toContain("link '../../scripts/none.mjs' names scripts/none.mjs");
    expect(message).toContain("link '../missing.md' names docs/missing.md");
    expect(message).not.toContain("also-missing.md");
    const validRoot = repository();
    const valid = renderedFixture(validRoot, FIXTURE, { "docs/trackers/TASKS.md": `<pre><code>[not a link](does-not-exist.md) ${escapeHtml('<a href="also-missing.md">')}</code></pre>` });
    expect(resolveSitePageLinks({ root: validRoot, site: valid.site, baseurl: BASE, coordinates: FIXTURE }).rewritten).toBe(0);
  });

});

describe("D. the source step", () => {
  test("plain pages get a header and a raw body; front-matter pages keep theirs; config and robots follow the base", async () => {
    const root = repository();
    const out = join(root, ".site");
    const result = await source({ root, out, baseurl: "/bridlewise-next" });
    expect(result.pages).toBe(4);
    const tasks = readFileSync(join(out, "trackers/TASKS.md"), "utf8");
    expect(tasks).toMatch(/^---\nlayout: "default"\n/u);
    expect(tasks).toContain('permalink: "/trackers/TASKS/"');
    expect(tasks).toContain("{% raw %}\n# Tasks");
    expect(tasks.trimEnd().endsWith("{% endraw %}")).toBe(true);
    expect(parse(readFileSync(join(out, "floor/roadmap.md"), "utf8").split("---")[1]!)).toMatchObject({ title: "Roadmap", permalink: "/floor/roadmap/", site_href: "/bridlewise-next/floor/roadmap/" });
    // The design system's generated half: the sheet holds exactly what the
    // shell reads (and what that reads), Logbook leads, the faces are served.
    const sheet = readFileSync(join(out, "assets/css/tokens.css"), "utf8");
    expect(sheet).toMatch(/^\/\* GENERATED from src\/cockpit\/tokens\.css/u);
    expect(sheet).toMatch(/:root \{\n {2}color-scheme: light;\n/u);
    expect(sheet).toContain("\n  --ground-0: #f6f4ef;\n");
    // The mark's inks ride in the sheet, each part from its own token.
    expect(sheet).toContain(".brand-mark > :nth-child(1) { fill: var(--ground-0); }");
    expect(sheet).not.toContain("--cat-turn");
    expect(readFileSync(join(out, "_includes/design-head.html"), "utf8")).toContain('<meta name="theme-color" content="#f6f4ef">');
    expect(readFileSync(join(out, "_includes/brand-mark.svg"), "utf8")).toMatch(/^<svg class="brand-mark"/u);
    expect(readFileSync(join(out, "assets/fonts/OFL.txt"), "utf8")).toBe("licence\n");
    const config = readFileSync(join(out, "_config.yml"), "utf8");
    // Every coordinate comes from package.json and the deployment's base path.
    expect(parse(config)).toMatchObject({
      title: "Fixture",
      url: "https://example-org.github.io",
      baseurl: "/bridlewise-next",
      repository: "Example-Org/site-repo",
      repository_url: "https://github.com/Example-Org/site-repo",
      security_url: "https://github.com/Example-Org/site-repo/blob/main/SECURITY.md",
      versions_url: SITE_LINKS.versions,
      release_version: "",
      relative_links: { enabled: false },
      plugins: ["jekyll-sitemap"],
    });
    expect(existsSync(join(out, "assets/js/markup.js"))).toBe(false); // No retired browser-only consumer is projected.
    expect(readFileSync(join(out, "v/index.md"), "utf8")).toContain("No release has been published yet.");
    expect(JSON.parse(readFileSync(join(out, "v/versions.json"), "utf8"))).toEqual({ current: "main", versions: [] });
  });

  test("a stylesheet that is not the design system's refuses the build (scripts/floor/site-style.mjs)", async () => {
    const root = repository({
      "docs/assets/css/style.css": "body { color: red; font-family: Georgia; }\n",
      "docs/assets/css/extra.scss": "---\n---\n.a { color: #fff; }\n",
    });
    const refusal = await source({ root, out: join(root, ".site"), baseurl: "/b" }).then(() => null, (error: unknown) => error);
    expect(refusal).toBeInstanceOf(Error);
    const lines = (refusal as Error).message.split("\n").map((line) => line.trim());
    expect(lines[0]).toContain("3 style finding(s): ");
    expect(lines).toContain("assets/css/extra.scss: a Sass source: the site's stylesheets are plain CSS, judged by one parser");
    expect(lines.filter((line) => line.startsWith("assets/css/style.css:1:")).map((line) => line.replace(/^assets\/css\/style\.css:1:\d+ /u, ""))).toEqual([
      "color: colour literal: red",
      "font-family: not one --face-* token: Georgia",
    ]);
  });

  test("a layout with a style of its own or a remote sheet refuses the build", async () => {
    const root = repository({ "docs/_layouts/default.html": '<html><head><link rel="stylesheet" href="https://cdn.example/x.css"><style>p { color: var(--ink-1); }</style></head><body style="margin: 0">{{ content }}</body></html>\n' });
    const refusal = await source({ root, out: join(root, ".site"), baseurl: "/b" }).then(() => null, (error: unknown) => error);
    expect(refusal).toBeInstanceOf(Error);
    const lines = (refusal as Error).message.split("\n").map((line) => line.trim());
    expect(lines[0]).toContain("3 style finding(s): ");
    expect(lines.filter((line) => line.startsWith("_layouts/default.html:1 ")).map((line) => line.replace(/^_layouts\/default\.html:1 /u, ""))).toEqual([
      '<link rel="stylesheet"> fetches from elsewhere: https://cdn.example/x.css',
      "<style>: the styles live in the token-reading stylesheets",
      "<body style=…>: the styles live in the token-reading stylesheets",
    ]);
  });

  test("a plain page holding {% endraw %} is refused (it would end the raw block early)", async () => {
    const root = repository({ "docs/process/x.md": "# X\n\n{% endraw %}\n" });
    await expect(source({ root, out: join(root, ".site"), baseurl: "/b" })).rejects.toThrow(/cannot contain \{% endraw %\}/u);
  });

  test("old URL shapes are real redirect pages; a page's own source spelling is never shadowed", async () => {
    const root = repository();
    const plan = sitePlan({ coordinates: FIXTURE, root });
    const aliases = new Map(legacyAliases(plan));
    expect(aliases.get("/product/")).toBe("/");
    expect(aliases.get("/roadmap/")).toBe("/floor/roadmap/");
    expect(aliases.get("/floor/trackers/TASKS.md")).toBe("/trackers/TASKS/");
    expect(aliases.get("/floor/trackers/TASKS/")).toBe("/trackers/TASKS/");
    const out = join(root, ".site");
    await source({ root, out, baseurl: "/bridlewise" });
    const moved = readFileSync(join(out, "floor/trackers/TASKS.md/index.html"), "utf8");
    expect(moved).toContain('<script src="/bridlewise/assets/js/moved.js"></script>');
    const script = readFileSync(join(out, "assets/js/moved.js"), "utf8");
    let replaced = "";
    new Function("document", "location", script)({ querySelector: () => ({ href: "/bridlewise/trackers/TASKS/" }) }, { search: "?q=1", hash: "#open", replace: (target: string) => { replaced = target; } });
    expect(replaced).toBe("/bridlewise/trackers/TASKS/?q=1#open");
    expect(parse(moved.split("---")[1]!)).toMatchObject({ permalink: "/floor/trackers/TASKS.md/", site_href: "/bridlewise/floor/trackers/TASKS.md/", canonical_url: "/trackers/TASKS/" });
    expect(existsSync(join(out, "floor/trackers/TASKS.md/moved.js"))).toBe(false);
    expect(moved).toContain('<a href="/bridlewise/trackers/TASKS/">');
    // `/trackers/TASKS.md` is the page's own source file in the Jekyll
    // source: the redirect folder cannot and does not take its name.
    expect(existsSync(join(out, "trackers/TASKS.md/index.html"))).toBe(false);
  });

  test("a release snapshot is built for its own place and lists no versions", async () => {
    const root = repository();
    const out = join(root, ".release");
    const result = await source({ root, out, baseurl: "/bridlewise/v/0.2.0", release: "0.2.0" });
    expect(result.release).toBe("0.2.0");
    const config = readFileSync(join(out, "_config.yml"), "utf8");
    expect(parse(config)).toMatchObject({ versions_url: SITE_LINKS.versions, release_version: "0.2.0", relative_links: { enabled: false } });
    expect(existsSync(join(out, "v"))).toBe(false);
    expect(existsSync(join(out, "versions.json"))).toBe(false);
    await expect(source({ root, out, baseurl: "/bridlewise", release: "0.2.0" })).rejects.toThrow(/served at <base>\/v\/0\.2\.0/u);
    await expect(source({ root, out, baseurl: "/bridlewise/v/v0.2.0", release: "v0.2.0" })).rejects.toThrow(/not a version/u);
  });

  test("the source may not publish into the snapshots' folder", async () => {
    const root = repository({ "docs/v/notes.md": "# Notes\n" });
    await expect(source({ root, out: join(root, ".site"), baseurl: "/b" })).rejects.toThrow(/docs\/v\/ exists/u);
  });
});

/** A built page as the layout leaves it: the charset, the site's two policies for `base`, then what loads. */
function policied(body: string, base = "/bridlewise", assetsBase = "/bridlewise"): string {
  const [origin, scoped] = sitePolicies(base);
  return `<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${origin}"><meta http-equiv="Content-Security-Policy" content="${scoped}"><link rel="stylesheet" href="${escapeHtml(assetsBase)}/assets/css/style.css"></head><body><main id="main" class="wrap article"><!--${PAGE_CONTENT.start}-->${body}<!--${PAGE_CONTENT.end}--></main></body></html>\n`;
}

/** Actual post-Jekyll-shaped pages: the production plan owns paths, markers and metadata. No Markdown grammar is emulated here. */
function renderedFixture(root: string, coordinates = FIXTURE, bodies: Readonly<Record<string, string>> = {}, baseurl = BASE, release: string | null = null): { site: string; plan: ReturnType<typeof sitePlan> } {
  const plan = sitePlan({ root, coordinates, snapshot: release !== null });
  expect(plan.collisions).toEqual([]);
  const built = createTempDir("rendered-source-links-");
  for (const page of plan.byPermalink.values()) {
    if (page.artifact) continue;
    const file = candidateSiteFiles(built, page.permalink)[0];
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, policied(bodies[page.docsPath] ?? "<p>Page</p>", baseurl, baseurl));
  }
  write(built, SITE_PLAN_FILE, JSON.stringify(sitePlanProjection({ plan, baseurl, release })));
  write(built, "assets/css/style.css", ".wrap{} .article{}\n");
  return { site: built, plan };
}

const builtSourceRoots = new Map<string, string>();
function finishSite(options: { site: string; baseurl: string; versionsDir?: string; root?: string }): ReturnType<typeof finishSiteOwner> {
  return finishSiteOwner({ root: builtSourceRoots.get(options.site) ?? REAL_ROOT, ...options });
}

/** A built site as Jekyll would leave it for `buildSiteSource` with `versions`. */
function builtSite(versions: readonly string[], pages: Readonly<Record<string, string>> = {}, livePages: Readonly<Record<string, string>> = {}): string {
  const page = (body: string): string => policied(body);
  const root = tree({
    "docs/index.md": "---\ntitle: Home\n---\n# Home\n\n[Versions]({{ site.versions_url }})\n", "docs/README.md": "# Docs\n",
    "docs/_data/page-routes.json": JSON.stringify({ schemaVersion: "bridlewise-site-page-routes/v1", docsHome: "README.md", livePages: { "index.md": "/", ...livePages } }),
    ...Object.fromEntries(Object.keys(livePages).map((key) => [`docs/${key}`, "# Live page\n"])),
    "docs/_data/site-url-history.json": JSON.stringify({ schemaVersion: "bridlewise-site-url-history/v1", pages: { "docs/index.md": "/", "docs/README.md": "/contents/" }, aliases: {} }),
  });
  const built = site({
    "index.html": page(`<p class="lede">Home</p><a href="${SITE_LINKS.versions}">Versions</a>`),
    "docs/index.html": page('<p class="lede">Documentation</p>'),
    "docs/v/index.html": page(versions.map((version) => `<a href="/bridlewise/docs/v/${version}/">${version}</a>`).join("")),
    "docs/v/versions.json": JSON.stringify({ current: "main", versions: versions.map((version) => ({ version, path: `/docs/v/${version}/` })) }),
    "assets/css/style.css": ".lede{} .wrap{} .article{}\n",
    "assets/floor/floor.css": "body{}\n",
    [SITE_PLAN_FILE]: JSON.stringify(sitePlanProjection({ plan: sitePlan({ root }), baseurl: "/bridlewise" })),
    ...pages,
  });
  builtSourceRoots.set(built, root);
  return built;
}

/** A released snapshot folder: `<dir>/<version>/` built for `/bridlewise/docs/v/<version>`. */
function snapshots(entries: Readonly<Record<string, Readonly<Record<string, string>>>>): string {
  const root = createTempDir("site-versions-");
  for (const [version, files] of Object.entries(entries)) for (const [path, text] of Object.entries(files)) write(root, `${version}/${path}`, text);
  return root;
}

describe("E. the finish step: released snapshots merge whole, then the whole site is judged", () => {
  test("valid HTML outside the plan cannot silently become a published page", () => {
    const siteRoot = builtSite([], { "unplanned/index.html": policied("<p>Unexpected published page</p>") });
    expect(() => finishSite({ site: siteRoot, baseurl: BASE })).toThrow(/plan: unplanned\/index\.html is not owned by the publish plan/u);
    expect(finishSite({ site: builtSite([]), baseurl: BASE }).versions).toEqual([]);
  });

  test("every HTML file the built site serves carries the two policies first; any other output is refused", () => {
    const [origin, scoped] = sitePolicies("/bridlewise");
    const meta = (content: string): string => `<meta http-equiv="Content-Security-Policy" content="${content}">`;
    const bare = "<html><head><title>bare</title></head><body><main id=\"main\" class=\"wrap article\"><p class=\"lede\">x</p></main></body></html>";
    const siteRoot = builtSite([], {
      "bare/index.html": bare,
      "loud/PAGE.HTML": bare,
      "old/page.htm": bare,
      "one/index.html": `<html><head><meta charset="utf-8">${meta(origin)}</head><body></body></html>`,
      "late/index.html": `<html><head><meta charset="utf-8"><title>t</title>${meta(origin)}${meta(scoped)}</head><body></body></html>`,
      "elsewhere/index.html": `<html><head><meta charset="utf-8">${meta(origin)}${meta(sitePolicies("/other")[1])}</head><body></body></html>`,
      "third/index.html": `<html><head><meta charset="utf-8">${meta(origin)}${meta(scoped)}</head><body><noscript>${meta("default-src *")}</noscript></body></html>`,
      // The policies right after a script: the script loads before any policy applies.
      "script-first/index.html": `<html><head><script src="/bridlewise/assets/js/early.js"></script>${meta(origin)}${meta(scoped)}</head><body></body></html>`,
      "no-charset/index.html": `<html><head>${meta(origin)}${meta(scoped)}<meta charset="utf-8"></head><body></body></html>`,
      "good/index.html": policied('<p class="lede">fine</p>'),
      "feed.xml": "<feed/>",
    });
    const refusal = (() => { try { finishSite({ site: siteRoot, baseurl: "/bridlewise" }); return ""; } catch (error) { return (error as Error).message; } })();
    const refused = refusal.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("policy: ")).map((line) => line.slice("policy: ".length).split(" ")[0]);
    expect(refused).toEqual(["bare/index.html", "elsewhere/index.html", "late/index.html", "loud/PAGE.HTML", "no-charset/index.html", "old/page.htm", "one/index.html", "script-first/index.html", "third/index.html"]);
  });

  test("versions sort newest first, a release before its pre-releases", () => {
    const dir = snapshots({ "0.2.0": { "index.html": "x" }, "0.10.0": { "index.html": "x" }, "0.10.0-rc.1": { "index.html": "x" }, "1.0.0": { "index.html": "x" } });
    expect(readVersions(dir)).toEqual(["1.0.0", "0.10.0", "0.10.0-rc.1", "0.2.0"]);
    expect(readVersions(null)).toEqual([]);
  });

  test("a snapshot merges at /docs/v/<version>/ and its links are crawled with the rest", () => {
    const dir = snapshots({ "0.1.0": { "index.html": policied('<a href="/bridlewise/docs/v/0.1.0/quickstart/">Quickstart</a><a href="/bridlewise/docs/v/">Other versions</a>', "/bridlewise/docs/v/0.1.0"), "quickstart/index.html": policied('<a href="../">Back</a>', "/bridlewise/docs/v/0.1.0") } });
    const siteRoot = builtSite(["0.1.0"]);
    const result = finishSite({ site: siteRoot, baseurl: "/bridlewise", versionsDir: dir });
    expect(result.versions).toEqual(["0.1.0"]);
    expect(existsSync(join(siteRoot, "docs/v/0.1.0/quickstart/index.html"))).toBe(true);
    // The snapshot is judged for links but not against today's stylesheets.
    expect(result.designPages).toBe(3);
  });

  test("a snapshot link that 404s on the merged site is refused", () => {
    const dir = snapshots({ "0.1.0": { "index.html": '<a href="/bridlewise/docs/v/0.1.0/missing/">Gone</a>' } });
    expect(() => finishSite({ site: builtSite(["0.1.0"]), baseurl: "/bridlewise", versionsDir: dir })).toThrow(/link: docs\/v\/0\.1\.0\/index\.html: \/bridlewise\/docs\/v\/0\.1\.0\/missing\//u);
  });

  test("a snapshot reaches a live root page and the merged crawl refuses its later removal", () => {
    const dir = snapshots({ "0.1.0": { "index.html": policied('<a href="/bridlewise/roadmap/">Current roadmap</a>', "/bridlewise/docs/v/0.1.0") } });
    const present = builtSite(["0.1.0"], { "roadmap/index.html": policied('<p class="lede">Current roadmap</p>') }, { "roadmap.md": "/roadmap/" });
    expect(finishSite({ site: present, baseurl: "/bridlewise", versionsDir: dir }).versions).toEqual(["0.1.0"]);
    const removed = builtSite(["0.1.0"]);
    expect(() => finishSite({ site: removed, baseurl: "/bridlewise", versionsDir: dir })).toThrow(/link: docs\/v\/0\.1\.0\/index\.html: \/bridlewise\/roadmap\/ → \/roadmap\//u);
  });

  test("a snapshot never overwrites a page, and the folder must hold only built versions", () => {
    const collide = snapshots({ "0.1.0": { "index.html": "x" } });
    expect(() => finishSite({ site: builtSite(["0.1.0"], { "docs/v/0.1.0/index.html": "page" }), baseurl: "/bridlewise", versionsDir: collide })).toThrow(/already holds \/docs\/v\/0\.1\.0\//u);
    expect(() => readVersions(snapshots({ "latest": { "index.html": "x" } }))).toThrow(/not a released version snapshot/u);
    expect(() => readVersions(snapshots({ "v0.1.0": { "index.html": "x" } }))).toThrow(/not a released version snapshot/u);
    expect(() => readVersions(snapshots({ "0.1.0": { "page.html": "x" } }))).toThrow(/no index\.html/u);
  });

  test("the source's versions list and the merged folder must be the same set", () => {
    const dir = snapshots({ "0.1.0": { "index.html": "x" } });
    expect(() => finishSite({ site: builtSite([]), baseurl: "/bridlewise", versionsDir: dir })).toThrow(/build both steps from one folder/u);
  });

  test("a design finding on a page this build rendered is refused", () => {
    const siteRoot = builtSite([], { "about/index.html": '<html><body><main id="main" class="wrap article"><p class="unstyled-thing">x</p></main></body></html>' });
    expect(() => finishSite({ site: siteRoot, baseurl: "/bridlewise" })).toThrow(/design: \.unstyled-thing has no CSS rule/u);
  });
});

describe("G. the site source names no coordinate of its own", () => {
  test("a page, a text file or the layout spelling the repository's GitHub or Pages URL is refused", async () => {
    // Plants in four places and three spellings: the current name, the name
    // before the rename, and the Pages host; any case.
    const root = repository({
      "docs/floor/a.md": "---\ntitle: A\n---\n\n[source](https://github.com/Example-Org/site-repo/blob/main/README.md)\n",
      "docs/llms.txt": "Docs: https://example-org.github.io/site-repo/\n",
      "docs/_layouts/default.html": "<html><body><a href=\"https://github.com/example-org/BRIDLEWISE-TESTING\">old</a>{{ content }}</body></html>\n",
      "docs/.well-known/security.txt": "Policy: https://github.com/Example-Org/bridlewise/blob/main/SECURITY.md\n",
    });
    const violations = siteSourceViolations({ coordinates: FIXTURE, root });
    expect(violations.filter((line: string) => line.includes("spells the repository's own URL")).map((line: string) => line.split(":")[0])).toEqual([
      "docs/_layouts/default.html",
      "docs/.well-known/security.txt",
      "docs/floor/a.md",
      "docs/llms.txt",
    ]);
    await expect(source({ root, out: join(root, ".site"), baseurl: "/b" })).rejects.toThrow(/spells the repository's own URL/u);
    // Near misses: another repository of the same owner, a name that only
    // starts like this one, and the configuration read through Liquid.
    expect(siteSourceViolations({ coordinates: FIXTURE, root: repository({
      "docs/floor/b.md": "---\ntitle: B\n---\n\n[evidence](https://github.com/Example-Org/site-repo-evidence) · [scorecard](https://scorecard.dev/viewer/?uri=github.com/{{ site.repository }}) · [source]({{ site.repository_url }})\n",
    }) })).toEqual([]);
  });

  test("a record may cite a GitHub object by URL; nothing else, and no site page may", () => {
    const issue = "https://github.com/Example-Org/site-repo/issues/155";
    const root = repository({
      // Records: an issue, a pull request's files tab, a discussion, a run's job and a release tag are citations…
      "docs/decisions/D-1.md": `---\nid: D-1\n---\n\n[#155](${issue}) · [#3](https://github.com/Example-Org/site-repo/pull/3/files) · [d](https://github.com/example-org/BRIDLEWISE-TESTING/discussions/9)\n`,
      "docs/community/intake.json": JSON.stringify({ planned: issue, run: "https://github.com/Example-Org/site-repo/actions/runs/12/job/34", tag: "https://github.com/Example-Org/site-repo/releases/tag/v0.1.0" }),
      // …but a file link, a listing, the bare repository, the site, and a walk out of an object are not.
      "docs/decisions/D-2.md": "---\nid: D-2\n---\n\n[file](https://github.com/Example-Org/site-repo/blob/main/README.md) · [all](https://github.com/Example-Org/site-repo/issues) · [walk](https://github.com/Example-Org/site-repo/issues/1/../../blob/main/x)\n",
      "docs/trackers/items/T-1.json": JSON.stringify({ repo: "https://github.com/Example-Org/site-repo", site: "https://example-org.github.io/site-repo/floor/" }),
      // A site page may not even cite an issue by a spelled URL: it reads site.repository_url.
      "docs/floor/a.md": `---\ntitle: A\n---\n\n[#155](${issue})\n`,
    });
    const found = siteSourceViolations({ coordinates: FIXTURE, root }).map((line: string) => `${line.split(": ")[0]} ${line.includes("a record cites") ? "record" : "page"}`);
    expect(found).toEqual([
      "docs/decisions/D-2.md:5 record",
      "docs/decisions/D-2.md:5 record",
      "docs/decisions/D-2.md:5 record",
      "docs/floor/a.md:5 page",
      "docs/trackers/items/T-1.json:1 record",
      "docs/trackers/items/T-1.json:1 record",
    ]);
  });

  test("rendered versions links use the builder marker; source-token presence grants no URL", async () => {
    // These are declared Jekyll output shapes, not a substitute Markdown/Liquid renderer.
    const forms = {
      "docs/floor/a.md": { source: '<a href="{{ \'/v/\' | relative_url }}">Versions</a>', href: "/bridlewise/v/" },
      "docs/floor/b.md": { source: '[1.0]({{ "/v/1.0.0/" | relative_url }})', href: "/bridlewise/v/1.0.0/" },
      "docs/floor/c.md": { source: '<a href="{{ site.baseurl }}/v/">Versions</a>', href: "/bridlewise/v/" },
      "docs/floor/d.md": { source: '<a href="{{ \'/v/\' | absolute_url }}">Versions</a>', href: "https://example-org.github.io/bridlewise/v/" },
      "docs/floor/e.md": { source: '<a href="{{ \'/v/\' | append: \'\' | relative_url }}">Versions</a>', href: "/bridlewise/v/" },
      "docs/floor/f.md": { source: '<a href="{{ \'/v/\' | prepend: site.baseurl }}">Versions</a>', href: "/bridlewise/v/" },
      "docs/g.md": { source: '<a href="../v/">Versions</a>', href: "/bridlewise/v/" },
      "docs/floor/h.md": { source: '<a href="{{ site.url }}{{ site.baseurl }}/v/versions.json">Versions</a>', href: "https://example-org.github.io/bridlewise/v/versions.json" },
    };
    const root = repository(Object.fromEntries(Object.entries(forms).map(([path, item]) => [path, `---\ntitle: P\n---\n\n${item.source}\n`])));
    expect(siteSourceViolations({ coordinates: FIXTURE, root })).toEqual([]);
    await expect(source({ root, out: join(root, ".site"), baseurl: BASE })).resolves.toBeDefined();
    const denied = renderedFixture(root, FIXTURE, Object.fromEntries(Object.entries(forms).map(([path, item]) => [path, `<a href="${item.href}">Versions</a>`])));
    const refusal = (() => { try { resolveSitePageLinks({ root, site: denied.site, baseurl: BASE, coordinates: FIXTURE }); return null; } catch (error) { return error; } })();
    expect(refusal).toBeInstanceOf(Error);
    for (const path of Object.keys(forms)) expect((refusal as Error).message).toContain(path);
    expect((refusal as Error).message).toMatch(/versions/u);

    const validRoot = repository({
      "docs/floor/allowed.md": '---\ntitle: Versions\n---\n# Versions\n\n[versions]({{ site.versions_url }}) · [very](../very.md) · [vision](../vision.md)\n',
      "docs/very.md": "# Very\n", "docs/vision.md": "# Vision\n",
    });
    const bodies = { "docs/floor/allowed.md": `<a href="${SITE_LINKS.versions}">Versions</a> · <a href="../very.md">Very</a> · <a href="../vision.md">Vision</a><pre><code>${escapeHtml('<a href="/bridlewise/v/9.9.9/">')}Quoted</code></pre>` };
    const allowed = renderedFixture(validRoot, FIXTURE, bodies);
    const projected = JSON.parse(readFileSync(join(allowed.site, SITE_PLAN_FILE), "utf8"));
    expect(projected.phase).toBe("source");
    expect(projected.pages["docs/floor/allowed.md"].sourceSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(projected.pages["docs/floor/allowed.md"]).not.toHaveProperty("globalLinks");
    expect(resolveSitePageLinks({ root: validRoot, site: allowed.site, baseurl: BASE, coordinates: FIXTURE }).rewritten).toBe(3);
    expect(JSON.parse(readFileSync(join(allowed.site, SITE_PLAN_FILE), "utf8")).phase).toBe("links-resolved");
    const wrongVersion = renderedFixture(validRoot, FIXTURE, { "docs/floor/allowed.md": '<a href="/bridlewise/v/9.9.9/">Not the declared live versions page</a>' });
    expect(() => resolveSitePageLinks({ root: validRoot, site: wrongVersion.site, baseurl: BASE, coordinates: FIXTURE })).toThrow(/versions/u);
    write(validRoot, "docs/floor/literal.md", '# Literal\n\n<a href="/bridlewise/v/">No global declaration</a>\n');
    const noInheritance = renderedFixture(validRoot, FIXTURE, { ...bodies, "docs/floor/literal.md": '<a href="/bridlewise/v/">No global declaration</a>' });
    expect(() => resolveSitePageLinks({ root: validRoot, site: noInheritance.site, baseurl: BASE, coordinates: FIXTURE })).toThrow(/docs\/floor\/literal\.md/u);
  });

  test("source versions tokens in plain code or actual Liquid never authorize a hardcoded rendered versions URL", async () => {
    const examples = [
      { source: '# Code example\n\n`{{ site.versions_url }}`\n', body: '<code>{{ site.versions_url }}</code><a href="/bridlewise/v/">Hardcoded URL</a>', raw: true },
      { source: '---\ntitle: Versions\n---\n[Versions]({{ site.versions_url }})\n', body: '<a href="/bridlewise/v/">Hardcoded despite a real Liquid source expression</a>', raw: false },
    ];
    for (const example of examples) {
      const root = repository({ "docs/floor/token.md": example.source });
      if (example.raw) {
        const out = join(root, ".plain-code-source");
        await source({ root, out, baseurl: BASE });
        expect(readFileSync(join(out, "floor/token.md"), "utf8")).toContain("{% raw %}\n# Code example\n\n`{{ site.versions_url }}`");
      }
      // The actual rendered href, not source-token presence, decides ownership.
      const rendered = renderedFixture(root, FIXTURE, { "docs/floor/token.md": example.body });
      expect(() => resolveSitePageLinks({ root, site: rendered.site, baseurl: BASE, coordinates: FIXTURE })).toThrow(/docs\/floor\/token\.md:.*versions folder/u);
    }
  });

  test("the source config cannot declare a builder-owned key, and must read as YAML", async () => {
    const build = (config: string) => {
      const root = repository({ "docs/_config.yml": config });
      return source({ root, out: join(root, ".site"), baseurl: "/b" });
    };
    await expect(build("title: Fixture\nbaseurl: /old\nrepository_url: https://example.test\n")).rejects.toThrow(/declares baseurl, repository_url, which the builder writes/u);
    await expect(build("title: Fixture\nversions_url: /v/\n")).rejects.toThrow(/declares versions_url/u);
    for (const enabled of [true, false]) await expect(build(`title: Fixture\nrelative_links:\n  enabled: ${String(enabled)}\n`)).rejects.toThrow(/declares relative_links/u);
    await expect(build("title: A\ntitle: B\n")).rejects.toThrow(/_config\.yml is unreadable/u);
    // Near miss: a page front matter or a nested key of the same name is not the site's key.
    await expect(build("title: Fixture\ndefaults:\n  - values:\n      url: /x\n")).resolves.toBeDefined();
  });

  test("this repository's own tree prepares a docs-only release with local floor data and a live versions address", async () => {
    expect(siteSourceViolations({ root: REAL_ROOT })).toEqual([]);
    const out = join(createTempDir("site-release-"), "src");
    // Source preparation preserves the renderer input; the mandatory rendered link gate follows Jekyll.
    await buildSiteSource({ root: REAL_ROOT, out, baseurl: "/bridlewise/docs/v/0.1.0", release: "0.1.0" });
    expect(parse(readFileSync(join(out, "_config.yml"), "utf8"))).toMatchObject({ versions_url: SITE_LINKS.versions, release_version: "0.1.0", relative_links: { enabled: false } });
    expect(existsSync(join(out, "v"))).toBe(false);
    // The floor pages' data is in the snapshot (the review's probe: without it every later deploy refused).
    expect(JSON.parse(readFileSync(join(out, "floor/data/atlas.json"), "utf8")).schemaVersion).toBe("bridlewise-floor-atlas/v1");
    expect(JSON.parse(readFileSync(join(out, "floor/data/status.json"), "utf8")).schemaVersion).toBe("bridlewise-floor-status/v1");
  });

  test("source preserves links and the mandatory rendered finish refuses missing page and layout resources", async () => {
    const root = repository({
      "docs/floor/a.md": "---\ntitle: A\n---\n\n<div data-src=\"x\"></div><a href=\"{{ '/floor/data/other.json' | relative_url }}\">data</a>\n",
      "docs/_layouts/default.html": "<html><body><a href=\"{{ site.baseurl }}/nowhere.json\">x</a>{{ content }}</body></html>\n",
    });
    const prepared = join(root, ".release");
    await expect(source({ root, out: prepared, baseurl: "/b/v/0.3.0", release: "0.3.0" })).resolves.toBeDefined();
    expect(readFileSync(join(prepared, "floor/a.md"), "utf8")).toContain("{{ '/floor/data/other.json' | relative_url }}");
    // The hand-shaped rendered fixtures exercise the real finish door. Native Jekyll is a separate oracle.
    const completeFixture = (sourceRoot: string, bodies: Readonly<Record<string, string>>): ReturnType<typeof renderedFixture> => {
      const rendered = renderedFixture(sourceRoot, FIXTURE, bodies);
      write(rendered.site, "assets/css/style.css", ".wrap{} .article{}\n");
      write(rendered.site, "assets/floor/floor.css", "");
      write(rendered.site, "assets/logo.png", "png");
      write(rendered.site, "floor/data/status.json", "{}\n");
      write(rendered.site, "sitemap.xml", "<urlset/>\n");
      write(rendered.site, "v/index.html", policied("<p>Versions</p>"));
      write(rendered.site, "v/versions.json", JSON.stringify({ current: "main", versions: [] }));
      return rendered;
    };
    const broken = completeFixture(root, { "docs/floor/a.md": '<div data-src="x"></div><a href="/bridlewise/floor/data/other.json">data</a>' });
    const home = candidateSiteFiles(broken.site, "/")[0];
    writeFileSync(home, readFileSync(home, "utf8").replace("<body>", '<body><a href="/bridlewise/nowhere.json">layout resource</a>'));
    const refusal = (() => { try { finishSiteOwner({ root, site: broken.site, baseurl: BASE, coordinates: FIXTURE }); return null; } catch (error) { return error; } })();
    expect(refusal).toBeInstanceOf(Error);
    const missing = (refusal as Error).message.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("link: "));
    expect(missing).toHaveLength(2);
    expect(missing.some((line) => line.includes("floor/a/index.html") && line.includes("/floor/data/other.json"))).toBe(true);
    expect(missing.some((line) => line.includes("index.html") && line.includes("/nowhere.json"))).toBe(true);
    // Near misses: generated data, a served asset, source-relative pages and the generated sitemap remain reachable.
    const validRoot = repository({ "docs/floor/b.md": '# B\n\n<a href="{{ \'/floor/data/status.json\' | relative_url }}">s</a> <a href="{{ \'/assets/logo.png\' | relative_url }}">l</a> <a href="roadmap.md">r</a> <a href="../index.md">p</a> <a href="{{ site.baseurl }}/sitemap.xml">m</a>\n' });
    const valid = completeFixture(validRoot, { "docs/floor/b.md": '<a href="/bridlewise/floor/data/status.json">s</a> <a href="/bridlewise/assets/logo.png">l</a> <a href="roadmap.md">r</a> <a href="../index.md">p</a> <a href="/bridlewise/sitemap.xml">m</a>' });
    expect(finishSiteOwner({ root: validRoot, site: valid.site, baseurl: BASE, coordinates: FIXTURE }).versions).toEqual([]);
  });

  test("a redirect page escapes its target through the one markup owner", async () => {
    // A permalink holding markup characters: the redirect page must not emit them raw.
    const root = repository({ "docs/odd.md": "---\npermalink: /a&b'<c>/\n---\n\n# Odd\n" });
    const out = join(root, ".site");
    await source({ root, out, baseurl: "/b" });
    const moved = readFileSync(join(out, "a&b'<c>.md", "index.html"), "utf8");
    const target = "/b/a&b'<c>/";
    expect(escapeHtml(target)).not.toBe(target);
    expect(moved).toContain(`<a href="${escapeHtml(target)}">${escapeHtml(target)}</a>`);
    expect(moved).not.toContain(`href="${target}"`);
  });

  test("an alias that is itself a page's URL is never redirected", () => {
    // `/a.md` is the `.md` spelling of docs/a.md's page AND the permalink of docs/b.md.
    const plan = sitePlan({ coordinates: FIXTURE, root: repository({ "docs/a.md": "# A\n", "docs/b.md": "---\npermalink: /a.md\n---\n\n# B\n" }) });
    expect(plan.byPermalink.has("/a.md")).toBe(true);
    expect(new Map(legacyAliases(plan)).has("/a.md")).toBe(false);
    expect(new Map(legacyAliases(sitePlan({ coordinates: FIXTURE, root: repository({ "docs/a.md": "# A\n" }) }))).get("/a.md")).toBe("/a/");
  });
});

const FROM = "https://llm-4-people.github.io/bridlewise-testing/";
const TO = "https://bridlewise.llm4people.dev/";

describe("W5. live pages and the versioned documentation share one publish plan", () => {
  const coordinates = { ...FIXTURE, docsPath: "/docs/" };
  const routes = {
    schemaVersion: "bridlewise-site-page-routes/v1",
    docsHome: "README.md",
    livePages: { "index.md": "/", "floor/roadmap.md": "/roadmap/", "run/index.html": "/run/" },
  };
  const routedRepository = () => repository({
    "docs/_data/page-routes.json": `${JSON.stringify(routes)}\n`,
    "docs/README.md": "# Documentation\n\n[Guide](quickstart.md) · [Roadmap](floor/roadmap.md)\n",
    "docs/quickstart.md": "# Quickstart\n\n[Documentation](README.md) · [Home](index.md) · [Roadmap](floor/roadmap.md) · [Run](run/index.html)\n",
    "docs/run/index.html": "---\nlayout: default\ntitle: Run\n---\n<a href=\"../quickstart.md\">Read the guide</a>\n",
    "docs/_data/navigation.yml": "home:\n  page: index.md\nprimary:\n  - title: Quickstart\n    page: quickstart.md\n  - title: Roadmap\n    page: floor/roadmap.md\nsections: []\n",
  });

  test("W5 gives the docs home its own URL and includes published HTML in the same collision judgement", () => {
    const plan = sitePlan({ root: routedRepository(), coordinates });
    expect(plan.collisions).toEqual([]);
    expect(plan.pages.get("docs/README.md").permalink).toBe("/docs/");
    expect(plan.pages.get("docs/quickstart.md").permalink).toBe("/docs/quickstart/");
    expect(plan.pages.get("docs/floor/roadmap.md").permalink).toBe("/roadmap/");
    expect(plan.pages.get("docs/run/index.html").permalink).toBe("/run/");
  });

  test("W5 snapshots contain the docs home and local assets while root Markdown and HTML stay live", async () => {
    const root = routedRepository();
    const out = join(root, ".release");
    const baseurl = "/project/docs/v/0.1.0";
    await source({ root, out, coordinates, baseurl, release: "0.1.0" });
    expect(existsSync(join(out, "index.md"))).toBe(false);
    expect(existsSync(join(out, "floor/roadmap.md"))).toBe(false);
    expect(existsSync(join(out, "run/index.html"))).toBe(false);
    const home = readFileSync(join(out, "README.md"), "utf8");
    expect(home).toContain('permalink: "/"');
    expect(home).toContain("[Guide](quickstart.md)");
    const guide = readFileSync(join(out, "quickstart.md"), "utf8");
    expect(guide).toContain("[Documentation](README.md)");
    expect(guide).toContain("[Home](index.md)");
    expect(guide).toContain("[Roadmap](floor/roadmap.md)");
    expect(guide).toContain("[Run](run/index.html)");
    const rendered = renderedFixture(root, coordinates, {
      "docs/README.md": '<a href="quickstart.md">Guide</a>',
      "docs/quickstart.md": '<a href="README.md">Documentation</a> · <a href="index.md">Home</a> · <a href="floor/roadmap.md">Roadmap</a> · <a href="run/index.html">Run</a>',
    }, baseurl, "0.1.0");
    expect(resolveSitePageLinks({ root, site: rendered.site, baseurl, coordinates, release: "0.1.0" }).rewritten).toBe(5);
    const readRendered = (key: string): string => readFileSync(candidateSiteFiles(rendered.site, rendered.plan.pages.get(key).permalink)[0], "utf8");
    expect(readRendered("docs/README.md")).toContain('href="/project/docs/v/0.1.0/quickstart/"');
    const renderedGuide = readRendered("docs/quickstart.md");
    for (const target of ["/project/docs/v/0.1.0/", "/project/", "/project/roadmap/", "/project/run/"]) expect(renderedGuide).toContain(`href="${target}"`);
    expect(existsSync(join(out, "assets/logo.png"))).toBe(true);
    expect(parse(readFileSync(join(out, "_config.yml"), "utf8"))).toMatchObject({ versions_url: SITE_LINKS.versions, release_version: "0.1.0", relative_links: { enabled: false } });
  });

  test("W5 release assets use their active snapshot base while literal version and page addresses refuse", () => {
    const root = routedRepository();
    const baseurl = "/project/docs/v/0.1.0";
    const release = "0.1.0";
    const rendered = renderedFixture(root, coordinates, { "docs/README.md": `<img src="${baseurl}/assets/logo.png"><a href="${baseurl}/floor/data/status.json">Snapshot data</a>` }, baseurl, release);
    write(rendered.site, "assets/logo.png", "snapshot asset");
    write(rendered.site, "floor/data/status.json", "{}");
    expect(resolveSitePageLinks({ root, site: rendered.site, baseurl, release, coordinates }).rewritten).toBe(0);
    expect(crawlSiteLinks({ siteRoot: rendered.site, baseurl }).unresolved).toEqual([]);
    for (const target of [`${baseurl}/quickstart/`, "/project/docs/v/9.9.9/assets/logo.png", "/project/docs/v/"]) {
      const literal = renderedFixture(root, coordinates, { "docs/README.md": `<a href="${target}">Literal</a>` }, baseurl, release);
      expect(() => resolveSitePageLinks({ root, site: literal.site, baseurl, release, coordinates })).toThrow(/versions folder|spells the page URL/u);
    }
  });

  test("W5 writes page addresses and navigation before resolving rendered HTML without a second base prefix", async () => {
    const root = routedRepository();
    const out = join(root, ".site");
    await source({ root, out, coordinates, baseurl: "/project" });
    expect(readFileSync(join(out, "run/index.html"), "utf8")).toContain('href="../quickstart.md"');
    expect(readFileSync(join(out, "run/index.html"), "utf8")).toContain('permalink: /run/');
    const rendered = renderedFixture(root, coordinates, { "docs/run/index.html": '<a href="../quickstart.md">Read the guide</a>' }, "/project");
    expect(resolveSitePageLinks({ root, site: rendered.site, baseurl: "/project", coordinates }).rewritten).toBe(1);
    expect(readFileSync(candidateSiteFiles(rendered.site, "/run/")[0], "utf8")).toContain('href="/project/docs/quickstart/"');
    const navigation = parse(readFileSync(join(out, "_data/navigation.yml"), "utf8"));
    expect(navigation.home.href).toBe("/project/");
    expect(navigation.primary.map((item: { href: string }) => item.href)).toEqual(["/project/docs/quickstart/", "/project/roadmap/"]);
    expect(existsSync(join(out, "docs/v/index.md"))).toBe(true);
    expect(JSON.parse(readFileSync(join(out, "docs/v/versions.json"), "utf8"))).toEqual({ current: "main", versions: [] });
    expect(existsSync(join(out, "versions.json"))).toBe(false);
  });

  test("W5 derives one-hop old URLs from the captured page identities", () => {
    const root = routedRepository();
    const plan = sitePlan({ root, coordinates });
    expect(landingPath("/floor/roadmap/", plan)).toBe("/roadmap/");
    expect(landingPath("/trackers/TASKS/", plan)).toBe("/docs/trackers/TASKS/");
    expect(landingPath("/product/", plan)).toBe("/");
    expect(new Map(legacyAliases(plan)).has("/roadmap/")).toBe(false);
    const snapshot = sitePlan({ root, coordinates, snapshot: true });
    expect(new Map(legacyAliases(snapshot)).has("/floor/roadmap/")).toBe(false);
    expect(new Map(legacyAliases(snapshot)).has("/product/")).toBe(false);
  });

  test("W5 URL capture uses the current plan and refuses to overwrite its immutable record", () => {
    const root = routedRepository();
    const original = readFileSync(join(root, "docs/_data/site-url-history.json"), "utf8");
    const out = join(root, "captured.json");
    captureSiteUrls({ root, out });
    expect(JSON.parse(readFileSync(out, "utf8")).pages["docs/quickstart.md"]).toBe("/docs/quickstart/");
    expect(readFileSync(join(root, "docs/_data/site-url-history.json"), "utf8")).toBe(original);
    const refusal = (() => { try { captureSiteUrls({ root, out }); return null; } catch (error) { return error; } })();
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as NodeJS.ErrnoException).code).toBe("EEXIST");
  });

  test("W5 resolves actual rendered attributes while escaped code and raw-text examples stay exact", () => {
    const root = routedRepository();
    const body = `<script type="application/json">{"example":"<a href=missing.md>"}</script><pre><code>${escapeHtml('<a href="missing.md">Example</a>')}</code></pre><a href="quickstart.md">Actual guide</a> · <a href="floor/roadmap.md">Actual roadmap</a>`;
    const rendered = renderedFixture(root, coordinates, { "docs/README.md": body }, "/project");
    expect(resolveSitePageLinks({ root, site: rendered.site, baseurl: "/project", coordinates }).rewritten).toBe(2);
    const html = readFileSync(candidateSiteFiles(rendered.site, "/docs/")[0], "utf8");
    expect(html).toContain('href="/project/docs/quickstart/"');
    expect(html).toContain('href="/project/roadmap/"');
    expect(html).toContain(escapeHtml('<a href="missing.md">Example</a>'));
    expect(html).toContain('{"example":"<a href=missing.md>"}');
  });

  test("W5 output admission preserves an existing directory and its unknown contents", async () => {
    const root = routedRepository();
    const out = join(root, ".existing");
    write(out, "keep.txt", "unknown existing work\n");
    const refusal = await source({ root, out, coordinates, baseurl: "/project" }).then(() => null, (error: unknown) => error);
    expect(existsSync(join(out, "keep.txt"))).toBe(true);
    expect(readFileSync(join(out, "keep.txt"), "utf8")).toBe("unknown existing work\n");
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toMatch(/site output must be a new directory/u);
  });

  test("W5 output admission cannot erase the source checkout", async () => {
    const root = routedRepository();
    const before = readFileSync(join(root, "README.md"), "utf8");
    const refusal = await source({ root, out: root, coordinates, baseurl: "/project" }).then(() => null, (error: unknown) => error);
    expect(existsSync(join(root, "README.md"))).toBe(true);
    expect(readFileSync(join(root, "README.md"), "utf8")).toBe(before);
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toMatch(/site output must be a new directory/u);
  });

  test("W5 output admission protects the redirect destination and refuses a copy inside docs input", async () => {
    const root = routedRepository();
    const out = join(root, ".redirect");
    write(out, "keep.txt", "preserve redirect destination\n");
    expect(() => buildRedirectSite({ root, out, coordinates, from: FROM, to: TO })).toThrow(/site output must be a new directory/u);
    expect(readFileSync(join(out, "keep.txt"), "utf8")).toBe("preserve redirect destination\n");
    const nested = join(root, "docs/generated");
    const refusal = await source({ root, out: nested, coordinates, baseurl: "/project" }).then(() => null, (error: unknown) => error);
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toMatch(/outside its documentation input/u);
    expect(existsSync(nested)).toBe(false);
  });

  test("W5 refuses actual rendered literal page URLs while preserving asset references and escaped examples", () => {
    const root = routedRepository();
    write(root, "docs/quickstart.md", '# Quickstart\n\n<a href="{{ \'/roadmap/\' | relative_url }}">Roadmap</a>\n[Guide](/docs/quickstart/)\n<a href="/future-page/">Future</a>\n<img src="{{ \'/assets/logo.png\' | relative_url }}" alt="logo">\n');
    expect(siteSourceViolations({ root, coordinates })).toEqual([]);
    const rendered = renderedFixture(root, coordinates, { "docs/quickstart.md": `<a href="/project/roadmap/">Roadmap</a><a href="/project/docs/quickstart/">Guide</a><a href="/project/future-page/">Future</a><img src="/project/assets/logo.png" alt="logo"><pre><code>${escapeHtml('<a href="/project/roadmap/">')}Example</code></pre>` }, "/project");
    const refusal = (() => { try { resolveSitePageLinks({ root, site: rendered.site, baseurl: "/project", coordinates }); return null; } catch (error) { return error; } })();
    expect(refusal).toBeInstanceOf(Error);
    for (const path of ["/roadmap/", "/docs/quickstart/", "/future-page/"]) expect((refusal as Error).message).toContain(path);
    expect((refusal as Error).message).toContain("docs/quickstart.md");
    expect((refusal as Error).message).not.toContain("assets/logo.png");
  });

  test("W5 refuses navigation URL literals and a missing source page rather than emitting an empty href", async () => {
    for (const leaf of [{ title: "Old", path: "/roadmap/" }, { title: "Old", href: "/roadmap/" }, { title: "Missing", page: "missing.md" }, { title: "No target" }, { title: "Forged", page: "README.md", sourceRef: "authored" }]) {
      const root = routedRepository();
      write(root, "docs/_data/navigation.yml", `primary: ${JSON.stringify([leaf])}\nsections: []\n`);
      const refusal = await source({ root, out: join(root, ".site"), coordinates, baseurl: "/project" }).then(() => null, (error: unknown) => error);
      expect(refusal).toBeInstanceOf(Error);
      expect((refusal as Error).message).toMatch(/^navigation /u);
    }
  });

  test("W5 generated per-link source references retain usable URLs before finalization", async () => {
    const root = routedRepository();
    write(root, "src/demo/index.html", "<!doctype html><title>Example source</title>");
    write(root, "docs/_data/page-routes.json", JSON.stringify({ ...routes, artifacts: [{ sourceEntry: "src/demo/index.html", outputPath: "/demo/", connections: "none", surface: "cockpit" }] }));
    write(root, "docs/_data/navigation.yml", 'demo:\n  artifact: src/demo/index.html\nprimary:\n  - title: Docs\n    page: README.md\nsections: []\n');
    const out = join(createTempDir("navigation-source-reference-"), "site");
    await source({ root, out, coordinates, baseurl: "/project" });
    const navigation = parse(readFileSync(join(out, "_data/navigation.yml"), "utf8"));
    expect(navigation.demo.href).toBe("/project/demo/");
    expect(navigation.demo.sourceRef).toBe(siteSourceReference("src/demo/index.html"));
    expect(navigation.primary[0].sourceRef).toBe(siteSourceReference("docs/README.md"));
    const body = `<a href="${navigation.demo.href}" ${SITE_SOURCE_ATTRIBUTE}="${navigation.demo.sourceRef}">Example</a><iframe title="Example" src="${escapeHtml(`${navigation.demo.href}?view=embedded&path=%2f#cause`)}" ${SITE_SOURCE_ATTRIBUTE}="${navigation.demo.sourceRef}"></iframe>`;
    const built = renderedFixture(root, coordinates, { "docs/README.md": body }, "/project");
    const entry = candidateSiteFiles(built.site, "/docs/")[0];
    const before = siteDocumentLinks(readFileSync(entry, "utf8"));
    expect(before).toContain("/project/demo/?view=embedded&path=%2f#cause");
    expect(before.every((target: string) => !target.startsWith(SITE_LINK_PREFIX)), "Visual sees real URLs before finish").toBe(true);
    const result = resolveSitePageLinks({ root, site: built.site, baseurl: "/project", coordinates });
    expect(result.verifiedReferences).toBe(2);
    expect(result.rewritten, "provenance does not replace the real href with an intermediate URL").toBe(0);
    const final = readFileSync(entry, "utf8");
    expect(siteDocumentLinks(final)).toEqual(before);
    expect(final).not.toContain(SITE_SOURCE_ATTRIBUTE);
    expect(final).not.toContain(SITE_LINK_PREFIX);
  });

  test("W5 per-link source binding refuses copied, stale, malformed and dangling references", () => {
    const root = routedRepository();
    const reference = siteSourceReference("docs/README.md");
    const attr = `${SITE_SOURCE_ATTRIBUTE}="${reference}"`;
    const cases = [
      `<a href="/project/docs/quickstart/" ${attr}>Copied to the wrong target</a>`,
      `<a href="/project/docs-old/" ${attr}>Stale target</a>`,
      `<a href="/project/docs/" ${SITE_SOURCE_ATTRIBUTE}="${siteSourceReference("docs/unknown.md")}">Unknown source</a>`,
      `<a href="/project/docs/" ${SITE_SOURCE_ATTRIBUTE}="${SITE_LINK_PREFIX}unknown">Unknown marker</a>`,
      `<a href="/project/docs/" ${SITE_SOURCE_ATTRIBUTE}="">Empty marker</a>`,
      `<p ${attr}>A marker beside another link grants nothing</p><a href="/project/docs/">Literal</a>`,
      `<a href="/project/docs/" ${attr}>Generated</a><a href="/project/docs/">Unmarked literal on the same page</a>`,
      `<a href="/project/docs/" src="/project/docs/" ${attr}>Ambiguous URL attribute</a>`,
      `<a href="/project/docs/" href="/project/docs/quickstart/" ${attr}>Duplicate URL attribute</a>`,
      `<a href="/project/docs/" ${attr} ${attr}>Duplicate reference</a>`,
    ];
    for (const body of cases) {
      const rendered = renderedFixture(root, coordinates, { "docs/README.md": body }, "/project");
      const entry = candidateSiteFiles(rendered.site, "/docs/")[0];
      const html = readFileSync(entry, "utf8");
      const plan = readFileSync(join(rendered.site, SITE_PLAN_FILE), "utf8");
      expect(() => resolveSitePageLinks({ root, site: rendered.site, baseurl: "/project", coordinates })).toThrow(/source reference|spells the page URL/u);
      expect(readFileSync(entry, "utf8")).toBe(html);
      expect(readFileSync(join(rendered.site, SITE_PLAN_FILE), "utf8")).toBe(plan);
    }
    write(root, "docs/quickstart.md", `# Literal reserved marker\n<a href="/project/docs/" ${attr}>Literal reserved marker</a>\n`);
    expect(siteSourceViolations({ root, coordinates })).toEqual([expect.stringContaining("docs/quickstart.md: authored source contains a reserved builder link marker")]);
  });

  test("W5 requires captured history and canonical source-key/path declarations", () => {
    const absent = routedRepository();
    unlinkSync(join(absent, "docs/_data/site-url-history.json"));
    expect(() => sitePlan({ root: absent, coordinates })).toThrow(/captured URL history must be preserved/u);
    const root = routedRepository();
    write(root, "docs/_data/site-url-history.json", JSON.stringify({ schemaVersion: "bridlewise-site-url-history/v1", pages: { "../outside.md": "/old/" }, aliases: {} }));
    expect(() => sitePlan({ root, coordinates })).toThrow(/is not a captured publish plan/u);
    const ambiguous = routedRepository();
    write(ambiguous, "docs/_data/site-url-history.json", JSON.stringify({ schemaVersion: "bridlewise-site-url-history/v1", pages: { "docs/index.md": "/old/", "docs/quickstart.md": "/old/" }, aliases: {} }));
    expect(() => sitePlan({ root: ambiguous, coordinates })).toThrow(/duplicate captured page URLs/u);
    for (const path of ["/a/../", "/a/%2e%2e/", "/a//b/", "/roadmap/?secret=value", "//other.example/"]) {
      const invalid = routedRepository();
      write(invalid, "docs/_data/page-routes.json", JSON.stringify({ ...routes, livePages: { ...routes.livePages, "floor/roadmap.md": path } }));
      expect(() => sitePlan({ root: invalid, coordinates })).toThrow(/is not a site-page route declaration/u);
    }
  });

  test("W5 source URL ownership covers unquoted links and ignores whole multiline comments and raw text", () => {
    const root = routedRepository();
    write(root, "docs/quickstart.md", '# Guide\n<!--\n<a href="/docs/">comment</a>\n-->\n<script>\nconst example = \'<a href="/docs/">\';\n</script>\n<a href=/docs/>Actual literal</a>\n<a\n href="/roadmap/">Multiline literal</a>\n');
    expect(siteSourceViolations({ root, coordinates })).toEqual([]);
    const rendered = renderedFixture(root, coordinates, { "docs/quickstart.md": '<!--\n<a href="/docs/">comment</a>\n--><script>const example = \'<a href="/docs/">\';</script><a href=/docs/>Actual literal</a><a\n href="/roadmap/">Multiline literal</a>' }, "/project");
    const refusal = (() => { try { resolveSitePageLinks({ root, site: rendered.site, baseurl: "/project", coordinates }); return null; } catch (error) { return error; } })();
    expect(refusal).toBeInstanceOf(Error);
    const literalErrors = (refusal as Error).message.split("\n").filter((line) => line.includes("spells the page URL"));
    expect(literalErrors).toHaveLength(2);
    for (const target of ["/docs/", "/roadmap/"]) expect(literalErrors.some((line) => line.includes(`page URL ${target};`))).toBe(true);
    const unquoted = renderedFixture(root, coordinates, { "docs/README.md": `<a href=quickstart.md>Guide</a><code>${escapeHtml("<script>")}</code>` }, "/project");
    expect(resolveSitePageLinks({ root, site: unquoted.site, baseurl: "/project", coordinates }).rewritten).toBe(1);
    expect(readFileSync(candidateSiteFiles(unquoted.site, "/docs/")[0], "utf8")).toContain('href="/project/docs/quickstart/"');
    write(root, "docs/quickstart.md", '<div markdown="0">\n`<a href="/docs/">Actual HTML link</a>`\n</div>\n');
    expect(siteSourceViolations({ root, coordinates })).toEqual([]);
    const rawHtml = renderedFixture(root, coordinates, { "docs/quickstart.md": '<div markdown="0">\n`<a href="/docs/">Actual HTML link</a>`\n</div>' }, "/project");
    expect(() => resolveSitePageLinks({ root, site: rawHtml.site, baseurl: "/project", coordinates })).toThrow(/spells the page URL \/docs\//u);
  });

  test("W5 derives declared document roles at non-HTML suffixes without promoting Markdown assets", () => {
    const root = routedRepository();
    write(root, "docs/quickstart.md", '---\npermalink: /page.md\n---\n# Guide\n');
    const rendered = renderedFixture(root, coordinates);
    for (const name of ["upper.HTML", "short.htm", "xml.xhtml"]) write(rendered.site, name, "<html><body>Discovered</body></html>");
    write(rendered.site, "assets/source.md", "# An asset, not a rendered document\n");
    const facts = readSiteDocumentFiles({ site: rendered.site, phase: "source", root, baseurl: BASE, coordinates });
    expect(facts.errors).toEqual([]);
    expect(facts.planned.find((page: { sourceId: string }) => page.sourceId === "docs/quickstart.md")).toMatchObject({ permalink: "/docs/page.md", file: join(rendered.site, "docs/page.md"), artifact: false });
    expect(facts.documentFiles).toEqual(expect.arrayContaining([join(rendered.site, "docs/page.md"), ...["upper.HTML", "short.htm", "xml.xhtml"].map((name) => join(rendered.site, name))]));
    expect(facts.documentFiles).not.toContain(join(rendered.site, "assets/source.md"));
    expect(Object.isFrozen(facts.documentFiles)).toBe(true);
    expect(Object.isFrozen(facts.planned)).toBe(true);
    expect(resolveSitePageLinks({ root, site: rendered.site, baseurl: BASE, coordinates }).rewritten).toBe(0);
    expect(readSiteDocumentFiles({ site: rendered.site, phase: "links-resolved", root, baseurl: BASE, coordinates }).documentFiles).toEqual(facts.documentFiles);
  });

  test("W5 preserves every missing or ambiguous planned-output error and changes no rendered bytes on refusal", () => {
    const root = routedRepository();
    write(root, "docs/quickstart.md", '---\npermalink: /page.md\n---\n# Guide\n');
    const rendered = renderedFixture(root, coordinates);
    write(rendered.site, "docs/page.md.html", "<html><body>A second candidate</body></html>");
    unlinkSync(candidateSiteFiles(rendered.site, "/docs/")[0]);
    const options = { site: rendered.site, phase: "source", root, baseurl: BASE, coordinates };
    const before = readFileSync(join(rendered.site, SITE_PLAN_FILE), "utf8");
    const bodyBefore = readFileSync(join(rendered.site, "docs/page.md"), "utf8");
    const facts = readSiteDocumentFiles(options);
    expect(facts.errors).toEqual(expect.arrayContaining(["docs/README.md has no single built page at /docs/", "docs/quickstart.md has no single built page at /docs/page.md"]));
    expect(facts.errors).toHaveLength(2);
    expect(facts.problems.map((problem: { kind: string }) => problem.kind)).toEqual(["output", "output"]);
    let refusal: unknown;
    try { resolveSitePageLinks({ root, site: rendered.site, baseurl: BASE, coordinates }); } catch (error) { refusal = error; }
    expect(refusal).toBeInstanceOf(Error);
    for (const error of facts.errors) expect((refusal as Error).message).toContain(error);
    expect(readFileSync(join(rendered.site, SITE_PLAN_FILE), "utf8")).toBe(before);
    expect(readFileSync(join(rendered.site, "docs/page.md"), "utf8")).toBe(bodyBefore);
  });

  test("W5 document-role facts retain projection validation and distinguish artifacts not assembled yet", () => {
    const root = routedRepository();
    write(root, "src/demo/index.html", "<html><body>Demo source</body></html>");
    write(root, "docs/_data/page-routes.json", JSON.stringify({ ...routes, artifacts: [{ sourceEntry: "src/demo/index.html", outputPath: "/demo/", connections: "none", surface: "cockpit" }] }));
    const rendered = renderedFixture(root, coordinates);
    const options = { site: rendered.site, root, baseurl: BASE, coordinates };
    const sourceFacts = readSiteDocumentFiles(options);
    expect(sourceFacts.errors).toEqual([]);
    expect(sourceFacts.planned.find((page: { sourceId: string }) => page.sourceId === "src/demo/index.html")).toMatchObject({ artifact: true, file: null });
    expect(resolveSitePageLinks({ root, site: rendered.site, baseurl: BASE, coordinates }).rewritten).toBe(0);
    expect(readSiteDocumentFiles({ ...options, phase: "links-resolved" }).errors).toEqual(["src/demo/index.html has no single built page at /demo/"]);
    write(rendered.site, "demo/index.html", "<html><body>Built demo</body></html>");
    const completed = readSiteDocumentFiles({ ...options, phase: "links-resolved" });
    expect(completed.errors).toEqual([]);
    expect(completed.planned.find((page: { sourceId: string }) => page.sourceId === "src/demo/index.html").file).toBe(join(rendered.site, "demo/index.html"));
    expect(() => readSiteDocumentFiles({ ...options, baseurl: "/sibling" })).toThrow(/does not describe deployment/u);
    expect(() => readSiteDocumentFiles({ ...options, phase: "source" })).toThrow(/has phase links-resolved/u);
    write(root, "docs/quickstart.md", "# Source changed after the projection\n");
    expect(() => readSiteDocumentFiles(options)).toThrow(/does not match this source/u);
    write(rendered.site, SITE_PLAN_FILE, "{ malformed");
    expect(() => readSiteDocumentFiles(options)).toThrow(/not readable JSON/u);
  });

  test("W5 refuses two source identities claiming one actual document file", () => {
    const root = routedRepository();
    const rendered = renderedFixture(root, coordinates);
    const documentFile = candidateSiteFiles(rendered.site, "/docs/")[0];
    for (const [first, second] of [["docs/README.md", "docs/quickstart.md"], ["docs/quickstart.md", "docs/README.md"]] as const) {
      const projection = sitePlanProjection({ plan: rendered.plan, baseurl: BASE });
      projection.pages["docs/quickstart.md"].permalink = projection.pages["docs/README.md"].permalink;
      for (const sourceId of [first, second]) projection.pages[sourceId].sourceId = "a page property cannot override its source key";
      projection.pages = Object.fromEntries([
        [first, projection.pages[first]], [second, projection.pages[second]],
        ...Object.entries(projection.pages).filter(([sourceId]) => sourceId !== first && sourceId !== second),
      ]);
      write(rendered.site, SITE_PLAN_FILE, JSON.stringify(projection));
      const facts = readSiteDocumentFiles({ site: rendered.site, baseurl: BASE });
      expect(facts.errors).toEqual([`${first} and ${second} share the built page at /docs/`]);
      expect(facts.problems).toEqual([{ kind: "collision", sourceId: second, permalink: "/docs/", message: facts.errors[0] }]);
      expect(facts.planned.slice(0, 2)).toMatchObject([{ sourceId: first, file: documentFile }, { sourceId: second, file: documentFile }]);
      expect(() => readSiteDocumentFiles({ site: rendered.site, root, baseurl: BASE, coordinates })).toThrow(/does not match this source/u);
    }
  });

  test("W5 resolves actual rendered links from source IDs, including raw HTML, without touching code examples", () => {
    const root = routedRepository();
    write(root, "docs/quickstart.md", '---\npermalink: /different/\n---\n# Guide\n');
    const plan = sitePlan({ root, coordinates });
    const built = createTempDir("rendered-source-links-");
    const entry = candidateSiteFiles(built, "/docs/")[0];
    for (const page of plan.byPermalink.values()) {
      const file = candidateSiteFiles(built, page.permalink)[0];
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, policied(page.docsPath === "docs/README.md" ? `<div markdown="0">\`<a href=quickstart.md?q=1#details>Actual HTML</a>\`</div><code>${escapeHtml('<a href="missing.md">')}</code><script>const example = '<a href="missing.md">';</script>` : '<p>Page</p>'));
    }
    write(built, SITE_PLAN_FILE, JSON.stringify(sitePlanProjection({ plan, baseurl: "/bridlewise" })));
    expect(resolveSitePageLinks({ root, site: built, baseurl: "/bridlewise", coordinates }).rewritten).toBe(1);
    const html = readFileSync(entry, "utf8");
    expect(html).toContain('href="/bridlewise/docs/different/?q=1#details"');
    expect(html).toContain(escapeHtml('<a href="missing.md">'));
    expect(html).toContain('const example = \'<a href="missing.md">\';');
    expect(JSON.parse(readFileSync(join(built, SITE_PLAN_FILE), "utf8")).phase).toBe("links-resolved");
    expect(() => resolveSitePageLinks({ root, site: built, baseurl: "/bridlewise", coordinates })).toThrow(/phase|already|links-resolved/u);
    expect(readFileSync(entry, "utf8")).toBe(html);
    expect(rewritePageLinks('[Docs](./)', { root, pageDocsPath: "docs/quickstart.md", plan, baseurl: "/bridlewise" }).text).toBe('[Docs](/bridlewise/docs/)');
    write(built, SITE_PLAN_FILE, JSON.stringify({ ...sitePlanProjection({ plan, baseurl: "/bridlewise" }), baseurl: "/wrong" }));
    expect(() => resolveSitePageLinks({ root, site: built, baseurl: "/bridlewise", coordinates })).toThrow(/^site-pages\.json does not describe deployment \/bridlewise$/u);
    expect(readFileSync(entry, "utf8")).toBe(html);
  });

  test("W5 projects the versions marker through real attributes, shell markup, text, JSON and code", () => {
    const root = routedRepository();
    write(root, "docs/floor/global.md", '---\ntitle: Global\n---\n[Versions]({{ site.versions_url }})\n\n`{{ site.versions_url }}`\n');
    for (const baseurl of ["/project", "/a&b", '/a"b', "/a</script>b"]) {
      const versionIndex = new URL(`${baseurl}/docs/v/`, coordinates.siteOrigin).pathname;
      const rendered = renderedFixture(root, coordinates, { "docs/floor/global.md": `<a href="${SITE_LINKS.versions}?lang=en#all">Versions</a><p>${SITE_LINKS.versions}</p><code>${SITE_LINKS.versions}</code><script type="application/json">{"versions":"${SITE_LINKS.versions}"}</script>` }, baseurl);
      const page = candidateSiteFiles(rendered.site, "/docs/floor/global/")[0];
      writeFileSync(page, readFileSync(page, "utf8").replace("<head>", `<head><link rel="alternate" href="${SITE_LINKS.versions}">`));
      // Generated versions markup has no authored-body boundary or source-token declaration.
      write(rendered.site, "docs/v/index.html", `<html><head></head><body><a href="${SITE_LINKS.versions}">Versions</a><p>${SITE_LINKS.versions}</p></body></html>`);
      expect(resolveSitePageLinks({ root, site: rendered.site, baseurl, coordinates }).rewritten).toBe(3);
      const html = readFileSync(page, "utf8");
      expect(siteDocumentLinks(html)).toContain(`${versionIndex}?lang=en#all`);
      expect(siteDocumentLinks(html)).toContain(versionIndex);
      const nodes: ReturnType<typeof parseSiteHtml>[] = [];
      const visit = (node: ReturnType<typeof parseSiteHtml>): void => {
        nodes.push(node);
        for (const child of node.childNodes ?? []) visit(child);
        if (node.content !== undefined) visit(node.content);
      };
      visit(parseSiteHtml(html));
      const text = (node: ReturnType<typeof parseSiteHtml>): string => (node.childNodes ?? []).map((child: ReturnType<typeof parseSiteHtml>) => child.value ?? "").join("");
      const scripts = nodes.filter((node) => node.tagName === "script");
      expect(scripts).toHaveLength(1);
      expect(scripts[0].attrs.find((attribute: { name: string; value: string }) => attribute.name === "type").value).toBe("application/json");
      expect(JSON.parse(text(scripts[0]))).toEqual({ versions: versionIndex });
      expect(text(nodes.find((node) => node.tagName === "p"))).toBe(versionIndex);
      expect(text(nodes.find((node) => node.tagName === "code"))).toBe(versionIndex);
      for (const file of [page, join(rendered.site, "docs/v/index.html")]) expect(readFileSync(file, "utf8")).not.toContain(SITE_LINK_PREFIX);
    }
  });

  test("W5 refuses unsupported deferred markers and authored marker forgery", () => {
    const root = routedRepository();
    for (const marker of [`${SITE_LINKS.versions}/extra`, `${SITE_LINK_PREFIX}unknown`]) {
      const rendered = renderedFixture(root, coordinates, { "docs/README.md": `<a href="${marker}">Unsupported</a>` }, "/project");
      expect(() => resolveSitePageLinks({ root, site: rendered.site, baseurl: "/project", coordinates })).toThrow(/unsupported builder link/u);
    }
    for (const body of [
      `<p>${SITE_LINK_PREFIX}unknown</p>`,
      `<code>${SITE_LINKS.versions}-unknown</code>`,
      `<script type="application/json">{"versions":"${SITE_LINKS.versions}/extra"}</script>`,
    ]) {
      const leftover = renderedFixture(root, coordinates, { "docs/README.md": body }, "/project");
      const entry = candidateSiteFiles(leftover.site, "/docs/")[0];
      const html = readFileSync(entry, "utf8");
      const manifest = readFileSync(join(leftover.site, SITE_PLAN_FILE), "utf8");
      expect(() => resolveSitePageLinks({ root, site: leftover.site, baseurl: "/project", coordinates })).toThrow(/unsupported builder link/u);
      expect(readFileSync(entry, "utf8")).toBe(html);
      expect(readFileSync(join(leftover.site, SITE_PLAN_FILE), "utf8")).toBe(manifest);
    }
    write(root, "docs/quickstart.md", `# Forgery\n\n<a href="${SITE_LINKS.versions}">Versions</a>\n`);
    expect(siteSourceViolations({ root, coordinates })).toEqual([expect.stringContaining("docs/quickstart.md: authored source contains a reserved builder link marker")]);
  });

  test("W5 resolves exact-file canonical pages including the live 404", () => {
    const root = routedRepository();
    write(root, "docs/404.md", "---\ntitle: Missing\n---\n[Docs](README.md)\n");
    write(root, "docs/file.md", "---\npermalink: /file.html\n---\n[Docs](README.md)\n");
    write(root, "docs/plain.md", "---\npermalink: /plain.md\n---\n[Docs](README.md)\n");
    write(root, "docs/_data/page-routes.json", JSON.stringify({ ...routes, livePages: { ...routes.livePages, "404.md": "/404.html" } }));
    const rendered = renderedFixture(root, coordinates, { "docs/404.md": '<a href="README.md">Docs</a>', "docs/file.md": '<a href="README.md">Docs</a>', "docs/plain.md": '<a href="README.md">Docs</a>' }, "/project");
    expect(resolveSitePageLinks({ root, site: rendered.site, baseurl: "/project", coordinates }).rewritten).toBe(3);
    for (const path of ["404.html", "docs/file.html", "docs/plain.md"]) expect(readFileSync(join(rendered.site, path), "utf8")).toContain('href="/project/docs/"');
    const missing = renderedFixture(root, coordinates, {}, "/project");
    write(missing.site, "docs/plain.md", '<html><body><a href="/project/docs/">Missing boundary</a></body></html>');
    expect(() => resolveSitePageLinks({ root, site: missing.site, baseurl: "/project", coordinates })).toThrow(/docs\/plain\.md: .*builder-owned authored-content boundary/u);
    expect(JSON.parse(readFileSync(join(missing.site, SITE_PLAN_FILE), "utf8")).phase).toBe("source");
  });

  test("W5 decodes source filenames and literal aliases once while preserving query and fragment", () => {
    const root = routedRepository();
    write(root, "docs/guide name.md", "# Guide\n");
    const encoded = renderedFixture(root, coordinates, { "docs/README.md": '<a href="guide%20name.md?q=%2f#details">Guide</a>' }, "/project");
    expect(resolveSitePageLinks({ root, site: encoded.site, baseurl: "/project", coordinates }).rewritten).toBe(1);
    expect(readFileSync(join(encoded.site, "docs/index.html"), "utf8")).toContain('href="/project/docs/guide name/?q=%2f#details"');
    for (const target of ["/project/docs/quickstart%2emd", "/project/docs/%2e/quickstart.md"]) {
      const literal = renderedFixture(root, coordinates, { "docs/README.md": `<a href="${target}">Literal</a>` }, "/project");
      expect(() => resolveSitePageLinks({ root, site: literal.site, baseurl: "/project", coordinates })).toThrow(/spells the page URL/u);
    }
    const escaped = renderedFixture(root, coordinates, { "docs/README.md": '<a href="%2e%2e/%2e%2e/outside.md">Outside</a>' }, "/project");
    expect(() => resolveSitePageLinks({ root, site: escaped.site, baseurl: "/project", coordinates })).toThrow(/leaves the repository/u);
  });

  test("W5 policy scopes use verified versions and explicit live-artifact capabilities", () => {
    const root = routedRepository();
    write(root, "src/demo/index.html", "<!doctype html><title>Artifact source</title>\n");
    write(root, "docs/_data/page-routes.json", JSON.stringify({ ...routes, artifacts: [{ sourceEntry: "src/demo/index.html", outputPath: "/demo/", connections: "none", surface: "cockpit" }] }));
    const policy = sitePolicyResolver({ root, coordinates, baseurl: "/project", versions: ["0.1.0"] });
    expect(policy("demo/index.html")).toEqual({ baseurl: "/project/demo", connections: "none", surface: "cockpit", cspRequired: true });
    expect(policy("/project/demo/")).toEqual(policy("demo/index.html"));
    expect(policy("docs/v/0.1.0/index.html")).toEqual({ baseurl: "/project/docs/v/0.1.0", connections: "site", surface: "site", cspRequired: true });
    expect(policy("docs/v/index.html").baseurl).toBe("/project");
    expect(() => policy("docs/v/9.9.9/index.html")).toThrow(/unverified documentation version 9\.9\.9/u);
    expect(() => policy("/project-sibling/demo/")).toThrow(/outside deployment/u);
    expect(() => sitePolicyResolver({ root, coordinates, baseurl: "/project" })("docs/v/0.1.0/index.html")).toThrow(/unverified documentation version 0\.1\.0/u);
    const plan = sitePlan({ root, coordinates, snapshot: true });
    expect(plan.pages.has("src/demo/index.html")).toBe(false);
    expect(plan.bySource.get("src/demo/index.html").output).toBe(false);
    expect(rewritePageLinks("[Demo](../src/demo/index.html)", { pageDocsPath: "docs/README.md", root, plan, baseurl: "/project/docs/v/0.1.0", liveBaseurl: "/project" }).text).toBe("[Demo](/project/demo/)");
  });

  test("W5 static artifact judging accepts the exact none policy and refuses the ordinary site policy", () => {
    const root = routedRepository();
    write(root, "src/demo/index.html", "<!doctype html><title>Artifact source</title>\n");
    write(root, "docs/_data/page-routes.json", JSON.stringify({ ...routes, artifacts: [{ sourceEntry: "src/demo/index.html", outputPath: "/demo/", connections: "none", surface: "cockpit" }] }));
    const page = (connections: "none" | "site") => {
      const [origin, scoped] = sitePolicies("/project/demo", { connections });
      return `<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${origin}"><meta http-equiv="Content-Security-Policy" content="${scoped}"></head><body>Artifact</body></html>`;
    };
    const built = site({ "demo/index.html": page("none") });
    expect(builtPolicyViolations({ root, siteRoot: built, baseurl: "/project", coordinates })).toEqual([]);
    write(built, "demo/index.html", page("site"));
    expect(builtPolicyViolations({ root, siteRoot: built, baseurl: "/project", coordinates })).toEqual([expect.stringContaining("demo/index.html does not carry the site's two policies")]);
  });

  test("W5 live artifact assembly builds fresh source at its declared mount and copies every asset", async () => {
    const root = routedRepository();
    write(root, "src/demo/index.html", "<!doctype html><title>Source</title>");
    write(root, "docs/_data/page-routes.json", JSON.stringify({ ...routes, artifacts: [{ sourceEntry: "src/demo/index.html", outputPath: "/demo/", connections: "none", surface: "cockpit" }] }));
    const built = site({ "index.html": "<!doctype html><title>Site</title>" });
    const outRoot = join(createTempDir("live-artifact-output-"), "fresh");
    const result = await assembleLiveArtifacts({ root, site: built, outRoot, baseurl: "/project", coordinates, statusFile: "same-source-status.json", builders: {
      "src/demo/index.html": async (options: { root: string; out: string; baseurl: string; statusFile: string }) => {
        expect(options.root).toBe(root);
        expect(options.baseurl).toBe("/project/demo");
        expect(options.statusFile).toBe("same-source-status.json");
        write(options.out, "index.html", '<!doctype html><script src="assets/app.js"></script>');
        write(options.out, "assets/app.js", "export {};\n");
        write(options.out, "assets/fonts/face.woff2", "fixture font");
        write(options.out, ".well-known/demo.json", '{"purpose":"served exception"}\n');
        write(options.out, "replay-manifest.json", '{"fixture":"owner-produced"}\n');
        return { out: options.out };
      },
    } });
    expect(result.artifacts).toEqual([{ sourceEntry: "src/demo/index.html", outputPath: "/demo/" }]);
    expect(readFileSync(join(built, "demo/assets/app.js"), "utf8")).toBe("export {};\n");
    expect(readFileSync(join(built, "demo/assets/fonts/face.woff2"), "utf8")).toBe("fixture font");
    expect(readFileSync(join(built, "demo/.well-known/demo.json"), "utf8")).toBe('{"purpose":"served exception"}\n');
    expect(readFileSync(join(built, "demo/replay-manifest.json"), "utf8")).toContain("owner-produced");
    expect(crawlSiteLinks({ siteRoot: built, baseurl: "/project" }).unresolved).toEqual([]);
    const snapshot = join(root, ".release-artifact");
    await source({ root, out: snapshot, coordinates, baseurl: "/project/docs/v/0.1.0", release: "0.1.0" });
    expect(existsSync(join(snapshot, "demo"))).toBe(false);
  });

  test.each(["assets/_virtual_bridlewise-public-replay.js", "assets/.hidden.js", "_modules/app.js", ".cache/app.js", ".well-known/_hidden.js"])("W5 live artifact admission refuses output Jekyll omits: %s", async (output) => {
    const root = routedRepository();
    write(root, "src/demo/index.html", "<!doctype html><title>Source</title>");
    write(root, "docs/_data/page-routes.json", JSON.stringify({ ...routes, artifacts: [{ sourceEntry: "src/demo/index.html", outputPath: "/demo/", connections: "none", surface: "cockpit" }] }));
    const originalSite = "<!doctype html><title>Existing site</title>";
    const built = site({ "index.html": originalSite });
    const outRoot = join(createTempDir("unserved-artifact-"), "fresh");
    await expect(assembleLiveArtifacts({ root, site: built, outRoot, baseurl: "/project", coordinates, builders: {
      "src/demo/index.html": async (options: { out: string }) => {
        write(options.out, "index.html", "<!doctype html><title>Artifact</title>");
        write(options.out, output, "export {};\n");
        return { out: options.out };
      },
    } })).rejects.toThrow(/contains output Jekyll will omit/u);
    expect(readFileSync(join(built, "index.html"), "utf8")).toBe(originalSite);
    expect(readFileSync(join(outRoot, "0", output), "utf8")).toBe("export {};\n");
  });

  test("W5 live artifact admission preserves existing work and refuses unknown builders or supplied bundles", async () => {
    const root = routedRepository();
    write(root, "src/demo/index.html", "<!doctype html><title>Source</title>");
    write(root, "docs/_data/page-routes.json", JSON.stringify({ ...routes, artifacts: [{ sourceEntry: "src/demo/index.html", outputPath: "/demo/", connections: "none", surface: "cockpit" }] }));
    const built = site({ "index.html": "<!doctype html><title>Site</title>" });
    const options = { root, site: built, baseurl: "/project", coordinates };
    const unknownOut = join(createTempDir("unknown-artifact-"), "fresh");
    await expect(assembleLiveArtifacts({ ...options, outRoot: unknownOut, builders: {} })).rejects.toThrow(/no trusted builder/u);
    expect(existsSync(unknownOut)).toBe(false);
    const supplied = site({ "index.html": "<!doctype html><title>Supplied bundle</title>" });
    await expect(assembleLiveArtifacts({ ...options, outRoot: join(createTempDir("supplied-artifact-"), "fresh"), builders: { "src/demo/index.html": async () => ({ out: supplied }) } })).rejects.toThrow(/uploaded bundle is not accepted/u);
    expect(existsSync(join(built, "demo"))).toBe(false);
    write(built, "demo/keep.txt", "existing work");
    const preservedOut = join(createTempDir("preserved-artifact-"), "fresh");
    await expect(assembleLiveArtifacts({ ...options, outRoot: preservedOut, builders: { "src/demo/index.html": async () => { throw new Error("must not run"); } } })).rejects.toThrow(/destination already exists/u);
    expect(existsSync(preservedOut)).toBe(false);
    expect(readFileSync(join(built, "demo/keep.txt"), "utf8")).toBe("existing work");
    await expect(assembleLiveArtifacts({ ...options, outRoot: join(root, "inside"), builders: {} })).rejects.toThrow(/outside the checkout/u);
  });
});

describe("F. the old-URL redirect site", () => {
  test("the old site is a whole URL from the identity: the owner's Pages host and the old base", () => {
    expect(legacySiteUrl({ owner: "Example-Org" })).toBe("https://example-org.github.io/bridlewise-testing/");
  });

  test("the landing map is one map per plan: an alias lands on its page, anything else on itself", () => {
    const plan = sitePlan({ coordinates: FIXTURE, root: repository() });
    expect(landingMap(plan)).toBe(landingMap(plan));
    expect(Object.isFrozen(landingMap(plan))).toBe(true);
    expect([...landingMap(plan)]).toEqual(legacyAliases(plan));
    expect(landingPath("/roadmap/", plan)).toBe("/floor/roadmap/");
    expect(landingPath("/floor/trackers/TASKS.md", plan)).toBe("/trackers/TASKS/");
    expect(landingPath("/floor/roadmap/", plan)).toBe("/floor/roadmap/");
    expect(landingPath("/never/", plan)).toBe("/never/");
  });

  test("a whole URL under the old site lands through the map, its query and fragment kept; anything else is not claimed", () => {
    const options = { from: FROM, to: TO, landing: { "/roadmap/": "/floor/roadmap/", "/quickstart/": "/docs/quickstart/", "/a&b'%3Cc%3E/": "/docs/odd/" } };
    expect(redirectTarget(`${FROM}roadmap/`, options)).toBe(`${TO}floor/roadmap/`);
    expect(redirectTarget(`${FROM}quickstart`, options)).toBe(`${TO}docs/quickstart/`);
    expect(redirectTarget(`${FROM}quickstart/?q=1#h`, options)).toBe(`${TO}docs/quickstart/?q=1#h`);
    expect(redirectTarget(`${FROM}a&b'%3Cc%3E/`, options)).toBe(`${TO}docs/odd/`);
    // The browser spells a path its own way (a raw `|`, lower-case escapes): the key is the map's `encodeURI` spelling.
    expect(redirectTarget(`${FROM}a&b'%3cc%3e/`, options)).toBe(`${TO}docs/odd/`);
    expect(redirectTarget(`${FROM}pipe|d/`, { ...options, landing: { [encodeURI("/pipe|d/")]: "/docs/pipe/" } })).toBe(`${TO}docs/pipe/`);
    expect(redirectTarget(`${FROM}assets/floor/floor.css`, options)).toBe(`${TO}assets/floor/floor.css`);
    expect(redirectTarget(FROM, options)).toBe(TO);
    expect(redirectTarget("https://llm-4-people.github.io/bridlewise-testing", options)).toBe(TO);
    // Near misses: a longer name sharing the prefix, another host with the same path, the host's root.
    expect(redirectTarget("https://llm-4-people.github.io/bridlewise-testingx/a", options)).toBeNull();
    expect(redirectTarget("https://other.github.io/bridlewise-testing/roadmap/", options)).toBeNull();
    expect(redirectTarget("https://llm-4-people.github.io/", options)).toBeNull();
  });

  test("the organisation's tree: one exact, script-free hop per old pretty path, the 404 fallback over the same map, .nojekyll", () => {
    const root = repository();
    const plan = sitePlan({ coordinates: FIXTURE, root });
    const out = join(createTempDir("site-redirect-"), "out");
    const result = buildRedirectSite({ coordinates: FIXTURE, root, out, from: FROM, to: TO });
    const relative = result.files.map((file: string) => file.slice(out.length + 1)).sort();
    expect(relative).toEqual([
      ".nojekyll", "404.html",
      "bridlewise-testing/decisions/index.html", "bridlewise-testing/floor/roadmap/index.html", "bridlewise-testing/floor/trackers/TASKS/index.html",
      "bridlewise-testing/index.html", "bridlewise-testing/product/index.html", "bridlewise-testing/roadmap/index.html", "bridlewise-testing/trackers/TASKS/index.html",
    ]);
    const hop = (file: string): string => {
      const html = readFileSync(join(out, file), "utf8");
      const canonical = /<link rel="canonical" href="([^"]+)">/u.exec(html)![1]!;
      expect(html).toContain(`<meta http-equiv="refresh" content="0; url=${canonical}">`);
      expect(html).toContain(`<a href="${canonical}">`);
      expect(html).not.toMatch(/<script[^>]+src=/u);
      let replaced: string | null = null;
      new Function("location", html.split("<script>")[1]!.split("</script>")[0]!)({ search: "?q=1", hash: "#h", replace: (url: string) => { replaced = url; } });
      expect(replaced).toBe(`${canonical}?q=1#h`);
      return canonical;
    };
    expect(hop("bridlewise-testing/index.html")).toBe(TO);
    expect(hop("bridlewise-testing/roadmap/index.html")).toBe(`${TO}floor/roadmap/`);
    expect(hop("bridlewise-testing/product/index.html")).toBe(TO);
    expect(hop("bridlewise-testing/floor/trackers/TASKS/index.html")).toBe(`${TO}trackers/TASKS/`);
    // ONE hop: every stub lands on a page the plan publishes, never on another alias.
    for (const file of relative.filter((name: string) => name.startsWith("bridlewise-testing/"))) {
      expect(plan.byPermalink.has(`/${hop(file).slice(TO.length)}`)).toBe(true);
    }
    const fallback = readFileSync(join(out, "404.html"), "utf8");
    expect(fallback).toContain('<meta name="robots" content="noindex">');
    expect(fallback).not.toContain('rel="canonical"');
    expect(fallback).not.toMatch(/<script[^>]+src=/u);
    const code = fallback.split("<script>\n")[1]!.split("</script>")[0]!;
    const visit = (href: string): string | null => {
      let target: string | null = null;
      new Function("location", code)({ href, replace: (url: string) => { target = url; } });
      return target;
    };
    expect(visit(`${FROM}floor/trackers/TASKS.md?q=1#h`)).toBe(`${TO}trackers/TASKS/?q=1#h`);
    expect(visit(`${FROM}roadmap`)).toBe(`${TO}floor/roadmap/`);
    expect(visit(`${FROM}assets/logo.png`)).toBe(`${TO}assets/logo.png`);
    expect(visit("https://llm-4-people.github.io/elsewhere/")).toBeNull();
    expect(readFileSync(join(out, ".nojekyll"), "utf8")).toBe("");
  });

  test("a landing path holding markup is escaped in the page and inert in the 404 script", () => {
    const root = repository({ "docs/odd.md": "---\npermalink: /a&b'<c>/\n---\n\n# Odd\n" });
    const out = join(createTempDir("site-redirect-"), "out");
    buildRedirectSite({ coordinates: FIXTURE, root, out, from: FROM, to: TO });
    const stub = readFileSync(join(out, "bridlewise-testing", "a&b'<c>", "index.html"), "utf8");
    expect(stub).toContain(`<link rel="canonical" href="${escapeHtml(`${TO}a&b'%3Cc%3E/`)}">`);
    expect(stub).not.toContain("<c>");
    // The `.md` spelling is no pretty path: the 404 script answers it, from a map that holds no raw `<`.
    const fallback = readFileSync(join(out, "404.html"), "utf8");
    expect(fallback).toContain(`"/a&b'%3Cc%3E.md":"/a&b'%3Cc%3E/"`);
    expect(fallback).not.toContain("<c>");
  });

  test("the loop guard compares whole URLs: a target that is the old site or under it refuses; the same path on another host does not", () => {
    const build = (to: string) => () => buildRedirectSite({ coordinates: FIXTURE, root: repository(), out: join(createTempDir("site-redirect-"), "out"), from: FROM, to });
    expect(build(FROM)).toThrow(/nothing to redirect until the repository is renamed/u);
    expect(build("https://llm-4-people.github.io/bridlewise-testing")).toThrow(/would loop/u);
    expect(build(`${FROM}docs/`)).toThrow(/would loop/u);
    expect(build("https://bridlewise.llm4people.dev/bridlewise-testing/")).not.toThrow();
    expect(build("https://llm-4-people.github.io/bridlewise/")).not.toThrow();
  });
});


describe("the shared site source footprint", () => {
  test("keeps all opened HTML, hidden/historical identities and catalog existence inputs without a second walker", () => {
    const root = repository({
      "docs/guide.md": "# Guide\n",
      "docs/hidden.md": "---\npublished: false\n---\n# Hidden\n",
      "docs/historical-hidden.md": "---\npublished: false\n---\n# Old page\n",
      "docs/plain.HTML": "<p>This is copied HTML, without front matter.</p>\n",
      "docs/published.html": "---\ntitle: HTML page\n---\n<p>Published</p>\n",
      "docs/_includes/not-opened.html": "<p>A layout include is not a page candidate.</p>\n",
      "web/catalog-entry.ts": "export {};\n",
      "docs/_data/page-routes.json": JSON.stringify({
        schemaVersion: "bridlewise-site-page-routes/v1", docsHome: "guide.md",
        livePages: { "index.md": "/", "declared-missing.md": "/declared-missing/" },
        artifacts: [{ sourceEntry: "web/catalog-entry.ts", outputPath: "/catalog-artifact/", connections: "none", surface: "cockpit" }],
      }),
      "docs/_data/site-url-history.json": JSON.stringify({
        schemaVersion: "bridlewise-site-url-history/v1",
        pages: { "docs/historical-hidden.md": "/old-hidden/", "docs/historical-missing.md": "/old-missing/" },
        aliases: { "/old-alias/": "/old-missing/" },
      }),
    });
    const plan = sitePlan({ root });
    for (const path of [
      "docs/_data/page-routes.json", "docs/_data/site-url-history.json",
      "docs/guide.md", "docs/hidden.md", "docs/plain.HTML", "docs/published.html", "web/catalog-entry.ts",
      "docs/declared-missing.md", "docs/historical-hidden.md", "docs/historical-missing.md",
    ]) expect(plan.inputs.has(path), `${path} is part of the observed source contract`).toBe(true);
    expect(plan.inputs.has("docs/_includes/not-opened.html")).toBe(false);
    expect(plan.pages.has("docs/plain.HTML")).toBe(false);
    expect(plan.pages.has("docs/published.html")).toBe(true);
    for (const path of ["docs/historical-hidden.md", "docs/historical-missing.md"]) {
      expect(plan.collisions.some((problem: string) => problem.includes(path) && problem.includes("no longer publishes"))).toBe(true);
    }
    expect(plan.collisions.some((problem: string) => problem.includes("declared-missing.md") && problem.includes("not a published page"))).toBe(true);
  });
});
