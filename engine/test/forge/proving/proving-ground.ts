/**
 * THE PROVING GROUND, as the workspace's scenarios use it (runbook P1.11/P3.8):
 * the organisation's `forge-proving-ground` repository on REAL GitHub,
 * reached as the `agent` App through the one credential module (the key in
 * the host key home, an installation token minted for that one repository;
 * nothing is printed). Not a test file: the offline suites never load it
 * (it reaches the network), `run.ts` does.
 *
 * Its CONFIGURATION is not made here: the one settings owner is the forge's
 * settings-as-code (`harness forge apply`, run with the owner credential),
 * which declares the proving ground's ruleset on `main` (`merge_queue` and
 * `required_signatures`) and `delete_branch_on_merge`. A scenario READS that
 * configuration first and refuses to run without it
 * (`proving_ground_unconfigured`, naming what is missing) — a proof on an
 * unconfigured repository proves nothing. The one write here is the seed: the
 * repository's first commit on `main` (the contents API, the only API that
 * commits into an empty repository; the App's commit, signed by GitHub).
 *
 * THE WORKSPACE ON IT: a scratch clone of the proving ground (fetched over
 * https; the repository is public) and the real workspace manager over it,
 * its forge the real GitHub implementation (`githubWorkspaceForge`) on the
 * agent's client — the exact code `ws` runs, pointed at the proving ground.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { admitHarnessKeyHome } from "../../../src/filesystem/self-protection/key-home.ts";
import { HarnessError } from "../../../src/kernel/errors.ts";
import { loadPinnedConfigSnapshot } from "../../../src/kernel/config.ts";
import { configuredGitRepository, configuredWorktreeGitPort } from "../../../src/git/worktree-port.ts";
import { gitOutput } from "../../../src/git/tree-reader.ts";
import { keyHomeCustody } from "../../../src/workflow/forge/app-keys.ts";
import { isForgeError } from "../../../src/workflow/forge/codes.ts";
import { configuredForge, configuredForgeClient } from "../../../src/workflow/forge/configured-forge.ts";
import { appInstallationCredential } from "../../../src/workflow/forge/credentials.ts";
import { forgeEndpoint } from "../../../src/workflow/forge/forge-config.ts";
import type { ForgeClient } from "../../../src/workflow/forge/port.ts";
import { githubWorkspaceForge } from "../../../src/workflow/workspace-forge-github.ts";
import { worktreeOperationTimeouts } from "../../../src/workflow/workflow-config.ts";
import { createWorkspaceManager, type WorkspaceManager } from "../../../src/workflow/workspace-manager.ts";

/** The proving ground's repository name (runbook P1.3). */
export const PROVING_GROUND = "forge-proving-ground";

export type ProvingGround = Readonly<{ owner: string; name: string; webUrl: string; client: ForgeClient }>;

/** The proving ground, reached as the `agent` App (see the header). */
export function provingGround(): ProvingGround {
  const settings = configuredForge();
  const credential = appInstallationCredential(forgeEndpoint(settings), keyHomeCustody(admitHarnessKeyHome([])), {
    role: "agent", owner: settings.organization, repository: PROVING_GROUND, renewBeforeMs: settings.tokenRenewBeforeMs,
  });
  return Object.freeze({ owner: settings.organization, name: PROVING_GROUND, webUrl: settings.webUrl.replace(/\/+$/u, ""), client: configuredForgeClient(credential) });
}

function path(ground: ProvingGround, rest = ""): string {
  return `/repos/${encodeURIComponent(ground.owner)}/${encodeURIComponent(ground.name)}${rest}`;
}

/** `main`'s head, or null while the repository is empty (GitHub answers 409) or has no `main`. */
export async function mainHead(ground: ProvingGround): Promise<string | null> {
  try {
    const answer = await ground.client.rest<{ object?: { sha?: unknown } }>({ method: "GET", path: path(ground, "/git/ref/heads/main") });
    return typeof answer.data?.object?.sha === "string" ? answer.data.object.sha : null;
  } catch (error) {
    if (isForgeError(error, "github_conflict", "github_not_found")) return null;
    throw error;
  }
}

/**
 * THE SEED: the repository's first commit on `main` (a README), made by the
 * agent through the contents API, only while the repository is empty.
 * Answers `main`'s head and whether this call made it.
 */
export async function seedMain(ground: ProvingGround): Promise<Readonly<{ head: string; created: boolean }>> {
  const existing = await mainHead(ground);
  if (existing !== null) return Object.freeze({ head: existing, created: false });
  const readme = "# forge-proving-ground\n\nThe proving ground of the Bridlewise forge (runbook P1.11, P3.8): scenarios run here against real GitHub; nothing here is product code.\n";
  const answer = await ground.client.rest<{ commit?: { sha?: unknown } }>({
    method: "PUT", path: path(ground, "/contents/README.md"),
    body: { message: "Seed the proving ground", content: Buffer.from(readme, "utf8").toString("base64"), branch: "main" },
  });
  const head = answer.data?.commit?.sha;
  if (typeof head !== "string") throw new HarnessError("GitHub's answer to the seed commit names no commit", "proving_ground_seed_failed");
  return Object.freeze({ head, created: true });
}

