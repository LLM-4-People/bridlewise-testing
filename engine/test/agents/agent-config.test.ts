import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveAgentsConfig,
  createProviderModelResolver,
  validateAgentsConfig,
  getAgentProfile,
  hasCapability,
  isPathInWriteSet,
  detectWriteSetConflict,
  type AgentProfile,
} from "../../src/agents/agent-config.ts";
import { AGENT_CAPABILITY_CATALOG } from "../../src/kernel/config-contracts.ts";
import { getConfigDocumentSchema } from "../../src/kernel/config-contracts.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { scratchAgentsConfigDocument } from "../support/scratch-runtime-config.ts";

const CONFIG_DOCUMENT_SCHEMA = getConfigDocumentSchema();

// The checked-in config deliberately ships NO provider (the provider
// decision), so this fixture declares its own scratch one — the real
// document with the runtime and every profile pointed at a scratch
// provider/model. See the helper for the reasoning; everything else about
// the document (limits, schema validation, profile names/tools/writeSets)
// stays the real thing.
const VALID_CONFIG = scratchAgentsConfigDocument();

// Derive provider/model values from the fixture (single source of truth).
// Hardcoding provider/model IDs would drift the moment the fixture changes —
// the test must read them dynamically.
const RUNTIME = VALID_CONFIG.runtime!;
const FIRST_PROVIDER = RUNTIME.providers[0]!;
const FIRST_PROVIDER_ID = FIRST_PROVIDER.id;
const FIRST_MODEL = FIRST_PROVIDER.models[0]!;
const FIRST_MODEL_ID = FIRST_MODEL.id;
const ALL_PROVIDER_IDS = RUNTIME.providers.map((p) => p.id).toSorted();
const FIRST_PROVIDER_MODEL_IDS = FIRST_PROVIDER.models.map((m) => m.id).toSorted();
const CONFIG_RESEARCHER = VALID_CONFIG.agents!.profiles[0]!;

function configWith(mutator: (c: Record<string, unknown>) => void): typeof VALID_CONFIG {
  const clone = structuredClone(VALID_CONFIG) as unknown as Record<string, unknown>;
  mutator(clone);
  return CONFIG_DOCUMENT_SCHEMA.parse(clone) as typeof VALID_CONFIG;
}

function rawConfigWith(mutator: (c: Record<string, unknown>) => void): Record<string, unknown> {
  const clone = structuredClone(VALID_CONFIG) as unknown as Record<string, unknown>;
  mutator(clone);
  return clone;
}

const RESEARCHER_PROFILE: AgentProfile = {
  name: "researcher", type: "call-and-return",
  model: FIRST_MODEL_ID,
  provider: FIRST_PROVIDER_ID,
  systemPrompt: "You are a research agent.",
  tools: ["read_file", "list_files"],
  capabilities: ["read"],
  writeSet: [],
  maxTurns: 10,
};

const IMPLEMENTER_PROFILE: AgentProfile = {
  name: "implementer", type: "call-and-return",
  model: FIRST_MODEL_ID,
  provider: FIRST_PROVIDER_ID,
  systemPrompt: "You are an implementer.",
  tools: ["read_file", "list_files"],
  capabilities: ["read", "write"],
  writeSet: ["src/"],
  maxTurns: 20,
};

// ============================================================================
// resolveAgentsConfig
// ============================================================================

test("Agent config: resolves agents config from valid document", () => {
  const config = resolveAgentsConfig(VALID_CONFIG);
  assert.ok(config);
  assert.equal(config!.maximumConcurrentAgents, 3);
  assert.equal(config!.profiles.length, 3);
  assert.equal(config!.profiles[0]!.name, "researcher");
  assert.equal(config!.profiles[1]!.name, "implementer");
  assert.equal(config!.profiles[2]!.name, "reviewer");
  assert.equal(config!.orchestration.alignmentMonitorIntervalMs, 30000);
  assert.equal(config!.orchestration.conflictDetectionEnabled, true);
});

