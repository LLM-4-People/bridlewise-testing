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
import { GITHUB_API_VERSION, GITHUB_JSON_MEDIA_TYPE } from "../../src/workflow/forge/port.ts";
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

/** A real two-page collection whose validation replies deliberately omit Link. */
function conditionalPagesFixture() {
  const fake = fakeGithub();
  const forge = client(fake);
  const pages: number[] = [];
  const rows = Array.from({ length: 101 }, (_, index) => ({ id: index + 1, conclusion: index === 100 ? "failure" : "success" }));
  fake.route("GET", /^\/conditional-pages$/u, (request) => {
    const page = Number(request.query.get("page") ?? "1");
    pages.push(page);
    const etag = `"conditional-page-${String(page)}"`;
    if (request.headers.get("if-none-match") === etag) return { status: 304, headers: { etag } };
    return {
      status: 200,
      body: rows.slice((page - 1) * 100, page * 100),
      headers: {
        etag,
        ...(page === 1 ? { link: `<${fake.apiUrl}/conditional-pages?per_page=100&page=2>; rel="next"` } : {}),
      },
    };
  });
  return { fake, forge, pages, rows };
}

test("conditional pagination replays every cached page when 304 omits Link, including a failure at item 101", async () => {
  const { forge, pages, rows } = conditionalPagesFixture();
  const request = { path: "/conditional-pages" };
  const options = { maxPages: 2, perPage: 100 };
  assert.deepEqual(await forge.paginate(request, options), rows);
  const repeated = await forge.paginate<{ id: number; conclusion: string }>(request, options);
  assert.deepEqual(repeated, rows);
  assert.deepEqual(repeated.at(-1), { id: 101, conclusion: "failure" }, "validation cannot erase the failed second-page item");
  assert.deepEqual(pages, [1, 2, 1, 2], "both actual pages are requested on both observations");
});

test("conditional pagination still refuses maxPages after its first page was cached", async () => {
  const { forge, pages } = conditionalPagesFixture();
  await forge.paginate({ path: "/conditional-pages" }, { maxPages: 2, perPage: 100 });
  const before = pages.length;
  const facts = await refusedWith("forge_list_oversized", () => forge.paginate({ path: "/conditional-pages" }, { maxPages: 1, perPage: 100 }));
  assert.equal(facts.maxPages, 1);
  assert.deepEqual(pages.slice(before), [1], "the bound refuses before asking for the retained next page");
});

test("conditional representations are scoped by effective Accept and complete query on the same client", async () => {
  const fake = fakeGithub();
  const forge = client(fake);
  const alternative = "application/vnd.github.object+json";
  const conditionals: (string | null)[] = [];
  fake.route("GET", /^\/conditional-scope$/u, (request) => {
    const representation = request.headers.get("accept") === alternative ? "object" : "json";
    const slot = request.query.get("slot")!;
    const etag = `"${representation}-${slot}"`;
    conditionals.push(request.headers.get("if-none-match"));
    if (request.headers.get("if-none-match") === etag) return { status: 304, headers: { etag } };
    return { status: 200, body: { representation, slot }, headers: { etag, link: `<${fake.apiUrl}/conditional-scope?cursor=${representation}-${slot}>; rel="next"` } };
  });
  const first = await forge.rest({ method: "GET", path: "/conditional-scope", query: { slot: "one" } });
  const other = await forge.rest({ method: "GET", path: "/conditional-scope", query: { slot: "one" }, accept: alternative });
  const explicitDefault = await forge.rest({ method: "GET", path: "/conditional-scope", query: { slot: "one" }, accept: GITHUB_JSON_MEDIA_TYPE });
  const otherQuery = await forge.rest({ method: "GET", path: "/conditional-scope", query: { slot: "two" } });
  const repeatedOther = await forge.rest({ method: "GET", path: "/conditional-scope", query: { slot: "one" }, accept: alternative });
  const repeatedQuery = await forge.rest({ method: "GET", path: "/conditional-scope", query: { slot: "two" } });
  assert.deepEqual(conditionals, [null, null, '"json-one"', null, '"object-one"', '"json-two"']);
  assert.deepEqual(first.data, { representation: "json", slot: "one" });
  assert.deepEqual(other.data, { representation: "object", slot: "one" });
  assert.equal(explicitDefault.notModified, true, "omitted and explicit default Accept select the same representation");
  assert.deepEqual(explicitDefault.data, first.data);
  assert.equal(explicitDefault.next, "/conditional-scope?cursor=json-one");
  assert.deepEqual(repeatedOther.data, other.data);
  assert.equal(repeatedOther.next, "/conditional-scope?cursor=object-one");
  assert.deepEqual(repeatedQuery.data, otherQuery.data);
  assert.equal(repeatedQuery.next, "/conditional-scope?cursor=json-two");
});

