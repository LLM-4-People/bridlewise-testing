import assert from "node:assert/strict";
import test from "node:test";

import { ROOT_POLICY } from "../../../../src/kernel/root-policy.ts";
import { InputError } from "../../../../src/kernel/errors.ts";
import { compileSelfProtectionConfigToSpec } from "../../../../src/filesystem/self-protection/guardian-binary.ts";
import {
  SELF_PROTECTION_CONFIG_SCHEMA,
  parseSelfProtectionConfig,
  resolveSelfProtectionConfig,
  selfProtectionConfigViolations,
  type SelfProtectionConfig,
} from "../../../../src/filesystem/self-protection/self-protection-config.ts";
import { emptyKeepOutFacts } from "../../../support/keep-out-facts.ts";

const EMPTY_KEEP_OUT = emptyKeepOutFacts();

/**
 * Config-tampering hostile tests. The operator config is additive-only: the
 * floor (`minimumProtectedSubtrees`, `minimumAllowSet`, `handledAccessFs`,
 * `blockRead`, `blockWrite`, `mayNotBeDisabled`, `binaryStamp`) lives in
 * `ROOT_POLICY.selfProtection` and MUST NOT appear in the config document. The
 * `strictObject` schema rejects any floor field in the config; the root-policy
 * floor is non-overridable (deepFrozen).
 */

test("hostile config-tampering: root-policy floor is non-overridable (deepFrozen)", () => {
  assert.deepEqual([...ROOT_POLICY.selfProtection.minimumProtectedSubtrees], ["src"]);
  assert.equal(ROOT_POLICY.selfProtection.mayNotBeDisabled, true);
  assert.equal(ROOT_POLICY.selfProtection.blockRead, true);
  assert.equal(ROOT_POLICY.selfProtection.blockWrite, true);
  // The pin itself is GENERATED (`harness sync` recomputes it from the sealed
  // guardian sources); a literal copy here was a second, hand-edited owner.
  assert.match(ROOT_POLICY.selfProtection.binaryStamp, /^[0-9a-f]{64}$/u);
  // The operator cannot remove 'src' from minimumProtectedSubtrees — it is not
  // a config field at all.
  assert.throws(
    () => parseSelfProtectionConfig({
      schemaVersion: "bridlewise-self-protection-config/v1",
      enabled: true,
      minimumProtectedSubtrees: [],  // floor field — must be rejected
    } as unknown),
  );
});

test("hostile config-tampering: operator cannot set blockRead/blockWrite in config (floor-only fields)", () => {
  assert.throws(
    () => parseSelfProtectionConfig({
      schemaVersion: "bridlewise-self-protection-config/v1",
      enabled: true,
      blockRead: false,  // floor field — must be rejected
    } as unknown),
  );
  assert.throws(
    () => parseSelfProtectionConfig({
      schemaVersion: "bridlewise-self-protection-config/v1",
      enabled: true,
      blockWrite: false,  // floor field — must be rejected
    } as unknown),
  );
});

test("hostile config-tampering: operator cannot set binaryStamp in config (floor-only field)", () => {
  assert.throws(
    () => parseSelfProtectionConfig({
      schemaVersion: "bridlewise-self-protection-config/v1",
      enabled: true,
      binaryStamp: "0000000000000000000000000000000000000000000000000000000000000000",
    } as unknown),
  );
});

test("hostile config-tampering: operator cannot set mayNotBeDisabled in config (floor-only field)", () => {
  assert.throws(
    () => parseSelfProtectionConfig({
      schemaVersion: "bridlewise-self-protection-config/v1",
      enabled: true,
      mayNotBeDisabled: false,
    } as unknown),
  );
});

test("hostile config-tampering: operator additionalAllowRule with relative path rejected", () => {
  assert.throws(
    () => parseSelfProtectionConfig({
      schemaVersion: "bridlewise-self-protection-config/v1",
      enabled: true,
      additionalAllowRules: [{ path: "relative/path", access: ["READ_FILE"] }],
    } as unknown),
  );
});

test("hostile config-tampering: operator additionalProtectedSubtree with relative path rejected", () => {
  assert.throws(
    () => parseSelfProtectionConfig({
      schemaVersion: "bridlewise-self-protection-config/v1",
      enabled: true,
      additionalProtectedSubtrees: ["relative/secret"],
    } as unknown),
  );
});

test("hostile config-tampering: operator additionalProtectedSubtree overlapping an additionalAllowRule → the compiler refuses it by identity", () => {
  // Parsing accepts the shape; the ONE overlap decision is the compiler's
  // keep-out verdict (a schema-level spelling check was a second, weaker copy).
  const config = parseSelfProtectionConfig({
    schemaVersion: "bridlewise-self-protection-config/v1",
    enabled: true,
    tempDir: "/home/user/tmp",
    additionalProtectedSubtrees: ["/home/user/secret"],
    additionalAllowRules: [{ path: "/home/user/secret/file", access: ["READ_FILE"] }],
  } as unknown);
  assert.throws(
    () => compileSelfProtectionConfigToSpec(config, "/opt/harness", "/home/user/project", "/usr/bin/node", EMPTY_KEEP_OUT),
    (error: unknown) => error instanceof InputError && error.code === "self_protection_rule_overlaps_refused_path",
  );
});

test("hostile config-tampering: disabled config has no violations (the floor is still enforced at runtime)", () => {
  const disabled: SelfProtectionConfig = parseSelfProtectionConfig({
    schemaVersion: "bridlewise-self-protection-config/v1",
    enabled: false,
  });
  assert.deepEqual([...selfProtectionConfigViolations(disabled)], []);
});

test("hostile config-tampering: an absent section resolves to CONFINED — only a written enabled:false turns it off", () => {
  const resolved = resolveSelfProtectionConfig({});
  assert.equal(resolved.enabled, true);
  assert.equal(resolveSelfProtectionConfig({ selfProtection: { schemaVersion: "bridlewise-self-protection-config/v1", enabled: false } }).enabled, false);
  assert.equal(resolved.schemaVersion, "bridlewise-self-protection-config/v1");
});

test("hostile config-tampering: unknown key in config document rejected by strictObject", () => {
  assert.throws(
    () => SELF_PROTECTION_CONFIG_SCHEMA.parse({
      schemaVersion: "bridlewise-self-protection-config/v1",
      enabled: true,
      evilKey: 1,
    } as unknown),
  );
});
