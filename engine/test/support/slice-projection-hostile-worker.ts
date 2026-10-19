import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { InputError } from "../../src/kernel/errors.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { parseSliceDeclarationsText } from "../../scripts/verification/slice-declarations.ts";
import { SLICE_PROJECTION_PATHS } from "../../scripts/verification/slice-projection-paths.ts";
import {
  buildSliceProjection,
  checkSliceProjection,
  createSliceProjectionCapturedValues,
  type SliceProjectionCapturedFile,
  type SliceProjectionInput,
} from "../../scripts/verification/slice-projections.ts";
import {
  currentSliceProjectionDerivedPaths,
  currentSliceProjectionInput,
} from "./current-slice-projection-fixture.ts";

type MutableProjectionInput = {
  captured: {
    schemaVersion: string;
    files: Array<{ path: string; contentBase64: string }>;
  };
};

const base = currentSliceProjectionInput();
const baseline = buildSliceProjection(base);
const families: string[] = [];

family("current-all-artifact-comparison", () => {
  const mechanicallyDerivedPaths = currentSliceProjectionDerivedPaths();
  assert.equal(mechanicallyDerivedPaths.length, 76);
  assert.deepEqual(base.captured.files.map((file) => file.path), mechanicallyDerivedPaths);
  const current = Object.keys(baseline.artifactsByPath).map((path) => ({ path, bytes: readFileSync(path, "utf8") }));
  const check = checkSliceProjection(baseline, current);
  assert.equal(check.paths.length, Object.keys(baseline.artifactsByPath).length);
  assert.deepEqual(check.paths.map((entry) => entry.path), Object.keys(baseline.artifactsByPath));
  for (const entry of check.paths) {
    const observed = current.find((candidate) => candidate.path === entry.path)!;
    const expected = baseline.artifactsByPath[entry.path]!;
    assert.equal(entry.disposition, observed.bytes === expected.bytes ? "exact" : "drift");
  }
});

family("destination-non-authority", () => {
  assert.equal(checkSliceProjection(baseline, []).ok, false);
  const first = Object.values(baseline.artifactsByPath)[0]!;
  assert.equal(checkSliceProjection(baseline, [{ path: first.path, bytes: "{}\n" }]).ok, false);
  assert.equal(checkSliceProjection(baseline, [
    { path: first.path, bytes: first.bytes },
    { path: first.path, bytes: first.bytes },
  ]).paths[0]!.disposition, "duplicate");
  assert.deepEqual(checkSliceProjection(baseline, [{ path: "unexpected.json", bytes: "{}\n" }]).violations.at(-1),
    "slice_projection_unexpected:unexpected.json");
});

family("no-caller-trust-state", () => {
  const serialized = JSON.stringify(base);
  for (const field of [
    "receiptHash", "completedStages", "repositoryIdentity", "candidateIdentity", "rootIdentity",
    "descriptorIdentity", "stableBeforeAndAfter", "safeReadsComplete", "abaRecheckComplete",
    "leaseState", "recoveryState",
  ]) assert.equal(serialized.includes(`\"${field}\"`), false, field);
  expectCode(() => buildSliceProjection({ ...base, upstream: { leaseState: "held" } } as never),
    "slice_projection_input_invalid");
  expectCode(() => buildSliceProjection({ ...base, admittedAssessments: "pass" } as never),
    "slice_projection_input_invalid");
});

family("self-issued-digest-and-claim-rejection", () => {
  expectCode(() => createSliceProjectionCapturedValues({ ...base.captured, receiptHash: "a".repeat(64) }),
    "slice_captured_values_invalid");
  expectCode(() => createSliceProjectionCapturedValues({ ...base.captured, identityHash: "b".repeat(64) }),
    "slice_captured_values_invalid");
  const claimed = structuredClone(base);
  (claimed.captured.files[0] as unknown as Record<string, unknown>).sha256 = "c".repeat(64);
  (claimed.captured.files[0] as unknown as Record<string, unknown>).byteLength = 1;
  expectCode(() => buildSliceProjection(claimed), "slice_projection_input_invalid");
});

