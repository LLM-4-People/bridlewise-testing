/**
 * THE PROVING GROUND ON REAL GITHUB, as the workspace's scenarios use it
 * (runbook P1.11/P3.8): the forge section's one `provingGround` repository
 * (`provingGroundRepository`, never the trunk), reached as the `agent` App
 * through the one credential module (the key in the host key home, an
 * installation token minted for that one repository; nothing is printed).
 * Not a test file: no offline test may load this folder
 * (`../proving-isolation.test.ts`); `run.ts` does. Its seed, configuration
 * check and verdict rules live in `../proving-ground-api.ts`, tested offline.
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
import { configuredForge, configuredForgeClient } from "../../../src/workflow/forge/configured-forge.ts";
import { appInstallationCredential } from "../../../src/workflow/forge/credentials.ts";
import { forgeEndpoint } from "../../../src/workflow/forge/forge-config.ts";
import { githubWorkspaceForge } from "../../../src/workflow/workspace-forge-github.ts";
import { worktreeOperationTimeouts } from "../../../src/workflow/workflow-config.ts";
import { createWorkspaceManager, type WorkspaceManager } from "../../../src/workflow/workspace-manager.ts";
import { provingGroundRepository, type ProvingGround } from "../proving-ground-api.ts";

/** The proving ground, reached as the `agent` App (see the header). */
export function provingGround(): ProvingGround {
  const settings = configuredForge();
  const name = provingGroundRepository(settings);
  const credential = appInstallationCredential(forgeEndpoint(settings), keyHomeCustody(admitHarnessKeyHome([])), {
    role: "agent", owner: settings.organization, repository: name, renewBeforeMs: settings.tokenRenewBeforeMs,
  });
  return Object.freeze({ owner: settings.organization, name, webUrl: settings.webUrl.replace(/\/+$/u, ""), client: configuredForgeClient(credential) });
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
