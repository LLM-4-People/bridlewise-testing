/**
 * EVERY COMMIT CARRIES ITS COMMITTER'S SIGN-OFF (the DCO, `git commit -s`),
 * AND AN AGENT COMMIT CARRIES NOBODY'S PERSONAL IDENTITY.
 *
 * The DCO rule is binding and was enforced by nothing: seven merge commits on
 * the design and marketing branches carried no `Signed-off-by`, and neither
 * the commit-msg hook (which `git merge` runs too) nor CI refused them. It is
 * judged at two doors, with this one judge ({@link commitRecordProblems}):
 *
 *   - the `commit-msg` hook (the commit guard's message duty), over the
 *     message and the author and committer git will record
 *     (`git var GIT_AUTHOR_IDENT` / `GIT_COMMITTER_IDENT`), merges included
 *     (`git merge --signoff`, or `git commit -s` after a conflicted merge);
 *   - the required `commit-records` workflow, over a pull request's or a merge
 *     group's commits (`node scripts/verification/sign-off.ts --range
 *     <base>..<head>`).
 *
 * THE IDENTITY TRAILERS. Every trailer whose key ends in `-by` (any case:
 * `Signed-off-by`, `signed-off-by`, `Co-authored-by`, `Reviewed-by`, …) or
 * whose value carries an `@` names a person, and GitHub shows it publicly.
 * Each must be exactly `Name <address>`: a bare address, a missing name, or
 * text after the `>` is refused by name, never dropped (a dropped trailer is
 * a published address nobody judged). A sign-off is an identity trailer whose
 * key is `signed-off-by` in any case; one of them must be the committer's.
 *
 * AN AGENT COMMIT IS THE PROJECT'S IDENTITY THROUGHOUT: its author, its
 * committer and EVERY identity trailer are the declared agent identity
 * (`ROOT_POLICY.workflow.commitIdentity.agent`, the one source). A commit is an
 * agent's when any identity on it is the agent identity or uses its address's
 * domain, when it is made in a checkout the harness made for an agent (the
 * `agentCheckoutKey` git config the workspace and candidate writers set beside
 * the agent identity, read by the hook), or when the pull request bringing it
 * was opened by a declared agent account (`agentAccounts`; the workflow passes
 * the pull request's author). A human outside contributor's commit carries
 * none of those marks and keeps the ordinary DCO.
 *
 * NO NAME IS AN EXEMPTION. A committer name and address are anyone's to set,
 * so no commit passes because of who it says committed it. The one commit a
 * contributor cannot make is the merge queue's own: in a merge group
 * (`--merge-group`), the first-parent chain from the group's head down to its
 * base is the queue's merges on a ref only GitHub writes
 * (`gh-readonly-queue/…`), so each of those must BE a merge and is not judged,
 * while every commit they bring in is.
 */
import { HarnessError, InputError } from "../../src/kernel/errors.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { bootstrapProcess, isEntryPoint } from "../../src/runtime/cli-debug.ts";
import { gitText as git, messageTrailers, trailersOf } from "./commit-trailers.ts";

/** The trailer key of a sign-off (compared without regard to case). */
export const SIGN_OFF_TRAILER = "Signed-off-by";

export type Identity = Readonly<{ name: string; email: string }>;
type Trailer = Readonly<{ key: string; value: string }>;

/** The project's identity for agent commits, and the accounts that open agent pull requests (the one declared source). */
export const AGENT_IDENTITY: Identity = ROOT_POLICY.workflow.commitIdentity.agent;
const AGENT_ACCOUNTS: readonly string[] = ROOT_POLICY.workflow.commitIdentity.agentAccounts;
/** The git config key a harness-made agent checkout carries (the one declared source). */
export const AGENT_CHECKOUT_KEY: string = ROOT_POLICY.workflow.commitIdentity.agentCheckoutKey;

const domainOf = (email: string): string => email.slice(email.lastIndexOf("@") + 1).toLowerCase();

/** Is a pull request opened by `login` an agent's (a declared agent account)? */
export function isAgentAccount(login: string): boolean {
  return AGENT_ACCOUNTS.includes(login);
}

