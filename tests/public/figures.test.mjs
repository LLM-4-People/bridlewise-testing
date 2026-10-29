// The generated figures (shared/figures.ts): the site's inline figures drawn
// with classes only, the decision-status bar counted from the decision records
// when the site is built and never committed, and every refusal planted.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";

import { boxFigureInline, boxFigureViolations, FigureError, partBarInline, partBarSentence } from "../../shared/figures.ts";
import { DECISION_IMPLEMENTATIONS, decisionStatus } from "../../engine/scripts/verification/tracker-entries.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path) => readFileSync(join(ROOT, path), "utf8");
const CSS = read("docs/assets/css/style.css");
/** Every class an inline figure uses has a rule in the site's stylesheet. */
const assertInked = (svg) => {
  for (const name of new Set([...svg.matchAll(/class="([^"]+)"/gu)].flatMap((match) => match[1].split(" ")))) {
    assert.ok(CSS.includes(`.${name} `) || CSS.includes(`.${name},`), `.${name} has a rule in style.css`);
  }
};
const BAR = { title: "4 things", subtitle: "by kind", source: "a test", parts: [
  { label: "built", count: 3, ink: "--ok" },
  { label: "partly", count: 1, ink: "--ok", hatched: true },
  { label: "none", count: 0, ink: "--warn" },
] };

test("a part bar is drawn inline with classes only, states its whole content in words, and every class it uses is inked by the site", () => {
  const sentence = partBarSentence(BAR);
  assert.equal(sentence, "4 things, by kind: 3 built; 1 partly; 0 none. Source: a test.");
  const svg = partBarInline(BAR, "fig-b");
  assert.match(svg, /^<svg class="fig" [^>]*role="img" aria-labelledby="fig-b-t fig-b-d">/u);
  assert.ok(svg.includes(`<desc id="fig-b-d">${sentence}</desc>`));
  assert.doesNotMatch(svg, /#[0-9a-f]{3,8}\b|var\(|oklch|color-mix|fill="(?!url\(#fig-b-)|stroke="/iu, "no colour in the markup: the theme inks it");
  assert.equal((svg.match(/<rect x="[\d.]+" y="64" width="[\d.]+" height="22" class=/gu) ?? []).length, 2, "a part with no count is not drawn, but it keeps its legend");
  assert.ok(svg.includes(">0</text>"));
  assert.match(svg, /<pattern id="fig-b-h1-6"/u, "a hatched part is hatched, not only coloured");
  assert.match(svg, /class="fig-line-ok" fill="url\(#fig-b-h1-6\)"/u);
  assertInked(svg);
});

test("a part inked by anything but a part ink, or with an id that is not a plain name, is refused", () => {
  assert.throws(() => partBarInline({ ...BAR, parts: [{ label: "x", count: 1, ink: "--accent" }] }, "fig-b"), (error) => error instanceof FigureError && error.code === "figure_ink_unknown");
  assert.throws(() => partBarInline(BAR, 'x" onload="alert(1)'), (error) => error instanceof FigureError && error.code === "figure_id_invalid");
});

test("the decision-status figure counts every record once, from its own front matter, and names every implementation state", () => {
  const entries = readdirSync(join(ROOT, "docs/decisions")).filter((name) => name.endsWith(".md") && name !== "README.md").map((name) => ({ name, text: read(`docs/decisions/${name}`) }));
  const status = decisionStatus(entries);
  assert.equal(status.parts.reduce((sum, part) => sum + part.count, 0), entries.length);
  assert.equal(status.title, `${String(entries.length)} decision records`);
  assert.equal(status.parts.length, DECISION_IMPLEMENTATIONS.length + 1, "each implementation state, plus superseded");
  const planted = decisionStatus([
    { name: "a.md", text: "---\nid: A\nstatus: in-force\nimplementation: done\n---\n# A\n" },
    { name: "b.md", text: "---\nid: B\nstatus: superseded\nimplementation: done\n---\n# B\n" },
  ]);
  assert.deepEqual(planted.parts.map((part) => part.count), [1, 0, 0, 0, 1], "a superseded record is superseded whatever it reached");
  assertInked(partBarInline(status, "fig-decision-status"));
  assert.ok(!existsSync(join(ROOT, "docs/assets/generated/decision-status-light.svg")) && !existsSync(join(ROOT, "docs/assets/generated/decision-status-dark.svg")), "the count is never committed as a figure");
  assert.ok(!read("docs/decisions/README.md").includes(partBarSentence(status)), "nor as the index's sentence: every change to the records would rewrite it (#527)");
  assert.ok(read("docs/floor/index.md").includes("{% include figures/decision-status.svg %}"), "the development floor shows the figure the site build draws");
});

const figure = JSON.parse(read("docs/_data/figures/architecture.json"));

test("a boxes figure is drawn inline with classes only, its ids prefixed, and every class it uses is inked by the site", () => {
  assert.deepEqual(boxFigureViolations(figure), []);
  const svg = boxFigureInline(figure, "fig-a");
  assert.doesNotMatch(svg, /#[0-9a-f]{3,8}\b|fill="(?!none)|stroke="/iu, "no colour in the markup: the theme inks it");
  assert.match(svg, /aria-labelledby="fig-a-t fig-a-d"/u);
  assert.match(svg, /marker-end="url\(#fig-a-arrow\)"/u);
  assertInked(svg);
});

/** Text that tries every way out of an SVG or HTML text node and attribute. */
const HOSTILE = [
  '<script>alert(1)</script>',
  '"/><script>alert(2)</script><x a="',
  "'/><image href=x onerror=alert(3)>",
  "]]><!-- & </text></svg>",
];

/** The SVG parsed as XML: it must be well formed, hold no script and no element the generator does not draw. */
function parsedSvg(svg) {
  const document = new new JSDOM("").window.DOMParser().parseFromString(svg, "image/svg+xml");
  assert.equal(document.getElementsByTagName("parsererror").length, 0, `well-formed: ${svg.slice(0, 200)}`);
  for (const tag of ["script", "image", "foreignObject", "x"]) assert.equal(document.getElementsByTagName(tag).length, 0, `no <${tag}> escaped into the figure`);
  for (const element of document.getElementsByTagName("*")) {
    for (const attribute of element.attributes) assert.ok(!/^on/iu.test(attribute.name), `no event handler: ${attribute.name}`);
  }
  return document;
}

test("hostile labels stay text: every string a figure carries is escaped where it lands", () => {
  for (const evil of HOSTILE) {
    const bar = { title: evil, subtitle: evil, source: evil, parts: [{ label: evil, count: 2, ink: "--ok" }, { label: evil, count: 1, ink: "--ink-2", hatched: true }] };
    const document = parsedSvg(partBarInline(bar, "fig-evil-bar"));
    const texts = [...document.getElementsByTagName("text")].map((node) => node.textContent);
    assert.ok(texts.filter((text) => text === evil).length >= 4, "the title, subtitle and both labels read as the text itself");
    assert.equal(document.querySelector("title").textContent, `${evil}, ${evil}`, "the title is the headline and what it divides");
    assert.equal(document.querySelector("desc").textContent, partBarSentence(bar));
    const boxes = { ...figure, title: evil, desc: evil, heading: evil, aside: evil, foot: evil, boxes: figure.boxes.map((box) => ({ ...box, title: evil, lines: box.lines.map(() => evil), ...(box.tag === undefined ? {} : { tag: evil }) })), edges: figure.edges.map((edge) => (edge.label === undefined ? edge : { ...edge, label: evil })) };
    const inline = parsedSvg(boxFigureInline(boxes, "fig-evil"));
    assert.equal(inline.querySelector("title").textContent, evil);
    assert.ok([...inline.getElementsByTagName("text")].every((node) => node.textContent === evil), "every box, line, tag, heading and foot is the text itself");
  }
});

test("an inline figure's id is a plain name: anything else is refused before it reaches an id or url(#…)", () => {
  for (const id of ['x" onload="alert(1)', "fig a", "Fig", "1fig", "fig)url(", ""]) {
    assert.throws(() => boxFigureInline(figure, id), (error) => error instanceof FigureError && error.code === "figure_id_invalid", JSON.stringify(id));
  }
  assert.doesNotThrow(() => boxFigureInline(figure, "fig-architecture-2"));
});

test("a malformed figure is refused, each fault named", () => {
  assert.deepEqual(boxFigureViolations(null), ["the figure is not a JSON object"]);
  const broken = structuredClone(figure);
  broken.schema = "other";
  broken.boxes[0].x = figure.width;
  broken.boxes[1].h = 40;
  broken.edges[0].d = "M 0 0 C 1 1 2 2 3 3";
  broken.edges[1].label = "orphan";
  const problems = boxFigureViolations(broken);
  assert.equal(problems.length, 5, problems.join("\n"));
  assert.match(problems.join("\n"), /schema/u);
  assert.match(problems.join("\n"), /leaves the figure/u);
  assert.match(problems.join("\n"), /too short/u);
  assert.match(problems.join("\n"), /straight path/u);
  assert.match(problems.join("\n"), /label and its place/u);
});
