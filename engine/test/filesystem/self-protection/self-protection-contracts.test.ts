import assert from "node:assert/strict";
import test from "node:test";

import {
  GUARDIAN_SPEC_SCHEMA,
  GUARDIAN_SPEC_SCHEMA_VERSION,
  GUARDIAN_SPEC_SCHEMA_HASH,
  LANDLOCK_ACCESS_FS_FLAG_NAMES,
  LANDLOCK_FLAG_METADATA,
  FILE_LEVEL_FLAGS,
  DIR_ONLY_FLAGS,
  DEFAULT_TEMP_DIR_ACCESS,
  PROJECT_ROOT_ACCESS_FLAGS,
  GUARDIAN_BINARY_ERROR_CODES,
  isGuardianPreExecFailure,
  isFileLevelFlag,
  flagValidForRuleKind,
  maskFlagNamesToAbi,
  type LandlockAccessFsFlagName,
} from "../../../src/filesystem/self-protection/self-protection-contracts.ts";

const VALID_SPEC = {
  abi_version_hint: 0,
  handled_access_fs: ["READ_FILE", "READ_DIR", "EXECUTE"],
  allow_rules: [{ path: "/usr", access: ["EXECUTE", "READ_FILE", "READ_DIR"] }],
  protected_subtrees: ["/home/user/project/src"],
  default_deny_outside_allow_rules: true,
  temp_dir: "/tmp",
  temp_dir_access: ["READ_FILE", "READ_DIR", "WRITE_FILE"],
};

test("self-protection-contracts: 16 flag names match the C binary table exactly", () => {
  assert.deepEqual([...LANDLOCK_ACCESS_FS_FLAG_NAMES], [
    "EXECUTE", "WRITE_FILE", "READ_FILE", "READ_DIR",
    "REMOVE_DIR", "REMOVE_FILE", "MAKE_CHAR", "MAKE_DIR",
    "MAKE_REG", "MAKE_SOCK", "MAKE_FIFO", "MAKE_BLOCK",
    "MAKE_SYM", "REFER", "TRUNCATE", "IOCTL_DEV",
  ]);
  assert.equal(LANDLOCK_ACCESS_FS_FLAG_NAMES.length, 16);
});

test("self-protection-contracts: per-flag ABI + appliesTo match the C binary table", () => {
  const expected: Record<string, { minAbi: number; appliesTo: "any" | "dir-only" }> = {
    EXECUTE: { minAbi: 1, appliesTo: "any" },
    WRITE_FILE: { minAbi: 1, appliesTo: "any" },
    READ_FILE: { minAbi: 1, appliesTo: "any" },
    READ_DIR: { minAbi: 1, appliesTo: "dir-only" },
    REMOVE_DIR: { minAbi: 1, appliesTo: "dir-only" },
    REMOVE_FILE: { minAbi: 1, appliesTo: "dir-only" },
    MAKE_CHAR: { minAbi: 1, appliesTo: "dir-only" },
    MAKE_DIR: { minAbi: 1, appliesTo: "dir-only" },
    MAKE_REG: { minAbi: 1, appliesTo: "dir-only" },
    MAKE_SOCK: { minAbi: 1, appliesTo: "dir-only" },
    MAKE_FIFO: { minAbi: 1, appliesTo: "dir-only" },
    MAKE_BLOCK: { minAbi: 1, appliesTo: "dir-only" },
    MAKE_SYM: { minAbi: 1, appliesTo: "dir-only" },
    REFER: { minAbi: 2, appliesTo: "dir-only" },
    TRUNCATE: { minAbi: 3, appliesTo: "any" },
    IOCTL_DEV: { minAbi: 5, appliesTo: "dir-only" },
  };
  for (const name of LANDLOCK_ACCESS_FS_FLAG_NAMES) {
    assert.equal(LANDLOCK_FLAG_METADATA[name].minAbi, expected[name]!.minAbi, `minAbi for ${name}`);
    assert.equal(LANDLOCK_FLAG_METADATA[name].appliesTo, expected[name]!.appliesTo, `appliesTo for ${name}`);
  }
});