/** `Name <address>` and nothing else, as a sign-off or an ident spells it; `null` when the text is not exactly one. */
function parseIdentity(text: string): Identity | null {
  const match = /^([^<>@]*[^<>@\s])\s*<([^<>\s@]+@[^<>\s@]+)>$/u.exec(text.trim());
  return match === null ? null : { name: match[1]!.trim(), email: match[2]! };
}

/** An ident as `git var` prints it: `Name <address> <time> <zone>`. */
function parseIdent(text: string): Identity | null {
  return parseIdentity(text.trim().replace(/\s+\d+\s+[+-]\d{4}$/u, ""));
}

function sameIdentity(left: Identity, right: Identity): boolean {
  return left.name === right.name && left.email.toLowerCase() === right.email.toLowerCase();
}

const spelled = (identity: Identity): string => `${identity.name} <${identity.email}>`;

/** Does `trailer` name a person (a `-by` key in any case, or an address in its value)? */
function isIdentityTrailer(trailer: Trailer): boolean {
  return /-by$/iu.test(trailer.key) || trailer.value.includes("@");
}

/** The commit a judgement reads: its two idents and every trailer of its message. */
export type JudgedCommit = Readonly<{ author: Identity; committer: Identity; trailers: readonly Trailer[] }>;

/**
 * THE judge: the refusals of one commit, each named. `agentMarked` says the
 * context made it an agent's whatever its identities say (a declared agent
 * account's pull request; a harness-made agent checkout).
 */
export function commitRecordProblems(commit: JudgedCommit, agentMarked = false): readonly string[] {
  const named = commit.trailers.filter(isIdentityTrailer).map((trailer) => ({ trailer, identity: parseIdentity(trailer.value) }));
  const unreadable = named.filter((entry) => entry.identity === null)
    .map(({ trailer }) => `its "${trailer.key}: ${trailer.value}" trailer is not exactly one "Name <address>"`);
  const people = named.flatMap((entry) => entry.identity === null ? [] : [{ role: `${entry.trailer.key} trailer`, identity: entry.identity }]);
  const signOffs = named.flatMap((entry) => entry.identity !== null && entry.trailer.key.toLowerCase() === SIGN_OFF_TRAILER.toLowerCase() ? [entry.identity] : []);
  const dco = signOffs.some((signOff) => sameIdentity(signOff, commit.committer)) ? [] :
    [`it has no "${SIGN_OFF_TRAILER}: ${spelled(commit.committer)}" trailer (${signOffs.length === 0 ? "it carries none" : `it carries ${signOffs.map(spelled).join(", ")}`}); commit with -s (a merge: git merge --signoff, or git commit -s after resolving)`];
  const identities = [{ role: "author", identity: commit.author }, { role: "committer", identity: commit.committer }, ...people];
  const agent = agentMarked || identities.some(({ identity }) => sameIdentity(identity, AGENT_IDENTITY) || domainOf(identity.email) === domainOf(AGENT_IDENTITY.email));
  const agentProblems = !agent ? [] : identities.filter(({ identity }) => !sameIdentity(identity, AGENT_IDENTITY))
    .map(({ role, identity }) => `it is an agent commit and its ${role} is ${spelled(identity)}, not the project's agent identity ${spelled(AGENT_IDENTITY)}`);
  return [...unreadable, ...dco, ...agentProblems];
}

/** Is `root` a checkout the harness made for an agent (its {@link AGENT_CHECKOUT_KEY} is true, read as the hook's git reads it)? */
export function isAgentCheckout(root: string): boolean {
  const answer = git(root, ["config", "--type=bool", "--default=false", "--get", AGENT_CHECKOUT_KEY]).trim();
  return answer === "true";
}

/** The ident git will record for a commit made at `root` now (`GIT_AUTHOR_IDENT` or `GIT_COMMITTER_IDENT`). */
function pendingIdent(root: string, variable: "GIT_AUTHOR_IDENT" | "GIT_COMMITTER_IDENT"): Identity {
  const identity = parseIdent(git(root, ["var", variable]));
  if (identity === null) throw new InputError(`git names no usable identity here (git var ${variable}): set user.name and user.email`, "commit_identity_unreadable");
  return identity;
}

