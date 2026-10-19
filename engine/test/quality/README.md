# quality

The `engine/test/quality/` folder of the development surface.

## What each file does

- `semantic-form.test.ts` — the semantic form: comments, layout and quoting are not meaning; an operator, a name, a value or an order is; an unjudged kind is said; an unparsable file is refused.
- `shared-strip-behavior.test.ts` — regression test pinning the merged `stripCommentsAndStrings` behavior (single-line block comments included).

## Where it lives and what consumes it

The folder lives at `engine/test/quality/`.
