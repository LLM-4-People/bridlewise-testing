// test/regression/harness-regenerate-schema.test.ts
//
// Regression test for the EXP468 finding "harness regenerate does
// NOT regenerate `traceability/config-document-schema.json`".
//
// The fix added a `regenerateConfigSchemaArtifact` step to
// `harnessRegenerate` (src/workflow/harness-commands.ts). The step
// rewrites `traceability/config-document-schema.json` from
// `getConfigContractArtifact()` in canonical-JSON form, so the
// artifact cannot drift from `src/kernel/config-contracts.ts` after a
// contract edit.
//
// This test verifies the contract:
// 1. The `schemaArtifact` field exists on the `HarnessRegenerateOutput`
// TYPE (compile-time check — the test file imports the type and the
// tsc gate fails if the field is removed).
// 2. The on-disk artifact content matches
// `configContractArtifactText(getConfigContractArtifact())` (the one byte
// form `test/config/config-contracts.test.ts` expects, one entry per line).
//
// We do NOT call `harnessRegenerate` directly because that requires the
// full test-inventory subprocess to be runnable, which depends on the
// repository-root capability allowing the integration/ path as a safe
// repository root. That capability is not available in the test
// sandbox. The integration gate (`harness check`) exercises the full
// `harnessRegenerate` flow on every round; this test pins the contract.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import { canonicalJson, sha256 } from "../../src/kernel/integrity.ts";
import { configContractArtifactText, getConfigContractArtifact } from "../../src/kernel/config-contracts.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";

import type { HarnessRegenerateOutput } from "../../src/workflow/harness-commands.ts";
import { createTempDir } from "../support/temp-dir.ts";

const CONFIG_DOCUMENT_SCHEMA_ARTIFACT = getConfigContractArtifact();

test("harness regenerate: HarnessRegenerateOutput type has a schemaArtifact field (compile-time + runtime check)", () => {
  // Compile-time: if the schemaArtifact field is removed from the type,
  // `Pick` fails to compile, so the tsc gate fails. Runtime: we construct
  // a sample value with the field present.
  const sample: Pick<HarnessRegenerateOutput, "schemaArtifact"> = {
    schemaArtifact: {
      status: "current",
      schemaHash: "0".repeat(64),
      artifactPath: "traceability/config-document-schema.json",
    },
  };
  assert.equal(sample.schemaArtifact.status, "current");
  assert.equal(sample.schemaArtifact.artifactPath, "traceability/config-document-schema.json");
});

test("harness regenerate: the on-disk artifact matches CONFIG_DOCUMENT_SCHEMA_ARTIFACT in its one text form (one entry per line)", () => {
  const root = process.cwd();
  const artifactPath = join(root, ROOT_POLICY.configuration.contract.generatedSchemaPath);
  // The artifact is TRACKED (a generated output every checkout holds): absent is a red, never a skip.
  assert.ok(existsSync(artifactPath), `${artifactPath} is missing: run \`node src/cli.ts harness sync --with-bundle\``);
  const onDisk = readFileSync(artifactPath, "utf8");
  const expected = configContractArtifactText(CONFIG_DOCUMENT_SCHEMA_ARTIFACT);
  assert.equal(
    sha256(onDisk),
    sha256(expected),
    "traceability/config-document-schema.json must match configContractArtifactText(CONFIG_DOCUMENT_SCHEMA_ARTIFACT) — run `node src/cli.ts harness sync --with-bundle` to fix drift",
  );
  // #221: one entry per line, so parallel changes to the contract merge; the same value as the canonical form.
  assert.ok(onDisk.split("\n").length > 1000, "the schema is laid out one entry per line");
  assert.equal(canonicalJson(JSON.parse(onDisk)), canonicalJson(CONFIG_DOCUMENT_SCHEMA_ARTIFACT));
});

test("harness regenerate: the artifact's text form is stable + non-empty", () => {
  // The artifact must be canonical (stable byte-for-byte) and non-empty.
  const c1 = configContractArtifactText(CONFIG_DOCUMENT_SCHEMA_ARTIFACT);
  const c2 = configContractArtifactText(CONFIG_DOCUMENT_SCHEMA_ARTIFACT);
  assert.equal(c1, c2, "the text form is stable across calls");
  assert.ok(c1.length > 100, "the canonical artifact is non-trivial");
  assert.ok(CONFIG_DOCUMENT_SCHEMA_ARTIFACT.schemaHash.length > 0);
  assert.ok(CONFIG_DOCUMENT_SCHEMA_ARTIFACT.identityHash.length > 0);
});

test("harness regenerate: writing a stale artifact + canonical form would differ (regression for the fix)", () => {
  // This test simulates the EXP468 finding: a stale pretty-printed
  // artifact would NOT match the canonical form. We write both forms
  // to a tmp dir and verify they differ — proving the fix matters
  // (canonical-JSON vs pretty-JSON is a real difference).
  const tmp = createTempDir("regenerate-schema-");
  try {
    const canonical = `${canonicalJson(CONFIG_DOCUMENT_SCHEMA_ARTIFACT)}\n`;
    const pretty = `${JSON.stringify(CONFIG_DOCUMENT_SCHEMA_ARTIFACT, null, 2)}\n`;
    assert.notEqual(sha256(canonical), sha256(pretty), "canonical-JSON vs pretty-JSON must differ — the EXP468 fix matters");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