test("separate credential clients never share cached data or pagination metadata at the same URL and ETag", async () => {
  const fake = fakeGithub();
  const first = githubClient(fake.endpoint(), memoryCredential("user:first", fake.userToken("first")));
  const second = githubClient(fake.endpoint(), memoryCredential("user:second", fake.userToken("second")));
  const conditionals: (string | null)[] = [];
  fake.route("GET", /^\/conditional-principal$/u, (request) => {
    const principal = fake.principalOf(request)!;
    conditionals.push(request.headers.get("if-none-match"));
    if (request.headers.get("if-none-match") === '"same"') return { status: 304, headers: { etag: '"same"' } };
    return { status: 200, body: { principal }, headers: { etag: '"same"', link: `<${fake.apiUrl}/conditional-principal?cursor=${principal}>; rel="next"` } };
  });
  const a = await first.rest({ method: "GET", path: "/conditional-principal" });
  const b = await second.rest({ method: "GET", path: "/conditional-principal" });
  const aAgain = await first.rest({ method: "GET", path: "/conditional-principal" });
  const bAgain = await second.rest({ method: "GET", path: "/conditional-principal" });
  assert.deepEqual(conditionals, [null, null, '"same"', '"same"']);
  assert.deepEqual(aAgain.data, a.data);
  assert.deepEqual(bAgain.data, b.data);
  assert.notDeepEqual(aAgain.data, bAgain.data);
  assert.equal(aAgain.next, "/conditional-principal?cursor=first");
  assert.equal(bAgain.next, "/conditional-principal?cursor=second");
});

test("304 replacement and explicitly empty Link persist through later absent-Link validations", async () => {
  const fake = fakeGithub();
  const forge = client(fake);
  let calls = 0;
  fake.route("GET", /^\/conditional-links$/u, () => {
    calls += 1;
    if (calls === 1) return { status: 200, body: { version: "original" }, headers: { etag: '"original"', link: `<${fake.apiUrl}/conditional-links?page=2>; rel="next"` } };
    if (calls === 2) return { status: 304, headers: { link: `<${fake.apiUrl}/conditional-links?page=3>; rel="next"` } };
    if (calls === 4) return { status: 304, headers: { link: "" } };
    return { status: 304, headers: {} };
  });
  const first = await forge.rest({ method: "GET", path: "/conditional-links" });
  const replaced = await forge.rest({ method: "GET", path: "/conditional-links" });
  const retained = await forge.rest({ method: "GET", path: "/conditional-links" });
  const cleared = await forge.rest({ method: "GET", path: "/conditional-links" });
  const stillCleared = await forge.rest({ method: "GET", path: "/conditional-links" });
  assert.equal(first.next, "/conditional-links?page=2");
  assert.equal(replaced.next, "/conditional-links?page=3");
  assert.equal(retained.next, replaced.next, "the supplied replacement survives a later omitted Link");
  assert.deepEqual(cleared.links, {});
  assert.equal(cleared.next, undefined);
  assert.deepEqual(stillCleared.links, {});
  assert.equal(stillCleared.next, undefined, "a cleared next cursor cannot resurrect");
  for (const response of [first, replaced, retained, cleared, stillCleared]) {
    assert.deepEqual(response.data, { version: "original" });
    assert.ok(Object.isFrozen(response.links));
  }
});

test("a fresh 200 without Link replaces old pagination metadata before subsequent 304 replay", async () => {
  const fake = fakeGithub();
  const forge = client(fake);
  let calls = 0;
  fake.route("GET", /^\/conditional-fresh$/u, () => {
    calls += 1;
    if (calls === 1) return { status: 200, body: { version: "old" }, headers: { etag: '"old"', link: `<${fake.apiUrl}/conditional-fresh?page=2>; rel="next"` } };
    if (calls === 2) return { status: 200, body: { version: "new" }, headers: { etag: '"new"' } };
    return { status: 304, headers: {} };
  });
  await forge.rest({ method: "GET", path: "/conditional-fresh" });
  const fresh = await forge.rest({ method: "GET", path: "/conditional-fresh" });
  const validated = await forge.rest({ method: "GET", path: "/conditional-fresh" });
  assert.deepEqual(fresh.data, { version: "new" });
  assert.deepEqual(validated.data, fresh.data);
  assert.equal(validated.etag, '"new"');
  assert.equal(validated.next, undefined);
  assert.deepEqual(validated.links, {}, "fresh absence replaces old links rather than merging them");
});

