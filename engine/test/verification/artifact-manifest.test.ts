import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  ARTIFACT_MANIFEST_PATH,
  artifactProvenanceViolations,
  buildArtifactAdmissionManifest,
} from "../../scripts/tooling/verification/artifact-admission.ts";
import { syncArtifactManifest } from "../../scripts/tooling/artifact-manifest.ts";
import { rawSafeRepositoryRootAccess } from "../../scripts/verification/safe-repository-reader.ts";
import { createTempDir } from "../support/temp-dir.ts";

/**
 * THE ARTIFACT INVENTORY'S PRODUCER — provenance is PRODUCED, and a population
 * drop is a decision.
 *
 * The defects this file pins:
 *  - a capture stamp and `origin.{license,producingTool}` were read back out of
 *    the document (the prior entry's origin was reused by digest wholesale),
 *    so a hand edit passed `--check`, passed `harness check`, and survived
 *    `harness regenerate` while `artifactAdmissionViolations` refused the same
 *    bytes;
 *  - deleting a governed artifact silently pruned its entry (500 -> 499, no
 *    supersession record), because the producer compared nothing with the
 *    previous entry set.
 */

const GOVERNED = [
  "traceability/canonical/harness-requirements.md",
  "traceability/README.md",
  "verification/benchmarks/test/README.md",
] as const;

