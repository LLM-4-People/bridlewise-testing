import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  computeDispositionBinding,
  computeInventoryBinding,
  computeConfigSchemaBinding,
  generateAutoGeneratorReport,
  parseAutoGeneratorReport,
  AUTO_GENERATOR_SCHEMA_VERSION,
} from "../../src/workflow/auto-generator.ts";
import { canonicalJson, sha256 } from "../../src/kernel/integrity.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { VERIFICATION_PATHS } from "../../src/kernel/verification-paths.ts";
import { createTempDir } from "../support/temp-dir.ts";
import { engineModuleSourceRelative } from "../support/module-resolver.ts";

const ROOT = process.cwd();

test("AutoGenerator: computeDispositionBinding returns binding for real project", () => {
  const binding = computeDispositionBinding(ROOT);
  assert.ok(binding !== null);
  assert.ok(typeof binding!.fileSha256 === "string");
  assert.ok(typeof binding!.identityHash === "string");
  assert.ok(binding!.fileSha256.length === 64);
  assert.ok(binding!.identityHash.length === 64);
});

test("AutoGenerator: computeDispositionBinding matches current root policy", () => {
  const binding = computeDispositionBinding(ROOT);
  assert.ok(binding !== null);
  assert.equal(binding!.current.fileSha256, ROOT_POLICY.verification.testSurfaceDispositionBinding.fileSha256);
  assert.equal(binding!.current.identityHash, ROOT_POLICY.verification.testSurfaceDispositionBinding.identityHash);
});

