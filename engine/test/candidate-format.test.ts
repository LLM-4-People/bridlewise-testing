import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { buildCandidateManifest, buildCandidateManifestDetailed } from "../scripts/tooling/candidate-manifest.ts";
import {
  candidateFormatForBytes,
  candidateFormatErrorViolations,
  candidatePathRejectedWithoutContentRead,
} from "../scripts/verification/candidate-format.ts";
import { buildArtifactAdmissionManifest } from "../scripts/tooling/verification/artifact-admission.ts";
import { verifyGovernedTypeScriptSource } from "../scripts/tooling/verification/governed-source.ts";
import {
  reconstructOriginalBytes,
  verifyRejectedBinaryFixture,
} from "../scripts/tooling/verification/rejected-binary-fixture.ts";
import {
  readSafeRepositoryFile,
  type SafeRepositoryRootAccess,
} from "../scripts/verification/safe-repository-reader.ts";
import { HarnessError } from "../src/kernel/errors.ts";
import { canonicalHash, canonicalJson, canonicalJsonLines, sha256 } from "../src/kernel/integrity.ts";
import { ROOT_POLICY } from "../src/kernel/root-policy.ts";
import {
  createQualifiedRepositoryLocalTemporaryDirectory,
  removeRepositoryLocalTemporaryDirectory,
  removeRepositoryLocalTemporaryRoot,
  withSeparateTestRepositoryRootReadAccess,
} from "./support/repository-local-temporary.ts";
import { withProductionRejectFloor } from "./support/test-env-helpers.ts";
import { createTempDir } from "./support/temp-dir.ts";

const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));

test.after(removeRepositoryLocalTemporaryRoot);

test("candidate format rejects every noncanonical text byte condition", () => {
  const cases = [
    ["bom.txt", Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0a]), "byte-order-mark"],
    ["nul.txt", Buffer.from([0x61, 0x00, 0x0a]), "nul"],
    ["crlf.txt", Buffer.from("a\r\n"), "carriage-return"],
    ["cr.txt", Buffer.from("a\rb\n"), "carriage-return"],
    ["invalid.txt", Buffer.from([0xff, 0x0a]), "invalid-utf8"],
    ["missing.txt", Buffer.from("a"), "missing-final-newline"],
    ["excess.txt", Buffer.from("a\n\n"), "excess-final-newline"],
    ["space.txt", Buffer.from("a \n"), "trailing-whitespace"],
    ["tab.txt", Buffer.from("a\t\n"), "trailing-whitespace"],
  ] as const;
  for (const [path, bytes, kind] of cases) {
    const outcome = candidateFormatForBytes(path, bytes, undefined);
    assert.ok(outcome.violations.some((violation) => violation.includes(kind)), `${path} must reject ${kind}`);
  }
  assert.deepEqual(candidateFormatForBytes("empty.txt", Buffer.alloc(0), undefined).violations, []);
  assert.deepEqual(candidateFormatForBytes("valid.txt", Buffer.from("a\n"), undefined).violations, []);
});

test("Markdown hard breaks require explicit markup instead of trailing spaces", () => {
  const hardBreak = candidateFormatForBytes("doc.md", Buffer.from("line  \nnext\n"), undefined);
  assert.ok(hardBreak.violations.some((violation) => violation.includes("trailing-whitespace")));
  assert.deepEqual(candidateFormatForBytes("doc.md", Buffer.from("line<br>\nnext\n"), undefined).violations, []);
});

test("binary exemption requires both a declared extension and exact magic", () => {
  const signature = Buffer.from("89504e470d0a1a0a", "hex");
  const binary = Buffer.concat([signature, Buffer.from([0x00, 0xff, 0x00])]);
  assert.deepEqual(candidateFormatForBytes("asset.png", binary, undefined), {
    classification: "binary-exempt",
    violations: [],
  });
  assert.ok(candidateFormatForBytes("asset.png", Buffer.from("not png\n"), undefined).violations.some(
    (violation) => violation.includes("binary-signature-invalid"),
  ));
  assert.ok(candidateFormatForBytes("asset.bin", binary, undefined).violations.some(
    (violation) => violation.includes("nul") || violation.includes("invalid-utf8"),
  ));
  assert.deepEqual(candidateFormatForBytes("archive.tar.gz", Buffer.from([0x1f, 0x8b, 0x00]), undefined), {
    classification: "binary-exempt",
    violations: [],
  });
});

