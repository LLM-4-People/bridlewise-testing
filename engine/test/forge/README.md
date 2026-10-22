# forge

The `engine/test/forge/` folder of the development surface: the forge
(`engine/src/workflow/forge/`), against a fake GitHub on the loopback
upstream, so every test drives the real outbound door and transport.

## What each file does

- `fake-github.ts` — THE FAKE GITHUB every lane's forge tests use (not a test file): an object store by API path with ETags (a 304 is not counted) and `Link` pagination; the App flow (installation lookup and token minting with RS256 JWT verification against the App's generated key, manifest conversion); authentication; the pinned-version check; `refuseNext` (rate, secondary and plan refusals), per-test `route`s and the token lifetime. Tokens are assembled at runtime.
- `github-client.test.ts` — the GitHub adapter: the pinned version, media type and user agent; conditional GETs (304 from the cache, not counted; the bounded LRU); pagination and its required bound; every refusal classified once (budgets with their reset or wait, plan, permission, validation, server) with near misses; a redirect is `github_moved`; GraphQL errors; the API-path checks; credentials asked at call time.
- `app-tokens.test.ts` — the App registry (four Apps, least privilege, GitHub's permission names, custody), narrowing that never widens, the host key custody (0600 in the key home, identity without the key, environment Apps refused, malformed records refused) and installation-token minting (narrowed, cached, renewed before expiry; a token minted wider is an integrity stop).

- `apps.test.ts` — GH-1a: the App manifests, the `forge` section's refusals, and the generated `.github/forge/` files (drift named in two places, plus a near miss). The maintainer's `gh`: a secret on stdin only and typed failures without the value. The bounded run: input on stdin, a stall ended, a busy run ended by its CPU limit and never by a stall, and a slow talker kept alive. The Apps page against the fake GitHub, with each barrier red without it: the one-time token (no state without it), Host and Origin, and the conversion check (owner, name, permissions, events). Custody right after conversion: an environment key is stored before its push, held on failure and resumed on reload. A name already taken is detected. End to end: host custody, install links, and Done guarded by session and origin. A busy port is typed.

- `proving/` — the proving-ground scenarios on real GitHub (P1.11, P3.8), run by `proving/run.ts`, never by the offline suites (see its README).
- `proving-ground-api.ts` — the proving ground's rules on any forge client, shared by the scenarios and their offline tests (not a test file): the repository's identity (the one `provingGround` repository, never the trunk), the seed, the read-only configuration check, a deleted branch (404 only), a commit's verification, and the verdict rules of V-6, V-14 and V-15.
- `proving-ground-api.test.ts` — those rules against the fake GitHub, each red under mutation.
- `proving-isolation.test.ts` — no test file reaches `proving/`, directly or through a helper (the repository's one reachability walk, with a direct and a transitive witness).
- `forge-key-home.ts` — the forge tests' key homes (a helper, not a test file): `temporaryKeyHome` creates a new, empty key home under the test process's own temporary root for every test that stores a key; `requireTestKeyHome` refuses to run unless the process is under the runners' private test key home.
- `flake-shim-token-ends-zero.ts` — a deterministic reproduction shim (registered in `testExecution.flakeReproduction.deterministicShims`): every `randomBytes` answer ends in a byte with a zero low half, recreating the one draw in sixteen that made the token test's near miss equal the real token.

## Where it lives and what consumes it

The folder lives at `engine/test/forge/`.
