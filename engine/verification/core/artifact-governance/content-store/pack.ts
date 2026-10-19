import { InputError } from "../../../../src/kernel/errors.ts";
import { canonicalDomainHash, deepFreeze, sha256 } from "../../../../src/kernel/integrity.ts";
import { snapshotUint8Array } from "../../../../src/kernel/safe-structural.ts";
import { z } from "zod";

import {
  assertSha256,
  canonicalDocumentBytes,
  parseCanonicalJsonDocument,
} from "./domain/identities.ts";

export const CONTENT_PACK_INDEX_SCHEMA_VERSION =
  "bridlewise-content-addressed-evidence-pack-index/v1" as const;
export const CONTENT_PACK_MAGIC = "CHCASP1\0" as const;
export const CONTENT_PACK_VERSION = 1;
export const CONTENT_PACK_HEADER_BYTES = 20;
export const CONTENT_PACK_RECORD_HEADER_BYTES = 40;
export const CONTENT_PACK_TRAILER_BYTES = 32;
export const CONTENT_PACK_DEFAULT_CEILING_BYTES = 16_777_216;
export const CONTENT_PACK_TRAILER_DOMAIN =
  "bridlewise-content-addressed-evidence-pack-trailer/v1\0" as const;
export const CONTENT_BYTE_OWNERSHIP_CONTRACT = deepFreeze({
  acceptedIngress: "exact-uint8array-or-buffer-view",
  ingressDisposition: "bounded-snapshot-copy",
  subarrayAndPooledBufferDisposition: "copy-exact-view-bytes",
  sharedResizableDetachedOrExoticBackingDisposition: "reject",
  dataViewArrayBufferSubclassProxyOrWrapperDisposition: "reject",
  egressDisposition: "fresh-defensive-copy",
  internalStorage: "module-private-weak-map",
  deepFreezeClaim: "none-for-byte-storage",
} as const);

const SHA256_SCHEMA = z.string().regex(/^[0-9a-f]{64}$/u);
const NONNEGATIVE_SAFE_INTEGER_SCHEMA = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const PACK_INDEX_RECORD_SCHEMA = z.strictObject({
  blobByteLength: NONNEGATIVE_SAFE_INTEGER_SCHEMA,
  blobOffset: NONNEGATIVE_SAFE_INTEGER_SCHEMA,
  blobSha256: SHA256_SCHEMA,
});
const PACK_INDEX_SCHEMA = z.strictObject({
  schemaVersion: z.literal(CONTENT_PACK_INDEX_SCHEMA_VERSION),
  packByteLength: NONNEGATIVE_SAFE_INTEGER_SCHEMA,
  packSha256: SHA256_SCHEMA,
  records: z.array(PACK_INDEX_RECORD_SCHEMA),
  indexIdentity: SHA256_SCHEMA,
});

export type ContentBlob = Readonly<{
  byteLength: number;
  sha256: string;
}>;

export type ContentPackRecord = Readonly<z.infer<typeof PACK_INDEX_RECORD_SCHEMA>>;
export type ContentPackIndex = Readonly<z.infer<typeof PACK_INDEX_SCHEMA>>;

export type ContentPack = Readonly<{
  byteLength: number;
  index: ContentPackIndex;
  sha256: string;
}>;

const BLOB_BYTES = new WeakMap<ContentBlob, Uint8Array>();
const PACK_BYTES = new WeakMap<ContentPack, Uint8Array>();

export function createContentBlob(
  input: unknown,
  maximumBytes = CONTENT_PACK_DEFAULT_CEILING_BYTES,
): ContentBlob {
  const bytes = snapshotUint8Array(input, maximumBytes);
  const blob = Object.freeze({ byteLength: bytes.byteLength, sha256: sha256(bytes) });
  BLOB_BYTES.set(blob, bytes);
  return blob;
}