test("Agent config: returns undefined when agents section is absent", () => {
  const doc = configWith((c) => { delete c.agents; });
  const config = resolveAgentsConfig(doc);
  assert.equal(config, undefined);
});

test("Agent config: resolved profiles are frozen", () => {
  const config = resolveAgentsConfig(VALID_CONFIG);
  assert.ok(config);
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config!.profiles));
  assert.ok(Object.isFrozen(config!.profiles[0]));
  assert.ok(Object.isFrozen(config!.profiles[0]!.tools));
  assert.ok(Object.isFrozen(config!.profiles[0]!.capabilities));
  assert.ok(Object.isFrozen(config!.profiles[0]!.writeSet));
});

test("Agent config: resolved orchestration is frozen", () => {
  const config = resolveAgentsConfig(VALID_CONFIG);
  assert.ok(config);
  assert.ok(Object.isFrozen(config!.orchestration));
});

test("Agent config: profiles preserve all fields", () => {
  const config = resolveAgentsConfig(VALID_CONFIG);
  assert.ok(config);
  const researcher = config!.profiles.find(p => p.name === "researcher")!;
  assert.equal(researcher.model, CONFIG_RESEARCHER.model);
  assert.equal(researcher.provider, CONFIG_RESEARCHER.provider);
  assert.equal(researcher.systemPrompt, "You are a research agent. Read files and gather information. Do not modify files.");
  assert.deepEqual([...researcher.tools], ["read_file", "list_files"]);
  assert.deepEqual([...researcher.capabilities], ["read"]);
  assert.deepEqual([...researcher.writeSet], []);
  assert.equal(researcher.maxTurns, 10);
});

// ============================================================================
// createProviderModelResolver
// ============================================================================

test("Agent config: resolver resolves valid provider/model", () => {
  const resolver = createProviderModelResolver(VALID_CONFIG);
  const result = resolver.resolve(RESEARCHER_PROFILE);
  assert.equal(result.providerId, FIRST_PROVIDER_ID);
  assert.equal(result.modelId, FIRST_MODEL_ID);
  assert.equal(result.maxTokens, FIRST_MODEL.maxTokens);
  assert.equal(result.temperature, FIRST_MODEL.temperature);
});

test("Agent config: resolver throws for unknown provider", () => {
  const resolver = createProviderModelResolver(VALID_CONFIG);
  const profile: AgentProfile = { ...RESEARCHER_PROFILE, provider: "unknown" };
  assert.throws(() => resolver.resolve(profile), /unknown provider/);
});

test("Agent config: resolver throws for unknown model", () => {
  const resolver = createProviderModelResolver(VALID_CONFIG);
  const profile: AgentProfile = { ...RESEARCHER_PROFILE, model: "unknown-model" };
  assert.throws(() => resolver.resolve(profile), /unknown model/);
});

test("Agent config: resolver lists provider ids", () => {
  const resolver = createProviderModelResolver(VALID_CONFIG);
  const ids = resolver.providerIds();
  assert.deepEqual(ids, ALL_PROVIDER_IDS);
});

test("Agent config: resolver lists model ids for provider", () => {
  const resolver = createProviderModelResolver(VALID_CONFIG);
  const ids = resolver.modelIds(FIRST_PROVIDER_ID);
  assert.deepEqual(ids, FIRST_PROVIDER_MODEL_IDS);
});

test("Agent config: resolver returns empty for unknown provider model ids", () => {
  const resolver = createProviderModelResolver(VALID_CONFIG);
  assert.deepEqual(resolver.modelIds("unknown"), []);
});

test("Agent config: resolver throws when runtime section is missing", () => {
  const doc = configWith((c) => { delete c.runtime; });
  assert.throws(() => createProviderModelResolver(doc), /no 'runtime' section/);
});

test("Agent config: resolver result is frozen", () => {
  const resolver = createProviderModelResolver(VALID_CONFIG);
  const result = resolver.resolve(RESEARCHER_PROFILE);
  assert.ok(Object.isFrozen(result));
});

// ============================================================================
// validateAgentsConfig
// ============================================================================

