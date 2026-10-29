import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { Ajv2020, type AnySchema } from "ajv/dist/2020.js";

import {
  getConfigContractArtifact,
  buildConfigContract,
  getConfigDocumentSchema,
  type ConfigContractPolicyProjection,
} from "../../src/kernel/config-contracts.ts";
import { canonicalHash, canonicalJson, sha256 } from "../../src/kernel/integrity.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";

const CONFIG_DOCUMENT_SCHEMA = getConfigDocumentSchema();
const GENERATED_CONFIG_DOCUMENT_SCHEMA = getConfigContractArtifact().schema;
const CONFIG_DOCUMENT_SCHEMA_HASH = getConfigContractArtifact().schemaHash;
const CONFIG_DOCUMENT_SCHEMA_IDENTITY = getConfigContractArtifact().identity;
const CONFIG_DOCUMENT_SCHEMA_IDENTITY_HASH = getConfigContractArtifact().identityHash;
const CONFIG_DOCUMENT_SCHEMA_ARTIFACT = getConfigContractArtifact();


const CONFIG_PATH = new URL("../../bridlewise.config.json", import.meta.url);
const CONTRACT_SOURCE_PATH = new URL("../../src/kernel/config-contracts.ts", import.meta.url);
const ARTIFACT_PATH = new URL("../../traceability/config-document-schema.json", import.meta.url);
const VALID_CONFIG = CONFIG_DOCUMENT_SCHEMA.parse(JSON.parse(readFileSync(CONFIG_PATH, "utf8")));
const REPOSITORY_ROOT_CAPABILITY_BUDGET = ROOT_POLICY.verification.testFixtures
  .repositoryRootCapability.budget;
const REPOSITORY_ROOT_CAPABILITY_LIMIT_CEILINGS =
  REPOSITORY_ROOT_CAPABILITY_BUDGET.limitCeilings;
const REPOSITORY_ROOT_CAPABILITY_LIMIT_FIELDS = [
  "maximumConcurrentBorrowsPerCapability",
  "maximumOperationsPerBorrow",
  "maximumBorrowOperationsPerCapability",
  "maximumBorrowOperationsPerTask",
  "maximumCapabilityRotationsPerTask",
  "maximumBorrowedPathBytes",
  "maximumBorrowedPathSegments",
] as const;
type RepositoryRootCapabilityLimitField =
  typeof REPOSITORY_ROOT_CAPABILITY_LIMIT_FIELDS[number];
type MutableRepositoryRootCapabilityBudgetPolicy = {
  verification: {
    testFixtures: {
      repositoryRootCapability: {
        budget: {
          schemaVersion?: string;
          limitCeilings: Partial<Record<RepositoryRootCapabilityLimitField, number>>;
        };
      };
    };
  };
};

function candidate(mutator: (value: Record<string, unknown>) => void): Record<string, unknown> {
  const value = structuredClone(VALID_CONFIG) as unknown as Record<string, unknown>;
  mutator(value);
  return value;
}

