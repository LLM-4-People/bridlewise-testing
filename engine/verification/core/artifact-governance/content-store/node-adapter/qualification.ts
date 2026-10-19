import { InputError } from "../../../../../src/kernel/errors.ts";
import { compileExactWriteLease, type ExactWriteLease } from
  "../../../../../src/modules/effect-boundary/index.ts";

import type { ContentStoreCandidate } from "../candidate.ts";
import { contentTreeBytes } from "../tree.ts";
import {
  reconstructContentTree,
  withObservedContentRootForNodeAdapterInternal,
  type ContentRootCapability,
} from "./reconstruct.ts";
import { scanContentTree, type ContentTreeScan } from "./scan.ts";
import {
  CONTENT_STORE_SYNTHETIC_QUALIFICATION_RESIDUE_DISPOSITION,
  type ContentStoreFirstActivationRequest,
} from "./transaction-contracts.ts";
import { readDurableRootDirectory } from "./transaction-state.ts";

const QUALIFICATION_PATH = /^[a-z0-9][a-z0-9.-]{0,126}$/u;

export function compileContentStoreSyntheticQualificationLease(
  root: ContentRootCapability,
  destinationRelativePath: string,
): ExactWriteLease {
  assertQualificationPath(destinationRelativePath);
  return compileExactWriteLease(root, [{
    operation: "create-directory",
    relativePath: destinationRelativePath,
  }]);
}

export function qualifyCandidate(
  request: ContentStoreFirstActivationRequest,
  sourceScan: ContentTreeScan,
): void {
  const qualification = request.qualification;
  assertQualificationPath(qualification.destinationRelativePath);
  withObservedContentRootForNodeAdapterInternal(qualification.root, (qualificationRootPath) => {
    const entries = readDurableRootDirectory(qualificationRootPath);
    const existing = entries.find((entry) => entry.name === qualification.destinationRelativePath);
    const qualifiedPath = `${qualificationRootPath}/${qualification.destinationRelativePath}`;
    if (existing === undefined) {
      reconstructContentTree({
        root: qualification.root,
        destinationRelativePath: qualification.destinationRelativePath,
        lease: qualification.lease,
        tree: request.candidate.tree,
        blobs: sourceScan.blobs,
      });
    } else if (existing.kind !== "directory") {
      throw new InputError("Synthetic qualification residue is unsafe", "content_store_qualification_residue_invalid");
    }
    const reconstructionScan = scanContentTree(qualifiedPath);
    if (!Buffer.from(contentTreeBytes(reconstructionScan.tree)).equals(
      Buffer.from(contentTreeBytes(request.candidate.tree)),
    ) || reconstructionScan.logicalByteLength !== sourceScan.logicalByteLength) {
      throw new InputError("Synthetic qualification rescan changed", "content_store_qualification_rescan_mismatch");
    }
  });
}

export function assertScanMatchesCandidate(scan: ContentTreeScan, candidate: ContentStoreCandidate): void {
  if (!Buffer.from(contentTreeBytes(scan.tree)).equals(Buffer.from(contentTreeBytes(candidate.tree)))) {
    throw new InputError("Content source scan does not match candidate", "content_store_source_candidate_mismatch");
  }
  const expected = scan.blobs.map((blob) => `${blob.sha256}:${blob.byteLength}`).toSorted();
  const actual = candidate.packs.flatMap((pack) => pack.index.records.map(
    (record) => `${record.blobSha256}:${record.blobByteLength}`,
  )).toSorted();
  if (expected.length !== actual.length || expected.some((value, index) => value !== actual[index])) {
    throw new InputError("Content source blob closure does not match candidate", "content_store_source_blob_mismatch");
  }
}

export function assertSyntheticQualificationRequest(request: ContentStoreFirstActivationRequest): void {
  if (request.qualification.mode !== "caller-owned-transient-synthetic-qualification" ||
    request.qualification.residueDisposition !== CONTENT_STORE_SYNTHETIC_QUALIFICATION_RESIDUE_DISPOSITION) {
    throw new InputError("Content store production activation is blocked", "content_store_production_activation_blocked");
  }
  assertQualificationPath(request.qualification.destinationRelativePath);
}

export function qualificationEffect(destinationRelativePath: string): Readonly<{
  operation: "create-directory";
  relativePath: string;
}> {
  assertQualificationPath(destinationRelativePath);
  return Object.freeze({ operation: "create-directory", relativePath: destinationRelativePath });
}

function assertQualificationPath(relativePath: string): void {
  if (!QUALIFICATION_PATH.test(relativePath) || relativePath.normalize("NFC") !== relativePath) {
    throw new InputError("Synthetic qualification path is invalid", "content_store_qualification_path_invalid");
  }
}
