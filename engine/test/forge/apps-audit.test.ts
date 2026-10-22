/**
 * `harness forge apps audit` (`apps-audit.ts`, runbook P1.11) against the
 * fake GitHub:
 * - an App installed exactly as the registry declares passes every check;
 * - each kind of difference is named by its check (a repository too many or
 *   missing, permissions, the selection, no installation at all);
 * - the audit's installation token reads only metadata, and a wider one is
 *   refused;
 * - an environment App signs only with the key its job is handed, and a
 *   host App never signs through the environment's custody.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { FORGE_APPS } from "../../src/workflow/forge/app-registry.ts";
import { environmentKeyCustody, keyHomeCustody, storeAppKey } from "../../src/workflow/forge/app-keys.ts";
import { auditAppInstallation } from "../../src/workflow/forge/apps-audit.ts";
import { isForgeError } from "../../src/workflow/forge/codes.ts";
import { fakeGithub } from "./fake-github.ts";
import { temporaryKeyHome } from "./forge-key-home.ts";
import { SETTINGS } from "./forge-settings.ts";

const ORG = "LLM-4-People";
/** The repositories the registry installs the agent and the verifier on, for the test section (trunk, notes, meta, and the proving ground). */
const HOST_REPOSITORIES = ["bridlewise-testing", ".github", "bridlewise-coordination", "forge-proving-ground"].map((name) => `${ORG}/${name}`);

function hostAudit(permissions: Readonly<Record<string, string>>, repositories: readonly string[]) {
  const fake = fakeGithub();
  const app = fake.installApp({ slug: "bridlewise-agent", permissions, repositories });
  const keyHome = temporaryKeyHome();
  storeAppKey(keyHome, "agent", { appId: app.appId, slug: app.slug, clientId: app.clientId, pem: app.pem });
  return { fake, app, run: () => auditAppInstallation(fake.endpoint(), keyHomeCustody(keyHome), "agent", SETTINGS) };
}

const checkOf = (audit: Awaited<ReturnType<typeof auditAppInstallation>>, name: string) => audit.checks.find((check) => check.check === name);

test("an App installed exactly as declared passes, read by the App itself with a metadata-only token", async () => {
  const { fake, run } = hostAudit(FORGE_APPS.agent.permissions, HOST_REPOSITORIES);
  const audit = await run();
  assert.equal(audit.ok, true, JSON.stringify(audit.checks));
  assert.deepEqual(audit.checks.map((check) => check.check), ["installed", "selection", "permissions", "events", "repositories"]);
  const minted = fake.requests.filter((request) => request.method === "POST" && request.path.endsWith("/access_tokens"));
  assert.deepEqual(minted.map((request) => request.body), [{ permissions: { metadata: "read" } }], "one token, metadata only, every installed repository");
  assert.ok(!fake.requests.some((request) => request.method !== "GET" && !request.path.endsWith("/access_tokens")), "the audit writes nothing");
});

test("every difference is named by its check: a repository too many or missing, other permissions, another selection, no installation", async () => {
  const extra = await hostAudit(FORGE_APPS.agent.permissions, [...HOST_REPOSITORIES, `${ORG}/bridlewise-archive`]).run();
  assert.equal(extra.ok, false);
  assert.deepEqual(checkOf(extra, "repositories")?.found, [...HOST_REPOSITORIES.map((name) => name.split("/")[1]!), "bridlewise-archive"].sort());
  const missing = await hostAudit(FORGE_APPS.agent.permissions, HOST_REPOSITORIES.slice(0, 2)).run();
  assert.equal(checkOf(missing, "repositories")?.ok, false);
  const wider = await hostAudit({ ...FORGE_APPS.agent.permissions, administration: "write" }, HOST_REPOSITORIES).run();
  assert.equal(checkOf(wider, "permissions")?.ok, false);
  assert.equal(checkOf(wider, "repositories")?.ok, true, "only the permissions differ");
  const narrower = await hostAudit({ ...FORGE_APPS.agent.permissions, contents: "read" }, HOST_REPOSITORIES).run();
  assert.equal(checkOf(narrower, "permissions")?.ok, false, "a narrower grant differs too: the registry is exact");
  const all = hostAudit(FORGE_APPS.agent.permissions, HOST_REPOSITORIES);
  all.fake.route("GET", /^\/app\/installations$/u, () => ({ status: 200, body: [{ id: all.app.installationId, account: { login: ORG }, repository_selection: "all", permissions: FORGE_APPS.agent.permissions, events: [] }] }));
  assert.equal(checkOf(await all.run(), "selection")?.ok, false, "an installation on all repositories is refused");
  const elsewhere = hostAudit(FORGE_APPS.agent.permissions, ["someone-else/repo"]);
  const notHere = await elsewhere.run();
  assert.deepEqual({ ok: notHere.ok, installationId: notHere.installationId, check: checkOf(notHere, "installed")?.ok }, { ok: false, installationId: null, check: false });
});

test("the audit token is metadata only: GitHub minting anything wider is refused before any read", async () => {
  const { fake, run } = hostAudit(FORGE_APPS.agent.permissions, HOST_REPOSITORIES);
  fake.route("POST", /^\/app\/installations\/\d+\/access_tokens$/u, () => ({ status: 201, body: { token: "ghs_wide", expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: { metadata: "read", contents: "write" } } }));
  await assert.rejects(run(), (error: unknown) => isForgeError(error, "forge_token_scope_mismatch"));
  assert.ok(!fake.requests.some((request) => request.path === "/installation/repositories"));
});

test("an environment App signs only with the key its job is handed; a host App never signs through the environment's custody", async () => {
  const fake = fakeGithub();
  const app = fake.installApp({ slug: "bridlewise-door", permissions: FORGE_APPS.door.permissions, repositories: [`${ORG}/bridlewise-testing`, `${ORG}/forge-proving-ground`] });
  const custody = FORGE_APPS.door.custody;
  assert.ok(custody.kind === "environment");
  const before = { key: process.env[custody.keySecret], id: process.env[custody.clientIdVariable] };
  try {
    delete process.env[custody.keySecret];
    delete process.env[custody.clientIdVariable];
    await assert.rejects(auditAppInstallation(fake.endpoint(), environmentKeyCustody(), "door", SETTINGS), (error: unknown) => isForgeError(error, "forge_app_key_unavailable") && error.message.includes(custody.keySecret));
    process.env[custody.keySecret] = app.pem;
    process.env[custody.clientIdVariable] = app.clientId;
    const audit = await auditAppInstallation(fake.endpoint(), environmentKeyCustody(), "door", SETTINGS);
    assert.equal(checkOf(audit, "permissions")?.ok, true, JSON.stringify(audit.checks));
    assert.equal(checkOf(audit, "installed")?.ok, true);
    assert.throws(() => environmentKeyCustody().clientId("agent"), (error: unknown) => isForgeError(error, "forge_app_key_unavailable"));
  } finally {
    for (const [variable, value] of [[custody.keySecret, before.key], [custody.clientIdVariable, before.id]] as const) {
      if (value === undefined) delete process.env[variable]; else process.env[variable] = value;
    }
  }
});
