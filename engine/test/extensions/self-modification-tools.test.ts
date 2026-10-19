import assert from "node:assert/strict";
import test from "node:test";

import {
  SELF_MODIFICATION_TOOL_IDS,
  SELF_MODIFICATION_TOOL_MANIFEST,
  isSelfModificationTool,
  extensionTypeForTool,
  operationForTool,
  invokeAddTool,
  invokeEditTool,
  invokeDeleteTool,
  invokeEnableDisableTool,
  invokeUpgradeDowngradeTool,
  invokeRollbackTool,
  dispatchAdd,
  dispatchEdit,
  dispatchDelete,
  validateWriteSetForTool,
  writeSetIdentity,
  SelfModificationError,
} from "../../src/extensions/self-modification-tools.ts";
import type {
  AddToolInput,
  EditToolInput,
  DeleteToolInput,
  ToolContext,
} from "../../src/extensions/self-modification-tools.ts";
import { createApprovalWorkflow } from "../../src/extensions/approval-workflow.ts";
import type { ActivationApplier } from "../../src/extensions/approval-workflow.ts";
import { createExtensionManifest } from "../../src/extensions/extension-manifest.ts";
import type { ExtensionManifestEntry } from "../../src/extensions/extension-manifest.ts";
import { InputError, SecurityError } from "../../src/kernel/errors.ts";
import {
  makeEntry, makeProviderEntry, makeModelEntry, makeToolEntry,
  makeAgentTypeEntry, makeQualityPackEntry, makeModuleEntry,
  VALID_TIMESTAMP, LATER_TIMESTAMP,
} from "./fixtures.ts";

const noopApplier: ActivationApplier = {
  applyProposal: (p) => ({ success: true, postimageHash: p.postimageHash }),
  rollbackProposal: () => ({ success: true }),
};

function makeToolContext(entries: ExtensionManifestEntry[] = []): ToolContext {
  return {
    manifest: createExtensionManifest(entries),
    workflow: createApprovalWorkflow({ applier: noopApplier, approvalTtlMs: 3600_000 }),
  };
}

const WRITE_SET = ["src/extensions/test.ts"];

// ============================================================================
// Closed registry — SELF_MODIFICATION_TOOL_IDS
// ============================================================================

test("Tools: SELF_MODIFICATION_TOOL_IDS has exactly 18 tools", () => {
  assert.equal(SELF_MODIFICATION_TOOL_IDS.length, 18);
});

test("Tools: SELF_MODIFICATION_TOOL_IDS is frozen", () => {
  assert.ok(Object.isFrozen(SELF_MODIFICATION_TOOL_IDS));
});

test("Tools: contains all add/edit/delete for 6 types", () => {
  const ids = [...SELF_MODIFICATION_TOOL_IDS];
  for (const kind of ["provider", "model", "tool", "quality_pack", "agent_type", "module"]) {
    assert.ok(ids.includes(`add_${kind}` as never));
    assert.ok(ids.includes(`edit_${kind}` as never));
    assert.ok(ids.includes(`delete_${kind}` as never));
  }
});

test("Tools: isSelfModificationTool true for registered", () => {
  assert.ok(isSelfModificationTool("add_provider"));
});

test("Tools: isSelfModificationTool false for unregistered", () => {
  assert.ok(!isSelfModificationTool("write_file"));
  assert.ok(!isSelfModificationTool("add_unknown"));
});

test("Tools: isSelfModificationTool false for empty", () => {
  assert.ok(!isSelfModificationTool(""));
});

test("Tools: extensionTypeForTool maps correctly", () => {
  assert.equal(extensionTypeForTool("add_provider"), "provider-adapter");
  assert.equal(extensionTypeForTool("add_model"), "model-profile");
  assert.equal(extensionTypeForTool("add_tool"), "mcp-tool-or-adapter");
  assert.equal(extensionTypeForTool("add_quality_pack"), "quality-pack");
  assert.equal(extensionTypeForTool("add_agent_type"), "agent-profile");
  assert.equal(extensionTypeForTool("add_module"), "cohesive-product-module");
});

