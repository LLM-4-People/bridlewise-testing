/**
 * THE PUBLIC WORDS, RENDERED — every surface's copy from the two sources
 * (`docs/brand/messaging.json`, `docs/brand/claims.json`) and, where status
 * matters, the floor's checks snapshot and the roadmap feed. Nothing here is
 * typed per surface; a new promise or claim is one edit to a source.
 *
 * Surfaces (each a pure function):
 * - the README's front block (Markdown; GH-7's projector writes it into the README);
 * - the org profile (Markdown; GH-7 writes `profile/README.md` in `.github`);
 * - the repository metadata (description, homepage, topics; GH-7 applies it);
 * - the release-note header (Markdown; the release train prepends it);
 * - the claims page (`/floor/claims/`, built at publish with the checks
 *   snapshot): every claim with its proof, and a claim whose check is red, or
 *   did not run on the published commit, RETRACTED, publicly and at once
 *   (user decision, 2026-10-21).
 *
 * The visual treatment of the site and the images is DESIGN's; this module
 * writes words and the semantic markup they sit in.
 */
import { escapeHtml } from "../../../shared/markup.ts";
import type { Claim, DecisionState } from "./claims.ts";
import type { Messaging } from "./messaging.ts";

/** One check as the floor's status snapshot (`bridlewise-floor-status/v1`) reports it. */
export type CheckResult = Readonly<{ id: string; status: string; headSha: string | null; runUrl: string | null }>;

/** A claim judged at a commit. */
export type JudgedClaim = Readonly<{
  claim: Claim;
  /** holds: every bound check passed on the commit; retracted: one is red or did not run there; unchecked: no snapshot was given. */
  verdict: "holds" | "retracted" | "unchecked" | "designed" | "not-claimed";
  checks: readonly Readonly<{ id: string; status: string; runUrl: string | null }>[];
}>;

/** Every claim's verdict at `commit` from the checks snapshot (`null`: none given, so nothing is retracted by absence). */
export function judgeClaims(claims: readonly Claim[], checks: readonly CheckResult[] | null, commit: string): readonly JudgedClaim[] {
  return claims.map((claim) => {
    if (claim.kind === "designed") return { claim, verdict: "designed", checks: [] };
    if (claim.kind === "not-claimed") return { claim, verdict: "not-claimed", checks: [] };
    const bound = claim.checks.map((id) => {
      const found = checks?.find((c) => c.id === id);
      if (checks === null) return { id, status: "unknown", runUrl: null };
      if (found === undefined) return { id, status: "not-run", runUrl: null };
      if (found.headSha !== null && found.headSha !== commit) return { id, status: "not-run", runUrl: found.runUrl };
      return { id, status: found.status, runUrl: found.runUrl };
    });
    const verdict = checks === null ? "unchecked" : bound.every((c) => c.status === "pass") ? "holds" : "retracted";
    return { claim, verdict, checks: bound };
  });
}

