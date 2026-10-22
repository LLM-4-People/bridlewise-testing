---
published: false
---

# Brand sources

The project's public words, in two sources that every generated surface reads.

## What each file does

- `messaging.json` holds the name, the
  promise, the summary, what this repository is, the developer-preview status line, the licence, the
  repository description and topics, and the name's own story (a cited
  dictionary entry). Its format is checked by `engine/src/workflow/messaging.ts`.
  The repository's and the site's addresses are not in it: `package.json`
  `repository.url` declares them once.
- `claims.json` is the claims register. Every public claim belongs to one of
  three kinds:
  - a claim that holds while its checks pass;
  - a claim that is designed but not built, which names its decision;
  - something we do not claim, with the reason.
  
  Its format is checked by `engine/scripts/brand/claims.ts`.

## Where it lives and what consumes it

The folder lives at `docs/brand/`. `engine/scripts/brand/cli.ts` renders, from
these two files:
- the README's front block, and the site home's hero and description, written
  by `harness sync` and judged by `harness check`, which also refuses an
  invalid source (a cited proof the tree does not hold, a decision that is not
  a record, a status line without "developer preview");
- the org profile;
- the repository metadata (the forge's repository settings read the same
  reader, `engine/src/workflow/messaging.ts`);
- the release-note header;
- the claims page.

Edit these two files, never a
rendered surface.
