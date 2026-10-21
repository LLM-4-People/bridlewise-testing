import assert from "node:assert/strict";
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
 *  - `generatedAt` and `origin.{license,producingTool}` were read back out of
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
  generatedAt: string;
  entries: Array<{ path: string; origin: Record<string, string> }>;
} {
  return JSON.parse(readFileSync(join(root, ARTIFACT_MANIFEST_PATH), "utf8"));
}

test("artifact-manifest: the producer derives generatedAt from the captures and is byte-stable", () => {
  const root = makeFixture();
  try {
    const written = syncArtifactManifest(root, { write: true });
    assert.equal(written.status, "written");
    assert.equal(written.entries, GOVERNED.length);
    const committed = readFileSync(join(root, ARTIFACT_MANIFEST_PATH), "utf8");
    const manifest = readManifest(root);
    const latestCapture = manifest.entries
      .map((entry) => entry.origin.capturedAt)
      .toSorted()
      .at(-1);
    assert.equal(manifest.generatedAt, latestCapture, "the document stamp is the latest capture, not a value the document chose");
    assert.equal(syncArtifactManifest(root, { write: false }).allCurrent, true, "a second run over one tree must be byte-stable");
    assert.equal(syncArtifactManifest(root, { write: true }).status, "current");
    assert.equal(readFileSync(join(root, ARTIFACT_MANIFEST_PATH), "utf8"), committed);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("artifact-manifest: a hand-edited generatedAt reds --check and the next write restores the derived stamp", () => {
  const root = makeFixture();
  try {
    syncArtifactManifest(root, { write: true });
    const path = join(root, ARTIFACT_MANIFEST_PATH);
    const committed = readFileSync(path, "utf8");
    // A SURGICAL edit: only the timestamp differs, so the byte compare is the
    // only thing that can catch it — and it does, because the rebuild derives
    // the stamp from the captures instead of reading this one back.
    const edited = committed.replace(/"generatedAt":"[^"]+"/u, '"generatedAt":"2020-01-01T00:00:00Z"');
    assert.notEqual(edited, committed);
    writeFileSync(path, edited);
    const drifted = syncArtifactManifest(root, { write: false });
    assert.equal(drifted.allCurrent, false, "a hand-edited document stamp is not current");
    assert.equal(drifted.status, "stale");
    syncArtifactManifest(root, { write: true });
    assert.equal(readFileSync(path, "utf8"), committed, "the producer republishes its derived stamp");
  } finally {
    rmSync(root, { recursive: true, force: true });
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

test("artifact-manifest: the provenance policy refuses an unadmitted origin and a stamp the entries do not derive", () => {
  const root = makeFixture();
  try {
    syncArtifactManifest(root, { write: true });
    const manifest = readManifest(root);
    // The committed document passes its own policy.
    assert.deepEqual([...artifactProvenanceViolations(manifest as never)], []);
    const tampered = structuredClone(manifest) as never as {
      generatedAt: string;
      entries: Array<{ id: string; origin: Record<string, string> }>;
    };
    tampered.entries[0]!.origin["license"] = "unknown";
    assert.ok(
      artifactProvenanceViolations(tampered as never).includes("artifact-origin-not-admitted:" + tampered.entries[0]!.id),
      "an unadmitted origin must be named by the shared policy",
    );
    const restamped = structuredClone(manifest) as never as { generatedAt: string };
    restamped.generatedAt = "2020-01-01T00:00:00Z";
    assert.ok(
      artifactProvenanceViolations(restamped as never).includes("artifact-generated-at-not-derived-from-captures"),
      "a stamp the entries do not derive must be named by the shared policy",
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
      generatedAt: "2026-10-21T00:00:00Z",
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