test("Agent config: validate returns valid for correct config", () => {
  const result = validateAgentsConfig(VALID_CONFIG);
  assert.equal(result.valid, true);
  if (result.valid) {
    assert.ok(result.config);
    assert.ok(result.resolver);
  }
});

test("Agent config: validate returns valid when agents section absent", () => {
  const doc = configWith((c) => { delete c.agents; });
  const result = validateAgentsConfig(doc);
  assert.equal(result.valid, true);
  if (result.valid) {
    assert.equal(result.config.profiles.length, 0);
  }
});

test("Agent config: validate returns errors for unknown provider", () => {
  const doc = configWith((c) => {
    const profiles = (c.agents as Record<string, unknown>).profiles as unknown[];
    (profiles[0] as Record<string, unknown>).provider = "unknown-provider";
  });
  const result = validateAgentsConfig(doc);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.ok(result.errors.length > 0);
    assert.ok(result.errors.some(e => e.includes("unknown provider")));
  }
});

test("Agent config: validate returns errors for unknown model", () => {
  const doc = configWith((c) => {
    const profiles = (c.agents as Record<string, unknown>).profiles as unknown[];
    (profiles[0] as Record<string, unknown>).model = "unknown-model";
  });
  const result = validateAgentsConfig(doc);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.ok(result.errors.some(e => e.includes("unknown model")));
  }
});

// ============================================================================
// getAgentProfile
// ============================================================================

test("Agent config: getAgentProfile returns existing profile", () => {
  const config = resolveAgentsConfig(VALID_CONFIG)!;
  const profile = getAgentProfile(config, "researcher");
  assert.equal(profile.name, "researcher");
});

test("Agent config: getAgentProfile throws for missing profile", () => {
  const config = resolveAgentsConfig(VALID_CONFIG)!;
  assert.throws(() => getAgentProfile(config, "nonexistent"), /not configured/);
});

// ============================================================================
// hasCapability
// ============================================================================

test("Agent config: hasCapability returns true for configured capability", () => {
  assert.equal(hasCapability(RESEARCHER_PROFILE, "read"), true);
});

test("Agent config: hasCapability returns false for unconfigured capability", () => {
  assert.equal(hasCapability(RESEARCHER_PROFILE, "write"), false);
});

test("Agent config: hasCapability returns true for multiple capabilities", () => {
  assert.equal(hasCapability(IMPLEMENTER_PROFILE, "read"), true);
  assert.equal(hasCapability(IMPLEMENTER_PROFILE, "write"), true);
  assert.equal(hasCapability(IMPLEMENTER_PROFILE, "execute"), false);
  assert.equal(hasCapability(IMPLEMENTER_PROFILE, "delegate"), false);
});

test("Agent config: hasCapability handles all capability types", () => {
  const fullProfile: AgentProfile = {
    ...IMPLEMENTER_PROFILE,
    capabilities: ["read", "write", "execute", "delegate"],
  };
  assert.equal(hasCapability(fullProfile, "read"), true);
  assert.equal(hasCapability(fullProfile, "write"), true);
  assert.equal(hasCapability(fullProfile, "execute"), true);
  assert.equal(hasCapability(fullProfile, "delegate"), true);
});

// ============================================================================
// isPathInWriteSet
// ============================================================================

test("Agent config: isPathInWriteSet returns false for empty write set", () => {
  assert.equal(isPathInWriteSet(RESEARCHER_PROFILE, "src/foo.ts"), false);
});

test("Agent config: isPathInWriteSet returns true for path within prefix", () => {
  assert.equal(isPathInWriteSet(IMPLEMENTER_PROFILE, "src/foo.ts"), true);
  assert.equal(isPathInWriteSet(IMPLEMENTER_PROFILE, "src/agents/runtime.ts"), true);
});

test("Agent config: isPathInWriteSet returns false for path outside prefix", () => {
  assert.equal(isPathInWriteSet(IMPLEMENTER_PROFILE, "test/foo.test.ts"), false);
  assert.equal(isPathInWriteSet(IMPLEMENTER_PROFILE, "docs/readme.md"), false);
});

