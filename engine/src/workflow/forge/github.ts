/**
 * THE GITHUB ADAPTER — the forge port (`port.ts`) on the ONE outbound HTTP
 * door (`src/shared/outbound-http.ts`: pinned destinations, no redirects,
 * verified TLS, bounded bodies and deadlines). It is the only code that builds
 * a GitHub request; every lane calls `rest`, `paginate` or `graphql` on the
 * client {@link githubClient} returns.
 *
 * It owns, once: the pinned API version and media type, the conditional-GET
 * cache (ETags), the `Link` pagination, the classification of every refusal
 * GitHub answers with (`classifyGithubAnswer`, into `codes.ts`), and the
 * debug log of each request (category `forge`; method, path, status, the
 * rate-limit facts; never a header value or a body).
 */
import { isAbortError } from "../../kernel/errors.ts";
import { deepFreeze } from "../../kernel/integrity.ts";
import { parseJsonExact } from "../../kernel/json-integrity.ts";
import { debugLog } from "../../shared/debug/debug-system.ts";
import { dispatchOutboundRequest, discardBody, isOutboundHttpError, outboundDeadline, prepareOutboundRequest, readBody } from "../../shared/outbound-http.ts";
import { ForgeError, type ForgeCode } from "./codes.ts";
import {
  GITHUB_API_VERSION,
  GITHUB_JSON_MEDIA_TYPE,
  type ForgeClient,
  type ForgeCredential,
  type ForgeEndpoint,
  type ForgeMethod,
  type ForgePageOptions,
  type ForgeRateFacts,
  type ForgeRequest,
  type ForgeResponse,
} from "./port.ts";

/** The central-log category of every forge request. */
export const FORGE_LOG_CATEGORY = "forge";

const MUTATING: ReadonlySet<ForgeMethod> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * What GitHub says when a feature is outside the plan (or its add-ons):
 * "Upgrade to GitHub Pro or make this repository public to enable this
 * feature.", "… requires GitHub Advanced Security / Secret Protection",
 * "… is not available for this plan / on private repositories". Read only on a
 * 403, 404 or 422, where it is the only difference from a permission or a
 * validation refusal.
 */
