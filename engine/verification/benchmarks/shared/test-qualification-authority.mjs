#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "../../../src/kernel/integrity.ts";
import { MIGRATION_WRITE_AUTHORITY_TRUST_BASE_LEASE } from
  "../coordination/migration-write-authority/author-trust-base.mjs";
import {
  auditQualificationPortableDisclosure,
  createQualificationAuthority
} from "./qualification-authority.mjs";
import { auditQualificationAuthorityDocumentation, auditQualificationAuthorityProjection } from "./qualification-authority-audit.mjs";
import {
  buildScopeAnalysis,
  compileQualificationAuthorityInventory,
  lookupScopeBinding,
  resolveQualificationPortableDynamicPattern,
  resolveScopedImportedBinding,
  resolvesToProcessEnv,
  validateQualificationAuthorityInventorySchema,
  verifyQualificationAuthorityInventory
} from "./qualification-authority-inventory.mjs";
import {
  astChildren,
  astNode,
  astNodeArray,
  createQualificationParserBoundary
} from "./qualification-parser.mjs";
import Ajv2020 from "ajv/dist/2020.js";
import {
  createUtf8OffsetMap,
  utf8ByteOffset,
  utf8ByteOffsetFromMap,
  utf8ByteSpan,
  utf8ByteSpanFromMap,
  utf8ByteLengthFromMap
} from "../../../src/text/utf8-offsets.ts";

const ROOT = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const GENERATED_INVENTORY_PATH =
  "verification/benchmarks/shared/qualification-authority-inventory.v5.json";
const TEST_PARENT = join(ROOT, ".bridlewise", "qualification-authority-v5-tests");
const MWA_PACKAGE_CLOSURE = Object.freeze([
  "ajv",
  "fast-deep-equal",
  "fast-uri",
  "json-schema-traverse",
  "require-from-string",
  "zod"
]);
let projectedInventory;

function copyIntoRoot(root, relativePath) {
  const destination = join(root, relativePath);
  mkdirSync(dirname(destination), { mode: 0o700, recursive: true });
  cpSync(join(ROOT, relativePath), destination, { recursive: true });
}

function prepareRepositoryRoot(name, packageNames = ["@babel/parser"]) {
  const root = join(TEST_PARENT, name);
  rmSync(root, { force: true, recursive: true });
  mkdirSync(join(root, "node_modules"), { mode: 0o700, recursive: true });
  for (const relativePath of ["package.json", "package-lock.json", "node_modules/.package-lock.json"]) {
    copyIntoRoot(root, relativePath);
  }
  for (const packageName of packageNames) copyIntoRoot(root, `node_modules/${packageName}`);
  return root;
}

function writeFixture(root, relativePath, source) {
  const destination = join(root, relativePath);
  mkdirSync(dirname(destination), { mode: 0o700, recursive: true });
  writeFileSync(destination, source, { encoding: "utf8", mode: 0o600 });
}

function fixtureRepository(name) {
  const root = prepareRepositoryRoot(name);
  const files = Object.freeze({
    "src/base.ts": [
      "export const value = 7;",
      "export default function base() { return value; }",
      "export const unicode_é = /é+/u;",
      "export const quotient = 8 / 2;",
      "export const template = `value:${value}`;"
    ].join("\n"),
    "src/side.ts": "globalThis.__qualificationSideEffect = true;\n",
    "src/barrel.ts": [
      "export * from './base.ts';",
      "export { default as baseDefault } from './base.ts';"
    ].join("\n"),
    "src/component.tsx": "export const Component = () => <main data-kind='fixture'>ok</main>;\n",
    "src/javascript.jsx": "export const element = <span>fixture</span>;\n",
    "src/module.mts": "export type Qualified = { readonly ok: true };\n",
    "src/declaration.d.mts": "export declare const declarationOnly: unique symbol;\n",
    "src/common.cts": [
      "const request = './base.ts', loader = require, unrelated = 1;",
      "loader(request);",
      "export {};"
    ].join("\n"),
    "test/consumer.ts": [
      "import base, { value as renamed } from '../src/base.ts' with { type: 'javascript' };",
      "import * as barrel from '../src/barrel.ts';",
      "import '../src/side.ts';",
      "import moduleApi, { createRequire as makeRequire } from 'node:module';",
      "const loader = makeRequire(import.meta.url), loaderAlias = loader, request = '../src/base.ts';",
      "loaderAlias(request);",
      "const dynamicTarget = '../src/' + 'base.ts';",
      "await import(dynamicTarget);",
      "const ordinary = { resolve(input: string) { return input; } };",
      "ordinary.resolve(request);",
      "const Ω = /(?:a|b)+/u, divided = 12 / 3, rendered = `${renamed}:${divided}`;",
      "void [base, barrel, moduleApi, Ω, rendered];"
    ].join("\n"),
    "traceability/sources/s2/non-module-fragment.ts": "type DeliberatelyVendoredFragment =\n",
    "vitest.config.ts": "export default { test: { passWithNoTests: true } };\n"
  });
  for (const [relativePath, source] of Object.entries(files)) writeFixture(root, relativePath, source);
  return root;
}

