import { InputError } from "../../../../src/kernel/errors.ts";
import { canonicalDomainHash, deepFreeze, sha256 } from "../../../../src/kernel/integrity.ts";
import { ROOT_POLICY } from "../../../../src/kernel/root-policy.ts";

import {
  evaluateContentAdmissionForCandidateInternal,
  type ContentAdmissionAuthority,
  type ContentAdmissionEvidence,
} from "./admission-evidence.ts";
import {
  CONTENT_STORE_REGISTRY_SCHEMA_VERSION,
  type ContentAdmissionDecision,
  type ContentRegistry,
} from "./domain/contracts.ts";
import { canonicalDocumentBytes } from "./domain/identities.ts";
import {
  buildContentPacks,
  contentPackIndexBytes,
  readContentBlobBytes,
  type ContentBlob,
  type ContentPack,
} from "./pack.ts";
import {
  contentTreeBytes,
  verifyContentTreeBlobSet,
  type ContentTree,
} from "./tree.ts";

export type ContentStoreCandidate = Readonly<{
  decision: ContentAdmissionDecision;
  tree: ContentTree;
  packs: readonly ContentPack[];
  registry: ContentRegistry;
}>;

export type ContentStorePreparation =
  | Readonly<{
    status: "admitted";
    decision: ContentAdmissionDecision;
    candidate: ContentStoreCandidate;
  }>
  | Readonly<{
    status: "blocked";
    decision: ContentAdmissionDecision;
    candidate: null;
  }>;

export type ContentBuildStage = "pack" | "registry" | "tree-document";

export function prepareContentStoreCandidate(input: Readonly<{
  tree: ContentTree;
  blobs: readonly ContentBlob[];
  authority: ContentAdmissionAuthority;
  evidence: ContentAdmissionEvidence;
  packCeilingBytes?: number;
  onBuildStage?: (stage: ContentBuildStage) => void;
}>): ContentStorePreparation {
  const blobs = uniqueBlobs(input.blobs);
  assertExactTreeBlobClosure(input.tree, blobs);
  const decision = evaluateContentAdmissionForCandidateInternal(input.authority, input.evidence, blobs);
  if (decision.status === "blocked") {
    return deepFreeze({ status: "blocked", decision, candidate: null });
  }

  input.onBuildStage?.("pack");
  const packs = buildContentPacks(blobs, input.packCeilingBytes);
  input.onBuildStage?.("tree-document");
  const treeBytes = contentTreeBytes(input.tree);
  input.onBuildStage?.("registry");
  const packRecords = packs.map((pack) => {
    const indexBytes = contentPackIndexBytes(pack.index);
    return {
      indexIdentity: pack.index.indexIdentity,
      indexByteLength: indexBytes.byteLength,
      indexSha256: sha256(indexBytes),
      packByteLength: pack.byteLength,
      packSha256: pack.sha256,
    };
  });
  const registryPayload = {
    schemaVersion: CONTENT_STORE_REGISTRY_SCHEMA_VERSION,
    algorithm: "sha256" as const,
    packCeilingBytes: input.packCeilingBytes ??
      ROOT_POLICY.artifactGovernance.contentAddressedEvidence.pack.maximumBytes,
    treeIdentity: input.tree.treeIdentity,
    treeByteLength: treeBytes.byteLength,
    treeSha256: sha256(treeBytes),
    packs: packRecords,
    admissionDecisionIdentity: decision.decisionIdentity,
  };
  const registry: ContentRegistry = deepFreeze({
    ...registryPayload,
    registryIdentity: canonicalDomainHash("content-store.registry/v1", registryPayload),
  });
  const candidate: ContentStoreCandidate = Object.freeze({
    decision,
    tree: input.tree,
    packs,
    registry,
  });
  return Object.freeze({ status: "admitted", decision, candidate });
}

export function contentRegistryBytes(registry: ContentRegistry): Uint8Array {
  const { registryIdentity, ...payload } = registry;
  if (canonicalDomainHash("content-store.registry/v1", payload) !== registryIdentity) {
    throw new InputError("Content registry identity is invalid", "content_store_registry_identity_invalid");
  }
  return canonicalDocumentBytes(registry);
}

function uniqueBlobs(blobs: readonly ContentBlob[]): readonly ContentBlob[] {
  const byDigest = new Map<string, ContentBlob>();
  for (const blob of blobs) {
    const bytes = readContentBlobBytes(blob);
    if (bytes.byteLength !== blob.byteLength || sha256(bytes) !== blob.sha256) {
      throw new InputError("Content blob handle is invalid", "content_store_blob_handle_invalid");
    }
    if (byDigest.has(blob.sha256)) {
      throw new InputError("Content blob input is duplicated", "content_store_blob_duplicate");
    }
    byDigest.set(blob.sha256, blob);
  }
  return Object.freeze([...byDigest.values()].toSorted((left, right) => left.sha256.localeCompare(right.sha256)));
}

function assertExactTreeBlobClosure(tree: ContentTree, blobs: readonly ContentBlob[]): void {
  const digests = new Set(blobs.map((blob) => blob.sha256));
  verifyContentTreeBlobSet(tree, digests);
  const referenced = new Set(tree.entries.flatMap((entry) => entry.kind === "file" ? [entry.blobSha256] : []));
  if (referenced.size !== digests.size || [...digests].some((digest) => !referenced.has(digest))) {
    throw new InputError("Content tree blob closure is not exact", "content_store_tree_blob_closure_invalid");
  }
}