function writeRelative(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function makeFixture(): string {
  const root = createTempDir("artifact-manifest-");
  for (const path of GOVERNED) writeRelative(root, path, `content of ${path}\n`);
  return root;
}

/** The committed record: each governed artifact's path, and an authored origin with its bytes where there is one. */
function readManifest(root: string): Record<string, unknown> & {
  artifacts: Array<{ path: string; origin?: Record<string, string>; integrity?: { byteLength: number; sha256: string } }>;
} {
  return JSON.parse(readFileSync(join(root, ARTIFACT_MANIFEST_PATH), "utf8"));
}

/** The full admission manifest of the fixture, derived from its tree and its record. */
const derived = (root: string) => buildArtifactAdmissionManifest({ root: rawSafeRepositoryRootAccess(root), previousManifest: readManifest(root) });

test("artifact-manifest: the producer reads no clock — one tree gives the same bytes at any two times, one entry per line (#221)", (t) => {
  const root = makeFixture();
  try {
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-01-01T00:00:00Z") });
    const written = syncArtifactManifest(root, { write: true });
    assert.equal(written.status, "written");
    assert.equal(written.entries, GOVERNED.length);
    const committed = readFileSync(join(root, ARTIFACT_MANIFEST_PATH), "utf8");
    assert.doesNotMatch(committed, /capturedAt|generatedAt/u, "no wall-clock stamp in the record");
    const lines = committed.split("\n");
    for (const path of GOVERNED) {
      assert.equal(lines.filter((line) => line.includes(`"path":"${path}"`)).length, 1, `${path} has a line of its own`);
    }
    // A year later, the same tree: the same bytes, current, and a write changes nothing.
    t.mock.timers.setTime(Date.parse("2027-06-15T12:34:56Z"));
    assert.equal(syncArtifactManifest(root, { write: false }).allCurrent, true, "a run at another time over one tree is byte-identical");
    assert.equal(syncArtifactManifest(root, { write: true }).status, "current");
    assert.equal(readFileSync(join(root, ARTIFACT_MANIFEST_PATH), "utf8"), committed);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("artifact-manifest: an edit to a governed artifact rewrites nothing; two branches adding different artifacts merge (#221)", () => {
  const manifestAfter = (edits: Readonly<Record<string, string>>): string => {
    const root = makeFixture();
    try {
      for (const [path, text] of Object.entries(edits)) writeRelative(root, path, text);
      syncArtifactManifest(root, { write: true });
      return readFileSync(join(root, ARTIFACT_MANIFEST_PATH), "utf8");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  const base = manifestAfter({});
  // No committed digest of a mechanically captured artifact: an edit changes nothing here.
  assert.equal(manifestAfter({ [GOVERNED[1]]: "edited on one branch\n" }), base, "an edit rewrites nothing");
  // Two new artifacts on two branches: one line each, and git's own merge holds both.
  const ours = manifestAfter({ "traceability/added-on-one-branch.md": "a\n" });
  const theirs = manifestAfter({ "verification/benchmarks/test/added-on-another.md": "b\n" });
  const both = manifestAfter({ "traceability/added-on-one-branch.md": "a\n", "verification/benchmarks/test/added-on-another.md": "b\n" });
  const dir = createTempDir("artifact-manifest-merge-");
  try {
    writeFileSync(join(dir, "ours"), ours);
    writeFileSync(join(dir, "base"), base);
    writeFileSync(join(dir, "theirs"), theirs);
    const merged = spawnSync("git", ["merge-file", "-p", join(dir, "ours"), join(dir, "base"), join(dir, "theirs")], { encoding: "utf8" });
    assert.equal(merged.status, 0, `the two branches' records conflicted:\n${merged.stdout}`);
    assert.equal(merged.stdout, both, "the clean merge is exactly the record of both changes");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("artifact-manifest: a hand-written origin that is not admitted reds --check and is replaced by the mechanical capture, never reused", () => {
  for (const [field, value] of [["license", "unknown"], ["producingTool", "rogue-tool"]] as const) {
    const root = makeFixture();
    try {
      syncArtifactManifest(root, { write: true });
      const path = join(root, ARTIFACT_MANIFEST_PATH);
      const committed = readFileSync(path, "utf8");
      // The plant: the first artifact's mechanical origin written into the record with one field edited, for its exact bytes.
      const entry = derived(root).entries[0]!;
      const forged = { path: entry.path, origin: { ...entry.origin, [field]: value }, integrity: entry.integrity };
      const edited = committed.replace(`{"path":"${entry.path}"}`, JSON.stringify(forged));
      assert.notEqual(edited, committed, `the ${field} plant must change the record`);
      writeFileSync(path, edited);
      assert.equal(syncArtifactManifest(root, { write: false }).allCurrent, false, `a hand-written origin.${field} must not be current`);
      syncArtifactManifest(root, { write: true });
      assert.equal(readFileSync(path, "utf8"), committed, `the producer replaces the unadmitted ${field} with the mechanical capture`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("artifact-manifest: the provenance policy refuses an unadmitted origin", () => {
  const root = makeFixture();
  try {
    syncArtifactManifest(root, { write: true });
    const manifest = derived(root);
    // The derived document passes its own policy.
    assert.deepEqual([...artifactProvenanceViolations(manifest)], []);
    const tampered = structuredClone(manifest) as never as {
      entries: Array<{ id: string; origin: Record<string, string> }>;
    };
    tampered.entries[0]!.origin["license"] = "unknown";
    assert.ok(
      artifactProvenanceViolations(tampered as never).includes("artifact-origin-not-admitted:" + tampered.entries[0]!.id),
      "an unadmitted origin must be named by the shared policy",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("artifact-manifest: a deleted governed artifact is refused unless named, and naming it prunes one entry", () => {
  const root = makeFixture();
  try {
    syncArtifactManifest(root, { write: true });
    const removed = GOVERNED[2];
    rmSync(join(root, removed));
    // THE DEFECT: this used to rewrite 500 entries as 499 and the check went
    // green with no supersession record. The producer refuses instead.
    assert.throws(
      () => syncArtifactManifest(root, { write: false }),
      /governed artifact\(s\) disappeared/u,
    );
    assert.throws(
      () => syncArtifactManifest(root, { write: true }),
      (error: unknown) => {
        assert.match(String((error as Error).message), /--prune verification\/benchmarks\/test\/README\.md/u);
        return true;
      },
      "the refusal must name the exact way out",
    );
    // A prune that names a PRESENT artifact is not a deletion.
    assert.throws(
      () => syncArtifactManifest(root, { write: true, prune: [GOVERNED[0]] }),
      /still exist under the governed roots/u,
    );
    const pruned = syncArtifactManifest(root, { write: true, prune: [removed] });
    assert.equal(pruned.entries, GOVERNED.length - 1);
    assert.deepEqual([...pruned.dropped], [removed]);
    assert.equal(syncArtifactManifest(root, { write: false }).allCurrent, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("artifact-manifest: a canonical authority is append-only and cannot be pruned", () => {
  const root = makeFixture();
  try {
    syncArtifactManifest(root, { write: true });
    const canonical = GOVERNED[0];
    rmSync(join(root, canonical));
    assert.throws(
      () => syncArtifactManifest(root, { write: true, prune: [canonical] }),
      /append-only and cannot be pruned/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("artifact-manifest: the builder refuses a previous origin that is not one of the pinned shapes", () => {
  const root = makeFixture();
  try {
    const built = syncArtifactManifest(root, { write: true });
    assert.equal(built.entries, GOVERNED.length);
    const record = readManifest(root);
    const entry = derived(root).entries[0]!;
    const tampered = { ...record, artifacts: record.artifacts.map((artifact) => artifact.path === entry.path ? { path: entry.path, origin: { ...entry.origin, producingTool: "rogue-tool" }, integrity: entry.integrity } : artifact) };
    const rebuilt = buildArtifactAdmissionManifest({
      root: rawSafeRepositoryRootAccess(root),
      previousManifest: tampered,
    });
    assert.notEqual(
      rebuilt.entries[0]!.origin.producingTool,
      "rogue-tool",
      "an unadmitted prior origin is not reused — the mechanical capture replaces it",
    );
    assert.deepEqual([...artifactProvenanceViolations(rebuilt)], [], "the rebuilt document is admissible");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
