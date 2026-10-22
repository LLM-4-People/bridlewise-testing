# forge

The `engine/test/forge/` folder of the development surface: the forge
(`engine/src/workflow/forge/`), against a fake GitHub on the loopback
upstream, so every test drives the real outbound door and transport.

## What each file does

- `fake-github.ts` — THE FAKE GITHUB every lane's forge tests use (not a test file): an object store by API path with ETags (a 304 is not counted) and `Link` pagination; the App flow (installation lookup and token minting with RS256 JWT verification against the App's generated key, manifest conversion); authentication; the pinned-version check; `refuseNext` (rate, secondary and plan refusals), per-test `route`s and the token lifetime. Tokens are assembled at runtime.
- `github-client.test.ts` — the GitHub adapter: the pinned version, media type and user agent; conditional GETs (304 from the cache, not counted; the bounded LRU); pagination and its required bound; every refusal classified once (budgets with their reset or wait, plan, permission, validation, server) with near misses; a redirect is `github_moved`; GraphQL errors; the API-path checks; credentials asked at call time.
- `app-tokens.test.ts` — the App registry (four Apps, least privilege, GitHub's permission names, custody), narrowing that never widens, the host key custody (0600 in the key home, identity without the key, environment Apps refused, malformed records refused) and installation-token minting (narrowed, cached, renewed before expiry; a token minted wider is an integrity stop).

- `apps.test.ts` — GH-1a: the App manifests (the registry's exact permissions, no webhook, owner-only, the local callback), the `forge` section's refusals, the generated `.github/forge/` files (written, a hand edit and a stray named, a near miss beside the folder left alone), the maintainer's `gh` (a secret on stdin only, typed failures without the value), and the Apps page end to end against the fake GitHub (CSP, Host check, unknown and used states refused, the agent key in the host custody, the door key in the environment secret, install links, Done guarded by session and origin; a busy port is typed).

## Where it lives and what consumes it

The folder lives at `engine/test/forge/`.
