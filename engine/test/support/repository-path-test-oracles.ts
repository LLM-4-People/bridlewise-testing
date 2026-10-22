import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  assertGeneratedCaseFoldingModule,
  deriveCaseFoldingAuthority,
  deriveRepositoryPathUnicodeFoundation,
  parsePathPolicySourceManifest,
  parseUnicodePathSourceManifest,
  runRepositoryPathUnicodeGenerator,
  type UnicodePathSourceManifest,
} from "../../scripts/generation/repository-path-unicode.ts";
import { getConfigDocumentSchema } from "../../src/kernel/config-contracts.ts";
import { HarnessError } from "../../src/kernel/errors.ts";
import { sha256 } from "../../src/kernel/integrity.ts";
import { readNodeRuntimeCapabilities } from "../../src/runtime/runtime-capabilities.ts";
import {
  REPOSITORY_PATH_GIT_SYMLINK_ALIAS_POLICY,
  REPOSITORY_PATH_PROFILE,
  REPOSITORY_PATH_QUALIFIED_LIMIT_CEILINGS,
  REPOSITORY_PATH_RUNTIME_AUTHORITY_ERROR_CODE,
  REPOSITORY_PATH_SETTINGS_SCHEMA_VERSION,
  type RepositoryPathContext,
} from "../../src/repository-path/contracts.ts";
import {
  createRepositoryPathInspector,
  inspectRepositoryPath,
  inspectRepositoryPathSet,
  portableRepositoryPathKey,
  requireRepositoryPath,
  requireRepositoryPathSet,
  type RepositoryPathLimits,
  type ValidRepositoryPath,
} from "../../src/repository-path/index.ts";
import * as repositoryPathLogical from "../../src/repository-path/logical.ts";
import {
  UNICODE_CASE_FOLDING_ENTRY_COUNT,
  UNICODE_CASE_FOLDING_SOURCE_SHA256,
  UNICODE_CASE_FOLDING_TABLE,
  UNICODE_CASE_FOLDING_TABLE_BYTE_LENGTH,
  UNICODE_CASE_FOLDING_TABLE_JSON,
  UNICODE_CASE_FOLDING_TABLE_SHA256,
} from "../../src/repository-path/unicode-case-fold.generated.ts";
import {
  REPOSITORY_PATH_OFFICIAL_CORPUS_EXPECTATIONS,
  type RepositoryPathTestId,
} from "./repository-path-test-catalog.ts";
import { requirePathPolicySources } from "../../scripts/verification/path-policy-sources.ts";

const CONFIG_DOCUMENT_SCHEMA = getConfigDocumentSchema();

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SOURCE_ROOT = `${ROOT}traceability/sources/path-policy/unicode-17.0.0/`;
const PATH_POLICY_MANIFEST_PATH = `${ROOT}traceability/sources/path-policy/manifest.json`;
const CASE_FOLDING_PATH = `${SOURCE_ROOT}CaseFolding.txt`;
const NORMALIZATION_PATH = `${SOURCE_ROOT}NormalizationTest.txt`;
const MANIFEST_PATH = `${SOURCE_ROOT}manifest.json`;
const GENERATED_PATH = `${ROOT}src/repository-path/unicode-case-fold.generated.ts`;
const CONFIG_PATH = `${ROOT}bridlewise.config.json`;
const GENERATOR_PATH = `${ROOT}scripts/generation/repository-path-unicode.ts`;
const CASE_FOLDING_TEXT = readFileSync(CASE_FOLDING_PATH, "utf8");
const NORMALIZATION_TEXT = readFileSync(NORMALIZATION_PATH, "utf8");
const MANIFEST_TEXT = readFileSync(MANIFEST_PATH, "utf8");
const PATH_POLICY_MANIFEST_TEXT = readFileSync(PATH_POLICY_MANIFEST_PATH, "utf8");
const MANIFEST = parseUnicodePathSourceManifest(MANIFEST_TEXT);
const PATH_POLICY_MANIFEST = parsePathPolicySourceManifest(PATH_POLICY_MANIFEST_TEXT);
const GIT_SOURCE_AUTHORITY = PATH_POLICY_MANIFEST.sourceSets.git;
const GIT_PATH_SOURCE = GIT_SOURCE_AUTHORITY.sources.find((source) => source.upstreamPath === "path.c")!;
const GIT_TEST_SOURCE = GIT_SOURCE_AUTHORITY.sources.find((source) =>
  source.upstreamPath === "t/t0060-path-utils.sh"
)!;
// The Git sources are not published here: a checkout without them refuses by name, with the fetch that provides them.
requirePathPolicySources(ROOT);
const GIT_PATH_TEXT = readFileSync(`${ROOT}${GIT_PATH_SOURCE.path}`, "utf8");
const GIT_TEST_TEXT = readFileSync(`${ROOT}${GIT_TEST_SOURCE.path}`, "utf8");
const CONFIG = CONFIG_DOCUMENT_SCHEMA.parse(JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as unknown);
const LIMITS: RepositoryPathLimits = CONFIG.repositoryPaths.limits;
const LIMITS_INSPECTOR = createRepositoryPathInspector(LIMITS);

