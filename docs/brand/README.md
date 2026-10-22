---
published: false
---

# Brand sources

The project's public words, in two sources that every generated surface reads.

## What each file does

- `messaging.json` holds the name, the repository and site addresses, the
  promise, the summary, the developer-preview status line, the licence, the
  repository description and topics, and the name's own story (a cited
  dictionary entry). Its format is checked by `engine/scripts/brand/messaging.ts`.
- `claims.json` is the claims register. Every public claim belongs to one of
  three kinds:
  - a claim that holds while its checks pass;
  - a claim that is designed but not built, which names its decision;
  - something we do not claim, with the reason.
  
  Its format is checked by `engine/scripts/brand/claims.ts`.

## Where it lives and what consumes it

The folder lives at `docs/brand/`. `engine/scripts/brand/cli.ts` renders, from
these two files:
- the README's front block;
- the org profile;
- the repository metadata;
- the release-note header;
- the claims page.

The roadmap renderer reads the addresses. Edit these two files, never a
rendered surface.
