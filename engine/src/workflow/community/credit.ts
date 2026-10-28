/**
 * CONTRIBUTOR CREDIT (github-only §10.6): who contributed what, computed from
 * the history that landed, all-contributors style but without its bot (which
 * commits to `main` as a second writer). `landedCommits` reads a range from
 * GitHub; the rest is pure: the same commits always answer the same credit
 * (the release train for a release's notes, the site for `/contributors/`).
 *
 * PRIVACY: credit is by GitHub LOGIN, never by email. A commit's author login
 * is GitHub's own answer (the commit API's `author.login`); a
 * `Co-authored-by:` person is known by login only through GitHub's noreply
 * address (`<id>+<login>@users.noreply.github.com`), and otherwise by the
 * name they wrote. A co-author's email only tells two of them apart and never
 * leaves this module: nothing it answers, and so nothing published from it
 * (pages, release notes, replies), carries one.
 *
 * The project's own tooling is never credited: a bot or App (`[bot]`) and the
 * logins the caller declares as its own.
 */
import type { ForgeClient } from "../forge/port.ts";

/** One commit, as the caller read it from GitHub (oldest first in a list). */
export type CreditCommit = Readonly<{
  sha: string;
  /** GitHub's login for the commit's author, or `null` when GitHub ties the commit to no account. */
  authorLogin: string | null;
  authorName: string;
  message: string;
}>;

export type Contributor = Readonly<{
  /** The GitHub login, when GitHub knows one; the public identity credit uses. */
  login: string | null;
  /** The name as written (shown only when no login is known). */
  name: string;
  /** The commits that credit them, oldest first. */
  commits: readonly string[];
  first: string;
}>;

const CO_AUTHOR = /^Co-authored-by:[ \t]{0,8}([^<\r\n]{1,200}?)[ \t]{0,8}<([^<>\s]{1,320})>[ \t]{0,8}$/gimu;
const NOREPLY = /^(?:\d{1,20}\+)?([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))@users\.noreply\.github\.com$/iu;
const BOT = /\[bot\]/iu;

type Person = Readonly<{ key: string; login: string | null; name: string }>;

/** The people a commit credits: its author, then its co-authors, each once; tooling never. */
function creditedBy(commit: CreditCommit, own: ReadonlySet<string>): readonly Person[] {
  const people: Person[] = [];
  const add = (login: string | null, name: string, fallbackKey: string): void => {
    if (BOT.test(name) || (login !== null && (BOT.test(login) || own.has(login.toLowerCase())))) return;
    const key = login === null ? fallbackKey : `login:${login.toLowerCase()}`;
    if (!people.some((person) => person.key === key)) people.push({ key, login, name: name.trim() });
  };
  add(commit.authorLogin, commit.authorName, `name:${commit.authorName.trim().toLowerCase()}`);
  for (const match of commit.message.matchAll(CO_AUTHOR)) {
    const email = match[2]!;
    add(NOREPLY.exec(email)?.[1] ?? null, match[1]!, `email:${email.toLowerCase()}`);
  }
  return people;
}

/** Every contributor of `commits` (oldest first), in order of first contribution, by login (see the header). */
export function contributorsOf(commits: readonly CreditCommit[], own: ReadonlySet<string> = new Set()): readonly Contributor[] {
  const ownLogins = new Set([...own].map((login) => login.toLowerCase()));
  const byKey = new Map<string, { login: string | null; name: string; commits: string[]; first: string }>();
  for (const commit of commits) {
    for (const person of creditedBy(commit, ownLogins)) {
      const known = byKey.get(person.key);
      if (known === undefined) byKey.set(person.key, { login: person.login, name: person.name, commits: [commit.sha], first: commit.sha });
      else {
        known.name = person.name;
        known.commits.push(commit.sha);
      }
    }
  }
  return Object.freeze([...byKey.values()].map((contributor) => Object.freeze({ ...contributor, commits: Object.freeze(contributor.commits) })));
}

/** A release's credit: every contributor of the release's commits, and the new ones (no earlier commit credits them). */
export function releaseCredit(before: readonly CreditCommit[], release: readonly CreditCommit[], own: ReadonlySet<string> = new Set()): Readonly<{ all: readonly Contributor[]; newcomers: readonly Contributor[] }> {
  const identity = (contributor: Contributor): string => (contributor.login === null ? `name:${contributor.name.toLowerCase()}` : `login:${contributor.login.toLowerCase()}`);
  const earlier = new Set(contributorsOf(before, own).map(identity));
  const all = contributorsOf(release, own);
  return Object.freeze({ all, newcomers: Object.freeze(all.filter((contributor) => !earlier.has(identity(contributor)))) });
}

/**
 * The commits from `base` (excluded) to `head`, oldest first, as GitHub
 * answers them (`GET …/compare/{base}...{head}`, page by page): each with its
 * author's login, the one public identity credit uses.
 */
export async function landedCommits(client: ForgeClient, owner: string, repository: string, base: string, head: string, maxPages: number): Promise<readonly CreditCommit[]> {
  const commits = await client.paginate<{ sha: string; author?: { login?: unknown } | null; commit: { author?: { name?: unknown } | null; message: string } }>(
    { path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}` },
    { maxPages, perPage: 100, items: (data) => (data as { commits?: [] }).commits ?? [] },
  );
  return Object.freeze(commits.map((commit) => Object.freeze({
    sha: commit.sha,
    authorLogin: typeof commit.author?.login === "string" ? commit.author.login : null,
    authorName: typeof commit.commit.author?.name === "string" ? commit.commit.author.name : "",
    message: commit.commit.message,
  })));
}
