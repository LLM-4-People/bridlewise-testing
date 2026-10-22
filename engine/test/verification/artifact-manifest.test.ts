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
import { UNCOMMITTED_GOVERNED_PATHS } from "../../src/kernel/verification-paths.ts";
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

function readManifest(root: string): Record<string, unknown> & {
  entries: Array<{ path: string; origin: Record<string, string> }>;
} {
  return JSON.parse(readFileSync(join(root, ARTIFACT_MANIFEST_PATH), "utf8"));
}

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

test("artifact-manifest: a never-committed governed-root path is ignored by the versioned rules and never admitted", () => {
  // Each is ignored by THIS tree's own .gitignore (never only a machine's exclude): no commit can hold it.
  const engine = join(import.meta.dirname, "..", "..");
  for (const uncommitted of UNCOMMITTED_GOVERNED_PATHS) {
    const probe = uncommitted.endsWith("/") ? `${uncommitted}probe.txt` : uncommitted;
    const ignored = spawnSync("git", ["check-ignore", "--no-index", "--verbose", "--", probe], { cwd: engine, encoding: "utf8" });
    assert.equal(ignored.status, 0, `${probe} is ignored: ${ignored.stderr}`);
    assert.match(ignored.stdout, /^engine\/\.gitignore:\d+:/u, `${probe} is ignored by engine/.gitignore: ${ignored.stdout}`);
  }
  // Planted on disk, none enters the inventory: a manifest entry for it would be a governed artifact no commit holds.
  const root = makeFixture();
  try {
    for (const uncommitted of UNCOMMITTED_GOVERNED_PATHS) {
      writeRelative(root, uncommitted.endsWith("/") ? `${uncommitted}t/planted.sh` : uncommitted, "never committed\n");
    }
    assert.equal(syncArtifactManifest(root, { write: true }).entries, GOVERNED.length);
    assert.deepEqual(readManifest(root).entries.map((entry) => entry.path).toSorted(), [...GOVERNED].toSorted());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("artifact-manifest: two branches that change different artifacts merge cleanly into the manifest of both (#221)", () => {
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
  // Entries sort by path (traceability/README.md, traceability/canonical/…, verification/…): the two edited
  // artifacts' lines have an unchanged one between them, as any two artifacts of a real tree almost always do.
  const ours = manifestAfter({ [GOVERNED[1]]: "edited on one branch\n" });
  const theirs = manifestAfter({ [GOVERNED[2]]: "edited on the other branch\n" });
  const both = manifestAfter({ [GOVERNED[1]]: "edited on one branch\n", [GOVERNED[2]]: "edited on the other branch\n" });
  const dir = createTempDir("artifact-manifest-merge-");
  try {
    writeFileSync(join(dir, "ours"), ours);
    writeFileSync(join(dir, "base"), base);
    writeFileSync(join(dir, "theirs"), theirs);
    const merged = spawnSync("git", ["merge-file", "-p", join(dir, "ours"), join(dir, "base"), join(dir, "theirs")], { encoding: "utf8" });
    assert.equal(merged.status, 0, `the two branches' manifests conflicted:\n${merged.stdout}`);
    assert.equal(merged.stdout, both, "the clean merge is exactly the manifest of both changes");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("artifact-manifest: a hand-edited origin.license or producingTool reds --check and is replaced, never reused", () => {
  for (const [field, value] of [["license", "unknown"], ["producingTool", "rogue-tool"]] as const) {
    const root = makeFixture();
    try {
      syncArtifactManifest(root, { write: true });
      const path = join(root, ARTIFACT_MANIFEST_PATH);
      const committed = readFileSync(path, "utf8");
      const parsed = readManifest(root);
      const target = parsed.entries[0]!.origin[field]!;
      assert.equal(target.length > 0, true);
      const edited = committed.replace(`"${field}":"${target}"`, `"${field}":"${value}"`);
      assert.notEqual(edited, committed, `the ${field} mutation must change the document`);
      writeFileSync(path, edited);
      const drifted = syncArtifactManifest(root, { write: false });
      assert.equal(drifted.allCurrent, false, `a hand-edited origin.${field} must not be current`);
      // THE OLD BEHAVIOUR: the producer reused the prior origin by digest, so
      // `--write` reproduced the edit. The claim is now replaced by the
      // mechanical capture the licence authority derives.
      syncArtifactManifest(root, { write: true });
      const healed = readManifest(root);
      assert.equal(healed.entries[0]!.origin[field], target, `the producer republishes the admitted ${field}`);
      assert.equal(syncArtifactManifest(root, { write: false }).allCurrent, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("artifact-manifest: the provenance policy refuses an unadmitted origin", () => {
  const root = makeFixture();
  try {
    syncArtifactManifest(root, { write: true });
    const manifest = readManifest(root);
    // The committed document passes its own policy.
    assert.deepEqual([...artifactProvenanceViolations(manifest as never)], []);
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
    const parsed = readManifest(root);
    const tampered = structuredClone(parsed) as never as {
      entries: Array<{ origin: Record<string, string> }>;
    };
    tampered.entries[0]!.origin["producingTool"] = "rogue-tool";
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