test("a fresh successful GET without ETag retires the previous conditional entry", async () => {
  const fake = fakeGithub();
  const forge = client(fake);
  const conditionals: (string | null)[] = [];
  let calls = 0;
  fake.route("GET", /^\/conditional-no-etag$/u, (request) => {
    conditionals.push(request.headers.get("if-none-match"));
    calls += 1;
    return calls === 1
      ? { status: 200, body: { version: "old" }, headers: { etag: '"old"', link: `<${fake.apiUrl}/conditional-no-etag?page=2>; rel="next"` } }
      : { status: 200, body: { version: "fresh" }, headers: {} };
  });
  await forge.rest({ method: "GET", path: "/conditional-no-etag" });
  const fresh = await forge.rest({ method: "GET", path: "/conditional-no-etag" });
  const next = await forge.rest({ method: "GET", path: "/conditional-no-etag" });
  assert.deepEqual(conditionals, [null, '"old"', null], "a successful unvalidated representation removes its old validator");
  assert.deepEqual(next.data, fresh.data);
  assert.equal(next.notModified, false);
  assert.equal(next.etag, undefined);
  assert.equal(next.next, undefined);
});

/** Adversarial response metadata, constructed here and parsed only by production linkPaths. */
function refusedConditionalLink(fake: FakeGithub, form: "foreign" | "traversal" | "garbage" | "partial" | "ambiguous" | "anchor"): string {
  const safe = `<${fake.apiUrl}/conditional-poison?page=2>; rel="next"`;
  if (form === "foreign") return '<https://evil.invalid/conditional-poison?page=2>; rel="next"';
  if (form === "traversal") return `<${fake.apiUrl}/conditional-poison/.%2e/escape?page=2>; rel="next"`;
  if (form === "garbage") return "not a Link field";
  if (form === "partial") return safe + " trailing-garbage";
  if (form === "anchor") return safe + '; AnChOr="/another-context"';
  return safe + `, <${fake.apiUrl}/conditional-poison?page=3>; rel="next"`;
}

test("validated Link parsing retains safe parameters before and after rel and accepts explicit whitespace clearing", () => {
  const endpoint = fakeGithub().endpoint();
  const header = `<${endpoint.apiUrl}/labels?page=2>; title="next labels"; rel="next"; type="application/json", <${endpoint.apiUrl}/labels?page=4>; rel="last"; title="last labels"`;
  assert.deepEqual(linkPaths(endpoint, header), { next: "/labels?page=2", last: "/labels?page=4" });
  assert.deepEqual(linkPaths(endpoint, " \t "), {});
});

for (const invalid of ["body", "foreign", "traversal", "garbage", "partial", "ambiguous", "anchor"] as const) {
  test(`a rejected 200 ${invalid} response cannot poison an existing conditional representation`, async () => {
    const fake = fakeGithub();
    const forge = client(fake);
    const conditionals: (string | null)[] = [];
    let calls = 0;
    fake.route("GET", /^\/conditional-poison$/u, (request) => {
      conditionals.push(request.headers.get("if-none-match"));
      calls += 1;
      if (calls === 1) return { status: 200, body: { trusted: true }, headers: { etag: '"trusted"', link: `<${fake.apiUrl}/conditional-poison?page=2>; rel="next"` } };
      if (calls === 2) return invalid === "body"
        ? { status: 200, raw: Buffer.from("not JSON"), headers: { etag: '"poison"', link: `<${fake.apiUrl}/conditional-poison?page=3>; rel="next"` } }
        : { status: 200, body: { poison: true }, headers: { etag: '"poison"', link: refusedConditionalLink(fake, invalid) } };
      return { status: 304, headers: {} };
    });
    await forge.rest({ method: "GET", path: "/conditional-poison" });
    await refusedWith("github_response_invalid", () => forge.rest({ method: "GET", path: "/conditional-poison" }));
    const retained = await forge.rest({ method: "GET", path: "/conditional-poison" });
    assert.equal(conditionals.at(-1), '"trusted"', "a rejected response never supplies the next validator");
    assert.deepEqual(retained.data, { trusted: true });
    assert.equal(retained.etag, '"trusted"');
    assert.equal(retained.next, "/conditional-poison?page=2");
    assert.equal(fake.requests.length, 3);
    assert.ok(fake.requests.every((request) => request.path === "/conditional-poison"), "no refused cursor is followed");
  });
}

