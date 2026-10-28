---
schema: bridlewise-tracker-item/v1
published: false
id: PUBLIC-SNAPSHOT-CANDIDATE-FORMAT
type: Task
state: closed
resolution: completed
lane: floor
opened: 2026-10-20
closed: 2026-10-20
---

closed 2026-10-20 at `c0f637e7`. Reproduced 3 red of 25 (`artifact admission rejected content format: ...historical-evidence.tar.gz`, `4532 !== 4533`, and `artifact-search-projection-drift:...verify-artifacts.mjs`). The owner is the projection declaration, not the evidence fixture: the public import sanitized the local home path to `/home/example` in exactly three text projections while `content-manifest.json` still declared the private-floor bytes (1627/360872/4533 against 1626/360852/4532); the archived originals do not match the manifest either (they retain the older `code-harness` path), and the public tree cannot carry the private home path because `npm run check:secrets` refuses it outside fixture paths. Re-measured the manifest from the bytes this tree carries under its own `identity`/`append-one-lf` rules (all three are identity) and updated both sidecars' `contentManifestSha256` (`52149559...` → `bef1b490...`); no evidence byte or archive was rewritten. `node --experimental-strip-types --test test/candidate-format.test.ts` is 25/25 after. The public import sanitizer must re-measure this manifest whenever it rewrites a projection; the focused guard is the refusal if it does not.
