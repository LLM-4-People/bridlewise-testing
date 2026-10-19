import assert from "node:assert/strict";
import test from "node:test";

import {
  createExtensionManifest,
  EXTENSION_TYPES,
  EXTENSION_MANIFEST_SCHEMA_VERSION,
} from "../../src/extensions/extension-manifest.ts";
import type { ExtensionManifestEntry, ExtensionManifest } from "../../src/extensions/extension-manifest.ts";
import { createApprovalWorkflow } from "../../src/extensions/approval-workflow.ts";
import type { ActivationApplier, ExtensionEffectRecorder, ApprovalPrincipal } from "../../src/extensions/approval-workflow.ts";
import { proposeAdd, proposeDelete, proposeVersionChange } from "../../src/extensions/extension-lifecycle.ts";
import { invokeAddTool, invokeEditTool, invokeDeleteTool } from "../../src/extensions/self-modification-tools.ts";
import type { ToolContext, AddToolInput, EditToolInput, DeleteToolInput } from "../../src/extensions/self-modification-tools.ts";
import { AGENT_TYPE_IDS } from "../../src/agents/agent-type-registry.ts";
import { TOOL_CAPABILITIES } from "../../src/tools/tool-manifest.ts";
import { AGENT_CAPABILITIES } from "../../src/kernel/config-contracts.ts";
import {
  makeProviderEntry, makeModelEntry, makeToolEntry, makeAgentTypeEntry,
  makeQualityPackEntry, makeModuleEntry, makeEntry, LATER_TIMESTAMP,
} from "./fixtures.ts";

const APPROVER: ApprovalPrincipal = { kind: "user", id: "operator" };
const REVIEWER: ApprovalPrincipal = { kind: "cli", id: "reviewer" };

function recordingApplier(): { applier: ActivationApplier; applied: string[]; rolledBack: string[] } {
  const applied: string[] = [];
  const rolledBack: string[] = [];
  const applier: ActivationApplier = {
    applyProposal: (p) => { applied.push(p.proposalId); return { success: true, postimageHash: p.postimageHash }; },
    rollbackProposal: (p) => { rolledBack.push(p.proposalId); return { success: true }; },
  };
  return { applier, applied, rolledBack };
}

function recordingRecorder(): { recorder: ExtensionEffectRecorder; log: readonly string[] } {
  const log: string[] = [];
  const recorder: ExtensionEffectRecorder = {
    recordProposal: (p) => { log.push(`propose:${p.proposalId}:${p.scope.operation}`); },
    recordApproval: (g) => { log.push(`approve:${g.grantId}`); },
    recordRejection: (p) => { log.push(`reject:${p.proposalId}`); },
    recordApplication: (p, _h, ok) => { log.push(`apply:${p.proposalId}:${ok}`); },
    recordReview: (r) => { log.push(`review:${r.reviewId}:${r.verdict}`); },
    recordActivation: (o) => { log.push(`activate:${o.proposalId}:${o.activated}`); },
    recordRollback: (p, _r) => { log.push(`rollback:${p.proposalId}`); },
  };
  return { recorder, get log() { return log; } };
}

function makeCtx(entries: ExtensionManifestEntry[] = []): ToolContext {
  const { applier } = recordingApplier();
  return {
    manifest: createExtensionManifest(entries),
    workflow: createApprovalWorkflow({ applier, approvalTtlMs: 3600_000 }),
  };
}

// ============================================================================
// Extension manifest aligns with existing registries
// ============================================================================

test("Integration: EXTENSION_TYPES covers providers, models, tools, agents, quality packs, modules", () => {
  const types = [...EXTENSION_TYPES];
  assert.ok(types.includes("provider-adapter"));
  assert.ok(types.includes("model-profile"));
  assert.ok(types.includes("mcp-tool-or-adapter"));
  assert.ok(types.includes("agent-profile"));
  assert.ok(types.includes("quality-pack"));
  assert.ok(types.includes("cohesive-product-module"));
});

test("Integration: provider extension capabilities can include tool capabilities", () => {
  const entry = makeProviderEntry("p1");
  for (const cap of TOOL_CAPABILITIES) {
    const withCap = { ...entry, capabilities: [cap] };
    const m = createExtensionManifest([withCap]);
    assert.equal(m.size(), 1);
  }
});

test("Integration: agent-profile extension aligns with AGENT_TYPE_IDS", () => {
  const m = createExtensionManifest([makeAgentTypeEntry("call-and-return")]);
  assert.ok(m.has("call-and-return"));
  assert.ok(AGENT_TYPE_IDS.includes("call-and-return"));
});

