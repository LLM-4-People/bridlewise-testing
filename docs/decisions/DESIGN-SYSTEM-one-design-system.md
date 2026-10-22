---
id: DESIGN-SYSTEM
date: 2026-10-10
by: user
group: user-rules
status: in-force
implementation: pending
route: DESIGN-SYSTEM
---
# One design system across the harness

When each surface (the web app, the desktop app, the docs, generated pages)
keeps its own styles, they look like different products and every visual fix
is made several times. So one design system is the single source for all of
them.

The user, 2026-10-10: "we need the same set of design, elements, typo, etc
shared, thorough the entire harness".

- One design system (tokens, typography, elements, components) is the single
  source for the web UI, the desktop app, the docs and artifacts.
- No surface defines its own styles or copies components. New UI work consumes
  it; a difference between surfaces is a finding.

What is missing: the web cockpit has one token file
(`src/cockpit/tokens.css`, described in `DESIGN.md`), but the docs site keeps
its own stylesheets (`scripts/floor/design-coverage.mjs` checks the site
against them, not against the shared tokens), and nothing yet shares one
source across surfaces or refuses a surface's own styles.
