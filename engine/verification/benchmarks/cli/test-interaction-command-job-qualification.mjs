#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { QUALIFICATION_PATHS } from "./interaction-command-job-qualification-paths.mjs";
import {
  AuthorReceiptError,
  assertAuthorReceiptPin,
  canonicalJson,
  sha256,
  verifyAuthorReceipt
} from "./verify-qualification-author-receipt.mjs";
import {
  ProtocolValidationError,
  validateProtocolFiles,
  validateProtocolStructure
} from "./interaction-command-job-qualification/validate-protocol.mjs";

const rootRealpath = QUALIFICATION_PATHS.rootRealpath;
const read = (relativePath) => fs.readFileSync(path.join(rootRealpath, relativePath));
const catalogBytes = read(QUALIFICATION_PATHS.catalogPath);
const schemaBytes = read(QUALIFICATION_PATHS.schemaPath);
const documentBytes = read(QUALIFICATION_PATHS.documentPath);
const catalog = JSON.parse(catalogBytes);
const schema = JSON.parse(schemaBytes);
let assertions = 0;

function clone(value) {
  return structuredClone(value);
}

function serialize(value) {
  return Buffer.from(JSON.stringify(value, null, 2) + "\n", "utf8");
}

function lineCount(bytes) {
  let count = 0;
  for (const byte of bytes) if (byte === 10) count += 1;
  if (bytes.length > 0 && bytes.at(-1) !== 10) count += 1;
  return count;
}

function bindDocument(candidateCatalog, bytes) {
  candidateCatalog.canonicalDocument.identity = sha256(bytes);
  candidateCatalog.canonicalDocument.bytes = bytes.length;
  candidateCatalog.canonicalDocument.lines = lineCount(bytes);
}

function replaceOnce(bytes, before, after) {
  assert.equal(Buffer.byteLength(before), Buffer.byteLength(after));
  const text = bytes.toString("utf8");
  assert.equal(text.split(before).length, 2, `fixture source must occur once: ${before}`);
  return Buffer.from(text.replace(before, after), "utf8");
}

function expectCode(name, ErrorType, expectedCode, operation) {
  assertions += 1;
  assert.throws(operation, (error) => {
    assert.ok(error instanceof ErrorType, `${name}: wrong error type ${error?.constructor?.name}`);
    assert.equal(error.code, expectedCode, `${name}: wrong rejection`);
    return true;
  });
}

function structural(overrides = {}) {
  return validateProtocolStructure({ rootRealpath, catalogBytes, schemaBytes, documentBytes, ...overrides });
}

const verifiedAuthorReceipt = verifyAuthorReceipt();
assert.equal(verifiedAuthorReceipt.receipt.status, "author-snapshot-unadmitted-external-pin");
const trustedResult = validateProtocolFiles({ verifiedAuthorReceipt });
assert.equal(trustedResult.status, "valid-author-snapshot-unadmitted");
const tupleLength = schema.properties.artifacts.prefixItems.length;
assert.equal(trustedResult.artifacts, tupleLength);
assert.equal(catalog.artifacts.length, tupleLength);
assertions += 4;

const duplicateCatalog = catalogBytes.toString("utf8").replace(
  '  "schemaVersion": "bridlewise-cli-qualification-protocol-artifacts/v3",',
  '  "schemaVersion": "bridlewise-cli-qualification-protocol-artifacts/v3",\n' +
    '  "\\u0073chemaVersion": "bridlewise-cli-qualification-protocol-artifacts/v3",'
);
expectCode("escaped duplicate catalog key", ProtocolValidationError, "json_duplicate_key", () =>
  structural({ catalogBytes: Buffer.from(duplicateCatalog) })
);

const duplicateSchema = schemaBytes.toString("utf8").replace(
  '  "$id": "https://bridlewise.invalid/schemas/qualification-protocol-artifacts/v3",',
  '  "$id": "https://bridlewise.invalid/schemas/qualification-protocol-artifacts/v3",\n' +
    '  "\\u0024id": "https://bridlewise.invalid/schemas/qualification-protocol-artifacts/v3",'
);
expectCode("escaped duplicate schema key", ProtocolValidationError, "json_duplicate_key", () =>
  structural({ schemaBytes: Buffer.from(duplicateSchema) })
);

const missingArtifact = clone(catalog);
missingArtifact.artifacts.pop();
expectCode("derived artifact cardinality", ProtocolValidationError, "artifact_cardinality", () =>
  structural({ catalogBytes: serialize(missingArtifact) })
);

const reorderedArtifacts = clone(catalog);
[reorderedArtifacts.artifacts[0], reorderedArtifacts.artifacts[1]] = [reorderedArtifacts.artifacts[1], reorderedArtifacts.artifacts[0]];
expectCode("schema-owned artifact order", ProtocolValidationError, "catalog_schema_validation", () =>
  structural({ catalogBytes: serialize(reorderedArtifacts) })
);