family("canonical-base64", () => {
  const variants = ["", `${base.captured.files[0]!.contentBase64}=`, "not base64"];
  for (const contentBase64 of variants) {
    const changed = replaceFile(base, base.captured.files[0]!.path, { contentBase64 });
    expectCode(() => buildSliceProjection(changed), "slice_captured_base64_invalid:");
  }
});

family("canonical-paths", () => {
  for (const path of ["/absolute.json", "traceability/../alias.json", "traceability\\alias.json"]) {
    const changed = replaceFile(base, base.captured.files[0]!.path, { path });
    expectCode(() => buildSliceProjection(changed), "slice_captured_path_invalid:");
  }
  const generated = replaceFile(base, base.captured.files[0]!.path, { path: SLICE_PROJECTION_PATHS.s2Trace });
  expectCode(() => buildSliceProjection(generated), `slice_projection_self_input:${SLICE_PROJECTION_PATHS.s2Trace}`);
});

family("exact-input-path-surface", () => {
  expectCode(() => buildSliceProjection(removeFile(base, ROOT_POLICY.sourcePath)), `slice_input_missing:${ROOT_POLICY.sourcePath}`);
  expectCode(() => buildSliceProjection(addFile(base, {
    path: "qa/noncanonical-extra.json",
    contentBase64: Buffer.from("{}\n").toString("base64"),
  })), "slice_evidence_surface_invalid");
  const duplicate = mutableClone(base);
  duplicate.captured.files.push({ ...duplicate.captured.files[0]! });
  expectCode(() => buildSliceProjection(duplicate as SliceProjectionInput), "slice_captured_path_duplicate");
});

family("declaration-byte-binding", () => {
  const changed = mutateJsonFile(base, SLICE_PROJECTION_PATHS.declarations, (value) => {
    value.slices[0].name = `${value.slices[0].name} exact-byte mutation`;
  });
  const build = buildSliceProjection(changed);
  assert.notEqual(build.inputIdentity, baseline.inputIdentity);
  assert.notEqual(build.artifactsByPath[SLICE_PROJECTION_PATHS.s2Trace]!.sha256,
    baseline.artifactsByPath[SLICE_PROJECTION_PATHS.s2Trace]!.sha256);
  expectCode(() => buildSliceProjection({ ...base, declarations: { slices: [] } } as never),
    "slice_projection_input_invalid");
  const duplicate = replaceText(base, SLICE_PROJECTION_PATHS.declarations, duplicateFirstObjectKey);
  expectCode(() => buildSliceProjection(duplicate), "slice_declarations_key_duplicate");
});

family("requirements-byte-and-identity-binding", () => {
  const registry = replaceText(base, SLICE_PROJECTION_PATHS.requirementsRegistry, (text) => `${text} `);
  expectCode(() => buildSliceProjection(registry), "slice_requirements_bytes_stale");
  const source = replaceText(base, "traceability/canonical/harness-requirements.md", (text) => `${text} `);
  expectCode(() => buildSliceProjection(source), "slice_requirements_bytes_stale");
  expectCode(() => buildSliceProjection({ ...base, requirementsIdentityHash: "d".repeat(64) } as never),
    "slice_projection_input_invalid");
  expectCode(() => buildSliceProjection(replaceText(
    base,
    SLICE_PROJECTION_PATHS.requirementsRegistry,
    duplicateFirstObjectKey,
  )), "requirements_registry_key_duplicate");
});

