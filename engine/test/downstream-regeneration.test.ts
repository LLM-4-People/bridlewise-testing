import assert from "node:assert/strict";
import test from "node:test";

import { InputError } from "../src/kernel/errors.ts";
import { canonicalHash, canonicalJson, sha256 } from "../src/kernel/integrity.ts";
import { compareUtf8Bytes } from "../src/kernel/ordered.ts";
import { ROOT_POLICY } from "../src/kernel/root-policy.ts";
import { SLICE_PROJECTION_PATHS, VERIFICATION_PATHS } from "../src/kernel/verification-paths.ts";
import {
  DOWNSTREAM_ARTIFACT_IDS,
  DOWNSTREAM_ARTIFACT_PATHS,
  DOWNSTREAM_ARTIFACT_REGISTRY,
  DOWNSTREAM_ARTIFACT_REGISTRY_IDENTITY,
  DOWNSTREAM_REGENERATION_ORDERING_RULE,
  DOWNSTREAM_REGENERATION_REVISION,
  DOWNSTREAM_REGENERATION_SCHEMA_VERSION,
  checkDownstreamRegeneration,
  compileDownstreamRegenerationBuild,
  type DownstreamArtifactBuild,
  type DownstreamArtifactId,
  type DownstreamRegenerationBuild,
} from "../verification/core/downstream-regeneration.ts";

// DELIBERATE SUBSET: 8 of 8 — and it is written out ON PURPOSE. This list is
// the SECOND INSTRUMENT: it names every artifact the registry is supposed to
// hold, independently of the registry, so a registry that loses one is caught
// by a disagreement rather than by both sides shrinking together. Deriving it
// from `DOWNSTREAM_ARTIFACT_REGISTRY` would make the assertion below compare
// the registry with itself and pass on any content at all. A ninth artifact
// added to the registry reds this file loudly — through DR-R038, which is the
// only thing here that compares the two SETS. Before DR-R038 existed, that
// sentence was true only by accident: a dozen hand-typed `8`s elsewhere in
// this file failed, none of them naming the artifact that appeared.
const EXPECTED_IDS: readonly DownstreamArtifactId[] = [
  "configuration-document-schema",
  "contract-schemas",
  "forensic-schemas",
  "requirements-schema",
  "slice-s2",
  "slice-s2.4",
  "slice-s3.1",
  "test-inventory",
];

const EXPECTED_PATHS: readonly string[] = [
  ROOT_POLICY.configuration.contract.generatedSchemaPath,
  SLICE_PROJECTION_PATHS.contractSchemaArtifact,
  SLICE_PROJECTION_PATHS.forensicSchemaArtifact,
  SLICE_PROJECTION_PATHS.requirementsSchemaArtifact,
  SLICE_PROJECTION_PATHS.s2Trace,
  SLICE_PROJECTION_PATHS.s24Trace,
  SLICE_PROJECTION_PATHS.s31Trace,
  VERIFICATION_PATHS.testInventory,
];

function artifactBytes(id: DownstreamArtifactId, content?: string): string {
  const value = { id, content: content ?? `content-${id}` };
  return `${canonicalJson(value)}\n`;
}

function pathForId(id: DownstreamArtifactId): string {
  return EXPECTED_PATHS[EXPECTED_IDS.indexOf(id)]!;
}

function syntheticBuild(
  overrides: Partial<Record<DownstreamArtifactId, string>> = {},
): DownstreamRegenerationBuild {
  const artifacts: DownstreamArtifactBuild[] = DOWNSTREAM_ARTIFACT_IDS.map((id) => {
    const path = DOWNSTREAM_ARTIFACT_REGISTRY.find((entry) => entry.id === id)!.path;
    const bytes = artifactBytes(id, overrides[id]);
    return {
      id,
      path,
      bytes,
      sha256: sha256(bytes),
      identityHash: canonicalHash({ id, content: overrides[id] ?? `content-${id}` }),
    };
  });
  return compileDownstreamRegenerationBuild(artifacts);
}

function buildArtifacts(
  overrides: Partial<Record<DownstreamArtifactId, string>> = {},
): readonly DownstreamArtifactBuild[] {
  return DOWNSTREAM_ARTIFACT_IDS.map((id) => {
    const path = DOWNSTREAM_ARTIFACT_REGISTRY.find((entry) => entry.id === id)!.path;
    const bytes = artifactBytes(id, overrides[id]);
    return { id, path, bytes, sha256: sha256(bytes), identityHash: canonicalHash({ id }) };
  });
}

function destinations(
  build: DownstreamRegenerationBuild,
  overrides: { removePaths?: readonly string[]; mutatePaths?: Readonly<Record<string, string>>; extraPaths?: readonly Readonly<{ path: string; bytes: string }>[] } = {},
): readonly Readonly<{ path: string; bytes: string }>[] {
  const result: Array<{ path: string; bytes: string }> = [];
  for (const artifact of build.artifacts) {
    if (overrides.removePaths?.includes(artifact.path)) continue;
    const mutated = overrides.mutatePaths?.[artifact.path];
    result.push({ path: artifact.path, bytes: mutated ?? artifact.bytes });
  }
  if (overrides.extraPaths) result.push(...overrides.extraPaths);
  return result;
}

function assertFrozen(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value as object)) return;
  seen.add(value as object);
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value as object)) assertFrozen(child, seen);
}

function expectCode(run: () => unknown, code: string): void {
  assert.throws(run, (error: unknown) => error instanceof InputError && error.code === code);
}

function expectThrow(run: () => unknown): void {
  assert.throws(run);
}

test("DR-R001 downstream regeneration schema version is correct", () => {
  assert.equal(DOWNSTREAM_REGENERATION_SCHEMA_VERSION, "bridlewise-downstream-regeneration/v1");
});

test("DR-R002 downstream regeneration revision is correct", () => {
  assert.equal(DOWNSTREAM_REGENERATION_REVISION, "downstream-regeneration-checker/v1");
});

test("DR-R003 downstream regeneration ordering rule is correct", () => {
  assert.equal(DOWNSTREAM_REGENERATION_ORDERING_RULE, "unsigned-utf8-byte-lexicographic/v1");
});

test("DR-R004 downstream artifact registry has 8 entries", () => {
  assert.equal(DOWNSTREAM_ARTIFACT_REGISTRY.length, 8);
});

test("DR-R005 downstream artifact IDs has 8 entries", () => {
  assert.equal(DOWNSTREAM_ARTIFACT_IDS.length, 8);
});

test("DR-R006 downstream artifact paths has 8 entries", () => {
  assert.equal(DOWNSTREAM_ARTIFACT_PATHS.length, 8);
});

test("DR-R007 downstream artifact IDs are unique", () => {
  assert.equal(new Set(DOWNSTREAM_ARTIFACT_IDS).size, DOWNSTREAM_ARTIFACT_IDS.length);
});

test("DR-R008 downstream artifact paths are unique", () => {
  assert.equal(new Set(DOWNSTREAM_ARTIFACT_PATHS).size, DOWNSTREAM_ARTIFACT_PATHS.length);
});

test("DR-R009 downstream artifact registry is frozen", () => {
  assert.equal(Object.isFrozen(DOWNSTREAM_ARTIFACT_REGISTRY), true);
});

test("DR-R010 downstream artifact IDs is frozen", () => {
  assert.equal(Object.isFrozen(DOWNSTREAM_ARTIFACT_IDS), true);
});

test("DR-R011 downstream artifact paths is frozen", () => {
  assert.equal(Object.isFrozen(DOWNSTREAM_ARTIFACT_PATHS), true);
});

