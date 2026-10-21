# Agent briefing

This repository is the public development floor for Bridlewise, not the
product. It carries the full test floor, the prevention guards, the design
record, and the verification machinery. The product is projected from this
tree into the separate product repository.

## Public boundary and publishing

- Treat this as a developer preview. Never claim production readiness, and
  keep the developer-preview warning explicit in public prose. Never use a
  real or sensitive corpus in a test.
- Do not publish the raw corpus, private trackers, credentials, personal data,
  or evidence that is not already public. Use the [public evidence
  page](docs/floor/evidence.md) and the [documented corpus
  boundary](docs/floor/evidence.md#corpus-boundary).
- A public snapshot is not a second owner of a private fact. Read the process
  documents before changing a guard, a tracker, or a release record.
- Keep the testing site's contributor hub separate from the product
  documentation mirror. The product site and the product README are not
  generated from this README.
- Do not commit generated site output; the Pages workflow assembles the site.

## Rules

Every change is bound by the mandatory engineering rules, the measurement
contract, the evidence bar and the agent operating rules. Their single owner is
[Agent process](docs/process/AGENTS.md); read it before you edit.

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
- [Public evidence](docs/floor/evidence.md)

## Commands

Setup and the fresh-clone gate are owned by
[Contributing](CONTRIBUTING.md#setup); the commit mechanics by
[Commit and pull request style](CONTRIBUTING.md#commit-and-pull-request-style).
The public smoke suite is
`npm run test:public`; the full floor and its prerequisites are described in
the [Test map](docs/testing.md).
