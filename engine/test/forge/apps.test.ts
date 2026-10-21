/**
 * GH-1a: the App manifests and the generated `.github/forge/` files
 * (`generated-files.ts`), the `forge` configuration section
 * (`forge-config.ts`), the maintainer's `gh` (`maintainer-cli.ts`, with an
 * injected run: no test runs `gh`) and the Apps page (`apps-page.ts`) against
 * the fake GitHub, end to end: create → convert → the key in the host custody
 * or the environment secret → install links → Done.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { admitHarnessKeyHome } from "../../src/filesystem/self-protection/key-home.ts";
import { sha256 } from "../../src/kernel/integrity.ts";
import { FORGE_APP_ROLES, FORGE_APPS } from "../../src/workflow/forge/app-registry.ts";
import { keyHomeCustody } from "../../src/workflow/forge/app-keys.ts";
import { serveAppsPage } from "../../src/workflow/forge/apps-page.ts";
import { isForgeError } from "../../src/workflow/forge/codes.ts";
import { FORGE_DISCUSSION_CATEGORIES } from "../../src/workflow/forge/discussion-categories.ts";
import { FORGE_CONFIG_SCHEMA, forgeEndpoint, repositoriesOfKinds, type ForgeSettings } from "../../src/workflow/forge/forge-config.ts";
import { appManifest, forgeGeneratedFiles, syncForgeFiles } from "../../src/workflow/forge/generated-files.ts";
import { maintainerCli, type MaintainerCli, type MaintainerCliRun } from "../../src/workflow/forge/maintainer-cli.ts";
import { fakeGithub } from "./fake-github.ts";

const SETTINGS: ForgeSettings = FORGE_CONFIG_SCHEMA.parse({
  organization: "LLM-4-People",
  apiUrl: "https://api.github.com",
  webUrl: "https://github.com",
  userAgent: "bridlewise-forge-test",
  request: { timeoutMs: 10_000, maxResponseBytes: 1_048_576, cleanupTimeoutMs: 1_000, etagCacheEntries: 64 },
  tokenRenewBeforeMs: 300_000,
  repositories: [
    { name: "bridlewise-testing", kind: "trunk", visibility: "public" },
    { name: ".github", kind: "meta", visibility: "public" },
    { name: "bridlewise-evidence", kind: "evidence", visibility: "public" },
    { name: "bridlewise-coordination", kind: "notes", visibility: "private" },
    { name: "bridlewise-archive", kind: "archive", visibility: "private" },
    { name: "forge-proving-ground", kind: "none", visibility: "public", provingGround: true },
  ],
  appsPage: { port: 47811, legacyApps: [{ slug: "claude", repositories: ["bridlewise-testing"] }] },
});

test("the App manifests carry the registry's exact permissions, no webhook, owner-only, and the local callback", () => {
  for (const role of FORGE_APP_ROLES) {
    const manifest = appManifest(role, SETTINGS) as Record<string, unknown>;
    assert.equal(manifest.name, FORGE_APPS[role].name);
    assert.deepEqual(manifest.default_permissions, FORGE_APPS[role].permissions);
    assert.deepEqual(Object.keys(manifest.default_permissions as object), Object.keys(FORGE_APPS[role].permissions).sort(), "sorted, stable bytes");
    assert.equal(manifest.public, false);
    assert.deepEqual(manifest.hook_attributes, { url: "https://github.com/LLM-4-People/bridlewise-testing", active: false });
    assert.equal(manifest.redirect_url, "http://127.0.0.1:47811/callback");
    assert.deepEqual(manifest.default_events, []);
    assert.equal(manifest.url, "https://github.com/LLM-4-People/bridlewise-testing");
  }
  // Installation targets: by kind, plus every proving ground; never an archive.
  assert.deepEqual(repositoriesOfKinds(SETTINGS, FORGE_APPS.door.installedOn).map((repository) => repository.name),
    ["bridlewise-testing", ".github", "bridlewise-evidence", "bridlewise-coordination", "forge-proving-ground"]);
  assert.deepEqual(repositoriesOfKinds(SETTINGS, FORGE_APPS.publisher.installedOn).map((repository) => repository.name),
    ["bridlewise-testing", ".github", "bridlewise-evidence", "forge-proving-ground"]);
});

test("the forge section refuses what it must: two trunks, a duplicate name, a non-https or pathful origin, an out-of-range bound", () => {
  const base = JSON.parse(JSON.stringify(SETTINGS)) as Record<string, unknown> & { repositories: Record<string, unknown>[] };
  const refused = (patch: (draft: typeof base) => void): boolean => {
    const draft = JSON.parse(JSON.stringify(base)) as typeof base;
    patch(draft);
    return !FORGE_CONFIG_SCHEMA.safeParse(draft).success;
  };
  assert.ok(refused((draft) => { draft.repositories[1]!.kind = "trunk"; }));
  assert.ok(refused((draft) => { draft.repositories.push({ name: "Bridlewise-Testing", kind: "none", visibility: "public" }); }));
  assert.ok(refused((draft) => { draft.apiUrl = "http://api.github.com"; }));
  assert.ok(refused((draft) => { draft.webUrl = "https://github.com/x"; }));
  assert.ok(refused((draft) => { draft.organization = "-bad"; }));
  assert.ok(refused((draft) => { (draft.request as Record<string, number>).timeoutMs = 10; }));
  assert.ok(refused((draft) => { draft.extra = true; }));
  assert.ok(!refused(() => undefined), "the base parses");
  assert.equal(forgeEndpoint(SETTINGS).allowPrivateAddress, false);
  assert.equal(forgeEndpoint(SETTINGS).apiUrl, "https://api.github.com");
});

test("the generated files: written from their owners, hand edits and strays are drift, and the index binds each file's sha256", () => {
  const top = mkdtempSync(join(tmpdir(), "forge-files-"));
  const files = forgeGeneratedFiles(SETTINGS);
  assert.deepEqual([...files.keys()], ["apps/agent.json", "apps/verifier.json", "apps/door.json", "apps/publisher.json", "manifest.json"]);
  const index = JSON.parse(files.get("manifest.json")!) as { files: { path: string; sha256: string }[] };
  for (const entry of index.files) assert.equal(entry.sha256, sha256(files.get(entry.path)!));
  assert.equal(syncForgeFiles(top, undefined, false).status, "current", "no section and no folder: converged by absence");
  assert.equal(syncForgeFiles(top, SETTINGS, false).status, "stale");
  assert.equal(syncForgeFiles(top, SETTINGS, true).status, "regenerated");
  assert.deepEqual(syncForgeFiles(top, SETTINGS, false), { status: "current", converged: true, changed: [] });
  assert.deepEqual(JSON.parse(readFileSync(join(top, ".github/forge/apps/door.json"), "utf8")), appManifest("door", SETTINGS));
  // A hand edit in one place and a stray file in another: both named.
  writeFileSync(join(top, ".github/forge/apps/agent.json"), readFileSync(join(top, ".github/forge/apps/agent.json"), "utf8").replace("\"read\"", "\"write\""));
  mkdirSync(join(top, ".github/forge/rulesets"), { recursive: true });
  writeFileSync(join(top, ".github/forge/rulesets/hand.json"), "{}\n");
  // Near miss: a file beside the folder is not the forge's.
  writeFileSync(join(top, ".github/CODEOWNERS"), "* @x\n");
  const stale = syncForgeFiles(top, SETTINGS, false);
  assert.deepEqual(stale.changed, [".github/forge/apps/agent.json", ".github/forge/rulesets/hand.json"]);
  assert.equal(stale.converged, false);
  syncForgeFiles(top, SETTINGS, true);
  assert.equal(syncForgeFiles(top, SETTINGS, false).status, "current");
  assert.equal(readFileSync(join(top, ".github/CODEOWNERS"), "utf8"), "* @x\n");
});

/** A recording `gh`: every call's arguments and stdin, and a scripted answer. */
function recordingGh(answer: (args: readonly string[]) => Readonly<{ status: number; stdout?: string; stderr?: string }> = () => ({ status: 0 })): { run: MaintainerCliRun; calls: { args: readonly string[]; input: string | undefined }[] } {
  const calls: { args: readonly string[]; input: string | undefined }[] = [];
  return {
    calls,
    run: (args, input) => {
      calls.push({ args, input });
      const reply = answer(args);
      return { status: reply.status, stdout: reply.stdout ?? "", stderr: reply.stderr ?? "", missing: false };
    },
  };
}