/** What the scenarios need of the repository's configuration (see the header). */
export const REQUIRED_RULES = Object.freeze(["merge_queue", "required_signatures"] as const);

/**
 * Refuses (`proving_ground_unconfigured`) unless the proving ground is
 * configured as the scenarios need: `main` exists, the rules in force on it
 * include {@link REQUIRED_RULES}, and the repository deletes a merged head
 * branch. Read as the agent (`GET …/rules/branches/main` answers the rules in
 * force to any reader).
 */
export async function requireConfigured(ground: ProvingGround): Promise<void> {
  const missing: string[] = [];
  if (await mainHead(ground) === null) missing.push("a main branch (run `seed`)");
  const repository = await ground.client.rest<{ delete_branch_on_merge?: unknown }>({ method: "GET", path: path(ground) });
  if (repository.data?.delete_branch_on_merge !== true) missing.push("delete_branch_on_merge: true");
  const rules = missing.length > 0 && missing[0]!.startsWith("a main") ? [] : (await ground.client.rest<readonly { type?: unknown }[]>({ method: "GET", path: path(ground, "/rules/branches/main") })).data ?? [];
  const types = new Set(rules.map((rule) => rule.type));
  for (const rule of REQUIRED_RULES) if (!types.has(rule)) missing.push(`the ${rule} rule on main`);
  if (missing.length > 0) {
    throw new HarnessError(
      `${ground.owner}/${ground.name} is not configured for the scenarios: missing ${missing.join(", ")} — its configuration is declared in the forge's settings-as-code and applied by \`harness forge apply\`, never by hand`,
      "proving_ground_unconfigured",
    );
  }
}

/** The commit's signature verification as GitHub reports it. */
export async function commitVerification(ground: ProvingGround, sha: string): Promise<Readonly<{ verified: boolean; reason: string }>> {
  const answer = await ground.client.rest<{ verification?: { verified?: unknown; reason?: unknown } }>({ method: "GET", path: path(ground, `/git/commits/${sha}`) });
  return Object.freeze({ verified: answer.data?.verification?.verified === true, reason: String(answer.data?.verification?.reason ?? "unknown") });
}

/**
 * A WORKSPACE ON THE PROVING GROUND: a scratch clone of it under `scratch`
 * (whose `main` tracks `origin/main`, the land target) and the real workspace
 * manager over it — the pinned configuration's git and timeouts, no gates of
 * its own (a scenario proves the forge, not a suite), landing on `main`, and
 * its forge the real GitHub implementation on the agent's client.
 */
export function provingWorkspace(ground: ProvingGround, scratch: string, onProgress: (line: string) => void): Readonly<{ clone: string; manager: WorkspaceManager }> {
  const snapshot = loadPinnedConfigSnapshot();
  const isolation = snapshot.document.workspaceIsolation!;
  const clone = join(scratch, "clone");
  mkdirSync(scratch, { recursive: true });
  const run = (cwd: string, argv: readonly string[]): string => gitOutput(configuredGitRepository(snapshot.document, cwd), argv).stdout.toString("utf8").trim();
  run(scratch, ["clone", "-q", `${ground.webUrl}/${ground.owner}/${ground.name}.git`, clone]);
  // The local commits' author (the publisher names it in a Co-authored-by trailer; the twin is the App's, signed by GitHub).
  run(clone, ["config", "user.name", "bridlewise proving ground"]);
  run(clone, ["config", "user.email", "proving-ground@bridlewise.invalid"]);
  const git = configuredWorktreeGitPort(snapshot.document);
  const manager = createWorkspaceManager({
    checkoutRoot: clone,
    engineRelative: "",
    config: {
      ...isolation,
      workspaceRoot: join(scratch, "workspaces"),
      landTargets: ["main"],
      links: [],
      commands: {},
      phases: { setup: [], validate: [], regenerate: [], merge: [] },
    },
    git,
    repository: (checkout: string) => configuredGitRepository(snapshot.document, checkout),
    forge: () => githubWorkspaceForge(ground.client, { owner: ground.owner, name: ground.name }),
    commands: { run: async (_checkout, name) => { throw new HarnessError(`the proving ground runs no command (${name})`, "proving_ground_command"); } },
    timeouts: worktreeOperationTimeouts(snapshot.document),
    timeline: null,
    onProgress,
  });
  return Object.freeze({ clone, manager });
}
