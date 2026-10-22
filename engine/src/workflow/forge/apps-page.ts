/**
 * THE APPS PAGE — `harness forge apps create` (runbook P1.2, GH-1a; the
 * user's Session 1, items 3 to 6). A local page on 127.0.0.1 only:
 *
 * 1. THE PAGE IS BOUND TO A ONE-TIME TOKEN printed in the terminal only
 *    (`http://127.0.0.1:47811/?t=…`): without it the page answers 404, so no
 *    state value is ever served to a request that did not come from the
 *    terminal's reader. Every request must name the page's own Host (no DNS
 *    rebinding), and a request carrying another Origin is refused.
 * 2. One **Create** button per App posts its generated manifest
 *    (`generated-files.ts` `appManifest`, the bytes of
 *    `.github/forge/apps/<role>.json`) to GitHub's organisation form, with a
 *    one-use random `state`.
 * 3. On GitHub's redirect (`/callback?code&state`) the code is converted
 *    (unauthenticated: the one-hour code is the secret) and THE CONVERSION IS
 *    VERIFIED ({@link verifyConversion}): the App's owner is the
 *    organisation, its name the registry's, its permissions and events
 *    exactly the manifest's — otherwise nothing is stored.
 * 4. CUSTODY RIGHT AFTER CONVERSION: the key is written to the key custody
 *    (`app-keys.ts`, the key home) BEFORE any later step. An environment key
 *    (door, publisher) is then pushed through the maintainer's `gh`
 *    (`maintainer-cli.ts`) and dropped from the host; a push that fails
 *    leaves it held, and every page load RESUMES it. The client and webhook
 *    secrets GitHub also returns are dropped (no OAuth, no webhook).
 * 5. A name a half-finished attempt already took (the App exists on GitHub,
 *    no key is stored here) is detected and shown with what to do; it is
 *    never offered for creation again.
 * 6. The page lists what Session 1 still asks: each App's install link and
 *    the exact repositories, the legacy Apps to narrow, and the Discussion
 *    categories (from the community intake).
 *
 * The page is rendered from ONE JSON document embedded in it (no value is
 * spliced into HTML: the page's own script builds the DOM with
 * `textContent` and form values), under a nonce content security policy.
 * `/done` must carry the page's session token and come from its own origin.
 * Nothing here waits on a timer: the page lives until the maintainer presses
 * **Done** (or the process is stopped).
 */
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { HarnessError } from "../../kernel/errors.ts";
import { guarded } from "../../process/fault-policy.ts";
import { randomBytes } from "../../kernel/integrity.ts";
import { debugLog } from "../../shared/debug/debug-system.ts";
import type { AdmittedKeyHome } from "../../filesystem/self-protection/key-home.ts";
import { FORGE_APP_ROLES, FORGE_APPS, type ForgeAppRole } from "./app-registry.ts";
import { appKeyState, pushHeldKey, storeAppKey, type StoredAppIdentity } from "./app-keys.ts";
import { ForgeError, isForgeError } from "./codes.ts";
import { anonymousCredential } from "./credentials.ts";
import type { DiscussionCategory } from "../community/sources.ts";
import { repositoriesOfKinds, trunkRepository, type ForgeSettings } from "./forge-config.ts";
import { appManifest, appsPageOrigin } from "./generated-files.ts";
import { FORGE_LOG_CATEGORY, githubClient } from "./github.ts";
import type { MaintainerCli } from "./maintainer-cli.ts";
import type { ForgeEndpoint } from "./port.ts";

/** What one created App is, as the page shows it (public facts only). */
export type CreatedApp = Readonly<{ role: ForgeAppRole; appId: number; slug: string; clientId: string; keyStoredIn: string }>;

export type AppsPageSummary = Readonly<{ created: readonly CreatedApp[]; pending: readonly ForgeAppRole[] }>;

export type AppsPageOptions = Readonly<{
  settings: ForgeSettings;
  endpoint: ForgeEndpoint;
  keyHome: AdmittedKeyHome;
  cli: MaintainerCli;
  /** The port to bind (a test passes 0 for any free port; production: `forge.appsPage.port`). */
  port: number;
  /** The Discussion categories to create by hand (the community intake owns them: `docs/community/intake.json`). */
  discussionCategories: readonly DiscussionCategory[];
}>;

