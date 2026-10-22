/**
 * `harness door` — the verbs the generated `door.yml` runs, as the door App
 * (its token minted in the `door` environment and handed in `DOOR_TOKEN`):
 *
 *   harness door preflight --run <id> --github-output <file>
 *   harness door stream    --run <id>
 *   harness door reuse-claim --artifacts <dir> --github-output <file>
 *   harness door judge     --run <id> --artifacts <dir> [--reuse <dir>] --out <dir> --github-output <file>
 *   harness door action    --event <event.json>
 *
 * `preflight` refuses hostile artifacts before any download and says
 * `accepted=true|false`. `stream` keeps the check in progress (display only).
 * `judge` posts the verdict on the check and writes the attestation's subject
 * (`keydoc.json`, the key document) and predicate (`predicate.json`), saying
 * `attest=true`; a run the door cannot judge at all (no plan, refused
 * artifacts) is posted as a FAILED check naming why — never left pending,
 * never passed. `action` handles the check's button.
 *
 * The endpoint is the forge section's (`configuredForge`, `forgeEndpoint`);
 * the repository is the one the workflow runs in (`GITHUB_REPOSITORY`).
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { HarnessError, InputError } from "../../kernel/errors.ts";
import { canonicalHash, canonicalJson, deepFreeze } from "../../kernel/integrity.ts";
import { loadPinnedConfigSnapshot } from "../../kernel/config.ts";
import { configuredGitRepository } from "../../git/worktree-port.ts";
import { repositoryToplevel } from "../../git/repository-ownership.ts";
import { wrapResult, type CommandAnswer } from "../command-result.ts";
import { configuredForge } from "../forge/configured-forge.ts";
import { environmentCredential } from "../forge/credentials.ts";
import { forgeEndpoint } from "../forge/forge-config.ts";
import { githubClient } from "../forge/github.ts";
import type { ForgeClient } from "../forge/port.ts";
import { findCheckRun, getWorkflowRun, writeCheckRun, type Repository } from "./door-github.ts";
import { findVerdictLocator } from "../gates/reuse.ts";
import { parsePlan } from "../gates/plan.ts";
import { judgeCompletedRun } from "./judge.ts";
import { preflightArtifacts, rerunCold, streamProgress } from "./stream.ts";

const VERBS = ["preflight", "stream", "reuse-claim", "judge", "action"] as const;

/** The streamer's cadence and its bound (display only; the job's own ceiling is 15 minutes). */
const STREAM_INTERVAL_MS = 20_000;
const STREAM_BUDGET_MS = 12 * 60_000;

function repositoryFromEnvironment(): Repository {
  const value = process.env.GITHUB_REPOSITORY ?? "";
  const [owner, name, ...rest] = value.split("/");
  if (owner === undefined || owner === "" || name === undefined || name === "" || rest.length > 0) {
    throw new InputError("harness door runs inside the door workflow: GITHUB_REPOSITORY names no owner/name", "door_environment_missing");
  }
  return { owner, name };
}

function doorClient(): ForgeClient {
  return githubClient(forgeEndpoint(configuredForge()), environmentCredential("door", "DOOR_TOKEN"));
}

function flags(verb: string, argv: readonly string[], names: readonly string[]): Readonly<Record<string, string | undefined>> {
  try {
    return parseArgs({ args: [...argv], options: Object.fromEntries(names.map((name) => [name, { type: "string" as const }])), strict: true }).values as Record<string, string | undefined>;
  } catch (error) {
    throw new InputError(`door ${verb}: ${(error as Error).message}`, "input_error");
  }
}

function required(verb: string, values: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = values[name];
  if (value === undefined || value === "") throw new InputError(`door ${verb} requires --${name}`, "input_error");
  return value;
}

function runId(verb: string, values: Readonly<Record<string, string | undefined>>): number {
  const id = Number(required(verb, values, "run"));
  if (!Number.isSafeInteger(id) || id <= 0) throw new InputError(`door ${verb}: --run is not a run id`, "input_error");
  return id;
}

function runUrl(repository: Repository, id: number): string {
  return `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${repository.owner}/${repository.name}/actions/runs/${String(id)}`;
}

/** Posts a failed verdict naming why the run could not be judged (never left pending, never passed). */
async function refuseRun(client: ForgeClient, repository: Repository, id: number, why: string): Promise<void> {
  const run = await getWorkflowRun(client, repository, id);
  await writeCheckRun(client, repository, run.headSha, {
    status: "completed",
    conclusion: "failure",
    detailsUrl: runUrl(repository, id),
    title: "Refused: the run could not be judged",
    summary: `The door could not judge [the CI run](${runUrl(repository, id)}): ${why}`,
  }, await findCheckRun(client, repository, run.headSha));
}

