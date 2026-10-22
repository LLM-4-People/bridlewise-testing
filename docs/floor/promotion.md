---
layout: default
page_class: floor
title: "Promotion contract"
description: "How a change moves from the Bridlewise development floor to the product repository: the projection boundary, deterministic gates, manual decisions, and release step."
permalink: /floor/promotion/
---

# Promotion contract

This is the contract between the two repositories. `bridlewise-testing` holds the source, tests, and evidence. `bridlewise` receives the projection. A change reaches the product branch through that projection, not a merge. The source tree is `testing`. The target tree is built from a declared profile. The same profile and the same gate run for every promotion, and a refusal stops publication.

<div class="callout-warning" role="note">
<p>This contract governs a developer preview. It does not make the preview production-ready, audited, or safe for sensitive code. The product branch is still pre-admission.</p>
</div>

## The rule

The product branch is not edited directly and is not merged into. A source commit is checked on the floor, then carried through the promotion door. The rule is recorded as [UR-12]({{ '/decisions/UR-12-master-changes-only-through-the-promotion-door/' | relative_url }}) in the decision set.

The profile is [`promotion/testing-to-master.json`](../../promotion/testing-to-master.json). It declares:

| Field | Value in the current profile | Meaning |
|---|---|---|
| `source.ref` | `refs/heads/testing` | The commit being carried |
| `target.ref` | `refs/heads/master` | The branch that receives the projection |
| `remote` | `origin` | Where both refs are published |
| `trigger` | `on-source-publish` | The profile may start after the source ref moves |
| `safety.maxDeletedFraction` | `0.1` | The largest share of the target a projection may delete before it refuses |

The profile is read from the source commit, not from the target or the working tree. A change to the profile takes effect when it is committed on the source. Every promotion commit names the profile and its exact blob.

The public snapshots publish `main`, not the `testing` and `master` pair. The profile describes the maintainer topology. A fresh public clone does not carry the source ref, so `npm run promote -- status` refuses with `promotion_source_missing`. That is a typed refusal, not a failed test.

## The projection

The target tree is computed from the source. It is not a merge result and it is not a copy of the whole source tree.

- `entryPoints` are the modules the shipped program is reached through.
- Every module an entry point reaches through imports, `require`, workers, globs, stylesheet imports, symbolic links, and declared spawn calls ships.
- `include` names files or folder prefixes that ship without an import edge. Included modules are walked like entry points.
- `exclude` names paths that never ship and are never walked.
- `companions` ship when their folder or a subfolder holds a shipped path.
- Everything else is denied by default.

The current profile excludes `tests/`, `bench/`, `docs/`, and `promotion/`, plus internal design and evidence folders. A shipped module that imports an excluded path is refused. The documentation site is built separately; `docs/` does not travel through this promotion profile.

The projection refuses a missing entry point, a dangling import, an import into an excluded path, an undeclared package dependency, or a submodule it cannot project. A computed import or a glob that matches nothing is reported as an opaque edge, not guessed.

## The deterministic gate

The gate covers these stages. A refusal at any stage stops publication. An up-to-date or unchanged answer is `ok`, not a failure.

| Order | Stage | What it checks | A refusal means |
|---|---|---|---|
| 1 | Profile | Strict `bridlewise-promotion-profile/v1` schema; no path both included and excluded; valid spawn bases; declared commands exist | The profile is invalid. Fix it on the source. |
| 2 | Boundary | Reachability from entry points and included modules; exclusions; package declarations; gitlinks | The source would ship a broken or undeclared module. Fix the source or the boundary. |
| 3 | Derived files | Kept package scripts; pruned script segments; lockfiles re-resolved against the projected manifests | A manifest or lockfile transform cannot represent the source. Fix the source manifest. |
| 4 | Plan safety | Target edits since the last promotion; the deletion budget; the never-rule; an up-to-date or unchanged projection | The target has edits the source does not reproduce, the projection deletes too much, or the source was merged with the target. Fix the source or use a reasoned override. |
| 5 | Setup | `web-deps`, `engine-deps`, `guardian`, `bundle` in the candidate | A setup command failed on the projected tree. Read its output and fix the source. |
| 6 | Converge | `harness-sync --with-bundle`, repeated until a pass changes nothing | A generator does not reach a fixed point, or a command writes an undeclared path. Fix the generator. |
| 7 | Verify | `web-typecheck`, `engine-typecheck`, `engine-check --skip-typecheck`, `web-build` | A gate failed on the exact tree, or a gate changed the tree it judges. Nothing is committed. |
| 8 | Commit | The repository's own hooks certify the exact tree; one commit with the target and source as parents; a receipt names every command | The commit door refused what the earlier gates missed. Fix the source and add the missing check. |
| 9 | Publish | One atomic push of the commit and its receipt; target checkout fast-forward | The push or landing refused. The commit may stay pinned for a resume. Never force. |

The candidate is kept on a failed gate so the output can be read. An integrity refusal means stop and preserve the evidence. It is not an invitation to retry until the state looks different.

## What is automated

A reference-transaction hook watches the source ref. When the profile's trigger is `on-source-publish` and the source ref moves, the hook starts an unattended promotion in the background. The hook does not trigger on the promoter's own fetch or push.

