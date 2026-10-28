/**
 * EVERY COMMIT CARRIES ITS COMMITTER'S SIGN-OFF (the DCO, `git commit -s`).
 *
 * The rule is binding and was enforced by nothing: seven merge commits on the
 * design and marketing branches carried no `Signed-off-by`, and neither the
 * commit-msg hook (which `git merge` runs too) nor CI refused them. It is
 * judged at the two lowest doors:
 *
 *   - the `commit-msg` hook (the commit guard's message duty): the message
 *     must carry a `Signed-off-by` trailer naming the committer git will
 *     record (`git var GIT_COMMITTER_IDENT`), merge commits included
 *     (`git merge --signoff`, or `git commit -s` after a conflicted merge);
 *   - CI, over a pull request's, a merge group's or a push's commits
 *     (`node scripts/verification/sign-off.ts --range <base>..<head>`): every
 *     commit's trailers must name its own committer.
 *
 * The one exception is a MECHANICAL merge: a merge commit GitHub itself made
 * (committer `GitHub <noreply@github.com>`; the merge queue's and a merged
 * pull request's), which carries no author's work of its own.
 *
 * A sign-off matches when its name is the committer's name and its address is
 * the committer's address (an address compared without regard to case).
 * Trailers are git's own parse (`commit-trailers.ts`), so a `Signed-off-by:`
 * line inside the body is not a sign-off.
 *
 * AN AGENT COMMIT IS THE PROJECT'S IDENTITY THROUGHOUT. Its author, its
 * committer and EVERY sign-off are the declared agent identity
 * (`ROOT_POLICY.workflow.commitIdentity.agent`, the one source), never a
 * person's own name or address. A commit is an agent's when any identity on it
 * is the agent identity or uses its address's domain (the commit-msg hook
 * reads that), or when the pull request bringing it was opened by a declared
 * agent account (`agentAccounts`; the server-side check passes the pull
 * request's author). A human outside contributor's commit carries none of
 * those marks and keeps the ordinary DCO: their own sign-off as committer.
 */
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { bootstrapProcess, isEntryPoint } from "../../src/runtime/cli-debug.ts";
import { gitText as git, messageTrailerValues, trailerValuesOf } from "./commit-trailers.ts";

/** The trailer key of a sign-off. */
export const SIGN_OFF_TRAILER = "Signed-off-by";

/** The identity GitHub commits its own merges under (the one mechanical committer). */
const GITHUB_MERGE_COMMITTER = Object.freeze({ name: "GitHub", email: "noreply@github.com" });

export type Identity = Readonly<{ name: string; email: string }>;

/** The project's identity for agent commits, and the accounts that open agent pull requests (the one declared source). */
export const AGENT_IDENTITY: Identity = ROOT_POLICY.workflow.commitIdentity.agent;
const AGENT_ACCOUNTS: readonly string[] = ROOT_POLICY.workflow.commitIdentity.agentAccounts;

const domainOf = (email: string): string => email.slice(email.lastIndexOf("@") + 1).toLowerCase();

/** Is a pull request opened by `login` an agent's (a declared agent account)? */
export function isAgentAccount(login: string): boolean {
  return AGENT_ACCOUNTS.includes(login);
}

/**
 * The refusals of a commit by its identities: an agent commit (any identity
 * is the agent's or in its domain, or `agentPullRequest`) whose author,
 * committer or any sign-off is not exactly the agent identity, each named. A
 * human's commit (no such mark) answers none: it keeps the ordinary DCO.
 */
export function agentIdentityProblems(
  commit: Readonly<{ author: Identity; committer: Identity; signOffs: readonly Identity[] }>,
  agentPullRequest = false,
): readonly string[] {
  const identities = [["author", commit.author], ["committer", commit.committer], ...commit.signOffs.map((signOff) => ["Signed-off-by", signOff] as const)] as const;
  const agent = agentPullRequest || identities.some(([, identity]) => sameIdentity(identity, AGENT_IDENTITY) || domainOf(identity.email) === domainOf(AGENT_IDENTITY.email));
  if (!agent) return [];
  return identities.flatMap(([role, identity]) => sameIdentity(identity, AGENT_IDENTITY) ? [] :
    [`its ${role} is ${identity.name} <${identity.email}>, not the project's agent identity ${AGENT_IDENTITY.name} <${AGENT_IDENTITY.email}>`]);
}

/** `Name <address>`, as a sign-off or an ident spells it; `null` when the text is not one. */
function parseIdentity(text: string): Identity | null {
  const match = /^(.+?)\s*<([^<>\s]+)>/u.exec(text.trim());
  return match === null ? null : { name: match[1]!.trim(), email: match[2]! };
}

