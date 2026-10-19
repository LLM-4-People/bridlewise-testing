/**
 * Shared JSON HTTP request helper for integration tests.
 *
 * 9+ integration test files each defined their own `async function req()`
 * to send a JSON request to the test server and parse the JSON/text body.
 * The copies had drifted into five distinct signatures (positional vs
 * object args, `{status, body}` vs `{status, json}` return shapes,
 * optional `setCookie`, optional per-call cookie override). All shared the
 * SAME core: fetch with the auth cookie + the CSRF `X-Requested-With`
 * header, JSON-stringify the body, parse JSON-or-text from the response.
 *
 * This module is the single owner of that core. Every test imports
 * `jsonRequest` (or the per-server `makeJsonRequest` factory) instead of
 * re-implementing it. A fix to the request logic (CSRF header name, body
 * parse, error handling) fixes every consumer.
 *
 * The CSRF header is owned here so a future rename of the CSRF contract
 * changes one place, not nine. The body parse is JSON-or-text (matches
 * every prior copy): an empty body returns `undefined`; a non-JSON body
 * returns the raw text; a JSON body returns the parsed value.
 */

/** The result of a JSON request: status + parsed body + Set-Cookie. */
export interface JsonRequestResult {
  readonly status: number;
  /** The parsed JSON body, the raw text body, or `undefined` when empty. */
  readonly body: unknown;
  /** The `set-cookie` header value (null when absent). */
  readonly setCookie: string | null;
  /** The full response header set, for assertions about wire contracts
   * carried in headers (the trace id, collection bounds, identity). */
  readonly headers: Headers;
}

/** The standard CSRF header value the router requires on mutating routes. */
export const CSRF_HEADER: Readonly<Record<string, string>> = { "X-Requested-With": "test" };

/** Options for a single JSON request. */
export interface JsonRequestOptions {
  /** HTTP method (defaults to `GET`). Explicit `undefined` means the default,
   * so callers forwarding an optional value need no conditional spread. */
  method?: string | undefined;
  /** The request body — JSON-stringified when present. */
  body?: unknown;
  /** The Cookie header value (e.g. `harness_auth=...`). Pass `null` to
   * send no cookie at all; omit to send no cookie (same as null). */
  cookie?: string | null;
  /** Extra headers to merge in (e.g. `Accept`, `Content-Type` overrides). */
  extraHeaders?: Record<string, string>;
  /** When true, suppress the default CSRF header (for tests that verify the
   * CSRF gate rejects the absence). Defaults to false. */
  noCsrf?: boolean;
}

/**
 * Send a JSON request to `baseUrl + path` and return the status + parsed
 * body + Set-Cookie. The CSRF `X-Requested-With: test` header is added by
 * default (use `noCsrf: true` to omit). The body is JSON-stringified when
 * present; the response body is parsed as JSON when possible, falling
 * back to the raw text, and `undefined` when empty.
 */
export async function jsonRequest(
  baseUrl: string,
  path: string,
  opts: JsonRequestOptions = {},
): Promise<JsonRequestResult> {
  const headers: Record<string, string> = {};
  if (!opts.noCsrf) Object.assign(headers, CSRF_HEADER);
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.cookie !== undefined && opts.cookie !== null) headers["Cookie"] = opts.cookie;
  if (opts.extraHeaders) Object.assign(headers, opts.extraHeaders);
  const res = await fetch(`${baseUrl}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : null,
  });
  const setCookie = res.headers.get("set-cookie");
  const text = await res.text();
  let body: unknown = undefined;
  if (text.length > 0) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  return { status: res.status, body, setCookie, headers: res.headers };
}

/**
 * Bind a `jsonRequest` to a fixed `baseUrl` + default cookie. The most
 * common pattern in the integration tests is a module-level `authCookie`
 * set in `beforeAll` and used by every `req(...)` call. This factory
 * captures that: `const req = makeJsonRequest(() => baseUrl, () => authCookie);`
 * returns a `req(path, opts?)` that uses the live base URL + cookie. The
 * per-call `cookie` option (in `opts`) overrides the default. Pass
 * `defaultCookie: () => null` for tests that need to send unauthenticated
 * requests by default and a per-call cookie on specific calls.
 */
export function makeJsonRequest(
  getBaseUrl: () => string,
  getDefaultCookie: () => string | null,
): (
  path: string,
  opts?: JsonRequestOptions,
) => Promise<JsonRequestResult> {
  return (path, opts = {}) =>
    jsonRequest(getBaseUrl(), path, {
      ...opts,
      cookie: opts.cookie !== undefined ? opts.cookie : getDefaultCookie(),
    });
}
