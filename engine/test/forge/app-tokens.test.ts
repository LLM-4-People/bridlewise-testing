/**
 * App identities: the registry (`app-registry.ts`), the host's key custody
 * (`app-keys.ts`, in the run's private key home) and installation-token
 * minting (`credentials.ts`) against the fake GitHub, which verifies every
 * JWT with the App's public key.
 */
import assert from "node:assert/strict";
import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { admitHarnessKeyHome } from "../../src/filesystem/self-protection/key-home.ts";
import { FORGE_APP_ROLES, FORGE_APPS, forgeApp, narrowedPermissions } from "../../src/workflow/forge/app-registry.ts";
import { appKeyState, harnessAppKeyCustody, keyHomeCustody, pushHeldKey, storeAppKey } from "../../src/workflow/forge/app-keys.ts";
import { ForgeError, isForgeError, type ForgeCode } from "../../src/workflow/forge/codes.ts";
import { appInstallationCredential, appJwt } from "../../src/workflow/forge/credentials.ts";
import { githubClient } from "../../src/workflow/forge/github.ts";
import { fakeGithub } from "./fake-github.ts";

/** GitHub's App permission names (`app-permissions` in the REST description, 2026-10-21) plus the repository security advisories permission. */
const GITHUB_PERMISSION_NAMES = new Set([
  "actions", "administration", "artifact_metadata", "attestations", "checks", "code_quality", "codespaces", "contents",
  "custom_properties_for_organizations", "dependabot_secrets", "deployments", "discussions", "environments", "issues",
  "members", "merge_queues", "metadata", "organization_administration", "organization_custom_properties", "organization_hooks",
  "organization_packages", "organization_plan", "organization_projects", "organization_secrets", "packages", "pages",
  "pull_requests", "repository_advisories", "repository_custom_properties", "repository_hooks", "repository_projects",
  "secret_scanning_alerts", "secrets", "security_events", "single_file", "statuses", "vulnerability_alerts", "workflows",
]);

async function refusedWith(code: ForgeCode, run: () => unknown): Promise<void> {
  try { await run(); } catch (error) {
    assert.ok(isForgeError(error), String(error));
    assert.equal(error.forgeCode, code, error.message);
    return;
  }
  assert.fail(`expected ${code}`);
}

test("the registry: four Apps, least privilege, GitHub's permission names, custody stated", () => {
  assert.deepEqual([...FORGE_APP_ROLES], ["agent", "verifier", "door", "publisher"]);
  for (const role of FORGE_APP_ROLES) {
    const app = FORGE_APPS[role];
    assert.equal(app.role, role);
    assert.match(app.name, /^bridlewise-[a-z]+$/u);
    for (const [name, access] of Object.entries(app.permissions)) {
      assert.ok(GITHUB_PERMISSION_NAMES.has(name), `${role}: ${name} is not a GitHub App permission`);
      assert.ok(access === "read" || access === "write");
    }
    assert.equal(app.permissions.metadata, "read");
    assert.notEqual(app.permissions.administration, "write", `${role} holds administration: write`);
    assert.equal(app.permissions.members, undefined);
    assert.equal(app.permissions.organization_administration, undefined);
    assert.ok(app.installedOn.length > 0 && !app.installedOn.includes("archive"));
  }
  assert.deepEqual(FORGE_APPS.agent.custody, { kind: "host" });
  assert.deepEqual(FORGE_APPS.verifier.custody, { kind: "host" });
  assert.equal(FORGE_APPS.door.custody.kind === "environment" && FORGE_APPS.door.custody.keySecret, "DOOR_APP_KEY");
  assert.equal(FORGE_APPS.publisher.custody.kind === "environment" && FORGE_APPS.publisher.custody.environment, "publish");
  // Only the door may write checks; only the publisher may write issues; the verifier cannot write contents.
  assert.deepEqual(FORGE_APP_ROLES.filter((role) => FORGE_APPS[role].permissions.checks === "write"), ["door"]);
  assert.deepEqual(FORGE_APP_ROLES.filter((role) => FORGE_APPS[role].permissions.issues === "write"), ["publisher"]);
  assert.equal(FORGE_APPS.verifier.permissions.contents, "read");
  assert.throws(() => forgeApp("admin"), (error: unknown) => isForgeError(error, "forge_app_unknown"));
});

