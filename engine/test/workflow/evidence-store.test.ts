/**
 * THE EVIDENCE STORE, DRIVEN (`src/workflow/evidence-store.ts`) — planted
 * repositories and private stores, through the functions the
 * `harness evidence` verbs call, the verbs themselves and the exposed action:
 *
 *   - ingest stores every regular file a path names (a folder: everything
 *     under it) as the immutable owner's content-addressed objects — 0600 in
 *     0700 folders, one object per distinct payload — and records each path,
 *     sha256, size and git mode in a sorted, one-entry-per-line manifest; it
 *     is idempotent, REFUSES other bytes for a recorded path, and writes the
 *     generated ignore rule;
 *   - verify proves every recorded object present, private and byte-exact,
 *     and names each missing, corrupt or unsafe one (a link anywhere in the
 *     store is refused, never followed);
 *   - materialize writes recorded files (or a folder of them) back at their
 *     paths with their modes, leaves an identical file alone, and refuses an
 *     unrecorded path, a missing object, a different file at the path and a
 *     stale ignore rule — writing nothing;
 *   - CONTAINMENT (security review E1-E3, correctness N1): a manifest entry
 *     outside its manifest's evidence folder, inside `.git` or the hooks, or
 *     escaping is refused when the manifest is READ; a linked parent is
 *     refused for materialize and ingest, nothing is written or read outside;
 *     the exposed action inherits every refusal;
 *   - the store is the one private-home owner's: refused overlapping the
 *     repository or the system temp folder, as a link and open to others;
 *     located by the operator's variable or the data home; refused under test
 *     without the variable (N5); and kept out of every confined process
 *     wherever it is (E4).
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { tryAcquireFileLock } from "../../src/filesystem/file-lock.ts";
import { createOwnedTemporaryDirectory } from "../../src/filesystem/private-state.ts";
import { floorKeepOutVerdict } from "../../src/filesystem/self-protection/keep-out.ts";
import { sha256 } from "../../src/kernel/integrity.ts";
import { statePath } from "../../src/kernel/product-identity.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { executeAction } from "../../src/shared/exposure/index.ts";
import { installWorkspaceGitStateSource, registerWorkspaceGitExposure } from "../../src/shared/exposure/registrations/workspace-git.ts";
import {
  admitEvidenceStore,
  EVIDENCE_MANIFEST_SCHEMA,
  evidenceManifests,
  evidenceManifestText,
  evidenceStoreLocation,
  evidenceStoreSetting,
  ingestEvidence,
  materializeEvidence,
  parseEvidenceManifest,
  recordedEvidence,
  syncEvidenceIgnore,
  verifyEvidence,
} from "../../src/workflow/evidence-store.ts";
import { harnessEvidence } from "../../src/workflow/harness-commands.ts";
import { armTestKeyHome } from "../support/test-key-home.ts";
import { createTempDir } from "../support/temp-dir.ts";

const POLICY = ROOT_POLICY.workflow.evidenceStore;
const MANIFEST = `docs/run/${POLICY.manifestName}`;
const FOLDER = `docs/run/${POLICY.folderName}`;

function git(root: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-c", "user.name=Evidence Test", "-c", "user.email=evidence@example.invalid", ...args], { cwd: root, encoding: "utf8" });
}

function write(root: string, path: string, content: string, mode?: number): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
  if (mode !== undefined) chmodSync(join(root, path), mode);
}

/** A private store location for one test: outside the system temp folder (the store must be disjoint from it), removed with the run's private home. */
function privateStoreLocation(): string {
  return join(createOwnedTemporaryDirectory(armTestKeyHome(), "evidence-"), "store");
}

/** A repository with a committed README and ignore file and an uncommitted evidence folder: two equal payloads, one executable, one nested. */
function planted(): Readonly<{ root: string; location: string }> {
  const root = realpathSync(createTempDir("evidence-repo-"));
  git(root, "init", "-q");
  write(root, "README.md", "# planted\n");
  write(root, ".gitignore", "/node_modules/\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  write(root, `${FOLDER}/raw/run.log.txt`, "run 1\n");
  write(root, `${FOLDER}/raw/copy.log.txt`, "run 1\n");
  write(root, `${FOLDER}/raw/nested/probe.sh.txt`, "#!/bin/sh\necho probe\n", 0o755);
  write(root, `${FOLDER}/raw/receipt.json`, "{\"ok\":true}\n");
  return { root, location: privateStoreLocation() };
}

/** Ingest the planted folder and track the manifest. */
function ingested(): Readonly<{ root: string; location: string; store: ReturnType<typeof admitEvidenceStore> }> {
  const { root, location } = planted();
  const store = admitEvidenceStore(location, root);
  ingestEvidence(root, [`${FOLDER}/raw`], MANIFEST, store);
  git(root, "add", "--", MANIFEST, ".gitignore");
  return { root, location, store };
}

/** Where the immutable owner keeps the object of `digest` in an admitted store. */
function objectOf(location: string, digest: string): string {
  return join(location, POLICY.objects.root, POLICY.objects.namespace, "sha256", `${digest}${POLICY.objects.extension}`);
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code ?? `untyped: ${(error as Error).message}`;
  }
  return "(no refusal)";
}

