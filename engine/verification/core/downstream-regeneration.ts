import { InputError } from "../../src/kernel/errors.ts";
import { canonicalHash, deepFreeze, sha256, type DeepReadonly } from "../../src/kernel/integrity.ts";
import { compareUtf8Bytes, sameOrderedValues } from "../../src/kernel/ordered.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { SLICE_PROJECTION_PATHS, VERIFICATION_PATHS } from "../../src/kernel/verification-paths.ts";

export const DOWNSTREAM_REGENERATION_SCHEMA_VERSION =
  "bridlewise-downstream-regeneration/v1" as const;
export const DOWNSTREAM_REGENERATION_REVISION =
  "downstream-regeneration-checker/v1" as const;
export const DOWNSTREAM_REGENERATION_ORDERING_RULE =
  "unsigned-utf8-byte-lexicographic/v1" as const;

export type DownstreamArtifactId =
  | "configuration-document-schema"
  | "requirements-schema"
  | "contract-schemas"
  | "forensic-schemas"
  | "test-inventory"
  | "slice-s2"
  | "slice-s2.4"
  | "slice-s3.1";

type DownstreamArtifactRegistration = DeepReadonly<{
  id: DownstreamArtifactId;
  path: string;
  stage: string;
}>;

const DOWNSTREAM_ARTIFACT_REGISTRY_SOURCE = [
  {
    id: "configuration-document-schema",
    path: ROOT_POLICY.configuration.contract.generatedSchemaPath,
    stage: "generate-schemas",
  },
  {
    id: "requirements-schema",
    path: SLICE_PROJECTION_PATHS.requirementsSchemaArtifact,
    stage: "generate-schemas",
  },
  {
    id: "contract-schemas",
    path: SLICE_PROJECTION_PATHS.contractSchemaArtifact,
    stage: "generate-schemas",
  },
  {
    id: "forensic-schemas",
    path: SLICE_PROJECTION_PATHS.forensicSchemaArtifact,
    stage: "generate-schemas",
  },
  {
    id: "test-inventory",
    path: VERIFICATION_PATHS.testInventory,
    stage: "generate-test-inventory",
  },
  {
    id: "slice-s2",
    path: SLICE_PROJECTION_PATHS.s2Trace,
    stage: "generate-slice-projections",
  },
  {
    id: "slice-s2.4",
    path: SLICE_PROJECTION_PATHS.s24Trace,
    stage: "generate-slice-projections",
  },
  {
    id: "slice-s3.1",
    path: SLICE_PROJECTION_PATHS.s31Trace,
    stage: "generate-slice-projections",
  },
] as const satisfies readonly DownstreamArtifactRegistration[];

export const DOWNSTREAM_ARTIFACT_REGISTRY: readonly DownstreamArtifactRegistration[] = deepFreeze(
  [...DOWNSTREAM_ARTIFACT_REGISTRY_SOURCE].toSorted((left, right) =>
    compareUtf8Bytes(left.id, right.id),
  ),
);

export const DOWNSTREAM_ARTIFACT_IDS: readonly DownstreamArtifactId[] = deepFreeze(
  DOWNSTREAM_ARTIFACT_REGISTRY.map((entry) => entry.id),
);

export const DOWNSTREAM_ARTIFACT_PATHS: readonly string[] = deepFreeze(
  DOWNSTREAM_ARTIFACT_REGISTRY.map((entry) => entry.path),
);

export const DOWNSTREAM_ARTIFACT_REGISTRY_IDENTITY = canonicalHash(DOWNSTREAM_ARTIFACT_REGISTRY);

export type DownstreamArtifactBuild = DeepReadonly<{
  id: DownstreamArtifactId;
  path: string;
  bytes: string;
  sha256: string;
  identityHash: string;
}>;

export type DownstreamRegenerationBuild = DeepReadonly<{
  schemaVersion: typeof DOWNSTREAM_REGENERATION_SCHEMA_VERSION;
  artifacts: readonly DownstreamArtifactBuild[];
  buildIdentity: string;
}>;

export type DownstreamArtifactDisposition =
  | "exact"
  | "missing"
  | "drift"
  | "duplicate";

export type DownstreamArtifactResult = DeepReadonly<{
  id: DownstreamArtifactId;
  path: string;
  stage: string;
  disposition: DownstreamArtifactDisposition;
  expectedSha256: string;
  observedSha256: string | null;
  expectedByteLength: number;
  observedByteLength: number | null;
}>;

export type DownstreamRegenerationResult = DeepReadonly<{
  schemaVersion: typeof DOWNSTREAM_REGENERATION_SCHEMA_VERSION;
  revision: typeof DOWNSTREAM_REGENERATION_REVISION;
  registryIdentity: string;
  orderingRule: typeof DOWNSTREAM_REGENERATION_ORDERING_RULE;
  consistent: boolean;
  artifactCount: number;
  destinationCount: number;
  artifacts: readonly DownstreamArtifactResult[];
  unexpectedPaths: readonly string[];
  violations: readonly string[];
  resultIdentity: string;
}>;