test("config contract source, identity, and generated projection are byte-bound", () => {
  const sourceSha256 = sha256(readFileSync(CONTRACT_SOURCE_PATH));
  assert.equal(sourceSha256, ROOT_POLICY.configuration.contract.sourceSha256);
  assert.equal(CONFIG_DOCUMENT_SCHEMA_IDENTITY.sourceSha256, sourceSha256);
  assert.equal(CONFIG_DOCUMENT_SCHEMA_IDENTITY.schemaHash, CONFIG_DOCUMENT_SCHEMA_HASH);
  assert.equal(canonicalHash(CONFIG_DOCUMENT_SCHEMA_IDENTITY), CONFIG_DOCUMENT_SCHEMA_IDENTITY_HASH);

  const verifySourcePin = (projection: ConfigContractPolicyProjection): void => {
    assert.equal(buildConfigContract(projection).identity.sourceSha256, sourceSha256);
  };
  verifySourcePin(ROOT_POLICY);

  const omittedPin = structuredClone(ROOT_POLICY) as unknown as ConfigContractPolicyProjection;
  delete (omittedPin as unknown as {
    configuration: { contract: { sourceSha256?: string } };
  }).configuration.contract.sourceSha256;
  assert.throws(() => verifySourcePin(omittedPin), "isolated source pin omission");

  const driftedPin = structuredClone(ROOT_POLICY) as unknown as ConfigContractPolicyProjection;
  (driftedPin as unknown as {
    configuration: { contract: { sourceSha256: string } };
  }).configuration.contract.sourceSha256 = "0".repeat(64);
  assert.throws(() => verifySourcePin(driftedPin), "isolated source pin drift");
  const driftedContract = buildConfigContract(driftedPin);
  assert.equal(driftedContract.schemaHash, CONFIG_DOCUMENT_SCHEMA_HASH);
  assert.notEqual(driftedContract.identityHash, CONFIG_DOCUMENT_SCHEMA_IDENTITY_HASH);

  const artifactText = readFileSync(ARTIFACT_PATH, "utf8");
  const artifact: unknown = JSON.parse(artifactText);
  assert.equal(artifactText, `${canonicalJson(CONFIG_DOCUMENT_SCHEMA_ARTIFACT)}\n`);
  assert.deepEqual(artifact, CONFIG_DOCUMENT_SCHEMA_ARTIFACT);
});

test("pure config compiler derives candidate semantics and enforces central compiler bounds", () => {
  // A fresh native module graph is necessary: this file's fixtures have
  // already requested the host contract. V8's executed function counts
  // observe the actual private compiler without exporting cache controls.
  const cold = spawnSync(process.execPath, ["--input-type=module", "--eval", `
    import assert from 'node:assert/strict';
    import { Session } from 'node:inspector';
    import { promisify } from 'node:util';
    const session = new Session(); session.connect();
    const post = promisify(session.post).bind(session);
    try {
      await post('Profiler.enable');
      await post('Profiler.startPreciseCoverage', {callCount: true, detailed: true});
      const contractUrl = ${JSON.stringify(new URL("../../src/kernel/config-contracts.ts", import.meta.url).href)};
      const contract = await import(contractUrl);
      const observed = new Set();
      async function work(runtime, artifact, reason) {
        const {result} = await post('Profiler.takePreciseCoverage');
        const owner = result.find(script => script.url === contractUrl);
        assert(owner, 'actual compiler script is observed');
        for (const [name, expected] of [['buildRuntimeConfigContract', runtime], ['compileConfigContractArtifact', artifact]]) {
          const fn = owner.functions.find(fn => fn.functionName === name);
          if (fn) observed.add(name);
          assert(observed.has(name), 'actual compiler function is observed: ' + name);
          // After the initial census V8 omits functions with no new calls.
          assert.equal(fn?.ranges[0].count ?? 0, expected, reason + ': ' + name);
        }
      }
      assert.equal(contract.MCP_AUTH_TOKEN_MAX, 4096);
      await work(0, 0, 'imports and defaults compile no document or evidence');
      const schema = contract.getConfigDocumentSchema();
      assert.equal(contract.getConfigDocumentSchema() === schema, true, 'runtime getter reuses its schema');
      assert.equal(contract.getMcpServerConfigSchema() === schema.shape.tools.unwrap().shape.mcpServers.unwrap().element, true, 'registration and document share one schema');
      await work(1, 0, 'runtime validation shares one compiler and emits no tooling evidence');
      const artifact = contract.getConfigContractArtifact();
      assert.equal(contract.getConfigContractArtifact() === artifact, true, 'artifact getter reuses its immutable result');
      assert(Object.isFrozen(artifact)); assert(Object.isFrozen(artifact.schema));
      await work(0, 1, 'repeated evidence requests share the successful immutable artifact');
      const {ROOT_POLICY} = await import(${JSON.stringify(new URL("../../src/kernel/root-policy.ts", import.meta.url).href)});
      const complete = contract.buildConfigContract(ROOT_POLICY);
      assert.deepEqual(complete.artifact, artifact);
      await work(1, 1, 'explicit candidate compilation still emits the complete contract');
      await post('Profiler.stopPreciseCoverage');
    } finally { session.disconnect(); }
  `], { encoding: "utf8", timeout: 30_000 });
  assert.equal(cold.error, undefined);
  assert.equal(cold.status, 0, cold.stderr || cold.stdout);

  const candidatePolicy = structuredClone(ROOT_POLICY) as unknown as ConfigContractPolicyProjection;
  const mutableCandidate = candidatePolicy as unknown as {
    configuration: { contract: {
      sourceSha256: string;
      compilerLimits: { maximumPolicyStringCharacters: number; maximumProtocolIdentifiers: number };
    } };
    contracts: { limits: { maximumEvents: number } };
  };
  mutableCandidate.configuration.contract.sourceSha256 = "0".repeat(64);
  mutableCandidate.contracts.limits.maximumEvents += 1;
  const candidateContract = buildConfigContract(candidatePolicy);
  assert.notEqual(candidateContract.schemaHash, CONFIG_DOCUMENT_SCHEMA_HASH);
  assert.equal(candidateContract.identity.sourceSha256, "0".repeat(64));
  assert.equal(candidateContract.artifact.schemaHash, candidateContract.schemaHash);
  assert.equal(candidateContract.artifact.identityHash, candidateContract.identityHash);

  mutableCandidate.configuration.contract.compilerLimits.maximumProtocolIdentifiers = 1;
  assert.throws(() => buildConfigContract(candidatePolicy));
  mutableCandidate.configuration.contract.compilerLimits.maximumProtocolIdentifiers = 128;
  mutableCandidate.configuration.contract.compilerLimits.maximumPolicyStringCharacters = 8;
  assert.throws(() => buildConfigContract(candidatePolicy));
});