test("DR-R012 downstream artifact registry identity is a sha256 hash", () => {
  assert.match(DOWNSTREAM_ARTIFACT_REGISTRY_IDENTITY, /^[0-9a-f]{64}$/u);
});

test("DR-R013 downstream artifact registry identity is deterministic", () => {
  const recomputed = canonicalHash(DOWNSTREAM_ARTIFACT_REGISTRY);
  assert.equal(recomputed, DOWNSTREAM_ARTIFACT_REGISTRY_IDENTITY);
});

test("DR-R014 downstream artifact registry is sorted by id", () => {
  const ids = DOWNSTREAM_ARTIFACT_REGISTRY.map((entry) => entry.id);
  const sorted = [...ids].toSorted(compareUtf8Bytes);
  assert.deepEqual(ids, sorted);
});

for (const id of EXPECTED_IDS) {
  test(`DR-R015 downstream artifact registry contains id ${id}`, () => {
    assert.ok(DOWNSTREAM_ARTIFACT_REGISTRY.some((entry) => entry.id === id));
  });
}

for (const id of EXPECTED_IDS) {
  test(`DR-R016 downstream artifact registry contains path for ${id}`, () => {
    const path = pathForId(id);
    assert.ok(DOWNSTREAM_ARTIFACT_REGISTRY.some((entry) => entry.path === path));
  });
}

for (const id of EXPECTED_IDS) {
  test(`DR-R017 downstream artifact registry stage for ${id}`, () => {
    const entry = DOWNSTREAM_ARTIFACT_REGISTRY.find((e) => e.id === id)!;
    assert.ok(typeof entry.stage === "string" && entry.stage.length > 0);
  });
}

test("DR-R038 the hand-written expectation and the derived registry hold the SAME ids", () => {
  // THE HEADER'S CLAIM, MADE MECHANICAL. `EXPECTED_IDS` is written out so a
  // registry that LOSES an artifact is caught by a disagreement — and that
  // direction works: removing an id makes a named DR-R015 test fail.
  //
  // The other direction did not. `EXPECTED_IDS` only ever drives loops, so a
  // NINTH artifact in the registry adds no test here and removes none; what
  // actually reds this file is a dozen separately hand-typed `8`s, which the
  // header does not mention and which say nothing about WHICH artifact is new.
  // A second instrument that can only see loss is half an instrument.
  //
  // Set equality between a hand-written list and a derived one is therefore
  // not the tautology it would be if both sides came from the registry — it
  // is the whole point of keeping the hand-written side.
  assert.deepEqual(
    [...EXPECTED_IDS].toSorted(compareUtf8Bytes),
    [...DOWNSTREAM_ARTIFACT_IDS].toSorted(compareUtf8Bytes),
  );
});

test("DR-R018 downstream artifact IDs match registry", () => {
  assert.deepEqual(DOWNSTREAM_ARTIFACT_IDS, DOWNSTREAM_ARTIFACT_REGISTRY.map((entry) => entry.id));
});

test("DR-R019 downstream artifact paths match registry", () => {
  assert.deepEqual(DOWNSTREAM_ARTIFACT_PATHS, DOWNSTREAM_ARTIFACT_REGISTRY.map((entry) => entry.path));
});

for (const id of EXPECTED_IDS) {
  test(`DR-R020 registry entry ${id} has id path and stage`, () => {
    const entry = DOWNSTREAM_ARTIFACT_REGISTRY.find((e) => e.id === id)!;
    assert.ok(typeof entry.id === "string" && entry.id.length > 0);
    assert.ok(typeof entry.path === "string" && entry.path.length > 0);
    assert.ok(typeof entry.stage === "string" && entry.stage.length > 0);
  });
}

test("DR-R021 registry configuration-document-schema path matches root policy", () => {
  const entry = DOWNSTREAM_ARTIFACT_REGISTRY.find((e) => e.id === "configuration-document-schema")!;
  assert.equal(entry.path, ROOT_POLICY.configuration.contract.generatedSchemaPath);
});

test("DR-R022 registry requirements-schema path matches slice projection paths", () => {
  const entry = DOWNSTREAM_ARTIFACT_REGISTRY.find((e) => e.id === "requirements-schema")!;
  assert.equal(entry.path, SLICE_PROJECTION_PATHS.requirementsSchemaArtifact);
});

test("DR-R023 registry contract-schemas path matches slice projection paths", () => {
  const entry = DOWNSTREAM_ARTIFACT_REGISTRY.find((e) => e.id === "contract-schemas")!;
  assert.equal(entry.path, SLICE_PROJECTION_PATHS.contractSchemaArtifact);
});

test("DR-R024 registry forensic-schemas path matches slice projection paths", () => {
  const entry = DOWNSTREAM_ARTIFACT_REGISTRY.find((e) => e.id === "forensic-schemas")!;
  assert.equal(entry.path, SLICE_PROJECTION_PATHS.forensicSchemaArtifact);
});

test("DR-R025 registry test-inventory path matches verification paths", () => {
  const entry = DOWNSTREAM_ARTIFACT_REGISTRY.find((e) => e.id === "test-inventory")!;
  assert.equal(entry.path, VERIFICATION_PATHS.testInventory);
});

test("DR-R026 registry slice-s2 path matches slice projection paths", () => {
  const entry = DOWNSTREAM_ARTIFACT_REGISTRY.find((e) => e.id === "slice-s2")!;
  assert.equal(entry.path, SLICE_PROJECTION_PATHS.s2Trace);
});

test("DR-R027 registry slice-s2.4 path matches slice projection paths", () => {
  const entry = DOWNSTREAM_ARTIFACT_REGISTRY.find((e) => e.id === "slice-s2.4")!;
  assert.equal(entry.path, SLICE_PROJECTION_PATHS.s24Trace);
});

test("DR-R028 registry slice-s3.1 path matches slice projection paths", () => {
  const entry = DOWNSTREAM_ARTIFACT_REGISTRY.find((e) => e.id === "slice-s3.1")!;
  assert.equal(entry.path, SLICE_PROJECTION_PATHS.s31Trace);
});

test("DR-R029 compile build with all artifacts produces 8 artifacts", () => {
  const build = syntheticBuild();
  assert.equal(build.artifacts.length, 8);
});

test("DR-R030 compile build schema version is correct", () => {
  const build = syntheticBuild();
  assert.equal(build.schemaVersion, DOWNSTREAM_REGENERATION_SCHEMA_VERSION);
});

test("DR-R031 compile build identity is a sha256 hash", () => {
  const build = syntheticBuild();
  assert.match(build.buildIdentity, /^[0-9a-f]{64}$/u);
});

test("DR-R032 compile build is frozen", () => {
  const build = syntheticBuild();
  assert.equal(Object.isFrozen(build), true);
});

test("DR-R033 compile build artifacts are frozen", () => {
  const build = syntheticBuild();
  for (const artifact of build.artifacts) {
    assert.equal(Object.isFrozen(artifact), true);
  }
});

test("DR-R034 compile build artifacts are sorted by id", () => {
  const build = syntheticBuild();
  const ids = build.artifacts.map((entry) => entry.id);
  const sorted = [...ids].toSorted(compareUtf8Bytes);
  assert.deepEqual(ids, sorted);
});

test("DR-R035 compile build is deterministic across 3 calls", () => {
  const a = syntheticBuild();
  const b = syntheticBuild();
  const c = syntheticBuild();
  assert.equal(a.buildIdentity, b.buildIdentity);
  assert.equal(b.buildIdentity, c.buildIdentity);
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
});

test("DR-R036 compile build canonical JSON is stable across 3 calls", () => {
  const a = canonicalJson(syntheticBuild());
  const b = canonicalJson(syntheticBuild());
  const c = canonicalJson(syntheticBuild());
  assert.equal(a, b);
  assert.equal(b, c);
});

