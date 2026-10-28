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
 * THE IDENTITY TRAILERS are judged by KEY: every trailer whose key ends in
 * `-by`, in any case (`Signed-off-by`, `signed-off-by`, `Co-authored-by`,
 * `Reviewed-BY`, …). One that carries an address must be exactly
 * `Name <address>`: a bare address, a missing name, or text after the `>` is
 * refused, never dropped. On a human's commit one without an address
 * (`Reported-by: Bob Smith`, `Reported-by: @octocat`) passes; on an agent's
 * it still names a person and is refused. Other keys keep their own grammar
 * (`Flake-cause: … @ <commit>`, a `Link:` URL). An ADDRESS is recognised by
 * its shape (`local@label.label`, Unicode labels included) after the one
 * normalisation: NFKC (a fullwidth `＠` is one), default-ignorable code points
 * removed (a zero-width space or soft hyphen hides nothing), and the
 * ideographic full stops read as `.`; never by "any `@`". A sign-off is an identity
 * trailer whose key is `signed-off-by` in any case; one of them must be the
 * committer's.
 *
 * AN AGENT COMMIT IS THE PROJECT'S IDENTITY THROUGHOUT: its author, its
 * committer and EVERY identity trailer are the declared agent identity
 * (`ROOT_POLICY.workflow.commitIdentity.agent`, the one source). A commit is an
 * agent's when any identity on it is the agent identity or uses its address's
 * domain, when it is made in a checkout the harness made for an agent (the
 * `agentCheckoutKey` git config the workspace and candidate writers set beside
 * the agent identity, read by the hook), or when the pull request bringing it
 * was opened by a declared agent account (`agentAccounts`; the workflow passes
 * the pull request's author). A human outside contributor's commit carries none of
 * those marks and keeps the ordinary DCO. On an agent commit the WHOLE
 * message (subject, body, every trailer, every comment line — the hook judges
 * the message file as written, since `--cleanup=verbatim` records all of it),
 * normalised, names no address but the agent's:
 * a body-paragraph `Signed-off-by`, a `Signed off by:` spelled with spaces, a
 * `Cc:` or a bare address in the subject are refused like a trailer.
 *
 * NO REFUSAL ECHOES A PERSON. A refusal is printed into a public log (an
 * Actions run, a terminal recorded by a tool), so it names the role and the
 * trailer key, and an address only as `<redacted t>`, a token keyed by this
 * run's random, never-printed key: two addresses are told apart, and nothing
 * else is said (not even the domain, which can be a name). The agent identity
 * is the project's and is named.
 *
 * NO NAME IS AN EXEMPTION. A committer name and address are anyone's to set,
 * so no commit passes because of who it says committed it. The one commit a
 * contributor cannot make is the merge queue's own. In a merge group
 * (`--merge-group <ref> --remote <url>`), the judge first VERIFIES the group:
 * `<ref>` is a `refs/heads/gh-readonly-queue/` ref (a namespace only GitHub's
 * queue writes) and the remote holds it at the range's head. What is trusted,
 * exactly: GitHub's own ref namespace and the event's ref name; the
 * first-parent chain from that head to the base is the queue's merges, each
 * of which must BE a merge and is not judged, while every commit they bring
 * in is.
 */
import { createHmac, randomBytes } from "node:crypto";

import { HarnessError, InputError } from "../../src/kernel/errors.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { bootstrapProcess, isEntryPoint } from "../../src/runtime/cli-debug.ts";
import { gitText as git, messageTrailers } from "./commit-trailers.ts";

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

/**
 * THE ONE NORMALISATION every judged text goes through: NFKC (a fullwidth `＠`
 * is an `@`), every default-ignorable code point removed (a zero-width space or
 * a soft hyphen beside the `@` hides nothing), and the ideographic full stops
 * (U+3002, U+FF61) read as `.`.
 */
function normalised(text: string): string {
  return text.normalize("NFKC").replace(/\p{Default_Ignorable_Code_Point}/gu, "").replace(/[\u3002\uFF61]/gu, ".");
}

/** `Name <address>` and nothing else, as a sign-off or an ident spells it (normalised); `null` when the text is not exactly one. */
function parseIdentity(text: string): Identity | null {
  const match = /^([^<>@]*[^<>@\s])\s*<([^<>\s@]+@[^<>\s@]+)>$/u.exec(normalised(text).trim());
  return match === null ? null : { name: match[1]!.trim(), email: match[2]! };
}

/** An ident as `git var` prints it: `Name <address> <time> <zone>`. */
function parseIdent(text: string): Identity | null {
  return parseIdentity(text.trim().replace(/\s+\d+\s+[+-]\d{4}$/u, ""));
}

function sameIdentity(left: Identity, right: Identity): boolean {
  return left.name === right.name && left.email.toLowerCase() === right.email.toLowerCase();
}

/** An address by its shape, Unicode labels included (an IDN): `local@label.label`. */
const ADDRESS = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;

/** The addresses `text` names, after the one normalisation, lower-cased. */
export function addressesIn(text: string): readonly string[] {
  return [...normalised(text).matchAll(ADDRESS)].map((match) => match[0].toLowerCase());
}

/**
 * The key of this process's redaction tokens: random, never stored, never
 * printed. A token tells two addresses apart within one run's log and says
 * nothing else: not the address, not its domain (a vanity domain is a name),
 * and no dictionary can test a guess against it.
 */
const REDACTION_KEY = randomBytes(32);

/** An address as a refusal may print it: the agent's in full; anyone else's only as this run's keyed token. */
function redacted(address: string): string {
  if (address.toLowerCase() === AGENT_IDENTITY.email.toLowerCase()) return address;
  return `<redacted ${createHmac("sha256", REDACTION_KEY).update(address.toLowerCase()).digest("hex").slice(0, 12)}>`;
}

/** An identity as a refusal may print it: the agent's in full; anyone else's never — only a token of their address. */
function shown(identity: Identity): string {
  return sameIdentity(identity, AGENT_IDENTITY) ? `${identity.name} <${identity.email}>` : redacted(identity.email);
}

const AGENT_SPELLED = `${AGENT_IDENTITY.name} <${AGENT_IDENTITY.email}>`;

/** Does `trailer` name a person (its key ends in `-by`, in any case)? */
function isIdentityTrailer(trailer: Trailer): boolean {
  return /-by$/iu.test(trailer.key);
}

/** The commit a judgement reads: its two idents and every trailer of its message. */
export type JudgedCommit = Readonly<{ author: Identity; committer: Identity; trailers: readonly Trailer[]; message: string }>;

/**
 * THE judge: the refusals of one commit, each named. `agentMarked` says the
 * context made it an agent's whatever its identities say (a declared agent
 * account's pull request; a harness-made agent checkout).
 */
export function commitRecordProblems(commit: JudgedCommit, agentMarked = false): readonly string[] {
  const named = commit.trailers.filter(isIdentityTrailer).map((trailer) => ({ trailer, identity: parseIdentity(trailer.value) }));
  const unreadable = named.filter((entry) => entry.identity === null && addressesIn(entry.trailer.value).length > 0)
    .map(({ trailer }) => `its "${trailer.key}" trailer carries an address but is not exactly one "Name <address>"`);
  const people = named.flatMap((entry) => entry.identity === null ? [] : [{ role: `${entry.trailer.key} trailer`, identity: entry.identity }]);
  const signOffs = named.flatMap((entry) => entry.identity !== null && entry.trailer.key.toLowerCase() === SIGN_OFF_TRAILER.toLowerCase() ? [entry.identity] : []);
  const dco = signOffs.some((signOff) => sameIdentity(signOff, commit.committer)) ? [] :
    [`it has no "${SIGN_OFF_TRAILER}" trailer naming its committer ${shown(commit.committer)} (${signOffs.length === 0 ? "it carries none" : `it carries ${signOffs.map(shown).join(", ")}`}); commit with -s (a merge: git merge --signoff, or git commit -s after resolving)`];
  const identities = [{ role: "author", identity: commit.author }, { role: "committer", identity: commit.committer }, ...people];
  const agent = agentMarked || identities.some(({ identity }) => sameIdentity(identity, AGENT_IDENTITY) || domainOf(identity.email) === domainOf(AGENT_IDENTITY.email));
  if (!agent) return [...unreadable, ...dco];
  const agentProblems = identities.filter(({ identity }) => !sameIdentity(identity, AGENT_IDENTITY))
    .map(({ role, identity }) => `it is an agent commit and its ${role} is ${shown(identity)}, not the project's agent identity ${AGENT_SPELLED}`);
  // A -by trailer with no address still names a person (`Co-authored-by: A Name`): on an agent commit, refused.
  const nameOnly = named.filter((entry) => entry.identity === null && addressesIn(entry.trailer.value).length === 0)
    .map(({ trailer }) => `it is an agent commit and its "${trailer.key}" trailer names someone other than the project's agent identity ${AGENT_SPELLED}`);
  // The whole recorded message, normalised: an address anywhere in it that is not the agent's.
  const foreign = [...new Set(addressesIn(commit.message).filter((address) => address !== AGENT_IDENTITY.email.toLowerCase()))]
    .map((address) => `it is an agent commit and its message names ${redacted(address)}, an address that is not the project's agent identity's`);
  return [...unreadable, ...dco, ...agentProblems, ...nameOnly, ...foreign];
}

/** Is `root` a checkout the harness made for an agent (its {@link AGENT_CHECKOUT_KEY} is true, read as the hook's git reads it)? */
export function isAgentCheckout(root: string): boolean {
  const answer = git(root, ["config", "--type=bool", "--default=false", "--get", AGENT_CHECKOUT_KEY]).trim();
  return answer === "true";
}

/** The ident git will record for a commit made at `root` now (`GIT_AUTHOR_IDENT` or `GIT_COMMITTER_IDENT`). */
function pendingIdent(root: string, variable: "GIT_AUTHOR_IDENT" | "GIT_COMMITTER_IDENT"): Identity {
  // git resolves a commit's identities before it runs its hooks; a hook run without one (invoked by hand) is
  // refused by name and type, never with git's raw failure.
  let ident: string;
  try {
    ident = git(root, ["var", variable]);
  } catch {
    throw new InputError(`git names no ${variable === "GIT_AUTHOR_IDENT" ? "author" : "committer"} here (git var ${variable}): set user.name and user.email, or run this as git's own hook`, "commit_identity_unreadable");
  }
  const identity = parseIdent(ident);
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
  // The whole message file, as written: under --cleanup=verbatim every line of it is recorded, so nothing is exempt.
  const problems = commitRecordProblems({ ...idents, trailers: messageTrailers(root, message), message }, agentCheckout);
  if (problems.length === 0) return null;
  const repair = agentCheckout ? ` (this checkout is an agent's: its ${AGENT_CHECKOUT_KEY} is set, so user.name and user.email are ${AGENT_SPELLED})` : "";
  return `${problems.join("; ")}${repair}`;
}

/**
 * How a range is read: a pull request's (every commit judged), or a merge
 * group's, verified first: `mergeGroup.ref` is a GitHub queue ref and
 * `mergeGroup.remote` holds it at the range's head.
 */
export type RangeContext = Readonly<{ agentPullRequest?: boolean; mergeGroup?: Readonly<{ ref: string; remote: string }> }>;

/** GitHub's merge-queue namespace: refs only the queue writes. */
const MERGE_QUEUE_REF_PREFIX = "refs/heads/gh-readonly-queue/";

/** The head commit a merge group's ref names on its remote, or a refusal that says why it is not the queue's. */
function verifiedMergeGroupHead(root: string, group: Readonly<{ ref: string; remote: string }>, head: string): string | null {
  if (!group.ref.startsWith(MERGE_QUEUE_REF_PREFIX)) return `the merge group's ref ${group.ref} is not in GitHub's queue namespace ${MERGE_QUEUE_REF_PREFIX}`;
  const listed = git(root, ["ls-remote", "--", group.remote, group.ref]).trim().split("\n").filter((line) => line.length > 0);
  const tip = listed.length === 1 ? listed[0]!.split("\t")[0] : undefined;
  const expected = git(root, ["rev-parse", "--verify", `${head}^{commit}`]).trim();
  return tip === expected ? null : `the remote does not hold the merge group's ref ${group.ref} at ${expected.slice(0, 12)} (it answers ${tip ?? "nothing"})`;
}

/** Every commit of `range` (`<base>..<head>`) whose records are wrong, each named with its refusals. */
export function unsignedCommits(root: string, range: string, context: RangeContext = {}): readonly string[] {
  const [base, head] = range.split("..");
  if (base === undefined || head === undefined || base.length === 0 || head.length === 0) throw new InputError(`a range is <base>..<head>, not ${range}`, "sign_off_range_invalid");
  const queue = new Set<string>();
  const problems: string[] = [];
  if (context.mergeGroup !== undefined) {
    const unverified = verifiedMergeGroupHead(root, context.mergeGroup, head);
    if (unverified !== null) return [`${head.slice(0, 12)}: ${unverified}: no commit of it is taken for the queue's`];
    for (const line of git(root, ["rev-list", "--first-parent", "--parents", range, "--"]).split("\n").filter((entry) => entry.length > 0)) {
      const [sha = "", ...parents] = line.split(" ");
      if (parents.length !== 2) problems.push(`${sha.slice(0, 12)} is on the merge group's first-parent chain but is not a merge: the queue makes only merges, so this commit is not the queue's`);
      else queue.add(sha);
    }
  }
  // One commit at a time, its fields separated by NUL — the one byte no commit message or ident can hold —
  // and its message last, read whole: no byte a message carries can end a field or a record early.
  for (const sha of git(root, ["rev-list", range, "--"]).split("\n").filter((line) => line.length > 0)) {
    if (queue.has(sha)) continue;
    const [authorName = "", authorEmail = "", name = "", email = "", ...rest] = git(root, ["log", "-1", "--format=%an%x00%ae%x00%cn%x00%ce%x00%B", sha, "--"]).split("\0");
    const message = rest.join("\0");
    const judged = commitRecordProblems({ author: { name: authorName, email: authorEmail }, committer: { name, email }, trailers: messageTrailers(root, message), message }, context.agentPullRequest === true);
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
  const groupRef = valueOf("--merge-group");
  const remote = valueOf("--remote");
  if (range === undefined || (argv.includes("--pull-request-author") && login === undefined) || (groupRef === undefined) !== (remote === undefined) || (groupRef !== undefined && login !== undefined)) {
    throw new HarnessError("Usage: sign-off --range <base>..<head> [--pull-request-author <login> | --merge-group <queue ref> --remote <url>]", "sign_off_usage");
  }
  // A pull request a declared agent account opened brings agent commits only, whatever their marks say.
  const unsigned = unsignedCommits(process.cwd(), range, {
    agentPullRequest: login !== undefined && isAgentAccount(login),
    ...(groupRef === undefined || remote === undefined ? {} : { mergeGroup: { ref: groupRef, remote } }),
  });
  if (unsigned.length === 0) {
    process.stdout.write(`sign-off: every commit of ${range} carries its committer's sign-off, every identity trailer is readable, and every agent commit is the project identity\n`);
  } else {
    process.stderr.write(`sign-off: ${String(unsigned.length)} refusal(s) over ${range}:\n${unsigned.map((line) => `  - ${line}`).join("\n")}\n`);
    process.exitCode = 1;
  }
}