export async function runDoorCli(engineRoot: string, argv: readonly string[]): Promise<CommandAnswer> {
  const [verb, ...rest] = argv;
  if (verb === undefined || !(VERBS as readonly string[]).includes(verb)) throw new InputError(`harness door <${VERBS.join("|")}> (got ${JSON.stringify(verb ?? "")})`, "input_error");
  const repository = repositoryFromEnvironment();
  const client = doorClient();
  if (verb === "preflight") {
    const values = flags(verb, rest, ["run", "github-output"]);
    const id = runId(verb, values);
    const findings = await preflightArtifacts(client, repository, id);
    if (values["github-output"] !== undefined) appendFileSync(values["github-output"], `accepted=${findings.length === 0 ? "true" : "false"}\n`);
    if (findings.length > 0) await refuseRun(client, repository, id, findings.map((finding) => `${finding.rule}${finding.artifact === undefined ? "" : ` (${finding.artifact})`}: ${finding.detail}`).join("; "));
    return { result: wrapResult("door", deepFreeze({ accepted: findings.length === 0, findings }), { status: findings.length === 0 ? "pass" : "fail" }) };
  }
  if (verb === "stream") {
    const id = runId(verb, flags(verb, rest, ["run"]));
    const ending = await streamProgress(client, repository, id, { intervalMs: STREAM_INTERVAL_MS, deadline: Date.now() + STREAM_BUDGET_MS });
    return { result: wrapResult("door", deepFreeze({ ending }), { status: "pass" }) };
  }
  if (verb === "reuse-claim") {
    // The plan claims reuse: the door locates the verdict for K itself, by name (never by the run's word).
    const values = flags(verb, rest, ["artifacts", "github-output"]);
    const plan = parsePlan(JSON.parse(readFileSync(join(resolve(required(verb, values, "artifacts")), "gate-plan", "plan.json"), "utf8")));
    const locator = plan.reuse === undefined ? null : await findVerdictLocator(client, repository, plan.keyDigest, "success");
    if (values["github-output"] !== undefined) appendFileSync(values["github-output"], `key=${plan.keyDigest}\ndoor-run=${locator === null ? "" : String(locator.runId)}\n`);
    return { result: wrapResult("door", deepFreeze({ claimed: plan.reuse !== undefined, located: locator !== null }), { status: "pass" }) };
  }
  if (verb === "judge") {
    const values = flags(verb, rest, ["run", "artifacts", "reuse", "out", "github-output"]);
    const id = runId(verb, values);
    const out = resolve(required(verb, values, "out"));
    const top = repositoryToplevel(engineRoot, "directory");
    if (top === undefined) throw new InputError("the door runs in its own checkout of main", "door_environment_missing");
    const mainSha = process.env.GITHUB_SHA ?? "";
    let judged;
    try {
      judged = await judgeCompletedRun({
        client,
        repository,
        git: configuredGitRepository(loadPinnedConfigSnapshot().document, top),
        mainSha,
        artifactsDirectory: resolve(required(verb, values, "artifacts")),
        runId: id,
        runUrl: runUrl(repository, id),
        ...(values.reuse === undefined ? {} : { reuseDirectory: resolve(values.reuse) }),
      });
    } catch (error) {
      if (!(error instanceof HarnessError)) throw error;
      await refuseRun(client, repository, id, `${error.code}: ${error.message}`);
      throw error;
    }
    await writeCheckRun(client, repository, judged.checkSha, judged.check, await findCheckRun(client, repository, judged.checkSha));
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "keydoc.json"), canonicalJson(judged.keyDocument));
    writeFileSync(join(out, "predicate.json"), canonicalJson({
      verdict: judged.verdict.conclusion,
      key: judged.verdict.key,
      treeId: judged.verdict.treeId,
      headSha: judged.verdict.headSha,
      ciChanging: judged.verdict.ciChanging,
      receiptDigest: canonicalHash(judged.receipt),
      catalogueDigest: judged.receipt.catalogueDigest,
      findings: judged.verdict.findings,
      run: judged.verdict.runUrl,
      door: { workflowSha: mainSha },
    }));
    if (values["github-output"] !== undefined) appendFileSync(values["github-output"], `attest=true\nkey=${judged.verdict.key}\nverdict=${judged.verdict.conclusion}\n`);
    return { result: wrapResult("door", deepFreeze({ verdict: judged.verdict.conclusion, key: judged.verdict.key, findings: judged.verdict.findings.length }), { status: "pass" }) };
  }
  const values = flags(verb, rest, ["event"]);
  const event = JSON.parse(readFileSync(required(verb, values, "event"), "utf8")) as {
    requested_action?: { identifier?: string };
    check_run?: { head_sha?: string; id?: number; check_suite?: { head_branch?: string | null } };
    repository?: { id?: number };
  };
  const identifier = event.requested_action?.identifier;
  const checkRun = event.check_run;
  if (identifier !== "rerun-cold" || checkRun?.head_sha === undefined || checkRun.id === undefined || event.repository?.id === undefined) {
    throw new InputError(`door action: no button the door offers (${String(identifier)})`, "door_action_unknown");
  }
  const dispatched = await rerunCold(client, repository, { headBranch: checkRun.check_suite?.head_branch ?? null, headSha: checkRun.head_sha });
  await writeCheckRun(client, repository, checkRun.head_sha, {
    status: "in_progress",
    title: "Re-run cold dispatched",
    summary: `Every gate runs again, reusing nothing: [run ${String(dispatched)}](${runUrl(repository, dispatched)}). A failed earlier attempt of the same tree still stands.`,
  }, checkRun.id);
  return { result: wrapResult("door", deepFreeze({ action: identifier, dispatched }), { status: "pass" }) };
}