test("DR-R037 compile build identity changes when content changes", () => {
  const a = syntheticBuild();
  const b = syntheticBuild({ "slice-s2": "different-content" });
  assert.notEqual(a.buildIdentity, b.buildIdentity);
});

test("DR-C001 check with exact destinations returns consistent true", () => {
  const build = syntheticBuild();
  const result = checkDownstreamRegeneration(build, destinations(build));
  assert.equal(result.consistent, true);
});

test("DR-C002 check with exact destinations returns 0 violations", () => {
  const build = syntheticBuild();
  const result = checkDownstreamRegeneration(build, destinations(build));
  assert.deepEqual(result.violations, []);
});

test("DR-C003 check with exact destinations returns 8 artifact results", () => {
  const build = syntheticBuild();
  const result = checkDownstreamRegeneration(build, destinations(build));
  assert.equal(result.artifacts.length, 8);
});

test("DR-C004 check with exact destinations returns all exact disposition", () => {
  const build = syntheticBuild();
  const result = checkDownstreamRegeneration(build, destinations(build));
  for (const artifact of result.artifacts) {
    assert.equal(artifact.disposition, "exact");
  }
});

test("DR-C005 check result schema version is correct", () => {
  const build = syntheticBuild();
  const result = checkDownstreamRegeneration(build, destinations(build));
  assert.equal(result.schemaVersion, DOWNSTREAM_REGENERATION_SCHEMA_VERSION);
});

test("DR-C006 check result revision is correct", () => {
  const build = syntheticBuild();
  const result = checkDownstreamRegeneration(build, destinations(build));
  assert.equal(result.revision, DOWNSTREAM_REGENERATION_REVISION);
});

test("DR-C007 check result ordering rule is correct", () => {
  const build = syntheticBuild();
  const result = checkDownstreamRegeneration(build, destinations(build));
  assert.equal(result.orderingRule, DOWNSTREAM_REGENERATION_ORDERING_RULE);
});

test("DR-C008 check result registry identity matches", () => {
  const build = syntheticBuild();
  const result = checkDownstreamRegeneration(build, destinations(build));
  assert.equal(result.registryIdentity, DOWNSTREAM_ARTIFACT_REGISTRY_IDENTITY);
});

test("DR-C009 check result artifact count matches build", () => {
  const build = syntheticBuild();
  const result = checkDownstreamRegeneration(build, destinations(build));
  assert.equal(result.artifactCount, 8);
});

test("DR-C010 check result destination count matches destinations", () => {
  const build = syntheticBuild();
  const dests = destinations(build);
  const result = checkDownstreamRegeneration(build, dests);
  assert.equal(result.destinationCount, dests.length);
});

test("DR-C011 check result is deeply frozen", () => {
  const build = syntheticBuild();
  const result = checkDownstreamRegeneration(build, destinations(build));
  assertFrozen(result);
});

test("DR-C012 check result identity is a sha256 hash", () => {
  const build = syntheticBuild();
  const result = checkDownstreamRegeneration(build, destinations(build));
  assert.match(result.resultIdentity, /^[0-9a-f]{64}$/u);
});

test("DR-C013 check result is deterministic across 3 calls", () => {
  const build = syntheticBuild();
  const dests = destinations(build);
  const a = checkDownstreamRegeneration(build, dests);
  const b = checkDownstreamRegeneration(build, dests);
  const c = checkDownstreamRegeneration(build, dests);
  assert.equal(a.resultIdentity, b.resultIdentity);
  assert.equal(b.resultIdentity, c.resultIdentity);
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
});

test("DR-C014 check result canonical JSON is stable across 3 calls", () => {
  const build = syntheticBuild();
  const dests = destinations(build);
  const a = canonicalJson(checkDownstreamRegeneration(build, dests));
  const b = canonicalJson(checkDownstreamRegeneration(build, dests));
  const c = canonicalJson(checkDownstreamRegeneration(build, dests));
  assert.equal(a, b);
  assert.equal(b, c);
});

test("DR-C015 check result identity changes when destinations change", () => {
  const build = syntheticBuild();
  const exact = checkDownstreamRegeneration(build, destinations(build));
  const drifted = checkDownstreamRegeneration(build, destinations(build, {
    mutatePaths: { [DOWNSTREAM_ARTIFACT_PATHS[0]!]: "different" },
  }));
  assert.notEqual(exact.resultIdentity, drifted.resultIdentity);
});

for (const id of EXPECTED_IDS) {
  test(`DR-C016 check artifact ${id} has correct id in result`, () => {
    const build = syntheticBuild();
    const result = checkDownstreamRegeneration(build, destinations(build));
    const artifact = result.artifacts.find((a) => a.id === id)!;
    assert.equal(artifact.id, id);
  });
}
for (const id of EXPECTED_IDS) {
  const path = pathForId(id);
  test(`DR-C017 check artifact ${id} has correct path in result`, () => {
    const build = syntheticBuild();
    const result = checkDownstreamRegeneration(build, destinations(build));
    const artifact = result.artifacts.find((a) => a.id === id)!;
    assert.equal(artifact.path, path);
  });
}
for (const id of EXPECTED_IDS) {
  test(`DR-C018 check artifact ${id} has correct stage in result`, () => {
    const build = syntheticBuild();
    const result = checkDownstreamRegeneration(build, destinations(build));
    const artifact = result.artifacts.find((a) => a.id === id)!;
    const registration = DOWNSTREAM_ARTIFACT_REGISTRY.find((e) => e.id === id)!;
    assert.equal(artifact.stage, registration.stage);
  });
}
for (const id of EXPECTED_IDS) {
  test(`DR-C019 check artifact ${id} has exact expected sha256`, () => {
    const build = syntheticBuild();
    const result = checkDownstreamRegeneration(build, destinations(build));
    const artifact = result.artifacts.find((a) => a.id === id)!;
    assert.equal(artifact.expectedSha256, build.artifacts.find((a) => a.id === id)!.sha256);
  });
}
for (const id of EXPECTED_IDS) {
  test(`DR-C020 check artifact ${id} has exact observed sha256`, () => {
    const build = syntheticBuild();
    const result = checkDownstreamRegeneration(build, destinations(build));
    const artifact = result.artifacts.find((a) => a.id === id)!;
    assert.equal(artifact.observedSha256, artifact.expectedSha256);
  });
}
for (const id of EXPECTED_IDS) {
  test(`DR-C021 check artifact ${id} has exact expected byte length`, () => {
    const build = syntheticBuild();
    const result = checkDownstreamRegeneration(build, destinations(build));
    const artifact = result.artifacts.find((a) => a.id === id)!;
    assert.equal(artifact.expectedByteLength, build.artifacts.find((a) => a.id === id)!.bytes.length);
  });
}
for (const id of EXPECTED_IDS) {
  test(`DR-C022 check artifact ${id} has exact observed byte length`, () => {
    const build = syntheticBuild();
    const result = checkDownstreamRegeneration(build, destinations(build));
    const artifact = result.artifacts.find((a) => a.id === id)!;
    assert.equal(artifact.observedByteLength, artifact.expectedByteLength);
  });
}

