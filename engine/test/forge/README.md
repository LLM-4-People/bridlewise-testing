# forge

The `engine/test/forge/` folder of the development surface: the forge
(`engine/src/workflow/forge/`), against a fake GitHub on the loopback
upstream, so every test drives the real outbound door and transport.

## What each file does

- `fake-github.ts` — THE FAKE GITHUB every lane's forge tests use (not a test file): an object store by API path with ETags (a 304 is not counted) and `Link` pagination; the App flow (installation lookup and token minting with RS256 JWT verification against the App's generated key, manifest conversion); authentication; the pinned-version check; `refuseNext` (rate, secondary and plan refusals), per-test `route`s and the token lifetime. Tokens are assembled at runtime.
- `github-client.test.ts` — the GitHub adapter: the pinned version, media type and user agent; conditional GETs (304 from the cache, not counted; the bounded LRU); pagination and its required bound; every refusal classified once (budgets with their reset or wait, plan, permission, validation, server) with near misses; a redirect is `github_moved`; GraphQL errors; the API-path checks; credentials asked at call time.
- `app-tokens.test.ts` — the App registry (four Apps, least privilege, GitHub's permission names, custody), narrowing that never widens, the host key custody (0600 in the key home, identity without the key, environment Apps refused, malformed records refused) and installation-token minting (narrowed, cached, renewed before expiry; a token minted wider is an integrity stop).
- `history-fixture.ts` — THE PLANTED HISTORY the importer's tests share (not a test file): a repository with a credential, assembled at runtime, in every place a history holds one (a text blob, a short connection-string password, a binary blob, a commit message, a tag message, a note), on branches, a tag, notes and `refs/pull/*`, beside near-misses the catalogue must not flag; also consumed by `engine/live/history-import.test.ts`.
- `history-import.test.ts` — the history importer's every git-only step: enumerate and the catalogue scan (each planted place found with its entry, no near-miss, a secret in a path or ref name refused), the purge plan (deterministic, short values anchored in their line, binary blobs stripped, inexpressible lines refused), the oracle (every object and name once, in chunks, each finding named to its object) and its judgement (covered, gap, projection divergence, disposed), every encoding (UTF-16LE with and without a BOM, UTF-16BE, UTF-32, UTF-8 with a BOM; an undecodable object listed yet matched byte for byte), the re-scan to zero (each kind of residue), the receipt (no absolute or home path, no catalogue hit), the review schema, the ref plan, the oracle configuration's RE2 projection, the pinned tools' refusals, the bounded runner (CPU budget, stall, progress never a stall, output bound) and the door's URL and usage refusals. The whole pipeline with the pinned tools is the live suite's.

## Where it lives and what consumes it

The folder lives at `engine/test/forge/`.