test("Agent config: isPathInWriteSet returns true for exact match", () => {
  const profile: AgentProfile = { ...IMPLEMENTER_PROFILE, writeSet: ["src/agents/agent-runtime.ts"] };
  assert.equal(isPathInWriteSet(profile, "src/agents/agent-runtime.ts"), true);
});

test("Agent config: isPathInWriteSet handles prefix without trailing slash", () => {
  const profile: AgentProfile = { ...IMPLEMENTER_PROFILE, writeSet: ["src"] };
  assert.equal(isPathInWriteSet(profile, "src/foo.ts"), true);
  assert.equal(isPathInWriteSet(profile, "src"), true);
  assert.equal(isPathInWriteSet(profile, "srctest/foo.ts"), false);
});

test("Agent config: isPathInWriteSet handles multiple prefixes", () => {
  const profile: AgentProfile = { ...IMPLEMENTER_PROFILE, writeSet: ["src/", "test/"] };
  assert.equal(isPathInWriteSet(profile, "src/foo.ts"), true);
  assert.equal(isPathInWriteSet(profile, "test/bar.test.ts"), true);
  assert.equal(isPathInWriteSet(profile, "docs/baz.md"), false);
});

// ============================================================================
// detectWriteSetConflict
// ============================================================================

test("Agent config: detectWriteSetConflict returns no conflicts for disjoint write sets", () => {
  const profiles: AgentProfile[] = [
    { ...IMPLEMENTER_PROFILE, name: "a", writeSet: ["src/"] },
    { ...IMPLEMENTER_PROFILE, name: "b", writeSet: ["test/"] },
  ];
  const result = detectWriteSetConflict(profiles);
  assert.equal(result.conflicts.length, 0);
});

test("Agent config: detectWriteSetConflict detects identical paths", () => {
  const profiles: AgentProfile[] = [
    { ...IMPLEMENTER_PROFILE, name: "a", writeSet: ["src/"] },
    { ...IMPLEMENTER_PROFILE, name: "b", writeSet: ["src/"] },
  ];
  const result = detectWriteSetConflict(profiles);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0]!.agentA, "a");
  assert.equal(result.conflicts[0]!.agentB, "b");
});

test("Agent config: detectWriteSetConflict detects overlapping paths", () => {
  const profiles: AgentProfile[] = [
    { ...IMPLEMENTER_PROFILE, name: "a", writeSet: ["src/"] },
    { ...IMPLEMENTER_PROFILE, name: "b", writeSet: ["src/agents/"] },
  ];
  const result = detectWriteSetConflict(profiles);
  assert.equal(result.conflicts.length, 1);
});

test("Agent config: detectWriteSetConflict ignores empty write sets", () => {
  const profiles: AgentProfile[] = [
    { ...IMPLEMENTER_PROFILE, name: "a", writeSet: [] },
    { ...IMPLEMENTER_PROFILE, name: "b", writeSet: ["src/"] },
  ];
  const result = detectWriteSetConflict(profiles);
  assert.equal(result.conflicts.length, 0);
});

test("Agent config: detectWriteSetConflict handles single profile", () => {
  const result = detectWriteSetConflict([IMPLEMENTER_PROFILE]);
  assert.equal(result.conflicts.length, 0);
});

test("Agent config: detectWriteSetConflict handles empty profiles array", () => {
  const result = detectWriteSetConflict([]);
  assert.equal(result.conflicts.length, 0);
});

test("Agent config: detectWriteSetConflict detects multiple conflicts", () => {
  const profiles: AgentProfile[] = [
    { ...IMPLEMENTER_PROFILE, name: "a", writeSet: ["src/", "test/"] },
    { ...IMPLEMENTER_PROFILE, name: "b", writeSet: ["src/"] },
    { ...IMPLEMENTER_PROFILE, name: "c", writeSet: ["test/"] },
  ];
  const result = detectWriteSetConflict(profiles);
  assert.equal(result.conflicts.length, 2);
});

