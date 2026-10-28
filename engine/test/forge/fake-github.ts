/**
 * A FAKE GITHUB FOR TESTS — a stateful GitHub on the loopback upstream
 * (`../support/loopback-upstream.ts`), so a test drives the forge adapter's
 * OWN transport (the one outbound HTTP door) exactly as production does.
 * Every lane that builds on the forge port tests against it.
 *
 * What it answers like GitHub does:
 * - an OBJECT STORE by API path: `GET` answers the stored JSON with an ETag
 *   (and 304 to a matching `If-None-Match`, not counted against the rate
 *   limit); a stored LIST is paginated (`per_page`, `page`, a `Link` header);
 *   `PUT` replaces, `PATCH` merges, `POST` to a stored list appends (with an
 *   `id`), `DELETE` removes (204); an unknown path is 404. A declared
 *   COLLECTION ({@link FakeGithub.collection}) also keeps each item at
 *   `<list>/<key>` in step with the list;
 * - APPS: {@link FakeGithub.installApp} registers an App (its RSA key pair is
 *   generated here; the private PEM is handed to the test to store through
 *   the real custody). `GET /repos/{o}/{r}/installation` and
 *   `POST /app/installations/{id}/access_tokens` require a valid RS256 JWT
 *   whose `iss` is the client id; the token is minted with exactly the asked
 *   permissions and repositories (a permission the installation lacks is 422);
 *   `GET /app/installations` (JWT) answers the App's one installation, and
 *   `GET /installation/repositories` the repositories a token reaches;
 * - the MANIFEST FLOW: {@link FakeGithub.pendingConversion} plants a code;
 *   `POST /app-manifests/{code}/conversions` answers its material once, as
 *   GitHub does (owner, name, permissions, events, the key);
 * - AUTHENTICATION: every other request needs `Authorization: Bearer <token>`
 *   with a token this fake minted ({@link FakeGithub.userToken} or an
 *   installation token); anything else is 401;
 * - the PINNED VERSION: a request without `X-GitHub-Api-Version: 2026-03-10`
 *   is 400, as GitHub answers an unsupported version;
 * - REFUSALS on demand: {@link FakeGithub.refuseNext} answers the next
 *   matching request with the given status, message and headers (a rate
 *   limit, a secondary limit, a plan refusal);
 * - routes of a test's own ({@link FakeGithub.route}), GraphQL included; a
 *   route answers before the built-in endpoints (to plant a wrong answer) and
 *   only for an authenticated request.
 *
 * Tokens are assembled at runtime from random bytes: no credential-shaped
 * literal is in the tree.
 */
import { generateKeyPairSync, randomBytes, verify, type KeyObject } from "node:crypto";

import { canonicalJson, sha256 } from "../../src/kernel/integrity.ts";
import { GITHUB_API_VERSION, type ForgeEndpoint } from "../../src/workflow/forge/port.ts";
import { address, serve } from "../support/loopback-upstream.ts";

export const FAKE_GITHUB_ORIGIN = "https://api.github.com";

export type FakeRequest = Readonly<{ method: string; path: string; query: URLSearchParams; headers: Headers; body: unknown }>;
export type FakeAnswer = Readonly<{ status: number; body?: unknown; headers?: Readonly<Record<string, string>> }>;
export type FakeRoute = (request: FakeRequest, match: RegExpMatchArray) => FakeAnswer | undefined;

export type FakeApp = Readonly<{
  appId: number;
  slug: string;
  clientId: string;
  installationId: number;
  /** The App's private key (PEM), for the test to store through the real custody. */
  pem: string;
  /** The installation's permissions and repositories (`owner/name`). */
  permissions: Readonly<Record<string, string>>;
  repositories: readonly string[];
}>;

type MintedToken = Readonly<{ kind: "user" | "installation"; principal: string; permissions?: Readonly<Record<string, string>>; repositories?: readonly string[] }>;

