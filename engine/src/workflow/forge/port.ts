/**
 * THE FORGE PORT — what every lane that talks to GitHub builds against: the
 * door and the gates (check runs, the verdict), `ws` on GitHub (pull requests,
 * the Git Data API, the merge queue), the publisher (releases, the
 * projection, Pages), the importer and the community bots. One client shape,
 * one credential shape, one answer shape, one refusal family (`codes.ts`).
 *
 * The port is deliberately thin: a typed REST call, a paginated read, a
 * GraphQL call, and the release assets' raw-body upload and download. Each lane writes its own typed operations ON this client
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
  /** Every page link of the answer (`next`, `last`, `prev`, `first`) as an API path with its query. */
  links: Readonly<Record<string, string>>;
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
  /** `https://uploads.github.com`: where a release asset is uploaded (a loopback `http:` URL only for a test server). */
  uploadsUrl: string;
  /**
   * Release assets: the origins a download may be redirected to (GitHub's
   * signed asset hosts), the largest asset, and the transfer's progress
   * floor (bytes per window; no total wall cap).
   */
  assets: Readonly<{ origins: readonly string[]; maxBytes: number; progressWindowMs: number; minBytesPerWindow: number }>;
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

/**
 * A release asset's bytes, streamed: its chunks, its size and the SHA-256 of
 * its bytes (lower-case hex). The one HTTP door holds the bytes that leave to
 * both (a mismatch cuts the upload: `forge_asset_integrity`).
 */
export type ForgeAssetBody = Readonly<{ chunks: AsyncIterable<Uint8Array>; size: number; sha256: string }>;

/** A raw-body upload to the uploads host (a release asset): `path` is the uploads API path, already filled in. */
export type ForgeUploadRequest = Readonly<{
  path: string;
  query?: ForgeQuery | undefined;
  /** The asset's media type (`Content-Type`). */
  contentType: string;
  body: ForgeAssetBody;
  signal?: AbortSignal | undefined;
}>;

/**
 * A raw-body download of a release asset (`GET …/releases/assets/{id}` as
 * `application/octet-stream`). The bytes stream to `sink`, bounded by
 * `forge.request.assets.maxBytes` and held to `sha256` (the caller's own
 * checksum, from SHA256SUMS). A mismatch is `forge_asset_integrity` after
 * the sink has seen the bytes, and the caller discards what it wrote.
 */
export type ForgeDownloadRequest = Readonly<{
  path: string;
  query?: ForgeQuery | undefined;
  sha256: string;
  sink: (chunk: Uint8Array) => void | Promise<void>;
  signal?: AbortSignal | undefined;
}>;

/** A download to a file: the asset at `destination`, published only once verified (no partial file, ever). */
export type ForgeDownloadToFileRequest = Readonly<{
  path: string;
  query?: ForgeQuery | undefined;
  sha256: string;
  destination: string;
  signal?: AbortSignal | undefined;
}>;

/** What a download read: its size and its (verified) SHA-256. */
export type ForgeDownloadAnswer = Readonly<{ bytes: number; sha256: string }>;

/** THE CLIENT every lane uses. */
export type ForgeClient = Readonly<{
  principal: string;
  endpoint: ForgeEndpoint;
  rest: <T = unknown>(request: ForgeRequest) => Promise<ForgeResponse<T>>;
  paginate: <T = unknown>(request: Omit<ForgeRequest, "method" | "body">, options: ForgePageOptions<T>) => Promise<readonly T[]>;
  /** A GraphQL call; an answer carrying `errors` is a typed refusal, never partial data. */
  graphql: <T = unknown>(query: string, variables?: Readonly<Record<string, unknown>>, signal?: AbortSignal) => Promise<T>;
  /** A raw-body upload to the uploads host; answers the parsed record, whose `digest` must be the one sent. */
  upload: <T = unknown>(request: ForgeUploadRequest) => Promise<ForgeResponse<T>>;
  /** A raw-body asset download, streamed and checksum-verified; one redirect is followed, only to `endpoint.assets.origins` and without the credential. */
  download: (request: ForgeDownloadRequest) => Promise<ForgeDownloadAnswer>;
  /** THE download to a file: {@link download} into a private temporary file beside `destination`, renamed over it only once verified. */
  downloadToFile: (request: ForgeDownloadToFileRequest) => Promise<ForgeDownloadAnswer>;
}>;

export type { ForgeError };