test("Tools: operationForTool maps add/edit/delete", () => {
  assert.equal(operationForTool("add_provider"), "add");
  assert.equal(operationForTool("edit_provider"), "edit");
  assert.equal(operationForTool("delete_provider"), "delete");
});

test("Tools: SELF_MODIFICATION_TOOL_MANIFEST has 18 entries", () => {
  assert.equal(SELF_MODIFICATION_TOOL_MANIFEST.length, 18);
});

test("Tools: SELF_MODIFICATION_TOOL_MANIFEST entries have descriptions", () => {
  for (const t of SELF_MODIFICATION_TOOL_MANIFEST) {
    assert.ok(t.description.length > 0);
  }
});

// ============================================================================
// invokeAddTool — type matching
// ============================================================================

test("Tools: invokeAddTool add_provider produces proposal", () => {
  const ctx = makeToolContext();
  const entry = makeProviderEntry("prov-a");
  const p = invokeAddTool({ toolId: "add_provider", entry, targetStatus: "active", description: "d", rationale: "r", writeSet: WRITE_SET }, ctx);
  assert.equal(p.scope.operation, "add");
  assert.equal(p.scope.extensionId, "prov-a");
  assert.equal(p.lifecycle.nextEntry.status, "active");
});

test("Tools: invokeAddTool add_model produces proposal", () => {
  const ctx = makeToolContext();
  const entry = makeModelEntry("model-a");
  const p = invokeAddTool({ toolId: "add_model", entry, description: "d", rationale: "r", writeSet: WRITE_SET }, ctx);
  assert.equal(p.scope.extensionId, "model-a");
});

test("Tools: invokeAddTool add_tool produces proposal", () => {
  const ctx = makeToolContext();
  const entry = makeToolEntry("tool-a");
  const p = invokeAddTool({ toolId: "add_tool", entry, description: "d", rationale: "r", writeSet: WRITE_SET }, ctx);
  assert.equal(p.lifecycle.nextEntry.type, "mcp-tool-or-adapter");
});

test("Tools: invokeAddTool add_quality_pack produces proposal", () => {
  const ctx = makeToolContext();
  const entry = makeQualityPackEntry("pack-a");
  const p = invokeAddTool({ toolId: "add_quality_pack", entry, description: "d", rationale: "r", writeSet: WRITE_SET }, ctx);
  assert.equal(p.lifecycle.nextEntry.type, "quality-pack");
});

test("Tools: invokeAddTool add_agent_type produces proposal", () => {
  const ctx = makeToolContext();
  const entry = makeAgentTypeEntry("agent-a");
  const p = invokeAddTool({ toolId: "add_agent_type", entry, description: "d", rationale: "r", writeSet: WRITE_SET }, ctx);
  assert.equal(p.lifecycle.nextEntry.type, "agent-profile");
});

test("Tools: invokeAddTool add_module produces proposal", () => {
  const ctx = makeToolContext();
  const entry = makeModuleEntry("mod-a");
  const p = invokeAddTool({ toolId: "add_module", entry, description: "d", rationale: "r", writeSet: WRITE_SET }, ctx);
  assert.equal(p.lifecycle.nextEntry.type, "cohesive-product-module");
});

test("Tools: invokeAddTool throws on type mismatch", () => {
  const ctx = makeToolContext();
  const entry = makeProviderEntry("prov-a");
  assert.throws(
    () => invokeAddTool({ toolId: "add_model", entry, description: "d", rationale: "r", writeSet: WRITE_SET }, ctx),
    (e: Error) => e instanceof SelfModificationError && e.code === "self_modification_type_mismatch",
  );
});

test("Tools: invokeAddTool throws on unregistered tool id", () => {
  const ctx = makeToolContext();
  const entry = makeProviderEntry("prov-a");
  assert.throws(
    () => invokeAddTool({ toolId: "write_file" as never, entry, description: "d", rationale: "r", writeSet: WRITE_SET }, ctx),
    (e: Error) => e instanceof SecurityError && e.code === "self_modification_unregistered_tool",
  );
});