export type FakeGithub = Readonly<{
  apiUrl: string;
  /** An endpoint for the adapter, bounded for tests. */
  endpoint: (overrides?: Partial<ForgeEndpoint>) => ForgeEndpoint;
  /** Every request received, oldest first. */
  requests: FakeRequest[];
  /** The object store by API path (no query). */
  objects: Map<string, unknown>;
  /** How long a minted installation token lives (GitHub: one hour). */
  tokens: { lifetimeMs: number };
  /** The rate-limit window's remaining count (decremented per counted answer). */
  rate: { limit: number; remaining: number; resetEpochSeconds: number };
  route: (method: string, pattern: RegExp, handler: FakeRoute) => void;
  /**
   * Declare a collection at `path` (a list API whose items are addressed at
   * `<path>/<item[key]>`): POST appends and creates the item (with
   * `defaults`, the fields GitHub adds), PUT, PATCH and DELETE on an item
   * keep the list in step.
   */
  collection: (path: string, items: readonly Record<string, unknown>[], key?: string, defaults?: Readonly<Record<string, unknown>>) => void;
  refuseNext: (match: Readonly<{ method?: string; path?: RegExp }>, answer: Readonly<{ status: number; message: string; headers?: Readonly<Record<string, string>> }>) => void;
  /** A token for a user principal (a maintainer's token or a workflow's). */
  userToken: (principal: string) => string;
  installApp: (input: Readonly<{ slug: string; permissions: Readonly<Record<string, string>>; repositories: readonly string[] }>) => FakeApp;
  pendingConversion: (code: string, input: Readonly<{ slug: string; permissions: Readonly<Record<string, string>>; repositories: readonly string[] }>) => FakeApp;
  /** The principal a request's token belongs to (undefined when unknown). */
  principalOf: (request: FakeRequest) => string | undefined;
}>;

function json(status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): FakeAnswer {
  return { status, body, headers };
}

function runtimeToken(prefix: string): string {
  return [prefix, randomBytes(18).toString("hex")].join("_");
}

