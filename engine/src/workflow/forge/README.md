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
- `github.ts` — THE ADAPTER: `githubClient` on the outbound door (pinned version, media type and user agent; the bounded least-recently-used ETag cache per client; `Link` pagination with a required page bound; GraphQL whose `errors` are a refusal, never partial data), `classifyGithubAnswer` and `classifyGraphqlErrors` (the one classification of GitHub's refusals), `forgeRequestUrl` (an API path judged as the server reads it: decoded first, every segment non-empty and no dot segment — `.%2e` included —, no encoded separator or double encoding, and the URL must keep the path byte for byte under the base), `linkPaths` (every `Link` rel as an API path, judged as written; a page outside the API is refused) and `rateFactsOf`. Logs each request at debug and each refusal at warn (category `forge`), never a header value or a body.
- `codes.ts` — THE ONE TABLE of the forge's answers: each code's class (`input`, `refused`, `budget`, `errored`, `integrity`) and its one remedy; `ForgeError` (budgets and errored answers are `retryable`, for the caller's scheduler), `isForgeError`.
- `app-registry.ts` — THE APP REGISTRY (github-only §4.1): the four Apps (`agent`, `verifier`, `door`, `publisher`), each one's exact GitHub permissions, key custody (`host`, or a GitHub environment secret with its client-id variable) and the repository kinds it is installed on; `narrowedPermissions` (a token is never minted wider than the registry; `metadata: read` is implied).
- `app-keys.ts` — THE APP KEY CUSTODY, the one credential module every App key passes through (the runbook's "broker" is the key home): `<key home>/forge-apps/<role>.json` (0600, atomic, durable). `storeAppKey` is the first step after a conversion, for every custody. A host App's custody (`keyHomeCustody`) answers the identity and signs, and never hands the key out. An environment App's key is HELD only until `pushHeldKey` puts it in its GitHub environment; then the record keeps the identity and the push time, and a failed push leaves the key held for the next run. `appKeyState` answers absent, held or done.
- `credentials.ts` — THE FIVE CREDENTIALS: `appInstallationCredential` (the installation looked up once, the token minted narrowed to one repository and the action's permissions, checked to be exactly what was asked — else `forge_token_scope_mismatch` —, cached in memory and renewed `renewBeforeMs` before it expires), `appJwtCredential` / `appJwt` (RS256, 9 minutes, `iss` = the client id), `environmentCredential`, `memoryCredential` and `anonymousCredential` (the manifest conversion only).

## The verbs (`harness forge`, `cli.ts`)

```bash
node src/cli.ts harness forge apps manifests [--check]   # write (or check) .github/forge/ from the registry
node src/cli.ts harness forge apps create                # the Apps page, Session 1 (runbook P1.2)
```

- `cli.ts` — the `harness forge` dispatch (the section through `configured-forge.ts`). `apps create` preflights the maintainer's `gh` and the `door`/`publish` environments, then serves the page until the maintainer presses Done.
- `apps-page.ts` — THE APPS PAGE (127.0.0.1 only), behind three barriers, each with a test that goes red without it: a ONE-TIME TOKEN printed in the terminal only (`/?t=…`; without it the page answers 404 and serves no state), Host and Origin checks, and THE CONVERSION CHECK (`verifyConversion`: the created App's owner, name, permissions and events must equal the generated manifest, or `forge_app_conversion_mismatch` and nothing is stored). One Create button per App posts its manifest with a one-use state. The callback converts the code and stores the key in the custody FIRST; an environment key is then pushed through the maintainer's `gh`, and a failed push stays held and is resumed on the next load. A name a half-finished attempt took is detected (`forge_app_name_taken`) and never offered again. The page then lists the install links with the exact repositories, the legacy Apps to narrow and the Discussion categories (from the community intake). It renders from one embedded JSON document, under a nonce CSP; Done needs the session token and the page's origin.
- `maintainer-cli.ts` — THE MAINTAINER'S `gh`, only while the owner credential is on the host (Session 1): an environment secret (sealed by `gh`, because Node has no sealed box; the value on stdin only), an environment variable, whether an environment exists, whether an App name is taken, and `ready`. Each run is `runBoundedCommand`: a projected environment (no token variable passes), and NO WALL-CLOCK KILL. A run ends only when it stalls (no output and no CPU work for `forge.maintainerCli.stallMs`) or passes its CPU limit (`cpuLimitMs`), which gives `forge_maintainer_cli_stalled`; any other failure is `forge_maintainer_cli_failed` with `gh`'s words.

- `forge-config.ts` — THE `forge` CONFIGURATION SECTION (spliced into the config document by `src/kernel/config-contracts.ts`): the organisation, the API and web origins, the request bounds (timeout, body size, cleanup, ETag cache entries, page bound), the token renewal margin, the repository topology (name, `kind`, visibility, the proving ground; exactly one trunk) and the Apps page (port, the legacy Apps to narrow); `forgeEndpoint`, `trunkRepository`, `repositoriesOfKinds`. No default in code; it imports no configuration reader (the kernel imports it).
- `configured-forge.ts` — THE ONE READER of the section (`configuredForgeSection`, the section or its absence for the `harness regenerate` arm; `configuredForge`, the section or `forge_not_configured`) and `configuredForgeClient(credential)`: every entry point that talks to GitHub builds its client here.
- `repository-identity.ts` — THE REPOSITORY IDENTITY: every address of this repository derives from the forge section's organisation, web origin and trunk repository: `owner/name`, the web, clone and issue URLs, the site's address (the trunk's declared `site { host, docsPath }`: its root, base path and documentation URL; a repository without a site keeps the organisation's Pages address), and the organisation's declared repositories. Code reads it here (the community files, the repository-link classifier). The forge-files arm of `harness sync` generates every copy other formats carry: `package.json`'s repository fields, `CITATION.cff`'s `repository-code`, and in hand-written Markdown the definitions of `[text][repo:<path>]`, `[text][site:<path>]` (the site's root) and `[text][docs:<path>]` (its documentation) references plus the clone-command block. A hand-spelled URL on the site's own host is refused. The product's repository (`product: true`) and the preview repository (`preview: true`) are identities of their own (`product:` and `preview:` references; after P1.10 the product is the trunk, so its site is `site:`/`docs:`; a `REPO=` variable block for commands in code). The rename (P1.10) is one edit of the forge section, `productRenamedSettings`: the preview repository becomes `<name>-preview` first, then the trunk takes the product's name and its `product` flag. The identity guard proves the edit clean on a copy of the tree. `.github/forge/repository-identity.json` is the generated plain-JSON copy that the dependency-free tools read (the link check, the site tooling).
- `repository-reference.ts` — THE `repo:<path>` REFERENCE: an address of this repository named through its identity (`repositoryReferenceUrl`). Markdown prose writes it as a reference label; a record field writes it bare (a tracker item's `evidence: repo:actions/runs/<id>`, judged by `tracker-status.ts` and rendered by the roadmap page). It is pure and import-free, because the confined roadmap-feed program loads it.
- `publish/` — the publisher App's work on the port: the product publication (`product.ts`: `harness promote forge-publish`, the projection receipt). Its README says what the publish job runs.
- `repository-reads.ts` — the floor's GitHub reads on the port (it replaced `scripts/floor/github.mjs`, a second client): `workflowRuns`, `latestByWorkflow`, `countOpenAlerts` (the declared population from a one-per-page probe's `rel="last"`, every page checked, a truncated population reported incomplete), `listReleases`, and `readFailureCode` (the status page's words for a typed refusal). Used by `scripts/floor/status.mjs`, `scripts/build-floor-data.mjs` and `scripts/promotion-gate.mjs`.
- `generated-files.ts` — THE FORGE'S GENERATED FILES: under `.github/forge/` the App manifests (`appManifest`: the registry's exact permissions, no webhook, owner-only, the local callback), every declared object (`<kind>/<scope>.<key>.json`) and the index (`manifest.json`: each file's sha256), plus `.github/dependabot.yml` and `.github/CODEOWNERS`; `forgeFileSources` reads their sources from the tree; `syncForgeFiles` is an arm of `harness regenerate` and of `harness check` (a hand edit or a stray file under the folder is drift).
- `projector/` — THE PROJECTOR (github-only §9.0): GitHub made equal to D = `project(S, L)`, computed confined from a commit and the ledger, applied by one algorithm that writes only the difference, re-reads and verifies; see its README.

## Settings as code (`harness forge plan|apply|audit`)

```bash
node src/cli.ts harness forge plan  --token-env GH_TOKEN   # what apply would change (read-only)
node src/cli.ts harness forge apply --token-stdin [--accept-loosening <kind:scope:key>]...   # tighten first; a weakening only by id
node src/cli.ts harness forge audit --token-env GH_TOKEN   # the plan judged: any drift fails
```

- `declarations.ts` — THE DECLARATIONS: every GitHub object the forge owns, as a pure function of the `forge` section, the App registry, the community sources (teams from the role table, with their members as data from `forge.teamMembers`; the issue forms' types, each of which must be in `FORGE_ISSUE_TYPES`, built from the tracker's one list of types, Milestone included) and the workflows' pinned actions — the org settings, the `kind` property and each repository's value, the security configurations, one per visibility (the private one without secret scanning or push protection unless the plan has Secret Protection; the add-on's fields recorded `unavailableOnPlan`; code scanning's default setup not set, since CodeQL runs in advanced setup), each attached to the governed repositories only (`security-configuration-repositories`: the selected scope, never every repository of the organisation), the teams and their grants, the org baseline ruleset and the trunk's R1–R5 (by `stage`: `p0` keeps the P0 contexts on the trunk only; `door` is the flip), repository, Actions and release settings (no Update-branch button), the environments (github-pages governed too), labels (one per area plus the declared ones), issue types and fields, autolinks and the Project — in apply order.
- `forge-state.ts` — the desired-state model: `ForgeObject` (kind, scope, key, file, desired body, unavailable fields), references (`{"$ref":"app"|"installation"|"team"|"user"}`, resolved at plan time), `writableBody`, and THE COMPARISON `differences` (every desired value must be in the live object; GitHub's extra fields are never drift; arrays named by `name`, `context` or `type` compare as sets).
- `live-state.ts` — one adapter per kind (`KIND_ADAPTERS`): how an object is read in the declared shape and created, updated or retired, all on the port; `EXCLUSIVE_KINDS` (rulesets, autolinks: an undeclared one is drift).
- `plan.ts` — `forgePlan`: create, update (with the differing pointers, and `loosening` when the update weakens a protection), unchanged, refused (with its code), unmanaged, or retire (always a loosening). A budget refusal stops the run. `forgeApply` applies TIGHTEN-FIRST:
  - it refuses before any write when a plan is incomplete, or when a loosening is neither acknowledged (`--accept-loosening <kind:scope:key>`, recorded in the receipt) nor a move into the org baseline;
  - it applies every tightening, then READS THE BASELINE BACK (`forge_tighten_unverified` if it does not hold what was declared);
  - it applies the acknowledged loosenings;
  - it judges every move again on what GitHub holds NOW: the repository's live `kind`, the live baseline and the live ruleset. It refuses with no protection moved unless every premise holds, and only then moves and retires.
  - A fresh plan is the verification.
- `strictness.ts` — THE STRICTNESS ORDER, total by construction. `looseningOf` judges every field either side carries: by its order where one is proven, as neutral where the field guards nothing, and as a loosening for anything else that differs, including every ruleset rule parameter and condition. Every kind is classified in an exhaustive table. `movedPremisesUnmet` names every premise a move into the org baseline relies on that does not hold.
- `repository-files.ts` — the in-tree renders beside `.github/forge/`. `.github/dependabot.yml` is written through THE one YAML emitter (`src/text/yaml-emit.ts`): every tracked lockfile outside the frozen prefixes must be a declared root, and every root must hold one. `.github/CODEOWNERS` is routing only, to the verifying roles of the role table. `workflowUsesOf` reads a workflow's `uses:` KEYS structurally: block scalars and multi-line quoted scalars are skipped whole, so `run:` text never widens the allowed actions, and a form it does not decide is refused. `forgeTreeFacts` gives the workflows' actions and the lockfiles.

## Tests

`engine/test/forge/fake-github.ts` is a stateful fake GitHub on the loopback
upstream: an object store by API path with ETags and pagination, the App flow
(installation lookup, token minting with JWT verification, manifest
conversion), authentication, the pinned-version check, refusals on demand and
routes of a test's own. Every lane tests against it.