// ============================================================================
// invokeEditTool
// ============================================================================

test("Tools: invokeEditTool edit_provider produces proposal", () => {
  const entry = makeProviderEntry("prov-a");
  const ctx = makeToolContext([entry]);
  const p = invokeEditTool({ toolId: "edit_provider", id: "prov-a", changes: { description: "updated" }, description: "d", rationale: "r", writeSet: WRITE_SET }, ctx);
  assert.equal(p.scope.operation, "edit");
  assert.equal(p.lifecycle.nextEntry.description, "updated");
});

test("Tools: invokeEditTool throws on unknown id", () => {
  const ctx = makeToolContext();
  assert.throws(
    () => invokeEditTool({ toolId: "edit_provider", id: "nope", changes: {}, description: "d", rationale: "r", writeSet: WRITE_SET }, ctx),
    (e: Error) => e instanceof InputError && e.code === "self_modification_not_found",
  );
});

test("Tools: invokeEditTool throws on type mismatch", () => {
  const entry = makeProviderEntry("prov-a");
  const ctx = makeToolContext([entry]);
  assert.throws(
    () => invokeEditTool({ toolId: "edit_model", id: "prov-a", changes: {}, description: "d", rationale: "r", writeSet: WRITE_SET }, ctx),
    (e: Error) => e instanceof SelfModificationError,
  );
});

// ============================================================================
// invokeDeleteTool
// ============================================================================

test("Tools: invokeDeleteTool delete_provider produces proposal", () => {
  const ctx = makeToolContext([{ ...makeProviderEntry("prov-a"), status: "active" }]);
  const p = invokeDeleteTool({ toolId: "delete_provider", id: "prov-a", description: "d", rationale: "r", writeSet: WRITE_SET, updatedAt: LATER_TIMESTAMP }, ctx);
  assert.equal(p.scope.operation, "delete");
  assert.equal(p.lifecycle.nextEntry.status, "tombstoned");
});

test("Tools: invokeDeleteTool blocks on dependents", () => {
  const dep = makeProviderEntry("dep");
  const consumer = makeEntry({ id: "consumer", dependencies: [{ id: "dep", versionRange: "^1.0.0" }] });
  const ctx = makeToolContext([dep, consumer]);
  assert.throws(
    () => invokeDeleteTool({ toolId: "delete_provider", id: "dep", description: "d", rationale: "r", writeSet: WRITE_SET, updatedAt: LATER_TIMESTAMP }, ctx),
    (e: Error) => e instanceof SecurityError,
  );
});

test("Tools: invokeDeleteTool throws on type mismatch", () => {
  const entry = makeProviderEntry("prov-a");
  const ctx = makeToolContext([entry]);
  assert.throws(
    () => invokeDeleteTool({ toolId: "delete_model", id: "prov-a", description: "d", rationale: "r", writeSet: WRITE_SET, updatedAt: LATER_TIMESTAMP }, ctx),
    (e: Error) => e instanceof SelfModificationError,
  );
});

// ============================================================================
// invokeEnableDisableTool / invokeUpgradeDowngradeTool / invokeRollbackTool
// ============================================================================

test("Tools: invokeEnableDisableTool enable staged provider", () => {
  const entry = { ...makeProviderEntry("prov-a"), status: "staged" as const };
  const ctx = makeToolContext([entry]);
  const p = invokeEnableDisableTool({ toolId: "add_provider", id: "prov-a", operation: "enable", targetStatus: "active", description: "d", rationale: "r", writeSet: WRITE_SET, updatedAt: LATER_TIMESTAMP }, ctx);
  assert.equal(p.lifecycle.nextEntry.status, "active");
});

test("Tools: invokeEnableDisableTool disable active provider", () => {
  const entry = { ...makeProviderEntry("prov-a"), status: "active" as const };
  const ctx = makeToolContext([entry]);
  const p = invokeEnableDisableTool({ toolId: "add_provider", id: "prov-a", operation: "disable", targetStatus: "disabled", description: "d", rationale: "r", writeSet: WRITE_SET, updatedAt: LATER_TIMESTAMP }, ctx);
  assert.equal(p.lifecycle.nextEntry.status, "disabled");
});