test("repository root capability config ceilings are omission-resistant and independently influential", () => {
  for (const field of REPOSITORY_ROOT_CAPABILITY_LIMIT_FIELDS) {
    const omittedPolicy = structuredClone(ROOT_POLICY) as unknown as ConfigContractPolicyProjection;
    const omittedLimits = (omittedPolicy as unknown as
      MutableRepositoryRootCapabilityBudgetPolicy)
      .verification.testFixtures.repositoryRootCapability.budget.limitCeilings;
    delete omittedLimits[field];
    assert.throws(() => buildConfigContract(omittedPolicy), `${field}: omitted policy field`);

    const widenedPolicy = structuredClone(ROOT_POLICY) as unknown as ConfigContractPolicyProjection;
    const widenedLimits = (widenedPolicy as unknown as
      MutableRepositoryRootCapabilityBudgetPolicy)
      .verification.testFixtures.repositoryRootCapability.budget.limitCeilings;
    widenedLimits[field] = (widenedLimits[field] ?? 0) + 1;
    assert.notEqual(
      buildConfigContract(widenedPolicy).schemaHash,
      CONFIG_DOCUMENT_SCHEMA_HASH,
      `${field}: generated schema influence`,
    );
  }

  const missingBudgetSchemaVersion = structuredClone(ROOT_POLICY) as unknown as
    ConfigContractPolicyProjection;
  delete (missingBudgetSchemaVersion as unknown as
    MutableRepositoryRootCapabilityBudgetPolicy)
    .verification.testFixtures.repositoryRootCapability.budget.schemaVersion;
  assert.throws(() => buildConfigContract(missingBudgetSchemaVersion));
});

