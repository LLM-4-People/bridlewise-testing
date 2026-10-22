/**
 * `harness forge` — the forge's verbs (the CLI's one door into
 * `src/workflow/forge/`):
 *
 *   harness forge apps manifests [--check]   write (or check) .github/forge/ from the registry
 *   harness forge apps create                serve the Apps page (Session 1) until Done
 *
 * Every verb answers one result envelope (`{"result":{…}}`) and its progress
 * on stderr. The `forge` section of `bridlewise.config.json` is required
 * (`forge_not_configured` otherwise).
 */
import { admitHarnessKeyHome } from "../../filesystem/self-protection/key-home.ts";
import { deepFreeze } from "../../kernel/integrity.ts";
import { wrapResult, type CommandAnswer } from "../command-result.ts";
import { readIntake } from "../community/sources.ts";
import { trackedTop } from "../evidence-store.ts";
import { FORGE_APP_ROLES, FORGE_APPS } from "./app-registry.ts";
import { serveAppsPage } from "./apps-page.ts";
import { ForgeError } from "./codes.ts";
import { configuredForge } from "./configured-forge.ts";
import { forgeEndpoint, trunkRepository } from "./forge-config.ts";
import { syncForgeFiles } from "./generated-files.ts";
import { maintainerCli } from "./maintainer-cli.ts";

const USAGE = "harness forge takes: apps manifests [--check] | apps create";

function usage(): never {
  throw new ForgeError("forge_usage", USAGE, {});
}

/** `harness forge apps manifests [--check]`. */
function appsManifests(root: string, rest: readonly string[]): CommandAnswer {
  if (rest.some((argument) => argument !== "--check")) usage();
  const write = !rest.includes("--check");
  const report = syncForgeFiles(trackedTop(root), configuredForge(), write);
  return { result: wrapResult("forge", deepFreeze({ verb: "apps manifests", ...report }), { status: report.converged ? "pass" : "fail" }) };
}

/** `harness forge apps create`: preflight, then the page until Done. */
async function appsCreate(root: string, rest: readonly string[], onProgress: (line: string) => void): Promise<CommandAnswer> {
  if (rest.length > 0) usage();
  const settings = configuredForge();
  const cli = maintainerCli(settings.webUrl, settings.request.timeoutMs);
  const ready = cli.ready();
  if (!ready.ready) throw new ForgeError("forge_maintainer_cli_failed", `The maintainer's gh is not ready: ${ready.reason}.`, {});
  const trunk = `${settings.organization}/${trunkRepository(settings).name}`;
  for (const role of FORGE_APP_ROLES) {
    const custody = FORGE_APPS[role].custody;
    if (custody.kind === "environment" && !cli.environmentExists(trunk, custody.environment)) {
      throw new ForgeError("forge_environment_missing", `The environment '${custody.environment}' of ${trunk} does not exist; the ${role} App's key goes there.`, { environment: custody.environment, repository: trunk });
    }
  }
  const { discussionCategories } = readIntake(trackedTop(root));
  const page = await serveAppsPage({ settings, endpoint: forgeEndpoint(settings), keyHome: admitHarnessKeyHome([]), cli, port: settings.appsPage.port, discussionCategories });
  onProgress(`Open ${page.url} in your browser (Session 1). The page stays up until you press Done there.`);
  const summary = await page.done;
  return { result: wrapResult("forge", deepFreeze({ verb: "apps create", ...summary }), { status: summary.pending.length === 0 ? "pass" : "fail" }) };
}

/** The `harness forge` dispatch. */
export async function runForgeCli(root: string, argv: readonly string[], onProgress: (line: string) => void): Promise<CommandAnswer> {
  const [group, verb, ...rest] = argv;
  if (group === "apps" && verb === "manifests") return appsManifests(root, rest);
  if (group === "apps" && verb === "create") return appsCreate(root, rest, onProgress);
  return usage();
}