test("Integration: agent-profile capabilities align with AGENT_CAPABILITIES", () => {
  for (const cap of AGENT_CAPABILITIES) {
    const entry = { ...makeAgentTypeEntry("agent-x"), capabilities: [cap] };
    const m = createExtensionManifest([entry]);
    assert.equal(m.size(), 1);
  }
});

test("Integration: schema version is stable identifier", () => {
  assert.equal(EXTENSION_MANIFEST_SCHEMA_VERSION, "bridlewise-extension-manifest/v1");
});

// ============================================================================
// End-to-end add flow through tools + workflow + recorder
// ============================================================================

test("Integration: add provider full flow records every phase to recorder", () => {
  const { recorder, log } = recordingRecorder();
  const { applier } = recordingApplier();
  const workflow = createApprovalWorkflow({ applier, recorder, approvalTtlMs: 3600_000 });
  const ctx: ToolContext = { manifest: createExtensionManifest(), workflow };
  const entry = makeProviderEntry("prov-int");
  const p = invokeAddTool({ toolId: "add_provider", entry, targetStatus: "active", description: "add", rationale: "need", writeSet: ["src/providers/prov-int.ts"] }, ctx);
  const g = workflow.approve(p, APPROVER, "rev-1");
  workflow.apply(g, p);
  const r = workflow.review(g, p, "ADMIT", REVIEWER);
  const outcome = workflow.activate(r, g, p);
  assert.ok(outcome.activated);
  assert.ok(log.some((e) => e.startsWith("propose:")));
  assert.ok(log.some((e) => e.startsWith("approve:")));
  assert.ok(log.some((e) => e.startsWith("apply:") && e.endsWith(":true")));
  assert.ok(log.some((e) => e.startsWith("review:") && e.endsWith(":ADMIT")));
  assert.ok(log.some((e) => e.startsWith("activate:") && e.endsWith(":true")));
});

test("Integration: rejected edit rolls back and records", () => {
  const { recorder, log } = recordingRecorder();
  const { applier } = recordingApplier();
  const workflow = createApprovalWorkflow({ applier, recorder, approvalTtlMs: 3600_000 });
  const existing = { ...makeProviderEntry("prov-rej"), status: "active" as const };
  const ctx: ToolContext = { manifest: createExtensionManifest([existing]), workflow };
  const p = invokeEditTool({ toolId: "edit_provider", id: "prov-rej", changes: { description: "bad change" }, description: "edit", rationale: "test", writeSet: ["src/providers/prov-rej.ts"] }, ctx);
  const g = workflow.approve(p, APPROVER, "rev-2");
  workflow.apply(g, p);
  const r = workflow.review(g, p, "REJECT", REVIEWER, ["breaking"]);
  const outcome = workflow.activate(r, g, p);
  assert.ok(outcome.rolledBack);
  assert.ok(log.some((e) => e.startsWith("rollback:")));
});

// ============================================================================
// Multi-extension dependency graph lifecycle
// ============================================================================

test("Integration: provider + model depending on provider + delete blocking", () => {
  const provider = { ...makeProviderEntry("prov-dep"), status: "active" as const };
  const model = makeModelEntry("model-dep");
  const modelWithDep: ExtensionManifestEntry = { ...model, dependencies: [{ id: "prov-dep", versionRange: "^1.0.0" }] };
  const m = createExtensionManifest([provider, modelWithDep]);
  assert.deepEqual([...m.dependents("prov-dep")], ["model-dep"]);
  // deleting provider must block because model-dep has a non-optional dependency
  assert.throws(
    () => proposeDelete({ context: { manifest: m }, id: "prov-dep", updatedAt: LATER_TIMESTAMP }),
  );
});

test("Integration: upgrade provider keeps model dependency satisfied", () => {
  const provider = { ...makeProviderEntry("prov-up", "1.0.0"), status: "active" as const };
  const model = makeModelEntry("model-up");
  const modelWithDep: ExtensionManifestEntry = { ...model, dependencies: [{ id: "prov-up", versionRange: "^1.0.0" }] };
  const m = createExtensionManifest([provider, modelWithDep]);
  const r = proposeVersionChange({ context: { manifest: m }, id: "prov-up", operation: "upgrade", newVersion: "1.5.0", updatedAt: LATER_TIMESTAMP });
  assert.equal(r.nextEntry.version, "1.5.0");
  // ^1.0.0 still admits 1.5.0
  assert.ok(r.compatibility.compatible);
});

