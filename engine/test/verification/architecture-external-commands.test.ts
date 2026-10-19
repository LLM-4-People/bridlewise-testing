import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  verifyArchitectureSources,
  type ArchitectureSource,
} from "../../scripts/verification/architecture.ts";
import {
  ARCHITECTURE_MANIFEST,
  EMPTY_COMPOSITION_ROOTS,
  type ArchitectureExternalCommand,
  type ArchitectureManifest,
} from "../../src/architecture-manifest.ts";
import { sha256 } from "../../src/kernel/integrity.ts";

// Regression coverage for MAJOR finding M2: `verifyExternalCommands` must
// read each external command's source from disk (provided by the caller as
// `externalCommandSources`) and assert its SHA-256 equals the manifest's
// `sourceSha256`. Previously it only checked the *format* of `sourceSha256`,
// so ~30 external Python/shell commands had unverified bindings.

const PYTHON_SOURCE = "import sys\nprint('hello')\n";
const PYTHON_HASH = sha256(PYTHON_SOURCE);

function makeExternalCommand(overrides: Partial<ArchitectureExternalCommand> = {}): ArchitectureExternalCommand {
  return {
    disposition: "blocked-unqualified",
    effects: ["filesystem-read", "process-status"],
    exposure: "verification-internal",
    id: "test-python-command",
    language: "python",
    owner: "test-qualification",
    path: "verification/benchmarks/test/command.py",
    sourceSha256: PYTHON_HASH,
    ...overrides,
  };
}

function makeManifest(externalCommands: readonly ArchitectureExternalCommand[]): ArchitectureManifest {
  return {
    schemaVersion: "bridlewise-architecture-manifest/v3",
    sourceRoots: ["scripts/", "src/", "verification/"],
    graphPolicy: "exact-registered-edges-no-cycles",
    publicApiPolicy: "exact-declared-export-name-hash",
    analysisLimits: { maximumSourceBytes: 1_048_576, maximumAstNodes: 100_000 },
    responsibilityPolicy: "one-registered-cohesive-owner-per-responsibility",
    physicalLayoutStatus: "open-blocking-architecture-v1-migration-required",
    compositionRoots: EMPTY_COMPOSITION_ROOTS,
    externalCommands,
    modules: [],
    findings: [],
  };
}

test("architecture-external-commands: correct source hash passes", () => {
  const command = makeExternalCommand();
  const manifest = makeManifest([command]);
  const result = verifyArchitectureSources([], manifest, [{ path: command.path, source: PYTHON_SOURCE }]);
  assert.equal(
    result.violations.includes(`architecture-external-command-source-missing:${command.path}`),
    false,
  );
  assert.equal(
    result.violations.includes(`architecture-external-command-source-hash-drift:${command.path}`),
    false,
  );
});

test("architecture-external-commands: wrong source hash fails with hash-drift", () => {
  const command = makeExternalCommand({ sourceSha256: sha256("different source bytes") });
  const manifest = makeManifest([command]);
  const result = verifyArchitectureSources([], manifest, [{ path: command.path, source: PYTHON_SOURCE }]);
  assert.ok(
    result.violations.includes(`architecture-external-command-source-hash-drift:${command.path}`),
    `expected hash-drift violation, got: ${JSON.stringify(result.violations)}`,
  );
  assert.equal(
    result.violations.includes(`architecture-external-command-source-missing:${command.path}`),
    false,
  );
});

test("architecture-external-commands: missing source file fails with source-missing", () => {
  const command = makeExternalCommand();
  const manifest = makeManifest([command]);
  // Caller provides an empty source set: the command path is absent.
  const result = verifyArchitectureSources([], manifest, []);
  assert.ok(
    result.violations.includes(`architecture-external-command-source-missing:${command.path}`),
    `expected source-missing violation, got: ${JSON.stringify(result.violations)}`,
  );
  assert.equal(
    result.violations.includes(`architecture-external-command-source-hash-drift:${command.path}`),
    false,
  );
});

test("architecture-external-commands: omitted externalCommandSources skips content check (backward compat)", () => {
  const command = makeExternalCommand({ sourceSha256: sha256("wrong") });
  const manifest = makeManifest([command]);
  // No third argument: content verification is skipped (caller did not opt in).
  const result = verifyArchitectureSources([], manifest);
  assert.equal(
    result.violations.includes(`architecture-external-command-source-missing:${command.path}`),
    false,
  );
  assert.equal(
    result.violations.includes(`architecture-external-command-source-hash-drift:${command.path}`),
    false,
  );
});

test("architecture-external-commands: shell command hash verified", () => {
  const shellSource = "#!/bin/sh\necho hi\n";
  const shellCommand: ArchitectureExternalCommand = {
    disposition: "blocked-unqualified",
    effects: ["filesystem-read", "process-status"],
    exposure: "research-only-non-model-facing",
    id: "test-shell-command",
    language: "shell",
    owner: "test-qualification",
    path: "verification/benchmarks/test/command.sh",
    sourceSha256: sha256(shellSource),
  };
  const manifest = makeManifest([shellCommand]);
  const ok = verifyArchitectureSources([], manifest, [{ path: shellCommand.path, source: shellSource }]);
  assert.equal(ok.violations.includes(`architecture-external-command-source-hash-drift:${shellCommand.path}`), false);
  assert.equal(ok.violations.includes(`architecture-external-command-source-missing:${shellCommand.path}`), false);

  const drifted = verifyArchitectureSources(
    [],
    manifest,
    [{ path: shellCommand.path, source: `${shellSource}# tampered\n` }],
  );
  assert.ok(drifted.violations.includes(`architecture-external-command-source-hash-drift:${shellCommand.path}`));
});

test("architecture-external-commands: real repository external commands all match manifest", () => {
  const sources: ArchitectureSource[] = [];
  for (const command of ARCHITECTURE_MANIFEST.externalCommands) {
    sources.push({ path: command.path, source: readFileSync(command.path, "utf8") });
  }
  const result = verifyArchitectureSources([], ARCHITECTURE_MANIFEST, sources);
  const hashViolations = result.violations.filter((v) => v.startsWith("architecture-external-command-source-"));
  assert.deepEqual([...hashViolations], []);
});
