import { createHash } from "node:crypto";

const PACK_MAGIC = Buffer.from("CHCASP1\0", "ascii");
const PACK_VERSION = 1;
const PACK_HEADER_BYTES = 20;
const PACK_RECORD_HEADER_BYTES = 40;
const PACK_TRAILER_BYTES = 32;
const PACK_TRAILER_DOMAIN = Buffer.from(
  "bridlewise-content-addressed-evidence-pack-trailer/v1\0",
  "ascii",
);
const CANONICAL_DOMAIN_ENCODING = "bridlewise-canonical-domain-envelope/v1";
const TREE_SCHEMA_VERSION = "bridlewise-content-addressed-evidence-tree/v1";
const TREE_METADATA_INCLUDED = ["kind", "mode", "size", "sha256"] as const;
const TREE_METADATA_EXCLUDED = [
  "acl",
  "atime",
  "birthtime",
  "ctime",
  "gid",
  "hardlink-topology",
  "mtime",
  "ownership",
  "sparse-layout",
  "uid",
  "xattrs",
] as const;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;

export type OraclePackRecord = Readonly<{
  blobByteLength: number;
  blobOffset: number;
  blobSha256: string;
}>;

export type OraclePack = Readonly<{
  byteLength: number;
  packSha256: string;
  records: readonly OraclePackRecord[];
}>;

export type OracleTree = Readonly<{
  entryCount: number;
  fileBlobDigests: readonly string[];
  metadataPolicyIdentity: string;
  treeIdentity: string;
}>;

export function oracleParseContentPack(input: Uint8Array, maximumBytes: number): OraclePack {
  const bytes = Buffer.from(input);
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < PACK_HEADER_BYTES + PACK_TRAILER_BYTES ||
    bytes.byteLength > maximumBytes || bytes.byteLength < PACK_HEADER_BYTES + PACK_TRAILER_BYTES) {
    throw new Error("oracle_pack_size_invalid");
  }
  if (!bytes.subarray(0, PACK_MAGIC.byteLength).equals(PACK_MAGIC)) {
    throw new Error("oracle_pack_magic_invalid");
  }
  if (bytes.readUInt32BE(8) !== PACK_VERSION) throw new Error("oracle_pack_version_invalid");
  const count = safeInteger(bytes.readBigUInt64BE(12), "oracle_pack_count_invalid");
  const records: OraclePackRecord[] = [];
  let offset = PACK_HEADER_BYTES;
  let prior: string | undefined;
  for (let index = 0; index < count; index += 1) {
    if (offset + PACK_RECORD_HEADER_BYTES > bytes.byteLength - PACK_TRAILER_BYTES) {
      throw new Error("oracle_pack_record_truncated");
    }
    const blobSha256 = bytes.subarray(offset, offset + 32).toString("hex");
    const blobByteLength = safeInteger(
      bytes.readBigUInt64BE(offset + 32),
      "oracle_pack_blob_size_invalid",
    );
    const blobOffset = offset + PACK_RECORD_HEADER_BYTES;
    const end = blobOffset + blobByteLength;
    if (!Number.isSafeInteger(end) || end > bytes.byteLength - PACK_TRAILER_BYTES) {
      throw new Error("oracle_pack_blob_truncated");
    }
    if (prior !== undefined && prior >= blobSha256) throw new Error("oracle_pack_order_invalid");
    if (digest(bytes.subarray(blobOffset, end)) !== blobSha256) {
      throw new Error("oracle_pack_blob_digest_invalid");
    }
    records.push(Object.freeze({ blobByteLength, blobOffset, blobSha256 }));
    prior = blobSha256;
    offset = end;
  }
  if (offset !== bytes.byteLength - PACK_TRAILER_BYTES) throw new Error("oracle_pack_layout_invalid");
  const trailer = digest(Buffer.concat([PACK_TRAILER_DOMAIN, bytes.subarray(0, offset)]));
  if (bytes.subarray(offset).toString("hex") !== trailer) throw new Error("oracle_pack_trailer_invalid");
  return Object.freeze({
    byteLength: bytes.byteLength,
    packSha256: digest(bytes),
    records: Object.freeze(records),
  });
}

