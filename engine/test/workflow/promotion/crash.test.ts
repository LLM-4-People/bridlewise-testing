/**
 * THE RESUME PROPERTY (merge-door-final §8, §17.2 T-R1): a promotion killed
 * (SIGKILL: no cleanup of any kind) at EVERY checkpoint it passes — after the
 * lock, the reconcile, the plan, the candidate, the settle, the commit, the
 * receipt, the pin, the push, the land, the install and the finish — and then
 * simply run again ends exactly where an uninterrupted run ends: the same
 * commit C (built deterministically: the reference is built first, then its
 * refs dropped), on the remote, on the local target and in W; W clean; the
 * receipt on the remote; no pin, no candidate, no extra commit. A rerun IS
 * the resume: there is no resume verb.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { promotionFolder, promotionRefs } from "../../../src/workflow/promotion/promotion-run.ts";
import { resolvePromotionContext } from "../../../src/workflow/promotion/context.ts";
import { apply, committed, landing } from "./apply-support.ts";
import { PROFILE_NAME, SOURCE, TARGET, type PromotionFixture } from "./promotion-fixture.ts";

const CHECKPOINTS = ["locked", "reconciled", "planned", "candidate", "settled", "committed", "receipt", "pinned", "pushed", "landed", "installed", "finished"] as const;
const CHILD = new URL("./crash-child.ts", import.meta.url).pathname;
const REFS = promotionRefs(PROFILE_NAME);

function child(fixture: PromotionFixture, crashAt?: string): ReturnType<typeof spawnSync> {
  // Not a test file: without the runner's context variable it prints its answer, not the runner's protocol.
  const { NODE_TEST_CONTEXT: _context, ...environment } = process.env;
  return spawnSync(process.execPath, [CHILD, fixture.root, fixture.commandsDirectory, fixture.workRoot, ...(crashAt === undefined ? [] : [crashAt])], { encoding: "utf8", env: environment, maxBuffer: 1 << 24 });
}

for (const checkpoint of CHECKPOINTS) {
  test(`T-R1: killed at "${checkpoint}", the rerun ends exactly where an uninterrupted run ends`, async () => {
    const fixture = landing(`promotion-crash-${checkpoint}`, {}, { remote: true, targetCheckout: true });
    const target = fixture.tip(TARGET);
    const source = fixture.tip(SOURCE);
    // The reference: the deterministic C of these inputs, then its pin and receipt dropped (the starting state again).
    const reference = committed(await apply(fixture)).commit;
    fixture.git(["update-ref", "-d", REFS.pending]);
    fixture.git(["update-ref", "-d", REFS.receipt(reference)]);
    const crashed = child(fixture, checkpoint);
    assert.equal(crashed.signal, "SIGKILL", `the child did not reach ${checkpoint}: ${String(crashed.stdout)}${String(crashed.stderr)}`);
    const rerun = child(fixture);
    assert.equal(rerun.status, 0, String(rerun.stderr));
    // The answer is the child's one JSON line (a support module it imports may print the test runner's summary after it).
    const answer = JSON.parse(String(rerun.stdout).split("\n").find((line) => line.startsWith("{\"code\""))!) as { code: string; message?: string };
    assert.ok(["promotion_published", "promotion_up_to_date"].includes(answer.code), JSON.stringify(answer));
    assert.equal(fixture.remoteGit(["rev-parse", `refs/heads/${TARGET}`]), reference, "the remote carries the same C");
    assert.equal(fixture.tip(TARGET), reference, "so does the local target");
    assert.equal(fixture.git(["-C", fixture.targetCheckout!, "rev-parse", "HEAD"]), reference, "and W");
    assert.equal(fixture.git(["-C", fixture.targetCheckout!, "status", "--porcelain"]), "", "W is clean");
    assert.deepEqual(fixture.git(["rev-list", "--first-parent", `${target}..${reference}`]).split("\n"), [reference], "no extra commit");
    assert.equal(fixture.git(["rev-parse", `${reference}^2`]), source);
    assert.equal(fixture.remoteGit(["rev-parse", REFS.receipt(reference)]), fixture.git(["rev-parse", REFS.receipt(reference)]), "the receipt is on the remote");
    assert.equal(fixture.git(["for-each-ref", "--format=%(refname)", REFS.pending]), "", "no pin left");
    const folder = promotionFolder(resolvePromotionContext(fixture.root, PROFILE_NAME, SOURCE, fixture.document));
    assert.deepEqual(existsSync(folder) ? readdirSync(folder).filter((name) => name.startsWith(`${PROFILE_NAME}-`) && !name.endsWith("-home")) : [], [], "no candidate left");
    assert.equal(existsSync(join(fixture.targetCheckout!, "build/out.txt")), true, "the build outputs were installed");
  });
}