test("generated text receives the same format policy", () => {
  const outcome = candidateFormatForBytes("generated/report.json", Buffer.from("{} \n"), undefined);
  assert.ok(outcome.violations.some((violation) => violation.includes("trailing-whitespace")));
  assert.equal(ROOT_POLICY.verification.candidateFormat.text.generatedText, "same-policy-no-generated-file-exemption");
});

test("tracked, staged, and untracked malformed files all block the candidate", () => withRepository((root, access) => {
  const path = join(root, "untracked.txt");
  writeFileSync(path, "bad \n");
  assertCandidateViolation(access, "candidate-text-trailing-whitespace");
  git(root, ["add", "untracked.txt"]);
  assertCandidateViolation(access, "candidate-text-trailing-whitespace");
  writeFileSync(path, "good\n");
  git(root, ["add", "untracked.txt"]);
  assert.equal(buildCandidateManifest(access).publication.eligibility, "ready");
}));

test("rejected sensitive paths fail before content inspection", () => withRepository((root, access) => {
  const path = join(root, ".env");
  writeFileSync(path, "SECRET=must-not-be-read\n");
  chmodSync(path, 0o000);
  assert.equal(candidatePathRejectedWithoutContentRead(".env"), true);
  assertCandidateViolation(access, "candidate-sensitive-path-rejected-without-read");
  chmodSync(path, 0o600);
}));

test("symlinks, hardlinks, control paths, and invalid UTF-8 Git paths are rejected", () => {
  withProductionRejectFloor(() => {
  withRepository((root, access) => {
    symlinkSync("base.txt", join(root, "linked.txt"));
    assertCandidateViolation(access, "candidate-entry-symlink-rejected");
  });
  withRepository((root, access) => {
    linkSync(join(root, "base.txt"), join(root, "aliased.txt"));
    assertCandidateViolation(access, "candidate-entry-hardlink-rejected");
  });
  withRepository((root, access) => {
    writeFileSync(join(root, "bad\nname.txt"), "valid\n");
    assertCandidateViolation(access, "candidate-path-invalid:control-character");
  });
  withRepository((root, access) => {
    const prefix = Buffer.from(`${root}/bad-`);
    writeFileSync(Buffer.concat([prefix, Buffer.from([0xff])]), "valid\n");
    assertCandidateViolation(access, "candidate-git-path-invalid-utf8");
  });
  });
});

for (const state of ["staged", "committed"] as const) {
  test(`invalid UTF-8 ${state} Git paths retain candidate error classification`, () => withRepository((root, access) => {
    writeFileSync(Buffer.concat([Buffer.from(`${root}/invalid-`), Buffer.from([0xff])]), "valid\n");
    git(root, ["add", "--all"]);
    if (state === "committed") commit(root, "invalid pathname fixture");
    assertCandidateViolation(access, `candidate-git-path-invalid-utf8:${state === "committed" ? "ls-tree" : "ls-files"}`);
  }));
}

test("descriptor reader rejects symlink ancestors and hardlinked authorities before content reads", () => {
  withProductionRejectFloor(() => {
  withRepository((root, access) => {
    copyInto(root, "nested/file.txt", Buffer.from("inside\n"));
    git(root, ["add", "nested/file.txt"]);
    commit(root, "nested baseline");
    const external = createTempDir("bridlewise-candidate-external-");
    try {
      writeFileSync(join(external, "file.txt"), "external must not be read\n");
      chmodSync(join(external, "file.txt"), 0o000);
      rmSync(join(root, "nested"), { recursive: true });
      symlinkSync(external, join(root, "nested"));
      assert.throws(() => buildCandidateManifest(access), (error) => {
        const violations = candidateFormatErrorViolations(error) ?? [];
        return violations.some((entry) => entry.includes("candidate-entry-ancestor-symlink-rejected")) &&
          !violations.some((entry) => entry.includes("candidate-entry-unreadable:nested%2Ffile.txt"));
      });
      chmodSync(join(external, "file.txt"), 0o600);
    } finally {
      rmSync(external, { recursive: true, force: true });
    }
  });

  withRepository((root, access) => {
    const manifestPath = "traceability/sources/s2/manifest.json";
    const yamlPath = "traceability/sources/s2/openai-chat-stream.yaml";
    const toolsPath = "traceability/sources/s2/mcp-tools.ts";
    copyInto(root, manifestPath, readFileSync(join(REPOSITORY_ROOT, manifestPath)));
    copyInto(root, yamlPath, readFileSync(join(REPOSITORY_ROOT, yamlPath)));
    copyInto(root, toolsPath, readFileSync(join(REPOSITORY_ROOT, toolsPath)));
    git(root, ["add", "."]);
    commit(root, "authority baseline");
    linkSync(join(root, manifestPath), join(root, `${manifestPath}.alias`));
    chmodSync(join(root, manifestPath), 0o000);
    try {
      assertCandidateViolation(access, "candidate-entry-hardlink-rejected");
    } finally {
      chmodSync(join(root, manifestPath), 0o600);
    }
  });
  });
});

