/**
 * GH-1a: the App manifests and the generated `.github/forge/` files
 * (`generated-files.ts`), the `forge` configuration section
 * (`forge-config.ts`), the maintainer's `gh` (`maintainer-cli.ts`, with an
 * injected run: no test runs `gh`) and the Apps page (`apps-page.ts`) against
 * the fake GitHub, end to end: create → convert → the key in the host custody
 * or the environment secret → install links → Done.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import test from "node:test";

import { admitHarnessKeyHome } from "../../src/filesystem/self-protection/key-home.ts";
import { sha256 } from "../../src/kernel/integrity.ts";
import { FORGE_APP_ROLES, FORGE_APPS } from "../../src/workflow/forge/app-registry.ts";
import { appKeyState, keyHomeCustody } from "../../src/workflow/forge/app-keys.ts";
import { serveAppsPage } from "../../src/workflow/forge/apps-page.ts";
import { isForgeError } from "../../src/workflow/forge/codes.ts";
import { readIntake } from "../../src/workflow/community/sources.ts";
import { trackedTop } from "../../src/workflow/evidence-store.ts";
import { FORGE_CONFIG_SCHEMA, forgeEndpoint, repositoriesOfKinds, type ForgeSettings } from "../../src/workflow/forge/forge-config.ts";
import { appManifest, forgeGeneratedFiles, syncForgeFiles } from "../../src/workflow/forge/generated-files.ts";
import { maintainerCli, runBoundedCommand, type MaintainerCliRun } from "../../src/workflow/forge/maintainer-cli.ts";
import { fakeGithub } from "./fake-github.ts";
import { createTempDir } from "../support/temp-dir.ts";

/** The repository's own community intake: the one table of the Discussion categories. */
const CATEGORIES = readIntake(trackedTop(join(import.meta.dirname, "..", ".."))).discussionCategories;

const SETTINGS: ForgeSettings = FORGE_CONFIG_SCHEMA.parse({
  organization: "LLM-4-People",
  apiUrl: "https://api.github.com",
  webUrl: "https://github.com",
  userAgent: "bridlewise-forge-test",
  request: { timeoutMs: 10_000, maxResponseBytes: 1_048_576, cleanupTimeoutMs: 1_000, etagCacheEntries: 64, maxPages: 10 },
  tokenRenewBeforeMs: 300_000,
  repositories: [
    { name: "bridlewise-testing", kind: "trunk", visibility: "public" },
    { name: ".github", kind: "meta", visibility: "public" },
    { name: "bridlewise-evidence", kind: "evidence", visibility: "public" },
    { name: "bridlewise-coordination", kind: "notes", visibility: "private" },
    { name: "bridlewise-archive", kind: "archive", visibility: "private" },
    { name: "forge-proving-ground", kind: "none", visibility: "public", provingGround: true },
  ],
  maintainerCli: { stallMs: 120_000, cpuLimitMs: 30_000, killGraceMs: 500 },
  appsPage: { port: 47811, legacyApps: [{ slug: "claude", repositories: ["bridlewise-testing"] }] },
});

const LIMITS = SETTINGS.maintainerCli;

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
  const top = createTempDir("forge-files-");
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
function recordingGh(answer: (args: readonly string[], input: string | undefined) => Readonly<{ status: number; stdout?: string; stderr?: string }> = () => ({ status: 0 })): { run: MaintainerCliRun; calls: { args: readonly string[]; input: string | undefined }[] } {
  const calls: { args: readonly string[]; input: string | undefined }[] = [];
  return {
    calls,
    run: async (args, input) => {
      calls.push({ args, input });
      const reply = answer(args, input);
      return { status: reply.status, stdout: reply.stdout ?? "", stderr: reply.stderr ?? "", missing: false, ending: "exited" as const };
    },
  };
}