async function asyncCodeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return (error as { code?: string }).code ?? `untyped: ${(error as Error).message}`;
  }
  return "(no refusal)";
}

const modeOf = (path: string): number => statSync(path).mode & 0o777;

/** A manifest document recording `entries` (each `{path, sha256, size, mode}`), written and tracked at `MANIFEST`. */
function forgeManifest(root: string, entries: readonly Readonly<Record<string, unknown>>[]): void {
  write(root, MANIFEST, `${JSON.stringify({ schema: EVIDENCE_MANIFEST_SCHEMA, entries })}\n`);
  git(root, "add", "--", MANIFEST);
}

test("ingest stores each payload once through the immutable owner, privately, and records path, digest, size and git mode in a sorted manifest", () => {
  const { root, location } = planted();
  const store = admitEvidenceStore(location, root);
  const report = ingestEvidence(root, [`${FOLDER}/raw`], MANIFEST, store);
  assert.deepEqual({ files: report.files, written: report.written, present: report.present, recorded: report.recorded }, { files: 4, written: 3, present: 1, recorded: 4 }, "the two equal payloads are one object");
  const manifest = parseEvidenceManifest(readFileSync(join(root, MANIFEST), "utf8"), MANIFEST);
  assert.equal(manifest.schema, EVIDENCE_MANIFEST_SCHEMA);
  assert.deepEqual(manifest.entries.map((entry) => entry.path), [
    `${FOLDER}/raw/copy.log.txt`, `${FOLDER}/raw/nested/probe.sh.txt`, `${FOLDER}/raw/receipt.json`, `${FOLDER}/raw/run.log.txt`,
  ]);
  const probe = manifest.entries.find((entry) => entry.path.endsWith("probe.sh.txt"))!;
  assert.deepEqual(probe, { path: `${FOLDER}/raw/nested/probe.sh.txt`, sha256: sha256("#!/bin/sh\necho probe\n"), size: Buffer.byteLength("#!/bin/sh\necho probe\n"), mode: "0755" });
  assert.equal(manifest.entries.find((entry) => entry.path.endsWith("receipt.json"))!.mode, "0644", "the umask never reaches the manifest");
  const object = objectOf(store.location, probe.sha256);
  assert.equal(readFileSync(object, "utf8"), "#!/bin/sh\necho probe\n");
  assert.equal(modeOf(object), 0o600);
  assert.equal(modeOf(dirname(object)), 0o700);
  assert.equal(modeOf(store.location), 0o700);
  const text = readFileSync(join(root, MANIFEST), "utf8");
  assert.equal(text, evidenceManifestText(manifest.entries), "the one layout");
  assert.equal(text.split("\n").filter((line) => line.includes("\"path\"")).length, 4, "one entry per line");
  assert.match(readFileSync(join(root, ".gitignore"), "utf8"), new RegExp(`${POLICY.ignoreBlock.begin.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\n/${FOLDER}/\\n${POLICY.ignoreBlock.end}`, "u"), "ingest writes the generated ignore rule");

  const again = ingestEvidence(root, [`${FOLDER}/raw`], MANIFEST, store);
  assert.deepEqual({ written: again.written, present: again.present, recorded: again.recorded }, { written: 0, present: 4, recorded: 0 }, "idempotent");
  assert.equal(readFileSync(join(root, MANIFEST), "utf8"), text, "an idempotent ingest leaves the manifest as it was");
});

test("ingest refuses other bytes for a recorded path, naming both digests, and stores nothing", () => {
  const { root, store } = ingested();
  const before = readFileSync(join(root, MANIFEST), "utf8");
  write(root, `${FOLDER}/raw/receipt.json`, "{\"ok\":false}\n");
  write(root, `${FOLDER}/raw/zz-new.txt`, "new\n");
  let message = "";
  try {
    ingestEvidence(root, [`${FOLDER}/raw`], MANIFEST, store);
  } catch (error) {
    assert.equal((error as { code?: string }).code, "evidence_replace_refused");
    message = (error as Error).message;
  }
  assert.ok(message.includes(sha256("{\"ok\":true}\n")) && message.includes(sha256("{\"ok\":false}\n")), `both digests named: ${message}`);
  assert.equal(readFileSync(join(root, MANIFEST), "utf8"), before, "the manifest is unchanged");
  assert.equal(existsSync(objectOf(store.location, sha256("new\n"))), false, "a refused ingest stores nothing, not even the files it could have");
});

