import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  parsePathPolicySourceManifest,
} from "../scripts/generation/repository-path-unicode.ts";
import {
  createPlannedNodeTestCorpusBinding,
  createPlannedNodeTestSourceBinding,
  createPlannedNodeTestSuiteSpec,
  parsePlannedNodeTestEvidenceBytes,
  plannedNodeTestReproducibilityIdentity,
} from "../scripts/tooling/planned-node-test-evidence.ts";
import {
  PLANNED_NODE_TEST_PROTOCOL,
  plannedNodeTestCatalogIdentity,
} from "../scripts/tooling/planned-node-test.ts";
import { discoverTestNames } from "../scripts/test-inventory.ts";
import * as repositoryPathPublic from "../src/repository-path/index.ts";
import { canonicalHash, canonicalJson, sha256 } from "../src/kernel/integrity.ts";
import {
  REPOSITORY_PATH_OFFICIAL_CORPUS_EXPECTATIONS,
  REPOSITORY_PATH_TEST_CATALOG,
  REPOSITORY_PATH_TEST_DECLARATION_IDENTITY,
  REPOSITORY_PATH_TEST_WORKER_PATH,
  createRepositoryPathPlannedCatalog,
} from "./support/repository-path-test-catalog.ts";
import { runRepositoryPathTestOracle } from "./support/repository-path-test-oracles.ts";
import {
  createPlannedNodeTestEvidenceSession,
  runPlannedNodeTestSuiteWithEvidence,
} from "./support/planned-node-test-evidence.ts";
import { PLANNED_NODE_TEST_SOURCE_AUTHORITY } from
  "./support/planned-node-test-source-authority.ts";
import { TEST_REPOSITORY_ROOT } from "./support/repository-local-temporary.ts";
import { relaxSafeReadFloorForThisFile } from "./support/test-env-helpers.ts";

const ROOT = TEST_REPOSITORY_ROOT;
// These tests read the real repository workspace (seeded with `cp -rl`
// hardlinks, nlink=2) in dev mode (`selfProtection.enabled: false`). The safe
// repository reader accepts hardlinked files in dev mode via the
// `HARNESS_REJECT_HARDLINKS` env var (`shouldRejectHardlinks`). Hardlink
// rejection is verified by the dedicated security tests, which leave the env
// var unset so the production floor is enforced.
// Relaxed for THIS FILE and restored when it finishes — see the helper.
relaxSafeReadFloorForThisFile();
const WORKER_PATH = REPOSITORY_PATH_TEST_WORKER_PATH;
const SOURCE_AUTHORITY = PLANNED_NODE_TEST_SOURCE_AUTHORITY.suites.repositoryPath;
const GENERATOR_PATH = resolve("scripts/generation/repository-path-unicode.ts");
const CASE_FOLDING_PATH = "traceability/sources/path-policy/unicode-17.0.0/CaseFolding.txt";
const NORMALIZATION_PATH = "traceability/sources/path-policy/unicode-17.0.0/NormalizationTest.txt";
const PATH_POLICY_MANIFEST_PATH = "traceability/sources/path-policy/manifest.json";
const PATH_POLICY_SOURCE_AUTHORITY = parsePathPolicySourceManifest(
  readFileSync(PATH_POLICY_MANIFEST_PATH, "utf8"),
);
const PLANNED_CATALOG = createRepositoryPathPlannedCatalog(runRepositoryPathTestOracle);
const EXPECTED_TEST_NAMES = REPOSITORY_PATH_TEST_CATALOG.map((entry) => `[${entry.id}] ${entry.name}`);
const HOSTILE_ENVIRONMENTS = [
  {
    REPOSITORY_PATH_TEST_VARIANT: "0",
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    NODE_TEST_CONTEXT: "hostile-parent-context-must-not-propagate",
  },
  {
    REPOSITORY_PATH_TEST_VARIANT: "1",
    LANG: "fr_CA.UTF-8",
    LC_ALL: "fr_CA.UTF-8",
    TZ: "America/Toronto",
  },
  {
    REPOSITORY_PATH_TEST_VARIANT: "2",
    LANG: "tr_TR.UTF-8",
    LC_ALL: "tr_TR.UTF-8",
    TZ: "Asia/Tokyo",
  },
] as const;

