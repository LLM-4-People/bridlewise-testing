// EXP438 — Plant synthetic babel-traverse content for the multi-step refactor.
//
// Plants 7 assertion utilities (makeAssertNode + 6 siblings) and ~300 call
// sites spread across 60+ files in a synthetic babel-traverse tree under
// `babel-work/babel/packages/babel-traverse/`. Also plants test files that
// reference makeAssertNode. Returns the planted ground truth so the e2e
// driver can compute expected outputs and verify actual vs expected.
//
// Why synthetic: real babel-traverse does NOT have makeAssertNode — we plant
// it to give the harness a real refactor target on real-shaped code. The
// plant is deterministic (seeded RNG) so expected outputs are reproducible.

import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const BABEL_ROOT = join(REPO_ROOT, "babel-work", "babel");
const TRAVERSE_SRC = join(BABEL_ROOT, "packages", "babel-traverse", "src");

// Mulberry32 seeded PRNG (deterministic — no Math.random in the plant).
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 20260722;
const rng = mulberry32(SEED);

// The 7 assertion utilities (canonical owner file).
const ASSERTIONS_FILE = join(TRAVERSE_SRC, "assertions.ts");
const ASSERTIONS_CONTENT = `// Synthetic babel-traverse assertion utilities (planted by EXP438).
// This file owns the 7 assertion helpers used across babel-traverse.
import type * as t from "@babel/types";

export function makeAssertNode(node: t.Node | null, type: string): asserts node is t.Node {
  if (node === null || node === undefined) {
    throw new Error("Expected " + type + " node but got null");
  }
  if (node.type !== type) {
    throw new Error("Expected " + type + " but got " + node.type);
  }
  // Type-checking logic — candidate for extraction into a helper.
  if (typeof node.type !== "string") {
    throw new Error("Node has no type string");
  }
  if (node.type.length === 0) {
    throw new Error("Node type is empty");
  }
}

export function makeAssertType(node: t.Node | null, expectedType: string): void {
  if (node === null) {
    throw new Error("Expected node of type " + expectedType + " but got null");
  }
  if (node.type !== expectedType) {
    throw new Error("Expected " + expectedType + " but got " + node.type);
  }
}

export function makeAssertString(node: t.Node | null): asserts node is t.StringLiteral {
  makeAssertNode(node, "StringLiteral");
}

export function makeAssertNumber(node: t.Node | null): asserts node is t.NumericLiteral {
  makeAssertNode(node, "NumericLiteral");
}

export function makeAssertBoolean(node: t.Node | null): asserts node is t.BooleanLiteral {
  makeAssertNode(node, "BooleanLiteral");
}

export function makeAssertBigInt(node: t.Node | null): asserts node is t.BigIntLiteral {
  makeAssertNode(node, "BigIntLiteral");
}

export function makeAssertNullable(node: t.Node | null, type: string): void {
  if (node !== null && node !== undefined) {
    makeAssertNode(node, type);
  }
}
`;

// 60 path files that each call makeAssertNode ~5 times (300 call sites total).
const PATH_FILES = [
  "ancestry", "comments", "context", "conversion", "evaluation", "family",
  "introspection", "modification", "removal", "replacement",
  "lib/family-validation", "lib/scope-binding", "lib/scope-inference",
  "lib/type-coercion", "lib/node-cleanup", "lib/scope-hoist",
  "lib/path-visitor", "lib/node-visitor",
  "inference/match", "inference/paths", "inference/types",
  "inference/container", "inference/literals",
  "generated/validators", "generated/ancestry-checks", "generated/type-guards",
  "generated/kind-checks", "generated/asserts-impl", "generated/visitors",
  "scope/binding-references", "scope/collect-exports", "scope/collect-imports",
  "scope/evaluate-computed-key", "scope/handle-declaration", "scope/infer-type",
  "scope/rename", "scope/traverse-children", "scope/traverse-ancestors",
  "scope/traverse-descendants", "scope/crawl-exports",
];

function makePathFile(name, callCount) {
  const calls = Array.from({ length: callCount }, (_, i) => {
    const r = rng();
    const type = ["StringLiteral", "NumericLiteral", "BooleanLiteral", "BigIntLiteral"][Math.floor(r * 4)];
    const ctx = ["path.node", "currentPath.node", "child.node", "childPath.node"][Math.floor(rng() * 4)];
    return `  // call site ${i + 1} (depth ${Math.floor(rng() * 3)})\n  makeAssertNode(${ctx}, "${type}");`;
  }).join("\n");
  const fileStem = name.split("/").pop();
  return `// Synthetic babel-traverse path/${name}.ts (planted by EXP438).
import type * as t from "@babel/types";
import { makeAssertNode, makeAssertType } from "../assertions.ts";

export function validate_${fileStem.replace(/-/g, "_")}(path: any): void {
${calls}
  // tail call to makeAssertType for type inference
  makeAssertType(path.node, "${fileStem}");
}
`;
}

// Test files referencing makeAssertNode (12 files).
const TEST_FILES = [
  "assertions.test.ts", "ancestry.test.ts", "introspection.test.ts",
  "removal.test.ts", "replacement.test.ts", "conversion.test.ts",
  "evaluation.test.ts", "modification.test.ts", "context.test.ts",
  "scope/rename.test.ts", "scope/binding.test.ts", "generated/validators.test.ts",
];

