#!/usr/bin/env bash
# require-pass-log.sh — refuse a guardian run that did not really pass.
#
# `make test` already exits non-zero when run-tests.sh skips or fails (the
# runner's summary refuses a skip). This is the CI-side second lock: it reads
# the run's own log and requires a POSITIVE pass count, a zero skip count and
# the ALL TESTS PASS marker, so a future editor that lets the summary return 0
# again still cannot certify the "Test guardian" step.

set -uo pipefail

log="${1:-}"
if [[ -z "$log" || ! -r "$log" ]]; then
  echo "guardian pass check: no readable log at ${log:-<missing>}" >&2
  exit 1
fi

refuse() {
  echo "guardian pass check: $*" >&2
  exit 1
}

# The skip count is judged first: it is the defect this check exists for, and
# it must be named even when the log also lacks the pass marker.
grep -qx 'SKIP 0' "$log" || refuse "the runner reported a non-zero (or no) skip count"
if grep -qE '^FAIL [0-9]+$' "$log"; then
  refuse "the runner reported failures"
fi
grep -qx 'ALL TESTS PASS' "$log" || refuse "the runner did not report ALL TESTS PASS"

line="$(grep -E '^PASS [0-9]+/[0-9]+$' "$log" | tail -n 1)"
[[ -n "$line" ]] || refuse "the runner reported no PASS n/total line"
counts="${line#PASS }"
passed="${counts%%/*}"
total="${counts##*/}"
[[ "$passed" =~ ^[0-9]+$ && "$total" =~ ^[0-9]+$ ]] || refuse "the PASS line is malformed: $line"
(( passed > 0 )) || refuse "the runner passed no tests"
(( passed == total )) || refuse "the runner passed $passed of $total — a partial run is not a pass"

echo "guardian pass check: $line with SKIP 0"
