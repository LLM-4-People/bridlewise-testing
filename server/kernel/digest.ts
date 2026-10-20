/**
 * Content digest — the SINGLE owner of "hash this text the way the harness
 * hashes text" in the server runtime.
 *
 * The same three-call expression (`createHash("sha256").update(content,
 * "utf8").digest("hex")`) was written out in the tool executor, in the editor
 * bridge and in the timeline bridge. Three copies of one decision is three
 * places for the algorithm, the encoding or the output form to drift, and the
 * values are COMPARED across those call sites: the editor tools verify a
 * preimage hash produced by one copy against a file hashed by another, and the
 * ledger stores digests that a reader is entitled to recompute. A copy that
 * quietly used a different encoding would not fail loudly — it would report a
 * preimage mismatch on a file nobody touched.
 *
 * The encoding is part of the contract, not a parameter: `"utf8"` in, hex out,
 * decided here once so a caller cannot forget it. This mirrors
 * `server/file-read.ts`, which owns the read encoding for the same reason.
 */
import { createHash } from "node:crypto";
import { closeSync, constants, openSync, readSync } from "node:fs";

/** Chunk size for {@link sha256OfFile}: bounded memory, one pass. */
const FILE_DIGEST_CHUNK_BYTES = 1 << 20;

/** SHA-256 of `content` read as UTF-8, as a lowercase hex string. */
export function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * SHA-256 of raw BYTES, as a lowercase hex string — the byte-image form of
 * the text contract above. A file read as a Buffer is hashed without a text
 * round-trip (a decode/encode pair would normalize byte sequences a digest
 * must see verbatim), so binary identity — a guardian binary, a blob — is
 * what this owns, beside the text contract the ledger's content digests
 * use. Same owner, same algorithm, both input kinds decided here once.
 */
export function sha256OfBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * SHA-256 of a FILE, read in bounded chunks and never through a final link
 * (`O_NOFOLLOW`): the third input kind this owner hashes. A database backup
 * can be larger than memory, and its digest must not be computed from bytes
 * a stale `readFileSync` copy happened to hold; a link is refused rather than
 * hashed, because the backup/restore contract names regular files.
 */
export function sha256OfFile(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(FILE_DIGEST_CHUNK_BYTES);
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      hash.update(chunk.subarray(0, read));
    }
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}
