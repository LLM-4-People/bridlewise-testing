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
import { CONTENT_TYPE_JSON, CONTENT_TYPE_OCTET_STREAM } from "../../kernel/contracts.ts";
import { isAbortError } from "../../kernel/errors.ts";
import { safePercentDecode } from "../../privacy/data-policy.ts";
import { deepFreeze } from "../../kernel/integrity.ts";
import { parseJsonExact } from "../../kernel/json-integrity.ts";
import { debugLog } from "../../shared/debug/debug-system.ts";
import { dispatchOutboundRequest, discardBody, isOutboundHttpError, outboundDeadline, outboundProgressDeadline, prepareOutboundRequest, readBody, readBodyBytes } from "../../shared/outbound-http.ts";
import { atomicWriteStream } from "../../filesystem/atomic-write.ts";
import { ForgeError, type ForgeCode } from "./codes.ts";
import { FORGE_REFUSAL_TEXT } from "./forge-config.ts";
import {
  GITHUB_API_VERSION,
  GITHUB_JSON_MEDIA_TYPE,
  type ForgeClient,
  type ForgeCredential,
  type ForgeDownloadAnswer,
  type ForgeDownloadRequest,
  type ForgeDownloadToFileRequest,
  type ForgeUploadRequest,
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
/** A base URL of the endpoint (`apiUrl`, `uploadsUrl`), checked. */
function baseUrl(raw: string, field: "apiUrl" | "uploadsUrl"): URL {
  let url: URL;
  try { url = new URL(raw); } catch {
    throw new ForgeError("forge_endpoint_invalid", `The forge ${field} is not an absolute URL.`, { [field]: raw });
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new ForgeError("forge_endpoint_invalid", `The forge ${field} must be an https URL with no credentials, query or fragment.`, { [field]: raw });
  }
  return url;
}

function apiBase(endpoint: ForgeEndpoint): URL {
  return baseUrl(endpoint.apiUrl, "apiUrl");
}

/** The refusal of a path that is not an API path under the base. */
function pathRefused(path: string, why: string): ForgeError {
  return new ForgeError("forge_request_invalid", `A forge request names an API path under the API base: '/'-separated, non-empty segments, no dot segment, query, fragment, backslash, control character, encoded separator or double encoding (${why}).`, { path });
}

/**
 * The request URL of `path` under the API base. `path` is checked AS THE
 * SERVER WILL READ IT: decoded first by the one percent decoder (a malformed
 * escape refused), then every segment non-empty and neither `.` nor `..` (so
 * `.%2e`, `%2E%2e` and `//` are refused, not normalised), no encoded separator (`%2f`, `%5c`), no
 * double encoding (`%25`), and finally the URL the platform builds must keep
 * the path byte for byte under the base: nothing resolves outside it.
 */
export function forgeRequestUrl(endpoint: ForgeEndpoint, path: string, query?: ForgeRequest["query"], base: URL = apiBase(endpoint)): URL {
  if (!path.startsWith("/")) throw pathRefused(path, "it does not start with '/'");
  if (/[?#\\\s\u0000-\u001f\u007f]/u.test(path)) throw pathRefused(path, "a query, fragment, backslash, space or control character");
  if (/%(?:2f|5c|25)/iu.test(path)) throw pathRefused(path, "an encoded separator or a double encoding");
  // THE one percent decoder (lenient: an escape it cannot decode stays as written, so a `%` left over is a malformed escape).
  const decoded = safePercentDecode(path);
  if (decoded.includes("%")) throw pathRefused(path, "a malformed escape");
  if (decoded.split("/").slice(1).some((segment) => segment === "" || segment === "." || segment === "..")) throw pathRefused(path, "an empty or dot segment");
  const prefix = base.pathname.replace(/\/$/u, "");
  const url = new URL(`${base.origin}${prefix}${path}`);
  if (url.pathname !== `${prefix}${path}`) throw pathRefused(path, "the URL does not keep the path as given");
  for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, String(value));
  return url;
}

function numberHeader(headers: Headers, name: string): number | undefined {
  const value = headers.get(name);
  if (value === null || !/^\d+$/u.test(value)) return undefined;
  return Number(value);
}

/** The rate-limit facts of an answer. */
function rateFactsOf(headers: Headers): ForgeRateFacts {
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

/**
 * Every link of a `Link` header (`next`, `last`, `prev`, `first`) as an API
 * path with its query, relative to the API base; a link elsewhere, or whose
 * path is not an API path (`forgeRequestUrl`'s checks), is refused.
 */
export function linkPaths(endpoint: ForgeEndpoint, header: string | null): Readonly<Record<string, string>> {
  const links: Record<string, string> = {};
  if (header === null) return Object.freeze(links);
  const base = apiBase(endpoint);
  const prefix = base.pathname.replace(/\/$/u, "");
  for (const part of header.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="([a-z]+)"/u.exec(part.trim());
    if (match === null) continue;
    // Judged as written, never as the URL parser normalises it (`/x/.%2e/y` would become `/y`).
    const raw = match[1]!;
    const root = `${base.origin}${prefix}/`;
    if (!raw.startsWith(root)) throw new ForgeError("github_response_invalid", "GitHub's Link header names a page outside the API.", {});
    const queryAt = raw.indexOf("?");
    const path = raw.slice(root.length - 1, queryAt === -1 ? undefined : queryAt);
    const search = queryAt === -1 ? "" : raw.slice(queryAt);
    try { forgeRequestUrl(endpoint, path); } catch { throw new ForgeError("github_response_invalid", "GitHub's Link header names a page whose path is not an API path.", { path }); }
    if (/[#\s]/u.test(search)) throw new ForgeError("github_response_invalid", "GitHub's Link header names a page with a fragment or a space.", {});
    links[match[2]!] = `${path}${search}`;
  }
  return Object.freeze(links);
}

type ErrorBody = Readonly<{ message: string; documentationUrl: string | undefined; errors: readonly string[] }>;

function errorBodyOf(text: string): ErrorBody {
  const parsed = parseJsonExact(text)?.value;
  if (typeof parsed !== "object" || parsed === null) return { message: text.slice(0, FORGE_REFUSAL_TEXT.bodyExcerptChars), documentationUrl: undefined, errors: [] };
  const body = parsed as Record<string, unknown>;
  const errors = Array.isArray(body.errors) ? body.errors.map((entry) => typeof entry === "string" ? entry : JSON.stringify(entry)).slice(0, FORGE_REFUSAL_TEXT.errorEntries) : [];
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
          ...(authorization === undefined ? {} : { Authorization: authorization }),
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
          "User-Agent": endpoint.userAgent,
          ...(request.body === undefined ? {} : { "Content-Type": CONTENT_TYPE_JSON }),
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
        const links = linkPaths(endpoint, response.headers.get("link"));
        return Object.freeze({ status: 304, data: cached.data as T, etag: cached.etag, notModified: true, next: links.next, links, rate, requestId });
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
      const links = linkPaths(endpoint, response.headers.get("link"));
      return Object.freeze({ status: response.status, data: data as T, etag, notModified: false, next: links.next, links, rate, requestId });
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

  /** A door refusal of a streamed body, in the forge's own family (the door logged and counted it). */
  function assetFailure(error: unknown, method: ForgeMethod, path: string): never {
    if (isOutboundHttpError(error) && (error.code === "outbound_body_integrity_failed" || error.code === "outbound_body_size_mismatch")) {
      throw new ForgeError("forge_asset_integrity", `${method} ${path}: the asset's bytes do not match the size or SHA-256 they declare (${error.code}).`, { method, path, ...error.safeDetails });
    }
    if (isOutboundHttpError(error) && error.code === "outbound_body_too_large") {
      throw new ForgeError("forge_asset_too_large", `${method} ${path}: the asset is larger than ${String(endpoint.assets.maxBytes)} bytes.`, { method, path, maxBytes: endpoint.assets.maxBytes });
    }
    return networkFailure(error, method, path);
  }

  /** The protocol headers every GitHub request carries, with the credential when there is one. */
  function githubHeaders(accept: string, authorization: string | undefined, extra: Readonly<Record<string, string>> = {}): Readonly<Record<string, string>> {
    return { Accept: accept, ...(authorization === undefined ? {} : { Authorization: authorization }), "X-GitHub-Api-Version": GITHUB_API_VERSION, "User-Agent": endpoint.userAgent, ...extra };
  }

  async function refusedAnswer(response: Response, signal: AbortSignal, method: ForgeMethod, path: string): Promise<never> {
    const text = await readBody(response, signal, endpoint.maxResponseBytes, endpoint.cleanupTimeoutMs, FORGE_LOG_CATEGORY);
    const refusal = classifyGithubAnswer(response.status, response.headers, text, method, path);
    debugLog(FORGE_LOG_CATEGORY, "warn", refusal.forgeCode, () => ({ principal: credential.principal, method, path, status: response.status }));
    throw refusal;
  }

  /**
   * An asset transfer's lifetime: a PROGRESS FLOOR (every window of
   * `assets.progressWindowMs` moves `assets.minBytesPerWindow` bytes, or
   * brings GitHub's answer), and no total wall cap. A large asset on a
   * loaded host is slow work that keeps moving, and is never cut.
   */
  function assetLifetime(signal: AbortSignal | undefined, method: ForgeMethod, path: string) {
    const { progressWindowMs, minBytesPerWindow } = endpoint.assets;
    return outboundProgressDeadline(signal, { windowMs: progressWindowMs, minBytes: minBytesPerWindow },
      () => new ForgeError("forge_asset_stalled", `${method} ${path}: a ${String(progressWindowMs)} ms window moved fewer than ${String(minBytesPerWindow)} bytes of the asset.`, { method, path, progressWindowMs, minBytesPerWindow }));
  }

  /**
   * The end of a transfer that failed: the CALLER's own cancellation answers
   * its own reason; the progress floor answers `forge_asset_stalled`; a
   * typed forge refusal is kept; anything else is classified by the door.
   */
  function transferFailure(error: unknown, request: Readonly<{ signal?: AbortSignal | undefined }>, lifetime: Readonly<{ expired: () => boolean; signal: AbortSignal }>, method: ForgeMethod, path: string): never {
    if (request.signal?.aborted === true) throw request.signal.reason;
    if (lifetime.expired()) throw lifetime.signal.reason;
    if (error instanceof ForgeError) throw error;
    return assetFailure(error, method, path);
  }

  async function upload<T>(request: ForgeUploadRequest): Promise<ForgeResponse<T>> {
    const method: ForgeMethod = "POST";
    const { path, body } = request;
    if (body.size > endpoint.assets.maxBytes) {
      throw new ForgeError("forge_asset_too_large", `${method} ${path}: the asset is ${String(body.size)} bytes, more than ${String(endpoint.assets.maxBytes)}.`, { method, path, size: body.size, maxBytes: endpoint.assets.maxBytes });
    }
    const url = forgeRequestUrl(endpoint, path, request.query, baseUrl(endpoint.uploadsUrl, "uploadsUrl"));
    const lifetime = assetLifetime(request.signal, method, path);
    // Every chunk that leaves is progress; so is the answer that follows the last one.
    const chunks = (async function* () { for await (const chunk of body.chunks) { lifetime.progress(chunk.byteLength); yield chunk; } })();
    try {
      const prepared = prepareOutboundRequest({
        url: url.href, method, logCategory: FORGE_LOG_CATEGORY, allowPrivateAddress: endpoint.allowPrivateAddress,
        protocolHeaders: githubHeaders(GITHUB_JSON_MEDIA_TYPE, await credential.authorization(lifetime.signal), { "Content-Type": request.contentType }),
      });
      let response: Response;
      try {
        response = await dispatchOutboundRequest(prepared, { chunks, size: body.size, sha256: body.sha256 }, lifetime.signal);
      } catch (error) {
        return transferFailure(error, request, lifetime, method, path);
      }
      lifetime.answered();
      if (response.status < 200 || response.status >= 300) return await refusedAnswer(response, lifetime.signal, method, path);
      const data = parseBody(await readBody(response, lifetime.signal, endpoint.maxResponseBytes, endpoint.cleanupTimeoutMs, FORGE_LOG_CATEGORY), method, path);
      // GitHub records the asset's own digest: it must be the one sent, or the release holds bytes nobody checked.
      const recorded = (data as { digest?: unknown } | undefined)?.digest;
      if (recorded !== `sha256:${body.sha256}`) {
        throw new ForgeError("forge_asset_integrity", `${method} ${path}: GitHub recorded the asset's digest as ${typeof recorded === "string" ? recorded : "nothing"}, not the SHA-256 sent.`, { method, path, declared: body.sha256, recorded: typeof recorded === "string" ? recorded : "" });
      }
      const links = linkPaths(endpoint, response.headers.get("link"));
      debugLog(FORGE_LOG_CATEGORY, "debug", "forge_asset_uploaded", () => ({ principal: credential.principal, path, bytes: body.size }));
      return Object.freeze({ status: response.status, data: data as T, etag: response.headers.get("etag") ?? undefined, notModified: false, next: links.next, links, rate: rateFactsOf(response.headers), requestId: response.headers.get("x-github-request-id") ?? undefined });
    } finally {
      lifetime.clear();
    }
  }

  /** A redirect answer (3xx, not 304). */
  const redirected = (response: Response): boolean => response.status >= 300 && response.status < 400 && response.status !== 304;

  async function download(request: ForgeDownloadRequest): Promise<ForgeDownloadAnswer> {
    const method: ForgeMethod = "GET";
    const { path } = request;
    const url = forgeRequestUrl(endpoint, path, request.query);
    const lifetime = assetLifetime(request.signal, method, path);
    try {
      const asked = prepareOutboundRequest({
        url: url.href, method, logCategory: FORGE_LOG_CATEGORY, allowPrivateAddress: endpoint.allowPrivateAddress,
        protocolHeaders: githubHeaders(CONTENT_TYPE_OCTET_STREAM, await credential.authorization(lifetime.signal)),
      });
      let response: Response;
      try {
        response = await dispatchOutboundRequest(asked, undefined, lifetime.signal, "answer");
        if (redirected(response)) {
          // GitHub answers the bytes with a signed URL on its asset hosts: asked ONLY there, and WITHOUT the credential.
          const location = response.headers.get("location");
          await discardBody(response, FORGE_LOG_CATEGORY, endpoint.cleanupTimeoutMs);
          const target = location !== null && URL.canParse(location, url) ? new URL(location, url) : undefined;
          if (target === undefined || !endpoint.assets.origins.some((origin) => target.href.startsWith(`${origin}/`))) {
            throw new ForgeError("forge_asset_redirect_refused", `${method} ${path}: GitHub redirected the asset to ${target?.origin ?? "an unreadable location"}, which is not one of forge.assetOrigins; nothing was asked there.`, { method, path, target: target?.origin ?? "" });
          }
          const signed = prepareOutboundRequest({
            url: target.href, method, logCategory: FORGE_LOG_CATEGORY, allowPrivateAddress: endpoint.allowPrivateAddress,
            protocolHeaders: { Accept: CONTENT_TYPE_OCTET_STREAM, "User-Agent": endpoint.userAgent },
          });
          response = await dispatchOutboundRequest(signed, undefined, lifetime.signal, "answer");
          if (redirected(response)) {
            // One hop, to a declared asset origin: a chain is never followed (its next stop was never declared).
            await discardBody(response, FORGE_LOG_CATEGORY, endpoint.cleanupTimeoutMs);
            throw new ForgeError("forge_asset_redirect_refused", `${method} ${path}: the asset host redirected again; a chained redirect is never followed, and nothing was asked at its next location.`, { method, path, target: target.origin });
          }
        }
      } catch (error) {
        return transferFailure(error, request, lifetime, method, path);
      }
      lifetime.answered();
      if (response.status < 200 || response.status >= 300) return await refusedAnswer(response, lifetime.signal, method, path);
      try {
        const read = await readBodyBytes(response, {
          signal: lifetime.signal, maxBytes: endpoint.assets.maxBytes, cleanupTimeoutMs: endpoint.cleanupTimeoutMs, logCategory: FORGE_LOG_CATEGORY, sha256: request.sha256,
          sink: async (chunk) => {
            lifetime.progress(chunk.byteLength);
            try {
              await request.sink(chunk);
            } catch (error) {
              // The local side failed (a full disk, a removed folder): never GitHub's failure.
              const code = (error as { code?: unknown } | undefined)?.code;
              throw new ForgeError("forge_asset_sink_failed", `${method} ${path}: writing the downloaded bytes failed here (${error instanceof Error ? error.message : String(error)}).`, { method, path, ...(typeof code === "string" ? { cause: code } : {}) });
            }
          },
        });
        debugLog(FORGE_LOG_CATEGORY, "debug", "forge_asset_downloaded", () => ({ principal: credential.principal, path, bytes: read.bytes }));
        return read;
      } catch (error) {
        return transferFailure(error, request, lifetime, method, path);
      }
    } finally {
      lifetime.clear();
    }
  }

  /**
   * A release asset downloaded to `destination` through the ONE atomic writer
   * (`atomicWriteStream`): the bytes stream into a private sibling temporary
   * file and are published under `destination` only once the whole asset
   * holds its size bound and the caller's SHA-256. A refused or failed
   * download leaves no file: no partial file, and nothing at `destination`
   * that was not verified.
   */
  async function downloadToFile(request: ForgeDownloadToFileRequest): Promise<ForgeDownloadAnswer> {
    let answer: ForgeDownloadAnswer | undefined;
    const written = await atomicWriteStream(request.destination, async (append) => {
      answer = await download({ path: request.path, query: request.query, sha256: request.sha256, signal: request.signal, sink: append });
    }, { durable: true });
    if (!written.success) throw written.error;
    return answer!;
  }

  return Object.freeze({ principal: credential.principal, endpoint, rest, paginate, graphql, upload, download, downloadToFile });
}

/** An API path with its query split off (a next-page path carries its own query). */
function splitPath(path: string): readonly [string, Readonly<Record<string, string>> | undefined] {
  const index = path.indexOf("?");
  if (index === -1) return [path, undefined];
  return [path.slice(0, index), Object.fromEntries(new URLSearchParams(path.slice(index + 1)))];
}

/** A GraphQL `errors` array as one forge refusal: its first error's `type` decides. */
function classifyGraphqlErrors(errors: readonly unknown[]): ForgeError {
  const first = (errors[0] ?? {}) as { type?: unknown; message?: unknown };
  const type = typeof first.type === "string" ? first.type : "";
  const message = typeof first.message === "string" ? first.message : "";
  const facts = { path: "/graphql", type, message, errors: errors.slice(0, FORGE_REFUSAL_TEXT.errorEntries).map((entry) => JSON.stringify(entry)) };
  const code: ForgeCode = type === "RATE_LIMITED" ? "github_rate_limited"
    : SECONDARY_LIMIT.test(message) ? "github_content_budget_exhausted"
      : PLAN_REFUSAL.test(message) ? "unavailable_on_plan"
        : type === "FORBIDDEN" ? "github_forbidden"
          : type === "NOT_FOUND" ? "github_not_found"
            : "github_validation_failed";
  return new ForgeError(code, `POST /graphql: ${message || type || "GitHub answered with errors"}`, facts);
}
