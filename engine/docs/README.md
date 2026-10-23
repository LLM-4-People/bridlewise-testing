# Engine docs

Current-codebase documentation for the engine: the documents that answer
"what is this and how do I change it today". The engine's prevention tests
read two of them, so they are carried in this tree.

## What each file does

- `registration-procedure.md` — the canonical steps to register a new module
  with the harness (manifest entry, composition root, hash bindings, the
  generators that re-derive them); `test/prevention/registration-procedure-doc.test.ts`
  holds the steps to this page.

## The subfolders

- `research/verification/` — `prevention-retrospective.md`, the human
  rendering of the prevention retrospective
  (`traceability/prevention/prevention-retrospective.json`), which
  `test/prevention/prevention-review.test.ts` checks against the record.

## Where it lives and what consumes it

The folder lives at `engine/docs/`. These documents are read by engineers
and by the two prevention tests named above; no module imports from here.
