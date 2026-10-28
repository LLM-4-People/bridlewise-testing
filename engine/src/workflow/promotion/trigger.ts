/**
 * THE TRIGGER — `harness promote auto --refs <refs>` (merge-door-final §11),
 * the entry the tracked `reference-transaction` hook starts in the background
 * after a push or a fetch moved remote-tracking refs (`trigger-hook.ts`). It
 * takes about a second and never blocks git:
 *
 * 1. The promoter's own fetches and pushes carry the run variable
 *    (`ROOT_POLICY.workflow.promotion.runEnvironmentVariable`): nothing to do.
 * 2. For each moved `refs/remotes/<remote>/<branch>`, the profiles THAT COMMIT
 *    declares (the profile lives on the source, so no machine setting and no
 *    second list) whose source is `refs/heads/<branch>`, whose remote is
 *    `<remote>` and whose trigger is `on-source-publish`. They are read as
 *    their trigger fields alone (`profileTriggerHeaders`) and FILTERED before
 *    anything judges them: a profile is judged only by the promotion it
 *    starts, which runs the source's own committed promoter, never by this
 *    checkout's code (#259). A ref holding a profile this engine could not
 *    read, or a newer schema, ends nothing (#121): an unrelated ref, a
 *    `manual` profile (the trunk's: the publish workflow promotes), a checkout
 *    behind main, all answer nothing and print nothing.
 * 3. Each one not already carrying that commit (its last `Projected-From`)
 *    starts ONE unattended `apply --profile <p> --source <commit> --auto` in
 *    the background ({@link launchUnattendedApply}). A hold is never decided
 *    here: the local hold ref is only a mirror, so the run itself reads the
 *    remote's and answers `promotion_held` (a hold released on another machine
 *    resumes automation here at the next push). An unattended run never waits
 *    for a lock: a run in progress coalesces it (`promotion_locked`).
 * 4. LATEST WINS ({@link withUnattendedChain}): every `apply` that ends —
 *    whatever its answer, except a hold or a coalesced run — and only once
 *    its locks are released and its process is the top-level one (never a
 *    promoter home's supervised child, whose descendants die with it),
 *    fetches the remote's source and, when it holds a commit the run's S does
 *    not contain, asks THIS trigger about that tip: the run that held the lock
 *    owes the chain to the runs it coalesced.
 * 5. FEEDBACK WITHOUT A TERMINAL: when a matched profile's previous run did
 *    not end ok, the answer carries ONE notice line for it — `auto`'s `--text`
 *    report, which the hook prints on the pusher's stderr: the person or agent
 *    who pushed sees a blocked promotion at the next push, and nothing else.
 *    The run started in the background logs to a file of its own in the
 *    profile's area (`last-run.ts` `openUnattendedLog`), named by its record.
 *
 * Any scheduler may call `apply --auto` itself (idempotent; exit 0 when not
 * due); none is built in.
 */
import { closeSync, realpathSync } from "node:fs";
import { basename, dirname } from "node:path";

import { deepFreeze } from "../../kernel/integrity.ts";
import { ROOT_POLICY } from "../../kernel/root-policy.ts";
import { resolveRevision } from "../../git/tree-reader.ts";
import { startDetached } from "../../process/supervised-run.ts";
import { ensurePrivateStateDirectory } from "../../filesystem/private-state.ts";
import { openContainedFolder, resolveLocation } from "../../filesystem/path-identity.ts";
import type { WorktreeGitPort } from "../../git/worktree-port.ts";
import { remoteTrackingRef } from "../../git/git-port.ts";
import { auditEvent, debugLog } from "../../shared/debug/debug-system.ts";
import { worktreeOperationTimeouts } from "../workflow-config.ts";
import { PromotionError, answer, answerWith, type PromotionAnswer, type PromotionCode } from "./codes.ts";
import { openUnattendedLog, promotionState, readLastRun } from "./last-run.ts";
import { branchOf, type PromotionProfile } from "./profile.ts";
import { isPromoterHomeChild, runningEngine } from "./promoter-home.ts";
import { formatPromoteArguments } from "./promote-arguments.ts";
import { profileWorkDirectory, promotionErrorOf, targetTip } from "./promotion-run.ts";
import { profileHistory } from "./trailers.ts";
import type { PromotionContext, RepositoryContext } from "./context.ts";

/** The pair an unattended run is started for: the checkout, the profile's private directory and the profile's name (never a parsed profile: the run reads it with the source's own code). */
export type UnattendedPair = Readonly<{ top: string; workDirectory: string; profile: string }>;

/** Starts one unattended run of a pair for `source` in the background; answers its pid. */
export type UnattendedLaunch = (pair: UnattendedPair, source: string) => number;


/**
 * The environment of an unattended run started from `environment`: a
 * top-level run of its own — never the promoter home's child (its
 * placement variable dropped: the new run finds its own promoter) — whose
 * log is `log`.
 */