const FAMILY_ORACLES = new Map<RepositoryPathTestId, () => void>();

function family(id: RepositoryPathTestId, body: () => void): void {
  if (FAMILY_ORACLES.has(id)) throw new Error(`Duplicate repository path oracle: ${id}`);
  FAMILY_ORACLES.set(id, body);
}

family("RPA-U001", () => {
  assert.equal(readNodeRuntimeCapabilities().unicodeVersion, "17.0");
  assert.equal(sha256(CASE_FOLDING_TEXT), UNICODE_CASE_FOLDING_SOURCE_SHA256);
  assert.equal(sha256(NORMALIZATION_TEXT),
    "5019ffd530751a741900c849c0e010332f142a3612234639bd200b82138a87db");
  assert.equal(Buffer.byteLength(CASE_FOLDING_TEXT, "utf8"), 87_539);
  assert.equal(Buffer.byteLength(NORMALIZATION_TEXT, "utf8"), 2_827_429);
  assert.equal(Buffer.byteLength(UNICODE_CASE_FOLDING_TABLE_JSON, "utf8"), 23_346);
  assert.equal(sha256(UNICODE_CASE_FOLDING_TABLE_JSON), UNICODE_CASE_FOLDING_TABLE_SHA256);
  assert.equal(UNICODE_CASE_FOLDING_TABLE_BYTE_LENGTH, 23_346);
  assert.equal(UNICODE_CASE_FOLDING_ENTRY_COUNT,
    REPOSITORY_PATH_OFFICIAL_CORPUS_EXPECTATIONS.caseFoldingEntries);
  const derived = deriveRepositoryPathUnicodeFoundation(ROOT);
  assert.equal(derived.generatedSource, readFileSync(GENERATED_PATH, "utf8"));
  assert.equal(derived.report.disposition, "foundation-derived-not-admitted-or-qualified");
});

family("RPA-U002", () => {
  const official = independentCaseFoldingMap(CASE_FOLDING_TEXT);
  const generated = new Map(UNICODE_CASE_FOLDING_TABLE);
  let independentlyAssertedEntries = 0;
  let runtimeReachableEntries = 0;
  for (const [source, mapping] of official) {
    assert.deepEqual(generated.get(source), mapping, `generated mapping U+${source.toString(16)}`);
    const input = String.fromCodePoint(source);
    const candidate = `q-${input}`;
    const decision = inspectRepositoryPath(candidate, LIMITS);
    if (decision.ok) {
      assert.equal(
        portableRepositoryPathKey(decision.path),
        independentPortabilityKey(candidate, official),
        `production Q key U+${source.toString(16)}`,
      );
      runtimeReachableEntries += 1;
    }
    independentlyAssertedEntries += 1;
  }
  assert.equal(independentlyAssertedEntries, REPOSITORY_PATH_OFFICIAL_CORPUS_EXPECTATIONS.caseFoldingEntries);
  assert.equal(official.size, REPOSITORY_PATH_OFFICIAL_CORPUS_EXPECTATIONS.caseFoldingEntries);
  assert.equal(generated.size, REPOSITORY_PATH_OFFICIAL_CORPUS_EXPECTATIONS.caseFoldingEntries);
  assert.ok(runtimeReachableEntries > 0);
});

family("RPA-U003", () => {
  let rows = 0;
  let assertions = 0;
  for (const line of NORMALIZATION_TEXT.split("\n")) {
    const data = line.split("#", 1)[0]!.trim();
    if (!data || data.startsWith("@")) continue;
    const fields = data.split(";").slice(0, 5).map(decodeCodePointField);
    assert.equal(fields.length, 5);
    const [c1, c2, c3, c4, c5] = fields as [string, string, string, string, string];
    for (const [actual, expected] of [
      [c1.normalize("NFC"), c2],
      [c2.normalize("NFC"), c2],
      [c3.normalize("NFC"), c2],
      [c4.normalize("NFC"), c4],
      [c5.normalize("NFC"), c4],
    ] as const) {
      assert.equal(actual, expected, `normalization row ${rows + 1} assertion ${assertions + 1}`);
      assertions += 1;
    }
    rows += 1;
  }
  assert.equal(rows, REPOSITORY_PATH_OFFICIAL_CORPUS_EXPECTATIONS.normalizationRows);
  assert.equal(assertions, REPOSITORY_PATH_OFFICIAL_CORPUS_EXPECTATIONS.normalizationAssertions);
});

