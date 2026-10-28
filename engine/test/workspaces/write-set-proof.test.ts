import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deepFreeze } from "../../src/kernel/integrity.ts";
import { DECISION_INDEX } from "../../src/kernel/verification-paths.ts";
import { bindingPinRanges, generatedOutputPaths, isGenerationOnlyChange, wholesaleGeneratedPaths } from "../../src/workflow/hash-binding-registry.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
import {
  computeMergedSinceConflicts,
  computePendingWriteSetConflicts,
  computeUnleasedPaths,
  isPathWithinWriteSet,
} from "../../src/workflow/workspace-contracts.ts";

/**
 * Write-set proof path-set arithmetic: subset checks and prefix-boundary
 * behavior for the changed-set ⊆ write-set gate.
 */

test("subset check passes when every changed path is leased", () => {
  assert.deepEqual(computeUnleasedPaths(["src/git/a.ts", "src/git/sub/b.ts"], ["src/git"]), []);
});

test("exact file entries lease exactly that file", () => {
  assert.deepEqual(computeUnleasedPaths(["src/git/a.ts"], ["src/git/a.ts"]), []);
  assert.deepEqual(computeUnleasedPaths(["src/git/ab.ts"], ["src/git/a.ts"]), ["src/git/ab.ts"]);
});

test("prefix boundary: src/foo does not lease src/foobar", () => {
  const unleased = computeUnleasedPaths(["src/foobar/x.ts"], ["src/foo"]);
  assert.deepEqual(unleased, ["src/foobar/x.ts"]);
});

test("prefix boundary: src/foo leases nested descendants", () => {
  assert.ok(isPathWithinWriteSet("src/foo/bar/baz/qux.ts", ["src/foo"]));
  assert.ok(!isPathWithinWriteSet("src/fo", ["src/foo"]));
});

test("parent paths are not leased by child entries", () => {
  assert.deepEqual(computeUnleasedPaths(["src/a.ts", "src/git"], ["src/git/sub"]), ["src/a.ts", "src/git"]);
});

test("multiple write-set entries are unioned", () => {
  const unleased = computeUnleasedPaths(
    ["src/git/a.ts", "test/workspaces/b.ts", "docs/c.md"],
    ["src/git", "test/workspaces"],
  );
  assert.deepEqual(unleased, ["docs/c.md"]);
});

test("empty changed set is always leased", () => {
  assert.deepEqual(computeUnleasedPaths([], ["src/git"]), []);
});

test("unleased output is sorted for deterministic reports", () => {
  const unleased = computeUnleasedPaths(["z.ts", "a.ts", "m.ts"], ["src/git"]);
  assert.deepEqual(unleased, ["a.ts", "m.ts", "z.ts"]);
});

test("NFC-equivalent paths compare equal", () => {
  const precomposed = "src/café/x.ts";
  const combining = "src/cafe\u0301/x.ts";
  assert.equal(precomposed.normalize("NFC") === combining.normalize("NFC"), true);
  assert.ok(isPathWithinWriteSet(precomposed, [precomposed.split("/").slice(0, 2).join("/")]));
});

test("the exempt set is what exempts a changed path from the lease", () => {
  const generated = new Set(["engine/src/architecture-manifest.ts", "engine/src/kernel/root-policy.ts"]);
  assert.deepEqual(
    computeUnleasedPaths(["engine/src/architecture-manifest.ts", "engine/src/kernel/root-policy.ts", "src/git/a.ts", "docs/x.md"], ["src/git"], generated),
    ["docs/x.md"],
  );
  // Without the exemption the same paths are unleased: the set is what exempts them.
  assert.deepEqual(
    computeUnleasedPaths(["engine/src/architecture-manifest.ts", "src/git/a.ts"], ["src/git"]),
    ["engine/src/architecture-manifest.ts"],
  );
});

