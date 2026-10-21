/**
 * THE FORGE PORT — what every lane that talks to GitHub builds against: the
 * door and the gates (check runs, the verdict), `ws` on GitHub (pull requests,
 * the Git Data API, the merge queue), the publisher (releases, the
 * projection, Pages), the importer and the community bots. One client shape,
 * one credential shape, one answer shape, one refusal family (`codes.ts`).
 *
 * The port is deliberately thin: a typed REST call, a paginated read, a
 * GraphQL call. Each lane writes its own typed operations ON this client
 * (one owner per object kind), never a second HTTP path: the adapter
 * (`github.ts`) is the only code that builds a GitHub request, and it does so
 * through the ONE outbound HTTP door (`src/shared/outbound-http.ts`).
 *
 * What the adapter guarantees to every caller:
 * - the API version is pinned ({@link GITHUB_API_VERSION}) on every request;
 * - a GET is conditional: the adapter keeps each answer's ETag and sends
 *   `If-None-Match`, and a 304 is answered from its cache (`notModified`) —
 *   GitHub does not count it against the rate limit;
 * - every non-2xx answer is a typed {@link ForgeError} (`codes.ts`),
 *   classified once: budgets (`github_rate_limited`,
 *   `github_secondary_rate_limited`, `github_content_budget_exhausted`) carry
 *   when to resume, and nothing in the adapter waits or retries — the caller's
 *   scheduler decides (NO-LOAD-BLOCK: a run is never blocked on a timer here);
 * - a redirect is never followed (a renamed repository is `github_moved`);
 * - the credential is asked for at call time and never logged, returned or
 *   put in a URL.
 */
import type { ForgeError } from "./codes.ts";

/** The REST API version every request pins (`X-GitHub-Api-Version`), read 2026-10-21 from `GET /versions`. */
export const GITHUB_API_VERSION = "2026-03-10";
/** The media type every REST request accepts unless the caller names another (a raw or diff media type). */
export const GITHUB_JSON_MEDIA_TYPE = "application/vnd.github+json";

export type ForgeMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Query parameters: plain values only (an array is GitHub's comma form only when the endpoint says so; pass it joined). */
export type ForgeQuery = Readonly<Record<string, string | number | boolean>>;

/** One REST call. `path` is the API path (`/repos/{owner}/{repo}/rulesets`), already filled in; never a URL. */
export type ForgeRequest = Readonly<{
  method: ForgeMethod;
  path: string;
  query?: ForgeQuery | undefined;
  /** Serialized as JSON. */
  body?: unknown;
  /** Defaults to {@link GITHUB_JSON_MEDIA_TYPE}. */
  accept?: string | undefined;
  signal?: AbortSignal | undefined;
}>;

/** The rate-limit facts GitHub sent with an answer (absent when it sent none). */
export type ForgeRateFacts = Readonly<{
  limit?: number;
  remaining?: number;
  used?: number;
  /** ISO time the window resets. */
  resetAt?: string;
  resource?: string;
}>;

/** One answer: its status, the parsed body, and the facts every caller may need. */
export type ForgeResponse<T> = Readonly<{
  status: number;
  /** The parsed JSON body (`undefined` for 204 and empty bodies); frozen. */
  data: T;
  etag: string | undefined;
  /** True when GitHub answered 304 and `data` is the cached answer of the same request. */
  notModified: boolean;
  /** The next page's API path (with its query), from the `Link` header; undefined on the last page. */
  next: string | undefined;
  rate: ForgeRateFacts;
  /** GitHub's request id (`X-GitHub-Request-Id`), for a report. */
  requestId: string | undefined;
}>;

/**
 * A credential: WHO the requests run as (`principal`, a name for logs and
 * facts, never a secret) and the `Authorization` header value, asked for at
 * call time (a minted token is cached and renewed by its owner). `undefined`
 * sends no header: only GitHub's unauthenticated endpoints (the App manifest
 * conversion) are called that way.
 */
export type ForgeCredential = Readonly<{
  principal: string;
  authorization: (signal: AbortSignal) => Promise<string | undefined>;
}>;

/** Where the API is and how a request is bounded. Every value comes from configuration; the adapter holds no default. */
export type ForgeEndpoint = Readonly<{
  /** `https://api.github.com` (a loopback `http:` URL only for a test server). */
  apiUrl: string;
  /** May a request reach a loopback or private address? (false for GitHub; true only for a local test server). */
  allowPrivateAddress: boolean;
  /** Each request's lifetime. */
  timeoutMs: number;
  /** The largest body read. */
  maxResponseBytes: number;
  /** How long a body cancel may take. */
  cleanupTimeoutMs: number;
  /** How many conditional-request answers the client keeps (least recently used dropped first). */
  etagCacheEntries: number;
  /** The `User-Agent` GitHub requires. */
  userAgent: string;
}>;

/** A paginated read's bounds and, for an endpoint that wraps its list (`{ total_count, workflow_runs: [...] }`), where the items are. */
export type ForgePageOptions<T> = Readonly<{
  /** The most pages read; more is the typed `forge_request_invalid` (a list the caller did not bound). */
  maxPages: number;
  /** Items per page (GitHub's maximum is 100). */
  perPage?: number;
  items?: (data: unknown) => readonly T[];
}>;

/** THE CLIENT every lane uses. */
export type ForgeClient = Readonly<{
  principal: string;
  endpoint: ForgeEndpoint;
  rest: <T = unknown>(request: ForgeRequest) => Promise<ForgeResponse<T>>;
  paginate: <T = unknown>(request: Omit<ForgeRequest, "method" | "body">, options: ForgePageOptions<T>) => Promise<readonly T[]>;
  /** A GraphQL call; an answer carrying `errors` is a typed refusal, never partial data. */
  graphql: <T = unknown>(query: string, variables?: Readonly<Record<string, unknown>>, signal?: AbortSignal) => Promise<T>;
}>;

export type { ForgeError };