/** A `gh` whose App lookups answer 404 (no App exists yet) and whose writes succeed, unless `fail` says otherwise. */
function githubGh(options: Readonly<{ taken?: readonly string[]; failSecrets?: () => boolean }> = {}) {
  return recordingGh((args) => {
    if (args[0] === "api" && args[3]?.startsWith("apps/")) return options.taken?.includes(args[3].slice(5)) === true ? { status: 0, stdout: `${args[3].slice(5)}\n` } : { status: 1, stderr: "gh: Not Found (HTTP 404)" };
    if (args[0] === "secret" && options.failSecrets?.() === true) return { status: 1, stderr: "HTTP 502: Bad Gateway" };
    return { status: 0 };
  });
}

test("the maintainer's gh: a secret travels on stdin only, lookups answer 404 as absent, a failure is typed without the value", async () => {
  const gh = recordingGh((args) => {
    if (args[0] === "api" && args[3]!.endsWith("/missing")) return { status: 1, stderr: "gh: Not Found (HTTP 404)" };
    if (args[0] === "api" && args[3]!.startsWith("apps/")) return args[3] === "apps/bridlewise-door" ? { status: 0, stdout: "bridlewise-door\n" } : { status: 1, stderr: "gh: Not Found (HTTP 404)" };
    if (args[0] === "api") return { status: 0, stdout: "door\n" };
    return { status: 0 };
  });
  const cli = maintainerCli("https://github.com", LIMITS, gh.run);
  assert.deepEqual(await cli.ready(), { ready: true });
  assert.equal(await cli.environmentExists("O/r", "door"), true);
  assert.equal(await cli.environmentExists("O/r", "missing"), false);
  assert.equal(await cli.appExists("bridlewise-door"), true);
  assert.equal(await cli.appExists("bridlewise-agent"), false);
  const value = ["pem", "material", "never", "in", "argv"].join("-");
  await cli.setEnvironmentSecret("O/r", "door", "DOOR_APP_KEY", value);
  const secretCall = gh.calls.at(-1)!;
  assert.deepEqual(secretCall.args, ["secret", "set", "DOOR_APP_KEY", "--env", "door", "--repo", "github.com/O/r"]);
  assert.equal(secretCall.input, value);
  assert.ok(gh.calls.every((call) => !call.args.join(" ").includes(value)), "never an argument");
  await cli.setEnvironmentVariable("O/r", "door", "DOOR_APP_CLIENT_ID", "Iv23abc");
  assert.deepEqual(gh.calls.at(-1)!.args, ["variable", "set", "DOOR_APP_CLIENT_ID", "--env", "door", "--repo", "github.com/O/r", "--body", "Iv23abc"]);
  const failing = maintainerCli("https://github.com", LIMITS, recordingGh(() => ({ status: 1, stderr: "HTTP 403: Resource not accessible" })).run);
  await assert.rejects(failing.setEnvironmentSecret("O/r", "door", "DOOR_APP_KEY", value), (error: unknown) => isForgeError(error, "forge_maintainer_cli_failed") && !error.message.includes(value) && /403/u.test(error.message));
  assert.deepEqual(await maintainerCli("https://github.com", LIMITS, recordingGh(() => ({ status: 1 })).run).ready(), { ready: false, reason: "gh is not logged in to github.com" });
  const missing = maintainerCli("https://github.com", LIMITS, async () => ({ status: null, stdout: "", stderr: "", missing: true, ending: "exited" as const }));
  assert.deepEqual(await missing.ready(), { ready: false, reason: "the gh command is not installed" });
  const stalled = maintainerCli("https://github.com", LIMITS, async () => ({ status: null, stdout: "", stderr: "", missing: false, ending: "stalled" as const }));
  await assert.rejects(stalled.setEnvironmentVariable("O/r", "door", "X", "y"), (error: unknown) => isForgeError(error, "forge_maintainer_cli_stalled"));
});

