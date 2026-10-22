# publish

The publisher App's work on the forge (`src/workflow/forge/publish/`), tested against the fake GitHub with Git Data routes backed by a real bare repository. git's own objects answer the blob, tree and commit requests, so "the forge built the same tree" is git's answer, not the fake's.

## What each file does

- `git-forge.ts` — the git-backed forge (not a test file): the Git Data routes over a bare repository (a ref created while absent, or moved by GraphQL `updateRefs` with its `beforeOid` and a fast-forward check; a REST `PATCH` of a ref refused), plus knobs that plant a wrong blob id, a wrong tree, an unsigned commit, or a ref move that is answered but never applied.
- `product.test.ts` — the product publication:
  - the re-made signed commit, its tree, parents, message, uploaded blobs and receipt;
  - a moved branch refused with nothing written;
  - each barrier with a test that goes red when it is removed (the blob id, the tree before any commit is made, the signature, the compare-and-swap's expected head, only-forward, the head check, an applied-but-unapplied move);
  - only promotion commits published, and the forge's refusal classes kept;
  - the publisher's check: the built tree must EQUAL the projection recomputed from S alone (an excluded file, internal notes, a replaced or added hook, a generated output with arbitrary content, wholly generated paths the projection does not hold, and a removed shipped file are each refused with their paths), under the profile read from S (a wrong blob or name refused);
  - the verb: it builds itself (a planted pending commit dropped and never carried), checks and publishes; a refusing build is its refusal, with nothing sent to the forge;
  - the grammar: `--out`, `--source` and the reasoned overrides, round trip included.
