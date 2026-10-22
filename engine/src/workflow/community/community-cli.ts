/**
 * THE `harness community` DOOR: each community action, run on `main`'s code
 * by the workflow that GitHub's events trigger, or by the maintainer.
 *
 *   harness community comment --event <path>         # an issue_comment event: IssueOps
 *   harness community issue --event <path>           # an issues event: the newcomer's welcome
 *   harness community welcome-pulls                  # every newcomer's open pull request (scheduled)
 *   harness community thank --pull <n>               # a merged pull request: the first-landing thank-you
 *   harness community credit --range <a>..<b> [--before <a>]   # the contributors of a range (release notes, the site)
 *   harness community spam-signal --interactions <path> --as-of <iso>
 *   harness community limit --apply <limit> --expiry <expiry> | --remove   # the maintainer's action
 *
 * The repository and the API come from the `forge` configuration section;
 * the credential is the token in `GH_TOKEN` (the publisher App's token in the
 * workflow, the maintainer's for `limit`), read at call time and never
 * logged. An event is read from the file GitHub writes (`GITHUB_EVENT_PATH`),
 * so no event text is ever interpolated into a command line.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { gitOutput } from "../../git/tree-reader.ts";
import { configuredGitRepository } from "../../git/worktree-port.ts";
import { loadPinnedConfigSnapshot } from "../../kernel/config.ts";
import { InputError } from "../../kernel/errors.ts";
import { deepFreeze } from "../../kernel/integrity.ts";
import { wrapResult, type CommandAnswer } from "../command-result.ts";
import { trackedTop } from "../evidence-store.ts";
import { FORGE_APPS } from "../forge/app-registry.ts";
import { configuredForge, configuredForgeClient } from "../forge/configured-forge.ts";
import { environmentCredential } from "../forge/credentials.ts";
import { trunkRepository } from "../forge/forge-config.ts";
import { contributorsOf, releaseCredit, type CreditCommit } from "./credit.ts";
import { handleCommentEvent, type CommunityExecutor } from "./executor.ts";
import { applyInteractionLimit, INTERACTION_EXPIRIES, INTERACTION_LIMITS, readModeration, spamSignal, type Interaction, type InteractionExpiry, type InteractionLimit } from "./moderation.ts";
import { thankFirstLanding, welcomeIssue, welcomeOpenPullRequests } from "./welcome.ts";

/** The environment variable every community action's token is read from. */
const COMMUNITY_TOKEN_VARIABLE = "GH_TOKEN";

const USAGE = "harness community takes: comment --event <path> | issue --event <path> | welcome-pulls | thank --pull <n> | credit --range <a>..<b> [--before <a>] | spam-signal --interactions <path> --as-of <iso> | limit (--apply <limit> --expiry <expiry> | --remove)";

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
function configuredExecutor(repositoryRoot: string, principal: string): CommunityExecutor {
  const settings = configuredForge();
  return deepFreeze({
    client: configuredForgeClient(environmentCredential(principal, COMMUNITY_TOKEN_VARIABLE)),
    owner: settings.organization,
    repository: trunkRepository(settings).name,
    repositoryRoot,
    botLogin: `${FORGE_APPS.publisher.name}[bot]`,
    maxCommentPages: settings.request.maxPages,
  });
}

/** The commits of `range` (oldest first), as credit reads them. */
function commitsOf(repositoryRoot: string, range: string): readonly CreditCommit[] {
  if (!/^[A-Za-z0-9._/~^-]+(?:\.\.[A-Za-z0-9._/~^-]+)?$/u.test(range)) usage(`${range} is not a revision range`);
  const repository = configuredGitRepository(loadPinnedConfigSnapshot().document, repositoryRoot);
  const log = gitOutput(repository, ["log", "--reverse", "--no-merges", "--format=%H%x1f%an%x1f%ae%x1f%B%x1e", range, "--"]).stdout.toString("utf8");
  return log.split("\x1e").map((entry) => entry.replace(/^\n/u, "")).filter((entry) => entry.length > 0).map((entry) => {
    const [sha, authorName, authorEmail, message] = entry.split("\x1f");
    return deepFreeze({ sha: sha!, authorName: authorName!, authorEmail: authorEmail!, message: message ?? "" });
  });
}