test("narrowing never widens: a permission the App lacks, or write over read, is refused", () => {
  assert.deepEqual(narrowedPermissions("agent", { contents: "read" }), { contents: "read", metadata: "read" });
  assert.equal(narrowedPermissions("agent", undefined), FORGE_APPS.agent.permissions);
  assert.throws(() => narrowedPermissions("agent", { issues: "write" }), (error: unknown) => isForgeError(error, "forge_request_invalid"));
  assert.throws(() => narrowedPermissions("verifier", { contents: "write" }), (error: unknown) => isForgeError(error, "forge_request_invalid"));
});

test("the custody stores a key at 0600 in the key home, answers the identity without it, signs only for host Apps, and holds an environment key only until it is pushed", async () => {
  const fake = fakeGithub();
  const app = fake.installApp({ slug: "bridlewise-agent", permissions: FORGE_APPS.agent.permissions, repositories: ["o/r"] });
  const keyHome = admitHarnessKeyHome([]);
  const identity = storeAppKey(keyHome, "agent", { appId: app.appId, slug: app.slug, clientId: app.clientId, pem: app.pem });
  const file = join(keyHome, "forge-apps", "agent.json");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const custody = keyHomeCustody(keyHome);
  const read = custody.identity("agent");
  assert.deepEqual(read, identity);
  assert.equal(JSON.stringify(read).includes(app.pem.split("\n")[1]!), false, "the identity never carries the key");
  assert.equal(Object.keys(read).sort().join(","), "appId,clientId,role,slug,storedAt");
  // A JWT the fake verifies with the public key.
  const jwt = appJwt(custody, "agent", Date.now());
  const claims = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf8")) as { iss: string; exp: number; iat: number };
  assert.equal(claims.iss, app.clientId);
  assert.ok(claims.exp - claims.iat <= 600);
  // An environment-custody App: stored right after conversion, HELD, never signed with on the host; pushed, then gone from the host.
  storeAppKey(keyHome, "door", { appId: 7, slug: "bridlewise-door", clientId: "Iv1door", pem: app.pem });
  assert.equal(appKeyState(keyHome, "door").state, "held");
  await refusedWith("forge_request_invalid", () => custody.identity("door"));
  await refusedWith("forge_request_invalid", () => custody.signRs256("door", Buffer.from("x")));
  await assert.rejects(pushHeldKey(keyHome, "door", async () => { throw new ForgeError("forge_maintainer_cli_failed", "the push failed", {}); }), (error: unknown) => isForgeError(error, "forge_maintainer_cli_failed"));
  assert.equal(appKeyState(keyHome, "door").state, "held", "a failed push keeps the key");
  let pushed = "";
  await pushHeldKey(keyHome, "door", async (pem) => { pushed = pem; });
  assert.equal(pushed, app.pem);
  assert.equal(appKeyState(keyHome, "door").state, "done");
  assert.equal(readFileSync(join(keyHome, "forge-apps", "door.json"), "utf8").includes(app.pem.split("\n")[1]!), false, "the pushed key is gone from the host");
  await refusedWith("forge_app_key_unavailable", () => pushHeldKey(keyHome, "door", async () => undefined));
  await refusedWith("forge_request_invalid", () => pushHeldKey(keyHome, "agent", async () => undefined));
  // A malformed key, identity or record is refused before or at use.
  await refusedWith("forge_app_key_invalid", () => storeAppKey(keyHome, "verifier", { appId: 1, slug: "bridlewise-verifier", clientId: "Iv1", pem: "not a key in any format" }));
  await refusedWith("forge_request_invalid", () => storeAppKey(keyHome, "agent", { appId: 0, slug: app.slug, clientId: app.clientId, pem: app.pem }));
  await refusedWith("forge_app_key_unavailable", () => harnessAppKeyCustody().identity("verifier"));
  writeFileSync(join(keyHome, "forge-apps", "verifier.json"), "{\"schemaVersion\":\"other\"}", { mode: 0o600 });
  await refusedWith("forge_app_key_invalid", () => custody.identity("verifier"));
});

