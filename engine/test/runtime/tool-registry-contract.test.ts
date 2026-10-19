import assert from "node:assert/strict";
import test from "node:test";

import { createToolRegistry, type ToolRegistry } from "../../src/runtime/tool-registry.ts";
import { makeRegisteredTool } from "../support/factories.ts";

/**
 * ToolRegistry contract (GAP-17).
 *
 * A generic suite any `ToolRegistry` implementation must satisfy. Run
 * against the real `createToolRegistry`.
 */

async function assertRegistryContract(makeRegistry: () => ToolRegistry, label: string): Promise<void> {
  const registry = makeRegistry();

  assert.equal(typeof registry.register, "function", `${label}: register is a function`);
  assert.equal(typeof registry.get, "function", `${label}: get is a function`);
  assert.equal(typeof registry.definitions, "function", `${label}: definitions is a function`);

  const initial = registry.definitions();
  assert.ok(Array.isArray(initial), `${label}: definitions() returns an array`);

  registry.register(makeRegisteredTool("contract_tool_a"));
  const got = registry.get("contract_tool_a");
  assert.ok(got !== undefined, `${label}: get returns a registered tool`);
  assert.equal(got!.definition.function.name, "contract_tool_a");

  assert.equal(registry.get("definitely_not_registered"), undefined, `${label}: get returns undefined for unknown tool`);

  assert.throws(
    () => registry.register(makeRegisteredTool("contract_tool_a")),
    (e: unknown) => (e as Error).message.includes("already registered"),
    `${label}: duplicate registration must throw`,
  );

  const defs = registry.definitions();
  assert.ok(Object.isFrozen(defs), `${label}: definitions() must return a frozen array`);
  assert.ok(
    defs.some((d) => d.function.name === "contract_tool_a"),
    `${label}: definitions() includes the registered tool`,
  );
}

test("ToolRegistry contract: real createToolRegistry satisfies the contract", async () => {
  await assertRegistryContract(() => createToolRegistry(), "real");
});

test("ToolRegistry contract: definitions stays frozen across calls", () => {
  const registry = createToolRegistry();
  registry.register(makeRegisteredTool("frozen_check"));
  const a = registry.definitions();
  const b = registry.definitions();
  assert.ok(Object.isFrozen(a));
  assert.ok(Object.isFrozen(b));
  assert.notEqual(a, b, "definitions() returns a fresh frozen array each call");
});

test("ToolRegistry contract: names and size reflect registrations", () => {
  const registry = createToolRegistry();
  const before = registry.size();
  registry.register(makeRegisteredTool("size_check_tool"));
  assert.equal(registry.size(), before + 1);
  assert.ok(registry.names().includes("size_check_tool"));
});
