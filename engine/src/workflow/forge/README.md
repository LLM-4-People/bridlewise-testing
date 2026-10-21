# Forge

The forge: how Bridlewise talks to GitHub, the one forge it lives on
(`specs/github-only.md`, the coordinator's notes). Every lane that reads or
writes GitHub — the door and the gates, `ws` on GitHub, the publisher and the
projection, the importer, the community bots, `harness forge plan|apply|audit`
— builds on ONE port and ONE adapter here, and never sends a GitHub request of
its own.

## The port, in one paragraph

`githubClient(endpoint, credential)` returns a `ForgeClient` with `rest`,
`paginate` and `graphql`. Every request goes through the ONE outbound HTTP door
(`src/shared/outbound-http.ts`), pins the REST API version `2026-03-10`, and
answers a frozen `ForgeResponse` (status, data, ETag, the next page, the
rate-limit facts, the request id). A repeated GET is conditional (its ETag is
sent; a 304 answers the cached data and costs no rate limit). Every refusal is
a typed `ForgeError` from `codes.ts`, classified once (`classifyGithubAnswer`):
the budgets (`github_rate_limited`, `github_secondary_rate_limited`,
`github_content_budget_exhausted`) carry when to resume and nothing here waits
or retries; a feature outside the plan is `unavailable_on_plan`; a redirect (a
renamed repository) is `github_moved`, never followed. A credential is one of
four, none read from a file: an App installation token minted from the host's
key custody and narrowed to one repository and one action's permissions, the
App's own JWT, a token handed in an environment variable, or one typed at a
prompt and held in memory.

## What each file does

- `port.ts` — THE PORT every lane builds against: `ForgeClient`, `ForgeRequest`, `ForgeResponse`, `ForgeCredential`, `ForgeEndpoint` (every bound comes from configuration; the adapter holds no default), `ForgePageOptions`, and the pinned `GITHUB_API_VERSION`.
- `github.ts` — THE ADAPTER: `githubClient` on the outbound door (pinned version, media type and user agent; the bounded least-recently-used ETag cache per client; `Link` pagination with a required page bound; GraphQL whose `errors` are a refusal, never partial data), `classifyGithubAnswer` and `classifyGraphqlErrors` (the one classification of GitHub's refusals), `forgeRequestUrl` (an API path judged as the server reads it: decoded first, every segment non-empty and no dot segment — `.%2e` included —, no encoded separator or double encoding, and the URL must keep the path byte for byte under the base), `linkPaths` (every `Link` rel as an API path, judged as written; a page outside the API is refused) and `rateFactsOf`. Logs each request at debug and each refusal at warn (category `forge`), never a header value or a body.
- `codes.ts` — THE ONE TABLE of the forge's answers: each code's class (`input`, `refused`, `budget`, `errored`, `integrity`) and its one remedy; `ForgeError` (budgets and errored answers are `retryable`, for the caller's scheduler), `isForgeError`.
- `app-registry.ts` — THE APP REGISTRY (github-only §4.1): the four Apps (`agent`, `verifier`, `door`, `publisher`), each one's exact GitHub permissions, key custody (`host`, or a GitHub environment secret with its client-id variable) and the repository kinds it is installed on; `narrowedPermissions` (a token is never minted wider than the registry; `metadata: read` is implied).
- `app-keys.ts` — THE HOST'S APP KEY CUSTODY: the agent's and verifier's keys in the key home (`<key home>/forge-apps/<role>.json`, 0600, written atomically and durably), `storeAppKey`, and `keyHomeCustody` — a custody that answers the App's public identity and SIGNS, and never hands the key out. Until cred-final's credential broker exists, the key home is the host's one key custody.
- `credentials.ts` — THE FOUR CREDENTIALS: `appInstallationCredential` (the installation looked up once, the token minted narrowed to one repository and the action's permissions, checked to be exactly what was asked — else `forge_token_scope_mismatch` —, cached in memory and renewed `renewBeforeMs` before it expires), `appJwtCredential` / `appJwt` (RS256, 9 minutes, `iss` = the client id), `environmentCredential` and `memoryCredential`.

- `forge-config.ts` — THE `forge` CONFIGURATION SECTION (spliced into the config document by `src/kernel/config-contracts.ts`): the organisation, the API and web origins, the request bounds (timeout, body size, cleanup, ETag cache entries, page bound), the token renewal margin and the repository topology (name, `kind`, visibility, the proving ground; exactly one trunk); `forgeEndpoint`, `trunkRepository`, `repositoriesOfKinds`. No default in code; it imports no configuration reader (the kernel imports it).
- `configured-forge.ts` — THE ONE READER of the section (`configuredForge`, or `forge_not_configured`) and `configuredForgeClient(credential)`: every entry point that talks to GitHub builds its client here.
- `repository-reads.ts` — the floor's GitHub reads on the port (it replaced `scripts/floor/github.mjs`, a second client): `workflowRuns`, `latestByWorkflow`, `countOpenAlerts` (the declared population from a one-per-page probe's `rel="last"`, every page checked, a truncated population reported incomplete), `listReleases`, and `readFailureCode` (the status page's words for a typed refusal). Used by `scripts/floor/status.mjs`, `scripts/build-floor-data.mjs` and `scripts/promotion-gate.mjs`.

## Tests

`engine/test/forge/fake-github.ts` is a stateful fake GitHub on the loopback
upstream: an object store by API path with ETags and pagination, the App flow
(installation lookup, token minting with JWT verification, manifest
conversion), authentication, the pinned-version check, refusals on demand and
routes of a test's own. Every lane tests against it.
