/**
 * THE APPS PAGE — `harness forge apps create` (runbook P1.2, GH-1a; the
 * user's Session 1, items 3 to 6). A local page on 127.0.0.1 only, which:
 *
 * 1. offers one **Create** button per App. Each posts the App's generated
 *    manifest (`generated-files.ts` `appManifest`, the same bytes as
 *    `.github/forge/apps/<role>.json`) to GitHub's organisation App-creation
 *    form, with a one-use random `state`;
 * 2. on GitHub's redirect (`/callback?code&state`), converts the code
 *    (`POST /app-manifests/{code}/conversions`, unauthenticated: the one-hour
 *    code is the secret) and puts the key where the registry says, never in
 *    a file of its own:
 *    - `host` custody (agent, verifier): the host key custody
 *      (`app-keys.ts`, the key home);
 *    - `environment` custody (door, publisher): the GitHub environment secret
 *      through the maintainer's `gh` (`maintainer-cli.ts`), with the client
 *      id as an environment variable.
 *    The client secret and webhook secret GitHub also returns are dropped
 *    (no OAuth, no webhook);
 * 3. lists what Session 1 still asks of the maintainer: each App's install
 *    link and the exact repositories to select (from the registry's kinds
 *    and the topology), the legacy Apps to narrow, and the Discussion
 *    categories to create.
 *
 * The page is rendered from ONE JSON document embedded in it (no value is
 * ever spliced into HTML: the page's own script builds the DOM with
 * `textContent` and form values), served with a content security policy
 * that admits only that script. Every request must name this page's own
 * host (no DNS rebinding); `/done` must carry the page's session token and
 * come from its own origin. Nothing here waits on a timer: the page lives
 * until the maintainer presses **Done** (or the process is stopped).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { HarnessError } from "../../kernel/errors.ts";
import { randomBytes } from "../../kernel/integrity.ts";
import { debugLog } from "../../shared/debug/debug-system.ts";
import type { AdmittedKeyHome } from "../../filesystem/self-protection/key-home.ts";
import { FORGE_APP_ROLES, FORGE_APPS, type ForgeAppRole } from "./app-registry.ts";
import { storeAppKey } from "./app-keys.ts";
import { ForgeError, isForgeError } from "./codes.ts";
import { anonymousCredential } from "./credentials.ts";
import { FORGE_DISCUSSION_CATEGORIES } from "./discussion-categories.ts";
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
}>;

export type AppsPage = Readonly<{
  /** `http://127.0.0.1:<port>/`. */
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
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_FORM_BYTES) { reject(new ForgeError("forge_apps_page_refused", "The form is larger than the page ever sends.", {})); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(new URLSearchParams(Buffer.concat(chunks).toString("utf8"))));
    request.on("error", reject);
  });
}

