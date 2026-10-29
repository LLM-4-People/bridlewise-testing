/**
 * THE LANDING, FILLED AT PUBLISH — the site's front page (`docs/index.md`) is
 * a shell of hand-written words; its numbers, verdicts and quotations are
 * written here when the site is published, from the sources the rest of the
 * site reads, so the landing and the pages it points to can never disagree:
 * - the certificate and the ledger: the claims register judged at the
 *   published commit (engine/scripts/brand judgeClaims, as /floor/claims/);
 * - the refusal: the harness's own answer to a call with no subcommand, run
 *   from this checkout, standing under the typed-refusals claim's verdict;
 * - the run: the illustrative run record's beats (docs/run/run-record.json);
 * - the roadmap: the roadmap's own tally (scripts/floor/roadmap-status.ts),
 *   drawn by the one figure owner (shared/figures.ts partBarInline);
 * - the readings: every required check's run at the commit, job by job;
 * - the name: the messaging source's dictionary entry.
 * Nothing on the page is typed by hand; a missing source refuses the build.
 *
 *   node scripts/floor/landing.ts --site <assembled source> --checks <status.json>
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { decisionStates, readClaims, type DecisionState } from "../../engine/scripts/brand/claims.ts";
import { readStatus, withFrontBlock } from "../../engine/scripts/brand/cli.ts";
import { judgeClaims, VERDICT_WORDS, type CheckResult, type JudgedClaim } from "../../engine/scripts/brand/render.ts";
import { readWords, type Words } from "../../engine/scripts/brand/words.ts";
import { atomicWriteFile } from "../../engine/src/filesystem/atomic-write.ts";
import { boundedEnding } from "../../engine/src/process/subprocess-bounds.ts";
import { runCpuBounded } from "../../engine/src/process/supervised-run.ts";
import { configuredSubprocessBounds } from "../../engine/src/workflow/workflow-config.ts";
import { bootstrapProcess, isEntryPoint } from "../../engine/src/runtime/cli-debug.ts";
import { partBarInline, type PartBar } from "../../shared/figures.ts";
import { escapeHtml } from "../../shared/markup.ts";
import { roadmapTally, type RoadmapTally } from "./roadmap-status.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const h = escapeHtml;

/** A refusal of the landing build, by code. */
export class LandingRefusal extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
    this.name = "LandingRefusal";
  }
}

/** The page the landing fills (repository-relative, and so relative to the assembled site's source). */
export const LANDING_PAGE = "docs/index.md";

/** The landing's generated blocks, in the order the page holds them. */
export const LANDING_BLOCKS = Object.freeze(["certificate", "ledger", "refusal", "run", "roadmap", "readings", "name"] as const);
export type LandingBlock = (typeof LANDING_BLOCKS)[number];

/** A block's markers: the shell carries each once, with honest words between them until the site is published. */
export function landingMarkers(block: LandingBlock): Readonly<{ begin: string; end: string }> {
  return Object.freeze({
    begin: `<!-- BEGIN GENERATED AT PUBLISH: the landing's ${block} (scripts/floor/landing.ts) -->`,
    end: `<!-- END GENERATED AT PUBLISH: the landing's ${block} -->`,
  });
}

/** Each verdict's mark: a second encoding beside its word and its ink. */
const MARKS: Readonly<Record<JudgedClaim["verdict"], string>> = Object.freeze({ holds: "✓", retracted: "✕", unchecked: "?", designed: "◇", "not-claimed": "—" });

/** The order verdicts are counted in, on the certificate. */
const TALLY: readonly JudgedClaim["verdict"][] = ["holds", "retracted", "unchecked", "designed", "not-claimed"];

const verdict = (v: JudgedClaim["verdict"]): string => `<span class="verdict" data-verdict="${v}"><span class="mark" aria-hidden="true">${MARKS[v]}</span> ${h(VERDICT_WORDS[v])}</span>`;
const commitLink = (commit: string): string => `<a href="{{ site.repository_url }}/commit/${h(commit)}"><code>${h(commit.slice(0, 8))}</code></a>`;
const blobLink = (path: string, text: string): string => `<a href="{{ site.repository_url }}/blob/main/${h(path)}">${text}</a>`;

