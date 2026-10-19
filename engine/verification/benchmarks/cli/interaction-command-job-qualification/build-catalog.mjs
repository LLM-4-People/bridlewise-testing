#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

class CatalogBuildError extends Error {
  constructor(code) {
    super(code);
    this.name = "CatalogBuildError";
    this.code = code;
  }
}

function reject(code) {
  throw new CatalogBuildError(code);
}

function sha256(bytes) {
  return "sha256:" + crypto.createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  return "{" + Object.keys(value).sort().map((key) =>
    JSON.stringify(key) + ":" + canonicalJson(value[key])
  ).join(",") + "}";
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

function resolveSection(documentBytes, heading) {
  const lines = splitLines(documentBytes);
  const matches = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].text === heading) matches.push(index);
  }
  if (matches.length === 0) reject("section_missing");
  if (matches.length !== 1) reject("section_duplicate");
  const startIndex = matches[0];
  let endIndex = startIndex + 1;
  while (endIndex < lines.length && !/^#{1,3} /.test(lines[endIndex].text)) endIndex += 1;
  const startByte = lines[startIndex].start;
  const endByte = endIndex < lines.length ? lines[endIndex].start : documentBytes.length;
  return {
    bytes: documentBytes.subarray(startByte, endByte),
    resolver: {
      resolverVersion: "markdown-atx-h3-section-bytes/v1",
      heading,
      headingLevel: 3,
      occurrence: 1,
      startByte,
      endByte,
      byteLength: endByte - startByte,
      startLine: startIndex + 1,
      endLine: endIndex,
      lineCount: endIndex - startIndex
    }
  };
}

function parseArguments(argv) {
  const values = new Map();
  let write = false;
  let check = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--write") write = true;
    else if (argument === "--check") check = true;
    else if (["--root", "--schema", "--output"].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) reject("arguments_invalid");
      values.set(argument.slice(2), value);
      index += 1;
    } else reject("arguments_invalid");
  }
  if (write === check || values.size !== 3) reject("arguments_invalid");
  return { root: values.get("root"), schema: values.get("schema"), output: values.get("output"), write, check };
}

function resolveInsideRoot(rootRealpath, relativePath, requireExisting) {
  if (path.isAbsolute(relativePath) || relativePath.split("/").some((part) => !part || part === "." || part === "..")) {
    reject("path_invalid");
  }
  const resolved = path.resolve(rootRealpath, relativePath);
  if (!resolved.startsWith(rootRealpath + path.sep)) reject("path_outside_root");
  if (requireExisting && fs.lstatSync(resolved).isSymbolicLink()) reject("path_symlink");
  return resolved;
}

function build({ root, schema: schemaPath, output: outputPath }) {
  const rootRealpath = fs.realpathSync(root);
  const schemaRealpath = resolveInsideRoot(rootRealpath, schemaPath, true);
  const schemaBytes = fs.readFileSync(schemaRealpath);
  const schema = JSON.parse(schemaBytes.toString("utf8"));
  const documentPath = schema.properties.canonicalHumanSource.const;
  const documentBytes = fs.readFileSync(resolveInsideRoot(rootRealpath, documentPath, true));
  const tuple = schema.properties.artifacts.prefixItems;
  if (!Array.isArray(tuple) || schema.properties.artifacts.items !== false) reject("artifact_tuple_invalid");

  const artifacts = tuple.map((reference) => {
    if (typeof reference?.$ref !== "string" || !reference.$ref.startsWith("#/$defs/")) reject("artifact_reference_invalid");
    const definitionName = reference.$ref.slice("#/$defs/".length);
    const definition = schema.$defs[definitionName];
    const properties = definition?.allOf?.[1]?.properties;
    const sectionTuple = properties?.sections?.prefixItems;
    if (!properties?.id?.const || !properties?.artifactSchemaVersion?.const || !Array.isArray(sectionTuple) || properties.sections.items !== false) {
      reject("artifact_definition_invalid");
    }
    const sections = sectionTuple.map((sectionDefinition) => {
      const heading = sectionDefinition?.allOf?.[1]?.properties?.resolver?.properties?.heading?.const;
      if (typeof heading !== "string") reject("section_definition_invalid");
      const section = resolveSection(documentBytes, heading);
      return { contentIdentity: sha256(section.bytes), resolver: section.resolver };
    });
    return {
      id: properties.id.const,
      artifactSchemaVersion: properties.artifactSchemaVersion.const,
      schemaIdentity: sha256(Buffer.from(canonicalJson(definition), "utf8")),
      documentPath,
      rootIdentity: sha256(Buffer.from(schema.properties.rootBinding.properties.resolverVersion.const + "\0" + rootRealpath, "utf8")),
      sections,
      status: schema.properties.status.const,
      requiredBefore: "candidate-run"
    };
  });

  const catalog = {
    $schema: schema.properties.$schema.const,
    schemaVersion: schema.properties.schemaVersion.const,
    status: schema.properties.status.const,
    observedAt: schema.properties.observedAt.const,
    canonicalHumanSource: documentPath,
    rootBinding: {
      resolverVersion: schema.properties.rootBinding.properties.resolverVersion.const,
      expectedRealpath: rootRealpath,
      identity: sha256(Buffer.from(schema.properties.rootBinding.properties.resolverVersion.const + "\0" + rootRealpath, "utf8"))
    },
    canonicalDocument: {
      identity: sha256(documentBytes),
      bytes: documentBytes.length,
      lines: splitLines(documentBytes).length,
      resolverVersion: schema.properties.canonicalDocument.properties.resolverVersion.const
    },
    catalogSchema: {
      path: schemaPath,
      identity: sha256(schemaBytes),
      subschemaCanonicalization: schema.properties.catalogSchema.properties.subschemaCanonicalization.const
    },
    containsMeasurements: false,
    forbiddenSectionMarkers: schema.properties.forbiddenSectionMarkers.prefixItems.map((item) => item.const),
    artifacts
  };
  return Buffer.from(JSON.stringify(catalog, null, 2) + "\n", "utf8");
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const output = build(options);
  const outputRealpath = resolveInsideRoot(fs.realpathSync(options.root), options.output, options.check);
  if (options.write) fs.writeFileSync(outputRealpath, output, { flag: "wx" });
  else if (!fs.readFileSync(outputRealpath).equals(output)) reject("catalog_drift");
  process.stdout.write(JSON.stringify({ status: options.write ? "written" : "current", bytes: output.length, identity: sha256(output) }) + "\n");
}

try {
  main();
} catch (error) {
  const code = error instanceof CatalogBuildError ? error.code : "catalog_builder_internal_error";
  process.stderr.write(JSON.stringify({ status: "invalid", code }) + "\n");
  process.exitCode = 1;
}
