# filesystem

The `engine/test/filesystem/` folder of the development surface.

## What each file does

- `path-identity.test.ts` — the one path-identity owner: resolution (links, `..`, missing tails), ancestry by identity and whole names, places created or re-created after they were measured, the one bigint identity spelling.
- `sqlite-wal.test.ts` — the WAL journal owner, deterministically: a BUSY switch (plain or extended code) waits through BEGIN IMMEDIATE/ROLLBACK and asks again; another failure or a BUSY past the deadline is thrown as it is; and no source but the owner spells the WAL switch.
- `journaled-commit.test.ts` — the journaled multi-file commit, driven: exact modes and no residue, a failing verify rolls back (a created file removed), a SIGKILL at every phase is recovered, a concurrent edit is never rolled over, unknown bytes refuse recovery.
- `file-lock.test.ts` — the one file lock: a forced two-breaker interleaving of one dead holder ends with one holder, a live holder is never broken however old, an unreadable lock is honoured then broken, a dead breaker's `.break` is cleared, every break and timeout is audited; the guard that no other module names or hand-breaks a lock file.
- `temporary-root.test.ts` — the temp root's headroom is measured (bytes and inodes as shares) and a low share of either warns.

## The subfolders

- `self-protection/`

## Where it lives and what consumes it

The folder lives at `engine/test/filesystem/`.