export function oracleParseContentTree(input: Uint8Array): OracleTree {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input);
  const candidate = JSON.parse(text) as unknown;
  if (text !== `${oracleCanonicalJson(candidate)}\n`) throw new Error("oracle_tree_noncanonical");
  const tree = plainRecord(candidate, "oracle_tree_shape_invalid");
  exactKeys(tree, [
    "entries",
    "metadataExcluded",
    "metadataIncluded",
    "metadataPolicyIdentity",
    "pathEncoding",
    "schemaVersion",
    "symlinkTargetEncoding",
    "treeIdentity",
  ], "oracle_tree_shape_invalid");
  if (tree.schemaVersion !== TREE_SCHEMA_VERSION ||
    tree.pathEncoding !== "base64url-posix-segment-bytes" ||
    tree.symlinkTargetEncoding !== "base64url-posix-bytes" ||
    !sameStringArray(tree.metadataIncluded, TREE_METADATA_INCLUDED) ||
    !sameStringArray(tree.metadataExcluded, TREE_METADATA_EXCLUDED) ||
    !isSha256(tree.metadataPolicyIdentity) || !isSha256(tree.treeIdentity) ||
    !Array.isArray(tree.entries)) {
    throw new Error("oracle_tree_contract_invalid");
  }
  const metadataPolicyIdentity = domainHash("content-store.tree-metadata-policy/v1", {
    included: TREE_METADATA_INCLUDED,
    excluded: TREE_METADATA_EXCLUDED,
    hardlinkDisposition: "reject-before-pack",
    specialEntryDisposition: "reject-before-pack",
    symlinkDisposition: "relative-confined-existing-nonsymlink-target-only",
  });
  if (tree.metadataPolicyIdentity !== metadataPolicyIdentity) {
    throw new Error("oracle_tree_metadata_policy_invalid");
  }
  const { treeIdentity, ...payload } = tree;
  if (domainHash("content-store.tree/v1", payload) !== treeIdentity) {
    throw new Error("oracle_tree_identity_invalid");
  }

  const pathMap = new Map<string, Readonly<{ kind: string; path: readonly string[] }>>();
  const symlinks: Array<Readonly<{ path: readonly string[]; target: Uint8Array }>> = [];
  const fileBlobDigests: string[] = [];
  let previous: readonly string[] | undefined;
  for (const rawEntry of tree.entries) {
    const entry = plainRecord(rawEntry, "oracle_tree_entry_invalid");
    const path = encodedPath(entry.pathSegmentsBase64url);
    if (previous !== undefined && comparePaths(previous, path) >= 0) {
      throw new Error("oracle_tree_order_invalid");
    }
    const key = path.join("/");
    if (pathMap.has(key)) throw new Error("oracle_tree_path_duplicate");
    const parent = path.slice(0, -1);
    if (parent.length > 0 && pathMap.get(parent.join("/"))?.kind !== "directory") {
      throw new Error("oracle_tree_parent_missing");
    }
    if (!Number.isInteger(entry.mode) || Number(entry.mode) < 0 || Number(entry.mode) > 0o7777) {
      throw new Error("oracle_tree_mode_invalid");
    }
    if (entry.kind === "directory") {
      exactKeys(entry, ["kind", "mode", "pathSegmentsBase64url"], "oracle_tree_entry_invalid");
    } else if (entry.kind === "file") {
      exactKeys(entry, [
        "blobSha256",
        "byteLength",
        "kind",
        "mode",
        "pathSegmentsBase64url",
      ], "oracle_tree_entry_invalid");
      if (!isSha256(entry.blobSha256) || !nonnegativeSafeInteger(entry.byteLength)) {
        throw new Error("oracle_tree_file_invalid");
      }
      fileBlobDigests.push(entry.blobSha256);
    } else if (entry.kind === "symlink") {
      exactKeys(entry, [
        "kind",
        "mode",
        "pathSegmentsBase64url",
        "targetBase64url",
        "targetByteLength",
        "targetSha256",
      ], "oracle_tree_entry_invalid");
      const target = decodeBase64url(entry.targetBase64url);
      if (target.byteLength !== entry.targetByteLength || digest(target) !== entry.targetSha256 ||
        target[0] === 0x2f || target.includes(0)) {
        throw new Error("oracle_tree_symlink_receipt_invalid");
      }
      symlinks.push(Object.freeze({ path, target }));
    } else {
      throw new Error("oracle_tree_kind_invalid");
    }
    pathMap.set(key, Object.freeze({ kind: String(entry.kind), path }));
    previous = path;
  }
  for (const symlink of symlinks) {
    const targetPath = resolveTarget(symlink.path, symlink.target);
    const target = pathMap.get(targetPath.join("/"));
    if (target === undefined || target.kind === "symlink") {
      throw new Error("oracle_tree_symlink_target_invalid");
    }
  }
  return Object.freeze({
    entryCount: tree.entries.length,
    fileBlobDigests: Object.freeze(fileBlobDigests.toSorted()),
    metadataPolicyIdentity,
    treeIdentity,
  });
}

