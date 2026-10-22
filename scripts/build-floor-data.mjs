import { resolve } from "node:path";

import { buildAtlas } from "./floor/atlas.mjs";
import { writeFloorData } from "./floor/site.mjs";
import { buildStatus } from "./floor/status.mjs";
import { configuredForgeClient } from "../engine/src/workflow/forge/configured-forge.ts";
import { environmentCredential } from "../engine/src/workflow/forge/credentials.ts";

function parseArgs(argv) {
  const out = {
    root: process.cwd(),
    site: null,
    offline: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") out.root = argv[++index];
    else if (arg === "--site") out.site = argv[++index];
    else if (arg === "--offline") out.offline = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!out.site) throw new Error("--site is required (the assembled site source: its floor/data and the claims judged against it are written there)");
  return {
    root: resolve(out.root),
    site: resolve(out.site),
    offline: out.offline,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const atlas = buildAtlas({ root: args.root });
  const status = await buildStatus({
    root: args.root,
    // The credential is the workflow's token in GH_TOKEN, read at call time, never an argument.
    client: args.offline ? null : configuredForgeClient(environmentCredential("floor:GH_TOKEN", "GH_TOKEN")),
    offline: args.offline,
    counts: atlas.counts,
  });
  writeFloorData({ root: args.root, site: args.site, atlas, status });
  process.stdout.write(
    `floor data: ${atlas.counts.testSources} surfaces, ${atlas.counts.guards} guards, ` +
      `${atlas.counts.decisions} decisions, promotion ${status.promotion.state}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`floor data failed: ${error.message}\n`);
  process.exitCode = 1;
});