const SOURCE_BINDINGS = [
  SOURCE_AUTHORITY.worker,
  SOURCE_AUTHORITY.catalog,
  SOURCE_AUTHORITY.oracle,
  PLANNED_NODE_TEST_SOURCE_AUTHORITY.shared.executor,
  PLANNED_NODE_TEST_SOURCE_AUTHORITY.shared.evidenceExecutor,
] as const;
const CORPUS_BINDINGS = [
  createPlannedNodeTestCorpusBinding(
    ROOT,
    "unicode-case-folding-cf",
    "unicode-case-folding-cf",
    CASE_FOLDING_PATH,
  ),
  createPlannedNodeTestCorpusBinding(
    ROOT,
    "unicode-normalization-test",
    "unicode-normalization-test",
    NORMALIZATION_PATH,
  ),
] as const;
const SUITE_SPEC = createPlannedNodeTestSuiteSpec({
  suiteId: "repository-path-authority",
  declarationIdentity: REPOSITORY_PATH_TEST_DECLARATION_IDENTITY,
  plannedCatalogIdentity: plannedNodeTestCatalogIdentity(PLANNED_CATALOG),
  expectedTestNames: EXPECTED_TEST_NAMES,
  sources: SOURCE_BINDINGS,
  corpora: CORPUS_BINDINGS,
});

test("[RPA-O001] isolated normal v4 worker declarations and bound catalog are exact", () => {
  assert.deepEqual(discoverTestNames(readFileSync(WORKER_PATH, "utf8")), EXPECTED_TEST_NAMES);
  assert.deepEqual(SOURCE_BINDINGS.map((binding) =>
    createPlannedNodeTestSourceBinding(ROOT, binding.role, binding.path)
  ), SOURCE_BINDINGS);
  assert.equal(new Set(EXPECTED_TEST_NAMES).size, EXPECTED_TEST_NAMES.length);
  assert.match(SUITE_SPEC.declarationIdentity, /^[0-9a-f]{64}$/u);
  assert.match(SUITE_SPEC.plannedCatalogIdentity, /^[0-9a-f]{64}$/u);
  assert.match(SUITE_SPEC.catalogIdentity, /^[0-9a-f]{64}$/u);
  assert.equal(SUITE_SPEC.repositoryAdmissionAllowed, false);
  assert.equal(
    SUITE_SPEC.qualificationDisposition,
    PLANNED_NODE_TEST_PROTOCOL.qualificationDisposition,
  );
});

test("[RPA-O002] independent outer census binds the complete official Unicode corpora", () => {
  const caseFoldingText = readFileSync(CASE_FOLDING_PATH, "utf8");
  const selected = caseFoldingText.split("\n").filter((line) =>
    /^[0-9A-F]+; [CF]; [0-9A-F ]+;/u.test(line)
  );
  assert.equal(selected.length, REPOSITORY_PATH_OFFICIAL_CORPUS_EXPECTATIONS.caseFoldingEntries);
  assert.equal(
    new Set(selected.map((line) => line.split(";", 1)[0])).size,
    REPOSITORY_PATH_OFFICIAL_CORPUS_EXPECTATIONS.caseFoldingEntries,
  );

  let rows = 0;
  let assertions = 0;
  for (const line of readFileSync(NORMALIZATION_PATH, "utf8").split("\n")) {
    const data = line.split("#", 1)[0]!.trim();
    if (data.length === 0 || data.startsWith("@")) continue;
    const fields = data.split(";").slice(0, 5).map((field) => field.trim());
    assert.equal(fields.length, REPOSITORY_PATH_OFFICIAL_CORPUS_EXPECTATIONS.normalizationAssertionsPerRow);
    assert.equal(fields.every((field) =>
      /^(?:[0-9A-F]{4,6})(?: [0-9A-F]{4,6})*$/u.test(field)
    ), true);
    rows += 1;
    assertions += fields.length;
  }
  assert.equal(rows, REPOSITORY_PATH_OFFICIAL_CORPUS_EXPECTATIONS.normalizationRows);
  assert.equal(assertions, REPOSITORY_PATH_OFFICIAL_CORPUS_EXPECTATIONS.normalizationAssertions);
  assert.deepEqual(CORPUS_BINDINGS.map((binding) => binding.facts), [
    {
      entries: REPOSITORY_PATH_OFFICIAL_CORPUS_EXPECTATIONS.caseFoldingEntries,
      uniqueSourceCodePoints: REPOSITORY_PATH_OFFICIAL_CORPUS_EXPECTATIONS.caseFoldingEntries,
    },
    {
      assertions: REPOSITORY_PATH_OFFICIAL_CORPUS_EXPECTATIONS.normalizationAssertions,
      assertionsPerRow: REPOSITORY_PATH_OFFICIAL_CORPUS_EXPECTATIONS.normalizationAssertionsPerRow,
      rows: REPOSITORY_PATH_OFFICIAL_CORPUS_EXPECTATIONS.normalizationRows,
    },
  ]);
});

