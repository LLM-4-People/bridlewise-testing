/**
 * THE `harness community` DOOR: the community actions that read or write
 * GitHub, run on `main`'s code by the community workflow
 * (`.github/workflows/community.yml`) or by the maintainer.
 *
 *   harness community categories                     # audit the Discussion categories against the intake registry
 *   harness community comment --event <path> --remote <name>   # an issue_comment event: IssueOps
 *   harness community issue --event <path>           # an issues event: the newcomer's welcome
 *   harness community welcome-pulls                  # every newcomer's open pull request (scheduled)
 *   harness community thank --before <sha> --after <sha>   # a push to main: every first-time author it landed thanked
 *   harness community credit --range <a>..<b> [--before <a>..<b>]   # contributors of a range, by login (release notes, the site)
 *   harness community spam-signal --interactions <path> --as-of <iso>
 *   harness community limit --apply <limit> --expiry <expiry> | --remove   # the maintainer's action
 *
 * The repository and the API come from the `forge` configuration section.
 * The publisher's actions (`comment`, `issue`, `welcome-pulls`, `thank`) read
 * the publisher App's installation token from the variable every publisher
 * job hands it in (`PUBLISHER_TOKEN_VARIABLE`); the maintainer's and the
 * audits' read `GH_TOKEN`. A token is read at call time and never logged.
 * An event is read from the file GitHub writes (`GITHUB_EVENT_PATH`), so no
 * event text is ever interpolated into a command line.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { configuredGitRepository, configuredWorktreeGitPort } from "../../git/worktree-port.ts";
import { loadPinnedConfigSnapshot } from "../../kernel/config.ts";
import { HarnessError, InputError } from "../../kernel/errors.ts";
import { deepFreeze } from "../../kernel/integrity.ts";
import { wrapResult, type CommandAnswer } from "../command-result.ts";
import { trackedTop } from "../evidence-store.ts";
import { FORGE_APPS } from "../forge/app-registry.ts";
import { configuredForge, configuredForgeClient } from "../forge/configured-forge.ts";
import { environmentCredential } from "../forge/credentials.ts";
import { trunkRepository } from "../forge/forge-config.ts";
import { PUBLISHER_TOKEN_VARIABLE } from "../forge/publish/product.ts";
import { worktreeOperationTimeouts } from "../workflow-config.ts";
import { remoteUrlOf } from "../workspace-forge.ts";
import { githubWorkspaceForge } from "../workspace-forge-github.ts";
import { categoryDrift, liveCategories } from "./categories.ts";
import { contributorsOf, landedCommits, releaseCredit } from "./credit.ts";
import { handleCommentEvent, type CommunityExecutor, type RecordLanding } from "./executor.ts";
import { applyInteractionLimit, INTERACTION_EXPIRIES, INTERACTION_LIMITS, readModeration, spamSignal, type Interaction, type InteractionExpiry, type InteractionLimit } from "./moderation.ts";
import { landIntakeRecord } from "./record.ts";
import { readIntake } from "./sources.ts";
import { thankLandedRange, welcomeIssue, welcomeOpenPullRequests } from "./welcome.ts";

const SHA = /^[0-9a-f]{40}$/u;
const RANGE = /^[A-Za-z0-9._/-]{1,200}\.\.[A-Za-z0-9._/-]{1,200}$/u;

/** The variable the maintainer's action and the audits read their token from. */
const MAINTAINER_TOKEN_VARIABLE = "GH_TOKEN";

const USAGE = "harness community takes: categories | comment --event <path> --remote <name> | issue --event <path> | welcome-pulls | thank --before <sha> --after <sha> | credit --range <a>..<b> [--before <a>..<b>] | spam-signal --interactions <path> --as-of <iso> | limit (--apply <limit> --expiry <expiry> | --remove)";

function usage(why: string): never {
  throw new InputError(`${why}. ${USAGE}`, "community_usage");
}

function readJson(path: string, what: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new InputError(`${what} at ${path} is unreadable as JSON (${(error as Error).message})`, "community_event_invalid");
  }
}

/** The executor this checkout's configuration names: the trunk repository, as the publisher App. */
function publisherExecutor(repositoryRoot: string): CommunityExecutor {
  const settings = configuredForge();
  return deepFreeze({
    client: configuredForgeClient(environmentCredential(`app:${FORGE_APPS.publisher.name}`, PUBLISHER_TOKEN_VARIABLE)),
    owner: settings.organization,
    repository: trunkRepository(settings).name,
    repositoryRoot,
    botLogin: `${FORGE_APPS.publisher.name}[bot]`,
    maxCommentPages: settings.request.maxPages,
  });
}

/**
 * The record landing of `executor`: the record committed in this checkout (the
 * workflow's checkout of the trunk branch, whose remote is `remote`) on
 * `intake/<id>` and published by the one publisher of commits through GH-3's
 * GitHub adapter of the Git Data port, as the publisher App.
 */
function recordLanding(executor: CommunityExecutor, remote: string): RecordLanding {
  return async (record, command, dates) => {
    const document = loadPinnedConfigSnapshot().document;
    const trunk = document.workspaceGit?.defaultBranch;
    if (trunk === undefined) throw new HarnessError("the configuration names no trunk branch (workspaceGit.defaultBranch)", "community_trunk_unconfigured");
    const repository = configuredGitRepository(document, executor.repositoryRoot);
    const remoteUrl = remoteUrlOf(repository, remote);
    const pull = await landIntakeRecord({
      forge: githubWorkspaceForge(executor.client, { owner: executor.owner, name: executor.repository }),
      repository,
      git: configuredWorktreeGitPort(document),
      target: { remote, remoteUrl, trunk },
      fetchMs: worktreeOperationTimeouts(document).fetchMs,
      author: { name: executor.botLogin, email: `${executor.botLogin}@users.noreply.github.com` },
    }, record, dates, command);
    return { url: pull.url };
  };
}

