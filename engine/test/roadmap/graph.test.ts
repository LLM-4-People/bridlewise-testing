/**
 * THE ROADMAP'S DEPENDENCY GRAPH (scripts/roadmap/graph.ts): the item graph
 * and its typed refusals (unknown ids, repeats, cycles named in order), the
 * deterministic layered layout, the accessible SVG (every
 * text escaped, classes and no colour) and the page script's compile and size
 * contract.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { InputError } from "../../src/kernel/errors.ts";
import {
  GRAPH_SCRIPT, dependencyGraph, layoutGraph, renderGraphSvg, type GraphItem, type GraphLayout,
} from "../../scripts/roadmap/graph.ts";
import type { RoadmapState } from "../../src/workflow/tracker-status.ts";

const item = (id: string, fields: Partial<Omit<GraphItem, "id">> = {}): GraphItem => ({
  id, title: `Title of ${id}`, milestone: "M1", state: "planned" as RoadmapState, blockers: [], parent: null, ...fields,
});

const refused = (run: () => unknown, message: RegExp): void => {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof InputError, `expected an InputError, got ${String(error)}`);
    assert.equal(error.code, "roadmap_graph_invalid");
    assert.match(error.message, message);
    return true;
  });
};

// ── the graph ───────────────────────────────────────────────────────────────

test("edges run from blocker to blocked and from child to parent, in a fixed order", () => {
  const graph = dependencyGraph([
    item("C", { blockers: ["A", "B"] }),
    item("B", { parent: "EPIC" }),
    item("EPIC", { milestone: null }),
    item("A", { state: "shipped" }),
  ]);
  assert.deepEqual(graph.nodes.map((node) => node.id), ["A", "B", "C", "EPIC"]);
  assert.deepEqual(graph.nodes[3], { id: "EPIC", title: "Title of EPIC", milestone: null, status: "planned" });
  assert.deepEqual(graph.edges, [
    { from: "A", to: "C", kind: "blocks" },
    { from: "B", to: "C", kind: "blocks" },
    { from: "B", to: "EPIC", kind: "parent" },
  ]);
  assert.ok(Object.isFrozen(graph.edges) && Object.isFrozen(graph.nodes));
});

test("an unknown blocker or parent, a repeated id or edge and an empty id are refused", () => {
  refused(() => dependencyGraph([item("A", { blockers: ["GHOST"] })]), /A names an unknown item GHOST in blockers/u);
  refused(() => dependencyGraph([item("A"), item("B", { parent: "NOBODY" })]), /B names an unknown item NOBODY in parent/u);
  refused(() => dependencyGraph([item("A"), item("A")]), /A appears twice/u);
  refused(() => dependencyGraph([item("A"), item("B", { blockers: ["A", "A"] })]), /B names A twice in blockers/u);
  refused(() => dependencyGraph([item("")]), /empty id/u);
  // Near-misses: a case-different id is another id, a closed blocker is still a known one.
  assert.equal(dependencyGraph([item("a"), item("A", { blockers: ["a"] })]).edges.length, 1);
  assert.equal(dependencyGraph([item("A", { state: "not planned" }), item("B", { blockers: ["A"] })]).edges.length, 1);
});

test("a cycle is refused and named in order, closed by its first id", () => {
  refused(() => dependencyGraph([item("A", { blockers: ["C"] }), item("B", { blockers: ["A"] }), item("C", { blockers: ["B"] })]),
    /cycle: A -> B -> C -> A\./u);
  refused(() => dependencyGraph([item("SELF", { blockers: ["SELF"] })]), /cycle: SELF -> SELF\./u);
  // A child blocked by its own parent: the parent edge closes the loop.
  refused(() => dependencyGraph([item("P"), item("K", { blockers: ["P"], parent: "P" })]), /cycle: K -> P -> K\./u);
  // Near-miss: a child that blocks its parent points the same way twice, once per kind.
  assert.deepEqual(dependencyGraph([item("P", { blockers: ["K"] }), item("K", { parent: "P" })]).edges.map((edge) => edge.kind), ["blocks", "parent"]);
  // A cycle downstream of an acyclic prefix names only the cycle.
  refused(() => dependencyGraph([
    item("ROOT"), item("X", { blockers: ["ROOT", "Y"] }), item("Y", { blockers: ["X"] }),
  ]), /cycle: X -> Y -> X\./u);
  // Near-miss: a diamond joins twice but loops nowhere.
  const diamond = dependencyGraph([item("A"), item("B", { blockers: ["A"] }), item("C", { blockers: ["A"] }), item("D", { blockers: ["B", "C"] })]);
  assert.equal(diamond.edges.length, 4);
});

// ── the critical path ───────────────────────────────────────────────────────

const sample = (): GraphItem[] => [
  item("A"), item("B", { blockers: ["A"] }), item("C", { blockers: ["A"] }), item("D", { blockers: ["B", "C"] }),
  item("E", { blockers: ["A"], milestone: "M2" }), item("F", { blockers: ["D", "E"], parent: "G" }), item("G", { milestone: "M2" }),
  item("LONE", { milestone: null }),
];

const overlaps = (layout: GraphLayout): string[] => {
  const found: string[] = [];
  for (const [at, left] of layout.nodes.entries()) {
    for (const right of layout.nodes.slice(at + 1)) {
      if (left.x < right.x + right.w && right.x < left.x + left.w && left.y < right.y + right.h && right.y < left.y + left.h) found.push(`${left.id}/${right.id}`);
    }
  }
  return found;
};

test("the layout is deterministic, whatever order the items come in", () => {
  const first = layoutGraph(dependencyGraph(sample()));
  const again = layoutGraph(dependencyGraph(sample()));
  const shuffled = layoutGraph(dependencyGraph(sample().toReversed()));
  assert.deepEqual(again, first);
  assert.equal(JSON.stringify(shuffled), JSON.stringify(first));
});

test("layers respect every edge, nodes never overlap and coordinates hold one decimal", () => {
  const layout = layoutGraph(dependencyGraph(sample()), { nodeWidth: 123.456, nodeHeight: 33.333, rowGap: 7.77 });
  const layer = new Map(layout.nodes.map((node) => [node.id, node.layer]));
  for (const edge of layout.edges) assert.ok(layer.get(edge.from)! < layer.get(edge.to)!, `${edge.from} -> ${edge.to}`);
  assert.deepEqual(overlaps(layout), []);
  assert.deepEqual([...layer.entries()].filter(([id]) => ["A", "D", "F", "G"].includes(id)), [["A", 0], ["D", 2], ["F", 3], ["G", 4]]);
  const numbers = [layout.width, layout.height, ...layout.nodes.flatMap((node) => [node.x, node.y, node.w, node.h]),
    ...layout.edges.flatMap((edge) => edge.points.flat())];
  for (const value of numbers) assert.equal(Math.round(value * 10) / 10, value);
  for (const node of layout.nodes) {
    assert.ok(node.x + node.w <= layout.width && node.y + node.h <= layout.height, `${node.id} inside the canvas`);
  }
  // Near-miss for the overlap probe itself: two planted stacked nodes are caught.
  const planted = { ...layout, nodes: [...layout.nodes, { ...layout.nodes[0]!, id: "PLANTED", y: layout.nodes[0]!.y + 1 }] };
  assert.deepEqual(overlaps(planted), [`${layout.nodes[0]!.id}/PLANTED`]);
});

test("an edge gets one mid-point per layer it crosses, clear of every node", () => {
  const layout = layoutGraph(dependencyGraph(sample()));
  const byId = new Map(layout.nodes.map((node) => [node.id, node]));
  for (const edge of layout.edges) {
    const from = byId.get(edge.from)!;
    const to = byId.get(edge.to)!;
    assert.equal(edge.points.length, to.layer - from.layer + 1, `${edge.from} -> ${edge.to}`);
    assert.deepEqual(edge.points[0], [from.x + from.w, from.y + from.h / 2]);
    assert.deepEqual(edge.points.at(-1), [to.x, to.y + to.h / 2]);
    for (const [x, y] of edge.points.slice(1, -1)) {
      for (const node of layout.nodes) assert.ok(!(x >= node.x && x <= node.x + node.w && y >= node.y && y <= node.y + node.h), `${edge.from} -> ${edge.to} crosses ${node.id}`);
    }
  }
  assert.ok(layout.edges.some((edge) => edge.points.length > 2), "the sample has a long edge");
});

test("barycenter sweeps untangle a crossing that id order would draw", () => {
  const items = [item("A"), item("B"), item("Y", { blockers: ["B"] }), item("Z", { blockers: ["A"] })];
  const y = (layout: GraphLayout, id: string): number => layout.nodes.find((node) => node.id === id)!.y;
  const swept = layoutGraph(dependencyGraph(items));
  assert.ok(y(swept, "Z") < y(swept, "Y"), "Z sits beside its blocker A");
  // Near-miss: with no sweep the id order stands, and the edges cross.
  const unswept = layoutGraph(dependencyGraph(items), { sweeps: 0 });
  assert.ok(y(unswept, "Y") < y(unswept, "Z"));
});

test("an empty graph lays out to its margins; unusable options are refused", () => {
  assert.deepEqual(layoutGraph(dependencyGraph([]), { margin: 10 }), { width: 20, height: 20, nodes: [], edges: [] });
  const graph = dependencyGraph([item("A")]);
  refused(() => layoutGraph(graph, { nodeWidth: 0 }), /nodeWidth is not a usable size/u);
  refused(() => layoutGraph(graph, { rowGap: -1 }), /rowGap is not a usable size/u);
  refused(() => layoutGraph(graph, { margin: Number.NaN }), /margin is not a usable size/u);
  refused(() => layoutGraph(graph, { sweeps: 1.5 }), /sweeps is not a non-negative integer/u);
  // Near-miss: zero gaps and margin are legal.
  assert.equal(layoutGraph(graph, { rowGap: 0, layerGap: 0, margin: 0 }).width, 200);
});

// ── the SVG ─────────────────────────────────────────────────────────────────

test("every text and attribute is escaped; the full title stays in <title>", () => {
  const hostile = `Fix <script>&"quotes"'`;
  const items = [item("A", { title: hostile, milestone: `M"1<` }), item("B", { blockers: ["A"], title: "x".repeat(200) })];
  const svg = renderGraphSvg(layoutGraph(dependencyGraph(items)), items, new Set());
  assert.ok(!svg.includes("<script>"), "no raw markup from a title");
  assert.ok(svg.includes(`<title>A: Fix &lt;script&gt;&amp;&quot;quotes&quot;&#39; (planned)</title>`));
  assert.ok(svg.includes(`data-milestone="M&quot;1&lt;"`));
  assert.ok(svg.includes(`<title>B: ${"x".repeat(200)} (planned)</title>`));
  const label = /<tspan class="node-title"[^>]*>(x+…)<\/tspan>/u.exec(svg);
  assert.ok(label !== null && label[1]!.length < 200, "the label is cut to fit, with an ellipsis");
  // Near-miss: a short title is never cut.
  assert.ok(svg.includes(`>Fix &lt;script&gt;&amp;&quot;quotes&quot;&#39;</tspan>`));
});

test("critical and blocked classes, data attributes, and no colour or inline style", () => {
  const items = [
    item("A"), item("B", { state: "blocked", blockers: ["A"] }), item("C", { blockers: ["A"], milestone: null }),
  ];
  const graph = dependencyGraph(items);
  // The critical path is the feed's (each milestone's criticalPath); the SVG draws whatever it is given.
  const path = ["A", "B"];
  const svg = renderGraphSvg(layoutGraph(graph), items, new Set(path));
  assert.match(svg, /<g class="node critical" data-id="A" data-status="planned" data-milestone="M1" tabindex="0"/u);
  assert.match(svg, /<g class="node critical blocked" data-id="B" data-status="blocked"/u);
  assert.match(svg, /<g class="node" data-id="C" data-status="planned" data-milestone="" tabindex="0"/u);
  assert.match(svg, /<path class="edge blocks critical" data-from="A" data-to="B" data-kind="blocks" d="M/u);
  // Near-miss: an edge with only one critical end is not critical.
  assert.match(svg, /<path class="edge blocks" data-from="A" data-to="C"/u);
  assert.equal((svg.match(/<g class="node(?: [^"]*)?"/gu) ?? []).length, 3);
  assert.doesNotMatch(svg, /style=|fill=|stroke=|#[0-9a-f]{3,8}\b|rgb\(|hsl\(/iu);
});

test("the SVG is an accessible image whose title and description summarise the counts", () => {
  const items = [item("A"), item("B", { state: "blocked", blockers: ["A"] }), item("C", { blockers: ["A"] })];
  const svg = renderGraphSvg(layoutGraph(dependencyGraph(items)), items, new Set(["A", "B"]));
  assert.match(svg, /^<svg [^>]*role="img"[^>]*aria-labelledby="roadmap-graph-title roadmap-graph-desc"/u);
  assert.match(svg, /<title id="roadmap-graph-title">Roadmap dependency graph<\/title>/u);
  assert.match(svg, /<desc id="roadmap-graph-desc">3 items, 2 dependencies, 2 on the critical path, 1 blocked\./u);
  const one = [item("SOLO")];
  assert.match(renderGraphSvg(layoutGraph(dependencyGraph(one)), one, new Set()), /1 item, 0 dependencies, 0 on the critical path, 0 blocked\./u);
});

test("a layout node with no item is refused", () => {
  const items = [item("A"), item("B")];
  const layout = layoutGraph(dependencyGraph(items));
  refused(() => renderGraphSvg(layout, [items[0]!], new Set()), /The layout names B, which no item has/u);
});

// ── the page script ─────────────────────────────────────────────────────────

test("the page script compiles, stays under its size cap and tolerates a page without the graph", () => {
  assert.doesNotThrow(() => new Function(GRAPH_SCRIPT));
  assert.ok(Buffer.byteLength(GRAPH_SCRIPT, "utf8") < 4096, `${Buffer.byteLength(GRAPH_SCRIPT, "utf8")} bytes`);
  const run = (document: unknown): void => {
    new Function("document", "window", GRAPH_SCRIPT)(document, {});
  };
  assert.doesNotThrow(() => run(undefined));
  assert.doesNotThrow(() => run({ querySelector: () => null }));
  assert.doesNotThrow(() => run({}));
  // Near-miss: a planted syntax error is what the compile probe catches.
  assert.throws(() => new Function(`${GRAPH_SCRIPT}\n})`), SyntaxError);
});

test("the page script marks upstream and downstream, filters by milestone and clears on Escape", () => {
  const items = [item("A"), item("B", { blockers: ["A"] }), item("C", { blockers: ["B"], milestone: "M2" }), item("D")];
  const svgText = renderGraphSvg(layoutGraph(dependencyGraph(items)), items, new Set());
  const dom = fakeDom(svgText);
  new Function("document", "window", GRAPH_SCRIPT)(dom.document, { matchMedia: () => ({ matches: true }) });
  dom.fire(dom.node("B"), "focus");
  assert.deepEqual(dom.classesOf(dom.node("A")), ["upstream"]);
  assert.deepEqual(dom.classesOf(dom.node("B")), ["current"]);
  assert.deepEqual(dom.classesOf(dom.node("C")), ["downstream"]);
  assert.deepEqual(dom.classesOf(dom.node("D")), []);
  assert.ok(dom.svg.classes.has("dimmed"));
  dom.fire(dom.document, "keydown", { key: "Escape" });
  assert.ok(!dom.svg.classes.has("dimmed"));
  assert.deepEqual(dom.classesOf(dom.node("A")), []);
  dom.fire(dom.node("C"), "keydown", { key: "Enter", preventDefault: () => undefined });
  assert.deepEqual(dom.scrolled, ["item-C"]);
  dom.select.value = "M2";
  dom.fire(dom.select, "change");
  assert.deepEqual(dom.hidden(), ["A", "A->B", "B", "B->C", "D"]);
  dom.select.value = "";
  dom.fire(dom.select, "change");
  assert.deepEqual(dom.hidden(), []);
});

/** The smallest DOM the page script touches, built from the rendered markup's own attributes. */
function fakeDom(svgText: string) {
  type Element = {
    attrs: Map<string, string>; classes: Set<string>; listeners: Map<string, ((event: unknown) => void)[]>; value: string;
    getAttribute(name: string): string | null; setAttribute(name: string, value: string): void; removeAttribute(name: string): void;
    hasAttribute(name: string): boolean; addEventListener(type: string, listener: (event: unknown) => void): void;
    classList: { add(...names: string[]): void; remove(...names: string[]): void };
    scrollIntoView(): void; focus(): void;
  };
  const scrolled: string[] = [];
  const element = (attrs: Record<string, string>): Element => {
    const self: Element = {
      attrs: new Map(Object.entries(attrs)), classes: new Set(), listeners: new Map(), value: "",
      getAttribute: (name) => self.attrs.get(name) ?? null,
      setAttribute: (name, value) => void self.attrs.set(name, value),
      removeAttribute: (name) => void self.attrs.delete(name),
      hasAttribute: (name) => self.attrs.has(name),
      addEventListener: (type, listener) => void self.listeners.set(type, [...(self.listeners.get(type) ?? []), listener]),
      classList: { add: (...names) => names.forEach((name) => self.classes.add(name)), remove: (...names) => names.forEach((name) => self.classes.delete(name)) },
      scrollIntoView: () => void scrolled.push(self.attrs.get("id")!),
      focus: () => undefined,
    };
    return self;
  };
  const attrsOf = (tag: string): Record<string, string> => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/gu)].map((match) => [match[1]!, match[2]!]));
  const nodes = [...svgText.matchAll(/<g class="node(?: [^"]*)?"[^>]*>/gu)].map((match) => element(attrsOf(match[0])));
  const edges = [...svgText.matchAll(/<path class="edge[^"]*"[^>]*>/gu)].map((match) => element(attrsOf(match[0])));
  const svg = element({});
  const all = (): Element[] => [...nodes, ...edges];
  Object.assign(svg, {
    querySelectorAll: (selector: string) => (selector.startsWith("g.node") ? nodes
      : selector.startsWith("path.edge") ? edges : all().filter((el) => el.classes.size > 0)),
  });
  const select = element({});
  const targets = new Map(nodes.map((node) => [`item-${node.getAttribute("data-id")}`, element({ id: `item-${node.getAttribute("data-id")}` })]));
  const document = element({});
  Object.assign(document, {
    querySelector: (selector: string) => (selector.startsWith("svg") ? svg : selector.startsWith("select") ? select : null),
    getElementById: (id: string) => targets.get(id) ?? null,
  });
  return {
    document, svg, select, scrolled,
    node: (id: string): Element => nodes.find((node) => node.getAttribute("data-id") === id)!,
    classesOf: (el: Element): string[] => [...el.classes].toSorted(),
    fire: (el: Element, type: string, event: unknown = {}): void => (el.listeners.get(type) ?? []).forEach((listener) => listener(event)),
    hidden: (): string[] => [
      ...nodes.filter((node) => node.getAttribute("display") === "none").map((node) => node.getAttribute("data-id")!),
      ...edges.filter((edge) => edge.getAttribute("display") === "none").map((edge) => `${edge.getAttribute("data-from")}->${edge.getAttribute("data-to")}`),
    ].toSorted(),
  };
}
