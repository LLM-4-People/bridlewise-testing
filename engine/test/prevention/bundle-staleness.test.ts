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
 * (write:false, no disk side effects) using the SAME esbuild options as
 * `scripts/build-bundle.ts` (imported via `getBundleBuildOptions` — DRY,
 * single source of truth for the build config), seals it exactly as
 * publication does (the bundle embeds its own pin, so the pin is the digest
 * with that one literal normalised out, and the published text carries it —
 * `sealSelfPinnedSource`), and requires the on-disk bundle to be those bytes.
 * If source changed but the bundle was not rebuilt, the bytes differ → the
 * test fails (deny-by-default: the bundle MUST be rebuildable from the
 * current source).
 *
 * It also verifies the on-disk bundle exists and its self-pinned digest
 * matches the root-policy pin (the registry's own binding verdict), and that
 * the pin is a pure function of the sources (FR-15): publishing into an empty
 * destination and over a bundle carrying another pin gives the same bytes.
 *
 * GUARD SUBJECT: the shipped bundle is rebuilt from current source — a stale bundle that still matches the root-policy pin is refused
 * GUARD OWNS: scripts/build-bundle.ts + the root-policy bundleSha256 pin — the sealed-rebuild comparison
 * GUARD PLANT: edit a non-self-referential source module that the bundle DOES tree-shake in (a tree-shaken export is the inert first plant — it changes no bundle bytes) without rebuilding; the sealed rebuilt bytes must differ from the on-disk bytes
 * GUARD DRIVEN: rebuild the bundle in memory from the live source tree, seal it, and compare it byte for byte with the on-disk bundle — the same build path `harness sync` runs
 * GUARD LIVENESS: the on-disk bundle is asserted to exist and to match the root-policy pin FIRST — a verdict read against a missing or unpinned bundle is not a staleness measurement
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { build } from "esbuild";

import { InputError } from "../../src/kernel/errors.ts";
import { sha256 } from "../../src/kernel/integrity.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { SELF_PIN_PLACEHOLDER, sealSelfPinnedSource, verifyBindingById } from "../../src/workflow/hash-binding-registry.ts";
import { getBundleBuildOptions, publishBundle } from "../../scripts/build-bundle.ts";

import { createTempDir } from "../support/temp-dir.ts";
import { requireHost } from "../support/host-requirement.ts";

const ROOT = process.cwd();
const bundlePath = join(ROOT, ROOT_POLICY.selfProtection.bundleRelativePath);
const pinnedHash = ROOT_POLICY.selfProtection.bundleSha256;

// The remedy guidance this guard prints. Pointed at the canonical one-shot
// (`harness sync --with-bundle`), which builds the bundle, re-pins its
// sha256, and verifies in a single invocation — not the manual
// build-then-hand-pin path that costs a diagnosis cycle.
const BUNDLE_MISSING_REMEDY =
  `dist/bundle.js must exist (run "node src/cli.ts harness sync --with-bundle" to build it, re-pin its sha256, and verify in one pass)`;
const STALENESS_REMEDY =
  `Run "node src/cli.ts harness sync --with-bundle" after a src/ change — it rebuilds the bundle, re-pins bundleSha256, and verifies in one pass.`;

test("BundleStaleness: dist/bundle.js exists on disk", () => {
  assert.ok(
    existsSync(bundlePath),
    BUNDLE_MISSING_REMEDY,
  );
});

const BUNDLE_BINDING_ID = "root-policy-self-protection-bundle-sha256";
const bundleSource = ROOT_POLICY.selfProtection.bundleRelativePath;

test("BundleStaleness: the on-disk bundle's self-pinned digest matches the root-policy pin", () => {
  requireHost(existsSync(bundlePath), `the built bundle at ${bundlePath} (the checkout setup's bundle step builds it)`);
  const verdict = verifyBindingById(ROOT, BUNDLE_BINDING_ID);
  assert.equal(verdict.error, undefined, `the bundle binding could not be computed: ${verdict.error ?? ""}`);
  assert.equal(verdict.actual, pinnedHash, "the verdict reads the pin root-policy.ts carries");
  assert.equal(
    verdict.expected,
    pinnedHash,
    `On-disk dist/bundle.js digest (${verdict.expected.slice(0, 12)}) does not match the root-policy pin (${pinnedHash.slice(0, 12)}). ` +
      STALENESS_REMEDY,
  );
});

// The remedy text an operator reads when the bundle is stale or missing must
// name the canonical one-shot (`harness sync --with-bundle`: build -> re-pin
// -> verify in a single invocation), not the manual build-then-hand-pin path
// that costs a diagnosis cycle. This scans the real remedy sites (this file's
// own assertion messages and the hash-binding description; the CLI's own
// bundle_missing remedy went with its deleted re-exec) so a regression in ANY
// of them reddens.
test("BundleStaleness: every bundle remedy names the canonical one-shot", () => {
  const bindingSource = readFileSync(join(ROOT, "src/workflow/hash-binding-registry.ts"), "utf8");
  const bindingDescription = bindingSource.match(/root-policy-self-protection-bundle-sha256",\s*description: "([^"]+)"/)?.[1] ?? "";
  const sites: ReadonlyArray<readonly [string, string]> = [
    ["this file's bundle-missing remedy", BUNDLE_MISSING_REMEDY],
    ["this file's staleness remedy", STALENESS_REMEDY],
    ["hash-binding description", bindingDescription],
  ];
  for (const [label, text] of sites) {
    assert.ok(text.length > 0, `${label}: expected to locate the remedy text (witness — the scan found nothing)`);
    assert.ok(
      text.includes("node src/cli.ts harness sync --with-bundle"),
      `${label} must name the one-shot: got "${text}"`,
    );
    assert.ok(
      !/build-bundle\.ts["`]?\s+then\b/.test(text),
      `${label} must not prescribe the manual build-then-pin path: got "${text}"`,
    );
  }
});

async function rebuiltBundleText(): Promise<string> {
  const result = await build(getBundleBuildOptions());
  const rebuiltText = result.outputFiles?.[0]?.text;
  assert.ok(
    typeof rebuiltText === "string" && rebuiltText.length > 0,
    "esbuild produced no output files — the bundle entry is missing or the build config is broken",
  );
  return rebuiltText;
}

test("BundleStaleness: rebuilding from current source reproduces the on-disk bundle byte for byte (no staleness)", async () => {
  requireHost(existsSync(bundlePath), `the built bundle at ${bundlePath} (the checkout setup's bundle step builds it)`);
  const sealed = sealSelfPinnedSource(bundleSource, await rebuiltBundleText());
  assert.equal(sealed.digest, pinnedHash, `the rebuilt bundle's digest is not the pin. ${STALENESS_REMEDY}`);
  assert.equal(
    sealed.text === readFileSync(bundlePath, "utf8"),
    true,
    `Stale bundle: rebuilding dist/bundle.js from the current source produced different bytes than the on-disk copy. ` +
      STALENESS_REMEDY,
  );
});

// FR-15 (verify/friction-round-a1b.md NF-08): the pin was a function of
// HISTORY — the bundle embeds its own pin, and publication kept a previous
// same-source bundle, so a fresh checkout (no bundle) and an old one (a
// bundle carrying an older pin) converged on different committed pins.
// Sealing makes the bytes and the pin a pure function of the sources.
test("BundleStaleness: the published bundle and its pin are a pure function of the sources, never of the bundle on disk before", async () => {
  const rebuilt = await rebuiltBundleText();
  const pinOf = (text: string) => /bundleSha256: "([0-9a-f]{64})"/.exec(text)?.[1];
  const withPin = (text: string, pin: string) => text.replace(/(bundleSha256: ")[0-9a-f]{64}(")/, `$1${pin}$2`);
  const builtWithAnotherPin = withPin(rebuilt, "a".repeat(64));
  assert.notEqual(builtWithAnotherPin, rebuilt, "the witness changes the embedded pin");

  // Two fresh checkouts: one with no bundle, one holding a bundle that
  // carries another pin (an older generation). Same sources → same bytes.
  const fresh = join(createTempDir("bundle-fresh-"), "bundle.js");
  const old = join(createTempDir("bundle-old-"), "bundle.js");
  writeFileSync(old, withPin(rebuilt, "b".repeat(64)), "utf8");
  const freshResult = publishBundle(rebuilt, fresh);
  const oldResult = publishBundle(builtWithAnotherPin, old);
  assert.deepEqual(oldResult, freshResult, "the pin does not depend on history");
  assert.equal(readFileSync(old, "utf8"), readFileSync(fresh, "utf8"), "the published bytes do not depend on history");
  assert.equal(pinOf(readFileSync(fresh, "utf8")), freshResult.bundleSha256, "the published bundle carries its own digest");
  assert.equal(freshResult.bundleSha256, sha256(withPin(rebuilt, SELF_PIN_PLACEHOLDER)), "the digest is taken with the pin normalised out");

  // A fixed point: re-sealing the published bytes changes nothing, and an
  // unchanged republish leaves the file untouched.
  const metadata = () => {
    const { ino, mode, size, mtimeNs, ctimeNs } = statSync(fresh, { bigint: true });
    return { ino, mode, size, mtimeNs, ctimeNs };
  };
  const before = metadata();
  assert.deepEqual(publishBundle(readFileSync(fresh, "utf8"), fresh), freshResult);
  assert.deepEqual(metadata(), before, "an unchanged artifact is not renamed or rewritten");
  assert.equal(existsSync(`${fresh}.sha256`), false, "no bundle.js.sha256 sidecar (wf1a-design L6)");

  // Every other byte counts: a changed non-self integrity field republishes
  // under a new pin.
  const changedField = rebuilt.replace(/(binaryStamp: ")[0-9a-f]{64}/, `$1${"c".repeat(64)}`);
  assert.notEqual(changedField, rebuilt);
  assert.notEqual(publishBundle(changedField, fresh).bundleSha256, freshResult.bundleSha256);

  // A decoy spelled like the pin never acquires its exemption: the text is
  // ambiguous and publication refuses, typed and named.
  const decoy = `${rebuilt}\nconst unrelated = { bundleSha256: "${"d".repeat(64)}" };\n`;
  assert.throws(() => sealSelfPinnedSource(bundleSource, decoy), (error: unknown) =>
    error instanceof InputError && error.code === "input_error" && /ambiguous in dist\/bundle\.js \(2 occurrences\)/.test(error.message));
  // A bundle with no pin at all (its shape changed) is refused too.
  assert.throws(() => sealSelfPinnedSource(bundleSource, rebuilt.replace(/bundleSha256: "[0-9a-f]{64}"/, "bundleSha256: undefined")), (error: unknown) =>
    error instanceof InputError && /hash literal not found in dist\/bundle\.js/.test(error.message));
});