test("a file removed between the enumeration and the read is dropped, not refused", () => withRepository((root, access) => {
  // ENUMERATE-THEN-READ OVER A LIVE TREE IS RACY AGAINST ANY CONCURRENT
  // WRITER, and this drives that window at the real door rather than hoping to
  // hit it. `git ls-files` lists the path, the existence filter accepts it, and
  // the read finds it gone — which used to produce
  // `candidate-entry-unreadable:<path>` and refuse the entire manifest. On the
  // live repository that fired once in six full suite runs, always naming an
  // unrelated test's temporary file.
  //
  // The removal is performed by the safe reader's own observation hook while
  // the loop is reading an EARLIER path (`base.txt` sorts before
  // `sub/vanishing.txt`), so the window is opened deterministically instead of
  // being waited for. The vanishing file lives in its own directory because
  // unlinking it changes THAT directory's identity, and the reader is entitled
  // to refuse a file whose own ancestor chain moved under it mid-read.
  const vanishing = "sub/vanishing.txt";
  copyInto(root, vanishing, Buffer.from("gone before it is read\n"));
  let removals = 0;
  const build = buildCandidateManifestDetailed(access, {
    afterAncestorTraversal: () => {
      if (removals > 0) return;
      removals += 1;
      rmSync(join(root, vanishing), { force: true });
    },
  });
  assert.equal(removals, 1, "the plant must have fired, or this test proves nothing");
  assert.deepEqual(build.vanishedPaths, [vanishing]);
  assert.equal(
    build.manifest.files.some((file) => file.path === vanishing),
    false,
    "a file that is no longer there was never part of this snapshot",
  );
  // And the snapshot the verification re-list is compared against must agree,
  // or the refusal simply moves to `candidate-changed-during-verification` and
  // the race is renamed rather than fixed. Reaching this line at all is that
  // assertion: `verifySnapshotUnchanged` runs inside the build above.

  // CONTROL — the same fixture with no removal keeps the file and reports
  // nothing vanished, so the plant is what changed the answer.
  copyInto(root, vanishing, Buffer.from("gone before it is read\n"));
  const quiet = buildCandidateManifestDetailed(access);
  assert.deepEqual(quiet.vanishedPaths, []);
  assert.equal(quiet.manifest.files.some((file) => file.path === vanishing), true);
}));

test("descriptor reader detects ancestor replacement without following it", () => withRepository((root, access) => {
  copyInto(root, "nested/file.txt", Buffer.from("inside\n"));
  const external = createTempDir("bridlewise-candidate-race-external-");
  try {
    writeFileSync(join(external, "file.txt"), "external must not be read\n");
    chmodSync(join(external, "file.txt"), 0o000);
    assert.throws(() => readSafeRepositoryFile(access, "nested/file.txt", 1024, {
      afterAncestorTraversal: () => {
        renameSync(join(root, "nested"), join(root, "nested-original"));
        symlinkSync(external, join(root, "nested"));
      },
    }), (error) => error instanceof HarnessError && error.code === "safe_path_identity_changed");
    chmodSync(join(external, "file.txt"), 0o600);
  } finally {
    rmSync(external, { recursive: true, force: true });
  }
}));