test("a bounded run: its input arrives on stdin; it is ended by a stall or by its CPU limit, never by a wall clock while it works", async () => {
  const node = process.execPath;
  const echo = await runBoundedCommand(node, ["-e", "process.stdin.pipe(process.stdout)"], "on stdin", { stallMs: 30_000, cpuLimitMs: 30_000, killGraceMs: 500 });
  assert.deepEqual([echo.status, echo.stdout, echo.ending], [0, "on stdin", "exited"]);
  // Idle (no output, no CPU work): a stall.
  const idle = await runBoundedCommand(node, ["-e", "setInterval(() => {}, 60000)"], undefined, { stallMs: 1_500, cpuLimitMs: 30_000, killGraceMs: 500 });
  assert.equal(idle.ending, "stalled");
  // Busy with no output: never a stall (it makes CPU progress), ended by its CPU limit.
  const busy = await runBoundedCommand(node, ["-e", "for (;;) {}"], undefined, { stallMs: 1_500, cpuLimitMs: 2_500, killGraceMs: 500 });
  assert.equal(busy.ending, "cpu-limit");
  // A slow writer that keeps printing outlives the stall window (near miss).
  const talker = await runBoundedCommand(node, ["-e", "let n = 0; const t = setInterval(() => { process.stdout.write('.'); if (++n === 8) clearInterval(t); }, 300)"], undefined, { stallMs: 1_500, cpuLimitMs: 30_000, killGraceMs: 500 });
  assert.deepEqual([talker.ending, talker.stdout], ["exited", "........"]);
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
  error: { code: string; message: string } | undefined;
  categories: unknown[];
  legacyApps: unknown[];
  apps: { role: string; name: string; created: { appId: number; slug: string; keyStoredIn: string } | null; note: string | null; manifest: string | null; createUrl: string | null; installUrl: string | null; repositories: string[] }[];
};

function pageData(html: string): PageData {
  const match = /<script id="data" type="application\/json">([^<]*)<\/script>/u.exec(html);
  assert.ok(match !== null, "the page embeds its one data document");
  return JSON.parse(match[1]!) as PageData;
}

/** A fresh key home for one page test (each test's Apps start absent). */
function freshKeyHome(): ReturnType<typeof admitHarnessKeyHome> {
  const keyHome = admitHarnessKeyHome([]);
  for (const role of FORGE_APP_ROLES) rmSync(join(keyHome, "forge-apps", `${role}.json`), { force: true });
  return keyHome;
}

async function withPage<T>(options: Readonly<{ gh?: ReturnType<typeof githubGh> }>, body: (context: Readonly<{ fake: ReturnType<typeof fakeGithub>; url: string; origin: string; keyHome: ReturnType<typeof admitHarnessKeyHome>; gh: ReturnType<typeof githubGh>; page: Awaited<ReturnType<typeof serveAppsPage>> }>) => Promise<T>): Promise<T> {
  const fake = fakeGithub();
  const gh = options.gh ?? githubGh();
  const keyHome = freshKeyHome();
  const page = await serveAppsPage({ settings: SETTINGS, endpoint: fake.endpoint(), keyHome, cli: maintainerCli("https://github.com", LIMITS, gh.run), port: 0, discussionCategories: CATEGORIES });
  try {
    return await body({ fake, url: page.url, origin: new URL(page.url).origin, keyHome, gh, page });
  } finally {
    await page.close();
  }
}

const stateOf = (data: PageData, role: string): string => new URL(data.apps.find((app) => app.role === role)!.createUrl!).searchParams.get("state")!;

test("barrier 1, the token: the page and its states answer only the holder of the one-time token printed in the terminal", async () => {
  await withPage({}, async ({ url, origin }) => {
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{48}$/u);
    for (const attempt of [`${origin}/`, `${origin}/?t=`, `${origin}/?t=${"0".repeat(48)}`, `${url.slice(0, -1)}0`, `${url}x`]) {
      const answer = await call(attempt);
      assert.equal(answer.status, 404, attempt);
      assert.ok(!answer.body.includes("state="), "no state is served");
    }
    const first = await call(url);
    assert.equal(first.status, 200);
    assert.match(String(first.headers["content-security-policy"]), /default-src 'none'; script-src 'nonce-[0-9a-f]+'/u);
    assert.equal(pageData(first.body).apps.length, 4);
  });
});

test("barrier 2, Host and Origin: another Host is refused (rebinding), another Origin is refused on every path", async () => {
  await withPage({}, async ({ url, origin }) => {
    assert.equal((await call(url, { host: "evil.test" })).status, 421);
    assert.equal((await call(url, { host: "localhost:1" })).status, 421);
    assert.equal((await call(url, { origin: "https://evil.test" })).status, 403);
    assert.equal((await call(`${origin}/callback?code=abc&state=x`, { origin: "https://evil.test" })).status, 403);
    // Near miss: the page's own Origin passes.
    assert.equal((await call(url, { origin })).status, 200);
  });
});

