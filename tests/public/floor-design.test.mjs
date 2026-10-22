import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { coverage } from "../../scripts/floor/design-coverage.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("the roadmap is a page shell the renderer fills, styled by the floor layer alone", () => {
  const roadmap = readFileSync(join(ROOT, "docs/floor/roadmap.md"), "utf8");
  assert.match(roadmap, /^page_class: roadmap$/mu);
  assert.match(roadmap, /^<!-- BEGIN GENERATED AT PUBLISH: the roadmap/mu);
  assert.match(roadmap, /^<!-- END GENERATED AT PUBLISH: the roadmap -->$/mu);
  assert.doesNotMatch(roadmap, /ROADMAP-PLAN/u, "no hand-kept plan: the roadmap is the feed's");
  const css = readFileSync(join(ROOT, "docs/assets/floor/floor.css"), "utf8");
  assert.doesNotMatch(css, /\.roadmap-|\.rm-/u, "the roadmap's components are floor components, not a private vocabulary");
  assert.match(css, /\.floor-roadmap \{/u);
  assert.match(css, /--floor-space-4/u);
});

test("the coverage guard names a missing rule and an unused rule", () => {
  const work = mkdtempSync(join(tmpdir(), "bridlewise-design-"));
  try {
    mkdirSync(join(work, "assets/css"), { recursive: true });
    mkdirSync(join(work, "assets/floor"), { recursive: true });
    writeFileSync(join(work, "assets/css/style.css"), ".styled { color: red; }\n");
    writeFileSync(join(work, "assets/floor/floor.css"), ".unused-component { color: blue; }\n");
    writeFileSync(
      join(work, "index.html"),
      '<!doctype html><html><body><main id="main"><p class="styled missing-component">x</p></main></body></html>\n',
    );
    const result = coverage(work);
    assert.equal(result.pages, 1);
    assert.deepEqual([...result.missing.keys()], ["missing-component"]);
    assert.deepEqual([...result.unused.keys()], ["unused-component"]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("the built site passes the design coverage guard", (t) => {
  const built = join(ROOT, ".site/_site");
  let exists = true;
  try {
    readFileSync(join(built, "index.html"));
  } catch {
    exists = false;
  }
  if (!exists) {
    t.skip("run node scripts/assemble-floor-site.mjs and the Jekyll build first");
    return;
  }
  const result = coverage(built);
  assert.ok(result.pages >= 150, `expected the full site, found ${result.pages} pages`);
  assert.equal(result.missing.size, 0, `unstyled content classes: ${[...result.missing.keys()].join(", ")}`);
  assert.equal(result.unused.size, 0, `unused floor.css rules: ${[...result.unused.keys()].join(", ")}`);

  const roadmap = readFileSync(join(built, "floor/roadmap/index.html"), "utf8");
  assert.doesNotMatch(roadmap, /<p>\|\s/u, "every generated Markdown table must render as a table, not paragraph text");
  const focusStart = roadmap.indexOf('id="now--next--later"');
  assert.ok(focusStart > 0, "the Now / next / later heading must exist");
  const focus = roadmap.slice(focusStart);
  const tableStart = focus.indexOf("<table>");
  const tableEnd = focus.indexOf("</table>");
  assert.ok(tableStart >= 0 && tableEnd > tableStart, "the Now / next / later section must contain a table");
  const table = focus.slice(tableStart, tableEnd);
  assert.equal((table.match(/<th>/gu) ?? []).length, 6, "the Now / next / later table must have six columns");
});