test("manifest-derived immutable source exceptions are exact-path and exact-digest only", () => withRepository((root, access) => {
  const manifestPath = "traceability/sources/s2/manifest.json";
  const yamlPath = "traceability/sources/s2/openai-chat-stream.yaml";
  const toolsPath = "traceability/sources/s2/mcp-tools.ts";
  copyInto(root, manifestPath, readFileSync(join(REPOSITORY_ROOT, manifestPath)));
  copyInto(root, yamlPath, readFileSync(join(REPOSITORY_ROOT, yamlPath)));
  copyInto(root, toolsPath, readFileSync(join(REPOSITORY_ROOT, toolsPath)));
  git(root, ["add", "."]);
  commit(root, "admit exact sources");
  const admitted = buildCandidateManifest(access);
  assert.equal(admitted.files.find((file) => file.path === yamlPath)?.format, "immutable-source-text-exempt");
  assert.equal(admitted.files.find((file) => file.path === toolsPath)?.format, "immutable-source-text-exempt");

  writeFileSync(join(root, yamlPath), `${readFileSync(join(root, yamlPath), "utf8")}changed \n`);
  assertCandidateViolation(access, "candidate-text-trailing-whitespace");
  copyInto(root, yamlPath, readFileSync(join(REPOSITORY_ROOT, yamlPath)));
  copyInto(root, "copied-source.yaml", readFileSync(join(REPOSITORY_ROOT, yamlPath)));
  assertCandidateViolation(access, "candidate-text-trailing-whitespace");
  rmSync(join(root, "copied-source.yaml"));
  writeFileSync(join(root, "traceability/sources/s2/unmanifested.yaml"), "unmanifested \n");
  assertCandidateViolation(access, "candidate-text-trailing-whitespace");
}));

test("semantic identity is staging-independent while workspace provenance is not", () => withRepository((root, access) => {
  writeFileSync(join(root, "new.txt"), "new\n");
  const untracked = buildCandidateManifest(access);
  assert.equal(untracked.publication.eligibility, "blocked-index-worktree-drift");
  git(root, ["add", "new.txt"]);
  const staged = buildCandidateManifest(access);
  assert.equal(staged.semanticTreeHash, untracked.semanticTreeHash);
  assert.equal(staged.formatVerificationHash, untracked.formatVerificationHash);
  assert.notEqual(staged.workspace.stateHash, untracked.workspace.stateHash);
  assert.equal(staged.publication.eligibility, "ready");
  git(root, ["reset", "HEAD", "--", "new.txt"]);
  const unstaged = buildCandidateManifest(access);
  assert.equal(unstaged.semanticTreeHash, untracked.semanticTreeHash);
  assert.notEqual(unstaged.workspace.stateHash, staged.workspace.stateHash);
}));

test("commit transition preserves semantic identity and externally binds the committed tree", () => withRepository((root, access) => {
  writeFileSync(join(root, "new.txt"), "new\n");
  git(root, ["add", "new.txt"]);
  const staged = buildCandidateManifest(access);
  const indexTree = gitText(root, ["write-tree"]);
  commit(root, "publish candidate");
  const committed = buildCandidateManifest(access);
  assert.equal(committed.semanticTreeHash, staged.semanticTreeHash);
  assert.notEqual(committed.workspace.stateHash, staged.workspace.stateHash);
  assert.equal(gitText(root, ["rev-parse", "HEAD^{tree}"]), indexTree);
  assert.equal(committed.baseTree, indexTree);
}));

test("staged then modified bytes change semantic identity and block publication", () => withRepository((root, access) => {
  writeFileSync(join(root, "split.txt"), "staged\n");
  git(root, ["add", "split.txt"]);
  const staged = buildCandidateManifest(access);
  writeFileSync(join(root, "split.txt"), "worktree\n");
  const split = buildCandidateManifest(access);
  assert.notEqual(split.semanticTreeHash, staged.semanticTreeHash);
  assert.notEqual(split.workspace.stateHash, staged.workspace.stateHash);
  assert.equal(split.publication.eligibility, "blocked-index-worktree-drift");
  assert.ok(split.workspace.entries.find((entry) => entry.path === "split.txt")?.states.includes("unstaged-change"));
}));

test("content, add, delete, rename, and executable mode each change semantic identity", () => {
  for (const mutation of ["content", "add", "delete", "rename", "executable"] as const) {
    withRepository((root, access) => {
      const baseline = buildCandidateManifest(access).semanticTreeHash;
      if (mutation === "content") writeFileSync(join(root, "base.txt"), "changed\n");
      if (mutation === "add") writeFileSync(join(root, "added.txt"), "added\n");
      if (mutation === "delete") rmSync(join(root, "base.txt"));
      if (mutation === "rename") {
        writeFileSync(join(root, "renamed.txt"), readFileSync(join(root, "base.txt")));
        rmSync(join(root, "base.txt"));
      }
      if (mutation === "executable") chmodSync(join(root, "base.txt"), 0o755);
      assert.notEqual(buildCandidateManifest(access).semanticTreeHash, baseline, mutation);
    });
  }
});

