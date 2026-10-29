---
id: ADDED-CONTENT
date: 2026-10-28
by: coordinator
group: process
status: in-force
implementation: partial
route: GH-537
acted_in: [engine/scripts/verification/added-content.ts, engine/scripts/commit-guard.ts, .github/workflows/commit-records.yml, engine/src/kernel/root-policy.ts, engine/src/privacy/secret-signals.ts, engine/test/support/throwaway-repository.ts]
---
# A commit never publishes a host

A lane once replaced a test file with a 2.5 MB `vitest list --json` listing
full of absolute host paths, and the user's home directory and account name
reached a public commit. Neither the hooks nor CI refused it.

- **No added line names a host's home.** That covers `/home/<name>`,
  `/Users/<name>` and `C:\Users\<name>` (either slash, a `~1` short name),
  with or without a trailing separator. The line is also read in every decoded
  form: percent-encoding (repeatedly), and JSON, JavaScript and backslash
  escapes. A text still changing after 16 decoding rounds is refused. The
  shapes and the documented placeholder names are the one publication-privacy
  catalogue's (`engine/src/privacy/secret-signals.ts`, the secret scan's too).
  Every other privacy row of it (an internal host, …) is refused the same way.
- **At the local hook, the running user's own home and account name** are
  refused wherever they appear, including after an encoded separator (`2F`).
  If the account is exactly (case-sensitively) a placeholder, as on a CI
  runner, only the bare-name check is skipped; the home is still judged.
- **A binary blob is read whole,** byte for byte and once more with its NULs
  dropped (UTF-16 text). A NUL is never a reason not to look.
- **No text blob exceeds the declared bound** (1 MiB). Raw output belongs in
  the evidence store.
- **No `.ts` file stops being TypeScript.** A declaration file is read as one.
- **No refusal echoes what it found.** It names the file, the line and the
  kind of finding, because it is printed into a public log.
- **The exemptions are declared and reviewed** in
  `ROOT_POLICY.verification.addedContent`:
  - the vendored text that is larger than the bound by nature;
  - the `.ts` files that are not whole TypeScript by nature (excerpts of an
    upstream source, and a fixture that exists to be a syntax error).
- **No location exempts anything.** A test's throwaway repository whose hooks
  must name this harness's guard by absolute path, or whose fixture names its
  own root, says so: its fixture helper sets
  `verification.addedContent.throwawayRepositoryKey` in its own `.git/config`
  (`engine/test/support/throwaway-repository.ts`). Only then may it name
  exactly two things of the host: its own root and this harness's guard. The
  marker is judged by identity and refused, typed, wherever the repository is
  not a throwaway one: set in any other scope, an agent's checkout (a
  workspace or a candidate), a project or any worktree of one (it holds the
  harness's own guard), or a repository at or above the running user's home.
- **One judge** (`engine/scripts/verification/added-content.ts`) is asked in
  three places:
  - the `commit-msg` door;
  - the `Commit records` check (`--range`), which knows no local identity;
  - `--tree`, the retroactive run. Main's tree passed it when the rule arrived.

**What is not yet guaranteed.**

- `Commit records` blocks only once GH-1's trunk-ruleset declaration (#537)
  makes it required. Until then, the local hook and an advisory check stand
  between a host and a public commit.
- A path split across string pieces (`"/home/" + name`) has no shape to match,
  so CI's shape match does not see it. The local hook still refuses the
  account name in any piece.
