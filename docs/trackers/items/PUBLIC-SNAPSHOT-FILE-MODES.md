---
schema: bridlewise-tracker-item/v1
id: PUBLIC-SNAPSHOT-FILE-MODES
type: Task
state: closed
resolution: completed
lane: floor
opened: 2026-10-20
closed: 2026-10-20
---

closed 2026-10-20. Reproduced 1 red of 5 (the guard named `scripts/verification/corpus.ts 600` and `test/verification/corpus-manifest.test.ts 600`); `git ls-files -s` records both as `100644`, so the expected working-tree mode is `0644` (Git records only the executable bit; the tree's dominant disk mode is `0664`). Repaired with `chmod 0644`; the focused guard is 5/5 (`node --experimental-strip-types --test test/prevention/git-freshness.test.ts`). The copy that produced them is the public-snapshot import outside this checkout: no in-repo writer or generator creates either tracked file, and `src/filesystem/atomic-write.ts` already carries an existing target's mode across its rename (a NEW file deliberately takes 0600). A fresh clone materializes 0644 and this guard refuses a recurrence. The chmod itself is not representable in a Git commit because Git stores only `100644` versus `100755`. Not a flaky suspect.