function decodeSegment(segment: string): unknown {
  try { return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")); } catch { return undefined; }
}

/** Start a fresh fake GitHub, installed as the loopback upstream's handler. */
export function fakeGithub(): FakeGithub {
  const apiUrl = address(FAKE_GITHUB_ORIGIN);
  const requests: FakeRequest[] = [];
  const objects = new Map<string, unknown>();
  /** Lists whose items are also objects at `<list>/<item[key]>` (a collection API: rulesets, labels, autolinks). */
  const collections = new Map<string, Readonly<{ key: string; defaults: Readonly<Record<string, unknown>> }>>();
  const routes: { method: string; pattern: RegExp; handler: FakeRoute }[] = [];
  const refusals: { method?: string; path?: RegExp; status: number; message: string; headers?: Readonly<Record<string, string>> }[] = [];
  const tokens = new Map<string, MintedToken>();
  const apps: (FakeApp & { publicKey: KeyObject })[] = [];
  const conversions = new Map<string, FakeApp>();
  const tokenPolicy = { lifetimeMs: 3600_000 };
  const rate = { limit: 5000, remaining: 5000, resetEpochSeconds: Math.floor(Date.now() / 1000) + 3600 };
  let nextId = 1000;

  function newApp(input: Readonly<{ slug: string; permissions: Readonly<Record<string, string>>; repositories: readonly string[] }>): FakeApp & { publicKey: KeyObject } {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const app = {
      appId: nextId++, slug: input.slug, clientId: `Iv23${randomBytes(8).toString("hex")}`, installationId: nextId++,
      pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), permissions: { ...input.permissions, metadata: "read" },
      repositories: [...input.repositories], publicKey,
    };
    apps.push(app);
    return app;
  }

  /** The App a valid JWT names, or undefined. */
  function jwtApp(authorization: string | null): (FakeApp & { publicKey: KeyObject }) | undefined {
    const token = authorization?.replace(/^Bearer /u, "") ?? "";
    const [header, payload, signature] = token.split(".");
    if (header === undefined || payload === undefined || signature === undefined) return undefined;
    const claims = decodeSegment(payload) as { iss?: unknown; exp?: unknown; iat?: unknown } | undefined;
    const app = apps.find((candidate) => candidate.clientId === claims?.iss);
    if (app === undefined || (decodeSegment(header) as { alg?: unknown } | undefined)?.alg !== "RS256") return undefined;
    const now = Math.floor(Date.now() / 1000);
    if (typeof claims?.exp !== "number" || claims.exp <= now || claims.exp - now > 600 || typeof claims.iat !== "number" || claims.iat > now + 60) return undefined;
    return verify("sha256", Buffer.from(`${header}.${payload}`), app.publicKey, Buffer.from(signature, "base64url")) ? app : undefined;
  }

  function counted(answer: FakeAnswer, countIt: boolean): FakeAnswer {
    if (countIt && rate.remaining > 0) rate.remaining -= 1;
    return { ...answer, headers: {
      "x-ratelimit-limit": String(rate.limit), "x-ratelimit-remaining": String(rate.remaining),
      "x-ratelimit-used": String(rate.limit - rate.remaining), "x-ratelimit-reset": String(rate.resetEpochSeconds), "x-ratelimit-resource": "core",
      "x-github-request-id": randomBytes(6).toString("hex").toUpperCase(),
      ...answer.headers,
    } };
  }

  function etagOf(value: unknown): string {
    return `W/"${sha256(canonicalJson(value)).slice(0, 32)}"`;
  }

  function store(request: FakeRequest): FakeAnswer {
    const { method, path } = request;
    const current = objects.get(path);
    if (method === "GET") {
      if (current === undefined) return json(404, { message: "Not Found", documentation_url: "https://docs.github.com/rest" });
      if (!Array.isArray(current)) {
        const etag = etagOf(current);
        if (request.headers.get("if-none-match") === etag) return { status: 304, headers: { etag } };
        return json(200, current, { etag });
      }
      const perPage = Number(request.query.get("per_page") ?? "30");
      const page = Number(request.query.get("page") ?? "1");
      const slice = current.slice((page - 1) * perPage, page * perPage);
      const etag = etagOf({ slice, page, perPage });
      const headers: Record<string, string> = { etag };
      if (page * perPage < current.length) headers.link = `<${apiUrl}${path}?per_page=${String(perPage)}&page=${String(page + 1)}>; rel="next"`;
      if (request.headers.get("if-none-match") === etag) return { status: 304, headers };
      return json(200, slice, headers);
    }
    const parent = path.slice(0, path.lastIndexOf("/"));
    const keyField = collections.get(parent)?.key;
    /** Keep a collection's list entry equal to its item object. */
    const syncParent = (item: unknown, remove = false): void => {
      if (keyField === undefined) return;
      const list = objects.get(parent) as Record<string, unknown>[];
      const index = list.findIndex((entry) => `${parent}/${String(entry[keyField])}` === path);
      if (index !== -1) list.splice(index, 1);
      if (!remove) list.splice(index === -1 ? list.length : index, 0, item as Record<string, unknown>);
    };
    if (method === "PUT") {
      // A collection item keeps what GitHub adds (its id, its source); the body replaces the rest.
      const replaced = keyField !== undefined && current !== undefined ? { ...(current as object), ...(request.body as object) } : request.body;
      objects.set(path, replaced);
      syncParent(replaced);
      return json(200, replaced);
    }
    if (method === "PATCH") {
      if (current === undefined || Array.isArray(current) || typeof current !== "object") return json(404, { message: "Not Found" });
      const merged = { ...(current as object), ...(request.body as object) };
      objects.set(path, merged);
      syncParent(merged);
      return json(200, merged);
    }
    if (method === "POST") {
      if (!Array.isArray(current)) return json(404, { message: "Not Found" });
      const declared = collections.get(path);
      const created: Record<string, unknown> = { id: nextId++, ...declared?.defaults, ...(request.body as object) };
      current.push(created);
      if (declared !== undefined) objects.set(`${path}/${String(created[declared.key])}`, created);
      return json(201, created);
    }
    if (method === "DELETE") {
      if (current === undefined) return json(404, { message: "Not Found" });
      objects.delete(path);
      syncParent(undefined, true);
      return { status: 204 };
    }
    return json(404, { message: "Not Found" });
  }

  function builtIn(request: FakeRequest): FakeAnswer | undefined {
    const conversion = /^\/app-manifests\/([^/]+)\/conversions$/u.exec(request.path);
    if (request.method === "POST" && conversion !== null) {
      const app = conversions.get(conversion[1]!);
      if (app === undefined) return json(404, { message: "Not Found" });
      conversions.delete(conversion[1]!);
      const owner = app.repositories[0]?.split("/")[0] ?? "LLM-4-People";
      return json(201, {
        id: app.appId, slug: app.slug, name: app.slug, owner: { login: owner, type: "Organization" },
        permissions: app.permissions, events: [],
        client_id: app.clientId, client_secret: runtimeToken("secret"), webhook_secret: null, pem: app.pem,
      });
    }
    const installation = /^\/repos\/([^/]+)\/([^/]+)\/installation$/u.exec(request.path);
    if (request.method === "GET" && installation !== null) {
      const app = jwtApp(request.headers.get("authorization"));
      if (app === undefined) return json(401, { message: "A JSON web token could not be decoded" });
      if (!app.repositories.includes(`${installation[1]!}/${installation[2]!}`)) return json(404, { message: "Not Found" });
      return json(200, { id: app.installationId, app_id: app.appId, app_slug: app.slug, permissions: app.permissions });
    }
    if (request.method === "GET" && request.path === "/app/installations") {
      // The App's own installations (its JWT): one, on the owner of its repositories, on selected repositories.
      const app = jwtApp(request.headers.get("authorization"));
      if (app === undefined) return json(401, { message: "A JSON web token could not be decoded" });
      const owner = app.repositories[0]?.split("/")[0] ?? "LLM-4-People";
      return json(200, [{ id: app.installationId, app_id: app.appId, app_slug: app.slug, account: { login: owner, type: "Organization" }, repository_selection: "selected", permissions: app.permissions, events: [] }]);
    }
    if (request.method === "GET" && request.path === "/installation/repositories") {
      // The repositories an installation token reaches (GitHub wraps the list).
      const minted = tokens.get(request.headers.get("authorization")?.replace(/^Bearer /u, "") ?? "");
      if (minted?.kind !== "installation") return json(403, { message: "Resource not accessible by integration" });
      const app = apps.find((candidate) => candidate.slug === minted.principal)!;
      const owner = app.repositories[0]!.split("/")[0]!;
      const names = minted.repositories ?? [];
      return json(200, { total_count: names.length, repository_selection: "selected", repositories: names.map((name) => ({ name, full_name: `${owner}/${name}` })) });
    }
    const accessTokens = /^\/app\/installations\/(\d+)\/access_tokens$/u.exec(request.path);
    if (request.method === "POST" && accessTokens !== null) {
      const app = jwtApp(request.headers.get("authorization"));
      if (app === undefined) return json(401, { message: "A JSON web token could not be decoded" });
      if (app.installationId !== Number(accessTokens[1])) return json(404, { message: "Not Found" });
      const body = (request.body ?? {}) as { permissions?: Record<string, string>; repositories?: string[] };
      const asked = body.permissions ?? app.permissions;
      for (const [name, access] of Object.entries(asked)) {
        const held = app.permissions[name];
        if (held === undefined || (access === "write" && held === "read")) return json(422, { message: `The permissions requested are not granted to this installation.`, errors: [name] });
      }
      const owner = app.repositories[0]!.split("/")[0]!;
      const names = body.repositories ?? app.repositories.map((entry) => entry.split("/")[1]!);
      if (names.some((name) => !app.repositories.includes(`${owner}/${name}`))) return json(422, { message: "There is at least one repository that does not exist or is not accessible to the parent installation." });
      const token = runtimeToken("ghs");
      const permissions = { ...asked, metadata: "read" };
      tokens.set(token, { kind: "installation", principal: app.slug, permissions, repositories: names });
      return json(201, { token, expires_at: new Date(Date.now() + tokenPolicy.lifetimeMs).toISOString(), permissions, repository_selection: "selected", repositories: names.map((name) => ({ name, full_name: `${owner}/${name}` })) });
    }
    return undefined;
  }

  serve(async (url, init) => {
    const parsed = new URL(url);
    const base = new URL(FAKE_GITHUB_ORIGIN);
    let body: unknown;
    try { body = init.body === undefined ? undefined : JSON.parse(init.body); } catch { body = init.body; }
    const request: FakeRequest = Object.freeze({ method: init.method, path: decodeURIComponent(parsed.pathname.slice(base.pathname.replace(/\/$/u, "").length)) || "/", query: parsed.searchParams, headers: init.headers, body });
    requests.push(request);
    const answer = ((): FakeAnswer => {
      if (request.headers.get("x-github-api-version") !== GITHUB_API_VERSION) return json(400, { message: "Unsupported API version" });
      const refusalIndex = refusals.findIndex((entry) => (entry.method === undefined || entry.method === request.method) && (entry.path === undefined || entry.path.test(request.path)));
      if (refusalIndex !== -1) {
        const [refusal] = refusals.splice(refusalIndex, 1);
        return json(refusal!.status, { message: refusal!.message, documentation_url: "https://docs.github.com/rest" }, refusal!.headers ?? {});
      }
      const token = request.headers.get("authorization")?.replace(/^Bearer /u, "");
      const conversion = request.method === "POST" && /^\/app-manifests\/[^/]+\/conversions$/u.test(request.path);
      if (!conversion && (token === undefined || (!tokens.has(token) && jwtApp(request.headers.get("authorization")) === undefined))) return json(401, { message: "Bad credentials" });
      for (const route of routes) {
        if (route.method !== request.method) continue;
        const match = route.pattern.exec(request.path);
        if (match === null) continue;
        const routed = route.handler(request, match);
        if (routed !== undefined) return routed;
      }
      const built = builtIn(request);
      if (built !== undefined) return built;
      if (!tokens.has(token ?? "")) return json(401, { message: "A JSON web token is not a token for this endpoint" });
      return store(request);
    })();
    const final = counted(answer, answer.status !== 304);
    const hasBody = final.body !== undefined && final.status !== 204 && final.status !== 304;
    return new Response(hasBody ? JSON.stringify(final.body) : null, { status: final.status, headers: { ...(hasBody ? { "content-type": "application/json; charset=utf-8" } : {}), ...final.headers } });
  });

  return Object.freeze({
    apiUrl,
    endpoint: (overrides: Partial<ForgeEndpoint> = {}) => Object.freeze({
      apiUrl, allowPrivateAddress: true, timeoutMs: 10_000, maxResponseBytes: 1_048_576, cleanupTimeoutMs: 1_000, etagCacheEntries: 64,
      userAgent: "bridlewise-forge-test", ...overrides,
    }),
    requests,
    objects,
    tokens: tokenPolicy,
    rate,
    route: (method: string, pattern: RegExp, handler: FakeRoute) => { routes.push({ method, pattern, handler }); },
    collection: (path: string, items: readonly Record<string, unknown>[], key = "id", defaults: Readonly<Record<string, unknown>> = {}) => {
      const list: Record<string, unknown>[] = items.map((item) => ({ ...(key === "id" && item.id === undefined ? { id: nextId++ } : {}), ...item }));
      objects.set(path, list);
      collections.set(path, { key, defaults });
      for (const item of list) objects.set(`${path}/${String(item[key])}`, item);
    },
    refuseNext: (match, answer) => { refusals.push({ ...match, ...answer }); },
    userToken: (principal: string) => {
      const token = runtimeToken("gho");
      tokens.set(token, { kind: "user", principal });
      return token;
    },
    installApp: (input) => newApp(input),
    pendingConversion: (code, input) => {
      const app = newApp(input);
      conversions.set(code, app);
      return app;
    },
    principalOf: (request: FakeRequest) => tokens.get(request.headers.get("authorization")?.replace(/^Bearer /u, "") ?? "")?.principal,
  });
}
