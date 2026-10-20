import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { buildAtlas } from "./floor/atlas.mjs";
import { stableJson } from "./floor/files.mjs";
import { buildStatus } from "./floor/status.mjs";

function parseArgs(argv) {
  const out = {
    testing: process.cwd(),
    product: null,
    out: null,
    offline: false,
    token: process.env.GH_TOKEN || null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--testing") out.testing = argv[++index];
    else if (arg === "--product") out.product = argv[++index];
    else if (arg === "--out") out.out = argv[++index];
    else if (arg === "--offline") out.offline = true;
    else if (arg === "--token") out.token = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!out.out) throw new Error("--out is required");
  return {
    testing: resolve(out.testing),
    product: out.product ? resolve(out.product) : null,
    out: resolve(out.out),
    offline: out.offline,
    token: out.token,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.out)) mkdirSync(args.out, { recursive: true });
  const atlas = buildAtlas({
    testingRoot: args.testing,
    productRoot: args.product,
  });
  const status = await buildStatus({
    testingRoot: args.testing,
    productRoot: args.product,
    token: args.token,
    offline: args.offline,
    counts: atlas.counts,
  });
  writeFileSync(join(args.out, "atlas.json"), stableJson(atlas));
  writeFileSync(join(args.out, "status.json"), stableJson(status));
  process.stdout.write(
    `floor data: ${atlas.counts.testSources} surfaces, ${atlas.counts.guards} guards, ` +
      `${atlas.counts.decisions} decisions, promotion ${status.promotion.state}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`floor data failed: ${error.message}\n`);
  process.exitCode = 1;
});
