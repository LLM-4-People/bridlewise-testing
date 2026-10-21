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
five, none read from a file: an App installation token minted from the host's
key custody and narrowed to one repository and one action's permissions, the
App's own JWT, a token handed in an environment variable, or one typed at a
prompt and held in memory — or none, for GitHub's unauthenticated manifest
conversion.

## What each file does

- `port.ts` — THE PORT every lane builds against: `ForgeClient`, `ForgeRequest`, `ForgeResponse`, `ForgeCredential`, `ForgeEndpoint` (every bound comes from configuration; the adapter holds no default), `ForgePageOptions`, and the pinned `GITHUB_API_VERSION`.
- `github.ts` — THE ADAPTER: `githubClient` on the outbound door (pinned version, media type and user agent; the bounded least-recently-used ETag cache per client; `Link` pagination with a required page bound; GraphQL whose `errors` are a refusal, never partial data), `classifyGithubAnswer` and `classifyGraphqlErrors` (the one classification of GitHub's refusals), `forgeRequestUrl` (an API path, never a URL, query, traversal or encoded separator), `nextPagePath` (a next page outside the API is refused) and `rateFactsOf`. Logs each request at debug and each refusal at warn (category `forge`), never a header value or a body.
- `codes.ts` — THE ONE TABLE of the forge's answers: each code's class (`input`, `refused`, `budget`, `errored`, `integrity`) and its one remedy; `ForgeError` (budgets and errored answers are `retryable`, for the caller's scheduler), `isForgeError`.
- `app-registry.ts` — THE APP REGISTRY (github-only §4.1): the four Apps (`agent`, `verifier`, `door`, `publisher`), each one's exact GitHub permissions, key custody (`host`, or a GitHub environment secret with its client-id variable) and the repository kinds it is installed on; `narrowedPermissions` (a token is never minted wider than the registry; `metadata: read` is implied).
- `app-keys.ts` — THE HOST'S APP KEY CUSTODY: the agent's and verifier's keys in the key home (`<key home>/forge-apps/<role>.json`, 0600, written atomically and durably), `storeAppKey`, and `keyHomeCustody` — a custody that answers the App's public identity and SIGNS, and never hands the key out. Until cred-final's credential broker exists, the key home is the host's one key custody.
- `credentials.ts` — THE FIVE CREDENTIALS: `appInstallationCredential` (the installation looked up once, the token minted narrowed to one repository and the action's permissions, checked to be exactly what was asked — else `forge_token_scope_mismatch` —, cached in memory and renewed `renewBeforeMs` before it expires), `appJwtCredential` / `appJwt` (RS256, 9 minutes, `iss` = the client id), `environmentCredential`, `memoryCredential` and `anonymousCredential` (the manifest conversion only).

## The verbs (`harness forge`, `cli.ts`)

```bash
node src/cli.ts harness forge apps manifests [--check]   # write (or check) .github/forge/ from the registry
node src/cli.ts harness forge apps create                # the Apps page, Session 1 (runbook P1.2)
```

- `cli.ts` — the `harness forge` dispatch and `configuredForge` (the `forge` section, or `forge_not_configured`). `apps create` preflights the maintainer's `gh` and the `door`/`publish` environments, then serves the page until the maintainer presses Done.
- `forge-config.ts` — THE `forge` CONFIGURATION SECTION (spliced into the config document by `src/kernel/config-contracts.ts`): the organisation, the API and web origins, the request bounds, the token renewal margin, the repository topology (name, `kind`, visibility, the proving ground; exactly one trunk) and the Apps page (port, the legacy Apps to narrow); `forgeEndpoint`, `trunkRepository`, `repositoriesOfKinds`. No default in code.
- `generated-files.ts` — THE FORGE'S GENERATED FILES under `.github/forge/`: the App manifests (`appManifest`: the registry's exact permissions, no webhook, owner-only, the local callback) and their index (`manifest.json`: each file's sha256); `syncForgeFiles` is an arm of `harness regenerate` and of `harness check` (a hand edit or a stray file under the folder is drift).
- `apps-page.ts` — THE APPS PAGE (127.0.0.1 only): one Create button per App posting its manifest to GitHub's organisation form with a one-use state; the callback converts the code (unauthenticated) and stores the key by custody — the host key home, or the environment secret plus the client-id variable through the maintainer's `gh` —, dropping the client and webhook secrets; then the install links with the exact repositories, the legacy Apps to narrow and the Discussion categories (from the community intake, `docs/community/intake.json`, the one table of them). Rendered from one embedded JSON document by the page's own script (no value spliced into HTML), under a nonce CSP; the Host must be the page's own, and Done needs the session token and the page's origin.
- `maintainer-cli.ts` — THE MAINTAINER'S `gh`, only while the owner credential is on the host (Session 1): an environment secret (sealed by `gh`: Node has no sealed box; the value on stdin only), an environment variable, whether an environment exists, and `ready`. A projected environment (no token variable passes); a failure is `forge_maintainer_cli_failed` with `gh`'s words.

## Tests

`engine/test/forge/fake-github.ts` is a stateful fake GitHub on the loopback
upstream: an object store by API path with ETags and pagination, the App flow
(installation lookup, token minting with JWT verification, manifest
conversion), authentication, the pinned-version check, refusals on demand and
routes of a test's own. Every lane tests against it.
