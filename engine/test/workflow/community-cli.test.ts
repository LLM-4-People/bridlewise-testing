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

test("credit answers the contributors of a range of this repository (HEAD: a shallow checkout holds it too)", async () => {
  const answer = await runCommunityCli(ENGINE, ["credit", "--range", "HEAD"]);
  const result = answer.result.result as { verb: string; all: readonly { email: string; commits: readonly string[] }[]; newcomers: readonly unknown[] };
  assert.equal(result.verb, "credit");
  assert.ok(result.all.length >= 1);
  assert.ok(result.all.every((person) => !/\[bot\]/u.test(person.email) && person.commits.length >= 1));
  assert.deepEqual(result.newcomers, []);
});
