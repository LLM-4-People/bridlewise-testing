# Agent briefing

This repository is the public development floor for Bridlewise, not the
product. It carries the full test floor, the prevention guards, the design
record, and the verification machinery. The product is projected from this
tree into the separate product repository.

## Read first

- [Agent process](docs/process/AGENTS.md)
- [Workflow](docs/process/WORKFLOW.md)
- [Roles](docs/process/ROLES.md)
- [Tier 1 agent contract](docs/process/TIER1-AGENT-CONTRACT.md)
- [Engine agent notes](engine/AGENTS.md)
- [Contributing](CONTRIBUTING.md)
- [Test map](docs/testing.md)
- [Build roadmap](docs/floor/roadmap.md)
- [How to help](docs/floor/help.md)

## Working rules

- Treat this as a developer preview. Never claim production readiness, and
  never use a real or sensitive corpus in a test.
- Read the process documents before changing a guard, a tracker, or a release
  record. A public snapshot is not a second owner of a private fact.
- Keep the testing site's contributor hub separate from the product
  documentation mirror. The product site and the product README are not
  generated from this README.
- Do not publish the raw corpus, private trackers, credentials, or evidence
  that is not already public. Use the public evidence page and the documented
  corpus boundary.
- Run the focused suite for the area you changed. A full-suite claim needs a
  fresh run; do not infer it from a subset.
- Commit only after the focused checks pass, with one cohesive change and the
  verification you actually ran.
- After every push, watch the CI run to completion (`gh run list`/`gh run view`)
  and fix any failure it reports before doing anything else. A green local run
  is not a green pull request: the sharded gate, the docs guards and the secret
  scan can fail on a tree that passed locally, and an unwatched red is an
  unfinished change. The workflow is grouped on the ref with
  `cancel-in-progress: true`, so a second push or a re-run cancels the run in
  flight: watch a run rather than trigger beside it. When you do supersede a
  run on purpose, cancel the older one by hand — while the newer run is still
  `pending` it does not displace the in-progress one, and both sit in the same
  group looking stuck.

## Commands

Install both dependency trees before running the floor:

```bash
npm ci
npm --prefix engine ci
```

The public smoke suite is `npm run test:public`. The full floor uses the
harness and is described in [Test map](docs/testing.md). The site is assembled by the Pages
workflow; do not commit generated site output.