test("verify proves every recorded object present, private and byte-exact, and names each missing, corrupt or unsafe one", () => {
  const { root, store } = ingested();
  assert.deepEqual(evidenceManifests(root), [MANIFEST], "a manifest is found where git tracks one");
  const clean = verifyEvidence(root, undefined, store);
  assert.deepEqual({ entries: clean.entries, bytes: clean.bytes, allPresent: clean.allPresent }, { entries: 4, bytes: 6 + 6 + 21 + 12, allPresent: true });

  const entries = recordedEvidence(root);
  rmSync(objectOf(store.location, entries.get(`${FOLDER}/raw/receipt.json`)!.sha256));
  const probe = objectOf(store.location, entries.get(`${FOLDER}/raw/nested/probe.sh.txt`)!.sha256);
  chmodSync(probe, 0o600);
  writeFileSync(probe, "#!/bin/sh\necho other\n");
  chmodSync(objectOf(store.location, entries.get(`${FOLDER}/raw/run.log.txt`)!.sha256), 0o644);
  const broken = verifyEvidence(root, [MANIFEST], store);
  assert.equal(broken.allPresent, false);
  assert.deepEqual(broken.missing, [`${FOLDER}/raw/receipt.json`]);
  assert.deepEqual(broken.corrupt, [`${FOLDER}/raw/nested/probe.sh.txt`]);
  assert.deepEqual(broken.unsafe, [`${FOLDER}/raw/copy.log.txt`, `${FOLDER}/raw/run.log.txt`], "both paths share the widened object");
});

test("a link anywhere inside the store is refused, never followed (security review E3)", () => {
  const { root, store } = ingested();
  const objects = dirname(objectOf(store.location, sha256("run 1\n")));
  const elsewhere = join(dirname(store.location), "elsewhere");
  // The object folder becomes a link to a copy of itself: same bytes, but reached through a link.
  execFileSync("cp", ["-a", objects, elsewhere]);
  rmSync(objects, { recursive: true });
  symlinkSync(elsewhere, objects);
  const report = verifyEvidence(root, [MANIFEST], store);
  assert.equal(report.allPresent, false);
  assert.equal(report.unsafe.length, 4, "every object behind the linked folder is refused");
  assert.equal(codeOf(() => ingestEvidence(root, [`${FOLDER}/raw/receipt.json`], MANIFEST, store)), "receipt_parent_symlink", "no object is written through it either");
});

test("materialize writes recorded files back with their modes, leaves an identical file alone, and refuses before writing anything", () => {
  const { root, store } = ingested();
  rmSync(join(root, `${FOLDER}/raw`), { recursive: true });

  assert.equal(codeOf(() => materializeEvidence(root, [`${FOLDER}/raw/absent.txt`], store)), "evidence_not_recorded");
  assert.equal(codeOf(() => materializeEvidence(root, ["../outside"], store)), "evidence_path_invalid");
  const one = materializeEvidence(root, [`${FOLDER}/raw/nested/probe.sh.txt`], store);
  assert.deepEqual(one.written, [`${FOLDER}/raw/nested/probe.sh.txt`]);
  assert.equal(modeOf(join(root, `${FOLDER}/raw/nested/probe.sh.txt`)), 0o755, "the recorded mode");
  const folder = materializeEvidence(root, [`${FOLDER}/raw`], store);
  assert.deepEqual(folder.unchanged, [`${FOLDER}/raw/nested/probe.sh.txt`]);
  assert.deepEqual(folder.written, [`${FOLDER}/raw/copy.log.txt`, `${FOLDER}/raw/receipt.json`, `${FOLDER}/raw/run.log.txt`]);
  assert.equal(readFileSync(join(root, `${FOLDER}/raw/receipt.json`), "utf8"), "{\"ok\":true}\n");
  assert.equal(modeOf(join(root, `${FOLDER}/raw/receipt.json`)), 0o644);
  assert.equal(git(root, "status", "--porcelain", "--untracked-files=all", "--", FOLDER), "", "git ignores every materialized copy");

  writeFileSync(join(root, `${FOLDER}/raw/run.log.txt`), "someone's edit\n");
  rmSync(join(root, `${FOLDER}/raw/receipt.json`));
  assert.equal(codeOf(() => materializeEvidence(root, [`${FOLDER}/raw`], store)), "evidence_materialize_conflict");
  assert.equal(existsSync(join(root, `${FOLDER}/raw/receipt.json`)), false, "a refused materialize writes nothing");
  assert.equal(readFileSync(join(root, `${FOLDER}/raw/run.log.txt`), "utf8"), "someone's edit\n", "a different file is never overwritten");
  rmSync(join(root, `${FOLDER}/raw/run.log.txt`));
  rmSync(objectOf(store.location, recordedEvidence(root).get(`${FOLDER}/raw/receipt.json`)!.sha256));
  assert.equal(codeOf(() => materializeEvidence(root, [`${FOLDER}/raw`], store)), "evidence_object_missing");
  assert.equal(existsSync(join(root, `${FOLDER}/raw/run.log.txt`)), false, "a missing object writes nothing");
});