const missingSection = clone(catalog);
missingSection.artifacts[0].sections.pop();
expectCode("derived artifact section cardinality", ProtocolValidationError, "artifact_section_cardinality", () =>
  structural({ catalogBytes: serialize(missingSection) })
);

const reorderedSections = clone(catalog);
[reorderedSections.artifacts[0].sections[0], reorderedSections.artifacts[0].sections[1]] = [
  reorderedSections.artifacts[0].sections[1],
  reorderedSections.artifacts[0].sections[0]
];
expectCode("schema-owned section order", ProtocolValidationError, "catalog_schema_validation", () =>
  structural({ catalogBytes: serialize(reorderedSections) })
);

const wrongSchemaIdentity = clone(catalog);
wrongSchemaIdentity.artifacts[0].schemaIdentity = "sha256:" + "0".repeat(64);
expectCode("actual artifact subschema identity", ProtocolValidationError, "artifact_schema_identity", () =>
  structural({ catalogBytes: serialize(wrongSchemaIdentity) })
);

const changedDocument = replaceOnce(documentBytes, "Wall-clock timestamps are display data", "Wall-clock timestamps are display date");
const changedCatalog = clone(catalog);
bindDocument(changedCatalog, changedDocument);
expectCode("changed governed section", ProtocolValidationError, "artifact_content_identity", () =>
  structural({ catalogBytes: serialize(changedCatalog), documentBytes: changedDocument })
);

const firstHeading = catalog.artifacts[0].sections[0].resolver.heading;
const missingHeadingDocument = replaceOnce(documentBytes, firstHeading, firstHeading.replace("### ", "##  "));
const missingHeadingCatalog = clone(catalog);
bindDocument(missingHeadingCatalog, missingHeadingDocument);
expectCode("missing exact heading", ProtocolValidationError, "section_missing", () =>
  structural({ catalogBytes: serialize(missingHeadingCatalog), documentBytes: missingHeadingDocument })
);

const duplicateHeadingDocument = Buffer.concat([documentBytes, Buffer.from(firstHeading + "\nDuplicate.\n")]);
const duplicateHeadingCatalog = clone(catalog);
bindDocument(duplicateHeadingCatalog, duplicateHeadingDocument);
expectCode("duplicate exact heading", ProtocolValidationError, "section_duplicate", () =>
  structural({ catalogBytes: serialize(duplicateHeadingCatalog), documentBytes: duplicateHeadingDocument })
);

const unownedDocument = Buffer.concat([documentBytes, Buffer.from("### Synthetic unowned normative section\nMutation.\n")]);
const unownedCatalog = clone(catalog);
bindDocument(unownedCatalog, unownedDocument);
expectCode("unowned normative section", ProtocolValidationError, "normative_section_unowned", () =>
  structural({ catalogBytes: serialize(unownedCatalog), documentBytes: unownedDocument })
);

const coWeakenedSchema = clone(schema);
const removedReference = coWeakenedSchema.properties.artifacts.prefixItems.pop();
delete coWeakenedSchema.$defs[removedReference.$ref.slice("#/$defs/".length)];
const coWeakenedSchemaBytes = serialize(coWeakenedSchema);
const coWeakenedCatalog = clone(catalog);
coWeakenedCatalog.artifacts.pop();
coWeakenedCatalog.catalogSchema.identity = sha256(coWeakenedSchemaBytes);
expectCode("schema and instance co-weakening leaves normative gap", ProtocolValidationError, "normative_section_unowned", () =>
  structural({ schemaBytes: coWeakenedSchemaBytes, catalogBytes: serialize(coWeakenedCatalog) })
);

const authorReceiptBytes = read(QUALIFICATION_PATHS.authorReceiptPath);
const pinText = read(QUALIFICATION_PATHS.authorPinPath).toString("utf8");

function coWeakenedReceipt(seed) {
  const receipt = JSON.parse(authorReceiptBytes);
  for (const file of receipt.governedFiles) {
    file.byteLength += seed;
    file.sha256 = sha256(Buffer.from(`${seed}:${file.relativePath}`));
  }
  for (const dependency of receipt.dependencyTrees) {
    dependency.byteLength += seed;
    dependency.treeIdentity = sha256(Buffer.from(`${seed}:${dependency.packageName}`));
  }
  receipt.runtime.nodeExecutable.sha256 = sha256(Buffer.from(`${seed}:node`));
  for (const name of ["validator", "sharedVerifier", "schema", "catalog", "document"]) {
    receipt.subjectIdentities[name].identity = receipt.governedFiles.find(
      (file) => file.relativePath === receipt.subjectIdentities[name].relativePath
    ).sha256;
  }
  return serialize(receipt);
}

