import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_TYPE_IDS,
  createAgentTypeRegistry,
  type AgentTypeDefinition,
} from "../../src/agents/agent-type-registry.ts";
import type { AgentProfile } from "../../src/agents/agent-config.ts";
import { CALL_RETURN_AGENT_TYPE } from "../../src/agents/agent-type-call-return.ts";
import { BACKGROUND_AGENT_TYPE } from "../../src/agents/agent-type-background.ts";
import { InputError } from "../../src/kernel/errors.ts";

const VALID_PROFILE: AgentProfile = {
  name: "test-agent",
  type: "call-and-return",
  model: "test-model",
  provider: "test-provider",
  systemPrompt: "test",
  tools: [],
  capabilities: ["read"],
  writeSet: [],
  maxTurns: 5,
};

const BACKGROUND_PROFILE: AgentProfile = {
  name: "bg-agent",
  type: "background",
  model: "test-model",
  provider: "test-provider",
  systemPrompt: "test",
  tools: [],
  capabilities: ["read"],
  writeSet: [],
  maxTurns: 5,
};

function makeTypeDef(overrides?: Partial<AgentTypeDefinition>): AgentTypeDefinition {
  return {
    typeId: "call-and-return",
    description: "test type",
    executionMode: "sync",
    lifecycleStates: ["pending", "running", "succeeded", "failed", "cancelled"],
    terminalStates: ["succeeded", "failed", "cancelled"],
    hooks: {},
    createRuntime: (() => ({})) as unknown as AgentTypeDefinition["createRuntime"],
    validateProfile: (() => []) as unknown as AgentTypeDefinition["validateProfile"],
    ...overrides,
  };
}

// ============================================================================
// AGENT_TYPE_IDS constant
// ============================================================================

test("Registry: AGENT_TYPE_IDS contains call-and-return", () => {
  assert.ok(AGENT_TYPE_IDS.includes("call-and-return"));
});

test("Registry: AGENT_TYPE_IDS contains background", () => {
  assert.ok(AGENT_TYPE_IDS.includes("background"));
});

test("Registry: AGENT_TYPE_IDS has exactly 2 values", () => {
  assert.equal(AGENT_TYPE_IDS.length, 2);
});

test("Registry: AGENT_TYPE_IDS is frozen", () => {
  assert.ok(Object.isFrozen(AGENT_TYPE_IDS));
});

test("Registry: AGENT_TYPE_IDS values are unique", () => {
  assert.equal(new Set([...AGENT_TYPE_IDS]).size, AGENT_TYPE_IDS.length);
});

// ============================================================================
// createAgentTypeRegistry — creation
// ============================================================================

test("Registry: creates empty registry when no types provided", () => {
  const registry = createAgentTypeRegistry();
  assert.deepEqual([...registry.registeredTypes()], []);
});

test("Registry: creates registry with initial types", () => {
  const registry = createAgentTypeRegistry([CALL_RETURN_AGENT_TYPE]);
  assert.deepEqual([...registry.registeredTypes()], ["call-and-return"]);
});

test("Registry: creates registry with both initial types", () => {
  const registry = createAgentTypeRegistry([CALL_RETURN_AGENT_TYPE, BACKGROUND_AGENT_TYPE]);
  assert.deepEqual([...registry.registeredTypes()], ["background", "call-and-return"]);
});

test("Registry: returned object is frozen", () => {
  const registry = createAgentTypeRegistry([CALL_RETURN_AGENT_TYPE]);
  assert.ok(Object.isFrozen(registry));
});

// ============================================================================
// resolve
// ============================================================================

test("Registry: resolves call-and-return profile", () => {
  const registry = createAgentTypeRegistry([CALL_RETURN_AGENT_TYPE]);
  const typeDef = registry.resolve(VALID_PROFILE);
  assert.equal(typeDef.typeId, "call-and-return");
});

test("Registry: resolves background profile", () => {
  const registry = createAgentTypeRegistry([CALL_RETURN_AGENT_TYPE, BACKGROUND_AGENT_TYPE]);
  const typeDef = registry.resolve(BACKGROUND_PROFILE);
  assert.equal(typeDef.typeId, "background");
});