test("Tools: invokeUpgradeDowngradeTool upgrade provider", () => {
  const entry = makeProviderEntry("prov-a", "1.0.0");
  const ctx = makeToolContext([{ ...entry, status: "active" }]);
  const p = invokeUpgradeDowngradeTool({ toolId: "add_provider", id: "prov-a", operation: "upgrade", newVersion: "2.0.0", description: "d", rationale: "r", writeSet: WRITE_SET, updatedAt: LATER_TIMESTAMP }, ctx);
  assert.equal(p.lifecycle.nextEntry.version, "2.0.0");
});

test("Tools: invokeRollbackTool rollback active provider", () => {
  const entry = { ...makeProviderEntry("prov-a"), status: "active" as const };
  const ctx = makeToolContext([entry]);
  const p = invokeRollbackTool({ toolId: "add_provider", id: "prov-a", description: "d", rationale: "r", writeSet: WRITE_SET, updatedAt: LATER_TIMESTAMP }, ctx);
  assert.equal(p.scope.operation, "rollback");
  assert.equal(p.lifecycle.nextEntry.status, "disabled");
});

// ============================================================================
// dispatch helpers
// ============================================================================

test("Tools: dispatchAdd delegates to invokeAddTool", () => {
  const ctx = makeToolContext();
  const entry = makeProviderEntry("prov-a");
  const p = dispatchAdd("add_provider", { entry, targetStatus: "active", description: "d", rationale: "r", writeSet: WRITE_SET }, ctx);
  assert.equal(p.scope.extensionId, "prov-a");
});

test("Tools: dispatchEdit delegates to invokeEditTool", () => {
  const entry = makeProviderEntry("prov-a");
  const ctx = makeToolContext([entry]);
  const p = dispatchEdit("edit_provider", { id: "prov-a", changes: { description: "new" }, description: "d", rationale: "r", writeSet: WRITE_SET }, ctx);
  assert.equal(p.lifecycle.nextEntry.description, "new");
});

test("Tools: dispatchDelete delegates to invokeDeleteTool", () => {
  const ctx = makeToolContext([{ ...makeProviderEntry("prov-a"), status: "active" }]);
  const p = dispatchDelete("delete_provider", { id: "prov-a", description: "d", rationale: "r", writeSet: WRITE_SET, updatedAt: LATER_TIMESTAMP }, ctx);
  assert.equal(p.scope.operation, "delete");
});

// ============================================================================
// validateWriteSetForTool / writeSetIdentity
// ============================================================================

test("Tools: validateWriteSetForTool accepts valid writeSet", () => {
  assert.equal(validateWriteSetForTool("add_provider", ["src/a.ts", "src/b.ts"]).length, 0);
});

test("Tools: validateWriteSetForTool rejects empty writeSet", () => {
  assert.ok(validateWriteSetForTool("add_provider", []).length > 0);
});

test("Tools: validateWriteSetForTool rejects absolute path", () => {
  assert.ok(validateWriteSetForTool("add_provider", ["/abs/path"]).length > 0);
});

test("Tools: validateWriteSetForTool rejects parent traversal", () => {
  assert.ok(validateWriteSetForTool("add_provider", ["../escape"]).length > 0);
});

test("Tools: validateWriteSetForTool rejects empty path", () => {
  assert.ok(validateWriteSetForTool("add_provider", ["" as string]).length > 0);
});

test("Tools: validateWriteSetForTool rejects duplicate paths", () => {
  assert.ok(validateWriteSetForTool("add_provider", ["src/a.ts", "src/a.ts"]).length > 0);
});

test("Tools: writeSetIdentity is order-independent", () => {
  assert.equal(writeSetIdentity(["b", "a"]), writeSetIdentity(["a", "b"]));
});