test("the ignore rule is generated from the manifests: harness check's arm reports it stale, materialize refuses while it is, a write makes it current", () => {
  const { root, store } = ingested();
  assert.equal(syncEvidenceIgnore(root, false).status, "current");
  write(root, ".gitignore", "/node_modules/\n");
  assert.deepEqual(syncEvidenceIgnore(root, false).changed, [".gitignore"], "a hand edit that dropped the rule is stale");
  rmSync(join(root, `${FOLDER}/raw/receipt.json`));
  assert.equal(codeOf(() => materializeEvidence(root, [`${FOLDER}/raw/receipt.json`], store)), "evidence_ignore_stale");
  assert.equal(existsSync(join(root, `${FOLDER}/raw/receipt.json`)), false, "nothing is written while the copy would not be ignored");
  assert.equal(syncEvidenceIgnore(root, true).status, "regenerated");
  assert.equal(syncEvidenceIgnore(root, false).status, "current");
  assert.ok(readFileSync(join(root, ".gitignore"), "utf8").startsWith("/node_modules/\n"), "the rest of the file is the author's");
  assert.deepEqual(materializeEvidence(root, [`${FOLDER}/raw/receipt.json`], store).written, [`${FOLDER}/raw/receipt.json`]);
});

test("an ingest STAGES the manifest it wrote (that one path): check and sync never drop its folder's ignore rule, and no raw file becomes committable (correctness E1)", () => {
  const { root, location } = planted();
  const store = admitEvidenceStore(location, root);
  ingestEvidence(root, [`${FOLDER}/raw`], MANIFEST, store);
  assert.equal(git(root, "ls-files", "--", MANIFEST).trim(), MANIFEST, "the manifest is staged");
  assert.equal(git(root, "diff", "--cached", "--name-only").trim(), MANIFEST, "and nothing else was staged");
  assert.equal(syncEvidenceIgnore(root, false).status, "current", "check: the rule stands");
  assert.equal(syncEvidenceIgnore(root, true).status, "current", "sync: nothing to rewrite, nothing dropped");
  assert.equal(git(root, "status", "--porcelain", "--untracked-files=all", "--", `${FOLDER}/raw`), "", "no raw evidence file shows as committable");
});

test("THE INGEST STAGES ITS MANIFEST LITERALLY (security H-2): a manifest spelled as pathspec magic is refused before anything is staged, and a manifest whose path holds a glob character stages that one path, never a tracked file the glob would match", () => {
  const { root, location } = planted();
  const store = admitEvidenceStore(location, root);
  write(root, `docs/:!e/${POLICY.folderName}/raw/one.txt`, "one\n");
  assert.equal(codeOf(() => ingestEvidence(root, [`docs/:!e/${POLICY.folderName}/raw`], `:!e/${POLICY.manifestName}`, store)), "evidence_path_invalid", "a leading ':' is refused");
  assert.equal(git(root, "diff", "--cached", "--name-only").trim(), "", "nothing was staged");
  // A tracked manifest the glob would match, changed in the working tree and NOT for this ingest to stage.
  const decoy = `docs/rXn/${POLICY.manifestName}`;
  write(root, decoy, evidenceManifestText([]));
  git(root, "add", "--", decoy);
  git(root, "commit", "-q", "-m", "a decoy manifest");
  write(root, decoy, `${evidenceManifestText([])}\n`);
  const globbed = `docs/r*n/${POLICY.manifestName}`;
  write(root, `docs/r*n/${POLICY.folderName}/raw/two.txt`, "two\n");
  ingestEvidence(root, [`docs/r*n/${POLICY.folderName}/raw`], globbed, store);
  assert.equal(git(root, "diff", "--cached", "--name-only").trim(), globbed, "only the manifest this ingest wrote is staged");
});

