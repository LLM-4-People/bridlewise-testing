---
schema: bridlewise-tracker-item/v1
published: false
id: PUBLIC-SNAPSHOT-BUNDLE-STALE
type: Task
state: closed
resolution: completed
lane: floor
opened: 2026-10-20
closed: 2026-10-20
---

closed 2026-10-20 at `c0f637e7`. Reproduced 1 red of 5: `npm --prefix engine run build:bundle` measured `68adb4f4d2633972c64b0ed1e7ae4cff7fb9eac026d0950b175a31b0e86789ab` (5,996,223 bytes; the row's `ab8f23b4...` was the `f518c9f6` source) while `ROOT_POLICY` still pinned `c2d96102...`. The rebuild alone cannot move the pin: `scripts/build-bundle.ts` publishes the sealed bytes, and the pin owner is the `root-policy-self-protection-bundle-sha256` hash binding written by `harness regenerate`. Ran the documented owner one-shot from `engine/`: `node src/cli.ts harness sync --with-bundle` — status `pass`, steps `register`, `regenerate`, `bundle-build`, `regenerate`, `check` all pass; convergence took 2 passes and rewrote only `engine/src/kernel/root-policy.ts` (`bundleSha256` `c2d96102...` → `68adb4f4...`). The focused guard is 5/5 after. No hand edit: the `dist/bundle.js` artifact stays gitignored and generated. The stale writer is the `src/` changes after the `c2d96102...` build (the last is `c0f637e7`, the backup/restore flow) landing without a bundle rebuild; the guard and the one-shot remedy already refuse that. The later item-4 source change re-ran the same one-shot and moved the pin to `f7138261...`; `test/prevention/bundle-staleness.test.ts` is 5/5 at the final head too. Not a flaky suspect.