function pendingIdents(root: string): Readonly<{ author: Identity; committer: Identity }> {
  return { author: pendingIdent(root, "GIT_AUTHOR_IDENT"), committer: pendingIdent(root, "GIT_COMMITTER_IDENT") };
}

/** The committer git will record for a commit made at `root` now. */
export function committerIdentity(root: string): Identity {
  return pendingIdent(root, "GIT_COMMITTER_IDENT");
}

/**
 * The refusal of a commit message about to be recorded at `root` (the
 * `commit-msg` question), or `null` when the commit's records are right.
 */
export function messageSignOffProblem(
  root: string,
  message: string,
  idents: Readonly<{ author: Identity; committer: Identity }> = pendingIdents(root),
  agentCheckout: boolean = isAgentCheckout(root),
): string | null {
  const problems = commitRecordProblems({ ...idents, trailers: messageTrailers(root, message) }, agentCheckout);
  if (problems.length === 0) return null;
  const repair = agentCheckout ? ` (this checkout is an agent's: its ${AGENT_CHECKOUT_KEY} is set, so user.name and user.email are ${spelled(AGENT_IDENTITY)})` : "";
  return `${problems.join("; ")}${repair}`;
}

/** How a range is read: a pull request's (every commit judged) or a merge group's (the queue's own first-parent merges are not). */
export type RangeContext = Readonly<{ agentPullRequest?: boolean; mergeGroup?: boolean }>;

/** Every commit of `range` (`<base>..<head>`) whose records are wrong, each named with its refusals. */
export function unsignedCommits(root: string, range: string, context: RangeContext = {}): readonly string[] {
  const [base, head] = range.split("..");
  if (base === undefined || head === undefined || base.length === 0 || head.length === 0) throw new InputError(`a range is <base>..<head>, not ${range}`, "sign_off_range_invalid");
  const queue = new Set<string>();
  const problems: string[] = [];
  if (context.mergeGroup === true) {
    for (const line of git(root, ["rev-list", "--first-parent", "--parents", range, "--"]).split("\n").filter((entry) => entry.length > 0)) {
      const [sha = "", ...parents] = line.split(" ");
      if (parents.length !== 2) problems.push(`${sha.slice(0, 12)} is on the merge group's first-parent chain but is not a merge: the queue makes only merges, so this commit is not the queue's`);
      else queue.add(sha);
    }
  }
  const records = git(root, ["log", "--format=%H%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%(trailers:only,unfold)%x1e", range, "--"]);
  for (const record of records.split("\x1e").map((entry) => entry.replace(/^\n/u, "")).filter((entry) => entry.length > 0)) {
    const [sha = "", authorName = "", authorEmail = "", name = "", email = "", trailers = ""] = record.split("\x1f");
    if (queue.has(sha)) continue;
    const judged = commitRecordProblems({ author: { name: authorName, email: authorEmail }, committer: { name, email }, trailers: trailersOf(trailers) }, context.agentPullRequest === true);
    problems.push(...judged.map((problem) => `${sha.slice(0, 12)}: ${problem}`));
  }
  return problems;
}

if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  const argv = process.argv.slice(2);
  const valueOf = (flag: string): string | undefined => {
    const at = argv.indexOf(flag);
    return at < 0 ? undefined : argv[at + 1];
  };
  const range = valueOf("--range");
  const login = valueOf("--pull-request-author");
  const mergeGroup = argv.includes("--merge-group");
  if (range === undefined || (argv.includes("--pull-request-author") && login === undefined) || (mergeGroup && login !== undefined)) {
    throw new HarnessError("Usage: sign-off --range <base>..<head> [--pull-request-author <login> | --merge-group]", "sign_off_usage");
  }
  // A pull request a declared agent account opened brings agent commits only, whatever their marks say.
  const unsigned = unsignedCommits(process.cwd(), range, { agentPullRequest: login !== undefined && isAgentAccount(login), mergeGroup });
  if (unsigned.length === 0) {
    process.stdout.write(`sign-off: every commit of ${range} carries its committer's sign-off, every identity trailer is readable, and every agent commit is the project identity\n`);
  } else {
    process.stderr.write(`sign-off: ${String(unsigned.length)} refusal(s) over ${range}:\n${unsigned.map((line) => `  - ${line}`).join("\n")}\n`);
    process.exitCode = 1;
  }
}