const PLAN_REFUSAL = /upgrade to github|make this repository public|not available (?:for|on|with) (?:this|your|the|private)|(?:requires?|purchase) (?:a |the )?github (?:pro|team|enterprise|advanced security)|advanced security (?:must|is not|isn't)|secret protection (?:is not|isn't|must|add-on)|code security (?:is not|isn't|must)|only available (?:on|for|with) (?:github )?(?:pro|team|enterprise)/iu;
const SECONDARY_LIMIT = /secondary rate limit|abuse detection/iu;

/** The API's origin and base path, checked once. */
function apiBase(endpoint: ForgeEndpoint): URL {
  let url: URL;
  try { url = new URL(endpoint.apiUrl); } catch {
    throw new ForgeError("forge_endpoint_invalid", "The forge API URL is not an absolute URL.", { apiUrl: endpoint.apiUrl });
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new ForgeError("forge_endpoint_invalid", "The forge API URL must be an https URL with no credentials, query or fragment.", { apiUrl: endpoint.apiUrl });
  }
  return url;
}

/** The request URL of `path` under the API base (`path` checked: an API path, never a URL or a traversal). */
export function forgeRequestUrl(endpoint: ForgeEndpoint, path: string, query?: ForgeRequest["query"]): URL {
  const base = apiBase(endpoint);
  if (!path.startsWith("/") || path.startsWith("//") || /[?#\\]|\/\.\.?(?:\/|$)|%2e%2e|%2f/iu.test(path) || /\s/u.test(path)) {
    throw new ForgeError("forge_request_invalid", "A forge request names an API path starting with '/', with no query, fragment, traversal or encoded separator.", { path });
  }
  const url = new URL(`${base.href.replace(/\/$/u, "")}${path}`);
  for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, String(value));
  return url;
}

function numberHeader(headers: Headers, name: string): number | undefined {
  const value = headers.get(name);
  if (value === null || !/^\d+$/u.test(value)) return undefined;
  return Number(value);
}

/** The rate-limit facts of an answer. */
export function rateFactsOf(headers: Headers): ForgeRateFacts {
  const reset = numberHeader(headers, "x-ratelimit-reset");
  const facts: { -readonly [K in keyof ForgeRateFacts]: ForgeRateFacts[K] } = {};
  const limit = numberHeader(headers, "x-ratelimit-limit");
  const remaining = numberHeader(headers, "x-ratelimit-remaining");
  const used = numberHeader(headers, "x-ratelimit-used");
  const resource = headers.get("x-ratelimit-resource");
  if (limit !== undefined) facts.limit = limit;
  if (remaining !== undefined) facts.remaining = remaining;
  if (used !== undefined) facts.used = used;
  if (reset !== undefined) facts.resetAt = new Date(reset * 1000).toISOString();
  if (resource !== null) facts.resource = resource;
  return Object.freeze(facts);
}

/** The next page's API path from a `Link` header, relative to the API base; a link elsewhere is refused. */
export function nextPagePath(endpoint: ForgeEndpoint, link: string | null): string | undefined {
  if (link === null) return undefined;
  const match = /<([^>]+)>\s*;\s*rel="next"/u.exec(link);
  if (match === null) return undefined;
  const base = apiBase(endpoint);
  let next: URL;
  try { next = new URL(match[1]!); } catch { throw new ForgeError("github_response_invalid", "GitHub's Link header names a next page that is not a URL.", {}); }
  const prefix = base.pathname.replace(/\/$/u, "");
  if (next.origin !== base.origin || !next.pathname.startsWith(`${prefix}/`)) {
    throw new ForgeError("github_response_invalid", "GitHub's Link header names a next page outside the API.", { origin: next.origin });
  }
  return `${next.pathname.slice(prefix.length)}${next.search}`;
}

type ErrorBody = Readonly<{ message: string; documentationUrl: string | undefined; errors: readonly string[] }>;

function errorBodyOf(text: string): ErrorBody {
  const parsed = parseJsonExact(text)?.value;
  if (typeof parsed !== "object" || parsed === null) return { message: text.slice(0, 300), documentationUrl: undefined, errors: [] };
  const body = parsed as Record<string, unknown>;
  const errors = Array.isArray(body.errors) ? body.errors.map((entry) => typeof entry === "string" ? entry : JSON.stringify(entry)).slice(0, 20) : [];
  return {
    message: typeof body.message === "string" ? body.message : "",
    documentationUrl: typeof body.documentation_url === "string" ? body.documentation_url : undefined,
    errors,
  };
}

/**
 * THE ONE CLASSIFICATION of a refused GitHub answer (non-2xx, non-304) into a
 * forge code with its facts. Pure: the status, the headers, the body text and
 * the method decide.
 */
export function classifyGithubAnswer(status: number, headers: Headers, bodyText: string, method: ForgeMethod, path: string): ForgeError {
  const body = errorBodyOf(bodyText);
  const rate = rateFactsOf(headers);
  const retryAfter = numberHeader(headers, "retry-after");
  const base = { status, path, method, message: body.message, ...(body.documentationUrl === undefined ? {} : { documentationUrl: body.documentationUrl }), ...(body.errors.length === 0 ? {} : { errors: body.errors }) };
  const raise = (code: ForgeCode, text: string, extra: Readonly<Record<string, string | number>> = {}): ForgeError => new ForgeError(code, `${method} ${path}: ${text}`, { ...base, ...extra });
  if (status === 401) return raise("github_unauthorized", "GitHub refused the credential.");
  if (status === 403 || status === 429) {
    if (rate.remaining === 0) return raise("github_rate_limited", "the primary rate limit is spent.", rate.resetAt === undefined ? {} : { resetAt: rate.resetAt });
    if (SECONDARY_LIMIT.test(body.message) || retryAfter !== undefined) {
      // GitHub's rule without a `retry-after`: wait at least a minute (the remedy says so); no number is invented here.
      const wait = retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter };
      return MUTATING.has(method)
        ? raise("github_content_budget_exhausted", "the content-creation budget is spent.", wait)
        : raise("github_secondary_rate_limited", "a secondary rate limit refused the request.", wait);
    }
  }
  if ((status === 403 || status === 404 || status === 422) && PLAN_REFUSAL.test(body.message)) return raise("unavailable_on_plan", "the feature is not available on this plan.");
  if (status === 403 || status === 429) return raise("github_forbidden", "GitHub refused the action for this principal.");
  if (status === 404 || status === 410) return raise("github_not_found", "GitHub answered that the object does not exist or is not visible.");
  if (status === 409) return raise("github_conflict", "the object is in a state that refuses this action.");
  if (status === 412) return raise("github_precondition_failed", "the request's precondition no longer holds.");
  if (status >= 500) return raise("github_unavailable", "GitHub failed.");
  return raise("github_validation_failed", "GitHub refused the payload.");
}

