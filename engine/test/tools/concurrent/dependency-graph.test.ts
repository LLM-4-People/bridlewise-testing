import assert from "node:assert/strict";
import test from "node:test";

import {
  buildToolCallDependencyGraph,
  topologicalLevels,
  resolveExplicitDeps,
  DependencyCycleError,
  UnknownReferenceError,
  type ConcurrentToolCall,
} from "../../../src/tools/concurrent/dependency-graph.ts";

function batch(calls: ReadonlyArray<readonly [string, string, Record<string, unknown>?]>): readonly ConcurrentToolCall[] {
  return calls.map(([id, name, args]) => ({ id, name, args: args ?? {} }));
}

test("dependency-graph: empty batch → 0 levels", () => {
  const g = buildToolCallDependencyGraph([]);
  assert.equal(g.deps.size, 0);
  assert.equal(g.levels.size, 0);
});

test("dependency-graph: independent calls → all level 0", () => {
  const g = buildToolCallDependencyGraph(batch([["a", "awareness"], ["b", "search"]]));
  assert.equal(g.levels.get("a"), 0);
  assert.equal(g.levels.get("b"), 0);
});

test("dependency-graph: explicit $ref → dependent level", () => {
  const g = buildToolCallDependencyGraph(batch([
    ["a", "awareness"],
    ["b", "search", { $ref: "a" }],
  ]));
  assert.equal(g.levels.get("a"), 0);
  assert.equal(g.levels.get("b"), 1);
  assert.ok(g.deps.get("b")!.has("a"));
});

test("dependency-graph: 10-step chain → levels 0..9 (sequential ordering)", () => {
  const calls: Array<[string, string, Record<string, unknown>]> = [];
  for (let s = 0; s < 10; s++) {
    const args: Record<string, unknown> = {};
    if (s > 0) args.$ref = `step-${s - 1}`;
    calls.push([`step-${s}`, "awareness", args]);
  }
  const g = buildToolCallDependencyGraph(batch(calls));
  for (let s = 0; s < 10; s++) assert.equal(g.levels.get(`step-${s}`), s, `step ${s} should be level ${s}`);
});

test("dependency-graph: 10 parallel chains → each chain sequential, chains parallel", () => {
  const calls: Array<[string, string, Record<string, unknown>?]> = [];
  for (let c = 0; c < 10; c++) {
    for (let s = 0; s < 10; s++) {
      const args: Record<string, unknown> = {};
      if (s > 0) args.$ref = `chain-${c}-step-${s - 1}`;
      calls.push([`chain-${c}-step-${s}`, "awareness", args]);
    }
  }
  const g = buildToolCallDependencyGraph(batch(calls));
  for (let c = 0; c < 10; c++) {
    for (let s = 0; s < 10; s++) {
      assert.equal(g.levels.get(`chain-${c}-step-${s}`), s, `chain ${c} step ${s} should be level ${s}`);
    }
  }
});

test("dependency-graph: cycle → DependencyCycleError", () => {
  assert.throws(
    () => buildToolCallDependencyGraph(batch([
      ["a", "awareness", { $ref: "b" }],
      ["b", "awareness", { $ref: "a" }],
    ])),
    DependencyCycleError,
  );
});

test("dependency-graph: unknown $ref → UnknownReferenceError", () => {
  assert.throws(
    () => buildToolCallDependencyGraph(batch([["a", "awareness", { $ref: "nope" }]])),
    UnknownReferenceError,
  );
});

test("dependency-graph: args as JSON string → parsed for $ref", () => {
  const g = buildToolCallDependencyGraph([
    { id: "a", name: "awareness", args: "{}" },
    { id: "b", name: "search", args: JSON.stringify({ $ref: "a" }) },
  ]);
  assert.equal(g.levels.get("a"), 0);
  assert.equal(g.levels.get("b"), 1);
});

test("dependency-graph: implicit data-flow (path matches producer result)", () => {
  const producerResults = new Map([["grep-1", new Set(["src/foo.ts", "src/bar.ts"])]]);
  const g = buildToolCallDependencyGraph(
    batch([
      ["grep-1", "grep"],
      ["read-1", "read_file", { path: "src/foo.ts" }],
      ["read-2", "read_file", { path: "src/other.ts" }],
    ]),
    {
      pathTools: new Set(["read_file"]),
      producerResults,
    },
  );
  // read-1 depends on grep-1 (path matched); read-2 does not (path not in producer).
  assert.ok(g.deps.get("read-1")!.has("grep-1"), "read-1 should depend on grep-1");
  assert.ok(!g.deps.get("read-2")!.has("grep-1"), "read-2 should NOT depend on grep-1");
});

test("topologicalLevels: null on cycle", () => {
  const deps = new Map([
    ["a", new Set(["b"])],
    ["b", new Set(["a"])],
  ]);
  assert.equal(topologicalLevels(deps), null);
});

test("resolveExplicitDeps: returns only $ref deps (no implicit)", () => {
  const out = resolveExplicitDeps(batch([
    ["a", "awareness"],
    ["b", "search", { $ref: "a" }],
  ]));
  assert.deepEqual([...out.get("b")!], ["a"]);
  assert.equal(out.get("a")!.size, 0);
});
