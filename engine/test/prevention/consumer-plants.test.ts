// The §28 receipt tool must not be the one scanner with no universe check.
//
// `consumer-plants.ts` answers "which guards' mutation plants must be re-run
// because this shared helper changed". Its answer is a WORK LIST, and an empty
// work list reads as "nothing to do" — the most comfortable wrong answer this
// project produces. So both of its inputs are driven here: a real subject with
// known consumers, and every way the closure can come back empty.
//
// LADDER VERDICT: rung 5, and it says so.
//   Rung 1 unavailable — the subject is a source file; nothing at the OS level
//     can refuse a reverse-import query.
//   Rung 2 unavailable — the bad answer is a well-typed empty array; no type
//     distinguishes "genuinely unreached" from "the resolver stopped
//     resolving", because both produce `readonly string[]` of length 0.
//   Rung 3 unavailable — the tool takes one argument, the subject path, and
//     there is no additional argument a caller could be forced to supply that
//     would carry the evidence the answer is complete.
//   Rung 4 IS taken WITHIN the tool (the single door refuses an empty universe
//     on both inputs), but the closure itself is a byte scan, and a byte scan's
//     universe is a regex — which is rung 5, and is exactly why the first
//     spelling of that regex was wrong.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import { consumerClosure } from "../../scripts/verification/consumer-plants.ts";
import { createTempDir } from "../support/temp-dir.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("consumer-plants: a real shared helper's consumers are found in BOTH repositories", () => {
  // `gitignore-anchoring.ts` is imported from this repository AND from the web
  // repository's global test setup. The cross-repository half is the whole
  // point: §28b was written because a fingerprint holding ONE git index let a
  // write to the sibling's tracked source exit 0 in silence.
  const closure = consumerClosure(join(REPO_ROOT, "scripts", "verification", "gitignore-anchoring.ts"));
  assert.equal(closure.failure, null);
  console.log(
    `[consumer-plants] scanned ${closure.scanned.length}, consumers ${closure.consumers.length}, plants ${closure.plants.length}`,
  );
  // CONTAINMENT, never a count (§31a): a floor of "at least N" passes on the
  // right number with the wrong set.
  // The two trees are one repository now, so "the other one" can no longer be
  // spelled as a repository name. It is spelled as NOT-THIS-PACKAGE, which is
  // the same proposition and cannot go stale when a directory is renamed.
  const web = closure.consumers.filter((path) => !path.startsWith(REPO_ROOT + "/"));
  const here = closure.consumers.filter((path) => path.startsWith(REPO_ROOT + "/"));
  assert.ok(web.length > 0, `no WEB consumer found; consumers were: ${closure.consumers.join(", ")}`);
  assert.ok(here.length > 0, `no INTEGRATION consumer found; consumers were: ${closure.consumers.join(", ")}`);
  assert.ok(
    closure.plants.some((path) => path.endsWith("test/prevention/gitignore-anchoring.test.ts")),
    "the helper's own prevention test must be in the plant list",
  );
  assert.ok(
    closure.plants.some((path) => !path.startsWith(REPO_ROOT + "/")),
    "the WEB plants must be in the list — a receipt that runs one repository is the defect §28b names",
  );
});

test("consumer-plants: a MULTI-LINE import is a consumer", () => {
  // The regression that produced this test. The first specifier pattern was
  // anchored on `import … "…"` bounded by `[^;\n]`, which cannot cross a
  // newline, so `import {\n  a,\n} from "./x.ts"` was invisible — and against
  // the real subject above it reported 2 consumers where the tree holds 6.
  const base = createTempDir("consumer-plants-multiline-");
  const src = join(base, "src");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "helper.ts"), "export const helper = 1;\n", "utf8");
  writeFileSync(
    join(src, "one-line.test.ts"),
    'import { helper } from "./helper.ts";\nexport const a = helper;\n',
    "utf8",
  );
  writeFileSync(
    join(src, "multi-line.test.ts"),
    'import {\n  helper,\n} from "./helper.ts";\nexport const b = helper;\n',
    "utf8",
  );
  const closure = consumerClosure(join(src, "helper.ts"), [
    { name: "planted", root: base, sources: ["src"], testFile: (p) => p.endsWith(".test.ts"), runner: "node-test" },
  ]);
  assert.equal(closure.failure, null);
  assert.deepEqual(
    closure.plants.map((path) => path.slice(src.length + 1)).sort(),
    ["multi-line.test.ts", "one-line.test.ts"],
    "both spellings of the same import must produce the same consumer",
  );
});

test("consumer-plants: an empty universe is a refusal on every input", () => {
  const base = createTempDir("consumer-plants-empty-");
  const src = join(base, "src");
  mkdirSync(src, { recursive: true });

  // INPUT 1 — nothing scanned.
  const nothingScanned = consumerClosure(join(src, "absent.ts"), [
    { name: "planted", root: base, sources: ["does-not-exist"], testFile: () => true, runner: "node-test" },
  ]);
  assert.match(nothingScanned.failure ?? "", /scanned ZERO source files/u);

  // The subject itself missing is its own answer, not a clean one.
  writeFileSync(join(src, "lonely.ts"), "export const lonely = 1;\n", "utf8");
  const absentSubject = consumerClosure(join(src, "absent.ts"), [
    { name: "planted", root: base, sources: ["src"], testFile: () => true, runner: "node-test" },
  ]);
  assert.match(absentSubject.failure ?? "", /does not exist/u);

  // INPUT 2 — scanned files exist and NOT ONE reaches the subject.
  const noConsumers = consumerClosure(join(src, "lonely.ts"), [
    { name: "planted", root: base, sources: ["src"], testFile: () => true, runner: "node-test" },
  ]);
  assert.equal(noConsumers.consumers.length, 0);
  assert.match(noConsumers.failure ?? "", /NOT ONE of \d+ scanned files/u);

  // INPUT 3 — consumers exist but NONE is a test. A work list of zero plants
  // is not "nothing to re-run"; it is "this module's consumers are unguarded".
  writeFileSync(join(src, "user.ts"), 'import { lonely } from "./lonely.ts";\nexport const u = lonely;\n', "utf8");
  const noPlants = consumerClosure(join(src, "lonely.ts"), [
    {
      name: "planted",
      root: base,
      sources: ["src"],
      testFile: (path) => path.endsWith(".test.ts"),
      runner: "node-test",
    },
  ]);
  assert.equal(noPlants.consumers.length, 1);
  assert.match(noPlants.failure ?? "", /NOT ONE of them is a test/u);

  // THE INERT DIRECTION — once a test consumer exists, the closure is
  // believed. Without this, a `consumerClosure` that refused every input would
  // satisfy all three assertions above.
  writeFileSync(
    join(src, "user.test.ts"),
    'import { lonely } from "./lonely.ts";\nexport const t = lonely;\n',
    "utf8",
  );
  const healthy = consumerClosure(join(src, "lonely.ts"), [
    {
      name: "planted",
      root: base,
      sources: ["src"],
      testFile: (path) => path.endsWith(".test.ts"),
      runner: "node-test",
    },
  ]);
  assert.equal(healthy.failure, null);
  assert.deepEqual(healthy.plants.map((path) => path.slice(src.length + 1)), ["user.test.ts"]);
});
