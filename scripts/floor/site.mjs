import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { isFile } from "./files.mjs";
import {
  FLOOR_COPY_ROOTS,
  FLOOR_OVERLAY_PAGES,
  materializeFloorFallbacks,
  materializeLegacyRedirects,
  materializePageFrontMatter,
  rewriteCopiedDocsPages,
} from "./site-pages.mjs";

const REQUIRED_PRODUCT = [
  "_config.yml",
  "_layouts/default.html",
  "index.md",
];
const REQUIRED_FLOOR = [
  "docs/index.md",
  "docs/product.md",
  "docs/floor/index.md",
  "docs/floor/help.md",
  "docs/floor/roadmap.md",
  "docs/floor/atlas.md",
  "docs/floor/status.md",
  "docs/assets/floor/floor.css",
  "docs/assets/floor/floor.js",
];

function fail(message) {
  throw new Error(message);
}

function ensure(condition, message) {
  if (!condition) fail(message);
}

function copyTree(source, destination, skipNames) {
  mkdirSync(destination, { recursive: true });
  cpSync(source, destination, {
    recursive: true,
    filter: (from) => {
      const name = from.split(/[\\/]/).pop();
      return !skipNames.has(name);
    },
  });
}

function setYaml(text, key, value) {
  const line = `${key}: ${JSON.stringify(value)}`;
  const pattern = new RegExp(`^${key}:.*$`, "m");
  if (pattern.test(text)) return text.replace(pattern, line);
  return `${text.replace(/\s*$/, "")}\n${line}\n`;
}

