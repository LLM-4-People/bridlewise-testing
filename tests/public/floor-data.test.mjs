import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildAtlas, readInventory } from "../../scripts/floor/atlas.mjs";
import { parse } from "yaml";

import { buildSiteSource } from "../../scripts/floor/site.mjs";
import { buildStatus } from "../../scripts/floor/status.mjs";
import { memoryCredential } from "../../engine/src/workflow/forge/credentials.ts";
import { githubClient } from "../../engine/src/workflow/forge/github.ts";
import { fakeGithub } from "../../engine/test/forge/fake-github.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/** The repository the tree declares (package.json repository.url), the one source every URL comes from. */
const REPOSITORY = /github\.com\/([^/]+\/[^/.]+?)(?:\.git)?$/u.exec(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).repository.url)[1];
const BLOB = `https://github.com/${REPOSITORY}/blob/main/`;

function readJson(path) {
  return JSON.parse(readFileSync(join(ROOT, path), "utf8"));
}

test("the floor atlas reconciles its generated counts with tracked sources", () => {
  const atlas = buildAtlas({ root: ROOT });
  // The inventory is a cache of the tree, not committed (#221): its owner answers it.
  const inventory = readInventory(ROOT).data;
  const dispositions = readJson("engine/traceability/test-surface-dispositions.json");

  assert.equal(atlas.schemaVersion, "bridlewise-floor-atlas/v1");
  assert.equal(atlas.counts.testNames, inventory.tests.length);
  assert.equal(atlas.counts.engineSources, inventory.scope.canonicalNodeSourceIds.length);
  assert.equal(atlas.counts.dispositions, dispositions.entries.length);
  assert.equal(atlas.counts.testSources, atlas.tests.length);
  assert.equal(atlas.counts.guards, atlas.guards.length);
  assert.equal(atlas.counts.decisions, atlas.decisions.length);
  assert.equal(
    atlas.counts.testNames,
    atlas.tests.reduce((sum, entry) => sum + (entry.testCount ?? 0), 0),
  );
  assert.ok(atlas.tests.length > 0);
  assert.ok(atlas.guards.length > 0);
  assert.ok(atlas.decisions.length > 0);

  for (const entry of atlas.tests) {
    assert.ok(entry.url.startsWith(BLOB), `${entry.url} is a file of this repository (package.json repository.url)`);
    assert.ok(existsSync(join(ROOT, entry.url.slice(BLOB.length))), `${entry.url} names a file this tree holds`);
    assert.ok(entry.category);
    assert.ok(entry.disposition);
  }
  const serialized = JSON.stringify(atlas);
  assert.equal(serialized.includes(ROOT), false, "atlas must not leak an absolute checkout path");
});

