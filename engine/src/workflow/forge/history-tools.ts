/**
 * THE HISTORY IMPORTER'S PINNED TOOLS — the two programs the importer runs
 * that are not the harness's own (`history-import.ts`):
 *
 * - **gitleaks**, the INDEPENDENT ORACLE (github-only §8.3): a second scanner
 *   with its own format list and its own regex engine, whose only job is to
 *   catch a format the secret catalogue lacks. It never decides what is
 *   purged: a hit it alone finds is a refusal until the catalogue has a row
 *   for it (BRIEF NO FALLBACKS: a test-only independent oracle is not a
 *   fallback).
 * - **git-filter-repo**, the REWRITER: `--sensitive-data-removal` with the
 *   generated purge expressions.
 *
 * Each is PINNED by the sha256 of the exact file the importer runs (and of
 * the release archive it comes from), checked before EVERY run: a tool that
 * is absent or whose bytes moved is a typed refusal naming the remedy, never
 * a search of `PATH` and never a quieter substitute.
 *
 * Where a tool lives: `<the import home>/<toolsFolder>/<name>-<version>/<file>`
 * (the private-home owner places the home; `ROOT_POLICY.workflow.historyImport`).
 * The harness does not download it: the outbound HTTP door never follows a
 * redirect (secb-design F-6) and a release asset is served through one, so
 * provisioning is the operator's one command the refusal prints.
 *
 * Moving a pin is a deliberate, reviewed provenance change: read the
 * upstream checksum file, verify the archive, record both digests here.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { deepFreeze, sha256 } from "../../kernel/integrity.ts";
import { ROOT_POLICY } from "../../kernel/root-policy.ts";
import { runCpuBounded, type CpuBounds, type CpuBoundedEnding } from "../../process/supervised-run.ts";
import { ForgeError, type ForgeCode } from "./codes.ts";
import { configuredForge } from "./configured-forge.ts";

/** How the importer runs a pinned file: directly, or as the script of the host's `python3`. */
export type HistoryToolRunner = "executable" | "python3";

export type HistoryToolPin = Readonly<{
  name: string;
  version: string;
  /** The `<platform>-<arch>` the file was built for, or `any` for a script. */
  platform: string;
  /**
   * Where the release archive is: its GitHub repository, release tag and
   * asset (coordinates, never an address held in code: the URL is composed
   * from the configured forge web origin only for the printed provisioning
   * command); its sha256 (from the upstream checksum file where one is
   * published) and the member the importer runs.
   */
  release: Readonly<{ repository: string; tag: string; asset: string }>;
  archiveSha256: string;
  member: string;
  /** The sha256 of the member's bytes: what is checked before every run. */
  sha256: string;
  runner: HistoryToolRunner;
}>;

export type HistoryToolName = "gitleaks" | "git-filter-repo";

// BEGIN AUTHORED PINS
const PINS: Readonly<Record<HistoryToolName, readonly HistoryToolPin[]>> = deepFreeze({
  gitleaks: [{
    name: "gitleaks",
    version: "8.30.1",
    platform: "linux-x64",
    release: { repository: "gitleaks/gitleaks", tag: "v8.30.1", asset: "gitleaks_8.30.1_linux_x64.tar.gz" },
    archiveSha256: "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb",
    member: "gitleaks",
    sha256: "88f91962aa2f93ac6ab281d553b9e125f5197bbbce38f9f2437f7299c32e5509",
    runner: "executable",
  }],
  "git-filter-repo": [{
    name: "git-filter-repo",
    version: "2.47.0",
    platform: "any",
    release: { repository: "newren/git-filter-repo", tag: "v2.47.0", asset: "git-filter-repo-2.47.0.tar.xz" },
    archiveSha256: "4662cbe5918196a9f1b5b3e1211a32e61cff1812419c21df4f47c5439f09e902",
    member: "git-filter-repo-2.47.0/git-filter-repo",
    sha256: "67447413e273fc76809289111748870b6f6072f08b17efe94863a92d810b7d94",
    runner: "python3",
  }],
});
// END AUTHORED PINS

