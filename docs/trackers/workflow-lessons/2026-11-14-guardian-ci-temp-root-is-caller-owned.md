---
id: L-2026-11-14-guardian-ci-temp-root-is-caller-owned
date: 2026-11-14
source: guardian fixture preparation requires a caller-admitted scratch directory
kind: guard
status: acted
acted_in: [.github/workflows/ci.yml]
---

## Observation

The guardian test command in GitHub Actions did not pass the runner's scratch directory to the native test owner. A reviewed update to its fixture preparation requires the caller to provide TMPDIR instead of selecting an ambient fallback; that native update is a separate milestone.

## Lesson

The workflow that admits a test run supplies its temporary root. Reuse the runner-provided directory, and preserve the native suite's exit status and complete positive pass-log check.

## Change

The existing Test guardian invocation passes RUNNER_TEMP as TMPDIR to make. The same pipefail, log, tee and require-pass-log.sh gate remain in place. This is a CI consumer change; it does not claim a native guardian build or runtime result.
