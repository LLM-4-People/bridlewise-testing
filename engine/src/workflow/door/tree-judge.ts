/**
 * THE TREE JUDGE — what a land may carry, judged by the door on the diff it
 * would land (github-only §3.1, §5.3 d). Push rulesets and metadata rules are
 * unavailable on a public repository on this plan, so the door is the
 * server-side choke point for each of these, and they are the same rules on
 * every pull request, an agent's or a person's:
 *
 *   - CONTENT: no added or modified blob larger than the policy's bound (raw
 *     evidence goes to the evidence store, never to git); no compiled binary
 *     or archive extension; no file whose name says it holds credentials
 *     (`isSecretFile`, the privacy owner); no text that the ONE secret
 *     catalogue (`secret-signals.ts`) recognises — only the row id is
 *     reported, never the value;
 *   - COMMITS: every commit of the pull request carries a DCO
 *     `Signed-off-by:` trailer naming its author's address (U-7). The ONE
 *     exception (coordinator ruling, 2026-10-21): a MECHANICAL merge — two
 *     parents, one a commit `main` already holds and the other one of the
 *     pull request's own commits, whose tree is exactly the clean merge of
 *     the two (GitHub's "update branch" makes one). It carries no content of
 *     its own, so there is nothing to sign; the door checks that exactly
 *     (`mechanical`, computed from git). Any other unsigned commit is
 *     refused, a merge included;
 *   - ALERTS: no open secret-scanning alert on any commit of the pull
 *     request (a push that bypassed push protection never lands, V-4).
 *
 * Pure: the door reads the diff, the commits and the alerts; this module
 * decides.
 */
import { deepFreeze } from "../../kernel/integrity.ts";
import { isSecretFile } from "../../privacy/secret-files.ts";
import { secretTextSignalIds } from "../../privacy/secret-signals.ts";

/**
 * THE CONTENT POLICY. `maxFileBytes`: the largest generated file is the test
 * inventory (3.05 MB on 2026-10-21); twice that holds its growth, and
 * anything larger is evidence for the store. The extensions are compiled
 * code and archives: a land carries sources, and a binary is reviewed by no
 * one. Archives already in the tree are frozen records (never re-landed).
 */
export const TREE_POLICY = deepFreeze({
  maxFileBytes: 6 * 1024 * 1024,
  forbiddenExtensions: [".exe", ".dll", ".so", ".dylib", ".o", ".obj", ".a", ".lib", ".jar", ".class", ".pyc", ".whl", ".zip", ".tar", ".gz", ".tgz", ".7z", ".rar", ".dmg", ".iso"],
} as const);

export type ChangedFile = Readonly<{
  path: string;
  status: "added" | "modified" | "removed" | "renamed";
  sizeBytes: number;
  /** The blob's text (UTF-8), or null for a binary blob or a removed file. */
  text: string | null;
}>;

export type CommitRecord = Readonly<{
  sha: string;
  message: string;
  authorEmail: string;
  /**
   * True only for a mechanical merge: two parents, one already on `main` and
   * the other a commit of this pull request, and a tree equal to the clean
   * merge of the two (the door computes it with git).
   */
  mechanical: boolean;
}>;

export type TreeFinding = Readonly<{
  rule: "file-size" | "file-extension" | "secret-file" | "secret-content" | "dco" | "secret-alert";
  path?: string;
  commit?: string;
  detail: string;
}>;

const SIGN_OFF = /^Signed-off-by:\s*(.+?)\s*<([^<>\s]+@[^<>\s]+)>\s*$/gmu;

/** The addresses a commit message signs off with (DCO trailers). */
export function signOffAddresses(message: string): readonly string[] {
  return [...message.matchAll(SIGN_OFF)].map((match) => match[2]!.toLowerCase());
}

export function judgeTree(files: readonly ChangedFile[], commits: readonly CommitRecord[], alertCommits: ReadonlyMap<string, readonly number[]>): readonly TreeFinding[] {
  const findings: TreeFinding[] = [];
  for (const file of files) {
    if (file.status === "removed") continue;
    const lower = file.path.toLowerCase();
    if (file.sizeBytes > TREE_POLICY.maxFileBytes) {
      findings.push({ rule: "file-size", path: file.path, detail: `${String(file.sizeBytes)} bytes, over the ${String(TREE_POLICY.maxFileBytes)}-byte bound (raw evidence goes to the evidence store)` });
    }
    const extension = TREE_POLICY.forbiddenExtensions.find((candidate) => lower.endsWith(candidate));
    if (extension !== undefined) findings.push({ rule: "file-extension", path: file.path, detail: `a ${extension} file: a land carries sources, never compiled code or an archive` });
    if (isSecretFile(file.path)) findings.push({ rule: "secret-file", path: file.path, detail: "its name says it holds credentials" });
    if (file.text !== null) {
      const ids = secretTextSignalIds(file.text, "admission");
      if (ids.length > 0) findings.push({ rule: "secret-content", path: file.path, detail: `the secret catalogue recognises: ${ids.join(", ")} (the value is never printed)` });
    }
  }
  for (const commit of commits) {
    const addresses = signOffAddresses(commit.message);
    if (addresses.length === 0) {
      if (!commit.mechanical) findings.push({ rule: "dco", commit: commit.sha, detail: "no Signed-off-by trailer (commit with -s; DCO); only a mechanical merge of a main commit and this pull request's own commit may go unsigned" });
    } else if (!addresses.includes(commit.authorEmail.toLowerCase())) {
      findings.push({ rule: "dco", commit: commit.sha, detail: `no Signed-off-by trailer names the author's address ${commit.authorEmail}` });
    }
    const alerts = alertCommits.get(commit.sha);
    if (alerts !== undefined && alerts.length > 0) findings.push({ rule: "secret-alert", commit: commit.sha, detail: `open secret-scanning alert(s) ${alerts.map((number) => `#${String(number)}`).join(", ")} on this commit` });
  }
  return deepFreeze(findings);
}