for (const invalid of ["foreign", "traversal", "garbage", "partial", "ambiguous", "anchor"] as const) {
  test(`a rejected 304 ${invalid} Link preserves the previous validated pagination metadata`, async () => {
    const fake = fakeGithub();
    const forge = client(fake);
    const conditionals: (string | null)[] = [];
    let calls = 0;
    fake.route("GET", /^\/conditional-poison$/u, (request) => {
      conditionals.push(request.headers.get("if-none-match"));
      calls += 1;
      if (calls === 1) return { status: 200, body: { trusted: true }, headers: { etag: '"trusted"', link: `<${fake.apiUrl}/conditional-poison?page=2>; rel="next"` } };
      if (calls === 2) return { status: 304, headers: { link: refusedConditionalLink(fake, invalid) } };
      return { status: 304, headers: {} };
    });
    await forge.rest({ method: "GET", path: "/conditional-poison" });
    await refusedWith("github_response_invalid", () => forge.rest({ method: "GET", path: "/conditional-poison" }));
    const retained = await forge.rest({ method: "GET", path: "/conditional-poison" });
    assert.equal(conditionals.at(-1), '"trusted"');
    assert.deepEqual(retained.data, { trusted: true });
    assert.equal(retained.next, "/conditional-poison?page=2");
    assert.equal(retained.etag, '"trusted"');
    assert.equal(fake.requests.length, 3);
  });
}

test("a 304 without a matching cached representation refuses explicitly", async () => {
  const fake = fakeGithub();
  fake.route("GET", /^\/conditional-cold$/u, () => ({ status: 304, headers: {} }));
  await refusedWith("github_response_invalid", () => client(fake).rest({ method: "GET", path: "/conditional-cold" }));
  assert.equal(fake.requests.length, 1, "the client does not retry a cold validation into apparent success");
});

for (const change of ["newer-200", "eviction"] as const) {
  test(`an older in-flight 304 cannot overwrite ${change} in the same conditional cache`, async () => {
    const fake = fakeGithub();
    const forge = githubClient(fake.endpoint({ etagCacheEntries: change === "eviction" ? 1 : 2 }), memoryCredential("user:maintainer", fake.userToken("maintainer")));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const conditionals: { path: string; etag: string | null }[] = [];
    let raceCalls = 0;
    serve(async (url, init) => {
      const path = new URL(url).pathname;
      conditionals.push({ path, etag: init.headers.get("if-none-match") });
      if (path === "/conditional-other") return Response.json({ other: true }, { headers: { etag: '"other"' } });
      assert.equal(path, "/conditional-race");
      raceCalls += 1;
      if (raceCalls === 1) return Response.json({ version: "old" }, { headers: { etag: '"old"', link: `<${fake.apiUrl}/conditional-race?cursor=old>; rel="next"` } });
      if (raceCalls === 2) {
        entered.resolve();
        await release.promise;
        return new Response(null, { status: 304, headers: { link: `<${fake.apiUrl}/conditional-race?cursor=late-old>; rel="next"` } });
      }
      if (change === "eviction") return Response.json({ version: "reloaded" }, { headers: { etag: '"reloaded"' } });
      if (raceCalls === 3) return Response.json({ version: "new" }, { headers: { etag: '"new"', link: `<${fake.apiUrl}/conditional-race?cursor=new>; rel="next"` } });
      return new Response(null, { status: 304 });
    });
    await forge.rest({ method: "GET", path: "/conditional-race" });
    const older = forge.rest({ method: "GET", path: "/conditional-race" });
    let competing: Awaited<ReturnType<typeof forge.rest>> | undefined;
    let olderAnswer: Awaited<ReturnType<typeof forge.rest>> | undefined;
    try {
      const enteredFirst = await Promise.race([entered.promise.then(() => true), older.then(() => false)]);
      assert.equal(enteredFirst, true, "the older request cannot complete before its controlled 304 is released");
      competing = await forge.rest({ method: "GET", path: change === "eviction" ? "/conditional-other" : "/conditional-race" });
    } finally {
      release.resolve();
      olderAnswer = await older;
    }
    assert.ok(competing);
    assert.ok(olderAnswer);
    assert.deepEqual(olderAnswer.data, { version: "old" }, "the late response still answers the representation it validated");
    const current = await forge.rest({ method: "GET", path: "/conditional-race" });
    if (change === "eviction") {
      assert.deepEqual(current.data, { version: "reloaded" });
      assert.equal(conditionals.at(-1)!.etag, null, "a late 304 cannot resurrect an intentionally evicted validator");
      assert.equal(current.next, undefined);
    } else {
      assert.deepEqual(competing.data, { version: "new" });
      assert.equal(conditionals.at(-1)!.etag, '"new"', "the late metadata write cannot replace the newer representation");
      assert.deepEqual(current.data, { version: "new" });
      assert.equal(current.next, "/conditional-race?cursor=new");
    }
  });
}