test("[RPA-O003] complete portable authority is invariant across three hostile runtimes", async () => {
  const session = createPlannedNodeTestEvidenceSession(SUITE_SPEC);
  try {
    const observations = [];
    for (const environment of HOSTILE_ENVIRONMENTS) {
      const observation = await session.run({ ...process.env, ...environment });
      assert.equal(observation.accepted, true, JSON.stringify({
        violations: observation.violations,
        diagnostics: observation.diagnostics,
      }));
      assert.ok(observation.evidence);
      assert.equal(observation.diagnostics.sourceSnapshotIdentity, session.sourceSnapshotIdentity);
      observations.push(observation.evidence);
    }
    const identities = observations.map(plannedNodeTestReproducibilityIdentity);
    assert.deepEqual(identities.slice(1), [identities[0], identities[0]]);

    const baseline = observations[0]!;
    const relocated = {
      ...baseline,
      runtime: { ...baseline.runtime, cwd: "/different/isolated/root", argv: ["relocated"] },
      integrityHash: "0".repeat(64),
    };
    assert.equal(plannedNodeTestReproducibilityIdentity(relocated), identities[0]);
    const semanticMutants = [
      {
        ...baseline,
        sourcesBefore: baseline.sourcesBefore.map((source, index) =>
          index === 0 ? { ...source, sha256: "0".repeat(64) } : source
        ),
      },
      {
        ...baseline,
        corporaBefore: baseline.corporaBefore.map((corpus, index) => index === 0
          ? { ...corpus, facts: { ...corpus.facts, entries: corpus.facts.entries! - 1 } }
          : corpus),
      },
      {
        ...baseline,
        runtime: {
          ...baseline.runtime,
          node: `${baseline.runtime.node}-mutant`,
        },
      },
      {
        ...baseline,
        candidateBefore: { ...baseline.candidateBefore, semanticTreeHash: "0".repeat(64) },
      },
    ];
    for (const mutant of semanticMutants) {
      assert.notEqual(plannedNodeTestReproducibilityIdentity(mutant), identities[0]);
    }

    const { integrityHash: baselineIntegrityHash, ...baselineUnsigned } = baseline;
    assert.match(baselineIntegrityHash, /^[0-9a-f]{64}$/u);
    const injectedExecutableUnsigned = {
      ...baselineUnsigned,
      runtime: {
        ...baseline.runtime,
        executable: { sha256: "0".repeat(64) },
      },
    };
    const injectedExecutable = {
      ...injectedExecutableUnsigned,
      integrityHash: canonicalHash(injectedExecutableUnsigned),
    };
    assert.throws(
      () => parsePlannedNodeTestEvidenceBytes(
        Buffer.from(`${canonicalJson(injectedExecutable)}\n`, "utf8"),
      ),
      (error) => error instanceof Error && error.message.includes("executable"),
    );
  } finally {
    session.close();
  }
});