test("runtime and generated JSON Schema enforce the same hostile config matrix", () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validateGenerated = ajv.compile(GENERATED_CONFIG_DOCUMENT_SCHEMA as AnySchema);
  const contracts = VALID_CONFIG.contracts as Record<string, unknown>;
  const limits = contracts.limits as Record<string, unknown>;
  const cases: ReadonlyArray<Readonly<{ name: string; value: unknown; accepted: boolean }>> = [
    { name: "current document", value: VALID_CONFIG, accepted: true },
    {
      name: "maximum contract limit",
      value: candidate((value) => {
        ((value.contracts as Record<string, unknown>).limits as Record<string, unknown>)
          .maximumEvents = ROOT_POLICY.contracts.limits.maximumEvents;
      }),
      accepted: true,
    },
    {
      name: "duplicate enabled protocol",
      value: candidate((value) => {
        (value.contracts as Record<string, unknown>).enabledProtocols = [
          "openai-responses",
          "openai-responses",
        ];
      }),
      accepted: false,
    },
    {
      name: "preferred protocol absent",
      value: candidate((value) => {
        (value.contracts as Record<string, unknown>).preferredModelProtocol =
          "openai-chat-completions";
        (value.contracts as Record<string, unknown>).enabledProtocols = ["openai-responses"];
      }),
      accepted: false,
    },
    {
      name: "limit above root ceiling",
      value: candidate((value) => {
        ((value.contracts as Record<string, unknown>).limits as Record<string, unknown>)
          .maximumEvents = ROOT_POLICY.contracts.limits.maximumEvents + 1;
      }),
      accepted: false,
    },
    {
      name: "alignment ceiling widened by document",
      value: candidate((value) => {
        ((value.alignmentCheckpoint as Record<string, unknown>).cadence as Record<string, unknown>)
          .maximumEventsBetweenCheckpoints = ROOT_POLICY.universalPolicyArchitecture.auditMatrix
            .alignmentCheckpoint.configurationLimits.maximumEventsBetweenCheckpoints + 1;
      }),
      accepted: false,
    },
    {
      name: "stale document version",
      value: candidate((value) => { value.schemaVersion = 2; }),
      accepted: false,
    },
    {
      name: "missing repository root capability budget",
      value: candidate((value) => { delete value.repositoryRootCapability; }),
      accepted: false,
    },
    {
      name: "unknown repository root capability budget field",
      value: candidate((value) => {
        (value.repositoryRootCapability as Record<string, unknown>).implicitReset = true;
      }),
      accepted: false,
    },
    {
      name: "stale repository root capability budget version",
      value: candidate((value) => {
        (value.repositoryRootCapability as Record<string, unknown>).schemaVersion =
          "bridlewise-repository-root-capability-budget/v0";
      }),
      accepted: false,
    },
    {
      name: "unknown root field",
      value: candidate((value) => { value.parallelAuthority = true; }),
      accepted: false,
    },
    {
      name: "empty enabled protocols",
      value: candidate((value) => {
        (value.contracts as Record<string, unknown>).enabledProtocols = [];
      }),
      accepted: false,
    },
  ];

  assert.equal(typeof limits.maximumEvents, "number");
  for (const fixture of cases) {
    const runtimeAccepted = CONFIG_DOCUMENT_SCHEMA.safeParse(fixture.value).success;
    const projectionAccepted = validateGenerated(fixture.value) as boolean;
    assert.equal(runtimeAccepted, fixture.accepted, `${fixture.name}: runtime`);
    assert.equal(projectionAccepted, fixture.accepted, `${fixture.name}: generated schema`);
    assert.equal(projectionAccepted, runtimeAccepted, `${fixture.name}: differential`);
  }

  for (const field of REPOSITORY_ROOT_CAPABILITY_LIMIT_FIELDS) {
    for (const fixture of [
      {
        name: "root ceiling",
        value: REPOSITORY_ROOT_CAPABILITY_LIMIT_CEILINGS[field],
        accepted: true,
      },
      {
        name: "above root ceiling",
        value: REPOSITORY_ROOT_CAPABILITY_LIMIT_CEILINGS[field] + 1,
        accepted: false,
      },
      { name: "zero", value: 0, accepted: false },
      { name: "noninteger", value: 1.5, accepted: false },
    ] as const) {
      const value = candidate((document) => {
        (document.repositoryRootCapability as Record<string, unknown>)[field] = fixture.value;
      });
      const runtimeAccepted = CONFIG_DOCUMENT_SCHEMA.safeParse(value).success;
      const projectionAccepted = validateGenerated(value) as boolean;
      assert.equal(runtimeAccepted, fixture.accepted, `${field}/${fixture.name}: runtime`);
      assert.equal(
        projectionAccepted,
        fixture.accepted,
        `${field}/${fixture.name}: generated schema`,
      );
      assert.equal(
        projectionAccepted,
        runtimeAccepted,
        `${field}/${fixture.name}: differential`,
      );
    }
    const omitted = candidate((document) => {
      delete (document.repositoryRootCapability as Record<string, unknown>)[field];
    });
    assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(omitted).success, false, `${field}: runtime omission`);
    assert.equal(validateGenerated(omitted), false, `${field}: generated schema omission`);
  }
});