test("a regeneration-only change: a wholly generated output always; a pin-bearing file or a generated block only when its authored part is unchanged", () => {
  // The pin-bearing fixture is the REAL root policy: normalization is derived
  // from the binding registry's own locators, so a synthetic `"a"*64` literal
  // is not a pin at all (a hand edit of one must lease the file).
  const pinBearing = "engine/src/kernel/root-policy.ts";
  const realPolicy = readFileSync(join(ROOT, "src/kernel/root-policy.ts"), "utf8");
  const bound = bindingPinRanges("src/kernel/root-policy.ts", realPolicy);
  assert.ok(bound.length > 0, "the fixture needs a registry-bound pin to exercise the regeneration-only arm");
  const withPin = (literal: string): string =>
    `${realPolicy.slice(0, bound[0]!.start)}${literal}${realPolicy.slice(bound[0]!.end)}`;
  assert.equal(isGenerationOnlyChange(pinBearing, withPin("a".repeat(64)), withPin("b".repeat(64))), true, "a re-derived pin");
  const handEdit = `${realPolicy.replace("export type", "export type  ")}`;
  assert.equal(isGenerationOnlyChange(pinBearing, realPolicy, handEdit), false, "a hand edit beside the pin");
  assert.equal(isGenerationOnlyChange(pinBearing, null, withPin("a".repeat(64))), false, "an added file is authored");
  assert.equal(isGenerationOnlyChange(pinBearing, withPin("a".repeat(64)), null), false, "a deleted file is authored");
  assert.equal(isGenerationOnlyChange("src/m/README.md", `x ${"a".repeat(64)}`, `x ${"b".repeat(64)}`), false, "a 64-hex value in a file that bears no pin is authored");
  const decisions = (prose: string, index: string): string => `${prose}\n${DECISION_INDEX.begin}\n${index}\n${DECISION_INDEX.end}\n`;
  assert.equal(isGenerationOnlyChange(DECISION_INDEX.path, decisions("p", "| a |"), decisions("p", "| a |\n| b |")), true, "the decision index re-derived");
  assert.equal(isGenerationOnlyChange(DECISION_INDEX.path, decisions("p", "| a |"), decisions("q", "| a |")), false);
  assert.equal(isGenerationOnlyChange("engine/scripts/verification/some-baseline.json", "{\"a\":1}", "{}"), false, "a pruned ratchet baseline is a change to lease");
  for (const wholesale of wholesaleGeneratedPaths()) assert.equal(isGenerationOnlyChange(wholesale, "a", "b"), true);
});

test("every wholly generated output is a generated output (the lease exemption and the never-leasable set agree)", () => {
  const generated = generatedOutputPaths();
  for (const wholesale of wholesaleGeneratedPaths()) assert.ok(generated.has(wholesale), wholesale);
});

// ---------------------------------------------------------------------------
// dynamic conflict intersection across N pending candidates
// ---------------------------------------------------------------------------

test("pending intersection reports every (changed path, workspace) pair", () => {
  const pending = deepFreeze([
    deepFreeze({ workspaceId: "agent-a-000000000001", writeSet: ["src/git"] }),
    deepFreeze({ workspaceId: "agent-b-000000000002", writeSet: ["src/git/tools"] }),
    deepFreeze({ workspaceId: "agent-c-000000000003", writeSet: ["docs"] }),
  ]);
  const conflicts = computePendingWriteSetConflicts(["src/git/tools/x.ts", "README.md"], pending);
  assert.equal(conflicts.length, 2);
  assert.deepEqual(conflicts.map((entry) => entry.otherWorkspaceId).toSorted(), [
    "agent-a-000000000001",
    "agent-b-000000000002",
  ]);
  assert.ok(conflicts.every((entry) => entry.path === "src/git/tools/x.ts"));
});

test("pending intersection is empty when nothing overlaps", () => {
  const pending = deepFreeze([
    deepFreeze({ workspaceId: "agent-a-000000000001", writeSet: ["src/git"] }),
    deepFreeze({ workspaceId: "agent-b-000000000002", writeSet: ["test/workspaces"] }),
  ]);
  assert.deepEqual(computePendingWriteSetConflicts(["docs/guide.md"], pending), []);
});

test("pending intersection handles N candidates with mixed hits", () => {
  const pending = Array.from({ length: 6 }, (_, index) =>
    deepFreeze({ workspaceId: `agent-w${index}-00000000000${index}`, writeSet: [`area/${index}`] }));
  const conflicts = computePendingWriteSetConflicts(["area/0/a.ts", "area/3/b.ts", "area/5/c/d.ts", "other/x.ts"], pending);
  assert.equal(conflicts.length, 3);
  assert.deepEqual(
    conflicts.map((entry) => `${entry.path}@${entry.otherWorkspaceId}`),
    ["area/0/a.ts@agent-w0-000000000000", "area/3/b.ts@agent-w3-000000000003", "area/5/c/d.ts@agent-w5-000000000005"],
  );
});

test("merged-since intersection uses exact path equality", () => {
  const conflicts = computeMergedSinceConflicts(
    ["src/a.ts", "src/b.ts"],
    ["src/a.ts", "src/a.ts.bak"],
  );
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]!.path, "src/a.ts");
  assert.equal(conflicts[0]!.otherWorkspaceId, null);
});

test("merged-since intersection is empty for disjoint sets", () => {
  assert.deepEqual(computeMergedSinceConflicts(["src/a.ts"], ["docs/b.md"]), []);
});