/** The certificate beside the promise: every verdict counted, the judged commit, and its stamp. */
export function certificateBlock(judged: readonly JudgedClaim[], commit: string, judgedAt: string | null): string {
  const counts = TALLY.map((v) => [v, judged.filter((j) => j.verdict === v).length] as const).filter(([v, n]) => n > 0 || v !== "unchecked");
  const day = judgedAt === null ? null : new Date(judgedAt).toISOString().slice(0, 10);
  return [
    `<aside class="certificate" aria-labelledby="certificate-title">`,
    `<header><h2 id="certificate-title">Certificate of inspection</h2><span class="serial">No. ${commitLink(commit)}</span></header>`,
    `<ul class="tally">${counts.map(([v, n]) => `<li data-verdict="${v}"><span class="mark" aria-hidden="true">${MARKS[v]}</span><span class="word">${h(VERDICT_WORDS[v])}</span><span class="n">${String(n)}</span></li>`).join("")}</ul>`,
    `<p class="total"><span>Claims inspected</span><span class="n">${String(judged.length)}</span></p>`,
    `<div class="cert-foot"><p class="fineprint">Nobody types these numbers. Each claim is judged against the checks that ran on this commit; a red or missing result strikes it out.</p>`,
    `<p class="stamp" aria-hidden="true">Judged<b>${h(commit.slice(0, 8))}</b>${day === null ? "" : h(day)}</p></div>`,
    `</aside>`,
  ].join("\n");
}

/** Part A: every claim, the check bound to it, the evidence, and its verdict at the commit. */
export function ledgerBlock(judged: readonly JudgedClaim[], checks: readonly CheckResult[], decisions: ReadonlyMap<string, DecisionState>): string {
  const label = (id: string): string => checks.find((c) => c.id === id)?.label ?? id;
  const rows = judged.map((j, index) => {
    const c = j.claim;
    let bound: string;
    let runs = "";
    if (c.kind === "holds-when-green") {
      bound = `${j.checks.map((k) => h(label(k.id))).join(" + ")}${c.evidence === null ? "" : `<span class="evidence">Evidence: ${blobLink(c.evidence, `<code>${h(c.evidence)}</code>`)}</span>`}`;
      runs = j.checks.filter((k) => k.runUrl !== null).map((k) => ` <a class="run" href="${h(k.runUrl!)}">run</a>`).join("");
    } else if (c.kind === "designed") {
      const record = decisions.get(c.decision);
      if (record === undefined) throw new LandingRefusal("landing_decision_missing", `${c.id} names ${c.decision}, which is no decision record`);
      bound = `Decision record<span class="evidence">${blobLink(record.path, `<code>${h(c.decision)}</code>`)}</span>`;
    } else {
      bound = `Not claimed<span class="evidence">${h(c.reason)}</span>`;
    }
    return `<tr data-verdict="${j.verdict}"><td class="no">${String(index + 1).padStart(2, "0")}</td><td><span class="claim-text">${h(c.text)}</span></td><td class="bound">${bound}</td><td class="result">${verdict(j.verdict)}${runs}</td></tr>`;
  });
  return [
    `<div class="ledger-frame"><table class="ledger">`,
    `<thead><tr><th scope="col">No.</th><th scope="col">Claim</th><th scope="col">Bound check</th><th scope="col">Result</th></tr></thead>`,
    `<tbody>${rows.join("")}</tbody>`,
    `</table></div>`,
  ].join("\n");
}

/** The harness's answer to a call with no subcommand, as it printed it. */
export type Refusal = Readonly<{ error: string; message: string; available: readonly string[] }>;

/**
 * Runs the harness from the checkout at `root` with no subcommand, through the
 * one bounded run (bounded by its work, the harness's configured bounds; no
 * wall-clock limit of its own), and reads its typed refusal.
 */
export async function runRefusal(root: string): Promise<Refusal> {
  const bounds = configuredSubprocessBounds();
  const ran = await runCpuBounded(process.execPath, ["src/cli.ts", "harness"], { cwd: join(root, "engine"), bounds });
  if (ran.ending !== "exited") throw new LandingRefusal("landing_refusal_missing", `the harness did not answer a call with no subcommand: ${boundedEnding(ran, bounds)}`);
  const line = `${ran.stdout.toString("utf8")}\n${ran.stderr.toString("utf8")}`.split("\n").find((text) => text.trim().startsWith("{") && text.includes('"error"'));
  if (line === undefined) throw new LandingRefusal("landing_refusal_missing", `the harness printed no typed refusal for a call with no subcommand (exit ${String(ran.status)})`);
  const answer = JSON.parse(line) as Partial<Refusal>;
  if (answer.error !== "no_harness_subcommand" || typeof answer.message !== "string" || !Array.isArray(answer.available)) {
    throw new LandingRefusal("landing_refusal_missing", `the harness answered ${JSON.stringify(answer.error)}, not no_harness_subcommand`);
  }
  return Object.freeze({ error: answer.error, message: answer.message, available: Object.freeze([...answer.available]) });
}

