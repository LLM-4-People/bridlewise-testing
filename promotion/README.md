# Promotion profiles

One file per promotion this repository declares: `<name>.json`, a source
branch carried to a target branch (`harness promote`, `npm run promote`).
The folder is the configured `promotion.profileDirectory`; it never ships
(every profile excludes it). A profile is always read from the SOURCE commit
being promoted, so a change to it takes effect when it is committed on the
source, and every promotion commit names the exact profile blob it used.

## What a profile declares

- `schema` — `bridlewise-promotion-profile/v2` (v2 added `boundary.overlay`: an engine that reads v1 refuses a v2 profile by its version, never by an unknown key).
- `name` — the file's basename.
- `source.ref`, `target.ref` — full branch refs; `remote` — where both are
  published (`null`: local only); `trigger` — `manual`, or
  `on-source-publish` once automatic promotion is switched on.
- `boundary` — what ships:
  - `entryPoints`: the modules the shipped program is reached through. Every
    module they reach through imports, `require`s, `new URL` workers,
    `import.meta.glob` globs, stylesheet `@import`s, symbolic links and the
    declared `spawnCalls` ships. What no literal names (a computed `import()`,
    a glob that matches nothing) is advised as `opaque_edge`.
  - `include`: files (or folder prefixes ending in `/`) that ship without an
    import edge (configuration, assets, documents). An included MODULE is
    walked like an entry point: its imports are judged and ship too.
  - `exclude`: what never ships and is never walked; a shipped module that
    imports an excluded path is refused.
  - `companions`: basenames (e.g. `README.md`) that ship when their folder, or
    a sub-folder, holds a shipped path.
  - `spawnCalls`: calls whose string argument names a script the program runs
    as a subprocess (`{callee, argument, base}`; `base` is `""` or a folder
    prefix ending in `/`).
  - `overlay`: a folder prefix (or `null`) holding the target-only files:
    each file under it ships at its path without the prefix
    (`product-only/README.md` is the product's `README.md`). The folder must
    be excluded. An overlay file is a target-only document or recipe, never a
    module (the import walk judges code only where it lives); the excludes
    hold at its shipped path; and it may not name a path the projection
    already carries (`promotion_overlay_invalid`): a path ships for one
    reason. Write its links as absolute URLs, since they are read at the
    target path.
  Everything else does NOT ship (deny by default).
- `transforms` — files derived for the target (never also excluded): a
  `package-manifest` keeps the listed `scripts` (each must exist on the source;
  segments that run a dropped script or name a path that does not ship are
  pruned) and the devDependencies the shipped files use; a `lockfile`
  re-resolves the source lockfile against it with a registry command.
- `phases` — the registry commands a promotion runs in its candidate
  (`setup`, then `converge` repeated until a pass changes nothing — what it
  changes must be generated outputs —, then `verify`, which must change
  nothing), named from `workspaceIsolation.commands`. After them, ONE `git
  commit` in the candidate: the repository's own hooks certify the exact tree.
- `safety.maxDeletedFraction` — the share of the target a promotion may
  delete before it refuses (a boundary typo).

## Changing the boundary

Edit the profile on the source branch. `npm run promote -- explain <path>`
says why a path ships or not (the import chain, the include, the companion
rule, the exclusion); `npm run promote -- plan --diff` shows what the target
would become. The source-side guard (`tests/prevention/promotion-boundary.test.ts`)
runs the same projection over the working tree at every change: an import
into an excluded path, a dangling import, a missing entry point, an
undeclared package or an invalid profile is red there first.

## Promoting

`npm run promote -- apply` builds the plan's commit in a candidate worktree
beside the repository, pins it (`refs/bridlewise/promotion/<name>/pending`,
its receipt under `…/receipts/<commit>`), pushes it with its receipt in ONE
atomic push (never forced) and fast-forwards the checkout that holds the
target; `--no-publish` stops after the pin, `--no-push` publishes locally.
The target's direct edits are overwritten only with `--accept-target-edits
<the plan's exact list> --reason <text>`, a deletion past the budget only
with `--allow-deletions --reason <text>`; both are recorded in the receipt
(and the edits in the commit's `Promotion-Accepted-Target-Edits` trailer). A
rerun is the resume. Run from a checkout that is not clean at the source, it
re-executes the source's own committed promoter in the folder `<name>-home`
of the repository's promotion folder beside it (one run at a time; its setup
redone until it passes). A busy machine's failure answers exit 4 (errored:
run it again later), never a defect of the source. `rollback`, `hold` and
`release-hold`, and the trigger this file's `trigger` switches on, are in
`CONTRIBUTING.md`.

## What each refusal means

`engine/src/workflow/promotion/codes.ts` holds every code with its class, exit
code and the one remedy; the guide is `CONTRIBUTING.md`.

## Adding a pair

Add `<name>.json` here with its own source and target; nothing else changes.