export type AppsPage = Readonly<{
  /** `http://127.0.0.1:<port>/?t=<one-time token>`: printed in the terminal only; the page answers nothing without it. */
  url: string;
  /** Resolves when the maintainer presses Done; the server is closed by then. */
  done: Promise<AppsPageSummary>;
  close: () => Promise<void>;
}>;

const CODE = /^[A-Za-z0-9_-]{1,128}$/u;
const MAX_FORM_BYTES = 4_096;

function token(): string {
  return randomBytes(24).toString("hex");
}

/** The page's script: renders the embedded document with DOM APIs only. */
const PAGE_SCRIPT = `
const data = JSON.parse(document.getElementById("data").textContent);
const el = (tag, text, attributes) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; for (const [k, v] of Object.entries(attributes ?? {})) node.setAttribute(k, v); return node; };
const main = document.querySelector("main");
if (data.error) { const box = el("section", undefined, { role: "alert" }); box.append(el("h2", "Refused: " + data.error.code), el("p", data.error.message), el("p", data.error.remedy)); main.append(box); }
const apps = el("section"); apps.append(el("h2", "1. Create the four Apps"), el("p", "Each button opens GitHub with the generated manifest; there, click \\u201cCreate GitHub App\\u201d. The key is stored for you: you never see or copy it."));
for (const app of data.apps) {
  const item = el("article"); item.append(el("h3", app.name));
  if (app.created) {
    item.append(el("p", "Created: App id " + app.created.appId + ", slug " + app.created.slug + ". Key stored in " + app.created.keyStoredIn + "."));
  } else if (app.note) {
    item.append(el("p", app.note, { role: "status" }));
  } else {
    const form = el("form", undefined, { method: "post", action: app.createUrl });
    const field = el("input", undefined, { type: "hidden", name: "manifest" }); field.value = app.manifest;
    form.append(field, el("button", "Create " + app.name, { type: "submit" }));
    item.append(form);
  }
  item.append(el("p", "Permissions: " + app.permissions));
  apps.append(item);
}
main.append(apps);
const install = el("section"); install.append(el("h2", "2. Install them"), el("p", "Choose \\u201cOnly select repositories\\u201d and tick exactly these:"));
for (const app of data.apps) {
  const item = el("article"); item.append(el("h3", app.name));
  if (app.installUrl) { const link = el("a", "Install " + app.name, { href: app.installUrl, rel: "noreferrer" }); item.append(el("p")); item.lastChild.append(link); }
  else item.append(el("p", "Create it first."));
  const list = el("ul"); for (const name of app.repositories) list.append(el("li", name)); item.append(list);
  install.append(item);
}
main.append(install);
const legacy = el("section"); legacy.append(el("h2", "3. Narrow the Apps installed before these"));
for (const app of data.legacyApps) { const item = el("article"); item.append(el("h3", app.slug), el("p", "Configure \\u2192 Only select repositories \\u2192 tick only:")); const list = el("ul"); for (const name of app.repositories) list.append(el("li", name)); item.append(list); legacy.append(item); }
legacy.append(el("p")); legacy.lastChild.append(el("a", "Organisation installations", { href: data.installationsUrl, rel: "noreferrer" }));
main.append(legacy);
const categories = el("section"); categories.append(el("h2", "4. Create the Discussion categories"), el("p")); categories.lastChild.append(el("a", "Discussions \\u2192 Categories", { href: data.discussionsUrl, rel: "noreferrer" }));
const table = el("table"); const head = el("tr"); head.append(el("th", "Name"), el("th", "Format"), el("th", "Use")); table.append(head);
for (const category of data.categories) { const row = el("tr"); row.append(el("td", category.name), el("td", category.format), el("td", category.purpose)); table.append(row); }
categories.append(table); main.append(categories);
const done = el("form", undefined, { method: "post", action: "/done" }); const session = el("input", undefined, { type: "hidden", name: "session" }); session.value = data.session;
done.append(session, el("button", "Done: close this page", { type: "submit" })); main.append(done);
`;

