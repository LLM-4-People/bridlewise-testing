/**
 * ONE WRITER SIGNS THE DISPOSITION MANIFEST, AND A STALE PIN REFUSES.
 *
 * ── THE DEFECT ────────────────────────────────────────────────────────────
 *
 * `harness regenerate` carried an inlined copy of the manifest logic. Its own
 * comment said why — importing the builder-layer verification module would put
 * `src/ -> scripts/` into the runtime import graph, which the architecture
 * forbids — and the constraint was real. The copy was not the only way to
 * satisfy it, and it differed from the original in two ways that mattered:
 *
 *   - it read the file with a raw `JSON.parse` and checked two fields by
 *     hand, so the schema never saw the entries;
 *   - it wrote `policyHash` from the CURRENT policy UNCONDITIONALLY.
 *
 * The second is the one with teeth. A stale `policyHash` means the manifest
 * records dispositions made under discovery rules that no longer apply — the
 * exact state a renamed test directory produces — and rewriting it makes the
 * pin agree with the new policy while describing the old world. It was the
 * only path in the repository that could re-bless a stale pin, and it made one
 * of the refusals that guard the test surface passable.
 *
 * The shared half now lives in the runtime layer where both callers may import
 * it, so there is one writer. This file holds the evidence that the
 * distinction the copy erased is now enforced: a stale SIGNATURE heals, a
 * stale POLICY refuses.
 *
 * Every input is built here, in memory, from the manifest's own owner. No test
 * writes to the live manifest.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import test from "node:test";

import { HarnessError } from "../../src/kernel/errors.ts";
import { canonicalHash } from "../../src/kernel/integrity.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import {
  createTestSurfaceDispositionManifest,
  parseTestSurfaceDispositionManifestText,
  resignTestSurfaceDispositionManifest,
  serializeTestSurfaceDispositionManifest,
  testSurfacePolicyHash,
} from "../../src/kernel/test-surface-manifest.ts";
import { engineModuleSourceRelative } from "../support/module-resolver.ts";
import { walk } from "../../scripts/verification/source-walk.ts";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..", "..");
const MANIFEST_PATH = join(
  REPOSITORY_ROOT,
  ROOT_POLICY.verification.testDiscovery.dispositionRegistry.manifestPath,
);

/** The live manifest's text — read only, never written by this file. */
function liveManifestText(): string {
  return readFileSync(MANIFEST_PATH, "utf8");
}

test("the live manifest round-trips through the owner byte-for-byte", () => {
  // LIVENESS on the whole mechanism, and the format contract in one line: if
  // re-signing produced different bytes, `harness regenerate` would rewrite
  // the file on every run and every diff would be noise.
  const text = liveManifestText();
  const resigned = resignTestSurfaceDispositionManifest(text);
  assert.equal(resigned.status, "current");
  assert.equal(resigned.text, text);

  // And the population is real, so a green verdict is not about an empty file.
  const manifest = parseTestSurfaceDispositionManifestText(text);
  assert.ok(manifest.entries.length > 100, `entries: ${manifest.entries.length}`);
});

test("a stale SIGNATURE heals, and heals to what the one writer would have written", () => {
  const manifest = parseTestSurfaceDispositionManifestText(liveManifestText());
  // The plant: a signature that is valid in shape and wrong in value, which is
  // exactly what a hand edit to an entry leaves behind.
  const damaged = serializeTestSurfaceDispositionManifest({
    ...manifest,
    integrityHash: "0".repeat(64),
  });
  assert.notEqual(damaged, liveManifestText());

  const healed = resignTestSurfaceDispositionManifest(damaged);
  assert.equal(healed.status, "regenerated");
  // The healed bytes are the ONE writer's output, not this function's idea of
  // the format — that is what "one writer" has to mean to be worth anything.
  assert.equal(
    healed.text,
    serializeTestSurfaceDispositionManifest(createTestSurfaceDispositionManifest(manifest.entries)),
  );
  assert.equal(healed.text, liveManifestText());
});

test("a stale POLICY refuses, and the refusal names both hashes", () => {
  const manifest = parseTestSurfaceDispositionManifestText(liveManifestText());
  const currentPolicyHash = testSurfacePolicyHash();
  assert.equal(manifest.policyHash, currentPolicyHash);

  // The plant is the state a renamed test directory produces: the entries are
  // untouched and the policy they were recorded under is gone. Supplied from
  // outside as a hash that is well-formed and not the current one, so the
  // refusal cannot be about a malformed field.
  const stalePolicyHash = "1".repeat(64);
  const stale = serializeTestSurfaceDispositionManifest({
    ...manifest,
    policyHash: stalePolicyHash,
  });

  assert.throws(
    () => resignTestSurfaceDispositionManifest(stale),
    (error: unknown) => {
      assert.ok(error instanceof HarnessError, `expected HarnessError, got ${String(error)}`);
      assert.equal(error.code, "test_surface_disposition_policy_stale");
      assert.match(error.message, /policyHash is stale/u);
      return true;
    },
  );

  // THE POINT, STATED AS AN ASSERTION: the refusal is not merely a different
  // message — nothing came back that a caller could write to disk. The old
  // inlined heal returned a manifest here, carrying the CURRENT policy hash
  // over the OLD entries, and that value is what re-blessed the pin.
  let produced: unknown = null;
  try {
    produced = resignTestSurfaceDispositionManifest(stale);
  } catch {
    produced = null;
  }
  assert.equal(produced, null);
});