test("Agent config: detectWriteSetConflict result is frozen", () => {
  const result = detectWriteSetConflict([IMPLEMENTER_PROFILE]);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.conflicts));
});

// ============================================================================
// Agent capability catalog
// ============================================================================

test("Agent config: capability catalog contains expected values", () => {
  assert.deepEqual([...AGENT_CAPABILITY_CATALOG], ["read", "write", "execute", "delegate"]);
});

test("Agent config: capability catalog is frozen", () => {
  assert.ok(Object.isFrozen(AGENT_CAPABILITY_CATALOG));
});

// ============================================================================
// Schema validation hostile cases
// ============================================================================

test("Agent config: schema rejects duplicate agent names", () => {
  const doc = rawConfigWith((c) => {
    const profiles = (c.agents as Record<string, unknown>).profiles as unknown[];
    (profiles[1] as Record<string, unknown>).name = "researcher";
  });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(doc).success, false);
});

test("Agent config: schema rejects duplicate tools in agent", () => {
  const doc = rawConfigWith((c) => {
    const profiles = (c.agents as Record<string, unknown>).profiles as unknown[];
    (profiles[0] as Record<string, unknown>).tools = ["read_file", "read_file"];
  });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(doc).success, false);
});

test("Agent config: schema rejects duplicate capabilities in agent", () => {
  const doc = rawConfigWith((c) => {
    const profiles = (c.agents as Record<string, unknown>).profiles as unknown[];
    (profiles[1] as Record<string, unknown>).capabilities = ["read", "read", "write"];
  });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(doc).success, false);
});

test("Agent config: schema rejects duplicate write set paths", () => {
  const doc = rawConfigWith((c) => {
    const profiles = (c.agents as Record<string, unknown>).profiles as unknown[];
    (profiles[1] as Record<string, unknown>).writeSet = ["src/", "src/"];
  });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(doc).success, false);
});

test("Agent config: schema rejects unknown capability value", () => {
  const doc = rawConfigWith((c) => {
    const profiles = (c.agents as Record<string, unknown>).profiles as unknown[];
    (profiles[0] as Record<string, unknown>).capabilities = ["hack"];
  });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(doc).success, false);
});

test("Agent config: schema rejects empty agent name", () => {
  const doc = rawConfigWith((c) => {
    const profiles = (c.agents as Record<string, unknown>).profiles as unknown[];
    (profiles[0] as Record<string, unknown>).name = "";
  });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(doc).success, false);
});

test("Agent config: schema rejects agent name with special characters", () => {
  const doc = rawConfigWith((c) => {
    const profiles = (c.agents as Record<string, unknown>).profiles as unknown[];
    (profiles[0] as Record<string, unknown>).name = "agent/../../etc";
  });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(doc).success, false);
});

test("Agent config: schema rejects maxTurns of zero", () => {
  const doc = rawConfigWith((c) => {
    const profiles = (c.agents as Record<string, unknown>).profiles as unknown[];
    (profiles[0] as Record<string, unknown>).maxTurns = 0;
  });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(doc).success, false);
});

test("Agent config: schema rejects maxTurns exceeding ceiling", () => {
  const doc = rawConfigWith((c) => {
    const profiles = (c.agents as Record<string, unknown>).profiles as unknown[];
    (profiles[0] as Record<string, unknown>).maxTurns = ROOT_POLICY.runtime.limits.maximumAgentMaxTurns + 1;
  });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(doc).success, false);
});

test("Agent config: schema rejects maximumConcurrentAgents exceeding ceiling", () => {
  const doc = rawConfigWith((c) => {
    (c.agents as Record<string, unknown>).maximumConcurrentAgents = ROOT_POLICY.runtime.limits.maximumAgents + 1;
  });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(doc).success, false);
});

test("Agent config: schema rejects more than maximumAgents profiles", () => {
  const doc = rawConfigWith((c) => {
    const agents = c.agents as Record<string, unknown>;
    const profiles = agents.profiles as unknown[];
    while (profiles.length <= ROOT_POLICY.runtime.limits.maximumAgents) {
      profiles.push(structuredClone(profiles[0]));
    }
  });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(doc).success, false);
});

