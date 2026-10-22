/**
 * THE DERIVED FILES (merge-door-final §6.2, T-X1..T-X4): the manifest and
 * Makefile derivations' every rule, driven pure, and the lockfile derivation through
 * the ONE command runner over a real repository (an errored run is retried,
 * then refused as the machine's; a failed one is the change's).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { deriveMakefile, deriveManifest, type ManifestContext } from "../../../src/workflow/promotion/transforms.ts";
import { PromotionError } from "../../../src/workflow/promotion/codes.ts";
import { createTempDir } from "../../support/temp-dir.ts";
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

/** The source repository's own Makefile, as `main` holds it (the product keeps the rules a product checkout can run). */
const MAIN_MAKEFILE = [
  ".PHONY: install typecheck public-test test check dev clean",
  "",
  "install:", "\tnpm ci", "\tnpm --prefix engine ci", "\tnpm run bootstrap:hooks", "\tchmod 600 engine/bridlewise.config.json",
  "",
  "typecheck:", "\tnpm run typecheck", "\tnpm --prefix engine run typecheck",
  "",
  "public-test:", "\tnpm run test:public",
  "",
  "test: public-test",
  "",
  "check: typecheck public-test", "\tnpm run check:secrets",
  "",
  "# the local servers",
  "dev:", "\tnode scripts/sd.mjs start",
  "",
  "clean:", "\trm -rf dist engine/dist",
  "",
].join("\n");

test("the makefile transform keeps the listed rules verbatim, in source order, and narrows .PHONY to them", () => {
  const derived = deriveMakefile(MAIN_MAKEFILE, ["clean", "install", "typecheck", "dev"], "Makefile");
  assert.equal(derived.text, [
    ".PHONY: install typecheck dev clean",
    "",
    "install:", "\tnpm ci", "\tnpm --prefix engine ci", "\tnpm run bootstrap:hooks", "\tchmod 600 engine/bridlewise.config.json",
    "",
    "typecheck:", "\tnpm run typecheck", "\tnpm --prefix engine run typecheck",
    "",
    "# the local servers",
    "dev:", "\tnode scripts/sd.mjs start",
    "",
    "clean:", "\trm -rf dist engine/dist",
    "",
  ].join("\n"), "a kept rule's comment, header and recipe cross as they are");
  assert.deepEqual(derived.explanation, { path: "Makefile", keptTargets: ["install", "typecheck", "dev", "clean"], droppedTargets: ["public-test", "test", "check"] });
  assert.equal(deriveMakefile(MAIN_MAKEFILE, ["install", "typecheck", "public-test", "test", "check", "dev", "clean"], "Makefile").text, MAIN_MAKEFILE, "keeping every rule is the source itself");
  assert.equal(deriveMakefile("# recipes\n.PHONY: a b\n\na:\n\techo a\n\nb: a\n\techo b\n", ["a"], "Makefile").text, "# recipes\n.PHONY: a\n\na:\n\techo a\n", "a comment above .PHONY stays with it");
  assert.equal(deriveMakefile("a: dist/out.txt\n\techo a\n", ["a"], "Makefile").text, "a: dist/out.txt\n\techo a\n", "a prerequisite that is a file, not a rule, crosses");
});

test("the makefile transform refuses by code: a missing target, a kept rule needing a dropped one, and every line outside its grammar", () => {
  const refused = (text: string, keep: readonly string[]): PromotionError => {
    try {
      deriveMakefile(text, keep, "Makefile");
    } catch (error) {
      assert.ok(error instanceof PromotionError, String(error));
      return error;
    }
    assert.fail("the derivation did not refuse");
  };
  const missing = refused(MAIN_MAKEFILE, ["install", "instal"]);
  assert.equal(missing.promotionCode, "promotion_makefile_target_missing");
  assert.deepEqual(missing.facts["targets"], ["instal"]);
  for (const [keep, target, prerequisites] of [[["test"], "test", ["public-test"]], [["typecheck", "check"], "check", ["public-test"]], [["check"], "check", ["typecheck", "public-test"]]] as const) {
    const dropped = refused(MAIN_MAKEFILE, keep);
    assert.equal(dropped.promotionCode, "promotion_makefile_prerequisite_dropped", JSON.stringify(keep));
    assert.deepEqual([dropped.facts["target"], dropped.facts["prerequisites"]], [target, prerequisites], JSON.stringify(keep));
  }
  const outside: readonly (readonly [string, number])[] = [
    ["X = 1\na:\n\techo $(X)\n", 1],
    ["X := 1\na:\n\techo a\n", 1],
    ["a:\n\techo a\nifeq ($(X),1)\nendif\n", 3],
    ["include other.mk\na:\n\techo a\n", 1],
    ["%.o: %.c\n\tcc $<\n", 1],
    ["a b:\n\techo a\n", 1],
    ["a::\n\techo a\n", 1],
    ["a:\n\techo a \\\n\t  more\n", 2],
    ["\techo orphan\na:\n\techo a\n", 1],
    ["a:\n    echo spaces\n", 2],
    ["a:\n\techo a\n\n\techo after a blank line\n", 4],
    [".PHONY: a\n.PHONY: b\na:\n\techo a\n", 2],
    ["a:\n\techo a\n.PHONY: a\n", 3],
    ["a:\n\techo a\n\na:\n\techo again\n", 4],
    ["# a comment\n\na:\n\techo a\n", 2],
    ["a:\n\techo a\n# a comment that ends the file\n", 4],
    ["a: ; echo a\n", 1],
    ["a:\r\n\techo a\r\n", 1],
  ];
  for (const [text, line] of outside) {
    const error = refused(text, ["a"]);
    assert.equal(error.promotionCode, "promotion_makefile_unparseable", JSON.stringify(text));
    assert.equal(error.facts["line"], line, JSON.stringify(text));
  }
});