test("config borrow-limit values are bound to root-policy ceilings and drift is detected", () => {
  const configuredBudget = VALID_CONFIG.repositoryRootCapability;
  for (const field of REPOSITORY_ROOT_CAPABILITY_LIMIT_FIELDS) {
    const ceiling = REPOSITORY_ROOT_CAPABILITY_LIMIT_CEILINGS[field];
    const configured = configuredBudget[field];
    assert.ok(
      configured <= ceiling,
      `${field}: config value ${configured} exceeds root-policy ceiling ${ceiling}`,
    );
  }
  const atCeiling = REPOSITORY_ROOT_CAPABILITY_LIMIT_FIELDS.filter(
    (field) => configuredBudget[field] === REPOSITORY_ROOT_CAPABILITY_LIMIT_CEILINGS[field],
  );
  assert.ok(
    atCeiling.length >= 1,
    "at least one config value should track a root-policy ceiling",
  );
  for (const field of atCeiling) {
    const lowered = structuredClone(ROOT_POLICY) as unknown as ConfigContractPolicyProjection;
    const loweredLimits = (lowered as unknown as MutableRepositoryRootCapabilityBudgetPolicy)
      .verification.testFixtures.repositoryRootCapability.budget.limitCeilings;
    loweredLimits[field] = configuredBudget[field] - 1;
    assert.throws(
      () => buildConfigContract(lowered).runtimeSchema.parse(VALID_CONFIG),
      `${field}: lowering ceiling below config value must invalidate the config`,
    );
  }
  for (const field of REPOSITORY_ROOT_CAPABILITY_LIMIT_FIELDS) {
    const widened = structuredClone(ROOT_POLICY) as unknown as ConfigContractPolicyProjection;
    const widenedLimits = (widened as unknown as MutableRepositoryRootCapabilityBudgetPolicy)
      .verification.testFixtures.repositoryRootCapability.budget.limitCeilings;
    widenedLimits[field] = REPOSITORY_ROOT_CAPABILITY_LIMIT_CEILINGS[field] + 1;
    assert.notEqual(
      buildConfigContract(widened).schemaHash,
      CONFIG_DOCUMENT_SCHEMA_HASH,
      `${field}: widening ceiling must change the generated schema`,
    );
  }
});

// ---------------------------------------------------------------------------
// CONF-1/CONF-2/CONF-3/CONF-5: performance, privacy, memory, and
// tools.allowedCommands sections are centralized in the config document.
// ---------------------------------------------------------------------------

test("CONF-1/2/3: canonical config carries performance, privacy, and memory sections", () => {
  const parsed = CONFIG_DOCUMENT_SCHEMA.parse(VALID_CONFIG);
  assert.ok(parsed.performance, "canonical config must have a performance section");
  assert.ok(parsed.privacy, "canonical config must have a privacy section");
  assert.ok(parsed.memory, "canonical config must have a memory section");
  assert.equal(parsed.performance?.schemaVersion, "bridlewise-performance-config/v1");
  assert.equal(parsed.privacy?.maxContextLines, 10);
  assert.equal(parsed.memory?.contextTokenLimit, 32768);
});

test("CONF-1/2/3: performance, privacy, and memory sections are optional", () => {
  const without = candidate((v) => {
    delete v.performance;
    delete v.privacy;
    delete v.memory;
  });
  assert.ok(CONFIG_DOCUMENT_SCHEMA.safeParse(without).success);
});

