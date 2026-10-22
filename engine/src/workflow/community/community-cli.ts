/**
 * THE `harness community` DOOR: the community actions that read or write
 * GitHub, run on `main`'s code.
 *
 *   harness community categories     # audit the Discussion categories against the intake registry
 *   harness community labels         # audit the community labels against docs/community/labels.json
 *
 * The repository and the API come from the `forge` configuration section;
 * the credential is the token in `GH_TOKEN`, read at call time and never
 * logged. Drift is the verb's `fail` status (exit 1), with each difference
 * and what to do about it.
 */
import { InputError } from "../../kernel/errors.ts";
import { deepFreeze } from "../../kernel/integrity.ts";
import { wrapResult, type CommandAnswer } from "../command-result.ts";
import { trackedTop } from "../evidence-store.ts";
import { configuredForge, configuredForgeClient } from "../forge/configured-forge.ts";
import { environmentCredential } from "../forge/credentials.ts";
import { trunkRepository } from "../forge/forge-config.ts";
import { categoryDrift, liveCategories } from "./categories.ts";
import { labelDrift, liveLabels, readLabels } from "./labels.ts";
import { readIntake } from "./sources.ts";

/** The environment variable every community action's token is read from. */
const COMMUNITY_TOKEN_VARIABLE = "GH_TOKEN";

const USAGE = "harness community takes: categories | labels";

/** Run one `harness community` verb (see the header). */
export async function runCommunityCli(root: string, argv: readonly string[]): Promise<CommandAnswer> {
  const [verb, ...rest] = argv;
  if ((verb !== "categories" && verb !== "labels") || rest.length > 0) {
    throw new InputError(`${verb === undefined ? "a verb is required" : `unknown verb or arguments: ${argv.join(" ")}`}. ${USAGE}`, "community_usage");
  }
  const settings = configuredForge();
  const client = configuredForgeClient(environmentCredential(`community:${verb}`, COMMUNITY_TOKEN_VARIABLE));
  const repository = trunkRepository(settings).name;
  if (verb === "labels") {
    const { drift, others } = labelDrift(readLabels(trackedTop(root)), await liveLabels(client, settings.organization, repository, settings.request.maxPages));
    return {
      result: wrapResult("community", deepFreeze({ verb, repository: `${settings.organization}/${repository}`, drift, others }), { status: drift.length === 0 ? "pass" : "fail" }),
      exitCode: drift.length === 0 ? 0 : 1,
    };
  }
  const drift = categoryDrift(readIntake(trackedTop(root)).discussionCategories, await liveCategories(client, settings.organization, repository));
  return {
    result: wrapResult("community", deepFreeze({ verb, repository: `${settings.organization}/${repository}`, drift }), { status: drift.length === 0 ? "pass" : "fail" }),
    exitCode: drift.length === 0 ? 0 : 1,
  };
}
