# Changelog

## [Unreleased]

### Added

- First public, sanitized snapshot of the Bridlewise development floor.
- Web unit, prevention, cockpit, performance, and end-to-end suites.
- Engine domain tests, live-test entry points, benchmarks, and guardian tests.
- 135 decision records and a curated design/architecture set.
- Public smoke tests for the CLI launcher, the preflight receipt, the secret scanner, and the docs.
- AGPL-3.0-only licensing and third-party notices.
- CI, CodeQL, dependency review, secret scanning, Dependabot, and OpenSSF Scorecard automation.
- Contributing, security, support, code-of-conduct, and issue/PR templates.

### Security

- Rebuilt from a sanitized tree; the private history, committed credentials, trackers, and evidence are not published.
- Removed the vendored Git source and the unlicensed historical-opencode tree.
- Added explicit ignore rules for environment files, private keys, databases, logs, and local harness state.

### Known limitations

- The full suite needs a 4.1 GB external corpus and a generated performance report; neither is published.
- The harness is pre-admission; `preflight` reports `harnessReady: false`.
- Linux-first; Landlock is Linux-only.
- No hosted demo.
- No production support.