for (const conflict of ["different-strong", "different-weak", "strong-from-weak"] as const) {
  test(`a 304 ${conflict} validator cannot rebind a cached representation`, async () => {
    const fake = fakeGithub();
    const forge = client(fake);
    const capturedTag = conflict === "strong-from-weak" ? 'W/"trusted"' : '"trusted"';
    const returnedTag = conflict === "strong-from-weak" ? '"trusted"' : conflict === "different-weak" ? 'W/"other"' : '"other"';
    const conditionals: (string | null)[] = [];
    let calls = 0;
    fake.route("GET", /^\/conditional-validator$/u, (request) => {
      conditionals.push(request.headers.get("if-none-match"));
      calls += 1;
      if (calls === 1) return { status: 200, body: { trusted: true }, headers: { etag: capturedTag, link: `<${fake.apiUrl}/conditional-validator?page=2>; rel="next"` } };
      if (calls === 2) return { status: 304, headers: { etag: returnedTag, link: `<${fake.apiUrl}/conditional-validator?page=3>; rel="next"` } };
      return { status: 304, headers: { etag: capturedTag } };
    });
    await forge.rest({ method: "GET", path: "/conditional-validator" });
    const facts = await refusedWith("github_response_invalid", () => forge.rest({ method: "GET", path: "/conditional-validator" }));
    assert.equal(facts["method"], "GET");
    assert.equal(facts["path"], "/conditional-validator");
    const retained = await forge.rest({ method: "GET", path: "/conditional-validator" });
    assert.deepEqual(conditionals, [null, capturedTag, capturedTag], "unsupported freshening never supplies the next conditional validator");
    assert.deepEqual(retained.data, { trusted: true });
    assert.equal(retained.etag, capturedTag);
    assert.equal(retained.next, "/conditional-validator?page=2");
    assert.equal(retained.notModified, true);
    assert.equal(fake.requests.length, 3, "the client never retries a rejected metadata update");
  });
}

test("a matching weak 304 validator can refresh a captured strong representation", async () => {
  const fake = fakeGithub();
  const forge = client(fake);
  const conditionals: (string | null)[] = [];
  let calls = 0;
  fake.route("GET", /^\/conditional-weak$/u, (request) => {
    conditionals.push(request.headers.get("if-none-match"));
    calls += 1;
    if (calls === 1) return { status: 200, body: { trusted: true }, headers: { etag: '"trusted"', link: `<${fake.apiUrl}/conditional-weak?page=2>; rel="next"` } };
    if (calls === 2) return { status: 304, headers: { etag: 'W/"trusted"', link: `<${fake.apiUrl}/conditional-weak?page=3>; rel="next"` } };
    return { status: 304, headers: {} };
  });
  await forge.rest({ method: "GET", path: "/conditional-weak" });
  const refreshed = await forge.rest({ method: "GET", path: "/conditional-weak" });
  const retained = await forge.rest({ method: "GET", path: "/conditional-weak" });
  assert.deepEqual(conditionals, [null, '"trusted"', 'W/"trusted"']);
  for (const response of [refreshed, retained]) {
    assert.deepEqual(response.data, { trusted: true });
    assert.equal(response.etag, 'W/"trusted"');
    assert.equal(response.next, "/conditional-weak?page=3");
    assert.equal(response.notModified, true);
  }
  assert.equal(fake.requests.length, 3);
});