export function buildContentPacks(
  inputs: readonly ContentBlob[],
  packCeilingBytes = CONTENT_PACK_DEFAULT_CEILING_BYTES,
): readonly ContentPack[] {
  assertPackCeiling(packCeilingBytes);
  const blobs = deduplicateBlobs(inputs);
  if (blobs.length === 0) return deepFreeze([]);
  const groups: ContentBlob[][] = [];
  let current: ContentBlob[] = [];
  let currentBytes = CONTENT_PACK_HEADER_BYTES + CONTENT_PACK_TRAILER_BYTES;
  for (const blob of blobs) {
    const recordBytes = CONTENT_PACK_RECORD_HEADER_BYTES + blob.byteLength;
    const singleRecordBytes = CONTENT_PACK_HEADER_BYTES + recordBytes + CONTENT_PACK_TRAILER_BYTES;
    if (singleRecordBytes > packCeilingBytes) {
      throw new InputError(
        "Content blob exceeds the pack ceiling",
        `content_store_blob_exceeds_pack_ceiling:${blob.sha256}:${blob.byteLength}:${packCeilingBytes}`,
      );
    }
    if (current.length > 0 && currentBytes + recordBytes > packCeilingBytes) {
      groups.push(current);
      current = [];
      currentBytes = CONTENT_PACK_HEADER_BYTES + CONTENT_PACK_TRAILER_BYTES;
    }
    current.push(blob);
    currentBytes += recordBytes;
  }
  if (current.length > 0) groups.push(current);
  return Object.freeze(groups.map((group) => buildSinglePack(group, packCeilingBytes)));
}

export function parseContentPack(
  input: unknown,
  packCeilingBytes = CONTENT_PACK_DEFAULT_CEILING_BYTES,
): ContentPack {
  assertPackCeiling(packCeilingBytes);
  const bytes = Buffer.from(snapshotUint8Array(input, packCeilingBytes));
  if (bytes.byteLength > packCeilingBytes ||
    bytes.byteLength < CONTENT_PACK_HEADER_BYTES + CONTENT_PACK_TRAILER_BYTES) {
    throw new InputError("Content pack size is invalid", "content_store_pack_size_invalid");
  }
  if (!bytes.subarray(0, 8).equals(Buffer.from(CONTENT_PACK_MAGIC, "ascii"))) {
    throw new InputError("Content pack magic is invalid", "content_store_pack_magic_invalid");
  }
  if (bytes.readUInt32BE(8) !== CONTENT_PACK_VERSION) {
    throw new InputError("Content pack version is invalid", "content_store_pack_version_invalid");
  }
  const count = safeUnsignedInteger(bytes.readBigUInt64BE(12), "content_store_pack_count_invalid");
  const records: ContentPackRecord[] = [];
  let offset = CONTENT_PACK_HEADER_BYTES;
  let previousDigest: string | undefined;
  for (let index = 0; index < count; index += 1) {
    if (offset + CONTENT_PACK_RECORD_HEADER_BYTES > bytes.byteLength - CONTENT_PACK_TRAILER_BYTES) {
      throw new InputError("Content pack record is truncated", "content_store_pack_record_truncated");
    }
    const blobSha256 = bytes.subarray(offset, offset + 32).toString("hex");
    const blobByteLength = safeUnsignedInteger(
      bytes.readBigUInt64BE(offset + 32),
      "content_store_pack_blob_size_invalid",
    );
    const blobOffset = offset + CONTENT_PACK_RECORD_HEADER_BYTES;
    const blobEnd = blobOffset + blobByteLength;
    if (!Number.isSafeInteger(blobEnd) || blobEnd > bytes.byteLength - CONTENT_PACK_TRAILER_BYTES) {
      throw new InputError("Content pack blob is truncated", "content_store_pack_blob_truncated");
    }
    if (previousDigest !== undefined && previousDigest >= blobSha256) {
      throw new InputError("Content pack records are not ordered", "content_store_pack_order_invalid");
    }
    const blobBytes = bytes.subarray(blobOffset, blobEnd);
    if (sha256(blobBytes) !== blobSha256) {
      throw new InputError("Content pack blob digest is invalid", "content_store_pack_blob_digest_invalid");
    }
    records.push({ blobByteLength, blobOffset, blobSha256 });
    previousDigest = blobSha256;
    offset = blobEnd;
  }
  if (offset !== bytes.byteLength - CONTENT_PACK_TRAILER_BYTES) {
    throw new InputError("Content pack has trailing record bytes", "content_store_pack_layout_invalid");
  }
  const body = bytes.subarray(0, offset);
  const expectedTrailer = packTrailer(body);
  if (!bytes.subarray(offset).equals(expectedTrailer)) {
    throw new InputError("Content pack trailer is invalid", "content_store_pack_trailer_invalid");
  }
  const packSha256 = sha256(bytes);
  const packIndex = createPackIndex(packSha256, bytes.byteLength, records);
  return createPack(bytes, packIndex, packSha256);
}