/** Run one `harness community` verb (see the header). */
export async function runCommunityCli(root: string, argv: readonly string[]): Promise<CommandAnswer> {
  const [verb, ...rest] = argv;
  let values: Readonly<Record<string, string | boolean | undefined>>;
  try {
    ({ values } = parseArgs({
      args: rest,
      options: {
        event: { type: "string" }, remote: { type: "string" }, after: { type: "string" }, range: { type: "string" }, before: { type: "string" },
        interactions: { type: "string" }, "as-of": { type: "string" }, apply: { type: "string" }, expiry: { type: "string" }, remove: { type: "boolean" },
      },
      strict: true,
    }));
  } catch (error) {
    return usage((error as Error).message);
  }
  const text = (name: string): string | undefined => (typeof values[name] === "string" ? values[name] : undefined);
  const event = text("event"), remote = text("remote"), range = text("range"), before = text("before"), after = text("after");
  const interactionsPath = text("interactions"), asOf = text("as-of"), apply = text("apply"), expiry = text("expiry");
  const repositoryRoot = trackedTop(root);
  switch (verb) {
    case "categories": {
      if (rest.length > 0) usage("categories takes no argument");
      const settings = configuredForge();
      const client = configuredForgeClient(environmentCredential("community:categories", MAINTAINER_TOKEN_VARIABLE));
      const repository = trunkRepository(settings).name;
      const drift = categoryDrift(readIntake(repositoryRoot).discussionCategories, await liveCategories(client, settings.organization, repository));
      return {
        result: wrapResult("community", deepFreeze({ verb, repository: `${settings.organization}/${repository}`, drift }), { status: drift.length === 0 ? "pass" : "fail" }),
        exitCode: drift.length === 0 ? 0 : 1,
      };
    }
    case "comment": {
      if (event === undefined || remote === undefined) usage("comment needs --event and --remote");
      const executor = publisherExecutor(repositoryRoot);
      const outcome = await handleCommentEvent(executor, readJson(event, "the comment event"), recordLanding(executor, remote));
      return { result: wrapResult("community", deepFreeze({ verb, outcome })) };
    }
    case "issue": {
      if (event === undefined) usage("issue needs --event");
      const outcome = await welcomeIssue(publisherExecutor(repositoryRoot), readJson(event, "the issue event"));
      return { result: wrapResult("community", deepFreeze({ verb, outcome })) };
    }
    case "welcome-pulls": {
      const outcomes = await welcomeOpenPullRequests(publisherExecutor(repositoryRoot), configuredForge().request.maxPages);
      return { result: wrapResult("community", deepFreeze({ verb, outcomes })) };
    }
    case "thank": {
      if (before === undefined || after === undefined || !SHA.test(before) || !SHA.test(after)) usage("thank needs --before <40-hex sha> --after <40-hex sha> (a push's range)");
      const outcomes = await thankLandedRange(publisherExecutor(repositoryRoot), before, after, configuredForge().request.maxPages);
      return { result: wrapResult("community", deepFreeze({ verb, outcomes })) };
    }
    case "credit": {
      // By GitHub login, never email (credit.ts): the range is read from GitHub, which knows each author's login.
      if (range === undefined || !RANGE.test(range) || (before !== undefined && !RANGE.test(before))) usage("credit needs --range <base>..<head> [--before <base>..<head>]");
      const settings = configuredForge();
      const client = configuredForgeClient(environmentCredential("community:credit", MAINTAINER_TOKEN_VARIABLE));
      const commitsOf = async (spec: string) => {
        const [base, head] = spec.split("..");
        return landedCommits(client, settings.organization, trunkRepository(settings).name, base!, head!, settings.request.maxPages);
      };
      const release = await commitsOf(range);
      const credit = before === undefined ? { all: contributorsOf(release), newcomers: [] } : releaseCredit(await commitsOf(before), release);
      return { result: wrapResult("community", deepFreeze({ verb, range, ...credit })) };
    }
    case "spam-signal": {
      if (interactionsPath === undefined || asOf === undefined) usage("spam-signal needs --interactions and --as-of");
      const interactions = readJson(interactionsPath, "the interactions") as readonly Interaction[];
      if (!Array.isArray(interactions)) usage("the interactions file is a JSON list");
      const signal = spamSignal(readModeration(repositoryRoot), interactions, asOf);
      return { result: wrapResult("community", deepFreeze({ verb, signal })) };
    }
    case "limit": {
      const settings = configuredForge();
      const client = configuredForgeClient(environmentCredential("maintainer:interaction-limit", MAINTAINER_TOKEN_VARIABLE));
      if (values.remove === true) {
        if (apply !== undefined || expiry !== undefined) usage("limit takes --remove alone");
        await applyInteractionLimit(client, settings.organization, trunkRepository(settings).name, null);
        return { result: wrapResult("community", deepFreeze({ verb, removed: true })) };
      }
      if (!(INTERACTION_LIMITS as readonly string[]).includes(apply ?? "") || !(INTERACTION_EXPIRIES as readonly string[]).includes(expiry ?? "")) {
        usage(`limit needs --apply (${INTERACTION_LIMITS.join(", ")}) and --expiry (${INTERACTION_EXPIRIES.join(", ")})`);
      }
      const request = { limit: apply as InteractionLimit, expiry: expiry as InteractionExpiry };
      await applyInteractionLimit(client, settings.organization, trunkRepository(settings).name, request);
      return { result: wrapResult("community", deepFreeze({ verb, applied: request })) };
    }
    default:
      return usage(verb === undefined ? "a verb is required" : `unknown verb ${verb}`);
  }
}