/** Part B: the call, the answer word for word, and the claim it stands under (struck with it when retracted). */
export function refusalBlock(refusal: Refusal, judged: readonly JudgedClaim[]): string {
  const claim = judged.find((j) => j.claim.id === "typed-refusals");
  if (claim === undefined) throw new LandingRefusal("landing_refusal_unclaimed", "the register holds no typed-refusals claim for the refusal to stand under");
  return [
    `<div class="refusal" data-verdict="${claim.verdict}">`,
    `<div class="slip call"><h3>The call</h3><pre><code>bridlewise harness</code></pre></div>`,
    `<div class="slip answer"><h3>The harness answers</h3><p class="code-word"><code>${h(refusal.error)}</code></p><pre><code>${h(refusal.message)}</code></pre>`,
    `<p class="source">Printed by ${blobLink("engine/src/workflow/harness-commands.ts", "<code>harness-commands.ts</code>")} when this page was built, under the claim: ${verdict(claim.verdict)}</p></div>`,
    `</div>`,
  ].join("\n");
}

/** The illustrative run record's fields the landing shows. */
type RunRecord = Readonly<{ notice: string; run: Readonly<{ id: string }>; beats: readonly Readonly<{ seq: number; kind: string; label?: string; title: string }>[] }>;

/** Part C: the run's beats in order, labelled synthetic. */
export function runBlock(record: RunRecord): string {
  const beats = record.beats.map((beat) => `<li class="beat" data-kind="${h(beat.kind)}"><span class="station">${String(beat.seq)}</span><span class="kind">${h(beat.label ?? beat.kind)}</span><span class="title">${h(beat.title)}</span></li>`);
  return [
    `<div><p class="tag">Synthetic run</p><ol class="beats" aria-label="The ${String(record.beats.length)} beats of run ${h(record.run.id)}">${beats.join("")}</ol></div>`,
    `<p class="synthetic">${h(record.notice)}</p>`,
  ].join("\n");
}

/** Part D: shipped of tracked, the parts drawn to scale, and what sits outside the count. */
export function roadmapBlock(roadmap: RoadmapTally): string {
  const { tally, total } = roadmap;
  const bar: PartBar = {
    title: `${String(tally.shipped)} of ${String(total)} tracked items shipped`,
    subtitle: "by state",
    parts: [
      { label: "shipped", count: tally.shipped, ink: "--ok" },
      { label: "claimed, unverified", count: tally.claimed, ink: "--warn", hatched: true },
      { label: "in progress", count: tally["in progress"], ink: "--ok", hatched: true },
      { label: "planned", count: tally.planned, ink: "--ink-2" },
      { label: "blocked", count: tally.blocked, ink: "--alarm" },
    ],
    source: "generated from the tracker items and the decision records",
  };
  return [
    `<div class="standing"><p class="big"><span class="n">${String(tally.shipped)} of ${String(total)}</span><span class="unit">tracked items shipped</span></p>`,
    `<figure class="system-figure" tabindex="0">${partBarInline(bar, "fig-landing-roadmap")}<figcaption>${String(roadmap.notPlanned)} more not planned, outside the count.</figcaption></figure></div>`,
  ].join("\n");
}

/** A job's conclusion in words, with its state. */
function jobState(conclusion: string | null, status: string): readonly [string, string] {
  if (status !== "completed") return ["running", "Running"];
  if (conclusion === "success") return ["pass", "Passed"];
  if (conclusion === "skipped") return ["skipped", "Skipped"];
  if (conclusion === null) return ["unknown", "No result"];
  return ["fail", conclusion === "failure" ? "Failed" : conclusion.replace(/_/gu, " ")];
}

