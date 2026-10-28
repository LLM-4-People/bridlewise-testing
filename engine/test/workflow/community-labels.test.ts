/**
 * THE COMMUNITY LABELS AS CODE (`src/workflow/community/labels.ts`): the
 * registry refuses what GitHub would not store; a declared label missing or
 * different in colour or description is drift (names compared without case,
 * as GitHub does); the repository's other labels are listed, not judged; the
 * live read is paginated on the forge port (the fake GitHub).
 */
import assert from "node:assert/strict";
import { cpSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { HarnessError } from "../../src/kernel/errors.ts";
import { labelDrift, LABELS_PATH, liveLabels, readLabels } from "../../src/workflow/community/labels.ts";
import { memoryCredential } from "../../src/workflow/forge/credentials.ts";
import { githubClient } from "../../src/workflow/forge/github.ts";
import { fakeGithub } from "../forge/fake-github.ts";
import { withTempDir } from "../support/temp-dir.ts";

const REPOSITORY = dirname(fileURLToPath(new URL("../../", import.meta.url)));
const declared = readLabels(REPOSITORY);

test("a repository holding every declared label as declared has no drift, and its other labels are listed", () => {
  const live = [...declared, { name: "lane:floor", color: "1d76db", description: "x" }, { name: "ui", color: "ededed", description: "" }];
  assert.deepEqual(labelDrift(declared, live), { drift: [], others: ["lane:floor", "ui"] });
});

test("a missing label, a case-only rename and a changed colour or description are drift; names match without case", () => {
  const [first, second, ...rest] = declared;
  const live = [{ ...first!, name: first!.name.toUpperCase(), color: "000000" }, ...rest.map((label) => ({ ...label, description: "changed" }))];
  const { drift, others } = labelDrift(declared, live);
  assert.deepEqual(drift.map((entry) => `${entry.name}:${entry.kind}`), [`${first!.name}:name`, `${first!.name}:color`, `${second!.name}:missing`, ...rest.map((label) => `${label.name}:description`)]);
  assert.deepEqual(others, [], "a case-only rename is the declared label, never an other");
  assert.match(drift[0]!.detail, new RegExp(`spelled "${first!.name.toUpperCase()}" on GitHub`, "u"));
});

test("the registry refuses a colour GitHub would not store and a name declared twice", () => {
  withTempDir("community-labels-", (root) => {
    cpSync(join(REPOSITORY, "docs/community"), join(root, "docs/community"), { recursive: true });
    for (const labels of [[{ name: "a", color: "#ffffff", description: "" }], [{ name: "a", color: "ffffff", description: "" }, { name: "A", color: "000000", description: "" }]]) {
      writeFileSync(join(root, LABELS_PATH), JSON.stringify({ schema: "bridlewise-community-labels/v1", labels }));
      assert.throws(() => readLabels(root), (error: unknown) => error instanceof HarnessError && error.code === "community_source_invalid", JSON.stringify(labels));
    }
  });
});

test("the live labels are read page by page on the forge port", async () => {
  const fake = fakeGithub();
  fake.objects.set("/repos/o/r/labels", Array.from({ length: 150 }, (_, index) => ({ name: `l${String(index)}`, color: "ABCDEF", description: index === 0 ? null : "d" })));
  const client = githubClient(fake.endpoint(), memoryCredential("user:maintainer", fake.userToken("maintainer")));
  const labels = await liveLabels(client, "o", "r", 5);
  assert.equal(labels.length, 150);
  assert.deepEqual(labels[0], { name: "l0", color: "abcdef", description: "" });
});