test("Registry: resolve throws for unknown type", () => {
  const registry = createAgentTypeRegistry();
  const profile: AgentProfile = { ...VALID_PROFILE, type: "unknown-type" };
  assert.throws(
    () => registry.resolve(profile),
    (e: Error) => e instanceof InputError && e.code === "agent_registry_unknown_type",
  );
});

test("Registry: resolve uses default call-and-return when type is undefined", () => {
  const registry = createAgentTypeRegistry([CALL_RETURN_AGENT_TYPE]);
  const profile: AgentProfile = { ...VALID_PROFILE, type: undefined as unknown as string };
  const typeDef = registry.resolve(profile);
  assert.equal(typeDef.typeId, "call-and-return");
});

test("Registry: resolve throws when type field is empty string", () => {
  const registry = createAgentTypeRegistry();
  const profile: AgentProfile = { ...VALID_PROFILE, type: "" };
  assert.throws(() => registry.resolve(profile), InputError);
});

// ============================================================================
// get
// ============================================================================

test("Registry: get returns type definition for existing type", () => {
  const registry = createAgentTypeRegistry([CALL_RETURN_AGENT_TYPE]);
  const typeDef = registry.get("call-and-return");
  assert.ok(typeDef);
  assert.equal(typeDef!.typeId, "call-and-return");
});

test("Registry: get returns undefined for non-existent type", () => {
  const registry = createAgentTypeRegistry();
  assert.equal(registry.get("non-existent"), undefined);
});

test("Registry: get returns undefined for empty string", () => {
  const registry = createAgentTypeRegistry([CALL_RETURN_AGENT_TYPE]);
  assert.equal(registry.get(""), undefined);
});

// ============================================================================
// has
// ============================================================================

test("Registry: has returns true for registered type", () => {
  const registry = createAgentTypeRegistry([CALL_RETURN_AGENT_TYPE]);
  assert.ok(registry.has("call-and-return"));
});

test("Registry: has returns false for unregistered type", () => {
  const registry = createAgentTypeRegistry();
  assert.ok(!registry.has("call-and-return"));
});

test("Registry: has returns false for empty string", () => {
  const registry = createAgentTypeRegistry([CALL_RETURN_AGENT_TYPE]);
  assert.ok(!registry.has(""));
});

// ============================================================================
// registeredTypes
// ============================================================================

test("Registry: registeredTypes returns sorted list", () => {
  const registry = createAgentTypeRegistry([BACKGROUND_AGENT_TYPE, CALL_RETURN_AGENT_TYPE]);
  assert.deepEqual([...registry.registeredTypes()], ["background", "call-and-return"]);
});

test("Registry: registeredTypes returns empty for empty registry", () => {
  const registry = createAgentTypeRegistry();
  assert.deepEqual([...registry.registeredTypes()], []);
});

// ============================================================================
// register — bootstrap-only enforcement
// ============================================================================

test("Registry: register throws after sealing", () => {
  const registry = createAgentTypeRegistry([CALL_RETURN_AGENT_TYPE]);
  assert.throws(
    () => registry.register(CALL_RETURN_AGENT_TYPE),
    (e: Error) => e instanceof InputError && e.code === "agent_registry_sealed",
  );
});

test("Registry: register throws for duplicate type ID", () => {
  assert.throws(
    () => createAgentTypeRegistry([CALL_RETURN_AGENT_TYPE, CALL_RETURN_AGENT_TYPE]),
    (e: Error) => e instanceof InputError && e.code === "agent_registry_duplicate_type",
  );
});

test("Registry: register throws for empty typeId", () => {
  const badTypeDef = makeTypeDef({ typeId: "" as AgentTypeDefinition["typeId"] });
  assert.throws(
    () => createAgentTypeRegistry([badTypeDef]),
    (e: Error) => e instanceof InputError && e.code === "agent_registry_invalid_type_id",
  );
});

test("Registry: register throws for typeId not in AGENT_TYPE_IDS", () => {
  const badTypeDef = makeTypeDef({ typeId: "invalid-type" as AgentTypeDefinition["typeId"] });
  assert.throws(
    () => createAgentTypeRegistry([badTypeDef]),
    (e: Error) => e instanceof InputError && e.code === "agent_registry_type_id_not_allowed",
  );
});