test("[RPA-O004] false corpus or source identities cannot fabricate portable evidence", async () => {
  const falseCorpus = createPlannedNodeTestSuiteSpec({
    suiteId: SUITE_SPEC.suiteId,
    declarationIdentity: SUITE_SPEC.declarationIdentity,
    plannedCatalogIdentity: SUITE_SPEC.plannedCatalogIdentity,
    expectedTestNames: SUITE_SPEC.expectedTestNames,
    sources: SUITE_SPEC.sources,
    corpora: SUITE_SPEC.corpora.map((corpus, index) => index === 0 ? {
      ...corpus,
      facts: { ...corpus.facts, entries: corpus.facts.entries! - 1 },
    } : corpus),
  });
  const falseSource = createPlannedNodeTestSuiteSpec({
    suiteId: SUITE_SPEC.suiteId,
    declarationIdentity: SUITE_SPEC.declarationIdentity,
    plannedCatalogIdentity: SUITE_SPEC.plannedCatalogIdentity,
    expectedTestNames: SUITE_SPEC.expectedTestNames,
    sources: SUITE_SPEC.sources.map((source) => source.role === "worker"
      ? { ...source, sha256: "0".repeat(64) }
      : source),
    corpora: SUITE_SPEC.corpora,
  });
  const observations = await Promise.all([falseCorpus, falseSource].map((mutant) =>
    runPlannedNodeTestSuiteWithEvidence(
      mutant,
      { ...process.env, ...HOSTILE_ENVIRONMENTS[0] },
    )));
  for (const observation of observations) {
    assert.equal(observation.accepted, false);
    assert.ok(observation.violations.length > 0);
  }
});

