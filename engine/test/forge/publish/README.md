# publish

The publisher App's work on the forge (`src/workflow/forge/publish/`), tested against the fake GitHub with Git Data routes backed by a real bare repository. git's own objects answer the blob, tree and commit requests, so "the forge built the same tree" is git's answer, not the fake's.

## What each file does

- `git-forge.ts` — the git-backed forge (not a test file): the Git Data routes over a bare repository, plus knobs that plant a wrong blob id, a wrong tree, an unsigned commit, or a ref update that is answered but never applied.
- `product.test.ts` — the product publication:
  - the re-made signed commit, its tree, parents, message, uploaded blobs and receipt;
  - a moved branch refused with nothing written;
  - each barrier with a test that goes red when it is removed (the blob id, the tree, the signature, `force: false`, the head check, the re-read);
  - only promotion commits published, and the forge's refusal classes kept;
  - the publisher's check: the built tree must be the projection recomputed from S under the profile read from it (an excluded file, internal notes or a changed shipped file named; a wrong profile blob or name refused);
  - the verb: it builds itself (a planted pending commit dropped and never carried), checks and publishes; a departing build publishes nothing; a refusing build is the verb's answer;
  - the grammar: `--out`, `--source` and the reasoned overrides, round trip included.