/** This process's `<platform>-<arch>`, in the pins' spelling (`x64` as Node names it). */
function hostToolPlatform(): string {
  return `${process.platform}-${process.arch}`;
}

/** The pin of `name` for this host (a script's `any` pin, else the host's own), or the typed refusal `history_tool_platform_unpinned`. */
export function historyToolPin(name: HistoryToolName, platform: string = hostToolPlatform()): HistoryToolPin {
  const pin = PINS[name].find((candidate) => candidate.platform === "any" || candidate.platform === platform);
  if (pin === undefined) {
    throw new ForgeError("history_tool_platform_unpinned", `${name} is pinned for ${PINS[name].map((candidate) => candidate.platform).join(", ")}, not for this host (${platform}): add a pin for it (the release archive, its published checksum and the member's sha256) in src/workflow/forge/history-tools.ts`, { tool: name, platform });
  }
  return pin;
}

/** Where `pin`'s file lives under the import home. */
export function historyToolPath(home: string, pin: HistoryToolPin): string {
  return join(home, ROOT_POLICY.workflow.historyImport.toolsFolder, `${pin.name}-${pin.version}`, basename(pin.member));
}

/** The command that provisions `pin` at `path` from `webOrigin` (the configured forge web origin): fetch, verify the archive's digest, extract the member (printed, never run by the harness). */
function provisioningCommand(pin: HistoryToolPin, path: string, webOrigin: string): string {
  const archive = pin.release.asset;
  const source = `${webOrigin}/${pin.release.repository}/releases/download/${pin.release.tag}/${archive}`;
  const extract = archive.endsWith(".tar.xz") ? "tar -xJf" : "tar -xzf";
  const folder = join(path, "..");
  return `mkdir -p '${folder}' && cd '${folder}' && curl -fsSLO '${source}' && echo '${pin.archiveSha256}  ${archive}' | sha256sum -c - && ${extract} '${archive}' '${pin.member}' && mv '${pin.member}' '${basename(path)}' && rm -f '${archive}'`;
}

/** A pinned tool ready to run: its pin and the verified file. */
export type ResolvedHistoryTool = Readonly<{ pin: HistoryToolPin; path: string }>;

/**
 * THE PIN CHECK, before every run: the file at {@link historyToolPath} exists
 * and its bytes have the pinned sha256. Refusals: `history_tool_missing`
 * (with the provisioning command) and `history_tool_digest_mismatch` (the
 * file is not the pinned one: replace it, never re-pin to it).
 */
export function resolveHistoryTool(home: string, name: HistoryToolName): ResolvedHistoryTool {
  const pin = historyToolPin(name);
  const path = historyToolPath(home, pin);
  if (!existsSync(path)) {
    throw new ForgeError("history_tool_missing", `${pin.name} ${pin.version} is not provisioned at ${path}. Provision it (the archive's digest is checked): ${provisioningCommand(pin, path, configuredForge().webUrl)}`, { tool: pin.name, version: pin.version, path });
  }
  const actual = sha256(readFileSync(path));
  if (actual !== pin.sha256) {
    throw new ForgeError("history_tool_digest_mismatch", `${path} is not the pinned ${pin.name} ${pin.version} (sha256 ${actual}, pinned ${pin.sha256}): remove it and provision the pinned file; a pin moves only as a reviewed provenance change`, { tool: pin.name, version: pin.version, path, sha256: actual });
  }
  return deepFreeze({ pin, path });
}

/** The argv that runs `tool` with `args` (a script through the host's `python3`). */
function historyToolArgv(tool: ResolvedHistoryTool, args: readonly string[]): readonly string[] {
  return tool.pin.runner === "python3" ? ["python3", tool.path, ...args] : [tool.path, ...args];
}

/** What one tool run answered. */
export type HistoryToolRun = Readonly<{ status: number; stdout: string; stderr: string }>;

function policyBounds(): CpuBounds {
  const policy = ROOT_POLICY.workflow.historyImport;
  return { cpuBudgetMs: policy.toolCpuBudgetMs, stallMs: policy.toolStallMs, pollMs: policy.toolPollMs, killGraceMs: policy.toolKillGraceMs, outputBytes: ROOT_POLICY.runtime.limits.maximumGitOutputBytes };
}

