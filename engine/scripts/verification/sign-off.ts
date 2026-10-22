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
 */
import { bootstrapProcess, isEntryPoint } from "../../src/runtime/cli-debug.ts";
import { gitText as git, messageTrailerValues, trailerValuesOf } from "./commit-trailers.ts";

/** The trailer key of a sign-off. */
export const SIGN_OFF_TRAILER = "Signed-off-by";

/** The identity GitHub commits its own merges under (the one mechanical committer). */
const GITHUB_MERGE_COMMITTER = Object.freeze({ name: "GitHub", email: "noreply@github.com" });

export type Identity = Readonly<{ name: string; email: string }>;

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
export function messageSignOffProblem(root: string, message: string, committer: Identity = committerIdentity(root)): string | null {
  const signOffs = signOffsOf(messageTrailerValues(root, message, SIGN_OFF_TRAILER));
  if (signOffs.some((signOff) => sameIdentity(signOff, committer))) return null;
  const found = signOffs.length === 0 ? "it carries none" : `it carries ${signOffs.map((signOff) => `${signOff.name} <${signOff.email}>`).join(", ")}`;
  return `the message has no "${SIGN_OFF_TRAILER}: ${committer.name} <${committer.email}>" trailer (${found}); commit with -s (a merge: git merge --signoff, or git commit -s after resolving)`;
}

/**
 * Every commit of `range` (`<base>..<head>`, as `git log` reads it) whose
 * trailers carry no sign-off by its own committer, each named; a merge GitHub
 * made itself is mechanical and passes.
 */
export function unsignedCommits(root: string, range: string): readonly string[] {
  const records = git(root, ["log", "--format=%H%x1f%P%x1f%cn%x1f%ce%x1f%(trailers:only,unfold)%x1e", range, "--"]);
  return records.split("\x1e").map((record) => record.replace(/^\n/u, "")).filter((record) => record.length > 0).flatMap((record) => {
    const [sha = "", parents = "", name = "", email = "", trailers = ""] = record.split("\x1f");
    const committer = { name, email };
    if (parents.trim().split(" ").length > 1 && sameIdentity(committer, GITHUB_MERGE_COMMITTER)) return [];
    return signOffsOf(trailerValuesOf(trailers, SIGN_OFF_TRAILER)).some((signOff) => sameIdentity(signOff, committer))
      ? []
      : [`${sha.slice(0, 12)} has no "${SIGN_OFF_TRAILER}: ${name} <${email}>" trailer`];
  });
}

if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  const [flag, range] = process.argv.slice(2);
  if (flag !== "--range" || range === undefined || !range.includes("..")) throw new Error("Usage: sign-off --range <base>..<head>");
  const unsigned = unsignedCommits(process.cwd(), range);
  if (unsigned.length === 0) {
    process.stdout.write(`sign-off: every commit of ${range} carries its committer's sign-off\n`);
  } else {
    process.stderr.write(`sign-off: ${String(unsigned.length)} commit(s) of ${range} carry no sign-off by their committer (the DCO, git commit -s):\n${unsigned.map((line) => `  - ${line}`).join("\n")}\n`);
    process.exitCode = 1;
  }
}