test("Agent config: schema accepts config at maximum agent count", () => {
  const doc = rawConfigWith((c) => {
    const agents = c.agents as Record<string, unknown>;
    agents.maximumConcurrentAgents = ROOT_POLICY.runtime.limits.maximumAgents;
  });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(doc).success, true);
});

test("Agent config: schema accepts zero concurrent agents", () => {
  const doc = rawConfigWith((c) => {
    (c.agents as Record<string, unknown>).maximumConcurrentAgents = 0;
  });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(doc).success, true);
});

test("Agent config: schema rejects maximumConcurrentAgents exceeding root ceiling", () => {
  const doc = rawConfigWith((c) => {
    const agents = c.agents as Record<string, unknown>;
    agents.maximumConcurrentAgents = ROOT_POLICY.runtime.limits.maximumAgents + 1;
  });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(doc).success, false);
});

test("Agent config: schema rejects unknown field in agents section", () => {
  const doc = rawConfigWith((c) => {
    (c.agents as Record<string, unknown>).unknownField = true;
  });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(doc).success, false);
});

test("Agent config: schema rejects unknown field in agent profile", () => {
  const doc = rawConfigWith((c) => {
    const profiles = (c.agents as Record<string, unknown>).profiles as unknown[];
    (profiles[0] as Record<string, unknown>).extra = "bad";
  });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(doc).success, false);
});

test("Agent config: schema rejects unknown field in orchestration", () => {
  const doc = rawConfigWith((c) => {
    const orch = (c.agents as Record<string, unknown>).orchestration as Record<string, unknown>;
    orch.extra = true;
  });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(doc).success, false);
});

test("Agent config: schema accepts optional agents section", () => {
  const doc = rawConfigWith((c) => { delete c.agents; });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(doc).success, true);
});

test("Agent config: schema rejects empty profiles array when maximumConcurrentAgents > 0", () => {
  const doc = rawConfigWith((c) => {
    const agents = c.agents as Record<string, unknown>;
    agents.profiles = [];
    agents.maximumConcurrentAgents = 0;
  });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(doc).success, true);
});

test("Agent config: schema rejects system prompt exceeding ceiling", () => {
  const doc = rawConfigWith((c) => {
    const profiles = (c.agents as Record<string, unknown>).profiles as unknown[];
    (profiles[0] as Record<string, unknown>).systemPrompt = "x".repeat(ROOT_POLICY.runtime.limits.maximumSystemPromptBytes + 1);
  });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(doc).success, false);
});

test("Agent config: schema accepts system prompt at ceiling", () => {
  const doc = rawConfigWith((c) => {
    const profiles = (c.agents as Record<string, unknown>).profiles as unknown[];
    (profiles[0] as Record<string, unknown>).systemPrompt = "x".repeat(ROOT_POLICY.runtime.limits.maximumSystemPromptBytes);
  });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(doc).success, true);
});

// ============================================================================
// Agent type field (D20)
// ============================================================================

test("Agent config: resolved profiles include type field", () => {
  const config = resolveAgentsConfig(VALID_CONFIG);
  assert.ok(config);
  for (const profile of config!.profiles) {
    assert.ok(typeof profile.type === "string");
    assert.ok(profile.type.length > 0);
  }
});

test("Agent config: type defaults to call-and-return when not specified", () => {
  const doc = rawConfigWith((c) => {
    const profiles = (c.agents as Record<string, unknown>).profiles as unknown[];
    delete (profiles[0] as Record<string, unknown>).type;
  });
  const parsed = CONFIG_DOCUMENT_SCHEMA.safeParse(doc);
  assert.ok(parsed.success);
  if (parsed.success) {
    const config = resolveAgentsConfig(parsed.data);
    assert.ok(config);
    assert.equal(config!.profiles[0]!.type, "call-and-return");
  }
});

test("Agent config: type call-and-return parses correctly", () => {
  const doc = rawConfigWith((c) => {
    const profiles = (c.agents as Record<string, unknown>).profiles as unknown[];
    (profiles[0] as Record<string, unknown>).type = "call-and-return";
  });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(doc).success, true);
});

