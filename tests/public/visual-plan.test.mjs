// The visual regression plan (scripts/visual/plan.ts): the matrix, the shot
// names and the gate, each refusal planted. What a page must hold is the
// rendered table's (scripts/rendered/rules.ts).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

import { gate, PAGES, shotName, shots, THEMES, VIEWPORTS } from "../../scripts/visual/plan.ts";
import { SITE_THEME_STORAGE as THEME_STORAGE } from "../../shared/site-page.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("the matrix covers every key page in both themes at desktop, tablet and phone widths, one name per shot", () => {
  assert.deepEqual([...THEMES], ["logbook", "carbon"]);
  assert.deepEqual(VIEWPORTS.map((v) => v.width), [1440, 768, 390]);
  const all = shots();
  assert.equal(all.length, PAGES.length * THEMES.length * VIEWPORTS.length);
  const names = all.map(shotName);
  assert.equal(new Set(names).size, names.length, "every shot has its own file");
  assert.equal(shotName({ page: "/", theme: "logbook", viewport: VIEWPORTS[0] }), "home--logbook--desktop.png");
  assert.equal(shotName({ page: "/floor/status/", theme: "carbon", viewport: VIEWPORTS[2] }), "floor-status--carbon--phone.png");
});

test("the theme the shots choose is the one the site's own script reads", () => {
  const script = readFileSync(join(ROOT, "docs/assets/js/site.js"), "utf8");
  // The pre-paint theme is a file the layout loads in its head (the page's policy runs no inline script).
  const prePaint = readFileSync(join(ROOT, "docs/assets/js/theme.js"), "utf8");
  assert.ok(script.includes(`"${THEME_STORAGE.key}"`) && prePaint.includes(`"${THEME_STORAGE.key}"`));
  assert.ok(prePaint.includes(`=== "${THEME_STORAGE.carbon}"`));
  assert.match(readFileSync(join(ROOT, "docs/_layouts/default.html"), "utf8"), /<script src="\{\{ '\/assets\/js\/theme\.js' \| relative_url \}\}"><\/script>/u);
});

const shot = (name, verdict) => ({ name, verdict, changedPixels: verdict === "changed" ? 10 : 0, totalPixels: verdict === "changed" ? 100 : 0 });

test("the gate: unchanged passes; a change passes only when declared; an unstable shot always refuses", () => {
  assert.deepEqual(gate([shot("a", "same"), shot("b", "same")], { changeDeclared: false }), { pass: true, reasons: [] });
  for (const verdict of ["changed", "added", "removed"]) {
    const undeclared = gate([shot("a", "same"), shot("b", verdict)], { changeDeclared: false });
    assert.equal(undeclared.pass, false, verdict);
    assert.match(undeclared.reasons[0], /visual-change/u);
    assert.equal(gate([shot("b", verdict)], { changeDeclared: true }).pass, true, `${verdict}, declared`);
  }
  const unstable = gate([shot("a", "unstable")], { changeDeclared: true });
  assert.equal(unstable.pass, false);
  assert.match(unstable.reasons[0], /nondeterministic/u);
});

test("the Pages workflow runs the check on every pull request and merge group, and the label is the declaration", () => {
  const workflow = parse(readFileSync(join(ROOT, ".github/workflows/pages.yml"), "utf8"));
  const job = workflow.jobs.visual;
  assert.ok(job, "the visual job exists");
  assert.match(job.if, /pull_request/u);
  assert.match(job.if, /merge_group/u);
  const runs = job.steps.map((step) => step.run ?? "").join("\n");
  assert.match(runs, /node scripts\/visual\/screens\.ts --base _visual\/base --head _visual\/head/u);
  assert.match(runs, /"visual-change"/u);
  assert.match(runs, /visual_base_unbuildable/u, "an unbuildable base is a typed refusal, never a skipped comparison");
  assert.doesNotMatch(runs, /build-floor-data/u, "no live floor snapshot enters a picture: each source step writes its own offline one");
});