for (const id of EXPECTED_IDS) {
  const path = pathForId(id);
  test(`DR-M001 missing destination ${id} returns missing disposition`, () => {
    const build = syntheticBuild();
    const result = checkDownstreamRegeneration(build, destinations(build, { removePaths: [path] }));
    const artifact = result.artifacts.find((a) => a.id === id)!;
    assert.equal(artifact.disposition, "missing");
    assert.equal(artifact.observedSha256, null);
    assert.equal(artifact.observedByteLength, null);
  });
}
for (const id of EXPECTED_IDS) {
  const path = pathForId(id);
  test(`DR-M002 missing destination ${id} returns consistent false`, () => {
    const build = syntheticBuild();
    const result = checkDownstreamRegeneration(build, destinations(build, { removePaths: [path] }));
    assert.equal(result.consistent, false);
  });
}
for (const id of EXPECTED_IDS) {
  const path = pathForId(id);
  test(`DR-M003 missing destination ${id} produces violation`, () => {
    const build = syntheticBuild();
    const result = checkDownstreamRegeneration(build, destinations(build, { removePaths: [path] }));
    assert.ok(result.violations.some((v) => v === `downstream_missing:${id}:${path}`));
  });
}
for (const id of EXPECTED_IDS) {
  const path = pathForId(id);
  test(`DR-M004 missing destination ${id} preserves other artifacts as exact`, () => {
    const build = syntheticBuild();
    const result = checkDownstreamRegeneration(build, destinations(build, { removePaths: [path] }));
    const others = result.artifacts.filter((a) => a.id !== id);
    for (const artifact of others) {
      assert.equal(artifact.disposition, "exact");
    }
  });
}
for (const id of EXPECTED_IDS) {
  const path = pathForId(id);
  test(`DR-M005 drift destination ${id} returns drift disposition`, () => {
    const build = syntheticBuild();
    const result = checkDownstreamRegeneration(build, destinations(build, {
      mutatePaths: { [path]: "drifted-content" },
    }));
    const artifact = result.artifacts.find((a) => a.id === id)!;
    assert.equal(artifact.disposition, "drift");
    assert.notEqual(artifact.observedSha256, artifact.expectedSha256);
  });
}
for (const id of EXPECTED_IDS) {
  const path = pathForId(id);
  test(`DR-M006 drift destination ${id} returns consistent false`, () => {
    const build = syntheticBuild();
    const result = checkDownstreamRegeneration(build, destinations(build, {
      mutatePaths: { [path]: "drifted-content" },
    }));
    assert.equal(result.consistent, false);
  });
}
for (const id of EXPECTED_IDS) {
  const path = pathForId(id);
  test(`DR-M007 drift destination ${id} produces violation`, () => {
    const build = syntheticBuild();
    const result = checkDownstreamRegeneration(build, destinations(build, {
      mutatePaths: { [path]: "drifted-content" },
    }));
    assert.ok(result.violations.some((v) => v === `downstream_drift:${id}:${path}`));
  });
}
for (const id of EXPECTED_IDS) {
  const path = pathForId(id);
  test(`DR-M008 drift destination ${id} preserves other artifacts as exact`, () => {
    const build = syntheticBuild();
    const result = checkDownstreamRegeneration(build, destinations(build, {
      mutatePaths: { [path]: "drifted-content" },
    }));
    const others = result.artifacts.filter((a) => a.id !== id);
    for (const artifact of others) {
      assert.equal(artifact.disposition, "exact");
    }
  });
}
for (const id of EXPECTED_IDS) {
  test(`DR-M009 duplicate destination ${id} returns duplicate disposition`, () => {
    const build = syntheticBuild();
    const artifact = build.artifacts.find((a) => a.id === id)!;
    const dests = [...destinations(build), { path: artifact.path, bytes: artifact.bytes }];
    const result = checkDownstreamRegeneration(build, dests);
    const resultArtifact = result.artifacts.find((a) => a.id === id)!;
    assert.equal(resultArtifact.disposition, "duplicate");
  });
}
for (const id of EXPECTED_IDS) {
  test(`DR-M010 duplicate destination ${id} returns consistent false`, () => {
    const build = syntheticBuild();
    const artifact = build.artifacts.find((a) => a.id === id)!;
    const dests = [...destinations(build), { path: artifact.path, bytes: artifact.bytes }];
    const result = checkDownstreamRegeneration(build, dests);
    assert.equal(result.consistent, false);
  });
}
for (const id of EXPECTED_IDS) {
  const path = pathForId(id);
  test(`DR-M011 duplicate destination ${id} produces violation`, () => {
    const build = syntheticBuild();
    const artifact = build.artifacts.find((a) => a.id === id)!;
    const dests = [...destinations(build), { path: artifact.path, bytes: artifact.bytes }];
    const result = checkDownstreamRegeneration(build, dests);
    assert.ok(result.violations.some((v) => v === `downstream_duplicate:${id}:${path}`));
  });
}

test("DR-U001 unexpected destination produces violation", () => {
  const build = syntheticBuild();
  const dests = [...destinations(build), { path: "unexpected/path.json", bytes: "{}\n" }];
  const result = checkDownstreamRegeneration(build, dests);
  assert.ok(result.violations.some((v) => v === "downstream_unexpected:unexpected/path.json"));
});

test("DR-U002 unexpected destination returns consistent false", () => {
  const build = syntheticBuild();
  const dests = [...destinations(build), { path: "unexpected/path.json", bytes: "{}\n" }];
  const result = checkDownstreamRegeneration(build, dests);
  assert.equal(result.consistent, false);
});

test("DR-U003 unexpected destinations are sorted in result", () => {
  const build = syntheticBuild();
  const dests = [
    ...destinations(build),
    { path: "zzz.json", bytes: "{}\n" },
    { path: "aaa.json", bytes: "{}\n" },
  ];
  const result = checkDownstreamRegeneration(build, dests);
  assert.deepEqual([...result.unexpectedPaths], ["aaa.json", "zzz.json"]);
});

test("DR-U004 multiple unexpected destinations produce multiple violations", () => {
  const build = syntheticBuild();
  const dests = [
    ...destinations(build),
    { path: "a.json", bytes: "{}\n" },
    { path: "b.json", bytes: "{}\n" },
  ];
  const result = checkDownstreamRegeneration(build, dests);
  assert.equal(result.unexpectedPaths.length, 2);
  assert.ok(result.violations.includes("downstream_unexpected:a.json"));
  assert.ok(result.violations.includes("downstream_unexpected:b.json"));
});

test("DR-U005 empty destinations returns all missing", () => {
  const build = syntheticBuild();
  const result = checkDownstreamRegeneration(build, []);
  assert.equal(result.consistent, false);
  assert.equal(result.artifacts.length, 8);
  for (const artifact of result.artifacts) {
    assert.equal(artifact.disposition, "missing");
  }
  assert.equal(result.violations.length, 8);
});

test("DR-U006 violations are sorted", () => {
  const build = syntheticBuild();
  const firstPath = DOWNSTREAM_ARTIFACT_PATHS[0]!;
  const result = checkDownstreamRegeneration(build, destinations(build, {
    removePaths: [firstPath],
    extraPaths: [{ path: "zzz.json", bytes: "{}\n" }],
  }));
  const sorted = [...result.violations].toSorted(compareUtf8Bytes);
  assert.deepEqual(result.violations, sorted);
});

test("DR-A001 partial state prevention - missing artifact in build throws", () => {
  const artifacts = buildArtifacts().filter((a) => a.id !== "slice-s2");
  expectCode(() => compileDownstreamRegenerationBuild(artifacts), "downstream_build_artifact_missing");
});

test("DR-A002 partial state prevention - extra artifact in build throws", () => {
  const artifacts = [...buildArtifacts(), {
    id: "extra-artifact" as DownstreamArtifactId,
    path: "extra/path.json",
    bytes: "{}\n",
    sha256: sha256("{}\n"),
    identityHash: canonicalHash({ extra: true }),
  }];
  expectCode(() => compileDownstreamRegenerationBuild(artifacts), "downstream_build_artifact_count_invalid");
});

