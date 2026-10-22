/**
 * `harness forge` — the forge's verbs (the CLI's one door into
 * `src/workflow/forge/`):
 *
 *   harness forge apps manifests [--check]           write (or check) the generated files from their owners
 *   harness forge apps create                        serve the Apps page (Session 1) until Done
 *   harness forge plan  (--token-env <VAR> | --token-stdin)   what apply would change (read-only)
 *   harness forge apply (--token-env <VAR> | --token-stdin)   send the whole plan, then verify it
 *   harness forge audit (--token-env <VAR> | --token-stdin)   the plan judged: any drift fails
 *
 * The credential of plan, apply and audit is never an argument or a file:
 * `--token-env` names the environment variable a workflow set (the
 * publisher's minted token for the audit), `--token-stdin` reads it from
 * standard input — a pipe, or the terminal with no echo (the maintainer's
 * short-lived token, github-only §3.4) — and holds it in memory only.
 * Plan, apply and audit refuse a tree whose generated files are stale: what
 * GitHub receives is exactly what the reviewed `.github/forge/` says.
 *
 * Every verb answers one result envelope (`{"result":{…}}`) and its progress
 * on stderr. The `forge` section of `bridlewise.config.json` is required
 * (`forge_not_configured` otherwise).
 */
import { admitHarnessKeyHome } from "../../filesystem/self-protection/key-home.ts";
import { deepFreeze } from "../../kernel/integrity.ts";
import { guarded } from "../../process/fault-policy.ts";
import { wrapResult, type CommandAnswer } from "../command-result.ts";
import { readIntake } from "../community/sources.ts";
import { trackedTop } from "../evidence-store.ts";
import { FORGE_APP_ROLES, FORGE_APPS } from "./app-registry.ts";
import { serveAppsPage } from "./apps-page.ts";
import { ForgeError } from "./codes.ts";
import { configuredForge } from "./configured-forge.ts";
import { environmentCredential, memoryCredential } from "./credentials.ts";
import { forgeDeclarations } from "./declarations.ts";
import { forgeEndpoint, trunkRepository } from "./forge-config.ts";
import { forgeFileSources, syncForgeFiles } from "./generated-files.ts";
import { githubClient } from "./github.ts";
import { forgeApply, forgePlan } from "./plan.ts";
import { maintainerCli } from "./maintainer-cli.ts";
import type { ForgeCredential } from "./port.ts";

const USAGE = "harness forge takes: apps manifests [--check] | apps create | plan|apply|audit (--token-env <VAR> | --token-stdin)";

function usage(): never {
  throw new ForgeError("forge_usage", USAGE, {});
}

/** `harness forge apps manifests [--check]`. */
function appsManifests(root: string, rest: readonly string[]): CommandAnswer {
  if (rest.some((argument) => argument !== "--check")) usage();
  const write = !rest.includes("--check");
  const top = trackedTop(root);
  const report = syncForgeFiles(top, forgeFileSources(top, configuredForge()), write);
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

/** Read a token from standard input: a pipe's whole text, or the terminal's line with no echo. */
async function tokenFromStdin(onProgress: (line: string) => void): Promise<string> {
  const input = process.stdin;
  if (input.isTTY !== true) {
    let text = "";
    for await (const chunk of input) text += String(chunk);
    return text.trim();
  }
  onProgress("GitHub token (not echoed; held in memory only):");
  input.setRawMode(true);
  input.resume();
  try {
    return await new Promise<string>((resolve, reject) => {
      let token = "";
      input.on("data", guarded("forge.cli.token-prompt", (chunk: Buffer) => {
        for (const character of chunk.toString("utf8")) {
          if (character === "\r" || character === "\n") { resolve(token.trim()); return; }
          if (character === "\u0003") { reject(new ForgeError("forge_token_unavailable", "The token prompt was interrupted.", {})); return; }
          token = character === "\u007f" ? token.slice(0, -1) : token + character;
        }
      }));
    });
  } finally {
    input.setRawMode(false);
    input.pause();
    input.removeAllListeners("data");
  }
}

/** The credential `--token-env <VAR>` or `--token-stdin` names (exactly one). */
async function settingsCredential(rest: readonly string[], onProgress: (line: string) => void): Promise<ForgeCredential> {
  if (rest.length === 2 && rest[0] === "--token-env" && /^[A-Z_][A-Z0-9_]*$/u.test(rest[1]!)) return environmentCredential(`token:${rest[1]!}`, rest[1]!);
  if (rest.length === 1 && rest[0] === "--token-stdin") return memoryCredential("token:stdin", await tokenFromStdin(onProgress));
  return usage();
}

/** `harness forge plan|apply|audit`. */
async function settingsVerb(root: string, verb: "plan" | "apply" | "audit", rest: readonly string[], onProgress: (line: string) => void): Promise<CommandAnswer> {
  const settings = configuredForge();
  const top = trackedTop(root);
  const sources = forgeFileSources(top, settings);
  const files = syncForgeFiles(top, sources, false);
  if (!files.converged) {
    throw new ForgeError("forge_declaration_invalid", `The generated forge files are stale (run harness sync, then review them): ${files.changed.join(", ")}.`, { changed: files.changed });
  }
  const credential = await settingsCredential(rest, onProgress);
  const context = { client: githubClient(forgeEndpoint(settings), credential), organization: settings.organization, maxPages: settings.request.maxPages };
  const objects = forgeDeclarations(sources);
  if (verb === "apply") {
    const outcome = await forgeApply(context, objects, settings.retired);
    const verified = outcome.verification.drift.length === 0;
    return { result: wrapResult("forge", deepFreeze({ verb, applied: outcome.applied, verification: outcome.verification }), { status: verified ? "pass" : "fail" }) };
  }
  const plan = await forgePlan(context, objects, settings.retired);
  const status = verb === "audit" ? (plan.drift.length === 0 ? "pass" : "fail") : (plan.complete ? "pass" : "fail");
  return { result: wrapResult("forge", deepFreeze({ verb, ...plan }), { status }) };
}

/** The `harness forge` dispatch. */
export async function runForgeCli(root: string, argv: readonly string[], onProgress: (line: string) => void): Promise<CommandAnswer> {
  const [group, verb, ...rest] = argv;
  if (group === "apps" && verb === "manifests") return appsManifests(root, rest);
  if (group === "apps" && verb === "create") return appsCreate(root, rest, onProgress);
  if (group === "plan" || group === "apply" || group === "audit") return settingsVerb(root, group, argv.slice(1), onProgress);
  return usage();
}