/** The forge's answer for each way the one supervisor stops a run (`src/process/supervised-run.ts`). */
const STOPPED: Readonly<Record<Exclude<CpuBoundedEnding, "exited" | "unstarted">, Readonly<{ code: ForgeCode; reason: (bounds: CpuBounds) => string }>>> = {
  "cpu-exhausted": { code: "history_tool_cpu_exhausted", reason: (bounds) => `it spent its CPU budget of ${String(bounds.cpuBudgetMs)} ms` },
  stalled: { code: "history_tool_stalled", reason: (bounds) => `it produced no output and no CPU time for ${String(bounds.stallMs)} ms` },
  "output-exceeded": { code: "history_tool_output_exceeded", reason: (bounds) => `its output passed ${String(bounds.outputBytes)} bytes` },
  unmeasurable: { code: "history_tool_unmeasurable", reason: () => "procfs cannot measure its process group's CPU time, so its budget cannot be judged" },
};

/**
 * THE BOUNDED RUN of a pinned tool (or the host program it runs on), through
 * the one process supervisor's work-bounded mode (`runCpuBounded`): bounded
 * by its process group's CPU time and a stall check (no output AND no CPU
 * time), NEVER by wall time (the user's no-load-block rule). A run the
 * supervisor stopped is its typed refusal (`history_tool_cpu_exhausted`,
 * `history_tool_stalled`, `history_tool_output_exceeded`,
 * `history_tool_unmeasurable`); one that ended with a status outside
 * `allowed`, or never started, is `history_tool_failed`, carrying the tool's
 * own last stderr lines (the tools print names and counts, never a scanned
 * value).
 */
export async function runBounded(
  label: string,
  argv: readonly string[],
  options: Readonly<{ cwd: string; env: Readonly<Record<string, string>>; allowed?: readonly number[]; input?: Buffer; bounds?: CpuBounds }>,
): Promise<HistoryToolRun> {
  const bounds = options.bounds ?? policyBounds();
  const run = await runCpuBounded(argv[0]!, argv.slice(1), { cwd: options.cwd, env: options.env, bounds, ...(options.input === undefined ? {} : { input: options.input }) });
  const err = run.stderr.toString("utf8");
  if (run.ending !== "exited" && run.ending !== "unstarted") {
    const stopped = STOPPED[run.ending];
    throw new ForgeError(stopped.code, `${label} was stopped: ${stopped.reason(bounds)}`, { tool: label });
  }
  if (run.status === null || !(options.allowed ?? [0]).includes(run.status)) {
    const reason = run.ending === "unstarted"
      ? `it did not run (${run.startError ?? "unknown"})`
      : run.signal !== null ? `it ended by ${run.signal}` : `it exited ${String(run.status)}: ${err.trim().split("\n").slice(-5).join(" | ")}`;
    throw new ForgeError("history_tool_failed", `${label} failed: ${reason}`, { tool: label });
  }
  return deepFreeze({ status: run.status, stdout: run.stdout.toString("utf8"), stderr: err });
}

/** Runs the pinned `tool` with `args` ({@link runBounded}; `env` is a projection the caller chose, never this process's whole environment). */
export function runHistoryTool(
  tool: ResolvedHistoryTool,
  args: readonly string[],
  options: Readonly<{ cwd: string; env: Readonly<Record<string, string>>; allowed?: readonly number[]; input?: Buffer }>,
): Promise<HistoryToolRun> {
  return runBounded(`${tool.pin.name} ${tool.pin.version}`, historyToolArgv(tool, args), options);
}

/**
 * The first line `<program> --version` prints (a host program a pinned tool
 * runs on: `python3` for filter-repo), for the receipt; a program that does
 * not answer is `history_tool_failed`.
 */
export async function hostProgramVersion(program: string, env: Readonly<Record<string, string>>): Promise<string> {
  const run = await runBounded(program, [program, "--version"], { cwd: process.cwd(), env });
  return `${run.stdout}${run.stderr}`.trim().split("\n")[0]!;
}
