# Fonts

The self-hosted typefaces of the one design system: IBM Plex Sans and IBM Plex
Mono, as IBM publishes them (variable fonts, the Latin-1 subset).

## What each file does

- `ibm-plex-sans-var-roman-latin1.woff2` — IBM Plex Sans, upright, every weight.
- `ibm-plex-sans-var-italic-latin1.woff2` — IBM Plex Sans, italic.
- `ibm-plex-mono-var-roman-latin1.woff2` — IBM Plex Mono, upright, every weight.
- `ibm-plex-mono-var-italic-latin1.woff2` — IBM Plex Mono, italic.
- `OFL.txt` — the SIL Open Font License 1.1 they are published under.

## Where it lives and what consumes it

The folder lives at `public/fonts/`, served at `/fonts/`. The cockpit's token
owner (`src/cockpit/tokens.css`) declares the four `@font-face` blocks, and
`public/sw.js` caches the files. `tests/cockpit/cockpit-fonts-owner.test.ts`
keeps the declarations and the files in step.
