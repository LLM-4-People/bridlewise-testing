import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildAtlas } from "../../scripts/floor/atlas.mjs";
import { assembleFloorSite } from "../../scripts/floor/site.mjs";
import { buildStatus } from "../../scripts/floor/status.mjs";
import { buildPromotionReceipt, verdictOutput } from "../../scripts/promotion-gate.mjs";
import { memoryCredential } from "../../engine/src/workflow/forge/credentials.ts";
import { githubClient } from "../../engine/src/workflow/forge/github.ts";
import { configuredRepositoryIdentity } from "../../engine/src/workflow/forge/repository-identity.ts";
import { fakeGithub } from "../../engine/test/forge/fake-github.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function readJson(path) {
  return JSON.parse(readFileSync(join(ROOT, path), "utf8"));
}

test("the floor atlas reconciles its generated counts with tracked sources", () => {
  const atlas = buildAtlas({ testingRoot: ROOT });
  const inventory = readJson("engine/traceability/s1-test-inventory.json");
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
    assert.ok(entry.url.startsWith(`${configuredRepositoryIdentity().webUrl}/blob/main/`), entry.url);
    assert.ok(entry.category);
    assert.ok(entry.disposition);
  }
  const serialized = JSON.stringify(atlas);
  assert.equal(serialized.includes(ROOT), false, "atlas must not leak an absolute checkout path");
});