family("source-manifest-duplicate-keys", () => {
  for (const [path, code] of [
    ["traceability/sources/s2/research-manifest.json", "s2_research_manifest_key_duplicate"],
    ["traceability/sources/s2/manifest.json", "official_fragment_manifest_key_duplicate"],
    ["traceability/sources/s3.1/manifest.json", "s31_source_manifest_key_duplicate"],
  ] as const) {
    expectCode(() => buildSliceProjection(replaceText(base, path, duplicateFirstObjectKey)), code);
  }
  const s31JsonEvidence = "traceability/sources/s3.1/jcs-values-input.json";
  expectCode(() => buildSliceProjection(replaceText(base, s31JsonEvidence,
    (text) => text.replace('"numbers":', '"numbers": [],\n  "numbers":'))),
    `slice_source_json_key_duplicate:${s31JsonEvidence}`);
});

family("fixture-duplicate-keys", () => {
  const fixture = base.captured.files.find((file) => file.path.startsWith("test/fixtures/s2/"))!;
  expectCode(() => buildSliceProjection(replaceText(base, fixture.path, duplicateFirstObjectKey)),
    `slice_fixture_key_duplicate:${fixture.path}`);
});

family("exact-test-source-binding", () => {
  const declarations = capturedDeclarations(base);
  const behavior = declarations.slices[0]!.behaviors[0]!;
  const renamed = mutateJsonFile(base, SLICE_PROJECTION_PATHS.declarations, (value) => {
    value.slices[0].behaviors[0].testName = `${behavior.testName} renamed`;
  });
  expectCode(() => buildSliceProjection(renamed), `slice_test_binding_invalid:${behavior.id}`);
  const changedSource = replaceText(base, declarations.slices[0]!.testSourceId,
    (text) => text.replace(JSON.stringify(behavior.testName), JSON.stringify(`${behavior.testName} source-drift`)));
  expectCode(() => buildSliceProjection(changedSource), `slice_test_binding_invalid:${behavior.id}`);
  const first = declarations.slices[0]!.behaviors[0]!.testName;
  const second = declarations.slices[0]!.behaviors[1]!.testName;
  const duplicateSource = replaceText(base, declarations.slices[0]!.testSourceId,
    (text) => text.replace(JSON.stringify(second), JSON.stringify(first)));
  expectCode(() => buildSliceProjection(duplicateSource), "slice_test_source_invalid:");
});

family("source-byte-cascade", () => {
  for (const [path, mutate] of [
    ["traceability/sources/s2/research-manifest.json", (value: any) => { value.sources[2].finding += "; exact-byte review"; }],
    ["traceability/sources/s2/manifest.json", (value: any) => { value.sources[0].fragments[0].purpose += "; exact-byte review"; }],
    ["traceability/sources/s3.1/manifest.json", (value: any) => { value.sources[0].finding += "; exact-byte review"; }],
  ] as const) {
    const build = buildSliceProjection(mutateJsonFile(base, path, mutate));
    assert.notEqual(build.inputIdentity, baseline.inputIdentity);
  }
});

family("complete-fixture-surface", () => {
  const b01 = base.captured.files.filter((file) => file.path.startsWith("test/fixtures/s2/b01-tool-boundary/"));
  const incomplete = b01.slice(0, 2).reduce((input, file) => removeFile(input, file.path), base);
  expectCode(() => buildSliceProjection(incomplete), "slice_fixture_namespace_incomplete:S2-B01");
  const unknown = addFile(base, {
    path: "test/fixtures/s2/unknown-namespace/extra.json",
    contentBase64: Buffer.from("{\"extra\":true}\n").toString("base64"),
  });
  expectCode(() => buildSliceProjection(unknown), "slice_fixture_surface_invalid");
  const moved = replaceFile(base, b01[0]!.path, { path: b01[0]!.path.replace("b01-tool-boundary", "b02-capabilities") });
  expectCode(() => buildSliceProjection(moved), "slice_fixture_");
});

family("deterministic-captured-order", () => {
  const reverse = mutableClone(base);
  reverse.captured.files.reverse();
  const first = buildSliceProjection(reverse as SliceProjectionInput);
  assert.equal(first.inputIdentity, baseline.inputIdentity);
  assert.deepEqual(first.artifactIdentitiesByPath, baseline.artifactIdentitiesByPath);
  assert.deepEqual(Object.fromEntries(Object.entries(first.artifactsByPath).map(([path, value]) => [path, value.bytes])),
    Object.fromEntries(Object.entries(baseline.artifactsByPath).map(([path, value]) => [path, value.bytes])));
});