function makeTestFile(name) {
  const calls = Array.from({ length: 8 }, (_, i) =>
    `  makeAssertNode(node${i}, "StringLiteral");`).join("\n");
  return `// Synthetic test ${name} (planted by EXP438).
import { makeAssertNode, makeAssertType } from "../assertions.ts";
import { bootstrapProcess, isEntryPoint } from "../../src/runtime/cli-debug.ts";

describe("${name}", () => {
  it("calls makeAssertNode", () => {
${calls}
  });
});
`;
}

export function plantBabel() {
  // Clean + recreate
  if (existsSync(BABEL_ROOT)) rmSync(BABEL_ROOT, { recursive: true, force: true });
  mkdirSync(TRAVERSE_SRC, { recursive: true });
  mkdirSync(join(TRAVERSE_SRC, "lib"), { recursive: true });
  mkdirSync(join(TRAVERSE_SRC, "inference"), { recursive: true });
  mkdirSync(join(TRAVERSE_SRC, "generated"), { recursive: true });
  mkdirSync(join(TRAVERSE_SRC, "scope"), { recursive: true });
  mkdirSync(join(TRAVERSE_SRC, "..", "test"), { recursive: true });

  // Reset RNG for determinism (same seed → same content every run).
  const localRng = mulberry32(SEED);

  // 1. Plant the assertion utilities file (the rename target).
  writeFileSync(ASSERTIONS_FILE, ASSERTIONS_CONTENT, "utf8");

  // 2. Plant path files. Each calls makeAssertNode ~5 times → ~270 call sites
  //    from path files + ~30 from tests = ~300 total.
  let pathCallSites = 0;
  const pathFileEntries = [];
  for (const pf of PATH_FILES) {
    const callsPerFile = 5 + Math.floor(localRng() * 4); // 5..8
    const content = makePathFile(pf, callsPerFile);
    const filePath = join(TRAVERSE_SRC, "path", `${pf}.ts`);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, "utf8");
    pathCallSites += callsPerFile;
    pathFileEntries.push({ file: `path/${pf}.ts`, calls: callsPerFile });
  }

  // 3. Plant test files (each ~8 calls → 12 * 8 = 96 + a few in the
  //    assertions.ts itself + 27 path files * 5-8 = 270 path + tests 96 = ~366+
  //    We want EXACTLY 298+ call sites, so plant fewer path calls).
  let testCallSites = 0;
  const testFileEntries = [];
  const testDir = join(TRAVERSE_SRC, "..", "test");
  for (const tf of TEST_FILES) {
    const content = makeTestFile(tf);
    const filePath = join(testDir, tf);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, "utf8");
    testCallSites += 8;
    testFileEntries.push({ file: `test/${tf}`, calls: 8 });
  }

  // Also plant a few direct uses in the assertions.ts file itself.
  // (Already 0 direct makeAssertNode calls in assertions.ts; makeAssertString etc. delegate.)

  const totalCallSites = pathCallSites + testCallSites;
  const totalFiles = 1 + pathFileEntries.length + testFileEntries.length;

  // The ground truth (used by the e2e driver to compute expected outputs).
  const groundTruth = {
    seed: SEED,
    babelRoot: BABEL_ROOT,
    traverseSrc: TRAVERSE_SRC,
    assertionsFile: "assertions.ts",
    assertionUtilities: [
      { name: "makeAssertNode", file: "assertions.ts", kind: "definition" },
      { name: "makeAssertType", file: "assertions.ts", kind: "definition" },
      { name: "makeAssertString", file: "assertions.ts", kind: "definition" },
      { name: "makeAssertNumber", file: "assertions.ts", kind: "definition" },
      { name: "makeAssertBoolean", file: "assertions.ts", kind: "definition" },
      { name: "makeAssertBigInt", file: "assertions.ts", kind: "definition" },
      { name: "makeAssertNullable", file: "assertions.ts", kind: "definition" },
    ],
    pathFiles: pathFileEntries,
    testFiles: testFileEntries,
    totalCallSites: totalCallSites,
    pathCallSites: pathCallSites,
    testCallSites: testCallSites,
    totalFiles: totalFiles,
    totalTestFiles: testFileEntries.length,
  };

  // Write the ground truth as a sidecar (the e2e driver reads it).
  writeFileSync(join(REPO_ROOT, "babel-work", "ground-truth.json"),
    JSON.stringify(groundTruth, null, 2), "utf8");

  return groundTruth;
}

// Allow direct execution: `node scripts/exp438/plant-babel.mjs`
if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  const gt = plantBabel();
  console.log(JSON.stringify({
    planted: true,
    babelRoot: gt.babelRoot,
    assertionUtilities: gt.assertionUtilities.length,
    pathFiles: gt.pathFiles.length,
    testFiles: gt.testFiles.length,
    totalCallSites: gt.totalCallSites,
    pathCallSites: gt.pathCallSites,
    testCallSites: gt.testCallSites,
    totalFiles: gt.totalFiles,
  }, null, 2));
}
