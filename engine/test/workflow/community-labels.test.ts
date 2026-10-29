/**
 * THE LABELS, DECLARED ONCE (`src/workflow/community/labels.ts`): the one
 * label declaration reads back as written, and refuses what GitHub would not
 * store (a colour GitHub would not keep, a name declared twice in any case).
 * Its drift on GitHub is the forge's (`harness forge plan`), never a second
 * audit here.
 */
import assert from "node:assert/strict";
import { cpSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { HarnessError } from "../../src/kernel/errors.ts";
import { LABELS_PATH, readLabels } from "../../src/workflow/community/labels.ts";
import { withTempDir } from "../support/temp-dir.ts";

const REPOSITORY = dirname(fileURLToPath(new URL("../../", import.meta.url)));

test("the declaration holds the community, Dependabot, lane and forge-marker labels, each once", () => {
  const names = readLabels(REPOSITORY).map((label) => label.name);
  for (const name of ["good first issue", "help wanted", "dependencies", "javascript", "lane:gh-9", "lane:floor", "lane:roadmap", "lane:flaky-burn-down", "lane:private-web", "forge-drift", "ci-failure"]) assert.ok(names.includes(name), name);
  assert.equal(new Set(names.map((name) => name.toLowerCase())).size, names.length);
});

test("the declaration refuses a colour GitHub would not store and a name declared twice in any case", () => {
  withTempDir("community-labels-", (root) => {
    cpSync(join(REPOSITORY, "docs/community"), join(root, "docs/community"), { recursive: true });
    for (const labels of [[{ name: "a", color: "#ffffff", description: "" }], [{ name: "a", color: "ffffff", description: "" }, { name: "A", color: "000000", description: "" }]]) {
      writeFileSync(join(root, LABELS_PATH), JSON.stringify({ schema: "bridlewise-community-labels/v1", labels }));
      assert.throws(() => readLabels(root), (error: unknown) => error instanceof HarnessError && error.code === "community_source_invalid", JSON.stringify(labels));
    }
  });
});

test("a declaration that is not JSON, or is missing, is refused before anything reads it", () => {
  withTempDir("community-labels-", (root) => {
    cpSync(join(REPOSITORY, "docs/community"), join(root, "docs/community"), { recursive: true });
    writeFileSync(join(root, LABELS_PATH), "{not json");
    assert.throws(() => readLabels(root), (error: unknown) => error instanceof HarnessError && error.code === "community_source_invalid" && error.message.includes(LABELS_PATH));
    rmSync(join(root, LABELS_PATH));
    assert.throws(() => readLabels(root), (error: unknown) => error instanceof HarnessError && error.code === "community_source_invalid" && error.message.includes("missing"));
  });
});