export function oracleCanonicalJson(value: unknown): string {
  return encodeCanonical(value, new Set<object>());
}

function encodeCanonical(value: unknown, ancestors: Set<object>): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("oracle_canonical_number_invalid");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value !== "object" || ArrayBuffer.isView(value)) {
    throw new Error("oracle_canonical_value_invalid");
  }
  if (ancestors.has(value)) throw new Error("oracle_canonical_cycle");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => encodeCanonical(entry, ancestors)).join(",")}]`;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new Error("oracle_canonical_object_invalid");
    }
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record).toSorted().map((key) =>
      `${JSON.stringify(key)}:${encodeCanonical(record[key], ancestors)}`
    ).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function domainHash(domain: string, payload: unknown): string {
  return digest(Buffer.from(oracleCanonicalJson({
    domain,
    encoding: CANONICAL_DOMAIN_ENCODING,
    payload,
  }), "utf8"));
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeInteger(value: bigint, code: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(code);
  return Number(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function nonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function plainRecord(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(code);
  }
  return value as Record<string, unknown>;
}

function exactKeys(record: Readonly<Record<string, unknown>>, expected: readonly string[], code: string): void {
  const actual = Object.keys(record).toSorted();
  const orderedExpected = [...expected].toSorted();
  if (actual.length !== orderedExpected.length ||
    actual.some((value, index) => value !== orderedExpected[index])) {
    throw new Error(code);
  }
}

function sameStringArray(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.length === expected.length &&
    value.every((entry, index) => entry === expected[index]);
}

function encodedPath(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((segment) => typeof segment === "string")) {
    throw new Error("oracle_tree_path_invalid");
  }
  for (const segment of value) decodeBase64url(segment);
  return Object.freeze([...value] as string[]);
}

function decodeBase64url(value: unknown): Uint8Array {
  if (typeof value !== "string" || !BASE64URL_PATTERN.test(value)) {
    throw new Error("oracle_base64url_invalid");
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.byteLength === 0 || bytes.toString("base64url") !== value) {
    throw new Error("oracle_base64url_noncanonical");
  }
  return Uint8Array.from(bytes);
}

function comparePaths(left: readonly string[], right: readonly string[]): number {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const result = Buffer.compare(
      Buffer.from(decodeBase64url(left[index]!)),
      Buffer.from(decodeBase64url(right[index]!)),
    );
    if (result !== 0) return result;
  }
  return left.length - right.length;
}

function resolveTarget(path: readonly string[], target: Uint8Array): readonly string[] {
  const resolved = [...path.slice(0, -1)];
  for (const segment of splitBytes(target)) {
    if (segment.byteLength === 0 || Buffer.from(segment).equals(Buffer.from("."))) continue;
    if (Buffer.from(segment).equals(Buffer.from(".."))) {
      if (resolved.length === 0) throw new Error("oracle_tree_symlink_unconfined");
      resolved.pop();
    } else {
      resolved.push(Buffer.from(segment).toString("base64url"));
    }
  }
  if (resolved.length === 0) throw new Error("oracle_tree_symlink_target_invalid");
  return resolved;
}

function splitBytes(bytes: Uint8Array): readonly Uint8Array[] {
  const output: Uint8Array[] = [];
  let start = 0;
  for (let index = 0; index <= bytes.byteLength; index += 1) {
    if (index === bytes.byteLength || bytes[index] === 0x2f) {
      output.push(bytes.slice(start, index));
      start = index + 1;
    }
  }
  return output;
}