test("Agent config: type background parses correctly", () => {
  const doc = rawConfigWith((c) => {
    const profiles = (c.agents as Record<string, unknown>).profiles as unknown[];
    (profiles[0] as Record<string, unknown>).type = "background";
  });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(doc).success, true);
});

test("Agent config: unknown type is rejected", () => {
  const doc = rawConfigWith((c) => {
    const profiles = (c.agents as Record<string, unknown>).profiles as unknown[];
    (profiles[0] as Record<string, unknown>).type = "unknown-type";
  });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(doc).success, false);
});

test("Agent config: empty type is rejected", () => {
  const doc = rawConfigWith((c) => {
    const profiles = (c.agents as Record<string, unknown>).profiles as unknown[];
    (profiles[0] as Record<string, unknown>).type = "";
  });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(doc).success, false);
});

test("Agent config: type null is rejected", () => {
  const doc = rawConfigWith((c) => {
    const profiles = (c.agents as Record<string, unknown>).profiles as unknown[];
    (profiles[0] as Record<string, unknown>).type = null;
  });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(doc).success, false);
});

test("Agent config: mixed types parse correctly", () => {
  const doc = rawConfigWith((c) => {
    const profiles = (c.agents as Record<string, unknown>).profiles as unknown[];
    (profiles[0] as Record<string, unknown>).type = "call-and-return";
    (profiles[1] as Record<string, unknown>).type = "background";
  });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(doc).success, true);
});

test("Agent config: backgroundTimeoutMs parses correctly", () => {
  const doc = rawConfigWith((c) => {
    const profiles = (c.agents as Record<string, unknown>).profiles as unknown[];
    (profiles[0] as Record<string, unknown>).backgroundTimeoutMs = 60000;
  });
  const parsed = CONFIG_DOCUMENT_SCHEMA.safeParse(doc);
  assert.ok(parsed.success);
  if (parsed.success) {
    const config = resolveAgentsConfig(parsed.data);
    assert.ok(config);
    assert.equal(config!.profiles[0]!.backgroundTimeoutMs, 60000);
  }
});

test("Agent config: backgroundTimeoutMs is optional", () => {
  const config = resolveAgentsConfig(VALID_CONFIG);
  assert.ok(config);
  assert.equal(config!.profiles[0]!.backgroundTimeoutMs, undefined);
});

test("Agent config: backgroundTimeoutMs negative is rejected", () => {
  const doc = rawConfigWith((c) => {
    const profiles = (c.agents as Record<string, unknown>).profiles as unknown[];
    (profiles[0] as Record<string, unknown>).backgroundTimeoutMs = -1;
  });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(doc).success, false);
});

test("Agent config: backgroundTimeoutMs zero is rejected", () => {
  const doc = rawConfigWith((c) => {
    const profiles = (c.agents as Record<string, unknown>).profiles as unknown[];
    (profiles[0] as Record<string, unknown>).backgroundTimeoutMs = 0;
  });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(doc).success, false);
});

test("Agent config: AgentProfile type field is accessible", () => {
  const profile = getAgentProfile(resolveAgentsConfig(VALID_CONFIG)!, "researcher");
  assert.ok(profile.type);
});

test("Agent config: resolved profile with type is frozen", () => {
  const config = resolveAgentsConfig(VALID_CONFIG);
  assert.ok(config);
  assert.ok(Object.isFrozen(config!.profiles[0]));
});

test("Agent profile tools: empty authority and explicit all remain distinct after config resolution", () => {
  for (const tools of [[], "all"] as const) {
    const raw = structuredClone(scratchAgentsConfigDocument());
    const profile = raw.agents!.profiles[0]!;
    const parsed = CONFIG_DOCUMENT_SCHEMA.parse({ ...raw, agents: { ...raw.agents!, profiles: [{ ...profile, tools }] } });
    assert.deepEqual(resolveAgentsConfig(parsed)!.profiles[0]!.tools, tools);
  }
});