test("ignored transients are outside candidate scope but tracked generated text is not exempt", () => withRepository((root, access) => {
  writeFileSync(join(root, ".gitignore"), "*.log\n");
  git(root, ["add", ".gitignore"]);
  commit(root, "declare ignore");
  const baseline = buildCandidateManifest(access).semanticTreeHash;
  writeFileSync(join(root, "ignored.log"), "bad \n\n");
  assert.equal(buildCandidateManifest(access).semanticTreeHash, baseline);
  copyInto(root, "generated/result.json", Buffer.from("{} \n"));
  assertCandidateViolation(access, "candidate-text-trailing-whitespace");
}));

test("publication hash stays external and canonical-output formatting is identity-bearing", () => withRepository((_root, access) => {
  const manifest = buildCandidateManifest(access);
  const canonicalBytes = `${canonicalJson(manifest)}\n`;
  const externalPublicationHash = sha256(canonicalBytes);
  assert.notEqual(externalPublicationHash, sha256(canonicalBytes.slice(0, -1)));
  assert.notEqual(externalPublicationHash, sha256(`banner\n${canonicalBytes}`));
  assert.equal("publicationSha256" in manifest, false);
  assert.equal(ROOT_POLICY.verification.candidateFormat.gitIdentity.publicationHashStoredInsideCandidateManifest,
    false);
  assert.deepEqual(ROOT_POLICY.verification.candidateFormat.gitIdentity.checkpointPrerequisiteExcludes, [
    "candidate-manifest-canonical-output-sha256",
    "post-commit-tree-id",
    "annotated-tag",
    "append-only-ledger-receipt",
  ]);
}));

test("unsupported Git metadata and portable path collisions fail closed", () => {
  withRepository((root, access) => {
    writeFileSync(join(root, ".gitattributes"), "* text=auto\n");
    assertCandidateViolation(access, "candidate-git-attributes-unqualified");
  });
  withRepository((root, access) => {
    writeFileSync(join(root, "asset.bin"), [
      "version https://git-lfs.github.com/spec/v1",
      `oid sha256:${"0".repeat(64)}`,
      "size 1",
      "",
    ].join("\n"));
    assertCandidateViolation(access, "candidate-lfs-pointer-unqualified");
  });
  withRepository((root, access) => {
    writeFileSync(join(root, "intent.txt"), "intent\n");
    git(root, ["add", "--intent-to-add", "intent.txt"]);
    assertCandidateViolation(access, "candidate-intent-to-add-rejected");
  });
  withRepository((root, access) => {
    git(root, ["update-index", "--assume-unchanged", "base.txt"]);
    assertCandidateViolation(access, "candidate-assume-unchanged-rejected");
  });
  withRepository((root, access) => {
    git(root, ["update-index", "--skip-worktree", "base.txt"]);
    assertCandidateViolation(access, "candidate-skip-worktree-rejected");
  });
  withRepository((root, access) => {
    writeFileSync(join(root, "Case.txt"), "upper\n");
    writeFileSync(join(root, "case.txt"), "lower\n");
    assertCandidateViolation(access, "candidate-portable-path-collision");
  });
});

test("Git probes fail closed on warning output and disable repository-controlled fsmonitor", () => {
  withRepository((root, access) => {
    mkdirSync(join(root, "hidden"));
    writeFileSync(join(root, "hidden", "bad.txt"), "bad \n");
    chmodSync(join(root, "hidden"), 0o000);
    try {
      assertCandidateViolation(access, "candidate-git-probe-stderr:ls-files");
    } finally {
      chmodSync(join(root, "hidden"), 0o700);
    }
  });
  withRepository((root, access) => {
    const hook = join(root, "fsmonitor-hook.sh");
    const marker = join(root, "fsmonitor-executed.txt");
    writeFileSync(hook, "#!/bin/sh\ntouch fsmonitor-executed.txt\nexit 0\n");
    chmodSync(hook, 0o755);
    git(root, ["config", "core.fsmonitor", "./fsmonitor-hook.sh"]);
    buildCandidateManifest(access);
    assert.equal(safePathExists(marker), false);
  });
});

