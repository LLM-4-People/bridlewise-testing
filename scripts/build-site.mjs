#!/usr/bin/env node
/**
 * The one site builder's command (the steps are `scripts/floor/site.mjs`):
 *
 *   node scripts/build-site.mjs source   --out .site --baseurl <base> [--versions <dir>]
 *   node scripts/build-site.mjs source   --out .site --baseurl <base>/v/<version> --release <version>
 *   (Jekyll: .site → _site)
 *   node scripts/build-site.mjs finish   --site _site --baseurl <base> [--versions <dir>]
 *   node scripts/build-site.mjs redirect --out <dir>   (the organisation site's tree for the old base)
 *
 * `--versions <dir>` is the folder of released docs snapshots
 * (`<dir>/<version>/index.html`, each a verified release asset); both steps
 * take the same folder. Every `source` build writes the floor data from the
 * tree (offline); the Pages workflow refreshes the live status online with
 * `build-floor-data.mjs`. `--release <version>` builds that release's
 * snapshot WHOLE, floor data included (at release time, from the release's
 * source commit; Jekyll then builds it and the release attaches the result as
 * its docs-site asset), and refuses a page naming a path the snapshot does
 * not build. Run from the repository root.
 */
import { buildRedirectSite, buildSiteSource, finishSite } from "./floor/site.mjs";

const USAGE = "usage: build-site.mjs source --out <dir> --baseurl <base> [--versions <dir> | --release <version>] | finish --site <dir> --baseurl <base> [--versions <dir>] | redirect --out <dir>";
const FLAGS = { source: ["--out", "--baseurl", "--versions", "--release"], finish: ["--site", "--baseurl", "--versions"], redirect: ["--out"] };
const REQUIRED = { source: ["--out", "--baseurl"], finish: ["--site", "--baseurl"], redirect: ["--out"] };

function parseArgs(argv) {
  const [verb, ...rest] = argv;
  if (!(verb in FLAGS)) throw new Error(USAGE);
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!FLAGS[verb].includes(flag) || value === undefined || value.startsWith("--")) throw new Error(`${flag ?? ""}: ${USAGE}`);
    options[flag] = value;
  }
  for (const flag of REQUIRED[verb]) if (options[flag] === undefined) throw new Error(`${verb} needs ${flag}: ${USAGE}`);
  return { verb, options };
}

async function run({ verb, options }) {
  const versionsDir = options["--versions"] ?? null;
  if (verb === "source") {
    const result = await buildSiteSource({ root: process.cwd(), out: options["--out"], baseurl: options["--baseurl"], versionsDir, release: options["--release"] ?? null });
    return `${result.release === null ? "site source" : `release ${result.release} snapshot source`}: ${result.pages} page(s) at ${result.baseurl}; ${result.rewrittenLinks} link(s) resolved; ${result.frontMatterPages} plain page(s) given a header; ${result.redirectedPaths} redirect page(s); ${result.versions.length} released version(s)`;
  }
  if (verb === "finish") {
    const result = finishSite({ site: options["--site"], baseurl: options["--baseurl"], versionsDir });
    return `site: clean (${result.pages} page(s), ${result.links} internal link(s), ${result.designPages} design-judged page(s), ${result.versions.length} released version(s))`;
  }
  const result = buildRedirectSite({ root: process.cwd(), out: options["--out"] });
  return `redirect site: ${result.from} → ${result.to} (${result.files.length} file(s) in ${result.out})`;
}

try {
  process.stdout.write(`${await run(parseArgs(process.argv.slice(2)))}\n`);
} catch (error) {
  process.stderr.write(`build-site failed: ${error.message}\n`);
  process.exitCode = 1;
}
