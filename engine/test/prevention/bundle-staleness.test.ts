/**
 * Bundle-staleness prevention test.
 *
 * Root cause: `dist/bundle.js` was built Jul 22; `src/config.ts` +
 * `src/root-policy.ts` changed Jul 24. The stale bundle's
 * `loadPinnedConfigSnapshot` validated the config against a stale schema →
 * `config_schema_invalid` → the Landlock env-var fast-path failed → disk
 * denied. The existing hash-binding test only verified the on-disk bundle
 * SHA256 matched the root-policy pin — it did NOT verify the bundle was
 * built from the CURRENT source. So a stale bundle (old source, old pin)
 * passed the hash check while silently breaking the fast-path.
 *
 * This test catches staleness directly: it rebuilds the bundle in-memory
 * (write:false, no disk side effects) through the SAME build as
 * `scripts/build-bundle.ts` (its `buildBundleInMemory` — DRY, one build), and
 * requires the on-disk
 * bundle to be those bytes. If source changed but the bundle was not rebuilt,
 * the bytes differ → the test fails (deny-by-default: the bundle MUST be
 * rebuildable from the current source).
 *
 * No digest of the bundle is committed (#221): a committed pin rewrote one
 * line of root-policy.ts on every engine change, conflicted on nearly every
 * merge, and was compared by nothing at runtime. The rebuild comparison is the
 * whole staleness proof, and publication is a pure function of the sources
 * (FR-15): publishing into an empty destination and over an older bundle
 * gives the same bytes.
 *
 * GUARD SUBJECT: the shipped bundle is rebuilt from current source — a stale bundle is refused
 * GUARD OWNS: scripts/build-bundle.ts — the rebuild comparison
 * GUARD PLANT: edit a source module that the bundle DOES tree-shake in (a tree-shaken export is the inert first plant — it changes no bundle bytes) without rebuilding; the rebuilt bytes must differ from the on-disk bytes
 * GUARD DRIVEN: rebuild the bundle in memory from the live source tree and compare it byte for byte with the on-disk bundle — the same build path `harness sync` runs
 * GUARD LIVENESS: the on-disk bundle is asserted to exist FIRST — a verdict read against a missing bundle is not a staleness measurement
 */

import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";

import { sha256 } from "../../src/kernel/integrity.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { buildBundleInMemory, bundleFreshness, publishBundle } from "../../scripts/build-bundle.ts";

import { createTempDir } from "../support/temp-dir.ts";
import { requireHost } from "../support/host-requirement.ts";

const ROOT = process.cwd();
const bundlePath = join(ROOT, ROOT_POLICY.selfProtection.bundleRelativePath);

// The remedy guidance this guard prints: the canonical one-shot
// (`harness sync --with-bundle`), which builds the bundle with every other
// generated value in a single invocation.
const BUNDLE_MISSING_REMEDY =
  `dist/bundle.js must exist (run "node src/cli.ts harness sync --with-bundle" to build it)`;
const STALENESS_REMEDY =
  `Run "node src/cli.ts harness sync --with-bundle" after a src/ change — it rebuilds the bundle from the current source.`;

test("BundleStaleness: dist/bundle.js exists on disk", () => {
  assert.ok(existsSync(bundlePath), BUNDLE_MISSING_REMEDY);
});

test("BundleStaleness: the tree commits no digest of the bundle (a build output is the build's to report, #221)", () => {
  assert.equal("bundleSha256" in ROOT_POLICY.selfProtection, false, "root-policy.ts holds no bundle pin");
  assert.equal(/bundleSha256:\s*"[0-9a-f]{64}"/u.test(readFileSync(join(ROOT, ROOT_POLICY.sourcePath), "utf8")), false, "no bundle digest literal in root-policy.ts");
});

test("BundleStaleness: every bundle remedy names the canonical one-shot", () => {
  for (const [label, text] of [["the bundle-missing remedy", BUNDLE_MISSING_REMEDY], ["the staleness remedy", STALENESS_REMEDY]] as const) {
    assert.ok(text.includes("node src/cli.ts harness sync --with-bundle"), `${label} must name the one-shot: got "${text}"`);
  }
});

async function rebuiltBundleText(): Promise<string> {
  const rebuiltText = (await buildBundleInMemory()).text;
  assert.ok(rebuiltText.length > 0, "the build produced an empty bundle — the bundle entry is missing or the build config is broken");
  return rebuiltText;
}

test("BundleStaleness: rebuilding from current source reproduces the on-disk bundle byte for byte (no staleness)", async () => {
  requireHost(existsSync(bundlePath), `the built bundle at ${bundlePath} (the checkout setup's bundle step builds it)`);
  assert.equal(
    (await rebuiltBundleText()) === readFileSync(bundlePath, "utf8"),
    true,
    `Stale bundle: rebuilding dist/bundle.js from the current source produced different bytes than the on-disk copy. ` +
      STALENESS_REMEDY,
  );
});

