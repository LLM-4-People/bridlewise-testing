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
 * - the site's data (`_data/brand.json`, written by the site build with the
 *   checks snapshot): every claim with its proof and its verdict, a claim
 *   whose check is red, or did not run on the published commit, RETRACTED,
 *   publicly and at once (user decision, 2026-10-21). The landing and the
 *   claims page are DESIGN's templates over it.
 *
 * The visual treatment of the site and the images is DESIGN's; this module
 * writes words and the semantic markup they sit in.
 */
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

/** The verdict words a reader sees (one vocabulary for every surface that shows a verdict). */
export const VERDICT_WORDS: Readonly<Record<JudgedClaim["verdict"], string>> = Object.freeze({ holds: "holds", retracted: "retracted", unchecked: "not checked in this build", designed: "designed, not built", "not-claimed": "not claimed" });

/**
 * The judged register as the site's data (`_data/brand.json`): plain values,
 * no markup. DESIGN's templates (the landing, `/floor/claims/`) render it, so
 * the claims have one markup, in the one design system.
 */
export function brandSite(m: Messaging, judged: readonly JudgedClaim[], commit: string, decisions: ReadonlyMap<string, DecisionState>): Readonly<Record<string, unknown>> {
  const counts = Object.fromEntries((Object.keys(VERDICT_WORDS) as JudgedClaim["verdict"][]).map((verdict) => [verdict, judged.filter((j) => j.verdict === verdict).length]));
  return {
    schema: "bridlewise-brand-site/v1",
    commit,
    commitUrl: `${m.repositoryUrl}/commit/${commit}`,
    messaging: m,
    counts,
    claims: judged.map(({ claim, verdict, checks }) => ({
      id: claim.id,
      kind: claim.kind,
      text: claim.text,
      verdict,
      verdictWords: VERDICT_WORDS[verdict],
      checks: checks.map((check) => ({ id: check.id, status: check.status, runUrl: check.runUrl })),
      proof: claim.kind === "designed"
        ? { label: claim.decision, href: blob(m, decisions.get(claim.decision)?.path ?? "docs/decisions/README.md"), implementation: decisions.get(claim.decision)?.implementation ?? "unknown" }
        : claim.evidence === null ? null : { label: claim.evidence, href: blob(m, claim.evidence) },
      reason: claim.kind === "not-claimed" ? claim.reason : null,
      example: claim.kind === "holds-when-green" && claim.example !== undefined ? { ...claim.example, sourceUrl: blob(m, claim.example.source) } : null,
    })),
  };
}