export function contentPackIndexBytes(index: ContentPackIndex): Uint8Array {
  const parsed = parseContentPackIndex(index);
  return canonicalDocumentBytes(parsed);
}

export function parseContentPackIndexBytes(bytes: Uint8Array): ContentPackIndex {
  return parseContentPackIndex(parseCanonicalJsonDocument(bytes, "Content pack index"));
}

export function verifyContentPackIndex(pack: ContentPack, candidate: ContentPackIndex): void {
  contentPackBytes(pack);
  const parsed = parseContentPackIndex(candidate);
  if (parsed.indexIdentity !== pack.index.indexIdentity) {
    throw new InputError("Content pack index does not match pack", "content_store_pack_index_mismatch");
  }
}

export function readContentPackBlob(pack: ContentPack, blobSha256: string): Uint8Array {
  assertSha256(blobSha256);
  const bytes = contentPackBytes(pack);
  const record = pack.index.records.find((candidate) => candidate.blobSha256 === blobSha256);
  if (record === undefined) {
    throw new InputError("Content blob is absent from pack", "content_store_blob_missing");
  }
  return bytes.slice(record.blobOffset, record.blobOffset + record.blobByteLength);
}

export function readContentBlobBytes(blob: ContentBlob): Uint8Array {
  return Uint8Array.from(contentBlobBytes(blob));
}

export function readContentPackBytes(pack: ContentPack): Uint8Array {
  return Uint8Array.from(contentPackBytes(pack));
}

function deduplicateBlobs(inputs: readonly ContentBlob[]): ContentBlob[] {
  const byDigest = new Map<string, ContentBlob>();
  for (const input of inputs) {
    assertSha256(input.sha256, "content_store_blob_digest_invalid");
    const bytes = contentBlobBytes(input);
    if (bytes.byteLength !== input.byteLength || sha256(bytes) !== input.sha256) {
      throw new InputError("Content blob digest does not match bytes", "content_store_blob_digest_mismatch");
    }
    const previous = byDigest.get(input.sha256);
    if (previous !== undefined &&
      !Buffer.from(contentBlobBytes(previous)).equals(Buffer.from(bytes))) {
      throw new InputError("Content blob digest collision detected", "content_store_blob_digest_collision");
    }
    byDigest.set(input.sha256, input);
  }
  return [...byDigest.entries()].toSorted(([left], [right]) => left.localeCompare(right))
    .map(([, blob]) => blob);
}