test("the maintainer's gh: a secret travels on stdin only, a missing environment is false, a failure is typed without the value", () => {
  const gh = recordingGh((args) => args[0] === "api" && args.at(-3)!.endsWith("/missing") ? { status: 1, stderr: "gh: Not Found (HTTP 404)" } : args[0] === "api" ? { status: 0, stdout: "door\n" } : { status: 0 });
  const cli = maintainerCli("https://github.com", 5_000, gh.run);
  assert.deepEqual(cli.ready(), { ready: true });
  assert.equal(cli.environmentExists("O/r", "door"), true);
  assert.equal(cli.environmentExists("O/r", "missing"), false);
  const value = ["pem", "material", "never", "in", "argv"].join("-");
  cli.setEnvironmentSecret("O/r", "door", "DOOR_APP_KEY", value);
  const secretCall = gh.calls.at(-1)!;
  assert.deepEqual(secretCall.args, ["secret", "set", "DOOR_APP_KEY", "--env", "door", "--repo", "github.com/O/r"]);
  assert.equal(secretCall.input, value);
  assert.ok(gh.calls.every((call) => !call.args.join(" ").includes(value)), "never an argument");
  cli.setEnvironmentVariable("O/r", "door", "DOOR_APP_CLIENT_ID", "Iv23abc");
  assert.deepEqual(gh.calls.at(-1)!.args, ["variable", "set", "DOOR_APP_CLIENT_ID", "--env", "door", "--repo", "github.com/O/r", "--body", "Iv23abc"]);
  const failing = maintainerCli("https://github.com", 5_000, recordingGh(() => ({ status: 1, stderr: "HTTP 403: Resource not accessible" })).run);
  assert.throws(() => failing.setEnvironmentSecret("O/r", "door", "DOOR_APP_KEY", value), (error: unknown) => isForgeError(error, "forge_maintainer_cli_failed") && !error.message.includes(value) && /403/u.test(error.message));
  assert.deepEqual(maintainerCli("https://github.com", 5_000, recordingGh(() => ({ status: 1 })).run).ready(), { ready: false, reason: "gh is not logged in to github.com" });
  const missing = maintainerCli("https://github.com", 5_000, () => ({ status: null, stdout: "", stderr: "", missing: true }));
  assert.deepEqual(missing.ready(), { ready: false, reason: "the gh command is not installed" });
});