function page(document: unknown, nonce: string): string {
  // The one embedding: JSON inside a non-executed script element, with `<` escaped so no `</script>` can end it.
  const data = JSON.stringify(document).replace(/</gu, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bridlewise forge: create the Apps</title>
<style nonce="${nonce}">:root{color-scheme:light dark}body{font:1rem/1.5 system-ui,sans-serif;margin:0 auto;max-width:56rem;padding:1rem}article{border-top:1px solid;padding:.5rem 0}table{border-collapse:collapse}td,th{border:1px solid;padding:.25rem .5rem;text-align:left}[role=alert]{border:2px solid;padding:.5rem 1rem}</style>
</head>
<body>
<h1>Bridlewise forge: Session 1</h1>
<main></main>
<script id="data" type="application/json">${data}</script>
<script nonce="${nonce}">${PAGE_SCRIPT}</script>
</body>
</html>
`;
}

function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", guarded("forge.apps-page.form-data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_FORM_BYTES) { reject(new ForgeError("forge_apps_page_refused", "The form is larger than the page ever sends.", {})); request.destroy(); return; }
      chunks.push(chunk);
    }));
    request.on("end", guarded("forge.apps-page.form-end", () => resolve(new URLSearchParams(Buffer.concat(chunks).toString("utf8")))));
    request.on("error", guarded("forge.apps-page.form-error", reject));
  });
}

/** Two strings equal in constant time (a token comparison). */
function sameToken(given: string | null, expected: string): boolean {
  if (given === null) return false;
  const left = Buffer.from(given, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * THE CONVERSION BARRIER: the App GitHub created is exactly the declared one —
 * owned by the organisation, named as the registry names it, and holding
 * exactly the manifest's permissions and events — or the typed
 * `forge_app_conversion_mismatch`, and nothing is stored.
 */
function verifyConversion(role: ForgeAppRole, settings: ForgeSettings, answer: Readonly<Record<string, unknown>>): Readonly<{ appId: number; slug: string; clientId: string; pem: string }> {
  const { id, slug, client_id: clientId, pem, name, owner, permissions, events } = answer;
  if (typeof id !== "number" || typeof slug !== "string" || typeof clientId !== "string" || typeof pem !== "string") {
    throw new ForgeError("github_response_invalid", "GitHub's manifest conversion carries no App id, slug, client id or key.", { role });
  }
  const manifest = appManifest(role, settings) as Readonly<{ name: string; default_permissions: Readonly<Record<string, string>>; default_events: readonly string[] }>;
  const ownerRecord = (typeof owner === "object" && owner !== null ? owner : {}) as { login?: unknown; type?: unknown };
  const sameSet = (left: Readonly<Record<string, unknown>>, right: Readonly<Record<string, unknown>>): boolean => {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    return [...keys].every((key) => left[key] === right[key]);
  };
  const mismatches: string[] = [];
  if (typeof ownerRecord.login !== "string" || ownerRecord.login.toLowerCase() !== settings.organization.toLowerCase() || ownerRecord.type !== "Organization") mismatches.push("owner");
  if (name !== manifest.name) mismatches.push("name");
  if (typeof permissions !== "object" || permissions === null || Array.isArray(permissions) || !sameSet(permissions as Record<string, unknown>, manifest.default_permissions)) mismatches.push("permissions");
  if (!Array.isArray(events) || events.length !== manifest.default_events.length || !manifest.default_events.every((event) => events.includes(event))) mismatches.push("events");
  if (mismatches.length > 0) {
    throw new ForgeError("forge_app_conversion_mismatch", `GitHub created an App (${String(slug)}) whose ${mismatches.join(", ")} differ from the declared ${role} App; nothing was stored.`, { role, slug: String(slug), mismatches });
  }
  return Object.freeze({ appId: id, slug, clientId, pem });
}

/** Serve the Apps page (see the module header). */
export async function serveAppsPage(options: AppsPageOptions): Promise<AppsPage> {
  const { settings, keyHome, cli } = options;
  const trunk = `${settings.organization}/${trunkRepository(settings).name}`;
  const web = settings.webUrl.replace(/\/$/u, "");
  const conversion = githubClient(options.endpoint, anonymousCredential("anonymous:app-manifest-conversion"));
  const pageToken = token();
  const session = token();
  const states = new Map<string, ForgeAppRole>();
  let lastError: Readonly<{ code: string; message: string; remedy: string }> | undefined;
  let finish: (summary: AppsPageSummary) => void = () => undefined;
  const done = new Promise<AppsPageSummary>((resolve) => { finish = resolve; });

  const keyStoredIn = (role: ForgeAppRole): string => {
    const custody = FORGE_APPS[role].custody;
    return custody.kind === "host" ? "the host key home" : `the ${custody.environment} environment of ${trunk} (secret ${custody.keySecret})`;
  };
  const createdApp = (role: ForgeAppRole, identity: StoredAppIdentity): CreatedApp => Object.freeze({ role, appId: identity.appId, slug: identity.slug, clientId: identity.clientId, keyStoredIn: keyStoredIn(role) });

  const showRefusal = (error: unknown, role: string): void => {
    // Every typed refusal is shown on the page (a forge code with its remedy; another harness refusal with its code); anything else is a defect (500).
    if (!(error instanceof HarnessError)) throw error;
    lastError = isForgeError(error)
      ? { code: error.forgeCode, message: error.message, remedy: error.remedy }
      : { code: error.code, message: error.message, remedy: "See the harness log for this refusal; a stored key is kept and resumed." };
    debugLog(FORGE_LOG_CATEGORY, "warn", lastError.code, () => ({ role }));
  };

  /** Push a held environment key into its environment (the resume path as well as the first push). */
  async function pushHeld(role: ForgeAppRole): Promise<StoredAppIdentity> {
    const custody = FORGE_APPS[role].custody;
    if (custody.kind !== "environment") throw new ForgeError("forge_request_invalid", `The ${role} App's key is not pushed anywhere.`, { role });
    return pushHeldKey(keyHome, role, async (pem, identity) => {
      await cli.setEnvironmentSecret(trunk, custody.environment, custody.keySecret, pem);
      await cli.setEnvironmentVariable(trunk, custody.environment, custody.clientIdVariable, identity.clientId);
    });
  }

  type Status = Readonly<{ created: CreatedApp | null; note: string | null }>;

  /** Where each App stands, resuming a held key and detecting a name a half-finished attempt took. */
  async function statuses(): Promise<ReadonlyMap<ForgeAppRole, Status>> {
    const answer = new Map<ForgeAppRole, Status>();
    for (const role of FORGE_APP_ROLES) {
      const state = appKeyState(keyHome, role);
      if (state.state === "done") { answer.set(role, { created: createdApp(role, state.identity), note: null }); continue; }
      if (state.state === "held") {
        try {
          answer.set(role, { created: createdApp(role, await pushHeld(role)), note: null });
        } catch (error) {
          showRefusal(error, role);
          answer.set(role, { created: null, note: `The ${role} App exists and its key is stored on this host; pushing it into its environment failed. Reload this page to retry.` });
        }
        continue;
      }
      if (await cli.appExists(FORGE_APPS[role].name)) {
        const taken = new ForgeError("forge_app_name_taken", `An App named ${FORGE_APPS[role].name} exists, but no key for it is stored here.`, { role });
        answer.set(role, { created: null, note: `${taken.message} ${taken.remedy}` });
        continue;
      }
      answer.set(role, { created: null, note: null });
    }
    return answer;
  }

  const summary = async (): Promise<AppsPageSummary> => {
    const now = await statuses();
    return Object.freeze({
      created: FORGE_APP_ROLES.flatMap((role) => now.get(role)?.created ?? []),
      pending: FORGE_APP_ROLES.filter((role) => now.get(role)?.created === null),
    });
  };

  function stateFor(role: ForgeAppRole): string {
    for (const [state, owner] of states) if (owner === role) return state;
    const state = token();
    states.set(state, role);
    return state;
  }

  async function document(): Promise<unknown> {
    const now = await statuses();
    return {
      session,
      error: lastError,
      installationsUrl: `${web}/organizations/${settings.organization}/settings/installations`,
      discussionsUrl: `${web}/${trunk}/discussions/categories`,
      categories: options.discussionCategories.map((category) => ({ name: category.name, format: category.format, purpose: category.use })),
      legacyApps: settings.appsPage.legacyApps,
      apps: FORGE_APP_ROLES.map((role) => {
        const app = FORGE_APPS[role];
        const status = now.get(role)!;
        const creatable = status.created === null && status.note === null;
        return {
          role,
          name: app.name,
          permissions: Object.entries(app.permissions).map(([name, access]) => `${name}: ${access}`).join(", "),
          repositories: repositoriesOfKinds(settings, app.installedOn).map((repository) => repository.name),
          created: status.created,
          note: status.note,
          manifest: creatable ? JSON.stringify(appManifest(role, settings)) : null,
          createUrl: creatable ? `${web}/organizations/${settings.organization}/settings/apps/new?state=${stateFor(role)}` : null,
          installUrl: status.created === null ? null : `${web}/apps/${status.created.slug}/installations/new`,
        };
      }),
    };
  }

  /** Convert, verify, store FIRST (custody right after conversion), then push an environment key. */
  async function convert(role: ForgeAppRole, code: string): Promise<void> {
    const answer = await conversion.rest<Record<string, unknown>>({ method: "POST", path: `/app-manifests/${code}/conversions` });
    const material = verifyConversion(role, settings, answer.data ?? {});
    const identity = storeAppKey(keyHome, role, material);
    debugLog(FORGE_LOG_CATEGORY, "info", "forge_app_created", () => ({ role, appId: identity.appId, slug: identity.slug }));
    if (FORGE_APPS[role].custody.kind === "environment") await pushHeld(role);
  }

  let origin = "";
  const send = (response: ServerResponse, status: number, body: string, headers: Readonly<Record<string, string>> = {}): void => {
    response.writeHead(status, { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", ...headers });
    response.end(body);
  };
  const home = (): string => `/?t=${pageToken}`;

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // Host: only this page's own address (no DNS rebinding). Origin: when a browser sends one, only this page's own.
    if (request.headers.host !== new URL(origin).host) { send(response, 421, "This page answers only on its own address.\n"); return; }
    if (request.headers.origin !== undefined && request.headers.origin !== origin) { send(response, 403, "Refused: a request from another origin.\n"); return; }
    const url = new URL(request.url ?? "/", origin);
    if (request.method === "GET" && url.pathname === "/") {
      // The page, and every state it holds, only to the holder of the one-time token printed in the terminal.
      if (!sameToken(url.searchParams.get("t"), pageToken)) { send(response, 404, "Not found.\n"); return; }
      const nonce = token();
      send(response, 200, page(await document(), nonce), {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; form-action ${web} 'self'; base-uri 'none'; frame-ancestors 'none'`,
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/callback") {
      const state = url.searchParams.get("state") ?? "";
      const code = url.searchParams.get("code") ?? "";
      const role = states.get(state);
      try {
        if (role === undefined || !CODE.test(code)) throw new ForgeError("forge_apps_page_refused", "The callback carries an unknown or used state, or no valid code.", {});
        states.delete(state);
        await convert(role, code);
        lastError = undefined;
      } catch (error) {
        showRefusal(error, role ?? "unknown");
      }
      send(response, 303, "", { location: home() });
      return;
    }
    if (request.method === "POST" && url.pathname === "/done") {
      const form = await readForm(request);
      if (request.headers.origin !== origin || form.get("session") !== session) { send(response, 403, "Refused: not this page's own form.\n"); return; }
      send(response, 200, "Done. You can close this tab.\n", { "content-type": "text/plain; charset=utf-8" });
      finish(await summary());
      return;
    }
    send(response, 404, "Not found.\n");
  }

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      debugLog(FORGE_LOG_CATEGORY, "error", "forge_apps_page_failed", () => ({ error: error instanceof Error ? error.message : String(error) }));
      if (!response.headersSent) send(response, 500, "The page failed; see the harness log.\n");
      else response.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", guarded("forge.apps-page.listen", (error: NodeJS.ErrnoException) => reject(new ForgeError("forge_apps_page_unavailable", `The page could not listen on 127.0.0.1:${String(options.port)} (${error.code ?? error.message}).`, { port: options.port }))));
    server.listen(options.port, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  if (options.port !== 0 && origin !== appsPageOrigin(settings)) {
    throw new ForgeError("forge_apps_page_unavailable", "The page listens elsewhere than the manifests' callback.", { origin });
  }
  const close = (): Promise<void> => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  void done.then(close);
  return Object.freeze({ url: `${origin}${home()}`, done, close });
}