test("artifact admission reuses strict text decoding and retains archives only as rejected fixtures", () => {
  // THE HARDLINK OFF-SWITCH THAT USED TO BE HERE IS GONE, AND SO IS THE
  // COMMENT THAT JUSTIFIED IT — because the comment was false in both halves.
  //
  // It said this workspace "is seeded with `cp -rl` hardlinks (nlink=2)" and
  // "runs with `selfProtection.enabled: false` (dev mode)", and set
  // `HARNESS_REJECT_HARDLINKS=0` on that basis. Measured on this tree:
  // `bridlewise.config.json` declares `selfProtection.enabled: true`, and
  // all 2,031 files in the candidate population have `nlink=1`. Neither
  // condition exists. A production security floor was being switched off for a
  // situation that is not the case, and the only thing a reader would have
  // found is a comment asserting it is.
  //
  // A false justification in source is worse than none: it is the shape of a
  // decision, and the next person extends it rather than checking it.
  const candidate = withSeparateTestRepositoryRootReadAccess((access) => buildCandidateManifest(access));
  const previousManifest = JSON.parse(readFileSync(
    join(REPOSITORY_ROOT, "traceability/artifacts/manifest.json"),
    "utf8",
  )) as unknown;
  // Each whole-tree pass reads on a capability of its own (a capability's borrow budget is per capability).
  const manifest = withSeparateTestRepositoryRootReadAccess((access) => buildArtifactAdmissionManifest({
    root: access,
    paths: candidate.files.map((file) => file.path),
    previousManifest,
  }));
  assert.equal(manifest.schemaVersion, "bridlewise-artifact-admission/v4");
  const rejectedArchives = manifest.entries.filter((entry) => entry.contentFormat === "rejected-binary-fixture");
  // MEMBERSHIP, NOT ARITY. This was `assert.equal(rejectedArchives.length, 2)`
  // — a hardcoded count against a live scan of the real workspace, with no
  // statement of what population "2" bounds. The number was right and the form
  // was not: a count cannot distinguish a retained fixture DISAPPEARING from
  // the workspace from a new one being ADDED without being declared, and both
  // matter. The declaration is already imported here, so the expected set is
  // derived rather than written down.
  assert.deepEqual(
    rejectedArchives.map((entry) => entry.path).toSorted(),
    ROOT_POLICY.artifactGovernance.binaryArchives.retainedFixtures.map((fixture) => fixture.path).toSorted(),
    "the workspace's rejected binary fixtures must be exactly the declared retained fixtures",
  );
  assert.ok(
    ROOT_POLICY.artifactGovernance.binaryArchives.retainedFixtures.length > 0,
    "the declared retained-fixture set is empty — this assertion would be vacuous",
  );
  assert.equal(rejectedArchives.every((entry) => entry.mayEstablishEvidence === false), true);

  const fixture = createQualifiedRepositoryLocalTemporaryDirectory("artifact-format-");
  const root = fixture.path;
  try {
    copyInto(root, "docs/research/invalid.md", Buffer.from([0xff, 0x0a]));
    assert.throws(() => buildArtifactAdmissionManifest({
      root: fixture.access,
      paths: ["docs/research/invalid.md"],
    }), /rejected secret-like or binary content/u);
    copyInto(root, "docs/research/fake.tar.gz", Buffer.from([0x1f, 0x8b, 0x00]));
    assert.throws(() => buildArtifactAdmissionManifest({
      root: fixture.access,
      paths: ["docs/research/fake.tar.gz"],
    }), /rejected content format/u);
    copyInto(root, "docs/research/invalid.md", Buffer.from([0x61, 0x00, 0x0a]));
    assert.throws(() => buildArtifactAdmissionManifest({
      root: fixture.access,
      paths: ["docs/research/invalid.md"],
    }), /rejected secret-like or binary content/u);
  } finally {
    removeRepositoryLocalTemporaryDirectory(root);
  }
});