export function unattendedEnvironment(environment: NodeJS.ProcessEnv, log: string): NodeJS.ProcessEnv {
  const { promoterHomeEnvironmentVariable, logEnvironmentVariable } = ROOT_POLICY.workflow.promotion;
  const own: NodeJS.ProcessEnv = { ...environment, [logEnvironmentVariable]: log };
  delete own[promoterHomeEnvironmentVariable];
  return own;
}

/** The production launch: this engine's CLI entry, `apply --profile <p> --source <S> --auto`, detached; it reports through its last-run record, and its log lines land in a log of its own (see the header). */
export function launchUnattendedApply(pair: UnattendedPair, source: string): number {
  const engine = runningEngine();
  // Defence in depth (the name is already one rule-checked segment): the profile's folder is reached from the
  // promotion area without following a link and confirmed under it BEFORE any log is made, swept or written.
  const area = dirname(pair.workDirectory);
  ensurePrivateStateDirectory(area);
  openContainedFolder(resolveLocation(realpathSync(area), "the promotion area"), [basename(pair.workDirectory)], true)?.close();
  const log = openUnattendedLog(pair.workDirectory);
  try {
    return startDetached(process.execPath, [
      ...process.execArgv,
      `${engine.root}/${engine.entry}`,
      ...engine.command,
      ...formatPromoteArguments({ verb: "apply", profile: pair.profile, source, auto: true }),
    ], { cwd: pair.top, env: unattendedEnvironment(process.env, log.path), stderr: log.fd });
  } finally {
    closeSync(log.fd);
  }
}

/** The profiles THIS checkout hosts: the ones its HEAD declares (judged by its own code) with an `on-source-publish` trigger; none when HEAD declares none it can read. */
function hostedProfiles(repository: RepositoryContext): readonly PromotionProfile[] {
  const head = resolveRevision(repository.repository, "HEAD");
  if (head === null) return [];
  try {
    return repository.profilesAt(head).map((loaded) => loaded.profile).filter((profile) => profile.trigger === "on-source-publish");
  } catch (error) {
    if (!(error instanceof PromotionError)) throw error;
    return [];
  }
}

/** The moved remote-tracking refs of the hook's list (each `refs/remotes/<remote>/<branch>`), as remote and branch. */
function movedRefs(refs: string): readonly Readonly<{ ref: string; remote: string; branch: string }>[] {
  return deepFreeze(refs.split(/\s+/u).flatMap((ref) => {
    const match = /^refs\/remotes\/([^/]+)\/(.+)$/u.exec(ref);
    return match === null || match[2] === "HEAD" ? [] : [{ ref, remote: match[1]!, branch: match[2]! }];
  }));
}

/**
 * `harness promote auto --refs <refs>` (see the header) over the repository
 * context; `launch` starts a background run (a test's spy).
 */
export function autoPromotion(
  repository: RepositoryContext,
  refs: string,
  launch: UnattendedLaunch,
  environment: NodeJS.ProcessEnv = process.env,
): PromotionAnswer {
  const run = ROOT_POLICY.workflow.promotion.runEnvironmentVariable;
  if (environment[run] !== undefined && environment[run] !== "") {
    return answer("promotion_not_due", "the refs moved by a promotion's own fetch or push: nothing to trigger", { refs });
  }
  const started: { profile: string; source: string; pid: number }[] = [];
  const skipped: { profile: string; source: string; reason: string }[] = [];
  const notices: string[] = [];
  const hosted = hostedProfiles(repository);
  for (const moved of movedRefs(refs)) {
    const commit = resolveRevision(repository.repository, moved.ref);
    if (commit === null) continue;
    const headers = repository.triggerHeadersAt(commit);
    // THIS checkout hosts these profiles (its own HEAD declares them, judged by its own code): a moved source of one
    // whose profile cannot be read there would stop its promotions in silence, so it is said, loudly. A foreign ref stays silent.
    for (const host of hosted.filter((profile) => profile.remote === moved.remote && branchOf(profile.source.ref) === moved.branch)) {
      if (!headers.some((header) => header.name === host.name)) {
        notices.push(`promotion ${host.name}: ${moved.remote}/${moved.branch} moved to ${commit}, whose ${host.name} profile cannot be read (or is gone): nothing was started; run: ${ROOT_POLICY.protocol.harnessCommand} promote status --profile ${host.name}`);
      }
    }
    for (const header of headers) {
      if (header.trigger !== "on-source-publish" || header.remote !== moved.remote || branchOf(header.sourceRef) !== moved.branch) continue;
      const pair: UnattendedPair = deepFreeze({ top: repository.top, workDirectory: profileWorkDirectory(repository.registry, header.name), profile: header.name });
      const last = readLastRun(pair.workDirectory);
      if (last?.result !== null && last?.result !== undefined && last.result.class !== "ok") {
        notices.push(`promotion ${header.name}: ${promotionState(last)} — ${last.result.code} (${last.result.message.split("\n")[0]!}); run: ${ROOT_POLICY.protocol.harnessCommand} promote status --profile ${header.name}`);
      }
      const target = targetTip(repository.repository, { target: { ref: header.targetRef }, remote: header.remote });
      const reason = target !== null && profileHistory(repository.repository, target, header.name)[0]?.trailers.projectedFrom === commit ? "up to date" : null;
      if (reason !== null) {
        skipped.push({ profile: header.name, source: commit, reason });
        auditEvent("promotion.trigger", { profile: header.name, kind: "skipped", source: commit, reason });
        continue;
      }
      let pid: number;
      try {
        pid = launch(pair, commit);
      } catch (error) {
        // A launch refused (a link where the profile's folder belongs) is that profile's notice, never the run's end.
        const refused = promotionErrorOf(error, { profile: header.name, phase: "launch" });
        notices.push(`promotion ${header.name}: its unattended run could not be started — ${refused.promotionCode} (${refused.message.split("\n")[0]!})`);
        auditEvent("promotion.trigger", { profile: header.name, kind: "refused", source: commit, code: refused.promotionCode });
        continue;
      }
      started.push({ profile: header.name, source: commit, pid });
      auditEvent("promotion.trigger", { profile: header.name, kind: "spawned", source: commit, pid });
    }
  }
  const data = { refs, started, skipped, notices };
  return started.length > 0
    ? answer("promotion_triggered", `started ${started.map((entry) => `${entry.profile} for ${entry.source}`).join(", ")} in the background`, data)
    : answer("promotion_not_due", skipped.length > 0 ? `nothing to start: ${skipped.map((entry) => `${entry.profile} ${entry.reason}`).join(", ")}` : "no promotion profile is triggered by these refs", data);
}