test("THE CONSERVATION PINS ARE NOT THE POLICY: restating them keeps the manifest current (the conservation identity checks them against the git index); any other discovery change stales it, and there is no door that re-signs it (design M4)", () => {
  const discovery = ROOT_POLICY.verification.testDiscovery;
  const { surfaceConservation: _pins, ...policy } = discovery;
  assert.equal(testSurfacePolicyHash(), canonicalHash(policy), "the pinned policy is the discovery policy without its conservation pins");
  assert.notEqual(testSurfacePolicyHash(), canonicalHash(discovery), "the pins are not part of it");
  const manifest = parseTestSurfaceDispositionManifestText(liveManifestText());
  assert.equal(manifest.policyHash, testSurfacePolicyHash(), "the live manifest is signed under the pin-free policy");
  assert.equal(resignTestSurfaceDispositionManifest.length, 1, "the re-sign takes the manifest text and nothing else: no token re-signs a stale policy");
});

test("a hand-edited entry is rejected by the SCHEMA, not by two checks", () => {
  const manifest = parseTestSurfaceDispositionManifestText(liveManifestText());
  const first = manifest.entries[0];
  assert.ok(first !== undefined);

  // An invented field. The replaced implementation validated `schemaVersion`
  // and `entries`-is-an-array by hand and let everything else through, so this
  // reached the signature and was signed into the manifest.
  const withExtraField = JSON.parse(serializeTestSurfaceDispositionManifest(manifest)) as {
    entries: Record<string, unknown>[];
  };
  withExtraField.entries[0] = { ...first, unexpectedField: "smuggled" };
  assert.throws(() => resignTestSurfaceDispositionManifest(`${JSON.stringify(withExtraField, null, 2)}\n`));

  // An invented disposition — a value the enum does not admit.
  const withBadDisposition = JSON.parse(serializeTestSurfaceDispositionManifest(manifest)) as {
    entries: Record<string, unknown>[];
  };
  withBadDisposition.entries[0] = { ...first, disposition: "definitely-fine" };
  assert.throws(() => resignTestSurfaceDispositionManifest(`${JSON.stringify(withBadDisposition, null, 2)}\n`));

  // BENIGN CONTROL: the same construction with nothing changed still heals, so
  // the two refusals above are about the edits and not about the rebuild.
  const untouched = JSON.parse(serializeTestSurfaceDispositionManifest(manifest)) as unknown;
  assert.equal(
    resignTestSurfaceDispositionManifest(`${JSON.stringify(untouched, null, 2)}\n`).status,
    "current",
  );
});

test("there is exactly one module that signs a disposition manifest", () => {
  // The structural half. `createTestSurfaceDispositionManifest` is the only
  // thing that computes the manifest's `integrityHash`, so the search is for a
  // SECOND place that assembles the signed object — the shape the inlined copy
  // had. Derived from the source, tree-wide, read as bytes.
  // The owner's src/-relative path, resolved from the tree — the fold moved it
  // under kernel/, so it is never spelled here.
  const owner = engineModuleSourceRelative("test-surface-manifest.ts");
  const signedRole = "complete-recognizable-test-surface-disposition";
  const searched: string[] = [];
  const offenders: string[] = [];

  for (const full of ["src", "scripts"].flatMap((root) => walk(join(REPOSITORY_ROOT, root), { exts: [".ts"] }))) {
    const relativePath = relative(REPOSITORY_ROOT, full).split(sep).join("/");
    if (relativePath === owner) continue;
    searched.push(relativePath);
    // The role literal is what a writer must state to assemble a signed
    // manifest. A reader never needs it.
    if (readFileSync(full, "utf8").includes(`"${signedRole}"`)) offenders.push(relativePath);
  }

  assert.ok(searched.length > 100, `the walk found ${searched.length} files`);
  assert.deepEqual(
    offenders,
    [],
    `${offenders.length} module(s) besides ${owner} assemble a signed disposition manifest: ` +
      `${offenders.join(", ")}. Extend the owner; a second writer of a pin is a pin that can be ` +
      `re-blessed.`,
  );

  // LIVENESS on the detector itself: it must find the owner when the owner is
  // not excluded, otherwise the empty answer above is about a scan that reads
  // nothing.
  const ownerSource = readFileSync(join(REPOSITORY_ROOT, owner), "utf8");
  assert.ok(ownerSource.includes(`"${signedRole}"`));
});