family("RPA-U004", () => {
  const baseline = deriveCaseFoldingAuthority(CASE_FOLDING_TEXT, MANIFEST);
  assertGeneratedCaseFoldingModule(readFileSync(GENERATED_PATH, "utf8"), baseline.moduleSource);

  const changedC = CASE_FOLDING_TEXT.replace("0041; C; 0061;", "0041; C; 007A;");
  const changedF = CASE_FOLDING_TEXT.replace("00DF; F; 0073 0073;", "00DF; F; 0073 0074;");
  for (const source of [changedC, changedF]) {
    assert.throws(() => deriveCaseFoldingAuthority(source, MANIFEST), hasCode(
      "repository_path_unicode_source_identity_invalid",
    ));
    const coMutatedManifest = manifestForCaseFoldingSource(source);
    const changed = deriveCaseFoldingAuthority(source, coMutatedManifest);
    assert.notEqual(changed.tableSha256, baseline.tableSha256);
    assert.notEqual(changed.moduleSource, baseline.moduleSource);
  }

  const firstCLine = CASE_FOLDING_TEXT.split("\n").find((line) => /; C; /u.test(line))!;
  const deleted = CASE_FOLDING_TEXT.replace(`${firstCLine}\n`, "");
  const duplicated = `${CASE_FOLDING_TEXT}${firstCLine}\n`;
  const selectedS = replaceFirstStatus(CASE_FOLDING_TEXT, "S", "C");
  const selectedT = replaceFirstStatus(CASE_FOLDING_TEXT, "T", "F");
  for (const source of [deleted, duplicated, selectedS, selectedT]) {
    assert.throws(() => deriveCaseFoldingAuthority(source, manifestForCaseFoldingSource(source)));
  }
  const wrongHeader = CASE_FOLDING_TEXT.replace("# CaseFolding-17.0.0.txt", "# CaseFolding-18.0.0.txt");
  assert.throws(
    () => deriveCaseFoldingAuthority(wrongHeader, manifestForCaseFoldingSource(wrongHeader)),
    hasCode("repository_path_case_folding_header_invalid"),
  );
  assert.throws(
    () => assertGeneratedCaseFoldingModule(`${baseline.moduleSource} `, baseline.moduleSource),
    hasCode("repository_path_generated_table_stale"),
  );
  const duplicateManifestKey = MANIFEST_TEXT.replace(
    '  "unicodeVersion": "17.0.0",',
    '  "unicodeVersion": "17.0.0",\n  "unicodeVersion": "17.0.0",',
  );
  assert.throws(() => parseUnicodePathSourceManifest(duplicateManifestKey));
});

