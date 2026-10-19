import { createRequire } from "node:module";
import { canonicalJson, sha256 } from "../../../src/kernel/integrity.ts";
import { assertNoDuplicateJsonObjectKeys } from "../../../src/kernel/json-integrity.ts";
import { readQualificationFile } from "../shared/qualification-authority.mjs";
import { buildAuthorReceiptSnapshot } from "./author-receipt.mjs";
import { SECRET_SPAN_PATHS } from "./foundation-paths.mjs";
import { strictUtf8 } from "./span-gateway.mjs";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default;
function read(relativePath) {
  return readQualificationFile(relativePath);
}

export function verifyAuthorReceipt(expectedAuthorReceiptSha256) {
  if (!/^[0-9a-f]{64}$/u.test(expectedAuthorReceiptSha256 ?? "")) {
    throw new Error("author_receipt_external_pin_invalid");
  }
  const receiptBytes = read(SECRET_SPAN_PATHS.authorReceipt);
  const receiptText = strictUtf8(receiptBytes);
  assertNoDuplicateJsonObjectKeys(receiptText, "author receipt duplicate key", "author_receipt_duplicate_key");
  if (receiptText !== canonicalJson(JSON.parse(receiptText)) + "\n") throw new Error("author_receipt_noncanonical");
  if (sha256(receiptBytes) !== expectedAuthorReceiptSha256) {
    throw new Error("author_receipt_external_pin_mismatch");
  }
  const pin = strictUtf8(read(SECRET_SPAN_PATHS.authorPin));
  const expectedPin = expectedAuthorReceiptSha256 + "  " + SECRET_SPAN_PATHS.authorReceipt + "\n";
  if (pin !== expectedPin) throw new Error("author_receipt_pin_invalid");
  const snapshot = buildAuthorReceiptSnapshot();
  const artifactBytes = new Map(snapshot.files.map((entry) => [entry.relativePath, Buffer.from(entry.bytes)]));
  const schemaBytes = artifactBytes.get(SECRET_SPAN_PATHS.authorReceiptSchema);
  if (schemaBytes === undefined) throw new Error("author_receipt_schema_unbound");
  const schemaText = strictUtf8(schemaBytes);
  assertNoDuplicateJsonObjectKeys(schemaText, "author schema duplicate key", "author_schema_duplicate_key");
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(JSON.parse(schemaText));
  const receipt = JSON.parse(receiptText);
  if (!validate(receipt)) throw new Error("author_receipt_schema_invalid");
  if (canonicalJson(receipt) !== canonicalJson(snapshot.receipt)) throw new Error("author_receipt_snapshot_drift");
  return Object.freeze({
    receipt,
    receiptSha256: sha256(receiptBytes),
    externalPinVerified: true,
    pinSha256: sha256(Buffer.from(pin, "utf8")),
    artifactSnapshot: Object.freeze(snapshot.files.map((entry) => Object.freeze({
      relativePath: entry.relativePath,
      bytes: Buffer.from(entry.bytes)
    })))
  });
}