/** Inline code in Markdown. */
const code = (text: string): string => ["`", text, "`"].join("");
const md = (text: string): string => text.replace(/([\\`*_[\]|<>])/gu, "\\$1");
const blob = (m: Messaging, path: string): string => (path.startsWith("https://") ? path : `${m.repositoryUrl}/blob/main/${path}`);

/** The README's front block: the promise, the summary, the preview warning, and the claims with their proof. */
export function readmeHero(m: Messaging, claims: readonly Claim[], decisions: ReadonlyMap<string, DecisionState>): string {
  const holds = claims.filter((c) => c.kind === "holds-when-green");
  const designed = claims.filter((c) => c.kind === "designed");
  const not = claims.filter((c) => c.kind === "not-claimed");
  return [
    `**${md(m.promise)}**`,
    "",
    md(m.summary),
    "",
    "> [!WARNING]",
    `> **${md(m.status)}**`,
    "",
    "### What we claim, and the check behind each",
    "",
    "| Claim | Checked by | Proof |",
    "|---|---|---|",
    ...holds.map((c) => c.kind === "holds-when-green" ? `| ${md(c.text)} | ${c.checks.map(code).join(", ")} | ${c.evidence === null ? "" : `[${md(c.evidence)}](${blob(m, c.evidence)})`} |` : ""),
    "",
    `A claim whose check is red is struck out on the [live claims page](${m.siteUrl}floor/claims/) until it passes again.`,
    "",
    "**Designed, not built yet:** " + designed.map((c) => c.kind === "designed" ? `${md(c.text)} ([${c.decision}](${blob(m, decisions.get(c.decision)?.path ?? "docs/decisions/README.md")}))` : "").join("; ") + ".",
    "",
    "**Not claimed:** " + not.map((c) => c.kind === "not-claimed" ? `${md(c.text)} (${md(c.reason.replace(/\.$/u, ""))})` : "").join("; ") + ".",
  ].join("\n");
}

/** The org profile: who we are, the honest status, where to look, and the name's own story. */
export function orgProfile(m: Messaging, claims: readonly Claim[]): string {
  const holds = claims.filter((c) => c.kind === "holds-when-green").length;
  const designed = claims.filter((c) => c.kind === "designed").length;
  return [
    `## ${md(m.name)}`,
    "",
    `**${md(m.promise)}** ${md(m.summary)}`,
    "",
    `> ${md(m.status)}`,
    "",
    `- [The roadmap](${m.siteUrl}floor/roadmap/): what is done, what is next, and why; no dates promised.`,
    `- [The claims](${m.siteUrl}floor/claims/): ${holds} claims, each with the check that backs it; ${designed} designed but not built yet.`,
    `- [The source](${m.repositoryUrl}) (${md(m.license)}).`,
    "",
    `*${md(m.about.word)}* (${md(m.about.partOfSpeech)}): ${md(m.about.definition)}. ([${md(m.about.source)}](${m.about.sourceUrl})) ${md(m.about.line)}`,
  ].join("\n");
}

/** The repository's metadata as GitHub takes it. */
export function repositoryMetadata(m: Messaging): Readonly<{ description: string; homepage: string; topics: readonly string[] }> {
  return { description: m.description, homepage: m.siteUrl, topics: m.topics };
}

/** The header every release note opens with: the status line and where the evidence lives. */
export function releaseHeader(m: Messaging): string {
  return [
    `> [!WARNING]`,
    `> **${md(m.status)}** Every release is a preview: the files are attached for inspection, not for deployment.`,
    "",
    `${md(m.promise)} This release's checks and receipts: the promotion receipt and \`SHA256SUMS\` attached below, and the [claims page](${m.siteUrl}floor/claims/).`,
  ].join("\n");
}

const h = escapeHtml;

/** The claims page body (HTML for the one site layout): every claim judged at the published commit. */
export function claimsPage(m: Messaging, judged: readonly JudgedClaim[], commit: string, decisions: ReadonlyMap<string, DecisionState>): string {
  const words: Readonly<Record<JudgedClaim["verdict"], string>> = { holds: "holds", retracted: "retracted", unchecked: "not checked in this build", designed: "designed, not built", "not-claimed": "not claimed" };
  const row = (j: JudgedClaim): string => {
    const c = j.claim;
    const proof = c.kind === "holds-when-green"
      ? `${j.checks.map((k) => `${k.runUrl === null ? h(k.id) : `<a href="${h(k.runUrl)}">${h(k.id)}</a>`} <span class="floor-state" data-status="${h(k.status)}">${h(k.status)}</span>`).join(" · ")}${c.evidence === null ? "" : ` · <a href="${h(blob(m, c.evidence))}">${h(c.evidence)}</a>`}`
      : c.kind === "designed"
        ? `decision <a href="${h(blob(m, decisions.get(c.decision)?.path ?? "docs/decisions/README.md"))}">${h(c.decision)}</a>: ${h(decisions.get(c.decision)?.implementation ?? "unknown")}`
        : `${h(c.reason)}${c.evidence === null ? "" : ` <a href="${h(blob(m, c.evidence))}">Evidence</a>`}`;
    return `<tr data-verdict="${j.verdict}"><td class="floor-claim">${h(c.text)}</td><td>${proof}</td><td><span class="floor-state" data-status="${j.verdict}">${h(words[j.verdict])}</span></td></tr>`;
  };
  const count = (v: JudgedClaim["verdict"]): number => judged.filter((j) => j.verdict === v).length;
  return [
    `<div class="floor-claims" data-commit="${h(commit)}">`,
    `<p class="floor-lede">${h(m.promise)} Each claim below is judged at <a href="${h(`${m.repositoryUrl}/commit/${commit}`)}">main@${h(commit.slice(0, 8))}</a> from the checks that ran on that commit. A claim whose check is red, or did not run there, is struck out until it passes again. Claims we do not make are listed too.</p>`,
    `<p class="floor-facts">${count("holds")} hold · ${count("retracted")} retracted · ${count("unchecked")} not checked · ${count("designed")} designed, not built · ${count("not-claimed")} not claimed</p>`,
    `<p class="floor-gap">${h(m.status)}</p>`,
    `<table class="floor-table floor-claims-table"><thead><tr><th scope="col">Claim</th><th scope="col">Proof you can rerun</th><th scope="col">Verdict</th></tr></thead><tbody>${judged.map(row).join("")}</tbody></table>`,
    `</div>`,
  ].join("\n");
}

/** The claims page as a site page: front matter for the one layout, then the body. */
export function claimsSitePage(m: Messaging, judged: readonly JudgedClaim[], commit: string, decisions: ReadonlyMap<string, DecisionState>): string {
  return [
    "---", "layout: default", "floor_assets: true", "page_class: claims", 'title: "Claims"',
    `description: ${JSON.stringify(`${m.promise} Every claim Bridlewise makes, judged against the checks that ran on the published commit.`)}`,
    "permalink: /floor/claims/", "---", "", "# Claims", "", claimsPage(m, judged, commit, decisions), "",
  ].join("\n");
}
