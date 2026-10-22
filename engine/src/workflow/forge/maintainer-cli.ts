/**
 * THE MAINTAINER'S GITHUB CLI, while the owner credential is on the host
 * (Session 1, runbook §U; decision B removes it at P3.9). The forge uses it
 * for exactly what neither the forge port nor an App can do:
 *
 * - writing a GitHub ENVIRONMENT SECRET (the door and publisher App keys):
 *   GitHub takes a secret only sealed to the environment's public key with
 *   libsodium's sealed box (X25519 + XSalsa20-Poly1305 + BLAKE2b), which
 *   Node's crypto cannot build; `gh secret set` seals it. The value goes to
 *   `gh` on STDIN, never in an argument, a file, a log or a returned fact;
 * - an environment VARIABLE (the App's client id) and reading whether an
 *   environment exists, with the same principal, so the owner token never
 *   enters this process.
 *
 * Every call is one `gh` run with an argument list (never a shell), a
 * projected environment (no `GH_TOKEN`/`GITHUB_TOKEN` passes: `gh` uses its
 * own store), and a bound. A failure is the typed
 * `forge_maintainer_cli_failed` with `gh`'s own words (its stderr, which
 * never holds the value).
 */
import { spawnSync } from "node:child_process";

import { COMMAND_ENVIRONMENT, projectEnvironment } from "../../process/environment-projection.ts";
import { ForgeError } from "./codes.ts";

/** What `gh` needs besides the command set: its own configuration home. */
const GH_ENVIRONMENT: readonly string[] = Object.freeze([...COMMAND_ENVIRONMENT, "XDG_CONFIG_HOME", "GH_CONFIG_DIR", "GH_HOST"]);

/** One `gh` invocation's outcome as the forge reads it. */
export type MaintainerCliRun = (args: readonly string[], input: string | undefined, timeoutMs: number) => Readonly<{ status: number | null; stdout: string; stderr: string; missing: boolean }>;

/** THE RUN: `gh` with an argument list and a projected environment. */
export const runGh: MaintainerCliRun = (args, input, timeoutMs) => {
  const result = spawnSync("gh", [...args], {
    input: input ?? "",
    encoding: "utf8",
    env: projectEnvironment(process.env, GH_ENVIRONMENT),
    timeout: timeoutMs,
    maxBuffer: 1_048_576,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const missing = (result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
  return Object.freeze({ status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", missing });
};

export type MaintainerCli = Readonly<{
  /** Whether `gh` is installed and logged in to the web origin's host (`gh auth status`). */
  ready: () => Readonly<{ ready: true } | { ready: false; reason: string }>;
  environmentExists: (repository: string, environment: string) => boolean;
  setEnvironmentSecret: (repository: string, environment: string, name: string, value: string) => void;
  setEnvironmentVariable: (repository: string, environment: string, name: string, value: string) => void;
}>;

function failed(what: string, run: ReturnType<MaintainerCliRun>): ForgeError {
  const words = run.missing ? "the gh command is not installed" : run.stderr.trim().split("\n").slice(-3).join(" ").slice(0, 400);
  return new ForgeError("forge_maintainer_cli_failed", `${what}: ${words || `gh exited ${String(run.status)}`}`, { what, ...(run.status === null ? {} : { exitCode: run.status }) });
}

/** The maintainer's CLI over `run` (production: {@link runGh}), for the GitHub host of `webUrl`. */
export function maintainerCli(webUrl: string, timeoutMs: number, run: MaintainerCliRun = runGh): MaintainerCli {
  const host = new URL(webUrl).host;
  return Object.freeze({
    ready: () => {
      const answer = run(["auth", "status", "--hostname", host], undefined, timeoutMs);
      if (answer.missing) return { ready: false, reason: "the gh command is not installed" } as const;
      return answer.status === 0 ? { ready: true } as const : { ready: false, reason: `gh is not logged in to ${host}` } as const;
    },
    environmentExists: (repository: string, environment: string) => {
      const answer = run(["api", "--hostname", host, `repos/${repository}/environments/${encodeURIComponent(environment)}`, "--jq", ".name"], undefined, timeoutMs);
      if (answer.status === 0) return answer.stdout.trim() === environment;
      if (/HTTP 404/u.test(answer.stderr)) return false;
      throw failed(`reading the environment ${environment} of ${repository}`, answer);
    },
    setEnvironmentSecret: (repository: string, environment: string, name: string, value: string) => {
      const answer = run(["secret", "set", name, "--env", environment, "--repo", `${host}/${repository}`], value, timeoutMs);
      if (answer.status !== 0) throw failed(`setting the secret ${name} of the environment ${environment}`, answer);
    },
    setEnvironmentVariable: (repository: string, environment: string, name: string, value: string) => {
      const answer = run(["variable", "set", name, "--env", environment, "--repo", `${host}/${repository}`, "--body", value], undefined, timeoutMs);
      if (answer.status !== 0) throw failed(`setting the variable ${name} of the environment ${environment}`, answer);
    },
  });
}
