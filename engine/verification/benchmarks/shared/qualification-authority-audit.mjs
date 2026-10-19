import { readFileSync } from "node:fs";
import { join, resolve as pathResolve } from "node:path";
import { sha256 } from "../../../src/kernel/integrity.ts";
import {
  QUALIFICATION_AUTHORITY_CONTRACT_SCHEMA_VERSION,
  QUALIFICATION_AUTHORITY_INVENTORY_SCHEMA_VERSION,
  QUALIFICATION_AUTHORITY_OWNER
} from "./qualification-authority-contract.mjs";
import { QUALIFICATION_PARSER_BOUNDARY_SCHEMA_VERSION } from "./qualification-parser.mjs";
import {
  compileQualificationAuthorityInventory,
  verifyQualificationAuthorityInventory
} from "./qualification-authority-inventory.mjs";

export const QUALIFICATION_AUTHORITY_AUDIT_CONTRACT = Object.freeze({
  schemaVersion: "bridlewise-qualification-authority-audit/v5",
  sourceUniverse: "complete-repository-supported-source-carriers",
  executableUniverse: "origin-policy-qualified-first-party-production-and-nonproduction",
  graphCoverage: Object.freeze([
    "static-import",
    "side-effect-import",
    "named-reexport",
    "barrel-export-all",
    "dynamic-import",
    "require",
    "require-resolve",
    "architecture-entrypoint"
  ]),
  parserBoundary: "single-installed-babel-parser-byte-and-lock-boundary",
  leasePolicy: "schema-derived-cohorts-configured-use-cardinality-and-compiled-environment-bindings",
  projectionPolicy: "exact-canonical-equality-read-only"
});

function summarize(inventory) {
  return Object.freeze({
    schemaVersion: QUALIFICATION_AUTHORITY_AUDIT_CONTRACT.schemaVersion,
    status: inventory.status === "compiled-current" && inventory.violations.length === 0 ?
      "complete-current" : "blocked",
    inventoryIdentity: inventory.inventoryIdentity,
    parserBoundaryIdentity: inventory.parserBoundary.parserBoundaryIdentity,
    sourceCount: inventory.sourceSurface.sourceCount,
    executableSourceCount: inventory.sourceSurface.executableSourceCount,
    nonExecutableCarrierCount: inventory.sourceSurface.nonExecutableCarrierCount,
    moduleCount: inventory.moduleGraph.moduleCount,
    edgeCount: inventory.moduleGraph.edgeCount,
    unresolvedDynamicEdgeCount: inventory.moduleGraph.unresolvedDynamicEdges.length,
    consumerCount: inventory.consumerInventory.modules.length,
    consumerEdgeCount: inventory.consumerInventory.edges.length,
    leaseCount: inventory.leaseInventory.length,
    protocolCohortCount: inventory.leaseInventory.reduce(
      (total, lease) => total + lease.protocolCohorts.length,
      0
    ),
    compiledEnvironmentNameCount: new Set(inventory.leaseInventory.flatMap(
      (lease) => lease.environmentBindings.names
    )).size,
    violations: inventory.violations
  });
}

export function auditQualificationAuthority(repositoryRoot) {
  return summarize(compileQualificationAuthorityInventory(repositoryRoot));
}

export function auditQualificationAuthorityProjection(value, repositoryRoot) {
  return summarize(verifyQualificationAuthorityInventory(value, repositoryRoot));
}

export const DOCUMENTATION_AUTHORITY_CONSUMER_REGISTRY = Object.freeze([
  Object.freeze({ path: "docs/research/security/secret-span-qualification-foundation.md", receiptPath: "traceability/evidence/research/secret-spans/foundation-author-receipt.v3.json", secretPinPath: "traceability/evidence/research/secret-spans/foundation-author-receipt.v3.sha256" }),
  Object.freeze({ path: "docs/research/coordination/migration-write-authority-remediation-report.md", receiptPath: "verification/benchmarks/coordination/migration-write-authority/author-receipt.v2.json" }),
  Object.freeze({ path: "verification/benchmarks/coordination/migration-write-authority/README.md", receiptPath: "verification/benchmarks/coordination/migration-write-authority/author-receipt.v2.json" })
]);
const CLAIMS_BLOCK = /<!-- authority-claims:v1 BEGIN -->\n\`\`\`json\n([\s\S]*?)\n\`\`\`\n<!-- authority-claims:v1 END -->/;
const REQUIRED_CLAIMS = Object.freeze([
  "authorityOwner", "inventoryPath", "inventorySchemaPath", "inventorySchemaVersion",
  "contractSchemaVersion", "parserBoundarySchemaVersion", "auditSchemaVersion"
]);
function canonicalClaimValue(root, key, claims) {
  switch (key) {
    case "authorityOwner": return QUALIFICATION_AUTHORITY_OWNER;
    case "inventoryPath": return "verification/benchmarks/shared/qualification-authority-inventory.v5.json";
    case "inventorySchemaPath": return "verification/benchmarks/shared/qualification-authority-inventory.schema.json";
    case "inventorySchemaVersion": return QUALIFICATION_AUTHORITY_INVENTORY_SCHEMA_VERSION;
    case "contractSchemaVersion": return QUALIFICATION_AUTHORITY_CONTRACT_SCHEMA_VERSION;
    case "parserBoundarySchemaVersion": return QUALIFICATION_PARSER_BOUNDARY_SCHEMA_VERSION;
    case "auditSchemaVersion": return QUALIFICATION_AUTHORITY_AUDIT_CONTRACT.schemaVersion;
    case "receiptSha256": {
      if (typeof claims.receiptPath !== "string" || claims.receiptPath.length === 0) return undefined;
      try { return sha256(readFileSync(join(root, claims.receiptPath))); } catch { return undefined; }
    }
    default: return undefined;
  }
}

export function auditQualificationAuthorityDocumentation(repositoryRoot) {
  const root = pathResolve(repositoryRoot);
  const violations = [];
  for (const entry of DOCUMENTATION_AUTHORITY_CONSUMER_REGISTRY) {
    let text;
    try { text = readFileSync(join(root, entry.path), "utf8"); }
    catch { violations.push("documentation_authority_consumer_absent:" + entry.path); continue; }
    const match = CLAIMS_BLOCK.exec(text);
    if (!match) { violations.push("documentation_authority_consumer_missing:" + entry.path); continue; }
    let claims;
    try { claims = JSON.parse(match[1]); }
    catch { violations.push("documentation_authority_consumer_malformed:" + entry.path); continue; }
    if (entry.receiptPath !== undefined) {
      if (claims.receiptPath !== entry.receiptPath) violations.push("documentation_authority_receipt_path_drift:" + entry.path);
    }
    if (entry.secretPinPath !== undefined) {
      if (claims.secretPinPath !== entry.secretPinPath) violations.push("documentation_authority_pin_path_drift:" + entry.path);
    }
    for (const key of Object.keys(claims)) {
      const expected = canonicalClaimValue(root, key, claims);
      if (expected === undefined) continue;
      if (claims[key] !== expected) violations.push("documentation_authority_claim_drift:" + entry.path + ":" + key);
    }
    for (const req of REQUIRED_CLAIMS) {
      if (claims[req] === undefined) violations.push("documentation_authority_claim_missing:" + entry.path + ":" + req);
    }
  }
  return Object.freeze({
    schemaVersion: "bridlewise-qualification-authority-documentation-audit/v1",
    status: violations.length === 0 ? "current" : "drift",
    consumerCount: DOCUMENTATION_AUTHORITY_CONSUMER_REGISTRY.length,
    violations: Object.freeze(violations)
  });
}
