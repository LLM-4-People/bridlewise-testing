/**
 * A timeline document as the ledger admits it: exact JSON text and the digest
 * OF THAT TEXT — what production computes for every document it records
 * (`engine/src/timeline/effect-documents.ts`). The store refuses a document
 * whose digest is not its text's (`timeline_document_digest_mismatch`), so a
 * fixture never hand-writes a digest: it builds the document here.
 */
import { sha256 } from "../../server/kernel/digest.ts";

export function jsonTimelineDocument(name: string, value: unknown): Readonly<{ name: string; contentJson: string; contentDigest: string }> {
  const contentJson = JSON.stringify(value);
  return { name, contentJson, contentDigest: sha256(contentJson) };
}