test("ONLY A TRACKED MANIFEST STEERS: an untracked file named like a manifest is refused by name, never turned into an ignore rule (security re-verification LOW)", () => {
  const { root } = planted();
  const planted_ = `docs/elsewhere/${POLICY.manifestName}`;
  mkdirSync(join(root, "docs", "elsewhere"), { recursive: true });
  writeFileSync(join(root, planted_), evidenceManifestText([]));
  assert.throws(() => evidenceManifests(root), (error: unknown) => (error as { code?: string }).code === "evidence_manifest_untracked" && (error as Error).message.includes(planted_));
  assert.throws(() => syncEvidenceIgnore(root, true), (error: unknown) => (error as { code?: string }).code === "evidence_manifest_untracked", "sync refuses to derive a rule from it");
});

test("ingests are serialized by the checkout's one ingest lock: an ingest waits while another holds it, then records its entries (correctness E3)", async () => {
  const { root, location } = planted();
  const held = tryAcquireFileLock(join(root, statePath("evidence-ingest.lock")), { holder: "a planted ingest" });
  assert.equal(held.state, "taken");
  const owner = pathToFileURL(fileURLToPath(new URL("../../src/workflow/evidence-store.ts", import.meta.url))).href;
  const script = `const m = await import(${JSON.stringify(owner)}); m.ingestEvidence(process.argv[1], [process.argv[2]], process.argv[3], m.admitEvidenceStore(process.argv[4], process.argv[1])); console.log("ingested");`;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, root, `${FOLDER}/raw/run.log.txt`, MANIFEST, location], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
  const ended = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal(existsSync(join(root, MANIFEST)), false, "the second ingest waits: it has not read or written the manifest");
  if (held.state === "taken") held.handle.release();
  assert.equal(await ended, 0, out);
  assert.match(out, /ingested/u);
  assert.deepEqual(parseEvidenceManifest(readFileSync(join(root, MANIFEST), "utf8"), MANIFEST).entries.map((entry) => entry.path), [`${FOLDER}/raw/run.log.txt`]);
});

test("a manifest entry outside its evidence folder, in .git or the hooks, or escaping is refused when the manifest is read (security review E1)", () => {
  const entry = (path: string): Readonly<Record<string, unknown>> => ({ path, sha256: sha256(path), size: 1, mode: "0644" });
  const text = (entries: readonly unknown[]): string => JSON.stringify({ schema: EVIDENCE_MANIFEST_SCHEMA, entries });
  assert.equal(parseEvidenceManifest(text([entry(`${FOLDER}/a`), entry(`${FOLDER}/b`)]), MANIFEST).entries.length, 2);
  assert.equal(codeOf(() => parseEvidenceManifest(text([entry(".git/hooks/pre-commit")]), MANIFEST)), "evidence_manifest_invalid", "git's own folder");
  assert.equal(codeOf(() => parseEvidenceManifest(text([entry(`${FOLDER}/.GIT/config`)]), MANIFEST)), "evidence_manifest_invalid", "any case");
  assert.equal(codeOf(() => parseEvidenceManifest(text([entry(`${FOLDER}/.githooks/post-checkout`)]), MANIFEST)), "evidence_manifest_invalid", "the shipped hooks' folder");
  assert.equal(codeOf(() => parseEvidenceManifest(text([entry("docs/other/x.txt")]), MANIFEST)), "evidence_entry_outside_manifest", "another folder of the tree");
  assert.equal(codeOf(() => parseEvidenceManifest(text([entry("docs/run/evidence-x/a")]), MANIFEST)), "evidence_entry_outside_manifest", "a sibling that only starts like the folder");
  assert.equal(codeOf(() => parseEvidenceManifest(text([entry(`${FOLDER}/../escape`)]), MANIFEST)), "evidence_manifest_invalid", "a dot segment");
  assert.equal(codeOf(() => parseEvidenceManifest(text([entry(`/${FOLDER}/abs`)]), MANIFEST)), "evidence_manifest_invalid", "absolute");
  assert.equal(codeOf(() => parseEvidenceManifest(text([entry(`${FOLDER}/b`), entry(`${FOLDER}/a`)]), MANIFEST)), "evidence_manifest_invalid", "unsorted");
  assert.equal(codeOf(() => parseEvidenceManifest(text([entry(`${FOLDER}/a`), entry(`${FOLDER}/a`)]), MANIFEST)), "evidence_manifest_invalid", "a duplicate");
  assert.equal(codeOf(() => parseEvidenceManifest(text([{ ...entry(`${FOLDER}/a`), mode: "0600" }]), MANIFEST)), "evidence_manifest_invalid");
  assert.equal(codeOf(() => parseEvidenceManifest("{", MANIFEST)), "evidence_manifest_invalid");

  // The repro of the review, end to end: a forged entry naming a hook, with a payload the store holds.
  const { root, store } = ingested();
  const payload = recordedEvidence(root).get(`${FOLDER}/raw/nested/probe.sh.txt`)!;
  forgeManifest(root, [{ path: ".git/hooks/pre-commit", sha256: payload.sha256, size: payload.size, mode: "0755" }]);
  assert.equal(codeOf(() => materializeEvidence(root, [".git/hooks/pre-commit"], store)), "evidence_manifest_invalid");
  forgeManifest(root, [{ path: `${FOLDER}/.githooks/post-checkout`, sha256: payload.sha256, size: payload.size, mode: "0755" }]);
  assert.equal(codeOf(() => materializeEvidence(root, [FOLDER], store)), "evidence_manifest_invalid");
  forgeManifest(root, [{ path: "scripts/planted.sh", sha256: payload.sha256, size: payload.size, mode: "0755" }]);
  assert.equal(codeOf(() => materializeEvidence(root, ["scripts"], store)), "evidence_entry_outside_manifest");
  assert.equal(codeOf(() => verifyEvidence(root, [MANIFEST], store)), "evidence_entry_outside_manifest", "every verb inherits the refusal");
  assert.equal(existsSync(join(root, ".git/hooks/pre-commit")), false);
  assert.equal(existsSync(join(root, ".githooks")), false);
  assert.equal(existsSync(join(root, "scripts")), false);

  // Two manifests can still meet (one inside the other's folder): one path is never recorded by both.
  const { root: two } = planted();
  const nested = `one/${POLICY.folderName}/sub`;
  write(two, `one/${POLICY.manifestName}`, text([entry(`${nested}/${POLICY.folderName}/x`)]));
  write(two, `${nested}/${POLICY.manifestName}`, text([entry(`${nested}/${POLICY.folderName}/x`)]));
  git(two, "add", "--", `one/${POLICY.manifestName}`, `${nested}/${POLICY.manifestName}`);
  assert.equal(codeOf(() => recordedEvidence(two)), "evidence_manifest_conflict");
});