test("self-protection-contracts: file-level vs dir-only flags partition correctly", () => {
  assert.deepEqual([...FILE_LEVEL_FLAGS], ["EXECUTE", "WRITE_FILE", "READ_FILE", "TRUNCATE"]);
  assert.deepEqual([...DIR_ONLY_FLAGS], [
    "READ_DIR", "REMOVE_DIR", "REMOVE_FILE", "MAKE_CHAR", "MAKE_DIR",
    "MAKE_REG", "MAKE_SOCK", "MAKE_FIFO", "MAKE_BLOCK", "MAKE_SYM", "REFER", "IOCTL_DEV",
  ]);
  for (const name of FILE_LEVEL_FLAGS) assert.equal(isFileLevelFlag(name), true);
  for (const name of DIR_ONLY_FLAGS) assert.equal(isFileLevelFlag(name), false);
  for (const name of LANDLOCK_ACCESS_FS_FLAG_NAMES) {
    assert.equal(flagValidForRuleKind(name, "directory"), true);
    assert.equal(flagValidForRuleKind(name, "file"), isFileLevelFlag(name));
  }
});

test("self-protection-contracts: valid spec parses", () => {
  const parsed = GUARDIAN_SPEC_SCHEMA.parse(VALID_SPEC);
  assert.equal(parsed.default_deny_outside_allow_rules, true);
  assert.equal(parsed.temp_dir, "/tmp");
});

test("self-protection-contracts: schema rejects unknown flag name in handled_access_fs", () => {
  const bad = { ...VALID_SPEC, handled_access_fs: ["READ_FILE", "BOGUS_FLAG"] };
  assert.throws(() => GUARDIAN_SPEC_SCHEMA.parse(bad));
});

test("self-protection-contracts: schema rejects unknown top-level key (strictObject)", () => {
  const bad = { ...VALID_SPEC, unknownKey: 1 };
  assert.throws(() => GUARDIAN_SPEC_SCHEMA.parse(bad));
});

test("self-protection-contracts: schema rejects empty handled_access_fs", () => {
  const bad = { ...VALID_SPEC, handled_access_fs: [] };
  assert.throws(() => GUARDIAN_SPEC_SCHEMA.parse(bad));
});

test("self-protection-contracts: schema rejects empty allow_rules", () => {
  const bad = { ...VALID_SPEC, allow_rules: [] };
  assert.throws(() => GUARDIAN_SPEC_SCHEMA.parse(bad));
});

test("self-protection-contracts: schema rejects temp_dir_access without temp_dir", () => {
  const { temp_dir: _drop, ...noTempDir } = VALID_SPEC;
  void _drop;
  const bad = { ...noTempDir, temp_dir_access: ["READ_FILE"] };
  assert.throws(() => GUARDIAN_SPEC_SCHEMA.parse(bad));
});

test("self-protection-contracts: schema rejects negative abi_version_hint", () => {
  const bad = { ...VALID_SPEC, abi_version_hint: -1 };
  assert.throws(() => GUARDIAN_SPEC_SCHEMA.parse(bad));
});

