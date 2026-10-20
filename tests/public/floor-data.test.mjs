import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildAtlas } from "../../scripts/floor/atlas.mjs";
import { assembleFloorSite } from "../../scripts/floor/site.mjs";
import { buildStatus } from "../../scripts/floor/status.mjs";
import { buildPromotionReceipt } from "../../scripts/promotion-gate.mjs";

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
    assert.match(entry.url, /^https:\/\/github\.com\/LLM-4-People\/bridlewise-testing\/blob\/main\//);
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

test("the promotion gate asks GitHub for runs at the requested commit", async () => {
  const sha = "a1cce5b3f96dec7db1a2a1f1d4aa08bf35ea8718";
  const requested = [];
  const workflowRuns = ["CI", "CodeQL", "Docs links", "Secret scan"].map((name, index) => ({
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
  const response = (body) => ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => "",
  });
  const fetchImpl = async (url) => {
    requested.push(String(url));
    if (String(url).includes("/actions/runs")) {
      return response({ workflow_runs: workflowRuns });
    }
    return response([]);
  };

  const receipt = await buildPromotionReceipt({
    product: "LLM-4-People/bridlewise",
    sha,
    tag: "dry-run",
    token: "test-token",
    fetchImpl,
    now: new Date("2026-01-01T00:02:00.000Z"),
  });

  assert.equal(receipt.verdict, "pass");
  assert.deepEqual(receipt.blockers, []);
  assert.ok(
    requested.some((url) => url.includes("/actions/runs?head_sha=") && url.includes(sha)),
    "the run lookup must include the requested commit",
  );
});

test("the promotion gate waits for a run that is still in progress", async () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  let runCalls = 0;
  let sleeps = 0;
  const response = (body) => ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => "",
  });
  const run = (status, conclusion) => ({
    id: 1,
    name: "CI",
    path: ".github/workflows/ci.yml",
    event: "push",
    status,
    conclusion,
    head_sha: sha,
    head_branch: "main",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:01:00Z",
    html_url: "https://github.com/LLM-4-People/bridlewise/actions/runs/1",
  });
  const names = ["CI", "CodeQL", "Docs links", "Secret scan"];
  const fetchImpl = async (url) => {
    if (String(url).includes("/actions/runs")) {
      runCalls += 1;
      if (runCalls === 1) {
        return response({
          workflow_runs: names.map((name) =>
            name === "CI" ? { ...run("in_progress", null), name } : { ...run("completed", "success"), name },
          ),
        });
      }
      return response({
        workflow_runs: names.map((name) => ({ ...run("completed", "success"), name })),
      });
    }
    return response([]);
  };

  const receipt = await buildPromotionReceipt({
    product: "LLM-4-People/bridlewise",
    sha,
    tag: "dry-run",
    token: "test-token",
    fetchImpl,
    now: new Date("2026-01-01T00:02:00.000Z"),
    waitSeconds: 5,
    sleepImpl: async () => {
      sleeps += 1;
    },
  });

  assert.equal(receipt.verdict, "pass");
  assert.equal(runCalls, 2);
  assert.equal(sleeps, 1);
});
