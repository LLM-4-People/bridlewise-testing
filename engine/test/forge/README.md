# forge

The `engine/test/forge/` folder of the development surface: the forge
(`engine/src/workflow/forge/`), against a fake GitHub on the loopback
upstream, so every test drives the real outbound door and transport.

## What each file does

- `fake-github.ts` — THE FAKE GITHUB every lane's forge tests use (not a test file): an object store by API path with ETags (a 304 is not counted) and `Link` pagination; the App flow (installation lookup and token minting with RS256 JWT verification against the App's generated key, manifest conversion); authentication; the pinned-version check; `refuseNext` (rate, secondary and plan refusals), per-test `route`s and the token lifetime. Tokens are assembled at runtime.
- `github-client.test.ts` — the GitHub adapter: the pinned version, media type and user agent; conditional GETs (304 from the cache, not counted; the bounded LRU); pagination and its required bound; every refusal classified once (budgets with their reset or wait, plan, permission, validation, server) with near misses; a redirect is `github_moved`; GraphQL errors; the API-path checks; credentials asked at call time.
- `app-tokens.test.ts` — the App registry (four Apps, least privilege, GitHub's permission names, custody), narrowing that never widens, the host key custody (0600 in the key home, identity without the key, environment Apps refused, malformed records refused) and installation-token minting (narrowed, cached, renewed before expiry; a token minted wider is an integrity stop).
- `projection-store.ts` — an in-memory projection store (`src/workflow/forge/projector/store.ts`) that keeps each object's git-owned fields, counts the writes, and plays GitHub's failure modes on demand: a field it silently does not keep, a refusal at the n-th write, an edit by someone else, an object someone else created.
- `projector.test.ts` — the projector: D's issues and labels with permalinks at S and the marker; V-26 (two sealed processes give one digest; the clock, `Intl`, randomness, `fetch`, `process`, timers, the locale, code from strings, a realm escape and any import outside the declared modules are each refused typed); the first run's phase order; V-25 (a second run makes zero writes; a changed record writes only its difference); V-28 (a silently dropped field is `projection_unverified`); the resumable budget refusal; a refused write; orphans; the input read from the commit, never the working tree; this repository's own projection.

- `apps.test.ts` — GH-1a: the App manifests, the `forge` section's refusals, and the generated `.github/forge/` files (drift named in two places, plus a near miss). The maintainer's `gh`: a secret on stdin only and typed failures without the value. The bounded run: input on stdin, a stall ended, a busy run ended by its CPU limit and never by a stall, and a slow talker kept alive. The Apps page against the fake GitHub, with each barrier red without it: the one-time token (no state without it), Host and Origin, and the conversion check (owner, name, permissions, events). Custody right after conversion: an environment key is stored before its push, held on failure and resumed on reload. A name already taken is detected. End to end: host custody, install links, and Done guarded by session and origin. A busy port is typed.

- `forge-key-home.ts` — the forge tests' key homes (a helper, not a test file): `temporaryKeyHome` creates a new, empty key home under the test process's own temporary root for every test that stores a key; `requireTestKeyHome` refuses to run unless the process is under the runners' private test key home.
- `flake-shim-token-ends-zero.ts` — a deterministic reproduction shim (registered in `testExecution.flakeReproduction.deterministicShims`): every `randomBytes` answer ends in a byte with a zero low half, recreating the one draw in sixteen that made the token test's near miss equal the real token.

## Where it lives and what consumes it

The folder lives at `engine/test/forge/`.
