import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { isFile } from "./files.mjs";

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

  rmSync(outRoot, { recursive: true, force: true });
  copyTree(join(productRoot), outRoot, new Set(["_site", ".jekyll-cache", ".git", "node_modules"]));
  copyTree(join(testingRoot, "docs/floor"), join(outRoot, "floor"), new Set(["data"]));
  copyTree(join(testingRoot, "docs/assets/floor"), join(outRoot, "assets/floor"), new Set());

  // The testing site has its own front door. The product index is replaced by
  // the contributor hub, and the product documentation gets a landing page at
  // /product/. The rest of the product documentation stays at its original
  // paths so the mirrored internal links keep working.
  copyFileSync(join(testingRoot, "docs/index.md"), join(outRoot, "index.md"));
  copyFileSync(join(testingRoot, "docs/product.md"), join(outRoot, "product.md"));

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

