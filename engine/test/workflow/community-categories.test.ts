/**
 * THE DISCUSSION CATEGORIES, AUDITED (`src/workflow/community/categories.ts`):
 * the registry's live categories must exist on GitHub with their name,
 * answerability and description; a planned one that exists is flagged to flip
 * live; an undeclared one is named; the live read is one GraphQL query on the
 * forge port (the fake GitHub).
 */
import assert from "node:assert/strict";
import { dirname } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { categoryDrift, liveCategories, type LiveCategory } from "../../src/workflow/community/categories.ts";
import { runCommunityCli } from "../../src/workflow/community/community-cli.ts";
import { readIntake } from "../../src/workflow/community/sources.ts";
import { HarnessError } from "../../src/kernel/errors.ts";
import { memoryCredential } from "../../src/workflow/forge/credentials.ts";
import { githubClient } from "../../src/workflow/forge/github.ts";
import { fakeGithub } from "../forge/fake-github.ts";

const REPOSITORY = dirname(fileURLToPath(new URL("../../", import.meta.url)));
const declared = readIntake(REPOSITORY).discussionCategories;

/** The repository exactly as the registry declares it: every live category, nothing planned. */
function matching(): LiveCategory[] {
  return declared.filter((category) => "live" in category.status).map((category) => ({ slug: category.slug, name: category.name, answerable: category.format === "question-answer", description: category.use }));
}

test("a repository that matches the registry has no drift", () => {
  assert.deepEqual(categoryDrift(declared, matching()), []);
});

test("every kind of drift is named with what to do", () => {
  const live = matching();
  const qa = live.find((category) => category.slug === "q-a")!;
  const general = live.find((category) => category.slug === "general")!;
  const drifted = [
    ...live.filter((category) => category.slug !== "ideas" && category.slug !== "q-a" && category.slug !== "general"),
    { ...qa, answerable: false, name: "Questions" },
    { ...general, description: "Chat about anything and everything here" },
    { slug: "rfcs", name: "RFCs", answerable: false, description: declared.find((category) => category.slug === "rfcs")!.use },
    { slug: "random", name: "Random", answerable: false, description: "" },
  ];
  const drift = categoryDrift(declared, drifted);
  assert.deepEqual(drift.map((entry) => `${entry.slug}:${entry.kind}`), ["general:description", "ideas:missing", "q-a:answerable", "q-a:name", "random:undeclared", "rfcs:now-live"]);
  assert.match(drift.find((entry) => entry.kind === "missing")!.detail, /create it \(format open-ended/u);
});

test("the live categories are one GraphQL read on the forge port, and the verb refuses what it does not know", async () => {
  const fake = fakeGithub();
  fake.route("POST", /^\/graphql$/u, (request) => {
    const body = request.body as { variables: { owner: string; name: string } };
    assert.deepEqual(body.variables, { owner: "o", name: "r" });
    return { status: 200, body: { data: { repository: { discussionCategories: { nodes: [{ slug: "q-a", name: "Q&A", isAnswerable: true, description: null }] } } } } };
  });
  const client = githubClient(fake.endpoint(), memoryCredential("user:maintainer", fake.userToken("maintainer")));
  assert.deepEqual(await liveCategories(client, "o", "r"), [{ slug: "q-a", name: "Q&A", answerable: true, description: "" }]);
  for (const argv of [[], ["categories", "extra"], ["labels"]]) {
    await assert.rejects(runCommunityCli(REPOSITORY, argv), (error: unknown) => error instanceof HarnessError && error.code === "community_usage", JSON.stringify(argv));
  }
});
