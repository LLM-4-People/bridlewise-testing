# publish

The publisher App's work on the forge (`src/workflow/forge/publish/`), tested against the fake GitHub with Git Data routes backed by a real bare repository. git's own objects answer the blob, tree and commit requests, so "the forge built the same tree" is git's answer, not the fake's.

## What each file does

- `product.test.ts` — the product publication:
  - the built promotion re-made as a signed commit holding the built tree, with parents [tip, source], the message and trailers kept, only the changed blobs uploaded, the branch moved forward, and the canonical receipt;
  - a branch that moved since the build refused with nothing written;
  - an unsigned commit or a wrong tree refused as integrity, with the branch unmoved;
  - a commit with no trailers, or with swapped parents, refused before any request;
  - the forge's refusals keeping their class (errored, refused);
  - the verb (nothing pending refused; the receipt written for the attestation);
  - the `forge-publish` grammar and its round trip.
