# External-surface audit — third parties and build tooling

Date: 2026-10-20. Base: `4f958ef1` (`public/testing`). Work branch: `agent/external-surface`.

The measurement contract's jurisdiction is the whole app. This audit covers the
outside things the public floor depends on — GitHub Actions, the runner class,
the Node runtime, npm trees and their lockfiles, devcontainer/build images, and
the Jekyll/Pages path — and records how each is pinned or measured.

- Declarations: [tests/prevention/external-surface-registry.json](../../tests/prevention/external-surface-registry.json)
- Mechanical guard: [tests/prevention/external-surface-registry.test.ts](../../tests/prevention/external-surface-registry.test.ts)
- Guard command: `npx vitest run tests/prevention/external-surface-registry.test.ts`

The registry names the whole universe (eleven workflows and thirteen build
files) and one entry per outside thing. The guard refuses an external action
that is not a full 40-hex commit with a version comment, a tag-only image or
devcontainer feature, any floating `latest` version reference, a Node engine
range that disagrees across manifests, a missing lockfile or package without an
integrity hash, a non-`ci` install, and any workflow, build file, action,
runner, image, lockfile or package that the registry does not declare. A new
workflow file is itself a failure, not an unguarded corner.

## Violations found and fixed

| Location | Defect | Fix |
| --- | --- | --- |
| `.github/workflows/test-shards.yml:156`, `:225`, `:231` | `actions/download-artifact@v4` was tag-pinned: no commit SHA and no version comment. | Resolved `v4` with `git ls-remote` at audit time to commit `d3f86a106a0bac45b974a628896c90dbdf5c8093` (`v4.3.0`); all three uses now carry the full SHA and `# v4.3.0`. Bumped on 2026-10-20 to `v8.0.2` (`9000827ccba6bdab643e8b6fd33ac0654aef8333`) because a CI annotation showed `v4.3.0` targets Node 20 and GitHub was FORCING it onto Node 24 — a runtime we did not pin, which is the third-party assumption this registry exists to remove. |
| `.devcontainer/devcontainer.json:7` | The `common-utils` devcontainer feature was tag-pinned to the floating major tag `:2`, not a digest. | Resolved the `:2` manifest to `sha256:e76a6a8a35d1ad824daad1540725e0ec9f8ed2dc00d2850e990a9830013c7d08` (feature release 2.7.1); the reference is now `ghcr.io/devcontainers/features/common-utils@sha256:…`. |

Both were live on the base commit. The guard was run before the fixes and
failed on exactly these two surfaces (plus their follow-on pin and call-site
findings). The first run also exposed a guard bug, not a tree defect:
`npm --prefix engine ci` was not recognised as a `ci`-style install; the
matcher was corrected in the guard. The guard passed after the two tree fixes.

## Clean audit

- **Actions.** Thirteen external action identities and two local reusable
  workflows are declared. Every external `uses:` in the enumerated workflows is
  a full 40-hex commit with a version comment; every call site is declared in
  the registry's `usedIn`.
- **Runner.** Only `ubuntu-24.04` appears, in ten workflows. The shard workflow
  defaults its `runner` input to it, and `ci.yml` passes it explicitly. The label
  is provider-managed; the merge receipt records the class it ran on.
- **Node.** `.node-version` and `.nvmrc` are both `24.20.0`; six workflows pin
  `node-version: 24.20.0`; both floor manifests declare
  `>=24.18.0 <25.0.0`; the three verification-only benchmark manifests declare
  the exact `24.18.0`, which lies inside the floor range. No other tracked
  package manifest declares an engine.
- **Dependency trees.** Five trees are declared: the two floor trees (`web`,
  `engine`), two benchmark trees, and one frozen superseded benchmark record.
  All five lockfiles exist at `lockfileVersion` 3; every non-link package in
  every lockfile carries an integrity hash. The floor install path uses only
  `npm ci`; there is no `npm install`, `yarn` or `pnpm` install in the
  workflows, Makefiles or devcontainer.
- **Images.** The devcontainer base image is digest-pinned, and the
  `common-utils` feature is now digest-pinned. There is no other `FROM`,
  `image:` or `container:` reference in the universe.