test("self-protection-contracts: error codes table is complete and typed", () => {
  assert.deepEqual(new Set(Object.keys(GUARDIAN_BINARY_ERROR_CODES)), new Set(["2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "64"]));
  for (const code of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 64] as const) {
    assert.equal(isGuardianPreExecFailure(code), true, `${code} should be a pre-exec failure`);
  }
  assert.equal(isGuardianPreExecFailure(0), false);
  assert.equal(isGuardianPreExecFailure(1), false);
  assert.equal(isGuardianPreExecFailure(100), false);
});

test("self-protection-contracts: network modes are explicit IP-family permission or refusal; absence stays ungoverned", () => {
  assert.equal(GUARDIAN_SPEC_SCHEMA.parse(VALID_SPEC).network, undefined);
  for (const network of ["refused", "ip-family"] as const) {
    assert.equal(GUARDIAN_SPEC_SCHEMA.parse({ ...VALID_SPEC, network }).network, network);
  }
  for (const network of ["open", "loopback", "", "refused\u0000junk", "ip-family\u0000junk", 1, true, null, {}]) {
    assert.throws(() => GUARDIAN_SPEC_SCHEMA.parse({ ...VALID_SPEC, network }), `invalid network mode: ${JSON.stringify(network)}`);
  }
  assert.throws(() => GUARDIAN_SPEC_SCHEMA.parse({ ...VALID_SPEC, ["network\u0000junk"]: "ip-family" }));
});

test("self-protection-contracts: all path fields share the native parser's NUL-free string representation", () => {
  const pathSpecs = (path: string) => [
    { site: "allow_rules.path", spec: { ...VALID_SPEC, allow_rules: [{ ...VALID_SPEC.allow_rules[0], path }] } },
    { site: "protected_subtrees", spec: { ...VALID_SPEC, protected_subtrees: [path] } },
    { site: "keep_out", spec: { ...VALID_SPEC, keep_out: [path], keep_out_retries: 0 } },
    { site: "temp_dir", spec: { ...VALID_SPEC, temp_dir: path } },
  ];
  for (const { site, spec } of pathSpecs("/fixture\u0000suffix")) {
    assert.throws(() => GUARDIAN_SPEC_SCHEMA.parse(spec), /cannot contain NUL/u, site);
  }
  for (const path of ["/fixture\\u0000suffix", "/fixture\nline"]) {
    for (const { site, spec } of pathSpecs(path)) {
      assert.doesNotThrow(() => GUARDIAN_SPEC_SCHEMA.parse(spec), site);
    }
  }
});

test("self-protection-contracts: CPU and signal limits are typed spec fields; there is no memory field", () => {
  assert.equal(GUARDIAN_SPEC_SCHEMA.parse({ ...VALID_SPEC, cpu_seconds: 30 }).cpu_seconds, 30);
  assert.throws(() => GUARDIAN_SPEC_SCHEMA.parse({ ...VALID_SPEC, cpu_seconds: 0 }));
  assert.throws(() => GUARDIAN_SPEC_SCHEMA.parse({ ...VALID_SPEC, cpu_seconds: 86_401 }));
  assert.equal(GUARDIAN_BINARY_ERROR_CODES[11], "network_refusal_failed");
  assert.equal(GUARDIAN_BINARY_ERROR_CODES[12], "cpu_limit_failed");
  assert.equal(GUARDIAN_SPEC_SCHEMA.parse({ ...VALID_SPEC, signals: "refused" }).signals, "refused");
  assert.throws(() => GUARDIAN_SPEC_SCHEMA.parse({ ...VALID_SPEC, memory_bytes: 1_610_612_736 }), "no address-space ceiling of the guardian's own: memory is the admitted run's cgroup cap");
  assert.throws(() => GUARDIAN_SPEC_SCHEMA.parse({ ...VALID_SPEC, signals: "scoped" }));
});

test("self-protection-contracts: maskFlagNamesToAbi drops flags above the ABI", () => {
  const all = [...LANDLOCK_ACCESS_FS_FLAG_NAMES];
  assert.deepEqual([...maskFlagNamesToAbi(all, 1)], [
    "EXECUTE", "WRITE_FILE", "READ_FILE", "READ_DIR",
    "REMOVE_DIR", "REMOVE_FILE", "MAKE_CHAR", "MAKE_DIR",
    "MAKE_REG", "MAKE_SOCK", "MAKE_FIFO", "MAKE_BLOCK", "MAKE_SYM",
  ]);
  assert.deepEqual([...maskFlagNamesToAbi(["IOCTL_DEV"], 3)], []);
  assert.deepEqual([...maskFlagNamesToAbi(["IOCTL_DEV"], 5)], ["IOCTL_DEV"]);
  assert.deepEqual([...maskFlagNamesToAbi(["TRUNCATE"], 3)], ["TRUNCATE"]);
  assert.deepEqual([...maskFlagNamesToAbi(["REFER"], 1)], []);
});

test("self-protection-contracts: PROJECT_ROOT + DEFAULT_TEMP_DIR access sets are subsets of the 16 flags", () => {
  const flagset = new Set<LandlockAccessFsFlagName>(LANDLOCK_ACCESS_FS_FLAG_NAMES);
  for (const f of PROJECT_ROOT_ACCESS_FLAGS) assert.equal(flagset.has(f), true);
  for (const f of DEFAULT_TEMP_DIR_ACCESS) assert.equal(flagset.has(f), true);
});

test("self-protection-contracts: schema version + hash are stable strings", () => {
  assert.equal(GUARDIAN_SPEC_SCHEMA_VERSION, "bridlewise-self-protection-spec/v1");
  assert.match(GUARDIAN_SPEC_SCHEMA_HASH, /^[0-9a-f]{64}$/);
});