/** Part E: every required check's run at the commit, job by job (a run whose jobs were not read says so). */
export function readingsBlock(checks: readonly CheckResult[], commit: string): string {
  const required = checks.filter((check) => check.required === true);
  if (required.length === 0) throw new LandingRefusal("landing_checks_missing", "the status snapshot names no required check");
  const rows = required.flatMap((check) => {
    const head = `<th scope="rowgroup">${h(check.label ?? check.id)}${check.runUrl === null ? "" : ` <a class="run" href="${h(check.runUrl)}">run</a>`}</th>`;
    if (check.headSha !== null && check.headSha !== commit) return [`<tbody><tr>${head}<td>Its last run is at another commit</td><td class="result" data-state="not-run">Not run here</td></tr></tbody>`];
    if (check.jobs === undefined || check.jobs === null || check.jobs.length === 0) return [`<tbody><tr>${head}<td>Its jobs were not read</td><td class="result" data-state="unknown">${h(check.status)}</td></tr></tbody>`];
    const jobs = check.jobs.map((job, index) => {
      const [state, words] = jobState(job.conclusion, job.status);
      return `<tr>${index === 0 ? head.replace("<th ", `<th rowspan="${String(check.jobs!.length)}" `) : ""}<td>${job.url === null ? h(job.name) : `<a href="${h(job.url)}">${h(job.name)}</a>`}</td><td class="result" data-state="${state}">${h(words)}</td></tr>`;
    });
    return [`<tbody>${jobs.join("")}</tbody>`];
  });
  return [
    `<div class="ledger-frame"><table class="readings">`,
    `<thead><tr><th scope="col">Required check</th><th scope="col">Job</th><th scope="col">Result at ${commitLink(commit)}</th></tr></thead>`,
    rows.join(""),
    `</table></div>`,
  ].join("\n");
}

/** Part G: the name's dictionary entry, cited, and the line it gives the project. */
export function nameBlock(words: Words): string {
  const about = words.about;
  return [
    `<div>`,
    `<p class="headword">${h(about.word)}<span class="pos">${h(about.partOfSpeech)}</span></p>`,
    `<p class="definition"><span class="sense">1.</span>${h(about.definition)}</p>`,
    `<p class="cite"><a href="${h(about.sourceUrl)}">${h(about.source)}</a></p>`,
    `<p class="line">${h(about.line)}</p>`,
    `</div>`,
  ].join("\n");
}

/** Every block of the landing, from the repository at `root` and the status snapshot at `checksPath`. */
export function landingBlocks(root: string, checksPath: string, refusal: Refusal): Readonly<Record<LandingBlock, string>> {
  const status = readStatus(checksPath);
  const judged = judgeClaims(readClaims(root), status.checks, status.commit);
  const decisions = decisionStates(root);
  const record = JSON.parse(readFileSync(join(root, "docs/run/run-record.json"), "utf8")) as RunRecord;
  return Object.freeze({
    certificate: certificateBlock(judged, status.commit, status.generatedAt),
    ledger: ledgerBlock(judged, status.checks, decisions),
    refusal: refusalBlock(refusal, judged),
    run: runBlock(record),
    roadmap: roadmapBlock(roadmapTally(root)),
    readings: readingsBlock(status.checks, status.commit),
    name: nameBlock(readWords(root)),
  });
}

/** The shell with every block filled; a block whose markers are missing or repeated refuses. */
export function fillLanding(shell: string, blocks: Readonly<Record<LandingBlock, string>>): string {
  let text = shell;
  for (const block of LANDING_BLOCKS) {
    const { begin, end } = landingMarkers(block);
    const filled = withFrontBlock(text, begin, end, blocks[block]);
    if (filled === null) throw new LandingRefusal("landing_shell_invalid", `${LANDING_PAGE} carries no single ${block} block between its markers`);
    text = filled;
  }
  return text;
}

async function run(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({ args: [...argv], options: { site: { type: "string" }, checks: { type: "string" } } });
  if (values.site === undefined || values.checks === undefined) throw new LandingRefusal("landing_usage", "usage: landing.ts --site <assembled source> --checks <status.json>");
  const page = join(values.site, "index.md");
  const filled = fillLanding(readFileSync(page, "utf8"), landingBlocks(ROOT, values.checks, await runRefusal(ROOT)));
  const written = atomicWriteFile(page, filled, { exactMode: 0o644 });
  if (!written.success) throw new LandingRefusal("landing_write_failed", `${page}: ${written.reason ?? "unknown error"}`);
  process.stdout.write(`${JSON.stringify({ page, blocks: LANDING_BLOCKS.length })}\n`);
  return 0;
}

if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  run(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error: unknown) => {
    process.stderr.write(`[landing] REFUSED ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