/** Run one `harness community` verb (see the header). */
export async function runCommunityCli(root: string, argv: readonly string[]): Promise<CommandAnswer> {
  const [verb, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      event: { type: "string" }, pull: { type: "string" }, range: { type: "string" }, before: { type: "string" },
      interactions: { type: "string" }, "as-of": { type: "string" }, apply: { type: "string" }, expiry: { type: "string" }, remove: { type: "boolean" },
    },
    strict: true,
  });
  const repositoryRoot = trackedTop(root);
  switch (verb) {
    case "comment": {
      if (values.event === undefined) usage("comment needs --event");
      // The record landing (a pull request through GH-3's WorkspaceForge adapter, #232) is not wired yet, so a
      // triage command is refused before anything is posted (`community_record_landing_unavailable`).
      const outcome = await handleCommentEvent(configuredExecutor(repositoryRoot, "publisher:comment"), readJson(values.event, "the comment event"));
      return { result: wrapResult("community", deepFreeze({ verb, outcome })) };
    }
    case "issue": {
      if (values.event === undefined) usage("issue needs --event");
      const outcome = await welcomeIssue(configuredExecutor(repositoryRoot, "publisher:welcome"), readJson(values.event, "the issue event"));
      return { result: wrapResult("community", deepFreeze({ verb, outcome })) };
    }
    case "welcome-pulls": {
      const outcomes = await welcomeOpenPullRequests(configuredExecutor(repositoryRoot, "publisher:welcome"), configuredForge().request.maxPages);
      return { result: wrapResult("community", deepFreeze({ verb, outcomes })) };
    }
    case "thank": {
      const pull = Number(values.pull);
      if (!Number.isSafeInteger(pull) || pull <= 0) usage("thank needs --pull <n>");
      const outcome = await thankFirstLanding(configuredExecutor(repositoryRoot, "publisher:thanks"), pull);
      return { result: wrapResult("community", deepFreeze({ verb, outcome })) };
    }
    case "credit": {
      if (values.range === undefined) usage("credit needs --range");
      const release = commitsOf(repositoryRoot, values.range);
      const credit = values.before === undefined
        ? { all: contributorsOf(release), newcomers: [] }
        : releaseCredit(commitsOf(repositoryRoot, values.before), release);
      return { result: wrapResult("community", deepFreeze({ verb, range: values.range, ...credit })) };
    }
    case "spam-signal": {
      if (values.interactions === undefined || values["as-of"] === undefined) usage("spam-signal needs --interactions and --as-of");
      const interactions = readJson(values.interactions, "the interactions") as readonly Interaction[];
      if (!Array.isArray(interactions)) usage("the interactions file is a JSON list");
      const signal = spamSignal(readModeration(repositoryRoot), interactions, values["as-of"]);
      return { result: wrapResult("community", deepFreeze({ verb, signal })) };
    }
    case "limit": {
      const settings = configuredForge();
      const client = configuredForgeClient(environmentCredential("maintainer:interaction-limit", COMMUNITY_TOKEN_VARIABLE));
      if (values.remove === true) {
        if (values.apply !== undefined || values.expiry !== undefined) usage("limit takes --remove alone");
        await applyInteractionLimit(client, settings.organization, trunkRepository(settings).name, null);
        return { result: wrapResult("community", deepFreeze({ verb, removed: true })) };
      }
      if (!(INTERACTION_LIMITS as readonly string[]).includes(values.apply ?? "") || !(INTERACTION_EXPIRIES as readonly string[]).includes(values.expiry ?? "")) {
        usage(`limit needs --apply (${INTERACTION_LIMITS.join(", ")}) and --expiry (${INTERACTION_EXPIRIES.join(", ")})`);
      }
      const request = { limit: values.apply as InteractionLimit, expiry: values.expiry as InteractionExpiry };
      await applyInteractionLimit(client, settings.organization, trunkRepository(settings).name, request);
      return { result: wrapResult("community", deepFreeze({ verb, applied: request })) };
    }
    default:
      return usage(verb === undefined ? "a verb is required" : `unknown verb ${verb}`);
  }
}