test("CONF-1: performance section with wrong schemaVersion is rejected", () => {
  const bad = candidate((v) => {
    (v.performance as Record<string, unknown>).schemaVersion = "bridlewise-performance-config/v0";
  });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(bad).success, false);
});

test("CONF-1: performance sampling rate must be a fraction in [0,1]", () => {
  const bad = candidate((v) => {
    (v.performance as Record<string, unknown>).sampling = { traceSamplingRate: 5, maxTracesPerScope: 1000, maxTraceDepth: 32 };
  });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(bad).success, false);
});

test("CONF-2: privacy section rejects non-integer maxContextLines", () => {
  const bad = candidate((v) => {
    (v.privacy as Record<string, unknown>).maxContextLines = 1.5;
  });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(bad).success, false);
});

test("CONF-2: privacy section rejects trimThreshold-like out-of-range via memory section", () => {
  const bad = candidate((v) => {
    (v.memory as Record<string, unknown>).trimThreshold = 0.3;
  });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(bad).success, false);
});

test("CONF-3: memory section rejects zero contextTokenLimit", () => {
  const bad = candidate((v) => {
    (v.memory as Record<string, unknown>).contextTokenLimit = 0;
  });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(bad).success, false);
});

test("CONF-4: runtime.limits.maximumToolIterations is optional and bounded by root ceiling", () => {
  const parsed = CONFIG_DOCUMENT_SCHEMA.parse(VALID_CONFIG);
  assert.equal(parsed.runtime?.limits?.maximumToolIterations, 10);
  const overCeiling = candidate((v) => {
    (v.runtime as Record<string, unknown>).limits = { maximumToolIterations: ROOT_POLICY.runtime.limits.maximumToolIterations + 1 };
  });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(overCeiling).success, false);
  const withoutLimits = candidate((v) => {
    delete (v.runtime as Record<string, unknown>).limits;
  });
  assert.ok(CONFIG_DOCUMENT_SCHEMA.safeParse(withoutLimits).success);
});

test("CONF-5: tools.allowedCommands is optional and defaults to absent", () => {
  const without = candidate((v) => {
    delete (v.tools as Record<string, unknown>).allowedCommands;
  });
  assert.ok(CONFIG_DOCUMENT_SCHEMA.safeParse(without).success);
  const parsed = CONFIG_DOCUMENT_SCHEMA.parse(VALID_CONFIG);
  assert.ok(Array.isArray(parsed.tools?.allowedCommands));
  assert.ok((parsed.tools?.allowedCommands ?? []).length > 0);
});

test("CONF-5: tools.allowedCommands refuses git and every program launcher by name, typed (src/tools/command-reach.ts)", () => {
  for (const [command, code] of [["git", "tool_command_reaches_git"], ["git-receive-pack", "tool_command_reaches_git"], ["sh", "tool_command_launches_programs"], ["env", "tool_command_launches_programs"], ["xargs", "tool_command_launches_programs"]] as const) {
    const listed = candidate((v) => {
      (v.tools as Record<string, unknown>).allowedCommands = ["echo", command];
    });
    const result = CONFIG_DOCUMENT_SCHEMA.safeParse(listed);
    assert.equal(result.success, false, `${command} was accepted in allowedCommands`);
    assert.deepEqual(result.error.issues.map((issue) => [issue.path.join("."), issue.message.endsWith(`(${code})`)]), [["tools.allowedCommands.1", true]], command);
  }
  assert.equal(CONFIG_DOCUMENT_SCHEMA.parse(VALID_CONFIG).tools?.allowedCommands?.includes("git"), false, "the shipped list holds git");
});

test("CONF-5: tools.allowedCommands rejects duplicate commands", () => {
  const dup = candidate((v) => {
    (v.tools as Record<string, unknown>).allowedCommands = ["echo", "echo"];
  });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(dup).success, false);
});

