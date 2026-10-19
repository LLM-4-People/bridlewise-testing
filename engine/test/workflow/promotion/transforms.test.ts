/**
 * THE DERIVED FILES (merge-door-final §6.2, T-X1..T-X4): the manifest
 * derivation's every rule, driven pure, and the lockfile derivation through
 * the ONE command runner over a real repository (an errored run is retried,
 * then refused as the machine's; a failed one is the change's).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { deriveManifest, type ManifestContext } from "../../../src/workflow/promotion/transforms.ts";
import { PromotionError } from "../../../src/workflow/promotion/codes.ts";
import { SOURCE, SOURCE_LOCK, SOURCE_MANIFEST, json, promotionFixture } from "./promotion-fixture.ts";

const context = (overrides: Partial<ManifestContext> = {}): ManifestContext => ({
  path: "package.json",
  isProjected: (path) => path.startsWith("product/"),
  importedPackages: new Set(["zod"]),
  tsconfigTypes: new Set(),
  lockPackages: SOURCE_LOCK.packages,
  ...overrides,
});

test("T-X1: dev scripts and devDependencies drop, a chain's segment that runs a dropped script or names an unprojected path is pruned, and the bytes are JSON.stringify(v, null, 2) + newline", () => {
  const manifest = {
    ...SOURCE_MANIFEST,
    scripts: { ...SOURCE_MANIFEST.scripts, check: "npm run test && npm run build && node dev/tool.ts && tsc --noEmit", lint: "node product/main.ts" },
    devDependencies: { ...SOURCE_MANIFEST.devDependencies, "@types/node": "^24.0.0" },
  };
  const derived = deriveManifest(json(manifest), ["build", "check"], context({ tsconfigTypes: new Set(["node"]) }));
  const value = JSON.parse(derived.text) as Record<string, Record<string, string>>;
  assert.equal(derived.text, `${JSON.stringify(value, null, 2)}\n`);
  assert.deepEqual(Object.keys(value), Object.keys(manifest), "every top-level key kept, in source order");
  assert.deepEqual(value["scripts"], { build: "vite build", check: "npm run build && tsc --noEmit" });
  assert.deepEqual(value["devDependencies"], { vite: "^1.0.0", typescript: "^5.0.0", "@types/node": "^24.0.0" });
  assert.deepEqual(derived.explanation.droppedScripts.map((entry) => entry.name), ["test", "lint"]);
  assert.deepEqual(derived.explanation.prunedSegments.map((entry) => [entry.segment, entry.reason]), [
    ["npm run test", "runs the dropped script test"],
    ["node dev/tool.ts", "names dev/tool.ts, which the projection does not carry"],
  ]);
  assert.deepEqual(derived.explanation.keptDevDependencies.map((entry) => entry.name).sort(), ["@types/node", "typescript", "vite"]);
  assert.deepEqual(derived.explanation.droppedDevDependencies, ["tscalias", "devtool"], "the npm: alias providing tsc is never the owner");
});

test("T-X2: a new runtime dependency crosses verbatim", () => {
  const derived = deriveManifest(json({ ...SOURCE_MANIFEST, dependencies: { ...SOURCE_MANIFEST.dependencies, undici: "^8.0.0" } }), ["build"], context());
  assert.deepEqual(JSON.parse(derived.text).dependencies, { zod: "^1.0.0", undici: "^8.0.0" });
});

test("T-X3: an emptied script, shell syntax other than &&, and two real owners of one command are refused by code", () => {
  const refused = (manifest: unknown, keep: readonly string[]): string => {
    try {
      deriveManifest(json(manifest), keep, context());
    } catch (error) {
      assert.ok(error instanceof PromotionError, String(error));
      return error.promotionCode;
    }
    assert.fail("the derivation did not refuse");
  };
  assert.equal(refused({ ...SOURCE_MANIFEST, scripts: { key: "node dev/tool.ts" } }, ["key"]), "promotion_manifest_script_emptied");
  for (const script of ["vite build; rm -rf dist", "vite build || true", "vite build | tee log", "echo $(pwd)", "vite build > log"]) {
    assert.equal(refused({ ...SOURCE_MANIFEST, scripts: { build: script } }, ["build"]), "promotion_manifest_script_unparseable", script);
  }
  // PC-4: an unspaced `&&`, a background `&` and a second line are shell syntax the segment split cannot see.
  for (const script of ["tsc&&vite build", "vite build & tsc", "vite build\ntsc"]) {
    assert.equal(refused({ ...SOURCE_MANIFEST, scripts: { build: script } }, ["build"]), "promotion_manifest_script_unparseable", script);
  }
  // PC-4: a kept script the source does not declare (a typo, a rename) is refused, never silently dropped.
  assert.equal(refused(SOURCE_MANIFEST, ["build", "chekc"]), "promotion_manifest_script_missing");
  const lock = { ...SOURCE_LOCK.packages, "node_modules/vite-fork": { version: "1.0.0", bin: { vite: "bin/vite.js" } } };
  assert.throws(
    () => deriveManifest(json({ ...SOURCE_MANIFEST, devDependencies: { ...SOURCE_MANIFEST.devDependencies, "vite-fork": "^1.0.0" } }), ["build"], context({ lockPackages: lock })),
    (error: unknown) => error instanceof PromotionError && error.promotionCode === "promotion_manifest_bin_ambiguous" && JSON.stringify(error.facts["owners"]) === JSON.stringify(["vite", "vite-fork"]),
  );
});

test("PC-4: the command a kept segment runs is found behind environment assignments and an npx / npm exec launcher", () => {
  for (const check of ["NODE_OPTIONS=--max-old-space-size=4096 tsc --noEmit", "npx --yes tsc --noEmit", "npm exec -- tsc --noEmit", "CI=1 FORCE=1 npx tsc"]) {
    const derived = deriveManifest(json({ ...SOURCE_MANIFEST, scripts: { build: "vite build", check } }), ["build", "check"], context());
    assert.deepEqual(Object.keys(JSON.parse(derived.text).devDependencies).sort(), ["typescript", "vite"], check);
  }
});

test("M9: concurrent plans of the same inputs derive the lockfile in scratch directories of their own", async () => {
  const fixture = promotionFixture("promotion-x4-race");
  fixture.commit(SOURCE, { "package.json": json({ ...SOURCE_MANIFEST, dependencies: { ...SOURCE_MANIFEST.dependencies, undici: "^8.0.0" } }) });
  const plans = await Promise.all([fixture.plan(), fixture.plan(), fixture.plan()]);
  for (const plan of plans) assert.deepEqual(plan.refusals, []);
  assert.equal(new Set(plans.map((plan) => plan.projection.tree)).size, 1, "the same inputs, the same projected tree");
});

test("T-X4: the lockfile is derived by the registry command; a cache miss is errored, retried with backoff, then refused as the machine's; a resolution error is the change's", async () => {
  const fixture = promotionFixture("promotion-x4");
  fixture.commit(SOURCE, { "package.json": json({ ...SOURCE_MANIFEST, dependencies: { ...SOURCE_MANIFEST.dependencies, undici: "^8.0.0" } }) });
  const derived = await fixture.plan();
  assert.deepEqual(derived.refusals, []);
  const lock = JSON.parse(fixture.git(["cat-file", "blob", `${derived.projection.tree}:package-lock.json`])) as { packages: Record<string, unknown> };
  assert.deepEqual(Object.keys(lock.packages), ["", "node_modules/typescript", "node_modules/undici", "node_modules/vite", "node_modules/zod"]);
  assert.equal(fixture.lockfileAttempts(), 1);
  // Memoized by its inputs: a re-plan runs no command.
  await fixture.plan();
  assert.equal(fixture.lockfileAttempts(), 1);

  fixture.commit(SOURCE, { "package.json": json({ ...SOURCE_MANIFEST, dependencies: { ...SOURCE_MANIFEST.dependencies, undici: "^8.1.0" } }) });
  fixture.markLockfile("enotcached");
  const waits: number[] = [];
  const errored = await fixture.plan({ retries: 2, sleep: async (ms) => { waits.push(ms); } });
  assert.deepEqual(errored.refusals.map((entry) => entry.code), ["promotion_transform_errored"]);
  assert.match(errored.refusals[0]!.message, /attempt 3 of 3/u);
  assert.match(errored.refusals[0]!.message, /ENOTCACHED/u);
  assert.deepEqual(waits, [1, 2], "a doubling backoff between the three attempts");
  assert.equal(fixture.lockfileAttempts(), 4);
  assert.deepEqual(errored.projection.underived, ["package-lock.json"]);

  const broken = promotionFixture("promotion-x4-failed");
  broken.commit(SOURCE, { "package.json": json({ ...SOURCE_MANIFEST, dependencies: { ...SOURCE_MANIFEST.dependencies, undici: "^9.0.0" } }) });
  broken.markLockfile("broken");
  const failed = await broken.plan({ retries: 2, sleep: async () => undefined });
  assert.deepEqual(failed.refusals.map((entry) => entry.code), ["promotion_transform_failed"]);
  assert.equal(broken.lockfileAttempts(), 1, "a failure is never retried");
});
