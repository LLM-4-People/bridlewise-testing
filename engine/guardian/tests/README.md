# Guardian tests

The Landlock guardian's self-tests. These build the guardian and a payload,
then assert the sandbox actually enforces.

## What each file does

- `run-tests.sh` — builds the guardian and `test_payload`, then asserts
  Landlock enforcement through the CLI contract. Fail-closed: any unexpected
  result fails the run, and a test that did not run (a skip) fails it too —
  a skipped security suite certifies nothing.
- `require-pass-log.sh` — reads the runner's log in CI and requires a positive
  `PASS n/n`, `SKIP 0` and `ALL TESTS PASS`, so the workflow refuses a run that
  skipped even if the runner's exit status were ever softened again.
- `test_payload.c` — the probe binary the guardian execs: it attempts the
  reads and writes the test asserts on, so a broken sandbox is visible as a
  wrong answer, not a crash.

## Where it lives and what consumes it

The folder lives at `engine/guardian/tests/`. The `Makefile` in the parent
folder builds the binaries and runs `run-tests.sh`; nothing imports these
files as modules.
