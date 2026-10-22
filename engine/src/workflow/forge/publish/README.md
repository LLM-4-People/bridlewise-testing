# publish

The publisher App's work on the forge (`app-registry.ts` names this folder as its owner): the product branch first, and later the releases, the projection, Pages and the ledger. Every request goes through the forge port (`../port.ts`, the one GitHub client), as the publisher App; nothing here retries or waits, so a budget or a failure reaches the caller as the forge's typed refusal.

## What each file does

- `git-data.ts` — the Git Data API on the port: `remakeCommit` carries one local commit to the forge. It uploads the blobs the commit changes against its first parent (each answered id checked), builds the tree on that parent's tree (the answered tree must be the local one), and makes the commit with no author, committer or signature, so GitHub signs it; an unsigned answer is refused. `branchHead` reads a branch, `advanceBranch` moves it only forward (`force: false`) after checking it still names the expected head, then re-reads it. `treeDelta` is the tree diff a re-made commit carries. Every mismatch is `forge_publication_mismatch` (integrity).
- `product.ts` — the product publication (decision PROMO-GH). `publishProduct` takes the promotion commit this job built (its trailers must name its source and profile, and its parents must be [the product tip, the source]), refuses when the forge's product branch moved since the build, re-makes the commit with parents `[T, S]` and moves the branch. It answers the projection receipt (`bridlewise-product-projection/v1`): the published commit, the built commit, the tree, the source, the profile and the head it landed on. `forgePublishVerb` is `harness promote forge-publish --out <file>`: it publishes the profile's pending commit and writes the receipt's canonical bytes (`receiptBytes`) for the job to attest. `configuredProductForge` is the configured forge as the publisher App, reading the installation token the job mints from `PUBLISHER_TOKEN_VARIABLE`.

## The publish job (for the generated `publish.yml`, environment `publish`)

1. Check out `main` at the landed commit, fetch `product`, and install both dependency trees.
2. Build the promotion: `harness promote apply --no-publish --source HEAD`. The projection is recomputed from S, and the profile's phases certify it.
3. Mint the publisher App's installation token from the `publish` environment's `PUBLISHER_APP_KEY` and `PUBLISHER_APP_CLIENT_ID`, exported as `BRIDLEWISE_PUBLISHER_TOKEN`.
4. Publish it: `harness promote forge-publish --out projection-receipt.json`.
5. Attest `projection-receipt.json` (`actions/attest`, the receipt as the subject).
