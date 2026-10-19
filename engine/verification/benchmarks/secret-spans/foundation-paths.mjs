import { defineCommandEffectContract } from "../shared/command-effect-contract.mjs";

export const SECRET_SPAN_QUALIFICATION_VERSIONS = Object.freeze({
  protocol: "bridlewise-secret-span-protocol/v3",
  result: "bridlewise-secret-span-result/v3",
  authorReceipt: "bridlewise-secret-span-author-receipt/v3",
  trustBase: "bridlewise-secret-span-trust-base/v3"
});

export const SECRET_SPAN_PATHS = Object.freeze({
  packageRoot: "verification/benchmarks/secret-spans",
  protocol: "verification/benchmarks/secret-spans/protocol.v3.json",
  protocolSchema: "verification/benchmarks/secret-spans/schemas/protocol.v3.schema.json",
  corpusSchema: "verification/benchmarks/secret-spans/schemas/corpus.v2.schema.json",
  resultSchema: "verification/benchmarks/secret-spans/schemas/result.v3.schema.json",
  authorReceiptSchema: "verification/benchmarks/secret-spans/schemas/author-receipt.v3.schema.json",
  authorReceipt: "traceability/evidence/research/secret-spans/foundation-author-receipt.v3.json",
  authorPin: "traceability/evidence/research/secret-spans/foundation-author-receipt.v3.sha256",
  evidenceAuthorityRoot: "traceability/evidence/research",
  evidenceRelativeRoot: "secret-spans-v3-private",
  exactFalsePositive: Object.freeze({
    source: "verification/benchmarks/code-intelligence/qualification.py",
    line: 1013,
    fixtureId: "SAFE-CALL-001",
    admissionSignalId: "credential-assignment"
  })
});

export const SECRET_SPAN_AUTHOR_RECEIPT_COMMAND_EFFECTS = defineCommandEffectContract({
  commandClass: "build",
  commandId: "secret-spans/build-author-receipt",
  defaultMode: "derive",
  modes: [{
    availability: "available",
    effects: ["cryptography", "filesystem-read", "process-status"],
    invocation: "default-or-explicit",
    name: "derive",
    unavailableCode: undefined
  }, {
    availability: "available",
    effects: ["cryptography", "filesystem-read", "process-status"],
    invocation: "explicit-only",
    name: "check",
    unavailableCode: undefined
  }, {
    availability: "blocked",
    effects: ["cryptography", "filesystem-read", "filesystem-write", "process-status"],
    invocation: "explicit-only",
    name: "write",
    unavailableCode: "production_migration_write_authority_unavailable"
  }]
});

export const SECRET_SPAN_EVIDENCE_COMMAND_EFFECTS = defineCommandEffectContract({
  commandClass: "generate",
  commandId: "secret-spans/publish-evidence",
  defaultMode: "derive",
  modes: [{
    availability: "available",
    effects: ["cryptography", "filesystem-read", "process-status"],
    invocation: "default-or-explicit",
    name: "derive",
    unavailableCode: undefined
  }, {
    availability: "available",
    effects: ["cryptography", "filesystem-read", "process-status"],
    invocation: "explicit-only",
    name: "check",
    unavailableCode: undefined
  }, {
    availability: "blocked",
    effects: ["cryptography", "filesystem-read", "filesystem-write", "process-status"],
    invocation: "explicit-only",
    name: "write",
    unavailableCode: "production_migration_write_authority_unavailable"
  }]
});

export const SECRET_SPAN_FOUNDATION_ARTIFACTS = Object.freeze([
  "verification/benchmarks/secret-spans/author-receipt.mjs",
  "verification/benchmarks/secret-spans/build-author-receipt.mjs",
  "verification/benchmarks/secret-spans/candidate-adapters.mjs",
  "verification/benchmarks/secret-spans/candidate-worker.mjs",
  "verification/benchmarks/secret-spans/corpora/adversarial-boundaries.v2.json",
  "verification/benchmarks/secret-spans/corpora/encoded-and-multiline.v2.json",
  "verification/benchmarks/secret-spans/corpora/syntax-and-negatives.v2.json",
  "verification/benchmarks/secret-spans/fixture-compiler.mjs",
  "verification/benchmarks/secret-spans/foundation-paths.d.mts",
  "verification/benchmarks/secret-spans/foundation-paths.mjs",
  "verification/benchmarks/secret-spans/protocol.v3.json",
  "verification/benchmarks/secret-spans/publish-evidence.mjs",
  "verification/benchmarks/secret-spans/resource-probe-worker.mjs",
  "verification/benchmarks/secret-spans/run-qualification.mjs",
  "verification/benchmarks/secret-spans/schemas/author-receipt.v3.schema.json",
  "verification/benchmarks/secret-spans/schemas/corpus.v2.schema.json",
  "verification/benchmarks/secret-spans/schemas/protocol.v3.schema.json",
  "verification/benchmarks/secret-spans/schemas/result.v3.schema.json",
  "verification/benchmarks/secret-spans/span-gateway.mjs",
  "verification/benchmarks/secret-spans/test-qualification.mjs",
  "verification/benchmarks/secret-spans/verify-author-receipt.mjs",
  "verification/benchmarks/secret-spans/worker-executor.mjs",
  "verification/benchmarks/cli/verify-qualification-author-receipt.mjs",
  "verification/benchmarks/coordination/migration-write-authority/author-trust-base.mjs",
  "verification/benchmarks/shared/qualification-parser.mjs",
  "verification/benchmarks/shared/qualification-authority-contract.d.mts",
  "verification/benchmarks/shared/qualification-authority-contract.mjs",
  "verification/benchmarks/shared/qualification-authority-inventory.mjs",
  "verification/benchmarks/shared/qualification-authority-inventory.schema.json",
  "verification/benchmarks/shared/qualification-authority-inventory.v5.json",
  "verification/benchmarks/shared/qualification-authority-audit.mjs",
  "verification/benchmarks/shared/qualification-authority.mjs",
  "verification/benchmarks/shared/test-qualification-authority.mjs",
  "verification/benchmarks/shared/command-effect-contract.mjs",
  "verification/benchmarks/shared/command-effect-contract.d.mts",
  "scripts/verification/architecture.ts",
  "scripts/tooling/verification/command-effect-inventory.ts",
  "scripts/verification/effect-surface.ts",
  "scripts/tooling/verification/governed-source.ts",
  "src/filesystem/immutable-receipt.ts",
  "scripts/verification/safe-repository-reader.ts",
  "scripts/verification/static-source.ts",
  "src/architecture-manifest.ts",
  "src/errors.ts",
  "src/integrity.ts",
  "src/json-integrity.ts",
  "src/linux-path.ts",
  "src/ordered.ts",
  "src/path-boundary.ts",
  "src/secret-signals.ts",
  "package.json",
  "package-lock.json",
  "node_modules/.package-lock.json",
  "traceability/canonical/harness-requirements.md",
  "src/root-policy.ts",
  "src/runtime-capabilities.ts",
  SECRET_SPAN_PATHS.exactFalsePositive.source
]);

export const SECRET_SPAN_ROOT_PACKAGES = Object.freeze(["@babel/parser", "ajv"]);
