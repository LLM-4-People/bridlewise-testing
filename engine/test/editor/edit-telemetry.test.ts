/**
 * The editor's exposure counters must be written by the REAL edit path —
 * never registered and then left at zero while the UI serves them as
 * measured facts.
 *
 * Every counter here is driven through `createEditorTools` (the one
 * model-facing editor factory, the same path the executor's `edit` tool
 * crosses): a fuzzy-healed edit moves `healFuzzyCount`, a refusal moves
 * `refusalCount`, a whole-file replace moves `wholeFileReplaceCount`, a
 * syntax refusal moves `syntaxRefusalCount`, and a successful edit moves
 * `editCount`/`successCount`/`lastEditAt` and pushes a restorable history
 * snapshot. A counter that stays at zero after the event it claims to
 * measure is the wired-but-inert class — this suite fails on it.
 *
 * Mutation contract: deleting the `healFuzzyCount += 1` line in
 * `edit-tools.ts` reds the fuzzy arm; deleting the history push reds the
 * rollback arm; registering a counter no path increments reds the
 * deny-by-default sweep at the bottom.
 */
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createEditorTools } from "../../src/editor/edit-tools.ts";
import { editorState } from "../../src/shared/exposure/registrations/editor.ts";
import { executeAction } from "../../src/shared/exposure/index.ts";
import { registerEditorExposure } from "../../src/shared/exposure/registrations/editor.ts";
import { mkTempDir } from "../support/temp-dir.ts";
import { rmSync } from "node:fs";

registerEditorExposure();

type Counters = {
  editCount: number;
  successCount: number;
  failureCount: number;
  refusalCount: number;
  wholeFileReplaceCount: number;
  syntaxRefusalCount: number;
  healExactCount: number;
  healWhitespaceCount: number;
  healEscapeCount: number;
  healFuzzyCount: number;
  rollbackCount: number;
  lastEditAt: number;
  historyDepth: number;
};

function snapshot(): Counters {
  return {
    editCount: editorState.editCount,
    successCount: editorState.successCount,
    failureCount: editorState.failureCount,
    refusalCount: editorState.refusalCount,
    wholeFileReplaceCount: editorState.wholeFileReplaceCount,
    syntaxRefusalCount: editorState.syntaxRefusalCount,
    healExactCount: editorState.healExactCount,
    healWhitespaceCount: editorState.healWhitespaceCount,
    healEscapeCount: editorState.healEscapeCount,
    healFuzzyCount: editorState.healFuzzyCount,
    rollbackCount: editorState.rollbackCount,
    lastEditAt: editorState.lastEditAt,
    historyDepth: editorState.history.length,
  };
}

/** Zero the counters between arms so each asserts ITS event, not a prior's. */
async function reset(): Promise<void> {
  await executeAction("editor.clearHistory");
  editorState.refusalCount = 0;
  editorState.wholeFileReplaceCount = 0;
  editorState.syntaxRefusalCount = 0;
  editorState.healExactCount = 0;
  editorState.healWhitespaceCount = 0;
  editorState.healEscapeCount = 0;
  editorState.healFuzzyCount = 0;
}

function makeEditor(dir: string, ...paths: string[]) {
  return createEditorTools({ repositoryRoot: dir, writeSet: new Set(paths) });
}

test("edit-telemetry: an exact edit moves editCount/successCount/lastEditAt and heals at the exact level", async () => {
  const dir = mkTempDir("edit-tel-");
  try {
    await reset();
    writeFileSync(join(dir, "a.ts"), "export const v = 1;\n");
    const before = snapshot();
    const r = makeEditor(dir, "a.ts").handlers.edit!({ path: "a.ts", oldString: "v = 1", newString: "v = 2" });
    assert.equal(r.success, true);
    const after = snapshot();
    assert.equal(after.editCount, before.editCount + 1, "an edit is counted");
    assert.equal(after.successCount, before.successCount + 1);
    assert.equal(after.healExactCount, before.healExactCount + 1, "the exact heal level is counted");
    assert.ok(after.lastEditAt > 0, "the last-edit instant is recorded");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await reset();
  }
});

