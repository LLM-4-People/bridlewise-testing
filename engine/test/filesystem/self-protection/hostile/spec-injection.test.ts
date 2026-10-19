import assert from "node:assert/strict";
import test from "node:test";

import { InputError } from "../../../../src/kernel/errors.ts";
import { GUARDIAN_SPEC_SCHEMA } from "../../../../src/filesystem/self-protection/self-protection-contracts.ts";
import {
  compileSelfProtectionConfigToSpec,
} from "../../../../src/filesystem/self-protection/guardian-binary.ts";
import {
  DEFAULT_SELF_PROTECTION_CONFIG,
  parseSelfProtectionConfig,
  type SelfProtectionConfig,
} from "../../../../src/filesystem/self-protection/self-protection-config.ts";
import { emptyKeepOutFacts } from "../../../support/keep-out-facts.ts";

const EMPTY_KEEP_OUT = emptyKeepOutFacts();

const HARNESS_ROOT = "/opt/harness";
const PROJECT_ROOT = "/home/user/project";
const NODE_BIN = "/usr/bin/node";

function enabled(overrides: Partial<SelfProtectionConfig> = {}): SelfProtectionConfig {
  return parseSelfProtectionConfig(Object.assign({}, DEFAULT_SELF_PROTECTION_CONFIG, { enabled: true }, overrides) as unknown);
}

test("hostile spec-injection: unknown flag name in handled_access_fs → Zod rejects", () => {
  const bad = {
    abi_version_hint: 0,
    handled_access_fs: ["READ_FILE", "BOGUS"],
    allow_rules: [{ path: "/usr", access: ["READ_FILE"] }],
    protected_subtrees: [],
  };
  assert.throws(() => GUARDIAN_SPEC_SCHEMA.parse(bad));
});

test("hostile spec-injection: unknown flag name in allow-rule access → Zod rejects", () => {
  const bad = {
    abi_version_hint: 0,
    handled_access_fs: ["READ_FILE"],
    allow_rules: [{ path: "/usr", access: ["READ_FILE", "NOT_A_FLAG"] }],
    protected_subtrees: [],
  };
  assert.throws(() => GUARDIAN_SPEC_SCHEMA.parse(bad));
});

test("hostile spec-injection: temp_dir_access without temp_dir → Zod rejects", () => {
  const bad = {
    abi_version_hint: 0,
    handled_access_fs: ["READ_FILE"],
    allow_rules: [{ path: "/usr", access: ["READ_FILE"] }],
    protected_subtrees: [],
    temp_dir_access: ["READ_FILE"],
  };
  assert.throws(() => GUARDIAN_SPEC_SCHEMA.parse(bad));
});

test("hostile spec-injection: unknown top-level key → Zod strictObject rejects", () => {
  const bad = {
    abi_version_hint: 0,
    handled_access_fs: ["READ_FILE"],
    allow_rules: [{ path: "/usr", access: ["READ_FILE"] }],
    protected_subtrees: [],
    evil_injected_key: "pwned",
  };
  assert.throws(() => GUARDIAN_SPEC_SCHEMA.parse(bad));
});

test("hostile spec-injection: allow-rule under the floor-protected src subtree → compiler InputError", () => {
  assert.throws(
    () => compileSelfProtectionConfigToSpec(
      enabled({ additionalAllowRules: [{ path: "/opt/harness/src/cli.ts", access: ["READ_FILE"] }] }),
      HARNESS_ROOT, PROJECT_ROOT, NODE_BIN, EMPTY_KEEP_OUT),
    (error: unknown) => error instanceof InputError && error.code === "self_protection_allow_rule_under_protected_subtree",
  );
});

test("hostile spec-injection: allow-rule under an additional protected subtree → config schema superRefine rejects (Zod)", () => {
  // The config schema's superRefine catches this at parse time (the operator
  // never gets a spec with an allow-rule under their own additional protected
  // subtree). The floor-protected src case is covered by the next test.
  assert.throws(
    () => compileSelfProtectionConfigToSpec(
      enabled({
        additionalProtectedSubtrees: ["/home/user/secret"],
        additionalAllowRules: [{ path: "/home/user/secret/file", access: ["READ_FILE"] }],
      }),
      HARNESS_ROOT, PROJECT_ROOT, NODE_BIN, EMPTY_KEEP_OUT),
  );
});

test("hostile spec-injection: allow-rule under the floor-protected src subtree → compiler InputError (self_protection_allow_rule_under_protected_subtree)", () => {
  assert.throws(
    () => compileSelfProtectionConfigToSpec(
      enabled({ additionalAllowRules: [{ path: "/opt/harness/src/cli.ts", access: ["READ_FILE"] }] }),
      HARNESS_ROOT, PROJECT_ROOT, NODE_BIN, EMPTY_KEEP_OUT),
    (error: unknown) => error instanceof InputError && error.code === "self_protection_allow_rule_under_protected_subtree",
  );
});

test("hostile spec-injection: temp_dir under a protected subtree → compiler InputError", () => {
  assert.throws(
    () => compileSelfProtectionConfigToSpec(
      enabled({ tempDir: "/opt/harness/src/tmp" }),
      HARNESS_ROOT, PROJECT_ROOT, NODE_BIN, EMPTY_KEEP_OUT),
    (error: unknown) => error instanceof InputError && error.code === "self_protection_temp_dir_under_protected_subtree",
  );
});

test("hostile spec-injection: non-absolute allow-rule path in config → config schema rejects", () => {
  assert.throws(
    () => parseSelfProtectionConfig({
      ...DEFAULT_SELF_PROTECTION_CONFIG,
      enabled: true,
      additionalAllowRules: [{ path: "relative/path", access: ["READ_FILE"] }],
    } as unknown),
  );
});

test("hostile spec-injection: empty handled_access_fs → Zod rejects", () => {
  const bad = {
    abi_version_hint: 0,
    handled_access_fs: [],
    allow_rules: [{ path: "/usr", access: ["READ_FILE"] }],
    protected_subtrees: [],
  };
  assert.throws(() => GUARDIAN_SPEC_SCHEMA.parse(bad));
});

test("hostile spec-injection: empty allow-rule access → Zod rejects", () => {
  const bad = {
    abi_version_hint: 0,
    handled_access_fs: ["READ_FILE"],
    allow_rules: [{ path: "/usr", access: [] }],
    protected_subtrees: [],
  };
  assert.throws(() => GUARDIAN_SPEC_SCHEMA.parse(bad));
});