type DestinationEntry = DeepReadonly<{ path: string; bytes: string }>;

export function compileDownstreamRegenerationBuild(
  artifacts: readonly DownstreamArtifactBuild[],
): DownstreamRegenerationBuild {
  assertUnique(artifacts.map((entry) => entry.id), "downstream_artifact_id_duplicate");
  assertUnique(artifacts.map((entry) => entry.path), "downstream_artifact_path_duplicate");
  if (artifacts.length < DOWNSTREAM_ARTIFACT_REGISTRY.length) {
    throw new InputError(
      "Downstream regeneration build is missing artifacts",
      "downstream_build_artifact_missing",
    );
  }
  if (artifacts.length > DOWNSTREAM_ARTIFACT_REGISTRY.length) {
    throw new InputError(
      "Downstream regeneration build has extra artifacts",
      "downstream_build_artifact_count_invalid",
    );
  }
  const expectedArtifactKeys = ["bytes", "id", "identityHash", "path", "sha256"];
  const byId = new Map(artifacts.map((entry) => [entry.id, entry]));
  for (const registration of DOWNSTREAM_ARTIFACT_REGISTRY) {
    const artifact = byId.get(registration.id);
    if (!artifact) {
      throw new InputError(
        "Downstream regeneration build is missing a required artifact",
        "downstream_build_artifact_missing",
      );
    }
    if (artifact.path !== registration.path) {
      throw new InputError(
        "Downstream regeneration build path does not match the registry",
        "downstream_build_path_mismatch",
      );
    }
    const actualArtifactKeys = Object.keys(artifact).toSorted();
    if (!sameOrderedValues(actualArtifactKeys, expectedArtifactKeys)) {
      throw new InputError(
        "Downstream regeneration build artifact has unknown fields",
        "downstream_build_artifact_unknown_fields",
      );
    }
    if (sha256(artifact.bytes) !== artifact.sha256) {
      throw new InputError(
        "Downstream regeneration build sha256 does not match its bytes",
        "downstream_build_sha256_invalid",
      );
    }
    if (artifact.bytes.length === 0) {
      throw new InputError(
        "Downstream regeneration build artifact is empty",
        "downstream_build_artifact_empty",
      );
    }
  }
  const sorted = [...artifacts].toSorted((left, right) => compareUtf8Bytes(left.id, right.id));
  const payload = {
    schemaVersion: DOWNSTREAM_REGENERATION_SCHEMA_VERSION,
    artifacts: sorted.map((entry) => ({
      id: entry.id,
      path: entry.path,
      sha256: entry.sha256,
      identityHash: entry.identityHash,
      byteLength: entry.bytes.length,
    })),
  };
  return deepFreeze({
    schemaVersion: DOWNSTREAM_REGENERATION_SCHEMA_VERSION,
    artifacts: sorted,
    buildIdentity: canonicalHash(payload),
  });
}

export function checkDownstreamRegeneration(
  build: DownstreamRegenerationBuild,
  destinations: readonly DestinationEntry[],
): DownstreamRegenerationResult {
  validateDownstreamRegenerationBuild(build);
  const byPath = groupDestinationsByPath(destinations);
  const artifactResults = build.artifacts.map((artifact) => {
    const observed = byPath.get(artifact.path) ?? [];
    if (observed.length === 0) {
      return {
        id: artifact.id,
        path: artifact.path,
        stage: stageForId(artifact.id),
        disposition: "missing" as const,
        expectedSha256: artifact.sha256,
        observedSha256: null,
        expectedByteLength: artifact.bytes.length,
        observedByteLength: null,
      };
    }
    if (observed.length > 1) {
      return {
        id: artifact.id,
        path: artifact.path,
        stage: stageForId(artifact.id),
        disposition: "duplicate" as const,
        expectedSha256: artifact.sha256,
        observedSha256: sha256(observed[0]!),
        expectedByteLength: artifact.bytes.length,
        observedByteLength: observed[0]!.length,
      };
    }
    const observedBytes = observed[0]!;
    const observedSha = sha256(observedBytes);
    return {
      id: artifact.id,
      path: artifact.path,
      stage: stageForId(artifact.id),
      disposition: observedBytes === artifact.bytes ? "exact" as const : "drift" as const,
      expectedSha256: artifact.sha256,
      observedSha256: observedSha,
      expectedByteLength: artifact.bytes.length,
      observedByteLength: observedBytes.length,
    };
  });
  const expectedPaths = new Set(build.artifacts.map((artifact) => artifact.path));
  const unexpectedPaths = [...byPath.keys()]
    .filter((path) => !expectedPaths.has(path))
    .toSorted(compareUtf8Bytes);
  const violations = [
    ...artifactResults
      .filter((entry) => entry.disposition !== "exact")
      .map((entry) => `downstream_${entry.disposition}:${entry.id}:${entry.path}`),
    ...unexpectedPaths.map((path) => `downstream_unexpected:${path}`),
  ].toSorted(compareUtf8Bytes);
  const consistent = artifactResults.every((entry) => entry.disposition === "exact") &&
    unexpectedPaths.length === 0;
  const resultPayload = {
    schemaVersion: DOWNSTREAM_REGENERATION_SCHEMA_VERSION,
    revision: DOWNSTREAM_REGENERATION_REVISION,
    registryIdentity: DOWNSTREAM_ARTIFACT_REGISTRY_IDENTITY,
    orderingRule: DOWNSTREAM_REGENERATION_ORDERING_RULE,
    consistent,
    artifactCount: artifactResults.length,
    destinationCount: destinations.length,
    artifacts: artifactResults,
    unexpectedPaths,
    violations,
  };
  return deepFreeze({ ...resultPayload, resultIdentity: canonicalHash(resultPayload) });
}