function buildSinglePack(blobs: readonly ContentBlob[], packCeilingBytes: number): ContentPack {
  const byteLength = CONTENT_PACK_HEADER_BYTES + CONTENT_PACK_TRAILER_BYTES + blobs.reduce(
    (total, blob) => total + CONTENT_PACK_RECORD_HEADER_BYTES + blob.byteLength,
    0,
  );
  if (byteLength > packCeilingBytes) {
    throw new InputError("Content pack exceeds ceiling", "content_store_pack_ceiling_exceeded");
  }
  const body = Buffer.alloc(byteLength - CONTENT_PACK_TRAILER_BYTES);
  Buffer.from(CONTENT_PACK_MAGIC, "ascii").copy(body, 0);
  body.writeUInt32BE(CONTENT_PACK_VERSION, 8);
  body.writeBigUInt64BE(BigInt(blobs.length), 12);
  let offset = CONTENT_PACK_HEADER_BYTES;
  const records: ContentPackRecord[] = [];
  for (const blob of blobs) {
    const blobBytes = contentBlobBytes(blob);
    Buffer.from(blob.sha256, "hex").copy(body, offset);
    body.writeBigUInt64BE(BigInt(blob.byteLength), offset + 32);
    const blobOffset = offset + CONTENT_PACK_RECORD_HEADER_BYTES;
    Buffer.from(blobBytes).copy(body, blobOffset);
    records.push({ blobByteLength: blob.byteLength, blobOffset, blobSha256: blob.sha256 });
    offset = blobOffset + blob.byteLength;
  }
  const bytes = Buffer.concat([body, packTrailer(body)]);
  const packSha256 = sha256(bytes);
  const packIndex = createPackIndex(packSha256, bytes.byteLength, records);
  return createPack(bytes, packIndex, packSha256);
}

function createPackIndex(
  packSha256: string,
  packByteLength: number,
  records: readonly ContentPackRecord[],
): ContentPackIndex {
  const payload = {
    schemaVersion: CONTENT_PACK_INDEX_SCHEMA_VERSION,
    packByteLength,
    packSha256,
    records: [...records],
  };
  return parseContentPackIndex({
    ...payload,
    indexIdentity: canonicalDomainHash("content-store.pack-index/v1", payload),
  });
}

function parseContentPackIndex(candidate: unknown): ContentPackIndex {
  const parsed = PACK_INDEX_SCHEMA.parse(candidate);
  const { indexIdentity, ...payload } = parsed;
  if (canonicalDomainHash("content-store.pack-index/v1", payload) !== indexIdentity) {
    throw new InputError("Content pack index identity is invalid", "content_store_pack_index_identity_invalid");
  }
  let previousDigest: string | undefined;
  for (const record of parsed.records) {
    if (previousDigest !== undefined && previousDigest >= record.blobSha256) {
      throw new InputError("Content pack index order is invalid", "content_store_pack_index_order_invalid");
    }
    previousDigest = record.blobSha256;
  }
  return deepFreeze(parsed);
}

function packTrailer(body: Uint8Array): Buffer {
  return Buffer.from(sha256(Buffer.concat([
    Buffer.from(CONTENT_PACK_TRAILER_DOMAIN, "ascii"),
    Buffer.from(body),
  ])), "hex");
}

function safeUnsignedInteger(value: bigint, code: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new InputError("Content pack integer exceeds safe range", code);
  }
  return Number(value);
}

function assertPackCeiling(packCeilingBytes: number): void {
  if (!Number.isSafeInteger(packCeilingBytes) ||
    packCeilingBytes < CONTENT_PACK_HEADER_BYTES + CONTENT_PACK_TRAILER_BYTES) {
    throw new InputError("Content pack ceiling is invalid", "content_store_pack_ceiling_invalid");
  }
}

function contentBlobBytes(blob: ContentBlob): Uint8Array {
  const bytes = BLOB_BYTES.get(blob);
  if (bytes === undefined) {
    throw new InputError("Content blob handle is invalid", "content_store_blob_handle_invalid");
  }
  return bytes;
}

function createPack(bytes: Uint8Array, index: ContentPackIndex, packSha256: string): ContentPack {
  const stored = Uint8Array.from(bytes);
  const pack = Object.freeze({ byteLength: stored.byteLength, index, sha256: packSha256 });
  PACK_BYTES.set(pack, stored);
  return pack;
}

function contentPackBytes(pack: ContentPack): Uint8Array {
  const bytes = PACK_BYTES.get(pack);
  if (bytes === undefined || bytes.byteLength !== pack.byteLength || sha256(bytes) !== pack.sha256) {
    throw new InputError("Content pack handle is invalid", "content_store_pack_handle_invalid");
  }
  return bytes;
}