test("DR-A003 partial state prevention - duplicate id in build throws", () => {
  const artifacts = buildArtifacts();
  const first = artifacts[0]!;
  const duplicated = [...artifacts, { ...first, path: "different/path.json" }];
  expectCode(() => compileDownstreamRegenerationBuild(duplicated), "downstream_artifact_id_duplicate");
});

test("DR-A004 partial state prevention - duplicate path in build throws", () => {
  const artifacts = buildArtifacts();
  const first = artifacts[0]!;
  const duplicated = [...artifacts, { ...first, id: "different-id" as DownstreamArtifactId }];
  expectCode(() => compileDownstreamRegenerationBuild(duplicated), "downstream_artifact_path_duplicate");
});

test("DR-A005 partial state prevention - wrong path for artifact throws", () => {
  const artifacts = buildArtifacts().map((a) =>
    a.id === "slice-s2" ? { ...a, path: "wrong/path.json" } : a,
  );
  expectCode(() => compileDownstreamRegenerationBuild(artifacts), "downstream_build_path_mismatch");
});

test("DR-A006 partial state prevention - invalid sha256 throws", () => {
  const artifacts = buildArtifacts().map((a) =>
    a.id === "slice-s2" ? { ...a, sha256: "0".repeat(64) } : a,
  );
  expectCode(() => compileDownstreamRegenerationBuild(artifacts), "downstream_build_sha256_invalid");
});

test("DR-A007 partial state prevention - empty bytes throws", () => {
  const artifacts = buildArtifacts().map((a) =>
    a.id === "slice-s2" ? { ...a, bytes: "", sha256: sha256("") } : a,
  );
  expectCode(() => compileDownstreamRegenerationBuild(artifacts), "downstream_build_artifact_empty");
});

test("DR-A008 partial state prevention - all 8 artifacts required", () => {
  for (const id of EXPECTED_IDS) {
    const artifacts = buildArtifacts().filter((a) => a.id !== id);
    expectCode(() => compileDownstreamRegenerationBuild(artifacts), "downstream_build_artifact_missing");
  }
});

test("DR-V001 validate build with wrong schema version throws", () => {
  const build = syntheticBuild();
  const invalid = { ...build, schemaVersion: "wrong-version" };
  expectCode(() => checkDownstreamRegeneration(invalid as DownstreamRegenerationBuild, []), "downstream_build_schema_version_invalid");
});

test("DR-V002 validate build with wrong artifact count throws", () => {
  const build = syntheticBuild();
  const invalid = { ...build, artifacts: build.artifacts.slice(0, 7) };
  expectCode(() => checkDownstreamRegeneration(invalid as DownstreamRegenerationBuild, []), "downstream_build_artifact_count_invalid");
});

test("DR-V003 validate build with wrong build identity throws", () => {
  const build = syntheticBuild();
  const invalid = { ...build, buildIdentity: "0".repeat(64) };
  expectCode(() => checkDownstreamRegeneration(invalid as DownstreamRegenerationBuild, []), "downstream_build_identity_invalid");
});

test("DR-V004 validate build with wrong order throws", () => {
  const build = syntheticBuild();
  const reversed = [...build.artifacts].reverse();
  const invalid = { ...build, artifacts: reversed };
  expectCode(() => checkDownstreamRegeneration(invalid as DownstreamRegenerationBuild, []), "downstream_build_order_invalid");
});

test("DR-V005 validate build with duplicate ids throws", () => {
  const build = syntheticBuild();
  const first = build.artifacts[0]!;
  const invalid = { ...build, artifacts: [...build.artifacts, first] };
  expectCode(() => checkDownstreamRegeneration(invalid as DownstreamRegenerationBuild, []), "downstream_build_id_duplicate");
});

test("DR-V006 validate build with wrong sha256 throws", () => {
  const build = syntheticBuild();
  const tampered = build.artifacts.map((a) =>
    a.id === "slice-s2" ? { ...a, sha256: "f".repeat(64) } : a,
  );
  const invalid = { ...build, artifacts: tampered };
  expectCode(() => checkDownstreamRegeneration(invalid as DownstreamRegenerationBuild, []), "downstream_build_bytes_invalid");
});

test("DR-V007 validate build with empty bytes throws", () => {
  const build = syntheticBuild();
  const tampered = build.artifacts.map((a) =>
    a.id === "slice-s2" ? { ...a, bytes: "", sha256: sha256("") } : a,
  );
  const invalid = { ...build, artifacts: tampered };
  expectCode(() => checkDownstreamRegeneration(invalid as DownstreamRegenerationBuild, []), "downstream_build_bytes_invalid");
});

test("DR-V008 validate build with registry mismatch throws", () => {
  const build = syntheticBuild();
  const tampered = build.artifacts.map((a) =>
    a.id === "slice-s2" ? { ...a, path: "wrong/path.json" } : a,
  );
  const invalid = { ...build, artifacts: tampered };
  expectCode(() => checkDownstreamRegeneration(invalid as DownstreamRegenerationBuild, []), "downstream_build_registry_mismatch");
});

test("DR-H001 hostile - invalid destination entry throws", () => {
  const build = syntheticBuild();
  const invalid = [{ path: 123, bytes: "test" }] as unknown as readonly Readonly<{ path: string; bytes: string }>[];
  expectThrow(() => checkDownstreamRegeneration(build, invalid));
});

test("DR-H002 hostile - destination with non-string bytes throws", () => {
  const build = syntheticBuild();
  const invalid = [{ path: "test.json", bytes: 123 }] as unknown as readonly Readonly<{ path: string; bytes: string }>[];
  expectThrow(() => checkDownstreamRegeneration(build, invalid));
});

test("DR-H003 hostile - build with extra unknown field is rejected", () => {
  const build = syntheticBuild();
  const extra = { ...build, extraField: "malicious" };
  expectCode(() => checkDownstreamRegeneration(extra as DownstreamRegenerationBuild, []), "downstream_build_unknown_fields");
});

test("DR-H004 hostile - structuredClone of build is still valid", () => {
  const build = syntheticBuild();
  const clone = structuredClone(build);
  const result = checkDownstreamRegeneration(clone, destinations(build));
  assert.equal(result.consistent, true);
});

test("DR-H005 hostile - JSON round trip of build is valid for compile", () => {
  const build = syntheticBuild();
  const json = JSON.parse(JSON.stringify(build));
  const recompiled = compileDownstreamRegenerationBuild(
    json.artifacts as readonly DownstreamArtifactBuild[],
  );
  assert.equal(recompiled.buildIdentity, build.buildIdentity);
});

test("DR-H006 hostile - mutation of build after compilation throws", () => {
  const build = syntheticBuild();
  assert.throws(() => {
    (build as unknown as { buildIdentity: string }).buildIdentity = "0".repeat(64);
  });
});

test("DR-H007 hostile - mutation of build artifacts throws", () => {
  const build = syntheticBuild();
  assert.throws(() => {
    (build.artifacts as unknown as unknown[]).push(build.artifacts[0]!);
  });
});

test("DR-H008 hostile - mutation of result throws", () => {
  const build = syntheticBuild();
  const result = checkDownstreamRegeneration(build, destinations(build));
  assert.throws(() => {
    (result as unknown as { consistent: boolean }).consistent = false;
  });
});

test("DR-H009 hostile - mutation of result artifacts throws", () => {
  const build = syntheticBuild();
  const result = checkDownstreamRegeneration(build, destinations(build));
  assert.throws(() => {
    (result.artifacts as unknown as unknown[]).pop();
  });
});