type CachedAnswer = Readonly<{ etag: string; data: unknown }>;

/** A bounded least-recently-used map of conditional-GET answers. */
function etagCache(capacity: number): Readonly<{ get: (key: string) => CachedAnswer | undefined; set: (key: string, answer: CachedAnswer) => void }> {
  const entries = new Map<string, CachedAnswer>();
  return Object.freeze({
    get: (key: string) => {
      const hit = entries.get(key);
      if (hit !== undefined) { entries.delete(key); entries.set(key, hit); }
      return hit;
    },
    set: (key: string, answer: CachedAnswer) => {
      entries.delete(key);
      entries.set(key, answer);
      while (entries.size > capacity) entries.delete(entries.keys().next().value!);
    },
  });
}

function parseBody(text: string, method: ForgeMethod, path: string): unknown {
  if (text.trim() === "") return undefined;
  const parsed = parseJsonExact(text);
  if (parsed === undefined) throw new ForgeError("github_response_invalid", `${method} ${path}: GitHub answered with a body that is not JSON.`, { method, path });
  return deepFreeze(parsed.value);
}

/** A failure the door raised that is not a policy refusal: the network's. */
function networkFailure(error: unknown, method: ForgeMethod, path: string): never {
  if (isOutboundHttpError(error)) {
    if (error.code === "outbound_redirect_refused") {
      throw new ForgeError("github_moved", `${method} ${path}: GitHub answered with a redirect (the repository was renamed or moved), which is never followed.`, { method, path, ...error.safeDetails });
    }
    throw error;
  }
  if (isAbortError(error)) throw error;
  throw new ForgeError("github_unavailable", `${method} ${path}: the request to GitHub failed before an answer (${error instanceof Error ? error.message : String(error)}).`, { method, path });
}

/**
 * THE CLIENT: the forge port over `endpoint`, as `credential`'s principal.
 * Each client has its own conditional-GET cache (a cached answer is the
 * principal's own: two principals may see different objects).
 */