test("materialize never writes through a linked parent: a linked evidence folder or a linked folder inside it is refused and nothing lands outside (security review E1, correctness N1)", () => {
  const { root, store } = ingested();
  const outside = realpathSync(createTempDir("evidence-outside-"));
  rmSync(join(root, FOLDER), { recursive: true });
  symlinkSync(outside, join(root, FOLDER));
  assert.equal(codeOf(() => materializeEvidence(root, [`${FOLDER}/raw/receipt.json`], store)), "evidence_path_through_link");
  assert.equal(existsSync(join(outside, "raw")), false, "nothing was written through the linked evidence folder");

  rmSync(join(root, FOLDER));
  mkdirSync(join(root, FOLDER));
  symlinkSync(outside, join(root, `${FOLDER}/raw`));
  assert.equal(codeOf(() => materializeEvidence(root, [`${FOLDER}/raw`], store)), "evidence_path_through_link");
  for (const name of ["copy.log.txt", "receipt.json", "run.log.txt", "nested"]) assert.equal(existsSync(join(outside, name)), false, `nor through a linked folder inside it (${name})`);

  rmSync(join(root, `${FOLDER}/raw`));
  mkdirSync(join(root, `${FOLDER}/raw`));
  symlinkSync(join(outside, "planted"), join(root, `${FOLDER}/raw/receipt.json`));
  assert.equal(codeOf(() => materializeEvidence(root, [`${FOLDER}/raw/receipt.json`], store)), "evidence_not_regular_file", "a link at the target itself");
  assert.equal(existsSync(join(outside, "planted")), false);

  rmSync(join(root, `${FOLDER}/raw/receipt.json`));
  assert.deepEqual(materializeEvidence(root, [`${FOLDER}/raw`], store).written.length, 4, "the real folders materialize, made one level at a time");
  assert.equal(lstatSync(join(root, `${FOLDER}/raw/nested`)).isDirectory(), true);
});