test("the makefile transform refuses a kept recipe that runs make on a target it drops, in every spelling, and judges only this Makefile", () => {
  const refusal = (recipe: string, keep: readonly string[] = ["a"]): PromotionError | null => {
    try {
      deriveMakefile(`a:\n\t${recipe}\n\nb:\n\techo b\n\nc:\n\techo c\n`, keep, "Makefile");
      return null;
    } catch (error) {
      assert.ok(error instanceof PromotionError, String(error));
      return error;
    }
  };
  for (const recipe of ["$(MAKE) b", "make b", "make -C . b", "${MAKE} b", "@$(MAKE) b", "-make b", "make -f Makefile b", "make --file=./Makefile b", "make --directory=. b", "make -s -j4 -k b", "make -j 4 b", "make -Cb/.. b", "$(MAKE) c b", "make VAR=1 b", "/usr/bin/make b", "gmake b", "bmake -C . b", "./make b", "/usr/local/bin/gmake -s b", "$(MAKE)"]) {
    const error = refusal(recipe, ["a", "c"]);
    assert.equal(error?.promotionCode, "promotion_makefile_recipe_target_dropped", recipe);
    assert.deepEqual([error.facts["target"], error.facts["line"], error.facts["targets"]], ["a", 2, recipe === "$(MAKE)" ? [] : ["b"]], recipe);
  }
  for (const recipe of ["$(MAKE) c", "make -C . c", "make -f Makefile c", "make -C guardian all", "make -C engine/guardian test", "make -f other.mk b", "echo build", "make -C ./sub b", "/usr/bin/make c", "gmake -C guardian all", "npm --prefix engine run build:bundle", "chmod 600 engine/bridlewise.config.json"]) {
    assert.equal(refusal(recipe, ["a", "c"]), null, `${recipe}: a kept target, or another Makefile's`);
  }
  for (const recipe of ["echo make b", "cd x && make b", "make b; echo", "make b | tee log", "make b > log", "$(MAKE) $(TARGET)", "make $$X", "make -C", "make -C /abs b", "make \"b\"", "make -C a -C b x", "make --bogus=1 c", "env make b", "make \\$x", "$(MAKE_CMD) b", "${SUBMAKE} b", "$(CC) -o x x.c", "FOO=1 make b", "FOO=1 node x.js", "cd x && $(SUB) b", "(cd x; make b)", "\"make\" b", "`which make` b", "echo ok; $(TOOL)"]) {
    const error = refusal(recipe, ["a", "c"]);
    assert.equal(error?.promotionCode, "promotion_makefile_unparseable", recipe);
    assert.equal(error.facts["line"], 2, recipe);
  }
});

test("the derived Makefile runs: `make -n` of every kept target succeeds, recursive make included", () => {
  const source = [
    ".PHONY: all build test lint",
    "",
    "all:", "\t$(MAKE) build", "\t@${MAKE} -s test",
    "",
    "build:", "\techo build",
    "",
    "test: build", "\techo test", "\tmake -C guardian all",
    "",
    "lint:", "\techo lint", "\tmake -C . lint-only",
    "",
  ].join("\n");
  const kept = ["all", "build", "test"];
  const derived = deriveMakefile(source, kept, "Makefile");
  const folder = createTempDir("derived-makefile-");
  writeFileSync(join(folder, "Makefile"), derived.text);
  for (const target of kept) {
    const run = spawnSync("make", ["-n", target], { cwd: folder, encoding: "utf8" });
    assert.equal(run.status, 0, `make -n ${target}: ${run.stderr}`);
  }
  assert.equal(spawnSync("make", ["-n", "lint"], { cwd: folder, encoding: "utf8" }).status, 2, "the dropped target is gone: make itself says so");
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
