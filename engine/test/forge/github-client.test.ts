/**
 * The forge's GitHub adapter (`src/workflow/forge/github.ts`) through the ONE
 * outbound HTTP door, against the fake GitHub (`./fake-github.ts`) on a real
 * loopback server: the pinned version, conditional GETs, pagination, the one
 * classification of every refusal, GraphQL, and the path checks.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { classifyGithubAnswer, forgeRequestUrl, githubClient, linkPaths } from "../../src/workflow/forge/github.ts";
import { isForgeError, type ForgeCode } from "../../src/workflow/forge/codes.ts";
import { memoryCredential } from "../../src/workflow/forge/credentials.ts";
import { GITHUB_API_VERSION } from "../../src/workflow/forge/port.ts";
import { fakeGithub, type FakeGithub } from "./fake-github.ts";
import { serve } from "../support/loopback-upstream.ts";

function client(fake: FakeGithub) {
  return githubClient(fake.endpoint(), memoryCredential("user:maintainer", fake.userToken("maintainer")));
}

async function refusedWith(code: ForgeCode, run: () => Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await run();
  } catch (error) {
    assert.ok(isForgeError(error), `expected a forge refusal, got ${String(error)}`);
    assert.equal(error.forgeCode, code, error.message);
    return error.facts as Record<string, unknown>;
  }
  assert.fail(`expected ${code}`);
}

test("every request pins the API version, the media type and the user agent, and answers frozen data", async () => {
  const fake = fakeGithub();
  fake.objects.set("/repos/o/r", { name: "r", private: false });
  const answer = await client(fake).rest<{ name: string }>({ method: "GET", path: "/repos/o/r" });
  assert.equal(answer.status, 200);
  assert.equal(answer.data.name, "r");
  assert.ok(Object.isFrozen(answer.data));
  const sent = fake.requests.at(-1)!;
  assert.equal(sent.headers.get("x-github-api-version"), GITHUB_API_VERSION);
  assert.equal(GITHUB_API_VERSION, "2026-03-10");
  assert.equal(sent.headers.get("accept"), "application/vnd.github+json");
  assert.equal(sent.headers.get("user-agent"), "bridlewise-forge-test");
  assert.equal(fake.principalOf(sent), "maintainer");
  assert.equal(answer.rate.remaining, fake.rate.remaining);
  assert.ok(answer.requestId !== undefined);
});

test("a repeated GET is conditional: a 304 answers the cached data and costs no rate limit", async () => {
  const fake = fakeGithub();
  fake.objects.set("/repos/o/r/rulesets/7", { id: 7, name: "trunk" });
  const forge = client(fake);
  const first = await forge.rest({ method: "GET", path: "/repos/o/r/rulesets/7" });
  const remaining = fake.rate.remaining;
  const second = await forge.rest({ method: "GET", path: "/repos/o/r/rulesets/7" });
  assert.equal(first.notModified, false);
  assert.equal(second.notModified, true);
  assert.equal(second.status, 304);
  assert.deepEqual(second.data, first.data);
  assert.equal(fake.requests.at(-1)!.headers.get("if-none-match"), first.etag);
  assert.equal(fake.rate.remaining, remaining, "a 304 is not counted");
  // A change on the server is seen at once.
  fake.objects.set("/repos/o/r/rulesets/7", { id: 7, name: "renamed" });
  const third = await forge.rest<{ name: string }>({ method: "GET", path: "/repos/o/r/rulesets/7" });
  assert.equal(third.notModified, false);
  assert.equal(third.data.name, "renamed");
  // A write is never conditional.
  await forge.rest({ method: "PATCH", path: "/repos/o/r/rulesets/7", body: { name: "x" } });
  assert.equal(fake.requests.at(-1)!.headers.get("if-none-match"), null);
  assert.equal(fake.requests.at(-1)!.headers.get("content-type"), "application/json");
});

test("the conditional cache is bounded: the least recently used answer is dropped first", async () => {
  const fake = fakeGithub();
  for (const id of [1, 2, 3]) fake.objects.set(`/labels/${String(id)}`, { id });
  const forge = githubClient(fake.endpoint({ etagCacheEntries: 2 }), memoryCredential("user:m", fake.userToken("m")));
  for (const id of [1, 2, 3]) await forge.rest({ method: "GET", path: `/labels/${String(id)}` });
  assert.equal((await forge.rest({ method: "GET", path: "/labels/1" })).notModified, false, "the oldest entry was dropped");
  assert.equal((await forge.rest({ method: "GET", path: "/labels/3" })).notModified, true);
});

test("paginate follows the Link header and refuses a list longer than its bound", async () => {
  const fake = fakeGithub();
  fake.objects.set("/repos/o/r/labels", Array.from({ length: 7 }, (_, index) => ({ name: `l${String(index)}` })));
  const forge = client(fake);
  const all = await forge.paginate<{ name: string }>({ path: "/repos/o/r/labels" }, { maxPages: 4, perPage: 3 });
  assert.deepEqual(all.map((label) => label.name), ["l0", "l1", "l2", "l3", "l4", "l5", "l6"]);
  assert.equal(fake.requests.filter((request) => request.path === "/repos/o/r/labels").length, 3);
  assert.equal(fake.requests.at(-1)!.query.get("page"), "3");
  const facts = await refusedWith("forge_list_oversized", () => forge.paginate({ path: "/repos/o/r/labels" }, { maxPages: 2, perPage: 3 }));
  assert.equal(facts.maxPages, 2);
  // A wrapped list names where its items are.
  fake.objects.set("/repos/o/r/actions/runs", { total_count: 1, workflow_runs: [{ id: 1 }] });
  const runs = await forge.paginate<{ id: number }>({ path: "/repos/o/r/actions/runs" }, { maxPages: 1, items: (data) => (data as { workflow_runs: { id: number }[] }).workflow_runs });
  assert.deepEqual(runs, [{ id: 1 }]);
});

test("every refusal is classified once, with the facts to act on", async () => {
  const fake = fakeGithub();
  const forge = client(fake);
  fake.objects.set("/x", { ok: true });
  const reset = String(Math.floor(Date.now() / 1000) + 600);
  const cases: readonly [string, number, string, Readonly<Record<string, string>>, ForgeCode][] = [
    ["GET", 403, "API rate limit exceeded for installation.", { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset }, "github_rate_limited"],
    ["GET", 429, "API rate limit exceeded.", { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset }, "github_rate_limited"],
    ["GET", 403, "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.", { "retry-after": "30" }, "github_secondary_rate_limited"],
    ["POST", 403, "You have exceeded a secondary rate limit and have been temporarily blocked from content creation.", {}, "github_content_budget_exhausted"],
    ["PUT", 429, "Too many requests", { "retry-after": "120" }, "github_content_budget_exhausted"],
    ["POST", 403, "Upgrade to GitHub Pro or make this repository public to enable this feature.", {}, "unavailable_on_plan"],
    ["PUT", 422, "Secret Protection is not available for this plan.", {}, "unavailable_on_plan"],
    ["GET", 404, "Advanced Security must be enabled for this repository to use code scanning.", {}, "unavailable_on_plan"],
    ["POST", 403, "Resource not accessible by integration", {}, "github_forbidden"],
    ["GET", 401, "Bad credentials", {}, "github_unauthorized"],
    ["GET", 404, "Not Found", {}, "github_not_found"],
    ["GET", 410, "Issues are disabled for this repo", {}, "github_not_found"],
    ["PUT", 409, "Reference update failed", {}, "github_conflict"],
    ["PATCH", 412, "Precondition Failed", {}, "github_precondition_failed"],
    ["POST", 422, "Validation Failed", {}, "github_validation_failed"],
    ["POST", 400, "Problems parsing JSON", {}, "github_validation_failed"],
    ["GET", 502, "Server Error", {}, "github_unavailable"],
  ];
  for (const [method, status, message, headers, code] of cases) {
    fake.refuseNext({ method, path: /^\/x$/u }, { status, message, headers });
    const facts = await refusedWith(code, () => forge.rest({ method: method as "GET", path: "/x", ...(method === "GET" ? {} : { body: {} }) }));
    assert.equal(facts.status, status);
    assert.equal(facts.message, message);
    if (code === "github_rate_limited") assert.equal(facts.resetAt, new Date(Number(reset) * 1000).toISOString());
    if (headers["retry-after"] !== undefined) assert.equal(facts.retryAfterSeconds, Number(headers["retry-after"]));
    else assert.equal(facts.retryAfterSeconds, undefined, "no wait is invented");
  }
  // Near misses: a 403 that merely mentions a limit or a plan word in another sense stays a permission refusal.
  for (const message of ["Must have admin rights to Repository.", "Although you appear to have the correct authorization credentials, the plan field is read-only."]) {
    fake.refuseNext({ path: /^\/x$/u }, { status: 403, message });
    await refusedWith("github_forbidden", () => forge.rest({ method: "GET", path: "/x" }));
  }
  // A 422's error details are carried.
  const details = classifyGithubAnswer(422, new Headers(), JSON.stringify({ message: "Validation Failed", errors: [{ resource: "Label", code: "already_exists", field: "name" }] }), "POST", "/repos/o/r/labels");
  assert.equal(details.forgeCode, "github_validation_failed");
  assert.match(String(details.facts.errors), /already_exists/u);
  assert.equal(details.retryable, false);
  assert.equal(classifyGithubAnswer(503, new Headers(), "", "GET", "/x").retryable, true);
});

test("GitHub's own words are carried in a refusal's text, its facts and its warning log: a 400's message and each validation error (resource, field, code)", async (t) => {
  const fake = fakeGithub();
  const forge = githubClient(fake.endpoint(), memoryCredential("user:maintainer", fake.userToken("maintainer")));
  const lines: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: unknown) => { lines.push(String(chunk)); return true; });
  fake.route("POST", /^\/orgs\/o\/code-security\/configurations$/u, () => ({ status: 400, body: { message: "Invalid request.", errors: [{ resource: "CodeSecurityConfiguration", field: "secret_scanning", code: "invalid" }], documentation_url: "https://docs.github.com/rest" } }));
  let refusal: unknown;
  try { await forge.rest({ method: "POST", path: "/orgs/o/code-security/configurations", body: { name: "x" } }); } catch (error) { refusal = error; }
  t.mock.restoreAll();
  assert.ok(isForgeError(refusal, "github_validation_failed"));
  const error = refusal as Error & { facts: Record<string, unknown> };
  assert.match(error.message, /GitHub: "Invalid request\."/u, "GitHub's message is in the text");
  assert.match(error.message, /"field":"secret_scanning"/u, "the refused field is in the text");
  assert.match(String(error.facts.errors), /"code":"invalid"/u);
  const logged = lines.find((line) => line.includes("github_validation_failed"));
  // The log owner's redaction masks the word "secret" even inside a field name; the field and code still show.
  assert.ok(logged !== undefined && logged.includes("_scanning") && logged.includes("invalid") && logged.includes("Invalid request."), `the warning line names GitHub's words: ${String(logged)}`);
  // A refusal with no words of GitHub's adds none.
  assert.doesNotMatch(classifyGithubAnswer(503, new Headers(), "", "GET", "/x").message, /GitHub:/u);
});

test("a redirect (a renamed repository) is never followed: github_moved", async () => {
  const fake = fakeGithub();
  fake.route("GET", /^\/repos\/o\/old$/u, () => ({ status: 301, body: { message: "Moved Permanently" }, headers: { location: `${fake.apiUrl}/repositories/42` } }));
  await refusedWith("github_moved", () => client(fake).rest({ method: "GET", path: "/repos/o/old" }));
  assert.equal(fake.requests.length, 1, "no second request");
});

test("a body that is not JSON is github_response_invalid, and an empty body is undefined data", async () => {
  const fake = fakeGithub();
  fake.route("GET", /^\/broken$/u, () => ({ status: 200, body: undefined, headers: {} }));
  const empty = await client(fake).rest({ method: "GET", path: "/broken" });
  assert.equal(empty.data, undefined);
  serve(async () => new Response("<html>not json</html>", { status: 200, headers: { "content-type": "text/html" } }));
  await refusedWith("github_response_invalid", () => githubClient(fake.endpoint(), memoryCredential("user:m", "t")).rest({ method: "GET", path: "/anything" }));
});

test("GraphQL: data is answered, an errors array is a typed refusal", async () => {
  const fake = fakeGithub();
  let answer: unknown = { data: { viewer: { login: "m" } } };
  fake.route("POST", /^\/graphql$/u, () => ({ status: 200, body: answer }));
  const forge = client(fake);
  assert.deepEqual(await forge.graphql("{ viewer { login } }"), { viewer: { login: "m" } });
  assert.deepEqual((fake.requests.at(-1)!.body as { variables: unknown }).variables, {});
  for (const [errors, code] of [
    [[{ type: "RATE_LIMITED", message: "API rate limit exceeded" }], "github_rate_limited"],
    [[{ type: "FORBIDDEN", message: "Resource not accessible by integration" }], "github_forbidden"],
    [[{ type: "NOT_FOUND", message: "Could not resolve to a ProjectV2" }], "github_not_found"],
    [[{ message: "was submitted too quickly: secondary rate limit" }], "github_content_budget_exhausted"],
    [[{ type: "UNPROCESSABLE", message: "Field is invalid" }], "github_validation_failed"],
  ] as const) {
    answer = { data: null, errors };
    await refusedWith(code, () => forge.graphql("mutation { x }"));
  }
});

test("a request names an API path under the base: every escape form is refused, each on its own, and real paths pass", () => {
  for (const endpoint of [fakeGithub().endpoint(), { ...fakeGithub().endpoint(), apiUrl: "https://api.github.com" }]) {
    const escapes: readonly (readonly [string, string])[] = [
      ["relative", "repos/o/r"],
      ["scheme-relative", "//evil.test/x"],
      ["absolute URL", "https://evil.test/x"],
      ["dot-dot", "/repos/../admin"],
      ["dot", "/repos/./x"],
      ["encoded dot-dot (the review's form)", "/repos/.%2e/admin"],
      ["encoded dot-dot, both", "/repos/%2e%2e/admin"],
      ["encoded dot-dot, upper case", "/repos/%2E%2E/admin"],
      ["encoded dot-dot, mixed", "/repos/%2E./admin"],
      ["encoded dot", "/repos/%2e/x"],
      ["trailing dot-dot", "/repos/o/.."],
      ["double-encoded dot-dot", "/repos/%252e%252e/admin"],
      ["encoded slash", "/a%2fb"],
      ["encoded slash, upper case", "/a%2Fb"],
      ["encoded backslash", "/a%5cb"],
      ["backslash", "/a\\b"],
      ["doubled slash inside", "/repos//admin"],
      ["trailing slash", "/repos/o/"],
      ["query", "/a?b=1"],
      ["fragment", "/a#b"],
      ["space", "/a b"],
      ["control character", "/a\u0000b"],
      ["malformed escape", "/a%zzb"],
    ];
    for (const [form, path] of escapes) {
      assert.throws(() => forgeRequestUrl(endpoint, path), (error: unknown) => isForgeError(error, "forge_request_invalid"), `${form}: ${path}`);
    }
    // Near misses: what the lanes really send.
    for (const path of ["/repos/o/r.js/issues", "/repos/o/r/labels/lane%3Agh-1", "/repos/o/r/labels/area%3Aengine", "/users/a-b", "/repos/o/.github/rulesets", "/repos/o/r/git/refs/heads/agent%2Bx"]) {
      const url = forgeRequestUrl(endpoint, path);
      assert.ok(url.pathname.endsWith(path), path);
    }
  }
  const endpoint = fakeGithub().endpoint();
  assert.equal(forgeRequestUrl(endpoint, "/repos/o/r.js/issues", { state: "open", per_page: 100 }).searchParams.get("per_page"), "100");
  for (const apiUrl of ["ftp://api.github.com", "https://user:pw@api.github.com", "https://api.github.com?x=1", "not a url"]) {
    assert.throws(() => forgeRequestUrl({ ...endpoint, apiUrl }, "/x"), (error: unknown) => isForgeError(error, "forge_endpoint_invalid"), apiUrl);
  }
  // A Link header to another host, outside the API, or whose path escapes, is refused; every rel is answered.
  assert.throws(() => linkPaths(endpoint, '<https://evil.test/x?page=2>; rel="next"'), (error: unknown) => isForgeError(error, "github_response_invalid"));
  assert.throws(() => linkPaths(endpoint, `<${endpoint.apiUrl}/x/.%2e/y?page=2>; rel="next"`), (error: unknown) => isForgeError(error, "github_response_invalid"));
  assert.deepEqual(linkPaths(endpoint, `<${endpoint.apiUrl}/x?page=2>; rel="next", <${endpoint.apiUrl}/x?page=9>; rel="last"`), { next: "/x?page=2", last: "/x?page=9" });
  assert.deepEqual(linkPaths(endpoint, null), {});
});

test("the credential is never sent to a request the door refuses, and a missing environment token is typed", async () => {
  const { environmentCredential } = await import("../../src/workflow/forge/credentials.ts");
  const fake = fakeGithub();
  const variable = "BRIDLEWISE_FORGE_TEST_TOKEN";
  delete process.env[variable];
  await refusedWith("forge_token_unavailable", () => githubClient(fake.endpoint(), environmentCredential("workflow", variable)).rest({ method: "GET", path: "/x" }));
  assert.equal(fake.requests.length, 0);
  process.env[variable] = fake.userToken("workflow");
  try {
    fake.objects.set("/x", { ok: true });
    assert.deepEqual((await githubClient(fake.endpoint(), environmentCredential("workflow", variable)).rest({ method: "GET", path: "/x" })).data, { ok: true });
  } finally { delete process.env[variable]; }
  // A public-only endpoint refuses the loopback fake before anything is sent.
  await assert.rejects(githubClient(fake.endpoint({ allowPrivateAddress: false }), memoryCredential("m", "t")).rest({ method: "GET", path: "/x" }), (error: unknown) => (error as { code?: string }).code === "outbound_private_destination_refused");
});