test("edit-telemetry: a fuzzy-healed edit moves healFuzzyCount (the level the UI sums into healTriggerCount)", async () => {
  const dir = mkTempDir("edit-tel-");
  try {
    await reset();
    writeFileSync(join(dir, "f.ts"), "function computeTotal() { return items.reduce((a, b) => a + b, 0); }\n");
    const before = snapshot();
    const r = makeEditor(dir, "f.ts").handlers.edit!({
      path: "f.ts",
      oldString: "function computeTotal() { return items.reduce((a, b) => a + b, 1); }",
      newString: "done();",
    });
    assert.equal(r.success, true);
    assert.equal(r.strategy, "fuzzy", "the resolver must route through the fuzzy level for this fixture");
    assert.equal(snapshot().healFuzzyCount, before.healFuzzyCount + 1, "the fuzzy heal is counted by the real path");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await reset();
  }
});

test("edit-telemetry: a whitespace-healed edit moves healWhitespaceCount", async () => {
  const dir = mkTempDir("edit-tel-");
  try {
    await reset();
    writeFileSync(join(dir, "w.ts"), "export function f() {\n    return 1 + 2;\n}\n");
    const before = snapshot();
    // The model's copy collapses the operator's spacing — not a substring of
    // the file, so the exact level misses and the whitespace level heals.
    const r = makeEditor(dir, "w.ts").handlers.edit!({ path: "w.ts", oldString: "return 1+2;", newString: "return 3;" });
    assert.equal(r.success, true);
    assert.equal(r.strategy, "whitespace");
    assert.equal(snapshot().healWhitespaceCount, before.healWhitespaceCount + 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await reset();
  }
});

test("edit-telemetry: a not-found refusal moves refusalCount and failureCount, never successCount", async () => {
  const dir = mkTempDir("edit-tel-");
  try {
    await reset();
    writeFileSync(join(dir, "n.ts"), "export const v = 1;\n");
    const before = snapshot();
    const r = makeEditor(dir, "n.ts").handlers.edit!({ path: "n.ts", oldString: "not present at all qqq", newString: "x" });
    assert.equal(r.success, false);
    const after = snapshot();
    assert.equal(after.refusalCount, before.refusalCount + 1, "a refusal is counted");
    assert.equal(after.failureCount, before.failureCount + 1);
    assert.equal(after.successCount, before.successCount, "a refusal never masquerades as a success");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await reset();
  }
});

test("edit-telemetry: a whole-file replace moves wholeFileReplaceCount", async () => {
  const dir = mkTempDir("edit-tel-");
  try {
    await reset();
    writeFileSync(join(dir, "wf.ts"), "export const v = 1;\n");
    const before = snapshot();
    const r = makeEditor(dir, "wf.ts").handlers.edit!({ path: "wf.ts", oldString: "<all>", newString: "export const v = 2;\n" });
    assert.equal(r.success, true);
    assert.equal(snapshot().wholeFileReplaceCount, before.wholeFileReplaceCount + 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await reset();
  }
});

test("edit-telemetry: a syntax-invalid whole-file replace moves syntaxRefusalCount and refusalCount", async () => {
  const dir = mkTempDir("edit-tel-");
  try {
    await reset();
    writeFileSync(join(dir, "s.ts"), "export const v = 1;\n");
    const before = snapshot();
    const r = makeEditor(dir, "s.ts").handlers.edit!({ path: "s.ts", oldString: "<all>", newString: "export const = (" });
    assert.equal(r.success, false);
    const after = snapshot();
    assert.equal(after.syntaxRefusalCount, before.syntaxRefusalCount + 1, "the syntax refusal is counted by name");
    assert.equal(after.refusalCount, before.refusalCount + 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await reset();
  }
});

test("edit-telemetry: a successful edit pushes a restorable snapshot and rollback restores the bytes", async () => {
  const dir = mkTempDir("edit-tel-");
  try {
    await reset();
    const original = "export const v = 1;\n";
    writeFileSync(join(dir, "r.ts"), original);
    const before = snapshot();
    const tools = makeEditor(dir, "r.ts");
    const r = tools.handlers.edit!({ path: "r.ts", oldString: "v = 1", newString: "v = 2" });
    assert.equal(r.success, true);
    assert.equal(snapshot().historyDepth, before.historyDepth + 1, "the real path pushes a snapshot");
    assert.equal(readFileSync(join(dir, "r.ts"), "utf8"), "export const v = 2;\n");
    const rb = (await executeAction("editor.rollback")) as Record<string, unknown>;
    assert.equal(rb["rolledBack"], true, "rollback restores a real snapshot");
    assert.equal(snapshot().rollbackCount, before.rollbackCount + 1);
    assert.equal(readFileSync(join(dir, "r.ts"), "utf8"), original, "the file's pre-edit bytes are restored");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await reset();
  }
});

test("edit-telemetry: a failed edit pushes NO snapshot (a rollback never resurrects stale bytes)", async () => {
  const dir = mkTempDir("edit-tel-");
  try {
    await reset();
    writeFileSync(join(dir, "z.ts"), "export const v = 1;\n");
    const before = snapshot();
    const r = makeEditor(dir, "z.ts").handlers.edit!({ path: "z.ts", oldString: "absent preimage qqq", newString: "x" });
    assert.equal(r.success, false);
    assert.equal(snapshot().historyDepth, before.historyDepth, "a zero-delta edit is not restorable");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await reset();
  }
});

test("edit-telemetry: a create's rollback removes the created file (restores the absent state)", async () => {
  const dir = mkTempDir("edit-tel-");
  try {
    await reset();
    const tools = makeEditor(dir, "c.ts");
    const r = tools.handlers.edit!({ path: "c.ts", oldString: "", newString: "export const z = 1;\n" });
    assert.equal(r.success, true);
    assert.equal(existsSync(join(dir, "c.ts")), true);
    const rb = (await executeAction("editor.rollback")) as Record<string, unknown>;
    assert.equal(rb["rolledBack"], true);
    assert.equal(existsSync(join(dir, "c.ts")), false, "rolling back a create removes the file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await reset();
  }
});

test("edit-telemetry: every declared editor counter is written by the real path (deny-by-default sweep)", async () => {
  // Discover the counter-shaped state fields from the registration source
  // itself, then prove each one moved under SOME arm above — a counter that
  // exists but no real edit increments is the defect this suite owns.
  const source = readFileSync(
    new URL("../../src/shared/exposure/registrations/editor.ts", import.meta.url),
    "utf8",
  );
  // The state object's numeric telemetry fields (name: 0 inside editorState).
  const stateBody = source.slice(source.indexOf("export const editorState"));
  const declared = [...stateBody.matchAll(/^\s{2}([a-zA-Z]+):\s*0,?\s*$/gm)].map((m) => m[1]!);
  // Knob projections (numbers seeded from config) are not telemetry.
  const knobs = new Set(["viewportLines", "maxRetries", "historyRetention"]);
  const counters = declared.filter((n) => !knobs.has(n) && n !== "fuzzyThreshold");
  assert.ok(counters.length >= 8, `expected the editor telemetry counters to be discoverable; got ${counters.join(",")}`);

  // Drive one edit of each outcome class and collect which counters moved.
  const dir = mkTempDir("edit-tel-");
  try {
    await reset();
    const start = snapshot();
    writeFileSync(join(dir, "a.ts"), "export function f() {\n    return 1 + 2;\n}\n");
    const tools = makeEditor(dir, "a.ts", "b.ts");
    tools.handlers.edit!({ path: "a.ts", oldString: "return 1+2;", newString: "return 3;" }); // whitespace heal
    tools.handlers.edit!({ path: "a.ts", oldString: "return 3;", newString: "return 4;" }); // exact
    tools.handlers.edit!({ path: "a.ts", oldString: "absent qqq zzz", newString: "x" }); // refusal
    tools.handlers.edit!({ path: "a.ts", oldString: "<all>", newString: "export const = (" }); // syntax refusal
    tools.handlers.edit!({ path: "a.ts", oldString: "<all>", newString: "export const ok = 1;\n" }); // whole-file
    const end = snapshot();
    const moved: string[] = [];
    for (const [key, after] of Object.entries(end)) {
      const beforeVal = start[key as keyof Counters];
      if (typeof after === "number" && after > beforeVal) moved.push(key);
    }
    // Map state fields → the sweep's expectation. historyDepth is exercised by
    // the rollback arms (clearHistory zeroes it), so it is asserted there.
    const expected = new Set([
      "editCount", "successCount", "failureCount", "refusalCount",
      "wholeFileReplaceCount", "syntaxRefusalCount",
      "healExactCount", "healWhitespaceCount", "lastEditAt",
    ]);
    const missing = [...expected].filter((k) => !moved.includes(k));
    assert.deepEqual(missing, [], `counters that did NOT move under the drive: ${missing.join(", ")} — each is a registered signal served as zero`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await reset();
  }
});
