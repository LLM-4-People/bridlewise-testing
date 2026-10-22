/**
 * THE RELEASE NOTES — generated from the repository's records between the
 * last release's source and this one's (github-only §9.4): the pull requests
 * that landed on `main`, the tracker items closed, the decision records added or changed, and the
 * people the commits credit (`Signed-off-by` and `Co-authored-by` names; an
 * address is never published). The UI's "Generate release notes" is not a
 * second source (`.github/release.yml` excludes everything).
 *
 * Pure over the repository and the plan: the same plan gives the same text
 * (no clock, no network). The public records (tracker items) closed between
 * the two sources are listed by type; module version entries join here when
 * per-module versioning exists (#101).
 */
import { commitTreeReader, gitOutput, type GitRepository } from "../../git/tree-reader.ts";
import type { ReleasePlan, ReleaseSettings } from "./release-train.ts";

/** Where the decision records live (one per file, `docs/decisions/<ID>-<slug>.md`). */
const DECISIONS_FOLDER = "docs/decisions/";
const MERGE_SUBJECT = /^Merge pull request #(\d+) from \S+$/u;
/** A squashed subject ends with ` (#<number>)`: the title before it and the number. */
function squashedPullRequest(subject: string): LandedPullRequest | null {
  const open = subject.lastIndexOf(" (#");
  if (open <= 0 || !subject.endsWith(")")) return null;
  const digits = subject.slice(open + 3, -1);
  return /^\d+$/u.test(digits) ? { number: Number(digits), title: subject.slice(0, open) } : null;
}

type LandedPullRequest = Readonly<{ number: number; title: string }>;

/** The pull requests the first-parent line of `main` landed in `from..to` (oldest first): merge commits and squashed `(#n)` subjects. */
export function landedPullRequests(repository: GitRepository, from: string | null, to: string): readonly LandedPullRequest[] {
  const range = from === null ? [to] : [`${from}..${to}`];
  const records = gitOutput(repository, ["log", "--first-parent", "--reverse", "--format=%s%x00%b%x1e", ...range, "--"]).stdout.toString("utf8").split("\x1e");
  const landed: LandedPullRequest[] = [];
  for (const record of records) {
    const [subject = "", body = ""] = record.replace(/^\n/u, "").split("\0");
    const merged = MERGE_SUBJECT.exec(subject);
    if (merged !== null) {
      landed.push({ number: Number(merged[1]), title: body.split("\n").find((line) => line.trim().length > 0)?.trim() ?? subject });
      continue;
    }
    const squashed = squashedPullRequest(subject);
    if (squashed !== null) landed.push(squashed);
  }
  return landed;
}

type DecisionChange = Readonly<{ status: "added" | "changed" | "removed"; path: string; title: string }>;