test("the site assembly gives the testing floor its own front door", () => {
  const work = mkdtempSync(join(tmpdir(), "bridlewise-floor-"));
  const product = join(work, "product");
  const out = join(work, "site");
  try {
    mkdirSync(join(product, "_layouts"), { recursive: true });
    mkdirSync(join(product, ".well-known"), { recursive: true });
    writeFileSync(
      join(product, "_config.yml"),
      [
        "title: Fixture",
        "url: https://example.test",
        "baseurl: /old",
        "plugins:",
        "  - jekyll-relative-links",
        "include:",
        "  - .well-known",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(product, "_layouts/default.html"),
      [
        "<!doctype html><html><head>",
        "  {% if page.floor_assets %}",
        "  <link rel=\"stylesheet\" href=\"{{ '/assets/floor/floor.css' | relative_url }}\">",
        "  {% endif %}",
        "  {% if page.floor_assets %}<script src=\"{{ '/assets/floor/floor.js' | relative_url }}\" defer></script>{% endif %}",
        "</head><body>{{ content }}</body></html>",
        "",
      ].join("\n"),
    );
    writeFileSync(join(product, "index.md"), "---\nlayout: default\ntitle: Home\npermalink: /\n---\n\n# Home\n");
    writeFileSync(join(product, ".well-known/security.txt"), "Contact: https://example.test/security\n");

    const result = assembleFloorSite({
      product,
      testing: ROOT,
      out,
      baseurl: "/bridlewise-testing",
    });

    const config = readFileSync(join(out, "_config.yml"), "utf8");
    assert.match(config, /baseurl: "\/bridlewise-testing"/);
    const layout = readFileSync(join(out, "_layouts/default.html"), "utf8");
    assert.match(layout, /assets\/floor\/floor\.css/u);
    assert.match(layout, /assets\/floor\/floor\.js/u);
    assert.doesNotMatch(layout, /page\.floor_assets/u, "the assembled shell must load the shared layer unconditionally");
    assert.match(config, /testing_hub_url: "\/"/);
    assert.match(config, /testing_floor_url: "\/floor\/"/);
    assert.match(config, /floor_notice_url: "\/"/);
    assert.match(config, /floor_notice:/);
    const hub = readFileSync(join(out, "index.md"), "utf8");
    assert.match(hub, /title: "Build, test, and extend Bridlewise"/);
    assert.match(hub, /permalink: \//);
    assert.match(hub, /Build the harness/);
    assert.notEqual(hub, "---\nlayout: default\ntitle: Home\npermalink: /\n---\n\n# Home\n");
    assert.match(readFileSync(join(out, "product.md"), "utf8"), /Product documentation/);
    assert.ok(readFileSync(join(out, "floor/index.md"), "utf8").includes("The development floor"));
    assert.ok(readFileSync(join(out, "floor/help.md"), "utf8").includes("How to help"));
    assert.ok(readFileSync(join(out, "floor/roadmap.md"), "utf8").includes("Roadmap: build the floor"));
    assert.ok(readFileSync(join(out, "assets/floor/floor.css"), "utf8").includes("floor-table-wrap"));
    // Jekyll renders a page only when it has front matter; the tracker pages
    // are plain Markdown, so the assembler adds it to the copy.
    const tasks = readFileSync(join(out, "trackers/TASKS.md"), "utf8");
    assert.match(tasks, /^---\nlayout: default\n/u);
    assert.match(tasks, /permalink: \/trackers\/TASKS\//u);
    // The floor's own roadmap link was rewritten to the page the site builds.
    assert.match(
      readFileSync(join(out, "floor/roadmap.md"), "utf8"),
      /\[TASKS\]\(\/bridlewise-testing\/trackers\/TASKS\/\)/u,
    );
    assert.ok(readFileSync(join(out, ".well-known/security.txt"), "utf8").includes("Contact:"));
    assert.equal(result.baseurl, "/bridlewise-testing");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("the floor status never turns missing API data into a pass", async () => {
  const status = await buildStatus({
    testingRoot: ROOT,
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
  assert.equal(status.checks.find((check) => check.id === "testing.code_scanning").status, "unknown");
  assert.equal(status.promotion.lastRun, null);
});

/**
 * A fake GitHub on the loopback upstream (the forge's own test double), so the
 * gate drives the real forge client and outbound door. `answer(request)`
 * returns `{ body, link? }` for every GET; a `link` names pages by their API
 * path (`/repos/...?page=2`) and is served as GitHub serves it.
 */
function gateClient(answer) {
  const fake = fakeGithub();
  const requested = [];
  fake.route("GET", /^\/repos\//u, (request) => {
    requested.push(`${request.path}?${request.query.toString()}`);
    const { body, link = null } = answer(request);
    return { status: 200, body, headers: link === null ? {} : { link: link.replaceAll("<", `<${fake.apiUrl}`) } };
  });
  return { requested, client: githubClient(fake.endpoint(), memoryCredential("test", fake.userToken("test"))) };
}

function successfulWorkflowRuns(sha) {
  return ["CI", "CodeQL", "Docs links", "Secret scan"].map((name, index) => ({
    id: index + 1,
    name,
    path: `.github/workflows/${name.toLowerCase().replaceAll(" ", "-")}.yml`,
    event: "push",
    status: "completed",
    conclusion: "success",
    head_sha: sha,
    head_branch: "main",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:01:00Z",
    html_url: `https://github.com/LLM-4-People/bridlewise/actions/runs/${index + 1}`,
  }));
}

const lowAlert = (number) => ({ number, state: "open", rule: { security_severity_level: "low" } });

test("the promotion gate asks GitHub for runs at the requested commit", async () => {
  const sha = "a1cce5b3f96dec7db1a2a1f1d4aa08bf35ea8718";
  const { requested, client } = gateClient((request) => (request.path.endsWith("/actions/runs") ? { body: { workflow_runs: successfulWorkflowRuns(sha) } } : { body: [] }));
  const receipt = await buildPromotionReceipt({ product: "LLM-4-People/bridlewise", sha, tag: "dry-run", client, now: new Date("2026-01-01T00:02:00.000Z") });
  assert.equal(receipt.verdict, "pass");
  assert.deepEqual(receipt.blockers, []);
  assert.ok(requested.some((url) => url.includes("/actions/runs?") && url.includes(`head_sha=${sha}`)), "the run lookup must include the requested commit");
});

test("the promotion gate waits for a run that is still in progress", async () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  let runCalls = 0;
  let sleeps = 0;
  const names = ["CI", "CodeQL", "Docs links", "Secret scan"];
  const run = (name, status, conclusion) => ({ ...successfulWorkflowRuns(sha)[0], name, status, conclusion });
  const { client } = gateClient((request) => {
    if (!request.path.endsWith("/actions/runs")) return { body: [] };
    runCalls += 1;
    return { body: { workflow_runs: names.map((name) => (runCalls === 1 && name === "CI" ? run(name, "in_progress", null) : run(name, "completed", "success"))) } };
  });
  const receipt = await buildPromotionReceipt({
    product: "LLM-4-People/bridlewise", sha, tag: "dry-run", client, now: new Date("2026-01-01T00:02:00.000Z"), waitSeconds: 5,
    sleepImpl: async () => { sleeps += 1; },
  });
  assert.equal(receipt.verdict, "pass");
  assert.equal(runCalls, 2);
  assert.equal(sleeps, 1);
});

test("the promotion gate refuses a truncated alert population", async () => {
  const sha = "a1cce5b3f96dec7db1a2a1f1d4aa08bf35ea8718";
  const { client } = gateClient((request) => {
    if (request.path.endsWith("/actions/runs")) return { body: { workflow_runs: successfulWorkflowRuns(sha) } };
    if (request.path.endsWith("/code-scanning/alerts")) {
      // The probe declares ONE open alert; the list page returns 100. The
      // page's declared total and the number judged disagree, so nothing may
      // certify the population.
      return request.query.get("per_page") === "1" ? { body: [lowAlert(0)] } : { body: Array.from({ length: 100 }, (_, index) => lowAlert(index)) };
    }
    return { body: [] };
  });
  const receipt = await buildPromotionReceipt({ product: "LLM-4-People/bridlewise", sha, tag: "dry-run", client, now: new Date("2026-01-01T00:02:00.000Z") });
  assert.equal(receipt.verdict, "blocked");
  assert.deepEqual(receipt.blockers, ["product.code_scanning:unknown"]);
  const check = receipt.checks.find((entry) => entry.id === "product.code_scanning");
  assert.equal(check.complete, false);
  assert.equal(check.truncated, true);
  assert.equal(check.judged, 100);
  assert.equal(check.declaredTotal, 1);
  assert.match(check.note, /incomplete: 100 of 1/u);
  assert.equal(verdictOutput(receipt), "blocked:product.code_scanning:unknown");
});

test("the promotion gate refuses an alert population with no completeness marker", async () => {
  const sha = "a1cce5b3f96dec7db1a2a1f1d4aa08bf35ea8718";
  const { client } = gateClient((request) => {
    if (request.path.endsWith("/actions/runs")) return { body: { workflow_runs: successfulWorkflowRuns(sha) } };
    // A server that ignores `per_page=1` and returns several alerts with no
    // Link header has declared no population: the total cannot be established.
    if (request.path.endsWith("/code-scanning/alerts")) return { body: [lowAlert(1), lowAlert(2)] };
    return { body: [] };
  });
  const receipt = await buildPromotionReceipt({ product: "LLM-4-People/bridlewise", sha, tag: "dry-run", client, now: new Date("2026-01-01T00:02:00.000Z") });
  assert.equal(receipt.verdict, "blocked");
  const check = receipt.checks.find((entry) => entry.id === "product.code_scanning");
  assert.equal(check.complete, false);
  assert.equal(check.declaredTotal, null);
  assert.match(check.note, /no completeness marker/u);
});

test("the promotion gate follows pagination and accepts a complete declared population", async () => {
  const sha = "a1cce5b3f96dec7db1a2a1f1d4aa08bf35ea8718";
  const link = (rel, page) => `</repos/LLM-4-People/bridlewise/code-scanning/alerts?state=open&per_page=100&page=${page}>; rel="${rel}"`;
  const { client } = gateClient((request) => {
    if (request.path.endsWith("/actions/runs")) return { body: { workflow_runs: successfulWorkflowRuns(sha) } };
    if (!request.path.endsWith("/code-scanning/alerts")) return { body: [] };
    if (request.query.get("per_page") === "1") {
      // 201 open alerts: the rel="last" page of a one-per-page probe is the declared total.
      return { body: [lowAlert(0)], link: `</repos/LLM-4-People/bridlewise/code-scanning/alerts?state=open&per_page=1&page=201>; rel="last"` };
    }
    const page = request.query.get("page");
    if (page === "1") return { body: Array.from({ length: 100 }, (_, index) => lowAlert(index)), link: `${link("next", 2)}, ${link("last", 3)}` };
    if (page === "2") return { body: Array.from({ length: 100 }, (_, index) => lowAlert(100 + index)), link: `${link("next", 3)}, ${link("last", 3)}` };
    return { body: [lowAlert(200)] };
  });
  const receipt = await buildPromotionReceipt({ product: "LLM-4-People/bridlewise", sha, tag: "dry-run", client, now: new Date("2026-01-01T00:02:00.000Z") });
  assert.equal(receipt.verdict, "pass");
  assert.deepEqual(receipt.blockers, []);
  const check = receipt.checks.find((entry) => entry.id === "product.code_scanning");
  assert.equal(check.complete, true);
  assert.equal(check.declaredTotal, 201);
  assert.equal(check.judged, 201);
  assert.equal(check.total, 201);
});

test("the promotion receipt's workflow verdict output is never empty", () => {
  assert.equal(verdictOutput({ verdict: "pass", blockers: [] }), "allowed");
  assert.equal(verdictOutput({ verdict: "blocked", blockers: ["product.ci:fail"] }), "blocked:product.ci:fail");
  assert.equal(verdictOutput({ verdict: "blocked", blockers: ["a", "b"] }), "blocked:a+b");
  assert.equal(verdictOutput({ verdict: "blocked", blockers: [] }), "blocked:unknown");
  assert.equal(verdictOutput(undefined), "blocked:unknown");
});
