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
 * not serve), that a link naming nothing and two pages for one URL are
 * refused in two places (the builder and docs:links), and that a released
 * snapshot merges only as a whole, verified site. Without these, the crawler
 * could be blind or the plan could drift and the first red would be a deploy.
 */
import { describe, expect, test } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
import { legacyAliases, prettyPermalink, publishedDocsPage, rewritePageLinks, siteSourceViolations, sitePlan } from "../../scripts/floor/site-pages.mjs";
import { sitePolicies } from "../../shared/site-page.ts";
// @ts-expect-error -- a .mjs module has no declaration file in the TS program.
import { buildRedirectSite, buildSiteSource, finishSite, readVersions, redirectTarget } from "../../scripts/floor/site.mjs";
// @ts-expect-error -- a .mjs module has no declaration file in the TS program.
import { checkSiteLinks } from "../../scripts/check-docs-links.mjs";
// @ts-expect-error -- a .mjs module has no declaration file in the TS program.
import { siteCoordinates } from "../../scripts/floor/repository.mjs";
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
    const home = rewritePageLinks(readFileSync(join(root, "docs/index.md"), "utf8"), { pageDocsPath: "docs/index.md", root, baseurl: "/bridlewise", plan });
    expect(home.text).toContain("[Engine](https://github.com/Example-Org/site-repo/blob/main/engine/x.ts)");
    expect(publishedDocsPage({ docsPath: "docs/hidden.md", root, plan })).toBeNull();
  });

  test("a link naming nothing is refused in two places; a link in a code fence is text", async () => {
    const root = repository({
      "docs/floor/broken.md": "# Broken\n\n[gone](../missing.md)\n",
      "docs/decisions/D-1.md": "---\nid: D-1\n---\n\n[out](../../../outside.md) and [script](../../scripts/none.mjs)\n",
    });
    const violations = siteSourceViolations({ coordinates: FIXTURE, root });
    expect(violations).toEqual([
      expect.stringContaining("docs/decisions/D-1.md: link '../../../outside.md' leaves the repository"),
      expect.stringContaining("docs/decisions/D-1.md: link '../../scripts/none.mjs' names scripts/none.mjs"),
      expect.stringContaining("docs/floor/broken.md: link '../missing.md' names docs/missing.md"),
    ]);
    await expect(source({ root, out: join(root, ".site"), baseurl: "/bridlewise" })).rejects.toThrow(/the site source refuses \(3\)/u);
    // The fenced example `[not a link](does-not-exist.md)` in TASKS.md is not judged.
    expect(siteSourceViolations({ coordinates: FIXTURE, root: repository() })).toEqual([]);
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
    expect(readFileSync(join(out, "floor/roadmap.md"), "utf8")).toMatch(/^---\ntitle: Roadmap\npermalink: \/floor\/roadmap\/\n---/u);
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
      versions_url: "/bridlewise-next/v/",
      release_version: "",
      plugins: ["jekyll-sitemap"],
    });
    // The served markup owner is the owner's own code, types stripped.
    const markup = readFileSync(join(out, "assets/js/markup.js"), "utf8");
    expect(markup).toMatch(/^\/\/ GENERATED from shared\/markup\.ts/u);
    expect(markup).toContain("export function escapeHtml(text");
    expect(markup).not.toMatch(/:\s*string\)/u);
    expect(readFileSync(join(out, "v/index.md"), "utf8")).toContain("No release has been published yet.");
    expect(JSON.parse(readFileSync(join(out, "versions.json"), "utf8"))).toEqual({ current: "main", versions: [] });
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
    expect(moved).toContain('<script src="moved.js"></script>');
    expect(readFileSync(join(out, "floor/trackers/TASKS.md/moved.js"), "utf8")).toBe('location.replace("/bridlewise/trackers/TASKS/");\n');
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
    expect(parse(config)).toMatchObject({ versions_url: "/bridlewise/v/", release_version: "0.2.0" });
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
function policied(body: string, base = "/bridlewise"): string {
  const [origin, scoped] = sitePolicies(base);
  return `<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${origin}"><meta http-equiv="Content-Security-Policy" content="${scoped}"><link rel="stylesheet" href="/bridlewise/assets/css/style.css"></head><body><main id="main" class="wrap article">${body}</main></body></html>\n`;
}