// ── webUi.quality.lintGate: the lint auto-check's gate basis ──
//
// THE DEFECT THIS GUARDS: the web UI's lint auto-check used to gate its
// pass/warning/failed status on the derived overallScore composite
// (hardcoded >=80 / >=60 cutoffs in the web server's auto-check-runner) —
// an uncalibrated configured index presented as if measured. The gate's
// basis must instead be these explicit, declared thresholds over the
// MEASURED sub-metrics. This test pins the declaration so the thresholds
// cannot silently vanish from the single config home (a missing
// declaration would push consumers back to hardcoded composite cutoffs).

test("QG-1: shipped config declares all four measured lint-gate thresholds", () => {
  const parsed = CONFIG_DOCUMENT_SCHEMA.parse(VALID_CONFIG);
  const gate = parsed.webUi?.quality?.lintGate;
  assert.ok(gate, "webUi.quality.lintGate must be declared in the shipped config (the lint check's gate basis)");
  assert.equal(typeof gate.maxIssuesPerKloc, "number");
  assert.equal(typeof gate.maxComplexityHotspots, "number");
  assert.equal(typeof gate.maxCloneRatio, "number");
  assert.equal(typeof gate.minTypedFileFraction, "number");
});

test("QG-2: lintGate ratio thresholds must be fractions in [0,1]", () => {
  const badClone = candidate((v) => {
    const q = ((v.webUi as Record<string, unknown>).quality as Record<string, unknown>);
    (q.lintGate as Record<string, unknown>).maxCloneRatio = 1.5;
  });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(badClone).success, false);
  const badTyped = candidate((v) => {
    const q = ((v.webUi as Record<string, unknown>).quality as Record<string, unknown>);
    (q.lintGate as Record<string, unknown>).minTypedFileFraction = -0.1;
  });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(badTyped).success, false);
});

test("QG-3: lintGate rejects negative counts and unknown keys", () => {
  const negative = candidate((v) => {
    const q = ((v.webUi as Record<string, unknown>).quality as Record<string, unknown>);
    (q.lintGate as Record<string, unknown>).maxIssuesPerKloc = -1;
  });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(negative).success, false);
  const unknownKey = candidate((v) => {
    const q = ((v.webUi as Record<string, unknown>).quality as Record<string, unknown>);
    (q.lintGate as Record<string, unknown>).minOverallScore = 80;
  });
  assert.equal(
    CONFIG_DOCUMENT_SCHEMA.safeParse(unknownKey).success,
    false,
    "a composite-score threshold must not be smuggled into the lint gate — the gate is defined over measured sub-metrics only",
  );
});

test("a suite watchdog whose stall bound is not below its ceiling, or whose kill grace is not below its stall bound, is refused", () => {
  const testExecution = getConfigDocumentSchema().shape.testExecution.unwrap().shape;
  for (const watchdog of [testExecution.webSuiteWatchdog.unwrap(), testExecution.engineSuiteWatchdog.unwrap()]) {
    assert.equal(watchdog.safeParse({ stallTimeoutMs: 300_000, hardCeilingMs: 1_800_000, killGraceMs: 3_000 }).success, true);
    for (const stallTimeoutMs of [1_800_000, 2_000_000]) {
      const refused = watchdog.safeParse({ stallTimeoutMs, hardCeilingMs: 1_800_000, killGraceMs: 3_000 });
      assert.equal(refused.success, false, `stall ${String(stallTimeoutMs)} with a 1800000 ceiling was accepted`);
      assert.match(JSON.stringify(refused.error?.issues), /stallTimeoutMs must be below hardCeilingMs/u);
    }
    // wf-1b3a-design M7: the grace is the watchdog's own number, never a code constant.
    assert.equal(watchdog.safeParse({ stallTimeoutMs: 300_000, hardCeilingMs: 1_800_000 }).success, false, "a watchdog without its kill grace was accepted");
    for (const killGraceMs of [50_000, 60_000]) {
      const refused = watchdog.safeParse({ stallTimeoutMs: 50_000, hardCeilingMs: 1_800_000, killGraceMs });
      assert.equal(refused.success, false, `a ${String(killGraceMs)} ms grace with a 50000 ms stall bound was accepted`);
      assert.match(JSON.stringify(refused.error?.issues), /killGraceMs must be below stallTimeoutMs/u);
    }
  }
});