test("Integration: upgrade provider to 2.0.0 breaks model dependency range", () => {
  const provider = { ...makeProviderEntry("prov-brk", "1.0.0"), status: "active" as const };
  const model = makeModelEntry("model-brk");
  const modelWithDep: ExtensionManifestEntry = { ...model, dependencies: [{ id: "prov-brk", versionRange: "^1.0.0" }] };
  const m = createExtensionManifest([provider, modelWithDep]);
  assert.throws(
    () => proposeVersionChange({
      context: { manifest: m },
      id: "prov-brk",
      operation: "upgrade",
      newVersion: "2.0.0",
      newCompatibilityRange: "^2.0.0",
      updatedAt: LATER_TIMESTAMP,
    }),
  );
});

test("Integration: deleting tombstoned dependency is rejected (idempotent delete not registered)", () => {
  const provider = { ...makeProviderEntry("prov-tomb"), status: "tombstoned" as const };
  const m = createExtensionManifest([provider]);
  // delete from tombstoned -> tombstoned is not a registered lifecycle edge
  assert.throws(
    () => proposeDelete({ context: { manifest: m }, id: "prov-tomb", updatedAt: LATER_TIMESTAMP }),
  );
});

// ============================================================================
// Snapshot determinism and round-trip
// ============================================================================

test("Integration: snapshot can seed a new manifest with same identity", () => {
  const m1 = createExtensionManifest([makeProviderEntry("a"), makeModelEntry("b")]);
  const snap = m1.snapshot();
  const m2 = createExtensionManifest(snap.entries);
  assert.equal(m1.identityHash(), m2.identityHash());
});

test("Integration: snapshot entries are valid entries", () => {
  const m = createExtensionManifest([makeProviderEntry("a")]);
  const snap = m.snapshot();
  for (const e of snap.entries) {
    assert.equal(typeof e.id, "string");
    assert.ok(e.id.length > 0);
  }
});

// ============================================================================
// All extension types are addable through tools
// ============================================================================

test("Integration: add each extension type through its tool", () => {
  const ctx = makeCtx();
  const cases: Array<{ toolId: AddToolInput["toolId"]; entry: ExtensionManifestEntry }> = [
    { toolId: "add_provider", entry: makeProviderEntry("t-provider") },
    { toolId: "add_model", entry: makeModelEntry("t-model") },
    { toolId: "add_tool", entry: makeToolEntry("t-tool") },
    { toolId: "add_quality_pack", entry: makeQualityPackEntry("t-pack") },
    { toolId: "add_agent_type", entry: makeAgentTypeEntry("t-agent") },
    { toolId: "add_module", entry: makeModuleEntry("t-module") },
  ];
  for (const { toolId, entry } of cases) {
    const p = invokeAddTool({ toolId, entry, description: "d", rationale: "r", writeSet: ["x.ts"] }, ctx);
    assert.equal(p.lifecycle.nextEntry.type, entry.type);
  }
});

test("Integration: edit each extension type through its tool", () => {
  const ctx = makeCtx([
    { ...makeProviderEntry("t-provider"), status: "active" },
    { ...makeModelEntry("t-model"), status: "active" },
    { ...makeToolEntry("t-tool"), status: "active" },
    { ...makeQualityPackEntry("t-pack"), status: "active" },
    { ...makeAgentTypeEntry("t-agent"), status: "active" },
    { ...makeModuleEntry("t-module"), status: "active" },
  ]);
  const cases: Array<{ toolId: EditToolInput["toolId"]; id: string }> = [
    { toolId: "edit_provider", id: "t-provider" },
    { toolId: "edit_model", id: "t-model" },
    { toolId: "edit_tool", id: "t-tool" },
    { toolId: "edit_quality_pack", id: "t-pack" },
    { toolId: "edit_agent_type", id: "t-agent" },
    { toolId: "edit_module", id: "t-module" },
  ];
  for (const { toolId, id } of cases) {
    const p = invokeEditTool({ toolId, id, changes: { description: "edited" }, description: "d", rationale: "r", writeSet: ["x.ts"] }, ctx);
    assert.equal(p.lifecycle.nextEntry.description, "edited");
  }
});