export function githubClient(endpoint: ForgeEndpoint, credential: ForgeCredential): ForgeClient {
  apiBase(endpoint);
  const cache = etagCache(endpoint.etagCacheEntries);

  async function rest<T>(request: ForgeRequest): Promise<ForgeResponse<T>> {
    const { method, path } = request;
    const url = forgeRequestUrl(endpoint, path, request.query);
    const lifetime = outboundDeadline(request.signal, endpoint.timeoutMs, () => new ForgeError("github_unavailable", `${method} ${path}: GitHub did not answer within ${String(endpoint.timeoutMs)} ms.`, { method, path }));
    const cacheKey = `${method} ${url.href}`;
    const cached = method === "GET" ? cache.get(cacheKey) : undefined;
    try {
      const authorization = await credential.authorization(lifetime.signal);
      const prepared = prepareOutboundRequest({
        url: url.href, method, logCategory: FORGE_LOG_CATEGORY, allowPrivateAddress: endpoint.allowPrivateAddress,
        protocolHeaders: {
          Accept: request.accept ?? GITHUB_JSON_MEDIA_TYPE,
          Authorization: authorization,
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
          "User-Agent": endpoint.userAgent,
          ...(request.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(cached === undefined ? {} : { "If-None-Match": cached.etag }),
        },
      });
      let response: Response;
      try {
        response = await dispatchOutboundRequest(prepared, request.body === undefined ? undefined : JSON.stringify(request.body), lifetime.signal);
      } catch (error) {
        if (lifetime.expired()) throw lifetime.signal.reason;
        return networkFailure(error, method, path);
      }
      const rate = rateFactsOf(response.headers);
      const requestId = response.headers.get("x-github-request-id") ?? undefined;
      debugLog(FORGE_LOG_CATEGORY, "debug", "forge_request", () => ({ principal: credential.principal, method, path, status: response.status, ...rate }));
      if (response.status === 304 && cached !== undefined) {
        await discardBody(response, FORGE_LOG_CATEGORY, endpoint.cleanupTimeoutMs);
        return Object.freeze({ status: 304, data: cached.data as T, etag: cached.etag, notModified: true, next: nextPagePath(endpoint, response.headers.get("link")), rate, requestId });
      }
      const text = await readBody(response, lifetime.signal, endpoint.maxResponseBytes, endpoint.cleanupTimeoutMs, FORGE_LOG_CATEGORY);
      if (response.status < 200 || response.status >= 300) {
        const refusal = classifyGithubAnswer(response.status, response.headers, text, method, path);
        debugLog(FORGE_LOG_CATEGORY, "warn", refusal.forgeCode, () => ({ principal: credential.principal, method, path, status: response.status, requestId: requestId ?? "" }));
        throw refusal;
      }
      const data = parseBody(text, method, path);
      const etag = response.headers.get("etag") ?? undefined;
      if (method === "GET" && etag !== undefined) cache.set(cacheKey, { etag, data });
      return Object.freeze({ status: response.status, data: data as T, etag, notModified: false, next: nextPagePath(endpoint, response.headers.get("link")), rate, requestId });
    } finally {
      lifetime.clear();
    }
  }

  async function paginate<T>(request: Omit<ForgeRequest, "method" | "body">, options: ForgePageOptions<T>): Promise<readonly T[]> {
    const items: T[] = [];
    let path: string | undefined = request.path;
    let query: ForgeRequest["query"] = { ...request.query, ...(options.perPage === undefined ? {} : { per_page: options.perPage }) };
    for (let page = 0; path !== undefined; page += 1) {
      if (page >= options.maxPages) {
        throw new ForgeError("forge_request_invalid", `GET ${request.path}: the list has more than ${String(options.maxPages)} pages; raise the bound deliberately or narrow the query.`, { path: request.path, maxPages: options.maxPages });
      }
      const [pathOnly, search] = splitPath(path);
      const answer: ForgeResponse<unknown> = await rest({ ...request, method: "GET", path: pathOnly, query: search ?? query });
      const pageItems = options.items === undefined ? answer.data : options.items(answer.data);
      if (!Array.isArray(pageItems)) throw new ForgeError("github_response_invalid", `GET ${request.path}: a page is not a list.`, { path: request.path });
      items.push(...(pageItems as T[]));
      path = answer.next;
      query = undefined;
    }
    return Object.freeze(items);
  }

  async function graphql<T>(query: string, variables: Readonly<Record<string, unknown>> = {}, signal?: AbortSignal): Promise<T> {
    const answer = await rest<unknown>({ method: "POST", path: "/graphql", body: { query, variables }, signal });
    const body = answer.data as { data?: unknown; errors?: unknown } | undefined;
    if (body !== undefined && Array.isArray(body.errors) && body.errors.length > 0) throw classifyGraphqlErrors(body.errors);
    if (body === undefined || body.data === undefined || body.data === null) throw new ForgeError("github_response_invalid", "POST /graphql: the answer carries no data.", { path: "/graphql" });
    return body.data as T;
  }

  return Object.freeze({ principal: credential.principal, endpoint, rest, paginate, graphql });
}

/** An API path with its query split off (a next-page path carries its own query). */
function splitPath(path: string): readonly [string, Readonly<Record<string, string>> | undefined] {
  const index = path.indexOf("?");
  if (index === -1) return [path, undefined];
  return [path.slice(0, index), Object.fromEntries(new URLSearchParams(path.slice(index + 1)))];
}

/** A GraphQL `errors` array as one forge refusal: its first error's `type` decides. */
export function classifyGraphqlErrors(errors: readonly unknown[]): ForgeError {
  const first = (errors[0] ?? {}) as { type?: unknown; message?: unknown };
  const type = typeof first.type === "string" ? first.type : "";
  const message = typeof first.message === "string" ? first.message : "";
  const facts = { path: "/graphql", type, message, errors: errors.slice(0, 20).map((entry) => JSON.stringify(entry)) };
  const code: ForgeCode = type === "RATE_LIMITED" ? "github_rate_limited"
    : SECONDARY_LIMIT.test(message) ? "github_content_budget_exhausted"
      : PLAN_REFUSAL.test(message) ? "unavailable_on_plan"
        : type === "FORBIDDEN" ? "github_forbidden"
          : type === "NOT_FOUND" ? "github_not_found"
            : "github_validation_failed";
  return new ForgeError(code, `POST /graphql: ${message || type || "GitHub answered with errors"}`, facts);
}