test("the mode guard: a VALID key record readable by other accounts is refused, by its mode alone", async () => {
  const fake = fakeGithub();
  const app = fake.installApp({ slug: "bridlewise-verifier", permissions: FORGE_APPS.verifier.permissions, repositories: ["o/r"] });
  const keyHome = admitHarnessKeyHome([]);
  storeAppKey(keyHome, "verifier", { appId: app.appId, slug: app.slug, clientId: app.clientId, pem: app.pem });
  const custody = keyHomeCustody(keyHome);
  assert.equal(custody.identity("verifier").appId, app.appId, "the record is valid at 0600");
  const file = join(keyHome, "forge-apps", "verifier.json");
  for (const mode of [0o644, 0o640, 0o604, 0o660]) {
    chmodSync(file, mode);
    try {
      custody.identity("verifier");
      assert.fail(`mode ${mode.toString(8)} was accepted`);
    } catch (error) {
      assert.ok(isForgeError(error, "forge_app_key_invalid") && /readable by other accounts/u.test(error.message), String(error));
    }
    assert.throws(() => custody.signRs256("verifier", Buffer.from("x")), (error: unknown) => isForgeError(error, "forge_app_key_invalid"), "nor does it sign");
  }
  chmodSync(file, 0o600);
  assert.equal(custody.identity("verifier").appId, app.appId, "0600 is read again");
});

test("the repository check: a token GitHub minted for another repository than asked is an integrity stop, even with the right permissions", async () => {
  const keyHome = admitHarnessKeyHome([]);
  const asked = { contents: "read", metadata: "read" } as const;
  const minted = (repositories: readonly string[]) => () => ({ status: 201, body: {
    token: "x", expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: asked, repositories: repositories.map((name) => ({ name })),
  } });
  for (const repositories of [["other"], ["r", "other"], []]) {
    const local = fakeGithub();
    const twin = local.installApp({ slug: "bridlewise-agent", permissions: FORGE_APPS.agent.permissions, repositories: ["o/r", "o/other"] });
    storeAppKey(keyHome, "agent", { appId: twin.appId, slug: twin.slug, clientId: twin.clientId, pem: twin.pem });
    local.route("POST", /^\/app\/installations\/\d+\/access_tokens$/u, minted(repositories));
    const answer = appInstallationCredential(local.endpoint(), keyHomeCustody(keyHome), { role: "agent", owner: "o", repository: "r", permissions: { contents: "read" }, renewBeforeMs: 0 });
    await refusedWith("forge_token_scope_mismatch", () => answer.authorization(new AbortController().signal));
  }
  // Near miss: exactly the one repository asked passes.
  const exact = fakeGithub();
  const exactApp = exact.installApp({ slug: "bridlewise-agent", permissions: FORGE_APPS.agent.permissions, repositories: ["o/r"] });
  storeAppKey(keyHome, "agent", { appId: exactApp.appId, slug: exactApp.slug, clientId: exactApp.clientId, pem: exactApp.pem });
  exact.route("POST", /^\/app\/installations\/\d+\/access_tokens$/u, minted(["r"]));
  assert.equal(await appInstallationCredential(exact.endpoint(), keyHomeCustody(keyHome), { role: "agent", owner: "o", repository: "r", permissions: { contents: "read" }, renewBeforeMs: 0 }).authorization(new AbortController().signal), "Bearer x");
});

