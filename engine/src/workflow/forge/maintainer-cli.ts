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
 * - an environment VARIABLE (the App's client id), whether an environment
 *   exists, and whether an App name is already taken (an owner's read of a
 *   private App), with the same principal, so the owner token never enters
 *   this process.
 *
 * Every call is one `gh` run with an argument list (never a shell) and a
 * projected environment (no `GH_TOKEN`/`GITHUB_TOKEN` passes: `gh` uses its
 * own store). NO WALL-CLOCK KILL (the user's no-load-block rule): every run
 * goes through the one supervisor's work-bounded mode, ended only when its
 * process group STALLS — no output and no CPU progress for `stallMs` — or
 * passes `cpuLimitMs` of CPU or its output bound. A host under
 * load slows a run; it never fails it. A failure is the typed
 * `forge_maintainer_cli_failed` (or `_stalled`) with `gh`'s own words (its
 * stderr, which never holds the value).
 */
import { COMMAND_ENVIRONMENT, projectEnvironment } from "../../process/environment-projection.ts";
import { CLOCK_TICK_MS } from "../../process/process-facts.ts";
import { runCpuBounded } from "../../process/supervised-run.ts";
import { ForgeError } from "./codes.ts";
import { SUBPROCESS_BOUNDS } from "../workflow-config.ts";

/** What `gh` needs besides the command set: its own configuration home. */
const GH_ENVIRONMENT: readonly string[] = Object.freeze([...COMMAND_ENVIRONMENT, "XDG_CONFIG_HOME", "GH_CONFIG_DIR", "GH_HOST"]);
/** The most output a run keeps (gh answers in a few lines; more is cut, never buffered without bound). */
const OUTPUT_BOUND = 1_048_576;

/** How a run is bounded: by progress and by its own CPU work, never by the wall clock. */
export type MaintainerCliLimits = Readonly<{ stallMs: number; cpuLimitMs: number; killGraceMs: number }>;

export type MaintainerCliAnswer = Readonly<{ status: number | null; stdout: string; stderr: string; missing: boolean; ending: "exited" | "stalled" | "cpu-limit" | "output-exceeded" | "unmeasurable" }>;

/** One `gh` invocation as the forge reads it. */
export type MaintainerCliRun = (args: readonly string[], input: string | undefined, limits: MaintainerCliLimits) => Promise<MaintainerCliAnswer>;

/**
 * ONE BOUNDED RUN of `command`: an argument list, a projected environment,
 * the input on stdin, through the ONE process supervisor's work-bounded mode
 * (`runCpuBounded`, src/process/supervised-run.ts): its process GROUP is
 * ended when it stalls (no output and no CPU work for `stallMs`), passes
 * `cpuLimitMs` of CPU (members and reaped children included), or passes the
 * output bound — never by the wall clock, and only through the one
 * terminator.
 */
export async function runBoundedCommand(command: string, args: readonly string[], input: string | undefined, limits: MaintainerCliLimits): Promise<MaintainerCliAnswer> {
  const run = await runCpuBounded(command, args, {
    cwd: process.cwd(),
    env: projectEnvironment(process.env, GH_ENVIRONMENT),
    input: Buffer.from(input ?? "", "utf8"),
    // The forge's own limits; the progress floor and the hang backstop are the harness's (SUBPROCESS_BOUNDS).
    bounds: { ...SUBPROCESS_BOUNDS, cpuBudgetMs: limits.cpuLimitMs, stallMs: limits.stallMs, pollMs: Math.max(CLOCK_TICK_MS, Math.min(1_000, Math.floor(limits.stallMs / 4))), killGraceMs: limits.killGraceMs, outputBytes: OUTPUT_BOUND },
  });
  const ending = run.ending === "cpu-exhausted" || run.ending === "cpu-rlimit" ? "cpu-limit" : run.ending === "hung" ? "stalled" : run.ending === "unstarted" ? "exited" : run.ending;
  return Object.freeze({
    status: run.status,
    stdout: run.stdout.toString("utf8"),
    stderr: run.ending === "unstarted" ? (run.startError ?? "") : run.stderr.toString("utf8"),
    missing: run.ending === "unstarted" && run.startError === "ENOENT",
    ending,
  });
}

/** THE RUN of the maintainer's `gh`. */
const runGh: MaintainerCliRun = (args, input, limits) => runBoundedCommand("gh", args, input, limits);

export type MaintainerCli = Readonly<{
  /** Whether `gh` is installed and logged in to the web origin's host (`gh auth status`). */
  ready: () => Promise<Readonly<{ ready: true } | { ready: false; reason: string }>>;
  environmentExists: (repository: string, environment: string) => Promise<boolean>;
  /** Whether an App with `slug` exists (the owner can read the organisation's private Apps). */
  appExists: (slug: string) => Promise<boolean>;
  setEnvironmentSecret: (repository: string, environment: string, name: string, value: string) => Promise<void>;
  setEnvironmentVariable: (repository: string, environment: string, name: string, value: string) => Promise<void>;
}>;

function failed(what: string, run: MaintainerCliAnswer): ForgeError {
  if (run.ending !== "exited") {
    return new ForgeError("forge_maintainer_cli_stalled", `${what}: gh ${run.ending === "stalled" ? "made no progress (no output, no CPU work) within its stall window" : run.ending === "cpu-limit" ? "used more CPU than its limit" : run.ending === "output-exceeded" ? "printed more than its output bound" : "could not be measured (procfs answers nothing for it)"}, so it was ended.`, { what, ending: run.ending });
  }
  const words = run.missing ? "the gh command is not installed" : run.stderr.trim().split("\n").slice(-3).join(" ").slice(0, 400);
  return new ForgeError("forge_maintainer_cli_failed", `${what}: ${words || `gh exited ${String(run.status)}`}`, { what, ...(run.status === null ? {} : { exitCode: run.status }) });
}

/** The maintainer's CLI over `run` (production: {@link runGh}), for the GitHub host of `webUrl`. */
export function maintainerCli(webUrl: string, limits: MaintainerCliLimits, run: MaintainerCliRun = runGh): MaintainerCli {
  const host = new URL(webUrl).host;
  return Object.freeze({
    ready: async () => {
      const answer = await run(["auth", "status", "--hostname", host], undefined, limits);
      if (answer.missing) return { ready: false, reason: "the gh command is not installed" } as const;
      return answer.status === 0 ? { ready: true } as const : { ready: false, reason: `gh is not logged in to ${host}` } as const;
    },
    environmentExists: async (repository: string, environment: string) => {
      const answer = await run(["api", "--hostname", host, `repos/${repository}/environments/${encodeURIComponent(environment)}`, "--jq", ".name"], undefined, limits);
      if (answer.status === 0) return answer.stdout.trim() === environment;
      if (answer.ending === "exited" && /HTTP 404/u.test(answer.stderr)) return false;
      throw failed(`reading the environment ${environment} of ${repository}`, answer);
    },
    appExists: async (slug: string) => {
      const answer = await run(["api", "--hostname", host, `apps/${encodeURIComponent(slug)}`, "--jq", ".slug"], undefined, limits);
      if (answer.status === 0) return answer.stdout.trim() === slug;
      if (answer.ending === "exited" && /HTTP 404/u.test(answer.stderr)) return false;
      throw failed(`reading whether the App ${slug} exists`, answer);
    },
    setEnvironmentSecret: async (repository: string, environment: string, name: string, value: string) => {
      const answer = await run(["secret", "set", name, "--env", environment, "--repo", `${host}/${repository}`], value, limits);
      if (answer.status !== 0) throw failed(`setting the secret ${name} of the environment ${environment}`, answer);
    },
    setEnvironmentVariable: async (repository: string, environment: string, name: string, value: string) => {
      const answer = await run(["variable", "set", name, "--env", environment, "--repo", `${host}/${repository}`, "--body", value], undefined, limits);
      if (answer.status !== 0) throw failed(`setting the variable ${name} of the environment ${environment}`, answer);
    },
  });
}
