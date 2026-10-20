import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { coverage } from "../../scripts/floor/design-coverage.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("the roadmap emits the shared design contract", () => {
  const roadmap = readFileSync(join(ROOT, "docs/floor/roadmap.md"), "utf8");
  for (const name of ["roadmap-progress", "roadmap-count", "roadmap-chip", "roadmap-table", "roadmap-group", "roadmap-details", "roadmap-toc"]) {
    assert.match(roadmap, new RegExp(`class="[^"]*\\b${name}\\b`, "u"), `${name} must be emitted by the roadmap generator`);
  }
  const css = readFileSync(join(ROOT, "docs/assets/floor/floor.css"), "utf8");
  for (const selector of [".roadmap-progress", ".roadmap-count", ".roadmap-chip--shipped", ".roadmap-table--plan", ".roadmap-details", ".roadmap-toc"]) {
    assert.ok(css.includes(selector), `${selector} must be styled by floor.css`);
  }
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
});
