/**
 * THE RELEASE DOOR — `harness release <plan|notes|assemble>`: the release
 * train's verbs, each answering the promotion envelope (`codes.ts`: one
 * table of answers for the product's publication) with its class's exit
 * code and a `--text` report.
 *
 *   plan      --releases <records.jsonl> [--now <iso time>] [--manual]
 *   notes     --releases … --repository <forge>/<owner>/<name> --out <file> [--now …] [--manual]
 *   assemble  --releases … --out <empty folder> --bundle <file> --guardian <file>
 *             --sbom <file> --docs-site <file> [--now …] [--manual]
 *
 * `--releases` is the forge's list of release records (the interval runs
 * from the newest one's `published_at`).
 *
 * The clock is read here and only here (`--now` replaces it): the plan is a
 * function of the repository, the settings and that time. `notes` and
 * `assemble` refuse unless the train is due, so a release is never built
 * for a plan that says "not now".
 */
import { readFileSync } from "node:fs";

import { deepFreeze } from "../../kernel/integrity.ts";
import { wrapResult } from "../command-result.ts";
import { PromotionError, answer, promotionExitCode, type PromotionAnswer } from "./codes.ts";
import { resolveRepositoryContext, type PromotionDocument } from "./context.ts";
import type { PromoteCliOutcome } from "./promote-cli.ts";
import { assembleRelease, RELEASE_INPUTS, type ReleaseInput } from "./release-assets.ts";
import { renderReleaseNotes } from "./release-notes.ts";
import { RELEASE_WAIT_REMEDIES, planRelease, type ReleasePlan, type ReleaseRecord } from "./release-train.ts";
import { atomicWriteFile } from "../../filesystem/atomic-write.ts";

const VERBS = deepFreeze(["plan", "notes", "assemble"] as const);
type ReleaseVerb = typeof VERBS[number];

const VALUE_FLAGS: Readonly<Record<ReleaseVerb, readonly string[]>> = deepFreeze({
  plan: ["--now", "--releases"],
  notes: ["--now", "--releases", "--repository", "--out"],
  assemble: ["--now", "--releases", "--out", "--bundle", "--guardian", "--sbom", "--docs-site"],
});

const INPUT_FLAGS: Readonly<Record<ReleaseInput, string>> = deepFreeze({ bundle: "--bundle", guardian: "--guardian", sbom: "--sbom", docsSite: "--docs-site" });

type ReleaseRequest = Readonly<{ verb: ReleaseVerb; values: ReadonlyMap<string, string>; manual: boolean }>;

function usage(message: string): PromotionError {
  return new PromotionError("promotion_release_usage", message);
}

/** argv → the request, or the usage refusal. */
export function parseReleaseArguments(argv: readonly string[]): ReleaseRequest {
  const verb = argv[0];
  if (verb === undefined || !(VERBS as readonly string[]).includes(verb)) throw usage(`name a verb: ${VERBS.join(", ")}`);
  const values = new Map<string, string>();
  let manual = false;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--manual") manual = true;
    else if (VALUE_FLAGS[verb as ReleaseVerb].includes(argument)) {
      const value = argv[++index];
      if (value === undefined || value.startsWith("--")) throw usage(`${argument} needs a value`);
      values.set(argument, value);
    } else throw usage(`${verb} takes no ${argument}`);
  }
  const required = verb === "notes" ? ["--releases", "--repository", "--out"] : verb === "assemble" ? VALUE_FLAGS.assemble.filter((flag) => flag !== "--now") : ["--releases"];
  const absent = required.filter((flag) => !values.has(flag));
  if (absent.length > 0) throw usage(`${verb} needs ${absent.join(", ")}`);
  if (values.has("--repository") && !/^https:\/\/[^/\s]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(values.get("--repository")!)) throw usage("--repository is the repository's web address, <forge>/<owner>/<name> (the release job passes $GITHUB_SERVER_URL/$GITHUB_REPOSITORY)");
  if (values.has("--now") && Number.isNaN(Date.parse(values.get("--now")!))) throw usage("--now is an ISO time");
  return deepFreeze({ verb: verb as ReleaseVerb, values, manual });
}