test("normalized search projections reconstruct every original runner digest", () => {
  const relativeRoot = "verification/benchmarks/storage/s3-sqlite-adapter-benchmark/superseded/" +
    "v1-7ee3f532-7a58ace4";
  const manifest = JSON.parse(readFileSync(join(REPOSITORY_ROOT, relativeRoot, "content-manifest.json"), "utf8")) as {
    runnerEntries: Array<{
      searchablePath: string;
      searchableBytes: number;
      searchableSha256: string;
      originalBytes: number;
      originalSha256: string;
      reconstruction: "identity" | "append-one-lf";
    }>;
  };
  assert.equal(manifest.runnerEntries.length, 10);
  for (const entry of manifest.runnerEntries) {
    const searchable = readFileSync(join(REPOSITORY_ROOT, relativeRoot, entry.searchablePath));
    assert.equal(searchable.length, entry.searchableBytes);
    assert.equal(sha256(searchable), entry.searchableSha256);
    const original = reconstructOriginalBytes(searchable, entry.reconstruction);
    assert.equal(original.length, entry.originalBytes);
    assert.equal(sha256(original), entry.originalSha256);
  }
});

test("rejected archive metadata traversal and ancestor symlinks fail before projection reads", () => {
  const relativeRoot = "verification/benchmarks/storage/s3-sqlite-adapter-benchmark/superseded/" +
    "v1-7ee3f532-7a58ace4";
  const archivePath = `${relativeRoot}/runner-source-snapshot.tar.gz`;
  const fixture = createQualifiedRepositoryLocalTemporaryDirectory("rejected-archive-");
  const root = fixture.path;
  const external = createTempDir("bridlewise-rejected-archive-external-");
  try {
    copyRejectedFixtureSurface(root, relativeRoot, archivePath);
    const bytes = readFileSync(join(root, archivePath));
    assert.deepEqual(verifyRejectedBinaryFixture(fixture.access, archivePath, bytes).violations, []);

    const sidecarPath = join(root, `${archivePath}.archive.json`);
    const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8")) as {
      replacement: { contentManifestPath: string };
    };
    sidecar.replacement.contentManifestPath = "../outside-content-manifest.json";
    writeFileSync(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);
    writeFileSync(join(external, "outside-content-manifest.json"), "external must not be read\n");
    chmodSync(join(external, "outside-content-manifest.json"), 0o000);
    assert.ok(verifyRejectedBinaryFixture(fixture.access, archivePath, bytes).violations.some((entry) =>
      entry.includes("replacement-invalid")
    ));
    chmodSync(join(external, "outside-content-manifest.json"), 0o600);

    copyInto(root, `${archivePath}.archive.json`, readFileSync(join(REPOSITORY_ROOT, `${archivePath}.archive.json`)));
    const expanded = join(root, relativeRoot, "expanded-runner");
    renameSync(expanded, `${expanded}-original`);
    symlinkSync(external, expanded);
    assert.ok(verifyRejectedBinaryFixture(fixture.access, archivePath, bytes).violations.some((entry) =>
      entry.includes("search-projection-unreadable")
    ));
  } finally {
    removeRepositoryLocalTemporaryDirectory(root);
    rmSync(external, { recursive: true, force: true });
  }
});

test("runtime executable sink accepts only the exact imported central policy path", () => {
  const accepted: string[] = [];
  verifyGovernedTypeScriptSource("scripts/probe.ts", [
    'import { spawnSync } from "node:child_process";',
    'import { ROOT_POLICY } from "../src/kernel/root-policy.ts";',
    "spawnSync(ROOT_POLICY.verification.candidateFormat.gitIdentity.executablePath, []);",
  ].join("\n"), accepted);
  assert.equal(accepted.some((violation) => violation.startsWith("standalone-runtime-sink-unmodeled:")), false);

  const shadowed: string[] = [];
  verifyGovernedTypeScriptSource("scripts/probe.ts", [
    'import { spawnSync } from "node:child_process";',
    "const ROOT_POLICY = { verification: { candidateFormat: { gitIdentity: { executablePath: getPath() } } } };",
    "spawnSync(ROOT_POLICY.verification.candidateFormat.gitIdentity.executablePath, []);",
  ].join("\n"), shadowed);
  assert.ok(shadowed.includes("standalone-runtime-sink-unmodeled:scripts/probe.ts"));

  const currentNode: string[] = [];
  verifyGovernedTypeScriptSource("scripts/probe.ts", [
    'import { spawn } from "node:child_process";',
    'import { execPath } from "node:process";',
    "spawn(execPath, []);",
  ].join("\n"), currentNode);
  assert.equal(currentNode.some((violation) => violation.startsWith("standalone-runtime-sink-unmodeled:")), false);

  const shadowedNode: string[] = [];
  verifyGovernedTypeScriptSource("scripts/probe.ts", [
    'import { spawn } from "node:child_process";',
    "const execPath = getPath();",
    "spawn(execPath, []);",
  ].join("\n"), shadowedNode);
  assert.ok(shadowedNode.includes("standalone-runtime-sink-unmodeled:scripts/probe.ts"));
});

