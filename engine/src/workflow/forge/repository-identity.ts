/**
 * THE REPOSITORY IDENTITY: the one place every reference to this
 * repository's GitHub address is derived from. That covers its
 * `owner/name`, its web, clone and issue URLs, its project Pages address
 * and base path, and the names of the organisation's other Bridlewise
 * repositories. The source is the `forge` section: the organisation, the
 * web origin, and the repository of kind `trunk`.
 *
 * Renaming the repository (runbook P1.10: bridlewise-testing → bridlewise)
 * is then one value in `bridlewise.config.json`, landed together with the
 * GitHub-side rename. Code reads it here, and generated files are
 * regenerated from it.
 */
import { deepFreeze } from "../../kernel/integrity.ts";
import { ForgeError } from "./codes.ts";
import { configuredForge } from "./configured-forge.ts";
import { trunkRepository, type ForgeSettings } from "./forge-config.ts";

export type RepositoryIdentity = Readonly<{
  /** The organisation (`LLM-4-People`). */
  owner: string;
  /** The repository's name (`bridlewise-testing`). */
  name: string;
  /** `owner/name`, as the API and `actions/checkout` name it. */
  fullName: string;
  /** `https://github.com/owner/name`. */
  webUrl: string;
  /** The clone URL (`…/name.git`). */
  gitUrl: string;
  /** The issue tracker (`…/name/issues`). */
  issuesUrl: string;
  /** The project Pages site's base path (`/name`). */
  pagesBasePath: string;
  /** The project Pages site (`https://owner.github.io/name/`, the owner lower-cased as GitHub serves it). */
  pagesUrl: string;
  /** Every repository of the organisation the forge declares (this one included), by name. */
  organisationRepositories: readonly string[];
}>;

/** The trunk repository's identity under `settings`. */
export function repositoryIdentity(settings: ForgeSettings): RepositoryIdentity {
  const web = new URL(settings.webUrl);
  if (web.origin !== "https://github.com") {
    throw new ForgeError("forge_endpoint_invalid", `Project Pages addresses are derived for github.com only; the forge names ${web.origin}.`, { webUrl: settings.webUrl });
  }
  const owner = settings.organization;
  const { name } = trunkRepository(settings);
  const webUrl = `${web.origin}/${owner}/${name}`;
  return deepFreeze({
    owner,
    name,
    fullName: `${owner}/${name}`,
    webUrl,
    gitUrl: `${webUrl}.git`,
    issuesUrl: `${webUrl}/issues`,
    pagesBasePath: `/${name}`,
    pagesUrl: `https://${owner.toLowerCase()}.github.io/${name}/`,
    organisationRepositories: settings.repositories.map((repository) => repository.name),
  });
}

/** This checkout's repository identity, from its configured `forge` section (`forge_not_configured` without one). */
export function configuredRepositoryIdentity(): RepositoryIdentity {
  return repositoryIdentity(configuredForge());
}