family("RPA-G001", () => {
  assert.deepEqual(GIT_SOURCE_AUTHORITY.upstream, {
    repository: "https://github.com/git/git",
    version: "2.55.0",
    tag: "v2.55.0",
    commit: "e9019fcafe0040228b8631c30f97ae1adb61bcdc",
  });
  for (const source of [GIT_SOURCE_AUTHORITY.license, ...GIT_SOURCE_AUTHORITY.sources]) {
    const bytes = readFileSync(`${ROOT}${source.path}`);
    assert.equal(bytes.byteLength, source.byteLength, source.path);
    assert.equal(sha256(bytes), source.sha256, source.path);
  }
  assert.equal(GIT_SOURCE_AUTHORITY.license.spdx, "GPL-2.0-only");
  assert.match(GIT_PATH_TEXT, /static int is_ntfs_dot_generic\(/u);
  assert.match(GIT_PATH_TEXT, /for \(i = 0, saw_tilde = 0; i < 8; i\+\+\)/u);
  assert.match(GIT_TEST_TEXT, /GI7EB~10/u);
  assert.match(GIT_TEST_TEXT, /~9999999/u);
  assert.match(GIT_TEST_TEXT, /GI7EBA~0/u);

  const duplicateKey = PATH_POLICY_MANIFEST_TEXT.replace(
    '  "schemaVersion": "bridlewise-path-policy-sources/v1",',
    '  "schemaVersion": "bridlewise-path-policy-sources/v1",\n' +
      '  "schemaVersion": "bridlewise-path-policy-sources/v1",',
  );
  assert.throws(() => parsePathPolicySourceManifest(duplicateKey));
  const inconsistent = structuredClone(PATH_POLICY_MANIFEST) as unknown as MutablePathPolicyManifest;
  inconsistent.sourceSets.git.upstream.tag = "v2.55.1";
  assert.throws(() => parsePathPolicySourceManifest(JSON.stringify(inconsistent)));

  const derived = deriveRepositoryPathUnicodeFoundation(ROOT);
  const sourceAuthority = derived.report.sourceAuthority as Readonly<{
    git: Readonly<{ tag: string; commit: string }>;
  }>;
  assert.equal(sourceAuthority.git.tag, GIT_SOURCE_AUTHORITY.upstream.tag);
  assert.equal(sourceAuthority.git.commit, GIT_SOURCE_AUTHORITY.upstream.commit);
});

family("RPA-G002", () => {
  const upstreamDefinitions = [...GIT_PATH_TEXT.matchAll(
    /return is_ntfs_dot_str\(name, "([a-z]+)", "([a-z0-9]+)"\);/gu,
  )].map((match) => ({ longName: `.${match[1]!}`, fallbackShortPrefix: match[2]! }));
  assert.deepEqual(
    [...REPOSITORY_PATH_GIT_SYMLINK_ALIAS_POLICY.gitExact.metadataNames]
      .map((entry) => ({ ...entry })).toSorted((left, right) => left.longName.localeCompare(right.longName)),
    upstreamDefinitions.toSorted((left, right) => left.longName.localeCompare(right.longName)),
  );

  const exactRegular = REPOSITORY_PATH_GIT_SYMLINK_ALIAS_POLICY.gitExact.regularShortName;
  const strictRegular = REPOSITORY_PATH_GIT_SYMLINK_ALIAS_POLICY.harnessStrictAdditional.regularShortName;
  const fallback = REPOSITORY_PATH_GIT_SYMLINK_ALIAS_POLICY.gitExact.fallbackShortName;
  assert.deepEqual(exactRegular, { prefixLength: 6, minimumSequence: 1, maximumSequence: 4 });
  assert.deepEqual(strictRegular, { minimumSequence: 5, maximumSequence: 9 });
  assert.deepEqual(fallback, {
    totalLength: 8,
    maximumPrefixLength: 6,
    minimumSequence: 1,
    maximumSequence: 9_999_999,
  });

  for (const metadata of REPOSITORY_PATH_GIT_SYMLINK_ALIAS_POLICY.gitExact.metadataNames) {
    const regularPrefix = metadata.longName.slice(1, exactRegular.prefixLength + 1);
    for (const value of [metadata.longName, `${metadata.longName}.`, `${metadata.longName} :$DATA`]) {
      assertGitSymlinkAlias(value);
      assertGitSymlinkAlias(value.toUpperCase());
    }
    assert.equal(inspectRepositoryPath(metadata.longName, LIMITS, { entryKind: "file" }).ok, true);

    for (let sequence = exactRegular.minimumSequence;
      sequence <= exactRegular.maximumSequence; sequence += 1) {
      const alias = `${regularPrefix}~${sequence}`;
      assertGitSymlinkAlias(alias);
      assertGitSymlinkAlias(alias.toUpperCase());
      assert.equal(inspectRepositoryPath(alias, LIMITS, { entryKind: "file" }).ok, true);
    }
    for (let sequence = strictRegular.minimumSequence;
      sequence <= strictRegular.maximumSequence; sequence += 1) {
      const alias = `${regularPrefix}~${sequence}`;
      assertGitSymlinkAlias(alias);
      assert.equal(inspectRepositoryPath(alias, LIMITS, { entryKind: "file" }).ok, true);
    }

    for (let width = 1; width <= 7; width += 1) {
      const minimum = width === 1 ? 1 : 10 ** (width - 1);
      const maximum = 10 ** width - 1;
      const candidates = new Set([minimum, minimum + 1, Math.floor((minimum + maximum) / 2), maximum - 1, maximum]);
      for (const sequence of candidates) {
        const alias = gitFallbackAlias(metadata.fallbackShortPrefix, sequence, fallback.totalLength);
        assert.equal(alias.length, fallback.totalLength);
        assertGitSymlinkAlias(alias);
        assertGitSymlinkAlias(alias.toUpperCase());
        assertGitSymlinkAlias(`${alias}.`);
        assertGitSymlinkAlias(`${alias} :$DATA`);
        assert.equal(inspectRepositoryPath(alias, LIMITS, { entryKind: "file" }).ok, true);
        if (!alias.startsWith("~")) {
          assertNoGitSymlinkAlias(`x${alias.slice(1)}`);
        }
      }
    }

    for (const value of [
      `${metadata.fallbackShortPrefix}~0`,
      `${metadata.fallbackShortPrefix}~10`,
      `${metadata.fallbackShortPrefix.slice(0, 4)}~10`,
      `.${metadata.fallbackShortPrefix}~1`,
      `${metadata.fallbackShortPrefix}~~1`,
      `${metadata.fallbackShortPrefix.slice(0, 5)}~01`,
      `${metadata.fallbackShortPrefix.slice(0, 5)}~1X`,
    ]) assertNoGitSymlinkAlias(value);
  }
  assertNoGitSymlinkAlias("~0000001");
  assertNoGitSymlinkAlias("~10000000");
  assertNoGitSymlinkAlias(".gitmoduleſ");
  assertNoGitSymlinkAlias("gitmodſ~1");
});

family("RPA-L001", () => {
  const cases: readonly Readonly<{ value: unknown; code: string }>[] = [
    { value: 1, code: "repository_path_type_invalid" },
    { value: "", code: "repository_path_empty" },
    { value: "/absolute", code: "repository_path_absolute" },
    { value: "C:/absolute", code: "repository_path_absolute" },
    { value: "a\\b", code: "repository_path_backslash" },
    { value: "a//b", code: "repository_path_empty_segment" },
    { value: "a/./b", code: "repository_path_dot_segment" },
    { value: "a/../b", code: "repository_path_dot_segment" },
    { value: "bad\ud800path", code: "repository_path_lone_surrogate" },
    { value: "Cafe\u0301.ts", code: "repository_path_non_nfc" },
    { value: "control-\u0001", code: "repository_path_forbidden_code_point" },
    { value: "format-\u200d", code: "repository_path_forbidden_code_point" },
    { value: "separator-\u2028", code: "repository_path_forbidden_code_point" },
    { value: "a<b", code: "repository_path_win32_character" },
  ];
  for (const fixture of cases) assertViolation(fixture.value, fixture.code);
  let validPairs = 0;
  for (let high = 0xd800; high <= 0xdbff; high += 1) {
    const highUnit = String.fromCharCode(high);
    assertViolation(highUnit, "repository_path_lone_surrogate");
    assertViolation(`prefix${highUnit}`, "repository_path_lone_surrogate");
    for (let low = 0xdc00; low <= 0xdfff; low += 1) {
      const pair = String.fromCharCode(high, low);
      assertViolationAbsent(
        `pair-${pair}`,
        "repository_path_lone_surrogate",
        `${high.toString(16)}/${low.toString(16)}`,
      );
      validPairs += 1;
    }
    for (const boundary of [0xd7ff, 0xd800, 0xdbff, 0xe000]) {
      assertViolation(String.fromCharCode(high, boundary), "repository_path_lone_surrogate");
    }
  }
  assert.equal(validPairs, REPOSITORY_PATH_OFFICIAL_CORPUS_EXPECTATIONS.validSurrogatePairs);
  for (let low = 0xdc00; low <= 0xdfff; low += 1) {
    const lowUnit = String.fromCharCode(low);
    assertViolation(lowUnit, "repository_path_lone_surrogate");
    assertViolation(`${lowUnit}suffix`, "repository_path_lone_surrogate");
    assertViolationAbsent(String.fromCharCode(0xd800, low), "repository_path_lone_surrogate");
    assertViolationAbsent(String.fromCharCode(0xdbff, low), "repository_path_lone_surrogate");
  }
  const accepted = inspectRepositoryPath("src/Éclair-😀.ts", LIMITS);
  assert.equal(accepted.ok, true);
  if (accepted.ok) {
    assert.equal(Object.isFrozen(accepted.path), true);
    assert.equal(Object.isFrozen(accepted.path.segments), true);
  }
});

family("RPA-L002", () => {
  const devices = [
    "CON", "prn.txt", "Aux.tar.gz", "NUL .txt", "COM1", "com9.log", "LPT1", "lpt9.log",
    "COM¹", "com².txt", "COM³.tar", "LPT¹", "lpt².log", "LPT³.txt",
    "CONIN$", "conout$.txt", "CLOCK$", "clock$.log",
  ];
  for (const value of devices) assertViolation(value, "repository_path_win32_reserved_device");
  for (const value of ["COM0", "COM10", "LPT0", "LPT10", "COMM", "CONSOLE", "COM⁴", "LPT⁴"]) {
    assert.equal(inspectRepositoryPath(value, LIMITS).ok, true, value);
  }
  for (const character of ['<', '>', ':', '"', '|', '?', '*']) {
    assertViolation(`a${character}b`, "repository_path_win32_character");
  }
  assertViolation("folder.", "repository_path_win32_trailing_dot_or_space");
  assertViolation("folder ", "repository_path_win32_trailing_dot_or_space");
});

family("RPA-L003", () => {
  for (const value of [".git", ".GIT", "git~1", "GIT~1", ".git..."]) {
    assertViolation(value, "repository_path_git_metadata_alias");
  }
  assert.equal(inspectRepositoryPath(".git.txt", LIMITS).ok, true);
  assert.equal(inspectRepositoryPath(".gitmodules", LIMITS, { entryKind: "file" }).ok, true);
  for (const value of ["mailma~0", "mailma~10", "maba30~0", "maba30~10", "mailmb~1", "~10000000"]) {
    assert.equal(inspectRepositoryPath(value, LIMITS, { entryKind: "symlink" }).ok, true, value);
  }
});

family("RPA-L004", () => {
  const two = { ...LIMITS, maximumSegmentUtf8Bytes: 2, maximumSegmentUtf16CodeUnits: 2 };
  assert.equal(inspectRepositoryPath("ab", two).ok, true);
  assertViolation("abc", "repository_path_segment_utf8_too_large", undefined, two);
  assertViolation("abc", "repository_path_segment_utf16_too_large", undefined, two);
  const five = { ...LIMITS, maximumPathUtf8Bytes: 5 };
  assert.equal(inspectRepositoryPath("a/b/c", five).ok, true);
  assertViolation("a/b/cd", "repository_path_utf8_too_large", undefined, five);
  const twoSegments = { ...LIMITS, maximumSegments: 2 };
  assert.equal(inspectRepositoryPath("a/b", twoSegments).ok, true);
  assertViolation("a/b/c", "repository_path_too_many_segments", undefined, twoSegments);
  assert.equal(inspectRepositoryPath("a".repeat(255), LIMITS).ok, true);
  assertViolation("a".repeat(256), "repository_path_segment_utf8_too_large");
  const twoPaths = { ...LIMITS, maximumPathsPerSet: 2 };
  const oversizedSet = inspectRepositoryPathSet(["a", "b", "c"], twoPaths);
  assert.equal(oversizedSet.ok, false);
  if (!oversizedSet.ok) assert.equal(oversizedSet.violations[0]?.code, "repository_path_set_too_large");
  assert.throws(() => inspectRepositoryPath("a", {
    ...LIMITS,
    maximumPathUtf8Bytes: REPOSITORY_PATH_QUALIFIED_LIMIT_CEILINGS.maximumPathUtf8Bytes + 1,
  }), hasCode("repository_path_limits_invalid"));
});

family("RPA-S001", () => {
  const sparse: unknown[] = [];
  sparse.length = 2;
  sparse[0] = "a";
  const accessor: unknown[] = [];
  Object.defineProperty(accessor, "0", { enumerable: true, get: () => "a" });
  accessor.length = 1;
  const cyclic: unknown[] = [];
  cyclic.push(cyclic);
  const exotic = Object.assign(Object.create({ inherited: true }) as Record<string, unknown>, { value: "a" });
  for (const value of [
    {}, sparse, accessor, cyclic, new Proxy(["a"], {}), [Symbol("x")], [exotic],
  ]) {
    const decision = inspectRepositoryPathSet(value, LIMITS);
    assert.equal(decision.ok, false);
    if (!decision.ok) {
      const codes = [
        ...decision.violations.map((entry) => entry.code),
        ...decision.pathViolations.flatMap((entry) => entry.violations.map((violation) => violation.code)),
      ];
      assert.equal(codes.includes("repository_path_set_structure_invalid"), true);
    }
  }
});

family("RPA-S002", () => {
  const pairs = [
    ["Case.ts", "case.ts"],
    ["Straße.ts", "STRASSE.ts"],
    ["Σ.ts", "ς.ts"],
    ["ﬃ.ts", "FFI.ts"],
    ["İ.ts", "i\u0307.ts"],
    ["µ.ts", "Μ.ts"],
    ["Ꭰ.ts", "ꭰ.ts"],
  ] as const;
  for (const [left, right] of pairs) {
    const decision = inspectRepositoryPathSet([left, right], LIMITS);
    assert.equal(decision.ok, false, `${left} / ${right}`);
    if (!decision.ok) {
      assert.equal(decision.collisions.some((entry) => entry.code === "repository_path_portable_collision"), true);
    }
  }
  const duplicate = inspectRepositoryPathSet(["same.ts", "same.ts"], LIMITS);
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) {
    assert.deepEqual(duplicate.collisions.map((entry) => entry.code), ["repository_path_exact_duplicate"]);
  }
  const nonNfc = inspectRepositoryPathSet(["Café.ts", "Cafe\u0301.ts"], LIMITS);
  assert.equal(nonNfc.ok, false);
  if (!nonNfc.ok) {
    assert.equal(nonNfc.pathViolations[0]?.violations[0]?.code, "repository_path_non_nfc");
    assert.equal(nonNfc.collisions.length, 0);
  }
  assertViolation("K.ts", "repository_path_non_nfc");
  const ordered = inspectRepositoryPathSet(["Straße.ts", "STRASSE.ts"], LIMITS);
  assert.equal(ordered.ok, false);
  if (!ordered.ok) {
    assert.equal(ordered.collisions[0]?.first.ordinal, 0);
    assert.equal(ordered.collisions[0]?.second.ordinal, 1);
  }
  const canary = "RPA-CANARY-PROVENANCE-DO-NOT-SERIALIZE";
  const canaryDecision = inspectRepositoryPathSet([
    { value: "safe.ts", provenance: { surface: canary, ordinal: 999 } },
  ], LIMITS);
  assert.equal(canaryDecision.ok, false);
  assertSerializedCanaryAbsent(canaryDecision, canary);
  const canaryPathDecision = inspectRepositoryPath(`bad<${canary}`, LIMITS);
  assertSerializedCanaryAbsent(canaryPathDecision, canary);
  for (const operation of [
    () => requireRepositoryPath(`bad<${canary}`, LIMITS),
    () => requireRepositoryPathSet([{ value: "safe.ts", provenance: { surface: canary } }], LIMITS),
  ]) {
    try {
      operation();
      assert.fail("canary operation unexpectedly succeeded");
    } catch (error) {
      assertSerializedCanaryAbsent(serializedError(error), canary);
    }
  }
});