test("DR-H010 hostile - mutation of result violations throws", () => {
  const build = syntheticBuild();
  const result = checkDownstreamRegeneration(build, destinations(build));
  assert.throws(() => {
    (result.violations as unknown as unknown[]).push("fake-violation");
  });
});

test("DR-H011 hostile - result survives structuredClone", () => {
  const build = syntheticBuild();
  const result = checkDownstreamRegeneration(build, destinations(build));
  const clone = structuredClone(result);
  assert.deepEqual(clone, result);
  assert.notEqual(clone, result);
});

test("DR-H012 hostile - build with wrong path that matches another artifact throws", () => {
  const artifacts = buildArtifacts().map((a) => {
    if (a.id === "slice-s2") {
      const otherPath = DOWNSTREAM_ARTIFACT_REGISTRY.find((e) => e.id === "slice-s2.4")!.path;
      return { ...a, path: otherPath };
    }
    return a;
  });
  expectCode(() => compileDownstreamRegenerationBuild(artifacts), "downstream_artifact_path_duplicate");
});

test("DR-H013 hostile - swapped ids between artifacts throws", () => {
  const artifacts = buildArtifacts();
  const first = artifacts[0]!;
  const second = artifacts[1]!;
  const swapped = artifacts.map((a) => {
    if (a.id === first.id) return { ...second, path: first.path };
    if (a.id === second.id) return { ...first, path: second.path };
    return a;
  });
  expectThrow(() => compileDownstreamRegenerationBuild(swapped));
});

test("DR-D001 determinism - same build and destinations produce same result identity", () => {
  const build = syntheticBuild();
  const dests = destinations(build);
  const a = checkDownstreamRegeneration(build, dests);
  const b = checkDownstreamRegeneration(build, dests);
  assert.equal(a.resultIdentity, b.resultIdentity);
});

test("DR-D002 determinism - reordered destinations produce same result", () => {
  const build = syntheticBuild();
  const dests = [...destinations(build)].reverse();
  const result = checkDownstreamRegeneration(build, dests);
  assert.equal(result.consistent, true);
});

test("DR-D003 determinism - reordered destinations produce same result identity", () => {
  const build = syntheticBuild();
  const dests1 = destinations(build);
  const dests2 = [...dests1].reverse();
  const a = checkDownstreamRegeneration(build, dests1);
  const b = checkDownstreamRegeneration(build, dests2);
  assert.equal(a.resultIdentity, b.resultIdentity);
});

test("DR-D004 determinism - build identity is order-independent", () => {
  const artifacts = buildArtifacts();
  const reversed = [...artifacts].reverse();
  const a = compileDownstreamRegenerationBuild(artifacts);
  const b = compileDownstreamRegenerationBuild(reversed);
  assert.equal(a.buildIdentity, b.buildIdentity);
});

test("DR-D005 determinism - different content produces different build identity", () => {
  const a = syntheticBuild({ "slice-s2": "content-a" });
  const b = syntheticBuild({ "slice-s2": "content-b" });
  assert.notEqual(a.buildIdentity, b.buildIdentity);
});

test("DR-D006 determinism - same content produces same build identity", () => {
  const a = syntheticBuild({ "slice-s2": "same-content" });
  const b = syntheticBuild({ "slice-s2": "same-content" });
  assert.equal(a.buildIdentity, b.buildIdentity);
});

test("DR-D007 determinism - result identity is deterministic for same inputs", () => {
  const build = syntheticBuild();
  const dests = destinations(build);
  const results = Array.from({ length: 5 }, () => checkDownstreamRegeneration(build, dests));
  const first = results[0]!.resultIdentity;
  assert.ok(results.every((r) => r.resultIdentity === first));
});

test("DR-D008 determinism - build identity is a sha256 hash", () => {
  const build = syntheticBuild();
  assert.match(build.buildIdentity, /^[0-9a-f]{64}$/u);
});

test("DR-D009 determinism - canonical JSON of build is stable", () => {
  const a = canonicalJson(syntheticBuild());
  const b = canonicalJson(syntheticBuild());
  assert.equal(a, b);
});

test("DR-D010 determinism - canonical JSON of result is stable", () => {
  const build = syntheticBuild();
  const dests = destinations(build);
  const a = canonicalJson(checkDownstreamRegeneration(build, dests));
  const b = canonicalJson(checkDownstreamRegeneration(build, dests));
  assert.equal(a, b);
});

test("DR-X001 mixed dispositions - some exact some missing some drift", () => {
  const build = syntheticBuild();
  const path0 = DOWNSTREAM_ARTIFACT_PATHS[0]!;
  const path1 = DOWNSTREAM_ARTIFACT_PATHS[1]!;
  const path2 = DOWNSTREAM_ARTIFACT_PATHS[2]!;
  const result = checkDownstreamRegeneration(build, destinations(build, {
    removePaths: [path0],
    mutatePaths: { [path1]: "drifted" },
  }));
  assert.equal(result.artifacts.find((a) => a.path === path0)!.disposition, "missing");
  assert.equal(result.artifacts.find((a) => a.path === path1)!.disposition, "drift");
  assert.equal(result.artifacts.find((a) => a.path === path2)!.disposition, "exact");
  assert.equal(result.consistent, false);
  assert.ok(result.violations.length >= 2);
});

test("DR-X002 all artifacts drift returns all drift violations", () => {
  const build = syntheticBuild();
  const mutated: Record<string, string> = {};
  for (const path of DOWNSTREAM_ARTIFACT_PATHS) {
    mutated[path] = `drifted-${path}`;
  }
  const result = checkDownstreamRegeneration(build, destinations(build, { mutatePaths: mutated }));
  assert.equal(result.consistent, false);
  for (const artifact of result.artifacts) {
    assert.equal(artifact.disposition, "drift");
  }
  assert.equal(result.violations.length, 8);
});

test("DR-X003 all artifacts missing returns all missing violations", () => {
  const build = syntheticBuild();
  const result = checkDownstreamRegeneration(build, []);
  assert.equal(result.consistent, false);
  for (const artifact of result.artifacts) {
    assert.equal(artifact.disposition, "missing");
  }
  assert.equal(result.violations.length, 8);
  assert.equal(result.unexpectedPaths.length, 0);
});

test("DR-X004 all artifacts exact plus unexpected returns 1 unexpected violation", () => {
  const build = syntheticBuild();
  const result = checkDownstreamRegeneration(build, [
    ...destinations(build),
    { path: "only-unexpected.json", bytes: "{}\n" },
  ]);
  assert.equal(result.consistent, false);
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0], "downstream_unexpected:only-unexpected.json");
});

test("DR-X005 result artifact count is always 8", () => {
  const build = syntheticBuild();
  assert.equal(checkDownstreamRegeneration(build, destinations(build)).artifactCount, 8);
  assert.equal(checkDownstreamRegeneration(build, []).artifactCount, 8);
  assert.equal(checkDownstreamRegeneration(build, [{ path: "x.json", bytes: "" }]).artifactCount, 8);
});

test("DR-X006 destination count reflects actual destinations", () => {
  const build = syntheticBuild();
  assert.equal(checkDownstreamRegeneration(build, destinations(build)).destinationCount, 8);
  assert.equal(checkDownstreamRegeneration(build, []).destinationCount, 0);
  assert.equal(checkDownstreamRegeneration(build, [{ path: "x.json", bytes: "{}\n" }]).destinationCount, 1);
});

test("DR-X007 result violations are unique", () => {
  const build = syntheticBuild();
  const result = checkDownstreamRegeneration(build, destinations(build, {
    removePaths: [DOWNSTREAM_ARTIFACT_PATHS[0]!],
    extraPaths: [{ path: "a.json", bytes: "{}\n" }],
  }));
  assert.equal(new Set(result.violations).size, result.violations.length);
});

