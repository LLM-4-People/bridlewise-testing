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
- `history-import.ts` — THE HISTORY IMPORTER (above): `importHistory`, and its steps for the tests — `enumerateHistory`, `scanHistory` (one read of every blob, commit and tag, and of every path and ref name, for the catalogue's spans and the oracle's chunked findings), `judgeOracle` (covered, disposed or a gap), `planPurge` (the expressions, deterministic), `planRefs` (kept namespaces, everything else under `refs/heads/imported/`), `purgeResidue` (what the re-scan left), `decodedTexts`, `addressCensus` / `runAddressCensus` (the address census, in-process and bounded), `runHistoryScan` (the scan, bounded), `namesOldId` / `oldIdIndex` (the old-id search), `receiptRefusal` and `recordedLocation`, `readImportReview`, `admitImportHome`.
- `history-identities.ts` — THE ADDRESS GATE's pure parts: the address shapes (`addressSpans`: plain, percent-encoded, RFC 2047; bounded, from each `@`), the known-address search (`knownAddresses`, `knownMatches`, `unescapedText`, `base64Payloads`, `hexPayloads`), the one fold (`foldAddress`: NFKC and the Unicode case fold) and the digest a disposition names (`addressDigest`), `withoutAddresses` (a printed message withholds every address), the public-tree check by identity (`insideTree`), the one mapping file (`readIdentityMap`), the judgement (`judgeAddresses`), the rewrite plan (`planAddressRewrite`) and the one comparator of the generated lists (`longestFirst`).
- `history-child.ts` — the importer's bounded child program: the address census (`addressCensus`) and the catalogue scan (`scanHistory`), each in a process of its own under the one bounded run, its answer on stdout only.
- `history-tools.ts` — THE PINNED TOOLS: gitleaks 8.30.1 and git-filter-repo 2.47.0, each pinned by the sha256 of its release archive and of the file run (an AUTHORED PINS region), `resolveHistoryTool` (absent → the provisioning command; other bytes → refused), `runBounded` / `runHistoryTool` (a process group bounded by CPU time and a stall check, never wall time; stopped only through the owned-process `terminate`).
- `gitleaks-config.ts` — THE ORACLE'S CONFIGURATION, projected from the catalogue: gitleaks' default rules plus one `bridlewise-<row>` rule per catalogue row RE2 can express; a row with a lookaround or a JavaScript-only escape is named in the header, never approximated.

## The verbs (`harness forge`, `cli.ts`)

```bash
node src/cli.ts harness forge apps manifests [--check]   # write (or check) .github/forge/ from the registry
node src/cli.ts harness forge apps create                # the Apps page, Session 1 (runbook P1.2)
```