type Answer = Readonly<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>;

function call(url: string, options: Readonly<{ method?: string; host?: string; origin?: string; form?: Readonly<Record<string, string>> }> = {}): Promise<Answer> {
  const target = new URL(url);
  const body = options.form === undefined ? undefined : new URLSearchParams(options.form).toString();
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({
      host: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method: options.method ?? "GET",
      headers: { host: options.host ?? target.host, ...(options.origin === undefined ? {} : { origin: options.origin }), ...(body === undefined ? {} : { "content-type": "application/x-www-form-urlencoded", "content-length": String(Buffer.byteLength(body)) }) },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

type PageData = {
  session: string;
  error: { code: string } | undefined;
  categories: unknown[];
  legacyApps: unknown[];
  apps: { role: string; name: string; created: { appId: number; slug: string; keyStoredIn: string } | null; manifest: string | null; createUrl: string | null; installUrl: string | null; repositories: string[] }[];
};

function pageData(html: string): PageData {
  const match = /<script id="data" type="application\/json">([^<]*)<\/script>/u.exec(html);
  assert.ok(match !== null, "the page embeds its one data document");
  return JSON.parse(match[1]!) as PageData;
}

test("the Apps page: create → convert → the key where the registry says → install links → Done; every refusal on the page", async () => {
  const fake = fakeGithub();
  const gh = recordingGh();
  const cli: MaintainerCli = maintainerCli("https://github.com", 5_000, gh.run);
  const keyHome = admitHarnessKeyHome([]);
  const page = await serveAppsPage({ settings: SETTINGS, endpoint: fake.endpoint(), keyHome, cli, port: 0 });
  try {
    const origin = new URL(page.url).origin;
    const first = await call(page.url);
    assert.equal(first.status, 200);
    const csp = String(first.headers["content-security-policy"]);
    assert.match(csp, /default-src 'none'; script-src 'nonce-[0-9a-f]+'/u);
    assert.match(csp, /form-action https:\/\/github\.com 'self'/u);
    assert.equal(first.headers["cache-control"], "no-store");
    let data = pageData(first.body);
    assert.equal(data.apps.length, 4);
    assert.equal(data.categories.length, FORGE_DISCUSSION_CATEGORIES.length);
    for (const app of data.apps) {
      assert.match(app.createUrl!, /^https:\/\/github\.com\/organizations\/LLM-4-People\/settings\/apps\/new\?state=[0-9a-f]{48}$/u);
      assert.deepEqual(JSON.parse(app.manifest!), appManifest(app.role as "agent", SETTINGS));
      assert.equal(app.installUrl, null);
    }
    const stateOf = (role: string): string => new URL(data.apps.find((app) => app.role === role)!.createUrl!).searchParams.get("state")!;
    // Another Host (DNS rebinding) is refused.
    assert.equal((await call(page.url, { host: "evil.test" })).status, 421);
    // An unknown state is refused, and shown.
    assert.equal((await call(`${origin}/callback?code=abc&state=${"0".repeat(48)}`)).status, 303);
    assert.equal(pageData((await call(page.url)).body).error?.code, "forge_apps_page_refused");
    // The agent: its key goes to the host custody.
    const agent = fake.pendingConversion("code-agent", { slug: "bridlewise-agent", permissions: FORGE_APPS.agent.permissions, repositories: ["LLM-4-People/bridlewise-testing"] });
    const agentState = stateOf("agent");
    assert.equal((await call(`${origin}/callback?code=code-agent&state=${agentState}`)).status, 303);
    assert.equal(keyHomeCustody(keyHome).identity("agent").appId, agent.appId);
    // The door: its key goes to the environment secret through gh, on stdin, and its client id to the variable.
    const door = fake.pendingConversion("code-door", { slug: "bridlewise-door", permissions: FORGE_APPS.door.permissions, repositories: ["LLM-4-People/bridlewise-testing"] });
    assert.equal((await call(`${origin}/callback?code=code-door&state=${stateOf("door")}`)).status, 303);
    assert.deepEqual(gh.calls.map((entry) => entry.args.slice(0, 3)), [["secret", "set", "DOOR_APP_KEY"], ["variable", "set", "DOOR_APP_CLIENT_ID"]]);
    assert.equal(gh.calls[0]!.input, door.pem);
    assert.equal(gh.calls[1]!.args.at(-1), door.clientId);
    // A used state is refused (single use).
    assert.equal((await call(`${origin}/callback?code=code-agent&state=${agentState}`)).status, 303);
    const after = (await call(page.url)).body;
    data = pageData(after);
    assert.equal(data.error?.code, "forge_apps_page_refused");
    assert.ok(!after.includes(agent.pem.split("\n")[1]!) && !after.includes(door.pem.split("\n")[1]!), "no key ever reaches the page");
    const shown = Object.fromEntries(data.apps.map((app) => [app.role, app]));
    assert.equal(shown.agent!.created!.slug, "bridlewise-agent");
    assert.equal(shown.agent!.installUrl, "https://github.com/apps/bridlewise-agent/installations/new");
    assert.equal(shown.agent!.createUrl, null);
    assert.match(shown.door!.created!.keyStoredIn, /door environment of LLM-4-People\/bridlewise-testing \(secret DOOR_APP_KEY\)/u);
    assert.deepEqual(shown.verifier!.repositories, ["bridlewise-testing", ".github", "bridlewise-coordination", "forge-proving-ground"]);
    // Done needs the session token and the page's own origin.
    assert.equal((await call(`${origin}/done`, { method: "POST", origin, form: { session: "x" } })).status, 403);
    assert.equal((await call(`${origin}/done`, { method: "POST", origin: "https://evil.test", form: { session: data.session } })).status, 403);
    assert.equal((await call(`${origin}/done`, { method: "POST", origin, form: { session: data.session } })).status, 200);
    const summary = await page.done;
    assert.deepEqual(summary.created.map((app) => app.role), ["agent", "door"]);
    assert.deepEqual(summary.pending, ["verifier", "publisher"]);
  } finally {
    await page.close();
  }
});

test("the Apps page refuses a port it cannot bind, typed", async () => {
  const fake = fakeGithub();
  const page = await serveAppsPage({ settings: SETTINGS, endpoint: fake.endpoint(), keyHome: admitHarnessKeyHome([]), cli: maintainerCli("https://github.com", 5_000, recordingGh().run), port: 0 });
  try {
    const port = Number(new URL(page.url).port);
    await assert.rejects(serveAppsPage({ settings: SETTINGS, endpoint: fake.endpoint(), keyHome: admitHarnessKeyHome([]), cli: maintainerCli("https://github.com", 5_000, recordingGh().run), port }),
      (error: unknown) => isForgeError(error, "forge_apps_page_unavailable"));
  } finally {
    await page.close();
  }
});
