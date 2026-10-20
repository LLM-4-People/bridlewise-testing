import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildAtlas } from "../../scripts/floor/atlas.mjs";
import { assembleFloorSite } from "../../scripts/floor/site.mjs";
import { buildStatus } from "../../scripts/floor/status.mjs";

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

test("the site assembly sets the testing baseurl and overlays the floor without touching product pages", () => {
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
    writeFileSync(join(product, "_layouts/default.html"), "<!doctype html><html><body>{{ content }}</body></html>\n");
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
    assert.match(config, /testing_floor_url: "\/floor\/"/);
    assert.match(config, /floor_notice:/);
    assert.equal(readFileSync(join(out, "index.md"), "utf8"), "---\nlayout: default\ntitle: Home\npermalink: /\n---\n\n# Home\n");
    assert.ok(readFileSync(join(out, "floor/index.md"), "utf8").includes("The development floor"));
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