for (const [name, seed] of [
  ["code/schema/catalog full-package co-weakening", 1],
  ["runtime/dependency/package full-package co-weakening", 2],
  ["scope/document/validator full-package co-weakening", 3]
]) {
  expectCode(name, AuthorReceiptError, "author_receipt_pin", () =>
    assertAuthorReceiptPin(coWeakenedReceipt(seed), pinText)
  );
}

const documentText = documentBytes.toString("utf8");
for (const fragment of [
  "proposed/validating/awaiting_authorization/awaiting_approval/awaiting_lease/queued | cancel intent",
  "proposed/validating/awaiting_authorization/awaiting_approval/awaiting_lease/queued | timeout intent",
  "termination request rejected, unavailable or authority lost",
  "The exact race precedence is:",
  "Every attempt has a versioned ObservedEffectReceipt with the closed disposition:",
  "A governed SurfaceUniverse compiler consumes",
  "the validator and tests derive its length and expected order, and prose never restates a count"
]) {
  assert.ok(documentText.includes(fragment), `missing v3 protocol claim: ${fragment}`);
  assertions += 1;
}

assert.equal(schema.properties.artifacts.minItems, undefined);
assert.equal(schema.properties.artifacts.maxItems, undefined);
assert.equal(schema.properties.artifacts.items, false);
assert.equal(documentText.includes(`all ${tupleLength} section 10.4 protocol requirements`), false);
assertions += 4;

const expectedScopes = new Map(catalog.artifacts.map((artifact) => [artifact.id, artifact.sections.map((section) => section.resolver.heading)]));
assert.ok(expectedScopes.get("job-transition-table").includes("### 6.2 Observed-effect disposition and receipt"));
assert.deepEqual(expectedScopes.get("egress-surface-coverage-protocol"), ["### 5.11 Raw ingress, diagnostics and egress control"]);
assert.deepEqual(expectedScopes.get("sanitization-session-protocol"), [
  "### 5.6 Detector/redactor compositions",
  "### 5.7 Sanitization session and emission barrier",
  "### 5.8 Safe mapping, paging and confidential query protocol",
  "### 8.6 Detector-composition suite: every DET-A through DET-H"
]);
assert.deepEqual(expectedScopes.get("detector-candidate-manifest"), [
  "### 3.1 Source policy",
  "### 3.2 Current discovery facts, not recommendations",
  "### 3.3 Detector and grammar discovery catalog",
  "### 5.6 Detector/redactor compositions",
  "### 7.7 Detector and regex profiles",
  "### 8.6 Detector-composition suite: every DET-A through DET-H"
]);
assert.deepEqual(expectedScopes.get("regex-profile"), [
  "### 3.3 Detector and grammar discovery catalog",
  "### 7.7 Detector and regex profiles",
  "### 8.7 Regex-engine suite: every REGEX-A through REGEX-D"
]);
assert.deepEqual(expectedScopes.get("safe-view-reconstruction-protocol"), [
  "### 5.5 Safe file-view access modes",
  "### 5.8 Safe mapping, paging and confidential query protocol",
  "### 7.5 File-view candidates",
  "### 7.6 Snapshot-acquisition candidates",
  "### 7.9 Nested semantic file-discovery qualification",
  "### 8.5 Safe file-view suite: every VIEW-A through VIEW-D",
  "### 8.8 Snapshot, containment and queue suite",
  "### 9.5 Safe file-view measures"
]);
assert.deepEqual(expectedScopes.get("metric-plan").slice(0, 6), [
  "### 9.1 Universal hard floors",
  "### 9.2 Discovery measures",
  "### 9.3 Execution and job measures",
  "### 9.4 CLI and web-parity measures",
  "### 9.5 Safe file-view measures",
  "### 9.6 Metric-plan and statistical floors"
]);
assertions += 7;

assert.notEqual(canonicalJson(schema.$defs.interactionTransport), canonicalJson(schema.$defs.capabilityProposal));
for (let index = 0; index < schema.properties.artifacts.prefixItems.length; index += 1) {
  const definitionName = schema.properties.artifacts.prefixItems[index].$ref.slice("#/$defs/".length);
  assert.equal(catalog.artifacts[index].schemaIdentity, sha256(Buffer.from(canonicalJson(schema.$defs[definitionName]))));
  assertions += 1;
}
for (const oldPath of [
  "docs/research/cli/verification/validate-qualification-protocol.mjs",
  "docs/research/cli/verification/validate-qualification-protocol.test.mjs"
]) {
  assert.equal(fs.existsSync(path.join(rootRealpath, oldPath)), false, `executable validation remains under docs: ${oldPath}`);
  assertions += 1;
}
assertions += 1;

process.stdout.write(JSON.stringify({ status: "passed", assertions, derivedArtifacts: tupleLength }) + "\n");