family("version-and-unassessed-semantics", () => {
  const wrong = mutableClone(base);
  wrong.captured.schemaVersion = "bridlewise-slice-projection-captured-values/v2";
  expectCode(() => buildSliceProjection(wrong as never), "slice_projection_input_invalid");
  for (const artifact of Object.values(baseline.artifactsByPath)) {
    if (!artifact.path.endsWith("s2.json") && !artifact.path.endsWith("s2.4.json") &&
      !artifact.path.endsWith("s3.1.json")) continue;
    const value = artifact.value as { auditMatrix: { independentAudit: { outcome: string } } };
    assert.equal(value.auditMatrix.independentAudit.outcome, "unassessed");
  }
});

assert.equal(families.length, 16);
const current = Object.keys(baseline.artifactsByPath).map((path) => ({ path, bytes: readFileSync(path, "utf8") }));
process.stdout.write(`${JSON.stringify({
  families,
  buildIdentity: baseline.inputIdentity,
  artifactHashes: Object.fromEntries(Object.entries(baseline.artifactsByPath).map(([path, value]) => [path, value.sha256])),
  currentDispositions: checkSliceProjection(baseline, current).paths,
})}\n`);

function family(name: string, run: () => void): void {
  run();
  families.push(name);
}

function expectCode(run: () => unknown, prefix: string): void {
  assert.throws(run, (error: unknown) => error instanceof InputError && error.code.startsWith(prefix));
}

function replaceFile(
  input: SliceProjectionInput,
  originalPath: string,
  replacement: Partial<SliceProjectionCapturedFile>,
): SliceProjectionInput {
  const clone = mutableClone(input);
  const index = clone.captured.files.findIndex((file) => file.path === originalPath);
  assert.notEqual(index, -1, originalPath);
  clone.captured.files[index] = { ...clone.captured.files[index]!, ...replacement };
  return clone as SliceProjectionInput;
}

function removeFile(input: SliceProjectionInput, path: string): SliceProjectionInput {
  const clone = mutableClone(input);
  clone.captured.files = clone.captured.files.filter((file) => file.path !== path);
  return clone as SliceProjectionInput;
}

function addFile(input: SliceProjectionInput, file: SliceProjectionCapturedFile): SliceProjectionInput {
  const clone = mutableClone(input);
  clone.captured.files.push(file);
  return clone as SliceProjectionInput;
}

function mutableClone(input: SliceProjectionInput): MutableProjectionInput {
  return structuredClone(input) as MutableProjectionInput;
}

function replaceText(input: SliceProjectionInput, path: string, transform: (text: string) => string): SliceProjectionInput {
  const current = input.captured.files.find((file) => file.path === path)!;
  const text = Buffer.from(current.contentBase64, "base64").toString("utf8");
  return replaceFile(input, path, { contentBase64: Buffer.from(transform(text)).toString("base64") });
}

function mutateJsonFile(input: SliceProjectionInput, path: string, mutate: (value: any) => void): SliceProjectionInput {
  return replaceText(input, path, (text) => {
    const value = JSON.parse(text);
    mutate(value);
    return `${JSON.stringify(value, null, 2)}\n`;
  });
}

function duplicateFirstObjectKey(text: string): string {
  return text.replace(/^(\s*)("[^"]+"\s*:\s*(?:"[^"]*"|true|false|null|-?[0-9]+),)/mu, "$1$2\n$1$2");
}

function capturedDeclarations(input: SliceProjectionInput) {
  const file = input.captured.files.find((entry) => entry.path === SLICE_PROJECTION_PATHS.declarations)!;
  return parseSliceDeclarationsText(Buffer.from(file.contentBase64, "base64").toString("utf8"));
}