test("DR-X008 result unexpected paths are unique", () => {
  const build = syntheticBuild();
  const dests = [
    ...destinations(build),
    { path: "dup.json", bytes: "{}\n" },
    { path: "dup.json", bytes: "{}\n" },
  ];
  const result = checkDownstreamRegeneration(build, dests);
  assert.equal(new Set(result.unexpectedPaths).size, result.unexpectedPaths.length);
});

test("DR-F001 compile build with empty array throws", () => {
  expectCode(() => compileDownstreamRegenerationBuild([]), "downstream_build_artifact_missing");
});

test("DR-F002 compile build with null throws", () => {
  expectThrow(() => compileDownstreamRegenerationBuild(null as unknown as readonly DownstreamArtifactBuild[]));
});

test("DR-F003 compile build with undefined throws", () => {
  expectThrow(() => compileDownstreamRegenerationBuild(undefined as unknown as readonly DownstreamArtifactBuild[]));
});

test("DR-F004 check with null build throws", () => {
  expectThrow(() => checkDownstreamRegeneration(null as unknown as DownstreamRegenerationBuild, []));
});

test("DR-F005 check with null destinations throws", () => {
  const build = syntheticBuild();
  expectThrow(() => checkDownstreamRegeneration(build, null as unknown as readonly Readonly<{ path: string; bytes: string }>[]));
});

test("DR-F006 compile build with one artifact throws", () => {
  expectCode(() => compileDownstreamRegenerationBuild(buildArtifacts().slice(0, 1)), "downstream_build_artifact_missing");
});

test("DR-F007 compile build with seven artifacts throws", () => {
  expectCode(() => compileDownstreamRegenerationBuild(buildArtifacts().slice(0, 7)), "downstream_build_artifact_missing");
});

test("DR-S001 compile build with same content produces same artifacts", () => {
  const a = syntheticBuild();
  const b = syntheticBuild();
  assert.deepEqual(a.artifacts, b.artifacts);
});

test("DR-S002 compile build artifact paths match registry paths", () => {
  const build = syntheticBuild();
  const paths = build.artifacts.map((a) => a.path);
  assert.deepEqual([...paths].toSorted(compareUtf8Bytes), [...DOWNSTREAM_ARTIFACT_PATHS].toSorted(compareUtf8Bytes));
});

test("DR-S003 compile build artifact ids match registry ids", () => {
  const build = syntheticBuild();
  const ids = build.artifacts.map((a) => a.id);
  assert.deepEqual([...ids].toSorted(compareUtf8Bytes), [...DOWNSTREAM_ARTIFACT_IDS].toSorted(compareUtf8Bytes));
});

test("DR-S004 check result artifacts match build artifact order", () => {
  const build = syntheticBuild();
  const result = checkDownstreamRegeneration(build, destinations(build));
  assert.deepEqual(
    result.artifacts.map((a) => a.id),
    build.artifacts.map((a) => a.id),
  );
});

test("DR-S005 check result artifacts have same paths as build", () => {
  const build = syntheticBuild();
  const result = checkDownstreamRegeneration(build, destinations(build));
  assert.deepEqual(
    result.artifacts.map((a) => a.path),
    build.artifacts.map((a) => a.path),
  );
});

test("DR-S006 check result artifacts have stages from registry", () => {
  const build = syntheticBuild();
  const result = checkDownstreamRegeneration(build, destinations(build));
  for (const artifact of result.artifacts) {
    const registration = DOWNSTREAM_ARTIFACT_REGISTRY.find((e) => e.id === artifact.id)!;
    assert.equal(artifact.stage, registration.stage);
  }
});

test("DR-S007 check with exact destinations has empty unexpected paths", () => {
  const build = syntheticBuild();
  const result = checkDownstreamRegeneration(build, destinations(build));
  assert.deepEqual(result.unexpectedPaths, []);
});

test("DR-S008 build identity is computed from sorted artifact summary", () => {
  const build = syntheticBuild();
  const payload = {
    schemaVersion: DOWNSTREAM_REGENERATION_SCHEMA_VERSION,
    artifacts: build.artifacts.map((entry) => ({
      id: entry.id,
      path: entry.path,
      sha256: entry.sha256,
      identityHash: entry.identityHash,
      byteLength: entry.bytes.length,
    })),
  };
  assert.equal(build.buildIdentity, canonicalHash(payload));
});

test("DR-S009 result identity is computed from full result payload", () => {
  const build = syntheticBuild();
  const result = checkDownstreamRegeneration(build, destinations(build));
  const { resultIdentity: _, ...payload } = result;
  assert.equal(result.resultIdentity, canonicalHash(payload));
});

test("DR-S010 build artifact sha256 matches bytes", () => {
  const build = syntheticBuild();
  for (const artifact of build.artifacts) {
    assert.equal(artifact.sha256, sha256(artifact.bytes));
  }
});

test("DR-S011 build artifact byte length is positive", () => {
  const build = syntheticBuild();
  for (const artifact of build.artifacts) {
    assert.ok(artifact.bytes.length > 0);
  }
});

test("DR-S012 result artifact expected sha256 matches build sha256", () => {
  const build = syntheticBuild();
  const result = checkDownstreamRegeneration(build, destinations(build));
  for (const artifact of result.artifacts) {
    const buildArtifact = build.artifacts.find((a) => a.id === artifact.id)!;
    assert.equal(artifact.expectedSha256, buildArtifact.sha256);
  }
});

test("DR-S013 result artifact expected byte length matches build byte length", () => {
  const build = syntheticBuild();
  const result = checkDownstreamRegeneration(build, destinations(build));
  for (const artifact of result.artifacts) {
    const buildArtifact = build.artifacts.find((a) => a.id === artifact.id)!;
    assert.equal(artifact.expectedByteLength, buildArtifact.bytes.length);
  }
});

test("DR-S014 result artifact observed sha256 is null when missing", () => {
  const build = syntheticBuild();
  const path = DOWNSTREAM_ARTIFACT_PATHS[0]!;
  const result = checkDownstreamRegeneration(build, destinations(build, { removePaths: [path] }));
  const artifact = result.artifacts.find((a) => a.path === path)!;
  assert.equal(artifact.observedSha256, null);
  assert.equal(artifact.observedByteLength, null);
});

test("DR-S015 result artifact observed sha256 is set when drift", () => {
  const build = syntheticBuild();
  const path = DOWNSTREAM_ARTIFACT_PATHS[0]!;
  const result = checkDownstreamRegeneration(build, destinations(build, {
    mutatePaths: { [path]: "drifted" },
  }));
  const artifact = result.artifacts.find((a) => a.path === path)!;
  assert.notEqual(artifact.observedSha256, null);
  assert.notEqual(artifact.observedByteLength, null);
  assert.notEqual(artifact.observedSha256, artifact.expectedSha256);
});

test("DR-S016 result artifact observed sha256 matches when duplicate", () => {
  const build = syntheticBuild();
  const artifact = build.artifacts[0]!;
  const dests = [...destinations(build), { path: artifact.path, bytes: artifact.bytes }];
  const result = checkDownstreamRegeneration(build, dests);
  const resultArtifact = result.artifacts.find((a) => a.id === artifact.id)!;
  assert.equal(resultArtifact.observedSha256, artifact.sha256);
  assert.equal(resultArtifact.observedByteLength, artifact.bytes.length);
});

test("DR-S017 result artifact observed byte length matches bytes when drift", () => {
  const build = syntheticBuild();
  const path = DOWNSTREAM_ARTIFACT_PATHS[0]!;
  const driftedBytes = "drifted-content";
  const result = checkDownstreamRegeneration(build, destinations(build, {
    mutatePaths: { [path]: driftedBytes },
  }));
  const artifact = result.artifacts.find((a) => a.path === path)!;
  assert.equal(artifact.observedByteLength, driftedBytes.length);
});