test("ingest never reads through a linked parent, a linked folder or a linked file: nothing outside the repository enters the store (security review E2)", () => {
  const { root, location } = planted();
  const store = admitEvidenceStore(location, root);
  const outside = realpathSync(createTempDir("evidence-outside-"));
  writeFileSync(join(outside, "private.txt"), "not evidence\n");
  symlinkSync(outside, join(root, `${FOLDER}/lnk`));
  assert.equal(codeOf(() => ingestEvidence(root, [`${FOLDER}/lnk/private.txt`], MANIFEST, store)), "evidence_path_through_link");
  assert.equal(codeOf(() => ingestEvidence(root, [`${FOLDER}/lnk`], MANIFEST, store)), "evidence_path_through_link", "the linked folder itself");
  assert.equal(codeOf(() => ingestEvidence(root, [FOLDER], MANIFEST, store)), "evidence_not_regular_file", "a folder that holds a link");
  rmSync(join(root, `${FOLDER}/lnk`));
  symlinkSync(join(outside, "private.txt"), join(root, `${FOLDER}/raw/alias.txt`));
  assert.equal(codeOf(() => ingestEvidence(root, [`${FOLDER}/raw/alias.txt`], MANIFEST, store)), "evidence_path_through_link", "a linked file is never followed");
  assert.equal(existsSync(objectOf(store.location, sha256("not evidence\n"))), false, "the outside file never entered the store");
  assert.equal(existsSync(join(root, MANIFEST)), false, "a refused ingest records nothing");
  assert.equal(codeOf(() => ingestEvidence(root, ["docs/elsewhere/x.txt"], MANIFEST, store)), "evidence_entry_outside_manifest", "a path outside the manifest's folder");
  assert.equal(codeOf(() => ingestEvidence(root, [`${FOLDER}/none`], MANIFEST, store)), "evidence_path_missing");
  assert.equal(codeOf(() => ingestEvidence(root, [`${FOLDER}/raw/run.log.txt`], "docs/run/other.json", store)), "evidence_manifest_name");
  assert.equal(codeOf(() => ingestEvidence(root, [], MANIFEST, store)), "evidence_usage");
});

test("the exposed action inherits every refusal: a forged entry or a linked folder is refused through workspaceGit.materializeEvidence", async () => {
  const { root, store } = ingested();
  const payload = recordedEvidence(root).get(`${FOLDER}/raw/nested/probe.sh.txt`)!;
  registerWorkspaceGitExposure();
  installWorkspaceGitStateSource({
    liveIndexState: () => "", journals: () => "", recordIndex: () => null, repairIndex: () => null,
    declaredDeletions: () => "", declareDeletion: () => null, clearDeclaredDeletions: () => null,
    evidence: () => "", evidenceStore: () => "", verifyEvidence: () => verifyEvidence(root, undefined, store),
    materializeEvidence: (path) => materializeEvidence(root, [path], store),
    workspaces: () => "", sweepWorkspaces: async () => null,
  });
  forgeManifest(root, [{ path: ".git/hooks/pre-commit", sha256: payload.sha256, size: payload.size, mode: "0755" }]);
  assert.equal(await asyncCodeOf(() => executeAction("workspaceGit.materializeEvidence", { path: ".git/hooks/pre-commit" })), "evidence_manifest_invalid");
  forgeManifest(root, [{ path: `${FOLDER}/raw/receipt.json`, sha256: payload.sha256, size: payload.size, mode: "0644" }]);
  rmSync(join(root, `${FOLDER}/raw`), { recursive: true });
  const outside = realpathSync(createTempDir("evidence-outside-"));
  symlinkSync(outside, join(root, `${FOLDER}/raw`));
  assert.equal(await asyncCodeOf(() => executeAction("workspaceGit.materializeEvidence", { path: `${FOLDER}/raw/receipt.json` })), "evidence_path_through_link");
  assert.equal(existsSync(join(outside, "receipt.json")), false);
  assert.equal(existsSync(join(root, ".git/hooks/pre-commit")), false);
});

test("the store is the one private home: refused overlapping the repository or the temp folder, as a link and open to others", () => {
  const { root, location } = planted();
  assert.equal(codeOf(() => admitEvidenceStore(join(root, "store"), root)), "evidence_store_not_disjoint");
  assert.equal(codeOf(() => admitEvidenceStore(root, root)), "evidence_store_not_disjoint");
  assert.equal(codeOf(() => admitEvidenceStore(createTempDir("evidence-in-temp-"), root)), "evidence_store_not_disjoint", "a store in the system temp folder");
  const target = admitEvidenceStore(location, root).location;
  const link = join(dirname(location), "link");
  symlinkSync(target, link);
  assert.equal(codeOf(() => admitEvidenceStore(link, root)), "evidence_store_unsafe");
  chmodSync(target, 0o755);
  assert.equal(codeOf(() => admitEvidenceStore(target, root)), "evidence_store_unsafe");
  chmodSync(target, 0o700);
});

