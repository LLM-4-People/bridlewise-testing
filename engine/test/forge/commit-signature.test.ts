/**
 * GITHUB'S OWN VERDICT ON A COMMIT'S SIGNATURE (`commitVerification`): true
 * only when GitHub reports the signature valid AND made by GitHub; an unsigned
 * commit is false; a commit GitHub does not hold is a typed refusal, never false.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { ForgeClient } from "../../src/workflow/forge/port.ts";
import { isForgeError } from "../../src/workflow/forge/codes.ts";
import { commitVerification } from "../../src/workflow/forge/repository-reads.ts";

/** A client whose GraphQL answer is `answer`, recording the variables it was asked with. */
function client(answer: unknown, asked: Record<string, unknown>[] = []): ForgeClient {
  return { graphql: async (_query: string, variables?: Readonly<Record<string, unknown>>) => { asked.push({ ...variables }); return answer; } } as unknown as ForgeClient;
}

test("signed by GitHub only when the signature is valid AND GitHub made it; unsigned is false; an unknown commit refuses typed", async () => {
  const commit = (signature: unknown) => ({ repository: { object: { oid: "abc", signature } } });
  const asked: Record<string, unknown>[] = [];
  assert.equal((await commitVerification(client(commit({ isValid: true, wasSignedByGitHub: true }), asked), "o/r", "abc")).signedByGitHub, true);
  assert.deepEqual(asked, [{ owner: "o", name: "r", oid: "abc" }]);
  assert.equal((await commitVerification(client(commit({ isValid: true, wasSignedByGitHub: false })), "o/r", "abc")).signedByGitHub, false, "a valid signature someone else made");
  assert.equal((await commitVerification(client(commit({ isValid: false, wasSignedByGitHub: true })), "o/r", "abc")).signedByGitHub, false, "an invalid signature");
  assert.equal((await commitVerification(client(commit(null)), "o/r", "abc")).signedByGitHub, false, "an unsigned commit");
  await assert.rejects(commitVerification(client({ repository: { object: null } }), "o/r", "abc"), (error: unknown) => isForgeError(error, "github_not_found"));
});

test("verification binds the exact queried oid and its author account; absent account association stays absent", async () => {
  const author = { name: "example-app[bot]", email: "10000+example-app[bot]@users.noreply.github.com", user: { login: "example-app[bot]" } };
  const object = { oid: "abc", author, signature: { isValid: true, wasSignedByGitHub: true } };
  assert.deepEqual(await commitVerification(client({ repository: { object } }), "o/r", "abc"), {
    oid: "abc", signedByGitHub: true, author: { name: author.name, email: author.email, login: author.user.login },
  });
  const anonymous = await commitVerification(client({ repository: { object: { ...object, author: { ...author, user: null } } } }), "o/r", "abc");
  assert.equal(anonymous.author?.login, null, "no bot inference from a name or email");
  const missing = await commitVerification(client({ repository: { object: { ...object, author: null } } }), "o/r", "abc");
  assert.equal(missing.author, null, "an absent identity cannot be substituted");
  for (const oid of [undefined, "def"]) {
    await assert.rejects(commitVerification(client({ repository: { object: { ...object, oid } } }), "o/r", "abc"), (error: unknown) => isForgeError(error, "github_response_invalid"));
  }
});