function validateDownstreamRegenerationBuild(build: DownstreamRegenerationBuild): void {
  const expectedBuildKeys = ["artifacts", "buildIdentity", "schemaVersion"];
  const actualBuildKeys = Object.keys(build).toSorted();
  if (!sameOrderedValues(actualBuildKeys, expectedBuildKeys)) {
    throw new InputError(
      "Downstream regeneration build has unknown fields",
      "downstream_build_unknown_fields",
    );
  }
  if (build.schemaVersion !== DOWNSTREAM_REGENERATION_SCHEMA_VERSION) {
    throw new InputError(
      "Downstream regeneration build schema version is invalid",
      "downstream_build_schema_version_invalid",
    );
  }
  assertUnique(build.artifacts.map((entry) => entry.id), "downstream_build_id_duplicate");
  assertUnique(build.artifacts.map((entry) => entry.path), "downstream_build_path_duplicate");
  if (build.artifacts.length !== DOWNSTREAM_ARTIFACT_REGISTRY.length) {
    throw new InputError(
      "Downstream regeneration build artifact count is invalid",
      "downstream_build_artifact_count_invalid",
    );
  }
  const byId = new Map(build.artifacts.map((entry) => [entry.id, entry]));
  for (const registration of DOWNSTREAM_ARTIFACT_REGISTRY) {
    const artifact = byId.get(registration.id);
    if (!artifact || artifact.path !== registration.path) {
      throw new InputError(
        "Downstream regeneration build does not match the registry",
        "downstream_build_registry_mismatch",
      );
    }
    const expectedArtifactKeys = ["bytes", "id", "identityHash", "path", "sha256"];
    const actualArtifactKeys = Object.keys(artifact).toSorted();
    if (!sameOrderedValues(actualArtifactKeys, expectedArtifactKeys)) {
      throw new InputError(
        "Downstream regeneration build artifact has unknown fields",
        "downstream_build_artifact_unknown_fields",
      );
    }
    if (sha256(artifact.bytes) !== artifact.sha256 || artifact.bytes.length === 0) {
      throw new InputError(
        "Downstream regeneration build artifact bytes are invalid",
        "downstream_build_bytes_invalid",
      );
    }
  }
  const ids = build.artifacts.map((entry) => entry.id);
  if (!sameOrderedValues(ids, [...ids].toSorted(compareUtf8Bytes))) {
    throw new InputError(
      "Downstream regeneration build artifact order is invalid",
      "downstream_build_order_invalid",
    );
  }
  if (!sameOrderedValues(ids, DOWNSTREAM_ARTIFACT_IDS)) {
    throw new InputError(
      "Downstream regeneration build does not match the registry",
      "downstream_build_registry_mismatch",
    );
  }
  const payload = {
    schemaVersion: build.schemaVersion,
    artifacts: build.artifacts.map((entry) => ({
      id: entry.id,
      path: entry.path,
      sha256: entry.sha256,
      identityHash: entry.identityHash,
      byteLength: entry.bytes.length,
    })),
  };
  if (canonicalHash(payload) !== build.buildIdentity) {
    throw new InputError(
      "Downstream regeneration build identity is invalid",
      "downstream_build_identity_invalid",
    );
  }
}

function groupDestinationsByPath(
  destinations: readonly DestinationEntry[],
): Map<string, string[]> {
  const byPath = new Map<string, string[]>();
  for (const destination of destinations) {
    if (typeof destination.path !== "string" || typeof destination.bytes !== "string") {
      throw new InputError(
        "Downstream regeneration destination entry is invalid",
        "downstream_destination_invalid",
      );
    }
    const values = byPath.get(destination.path) ?? [];
    values.push(destination.bytes);
    byPath.set(destination.path, values);
  }
  return byPath;
}

function stageForId(id: DownstreamArtifactId): string {
  const registration = DOWNSTREAM_ARTIFACT_REGISTRY.find((entry) => entry.id === id);
  if (!registration) {
    throw new InputError(
      "Downstream artifact id is not in the registry",
      "downstream_artifact_id_unknown",
    );
  }
  return registration.stage;
}

function assertUnique(values: readonly string[], code: string): void {
  if (new Set(values).size !== values.length) {
    throw new InputError("Values must be unique", code);
  }
}