test("barrier 3, the conversion: an App whose owner, name, permissions or events differ from the manifest stores nothing", async () => {
  await withPage({}, async ({ fake, url, origin, keyHome }) => {
    const variants: readonly [string, (body: Record<string, unknown>) => void][] = [
      ["owner", (body) => { body.owner = { login: "someone-else", type: "User" }; }],
      ["name", (body) => { body.name = "bridlewise-agent-2"; }],
      ["permissions", (body) => { body.permissions = { ...(body.permissions as object), administration: "write" }; }],
      ["permissions", (body) => { const narrower = { ...(body.permissions as Record<string, string>) }; delete narrower.checks; body.permissions = narrower; }],
      ["events", (body) => { body.events = ["push"]; }],
    ];
    for (const [field, mutate] of variants) {
      const app = fake.pendingConversion(`code-${field}`, { slug: "bridlewise-agent", permissions: FORGE_APPS.agent.permissions, repositories: ["LLM-4-People/bridlewise-testing"] });
      fake.route("POST", new RegExp(`^/app-manifests/code-${field}/conversions$`, "u"), () => {
        const body: Record<string, unknown> = { id: app.appId, slug: app.slug, name: app.slug, owner: { login: "LLM-4-People", type: "Organization" }, permissions: app.permissions, events: [], client_id: app.clientId, pem: app.pem };
        mutate(body);
        return { status: 201, body };
      });
      const data = pageData((await call(url)).body);
      assert.equal((await call(`${origin}/callback?code=code-${field}&state=${stateOf(data, "agent")}`)).status, 303);
      const after = pageData((await call(url)).body);
      assert.equal(after.error?.code, "forge_app_conversion_mismatch", field);
      assert.match(after.error!.message, new RegExp(field, "u"));
      assert.equal(appKeyState(keyHome, "agent").state, "absent", `nothing stored on a ${field} mismatch`);
    }
    // Near miss: the declared App is stored.
    fake.pendingConversion("code-good", { slug: "bridlewise-agent", permissions: FORGE_APPS.agent.permissions, repositories: ["LLM-4-People/bridlewise-testing"] });
    await call(`${origin}/callback?code=code-good&state=${stateOf(pageData((await call(url)).body), "agent")}`);
    assert.equal(appKeyState(keyHome, "agent").state, "done");
  });
});

test("custody right after conversion: an environment key is stored before its push, a failed push keeps it held, and a reload resumes it", async () => {
  let failing = true;
  const gh = githubGh({ failSecrets: () => failing });
  await withPage({ gh }, async ({ fake, url, origin, keyHome }) => {
    const door = fake.pendingConversion("code-door", { slug: "bridlewise-door", permissions: FORGE_APPS.door.permissions, repositories: ["LLM-4-People/bridlewise-testing"] });
    await call(`${origin}/callback?code=code-door&state=${stateOf(pageData((await call(url)).body), "door")}`);
    // The push failed: the key is held on the host (never lost), and the page says so.
    assert.equal(appKeyState(keyHome, "door").state, "held");
    const held = pageData((await call(url)).body);
    assert.equal(held.error?.code, "forge_maintainer_cli_failed");
    assert.match(held.apps.find((app) => app.role === "door")!.note!, /stored on this host; pushing it into its environment failed/u);
    assert.equal(held.apps.find((app) => app.role === "door")!.createUrl, null, "never offered for creation again");
    // The push succeeds on the next load: the key leaves the host.
    failing = false;
    const resumed = pageData((await call(url)).body);
    assert.equal(resumed.apps.find((app) => app.role === "door")!.created?.slug, "bridlewise-door");
    assert.equal(appKeyState(keyHome, "door").state, "done");
    const record = JSON.parse(readFileSync(join(keyHome, "forge-apps", "door.json"), "utf8")) as { pem: unknown; pushedAt: unknown };
    assert.equal(record.pem, null, "the environment key is gone from the host");
    assert.equal(typeof record.pushedAt, "string");
    const secrets = gh.calls.filter((entry) => entry.args[0] === "secret");
    assert.ok(secrets.length >= 2 && secrets.every((entry) => entry.input === door.pem), "the same stored key, pushed on stdin each time");
    assert.deepEqual(gh.calls.filter((entry) => entry.args[0] === "variable").at(-1)!.args.at(-1), door.clientId);
    assert.ok(!(await call(url)).body.includes(door.pem.split("\n")[1]!), "no key ever reaches the page");
  });
});