test("the store's location: the operator's variable wins and only as an absolute folder, else the data home; a process under test without it is refused (N5)", () => {
  const saved = { override: process.env[POLICY.environmentVariable], base: process.env[POLICY.baseVariable] };
  try {
    process.env[POLICY.environmentVariable] = "/srv/evidence";
    assert.equal(evidenceStoreLocation(), "/srv/evidence");
    assert.deepEqual(evidenceStoreSetting(), { location: "/srv/evidence", source: "environment", variable: POLICY.environmentVariable });
    process.env[POLICY.environmentVariable] = "relative/store";
    assert.equal(codeOf(() => evidenceStoreLocation()), "evidence_store_not_absolute");
    delete process.env[POLICY.environmentVariable];
    process.env[POLICY.baseVariable] = "/srv/data";
    assert.deepEqual(evidenceStoreSetting(), { location: join("/srv/data", ...POLICY.relative.split("/")), source: "default", variable: POLICY.environmentVariable });
    assert.ok(!evidenceStoreSetting().location.includes("/.local/state/"), "the default is outside the keep-out floor's state wildcard");
  } finally {
    if (saved.override === undefined) delete process.env[POLICY.environmentVariable];
    else process.env[POLICY.environmentVariable] = saved.override;
    if (saved.base === undefined) delete process.env[POLICY.baseVariable];
    else process.env[POLICY.baseVariable] = saved.base;
  }
  // This file runs under the engine runner: a child inherits its ancestry, so the write door says "under test".
  const base = realpathSync(createTempDir("evidence-unset-"));
  const module = fileURLToPath(new URL("../../src/workflow/evidence-store.ts", import.meta.url));
  const env: NodeJS.ProcessEnv = { ...process.env, [POLICY.baseVariable]: base };
  delete env[POLICY.environmentVariable];
  const child = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e",
    `import(${JSON.stringify(module)}).then((m) => { try { m.evidenceStoreLocation(); console.log("picked"); } catch (e) { console.log(e.code); } })`], { encoding: "utf8", env });
  assert.equal(child.stdout.trim(), "evidence_store_unset_under_test", child.stderr);
  assert.equal(existsSync(join(base, ...POLICY.relative.split("/"))), false, "no store was created");
});

test("the store keeps itself out of every confined process, wherever the operator put it (security review E4)", () => {
  const harnessRoot = fileURLToPath(new URL("../../", import.meta.url));
  const saved = process.env[POLICY.environmentVariable];
  const location = privateStoreLocation();
  try {
    process.env[POLICY.environmentVariable] = location;
    assert.notEqual(floorKeepOutVerdict(harnessRoot, location), undefined, "the store itself");
    assert.notEqual(floorKeepOutVerdict(harnessRoot, join(location, POLICY.objects.root, "x")), undefined, "anything inside it");
    assert.notEqual(floorKeepOutVerdict(harnessRoot, dirname(location)), undefined, "a folder that holds it");
    assert.equal(floorKeepOutVerdict(harnessRoot, join(dirname(dirname(location)), "beside")), undefined, "a place beside it is not");
  } finally {
    if (saved === undefined) delete process.env[POLICY.environmentVariable];
    else process.env[POLICY.environmentVariable] = saved;
  }
});

test("the verbs: ingest needs one manifest, verify fails on a missing object, materialize refuses a manifest flag, an unknown verb is typed", () => {
  const { root, location } = planted();
  const saved = process.env[POLICY.environmentVariable];
  process.env[POLICY.environmentVariable] = location;
  try {
    assert.equal(codeOf(() => harnessEvidence(root, ["ingest", `${FOLDER}/raw`])), "evidence_usage");
    assert.equal(harnessEvidence(root, ["ingest", "--manifest", MANIFEST, "--", `${FOLDER}/raw`]).status, "pass");
    git(root, "add", "--", MANIFEST);
    assert.equal(harnessEvidence(root, ["verify"]).status, "pass");
    rmSync(objectOf(realpathSync(location), recordedEvidence(root).get(`${FOLDER}/raw/receipt.json`)!.sha256));
    assert.equal(harnessEvidence(root, ["verify", "--manifest", MANIFEST]).status, "fail");
    assert.equal(codeOf(() => harnessEvidence(root, ["materialize", "--manifest", MANIFEST, `${FOLDER}/raw`])), "unknown_flag");
    assert.equal(codeOf(() => harnessEvidence(root, ["prune"])), "command_unavailable");
  } finally {
    if (saved === undefined) delete process.env[POLICY.environmentVariable];
    else process.env[POLICY.environmentVariable] = saved;
  }
});