family("RPA-B001", () => {
  assert.equal("inspectRepositoryPathWithValidatedLimits" in repositoryPathLogical, false);
  assert.throws(() => repositoryPathLogical.createRepositoryPathInspector({
    ...LIMITS,
    maximumSegmentUtf8Bytes: REPOSITORY_PATH_QUALIFIED_LIMIT_CEILINGS.maximumSegmentUtf8Bytes + 1,
  }), hasCode("repository_path_limits_invalid"));

  const inspector = repositoryPathLogical.createRepositoryPathInspector(LIMITS);
  assert.equal(Object.isFrozen(inspector), true);
  assert.equal(Object.isFrozen(inspector.limits), true);
  const accepted = inspector.inspect("Safe.ts");
  assert.equal(accepted.ok, true);
  if (!accepted.ok) return;
  assert.equal(portableRepositoryPathKey(accepted.path), accepted.path.portabilityKey);

  const structuralClone = structuredClone(accepted.path) as ValidRepositoryPath;
  const forgedObject = {
    ...accepted.path,
    portabilityKey: "forged",
  } as ValidRepositoryPath;
  const castString = accepted.path.value as unknown as ValidRepositoryPath;
  const inherited = Object.create(accepted.path) as ValidRepositoryPath;
  for (const forged of [structuralClone, forgedObject, castString, inherited]) {
    assert.throws(
      () => portableRepositoryPathKey(forged),
      hasCode(REPOSITORY_PATH_RUNTIME_AUTHORITY_ERROR_CODE),
    );
  }
});

