import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import {
  assertNoDuplicateJsonKeys,
  canonicalJson,
  sha256,
  verifyAuthorReceipt
} from "../verify-qualification-author-receipt.mjs";
import { QUALIFICATION_PATHS } from "../interaction-command-job-qualification-paths.mjs";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default;

export class ProtocolValidationError extends Error {
  constructor(code) {
    super(code);
    this.name = "ProtocolValidationError";
    this.code = code;
  }
}

function reject(code) {
  throw new ProtocolValidationError(code);
}

function parseJson(bytes) {
  try {
    assertNoDuplicateJsonKeys(bytes);
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    if (error?.code) reject(error.code);
    reject("json_parse_invalid");
  }
}

function splitLines(bytes) {
  const lines = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 10) continue;
    let text = bytes.subarray(start, index).toString("utf8");
    if (text.endsWith("\r")) text = text.slice(0, -1);
    lines.push({ start, text });
    start = index + 1;
  }
  if (start < bytes.length) lines.push({ start, text: bytes.subarray(start).toString("utf8") });
  return lines;
}

function resolveSection(documentBytes, resolver) {
  if (resolver.resolverVersion !== QUALIFICATION_PATHS.sectionResolverVersion) reject("section_resolver_version");
  const lines = splitLines(documentBytes);
  const matches = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].text === resolver.heading) matches.push(index);
  }
  if (matches.length === 0) reject("section_missing");
  if (matches.length !== 1 || resolver.occurrence !== 1) reject("section_duplicate");
  const startIndex = matches[0];
  if (!lines[startIndex].text.startsWith("### ") || resolver.headingLevel !== 3) reject("section_heading_level");
  let endIndex = startIndex + 1;
  while (endIndex < lines.length && !/^#{1,3} /.test(lines[endIndex].text)) endIndex += 1;
  const startByte = lines[startIndex].start;
  const endByte = endIndex < lines.length ? lines[endIndex].start : documentBytes.length;
  return {
    bytes: documentBytes.subarray(startByte, endByte),
    startByte,
    endByte,
    byteLength: endByte - startByte,
    startLine: startIndex + 1,
    endLine: endIndex,
    lineCount: endIndex - startIndex
  };
}

