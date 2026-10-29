/**
 * GITHUB'S OWN VERDICT ON A COMMIT'S SIGNATURE (`commitSignedByGitHub`): true
 * only when GitHub reports the signature valid AND made by GitHub; an unsigned
 * commit is false; a commit GitHub does not hold is a typed refusal, never false.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { ForgeClient } from "../../src/workflow/forge/port.ts";
import { isForgeError } from "../../src/workflow/forge/codes.ts";
import { commitSignedByGitHub } from "../../src/workflow/forge/repository-reads.ts";

/** A client whose GraphQL answer is `answer`, recording the variables it was asked with. */
function client(answer: unknown, asked: Record<string, unknown>[] = []): ForgeClient {
  return { graphql: async (_query: string, variables?: Readonly<Record<string, unknown>>) => { asked.push({ ...variables }); return answer; } } as unknown as ForgeClient;
}

test("signed by GitHub only when the signature is valid AND GitHub made it; unsigned is false; an unknown commit refuses typed", async () => {
  const commit = (signature: unknown) => ({ repository: { object: { signature } } });
  const asked: Record<string, unknown>[] = [];
  assert.equal(await commitSignedByGitHub(client(commit({ isValid: true, wasSignedByGitHub: true }), asked), "o/r", "abc"), true);
  assert.deepEqual(asked, [{ owner: "o", name: "r", oid: "abc" }]);
  assert.equal(await commitSignedByGitHub(client(commit({ isValid: true, wasSignedByGitHub: false })), "o/r", "abc"), false, "a valid signature someone else made");
  assert.equal(await commitSignedByGitHub(client(commit({ isValid: false, wasSignedByGitHub: true })), "o/r", "abc"), false, "an invalid signature");
  assert.equal(await commitSignedByGitHub(client(commit(null)), "o/r", "abc"), false, "an unsigned commit");
  await assert.rejects(commitSignedByGitHub(client({ repository: { object: null } }), "o/r", "abc"), (error: unknown) => isForgeError(error, "github_not_found"));
});