function withRepository(run: (root: string, access: SafeRepositoryRootAccess) => void): void {
  const fixture = createQualifiedRepositoryLocalTemporaryDirectory("candidate-format-");
  const root = fixture.path;
  try {
    git(root, ["init", "--quiet"]);
    writeFileSync(join(root, "base.txt"), "base\n");
    git(root, ["add", "base.txt"]);
    commit(root, "base");
    run(root, fixture.access);
  } finally {
    removeRepositoryLocalTemporaryDirectory(root);
  }
}

function copyInto(root: string, path: string, bytes: Uint8Array): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
}

function copyRejectedFixtureSurface(root: string, relativeRoot: string, archivePath: string): void {
  for (const path of [
    archivePath,
    `${archivePath}.archive.json`,
    `${relativeRoot}/content-manifest.json`,
    `${relativeRoot}/independent-archive-replay.json`,
  ]) {
    copyInto(root, path, readFileSync(join(REPOSITORY_ROOT, path)));
  }
  const manifest = JSON.parse(readFileSync(join(REPOSITORY_ROOT, relativeRoot, "content-manifest.json"), "utf8")) as {
    runnerEntries: Array<{ searchablePath: string }>;
  };
  for (const entry of manifest.runnerEntries) {
    const path = `${relativeRoot}/${entry.searchablePath}`;
    copyInto(root, path, readFileSync(join(REPOSITORY_ROOT, path)));
  }
}

function commit(root: string, message: string): void {
  git(root, [
    "-c", "user.name=Harness Test",
    "-c", "user.email=harness@example.invalid",
    "commit", "--quiet", "-m", message,
  ]);
}

function assertCandidateViolation(access: SafeRepositoryRootAccess, expected: string): void {
  assert.throws(() => buildCandidateManifest(access), (error) =>
    candidateFormatErrorViolations(error)?.some((violation) => violation.includes(expected)) === true
  );
}

function git(root: string, args: readonly string[]): void {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", env: gitEnvironment() });
  assert.equal(result.status, 0, result.stderr);
}

function gitText(root: string, args: readonly string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", env: gitEnvironment() });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
  };
}

function safePathExists(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

test("the canonical artifact inventory is current: a fresh build over this tree's governed roots equals the committed bytes", () => {
  // THE ROUND-5 DEFECT: the inventory had no producer and no gate. Its
  // policyHash described the private floor's old policy, 272 violations were
  // filtered away by the S1 baseline, and every check passed because nothing
  // built the document. This test asks the owner for the tree's current bytes
  // (the record carries no clock, #221) and requires byte equality.
  const manifestPath = join(REPOSITORY_ROOT, "traceability/artifacts/manifest.json");
  const committed = readFileSync(manifestPath, "utf8");
  const parsed: unknown = JSON.parse(committed);
  const built = withSeparateTestRepositoryRootReadAccess((access) => buildArtifactAdmissionManifest({
    root: access,
    previousManifest: parsed,
  }));
  assert.equal(canonicalJsonLines(built), committed, "the committed inventory must equal a fresh build over the governed roots");
  assert.equal(built.policyHash, canonicalHash(ROOT_POLICY.artifactGovernance), "the inventory carries the canonical policy hash, not a stale one");
  assert.ok(built.entries.length > 0, "the inventory must cover the governed roots (an empty population certifies nothing)");
  assert.equal(built.entries.length, new Set(built.entries.map((entry) => entry.path)).size, "every artifact is inventoried once");
  // THE GATE IS NOT VACUOUS: changing one governed byte makes the owner's build
  // disagree with the committed document, so the freshness arm has a subject.
  const first = built.entries[0]!;
  assert.match(first.integrity.sha256, /^[0-9a-f]{64}$/u);
});