export function assembleFloorSite({ product, testing, out, baseurl = "/bridlewise-testing" }) {
  const productRoot = resolve(product);
  const testingRoot = resolve(testing);
  const outRoot = resolve(out);
  ensure(existsSync(productRoot), `product docs root does not exist: ${productRoot}`);
  ensure(existsSync(testingRoot), `testing root does not exist: ${testingRoot}`);
  for (const path of REQUIRED_PRODUCT) {
    ensure(isFile(join(productRoot, path)), `product docs is missing ${path}`);
  }
  for (const path of REQUIRED_FLOOR) {
    ensure(isFile(join(testingRoot, path)), `testing floor is missing ${path}`);
  }
  // The pages a floor page may link to are the ones this plan publishes. The
  // product mirror provides `/cli/`, `/extending/` and `/index/`; a missing
  // one is copied from the testing checkout below as a self-contained
  // fallback, so the links are never left pointing at a page Jekyll will not
  // build.
  for (const { docsRoot } of FLOOR_COPY_ROOTS) {
    ensure(existsSync(join(testingRoot, ...docsRoot.split("/"))), `testing floor is missing ${docsRoot}/`);
  }

  rmSync(outRoot, { recursive: true, force: true });
  copyTree(join(productRoot), outRoot, new Set(["_site", ".jekyll-cache", ".git", "node_modules"]));
  for (const { docsRoot, siteRoot } of FLOOR_COPY_ROOTS) {
    copyTree(
      join(testingRoot, ...docsRoot.split("/")),
      join(outRoot, ...siteRoot.split("/")),
      new Set(["data"]),
    );
  }
  copyTree(join(testingRoot, "docs/assets/floor"), join(outRoot, "assets/floor"), new Set());

  // One shell, one design layer. The product layout conditionally loaded the
  // floor stylesheet per page; the assembled site always loads it, so no page
  // can opt out of the shared component rules and tokens.
  const layoutPath = join(outRoot, "_layouts/default.html");
  let layout = readFileSync(layoutPath, "utf8");
  const conditionalCss = `{% if page.floor_assets %}
  <link rel="stylesheet" href="{{ '/assets/floor/floor.css' | relative_url }}">
  {% endif %}`;
  const sharedCss = `<link rel="stylesheet" href="{{ '/assets/floor/floor.css' | relative_url }}">`;
  if (layout.includes(conditionalCss)) {
    layout = layout.replace(conditionalCss, sharedCss);
  } else if (!layout.includes("/assets/floor/floor.css")) {
    fail("the product shell has no shared floor stylesheet hook");
  }
  const conditionalJs = `{% if page.floor_assets %}<script src="{{ '/assets/floor/floor.js' | relative_url }}" defer></script>{% endif %}`;
  const sharedJs = `<script src="{{ '/assets/floor/floor.js' | relative_url }}" defer></script>`;
  if (layout.includes(conditionalJs)) {
    layout = layout.replace(conditionalJs, sharedJs);
  } else if (!layout.includes("/assets/floor/floor.js")) {
    fail("the product shell has no shared floor script hook");
  }
  writeFileSync(layoutPath, layout);

  // The testing site has its own front door. The product index is replaced by
  // the contributor hub, and the product documentation gets a landing page at
  // /product/. The rest of the product documentation stays at its original
  // paths so the mirrored internal links keep working.
  for (const { docsPath, sitePath } of FLOOR_OVERLAY_PAGES) {
    copyFileSync(
      join(testingRoot, ...docsPath.split("/")),
      join(outRoot, ...sitePath.split("/")),
    );
  }

  // A floor page may name a top-level product page the product mirror does not
  // carry (the plan says `/cli/` and `/extending/` are mirrored today). Copy
  // the self-contained testing fallback rather than shipping the link to a
  // page Jekyll never builds.
  const fallbackPages = materializeFloorFallbacks({ outRoot, productRoot, testingRoot });

  // A tracker page is plain Markdown; without front matter Jekyll copies it as
  // a static file and never builds the pretty URL the floor links to. Give the
  // assembled copy a page header (the source keeps rendering on GitHub).
  const frontMatterPages = materializePageFrontMatter({ outRoot, fallbackPages });

  // GitHub resolves a floor page's relative links against the SOURCE tree; the
  // site resolves them against the pretty URL, which is a different directory.
  // Rewrite only the assembled copy to the URLs the site actually publishes,
  // so the committed Markdown keeps working on GitHub.
  // The older URL shapes get static pages; a redirect header alone depends on
  // a plugin this build does not load.
  const redirectedPaths = materializeLegacyRedirects({ outRoot, baseurl, fallbackPages });

  const rewrittenLinks = rewriteCopiedDocsPages({
    outRoot,
    productRoot,
    testingRoot,
    baseurl,
    fallbackPages,
  });

  const configPath = join(outRoot, "_config.yml");
  let config = readFileSync(configPath, "utf8");
  config = setYaml(config, "baseurl", baseurl);
  config = setYaml(config, "testing_hub_url", "/");
  config = setYaml(config, "testing_floor_url", "/floor/");
  config = setYaml(config, "floor_notice_url", "/");
  config = setYaml(
    config,
    "floor_notice",
    "The contributor hub is at the site root. The complete product documentation is mirrored here. The product site remains the public copy.",
  );
  writeFileSync(configPath, config);

  const robotsPath = join(outRoot, "robots.txt");
  if (existsSync(robotsPath)) {
    const base = `https://llm-4-people.github.io${baseurl.replace(/\/$/, "")}/`;
    const robots = readFileSync(robotsPath, "utf8").replace(
      "https://llm-4-people.github.io/bridlewise/",
      base,
    );
    writeFileSync(robotsPath, robots);
  }

  const floorData = join(outRoot, "floor/data");
  mkdirSync(floorData, { recursive: true });

  return {
    out: outRoot,
    baseurl,
    productPages: countMarkdown(join(outRoot)),
    floorPages: countMarkdown(join(outRoot, "floor")),
    rewrittenLinks,
    redirectedPaths,
    frontMatterPages,
  };
}

function countMarkdown(root) {
  let total = 0;
  const visit = (directory) => {
    const entries = readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) visit(join(directory, entry.name));
      else if (entry.isFile() && entry.name.endsWith(".md")) total += 1;
    }
  };
  visit(root);
  return total;
}