- `cli.ts` — the `harness forge` dispatch (the section through `configured-forge.ts`). `apps create` preflights the maintainer's `gh` and the `door`/`publish` environments, then serves the page until the maintainer presses Done; `plan`, `apply` and `audit` judge the forge against the generated files (`plan.ts`); `import-history` runs the history importer (below) with the admitted import home and the configured git.
- `apps-page.ts` — THE APPS PAGE (127.0.0.1 only), behind three barriers, each with a test that goes red without it: a ONE-TIME TOKEN printed in the terminal only (`/?t=…`; without it the page answers 404 and serves no state), Host and Origin checks, and THE CONVERSION CHECK (`verifyConversion`: the created App's owner, name, permissions and events must equal the generated manifest, or `forge_app_conversion_mismatch` and nothing is stored). One Create button per App posts its manifest with a one-use state. The callback converts the code and stores the key in the custody FIRST; an environment key is then pushed through the maintainer's `gh`, and a failed push stays held and is resumed on the next load. A name a half-finished attempt took is detected (`forge_app_name_taken`) and never offered again. The page then lists the install links with the exact repositories, the legacy Apps to narrow and the Discussion categories (from the community intake). It renders from one embedded JSON document, under a nonce CSP; Done needs the session token and the page's origin.
- `maintainer-cli.ts` — THE MAINTAINER'S `gh`, only while the owner credential is on the host (Session 1): an environment secret (sealed by `gh`, because Node has no sealed box; the value on stdin only), an environment variable, whether an environment exists, whether an App name is taken, and `ready`. Each run is `runBoundedCommand`, a thin mapping onto the ONE supervisor's work-bounded mode (`runCpuBounded`, src/process/supervised-run.ts): a projected environment (no token variable passes), the process group bounded, and NO WALL-CLOCK KILL. A run ends only when it stalls (no output and no CPU work for `forge.maintainerCli.stallMs`) or passes its CPU limit (`cpuLimitMs`), which gives `forge_maintainer_cli_stalled`; any other failure is `forge_maintainer_cli_failed` with `gh`'s words.

- `forge-config.ts` — THE `forge` CONFIGURATION SECTION (spliced into the config document by `src/kernel/config-contracts.ts`): the organisation, the API and web origins, the request bounds (timeout, body size, cleanup, ETag cache entries, page bound), the token renewal margin, the repository topology (name, `kind`, visibility, the proving ground; exactly one trunk) and the Apps page (port, the legacy Apps to narrow); `forgeEndpoint`, `trunkRepository`, `repositoriesOfKinds`. No default in code; it imports no configuration reader (the kernel imports it).
- `configured-forge.ts` — THE ONE READER of the section (`configuredForgeSection`, the section or its absence for the `harness regenerate` arm; `configuredForge`, the section or `forge_not_configured`) and `configuredForgeClient(credential)`: every entry point that talks to GitHub builds its client here.
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

## The history importer, in one paragraph

`harness forge import-history <source> (--to <target> | --dry-run) [--review <file>] [--identity-map <file>]` is the
ONE path a history enters the forge (github-only §8.3, runbook P6.1). It
mirrors the source into a run folder of the private import home
(`HARNESS_IMPORT_HOME`, default `~/.local/state/bridlewise/history-import`,
0700, kept out of every confined process) and enumerates every object of every
ref. It reads each object ONCE and decodes every text it holds before any
matching, judged over the WHOLE content (a BOM's encoding — UTF-8,
UTF-16LE/BE, UTF-32LE/BE — else strict UTF-8, plus UTF-16 when the NULs sit
at alternate positions, plus the printable UTF-16 runs anywhere in the bytes
at both alignments); an object nothing
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
but UTF-8 — stripped whole, and only once the review acknowledges it by id
(`strips`; `strip.json` lists each with its paths): nothing is dropped
silently), re-scans to zero (`purgeResidue`), scans the
receipt itself (no absolute or home path: a local repository is recorded as
`local:<name>`; no catalogue hit), commits it on `refs/heads/ledger`, and
pushes every ref with an explicit refspec, atomically and never forced, into
an EMPTY target, then reads the target back. Before anything is rewritten or
pushed, THE ADDRESS GATE (`history-identities.ts`, the census in
`history-import.ts`) judges EVERY published byte: every address-shaped string
(plain, percent-encoded, or in an RFC 2047 encoded word; found from each `@`
with RFC 5321's bounds on its parts, so a text costs its length) in every
blob, commit and tag (read as UTF-8, lossy UTF-8, UTF-16LE/BE at both
alignments, and latin1 when nothing decodes), in EVERY path every tree records
(each tree read: `rev-list` names a shared object once) and in every ref name, compared under the ONE Unicode case fold (after
NFKC) against the ONE allowed list (`forge.historyImport.allowedIdentities`).
An address not on it must be MAPPED by the ONE identity mapping
(`--identity-map`, a mailmap-style file) or DISPOSED in the review (by the
digest of its folded form, with the reason); both files are refused inside the
public tree (compared by IDENTITY: the device and inode of each folder above
the file against the tree's root, so a link, `..` or another case of a name
changes nothing; a file with a second name, a hard link, counts as inside).
Anything else is refused (`history_import_identity_unallowed`), counting the
objects and listing each address by its digest, with its objects, in
`addresses.json`, never the address. A MAPPED-FROM address is KNOWN, so it is
also searched as that value in every spelling a reader recognises (entities,
quoted-printable, percent and backslash escapes, base64 at any alignment, a
compatibility form after NFKC, invisible characters, a folded line,
`[at]`/`[dot]`, a quoted local part: its letter-and-digit SKELETON in the
skeleton of every reading, references read loosely through the markup owner):
one the rewrite cannot reach is refused before the rewrite
(`history_import_identity_unreachable`). The census and the catalogue scan run
in the importer's child process under the one bounded run (`runAddressCensus`,
`runHistoryScan`), and the trees' paths are read under a declared count and
depth bound (`history_import_tree_bound`): no history holds the importer's own
process unbounded. The
importer applies the mapping in its one rewrite: a generated mailmap of the
exact header spellings, a literal expression for every exact spelling in text
filter-repo rewrites in place, and a blob it cannot rewrite in place stripped
whole (acknowledged). The SAME census then judges the rewritten history and
the receipt: an unallowed address, or the mapped-from address in ANY spelling,
is refused (`history_import_identity_residue`), and so is ANY object id from
before the rewrite, whole or abbreviated, anywhere it is published
(`history_import_old_id_residue`: with the public rewritten object an old id
confirms a guess); notes follow their commits first (`translateNotes`, through
the commit map). The published receipt holds only post-rewrite facts anyone
can recompute: nothing measured before the rewrite (a byte total's difference
is a replaced identity's length), no old id, no digest of the mapping, the
review or the expressions; those, and filter-repo's commit map, are in the
PRIVATE record (`record.json`, `commit-map`) in the run folder. `--dry-run` stops after the scans and answers
COUNTS only: the hits, the gaps, every unallowed address by what resolves it,
the places the rewrite cannot reach, and the blobs it would strip
(`addresses.json` and `strip.json` hold the details, privately). A secret in a path or a ref name,
or a credential in a URL, is refused. The two tools are pinned by sha256 and
checked before every run, and every tool process runs as a PROCESS GROUP
under the one supervisor's work-bounded mode: the group's CPU time (members
that vanished included) and a stall check (no output and no CPU progress),
until its pipes close, never by wall time; the harness does not download them (the outbound door never
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
