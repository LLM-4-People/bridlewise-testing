# Third-party notices

The development floor includes npm dependencies, vendored protocol/specification excerpts, and Unicode data used by verification. The upstream licenses travel with the material.

## Direct npm dependencies

### Web cockpit

- `svelte` — MIT
- `vite` — MIT
- `@sveltejs/vite-plugin-svelte` — MIT
- `typescript` — Apache-2.0
- `nanostores` — MIT
- `zod` — MIT
- `web-tree-sitter` — MIT
- `tree-sitter-wasms` — MIT

### Engine

- `zod` — MIT
- `@babel/parser` — MIT
- `@babel/types` — MIT
- `@xenova/transformers` — Apache-2.0 (optional peer for semantic embeddings; not installed by default because its transitive `sharp`/`protobufjs` tree carries known advisories)
- `web-tree-sitter` — MIT
- `tree-sitter-wasms` — MIT
- `undici` — MIT
- `esbuild` — MIT

### Test-only

- `yaml` — ISC (the YAML reader the workflow policy test parses workflows with)

Playwright, Vitest, `yaml`, and their transitive dependencies are installed from npm under their upstream licenses. They are not vendored.

## Vendored material in `engine/traceability/sources/`

| Path | Material | License |
|---|---|---|
| `path-policy/unicode-17.0.0/` | Unicode 17 normalization and case-folding data | Unicode License V3 (`LICENSE.txt`) |
| `runtime/node-v24.18.0-linux-x64/` | Node runtime manifest | Node.js license terms; see the upstream project |
| `s2/mcp-jsonrpc.ts`, `s2/mcp-tools.ts` | MCP protocol excerpts | `s2/mcp-LICENSE` |
| `s2/openai-*.yaml` | OpenAI streaming/protocol excerpts | `s2/openai-LICENSE` |
| `s3.1/jcs-*` | JSON Canonicalization Scheme vectors | `s3.1/jcs-LICENSE` |

These files are verification evidence, not linked runtime code. They retain their upstream licenses.

## Material not published

The public snapshot deliberately excludes:

- the vendored Git 2.55.0 path-policy source (GPL-2.0-only);
- the `historical-opencode` benchmark/sanitizer tree, whose provenance and license could not be established;
- private evidence, trackers, round history, and frozen records;
- the 4.1 GB external corpus.

If you need to redistribute any excluded material, obtain it from its upstream owner and comply with its license. Do not re-add it to this repository without a license review.

## Fonts

The cockpit requests IBM Plex Sans and IBM Plex Mono. No font binaries are vendored. IBM Plex is licensed under the SIL Open Font License 1.1; include the OFL notice if you bundle it.
