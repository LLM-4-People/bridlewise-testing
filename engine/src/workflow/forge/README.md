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
- `history-import.ts` — THE HISTORY IMPORTER (above): `importHistory`, and its steps for the tests — `enumerateHistory`, `scanHistory` (one read of every blob, commit and tag, and of every path and ref name, for the catalogue's spans and the oracle's chunked findings), `judgeOracle` (covered, disposed or a gap), `planPurge` (the expressions, deterministic), `planRefs` (kept namespaces, everything else under `refs/heads/imported/`), `purgeResidue` (what the re-scan left), `decodedTexts`, `receiptRefusal` and `recordedLocation`, `readImportReview`, `admitImportHome`.
- `history-tools.ts` — THE PINNED TOOLS: gitleaks 8.30.1 and git-filter-repo 2.47.0, each pinned by the sha256 of its release archive and of the file run (an AUTHORED PINS region), `resolveHistoryTool` (absent → the provisioning command; other bytes → refused), `runBounded` / `runHistoryTool` (a process group bounded by CPU time and a stall check, never wall time; stopped only through the owned-process `terminate`).
- `gitleaks-config.ts` — THE ORACLE'S CONFIGURATION, projected from the catalogue: gitleaks' default rules plus one `bridlewise-<row>` rule per catalogue row RE2 can express; a row with a lookaround or a JavaScript-only escape is named in the header, never approximated.
- `forge-cli.ts` — `harness forge <verb>`: parses argv for the domain (`import-history`).
- `credentials.ts` — THE FOUR CREDENTIALS: `appInstallationCredential` (the installation looked up once, the token minted narrowed to one repository and the action's permissions, checked to be exactly what was asked — else `forge_token_scope_mismatch` —, cached in memory and renewed `renewBeforeMs` before it expires), `appJwtCredential` / `appJwt` (RS256, 9 minutes, `iss` = the client id), `environmentCredential` and `memoryCredential`.

- `forge-config.ts` — THE `forge` CONFIGURATION SECTION (spliced into the config document by `src/kernel/config-contracts.ts`): the organisation, the API and web origins, the request bounds (timeout, body size, cleanup, ETag cache entries, page bound), the token renewal margin and the repository topology (name, `kind`, visibility, the proving ground; exactly one trunk); `forgeEndpoint`, `trunkRepository`, `repositoriesOfKinds`. No default in code; it imports no configuration reader (the kernel imports it).
- `configured-forge.ts` — THE ONE READER of the section (`configuredForge`, or `forge_not_configured`) and `configuredForgeClient(credential)`: every entry point that talks to GitHub builds its client here.
- `repository-reads.ts` — the floor's GitHub reads on the port (it replaced `scripts/floor/github.mjs`, a second client): `workflowRuns`, `latestByWorkflow`, `countOpenAlerts` (the declared population from a one-per-page probe's `rel="last"`, every page checked, a truncated population reported incomplete), `listReleases`, and `readFailureCode` (the status page's words for a typed refusal). Used by `scripts/floor/status.mjs`, `scripts/build-floor-data.mjs` and `scripts/promotion-gate.mjs`.

## The history importer, in one paragraph

`harness forge import-history <source> --to <target> [--review <file>]` is the
ONE path a history enters the forge (github-only §8.3, runbook P6.1). It
mirrors the source into a run folder of the private import home
(`HARNESS_IMPORT_HOME`, default `~/.local/state/bridlewise/history-import`,
0700, kept out of every confined process) and enumerates every object of every
ref. It reads each object ONCE and decodes every text it holds before any
matching (a BOM's encoding — UTF-8, UTF-16LE/BE, UTF-32LE/BE — else strict
UTF-8, plus UTF-16 when the NULs sit at alternate positions); an object nothing
decodes is matched byte for byte and refused unless the review exempts it by
id. Both scanners read those texts: the secret CATALOGUE (the redaction
engine's format layer, the same rows every scanner uses), which decides what
is purged, and gitleaks as the INDEPENDENT ORACLE (`stdin` mode over chunks of
whole objects, each finding located to its object), configured from the same
catalogue; an oracle hit no catalogue value contains is a refusal (a catalogue
gap, listed with its value's digest in `oracle-gaps.json`) unless the review
names that rule and digest. It purges with `git filter-repo
--sensitive-data-removal` from a generated 0600 expressions file
(`[REMOVED:<entry>]`; a short value only inside its line; a blob holding a hit
filter-repo cannot rewrite in place — a NUL in its first bytes, any encoding
but UTF-8 — stripped whole), re-scans to zero (`purgeResidue`), scans the
receipt itself (no absolute or home path: a local repository is recorded as
`local:<name>`; no catalogue hit), commits it on `refs/heads/ledger`, and
pushes every ref with an explicit refspec, atomically and never forced, into
an EMPTY target, then reads the target back. A secret in a path or a ref name,
or a credential in a URL, is refused. The two tools are pinned by sha256 and
checked before every run, and every tool process is bounded by its process
group's CPU time and a stall check (no output and no CPU progress), never by
wall time; the harness does not download them (the outbound door never
follows a release asset's redirect), so a missing one's refusal prints its
provisioning command.

## Tests

`engine/test/forge/history-import.test.ts` drives every importer step that
needs only git over planted histories (`history-fixture.ts`); the whole
pipeline with the pinned tools is the live suite's
(`engine/live/history-import.test.ts`, run with `HARNESS_IMPORT_HOME` naming a
home that holds them).

`engine/test/forge/fake-github.ts` is a stateful fake GitHub on the loopback
upstream: an object store by API path with ETags and pagination, the App flow
(installation lookup, token minting with JWT verification, manifest
conversion), authentication, the pinned-version check, refusals on demand and
routes of a test's own. Every lane tests against it.
