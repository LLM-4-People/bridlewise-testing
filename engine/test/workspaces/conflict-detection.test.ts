import assert from "node:assert/strict";
import test from "node:test";

import { detectWriteSetConflict, detectWriteSetConflictAmong } from "../../src/agents/agent-config.ts";
import { deepFreeze } from "../../src/kernel/integrity.ts";

/**
 * Static write-set conflict detection (admission gate) over owner-shaped
 * inputs — the workspace manager consumes `detectWriteSetConflictAmong`
 * with workspace ids, while agent profiles keep `detectWriteSetConflict`.
 */

test("detectWriteSetConflictAmong flags prefix overlap in both directions", () => {
  const { conflicts } = detectWriteSetConflictAmong([
    deepFreeze({ name: "a", writeSet: ["src/git"] }),
    deepFreeze({ name: "b", writeSet: ["src/git/tools"] }),
  ]);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]!.path, "src/git");
});

test("detectWriteSetConflictAmong respects prefix boundaries", () => {
  const { conflicts } = detectWriteSetConflictAmong([
    deepFreeze({ name: "a", writeSet: ["src/git"] }),
    deepFreeze({ name: "b", writeSet: ["src/github"] }),
  ]);
  assert.equal(conflicts.length, 0);
});

test("detectWriteSetConflictAmong flags identical entries", () => {
  const { conflicts } = detectWriteSetConflictAmong([
    deepFreeze({ name: "a", writeSet: ["src/git/worktree-port.ts"] }),
    deepFreeze({ name: "b", writeSet: ["src/git/worktree-port.ts"] }),
  ]);
  assert.equal(conflicts.length, 1);
});

test("detectWriteSetConflictAmong scales across N owners pairwise", () => {
  const { conflicts } = detectWriteSetConflictAmong([
    deepFreeze({ name: "a", writeSet: ["x/1"] }),
    deepFreeze({ name: "b", writeSet: ["x/2"] }),
    deepFreeze({ name: "c", writeSet: ["x"] }),
    deepFreeze({ name: "d", writeSet: ["y"] }),
  ]);
  assert.equal(conflicts.length, 2);
  const pairs = conflicts.map((conflict) => [conflict.agentA, conflict.agentB].sort().join("+")).toSorted();
  assert.deepEqual(pairs, ["a+c", "b+c"]);
});

test("detectWriteSetConflictAmong skips owners with empty write sets", () => {
  const { conflicts } = detectWriteSetConflictAmong([
    deepFreeze({ name: "a", writeSet: [] }),
    deepFreeze({ name: "b", writeSet: ["x"] }),
  ]);
  assert.equal(conflicts.length, 0);
});

test("detectWriteSetConflict keeps working for full agent profiles", () => {
  const profile = (name: string, writeSet: readonly string[]) => deepFreeze({
    name,
    type: "call-and-return",
    model: "m",
    provider: "p",
    systemPrompt: "",
    tools: [],
    capabilities: [],
    writeSet,
    maxTurns: 5,
  });
  const { conflicts } = detectWriteSetConflict([profile("a", ["src"]), profile("b", ["src/git"])]);
  assert.equal(conflicts.length, 1);
});
