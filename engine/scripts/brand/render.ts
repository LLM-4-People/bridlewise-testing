/**
 * THE PUBLIC WORDS, RENDERED — every surface's copy from the two sources
 * (`docs/brand/messaging.json`, `docs/brand/claims.json`) and, where status
 * matters, the floor's checks snapshot and the roadmap feed. Nothing here is
 * typed per surface; a new promise or claim is one edit to a source.
 *
 * Surfaces (each a pure function):
 * - the README's front block (Markdown; GH-7's projector writes it into the README);
 * - the org profile (Markdown; GH-7 writes `profile/README.md` in `.github`);
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
import type { Words } from "./words.ts";

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
const h = escapeHtml;
const code = (text: string): string => ["`", text, "`"].join("");
const md = (text: string): string => text.replace(/([\\`*_[\]|<>])/gu, "\\$1");
/** A repository file as a page the site serves links it: through `site.repository_url`, never a spelled address. */
const siteBlob = (path: string): string => (path.startsWith("https://") ? path : `{{ site.repository_url }}/blob/main/${path}`);
const blob = (m: Words, path: string): string => (path.startsWith("https://") ? path : `${m.repositoryUrl}/blob/main/${path}`);

/** The README's front block: the promise, the summary, the preview warning, and the claims with their proof. */
export function readmeHero(m: Words, claims: readonly Claim[], decisions: ReadonlyMap<string, DecisionState>): string {
  const holds = claims.filter((c) => c.kind === "holds-when-green");
  const designed = claims.filter((c) => c.kind === "designed");
  const not = claims.filter((c) => c.kind === "not-claimed");
  return [
    `**${md(m.promise)}**`,
    "",
    md(m.summary),
    "",
    md(m.repository),
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
export function orgProfile(m: Words, claims: readonly Claim[]): string {
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
/** The README's front block (written by `harness sync` between {@link FRONT_DOORS}' README markers): the name, then the hero. */
export function readmeFront(m: Words, claims: readonly Claim[], decisions: ReadonlyMap<string, DecisionState>): string {
  return [`# ${md(m.name)}`, "", readmeHero(m, claims, decisions)].join("\n");
}

/** The site home's hero text (written by `harness sync` between {@link FRONT_DOORS}' site markers, inside the page's hero section), in the site's own components. */
export function siteFront(m: Words): string {
  return [
    `  <p class="eyebrow">${h(m.name)} <span class="dot" aria-hidden="true"></span> ${h(m.license)} <span class="dot" aria-hidden="true"></span> Developer preview</p>`,
    `  <h1>${h(m.promise)}</h1>`,
    `  <p class="lede">${h(m.summary)}</p>`,
    `  <p class="lede">${h(m.repository)}</p>`,
    `  <div class="actions">`,
    `    <a class="button primary" href="{{ '/quickstart/' | relative_url }}">Start with a disposable copy</a>`,
    `    <a class="button" href="{{ '/floor/claims/' | relative_url }}">Check every claim</a>`,
    `    <a class="button" href="{{ '/floor/roadmap/' | relative_url }}">Read the roadmap</a>`,
    `    <a class="button" href="{{ site.repository_url }}">Read the source</a>`,
    `  </div>`,
    `  <p class="hero-note">${h(m.status)}</p>`,
  ].join("\n");
}

/**
 * THE FRONT DOORS: each file whose opening block is generated from the two
 * sources by `harness sync` (`cli.ts sync`) and judged by `harness check`.
 * The text around a block is hand-written; the block is never edited by hand.
 */
export const FRONT_DOORS: readonly Readonly<{ path: string; begin: string; end: string; render: (m: Words, claims: readonly Claim[], decisions: ReadonlyMap<string, DecisionState>) => string }>[] = Object.freeze([
  {
    path: "README.md",
    begin: "<!-- BEGIN GENERATED: the front door, from docs/brand/ (harness sync; engine/scripts/brand/cli.ts) -->",
    end: "<!-- END GENERATED: the front door -->",
    render: readmeFront,
  },
  {
    path: "docs/index.md",
    begin: "<!-- BEGIN GENERATED: the site's front door, from docs/brand/ (harness sync; engine/scripts/brand/cli.ts) -->",
    end: "<!-- END GENERATED: the site's front door -->",
    render: (m) => siteFront(m),
  },
  {
    path: "docs/index.md",
    begin: "# BEGIN GENERATED: the site's title and description, from docs/brand/messaging.json (harness sync)",
    end: "# END GENERATED: the site's title and description",
    render: (m) => [`title: ${JSON.stringify(`${m.name}: ${m.promise}`)}`, `description: ${JSON.stringify(m.description)}`].join("\n"),
  },
]);


/** The header every release note opens with: the status line and where the evidence lives. */
export function releaseHeader(m: Words): string {
  return [
    `> [!WARNING]`,
    `> **${md(m.status)}** Every release is a preview: the files are attached for inspection, not for deployment.`,
    "",
    `${md(m.promise)} This release's checks and receipts: the promotion receipt and \`SHA256SUMS\` attached below, and the [claims page](${m.siteUrl}floor/claims/).`,
  ].join("\n");
}


/** The claims page body (HTML for the one site layout): every claim judged at the published commit. */
export function claimsPage(m: Words, judged: readonly JudgedClaim[], commit: string, decisions: ReadonlyMap<string, DecisionState>): string {
  const words: Readonly<Record<JudgedClaim["verdict"], string>> = { holds: "holds", retracted: "retracted", unchecked: "not checked in this build", designed: "designed, not built", "not-claimed": "not claimed" };
  const row = (j: JudgedClaim): string => {
    const c = j.claim;
    const proof = c.kind === "holds-when-green"
      ? `${j.checks.map((k) => `${k.runUrl === null ? h(k.id) : `<a href="${h(k.runUrl)}">${h(k.id)}</a>`} <span class="floor-state" data-status="${h(k.status)}">${h(k.status)}</span>`).join(" · ")}${c.evidence === null ? "" : ` · <a href="${h(siteBlob(c.evidence))}">${h(c.evidence)}</a>`}`
      : c.kind === "designed"
        ? `decision <a href="${h(siteBlob(decisions.get(c.decision)?.path ?? "docs/decisions/README.md"))}">${h(c.decision)}</a>: ${h(decisions.get(c.decision)?.implementation ?? "unknown")}`
        : `${h(c.reason)}${c.evidence === null ? "" : ` <a href="${h(siteBlob(c.evidence))}">Evidence</a>`}`;
    return `<tr data-verdict="${j.verdict}"><td class="floor-claim">${h(c.text)}</td><td>${proof}</td><td><span class="floor-state" data-status="${j.verdict}">${h(words[j.verdict])}</span></td></tr>`;
  };
  const count = (v: JudgedClaim["verdict"]): number => judged.filter((j) => j.verdict === v).length;
  return [
    `<div class="floor-claims" data-commit="${h(commit)}">`,
    `<p class="floor-lede">${h(m.promise)} Each claim below is judged at <a href="${h(`{{ site.repository_url }}/commit/${commit}`)}">main@${h(commit.slice(0, 8))}</a> from the checks that ran on that commit. A claim whose check is red, or did not run there, is struck out until it passes again. Claims we do not make are listed too.</p>`,
    `<p class="floor-facts">${count("holds")} hold · ${count("retracted")} retracted · ${count("unchecked")} not checked · ${count("designed")} designed, not built · ${count("not-claimed")} not claimed</p>`,
    `<p class="floor-gap">${h(m.status)}</p>`,
    `<table class="floor-claims-table"><thead><tr><th scope="col">Claim</th><th scope="col">Proof you can rerun</th><th scope="col">Verdict</th></tr></thead><tbody>${judged.map(row).join("")}</tbody></table>`,
    `</div>`,
  ].join("\n");
}

/** The claims page as a site page: front matter for the one layout, then the body. */
/**
 * The claims page's shell (`docs/floor/claims.md`, a page the site builds):
 * the site build writes the judged claims between these markers.
 */
export const CLAIMS_PAGE_BLOCK = Object.freeze({
  path: "docs/floor/claims.md",
  begin: "<!-- BEGIN GENERATED AT PUBLISH: the claims, judged at the published commit (engine/scripts/brand/cli.ts build) -->",
  end: "<!-- END GENERATED AT PUBLISH: the claims -->",
});