test("the one site's source is this tree's docs/, with no second repository", async () => {
  const work = mkdtempSync(join(tmpdir(), "bridlewise-site-"));
  const out = join(work, "site");
  try {
    const result = await buildSiteSource({ root: ROOT, out, baseurl: "/bridlewise" });
    // Every coordinate the pages read is written from package.json, the one declaration.
    const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const repositoryUrl = manifest.repository.url.replace(/\.git$/u, "");
    const config = parse(readFileSync(join(out, "_config.yml"), "utf8"));
    assert.equal(config.baseurl, "/bridlewise");
    assert.equal(config.repository_url, repositoryUrl);
    assert.equal(config.security_url, `${repositoryUrl}/blob/main/SECURITY.md`);
    assert.equal(config.url, `https://${repositoryUrl.split("/")[3].toLowerCase()}.github.io`);
    const layout = readFileSync(join(out, "_layouts/default.html"), "utf8");
    assert.match(layout, /assets\/floor\/floor\.css/u);
    assert.match(layout, /assets\/floor\/floor\.js/u);
    assert.doesNotMatch(layout, /page\.floor_assets|floor_notice|testing_url|testing_hub_url/u, "one shell, one design layer, no mirror banner");
    // The front door leads with the product; the contributor hub and the floor are pages of the same site.
    assert.match(readFileSync(join(out, "index.md"), "utf8"), /permalink: \/\n/u);
    assert.match(readFileSync(join(out, "index.md"), "utf8"), /Every run, recorded/u);
    assert.match(readFileSync(join(out, "contribute.md"), "utf8"), /permalink: \/contribute\//u);
    assert.ok(readFileSync(join(out, "floor/index.md"), "utf8").includes("The development floor"));
    assert.ok(readFileSync(join(out, "assets/floor/floor.css"), "utf8").includes("floor-table-wrap"));
    assert.ok(readFileSync(join(out, ".well-known/security.txt"), "utf8").includes("Contact:"));
    // The trackers are plain Markdown; the build gives the copy its header.
    const tasks = readFileSync(join(out, "trackers/TASKS.md"), "utf8");
    assert.match(tasks, /^---\nlayout: "default"\n/u);
    assert.match(tasks, /permalink: "\/trackers\/TASKS\/"/u);
    assert.match(readFileSync(join(out, "floor/roadmap.md"), "utf8"), /\]\(\/bridlewise\/trackers\/TASKS\/\)/u);
    // The mirror landing is gone; its URL is a redirect to the front door.
    assert.equal(existsSync(join(out, "product.md")), false);
    assert.match(readFileSync(join(out, "product/index.html"), "utf8"), /<script src="moved\.js"><\/script>/u, "a moved page forwards through a file (no inline script under the policy)");
    assert.equal(readFileSync(join(out, "product/moved.js"), "utf8"), 'location.replace("/bridlewise/");\n');
    assert.ok(result.pages > 100);
    assert.deepEqual(result.versions, []);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("no site tool reads another repository or spells a repository name of its own", () => {
  for (const path of ["scripts/build-site.mjs", "scripts/build-floor-data.mjs", "scripts/floor/site.mjs", "scripts/floor/site-pages.mjs", "scripts/floor/atlas.mjs", "scripts/floor/status.mjs", "scripts/floor/deploy-order.mjs", "engine/src/workflow/forge/repository-reads.ts", "docs/_config.yml"]) {
    const text = readFileSync(join(ROOT, path), "utf8");
    assert.doesNotMatch(text, /--product|productRoot|LLM-4-People\//u, `${path} must take the repository from scripts/floor/repository.mjs`);
  }
});

test("the floor status never turns missing API data into a pass", async () => {
  const status = await buildStatus({
    root: ROOT,
    offline: true,
    now: new Date("2026-01-01T00:00:00.000Z"),
    counts: { testSources: 1 },
  });

  assert.equal(status.schemaVersion, "bridlewise-floor-status/v1");
  assert.equal(status.promotion.state, "unknown");
  assert.equal(status.github.available, false);
  assert.equal(status.generatedAt, "2026-01-01T00:00:00.000Z");
  assert.ok(status.checks.length > 0);
  assert.ok(status.checks.every((check) => check.status === "unknown"));
  assert.equal(status.checks.find((check) => check.id === "code_scanning").status, "unknown");
  assert.equal(status.promotion.lastRun, null);
  assert.equal(status.product.commit, null);
});


/**
 * A fake GitHub on the loopback upstream (the forge's own test double), so the
 * status drives the real forge client and outbound door. `answer(request)`
 * returns `{ status?, body, link? }` for every GET under `/repos/`; a `link`
 * names pages by their API path (`/repos/...?page=2`) and is served as GitHub
 * serves it.
 */
function forgeClient(answer) {
  const fake = fakeGithub();
  const requested = [];
  fake.route("GET", /^\/repos\//u, (request) => {
    requested.push(request.path);
    const { status = 200, body, link = null } = answer(request);
    return { status, body, headers: link === null ? {} : { link: link.replaceAll("<", `<${fake.apiUrl}`) } };
  });
  return { requested, client: githubClient(fake.endpoint(), memoryCredential("test", fake.userToken("test"))) };
}

test("the floor status reports the product branch of this repository", async () => {
  for (const [branch, commit, reason] of [
    [{ body: { commit: { sha: "abc123", commit: { committer: { date: "2026-01-01T00:00:00Z" } } } } }, "abc123", /not a release gate/u],
    [{ status: 404, body: { message: "Branch not found" } }, null, /refs\/heads\/product does not exist yet/u],
  ]) {
    const { requested, client } = forgeClient((request) => {
      if (request.path.includes("/branches/")) return branch;
      if (request.path.endsWith("/actions/runs")) return { body: { workflow_runs: [] } };
      return { body: [] };
    });
    const status = await buildStatus({ root: ROOT, client, maxPages: 5, now: new Date("2026-01-01T00:00:00.000Z") });
    assert.ok(requested.every((path) => path.startsWith(`/repos/${REPOSITORY}/`)), "one repository");
    assert.ok(requested.some((path) => path.endsWith("/branches/product")));
    assert.equal(status.product.ref, "refs/heads/product");
    assert.equal(status.product.commit, commit);
    assert.equal(status.promotion.profile, "main-to-product");
    assert.match(status.promotion.reason, reason);
  }
});

const lowAlert = (number) => ({ number, state: "open", rule: { security_severity_level: "low" } });

/** The status snapshot with `alerts` answering the code-scanning endpoint; every other endpoint answers empty. */
async function codeScanningCheck(alerts) {
  const { client } = forgeClient((request) => {
    if (request.path.endsWith("/code-scanning/alerts")) return alerts(request.query);
    if (request.path.endsWith("/actions/runs")) return { body: { workflow_runs: [] } };
    if (request.path.includes("/branches/")) return { body: { commit: { sha: "abc", commit: { committer: { date: null } } } } };
    return { body: [] };
  });
  const status = await buildStatus({ root: ROOT, client, maxPages: 5, now: new Date("2026-01-01T00:00:00.000Z") });
  return status.checks.find((entry) => entry.id === "code_scanning");
}

test("the status refuses a truncated alert population", async () => {
  // The probe declares ONE open alert; the list page returns 100. The page's
  // declared total and the number judged disagree, so nothing may certify
  // the population.
  const check = await codeScanningCheck((query) => (query.get("per_page") === "1" ? { body: [lowAlert(0)] } : { body: Array.from({ length: 100 }, (_, index) => lowAlert(index)) }));
  assert.equal(check.status, "unknown");
  assert.match(check.note, /incomplete: 100 of 1/u);
});

test("the status refuses an alert population with no completeness marker", async () => {
  // A server that ignores `per_page=1` and returns several alerts with no
  // Link header has declared no population: the total cannot be established.
  const check = await codeScanningCheck(() => ({ body: [lowAlert(1), lowAlert(2)] }));
  assert.equal(check.status, "unknown");
  assert.match(check.note, /no completeness marker/u);
});

test("the status follows pagination and accepts a complete declared population", async () => {
  const path = `/repos/${REPOSITORY}/code-scanning/alerts`;
  const link = (rel, page) => `<${path}?state=open&per_page=100&page=${page}>; rel="${rel}"`;
  const check = await codeScanningCheck((query) => {
    // 201 open alerts: the rel="last" page of a one-per-page probe is the declared total.
    if (query.get("per_page") === "1") return { body: [lowAlert(0)], link: `<${path}?state=open&per_page=1&page=201>; rel="last"` };
    if (query.get("page") === "1") return { body: Array.from({ length: 100 }, (_, index) => lowAlert(index)), link: `${link("next", 2)}, ${link("last", 3)}` };
    if (query.get("page") === "2") return { body: Array.from({ length: 100 }, (_, index) => lowAlert(100 + index)), link: `${link("next", 3)}, ${link("last", 3)}` };
    return { body: [lowAlert(200)] };
  });
  assert.equal(check.status, "pass");
  assert.equal(check.total, 201);
});
