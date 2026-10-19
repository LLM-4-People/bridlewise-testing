# mcp

The `engine/test/mcp/` folder of the development surface.

## What each file does

- `auth-headers.test.ts` — the `auth-headers.test` module.
- `config-resolution.test.ts` — config document → runtime entry resolution (`resolveMcpServerConfigs`).
- `config-schema.test.ts` — the config document schema, and the rules every SHIPPED MCP server obeys.
- `config.test.ts` — the `config.test` module.
- `exposure.test.ts` — the `exposure.test` module.
- `improper-usage.test.ts` — the `improper-usage.test` module.
- `no-static-constants.test.ts` — the `no-static-constants.test` module.
- `real-servers.test.ts` — real stdio servers under a test host, and the hosted Streamable HTTP servers (skipped honestly when unreachable).
- `registry.test.ts` — the `registry.test` module.
- `retry.test.ts` — the `retry.test` module.
- `tool-adapter.test.ts` — the annotation classifier (`mcpToolCapabilities`).
- `tool-name.test.ts` — the naming owner and the Responses projection's name validation.
- `transport.test.ts` — the transports, asserting the request headers a real server receives.
- `unavailability.test.ts` — the `unavailability.test` module.

## The subfolders

- `fixtures/`

## Where it lives and what consumes it

The folder lives at `engine/test/mcp/`.