/** A built site as Jekyll would leave it for `buildSiteSource` with `versions`. */
function builtSite(versions: readonly string[], pages: Readonly<Record<string, string>> = {}): string {
  const page = (body: string): string => policied(body);
  return site({
    "index.html": page('<p class="lede">Home</p><a href="/bridlewise/v/">Versions</a>'),
    "v/index.html": page(versions.map((version) => `<a href="/bridlewise/v/${version}/">${version}</a>`).join("")),
    "versions.json": JSON.stringify({ current: "main", versions: versions.map((version) => ({ version, path: `/v/${version}/` })) }),
    "assets/css/style.css": ".lede{} .wrap{} .article{}\n",
    "assets/floor/floor.css": "body{}\n",
    ...pages,
  });
}

/** A released snapshot folder: `<dir>/<version>/` built for `/bridlewise/v/<version>`. */
function snapshots(entries: Readonly<Record<string, Readonly<Record<string, string>>>>): string {
  const root = createTempDir("site-versions-");
  for (const [version, files] of Object.entries(entries)) for (const [path, text] of Object.entries(files)) write(root, `${version}/${path}`, text);
  return root;
}

describe("E. the finish step: released snapshots merge whole, then the whole site is judged", () => {
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

  test("a snapshot merges at /v/<version>/ and its links are crawled with the rest", () => {
    const dir = snapshots({ "0.1.0": { "index.html": policied('<a href="/bridlewise/v/0.1.0/quickstart/">Quickstart</a><a href="/bridlewise/v/">Other versions</a>', "/bridlewise/v/0.1.0"), "quickstart/index.html": policied('<a href="../">Back</a>', "/bridlewise/v/0.1.0") } });
    const siteRoot = builtSite(["0.1.0"]);
    const result = finishSite({ site: siteRoot, baseurl: "/bridlewise", versionsDir: dir });
    expect(result.versions).toEqual(["0.1.0"]);
    expect(existsSync(join(siteRoot, "v/0.1.0/quickstart/index.html"))).toBe(true);
    // The snapshot is judged for links but not against today's stylesheets.
    expect(result.designPages).toBe(2);
  });

  test("a snapshot link that 404s on the merged site is refused", () => {
    const dir = snapshots({ "0.1.0": { "index.html": '<a href="/bridlewise/v/0.1.0/missing/">Gone</a>' } });
    expect(() => finishSite({ site: builtSite(["0.1.0"]), baseurl: "/bridlewise", versionsDir: dir })).toThrow(/link: v\/0\.1\.0\/index\.html: \/bridlewise\/v\/0\.1\.0\/missing\//u);
  });

  test("a snapshot never overwrites a page, and the folder must hold only built versions", () => {
    const collide = snapshots({ "0.1.0": { "index.html": "x" } });
    expect(() => finishSite({ site: builtSite(["0.1.0"], { "v/0.1.0/index.html": "page" }), baseurl: "/bridlewise", versionsDir: collide })).toThrow(/already holds \/v\/0\.1\.0\//u);
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

  test("a relative_url link into the versions folder is refused; site.versions_url is the one way", () => {
    const root = repository({
      "docs/floor/a.md": "---\ntitle: A\n---\n\n<a href=\"{{ '/v/' | relative_url }}\">Versions</a>\n",
      "docs/floor/b.md": "---\ntitle: B\n---\n\n[1.0]({{ \"/v/1.0.0/\" | relative_url }}) · [list]({{ '/versions.json' | relative_url }})\n",
    });
    expect(siteSourceViolations({ coordinates: FIXTURE, root }).map((line: string) => line.split(": ")[0])).toEqual(["docs/floor/a.md:5", "docs/floor/b.md:5", "docs/floor/b.md:5"]);
    // Every other spelling of the same link (the review's five), each in its own page.
    const forms = {
      "docs/floor/c.md": "{{ site.baseurl }}/v/",
      "docs/floor/d.md": "{{ '/v/' | absolute_url }}",
      "docs/floor/e.md": "{{ '/v/' | append: '' | relative_url }}",
      "docs/floor/f.md": "{{ '/v/' | prepend: site.baseurl }}",
      "docs/g.md": "../v/",
      "docs/floor/h.md": "{{ site.url }}{{ site.baseurl }}/versions.json",
    };
    const planted = repository(Object.fromEntries(Object.entries(forms).map(([path, href]) => [path, `---\ntitle: P\n---\n\n<a href="${href}">Versions</a>\n`])));
    expect(siteSourceViolations({ coordinates: FIXTURE, root: planted }).filter((line: string) => line.includes("versions folder")).map((line: string) => line.split(":")[0])).toEqual(Object.keys(forms).sort((a, b) => a.localeCompare(b)));
    expect(siteSourceViolations({ coordinates: FIXTURE, root: repository({
      "docs/floor/c.md": "---\ntitle: C\n---\n\n[versions]({{ site.versions_url }}) · [very]({{ '/very/' | relative_url }}) · [vision]({{ '/vision/' | relative_url }}) · <a href=\"../vision/\">v</a>\n\n```html\n<a href=\"{{ '/v/' | relative_url }}\">quoted in a fence</a>\n```\n",
      "docs/very.md": "# Very\n",
      "docs/vision.md": "# Vision\n",
    }) })).toEqual([]);
  });

  test("the source config cannot declare a builder-owned key, and must read as YAML", async () => {
    const build = (config: string) => {
      const root = repository({ "docs/_config.yml": config });
      return source({ root, out: join(root, ".site"), baseurl: "/b" });
    };
    await expect(build("title: Fixture\nbaseurl: /old\nrepository_url: https://example.test\n")).rejects.toThrow(/declares baseurl, repository_url, which the builder writes/u);
    await expect(build("title: Fixture\nversions_url: /v/\n")).rejects.toThrow(/declares versions_url/u);
    await expect(build("title: A\ntitle: B\n")).rejects.toThrow(/_config\.yml is unreadable/u);
    // Near miss: a page front matter or a nested key of the same name is not the site's key.
    await expect(build("title: Fixture\ndefaults:\n  - values:\n      url: /x\n")).resolves.toBeDefined();
  });

  test("this repository's own tree passes, and builds as a WHOLE release snapshot: its floor data, and the live versions page", async () => {
    expect(siteSourceViolations({ coordinates: FIXTURE, root: REAL_ROOT })).toEqual([]);
    const out = join(createTempDir("site-release-"), "src");
    // The build itself refuses a snapshot whose pages name a path it does not build.
    await buildSiteSource({ root: REAL_ROOT, out, baseurl: "/bridlewise/v/0.1.0", release: "0.1.0" });
    expect(parse(readFileSync(join(out, "_config.yml"), "utf8"))).toMatchObject({ versions_url: "/bridlewise/v/", release_version: "0.1.0" });
    expect(existsSync(join(out, "v"))).toBe(false);
    // The floor pages' data is in the snapshot (the review's probe: without it every later deploy refused).
    expect(JSON.parse(readFileSync(join(out, "floor/data/atlas.json"), "utf8")).schemaVersion).toBe("bridlewise-floor-atlas/v1");
    expect(JSON.parse(readFileSync(join(out, "floor/data/status.json"), "utf8")).schemaVersion).toBe("bridlewise-floor-status/v1");
  });

  test("a build refuses a page that names a path it does not build, and says which build", async () => {
    // Planted in a page and in the layout; the snapshot names itself.
    const root = repository({
      "docs/floor/a.md": "---\ntitle: A\n---\n\n<div data-src=\"x\"></div><a href=\"{{ '/floor/data/other.json' | relative_url }}\">data</a>\n",
      "docs/_layouts/default.html": "<html><body><a href=\"{{ site.baseurl }}/nowhere/\">x</a>{{ content }}</body></html>\n",
    });
    await expect(source({ root, out: join(root, ".release"), baseurl: "/b/v/0.3.0", release: "0.3.0" })).rejects.toThrow(/2 site link\(s\) name a path this release 0\.3\.0 snapshot does not build:\n  _layouts\/default\.html: \/nowhere\/\n  floor\/a\.md: \/floor\/data\/other\.json|2 site link\(s\) name a path this release 0\.3\.0 snapshot does not build:\n  floor\/a\.md: \/floor\/data\/other\.json\n  _layouts\/default\.html: \/nowhere\//u);
    // Near misses: the floor data, a served asset, a page, a redirect and the sitemap Jekyll writes all exist.
    await expect(source({ root: repository({
      "docs/floor/b.md": "---\ntitle: B\n---\n\n<a href=\"{{ '/floor/data/status.json' | relative_url }}\">s</a> <a href=\"{{ '/assets/logo.png' | relative_url }}\">l</a> <a href=\"{{ '/floor/roadmap/' | relative_url }}\">r</a> <a href=\"{{ '/product/' | relative_url }}\">p</a> <a href=\"{{ site.baseurl }}/sitemap.xml\">m</a>\n",
    }), out: join(createTempDir("site-near-"), "src"), baseurl: "/b" })).resolves.toBeDefined();
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

const RENAMED = "https://llm-4-people.github.io/bridlewise/";

describe("F. the old-URL redirect site", () => {
  test("every old path maps to the same path under the current site; anything else is not claimed", () => {
    const to = { to: RENAMED };
    expect(redirectTarget("/bridlewise-testing/", to)).toBe("https://llm-4-people.github.io/bridlewise/");
    expect(redirectTarget("/bridlewise-testing", to)).toBe("https://llm-4-people.github.io/bridlewise/");
    expect(redirectTarget("/bridlewise-testing/floor/roadmap/", to)).toBe("https://llm-4-people.github.io/bridlewise/floor/roadmap/");
    expect(redirectTarget("/bridlewise-testing/assets/floor/floor.css", to)).toBe("https://llm-4-people.github.io/bridlewise/assets/floor/floor.css");
    // Near misses: a longer name sharing the prefix, the new base, the root.
    expect(redirectTarget("/bridlewise-testingx/a", to)).toBeNull();
    expect(redirectTarget("/bridlewise/floor/", to)).toBeNull();
    expect(redirectTarget("/", to)).toBeNull();
  });

  test("the built pages run that same mapping and show the destination without scripts", () => {
    const out = join(createTempDir("site-redirect-"), "out");
    const result = buildRedirectSite({ out, to: RENAMED });
    expect(result.files.map((file: string) => file.slice(out.length))).toEqual(["/bridlewise-testing/index.html", "/404.html"]);
    for (const file of result.files) {
      const html = readFileSync(file, "utf8");
      expect(html).toContain('<a href="https://llm-4-people.github.io/bridlewise/">');
      expect(html).not.toMatch(/<script[^>]+src=/u);
      const code = html.split("<script>\n")[1]!.split("</script>")[0]!;
      const visit = (pathname: string): string | null => {
        let target: string | null = null;
        new Function("location", code)({ pathname, search: "?q=1", hash: "#h", replace: (url: string) => { target = url; } });
        return target;
      };
      expect(visit("/bridlewise-testing/floor/atlas/")).toBe("https://llm-4-people.github.io/bridlewise/floor/atlas/?q=1#h");
      expect(visit("/elsewhere/")).toBeNull();
    }
  });

  test("before the rename the old base IS the site: building the redirect refuses (it would loop)", () => {
    expect(() => buildRedirectSite({ out: join(createTempDir("site-redirect-"), "out"), to: "https://llm-4-people.github.io/bridlewise-testing/" })).toThrow(/nothing to redirect until the repository is renamed/u);
  });
});
