// @vitest-environment node
/**
 * THE FLOOR SITE'S LINK GUARD — unit proof for the resolver and the rewrite.
 *
 * The Pages workflow runs the crawler against the REAL built `_site` (after
 * Jekyll). These tests drive the same resolver over small Jekyll-shaped
 * fixtures, including the exact shape the published site shipped:
 *
 *   a floor page at `/floor/roadmap/` linked `../trackers/TASKS.md`
 *   → `/floor/trackers/TASKS.md`, and Jekyll builds nothing there.
 *
 * They also prove the assembly-time rewrite maps the SOURCE-relative link to
 * the pretty URL the plan publishes, and that a floor page naming a docs path
 * the plan does not publish is refused. Without these, the crawler could be
 * blind or the plan could stop copying a tree and the first red would be a
 * deploy.
 */
import { describe, expect, test } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { createTempDir } from "../helpers/temp-dir.ts";

// The site tooling is plain Node ESM (it runs from `node scripts/...` and has
// no build step). The test program checks the values it receives, not a
// duplicate declaration of the module's shape.
// @ts-expect-error -- a .mjs module has no declaration file in the TS program.
import { candidateSiteFiles, crawlSiteLinks, pageUrlForSitePath, resolveSiteHref } from "../../scripts/floor/site-links.mjs";
// @ts-expect-error -- a .mjs module has no declaration file in the TS program.
import { floorPageLinkViolations, materializeFloorFallbacks, materializeLegacyRedirects, materializePageFrontMatter, publishedDocsPage, rewriteCopiedDocsPages, rewritePageLinks } from "../../scripts/floor/site-pages.mjs";
import { configuredRepositoryIdentity } from "../../engine/src/workflow/forge/repository-identity.ts";

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

function testingTree(files: Readonly<Record<string, string>>): string {
  const root = createTempDir("floor-site-plan-");
  for (const [path, text] of Object.entries(files)) write(root, path, text);
  return root;
}

const BASE = "/bridlewise-testing";
/** The repository a non-published target links to: the one repository identity (the forge configuration). */
const REPOSITORY = configuredRepositoryIdentity().webUrl;

