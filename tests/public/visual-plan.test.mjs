// The visual regression plan (scripts/visual/plan.ts): the matrix, the shot
// names, the invariants every shot holds, and the gate, each refusal planted.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

import { gate, invariantViolations, LAYOUT_SHIFT_BUDGET, PAGES, shotName, shots, THEMES, THEME_STORAGE, VIEWPORTS } from "../../scripts/visual/plan.ts";

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
  const layout = readFileSync(join(ROOT, "docs/_layouts/default.html"), "utf8");
  assert.ok(script.includes(`"${THEME_STORAGE.key}"`) && layout.includes(`"${THEME_STORAGE.key}"`));
  assert.ok(layout.includes(`=== "${THEME_STORAGE.carbon}"`));
});

const sound = { scrollWidth: 390, viewportWidth: 390, layoutShift: 0, fontsLoaded: ["IBM Plex Sans Variable", "IBM Plex Mono Variable"], imagesWithoutAlt: 0, mains: 1, h1s: 1 };

test("a sound page passes; each broken invariant is named", () => {
  assert.deepEqual(invariantViolations(sound), []);
  const planted = [
    [{ scrollWidth: 412 }, /scrolls sideways/u],
    [{ layoutShift: LAYOUT_SHIFT_BUDGET + 0.01 }, /layout shifts/u],
    [{ fontsLoaded: ["IBM Plex Mono Variable"] }, /IBM Plex Sans Variable did not load/u],
    [{ imagesWithoutAlt: 2 }, /without alt text/u],
    [{ mains: 0 }, /<main>/u],
    [{ h1s: 2 }, /<h1>/u],
  ];
  for (const [change, message] of planted) {
    const problems = invariantViolations({ ...sound, ...change });
    assert.equal(problems.length, 1, JSON.stringify(change));
    assert.match(problems[0], message);
  }
  assert.deepEqual(invariantViolations({ ...sound, layoutShift: LAYOUT_SHIFT_BUDGET }), [], "the budget itself is within budget");
});

const shot = (name, verdict, invariants = []) => ({ name, verdict, changedPixels: verdict === "changed" ? 10 : 0, totalPixels: verdict === "changed" ? 100 : 0, invariants });

test("the gate: unchanged passes; a change passes only when declared; an invariant or an unstable shot always refuses", () => {
  assert.deepEqual(gate([shot("a", "same"), shot("b", "same")], { changeDeclared: false }), { pass: true, reasons: [] });
  for (const verdict of ["changed", "added", "removed"]) {
    const undeclared = gate([shot("a", "same"), shot("b", verdict)], { changeDeclared: false });
    assert.equal(undeclared.pass, false, verdict);
    assert.match(undeclared.reasons[0], /visual-change/u);
    assert.equal(gate([shot("b", verdict)], { changeDeclared: true }).pass, true, `${verdict}, declared`);
  }
  const broken = gate([shot("a", "same", ["the page scrolls sideways"])], { changeDeclared: true });
  assert.deepEqual(broken, { pass: false, reasons: ["a: the page scrolls sideways"] });
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
});