test("an installation token is minted narrowed to one repository and the action's permissions, cached, and renewed before expiry", async () => {
  const fake = fakeGithub();
  const app = fake.installApp({ slug: "bridlewise-agent", permissions: FORGE_APPS.agent.permissions, repositories: ["o/r", "o/other"] });
  const keyHome = admitHarnessKeyHome([]);
  storeAppKey(keyHome, "agent", { appId: app.appId, slug: app.slug, clientId: app.clientId, pem: app.pem });
  const request = { role: "agent", owner: "o", repository: "r", permissions: { contents: "write", pull_requests: "write" }, renewBeforeMs: 300_000 } as const;
  const credential = appInstallationCredential(fake.endpoint(), keyHomeCustody(keyHome), request);
  assert.equal(credential.principal, "app:bridlewise-agent@o/r");
  fake.objects.set("/repos/o/r/pulls", []);
  const forge = githubClient(fake.endpoint(), credential);
  await forge.rest({ method: "POST", path: "/repos/o/r/pulls", body: { title: "t", head: "agent/x", base: "main", draft: true } });
  await forge.rest({ method: "GET", path: "/repos/o/r/pulls" });
  const mints = (): number => fake.requests.filter((entry) => entry.path.endsWith("/access_tokens")).length;
  assert.equal(mints(), 1, "the token is cached");
  assert.deepEqual(fake.requests.find((entry) => entry.path.endsWith("/access_tokens"))!.body, { repositories: ["r"], permissions: { contents: "write", pull_requests: "write", metadata: "read" } });
  assert.equal(fake.principalOf(fake.requests.at(-1)!), "bridlewise-agent");
  // A token closer to its expiry than the renewal margin is minted again on its next use; the installation id is remembered.
  fake.tokens.lifetimeMs = 200_000;
  const shortLived = githubClient(fake.endpoint(), appInstallationCredential(fake.endpoint(), keyHomeCustody(keyHome), request));
  await shortLived.rest({ method: "GET", path: "/repos/o/r/pulls" });
  await shortLived.rest({ method: "GET", path: "/repos/o/r/pulls" });
  assert.equal(mints(), 3);
  assert.equal(fake.requests.filter((entry) => entry.path === "/repos/o/r/installation").length, 2, "one lookup per credential");
});

test("minting refuses wider asks before any request, and a token minted for other permissions is an integrity stop", async () => {
  const fake = fakeGithub();
  const app = fake.installApp({ slug: "bridlewise-verifier", permissions: FORGE_APPS.verifier.permissions, repositories: ["o/r"] });
  const keyHome = admitHarnessKeyHome([]);
  storeAppKey(keyHome, "verifier", { appId: app.appId, slug: app.slug, clientId: app.clientId, pem: app.pem });
  const custody = keyHomeCustody(keyHome);
  assert.throws(() => appInstallationCredential(fake.endpoint(), custody, { role: "verifier", owner: "o", repository: "r", permissions: { contents: "write" }, renewBeforeMs: 0 }),
    (error: unknown) => isForgeError(error, "forge_request_invalid"));
  assert.equal(fake.requests.length, 0);
  // GitHub answering with more than was asked.
  fake.route("POST", /^\/app\/installations\/\d+\/access_tokens$/u, () => ({ status: 201, body: {
    token: "x", expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: { pull_requests: "write", contents: "write", metadata: "read" }, repositories: [{ name: "r" }],
  } }));
  const credential = appInstallationCredential(fake.endpoint(), custody, { role: "verifier", owner: "o", repository: "r", permissions: { pull_requests: "write" }, renewBeforeMs: 0 });
  await refusedWith("forge_token_scope_mismatch", () => credential.authorization(new AbortController().signal));
  // An App not installed on the repository: GitHub answers 404.
  const elsewhere = appInstallationCredential(fake.endpoint(), custody, { role: "verifier", owner: "o", repository: "unknown", renewBeforeMs: 0 });
  await refusedWith("github_not_found", () => elsewhere.authorization(new AbortController().signal));
});
