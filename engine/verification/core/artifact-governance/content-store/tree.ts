import { InputError } from "../../../../src/kernel/errors.ts";
import { canonicalDomainHash, deepFreeze, sha256 } from "../../../../src/kernel/integrity.ts";
import { ROOT_POLICY } from "../../../../src/kernel/root-policy.ts";
import { z } from "zod";

import {
  assertSha256,
  canonicalDocumentBytes,
  parseCanonicalJsonDocument,
} from "./domain/identities.ts";
import {
  compareEncodedPaths,
  decodeBase64urlBytes,
  encodeBase64urlBytes,
} from "./domain/path-bytes.ts";

export const CONTENT_TREE_SCHEMA_VERSION =
  "bridlewise-content-addressed-evidence-tree/v1" as const;

const POLICY = ROOT_POLICY.artifactGovernance.contentAddressedEvidence.tree;
const SHA256_SCHEMA = z.string().regex(/^[0-9a-f]{64}$/u);
const MODE_SCHEMA = z.number().int().min(0).max(0o7777);
const PATH_SCHEMA = z.array(z.string().min(1)).min(1);
const DIRECTORY_ENTRY_SCHEMA = z.strictObject({
  kind: z.literal("directory"),
  mode: MODE_SCHEMA,
  pathSegmentsBase64url: PATH_SCHEMA,
});
const FILE_ENTRY_SCHEMA = z.strictObject({
  kind: z.literal("file"),
  mode: MODE_SCHEMA,
  pathSegmentsBase64url: PATH_SCHEMA,
  byteLength: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  blobSha256: SHA256_SCHEMA,
});
const SYMLINK_ENTRY_SCHEMA = z.strictObject({
  kind: z.literal("symlink"),
  mode: MODE_SCHEMA,
  pathSegmentsBase64url: PATH_SCHEMA,
  targetBase64url: z.string().min(1),
  targetByteLength: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  targetSha256: SHA256_SCHEMA,
});
const TREE_ENTRY_SCHEMA = z.discriminatedUnion("kind", [
  DIRECTORY_ENTRY_SCHEMA,
  FILE_ENTRY_SCHEMA,
  SYMLINK_ENTRY_SCHEMA,
]);
const TREE_SCHEMA = z.strictObject({
  schemaVersion: z.literal(CONTENT_TREE_SCHEMA_VERSION),
  pathEncoding: z.literal(POLICY.pathEncoding),
  symlinkTargetEncoding: z.literal(POLICY.symlinkTargetEncoding),
  metadataIncluded: z.tuple([
    z.literal("kind"),
    z.literal("mode"),
    z.literal("size"),
    z.literal("sha256"),
  ]),
  metadataExcluded: z.tuple([
    z.literal(POLICY.metadataExcluded[0]),
    z.literal(POLICY.metadataExcluded[1]),
    z.literal(POLICY.metadataExcluded[2]),
    z.literal(POLICY.metadataExcluded[3]),
    z.literal(POLICY.metadataExcluded[4]),
    z.literal(POLICY.metadataExcluded[5]),
    z.literal(POLICY.metadataExcluded[6]),
    z.literal(POLICY.metadataExcluded[7]),
    z.literal(POLICY.metadataExcluded[8]),
    z.literal(POLICY.metadataExcluded[9]),
    z.literal(POLICY.metadataExcluded[10]),
  ]),
  metadataPolicyIdentity: SHA256_SCHEMA,
  entries: z.array(TREE_ENTRY_SCHEMA),
  treeIdentity: SHA256_SCHEMA,
});

export type ContentTreeDirectoryEntry = Readonly<z.infer<typeof DIRECTORY_ENTRY_SCHEMA>>;
export type ContentTreeFileEntry = Readonly<z.infer<typeof FILE_ENTRY_SCHEMA>>;
export type ContentTreeSymlinkEntry = Readonly<z.infer<typeof SYMLINK_ENTRY_SCHEMA>>;
export type ContentTreeEntry = Readonly<z.infer<typeof TREE_ENTRY_SCHEMA>>;
export type ContentTree = Readonly<z.infer<typeof TREE_SCHEMA>>;

export function createContentTree(entries: readonly ContentTreeEntry[]): ContentTree {
  const parsedEntries = entries.map((entry) => TREE_ENTRY_SCHEMA.parse(entry));
  const orderedEntries = parsedEntries.toSorted((left, right) =>
    compareEncodedPaths(left.pathSegmentsBase64url, right.pathSegmentsBase64url)
  );
  validateTreeEntries(orderedEntries);
  const metadataPolicyIdentity = treeMetadataPolicyIdentity();
  const payload = {
    schemaVersion: CONTENT_TREE_SCHEMA_VERSION,
    pathEncoding: POLICY.pathEncoding,
    symlinkTargetEncoding: POLICY.symlinkTargetEncoding,
    metadataIncluded: [...POLICY.metadataIncluded] as ["kind", "mode", "size", "sha256"],
    metadataExcluded: [...POLICY.metadataExcluded] as typeof POLICY.metadataExcluded,
    metadataPolicyIdentity,
    entries: orderedEntries,
  };
  return parseContentTree({
    ...payload,
    treeIdentity: canonicalDomainHash("content-store.tree/v1", payload),
  });
}

export function contentTreeBytes(tree: ContentTree): Uint8Array {
  return canonicalDocumentBytes(parseContentTree(tree));
}

