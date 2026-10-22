// The social card: the site's own page, drawn from the judged register and
// shot in both themes by the site build; every page's og:image is the
// Logbook card, and the retired disc images stay deleted.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

import { SOCIAL_CARD } from "../../scripts/visual/social.ts";
import { THEMES } from "../../shared/token-reader.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path) => readFileSync(join(ROOT, path), "utf8");

test("the card is the 1280x640 frame every preview crops to, one file per theme", () => {
  assert.equal(SOCIAL_CARD.width / SOCIAL_CARD.height, 2);
  assert.deepEqual(Object.keys(SOCIAL_CARD.files).sort(), [...THEMES].sort());
  assert.equal(SOCIAL_CARD.files.logbook, "assets/social.png", "the lead theme's card is the default");
  const card = read("docs/social/card.html");
  assert.match(card, new RegExp(`^permalink: ${SOCIAL_CARD.page.replaceAll("/", "\\/")}$`, "mu"));
  assert.match(card, /site\.data\.brand/u);
  assert.match(card, /brand\.counts\.retracted/u, "the card shows the retracted count: a failing check is never hidden from a preview");
});

test("every page's preview image is the card, and the retired disc images are gone", () => {
  const layout = read("docs/_layouts/default.html");
  assert.match(layout, new RegExp(`og:image" content="\\{\\{ page\\.image \\| default: '/${SOCIAL_CARD.files.logbook}'`, "u"));
  assert.match(layout, new RegExp(`twitter:image" content="\\{\\{ page\\.image \\| default: '/${SOCIAL_CARD.files.logbook}'`, "u"));
  for (const page of ["docs/run/index.html", "docs/policy-lab/index.html"]) assert.match(read(page), new RegExp(`/${SOCIAL_CARD.files.logbook}`, "u"), page);
  for (const retired of ["docs/assets/hero.png", "docs/assets/social-preview.png"]) assert.equal(existsSync(join(ROOT, retired)), false, retired);
});

test("the Pages build shoots the cards after Jekyll and before the links are judged", () => {
  const steps = parse(read(".github/workflows/pages.yml")).jobs.build.steps.map((step) => step.name);
  const jekyll = steps.indexOf("Build with Jekyll");
  const shoot = steps.indexOf("Shoot the social cards");
  const finish = steps.findIndex((name) => /check links and design/u.test(name));
  assert.ok(jekyll >= 0 && shoot > jekyll && finish > shoot, steps.join(" → "));
});
