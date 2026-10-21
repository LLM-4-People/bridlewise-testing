import { resolve } from "node:path";

import { assembleFloorSite } from "./floor/site.mjs";

function parseArgs(argv) {
  const out = { product: null, testing: process.cwd(), out: ".site", baseurl: "/bridlewise-testing" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--product") out.product = argv[++index];
    else if (arg === "--testing") out.testing = argv[++index];
    else if (arg === "--out") out.out = argv[++index];
    else if (arg === "--baseurl") out.baseurl = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!out.product) throw new Error("--product is required");
  return {
    product: resolve(out.product),
    testing: resolve(out.testing),
    out: resolve(out.out),
    baseurl: out.baseurl,
  };
}

try {
  const result = assembleFloorSite(parseArgs(process.argv.slice(2)));
  process.stdout.write(
    `floor site: ${result.productPages} Markdown files at ${result.baseurl}; ` +
      `${result.rewrittenLinks} relative link(s) resolved to site URLs; ` +
      `${result.redirectedPaths} legacy alias page(s)\n`,
  );
} catch (error) {
  process.stderr.write(`floor site failed: ${error.message}\n`);
  process.exitCode = 1;
}