The unattended run performs the projection, the gate, the commit, the atomic push, and the target checkout fast-forward. It takes no overrides. A locked or held state, or a target checkout with overlapping edits, is reported as a not-now answer; the next run resumes from the refs. A published commit is never rebuilt.

Automatic promotion pauses after a rollback. It stays paused until a person releases the hold with a reason.

The source repository's continuous integration is separate from promotion. It runs the typechecks, the secret scan, the public smoke suite, the cockpit and engine builds, and the guardian build and tests. It does not run the full corpus-backed suite, the live provider suite, or E2E on every push.

### The public release gate

The product release workflow calls a reusable floor gate pinned by commit. The gate runs the public floor suite, checks the product CI, CodeQL, docs links, and secret scan at the tag commit, and reads the product code scanning and Dependabot queues. It writes `promotion-receipt.json`. A missing, pending, failed, or unknown required check blocks the release. The status snapshot on this site is not that gate.

## What requires a person

- **The first promotion.** It was reviewed before it was applied. The record is [PROMO-FIRST]({{ '/decisions/PROMO-FIRST-the-first-promotion-reviewed/' | relative_url }}) in the decision set.
- **Overrides.** Accepting target edits, allowing a deletion past the budget, or releasing a hold requires the exact paths or a reason. The override is recorded in the receipt and, for accepted edits, in the commit trailers.
- **Source refusals.** A boundary error, a missing script, or a target edit is fixed on the source. Rerunning the promoter does not repair it.
- **Rollback and hold.** A rollback is a new commit that restores a prior promotion, not a history rewrite. It sets a hold. Releasing the hold is a person's decision with a reason.
- **The full suites.** The 4.1 GB corpus, the performance report, the live provider suite, and the browser E2E suite have prerequisites that are not published. They are manual or scheduled work, not a per-push gate.
- **The release.** A maintainer tags the product repository. The product release workflow repeats the build gate and publishes the release assets and checksums. The release is still a preview and is not a production endorsement. The [shipping page]({{ '/shipping/' | relative_url }}) lists the assets and the rollback path.
- **Security review.** No third-party audit, penetration test, or certification exists.

## From a test to a release

1. **Reproduce.** Make the failure visible on the floor. If the bug is real, the reproduction fails before the fix.
2. **Fix the owner.** Change the module that owns the behavior. Do not add a retry, fallback, or special case that hides the failure.
3. **Add prevention.** Add a test or guard that protects the class of failure, not only the example. A guard states its class, plant, driven behavior, and liveness check.
4. **Run the focused checks.** Run the test file, then the domain suite, then the typechecks and secret scan that cover the change. Run the full suite when its prerequisites exist.
5. **Commit on `testing`.** Push the source commit. The source CI runs; the reference hook may start a promotion.
6. **Project and gate.** The promoter reads the profile from the source commit, computes the candidate, and runs setup, converge, and verify. A refusal publishes nothing.
7. **Commit and publish.** One promotion commit records the profile blob, the source commit, the receipt, and any accepted target edits. One atomic push publishes the commit and receipt. The target checkout fast-forwards.
8. **Release.** A maintainer tags the product repository. The release workflow builds the published assets and checksums. The notes repeat the preview warning.

The test result does not travel with the commit. The promotion gate rechecks the projected tree with its declared build and harness gates. It does not rerun the full test suite. A green source run is not a voucher for a candidate that was never built.

### Failure reports

A reusable reporter watches the public workflows in both repositories. A failure opens one issue per workflow and branch or pull request, with the run link and the failed job names. Repeated failures comment on the same open issue. A later success for the same scope closes it. The reporter does not copy logs, secrets, or private paths into the issue.

## Refusal classes

| Class | Meaning | What happens |
|---|---|---|
| `ok` | Nothing to do, or done | A plan, a publication, or an up-to-date answer |
| `input` | Bad usage, missing profile, or invalid profile | Nothing is written; fix the request or profile |
| `precondition` | A boundary error, target edit, deletion budget, or divergence | Nothing is published; fix the source or use a reasoned override |
| `failed` | A real defect on the exact candidate tree | The candidate is kept; fix the source |
| `errored` | The environment failed, such as a busy or offline machine | The change is not blamed; a pinned commit can resume |
| `integrity` | A state that must not happen | Stop and preserve the evidence; do not publish |
| `parked` | The remote has the commit, but the target checkout has overlapping edits | The next run or a fast-forward lands it |

The full catalogue and the one remedy for each code live in the [promotion source](../../engine/src/workflow/promotion). Read the code and the remedy in the refusal instead of guessing from the exit status.

## What this contract does not prove

- The gate covers the projection and the declared build checks. It does not run every test, every provider, or every browser path.
- A successful promotion means the target tree matches the computed projection and passed the declared gate. It does not mean the product is correct.
- Automatic promotion is a convenience. It is not a trust boundary and it does not replace review of the source change.
- A release asset with a checksum is not a signed installer, a reproducible build proof, or a security audit.
- A rollback restores a prior tree. It does not erase the cause of the defect.

Use the [evidence commands]({{ '/floor/evidence/' | relative_url }}) to inspect the refusal and the release. Read the [status snapshot]({{ '/floor/status/' | relative_url }}) for the last generated state, with its fallback states.