/** The decision records `from..to` added, changed or removed (a record's title is its first heading at `to`, else its file name). */
export function decisionChanges(repository: GitRepository, from: string | null, to: string): readonly DecisionChange[] {
  if (from === null) return [];
  const lines = gitOutput(repository, ["diff", "--name-status", "--no-renames", "-z", from, to, "--", DECISIONS_FOLDER]).stdout.toString("utf8").split("\0").filter((part) => part.length > 0);
  const reader = commitTreeReader(repository, to);
  const changes: DecisionChange[] = [];
  for (let index = 0; index + 1 < lines.length; index += 2) {
    const [letter, path] = [lines[index]!, lines[index + 1]!];
    if (!path.endsWith(".md") || path.endsWith("/README.md")) continue;
    const status = letter === "A" ? "added" : letter === "D" ? "removed" : "changed";
    const heading = status === "removed" ? undefined : /^#\s+(.+?)\s*$/mu.exec(reader.text(path) ?? "")?.[1];
    changes.push({ status, path, title: heading ?? path.slice(path.lastIndexOf("/") + 1, -".md".length) });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

/** GitHub's private commit address (`<id>+<login>@users.noreply.github.com`, or `<login>@…`): it names a login, published as `@login`. */
const NOREPLY_ADDRESS = /^(?:\d+\+)?([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))@users\.noreply\.github\.com$/u;

/**
 * How one `Signed-off-by` / `Co-authored-by` value is credited: the name
 * before its `<address>`; a bare GitHub private address as its `@login`;
 * otherwise the value with every word that holds an `@` removed — so no
 * address is ever published, however the trailer was written. `null` when
 * nothing but an address was given.
 */
export function creditedName(value: string): string | null {
  const open = value.indexOf("<");
  const name = (open === -1 ? value : value.slice(0, open)).trim();
  const login = NOREPLY_ADDRESS.exec(name)?.[1];
  if (login !== undefined) return `@${login}`;
  const words = name.split(/\s+/u).filter((word) => word.length > 0 && !word.includes("@") && !/^\(?\)?$/u.test(word));
  return words.length === 0 ? null : words.join(" ");
}

/** The names the non-merge commits of `from..to` credit (`Signed-off-by`, `Co-authored-by`), sorted, each once; never an address. */
export function creditedPeople(repository: GitRepository, from: string | null, to: string): readonly string[] {
  const range = from === null ? [to] : [`${from}..${to}`];
  const text = gitOutput(repository, ["log", "--no-merges", "--format=%(trailers:key=Signed-off-by,valueonly,separator=%x00)%x00%(trailers:key=Co-authored-by,valueonly,separator=%x00)%x00", ...range, "--"]).stdout.toString("utf8");
  const names = new Set<string>();
  for (const value of text.split(/[\0\n]/u)) {
    const name = creditedName(value);
    if (name !== null) names.add(name);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * The release's notes (Markdown) for `plan`, in the repository whose web
 * address is `repositoryUrl` (`<forge>/<owner>/<name>`, as the forge names
 * it: the release job passes `$GITHUB_SERVER_URL/$GITHUB_REPOSITORY`, so no
 * host is spelled here and a rename changes nothing in code).
 */
export function renderReleaseNotes(repository: GitRepository, plan: ReleasePlan, settings: ReleaseSettings, repositoryUrl: string): string {
  const from = plan.previous?.source ?? null;
  const to = plan.product.source;
  // The door validated the address (<forge>/<owner>/<name>, no trailing slash).
  const url = repositoryUrl;
  const slug = url.split("/").slice(-2).join("/");
  const lines: string[] = [];
  if (plan.prerelease) {
    lines.push("> [!WARNING]", "> **Developer preview. Not production-ready.** Do not use Bridlewise with sensitive, proprietary, regulated or production codebases. Read SECURITY.md before running anything.", "");
  }
  lines.push(`The product \`${plan.version}\` is the \`product\` commit [\`${plan.product.commit.slice(0, 12)}\`](${url}/commit/${plan.product.commit}), projected from \`main\` at [\`${to.slice(0, 12)}\`](${url}/commit/${to}).`, "");
  if (plan.previous === null || from === null) {
    // No earlier release, or one from before the product was a projection of
    // main (a seeded preview): there is no source range to read records from.
    lines.push("This is the first release projected from `main`.");
    if (plan.previous !== null) lines.push(`The previous release, [${plan.previous.tag}](${url}/releases/tag/${plan.previous.tag}), predates the projection.`);
    if (settings.priorReleasesUrl !== null) lines.push(`The earlier previews are kept at ${settings.priorReleasesUrl}.`);
    lines.push("");
  } else {
    lines.push(`Changes since [${plan.previous.tag}](${url}/releases/tag/${plan.previous.tag}): [compare](${url}/compare/${plan.previous.tag}...${plan.tag}).`, "");
    const landed = landedPullRequests(repository, from, to);
    if (landed.length > 0) lines.push("## Landed", "", ...landed.map((pull) => `- ${pull.title} (#${String(pull.number)})`), "");
    const closed = plan.closedRecords ?? [];
    if (closed.length > 0) {
      const types = [...new Set(closed.map((record) => record.type))].sort();
      lines.push("## Closed", "", ...types.flatMap((type) => closed.filter((record) => record.type === type).map((record) => `- ${type}: ${record.title} (\`${record.id}\`${record.resolution === null || record.resolution === "completed" ? "" : `, ${record.resolution}`})`)), "");
    }
    const decisions = decisionChanges(repository, from, to);
    if (decisions.length > 0) lines.push("## Decisions", "", ...decisions.map((change) => `- ${change.status}: [${change.title}](${url}/blob/${to}/${change.path})`), "");
    const people = creditedPeople(repository, from, to);
    if (people.length > 0) lines.push("## Credited", "", people.join(", "), "");
  }
  lines.push(
    "## Verify",
    "",
    "Every asset is attested, and the release is immutable:",
    "",
    "```sh",
    `gh release verify ${plan.tag} --repo ${slug}`,
    `gh attestation verify <asset> --repo ${slug}`,
    "```",
    "",
  );
  return lines.join("\n");
}