export function parseContentTreeBytes(bytes: Uint8Array): ContentTree {
  return parseContentTree(parseCanonicalJsonDocument(bytes, "Content tree"));
}

export function verifyContentTreeBlobSet(tree: ContentTree, blobDigests: ReadonlySet<string>): void {
  const parsed = parseContentTree(tree);
  for (const entry of parsed.entries) {
    if (entry.kind === "file" && !blobDigests.has(entry.blobSha256)) {
      throw new InputError("Content tree references a missing blob", "content_store_tree_blob_missing");
    }
  }
}

export function treeMetadataPolicyIdentity(): string {
  return canonicalDomainHash("content-store.tree-metadata-policy/v1", {
    included: POLICY.metadataIncluded,
    excluded: POLICY.metadataExcluded,
    hardlinkDisposition: POLICY.hardlinkDisposition,
    specialEntryDisposition: POLICY.specialEntryDisposition,
    symlinkDisposition: POLICY.symlinkDisposition,
  });
}

function parseContentTree(candidate: unknown): ContentTree {
  const parsed = TREE_SCHEMA.parse(candidate);
  if (parsed.metadataPolicyIdentity !== treeMetadataPolicyIdentity()) {
    throw new InputError("Content tree metadata policy is invalid", "content_store_tree_metadata_policy_invalid");
  }
  const { treeIdentity, ...payload } = parsed;
  if (canonicalDomainHash("content-store.tree/v1", payload) !== treeIdentity) {
    throw new InputError("Content tree identity is invalid", "content_store_tree_identity_invalid");
  }
  validateTreeEntries(parsed.entries);
  return deepFreeze(parsed);
}

function validateTreeEntries(entries: readonly ContentTreeEntry[]): void {
  const byPath = new Map<string, ContentTreeEntry>();
  let previousPath: readonly string[] | undefined;
  for (const entry of entries) {
    for (const segment of entry.pathSegmentsBase64url) decodeBase64urlBytes(segment);
    if (previousPath !== undefined &&
      compareEncodedPaths(previousPath, entry.pathSegmentsBase64url) >= 0) {
      throw new InputError("Content tree order is invalid", "content_store_tree_order_invalid");
    }
    const key = pathKey(entry.pathSegmentsBase64url);
    if (byPath.has(key)) {
      throw new InputError("Content tree path is duplicated", "content_store_tree_path_duplicate");
    }
    const parent = entry.pathSegmentsBase64url.slice(0, -1);
    if (parent.length > 0 && byPath.get(pathKey(parent))?.kind !== "directory") {
      throw new InputError("Content tree parent is absent", "content_store_tree_parent_missing");
    }
    if (entry.kind === "file") assertSha256(entry.blobSha256);
    if (entry.kind === "symlink") validateSymlinkReceipt(entry);
    byPath.set(key, entry);
    previousPath = entry.pathSegmentsBase64url;
  }
  for (const entry of entries) {
    if (entry.kind !== "symlink") continue;
    const targetPath = resolveSymlinkTarget(entry);
    const target = byPath.get(pathKey(targetPath));
    if (target === undefined || target.kind === "symlink") {
      throw new InputError(
        "Content tree symlink target is absent or indirect",
        "content_store_tree_symlink_target_invalid",
      );
    }
  }
}

function validateSymlinkReceipt(entry: ContentTreeSymlinkEntry): void {
  const target = decodeBase64urlBytes(entry.targetBase64url);
  if (target.byteLength !== entry.targetByteLength || sha256(target) !== entry.targetSha256) {
    throw new InputError(
      "Content tree symlink receipt is invalid",
      "content_store_tree_symlink_receipt_invalid",
    );
  }
  if (target[0] === 0x2f || target.includes(0)) {
    throw new InputError(
      "Content tree symlink target is not confined",
      "content_store_tree_symlink_target_unconfined",
    );
  }
}

function resolveSymlinkTarget(entry: ContentTreeSymlinkEntry): readonly string[] {
  const resolved = [...entry.pathSegmentsBase64url.slice(0, -1)];
  for (const rawSegment of splitPosixBytes(decodeBase64urlBytes(entry.targetBase64url))) {
    if (rawSegment.byteLength === 0 || isAscii(rawSegment, ".")) continue;
    if (isAscii(rawSegment, "..")) {
      if (resolved.length === 0) {
        throw new InputError(
          "Content tree symlink escapes its root",
          "content_store_tree_symlink_target_unconfined",
        );
      }
      resolved.pop();
      continue;
    }
    resolved.push(encodeBase64urlBytes(rawSegment));
  }
  if (resolved.length === 0) {
    throw new InputError(
      "Content tree symlink resolves to its unrecorded root",
      "content_store_tree_symlink_target_invalid",
    );
  }
  return resolved;
}

function splitPosixBytes(bytes: Uint8Array): readonly Uint8Array[] {
  const segments: Uint8Array[] = [];
  let start = 0;
  for (let index = 0; index <= bytes.byteLength; index += 1) {
    if (index === bytes.byteLength || bytes[index] === 0x2f) {
      segments.push(bytes.slice(start, index));
      start = index + 1;
    }
  }
  return segments;
}

function isAscii(bytes: Uint8Array, value: "." | ".."): boolean {
  return Buffer.from(bytes).equals(Buffer.from(value, "ascii"));
}

function pathKey(path: readonly string[]): string {
  return path.join("/");
}
