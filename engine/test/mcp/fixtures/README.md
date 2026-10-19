# fixtures

The `engine/test/mcp/fixtures/` folder of the development surface.

## What each file does

- `adversarial-mcp-server.mjs` — MCP server fixture with adversarial modes for improper-usage + multi-tool scenarios.
- `fake-mcp-server.mjs` — minimal MCP server (stdio.
- `fs-probe-mcp-server.mjs` — stdio MCP server whose tools report the authority it runs with (write/read a path, its env names, cwd, HOME): the confinement tests measure from inside it.
- `streamable-http-server.ts` — in-process, spec-faithful MCP Streamable HTTP server that records every request (method, headers, body).

Fixtures are spawned or started by tests from their own absolute paths and
configs. A fixture is never referenced from the shipped
`engine/bridlewise.config.json` (the shipped-config test refuses it).

## Where it lives and what consumes it

The folder lives at `engine/test/mcp/fixtures/`.