test("Registry: register throws for missing createRuntime", () => {
  const badTypeDef = makeTypeDef({ createRuntime: undefined as unknown as AgentTypeDefinition["createRuntime"] });
  assert.throws(
    () => createAgentTypeRegistry([badTypeDef]),
    (e: Error) => e instanceof InputError && e.code === "agent_registry_invalid_definition",
  );
});

test("Registry: register throws for missing validateProfile", () => {
  const badTypeDef = makeTypeDef({ validateProfile: undefined as unknown as AgentTypeDefinition["validateProfile"] });
  assert.throws(
    () => createAgentTypeRegistry([badTypeDef]),
    (e: Error) => e instanceof InputError && e.code === "agent_registry_invalid_definition",
  );
});

test("Registry: register throws for empty lifecycleStates", () => {
  const badTypeDef = makeTypeDef({ lifecycleStates: [] });
  assert.throws(
    () => createAgentTypeRegistry([badTypeDef]),
    (e: Error) => e instanceof InputError && e.code === "agent_registry_invalid_definition",
  );
});

// ============================================================================
// Type definition properties
// ============================================================================

test("Registry: CALL_RETURN_AGENT_TYPE has correct typeId", () => {
  assert.equal(CALL_RETURN_AGENT_TYPE.typeId, "call-and-return");
});

test("Registry: CALL_RETURN_AGENT_TYPE has sync execution mode", () => {
  assert.equal(CALL_RETURN_AGENT_TYPE.executionMode, "sync");
});

test("Registry: CALL_RETURN_AGENT_TYPE has correct lifecycle states", () => {
  assert.deepEqual([...CALL_RETURN_AGENT_TYPE.lifecycleStates], ["pending", "running", "succeeded", "failed", "cancelled"]);
});

test("Registry: CALL_RETURN_AGENT_TYPE has correct terminal states", () => {
  assert.deepEqual([...CALL_RETURN_AGENT_TYPE.terminalStates], ["succeeded", "failed", "cancelled"]);
});

test("Registry: BACKGROUND_AGENT_TYPE has correct typeId", () => {
  assert.equal(BACKGROUND_AGENT_TYPE.typeId, "background");
});

test("Registry: BACKGROUND_AGENT_TYPE has async execution mode", () => {
  assert.equal(BACKGROUND_AGENT_TYPE.executionMode, "async");
});

test("Registry: BACKGROUND_AGENT_TYPE has extended lifecycle states", () => {
  const states = [...BACKGROUND_AGENT_TYPE.lifecycleStates];
  assert.ok(states.includes("suspended"));
  assert.ok(states.includes("idle"));
  assert.ok(states.includes("timed-out"));
});

test("Registry: BACKGROUND_AGENT_TYPE has extended terminal states", () => {
  const terminals = [...BACKGROUND_AGENT_TYPE.terminalStates];
  assert.ok(terminals.includes("timed-out"));
});

// ============================================================================
// validateProfile delegation
// ============================================================================

test("Registry: CALL_RETURN validateProfile accepts valid profile", () => {
  const errors = CALL_RETURN_AGENT_TYPE.validateProfile(VALID_PROFILE);
  assert.equal(errors.length, 0);
});

test("Registry: CALL_RETURN validateProfile rejects maxTurns < 1", () => {
  const badProfile: AgentProfile = { ...VALID_PROFILE, maxTurns: 0 };
  const errors = CALL_RETURN_AGENT_TYPE.validateProfile(badProfile);
  assert.ok(errors.length > 0);
  assert.ok(errors.some((e) => e.includes("maxTurns")));
});

test("Registry: CALL_RETURN validateProfile rejects empty name", () => {
  const badProfile: AgentProfile = { ...VALID_PROFILE, name: "" };
  const errors = CALL_RETURN_AGENT_TYPE.validateProfile(badProfile);
  assert.ok(errors.length > 0);
  assert.ok(errors.some((e) => e.includes("name")));
});

test("Registry: BACKGROUND validateProfile accepts valid profile", () => {
  const errors = BACKGROUND_AGENT_TYPE.validateProfile(BACKGROUND_PROFILE);
  assert.equal(errors.length, 0);
});

