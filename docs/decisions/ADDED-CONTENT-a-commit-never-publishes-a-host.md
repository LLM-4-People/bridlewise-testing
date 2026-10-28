---
id: ADDED-CONTENT
date: 2026-10-28
by: coordinator
group: process
status: in-force
implementation: partial
route: GH-537
acted_in: [engine/scripts/verification/added-content.ts, engine/scripts/commit-guard.ts, .github/workflows/commit-records.yml, engine/src/kernel/root-policy.ts]
---
# A commit never publishes a host

A lane once replaced a test file with a 2.5 MB `vitest list --json` listing
full of absolute host paths, and the user's home directory and account name
reached a public commit. Neither the hooks nor CI refused it.

- **No added line names a host's home.** That covers `/home/<name>/`,
  `/Users/<name>/` and `C:\Users\<name>\` (either slash). At the local hook it
  also covers the running user's own home directory and account name, wherever
  they appear.
- **No text blob exceeds the declared bound** (1 MiB). Raw output belongs in
  the evidence store.
- **No `.ts` file stops being TypeScript.** A declaration file is read as one.
- **No refusal echoes what it found.** It names the file, the line and the
  kind of finding, because it is printed into a public log.
- **The exemptions are declared and reviewed, synthetic only,** in
  `ROOT_POLICY.verification.addedContent`:
  - the placeholder account names fixtures and docs use;
  - the vendored text that is larger than the bound by nature;
  - the `.ts` files that are not whole TypeScript by nature (excerpts of an
    upstream source, and a fixture that exists to be a syntax error).

  A test's scratch repository inside the temp root may name its own temp paths
  and the harness that drives it. It is never published. The project, a
  workspace and a candidate get no such reading.
- **One judge** (`engine/scripts/verification/added-content.ts`) is asked in
  three places:
  - the `commit-msg` door;
  - the `Commit records` check (`--range`), which knows no local identity;
  - `--tree`, the retroactive run. Main's tree passed it when the rule arrived.

**What is not yet guaranteed.** `Commit records` counts only once GH-1's
trunk-ruleset declaration (#537) is applied. Until then, the local hook and an
advisory check stand between a host and a public commit.