/** Serve the Apps page (see the module header). */
export async function serveAppsPage(options: AppsPageOptions): Promise<AppsPage> {
  const { settings, keyHome, cli } = options;
  const trunk = `${settings.organization}/${trunkRepository(settings).name}`;
  const web = settings.webUrl.replace(/\/$/u, "");
  const conversion = githubClient(options.endpoint, anonymousCredential("anonymous:app-manifest-conversion"));
  const session = token();
  const states = new Map<string, ForgeAppRole>();
  const created = new Map<ForgeAppRole, CreatedApp>();
  let lastError: Readonly<{ code: string; message: string; remedy: string }> | undefined;
  let finish: (summary: AppsPageSummary) => void = () => undefined;
  const done = new Promise<AppsPageSummary>((resolve) => { finish = resolve; });

  const summary = (): AppsPageSummary => Object.freeze({
    created: FORGE_APP_ROLES.flatMap((role) => created.get(role) ?? []),
    pending: FORGE_APP_ROLES.filter((role) => !created.has(role)),
  });

  function stateFor(role: ForgeAppRole): string {
    for (const [state, owner] of states) if (owner === role) return state;
    const state = token();
    states.set(state, role);
    return state;
  }

  function document(): unknown {
    return {
      session,
      error: lastError,
      installationsUrl: `${web}/organizations/${settings.organization}/settings/installations`,
      discussionsUrl: `${web}/${trunk}/discussions/categories`,
      categories: FORGE_DISCUSSION_CATEGORIES,
      legacyApps: settings.appsPage.legacyApps,
      apps: FORGE_APP_ROLES.map((role) => {
        const app = FORGE_APPS[role];
        const made = created.get(role);
        return {
          role,
          name: app.name,
          permissions: Object.entries(app.permissions).map(([name, access]) => `${name}: ${access}`).join(", "),
          repositories: repositoriesOfKinds(settings, app.installedOn).map((repository) => repository.name),
          created: made ?? null,
          manifest: made === undefined ? JSON.stringify(appManifest(role, settings)) : null,
          createUrl: made === undefined ? `${web}/organizations/${settings.organization}/settings/apps/new?state=${stateFor(role)}` : null,
          installUrl: made === undefined ? null : `${web}/apps/${made.slug}/installations/new`,
        };
      }),
    };
  }

  async function convert(role: ForgeAppRole, code: string): Promise<CreatedApp> {
    const answer = await conversion.rest<Record<string, unknown>>({ method: "POST", path: `/app-manifests/${code}/conversions` });
    const { id, slug, client_id: clientId, pem } = answer.data ?? {};
    if (typeof id !== "number" || typeof slug !== "string" || typeof clientId !== "string" || typeof pem !== "string") {
      throw new ForgeError("github_response_invalid", "GitHub's manifest conversion carries no App id, slug, client id or key.", { role });
    }
    const custody = FORGE_APPS[role].custody;
    if (custody.kind === "host") {
      storeAppKey(keyHome, role, { appId: id, slug, clientId, pem });
      return Object.freeze({ role, appId: id, slug, clientId, keyStoredIn: "the host key home" });
    }
    cli.setEnvironmentSecret(trunk, custody.environment, custody.keySecret, pem);
    cli.setEnvironmentVariable(trunk, custody.environment, custody.clientIdVariable, clientId);
    return Object.freeze({ role, appId: id, slug, clientId, keyStoredIn: `the ${custody.environment} environment of ${trunk} (secret ${custody.keySecret})` });
  }

  let origin = "";
  const send = (response: ServerResponse, status: number, body: string, headers: Readonly<Record<string, string>> = {}): void => {
    response.writeHead(status, { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", ...headers });
    response.end(body);
  };

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.headers.host !== new URL(origin).host) { send(response, 421, "This page answers only on its own address.\n"); return; }
    const url = new URL(request.url ?? "/", origin);
    if (request.method === "GET" && url.pathname === "/") {
      const nonce = token();
      send(response, 200, page(document(), nonce), {
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
        const app = await convert(role, code);
        created.set(role, app);
        lastError = undefined;
        debugLog(FORGE_LOG_CATEGORY, "info", "forge_app_created", () => ({ role, appId: app.appId, slug: app.slug }));
      } catch (error) {
        // Every typed refusal is shown on the page (a forge code with its remedy; another harness refusal with its code); anything else is a defect (500).
        if (!(error instanceof HarnessError)) throw error;
        lastError = isForgeError(error)
          ? { code: error.forgeCode, message: error.message, remedy: error.remedy }
          : { code: error.code, message: error.message, remedy: "See the harness log for this refusal; nothing was stored for this App." };
        debugLog(FORGE_LOG_CATEGORY, "warn", lastError.code, () => ({ role: role ?? "unknown" }));
      }
      send(response, 303, "", { location: "/" });
      return;
    }
    if (request.method === "POST" && url.pathname === "/done") {
      const form = await readForm(request);
      if (request.headers.origin !== origin || form.get("session") !== session) { send(response, 403, "Refused: not this page's own form.\n"); return; }
      send(response, 200, "Done. You can close this tab.\n", { "content-type": "text/plain; charset=utf-8" });
      finish(summary());
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
    server.once("error", (error: NodeJS.ErrnoException) => reject(new ForgeError("forge_apps_page_unavailable", `The page could not listen on 127.0.0.1:${String(options.port)} (${error.code ?? error.message}).`, { port: options.port })));
    server.listen(options.port, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  if (options.port !== 0 && origin !== appsPageOrigin(settings)) {
    throw new ForgeError("forge_apps_page_unavailable", "The page listens elsewhere than the manifests' callback.", { origin });
  }
  const close = (): Promise<void> => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  void done.then(close);
  return Object.freeze({ url: `${origin}/`, done, close });
}
