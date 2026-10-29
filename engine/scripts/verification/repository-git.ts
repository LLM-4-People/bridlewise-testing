import { createHash } from "node:crypto";

import { HarnessError } from "../../src/kernel/errors.ts";
import { sha256 } from "../../src/kernel/integrity.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { strictUtf8Text } from "./candidate-format.ts";
import { runCpuBoundedSync } from "../../src/process/bounded-run-sync.ts";
import { boundedEnding } from "../../src/process/subprocess-bounds.ts";
import { subprocessBounds } from "../../src/workflow/workflow-config.ts";

/** What a probe answered: git's status (`null` when it did not exit), its output, and why it did not run to its end. */
export type RepositoryGitProbe = Readonly<{ status: number | null; stdout: Buffer; stderr: Buffer; error?: Error }>;

/**
 * Raw Git execution policy shared by publication and working-state readers:
 * the policy's executable, configuration and CLOSED environment, as one
 * bounded run (its output bounded by the policy's limit).
 */
export function probeRepositoryGit(
  root: string,
  args: readonly string[],
  options: Readonly<{ input?: Buffer; maximumOutputBytes?: number }> = {},
): RepositoryGitProbe {
  const policy = ROOT_POLICY.verification.candidateFormat.gitIdentity;
  const bounds = { ...subprocessBounds({}), outputBytes: options.maximumOutputBytes ?? policy.maximumOutputBytes };
  const run = runCpuBoundedSync(policy.executablePath, [
    ...policy.configurationOverrides.flatMap((value) => ["-c", value]), ...args,
  ], {
    cwd: root,
    env: { ...policy.processEnvironment },
    bounds,
    ...(options.input === undefined ? {} : { input: options.input }),
  });
  return run.ending === "exited"
    ? { status: run.status, stdout: run.stdout, stderr: run.stderr }
    : { status: null, stdout: run.stdout, stderr: run.stderr, error: new Error(boundedEnding(run, bounds)) };
}

function readRepositoryGit(
  root: string,
  args: readonly string[],
  options: Readonly<{ input?: Buffer; maximumOutputBytes?: number; allowedStatuses?: readonly number[] }> = {},
): Readonly<{ status: number; stdout: Buffer }> {
  const result = probeRepositoryGit(root, args, options);
  if (result.error !== undefined || result.status === null || result.stderr.length !== 0 ||
    !(options.allowedStatuses ?? [0]).includes(result.status)) {
    throw new HarnessError("Repository Git operation failed", "repository_git_failed", false, {
      operation: args[0] ?? "unknown", status: result.status ?? "unavailable",
      stderrSha256: sha256(result.stderr ?? Buffer.alloc(0)),
      stderrBytes: result.stderr?.length ?? 0,
    });
  }
  return { status: result.status, stdout: result.stdout };
}

function repositoryGitText(root: string, args: readonly string[]): string {
  const text = decodeRepositoryGit(readRepositoryGit(root, args).stdout);
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

function splitGitNul(bytes: Uint8Array): Buffer[] {
  const records: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) continue;
    records.push(Buffer.from(bytes.subarray(start, index)));
    start = index + 1;
  }
  if (start !== bytes.length) {
    throw new HarnessError("Git record is not terminated", "repository_git_framing_invalid", false);
  }
  return records;
}

function decodeRepositoryGit(bytes: Uint8Array): string {
  try { return strictUtf8Text(bytes); }
  catch { throw new HarnessError("Git text is not valid UTF-8", "repository_git_utf8_invalid", false); }
}

export type RepositoryTreeEntry = Readonly<{ path: string; mode: string; objectId: string; kind: "blob" | "commit" }>;

/** Each consumed subtree is a direct ls-tree root, so Git verifies its object signature. */
export function repositoryTreeEntries(root: string, reference = "HEAD", fullTree = false): readonly RepositoryTreeEntry[] {
  const prefix = fullTree ? "" : repositoryGitText(root, ["rev-parse", "--show-prefix"]), scope = Buffer.from(prefix);
  let observedBytes = 0, expandedBytes = 0;
  const maximumBytes = ROOT_POLICY.verification.candidateFormat.gitIdentity.maximumOutputBytes;
  const queue = [{ reference, prefix: "" }], cached = new Map<string, readonly Buffer[]>(), output: RepositoryTreeEntry[] = [];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    let records = cached.get(current.reference);
    if (records === undefined) {
      const bytes = readRepositoryGit(root, ["ls-tree", "--full-tree", "-z", current.reference]).stdout;
      observedBytes += bytes.length;
      if (observedBytes > maximumBytes) throw new HarnessError("Git traversal exceeds its bound", "repository_git_traversal_too_large", false);
      records = splitGitNul(bytes);
      cached.set(current.reference, records);
    }
    for (const raw of records) {
      expandedBytes += raw.length + Buffer.byteLength(current.prefix) + 1;
      if (expandedBytes > maximumBytes) throw new HarnessError("Git traversal exceeds its bound", "repository_git_traversal_too_large", false);
      const tab = raw.indexOf(9);
      if (tab === -1) throw new HarnessError("Invalid Git tree record", "repository_git_tree_invalid", false);
      const fullPath = Buffer.concat([Buffer.from(current.prefix), raw.subarray(tab + 1)]);
      const directoryPrefix = Buffer.concat([fullPath, Buffer.from("/")]);
      if (!fullPath.subarray(0, scope.length).equals(scope) && !scope.subarray(0, directoryPrefix.length).equals(directoryPrefix)) continue;
      const record = decodeRepositoryGit(raw), match = /^(\d+) (blob|commit|tree) ([a-f0-9]+)\t([\s\S]+)$/u.exec(record);
      if (match === null) throw new HarnessError("Invalid Git tree record", "repository_git_tree_invalid", false);
      const path = current.prefix + match[4]!;
      if (match[2] === "tree") queue.push({ reference: match[3]!, prefix: `${path}/` });
      else output.push({ path: path.slice(prefix.length), mode: match[1]!, objectId: match[3]!, kind: match[2] as "blob" | "commit" });
    }
  }
  return output.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

/** Git's regular-file projection uses the owner execute bit; full filesystem modes remain separate. */
export function fileGitMode(mode: number): "100644" | "100755" {
  return (mode & 0o100) === 0 ? "100644" : "100755";
}

export function gitBlobObjectId(bytes: Uint8Array, algorithm: "sha1" | "sha256"): string {
  return createHash(algorithm).update(`blob ${bytes.length}\0`, "utf8").update(bytes).digest("hex");
}