test("[RPA-O005] generator is byte-preserving and physical authority remains unavailable", () => {
  assert.equal(existsSync(resolve("src/repository-path/physical.ts")), false);
  assert.deepEqual(Object.keys(repositoryPathPublic).toSorted(), [
    "REPOSITORY_PATH_GIT_SYMLINK_ALIAS_POLICY",
    "REPOSITORY_PATH_PORTABILITY_KEY_ALGORITHM",
    "REPOSITORY_PATH_PROFILE",
    "REPOSITORY_PATH_QUALIFIED_LIMIT_CEILINGS",
    "REPOSITORY_PATH_RUNTIME_AUTHORITY_ERROR_CODE",
    "REPOSITORY_PATH_SETTINGS_SCHEMA_VERSION",
    "REPOSITORY_PATH_UNICODE_VERSION",
    "REPOSITORY_PATH_VIOLATION_CODES",
    "assertRepositoryPathRuntimeCapability",
    "createRepositoryPathInspector",
    "inspectRepositoryPath",
    "inspectRepositoryPathSet",
    "portableRepositoryPathKey",
    "requireRepositoryPath",
    "requireRepositoryPathSet",
  ]);

  const observedPaths = [
    resolve(PATH_POLICY_MANIFEST_PATH),
    resolve(CASE_FOLDING_PATH),
    resolve(NORMALIZATION_PATH),
    resolve("traceability/sources/path-policy/unicode-17.0.0/manifest.json"),
    resolve(PATH_POLICY_SOURCE_AUTHORITY.sourceSets.git.license.path),
    ...PATH_POLICY_SOURCE_AUTHORITY.sourceSets.git.sources.map((source) => resolve(source.path)),
    resolve("src/repository-path/unicode-case-fold.generated.ts"),
    GENERATOR_PATH,
  ];
  const before = observedPaths.map((path) => sha256(readFileSync(path)));
  for (const arguments_ of [[], ["--check"], ["--derive"]] as const) {
    const result = spawnSync(process.execPath, [GENERATOR_PATH, ...arguments_], {
      encoding: "utf8",
      env: { ...process.env, LANG: "C", LC_ALL: "C", TZ: "UTC" },
      maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as Readonly<Record<string, unknown>>;
    assert.equal(report.disposition, "foundation-derived-not-admitted-or-qualified");
    const sourceAuthority = report.sourceAuthority as Readonly<{
      git: Readonly<{ tag: string; commit: string }>;
    }>;
    assert.equal(sourceAuthority.git.tag, PATH_POLICY_SOURCE_AUTHORITY.sourceSets.git.upstream.tag);
    assert.equal(sourceAuthority.git.commit, PATH_POLICY_SOURCE_AUTHORITY.sourceSets.git.upstream.commit);
  }
  // SNAPSHOT AND RESTORE IN A `finally`, BEFORE ASSERTING. The generator is
  // invoked with `--write` and is EXPECTED to refuse for want of write
  // authority — which is the right way to prove a refusal, and is exactly the
  // shape that WRITES when the refusal is the thing that has broken. The hash
  // comparison below would then report generated source it could not put back.
  const preimage = new Map(observedPaths.map((path) => [path, readFileSync(path)] as const));
  try {
    const write = spawnSync(process.execPath, [GENERATOR_PATH, "--write"], {
      encoding: "utf8",
      env: { ...process.env, LANG: "C", LC_ALL: "C", TZ: "UTC" },
    });
    assert.notEqual(write.status, 0);
    assert.match(write.stderr, /repository_path_generation_write_authority_unavailable/u);
  } finally {
    for (const [path, bytes] of preimage) {
      if (!readFileSync(path).equals(bytes)) writeFileSync(path, bytes);
    }
  }
  assert.deepEqual(observedPaths.map((path) => sha256(readFileSync(path))), before);
  assert.match(canonicalHash(before), /^[0-9a-f]{64}$/u);
});

test("[RPA-O006] Git exact ordinary range and harness strict extension stay distinct", () => {
  const git = PATH_POLICY_SOURCE_AUTHORITY.sourceSets.git;
  const pathSource = git.sources.find((source) => source.upstreamPath === "path.c")!;
  const upstream = readFileSync(pathSource.path, "utf8");
  assert.match(upstream, /name\[7\] >= '1' && name\[7\] <= '4'/u);

  const policy = repositoryPathPublic.REPOSITORY_PATH_GIT_SYMLINK_ALIAS_POLICY;
  const limits = repositoryPathPublic.REPOSITORY_PATH_QUALIFIED_LIMIT_CEILINGS;
  for (const metadata of policy.gitExact.metadataNames) {
    const prefix = metadata.longName.slice(1, policy.gitExact.regularShortName.prefixLength + 1);
    for (let sequence = policy.gitExact.regularShortName.minimumSequence;
      sequence <= policy.gitExact.regularShortName.maximumSequence; sequence += 1) {
      const alias = `${prefix}~${sequence}`;
      assert.equal(independentGitRegularAliasMatch(alias, metadata.longName), true, alias);
      assert.equal(repositoryPathPublic.inspectRepositoryPath(
        alias,
        limits,
        { entryKind: "symlink" },
      ).ok, false, alias);
    }
    for (let sequence = policy.harnessStrictAdditional.regularShortName.minimumSequence;
      sequence <= policy.harnessStrictAdditional.regularShortName.maximumSequence; sequence += 1) {
      const alias = `${prefix}~${sequence}`;
      assert.equal(independentGitRegularAliasMatch(alias, metadata.longName), false, alias);
      const decision = repositoryPathPublic.inspectRepositoryPath(alias, limits, { entryKind: "symlink" });
      assert.equal(decision.ok, false, alias);
      if (!decision.ok) {
        assert.equal(
          decision.violations.some((entry) => entry.code === "repository_path_git_symlink_metadata_alias"),
          true,
          alias,
        );
      }
    }
  }
});

function independentGitRegularAliasMatch(input: string, longName: string): boolean {
  const prefix = longName.slice(1, 7);
  return input.slice(0, 6).toLowerCase() === prefix && input[6] === "~" &&
    input[7] !== undefined && input[7]! >= "1" && input[7]! <= "4" && input.length === 8;
}