function sameIdentity(left: Identity, right: Identity): boolean {
  return left.name === right.name && left.email.toLowerCase() === right.email.toLowerCase();
}

/** The identities of `Signed-off-by` trailer values. */
function signOffsOf(values: readonly string[]): readonly Identity[] {
  return values.flatMap((value) => {
    const identity = parseIdentity(value);
    return identity === null ? [] : [identity];
  });
}

/** The author git will record for a commit made at `root` now. */
export function authorIdentity(root: string): Identity {
  const identity = parseIdentity(git(root, ["var", "GIT_AUTHOR_IDENT"]));
  if (identity === null) throw new Error("git names no author identity here (git var GIT_AUTHOR_IDENT)");
  return identity;
}

/** The committer git will record for a commit made at `root` now. */
export function committerIdentity(root: string): Identity {
  const identity = parseIdentity(git(root, ["var", "GIT_COMMITTER_IDENT"]));
  if (identity === null) throw new Error("git names no committer identity here (git var GIT_COMMITTER_IDENT)");
  return identity;
}

/**
 * The refusal of a commit message that carries no sign-off by `committer`
 * (the `commit-msg` question), or `null` when one of its trailers is that
 * committer's.
 */
export function messageSignOffProblem(
  root: string,
  message: string,
  committer: Identity = committerIdentity(root),
  author: Identity = authorIdentity(root),
): string | null {
  const signOffs = signOffsOf(messageTrailerValues(root, message, SIGN_OFF_TRAILER));
  if (signOffs.some((signOff) => sameIdentity(signOff, committer))) {
    const identity = agentIdentityProblems({ author, committer, signOffs });
    return identity.length === 0 ? null : `an agent commit is the project's identity throughout, and ${identity.join("; ")}: set user.name and user.email to it`;
  }
  const found = signOffs.length === 0 ? "it carries none" : `it carries ${signOffs.map((signOff) => `${signOff.name} <${signOff.email}>`).join(", ")}`;
  return `the message has no "${SIGN_OFF_TRAILER}: ${committer.name} <${committer.email}>" trailer (${found}); commit with -s (a merge: git merge --signoff, or git commit -s after resolving)`;
}

/**
 * Every commit of `range` (`<base>..<head>`, as `git log` reads it) whose
 * trailers carry no sign-off by its own committer, each named; a merge GitHub
 * made itself is mechanical and passes.
 */
export function unsignedCommits(root: string, range: string, agentPullRequest = false): readonly string[] {
  const records = git(root, ["log", "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%(trailers:only,unfold)%x1e", range, "--"]);
  return records.split("\x1e").map((record) => record.replace(/^\n/u, "")).filter((record) => record.length > 0).flatMap((record) => {
    const [sha = "", parents = "", authorName = "", authorEmail = "", name = "", email = "", trailers = ""] = record.split("\x1f");
    const committer = { name, email };
    if (parents.trim().split(" ").length > 1 && sameIdentity(committer, GITHUB_MERGE_COMMITTER)) return [];
    const signOffs = signOffsOf(trailerValuesOf(trailers, SIGN_OFF_TRAILER));
    if (!signOffs.some((signOff) => sameIdentity(signOff, committer))) return [`${sha.slice(0, 12)} has no "${SIGN_OFF_TRAILER}: ${name} <${email}>" trailer`];
    return agentIdentityProblems({ author: { name: authorName, email: authorEmail }, committer, signOffs }, agentPullRequest).map((problem) => `${sha.slice(0, 12)} is an agent commit and ${problem}`);
  });
}

if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  const [flag, range, authorFlag, login] = process.argv.slice(2);
  if (flag !== "--range" || range === undefined || !range.includes("..") || (authorFlag !== undefined && (authorFlag !== "--pull-request-author" || login === undefined))) {
    throw new Error("Usage: sign-off --range <base>..<head> [--pull-request-author <login>]");
  }
  // A pull request a declared agent account opened brings agent commits only, whatever their marks say.
  const unsigned = unsignedCommits(process.cwd(), range, login !== undefined && isAgentAccount(login));
  if (unsigned.length === 0) {
    process.stdout.write(`sign-off: every commit of ${range} carries its committer's sign-off, and every agent commit is the project identity\n`);
  } else {
    process.stderr.write(`sign-off: ${String(unsigned.length)} commit(s) of ${range} break the DCO (no sign-off by their committer: git commit -s) or the agent identity (an agent commit is the project identity throughout):\n${unsigned.map((line) => `  - ${line}`).join("\n")}\n`);
    process.exitCode = 1;
  }
}