- **Floating `latest`.** None. `?filter=latest` at
  `.github/workflows/reusable-workflow-failure.yml:71` is a GitHub API query
  selector, not a version tag; the guard's patterns correctly do not treat it
  as a floating reference.
- **Pages/Jekyll.** `actions/jekyll-build-pages` is SHA-pinned like the other
  Pages actions. The assembler passes the resolved product commit to Jekyll as
  `build_revision`. `scripts/floor/site.mjs` adds no `plugins:`, `gems:` or
  `remote_theme:` key, so a floating gem cannot enter through this tree.

## Known unpinned surfaces (declared, owner named, not changed here)

| Location | Surface | Why it is not digest/exact-pinned | Owner |
| --- | --- | --- | --- |
| `.github/workflows/pages.yml:42` | Product docs ref defaults to `main`. | The site mirrors the product documentation, so the ref follows `main` by design; the resolved commit is recorded as the Jekyll build revision. It is a content input, never a code-execution input. Declared in `knownExceptions`. | Pages workflow |
| `.github/workflows/ci.yml:78`, `.github/workflows/test-shards.yml:138` | `gcc-14` installed from the runner's Ubuntu archive. | An exact apt version string is runner-image-specific and would drift with the provider's archive; the runner label plus the declared package name is the reproducible pin available to this tree. The compiler itself is declared once in `engine/guardian/Makefile`; both workflows install it and invoke that owner without a `CC=` literal. Declared in `knownExceptions`. | Guardian build owner (`engine/guardian/Makefile`) |
| `.devcontainer/Dockerfile:6` | `build-essential` installed from the base image's archive. | Same reason; the digest-pinned base image plus the package name is the pin. Declared in `knownExceptions`. | Devcontainer |

## Absolute-number findings (measurement contract)

These are signals currently judged by a constant duration, size or count rather
than through the measurement contract. They are **recorded, not changed**: the
numbers belong to the workflow/CI owner and to the measurement-contract work in
progress. This audit does not edit `engine/src/shared/run-cpu.ts`,
`engine/src/shared/budget-verdict.ts` or the metric-registry files.

| Location | Signal judged by an absolute number | Note |
| --- | --- | --- |
| `.github/workflows/ci.yml:21` | `timeout-minutes: 35` kills the gate job on a fixed duration. | No ambient-load declaration; a slow shared runner is judged the same as a hung build. |
| `.github/workflows/codeql.yml:29` | `timeout-minutes: 30`. | Same shape. |
| `.github/workflows/dependency-review.yml:19` | `timeout-minutes: 10`. | Same shape. |
| `.github/workflows/docs-links.yml:21` | `timeout-minutes: 5`. | Same shape. |
| `.github/workflows/pages.yml:26` | `timeout-minutes: 20`. | Same shape. |
| `.github/workflows/pages.yml:93` | `timeout-minutes: 10`. | Same shape. |
| `.github/workflows/promotion-gate.yml:42` | `timeout-minutes: 30`. | Same shape. |
| `.github/workflows/reusable-workflow-failure.yml:15` | `timeout-minutes: 10`. | Same shape. |
| `.github/workflows/scorecard.yml:18` | `timeout-minutes: 15`. | Same shape. |
| `.github/workflows/secret-scan.yml:20` | `timeout-minutes: 5`. | Same shape. |
| `.github/workflows/test-shards.yml:45`, `:112`, `:211` | `timeout-minutes: 15`, `45`, `10`. | The shard jobs receive the absolute kill; the receipt records `testPhaseMs`, but the gate still fails on the fixed wall. |
| `tests/test-budget.ts:42` | `TEST_TIMEOUT_MS = 30_000` ends a test on a fixed duration. | The comment says it ends a hang rather than policing slowness, but a loaded machine can trip a fixed number; owner: measurement-contract work. |
| `tests/test-budget.ts:56`, `:58` | `NESTED_RUNNER_LAUNCH_MS = 60_000` and `NESTED_RUNNER_TEST_MARGIN_MS = 15_000`. | Measured against one host's load samples; not derived from the current run. Owner: measurement-contract work. |
| `engine/bridlewise.config.json:755-757` | Web-suite watchdog: stall `300000` ms, hard ceiling `1800000` ms, grace `3000` ms. | The stall is output-based, but the hard ceiling is an absolute duration. Owner: measurement-contract work. |
| `engine/bridlewise.config.json:760-762` | Engine-suite watchdog: the same three absolute values. | Same shape. |
| `engine/bridlewise.config.json:790` | Kill grace `3000` ms. | A fixed process-cleanup bound, not a measured signal; recorded for completeness. |