family("RPA-C001", () => {
  assert.equal(CONFIG.repositoryPaths.schemaVersion, REPOSITORY_PATH_SETTINGS_SCHEMA_VERSION);
  assert.equal(CONFIG.repositoryPaths.profile, REPOSITORY_PATH_PROFILE);
  assert.deepEqual(CONFIG.repositoryPaths.limits, {
    maximumPathUtf8Bytes: 4_096,
    maximumSegmentUtf8Bytes: 255,
    maximumSegmentUtf16CodeUnits: 255,
    maximumSegments: 256,
    maximumPathsPerSet: 100_000,
  });
  for (const key of Object.keys(REPOSITORY_PATH_QUALIFIED_LIMIT_CEILINGS) as
    Array<keyof RepositoryPathLimits>) {
    const candidate = structuredClone(CONFIG) as unknown as MutableConfig;
    candidate.repositoryPaths.limits[key] = REPOSITORY_PATH_QUALIFIED_LIMIT_CEILINGS[key] + 1;
    assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(candidate).success, false, key);
  }
  const wrongProfile = structuredClone(CONFIG) as unknown as MutableConfig;
  wrongProfile.repositoryPaths.profile = "candidate-widened/v1";
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(wrongProfile).success, false);
});

family("RPA-E001", () => {
  const paths = [
    PATH_POLICY_MANIFEST_PATH,
    CASE_FOLDING_PATH,
    NORMALIZATION_PATH,
    MANIFEST_PATH,
    `${ROOT}${GIT_SOURCE_AUTHORITY.license.path}`,
    ...GIT_SOURCE_AUTHORITY.sources.map((source) => `${ROOT}${source.path}`),
    GENERATED_PATH,
    GENERATOR_PATH,
  ];
  const before = paths.map((path) => sha256(readFileSync(path)));
  const derived = deriveRepositoryPathUnicodeFoundation(ROOT);
  assertGeneratedCaseFoldingModule(readFileSync(GENERATED_PATH, "utf8"), derived.generatedSource);
  // SNAPSHOT AND RESTORE IN A `finally`, BEFORE ASSERTING. The generator is
  // invoked with `--write` and is EXPECTED to refuse for want of write
  // authority — which is the right way to prove a refusal, and is exactly the
  // shape that WRITES when the refusal is the thing that has broken. The hash
  // comparison below would then report generated source it could not put back.
  const preimage = new Map(paths.map((path) => [path, readFileSync(path)] as const));
  try {
    assert.throws(
      () => runRepositoryPathUnicodeGenerator(["--write"]),
      hasCode("repository_path_generation_write_authority_unavailable"),
    );
  } finally {
    for (const [path, bytes] of preimage) {
      if (!readFileSync(path).equals(bytes)) writeFileSync(path, bytes);
    }
  }
  assert.deepEqual(paths.map((path) => sha256(readFileSync(path))), before);
  assert.doesNotMatch(readFileSync(GENERATOR_PATH, "utf8"), /\b(?:writeFile|appendFile|rename|unlink)Sync\b/u);
});