function allH3Headings(documentBytes) {
  return splitLines(documentBytes).map((line) => line.text).filter((line) => line.startsWith("### "));
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsForbiddenMarker(sectionText, marker) {
  const escaped = escapeRegularExpression(marker);
  return new RegExp(`(^|[^A-Z0-9_])${escaped}([^A-Z0-9_]|$)`, "u").test(sectionText);
}

function assertEquals(actual, expected, code) {
  if (actual !== expected) reject(code);
}

function definitionFromReference(schema, reference) {
  if (typeof reference?.$ref !== "string" || !reference.$ref.startsWith("#/$defs/")) reject("artifact_schema_reference");
  const definition = schema.$defs?.[reference.$ref.slice("#/$defs/".length)];
  if (!definition) reject("artifact_schema_missing");
  return definition;
}

function definitionContract(definition) {
  const properties = definition?.allOf?.[1]?.properties;
  const sections = properties?.sections;
  if (typeof properties?.id?.const !== "string" || typeof properties?.artifactSchemaVersion?.const !== "string" || !Array.isArray(sections?.prefixItems) || sections.items !== false) {
    reject("artifact_schema_shape");
  }
  return { id: properties.id.const, version: properties.artifactSchemaVersion.const, sectionTuple: sections.prefixItems };
}

function headingFromSectionDefinition(definition) {
  const heading = definition?.allOf?.[1]?.properties?.resolver?.properties?.heading?.const;
  if (typeof heading !== "string") reject("artifact_section_schema_shape");
  return heading;
}

export function validateProtocolStructure({ rootRealpath, catalogBytes, schemaBytes, documentBytes }) {
  const catalog = parseJson(catalogBytes);
  const schema = parseJson(schemaBytes);
  const schemaIdentity = sha256(schemaBytes);
  const documentIdentity = sha256(documentBytes);
  const catalogIdentity = sha256(catalogBytes);
  const rootIdentity = sha256(Buffer.from(QUALIFICATION_PATHS.rootResolverVersion + "\0" + rootRealpath, "utf8"));

  const ajv = new Ajv2020({ allErrors: true, strict: true, strictTuples: false });
  const validate = ajv.compile(schema);
  if (!validate(catalog)) reject("catalog_schema_validation");

  assertEquals(catalog.rootBinding.expectedRealpath, rootRealpath, "root_catalog_realpath");
  assertEquals(catalog.rootBinding.identity, rootIdentity, "root_catalog_identity");
  assertEquals(catalog.catalogSchema.identity, schemaIdentity, "schema_catalog_identity");
  assertEquals(catalog.canonicalDocument.identity, documentIdentity, "document_catalog_identity");
  assertEquals(catalog.canonicalDocument.bytes, documentBytes.length, "document_byte_length");
  assertEquals(catalog.canonicalDocument.lines, splitLines(documentBytes).length, "document_line_count");
  assertEquals(catalog.canonicalDocument.resolverVersion, QUALIFICATION_PATHS.sectionResolverVersion, "document_resolver_version");

  const markerTuple = schema.properties?.forbiddenSectionMarkers?.prefixItems;
  if (!Array.isArray(markerTuple) || schema.properties.forbiddenSectionMarkers.items !== false) reject("marker_schema_tuple");
  assertEquals(catalog.forbiddenSectionMarkers.length, markerTuple.length, "marker_cardinality");
  for (let index = 0; index < markerTuple.length; index += 1) assertEquals(catalog.forbiddenSectionMarkers[index], markerTuple[index].const, "marker_order");

  const artifactTuple = schema.properties?.artifacts?.prefixItems;
  if (!Array.isArray(artifactTuple) || schema.properties.artifacts.items !== false) reject("artifact_schema_tuple");
  assertEquals(catalog.artifacts.length, artifactTuple.length, "artifact_cardinality");
  const ids = new Set();
  const ownedHeadings = new Set();
  for (let index = 0; index < artifactTuple.length; index += 1) {
    const definition = definitionFromReference(schema, artifactTuple[index]);
    const contract = definitionContract(definition);
    const artifact = catalog.artifacts[index];
    assertEquals(artifact.id, contract.id, "artifact_order");
    assertEquals(artifact.artifactSchemaVersion, contract.version, "artifact_schema_version");
    if (ids.has(artifact.id)) reject("artifact_duplicate_id");
    ids.add(artifact.id);
    assertEquals(artifact.schemaIdentity, sha256(Buffer.from(canonicalJson(definition), "utf8")), "artifact_schema_identity");
    assertEquals(artifact.rootIdentity, rootIdentity, "artifact_root_identity");
    assertEquals(artifact.documentPath, catalog.canonicalHumanSource, "artifact_document_path");
    assertEquals(artifact.sections.length, contract.sectionTuple.length, "artifact_section_cardinality");

    const artifactHeadings = new Set();
    for (let sectionIndex = 0; sectionIndex < contract.sectionTuple.length; sectionIndex += 1) {
      const expectedHeading = headingFromSectionDefinition(contract.sectionTuple[sectionIndex]);
      const sectionReceipt = artifact.sections[sectionIndex];
      assertEquals(sectionReceipt.resolver.heading, expectedHeading, "artifact_section_order");
      if (artifactHeadings.has(expectedHeading)) reject("artifact_section_duplicate");
      artifactHeadings.add(expectedHeading);
      ownedHeadings.add(expectedHeading);
      const section = resolveSection(documentBytes, sectionReceipt.resolver);
      for (const field of ["startByte", "endByte", "byteLength", "startLine", "endLine", "lineCount"]) {
        assertEquals(sectionReceipt.resolver[field], section[field], "artifact_resolver_" + field);
      }
      assertEquals(sectionReceipt.contentIdentity, sha256(section.bytes), "artifact_content_identity");
      const upper = section.bytes.toString("utf8").toUpperCase();
      for (const marker of catalog.forbiddenSectionMarkers) {
        if (containsForbiddenMarker(upper, marker)) reject("artifact_unfinished_marker");
      }
    }
  }

  for (const heading of allH3Headings(documentBytes)) {
    if (!ownedHeadings.has(heading)) reject("normative_section_unowned");
  }
  return Object.freeze({
    status: "structurally-valid-untrusted",
    artifacts: artifactTuple.length,
    sections: [...ownedHeadings].length,
    rootIdentity,
    schemaIdentity,
    documentIdentity,
    catalogIdentity
  });
}

function resolveInput(rootRealpath, relativePath) {
  if (path.isAbsolute(relativePath) || relativePath.split("/").some((part) => !part || part === "." || part === "..")) reject("path_identity");
  let current = rootRealpath;
  for (const part of relativePath.split("/")) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) reject("path_symlink");
  }
  const realpath = fs.realpathSync(current);
  if (!realpath.startsWith(rootRealpath + path.sep)) reject("path_outside_root");
  return realpath;
}

export function validateProtocolFiles({ root = QUALIFICATION_PATHS.rootRealpath, verifiedAuthorReceipt } = {}) {
  const author = verifiedAuthorReceipt ?? verifyAuthorReceipt({ root });
  const rootRealpath = author.rootRealpath;
  const result = validateProtocolStructure({
    rootRealpath,
    catalogBytes: fs.readFileSync(resolveInput(rootRealpath, QUALIFICATION_PATHS.catalogPath)),
    schemaBytes: fs.readFileSync(resolveInput(rootRealpath, QUALIFICATION_PATHS.schemaPath)),
    documentBytes: fs.readFileSync(resolveInput(rootRealpath, QUALIFICATION_PATHS.documentPath))
  });
  return Object.freeze({ ...result, status: "valid-author-snapshot-unadmitted", authorReceiptIdentity: author.receiptIdentity });
}
