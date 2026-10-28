/**
 * CONTRIBUTOR CREDIT (github-only §10.6): who contributed what, computed from
 * the history that landed, all-contributors style but without its bot (which
 * commits to `main` as a second writer). Pure: the caller hands over the
 * commits (the release train for a release's notes, the site for
 * `/contributors/`), and the same commits always answer the same credit.
 *
 * A commit credits its author and every `Co-authored-by:` trailer, as kind
 * `code`. The project's own tooling is never credited: a GitHub App or bot
 * identity (`[bot]`, `…[bot]@users.noreply.github.com`) and the identities a
 * caller declares as its own (the agents' commit identity, for example).
 * People are keyed by email, lower-cased, so one person with two spellings of
 * a name is one contributor; the name shown is their latest.
 */

/** One commit, as the caller read it (oldest first in a list). */
export type CreditCommit = Readonly<{ sha: string; authorName: string; authorEmail: string; message: string }>;

export type Contributor = Readonly<{
  name: string;
  email: string;
  /** The commits that credit them, oldest first. */
  commits: readonly string[];
  /** The first commit that credited them. */
  first: string;
}>;

const CO_AUTHOR = /^Co-authored-by:\s*(.+?)\s*<([^<>\s]+)>\s*$/gimu;

/** Whether `email`/`name` is tooling, never a person: a bot or App identity, or one the caller declares its own. */
function isTooling(name: string, email: string, own: ReadonlySet<string>): boolean {
  return /\[bot\]/iu.test(name) || /\[bot\]@users\.noreply\.github\.com$/iu.test(email) || own.has(email.toLowerCase());
}

/** The people a commit credits: its author, then its co-authors, each once. */
export function creditedBy(commit: CreditCommit, own: ReadonlySet<string> = new Set()): readonly Readonly<{ name: string; email: string }>[] {
  const people = [{ name: commit.authorName, email: commit.authorEmail }, ...[...commit.message.matchAll(CO_AUTHOR)].map((match) => ({ name: match[1]!, email: match[2]! }))];
  const seen = new Set<string>();
  return people.filter((person) => {
    const key = person.email.toLowerCase();
    if (seen.has(key) || isTooling(person.name, person.email, own)) return false;
    seen.add(key);
    return true;
  });
}

/** Every contributor of `commits` (oldest first), in order of first contribution. */
export function contributorsOf(commits: readonly CreditCommit[], own: ReadonlySet<string> = new Set()): readonly Contributor[] {
  const byEmail = new Map<string, { name: string; email: string; commits: string[]; first: string }>();
  const lowered = new Set([...own].map((email) => email.toLowerCase()));
  for (const commit of commits) {
    for (const person of creditedBy(commit, lowered)) {
      const key = person.email.toLowerCase();
      const known = byEmail.get(key);
      if (known === undefined) byEmail.set(key, { name: person.name, email: key, commits: [commit.sha], first: commit.sha });
      else {
        known.name = person.name;
        known.commits.push(commit.sha);
      }
    }
  }
  return Object.freeze([...byEmail.values()].map((contributor) => Object.freeze({ ...contributor, commits: Object.freeze(contributor.commits) })));
}

/**
 * A release's credit: every contributor of the release's commits, and the
 * new ones — those no commit before the release credits (the "new
 * contributors" line of the release notes).
 */
export function releaseCredit(before: readonly CreditCommit[], release: readonly CreditCommit[], own: ReadonlySet<string> = new Set()): Readonly<{ all: readonly Contributor[]; newcomers: readonly Contributor[] }> {
  const earlier = new Set(contributorsOf(before, own).map((contributor) => contributor.email));
  const all = contributorsOf(release, own);
  return Object.freeze({ all, newcomers: Object.freeze(all.filter((contributor) => !earlier.has(contributor.email))) });
}
