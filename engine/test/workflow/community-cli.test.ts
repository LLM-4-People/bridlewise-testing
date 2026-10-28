/**
 * THE `harness community` DOOR, driven (`src/workflow/community/community-cli.ts`):
 * a verb it does not know, or one missing its arguments, is the typed
 * `community_usage` naming every verb; `credit` answers the contributors of a
 * revision range of this repository, the tooling excluded.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { HarnessError } from "../../src/kernel/errors.ts";
import { runCommunityCli } from "../../src/workflow/community/community-cli.ts";

const ENGINE = fileURLToPath(new URL("../../", import.meta.url));

function usage(error: unknown): boolean {
  return error instanceof HarnessError && error.code === "community_usage" && /harness community takes:/u.test(error.message);
}

test("an unknown verb, or a verb missing its arguments, is the typed usage refusal", async () => {
  for (const argv of [[], ["bogus"], ["comment"], ["comment", "--event", "e.json"], ["issue"], ["thank"], ["thank", "--commit", "abc"], ["thank", "--pull", "7"], ["credit"], ["credit", "--range", "a;b"], ["spam-signal"], ["categories", "extra"], ["limit", "--apply", "everyone", "--expiry", "one_week"], ["limit", "--remove", "--apply", "existing_users"]]) {
    await assert.rejects(runCommunityCli(ENGINE, argv), usage, JSON.stringify(argv));
  }
});

test("credit reads its range from GitHub by login: a malformed range is refused before any request", async () => {
  for (const argv of [["credit", "--range", "HEAD"], ["credit", "--range", "a..b", "--before", "nope"], ["thank", "--before", "1".repeat(40)], ["thank", "--before", "x", "--after", "2".repeat(40)]]) {
    await assert.rejects(runCommunityCli(ENGINE, argv), usage, JSON.stringify(argv));
  }
});
