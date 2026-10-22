// The pinned corpus subset: the manifest, the fetch, and the one verification.
//
// The arms below exist because the failure this replaces was silent: a fresh
// clone had no corpus, the tests that read it could not run, and the only
// instruction was "copy the cache from another checkout". So the manifest must
// be generated and self-verifying, the fetch must materialise exactly what it
// says, and a drifted cache must refuse by name instead of being read.
//
// The fetch arm drives real git against a local bare repository. It never
// touches the network and never needs the 4 GB cache: the contract is the
// mechanics, and the committed manifest is generated where the cache lives.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createTempDir } from "../support/temp-dir.ts";

import {
  CORPUS_ROOT,
  CorpusError,
  MANIFEST_PATH,
  PERMITTED_LICENSES,
  cacheReadme,
  fetchCorpus,
  linkCorpus,
  manifestDigest,
  readManifest,
  sha256Hex,
  validateManifest,
  verifyCorpus,
  type CorpusMember,
  type CorpusManifest,
  PATH_POLICY_MANIFEST_PATH,
  gitCorpusMember,
  pathPolicyMember,
  readCorpus,
  REFERENCE_ONLY_LICENSES,
  REPOSITORY_ROOT,
} from "../../scripts/verification/corpus.ts";
import { parsePathPolicySourceManifest, readPathPolicySource } from "../../scripts/generation/repository-path-unicode.ts";
import { InputError } from "../../src/kernel/errors.ts";

function git(args: readonly string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } }).trim();
}

/** A manifest over one synthetic member and one derived entry, with a real digest. */
function syntheticManifest(upstream: string, commit: string, files: readonly { path: string; bytes: Buffer }[]): CorpusManifest {
  const member: CorpusMember = {
    name: "member",
    upstream,
    commit,
    license: "MIT",
    files: files.map((file) => ({ path: file.path, sizeBytes: file.bytes.byteLength, sha256: sha256Hex(file.bytes) })),
  };
  const payload = {
    schemaVersion: "bridlewise-corpus-manifest/v1",
    generatorRevision: "corpus-ts-1",
    root: CORPUS_ROOT,
    members: [member],
    derived: [] as CorpusManifest["derived"],
    notIncluded: "a synthetic member that exists only for this test",
  };
  return { ...payload, manifestSha256: manifestDigest(payload) };
}

