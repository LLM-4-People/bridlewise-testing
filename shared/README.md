# Shared

The wire contracts and shared declarations that both the server and the
client import. One capability, route, error code, or payload shape is
declared once here and consumed on both sides of the HTTP boundary, so the
two cannot drift.

## What each file does

- `routes.ts` — the canonical route list: the single source of truth for the
  set of surfaces the UI can show.
- `types.ts` — type-only re-exports from the canonical engine source, so
  event and state types originate in one place.
- `wire-types.ts` — the pure data shapes that cross the HTTP boundary from
  server to client.
- `input-schemas.ts` — the wire-input zod schemas and derived types for the
  request bodies the client sends.
- `ui-schema.ts` — the UI schema wire types shared by the server (schema
  builder) and the client (renderer), plus the schema version.
- `module-contract.ts` — the module contract: one declaration per UI
  surface, shared server↔client.
- `block-contract.ts` — the block contract: one declaration emits every
  projection of a unit of backend capability.
- `event-types.ts` — the inline event-kind vocabulary shown in the chat
  transcript (hallucination, steering, and friends).
- `errors.ts` — the error taxonomy: one code set shared by the server and
  the client.
- `constants.ts` — the shared protocol and schema constants consumed by more
  than one module.
- `dev-ports.ts` — the dev workflow's two ports, declared once for the Vite
  dev server, the API config owner, and the test floor's freshness preflight.
- `provenance.ts` — the provenance contract: the shape of "where did this
  value come from".
- `when-eval.ts` — the when-clause evaluator: the declarative visibility
  predicate language UI schema entries carry.
- `html-preview.ts` — the config-reader half of the untrusted-HTML iframe
  sandbox hardening.
- `web-ui-types.ts` — web-UI-local pure shared types with no dependency on
  the engine.
- `web-ui-defaults.ts` — the web-UI tunable defaults and readers, shared
  server↔client.
- `markdown.ts` — THE ONE MARKDOWN PARSER: markdown → plain nodes for the
  cockpit renderer, and `extractMarkdown` (links, reference definitions, code
  spans, with lines) for the repository's dead-link and briefing checks.
- `markup.ts` — THE ONE MARKUP ESCAPE OWNER: HTML escaping, entity decoding,
  Markdown table-cell escaping, tag stripping and comment/element removal,
  each in one pass (no double unescaping, no token formed across a removed
  region). `tests/public/markup-owner.test.mjs` refuses a hand-rolled copy
  anywhere in the tree.
- `site-page.ts` — WHAT EVERY PAGE OF THE PUBLIC SITE CARRIES: the two
  Content-Security-Policies (`sitePolicies`: the origin, and the site's
  base path on a shared origin; the Markdown table alignments are the only
  hashed style attributes), the extensions Pages serves as HTML, the
  palette burn-down list, and where a reader's theme choice is remembered. The site builder writes them into the pages, and the rendered
  judge checks them on every built page.
- `token-reader.ts` — THE TOKEN OWNER READ AS DATA: the one door between
  the design system (`src/cockpit/tokens.css`) and every surface that cannot
  load it as a stylesheet — the Pages site's generated token sheet, the
  generated icons, README images and social cards. It parses the owner's
  themes, follows `var()`, makes a colour concrete (hex, `rgb[a]`, `oklch`,
  `color-mix` in sRGB) and writes a surface's token sheet; an undeclared name
  is a typed refusal.

## Where it lives

The folder lives at `shared/`.