export function runRepositoryPathTestOracle(id: RepositoryPathTestId, check: (assertion: () => void) => void): void {
  const oracle = FAMILY_ORACLES.get(id);
  if (oracle === undefined) throw new Error(`Unknown repository path oracle: ${id}`);
  check(oracle);
}

function independentCaseFoldingMap(text: string): ReadonlyMap<number, readonly number[]> {
  const result = new Map<number, readonly number[]>();
  for (const line of text.split("\n")) {
    const match = /^([0-9A-F]+); ([CF]); ([0-9A-F ]+);/u.exec(line);
    if (!match) continue;
    const source = Number.parseInt(match[1]!, 16);
    assert.equal(result.has(source), false);
    result.set(source, match[3]!.trim().split(" ").map((value) => Number.parseInt(value, 16)));
  }
  return result;
}

function independentPortabilityKey(input: string, map: ReadonlyMap<number, readonly number[]>): string {
  let result = "";
  for (const character of input.normalize("NFD")) {
    const mapping = map.get(character.codePointAt(0)!);
    result += mapping ? String.fromCodePoint(...mapping) : character;
  }
  return result.normalize("NFC");
}

function decodeCodePointField(field: string): string {
  return String.fromCodePoint(...field.trim().split(" ").filter(Boolean)
    .map((value) => Number.parseInt(value, 16)));
}