/**
 * The release records the forge listed, one JSON object per line
 * (`gh api --paginate repos/<owner>/<name>/releases --jq '.[] | {tag_name, draft, published_at}'`):
 * each with its tag, whether it is a draft, and its publication time. A
 * line of another shape is refused, never skipped.
 */
export function readReleaseRecords(path: string): readonly ReleaseRecord[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw usage(`--releases ${path} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  return deepFreeze(text.split("\n").filter((line) => line.trim().length > 0).map((line, index) => {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      throw usage(`--releases ${path}:${String(index + 1)} is not JSON`);
    }
    const { tag_name: tag, draft, published_at: publishedAt } = (record ?? {}) as Record<string, unknown>;
    if (typeof tag !== "string" || typeof draft !== "boolean" || !(publishedAt === null || (typeof publishedAt === "string" && !Number.isNaN(Date.parse(publishedAt))))) {
      throw usage(`--releases ${path}:${String(index + 1)} is not a release record ({tag_name, draft, published_at})`);
    }
    return { tag, draft, publishedAt: publishedAt as string | null };
  }));
}

function describePlan(plan: ReleasePlan): string {
  return plan.due
    ? `${plan.tag} departs: the product ${plan.product.commit.slice(0, 12)} (from main ${plan.product.source.slice(0, 12)})${plan.approval ? ", through an approving reviewer" : ""}`
    : `${plan.tag} waits: ${plan.reasons.map((reason) => RELEASE_WAIT_REMEDIES[reason]).join("; ")}`;
}

async function releaseVerb(root: string, request: ReleaseRequest, document?: PromotionDocument): Promise<PromotionAnswer> {
  const context = resolveRepositoryContext(root, document);
  const settings = context.document.promotion?.release;
  if (settings === undefined) throw new PromotionError("promotion_release_settings_missing", "the configuration declares no `promotion.release`", {});
  const plan = planRelease({
    repository: context.repository,
    settings,
    profileDirectory: context.profileDirectory,
    commandNames: context.commandNames,
    now: new Date(request.values.get("--now") ?? Date.now()),
    manual: request.manual,
    releases: readReleaseRecords(request.values.get("--releases")!),
  });
  if (request.verb === "plan" || !plan.due) return answer(plan.due ? "promotion_release_due" : "promotion_release_not_due", describePlan(plan), plan);
  if (request.verb === "notes") {
    const out = request.values.get("--out")!;
    const written = atomicWriteFile(out, renderReleaseNotes(context.repository, plan, settings, request.values.get("--repository")!));
    if (!written.success) throw written.error;
    return answer("promotion_release_notes_written", `the notes of ${plan.tag} are in ${out}`, { plan, out });
  }
  const inputs = Object.fromEntries(RELEASE_INPUTS.map((role) => [role, request.values.get(INPUT_FLAGS[role])!]));
  const assets = assembleRelease({ repository: context.repository, plan, out: request.values.get("--out")!, inputs, platform: `${process.platform}-${process.arch}` });
  return answer("promotion_release_assembled", `${String(assets.length)} asset(s) of ${plan.tag} are in ${request.values.get("--out")!}`, { plan, assets });
}

/** Runs one `harness release` verb: its envelope, its exit code and its `--text` report (a refusal is an answer, not a crash). */
export async function runReleaseCli(root: string, argv: readonly string[], document?: PromotionDocument): Promise<PromoteCliOutcome> {
  let result: PromotionAnswer;
  try {
    result = await releaseVerb(root, parseReleaseArguments(argv), document);
  } catch (error) {
    if (!(error instanceof PromotionError)) throw error;
    result = answer(error.promotionCode, error.message, error.facts);
  }
  return deepFreeze({
    result: wrapResult(`release ${argv[0] ?? ""}`.trim(), result, { status: result.ok ? "pass" : "fail" }),
    exitCode: promotionExitCode(result.code),
    text: () => `${result.code} (${result.class}): ${result.message}\nremedy: ${result.remedy}\n`,
  });
}
