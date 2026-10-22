---
schema: bridlewise-tracker-item/v1
id: FLAKY-PUBLIC-ENGINE-GATE-LOG-PASSWORD-TAIL
type: Flake
state: closed
resolution: completed
lane: flaky-burn-down
opened: 2026-10-20
closed: 2026-10-20
---

covered and retired 2026-10-20 on `agent/public-reowning` from `114ab553` as fixed by `5f8aa96d`, not left owned: the identity is `engine/test/workflow/working-copy.test.ts` `the gate log redacts across chunk boundaries: …`; the private row records it failed once (2026-10-14 19:55Z, validate 19) because its random synthetic password ended in `_` or `-`, the persistence redaction keeps such a final character outside its marker (`"password": "[REDACTED:credential]-"`, measured 8 of 300 random JSON values), and the exact-shape assertion failed although the password never reached the log; the test's password now ends in a letter (0 of 2000 off-shape over the four forms), and the dropped character is the separate `REDACT-AMPERSAND-TAIL` case, not this identity. The test file at HEAD is byte-identical to `5f8aa96d` (`88f3532c…`), so the fix is in this tree. There is no `engine/traceability/flake-reproductions/` record for the identity, but this is a deterministic test-fixture red fixed at its cause, not a flake. The one public `engine.json` entry leaves with this row (the ledger's shrink-only rule; the private floor remains the owner of its records). Ran: `working-copy.test.ts` 35/35; the engine flaky guard 19/19; `npm run test:public` 34/34; `npm run docs:links` clean (512 files); `npm run docs:roadmap -- --check` current. This closes the public tracking row only.
