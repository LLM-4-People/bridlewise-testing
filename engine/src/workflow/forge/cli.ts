/**
 * `harness forge` — the forge's verbs (the CLI's one door into
 * `src/workflow/forge/`):
 *
 *   harness forge apps manifests [--check]   write (or check) .github/forge/ from the registry
 *   harness forge apps create                serve the Apps page (Session 1) until Done
 *   harness forge apps audit [--role <role>]…  each App's installation, read by the App, against the registry
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
import { FORGE_APP_ROLES, FORGE_APPS, type ForgeAppRole } from "./app-registry.ts";
import { environmentKeyCustody, keyHomeCustody, type AppKeyCustody } from "./app-keys.ts";
import { auditAppInstallation } from "./apps-audit.ts";
import { serveAppsPage } from "./apps-page.ts";
import { ForgeError } from "./codes.ts";
import { configuredForge } from "./configured-forge.ts";
import { forgeEndpoint, trunkRepository, type ForgeSettings } from "./forge-config.ts";
import { syncForgeFiles } from "./generated-files.ts";
import { maintainerCli } from "./maintainer-cli.ts";
import type { ForgeEndpoint } from "./port.ts";

const USAGE = "harness forge takes: apps manifests [--check] | apps create | apps audit [--role <agent|verifier|door|publisher>]...";

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

/**
 * `harness forge apps audit [--role <role>]…` (runbook P1.11): each App's
 * installation, read by the App itself, against the registry. Without
 * `--role` it audits the host Apps (their keys are in the key home). An
 * environment App is named by `--role` inside its own environment's job,
 * where its key is handed in (`forge-apps-audit.yml`).
 */
async function appsAudit(rest: readonly string[], wiring: ForgeCliWiring): Promise<CommandAnswer> {
  const roles: ForgeAppRole[] = [];
  for (let index = 0; index < rest.length; index += 2) {
    const role = rest[index + 1];
    if (rest[index] !== "--role" || role === undefined || !(FORGE_APP_ROLES as readonly string[]).includes(role)) usage();
    roles.push(role as ForgeAppRole);
  }
  const settings = wiring.settings();
  const audited = roles.length > 0 ? roles : FORGE_APP_ROLES.filter((role) => FORGE_APPS[role].custody.kind === "host");
  const audits = [];
  for (const role of audited) {
    const custody = FORGE_APPS[role].custody.kind === "host" ? wiring.hostCustody() : environmentKeyCustody();
    audits.push(await auditAppInstallation(wiring.endpoint(settings), custody, role, settings));
  }
  const ok = audits.every((audit) => audit.ok);
  return { result: wrapResult("forge", deepFreeze({ verb: "apps audit", ok, audits }), { status: ok ? "pass" : "fail" }) };
}

/**
 * What the verbs that talk to GitHub reach: the forge section, the endpoint
 * it names, and the host Apps' key custody. In production these are this
 * checkout's configured section and its key home; the CLI-level tests pass
 * a test section, a fake GitHub's endpoint and a key home of their own, and
 * drive the very same verbs. ONE parameter object for every verb (#312's
 * apps audit reads `hostCustody`).
 */
export type ForgeCliWiring = Readonly<{
  settings: () => ForgeSettings;
  endpoint: (settings: ForgeSettings) => ForgeEndpoint;
  hostCustody: () => AppKeyCustody;
}>;

const CONFIGURED: ForgeCliWiring = Object.freeze({
  settings: configuredForge,
  endpoint: forgeEndpoint,
  hostCustody: () => keyHomeCustody(admitHarnessKeyHome([])),
});

/** The `harness forge` dispatch. */
export async function runForgeCli(root: string, argv: readonly string[], onProgress: (line: string) => void, wiring: ForgeCliWiring = CONFIGURED): Promise<CommandAnswer> {
  const [group, verb, ...rest] = argv;
  if (group === "apps" && verb === "manifests") return appsManifests(root, rest);
  if (group === "apps" && verb === "create") return appsCreate(root, rest, onProgress);
  if (group === "apps" && verb === "audit") return appsAudit(rest, wiring);
  return usage();
}