test("AutoGenerator: computeDispositionBinding returns null for missing file", () => {
  const tmpDir = createTempDir("auto-gen-missing-disp-");
  try {
    const binding = computeDispositionBinding(tmpDir);
    assert.equal(binding, null);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("AutoGenerator: computeInventoryBinding returns binding for real project", () => {
  const binding = computeInventoryBinding(ROOT);
  assert.ok(binding !== null);
  assert.ok(typeof binding!.testInventoryHash === "string");
  assert.ok(binding!.testInventoryHash.length === 64);
});

test("AutoGenerator: computeInventoryBinding matches current root policy", () => {
  const binding = computeInventoryBinding(ROOT);
  assert.ok(binding !== null);
  assert.equal(binding!.current, ROOT_POLICY.verification.testInventoryHash);
});

test("AutoGenerator: computeInventoryBinding returns null for missing file", () => {
  const tmpDir = createTempDir("auto-gen-missing-inv-");
  try {
    const binding = computeInventoryBinding(tmpDir);
    assert.equal(binding, null);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("AutoGenerator: computeConfigSchemaBinding returns valid binding", () => {
  const binding = computeConfigSchemaBinding(ROOT);
  assert.ok(typeof binding.schemaHash === "string");
  assert.ok(typeof binding.identityHash === "string");
  assert.ok(binding.schemaHash.length === 64);
  assert.ok(binding.identityHash.length === 64);
});

test("AutoGenerator: computeConfigSchemaBinding matches", () => {
  const binding = computeConfigSchemaBinding(ROOT);
  assert.equal(binding.matches, true);
});

test("AutoGenerator: computeConfigSchemaBinding detects source drift", () => {
  const tmpDir = createTempDir("auto-gen-config-drift-");
  try {
    // The config contract + root policy live under src/kernel/ post-fold; the
    // fixture mirrors that layout (resolved from the module resolver, not a
    // hardcoded path) so the binding resolves the policy's declared sourcePath.
    const policyRel = engineModuleSourceRelative("root-policy.ts");
    const contractRel = engineModuleSourceRelative("kernel/config-contracts.ts");
    for (const rel of [policyRel, contractRel]) {
      mkdirSync(join(tmpDir, dirname(rel)), { recursive: true });
    }
    const policyText = readFileSync(join(ROOT, policyRel), "utf8");
    const contractText = readFileSync(join(ROOT, contractRel), "utf8");
    writeFileSync(join(tmpDir, policyRel), policyText);
    writeFileSync(join(tmpDir, contractRel), contractText + "\n// drift\n");
    const binding = computeConfigSchemaBinding(tmpDir);
    assert.equal(binding.matches, false);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("AutoGenerator: generateAutoGeneratorReport produces valid report", () => {
  const report = generateAutoGeneratorReport(ROOT);
  assert.equal(report.schemaVersion, AUTO_GENERATOR_SCHEMA_VERSION);
  assert.ok(report.steps.length > 0);
  assert.ok(typeof report.allMatch === "boolean");
  assert.ok(typeof report.integrityHash === "string");
});

test("AutoGenerator: report has disposition binding step", () => {
  const report = generateAutoGeneratorReport(ROOT);
  const step = report.steps.find((entry) => entry.step === "disposition-binding");
  assert.ok(step);
  assert.equal(step!.status, "pass");
});

test("AutoGenerator: report has inventory binding step", () => {
  const report = generateAutoGeneratorReport(ROOT);
  const step = report.steps.find((entry) => entry.step === "inventory-binding");
  assert.ok(step);
  assert.equal(step!.status, "pass");
});

test("AutoGenerator: report has config schema binding step", () => {
  const report = generateAutoGeneratorReport(ROOT);
  const step = report.steps.find((entry) => entry.step === "config-schema-binding");
  assert.ok(step);
  assert.equal(step!.status, "pass");
});

test("AutoGenerator: report has qualification authority inventory step", () => {
  const report = generateAutoGeneratorReport(ROOT);
  const step = report.steps.find((entry) => entry.step === "qualification-authority-inventory");
  assert.ok(step);
  assert.equal(step!.status, "pass");
});

test("AutoGenerator: report allMatch is true for real project", () => {
  const report = generateAutoGeneratorReport(ROOT);
  assert.equal(report.allMatch, true);
});

test("AutoGenerator: report integrity hash is valid", () => {
  const report = generateAutoGeneratorReport(ROOT);
  const { integrityHash, ...unsigned } = report;
  assert.equal(sha256(canonicalJson(unsigned)), integrityHash);
});

test("AutoGenerator: report is frozen", () => {
  const report = generateAutoGeneratorReport(ROOT);
  assert.ok(Object.isFrozen(report));
});

test("AutoGenerator: report has generatedAt timestamp", () => {
  const report = generateAutoGeneratorReport(ROOT);
  const parsed = new Date(report.generatedAt);
  assert.ok(!Number.isNaN(parsed.getTime()));
});

test("AutoGenerator: report has root field", () => {
  const report = generateAutoGeneratorReport(ROOT);
  assert.equal(report.root, ROOT);
});

test("AutoGenerator: report has dispositionBinding field", () => {
  const report = generateAutoGeneratorReport(ROOT);
  assert.ok(report.dispositionBinding !== null);
  assert.ok(typeof report.dispositionBinding!.fileSha256 === "string");
});

test("AutoGenerator: report has inventoryBinding field", () => {
  const report = generateAutoGeneratorReport(ROOT);
  assert.ok(report.inventoryBinding !== null);
  assert.ok(typeof report.inventoryBinding!.testInventoryHash === "string");
});

test("AutoGenerator: report has configSchemaBinding field", () => {
  const report = generateAutoGeneratorReport(ROOT);
  assert.ok(report.configSchemaBinding !== null);
  assert.ok(typeof report.configSchemaBinding!.schemaHash === "string");
});

test("AutoGenerator: parseAutoGeneratorReport parses valid report", () => {
  const report = generateAutoGeneratorReport(ROOT);
  const parsed = parseAutoGeneratorReport(JSON.parse(canonicalJson(report)));
  assert.equal(parsed.schemaVersion, report.schemaVersion);
  assert.equal(parsed.allMatch, report.allMatch);
});

test("AutoGenerator: parseAutoGeneratorReport throws on invalid schema version", () => {
  const report = generateAutoGeneratorReport(ROOT);
  const raw = JSON.parse(canonicalJson(report));
  raw.schemaVersion = "wrong";
  assert.throws(() => parseAutoGeneratorReport(raw), /schema version/);
});

test("AutoGenerator: parseAutoGeneratorReport throws on non-object", () => {
  assert.throws(() => parseAutoGeneratorReport(null), /must be an object/);
  assert.throws(() => parseAutoGeneratorReport("str"), /must be an object/);
  assert.throws(() => parseAutoGeneratorReport(42), /must be an object/);
});

test("AutoGenerator: parseAutoGeneratorReport throws on tampered integrity", () => {
  const report = generateAutoGeneratorReport(ROOT);
  const raw = JSON.parse(canonicalJson(report));
  raw.integrityHash = "0".repeat(64);
  assert.throws(() => parseAutoGeneratorReport(raw), /integrity is invalid/);
});

test("AutoGenerator: parseAutoGeneratorReport throws on missing integrity hash", () => {
  const report = generateAutoGeneratorReport(ROOT);
  const raw = JSON.parse(canonicalJson(report));
  delete raw.integrityHash;
  assert.throws(() => parseAutoGeneratorReport(raw), /integrity hash/);
});

test("AutoGenerator: report detects missing disposition file", () => {
  const tmpDir = createTempDir("auto-gen-nodisp-");
  try {
    const report = generateAutoGeneratorReport(tmpDir);
    const step = report.steps.find((entry) => entry.step === "disposition-binding");
    assert.ok(step);
    assert.equal(step!.status, "error");
    assert.equal(report.dispositionBinding, null);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("AutoGenerator: report detects missing inventory file", () => {
  const tmpDir = createTempDir("auto-gen-noinv-");
  try {
    const report = generateAutoGeneratorReport(tmpDir);
    const step = report.steps.find((entry) => entry.step === "inventory-binding");
    assert.ok(step);
    assert.equal(step!.status, "error");
    assert.equal(report.inventoryBinding, null);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("AutoGenerator: report detects missing qualification authority inventory", () => {
  // A tree WITH the verification surface but the inventory file deleted →
  // error (the file is expected and absent). Build a temp dir carrying a
  // `verification/` tree but not the inventory, so the step is the error arm,
  // not the product-only guided skip.
  const tmpDir = createTempDir("auto-gen-noqual-");
  try {
    mkdirSync(join(tmpDir, "verification", "benchmarks", "shared"), { recursive: true });
    const report = generateAutoGeneratorReport(tmpDir);
    const step = report.steps.find((entry) => entry.step === "qualification-authority-inventory");
    assert.ok(step);
    assert.equal(step!.status, "error");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("AutoGenerator: a product-only tree (no verification surface) reports the guided skip, not an error", () => {
  // The inverse arm: a tree with NO `verification/` directory is product-only
  // (master's shape), and the inventory step is a guided pass, not an error.
  const tmpDir = createTempDir("auto-gen-productonly-");
  try {
    const report = generateAutoGeneratorReport(tmpDir);
    const step = report.steps.find((entry) => entry.step === "qualification-authority-inventory");
    assert.ok(step);
    assert.equal(step!.status, "pass");
    assert.match(step!.message, /no verification tree/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("AutoGenerator: report allMatch is false when files are missing", () => {
  const tmpDir = createTempDir("auto-gen-false-");
  try {
    const report = generateAutoGeneratorReport(tmpDir);
    assert.equal(report.allMatch, false);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("AutoGenerator: report determinism - same root produces same report (ignoring timestamp)", () => {
  const report1 = generateAutoGeneratorReport(ROOT);
  const report2 = generateAutoGeneratorReport(ROOT);
  assert.equal(report1.allMatch, report2.allMatch);
  assert.equal(report1.steps.length, report2.steps.length);
  for (let i = 0; i < report1.steps.length; i++) {
    assert.equal(report1.steps[i]!.step, report2.steps[i]!.step);
    assert.equal(report1.steps[i]!.status, report2.steps[i]!.status);
  }
});

test("AutoGenerator: disposition binding captures fileSha256 from actual file", () => {
  const binding = computeDispositionBinding(ROOT);
  assert.ok(binding !== null);
  const dispositionPath = join(ROOT, ROOT_POLICY.verification.testDiscovery.dispositionRegistry.manifestPath);
  const fileBytes = readFileSync(dispositionPath, "utf8");
  assert.equal(binding!.fileSha256, sha256(fileBytes));
});

test("AutoGenerator: disposition binding captures identityHash from file content", () => {
  const binding = computeDispositionBinding(ROOT);
  assert.ok(binding !== null);
  const dispositionPath = join(ROOT, ROOT_POLICY.verification.testDiscovery.dispositionRegistry.manifestPath);
  const fileBytes = readFileSync(dispositionPath, "utf8");
  const parsed = JSON.parse(fileBytes);
  assert.equal(binding!.identityHash, parsed.integrityHash);
});

test("AutoGenerator: inventory binding captures testInventoryHash from file", () => {
  const binding = computeInventoryBinding(ROOT);
  assert.ok(binding !== null);
  const inventoryPath = join(ROOT, VERIFICATION_PATHS.testInventory);
  const fileBytes = readFileSync(inventoryPath, "utf8");
  const parsed = JSON.parse(fileBytes);
  assert.equal(binding!.testInventoryHash, parsed.inventoryHash);
});

test("AutoGenerator: config schema binding has correct schema hash", () => {
  const binding = computeConfigSchemaBinding(ROOT);
  assert.equal(binding.schemaHash.length, 64);
  assert.match(binding.schemaHash, /^[0-9a-f]{64}$/u);
});

test("AutoGenerator: config schema binding has correct identity hash", () => {
  const binding = computeConfigSchemaBinding(ROOT);
  assert.equal(binding.identityHash.length, 64);
  assert.match(binding.identityHash, /^[0-9a-f]{64}$/u);
});

test("AutoGenerator: report steps have required fields", () => {
  const report = generateAutoGeneratorReport(ROOT);
  for (const step of report.steps) {
    assert.ok(typeof step.step === "string");
    assert.ok(["pass", "drift", "error"].includes(step.status));
    assert.ok(typeof step.message === "string");
  }
});

test("AutoGenerator: 5 consecutive reports are consistent", () => {
  const reports = [];
  for (let i = 0; i < 5; i++) {
    reports.push(generateAutoGeneratorReport(ROOT));
  }
  for (let i = 1; i < 5; i++) {
    assert.equal(reports[0]!.allMatch, reports[i]!.allMatch);
    assert.equal(reports[0]!.steps.length, reports[i]!.steps.length);
  }
});
