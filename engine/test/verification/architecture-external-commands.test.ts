import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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
//
// The same door now distinguishes a PUBLICATION boundary from a missing
// source: a command declared `publication: "not-published"` is still refused
// by name when absent, and refused again when its source unexpectedly
// appears. Neither arm is a skip.

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
    publication: "published",
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

test("architecture-external-commands: a not-published source is refused by name, not skipped", () => {
  const command = makeExternalCommand({ publication: "not-published" });
  const manifest = makeManifest([command]);
  const absent = verifyArchitectureSources([], manifest, []);
  assert.ok(
    absent.violations.includes(`architecture-external-command-source-not-published:${command.path}`),
    `the public boundary must be named, got: ${JSON.stringify(absent.violations)}`,
  );
  assert.equal(
    absent.violations.some((violation) => violation.startsWith("architecture-external-command-source-missing:")),
    false,
    "an expected-absent not-published source is not a missing-source defect",
  );
  assert.equal(
    absent.violations.some((violation) => violation.startsWith("architecture-external-command-source-hash-drift:")),
    false,
  );
  assert.equal(absent.ok, false, "the guard must refuse, not certify the absent boundary");
});

test("architecture-external-commands: a not-published source that appears is refused as an unexpected publication", () => {
  const command = makeExternalCommand({ publication: "not-published" });
  const manifest = makeManifest([command]);
  const present = verifyArchitectureSources([], manifest, [{ path: command.path, source: PYTHON_SOURCE }]);
  assert.ok(
    present.violations.includes(`architecture-external-command-source-unexpectedly-published:${command.path}`),
    `an accidentally published source must be refused, got: ${JSON.stringify(present.violations)}`,
  );
  assert.equal(
    present.violations.some((violation) => violation.startsWith("architecture-external-command-source-not-published:")),
    false,
  );
  assert.equal(present.ok, false);
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
    publication: "published",
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

test("architecture-external-commands: real repository matches the manifest and its publication boundary", () => {
  const sources: ArchitectureSource[] = [];
  const notPublished = ARCHITECTURE_MANIFEST.externalCommands.filter((command) => command.publication === "not-published");
  for (const command of ARCHITECTURE_MANIFEST.externalCommands) {
    if (command.publication === "not-published") {
      assert.equal(
        existsSync(command.path),
        false,
        `the public snapshot must not carry the not-published source ${command.path}; a source that appears here is an accidental publication`,
      );
      continue;
    }
    sources.push({ path: command.path, source: readFileSync(command.path, "utf8") });
  }
  assert.ok(notPublished.length > 0, "the declared not-published set is empty — the boundary assertion would be vacuous");
  const result = verifyArchitectureSources([], ARCHITECTURE_MANIFEST, sources);
  const boundaryViolations = result.violations.filter((violation) =>
    violation.startsWith("architecture-external-command-source-not-published:"));
  assert.deepEqual(
    boundaryViolations.toSorted(),
    notPublished.map((command) => `architecture-external-command-source-not-published:${command.path}`).toSorted(),
    "every declared not-published source must be named on every run",
  );
  const publishedViolations = result.violations.filter((violation) =>
    violation.startsWith("architecture-external-command-source-") &&
    !violation.startsWith("architecture-external-command-source-not-published:"));
  assert.deepEqual([...publishedViolations], [], "every published source must match its manifest hash");
});
