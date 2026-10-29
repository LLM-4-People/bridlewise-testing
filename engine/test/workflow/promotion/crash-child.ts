/**
 * THE CRASH CHILD of the resume property test (`crash.test.ts`, T-R1): one
 * promotion (`apply`, published) over an existing landing fixture with a
 * remote and a target checkout, run in its own process, that SIGKILLs itself
 * when it passes the named checkpoint (`ApplyRun.checkpoint`) — a crash at a
 * precise point, with no cleanup of any kind. Without a checkpoint it runs to
 * the end and prints its answer as one JSON line.
 *
 *   node crash-child.ts <root> <commands dir> <work root> [<checkpoint>]
 */
import { configuredWorktreeGitPort } from "../../../src/git/worktree-port.ts";
import { applyPromotion } from "../../../src/workflow/promotion/apply.ts";
import { PromotionError } from "../../../src/workflow/promotion/codes.ts";
import { resolvePromotionContext } from "../../../src/workflow/promotion/context.ts";
import { ensureTestProcessSupervisor } from "../../../guardian/build.ts";
import { FIXTURE_ENGINE, FIXTURE_GENERATED, PROFILE_NAME, SOURCE, fixtureView } from "./promotion-fixture.ts";

const [root, commandsDirectory, workRoot, crashAt] = process.argv.slice(2);
if (root === undefined || commandsDirectory === undefined || workRoot === undefined) throw new Error("usage: crash-child.ts <root> <commands dir> <work root> [<checkpoint>]");
const view = fixtureView({ root, commandsDirectory, workRoot }, { landing: true, remote: true, targetCheckout: true });
const context = resolvePromotionContext(root, PROFILE_NAME, SOURCE, view.document);
try {
  const result = await applyPromotion(context, { acceptTargetEdits: null, allowDeletions: false, releaseHold: false, reason: null, noPublish: false, noPush: false, auto: false }, {
    git: configuredWorktreeGitPort(view.document),
    runner: { supervisor: ensureTestProcessSupervisor(), killGraceMs: 500, outputCharacters: 4_000, retries: { retries: 0, backoffMs: 1 } },
    generatedOutputs: () => FIXTURE_GENERATED,
    buildOutputs: () => ["build/out.txt"],
    engineRelative: FIXTURE_ENGINE,
    toolchain: { node: process.version },
    plan: (reconciled) => view.plan({ source: reconciled.source, target: reconciled.target }),
    checkpoint: (name) => {
      if (name === crashAt) process.kill(process.pid, "SIGKILL");
    },
  });
  process.stdout.write(`${JSON.stringify({ code: result.code, data: result.data })}\n`);
} catch (error) {
  if (!(error instanceof PromotionError)) throw error;
  process.stdout.write(`${JSON.stringify({ code: error.promotionCode, message: error.message })}\n`);
}
