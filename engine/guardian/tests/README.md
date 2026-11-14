# Guardian tests

The Landlock guardian's self-tests assert that the sandbox actually enforces.
Follow the shared [preparation and temporary-root contract](../README.md#preparing-and-running-tests)
before running them; artifact preparation and readonly execution are separate.

## What each file does

- `run-tests.sh` — requires current prebuilt artifacts through the Makefile's
  freshness preflight and uses the caller-admitted `TMPDIR` for specs and data;
  it asserts Landlock enforcement through the CLI contract. Fail-closed: any unexpected
  result fails the run, and a test that did not run (a skip) fails it too —
  a skipped security suite certifies nothing.
- `require-pass-log.sh` — reads the runner's log in CI and requires a positive
  `PASS n/n`, `SKIP 0` and `ALL TESTS PASS`, so the workflow refuses a run that
  skipped even if the runner's exit status were ever softened again.
- `test_payload.c` — the probe binary the guardian execs: it attempts the
  reads, writes, socket creation and owned IPC the tests assert on. The same
  source is compiled dynamically and statically by the Makefile, so the static
  executable-read test needs no second fixture implementation.

## Where it lives and what consumes it

The folder lives at `engine/guardian/tests/`. The `Makefile` in the parent
folder owns `test-fixtures` preparation, `test-preflight` freshness/path
projection and the `test` entry that invokes `run-tests.sh`. No compiler runs
inside the shell runner, and nothing imports these files as modules.