/** The endings after which no chain is owed (see the header): a hold (nothing runs until it is released) and a run coalesced into a running one (the holder chains). */
// DELIBERATE SUBSET: 2 of 66 — every other ending (an answer or a refusal) owes the chain; only these two mean another run, or a person, owns the next step.
const UNCHAINED: ReadonlySet<PromotionCode> = new Set<PromotionCode>(["promotion_held", "promotion_locked"]);

/**
 * THE CHAIN (see the header, 4): after `ended`, the remote's source fetched
 * into its remote-tracking ref (the port's run variable: the fetch triggers
 * nothing) and, when it holds a commit the run's S does not contain, the
 * trigger's rules over that tip ({@link autoPromotion}). Answers the trigger's answer, or `null`
 * when no chain is owed. Never throws: a chain that cannot be decided is
 * logged, and the run's own answer stands.
 */
function chainUnattended(
  context: PromotionContext,
  git: WorktreeGitPort,
  ended: PromotionCode,
  launch: UnattendedLaunch,
): PromotionAnswer | null {
  const { profile } = context.loaded;
  if (profile.remote === null || UNCHAINED.has(ended)) return null;
  const tracking = remoteTrackingRef(profile.remote, branchOf(profile.source.ref));
  try {
    const fetched = git.fetchRefs(context.top, profile.remote, [`+${profile.source.ref}:${tracking}`], worktreeOperationTimeouts(context.document).fetchMs);
    if (fetched.refusal !== null) {
      debugLog("workflow", "warn", "the promotion chain could not read the remote's source: the next push triggers again", () => ({ profile: profile.name, refusal: fetched.refusal }));
      return null;
    }
    const now = resolveRevision(context.repository, tracking);
    // Only a source the run's S does not already contain is newer (never a tip S carries: a `--no-push` run, a local S ahead of the remote).
    if (now === null || git.isAncestor(context.top, now, context.source, worktreeOperationTimeouts(context.document).inspectMs)) return null;
    auditEvent("promotion.trigger", { profile: profile.name, kind: "chained", source: now, after: context.source, ended });
    return autoPromotion(context, tracking, launch, {});
  } catch (error) {
    const failure = promotionErrorOf(error, { profile: profile.name, phase: "chain" });
    debugLog("workflow", "warn", "the promotion chain failed: the next push triggers again", () => ({ profile: profile.name, code: failure.promotionCode, message: failure.message }));
    return null;
  }
}

/**
 * Runs `run` — one `apply`, whatever its placement — and then owes its chain
 * ({@link chainUnattended}): after the run's locks are released and whatever
 * it answered, a refusal included. The answer gains `chained` (the trigger's
 * answer, or `null`); a refusal propagates unchanged. The promoter home's
 * child (`environment` names `engine` as the home's) owes none: its
 * descendants end with it, and its top-level parent chains.
 */
export async function withUnattendedChain(
  context: PromotionContext,
  git: WorktreeGitPort,
  run: () => Promise<PromotionAnswer>,
  launch: UnattendedLaunch,
  environment: NodeJS.ProcessEnv = process.env,
  engine = runningEngine(),
): Promise<PromotionAnswer> {
  if (isPromoterHomeChild(engine, environment)) return run();
  let result: PromotionAnswer;
  try {
    result = await run();
  } catch (error) {
    chainUnattended(context, git, error instanceof PromotionError ? error.promotionCode : "promotion_unexpected", launch);
    throw error;
  }
  const chained = chainUnattended(context, git, result.code, launch);
  return answerWith(result, { chained: chained === null ? null : chained.data });
}
