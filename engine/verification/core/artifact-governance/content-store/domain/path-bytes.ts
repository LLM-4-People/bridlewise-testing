import { InputError } from "../../../../../src/kernel/errors.ts";

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;

export function encodeBase64urlBytes(bytes: Uint8Array): string {
  if (bytes.byteLength === 0) {
    throw new InputError("Path segment is empty", "content_store_path_segment_empty");
  }
  return Buffer.from(bytes).toString("base64url");
}

export function decodeBase64urlBytes(encoded: string): Uint8Array {
  if (!BASE64URL_PATTERN.test(encoded)) {
    throw new InputError("Base64url path bytes are invalid", "content_store_base64url_invalid");
  }
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.byteLength === 0 || decoded.toString("base64url") !== encoded) {
    throw new InputError(
      "Base64url path bytes are not canonical",
      "content_store_base64url_noncanonical",
    );
  }
  return Uint8Array.from(decoded);
}

export function compareEncodedPaths(left: readonly string[], right: readonly string[]): number {
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const comparison = Buffer.compare(
      Buffer.from(decodeBase64urlBytes(left[index]!)),
      Buffer.from(decodeBase64urlBytes(right[index]!)),
    );
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}