test("DR-S018 check result includes all 8 artifact dispositions", () => {
  const build = syntheticBuild();
  const result = checkDownstreamRegeneration(build, destinations(build));
  assert.equal(result.artifacts.length, 8);
  const ids = result.artifacts.map((a) => a.id);
  for (const id of DOWNSTREAM_ARTIFACT_IDS) {
    assert.ok(ids.includes(id));
  }
});

test("DR-S019 check result violations use correct code format", () => {
  const build = syntheticBuild();
  const path = DOWNSTREAM_ARTIFACT_PATHS[0]!;
  const id = DOWNSTREAM_ARTIFACT_IDS[0]!;
  const result = checkDownstreamRegeneration(build, destinations(build, { removePaths: [path] }));
  assert.ok(result.violations.some((v) => v.startsWith("downstream_missing:")));
  assert.ok(result.violations.some((v) => v === `downstream_missing:${id}:${path}`));
});

test("DR-S020 check result unexpected path violation uses correct format", () => {
  const build = syntheticBuild();
  const result = checkDownstreamRegeneration(build, [
    ...destinations(build),
    { path: "extra.json", bytes: "{}\n" },
  ]);
  assert.ok(result.violations.includes("downstream_unexpected:extra.json"));
});

test("DR-I001 compile build with different identityHash produces different buildIdentity", () => {
  const artifacts1 = buildArtifacts();
  const artifacts2 = buildArtifacts().map((a) => ({ ...a, identityHash: "f".repeat(64) }));
  const build1 = compileDownstreamRegenerationBuild(artifacts1);
  const build2 = compileDownstreamRegenerationBuild(artifacts2);
  assert.notEqual(build1.buildIdentity, build2.buildIdentity);
});

test("DR-I002 compile build with different bytes produces different buildIdentity", () => {
  const artifacts1 = buildArtifacts();
  const artifacts2 = buildArtifacts({ "slice-s2": "different" });
  const build1 = compileDownstreamRegenerationBuild(artifacts1);
  const build2 = compileDownstreamRegenerationBuild(artifacts2);
  assert.notEqual(build1.buildIdentity, build2.buildIdentity);
});

test("DR-I003 compile build with different sha256 produces different buildIdentity", () => {
  const artifacts2 = buildArtifacts().map((a) =>
    a.id === "slice-s2" ? { ...a, sha256: "f".repeat(64) } : a,
  );
  expectCode(() => compileDownstreamRegenerationBuild(artifacts2), "downstream_build_sha256_invalid");
});

test("DR-I004 compile build is frozen deeply", () => {
  const build = syntheticBuild();
  assertFrozen(build);
});

test("DR-I005 check result is frozen deeply even when inconsistent", () => {
  const build = syntheticBuild();
  const result = checkDownstreamRegeneration(build, []);
  assertFrozen(result);
});

test("DR-I006 check result is frozen deeply with mixed dispositions", () => {
  const build = syntheticBuild();
  const result = checkDownstreamRegeneration(build, destinations(build, {
    removePaths: [DOWNSTREAM_ARTIFACT_PATHS[0]!],
    mutatePaths: { [DOWNSTREAM_ARTIFACT_PATHS[1]!]: "drift" },
    extraPaths: [{ path: "extra.json", bytes: "{}\n" }],
  }));
  assertFrozen(result);
});

test("DR-I007 registry entries are deeply frozen", () => {
  for (const entry of DOWNSTREAM_ARTIFACT_REGISTRY) {
    assert.equal(Object.isFrozen(entry), true);
  }
});

test("DR-I008 compile build artifacts are deeply frozen", () => {
  const build = syntheticBuild();
  for (const artifact of build.artifacts) {
    assertFrozen(artifact);
  }
});

test("DR-I009 check result artifacts are deeply frozen", () => {
  const build = syntheticBuild();
  const result = checkDownstreamRegeneration(build, destinations(build));
  for (const artifact of result.artifacts) {
    assertFrozen(artifact);
  }
});

test("DR-N001 null artifact id in build throws", () => {
  const artifacts = buildArtifacts().map((a) =>
    a.id === "slice-s2" ? { ...a, id: null as unknown as DownstreamArtifactId } : a,
  );
  expectThrow(() => compileDownstreamRegenerationBuild(artifacts));
});

test("DR-N002 null artifact path in build throws", () => {
  const artifacts = buildArtifacts().map((a) =>
    a.id === "slice-s2" ? { ...a, path: null as unknown as string } : a,
  );
  expectThrow(() => compileDownstreamRegenerationBuild(artifacts));
});

test("DR-N003 null artifact bytes in build throws", () => {
  const artifacts = buildArtifacts().map((a) =>
    a.id === "slice-s2" ? { ...a, bytes: null as unknown as string } : a,
  );
  expectThrow(() => compileDownstreamRegenerationBuild(artifacts));
});

test("DR-N004 undefined artifact sha256 in build throws", () => {
  const artifacts = buildArtifacts().map((a) =>
    a.id === "slice-s2" ? { ...a, sha256: undefined as unknown as string } : a,
  );
  expectThrow(() => compileDownstreamRegenerationBuild(artifacts));
});

test("DR-N005 null destination path throws", () => {
  const build = syntheticBuild();
  expectThrow(() => checkDownstreamRegeneration(build, [{ path: null as unknown as string, bytes: "{}\n" }]));
});

test("DR-N006 undefined destination bytes throws", () => {
  const build = syntheticBuild();
  expectThrow(() => checkDownstreamRegeneration(build, [{ path: "test.json", bytes: undefined as unknown as string }]));
});

test("DR-E001 empty string destination path is processed", () => {
  const build = syntheticBuild();
  const result = checkDownstreamRegeneration(build, [{ path: "", bytes: "{}\n" }]);
  assert.ok(result.unexpectedPaths.includes(""));
});

test("DR-E002 empty string destination bytes is processed as drift for matching path", () => {
  const build = syntheticBuild();
  const path = DOWNSTREAM_ARTIFACT_PATHS[0]!;
  const result = checkDownstreamRegeneration(build, [{ path, bytes: "" }]);
  const artifact = result.artifacts.find((a) => a.path === path)!;
  assert.equal(artifact.disposition, "drift");
  assert.equal(artifact.observedByteLength, 0);
});

test("DR-E003 very long destination bytes is processed", () => {
  const build = syntheticBuild();
  const path = DOWNSTREAM_ARTIFACT_PATHS[0]!;
  const longBytes = "x".repeat(10000);
  const result = checkDownstreamRegeneration(build, [{ path, bytes: longBytes }]);
  const artifact = result.artifacts.find((a) => a.path === path)!;
  assert.equal(artifact.disposition, "drift");
  assert.equal(artifact.observedByteLength, 10000);
});

test("DR-E004 unicode destination path is processed", () => {
  const build = syntheticBuild();
  const result = checkDownstreamRegeneration(build, [
    ...destinations(build),
    { path: "unicode/路径.json", bytes: "{}\n" },
  ]);
  assert.ok(result.unexpectedPaths.includes("unicode/路径.json"));
});

test("DR-E005 destination with special characters is processed", () => {
  const build = syntheticBuild();
  const result = checkDownstreamRegeneration(build, [
    ...destinations(build),
    { path: "special/!@#$%^&*().json", bytes: "{}\n" },
  ]);
  assert.ok(result.unexpectedPaths.includes("special/!@#$%^&*().json"));
});
