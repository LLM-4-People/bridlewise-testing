#!/usr/bin/env node
/**
 * The one site builder's command (the steps are `scripts/floor/site.mjs`):
 *
 *   node scripts/build-site.mjs source   --out .site --baseurl <base> [--versions <dir>]
 *   node scripts/build-site.mjs source   --out .site --baseurl <base>/docs/v/<version> --release <version>
 *   (Jekyll: .site → _site)
 *   node scripts/build-site.mjs resolve  --site _site --baseurl <base>/docs/v/<version> --release <version>
 *   node scripts/build-site.mjs finish   --site _site --baseurl <base> [--versions <dir>]
 *   node scripts/build-site.mjs redirect --out <dir>   (the organisation site's tree for the old base)
 *   node scripts/build-site.mjs capture-urls [--out <file>] (before changing page placement)
 *
 * `--versions <dir>` is the folder of released docs snapshots
 * (`<dir>/<version>/index.html`, each a verified release asset); both steps
 * take the same folder. Declared live artifacts are built once from their
 * trusted source producer after source validation, then copied by Jekyll.
 * Every `source` build writes the floor data from the
 * tree (offline); the Pages workflow refreshes the live status online with
 * `build-floor-data.mjs`. `--release <version>` builds that release's
 * documentation-only snapshot, floor data and local assets included (at release time, from the release's
 * source commit; Jekyll then builds it and the release attaches the result as
 * its docs-site asset), and refuses a page naming a path the snapshot does
 * not build. Run from the repository root.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOwnedTemporaryDirectory, removeOwnedTemporaryDirectory } from "../engine/src/filesystem/private-state.ts";
import { assembleLiveArtifacts, buildRedirectSite, buildSiteSource, finishSite, resolveSitePageLinks } from "./floor/site.mjs";
import { captureSiteUrls } from "./floor/site-pages.mjs";

const USAGE = "usage: build-site.mjs source --out <new dir> --baseurl <base> [--versions <dir> | --release <version>] | resolve --site <dir> --baseurl <base> [--release <version>] | finish --site <dir> --baseurl <base> [--versions <dir>] | redirect --out <new dir> | capture-urls [--out <new file>]";
const FLAGS = { source: ["--out", "--baseurl", "--versions", "--release"], resolve: ["--site", "--baseurl", "--release"], finish: ["--site", "--baseurl", "--versions"], redirect: ["--out"], "capture-urls": ["--out"] };
const REQUIRED = { source: ["--out", "--baseurl"], resolve: ["--site", "--baseurl"], finish: ["--site", "--baseurl"], redirect: ["--out"], "capture-urls": [] };

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
  if (verb === "capture-urls") {
    const result = captureSiteUrls({ root: process.cwd(), out: options["--out"] });
    return `URL history: ${result.pages} page(s), ${result.aliases} alias(es) captured in ${result.out}`;
  }
  const versionsDir = options["--versions"] ?? null;
  if (verb === "resolve") {
    const result = resolveSitePageLinks({ root: process.cwd(), site: options["--site"], baseurl: options["--baseurl"], release: options["--release"] ?? null });
    return `rendered links: ${result.pages} page(s), ${result.rewritten} source-relative link(s) resolved; publication checks remain in finish`;
  }
  if (verb === "source") {
    const result = await buildSiteSource({ root: process.cwd(), out: options["--out"], baseurl: options["--baseurl"], versionsDir, release: options["--release"] ?? null });
    // One source build owns every declared production artifact. Jekyll
    // copies its front-matter-free HTML and assets without another build.
    // Only load the trusted builder when this plan actually declares one.
    if (result.artifacts.length > 0) {
      const { PUBLIC_REPLAY_BUILDERS } = await import("./build-demo.ts");
      const temporary = createOwnedTemporaryDirectory(tmpdir(), "bridlewise-site-artifacts-");
      try {
        await assembleLiveArtifacts({ root: process.cwd(), site: result.out, outRoot: join(temporary, "fresh"), baseurl: options["--baseurl"], builders: PUBLIC_REPLAY_BUILDERS, statusFile: join(result.out, "floor/data/status.json") });
      } finally {
        removeOwnedTemporaryDirectory(temporary);
      }
    }
    return `${result.release === null ? "site source" : `release ${result.release} snapshot source`}: ${result.pages} page(s) at ${result.baseurl}; ${result.rewrittenLinks} plain-text link(s) projected; page links resolve after Jekyll; ${result.frontMatterPages} plain page(s) given a header; ${result.redirectedPaths} redirect page(s); ${result.artifacts.length} live artifact(s); ${result.versions.length} released version(s)`;
  }
  if (verb === "finish") {
    const result = finishSite({ root: process.cwd(), site: options["--site"], baseurl: options["--baseurl"], versionsDir });
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