test("Integration: delete each extension type through its tool", () => {
  const ctx = makeCtx([
    { ...makeProviderEntry("t-provider"), status: "active" },
    { ...makeModelEntry("t-model"), status: "active" },
    { ...makeToolEntry("t-tool"), status: "active" },
    { ...makeQualityPackEntry("t-pack"), status: "active" },
    { ...makeAgentTypeEntry("t-agent"), status: "active" },
    { ...makeModuleEntry("t-module"), status: "active" },
  ]);
  const cases: Array<{ toolId: DeleteToolInput["toolId"]; id: string }> = [
    { toolId: "delete_provider", id: "t-provider" },
    { toolId: "delete_model", id: "t-model" },
    { toolId: "delete_tool", id: "t-tool" },
    { toolId: "delete_quality_pack", id: "t-pack" },
    { toolId: "delete_agent_type", id: "t-agent" },
    { toolId: "delete_module", id: "t-module" },
  ];
  for (const { toolId, id } of cases) {
    const p = invokeDeleteTool({ toolId, id, description: "d", rationale: "r", writeSet: ["x.ts"], updatedAt: LATER_TIMESTAMP }, ctx);
    assert.equal(p.lifecycle.nextEntry.status, "tombstoned");
  }
});

// ============================================================================
// Recorder + anti-replay integration
// ============================================================================

test("Integration: recorder failures do not crash the workflow", () => {
  const throwingRecorder: ExtensionEffectRecorder = {
    recordProposal: () => { throw new Error("boom"); },
    recordApproval: () => { throw new Error("boom"); },
    recordRejection: () => { throw new Error("boom"); },
    recordApplication: () => { throw new Error("boom"); },
    recordReview: () => { throw new Error("boom"); },
    recordActivation: () => { throw new Error("boom"); },
    recordRollback: () => { throw new Error("boom"); },
  };
  const { applier } = recordingApplier();
  const workflow = createApprovalWorkflow({ applier, recorder: throwingRecorder, approvalTtlMs: 3600_000 });
  const ctx: ToolContext = { manifest: createExtensionManifest(), workflow };
  const p = invokeAddTool({ toolId: "add_provider", entry: makeProviderEntry("crash"), description: "d", rationale: "r", writeSet: ["x.ts"] }, ctx);
  const g = workflow.approve(p, APPROVER, "rev");
  workflow.apply(g, p);
  const r = workflow.review(g, p, "ADMIT", REVIEWER);
  const outcome = workflow.activate(r, g, p);
  assert.ok(outcome.activated);
});

test("Integration: full add flow with rejection and rollback restores preimage", () => {
  const { applier, rolledBack } = recordingApplier();
  const workflow = createApprovalWorkflow({ applier, approvalTtlMs: 3600_000 });
  const ctx: ToolContext = { manifest: createExtensionManifest(), workflow };
  const p = invokeAddTool({ toolId: "add_tool", entry: makeToolEntry("t-rej"), description: "d", rationale: "r", writeSet: ["x.ts"] }, ctx);
  const g = workflow.approve(p, APPROVER, "rev");
  workflow.apply(g, p);
  const r = workflow.review(g, p, "REJECT", REVIEWER, ["unsafe"]);
  const outcome = workflow.activate(r, g, p);
  assert.ok(outcome.rolledBack);
  assert.ok(rolledBack.includes(p.proposalId));
});

// ============================================================================
// Manifest consistency under lifecycle
// ============================================================================

test("Integration: manifest validate clean after only valid adds", () => {
  const m = createExtensionManifest();
  proposeAdd({ context: { manifest: m }, entry: makeProviderEntry("a") });
  // proposeAdd does not mutate the manifest (it produces a proposal); manifest stays clean
  assert.equal(m.size(), 0);
  assert.equal(m.validate().length, 0);
});

test("Integration: manifest is reusable across contexts", () => {
  const m: ExtensionManifest = createExtensionManifest([makeProviderEntry("a")]);
  const ctx1: ToolContext = { manifest: m, workflow: createApprovalWorkflow({ applier: recordingApplier().applier, approvalTtlMs: 3600_000 }) };
  const ctx2: ToolContext = { manifest: m, workflow: createApprovalWorkflow({ applier: recordingApplier().applier, approvalTtlMs: 3600_000 }) };
  // both contexts share the same manifest read-only
  assert.equal(ctx1.manifest.size(), 1);
  assert.equal(ctx2.manifest.size(), 1);
});

test("Integration: makeEntry fixture produces valid entry", () => {
  const e = makeEntry();
  const m = createExtensionManifest([e]);
  assert.equal(m.validate().length, 0);
});
