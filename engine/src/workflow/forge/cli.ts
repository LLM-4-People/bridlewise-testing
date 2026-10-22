/**
 * `harness forge` — the forge's verbs (the CLI's one door into
 * `src/workflow/forge/`):
 *
 *   harness forge apps manifests [--check]   write (or check) .github/forge/ from the registry
 *   harness forge apps create                serve the Apps page (Session 1) until Done
 *   harness forge import-history <source> --to <target> [--review <file>]
 *                                            the one path a history enters the forge
 *                                            (history-import.ts): scanned, purged, re-scanned
 *                                            to zero, receipted, pushed into an empty target
 *
 * Every verb answers one result envelope (`{"result":{…}}`) and its progress
 * on stderr. The `forge` section of `bridlewise.config.json` is required
 * (`forge_not_configured` otherwise).
 */
import { resolve } from "node:path";

import { admitHarnessKeyHome } from "../../filesystem/self-protection/key-home.ts";
import { resolveGitExecutable } from "../../git/git-adapter.ts";
import { loadPinnedConfigSnapshot } from "../../kernel/config.ts";
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
import { admitImportHome, importHistory, type HistoryImportRequest } from "./history-import.ts";
import { maintainerCli } from "./maintainer-cli.ts";

const USAGE = "harness forge takes: apps manifests [--check] | apps create | import-history <source> --to <target> [--review <file>]";
const IMPORT_USAGE = "harness forge import-history <source> --to <target> [--review <file>]";

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
  const cli = maintainerCli(settings.webUrl, settings.maintainerCli);
  const ready = await cli.ready();
  if (!ready.ready) throw new ForgeError("forge_maintainer_cli_failed", `The maintainer's gh is not ready: ${ready.reason}.`, {});
  const trunk = `${settings.organization}/${trunkRepository(settings).name}`;
  for (const role of FORGE_APP_ROLES) {
    const custody = FORGE_APPS[role].custody;
    if (custody.kind === "environment" && !(await cli.environmentExists(trunk, custody.environment))) {
      throw new ForgeError("forge_environment_missing", `The environment '${custody.environment}' of ${trunk} does not exist; the ${role} App's key goes there.`, { environment: custody.environment, repository: trunk });
    }
  }
  const { discussionCategories } = readIntake(trackedTop(root));
  const page = await serveAppsPage({ settings, endpoint: forgeEndpoint(settings), keyHome: admitHarnessKeyHome([]), cli, port: settings.appsPage.port, discussionCategories });
  onProgress(`Open ${page.url} in your browser (Session 1). The address carries a one-time token: it is printed here only, and the page answers nothing without it. The page stays up until you press Done there.`);
  const summary = await page.done;
  return { result: wrapResult("forge", deepFreeze({ verb: "apps create", ...summary }), { status: summary.pending.length === 0 ? "pass" : "fail" }) };
}

/** The request `argv` (after `import-history`) names, or `history_import_usage`. */
export function parseImportHistoryArguments(argv: readonly string[]): HistoryImportRequest {
  let source: string | undefined;
  let target: string | undefined;
  let review: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--to" || argument === "--review") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new ForgeError("history_import_usage", `${argument} needs a value: ${IMPORT_USAGE}`);
      if (argument === "--to") target = value;
      else review = resolve(value);
      index += 1;
    } else if (argument.startsWith("--")) {
      throw new ForgeError("history_import_usage", `unknown option ${argument}: ${IMPORT_USAGE}`);
    } else if (source === undefined) {
      source = argument;
    } else {
      throw new ForgeError("history_import_usage", `one source only: ${IMPORT_USAGE}`);
    }
  }
  if (source === undefined || target === undefined) throw new ForgeError("history_import_usage", `a source and --to are required: ${IMPORT_USAGE}`);
  return Object.freeze({ source, target, ...(review === undefined ? {} : { review }) });
}

/** `harness forge import-history`: the importer (history-import.ts) with the admitted import home and the configured git. */
async function importHistoryVerb(root: string, rest: readonly string[], onProgress: (line: string) => void): Promise<CommandAnswer> {
  const request = parseImportHistoryArguments(rest);
  const home = admitImportHome(trackedTop(root));
  const git = resolveGitExecutable(loadPinnedConfigSnapshot().document.workspaceGit?.gitExecutablePath);
  const receipt = await importHistory(request, { home, git, onProgress });
  return { result: wrapResult("forge", receipt, { status: "pass" }) };
}

/** The `harness forge` dispatch. */
export async function runForgeCli(root: string, argv: readonly string[], onProgress: (line: string) => void): Promise<CommandAnswer> {
  const [group, verb, ...rest] = argv;
  if (group === "import-history") return importHistoryVerb(root, argv.slice(1), onProgress);
  if (group === "apps" && verb === "manifests") return appsManifests(root, rest);
  if (group === "apps" && verb === "create") return appsCreate(root, rest, onProgress);
  return usage();
}