describe("A. the crawler resolves built pages, assets and external URLs", () => {
  test("a clean Jekyll-shaped fixture passes — pretty URLs, assets, relatives and externals", () => {
    const root = site({
      "index.html": [
        '<a href="/bridlewise-testing/floor/roadmap/">Roadmap</a>',
        '<a href="/bridlewise-testing/assets/floor/floor.css">CSS</a>',
        `<a href="${REPOSITORY}">GitHub</a>`,
        '<a href="#top">Top</a>',
        '<a href="mailto:hello@example.test">Mail</a>',
        '<p>An essay that quotes <code>href="/src/styles/tokens.css"</code> is not a link.</p>',
        "",
      ].join("\n"),
      "floor/roadmap/index.html": [
        '<link rel="stylesheet" href="/bridlewise-testing/assets/floor/floor.css">',
        '<a href="/bridlewise-testing/trackers/TASKS/">TASKS</a>',
        '<a href="../evidence/">Evidence</a>',
        '<script src="/bridlewise-testing/assets/floor/floor.js"></script>',
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
      "floor/roadmap/index.html": '<a href="/bridlewise-testing/floor/trackers/TASKS.md">TASKS</a>\n',
    });
    const rootResult = crawlSiteLinks({ siteRoot: rootRelative, baseurl: BASE });
    expect(rootResult.unresolved.map((entry: { resolved: string }) => entry.resolved)).toEqual(["/floor/trackers/TASKS.md"]);
  });

  test("a missing asset and a URL outside the base path both fail", () => {
    const root = site({
      "index.html": [
        '<img src="/bridlewise-testing/assets/floor/missing.png" alt="">',
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

describe("B. the assembly rewrite maps source-relative links to published site URLs", () => {
  test("roadmap links become pretty URLs, fragments ride along, and a repo file becomes its GitHub URL", () => {
    const testingRoot = testingTree({
      "docs/floor/roadmap.md": [
        "---",
        "permalink: /floor/roadmap/",
        "---",
        "",
        "[TASKS](../trackers/TASKS.md#done)",
        "[CLI](../cli.md#db-backupts)",
        "[guard](../../tests/prevention/guard.test.ts)",
        "[evidence](evidence.md)",
        "",
      ].join("\n"),
      "docs/floor/evidence.md": "---\npermalink: /floor/evidence/\n---\n\n# Evidence\n",
      "docs/trackers/TASKS.md": "# Tasks\n\n## Done\n",
      "docs/cli.md": "---\npermalink: /cli/\n---\n\n# CLI\n",
      "tests/prevention/guard.test.ts": "export {};\n",
    });
    const source = readFileSync(join(testingRoot, "docs/floor/roadmap.md"), "utf8");
    const result = rewritePageLinks(source, {
      pageDocsPath: "docs/floor/roadmap.md",
      testingRoot,
      productRoot: undefined,
      baseurl: BASE,
    });
    expect(result.rewritten).toBe(4);
    expect(result.text).toContain("(/bridlewise-testing/trackers/TASKS/#done)");
    expect(result.text).toContain("(/bridlewise-testing/cli/#db-backupts)");
    expect(result.text).toContain("(/bridlewise-testing/floor/evidence/)");
    expect(result.text).toContain(
      `(${REPOSITORY}/blob/main/tests/prevention/guard.test.ts)`,
    );
    // The committed file is not touched: GitHub keeps rendering its relative
    // links against the source tree.
    expect(readFileSync(join(testingRoot, "docs/floor/roadmap.md"), "utf8")).toBe(source);
  });

  test("the copied tree is rewritten in place and the trackers page is published", () => {
    const testingRoot = testingTree({
      "docs/floor/page.md": "---\npermalink: /floor/page/\n---\n\n[TASKS](../trackers/TASKS.md)\n",
      "docs/trackers/TASKS.md": "---\n---\n\n# Tasks\n",
    });
    const outRoot = createTempDir("floor-site-out-");
    const copied = rewriteCopiedDocsPages({
      outRoot,
      testingRoot,
      productRoot: undefined,
      baseurl: BASE,
    });
    // Nothing was copied into `outRoot`, so zero links moved; the positive
    // path below is the assembler test in tests/public/floor-data.test.mjs.
    expect(copied).toBe(0);
    expect(publishedDocsPage({ docsPath: "docs/trackers/TASKS.md", testingRoot })?.permalink).toBe(
      "/trackers/TASKS/",
    );
    expect(publishedDocsPage({ docsPath: "docs/trackers/TASKS.md", testingRoot })?.owner).toBe("testing");
  });
});

describe("C. a link to a docs path the plan does not publish is refused", () => {
  const testingRoot = () =>
    testingTree({
      "docs/floor/page.md": [
        "---",
        "permalink: /floor/page/",
        "---",
        "",
        "[process](../process/PROCESS.md)",
        "",
      ].join("\n"),
      "docs/process/PROCESS.md": "# Agent process\n",
    });

  test("the rewrite refuses at assembly time", () => {
    const root = testingRoot();
    expect(() =>
      rewritePageLinks("[process](../process/PROCESS.md)", {
        pageDocsPath: "docs/floor/page.md",
        testingRoot: root,
        productRoot: undefined,
        baseurl: BASE,
      }),
    ).toThrow(/targets docs\/process\/PROCESS\.md, which the floor site does not publish/u);
  });

  test("docs:links refuses in the normal test run", () => {
    const violations = floorPageLinkViolations({ testingRoot: testingRoot() });
    expect(violations).toEqual([
      { page: "docs/floor/page.md", target: "../process/PROCESS.md", docsPath: "docs/process/PROCESS.md" },
    ]);
  });

  test("a page marked published:false is not a publishable target", () => {
    const root = testingTree({
      "docs/floor/README.md": "---\npublished: false\n---\n\n# Notes\n",
    });
    expect(publishedDocsPage({ docsPath: "docs/floor/README.md", testingRoot: root })).toBeNull();
  });
});

describe("D. a product page the mirror lacks falls back to the testing page", () => {
  test("materializeFloorFallbacks copies only the missing top-level page and rewrite maps it", () => {
    const testingRoot = testingTree({
      "docs/floor/page.md": "---\npermalink: /floor/page/\n---\n\n[CLI](../cli.md)\n",
      "docs/cli.md": "---\npermalink: /cli/\n---\n\n# CLI\n",
    });
    const productRoot = createTempDir("floor-site-product-");
    const outRoot = createTempDir("floor-site-fallback-out-");
    write(outRoot, "floor/page.md", "[CLI](../cli.md)\n");

    const fallbacks = materializeFloorFallbacks({ outRoot, productRoot, testingRoot });
    expect(fallbacks).toEqual(["docs/cli.md"]);
    expect(readFileSync(join(outRoot, "cli.md"), "utf8")).toContain("# CLI");

    const moved = rewriteCopiedDocsPages({
      outRoot,
      testingRoot,
      productRoot,
      baseurl: BASE,
      fallbackPages: fallbacks,
    });
    expect(moved).toBe(1);
    expect(readFileSync(join(outRoot, "floor/page.md"), "utf8")).toContain("(/bridlewise-testing/cli/)");
    expect(readFileSync(join(outRoot, "cli.md"), "utf8")).toContain("# CLI");
  });

  test("a copied product fallback's process-document link goes to GitHub, not a 404", () => {
    const testingRoot = testingTree({
      "docs/testing.md": "---\npermalink: /testing/\n---\n\n[the evidence bar](process/PROCESS.md#evidence)\n",
      "docs/process/PROCESS.md": "# Agent process\n",
    });
    const result = rewritePageLinks(readFileSync(join(testingRoot, "docs/testing.md"), "utf8"), {
      pageDocsPath: "docs/testing.md",
      testingRoot,
      productRoot: undefined,
      baseurl: BASE,
      unpublishedDocs: "github",
    });
    expect(result.text).toContain(
      `(${REPOSITORY}/blob/main/docs/process/PROCESS.md#evidence)`,
    );
  });
});

describe("E. Jekyll needs front matter to publish a copied page", () => {
  test("a tracker page without front matter gets the plan's permalink; an existing header is untouched", () => {
    const outRoot = createTempDir("floor-site-frontmatter-");
    write(outRoot, "trackers/TASKS.md", "# Public floor tasks\n\n## Done\n");
    write(outRoot, "trackers/README.md", "---\npublished: false\n---\n\n# Notes\n");

    const added = materializePageFrontMatter({ outRoot });
    expect(added).toBe(1);
    const text = readFileSync(join(outRoot, "trackers/TASKS.md"), "utf8");
    expect(text.startsWith("---\nlayout: default\n")).toBe(true);
    expect(text).toContain("permalink: /trackers/TASKS/");
    expect(text.startsWith("---\nlayout: default\n")).toBe(true);
    expect(text, "a published page carries the same chrome as the floor pages").toContain(
      "floor_assets: true\npage_class: article\n",
    );
    expect(text).toContain("# Public floor tasks");
    expect(readFileSync(join(outRoot, "trackers/README.md"), "utf8")).toBe(
      "---\npublished: false\n---\n\n# Notes\n",
    );
  });

  test("an old URL shape is a real page that sends the browser to the published one", () => {
    const outRoot = createTempDir("floor-site-redirects-");
    write(outRoot, "trackers/TASKS.md", "# Public floor tasks\n");
    write(outRoot, "floor/roadmap.md", "# Build roadmap\n");
    materializeLegacyRedirects({ outRoot, baseurl: "/bridlewise-testing" });
    const tracker = readFileSync(join(outRoot, "floor/trackers/TASKS.md/index.html"), "utf8");
    // A real page through the site layout, not a bare HTML fragment: an old
    // link must not land on an unstyled line.
    expect(tracker.startsWith("---\nlayout: default\n")).toBe(true);
    expect(tracker).toContain("floor_assets: true");
    expect(tracker).toContain('class="callout-warning"');
    expect(tracker).toContain('location.replace("/bridlewise-testing/trackers/TASKS/")');
    expect(tracker).toContain('<a href="/bridlewise-testing/trackers/TASKS/">');
    // A copied file already sits at /floor/roadmap.md; the alias must not try
    // to take its name (the source keeps answering that spelling).
    expect(existsSync(join(outRoot, "floor/roadmap.md"))).toBe(true);
  });
});