Quoted historical baselines (records, not live gates, but they are constants a
consumer can re-derive a factor from):

| Location | Constant | Note |
| --- | --- | --- |
| `docs/testing.md:154` | `244017` ms single-host run; `83438 / 244017 = 2.92x`. | The receipt's `testPhaseMs` is dynamic; the denominator is one historical run. The page says this is a comparison, not a gate. |
| `docs/floor/evidence.md:205` | `244017` ms single-host run; `2.81x`. | Same historical comparison at `d47909de`. |
| `docs/floor/roadmap.md:85` | `244.0s` single-host run. | Same constant carried into the roadmap row. |

Reviewed and not recorded as findings: `shards: "10"` (a configured plan size;
the receipt records the actual population), `retention-days: 5` (artifact
retention, not a verdict), `--limit 100` (an API page bound),
`fail-on-severity: high` (an ordinal policy, not a duration/size/count), and
the caller-supplied `wait_seconds` input (a wait, not a measurement).

## Other findings

- **The guardian's compiler is one declaration, in the build owner (fixed 2026-10-20; anchor superseded 2026-10-21).**
  `.github/workflows/ci.yml` ran `make -C engine/guardian all` with the runner's
  default `cc`, while `test-shards.yml` ran `CC=gcc-14 make -C engine/guardian all`.
  `engine/guardian/Makefile` now declares `CC := gcc-14`, both jobs install that
  package and invoke the Makefile without a `CC=` literal, and
  `engine/guardian/build.ts` carries no compiler search list.
  `tests/prevention/guardian-compiler-pin.test.ts` refuses a workflow that spells
  `CC=` or installs another package. The binary was initially bound by its sha256,
  measured locally at `28ee831d1359c87d339f3689...`; that anchor was not
  reproducible — the CI runner's gcc sealed `2e9e4ead...` for the same sources and
  every CI run refused confinement. It is now bound by a reproducible build stamp
  over the sealed sources and declared flags (`guardian/build-stamp.spec`), and
  both jobs record `--stamp` beside the diagnostic file digest in the job summary.
  Capturing either value into the qualification receipt itself (rather than the
  summary) is still open.
- **The Jekyll config and plugin set are product-owned.** The Pages workflow
  copies `_config.yml` from the product docs checkout at run time; this repo
  cannot see the product's plugin set. The guard's reachable half is the
  assembler prohibition above. If the product adds a plugin, the public floor
  cannot mechanically verify its pin. This is the honest boundary of the
  public tree, not a clean bill for the product's Jekyll gems.
- **The devcontainer feature digest was resolved from the registry but no
  devcontainer build was run in this task.** The reference syntax
  (`feature@sha256:…`) is the devcontainer/OCI pinning form; a reviewer should
  run the devcontainer build (or the Codespaces path) once before treating the
  image path as exercised.
- **Private floor services.** `private:gitea` and `private:act_runner` are
  recorded only as pinned and verified in the private floor. No private version,
  hostname or token appears in this repository.

## Verification actually run

| Command | Result |
| --- | --- |
| `npx vitest run tests/prevention/external-surface-registry.test.ts` before the fixes | Failed on `action-pin` (all three `download-artifact@v4` uses) and `image-digest` (the `common-utils:2` feature). |
| `npx vitest run tests/prevention/external-surface-registry.test.ts` after the fixes | 11/11 tests pass. |
| Planted on the real tree: tag-pinned action, digest-less image, floating `latest`, drifted Node range, undeclared workflow | Each made the guard exit non-zero with the matching rule; the clean tree then passed 11/11. |
| `npx tsc --noEmit --checkers 1 -p tsconfig.tests.json` | Exit 0. |
| `npm run test:public` | Passed (see the commit message for the count). |
| `npm run docs:links` | Clean. |
| `npm run check:secrets` | Clean. |

No full-suite run was performed for this change, and no full-suite claim is
made. The new guard file was measured on its own; the shard manifest carries
that weight and records it as pending the next full re-measurement.