test("corpus: the committed manifest pins only reviewed, permissive members", () => {
  const manifest = readManifest();
  assert.equal(manifest.root, CORPUS_ROOT);
  assert.equal(manifest.members.length, 3, "lodash, express and babel/traverse are the only members the public tests read");
  assert.deepEqual(manifest.members.map((member) => member.name).sort(), ["babel", "express", "lodash"]);
  const total = manifest.members.reduce((count, member) => count + member.files.length, 0);
  assert.ok(total >= 40, `the manifest must pin the files the tests read, got ${total}`);
  for (const member of manifest.members) {
    assert.ok(PERMITTED_LICENSES.includes(member.license), `${member.name} carries an unreviewed licence ${member.license}`);
    assert.match(member.upstream, /^https:\/\/github\.com\//, `${member.name} must fetch from a public https remote`);
    assert.match(member.commit, /^[0-9a-f]{40}$/);
    assert.ok(member.files.length > 0, `${member.name} pins no files`);
  }
  assert.equal(manifest.derived.length, 1, "the scanner bait is the one derived file");
  assert.equal(manifest.derived[0]?.path, "real-20/lodash/test/index.html");
  assert.equal(manifest.derived[0]?.sizeBytes, 11064, "the guard asserts the Lodash test page's exact size");
  assert.equal(manifest.manifestSha256, manifestDigest(manifest), "the committed digest must match its contents");
  assert.ok(manifest.notIncluded.includes("not published"), "the manifest must state what it does not publish");
});

type MutableManifest = {
  members: { name: string; upstream: string; commit: string; license: string; files: { path: string; sizeBytes: number; sha256: string }[] }[];
  derived: unknown[];
  [key: string]: unknown;
};

test("corpus: a hand-edited hash, path, upstream or licence refuses by name", () => {
  const manifest = readManifest();
  const clone = (): MutableManifest => JSON.parse(JSON.stringify(manifest)) as MutableManifest;

  const digestMismatch = clone();
  digestMismatch.members[0]!.files[0]!.sha256 = "0".repeat(64);
  assert.throws(() => validateManifest(digestMismatch), (error: unknown) => error instanceof CorpusError && error.code === "corpus_manifest_digest_mismatch");

  const escape = clone();
  escape.members[0]!.files[0]!.path = "../escape.ts";
  assert.throws(() => validateManifest(escape), (error: unknown) => error instanceof CorpusError && error.code === "corpus_path_invalid");

  const insecure = clone();
  insecure.members[0]!.upstream = "http://example.invalid/x.git";
  assert.throws(() => validateManifest(insecure), (error: unknown) => error instanceof CorpusError && error.code === "corpus_upstream_invalid");

  const licence = clone();
  licence.members[0]!.license = "GPL-3.0-only";
  assert.throws(() => validateManifest(licence), (error: unknown) => error instanceof CorpusError && error.code === "corpus_license_unreviewed");
});

test("corpus: verify passes a matching cache and names the file that drifted", () => {
  const base = createTempDir("corpus-verify-");
  try {
    const repo = join(base, "repo");
    const cache = join(base, "cache");
    mkdirSync(repo, { recursive: true });
    mkdirSync(join(cache, "member"), { recursive: true });
    const bytes = Buffer.from("export const answer = 42;\n");
    writeFileSync(join(cache, "member", "index.ts"), bytes);
    writeFileSync(join(cache, "README.md"), "generated\n");
    mkdirSync(join(repo, "engine"), { recursive: true });
    symlinkSync(cache, join(repo, CORPUS_ROOT), "dir");

    const manifest = syntheticManifest("https://example.invalid/x.git", "a".repeat(40), [{ path: "index.ts", bytes }]);
    const ok = verifyCorpus(repo, manifest);
    assert.deepEqual(ok, { ok: true, root: cache, problems: [] });

    writeFileSync(join(cache, "member", "index.ts"), Buffer.from("export const answer = 43;\n"));
    const drifted = verifyCorpus(repo, manifest);
    assert.equal(drifted.ok, false);
    assert.deepEqual(drifted.problems, [{ path: "member/index.ts", reason: "sha256 mismatch" }]);

    rmSync(join(cache, "README.md"));
    const noReadme = verifyCorpus(repo, manifest);
    assert.ok(noReadme.problems.some((problem) => problem.path === "README.md"), "a cache without its README refuses");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("corpus: verify refuses a root that resolves inside the repository", () => {
  const base = createTempDir("corpus-inside-");
  try {
    const repo = join(base, "repo");
    mkdirSync(join(repo, "engine", "large-codebases", "member"), { recursive: true });
    const bytes = Buffer.from("x\n");
    writeFileSync(join(repo, "engine", "large-codebases", "member", "index.ts"), bytes);
    writeFileSync(join(repo, "engine", "large-codebases", "README.md"), "generated\n");
    const manifest = syntheticManifest("https://example.invalid/x.git", "a".repeat(40), [{ path: "index.ts", bytes }]);
    const verdict = verifyCorpus(repo, manifest);
    assert.equal(verdict.ok, false);
    assert.match(verdict.problems[0]?.reason ?? "", /inside the repository/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("corpus: fetch materialises the pinned commit and link checks it out", () => {
  const base = createTempDir("corpus-fetch-");
  try {
    const bare = join(base, "member.git");
    const seed = join(base, "seed");
    mkdirSync(seed, { recursive: true });
    git(["init", "-q", "--bare", bare], base);
    git(["init", "-q"], seed);
    const bytes = Buffer.from("function answer() { return 42; }\n");
    const derivedBytes = Buffer.from("<html><body>test page</body></html>\n");
    mkdirSync(join(seed, "lib"), { recursive: true });
    mkdirSync(join(seed, "test"), { recursive: true });
    writeFileSync(join(seed, "lib", "index.js"), bytes);
    writeFileSync(join(seed, "test", "index.html"), derivedBytes);
    git(["add", "."], seed);
    git(["commit", "-q", "-m", "one"], seed);
    git(["remote", "add", "origin", bare], seed);
    git(["push", "-q", "origin", "HEAD:main"], seed);
    const commit = git(["rev-parse", "HEAD"], seed);

    const member: CorpusMember = {
      name: "member",
      upstream: `file://${bare}`,
      commit,
      license: "MIT",
      files: [{ path: "lib/index.js", sizeBytes: bytes.byteLength, sha256: sha256Hex(bytes) }],
    };
    const payload = {
      schemaVersion: "bridlewise-corpus-manifest/v1",
      generatorRevision: "corpus-ts-1",
      root: CORPUS_ROOT,
      members: [member],
      derived: [{ path: "real-20/member/test/index.html", member: "member", source: "test/index.html", sizeBytes: derivedBytes.byteLength, sha256: sha256Hex(derivedBytes) }],
      notIncluded: "a synthetic member that exists only for this test",
    };
    const manifest: CorpusManifest = { ...payload, manifestSha256: manifestDigest(payload) };

    const repo = join(base, "repo");
    mkdirSync(repo, { recursive: true });
    const cache = join(base, "cache");
    const written = fetchCorpus(manifest, { cacheDir: cache, repoRoot: repo, log: () => {} });
    assert.equal(written, cache);
    assert.deepEqual(readFileSync(join(cache, "member", "lib", "index.js")), bytes);
    assert.deepEqual(readFileSync(join(cache, "real-20", "member", "test", "index.html")), derivedBytes);
    assert.ok(existsSync(join(cache, "README.md")), "the cache carries its generated README");

    // A fresh clone has no link yet: fetch must judge the CACHE it would
    // reuse, never the declared root. Remove the upstream first, so a second
    // materialisation is impossible and only reuse can answer.
    rmSync(bare, { recursive: true, force: true });
    rmSync(seed, { recursive: true, force: true });
    const reused = fetchCorpus(manifest, { cacheDir: cache, repoRoot: repo, log: () => {} });
    assert.equal(reused, cache, "a verified cache is reused without the upstream");
    writeFileSync(join(cache, "member", "lib", "index.js"), "tampered\n");
    assert.throws(
      () => fetchCorpus(manifest, { cacheDir: cache, repoRoot: repo, log: () => {} }),
      (error: unknown) => error instanceof CorpusError && error.code === "corpus_cache_exists",
      "a cache that no longer matches the manifest is refused, not refetched over",
    );
    writeFileSync(join(cache, "member", "lib", "index.js"), bytes);

    const link = linkCorpus(repo, cache);
    assert.equal(link, join(repo, CORPUS_ROOT));
    const verdict = verifyCorpus(repo, manifest);
    assert.equal(verdict.ok, true, `the linked cache must verify: ${verdict.problems.map((problem) => problem.path).join(", ")}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("corpus: link refuses an existing real directory instead of overwriting it", () => {
  const base = createTempDir("corpus-link-");
  try {
    const repo = join(base, "repo");
    const cache = join(base, "cache");
    mkdirSync(join(repo, "engine", "large-codebases"), { recursive: true });
    mkdirSync(cache, { recursive: true });
    assert.throws(() => linkCorpus(repo, cache), (error: unknown) => error instanceof CorpusError && error.code === "corpus_link_exists");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("corpus: link replaces its own previous cache but never a foreign tree", () => {
  const base = createTempDir("corpus-relink-");
  try {
    const repo = join(base, "repo");
    const caches = join(base, "corpus");
    const first = join(caches, "aaaa");
    const second = join(caches, "bbbb");
    const foreign = join(base, "elsewhere");
    for (const path of [first, second, foreign]) mkdirSync(path, { recursive: true });
    mkdirSync(repo, { recursive: true });
    linkCorpus(repo, first);
    assert.equal(readlinkSync(join(repo, CORPUS_ROOT)), first);
    // A regenerated manifest changes the digest and therefore the cache name:
    // the previous link is ours and is replaced.
    linkCorpus(repo, second);
    assert.equal(readlinkSync(join(repo, CORPUS_ROOT)), second);
    // A tree outside the corpus cache area is not ours to replace.
    rmSync(join(repo, CORPUS_ROOT));
    symlinkSync(foreign, join(repo, CORPUS_ROOT), "dir");
    assert.throws(() => linkCorpus(repo, first), (error: unknown) => error instanceof CorpusError && error.code === "corpus_link_exists");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("corpus: the generated README names the manifest, its digest and the removal path", () => {
  const manifest = readManifest();
  const readme = cacheReadme(manifest);
  assert.ok(readme.includes(MANIFEST_PATH));
  assert.ok(readme.includes(manifest.manifestSha256));
  assert.ok(readme.includes("npm run corpus:verify"));
  assert.ok(readme.includes("unlink engine/large-codebases"));
});

test("corpus: the git member is derived from the path-policy pins — three files, one copy of each pin, reference-only", () => {
  const git = parsePathPolicySourceManifest(readFileSync(join(REPOSITORY_ROOT, PATH_POLICY_MANIFEST_PATH), "utf8")).sourceSets.git;
  const member = pathPolicyMember();
  assert.equal(member.commit, git.upstream.commit);
  assert.equal(member.upstream, `${git.upstream.repository}.git`);
  assert.ok(REFERENCE_ONLY_LICENSES.includes(member.license) && !PERMITTED_LICENSES.includes(member.license), "GPL is fetched for reference, never a permissive member");
  assert.deepEqual(member.files.map((file) => file.path), ["COPYING", "path.c", "t/t0060-path-utils.sh"]);
  for (const binding of [git.license, ...git.sources]) {
    const file = member.files.find((entry) => binding.path.endsWith(`/git/${entry.path}`));
    assert.deepEqual(file && { sizeBytes: file.sizeBytes, sha256: file.sha256 }, { sizeBytes: binding.byteLength, sha256: binding.sha256 }, binding.path);
  }
  // ONE copy of the pins: the committed corpus manifest carries no git member,
  // and the corpus the fetch materialises does (its digest covers it).
  assert.equal(readManifest().members.some((entry) => entry.name === "git"), false);
  const corpus = readCorpus();
  assert.deepEqual(corpus.members.map((entry) => entry.name).sort(), ["babel", "express", "git", "lodash"]);
  assert.notEqual(corpus.manifestSha256, readManifest().manifestSha256, "the cache key covers the git pins too");
});

test("corpus: a fetched path-policy source that is absent or off its pin refuses by name, naming the fetch", () => {
  const root = createTempDir("corpus-git-source-");
  try {
    const bytes = Buffer.from("int main(void) { return 0; }\n");
    const binding = { path: "large-codebases/git/path.c", byteLength: bytes.byteLength, sha256: sha256Hex(bytes) };
    assert.throws(() => readPathPolicySource(root, binding), (error: unknown) =>
      error instanceof InputError && error.code === "repository_path_corpus_source_absent" && /npm run corpus:fetch/u.test(error.message));
    mkdirSync(join(root, "large-codebases", "git"), { recursive: true });
    writeFileSync(join(root, "large-codebases", "git", "path.c"), "drifted\n");
    assert.throws(() => readPathPolicySource(root, binding), (error: unknown) =>
      error instanceof InputError && error.code === "repository_path_source_identity_invalid" && /npm run corpus:fetch/u.test(error.message));
    writeFileSync(join(root, "large-codebases", "git", "path.c"), bytes);
    assert.deepEqual(readPathPolicySource(root, binding), bytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── THE LICENCE BOUNDARY, each check driven (review of #295) ──────────────
// GPL bytes stay out of the tree because (1) the path-policy manifest's git
// bindings may only point into the corpus root (the schema's path rule and
// the member's own prefix check, each refusing alone), (2) only a
// reference-only licence is admitted, and (3) the committed corpus manifest
// may not carry a git member of its own. Each is planted and must refuse.

function livePathPolicyText(): string {
  return readFileSync(join(REPOSITORY_ROOT, PATH_POLICY_MANIFEST_PATH), "utf8");
}

test("corpus: a path-policy manifest pointing the GPL sources back into the tracked tree is refused by the schema", () => {
  const live = JSON.parse(livePathPolicyText()) as { sourceSets: { git: { license: { path: string }; sources: { path: string }[] } } };
  const intoTree = (path: string): string => path.replace(/^large-codebases\/git\//u, "traceability/sources/path-policy/git-2.55.0/");
  for (const plant of ["license", "source"] as const) {
    const manifest = structuredClone(live);
    if (plant === "license") manifest.sourceSets.git.license.path = intoTree(manifest.sourceSets.git.license.path);
    else manifest.sourceSets.git.sources[0]!.path = intoTree(manifest.sourceSets.git.sources[0]!.path);
    assert.notEqual(JSON.stringify(manifest), JSON.stringify(live), "the plant changed nothing");
    assert.throws(() => parsePathPolicySourceManifest(JSON.stringify(manifest)), plant);
  }
  assert.doesNotThrow(() => parsePathPolicySourceManifest(livePathPolicyText()), "control: the live manifest parses");
});

test("corpus: the git member refuses a binding outside the corpus root on its own, and admits the live one", () => {
  const git = parsePathPolicySourceManifest(livePathPolicyText()).sourceSets.git;
  assert.equal(gitCorpusMember(git).files.length, 3, "control: the live source set is admitted");
  for (const plant of ["license", "source"] as const) {
    const intoTree = { ...git.license, path: "traceability/sources/path-policy/git-2.55.0/COPYING" };
    const planted = plant === "license"
      ? { ...git, license: intoTree }
      : { ...git, sources: [{ ...git.sources[0]!, path: "traceability/sources/path-policy/git-2.55.0/path.c" }, ...git.sources.slice(1)] };
    assert.throws(() => gitCorpusMember(planted), (error: unknown) => error instanceof CorpusError && error.code === "corpus_path_invalid", plant);
  }
});

test("corpus: the git member is admitted only under a reference-only licence", () => {
  const git = parsePathPolicySourceManifest(livePathPolicyText()).sourceSets.git;
  for (const spdx of ["GPL-3.0-only", "MIT", "AGPL-3.0-only"]) {
    assert.throws(() => gitCorpusMember({ ...git, license: { ...git.license, spdx } }),
      (error: unknown) => error instanceof CorpusError && error.code === "corpus_license_unreviewed", spdx);
  }
});

test("corpus: a committed corpus manifest that carries its own git member is refused", () => {
  const root = createTempDir("corpus-git-entry-");
  try {
    const committed = readManifest();
    const git = pathPolicyMember();
    const payload = {
      schemaVersion: committed.schemaVersion,
      generatorRevision: committed.generatorRevision,
      root: committed.root,
      members: [...committed.members, { ...git, license: "MIT" }],
      derived: committed.derived,
      notIncluded: committed.notIncluded,
    };
    mkdirSync(join(root, MANIFEST_PATH, ".."), { recursive: true });
    writeFileSync(join(root, MANIFEST_PATH), `${JSON.stringify({ ...payload, manifestSha256: manifestDigest(payload) }, null, 2)}\n`);
    mkdirSync(join(root, PATH_POLICY_MANIFEST_PATH, ".."), { recursive: true });
    writeFileSync(join(root, PATH_POLICY_MANIFEST_PATH), livePathPolicyText());
    assert.throws(() => readCorpus(root), (error: unknown) => error instanceof CorpusError && error.code === "corpus_manifest_invalid");
    // Control: the same root without the extra member composes.
    const clean = { ...payload, members: committed.members };
    writeFileSync(join(root, MANIFEST_PATH), `${JSON.stringify({ ...clean, manifestSha256: manifestDigest(clean) }, null, 2)}\n`);
    assert.equal(readCorpus(root).members.some((member) => member.name === "git"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
