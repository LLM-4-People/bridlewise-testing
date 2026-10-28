/**
 * THE APPLY SUPPORT of the promotion tests: a promotion run in this process
 * over a fixture (`promotion-fixture.ts`) with the fixture's own command
 * registry, generated outputs and engine folder (`apply`), its refusal
 * (`refused`), a landing fixture whose source changed the product
 * (`landing`), and the invariant sweep (T-K2: `untouched` /
 * `assertUntouched`) — shared by the build, publication, rollback and crash
 * tests.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { configuredWorktreeGitPort } from "../../../src/git/worktree-port.ts";
import { sha256 } from "../../../src/kernel/integrity.ts";
import { PromotionError, type PromotionAnswer, type PromotionCode } from "../../../src/workflow/promotion/codes.ts";
import { applyPromotion } from "../../../src/workflow/promotion/apply.ts";
import { resolvePromotionContext, type PromotionDocument } from "../../../src/workflow/promotion/context.ts";
import { promotionFolder, promotionRefs, type ApplyRequest, type ApplyRun } from "../../../src/workflow/promotion/promotion-run.ts";
import { ensureTestProcessSupervisor } from "../../../guardian/build.ts";
import { FIXTURE_ENGINE, FIXTURE_GENERATED, PROFILE_NAME, SOURCE, promotionFixture, type FixtureOptions, type PromotionFixture } from "./promotion-fixture.ts";

export type ApplyOptions = Readonly<{
  request?: Partial<ApplyRequest>;
  run?: Partial<ApplyRun>;
  /** Keep a failed candidate (`workspaceIsolation.preserveOnFailure`). */
  preserve?: boolean;
  retries?: number;
  waits?: number[];
  /** The checkout the run is invoked from (default: the fixture's own). */
  from?: string;
}>;

export function documentOf(fixture: PromotionFixture, preserve: boolean): PromotionDocument {
  return { ...fixture.document, workspaceIsolation: { ...fixture.document.workspaceIsolation!, preserveOnFailure: preserve } };
}

/** The build run a fixture's promotion uses in this process: the test supervisor, the fixture's generated outputs, its engine folder, and its plan. */
export function fixtureRun(fixture: PromotionFixture, options: ApplyOptions = {}): ApplyRun {
  const document = documentOf(fixture, options.preserve === true);
  return {
    git: configuredWorktreeGitPort(document),
    runner: {
      supervisor: ensureTestProcessSupervisor(),
      killGraceMs: 500,
      outputCharacters: 4_000,
      retries: { retries: options.retries ?? 1, backoffMs: 7, sleep: async (ms) => { options.waits?.push(ms); } },
    },
    generatedOutputs: () => FIXTURE_GENERATED,
    buildOutputs: () => [],
    engineRelative: FIXTURE_ENGINE,
    toolchain: { node: process.version },
    plan: (reconciled) => fixture.plan({ source: reconciled.source, target: reconciled.target }),
    ...options.run,
  };
}

/** `apply` over the fixture (`--no-publish` unless the request says otherwise), run in this process (the promoter home is `promoter-home.test.ts`'s). */
export async function apply(fixture: PromotionFixture, options: ApplyOptions = {}): Promise<PromotionAnswer> {
  const document = documentOf(fixture, options.preserve === true);
  const context = resolvePromotionContext(options.from ?? fixture.root, PROFILE_NAME, SOURCE, document);
  return applyPromotion(context, { acceptTargetEdits: null, allowDeletions: false, releaseHold: false, reason: null, noPublish: true, noPush: false, auto: false, ...options.request }, fixtureRun(fixture, options));
}

/** The refusal `apply` throws (a PromotionError), asserted to carry `code`. */
export async function refused(fixture: PromotionFixture, code: PromotionCode, options: ApplyOptions = {}): Promise<PromotionError> {
  try {
    await apply(fixture, options);
  } catch (error) {
    assert.ok(error instanceof PromotionError, String(error));
    assert.equal(error.promotionCode, code, error.message);
    return error;
  }
  assert.fail(`apply did not refuse with ${code}`);
}

/** A landing fixture whose source changed the product (so there is something to build). */
export function landing(prefix: string, overrides: Readonly<Record<string, unknown>> = {}, options: FixtureOptions = {}): PromotionFixture {
  const fixture = promotionFixture(prefix, overrides, { landing: true, ...options });
  fixture.commit(SOURCE, { "product/lib/helper.ts": "export const helper = 3;\n" }, "a product change");
  return fixture;
}

export type Untouched = Readonly<{ refs: string; index: string; porcelain: string; worktrees: string }>;

/** The state the invariant sweep (T-K2) compares: every branch and tag, the invoking checkout's index bytes and porcelain, and the worktrees that are not candidates. */
export function untouched(fixture: PromotionFixture): Untouched {
  const index = sha256(readFileSync(join(fixture.root, ".git", "index")));
  return {
    index,
    refs: fixture.git(["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/tags", "refs/bridlewise/promotion/dev-to-prod/pending"]),
    porcelain: fixture.git(["status", "--porcelain=v1", "--untracked-files=all"]),
    worktrees: fixture.git(["worktree", "list", "--porcelain"]).split("\n\n").filter((entry) => !entry.includes(fixture.workRoot)).join("\n\n"),
  };
}

/** T-K2: after a failed build nothing but the candidate changed, and no checkout but a candidate has a merge in progress. */
export function assertUntouched(fixture: PromotionFixture, before: Untouched): void {
  assert.deepEqual(untouched(fixture), before);
  assert.equal(existsSync(join(fixture.root, ".git", "MERGE_HEAD")), false, "the invoking checkout never has a merge in progress");
}

/** The repository's promotion folder under the fixture's workspace root. */
export function folderOf(fixture: PromotionFixture): string {
  return promotionFolder(resolvePromotionContext(fixture.root, PROFILE_NAME, SOURCE, fixture.document));
}

/** The candidate folders of the fixture's profile (their names). */
export function candidates(fixture: PromotionFixture): readonly string[] {
  const folder = folderOf(fixture);
  return existsSync(folder) ? readdirSync(folder).filter((name) => /^dev-to-prod-[0-9a-f]{8}$/u.test(name)) : [];
}

export function receiptOf(fixture: PromotionFixture, commit: string): Record<string, unknown> {
  return JSON.parse(fixture.git(["cat-file", "blob", promotionRefs(PROFILE_NAME).receipt(commit)])) as Record<string, unknown>;
}

export type Committed = Readonly<{ commit: string; tree: string; parents: readonly string[]; regenerated: readonly string[]; advisories: readonly Readonly<{ kind: string; path: string }>[]; resumed: boolean; steps: readonly Readonly<{ step: string; status: string; message: string }>[]; hookOutput: string }>;

export function committed(result: PromotionAnswer): Committed {
  assert.equal(result.code, "promotion_committed", result.message);
  return result.data as Committed;
}