test("a name a half-finished attempt took is detected: shown with what to do, never offered again", async () => {
  await withPage({ gh: githubGh({ taken: ["bridlewise-verifier"] }) }, async ({ url }) => {
    const data = pageData((await call(url)).body);
    const verifier = data.apps.find((app) => app.role === "verifier")!;
    assert.equal(verifier.createUrl, null);
    assert.match(verifier.note!, /exists, but no key for it is stored here/u);
    assert.match(verifier.note!, /delete it in the organisation's settings/u);
    assert.ok(data.apps.find((app) => app.role === "agent")!.createUrl !== null, "the others stay creatable");
  });
});

test("the Apps page end to end: host custody, install links, Done guarded by session and origin", async () => {
  await withPage({}, async ({ fake, url, origin, keyHome }) => {
    const data = pageData((await call(url)).body);
    for (const app of data.apps) {
      assert.match(app.createUrl!, /^https:\/\/github\.com\/organizations\/LLM-4-People\/settings\/apps\/new\?state=[0-9a-f]{48}$/u);
      assert.deepEqual(JSON.parse(app.manifest!), appManifest(app.role as "agent", SETTINGS));
    }
    assert.equal(data.categories.length, CATEGORIES.length);
    // An unknown state, and a used one, are refused.
    await call(`${origin}/callback?code=abc&state=${"0".repeat(48)}`);
    assert.equal(pageData((await call(url)).body).error?.code, "forge_apps_page_refused");
    const agent = fake.pendingConversion("code-agent", { slug: "bridlewise-agent", permissions: FORGE_APPS.agent.permissions, repositories: ["LLM-4-People/bridlewise-testing"] });
    const agentState = stateOf(data, "agent");
    const redirect = await call(`${origin}/callback?code=code-agent&state=${agentState}`);
    assert.equal(redirect.status, 303);
    assert.equal(redirect.headers.location, new URL(url).pathname + new URL(url).search, "back to the token-bound page");
    assert.equal(keyHomeCustody(keyHome).identity("agent").appId, agent.appId);
    await call(`${origin}/callback?code=code-agent&state=${agentState}`);
    const after = pageData((await call(url)).body);
    assert.equal(after.error?.code, "forge_apps_page_refused");
    const shown = Object.fromEntries(after.apps.map((app) => [app.role, app]));
    assert.equal(shown.agent!.installUrl, "https://github.com/apps/bridlewise-agent/installations/new");
    assert.deepEqual(shown.verifier!.repositories, ["bridlewise-testing", ".github", "bridlewise-coordination", "forge-proving-ground"]);
    assert.equal((await call(`${origin}/done`, { method: "POST", origin, form: { session: "x" } })).status, 403);
    assert.equal((await call(`${origin}/done`, { method: "POST", form: { session: after.session } })).status, 403, "no Origin on a form post is refused");
    assert.equal((await call(`${origin}/done`, { method: "POST", origin, form: { session: after.session } })).status, 200);
  });
});

test("the Apps page refuses a port it cannot bind, typed", async () => {
  await withPage({}, async ({ fake, url }) => {
    const port = Number(new URL(url).port);
    await assert.rejects(serveAppsPage({ settings: SETTINGS, endpoint: fake.endpoint(), keyHome: admitHarnessKeyHome([]), cli: maintainerCli("https://github.com", LIMITS, githubGh().run), port, discussionCategories: CATEGORIES }),
      (error: unknown) => isForgeError(error, "forge_apps_page_unavailable"));
  });
});
