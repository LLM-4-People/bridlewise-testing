const packageRoot = "verification/benchmarks/cli/interaction-command-job-qualification";
const validatorPath = packageRoot + "/validate-protocol.mjs";
const sharedVerifierPath = "verification/benchmarks/cli/verify-qualification-author-receipt.mjs";
const runnerPath = "verification/benchmarks/cli/run-interaction-command-job-qualification.mjs";
const testPath = "verification/benchmarks/cli/test-interaction-command-job-qualification.mjs";

export const QUALIFICATION_PATHS = Object.freeze({
  rootRealpath: "/home/example/bridlewise",
  rootResolverVersion: "realpath-root-sha256/v1",
  sectionResolverVersion: "markdown-atx-h3-section-bytes/v1",
  schemaPath: "docs/research/cli/qualification-protocol-artifacts.v3.schema.json",
  catalogPath: "docs/research/cli/qualification-protocol-artifacts.v3.json",
  documentPath: "docs/research/cli/interaction-command-job-qualification-brief.md",
  packageRoot,
  validatorPath,
  sharedVerifierPath,
  runnerPath,
  testPath,
  authorReceiptPath: "traceability/evidence/research/cli/qualification-protocol-author-receipt.v1.json",
  authorPinPath: "traceability/evidence/research/cli/qualification-protocol-author-receipt.v1.sha256",
  governedSourcePaths: Object.freeze([
    "verification/benchmarks/cli/interaction-command-job-qualification-paths.mjs",
    sharedVerifierPath,
    runnerPath,
    testPath
  ]),
  governedInputPaths: Object.freeze([
    "docs/research/cli/interaction-command-job-qualification-brief.md",
    "docs/research/cli/qualification-protocol-artifacts.v3.schema.json",
    "docs/research/cli/qualification-protocol-artifacts.v3.json",
    "package.json",
    "package-lock.json"
  ]),
  dependencyPackageNames: Object.freeze([
    "ajv",
    "fast-deep-equal",
    "fast-uri",
    "json-schema-traverse",
    "require-from-string"
  ])
});
