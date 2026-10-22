import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { buildAtlas } from "./floor/atlas.mjs";
import { stableJson } from "./floor/files.mjs";
import { buildStatus } from "./floor/status.mjs";
import { configuredForge, configuredForgeClient } from "../engine/src/workflow/forge/configured-forge.ts";
import { environmentCredential } from "../engine/src/workflow/forge/credentials.ts";

function parseArgs(argv) {
  const out = {
    root: process.cwd(),
    out: null,
    offline: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") out.root = argv[++index];
    else if (arg === "--out") out.out = argv[++index];
    else if (arg === "--offline") out.offline = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!out.out) throw new Error("--out is required");
  return {
    root: resolve(out.root),
    out: resolve(out.out),
    offline: out.offline,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.out)) mkdirSync(args.out, { recursive: true });
  const atlas = buildAtlas({ root: args.root });
  const status = await buildStatus({
    root: args.root,
    // The credential is the workflow's token in GH_TOKEN, read at call time, never an argument.
    client: args.offline ? null : configuredForgeClient(environmentCredential("floor:GH_TOKEN", "GH_TOKEN")),
    maxPages: args.offline ? null : configuredForge().request.maxPages,
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