// FR-15 (verify/friction-round-a1b.md NF-08): publication once kept a previous
// same-source bundle, so a fresh checkout and an old one disagreed. The
// published bytes and their reported digest are a pure function of the build.
test("BundleStaleness: the published bundle and its digest are a pure function of the sources, never of the bundle on disk before", async () => {
  const rebuilt = await rebuiltBundleText();
  const fresh = join(createTempDir("bundle-fresh-"), "bundle.js");
  const old = join(createTempDir("bundle-old-"), "bundle.js");
  writeFileSync(old, `${rebuilt}\n// an older generation\n`, "utf8");
  const freshResult = publishBundle(rebuilt, fresh);
  const oldResult = publishBundle(rebuilt, old);
  assert.deepEqual(oldResult, freshResult, "the digest does not depend on history");
  assert.equal(readFileSync(old, "utf8"), readFileSync(fresh, "utf8"), "the published bytes do not depend on history");
  assert.equal(freshResult.bundleSha256, sha256(rebuilt), "the reported digest is the published bytes' own");

  // An unchanged republish leaves the file untouched.
  const metadata = () => {
    const { ino, mode, size, mtimeNs, ctimeNs } = statSync(fresh, { bigint: true });
    return { ino, mode, size, mtimeNs, ctimeNs };
  };
  const before = metadata();
  assert.deepEqual(publishBundle(readFileSync(fresh, "utf8"), fresh), freshResult);
  assert.deepEqual(metadata(), before, "an unchanged artifact is not renamed or rewritten");
  assert.equal(existsSync(`${fresh}.sha256`), false, "no bundle.js.sha256 sidecar (wf1a-design L6)");

  // Every byte counts: a changed field republishes under a new digest.
  const changedField = rebuilt.replace(/(binaryStamp: ")[0-9a-f]{64}/, `$1${"c".repeat(64)}`);
  assert.notEqual(changedField, rebuilt);
  assert.notEqual(publishBundle(changedField, fresh).bundleSha256, freshResult.bundleSha256);
});

// The check `harness check` runs (`build-bundle --check`, its bundle step): no committed digest, a rebuild compared
// byte for byte. A hand edit of one byte is stale, an absent bundle is absent, a fresh copy is current.
test("BundleStaleness: harness check's freshness verdict refuses an edited bundle and names an absent one", async () => {
  const rebuilt = await rebuiltBundleText();
  const dir = createTempDir("bundle-check-");
  const copy = join(dir, "bundle.js");
  writeFileSync(copy, rebuilt, "utf8");
  assert.equal((await bundleFreshness(copy)).status, "current");
  writeFileSync(copy, `${rebuilt}// edited by hand\n`, "utf8");
  assert.deepEqual([(await bundleFreshness(copy)).fresh, (await bundleFreshness(copy)).status], [false, "stale"]);
  assert.equal((await bundleFreshness(join(dir, "missing.js"))).status, "absent");
});

// #318: esbuild names each module by its path from the build's directory, so a checkout whose dependencies resolve
// upward (a candidate reaching its source's node_modules) once built `// ../../…/node_modules/zod/…` where the
// source built `// node_modules/zod/…`, and the byte comparison called a fresh bundle stale.
test("BundleStaleness: two checkouts of one tree build the same bytes, wherever node_modules sits", async () => {
  // The bundle's own sources, as esbuild read them (paths relative to the engine root).
  const here = await buildBundleInMemory();
  const inputs = here.inputs.filter((path) => !path.includes("node_modules/"));
  assert.ok(inputs.length > 100, `the bundle's sources were found (liveness): ${String(inputs.length)}`);

  // Every package.json and tsconfig.json esbuild consults for them, from each source's folder up to the repository's.
  const repository = dirname(ROOT);
  const configs = new Set<string>();
  for (const input of inputs) {
    for (let folder = dirname(join(ROOT, input)); folder.startsWith(repository); folder = dirname(folder)) {
      for (const name of ["package.json", "tsconfig.json"]) {
        if (existsSync(join(folder, name))) configs.add(relative(ROOT, join(folder, name)));
      }
    }
  }

  // The second checkout sits three folders below the node_modules it resolves upward, as a candidate checkout does.
  const base = createTempDir("bundle-location-");
  symlinkSync(join(ROOT, "node_modules"), join(base, "node_modules"));
  const copy = join(base, "a", "b", "engine");
  for (const path of [...inputs, ...configs]) {
    mkdirSync(dirname(join(copy, path)), { recursive: true });
    copyFileSync(join(ROOT, path), join(copy, path));
  }
  const [hereLines, thereLines] = [here.text.split("\n"), (await buildBundleInMemory(copy)).text.split("\n")];
  assert.ok(here.text.includes("// node_modules/zod/"), "the bundle names its dependencies (liveness)");
  const differs = hereLines.findIndex((line, index) => thereLines[index] !== line);
  assert.deepEqual(
    differs === -1 && hereLines.length === thereLines.length ? [] : [`line ${String(differs + 1)}`, hereLines[differs], thereLines[differs]],
    [],
    "the bundle is a function of the sources, never of the checkout's location",
  );
});