function expectProjectionDrift(mutator) {
  const mutation = structuredClone(projectedInventory);
  mutator(mutation);
  assert.throws(
    () => verifyQualificationAuthorityInventory(mutation, ROOT),
    (error) => error?.code === "qualification_inventory_projection_drift"
  );
}

function mutateJson(root, relativePath, mutator) {
  const path = join(root, relativePath);
  const value = JSON.parse(readFileSync(path, "utf8"));
  mutator(value);
  writeFileSync(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
}

rmSync(TEST_PARENT, { force: true, recursive: true });
mkdirSync(TEST_PARENT, { mode: 0o700, recursive: true });

try {
  projectedInventory = JSON.parse(readFileSync(join(ROOT, GENERATED_INVENTORY_PATH), "utf8"));
  const currentInventory = verifyQualificationAuthorityInventory(projectedInventory, ROOT);
  const audit = auditQualificationAuthorityProjection(projectedInventory, ROOT);
  assert.equal(currentInventory.status, "compiled-current");
  assert.equal(audit.status, "complete-current");
  assert.equal(audit.inventoryIdentity, currentInventory.inventoryIdentity);
  assert.equal(currentInventory.sourceSurface.sourceCount,
    currentInventory.sourceSurface.executableSourceCount +
      currentInventory.sourceSurface.nonExecutableCarrierCount);

  const carrierClasses = new Map();
  for (const source of currentInventory.sourceSurface.sources) {
    carrierClasses.set(`${source.originClass}\0${source.moduleDisposition}`, source);
  }
  assert.ok(carrierClasses.size >= 4);
  for (const source of carrierClasses.values()) {
    expectProjectionDrift((value) => {
      value.sourceSurface.sources = value.sourceSurface.sources.filter((entry) => entry.path !== source.path);
    });
    expectProjectionDrift((value) => {
      const carrier = value.sourceSurface.sources.find((entry) => entry.path === source.path);
      carrier.originClass = carrier.originClass === "vendored-source" ?
        "first-party-production" : "vendored-source";
      carrier.moduleDisposition = carrier.moduleDisposition === "non-executable-carrier" ?
        "executable-first-party-module" : "non-executable-carrier";
      carrier.dispositionReason = "mutation-must-not-be-admitted";
    });
  }

  expectProjectionDrift((value) => { value.moduleGraph.edges.pop(); });
  expectProjectionDrift((value) => { value.consumerInventory.modules.pop(); });
  expectProjectionDrift((value) => { value.leaseInventory[0].protocolCohorts.pop(); });
  expectProjectionDrift((value) => {
    const category = Object.keys(value.leaseInventory[0].fieldInfluence)[0];
    value.leaseInventory[0].fieldInfluence[category].pop();
  });

  const dynamicEdges = currentInventory.moduleGraph.edges.filter((edge) =>
    edge.resolution === "internal-pattern"
  );
  assert.ok(dynamicEdges.length >= 2);
  assert.equal(dynamicEdges.every((edge) =>
    edge.resolutionEvidence.method === "unique-portable-suffix-over-complete-module-domain" &&
    edge.resolutionEvidence.matchCount === 1 && edge.resolutionEvidence.candidateDomainCount ===
      currentInventory.moduleGraph.moduleCount
  ), true);
  const ambiguous = resolveQualificationPortableDynamicPattern(
    "*entry.mjs",
    ["src/alpha/entry.mjs", "test/beta/entry.mjs"]
  );
  assert.equal(ambiguous.resolution, "ambiguous");
  assert.equal(ambiguous.target, null);
  assert.equal(ambiguous.evidence.matchCount, 2);

  const syntaxRoot = fixtureRepository("syntax-graph-root");
  const syntaxInventory = compileQualificationAuthorityInventory(syntaxRoot);
  assert.equal(syntaxInventory.status, "compiled-current");
  assert.deepEqual(syntaxInventory.violations, []);
  assert.equal(syntaxInventory.sourceSurface.sources.find((source) =>
    source.path === "traceability/sources/s2/non-module-fragment.ts"
  ).moduleDisposition, "non-executable-carrier");
  for (const kind of [
    "static-import",
    "side-effect-import",
    "named-reexport",
    "barrel-export-all",
    "dynamic-import",
    "require"
  ]) assert.ok(syntaxInventory.moduleGraph.edges.some((edge) => edge.kind === kind), kind);
  assert.ok(syntaxInventory.moduleGraph.edges.some((edge) =>
    edge.kind === "require" && edge.from === "src/common.cts" && edge.target === "src/base.ts"
  ));
  assert.ok(syntaxInventory.moduleGraph.edges.some((edge) =>
    edge.attributes.some((attribute) => attribute.key === "type" && attribute.value === "javascript")
  ));
  assert.equal(syntaxInventory.moduleGraph.edges.some((edge) =>
    edge.kind === "require-resolve" && edge.from === "test/consumer.ts"
  ), false);

  const vendoredBytes = readFileSync(join(
    syntaxRoot,
    "traceability/sources/s2/non-module-fragment.ts"
  ));
  writeFixture(syntaxRoot, "src/relabelled-vendored-fragment.ts", vendoredBytes);
  assert.throws(
    () => compileQualificationAuthorityInventory(syntaxRoot),
    (error) => error?.code === "qualification_parser_source_parse_failed"
  );
  rmSync(join(syntaxRoot, "src/relabelled-vendored-fragment.ts"));
  writeFixture(syntaxRoot, "src/unsupported-syntax.ts", "const unsupported = ;\n");
  assert.throws(
    () => compileQualificationAuthorityInventory(syntaxRoot),
    (error) => error?.code === "qualification_parser_source_parse_failed"
  );
  rmSync(join(syntaxRoot, "src/unsupported-syntax.ts"));

  const portableRoots = ["alpha-root", "root with spaces", "Ω-unicode-root"].map((name) =>
    prepareRepositoryRoot(name, ["@babel/parser", ...MWA_PACKAGE_CLOSURE])
  );
  const portableTrustBases = portableRoots.map((root) =>
    createQualificationAuthority(root).deriveQualificationTrustBase(
      MIGRATION_WRITE_AUTHORITY_TRUST_BASE_LEASE
    )
  );
  assert.equal(new Set(portableTrustBases.map(canonicalJson)).size, 1);
  assert.equal(portableTrustBases.every((trustBase) =>
    trustBase.portability.findingCount === 0 && !canonicalJson(trustBase).includes("/home/")
  ), true);
  const parserBindings = portableRoots.map((root) =>
    createQualificationParserBoundary(root).binding
  );
  assert.equal(new Set(parserBindings.map(canonicalJson)).size, 1);

  const disclosureRoot = portableRoots[0];
  const rawDisclosure = `${disclosureRoot}/src/private.ts`;
  const disclosure = auditQualificationPortableDisclosure({ rawDisclosure }, disclosureRoot);
  assert.equal(disclosure.findingCount, 1);
  assert.equal(disclosure.findings[0].jsonPointer, "/rawDisclosure");
  assert.equal(disclosure.findings[0].kind, "repository-root-absolute-path");
  assert.equal(Object.hasOwn(disclosure.findings[0], "rawValue"), false);
  const serializedDisclosureInput = Buffer.from(canonicalJson({ rawDisclosure }), "utf8");
  const span = disclosure.findings[0].span;
  assert.equal(JSON.parse(serializedDisclosureInput.subarray(span.startByte, span.endByte).toString("utf8")),
    rawDisclosure);

  const parserBaselineRoot = prepareRepositoryRoot("parser-baseline-root");
  const parserBaseline = createQualificationParserBoundary(parserBaselineRoot).binding;
  const byteMutationCases = [
    ["parser-package-json-bytes", "node_modules/@babel/parser/package.json", "\n"],
    ["parser-entry-bytes", "node_modules/@babel/parser/lib/index.js", "\n// bound mutation\n"],
    ["parser-license-bytes", "node_modules/@babel/parser/LICENSE", "\n"],
    ["parser-installed-tree-bytes", "node_modules/@babel/parser/README.md", "\n"]
  ];
  for (const [name, relativePath, suffix] of byteMutationCases) {
    const root = prepareRepositoryRoot(name);
    appendFileSync(join(root, relativePath), suffix);
    const mutated = createQualificationParserBoundary(root).binding;
    assert.notEqual(mutated.parserBoundaryIdentity, parserBaseline.parserBoundaryIdentity, name);
  }

  const rootLockMutant = prepareRepositoryRoot("parser-root-lock-mutant");
  mutateJson(rootLockMutant, "package-lock.json", (value) => {
    value.packages["node_modules/@babel/parser"].integrity = "sha512-root-lock-mutant";
  });
  assert.throws(
    () => createQualificationParserBoundary(rootLockMutant),
    (error) => error?.code === "qualification_parser_lock_binding_invalid"
  );
  const installedLockMutant = prepareRepositoryRoot("parser-installed-lock-mutant");
  mutateJson(installedLockMutant, "node_modules/.package-lock.json", (value) => {
    value.packages["node_modules/@babel/parser"].integrity = "sha512-installed-lock-mutant";
  });
  assert.throws(
    () => createQualificationParserBoundary(installedLockMutant),
    (error) => error?.code === "qualification_parser_lock_binding_invalid"
  );
  const bothLocksMutant = prepareRepositoryRoot("parser-both-locks-mutant");
  for (const relativePath of ["package-lock.json", "node_modules/.package-lock.json"]) {
    mutateJson(bothLocksMutant, relativePath, (value) => {
      value.packages["node_modules/@babel/parser"].integrity = "sha512-both-locks-mutant";
    });
  }
  assert.notEqual(
    createQualificationParserBoundary(bothLocksMutant).binding.parserBoundaryIdentity,
    parserBaseline.parserBoundaryIdentity
  );

  const packageVersionMutant = prepareRepositoryRoot("parser-package-version-mutant");
  mutateJson(packageVersionMutant, "node_modules/@babel/parser/package.json", (value) => {
    value.version = "0.0.0-mutant";
  });
  assert.throws(
    () => createQualificationParserBoundary(packageVersionMutant),
    (error) => error?.code === "qualification_parser_lock_binding_invalid"
  );

  // === Shared UTF-16 -> UTF-8 offset authority hostile tests ===
  {
    let offPass = 0;
    const offCases = [
      ["", 0, 0], ["abc", 0, 0], ["abc", 3, 3],
      ["é", 1, 2], ["Ω", 1, 2], ["façade", 6, 7],
      ["𝕏", 2, 4], ["aéΩ𝕏b", 1, 1], ["aéΩ𝕏b", 2, 3], ["aéΩ𝕏b", 3, 5],
      ["aéΩ𝕏b", 5, 9], ["aéΩ𝕏b", 6, 10], ["\r\n", 2, 2],
      ["aéb", 1, 1], ["aéb", 2, 3], ["aéb", 3, 4],
      ["café", 4, 5], ["naïve", 5, 6], ["✓", 1, 3],
      ["\u0301", 1, 2], ["a\u0301b", 1, 1], ["a\u0301b", 2, 3], ["a\u0301b", 3, 4],
    ];
    for (const [s, off, exp] of offCases) {
      assert.equal(utf8ByteOffset(s, off), exp, `utf8ByteOffset ${JSON.stringify(s)} ${off}`);
      const map = createUtf8OffsetMap(s);
      assert.equal(utf8ByteOffsetFromMap(map, off), exp, `map ${JSON.stringify(s)} ${off}`);
      assert.equal(utf8ByteLengthFromMap(map), Buffer.byteLength(s, "utf8"), `len ${JSON.stringify(s)}`);
      offPass += 1;
    }
    assert.deepEqual(utf8ByteSpan("aéΩ𝕏b", 1, 5), { startByte: 1, endByte: 9 });
    assert.deepEqual(utf8ByteSpanFromMap(createUtf8OffsetMap("aéΩ𝕏b"), 1, 5), { startByte: 1, endByte: 9 });
    assert.deepEqual(utf8ByteSpanFromMap(createUtf8OffsetMap("café"), 0, 4), { startByte: 0, endByte: 5 });
    const astral = "x𝕏y";
    for (const fn of [
      () => utf8ByteOffset(astral, 2),
      () => utf8ByteSpan(astral, 1, 2),
      () => utf8ByteOffsetFromMap(createUtf8OffsetMap(astral), 2),
      () => utf8ByteSpanFromMap(createUtf8OffsetMap(astral), 0, 2),
    ]) assert.throws(fn, /surrogate_pair|invalid_boundary/);
    assert.equal(utf8ByteOffset("abc", -1), -1, "negative sentinel returns -1");
    assert.equal(utf8ByteOffset("abc", Number(null ?? -1)), -1, "null-start sentinel returns -1");
    for (const fn of [
      () => utf8ByteOffset("abc", 4),
      () => utf8ByteOffsetFromMap(createUtf8OffsetMap("abc"), 4),
      () => utf8ByteSpan("abc", 2, 1),
      () => utf8ByteSpanFromMap(createUtf8OffsetMap("abc"), 2, 1),
      () => utf8ByteOffset("abc", 1.5),
      () => utf8ByteOffset(123, 0),
    ]) assert.throws(fn, /(out_of_range|inverted|not_string|not_integer)/);
    // map vs Buffer.byteLength consistency for a large hostile string
    const hostile = "çafé_𝕏_Ω_" + "x".repeat(1000) + "_ééé_𝕏𝕏";
    const hmap = createUtf8OffsetMap(hostile);
    for (let i = 0; i <= hostile.length; i += 1) {
      if (hmap[i] === 0xffffffff) continue;
      assert.equal(hmap[i], Buffer.byteLength(hostile.slice(0, i), "utf8"), `map@${i}`);
    }
    offPass += 8;
    console.log(`  offset hostile checks: ${offPass}`);
  }

  // === Recursively closed inventory schema hostile tests ===
  {
    let schPass = 0;
    const schema = JSON.parse(readFileSync(join(ROOT,
      "verification/benchmarks/shared/qualification-authority-inventory.schema.json"), "utf8"));
    const ajv = new Ajv2020({ allErrors: true, strict: true, $data: true });
    const validate = ajv.compile(schema);
    const base = JSON.parse(readFileSync(join(ROOT, GENERATED_INVENTORY_PATH), "utf8"));
    assert.equal(validate(base), true, "checked-in inventory must satisfy closed schema");
    assert.equal(validateQualificationAuthorityInventorySchema(base).length, 0);
    schPass += 2;
    const mut = (name, fn) => {
      const c = structuredClone(base); fn(c);
      assert.equal(validate(c), false, `schema must reject: ${name}`);
      assert.ok(validateQualificationAuthorityInventorySchema(c).length > 0, `compiler schema gate must reject: ${name}`);
      schPass += 2;
    };
    mut("top-extra", (c) => { c.extra = 1; });
    mut("top-missing", (c) => { delete c.inventoryIdentity; });
    mut("status-reclassify", (c) => { c.status = "weird"; });
    mut("authorityOwner-reclassify", (c) => { c.authorityOwner = "x"; });
    mut("parserBoundary-extra", (c) => { c.parserBoundary.extra = 1; });
    mut("parserBoundary-missing", (c) => { delete c.parserBoundary.packagePath; });
    mut("parserBoundary-originClass", (c) => { c.parserBoundary.originClass = "x"; });
    mut("parserOptions-ranges", (c) => { c.parserBoundary.parserOptions.ranges = "yes"; });
    mut("parserOptions-sourceType", (c) => { c.parserBoundary.parserOptions.sourceType = "module"; });
    mut("fileRecord-missing", (c) => { delete c.parserBoundary.packageJson.sha256; });
    mut("fileRecord-byteLength", (c) => { c.parserBoundary.packageJson.byteLength = -1; });
    mut("installedPackage-missing", (c) => { delete c.parserBoundary.installedPackage.fileCount; });
    mut("sourceSurface-sourceCount", (c) => { c.sourceSurface.sourceCount = 999; });
    mut("sourceSurface-sources-extra", (c) => { c.sourceSurface.sources[0].extra = 1; });
    mut("sourceRecord-originClass", (c) => { c.sourceSurface.sources[0].originClass = "bogus"; });
    mut("sourceRecord-disposition", (c) => { c.sourceSurface.sources[0].moduleDisposition = "bogus"; });
    mut("sourceRecord-missing", (c) => { delete c.sourceSurface.sources[0].path; });
    mut("moduleGraph-moduleCount", (c) => { c.moduleGraph.moduleCount = 999; });
    mut("moduleGraph-edgeCount", (c) => { c.moduleGraph.edgeCount = 999; });
    mut("moduleRecord-extra", (c) => { c.moduleGraph.modules[0].extra = 1; });
    mut("moduleRecord-originClass", (c) => { c.moduleGraph.modules[0].originClass = "bogus"; });
    mut("moduleRecord-missing", (c) => { delete c.moduleGraph.modules[0].sha256; });
    mut("edge-extra", (c) => { c.moduleGraph.edges[0].extra = 1; });
    mut("edge-kind", (c) => { c.moduleGraph.edges[0].kind = "nope"; });
    mut("edge-resolution", (c) => { c.moduleGraph.edges[0].resolution = "nope"; });
    mut("edge-attributes-key", (c) => { c.moduleGraph.edges[0].attributes.push({ key: 1, value: "x" }); });
    mut("edge-attributes-extra", (c) => { c.moduleGraph.edges[0].attributes.push({ key: "k", value: "v", extra: 1 }); });
    mut("span-extra", (c) => { c.moduleGraph.edges[0].span.extra = 1; });
    mut("span-negative", (c) => { c.moduleGraph.edges[0].span.startByte = -1; });
    mut("span-line", (c) => { c.moduleGraph.edges[0].span.startLine = 0; });
    mut("resolutionEvidence-method", (c) => { const e = c.moduleGraph.edges.find((x) => x.resolutionEvidence); e.resolutionEvidence.method = "x"; });
    mut("resolutionEvidence-count", (c) => { const e = c.moduleGraph.edges.find((x) => x.resolutionEvidence); e.resolutionEvidence.candidateDomainCount = 0; });
    mut("consumerModule-extra", (c) => { c.consumerInventory.modules[0].extra = 1; });
    mut("consumerModule-entrypoint", (c) => { c.consumerInventory.modules[0].entrypoint = "x"; });
    mut("envAccess-form", (c) => { c.consumerInventory.modules[0].environmentAccesses.push({ name: null, form: "bogus", span: c.moduleGraph.edges[0].span }); });
    mut("envAccess-name", (c) => { c.consumerInventory.modules[0].environmentAccesses.push({ name: 5, form: "member", span: c.moduleGraph.edges[0].span }); });
    mut("lease-extra", (c) => { c.leaseInventory[0].extra = 1; });
    mut("lease-missing", (c) => { delete c.leaseInventory[0].leaseIdentity; });
    mut("leaseUse-missing", (c) => { delete c.leaseInventory[0].uses[0].span; });
    mut("leaseDeclaration-missing", (c) => { delete c.leaseInventory[0].declaration.localName; });
    mut("receiptSchema-pointer", (c) => { c.leaseInventory[0].receiptSchema.trustBaseJsonPointer = "bad"; });
    mut("receiptSchema-missing", (c) => { delete c.leaseInventory[0].receiptSchema.sha256; });
    mut("protocolCohort-missing", (c) => { delete c.leaseInventory[0].protocolCohorts[0].requiredFields; });
    mut("protocolCohort-schemaPointer", (c) => { c.leaseInventory[0].protocolCohorts[0].schemaPointer = ""; });
    mut("fieldInfluence-bad-key", (c) => { c.leaseInventory[0].fieldInfluence["BadKey"] = ["x"]; });
    mut("fieldInfluence-bad-value", (c) => { c.leaseInventory[0].fieldInfluence["authority-contract"] = "notarray"; });
    mut("fieldInfluence-dup", (c) => { c.leaseInventory[0].fieldInfluence["authority-contract"] = ["a", "a"]; });
    mut("fieldInfluence-empty", (c) => { c.leaseInventory[0].fieldInfluence["authority-contract"] = []; });
    mut("fieldInfluence-empty-value", (c) => { c.leaseInventory[0].fieldInfluence["authority-contract"] = [""]; });
    mut("envBindings-mode", (c) => { c.leaseInventory[0].environmentBindings.mode = "x"; });
    mut("envBindings-names-dup", (c) => { c.leaseInventory[0].environmentBindings.names = ["a", "a"]; });
    mut("violations-dup", (c) => { c.violations = ["x", "x"]; });
    mut("violations-nonstring", (c) => { c.violations = [1]; });
    mut("generator-path", (c) => { c.generator.relativePath = "x"; });
    console.log(`  schema hostile checks: ${schPass}`);
  }

  // === Scope-aware binding/data-flow hostile tests ===
  {
    let scopePass = 0;
    const scopeRoot = prepareRepositoryRoot("scope-analysis-root");
    const boundary = createQualificationParserBoundary(scopeRoot);
    const findFirst = (program, pred) => {
      const stack = [program];
      while (stack.length > 0) {
        const n = stack.pop();
        if (pred(n)) return n;
        for (const ch of astChildren(n)) stack.push(ch);
      }
      return undefined;
    };
    const parse = (src) => boundary.parseModule(src, "src/x.ts");
    const envOf = (src) => {
      const parsed = parse(src);
      const { scopeOf } = buildScopeAnalysis(parsed.program);
      const member = findFirst(parsed.program, (n) =>
        (n.type === "MemberExpression" || n.type === "OptionalMemberExpression"));
      return resolvesToProcessEnv({ scopeOf }, astNode(member.object));
    };
    // direct process.env.FOO
    assert.equal(envOf("const x = process.env.FOO;"), true); scopePass += 1;
    // top-level alias
    assert.equal(envOf("const env = process.env; const x = env.FOO;"), true); scopePass += 1;
    // function-local alias (previously missed)
    assert.equal(envOf("function f() { const env = process.env; return env.FOO; }"), true); scopePass += 1;
    // member flow through two aliases
    assert.equal(envOf("const env = process.env; const x = env; const y = x.FOO;"), true); scopePass += 1;
    // destructuring default process.env.BAR
    assert.equal(envOf("const { FOO = process.env.BAR } = {};"), true); scopePass += 1;
    // destructuring of process.env
    {
      const parsed = parse("const { FOO } = process.env;");
      const { scopeOf } = buildScopeAnalysis(parsed.program);
      const decl = findFirst(parsed.program, (n) => n.type === "VariableDeclarator");
      assert.equal(resolvesToProcessEnv({ scopeOf }, astNode(decl.init)), true); scopePass += 1;
    }
    // shadowed process: local `process` must NOT be env
    assert.equal(envOf("const process = { env: { FOO: 1 } }; const x = process.env.FOO;"), false); scopePass += 1;
    // non-env member
    assert.equal(envOf("const x = obj.FOO;"), false); scopePass += 1;
    // alias cycle does not crash
    assert.equal(envOf("let a = b; let b = a; const x = a.FOO;"), false); scopePass += 1;
    // nested function scopes: outer alias visible inside
    assert.equal(envOf("const env = process.env; function f() { function g() { return env.FOO; } }"), true); scopePass += 1;
    // block-scoped alias not visible outside (resolved at use site)
    assert.equal(envOf("{ const env = process.env; const x = env.FOO; }"), true); scopePass += 1;

    // --- resolveScopedImportedBinding: alias chain to authority export ---
    const holderSrc = "import { deriveQualificationTrustBase as derive } from '../auth.mjs';\nconst d = derive;\nconst e = d;\nvoid e(null);";
    const holderParsed = parse(holderSrc);
    const holderScopeOf = buildScopeAnalysis(holderParsed.program).scopeOf;
    const callNode = findFirst(holderParsed.program, (n) => n.type === "CallExpression");
    const authModule = {
      source: { path: "auth.mjs" }, imports: new Map(), exports: new Map([
        ["deriveQualificationTrustBase", { kind: "local", localName: "deriveQualificationTrustBase" }]]),
      starExports: [], declarations: new Map(), uniqueDeclarations: new Map(), scopeOf: new Map()
    };
    const holderModule = {
      source: { path: "src/x.ts" },
      imports: new Map([["derive", { kind: "named", importedName: "deriveQualificationTrustBase", edge: { target: "auth.mjs" } }]]),
      exports: new Map(), starExports: [], declarations: new Map(), uniqueDeclarations: new Map(),
      scopeOf: holderScopeOf
    };
    const modules = new Map([["auth.mjs", authModule], ["src/x.ts", holderModule]]);
    const resolved = resolveScopedImportedBinding(modules, holderModule, "e", callNode);
    assert.equal(resolved.status, "resolved"); scopePass += 1;
    assert.equal(resolved.target.exportName, "deriveQualificationTrustBase"); scopePass += 1;
    // direct (non-aliased) still resolves
    const direct = resolveScopedImportedBinding(modules, holderModule, "derive", callNode);
    assert.equal(direct.status, "resolved"); scopePass += 1;
    // unknown name
    assert.equal(resolveScopedImportedBinding(modules, holderModule, "nope", callNode).status, "not-internal-import"); scopePass += 1;
    // alias to non-identifier init does not resolve to import
    {
      const src2 = "import { deriveQualificationTrustBase as derive } from '../auth.mjs';\nconst d = 42;\nvoid d;";
      const p2 = parse(src2); const so2 = buildScopeAnalysis(p2.program).scopeOf;
      const m2 = { source: { path: "src/x.ts" }, imports: holderModule.imports, exports: new Map(), starExports: [], declarations: new Map(), uniqueDeclarations: new Map(), scopeOf: so2 };
      assert.equal(resolveScopedImportedBinding(modules, m2, "d", findFirst(p2.program, (n) => n.type === "Identifier" && n.name === "d")).status, "not-internal-import"); scopePass += 1;
    }

    // --- buildScopeAnalysis: shadowing ---
    {
      const src = "const x = 1; function f() { const x = 2; return x; }";
      const program = parse(src).program;
      const { scopeOf } = buildScopeAnalysis(program);
      const fn = findFirst(program, (n) => n.type === "FunctionDeclaration");
      const outerX = findFirst(program, (n) => n.type === "VariableDeclarator" && astNode(n.id)?.name === "x");
      const innerX = findFirst(program, (n) => n.type === "VariableDeclarator" && astNode(n.id)?.name === "x" && n !== outerX);
      // function declaration name binds in program scope (visible from the function body)
      assert.ok(lookupScopeBinding(scopeOf, fn, "f") !== null); scopePass += 1;
      // outer x binds in program scope
      assert.ok(lookupScopeBinding(scopeOf, outerX, "x") !== null); scopePass += 1;
      // inner x shadows outer x (resolved to the inner binding from inside the function)
      const innerBinding = lookupScopeBinding(scopeOf, innerX, "x");
      assert.ok(innerBinding !== null && innerBinding.binding.node === innerX); scopePass += 1;
    }
    // default re-export resolves through the chain (false green #13)
    {
      const target = { source: { path: "target.mjs" }, imports: new Map(), exports: new Map([["default", { kind: "local", localName: "deriveQualificationTrustBase" }]]), starExports: [], declarations: new Map(), uniqueDeclarations: new Map(), scopeOf: new Map() };
      const reexp = { source: { path: "reexp.mjs" }, imports: new Map(), exports: new Map([["foo", { kind: "reexport", edge: { target: "target.mjs" }, importedName: "default" }]]), starExports: [], declarations: new Map(), uniqueDeclarations: new Map(), scopeOf: new Map() };
      const consumerSrc = "import { foo } from '../reexp.mjs';\nconst d = foo;\nvoid d(null);";
      const cp = parse(consumerSrc);
      const consumer = { source: { path: "src/c.ts" }, imports: new Map([["foo", { kind: "named", importedName: "foo", edge: { target: "reexp.mjs" } }]]), exports: new Map(), starExports: [], declarations: new Map(), uniqueDeclarations: new Map(), scopeOf: buildScopeAnalysis(cp.program).scopeOf };
      const mods = new Map([["target.mjs", target], ["reexp.mjs", reexp], ["src/c.ts", consumer]]);
      const r = resolveScopedImportedBinding(mods, consumer, "d", findFirst(cp.program, (n) => n.type === "CallExpression"));
      assert.equal(r.status, "resolved"); scopePass += 1;
      assert.equal(r.target.exportName, "default"); scopePass += 1;
    }
    // namespace member call via alias resolves (false green #11: property alias)
    {
      const nsSrc = "import * as auth from '../auth.mjs';\nconst a = auth;\nvoid a.deriveQualificationTrustBase(null);";
      const np = parse(nsSrc);
      const nsMod = { source: { path: "src/n.ts" }, imports: new Map([["auth", { kind: "namespace", importedName: "*", edge: { target: "auth.mjs" } }]]), exports: new Map(), starExports: [], declarations: new Map(), uniqueDeclarations: new Map(), scopeOf: buildScopeAnalysis(np.program).scopeOf };
      const mods2 = new Map([["auth.mjs", authModule], ["src/n.ts", nsMod]]);
      const ns = resolveScopedImportedBinding(mods2, nsMod, "a", findFirst(np.program, (n) => n.type === "CallExpression"));
      assert.equal(ns.status, "resolved-namespace"); scopePass += 1;
    }
    console.log(`  scope-aware hostile checks: ${scopePass}`);
  }

  // === Ambiguity blocking: an ambiguous star-export call produces a violation ===
  {
    const ambRoot = prepareRepositoryRoot("ambiguity-root");
    writeFixture(ambRoot, "src/a.ts", "export const deriveQualificationTrustBase = () => {};\n");
    writeFixture(ambRoot, "src/b.ts", "export const deriveQualificationTrustBase = () => {};\n");
    writeFixture(ambRoot, "src/star.ts", "export * from './a.ts';\nexport * from './b.ts';\n");
    writeFixture(ambRoot, "src/use.ts", "import { deriveQualificationTrustBase } from './star.ts';\nderiveQualificationTrustBase(null);\n");
    const amb = compileQualificationAuthorityInventory(ambRoot);
    assert.ok(amb.violations.some((v) => v.startsWith("lease_call_unresolved:") || v.startsWith("module_edge_")), "ambiguous flow must block");
  }

  // === Three distinct diverse-root scenarios exercising scope-aware analysis ===
  {
    const diverseRoots = ["alpha-ascii-root", "root with spaces", "Ω-unicode-root"].map((name) =>
      prepareRepositoryRoot(name));
    for (const r of diverseRoots) {
      writeFixture(r, "src/env.ts", [
        "const env = process.env;",
        "function read(key) { const local = env; return local[key]; }",
        "const { DEFAULT = process.env.FALLBACK } = {};",
        "export { read };"
      ].join("\n"));
      const inv = compileQualificationAuthorityInventory(r);
      assert.equal(inv.status, "compiled-current");
      assert.equal(inv.violations.length, 0);
      const envMod = inv.moduleGraph.modules.find((m) => m.path === "src/env.ts");
      assert.ok(envMod, "env module present in each diverse root");
    }
  }

  // === Documentation authority-consumer equality (reject reason 5) ===
  {
    let docPass = 0;
    const docAudit = auditQualificationAuthorityDocumentation(ROOT);
    assert.equal(docAudit.status, "current",
      "documentation consumers must equal canonical authority: " + JSON.stringify(docAudit.violations));
    assert.equal(docAudit.violations.length, 0); docPass += 2;
    assert.equal(docAudit.consumerCount, 3); docPass += 1;
    // hostile: a drifted receipt-hash claim must be detected, then restored
    const docPath = "docs/research/security/secret-span-qualification-foundation.md";
    const original = readFileSync(join(ROOT, docPath), "utf8");
    const drifted = original.replace(/"receiptSha256": "[0-9a-f]{64}"/,
      '"receiptSha256": "' + "f".repeat(64) + '"');
    writeFileSync(join(ROOT, docPath), drifted, { encoding: "utf8", mode: 0o600 });
    const driftAudit = auditQualificationAuthorityDocumentation(ROOT);
    assert.equal(driftAudit.status, "drift"); docPass += 1;
    assert.ok(driftAudit.violations.some((v) => v.includes("documentation_authority_claim_drift")), docPass += 0); docPass += 1;
    // hostile: a missing claims block must be detected, then restored
    writeFileSync(join(ROOT, docPath), "no claims here\n", { encoding: "utf8", mode: 0o600 });
    assert.equal(auditQualificationAuthorityDocumentation(ROOT).status, "drift"); docPass += 1;
    writeFileSync(join(ROOT, docPath), original, { encoding: "utf8", mode: 0o600 });
    assert.equal(auditQualificationAuthorityDocumentation(ROOT).status, "current"); docPass += 1;
    console.log("  documentation-consumer hostile checks: " + docPass);
  }

  process.stdout.write(`${JSON.stringify({
    status: "qualification-authority-v5-hostile-suite-passed",
    sourceCount: currentInventory.sourceSurface.sourceCount,
    carrierClassCount: carrierClasses.size,
    moduleCount: currentInventory.moduleGraph.moduleCount,
    edgeCount: currentInventory.moduleGraph.edgeCount,
    consumerCount: currentInventory.consumerInventory.modules.length,
    leaseCount: currentInventory.leaseInventory.length,
    protocolCohortCount: audit.protocolCohortCount,
    portableRootCount: portableRoots.length,
    parserMutationCount: byteMutationCases.length + 4
  })}\n`);
} finally {
  projectedInventory = undefined;
  rmSync(TEST_PARENT, { force: true, recursive: true });
}
