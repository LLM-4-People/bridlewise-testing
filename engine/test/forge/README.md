# forge

The `engine/test/forge/` folder of the development surface: the forge
(`engine/src/workflow/forge/`), against a fake GitHub on the loopback
upstream, so every test drives the real outbound door and transport.

## What each file does

- `fake-github.ts` — THE FAKE GITHUB every lane's forge tests use (not a test file): an object store by API path with ETags (a 304 is not counted) and `Link` pagination; the App flow (installation lookup and token minting with RS256 JWT verification against the App's generated key, manifest conversion); authentication; the pinned-version check; `refuseNext` (rate, secondary and plan refusals), per-test `route`s and the token lifetime. Tokens are assembled at runtime.
- `github-client.test.ts` — the GitHub adapter: the pinned version, media type and user agent; conditional GETs (304 from the cache, not counted; the bounded LRU); pagination and its required bound; every refusal classified once (budgets with their reset or wait, plan, permission, validation, server) with near misses; a redirect is `github_moved`; GraphQL errors; the API-path checks; credentials asked at call time.
- `app-tokens.test.ts` — the App registry (four Apps, least privilege, GitHub's permission names, custody), narrowing that never widens, the host key custody (0600 in the key home, identity without the key, environment Apps refused, malformed records refused) and installation-token minting (narrowed, cached, renewed before expiry; a token minted wider is an integrity stop).

- `apps.test.ts` — GH-1a: the App manifests, the `forge` section's refusals, and the generated `.github/forge/` files (drift named in two places, plus a near miss). The maintainer's `gh`: a secret on stdin only and typed failures without the value. The bounded run: input on stdin, a stall ended, a busy run ended by its CPU limit and never by a stall, and a slow talker kept alive. The Apps page against the fake GitHub, with each barrier red without it: the one-time token (no state without it), Host and Origin, and the conversion check (owner, name, permissions, events). Custody right after conversion: an environment key is stored before its push, held on failure and resumed on reload. A name already taken is detected. End to end: host custody, install links, and Done guarded by session and origin. A busy port is typed.

- `declarations.test.ts` — the declarations (every object once, in apply order, the plan's unavailable fields, the registry's references, the stage's flip, a form type outside the registry refused), the allowed actions, Dependabot's breadth over the tracked lockfiles, CODEOWNERS routing, and the comparison.
- `forge-settings.ts` — the forge section and the generated files' sources the forge tests use (a fixture, not a test file), independent of the repository's own configuration.
- `plan.test.ts` — plan, apply and audit against the fake GitHub: every action (create, update, unchanged, refused, unmanaged, retire), the tighten-first barriers (the baseline written and read back before rules move out; a read-back that fails stops the apply; a weakening only with its acknowledgement), a partial plan never applied, one object's refusal kept to it, a budget refusal stopping the run, unavailable fields never written, and the whole declaration set applied and converged to zero drift, idempotently.
- `forge-key-home.ts` — the forge tests' key homes (a helper, not a test file): `temporaryKeyHome` creates a new, empty key home under the test process's own temporary root for every test that stores a key; `requireTestKeyHome` refuses to run unless the process is under the runners' private test key home.
- `flake-shim-token-ends-zero.ts` — a deterministic reproduction shim (registered in `testExecution.flakeReproduction.deterministicShims`): every `randomBytes` answer ends in a byte with a zero low half, recreating the one draw in sixteen that made the token test's near miss equal the real token.

## Where it lives and what consumes it

The folder lives at `engine/test/forge/`.