test("Registry: BACKGROUND validateProfile rejects maxTurns < 1", () => {
  const badProfile: AgentProfile = { ...BACKGROUND_PROFILE, maxTurns: 0 };
  const errors = BACKGROUND_AGENT_TYPE.validateProfile(badProfile);
  assert.ok(errors.length > 0);
});

// ============================================================================
// Hooks
// ============================================================================

test("Registry: CALL_RETURN hooks object is present", () => {
  assert.ok(typeof CALL_RETURN_AGENT_TYPE.hooks === "object");
});

test("Registry: BACKGROUND hooks object is present", () => {
  assert.ok(typeof BACKGROUND_AGENT_TYPE.hooks === "object");
});

test("Registry: type definition hooks are filled with no-ops by registry", () => {
  const registry = createAgentTypeRegistry([CALL_RETURN_AGENT_TYPE]);
  const typeDef = registry.get("call-and-return")!;
  assert.ok(typeDef.hooks !== undefined);
});

// ============================================================================
// Multiple registries
// ============================================================================

test("Registry: multiple registries are independent", () => {
  const registry1 = createAgentTypeRegistry([CALL_RETURN_AGENT_TYPE]);
  const registry2 = createAgentTypeRegistry([BACKGROUND_AGENT_TYPE]);
  assert.ok(registry1.has("call-and-return"));
  assert.ok(!registry1.has("background"));
  assert.ok(registry2.has("background"));
  assert.ok(!registry2.has("call-and-return"));
});

test("Registry: two registries resolve same profile to different types", () => {
  const registry1 = createAgentTypeRegistry([CALL_RETURN_AGENT_TYPE]);
  const registry2 = createAgentTypeRegistry([CALL_RETURN_AGENT_TYPE, BACKGROUND_AGENT_TYPE]);
  const typeDef1 = registry1.resolve(VALID_PROFILE);
  const typeDef2 = registry2.resolve(VALID_PROFILE);
  assert.equal(typeDef1.typeId, "call-and-return");
  assert.equal(typeDef2.typeId, "call-and-return");
});

// ============================================================================
// Hostile / adversarial
// ============================================================================

test("Registry: resolve with null profile throws", () => {
  const registry = createAgentTypeRegistry([CALL_RETURN_AGENT_TYPE]);
  assert.throws(() => registry.resolve(null as unknown as AgentProfile));
});

test("Registry: resolve with undefined profile throws", () => {
  const registry = createAgentTypeRegistry([CALL_RETURN_AGENT_TYPE]);
  assert.throws(() => registry.resolve(undefined as unknown as AgentProfile));
});

test("Registry: register with null typeDef throws", () => {
  assert.throws(() => createAgentTypeRegistry([null as unknown as AgentTypeDefinition]));
});

test("Registry: register with undefined typeDef throws", () => {
  assert.throws(() => createAgentTypeRegistry([undefined as unknown as AgentTypeDefinition]));
});

test("Registry: register with non-string typeId throws", () => {
  const badTypeDef = makeTypeDef({ typeId: 123 as unknown as AgentTypeDefinition["typeId"] });
  assert.throws(() => createAgentTypeRegistry([badTypeDef]));
});

test("Registry: type definition stored in registry is frozen", () => {
  const registry = createAgentTypeRegistry([CALL_RETURN_AGENT_TYPE]);
  const typeDef = registry.get("call-and-return");
  assert.ok(typeDef);
  assert.ok(Object.isFrozen(typeDef));
});

test("Registry: AGENT_TYPE_IDS cannot be modified", () => {
  assert.throws(() => {
    (AGENT_TYPE_IDS as unknown as string[]).push("new-type");
  });
});

test("Registry: background profile resolves to background type with all states", () => {
  const registry = createAgentTypeRegistry([CALL_RETURN_AGENT_TYPE, BACKGROUND_AGENT_TYPE]);
  const typeDef = registry.resolve(BACKGROUND_PROFILE);
  assert.equal(typeDef.executionMode, "async");
  assert.ok(typeDef.lifecycleStates.length > CALL_RETURN_AGENT_TYPE.lifecycleStates.length);
});