function assertViolation(
  value: unknown,
  code: string,
  context?: RepositoryPathContext,
  limits: RepositoryPathLimits = LIMITS,
): void {
  const decision = context === undefined && limits === LIMITS
    ? LIMITS_INSPECTOR.inspect(value)
    : inspectRepositoryPath(value, limits, context);
  assert.equal(decision.ok, false, String(value));
  if (!decision.ok) assert.equal(decision.violations.some((entry) => entry.code === code), true, String(value));
}

function assertGitSymlinkAlias(value: string): void {
  assertViolation(value, "repository_path_git_symlink_metadata_alias", { entryKind: "symlink" });
  assertViolation(value, "repository_path_git_symlink_metadata_alias", { gitMode: "120000" });
}

function assertNoGitSymlinkAlias(value: string): void {
  const decision = inspectRepositoryPath(value, LIMITS, { entryKind: "symlink" });
  if (!decision.ok) {
    assert.equal(
      decision.violations.some((entry) => entry.code === "repository_path_git_symlink_metadata_alias"),
      false,
      value,
    );
  }
}

function gitFallbackAlias(prefix: string, sequence: number, totalLength: number): string {
  const digits = String(sequence);
  const prefixLength = totalLength - digits.length - 1;
  assert.ok(prefixLength >= 0 && prefixLength <= prefix.length);
  return `${prefix.slice(0, prefixLength)}~${digits}`;
}

function assertViolationAbsent(value: unknown, code: string, message = String(value)): void {
  const decision = LIMITS_INSPECTOR.inspect(value);
  if (!decision.ok) {
    assert.equal(decision.violations.some((entry) => entry.code === code), false, message);
  }
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof HarnessError && error.code === code;
}

function serializedError(error: unknown): unknown {
  if (!(error instanceof Error)) return { kind: typeof error };
  return {
    name: error.name,
    message: error.message,
    ...("code" in error && typeof error.code === "string" ? { code: error.code } : {}),
  };
}

function assertSerializedCanaryAbsent(value: unknown, canary: string): void {
  assert.equal(JSON.stringify(value).includes(canary), false);
}

function manifestForCaseFoldingSource(sourceText: string): UnicodePathSourceManifest {
  const candidate = structuredClone(MANIFEST) as unknown as MutableManifest;
  const source = candidate.sources.find((entry) => entry.id === "unicode-17.0.0-case-folding")!;
  source.byteLength = Buffer.byteLength(sourceText, "utf8");
  source.sha256 = sha256(sourceText);
  return candidate as unknown as UnicodePathSourceManifest;
}

function replaceFirstStatus(text: string, from: "S" | "T", to: "C" | "F"): string {
  const expression = new RegExp(`^([0-9A-F]+); ${from};`, "mu");
  assert.match(text, expression);
  return text.replace(expression, `$1; ${to};`);
}

type MutableManifest = {
  sources: Array<{
    id: string;
    byteLength: number;
    sha256: string;
  }>;
};

type MutableConfig = {
  repositoryPaths: {
    profile: string;
    limits: Record<keyof RepositoryPathLimits, number>;
  };
};

type MutablePathPolicyManifest = {
  sourceSets: {
    git: {
      upstream: {
        tag: string;
      };
    };
  };
};