test("Tools: writeSetIdentity changes with content", () => {
  assert.notEqual(writeSetIdentity(["a"]), writeSetIdentity(["b"]));
});

// ============================================================================
// Hostile / adversarial
// ============================================================================

test("Tools: invokeAddTool with null entry throws", () => {
  const ctx = makeToolContext();
  assert.throws(() => invokeAddTool({ toolId: "add_provider", entry: null as unknown as ExtensionManifestEntry, description: "d", rationale: "r", writeSet: WRITE_SET }, ctx));
});

test("Tools: invokeEditTool with null changes throws", () => {
  const entry = makeProviderEntry("prov-a");
  const ctx = makeToolContext([entry]);
  assert.throws(() => invokeEditTool({ toolId: "edit_provider", id: "prov-a", changes: null as unknown as EditToolInput["changes"], description: "d", rationale: "r", writeSet: WRITE_SET }, ctx));
});

test("Tools: add provider with incompatible apiVersion throws", () => {
  const ctx: ToolContext = {
    manifest: createExtensionManifest(),
    workflow: createApprovalWorkflow({ applier: noopApplier, approvalTtlMs: 3600_000 }),
    harness: { apiVersion: "1.0.0", compatibilityRange: "^1.0.0" },
  };
  const entry = { ...makeProviderEntry("prov-a"), apiVersion: "2.0.0" };
  assert.throws(
    () => invokeAddTool({ toolId: "add_provider", entry, description: "d", rationale: "r", writeSet: WRITE_SET }, ctx),
    (e: Error) => e instanceof Error,
  );
});

test("Tools: add tool and edit tool are distinct operations", () => {
  const entry = makeToolEntry("t1");
  const ctx = makeToolContext([entry]);
  const addP = invokeAddTool({ toolId: "add_tool", entry: makeToolEntry("t2"), description: "d", rationale: "r", writeSet: WRITE_SET }, ctx);
  const editP = invokeEditTool({ toolId: "edit_tool", id: "t1", changes: { description: "x" }, description: "d", rationale: "r", writeSet: WRITE_SET }, ctx);
  assert.equal(addP.scope.operation, "add");
  assert.equal(editP.scope.operation, "edit");
});

test("Tools: proposal writeSet is recorded in scope", () => {
  const ctx = makeToolContext();
  const entry = makeProviderEntry("prov-a");
  const ws = ["src/providers/prov-a.ts", "config/providers.json"];
  const p = invokeAddTool({ toolId: "add_provider", entry, description: "d", rationale: "r", writeSet: ws }, ctx);
  assert.deepEqual([...p.scope.writeSet].sort(), [...ws].sort());
});

test("Tools: full flow add→approve→activate through tools", () => {
  const ctx = makeToolContext();
  const entry = makeProviderEntry("prov-a");
  const p = invokeAddTool({ toolId: "add_provider", entry, targetStatus: "active", description: "d", rationale: "r", writeSet: WRITE_SET }, ctx);
  const g = ctx.workflow.approve(p, { kind: "user", id: "op" }, "rev");
  const applyResult = ctx.workflow.apply(g, p);
  assert.ok(applyResult.success);
  const review = ctx.workflow.review(g, p, "ADMIT", { kind: "cli", id: "rev" });
  const outcome = ctx.workflow.activate(review, g, p);
  assert.ok(outcome.activated);
  assert.equal(outcome.activatedEntry!.id, "prov-a");
});

test("Tools: AddToolInput type narrows toolId", () => {
  const input: AddToolInput = { toolId: "add_provider", entry: makeProviderEntry("x"), description: "d", rationale: "r", writeSet: WRITE_SET };
  assert.equal(input.toolId, "add_provider");
});

test("Tools: DeleteToolInput requires updatedAt", () => {
  const input: DeleteToolInput = { toolId: "delete_provider", id: "x", description: "d", rationale: "r", writeSet: WRITE_SET, updatedAt: VALID_TIMESTAMP };
  assert.equal(input.updatedAt, VALID_TIMESTAMP);
});
