#!/usr/bin/env bash
# run-tests.sh — assert Landlock enforcement using prepared native artifacts.
# The Makefile owns their build; this runner only checks freshness before use.
# Fail-closed: any unexpected result fails.
#
# Host at author time: kernel 6.6.114 WSL2, Landlock ABI 3. Landlock IS
# available here, so the "landlock_unavailable (exit 3)" path is NOT exercised
# by this script (it requires a kernel without Landlock). Author B covers it
# with a mock in the Node-side tests. All other error codes are exercised.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARDIAN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BIN="$GUARDIAN_DIR/build/harness-landlock-guardian"
TP="$GUARDIAN_DIR/build/test_payload"

PASS=0
FAIL=0
SKIP=0
TOTAL=0
OUT=""
RC=0

# --- accounting helpers (extracted by tests/prevention/guardian-runner-accounting.test.ts) ---
# ONE rule for every outcome: a test that ran and passed is PASS, a test that
# ran and failed is FAIL, and a test that did NOT run is SKIP. A skip never
# counts as a pass, and the summary never prints ALL TESTS PASS while one
# exists; before this rule test 20's "cc -static unavailable" skip incremented
# PASS and the script exited 0 claiming every test passed.
pass() { TOTAL=$((TOTAL+1)); PASS=$((PASS+1)); echo "PASS: $*"; }
fail() { TOTAL=$((TOTAL+1)); FAIL=$((FAIL+1)); echo "FAIL: $*"; }
skip() { TOTAL=$((TOTAL+1)); SKIP=$((SKIP+1)); echo "SKIP: $*"; }
summary() {
  echo "PASS $PASS/$TOTAL"
  # Printed on every path, so a caller can require the zero positively instead
  # of inferring it from the absence of a SKIP line.
  echo "SKIP $SKIP"
  if [[ "$TOTAL" -eq 0 ]]; then
    echo "NO TESTS RAN — a vacuous run certifies nothing"
    return 1
  fi
  if [[ "$TOTAL" -ne $((PASS+FAIL+SKIP)) ]]; then
    echo "INCOMPLETE ACCOUNTING: total $TOTAL != pass $PASS + fail $FAIL + skip $SKIP"
    return 1
  fi
  if [[ "$FAIL" -ne 0 ]]; then
    echo "FAIL $FAIL"
    return 1
  fi
  if [[ "$SKIP" -ne 0 ]]; then
    echo "NOT ALL TESTS PASSED — $SKIP test(s) did not run; a skipped test is not a passed test"
    return 1
  fi
  echo "ALL TESTS PASS"
}
# --- end accounting helpers ---

echo "=== checking prepared native artifacts (make test-preflight) ==="
if ! STATIC_BIN="$(make --no-print-directory -C "$GUARDIAN_DIR" test-preflight)"; then
  echo "FATAL: native artifacts need preparation; run make test-fixtures before readonly execution"
  exit 1
fi
if [[ -z "$STATIC_BIN" || "$STATIC_BIN" == *$'\n'* || "$STATIC_BIN" != /* || ! -f "$STATIC_BIN" || ! -x "$STATIC_BIN" ]]; then
  echo "FATAL: test-preflight did not return one absolute executable fixture file"
  exit 1
fi
[[ -x "$BIN" ]] || { echo "FATAL: binary missing at $BIN"; exit 1; }
[[ -x "$TP" ]]  || { echo "FATAL: test_payload missing at $TP"; exit 1; }

# Root admission belongs to the caller's existing temporary-root/profile owner.
# This standalone runner consumes that private TMPDIR without a fallback.
[[ -n "${TMPDIR:-}" ]] || { echo "FATAL: TMPDIR must name a caller-admitted private temporary directory"; exit 1; }
WORK="$(mktemp -d -- "$TMPDIR/bridlewise-guardian.XXXXXX")" || { echo "FATAL: mktemp failed"; exit 1; }
trap 'rm -rf "$WORK"' EXIT

# The guardian opens every spec path WITHOUT following links (a link in a
# resolved path means it was swapped after it was checked), so a hand-written
# spec names system directories by where they really are: on a merged-/usr
# host /lib, /bin and /sbin are links into /usr.
R_LIB="$(realpath -e /lib)"
R_BIN="$(realpath -e /bin)"
R_SBIN="$(realpath -e /sbin)"

PROTECT="$WORK/protect"
ALLOW="$WORK/allow"
mkdir -p "$PROTECT/sub" "$ALLOW"
echo "protect-content" > "$PROTECT/file.txt"
echo "allow-content"  > "$ALLOW/file.txt"

# Spec: handle all 16 ABI-1..5 flags. effective ABI on this host = 3 (kernel 6.6),
# so IOCTL_DEV is masked out by the guardian at runtime — that is correct
# fail-closed ABI masking behavior and is exercised implicitly here.
# Allow: $ALLOW (read+write+create), $GUARDIAN_DIR/build (exec the test_payload
# binary), and the system paths the dynamic loader + libc need. Do NOT allow
# the workspace parent or /home — so $PROTECT (under $WORK) has no covering
# allow-rule and is therefore protected (deny by omission).
cat > "$WORK/spec.json" <<EOF
{
  "abi_version_hint": 0,
  "handled_access_fs": [
    "EXECUTE","WRITE_FILE","READ_FILE","READ_DIR",
    "REMOVE_DIR","REMOVE_FILE","MAKE_CHAR","MAKE_DIR","MAKE_REG",
    "MAKE_SOCK","MAKE_FIFO","MAKE_BLOCK","MAKE_SYM",
    "REFER","TRUNCATE","IOCTL_DEV"
  ],
  "allow_rules": [
    {"path": "$ALLOW", "access": ["READ_FILE","READ_DIR","WRITE_FILE","MAKE_REG","REMOVE_FILE","TRUNCATE"]},
    {"path": "$GUARDIAN_DIR/build", "access": ["EXECUTE","READ_FILE","READ_DIR"]},
    {"path": "/usr", "access": ["READ_FILE","READ_DIR","EXECUTE"]},
    {"path": "$R_LIB", "access": ["READ_FILE","READ_DIR","EXECUTE"]},
    {"path": "$R_BIN", "access": ["READ_FILE","READ_DIR","EXECUTE"]},
    {"path": "$R_SBIN", "access": ["READ_FILE","READ_DIR","EXECUTE"]},
    {"path": "/etc", "access": ["READ_FILE","READ_DIR"]},
    {"path": "/dev", "access": ["READ_FILE","READ_DIR","WRITE_FILE"]},
    {"path": "/proc", "access": ["READ_FILE","READ_DIR"]}
  ],
  "protected_subtrees": ["$PROTECT"]
}
EOF

# A second spec used by the "spec_invalid (exit 4)" test: an allow_rule path
# that is UNDER a protected_subtree. $PROTECT/sub exists, so the existence
# check passes, but the guardian's descendant check must reject it.
cat > "$WORK/spec-invalid.json" <<EOF
{
  "abi_version_hint": 0,
  "handled_access_fs": ["READ_FILE","READ_DIR"],
  "allow_rules": [
    {"path": "$PROTECT/sub", "access": ["READ_FILE"]}
  ],
  "protected_subtrees": ["$PROTECT"]
}
EOF

# run_cap: run a command, capture combined stdout+stderr in $OUT, exit in $RC.
run_cap() {
  OUT="$("$@" 2>&1)"
  RC=$?
}

assert_contains() {
  local name="$1" expected="$2"
  if grep -qF -- "$expected" <<<"$OUT"; then
    pass "$name"
  else
    fail "$name"
    echo "  expected substring: $expected"
    echo "  actual: $OUT (exit=$RC)"
  fi
}

assert_exit() {
  local name="$1" expected="$2"
  if [[ "$RC" == "$expected" ]]; then
    pass "$name (exit=$RC)"
  else
    fail "$name (expected exit $expected, got $RC)"
    echo "  output: $OUT"
  fi
}

# Helper that runs guardian -> test_payload <args...>
gtp() {
  "$BIN" apply --spec "$WORK/spec.json" --exec "$TP" "$@"
}

echo "=== test 1: read protected -> EACCES ==="
run_cap gtp read "$PROTECT/file.txt" || true
assert_contains "read protected -> EACCES" "EACCES" "$OUT"

echo "=== test 2: write protected -> EACCES ==="
run_cap gtp write "$PROTECT/newfile" || true
assert_contains "write protected -> EACCES" "EACCES" "$OUT"

echo "=== test 3: create in protected -> EACCES ==="
run_cap gtp create "$PROTECT/newfile2" || true
assert_contains "create protected -> EACCES" "EACCES" "$OUT"

echo "=== test 4: list protected -> EACCES ==="
run_cap gtp list "$PROTECT" || true
assert_contains "list protected -> EACCES" "EACCES" "$OUT"

echo "=== test 5: read allowed -> OK ==="
run_cap gtp read "$ALLOW/file.txt" || true
assert_contains "read allowed -> OK" "OK" "$OUT"

echo "=== test 6: write allowed -> OK ==="
run_cap gtp write "$ALLOW/newfile" || true
assert_contains "write allowed -> OK" "OK" "$OUT"

echo "=== test 7: create in allowed -> OK ==="
run_cap gtp create "$ALLOW/newfile2" || true
assert_contains "create allowed -> OK" "OK" "$OUT"

echo "=== test 8: bad spec path -> exit 2 (spec_parse_error) ==="
run_cap "$BIN" apply --spec "$WORK/nonexistent.json" --exec "$TP" read "$ALLOW/file.txt" || true
assert_exit "bad spec path -> exit 2" "2" "$RC"

echo "=== test 9: spec invalid (allow_rule under protected_subtree) -> exit 4 ==="
run_cap "$BIN" apply --spec "$WORK/spec-invalid.json" --exec "$TP" read "$PROTECT/sub" || true
assert_exit "spec_invalid -> exit 4" "4" "$RC"

echo "=== test 10: usage (no args) -> exit 64 ==="
run_cap "$BIN" || true
assert_exit "usage no args -> exit 64" "64" "$RC"

echo "=== test 11: no forgeable 'already confined' sentinel reaches the payload ==="
run_cap "$BIN" apply --spec "$WORK/spec.json" --exec "env" || true
if grep -q "HARNESS_LANDLOCK_GUARDIAN" <<<"$OUT"; then
  fail "the guardian set HARNESS_LANDLOCK_GUARDIAN (a sandbox decision must be measured, never read from env)"
else
  pass "no sentinel env var set"
fi

echo "=== test 12: exec /bin/cat on protected file -> EACCES (real binary) ==="
# /bin/cat opens the file for read; Landlock denies READ_FILE on $PROTECT.
run_cap "$BIN" apply --spec "$WORK/spec.json" --exec "cat" "$PROTECT/file.txt" || true
# cat prints a "Permission denied" or "Operation not permitted" message to
# stderr and exits non-zero. Either wording indicates Landlock blocked it.
if [[ "$RC" -ne 0 ]] && (grep -qiE "permission denied|operation not permitted|EACCES" <<<"$OUT"); then
  pass "exec cat on protected -> blocked (exit=$RC, out=$OUT)"
else
  fail "exec cat on protected (expected blocked, exit!=0)"
  echo "  exit=$RC out=$OUT"
fi

echo "=== SKIP (exit 3, landlock_unavailable): NOT testable here ==="
echo "Landlock IS available on this host (kernel $(uname -r), ABI probed at runtime)."
echo "Author B covers the exit-3 path with a mock in the Node-side tests."

# ---- File-targeted allow-rule tests (esbuild-bundle enabler) ----------
# These use a SEPARATE spec (spec-file.json) that does NOT allow $ALLOW as a
# directory; it allow-lists individual FILES only. This proves file-targeted
# rules cover exactly one inode and do not leak to siblings.
echo "single-content"  > "$ALLOW/single.txt"
echo "secret-content"  > "$ALLOW/secret.txt"
printf 'w'             > "$ALLOW/single-w.txt"   # pre-exists for the write-OK test

# Spec for tests 13-15: single.txt (READ_FILE only), single-w.txt (READ+WRITE).
# system paths needed for the dynamically-linked test_payload to exec.
cat > "$WORK/spec-file.json" <<EOF
{
  "abi_version_hint": 0,
  "handled_access_fs": ["READ_FILE","WRITE_FILE","EXECUTE","READ_DIR","TRUNCATE","MAKE_REG"],
  "allow_rules": [
    {"path": "$ALLOW/single.txt",   "access": ["READ_FILE"]},
    {"path": "$ALLOW/single-w.txt", "access": ["READ_FILE","WRITE_FILE","TRUNCATE"]},
    {"path": "$GUARDIAN_DIR/build",  "access": ["EXECUTE","READ_FILE","READ_DIR"]},
    {"path": "/usr", "access": ["EXECUTE","READ_FILE","READ_DIR"]},
    {"path": "$R_LIB", "access": ["EXECUTE","READ_FILE","READ_DIR"]},
    {"path": "/etc", "access": ["READ_FILE"]},
    {"path": "/dev", "access": ["READ_FILE","WRITE_FILE","READ_DIR"]},
    {"path": "/proc","access": ["READ_FILE","READ_DIR"]}
  ],
  "protected_subtrees": []
}
EOF

# Helper: run guardian with the file-rule spec.
gtp_file() { "$BIN" apply --spec "$WORK/spec-file.json" --exec "$TP" "$@"; }

echo "=== test 13: file rule covers ONLY single.txt; sibling secret.txt denied ==="
run_cap gtp_file read "$ALLOW/single.txt" || true
assert_contains "read single.txt (file rule) -> OK" "OK" "$OUT"
run_cap gtp_file read "$ALLOW/secret.txt" || true
assert_contains "read secret.txt (sibling, not allow-listed) -> EACCES" "EACCES" "$OUT"

echo "=== test 14: file rule with READ_FILE only; write -> EACCES (write not in allowed_access) ==="
run_cap gtp_file write "$ALLOW/single.txt" || true
assert_contains "write single.txt (READ_FILE-only rule) -> EACCES" "EACCES" "$OUT"

echo "=== test 15: file rule with READ_FILE+WRITE_FILE; write -> OK ==="
run_cap gtp_file write "$ALLOW/single-w.txt" || true
assert_contains "write single-w.txt (READ+WRITE rule) -> OK" "OK" "$OUT"

echo "=== test 16 (hostile): file-targeted rule with READ_DIR in access -> exit 4 ==="
cat > "$WORK/spec-bad-filedir.json" <<EOF
{
  "abi_version_hint": 0,
  "handled_access_fs": ["READ_FILE","READ_DIR"],
  "allow_rules": [{"path": "$ALLOW/single.txt", "access": ["READ_FILE","READ_DIR"]}],
  "protected_subtrees": []
}
EOF
run_cap "$BIN" apply --spec "$WORK/spec-bad-filedir.json" --exec "$TP" read "$ALLOW/single.txt" || true
assert_exit "file rule with READ_DIR -> exit 4" "4" "$RC"

echo "=== test 17 (hostile): file-targeted rule with MAKE_REG in access -> exit 4 ==="
cat > "$WORK/spec-bad-filemake.json" <<EOF
{
  "abi_version_hint": 0,
  "handled_access_fs": ["READ_FILE","MAKE_REG"],
  "allow_rules": [{"path": "$ALLOW/single.txt", "access": ["READ_FILE","MAKE_REG"]}],
  "protected_subtrees": []
}
EOF
run_cap "$BIN" apply --spec "$WORK/spec-bad-filemake.json" --exec "$TP" read "$ALLOW/single.txt" || true
assert_exit "file rule with MAKE_REG -> exit 4" "4" "$RC"

echo "=== test 17b: keep_out — a rule under a present entry -> exit 4; an entry gone since the compile is skipped ==="
mkdir -p "$ALLOW/store"
: > "$ALLOW/store/web.db"
cat > "$WORK/spec-keepout-present.json" <<EOF
{
  "abi_version_hint": 0,
  "handled_access_fs": ["READ_FILE","READ_DIR"],
  "allow_rules": [{"path": "$ALLOW/store", "access": ["READ_FILE","READ_DIR"]}],
  "protected_subtrees": [],
  "keep_out": ["$ALLOW/store/web.db"],
  "keep_out_retries": 3
}
EOF
run_cap "$BIN" apply --spec "$WORK/spec-keepout-present.json" --exec "$TP" read "$ALLOW/store/web.db" || true
assert_exit "rule containing a present keep_out entry -> exit 4" "4" "$RC"
assert_contains "names the keep_out entry" "contains protected_subtree '$ALLOW/store/web.db'" "$OUT"
cat > "$WORK/spec-keepout-gone.json" <<EOF
{
  "abi_version_hint": 0,
  "handled_access_fs": ["READ_FILE","READ_DIR","EXECUTE"],
  "allow_rules": [
    {"path": "$ALLOW/single.txt", "access": ["READ_FILE"]},
    {"path": "$GUARDIAN_DIR/build", "access": ["EXECUTE","READ_FILE","READ_DIR"]},
    {"path": "/usr", "access": ["READ_FILE","READ_DIR","EXECUTE"]},
    {"path": "$R_LIB", "access": ["READ_FILE","READ_DIR","EXECUTE"]}
  ],
  "protected_subtrees": [],
  "keep_out": ["$ALLOW/store/deleted-since-compile.db"],
  "keep_out_retries": 3
}
EOF
run_cap "$BIN" apply --spec "$WORK/spec-keepout-gone.json" --exec "$TP" read "$ALLOW/single.txt" || true
assert_exit "a keep_out entry gone since the compile does not refuse the spec" "0" "$RC"
rm -rf "$ALLOW/store"

echo "=== test 18: esbuild-bundle scenario (node reads bundle, bundle read of src/ -> EACCES) ==="
# Layout mirrors the real plan: dist/bundle.js (allow-listed single file), src/cli.ts
# (protected by omission — no allow rule covers it). The bundle does
# fs.readFileSync(process.argv[2]) on src/cli.ts; expect EACCES.
ESBUILD="$WORK/esbuild"
mkdir -p "$ESBUILD/dist" "$ESBUILD/src"
cat > "$ESBUILD/dist/bundle.js" <<'BUNDLE'
const fs = require('fs');
const target = process.argv[2];
try {
  const data = fs.readFileSync(target, 'utf8');
  console.log('BUNDLE_READ_OK:', data.trim());
} catch (e) {
  console.log('BUNDLE_READ_DENIED:', e.code || e.message);
}
BUNDLE
printf 'console.log("SECRET SRC CLI")\n' > "$ESBUILD/src/cli.ts"

NODE="$(command -v node 2>/dev/null || true)"
if [[ -z "$NODE" ]]; then
  skip "test 18 (node not on PATH; cannot run the esbuild-bundle scenario here)"
else
  NODE_DIR="$(dirname "$NODE")"
  # Node's install dir parent (nvm/.../vX.Y.Z) for its modules/snapshot; resolve
  # the real node binary in case `node` is a symlink.
  NODE_REAL="$(readlink -f "$NODE")"
  NODE_REAL_DIR="$(dirname "$NODE_REAL")"
  NODE_REAL_PARENT="$(dirname "$NODE_REAL_DIR")"
  cat > "$WORK/spec-esbuild.json" <<EOF
{
  "abi_version_hint": 0,
  "handled_access_fs": ["READ_FILE","WRITE_FILE","EXECUTE","READ_DIR","TRUNCATE","MAKE_REG"],
  "allow_rules": [
    {"path": "$ESBUILD/dist/bundle.js", "access": ["READ_FILE"]},
    {"path": "$NODE_REAL_DIR",          "access": ["EXECUTE","READ_FILE","READ_DIR"]},
    {"path": "$NODE_REAL_PARENT",       "access": ["EXECUTE","READ_FILE","READ_DIR"]},
    {"path": "/usr", "access": ["EXECUTE","READ_FILE","READ_DIR"]},
    {"path": "$R_LIB", "access": ["EXECUTE","READ_FILE","READ_DIR"]},
    {"path": "/etc", "access": ["READ_FILE"]},
    {"path": "/dev", "access": ["READ_FILE","WRITE_FILE","READ_DIR"]},
    {"path": "/proc","access": ["READ_FILE","READ_DIR"]}
  ],
  "protected_subtrees": ["$ESBUILD/src"]
}
EOF
  run_cap "$BIN" apply --spec "$WORK/spec-esbuild.json" --exec "$NODE_REAL" "$ESBUILD/dist/bundle.js" "$ESBUILD/src/cli.ts" || true
  if grep -qF "BUNDLE_READ_DENIED: EACCES" <<<"$OUT"; then
    pass "esbuild-bundle: node read src/cli.ts -> EACCES (secret NOT leaked)"
  else
    fail "esbuild-bundle (expected BUNDLE_READ_DENIED: EACCES)"
    echo "  exit=$RC out=$OUT"
  fi
fi

# ---- Refinement 2: default-deny outside allow-set + EXECUTE-vs-READ research
# See RESEARCH-EXECUTE-VS-READ.md for the full primary-source analysis.
# Key finding: EXECUTE-only does NOT work for ANY binary type (static, dynamic,
# script) because the kernel's do_open_execat opens with O_RDONLY|__FMODE_EXEC,
# and Landlock maps FMODE_READ->READ_FILE + __FMODE_EXEC->EXECUTE (both required).

echo "=== test 19: default-deny — file OUTSIDE allow-set -> EACCES ==="
# Spec: allow ONLY $ALLOW (read+write) + system paths for the test_payload to exec.
# /var/lib is NOT in any allow-rule. test_payload reads /var/lib/dpkg/status -> EACCES.
SYSFILE="/var/lib/dpkg/status"
if [[ ! -r "$SYSFILE" ]]; then
  # fallback: a file outside the allow-set that exists on this host
  SYSFILE=""
  for cand in /var/lib/dpkg/status /etc/hostname /boot/config-$(uname -r); do
    if [[ -r "$cand" ]]; then SYSFILE="$cand"; break; fi
  done
fi
if [[ -z "$SYSFILE" ]]; then
  skip "test 19 (no readable system file found outside the allow-set on this host)"
else
  cat > "$WORK/spec-dd.json" <<EOF
{
  "abi_version_hint": 0,
  "default_deny_outside_allow_rules": true,
  "handled_access_fs": ["READ_FILE","WRITE_FILE","EXECUTE","READ_DIR","TRUNCATE","MAKE_REG"],
  "allow_rules": [
    {"path": "$ALLOW", "access": ["READ_FILE","WRITE_FILE","READ_DIR","MAKE_REG","TRUNCATE"]},
    {"path": "$GUARDIAN_DIR/build", "access": ["EXECUTE","READ_FILE","READ_DIR"]},
    {"path": "/usr", "access": ["EXECUTE","READ_FILE","READ_DIR"]},
    {"path": "$R_LIB", "access": ["EXECUTE","READ_FILE","READ_DIR"]},
    {"path": "$R_BIN", "access": ["EXECUTE","READ_FILE","READ_DIR"]},
    {"path": "/etc", "access": ["READ_FILE"]},
    {"path": "/dev", "access": ["READ_FILE","WRITE_FILE","READ_DIR"]},
    {"path": "/proc","access": ["READ_FILE","READ_DIR"]}
  ],
  "protected_subtrees": ["$PROTECT"]
}
EOF
  # NOTE: $SYSFILE is under /var or /etc/hostname. /etc IS allowed (for ld.so),
  # so use /var/lib/dpkg/status (under /var, NOT allowed) to prove default-deny.
  if [[ "$SYSFILE" == /var/* ]]; then
    run_cap "$BIN" apply --spec "$WORK/spec-dd.json" --exec "$TP" read "$SYSFILE" || true
    assert_contains "default-deny: read $SYSFILE (outside allow-set) -> EACCES" "EACCES" "$OUT"
  else
    skip "test 19 (need a /var/* file to prove default-deny; got $SYSFILE)"
  fi
fi

echo "=== test 20: static binary — EXECUTE-only -> EACCES; EXECUTE+READ -> OK ==="
# The Makefile prepared this static-linked variant of the existing test payload.
# Even static binaries need READ_FILE (the kernel opens with O_RDONLY).
# 20a: EXECUTE-only on the static binary -> expect EACCES before its roundtrip.
cat > "$WORK/spec-static-exec-only.json" <<EOF
{"abi_version_hint":0,"handled_access_fs":["EXECUTE","READ_FILE"],"allow_rules":[{"path":"$STATIC_BIN","access":["EXECUTE"]}],"protected_subtrees":[]}
EOF
run_cap "$BIN" apply --spec "$WORK/spec-static-exec-only.json" --exec "$STATIC_BIN" socketpair unix || true
if [[ "$RC" -ne 0 ]] && grep -qiE "permission denied|EACCES" <<<"$OUT"; then
  pass "static binary EXECUTE-only -> EACCES (research-confirmed: kernel needs READ_FILE)"
else
  fail "static EXECUTE-only (expected EACCES, got exit=$RC out=$OUT)"
fi
# 20b: EXECUTE+READ -> the same owned socketpair roundtrip returns exactly OK.
cat > "$WORK/spec-static-er.json" <<EOF
{"abi_version_hint":0,"handled_access_fs":["EXECUTE","READ_FILE"],"allow_rules":[{"path":"$STATIC_BIN","access":["EXECUTE","READ_FILE"]}],"protected_subtrees":[]}
EOF
run_cap "$BIN" apply --spec "$WORK/spec-static-er.json" --exec "$STATIC_BIN" socketpair unix || true
assert_exit "static binary EXECUTE+READ exits 0" "0" "$RC"
if [[ "$OUT" == "OK" ]]; then pass "static binary EXECUTE+READ: owned socketpair roundtrip -> OK"; else fail "static EXECUTE+READ: roundtrip failed (out=$OUT)"; fi

echo "=== test 21: dynamic binary (/bin/cat) — EXECUTE-only -> EACCES; EXECUTE+READ + libs -> OK ==="
# 21a: EXECUTE-only on /bin/cat -> expect EACCES
cat > "$WORK/spec-cat-exec-only.json" <<EOF
{"abi_version_hint":0,"handled_access_fs":["EXECUTE","READ_FILE","READ_DIR"],"allow_rules":[{"path":"$R_BIN/cat","access":["EXECUTE"]}],"protected_subtrees":[]}
EOF
run_cap "$BIN" apply --spec "$WORK/spec-cat-exec-only.json" --exec "/bin/cat" "/dev/null" || true
if [[ "$RC" -ne 0 ]] && grep -qiE "permission denied|EACCES" <<<"$OUT"; then
  pass "/bin/cat EXECUTE-only -> EACCES (dynamic linker needs READ_FILE)"
else
  fail "/bin/cat EXECUTE-only (expected EACCES, got exit=$RC out=$OUT)"
fi
# 21b: EXECUTE+READ on /bin/cat + /usr /lib EXECUTE+READ + /etc /dev READ -> expect OK (exit 0)
cat > "$WORK/spec-cat-er.json" <<EOF
{"abi_version_hint":0,"handled_access_fs":["EXECUTE","READ_FILE","READ_DIR","WRITE_FILE"],"allow_rules":[{"path":"$R_BIN/cat","access":["EXECUTE","READ_FILE"]},{"path":"/usr","access":["EXECUTE","READ_FILE","READ_DIR"]},{"path":"$R_LIB","access":["EXECUTE","READ_FILE","READ_DIR"]},{"path":"/etc","access":["READ_FILE"]},{"path":"/dev","access":["READ_FILE","WRITE_FILE","READ_DIR"]}],"protected_subtrees":[]}
EOF
run_cap "$BIN" apply --spec "$WORK/spec-cat-er.json" --exec "/bin/cat" "/dev/null" || true
if [[ "$RC" -eq 0 ]]; then
  pass "/bin/cat EXECUTE+READ + libs -> OK (exit 0)"
else
  fail "/bin/cat EXECUTE+READ (expected exit 0, got $RC: $OUT)"
fi

echo "=== test 22: node-bundle default-deny — bundle readFileSync('/var/lib/dpkg/status') -> EACCES ==="
NODE_BIN="$(command -v node 2>/dev/null || true)"
if [[ -z "$NODE_BIN" ]]; then
  skip "test 22 (node not on PATH; cannot run the node-bundle default-deny scenario)"
else
  NODE_REAL="$(readlink -f "$NODE_BIN")"
  NODE_DIR="$(dirname "$NODE_REAL")"; NODE_PARENT="$(dirname "$NODE_DIR")"
  ESBUILD2="$WORK/esbuild2"; mkdir -p "$ESBUILD2/dist"
  cat > "$ESBUILD2/dist/bundle.js" <<'BUNDLE'
const fs = require('fs');
const target = process.argv[2];
try { const d = fs.readFileSync(target, 'utf8'); console.log('BUNDLE_READ_OK:', d.slice(0,30)); }
catch (e) { console.log('BUNDLE_READ_DENIED:', e.code || e.message); }
BUNDLE
  TARGET="/var/lib/dpkg/status"
  [[ -e "$TARGET" ]] || TARGET="/var/log/alternatives.log"
  [[ -e "$TARGET" ]] || TARGET="/var/cache/ldconfig/aux-cache"
  cat > "$WORK/spec-node-dd.json" <<EOF
{
  "abi_version_hint": 0,
  "default_deny_outside_allow_rules": true,
  "handled_access_fs": ["READ_FILE","WRITE_FILE","EXECUTE","READ_DIR","TRUNCATE","MAKE_REG"],
  "allow_rules": [
    {"path": "$ESBUILD2/dist/bundle.js", "access": ["READ_FILE"]},
    {"path": "$NODE_REAL", "access": ["EXECUTE","READ_FILE"]},
    {"path": "$NODE_DIR", "access": ["EXECUTE","READ_FILE","READ_DIR"]},
    {"path": "$NODE_PARENT", "access": ["EXECUTE","READ_FILE","READ_DIR"]},
    {"path": "/usr", "access": ["EXECUTE","READ_FILE","READ_DIR"]},
    {"path": "$R_LIB", "access": ["EXECUTE","READ_FILE","READ_DIR"]},
    {"path": "/etc", "access": ["READ_FILE"]},
    {"path": "/dev", "access": ["READ_FILE","WRITE_FILE","READ_DIR"]},
    {"path": "/proc","access": ["READ_FILE","READ_DIR"]}
  ],
  "protected_subtrees": []
}
EOF
  run_cap "$BIN" apply --spec "$WORK/spec-node-dd.json" --exec "$NODE_REAL" "$ESBUILD2/dist/bundle.js" "$TARGET" || true
  if grep -qF "BUNDLE_READ_DENIED: EACCES" <<<"$OUT"; then
     pass "node-bundle default-deny: readFileSync('$TARGET') -> EACCES (outside allow-set)"
  else
    fail "node-bundle default-deny (expected BUNDLE_READ_DENIED: EACCES)"
    echo "  exit=$RC out=$OUT"
  fi
fi

# ---- temp_dir convenience (refinement 2: shared/exposed configurable) ----
# temp_dir is syntactic sugar for an allow-rule. The binary remains path-agnostic.
# See DESIGN.md "temp_dir convenience".

# Helper: run guardian with a temp_dir spec. $1 = spec file; rest = test_payload args.
gtp_td() { "$BIN" apply --spec "$1" --exec "$TP" "${@:2}"; }

echo "=== test 26: temp_dir convenience — write in temp_dir -> OK ==="
TD26="$WORK/td26"; mkdir -p "$TD26"
cat > "$WORK/spec-td26.json" <<EOF
{
  "abi_version_hint": 0,
  "handled_access_fs": ["READ_FILE","READ_DIR","WRITE_FILE","EXECUTE","TRUNCATE","MAKE_REG","MAKE_DIR","MAKE_SYM","REMOVE_FILE","REMOVE_DIR"],
  "allow_rules": [
    {"path": "$GUARDIAN_DIR/build", "access": ["EXECUTE","READ_FILE","READ_DIR"]},
    {"path": "/usr", "access": ["EXECUTE","READ_FILE","READ_DIR"]},
    {"path": "$R_LIB", "access": ["EXECUTE","READ_FILE","READ_DIR"]},
    {"path": "/etc", "access": ["READ_FILE"]},
    {"path": "/dev", "access": ["READ_FILE","WRITE_FILE","READ_DIR"]},
    {"path": "/proc","access": ["READ_FILE","READ_DIR"]}
  ],
  "protected_subtrees": ["$PROTECT"],
  "temp_dir": "$TD26"
}
EOF
run_cap gtp_td "$WORK/spec-td26.json" write "$TD26/newfile" || true
assert_contains "temp_dir write -> OK" "OK" "$OUT"

echo "=== test 27: temp_dir default access — read+write+create+remove -> all OK ==="
TD27="$WORK/td27"; mkdir -p "$TD27"; echo content > "$TD27/existing"
cat > "$WORK/spec-td27.json" <<EOF
{
  "abi_version_hint": 0,
  "handled_access_fs": ["READ_FILE","READ_DIR","WRITE_FILE","EXECUTE","TRUNCATE","MAKE_REG","MAKE_DIR","MAKE_SYM","REMOVE_FILE","REMOVE_DIR"],
  "allow_rules": [
    {"path": "$GUARDIAN_DIR/build", "access": ["EXECUTE","READ_FILE","READ_DIR"]},
    {"path": "/usr", "access": ["EXECUTE","READ_FILE","READ_DIR"]},
    {"path": "$R_LIB", "access": ["EXECUTE","READ_FILE","READ_DIR"]},
    {"path": "/etc", "access": ["READ_FILE"]},
    {"path": "/dev", "access": ["READ_FILE","WRITE_FILE","READ_DIR"]},
    {"path": "/proc","access": ["READ_FILE","READ_DIR"]}
  ],
  "protected_subtrees": [],
  "temp_dir": "$TD27"
}
EOF
run_cap gtp_td "$WORK/spec-td27.json" read "$TD27/existing" || true
assert_contains "temp_dir default read -> OK" "OK" "$OUT"
run_cap gtp_td "$WORK/spec-td27.json" create "$TD27/newfile" || true
assert_contains "temp_dir default create -> OK" "OK" "$OUT"
run_cap gtp_td "$WORK/spec-td27.json" write "$TD27/newfile2" || true
assert_contains "temp_dir default write -> OK" "OK" "$OUT"

echo "=== test 28: temp_dir custom access (READ only) — write -> EACCES ==="
TD28="$WORK/td28"; mkdir -p "$TD28"; echo content > "$TD28/f"
cat > "$WORK/spec-td28.json" <<EOF
{
  "abi_version_hint": 0,
  "handled_access_fs": ["READ_FILE","READ_DIR","WRITE_FILE","EXECUTE","TRUNCATE","MAKE_REG"],
  "allow_rules": [
    {"path": "$GUARDIAN_DIR/build", "access": ["EXECUTE","READ_FILE","READ_DIR"]},
    {"path": "/usr", "access": ["EXECUTE","READ_FILE","READ_DIR"]},
    {"path": "$R_LIB", "access": ["EXECUTE","READ_FILE","READ_DIR"]},
    {"path": "/etc", "access": ["READ_FILE"]},
    {"path": "/dev", "access": ["READ_FILE","WRITE_FILE","READ_DIR"]},
    {"path": "/proc","access": ["READ_FILE","READ_DIR"]}
  ],
  "protected_subtrees": [],
  "temp_dir": "$TD28",
  "temp_dir_access": ["READ_FILE","READ_DIR"]
}
EOF
run_cap gtp_td "$WORK/spec-td28.json" read "$TD28/f" || true
assert_contains "temp_dir custom read -> OK" "OK" "$OUT"
run_cap gtp_td "$WORK/spec-td28.json" write "$TD28/newfile" || true
assert_contains "temp_dir custom write -> EACCES" "EACCES" "$OUT"

echo "=== test 29 (hostile): temp_dir under protected_subtree -> exit 4 ==="
TD29="$WORK/td29"; mkdir -p "$TD29"
cat > "$WORK/spec-td29.json" <<EOF
{"abi_version_hint":0,"handled_access_fs":["READ_FILE","READ_DIR"],"allow_rules":[],"protected_subtrees":["$WORK"],"temp_dir":"$TD29"}
EOF
run_cap "$BIN" apply --spec "$WORK/spec-td29.json" --exec /bin/true || true
assert_exit "temp_dir under protected_subtree -> exit 4" "4" "$RC"

echo "=== test 30 (hostile): temp_dir duplicates allow_rules -> exit 4 ==="
TD30="$WORK/td30"; mkdir -p "$TD30"
cat > "$WORK/spec-td30.json" <<EOF
{"abi_version_hint":0,"handled_access_fs":["READ_FILE","READ_DIR"],"allow_rules":[{"path":"$TD30","access":["READ_FILE","READ_DIR"]}],"protected_subtrees":[],"temp_dir":"$TD30"}
EOF
run_cap "$BIN" apply --spec "$WORK/spec-td30.json" --exec /bin/true || true
assert_exit "temp_dir duplicates allow_rules -> exit 4" "4" "$RC"

echo "=== test 31 (hostile): temp_dir relative path -> exit 4 ==="
cat > "$WORK/spec-td31.json" <<EOF
{"abi_version_hint":0,"handled_access_fs":["READ_FILE","READ_DIR"],"allow_rules":[],"protected_subtrees":[],"temp_dir":"relative/path"}
EOF
run_cap "$BIN" apply --spec "$WORK/spec-td31.json" --exec /bin/true || true
assert_exit "temp_dir relative path -> exit 4" "4" "$RC"

echo "=== test 32 (hostile): temp_dir does not exist -> exit 4 ==="
cat > "$WORK/spec-td32.json" <<EOF
{"abi_version_hint":0,"handled_access_fs":["READ_FILE","READ_DIR"],"allow_rules":[],"protected_subtrees":[],"temp_dir":"$WORK/nonexistent-td"}
EOF
run_cap "$BIN" apply --spec "$WORK/spec-td32.json" --exec /bin/true || true
assert_exit "temp_dir does not exist -> exit 4" "4" "$RC"

echo "=== test 33 (hostile): temp_dir is a file (not a directory) -> exit 4 ==="
echo "not a dir" > "$WORK/notdir-td"
cat > "$WORK/spec-td33.json" <<EOF
{"abi_version_hint":0,"handled_access_fs":["READ_FILE","READ_DIR"],"allow_rules":[],"protected_subtrees":[],"temp_dir":"$WORK/notdir-td"}
EOF
run_cap "$BIN" apply --spec "$WORK/spec-td33.json" --exec /bin/true || true
assert_exit "temp_dir is a file -> exit 4" "4" "$RC"

echo "=== test 34 (hostile): a rule path that goes through a symbolic link -> exit 4 ==="
ln -s "$ALLOW" "$WORK/allow-link"
cat > "$WORK/spec-link.json" <<EOF
{"abi_version_hint":0,"handled_access_fs":["READ_FILE","READ_DIR"],"allow_rules":[{"path":"$WORK/allow-link","access":["READ_FILE","READ_DIR"]}],"protected_subtrees":[]}
EOF
run_cap "$BIN" apply --spec "$WORK/spec-link.json" --exec /bin/true || true
assert_exit "a linked rule path is refused (opened without following links) -> exit 4" "4" "$RC"

# A bind mount is a second spelling no realpath() removes; the guardian
# compares (device, inode). Made for real in a private mount namespace.
# The capability under test is a BIND MOUNT, not merely a namespace: a
# restricted user namespace can be created while mount inside it is denied
# (the CI runner), and a probe that only ran `true` then declared tests
# available that could not run. Each form is probed with the real operation,
# and only the form that mounts is used. A passwordless sudo on a host with
# restricted unprivileged namespaces gets a mount namespace as root, which is
# the strongest form available there.
mount_probe() {
  "$@" sh -c 'mkdir -p "$2" && mount --bind "$1" "$2"' sh "$PROTECT" "$WORK/alias-probe" >/dev/null 2>&1
}
UNSHARE=""
if mount_probe unshare -rm; then
  UNSHARE="unshare -rm"
elif mount_probe sudo -n unshare -m; then
  UNSHARE="sudo -n unshare -m"
fi
echo "=== test 37: network refused — IPv4, true IPv6 and Unix socket creation -> EACCES ==="
sed '1a "network": "refused",' "$WORK/spec.json" > "$WORK/spec-net.json"
for SOCKET_FAMILY in inet inet6 unix; do
  run_cap "$BIN" apply --spec "$WORK/spec-net.json" --exec "$TP" socket "$SOCKET_FAMILY" || true
  assert_exit "network refused: $SOCKET_FAMILY socket exits 1" "1" "$RC"
  assert_contains "network refused: $SOCKET_FAMILY socket -> EACCES" "EACCES:" "$OUT"
done

echo "=== test 38: network not governed — actual IPv4, IPv6, Unix and Netlink domains (the controls) ==="
run_cap "$BIN" apply --spec "$WORK/spec.json" --exec "$TP" socket inet || true
assert_exit "network not governed: IPv4 socket exits 0" "0" "$RC"
if [[ "$OUT" == "OK:AF_INET" ]]; then pass "network not governed: actual AF_INET"; else fail "network not governed: expected actual AF_INET (out=$OUT)"; fi
run_cap "$BIN" apply --spec "$WORK/spec.json" --exec "$TP" socket inet6 || true
assert_exit "network not governed: IPv6 socket exits 0" "0" "$RC"
if [[ "$OUT" == "OK:AF_INET6" ]]; then pass "network not governed: actual AF_INET6"; else fail "network not governed: expected actual AF_INET6 (out=$OUT)"; fi
run_cap "$BIN" apply --spec "$WORK/spec.json" --exec "$TP" socket unix || true
assert_exit "network not governed: Unix socket exits 0" "0" "$RC"
if [[ "$OUT" == "OK:AF_UNIX" ]]; then pass "network not governed: actual AF_UNIX"; else fail "network not governed: expected actual AF_UNIX (out=$OUT)"; fi
# Netlink is an unaddressed SOCK_RAW/protocol-0 creation control only.
run_cap "$BIN" apply --spec "$WORK/spec.json" --exec "$TP" socket netlink || true
assert_exit "network not governed: Netlink socket exits 0" "0" "$RC"
if [[ "$OUT" == "OK:AF_NETLINK" ]]; then pass "network not governed: actual AF_NETLINK"; else fail "network not governed: expected actual AF_NETLINK (out=$OUT)"; fi
run_cap "$BIN" apply --spec "$WORK/spec.json" --exec "$TP" socket inet-typo || true
assert_exit "unknown payload family does not fall back to IPv4" "2" "$RC"
assert_contains "unknown payload family reports an error" "ERROR:" "$OUT"

echo "=== test 39 (hostile): unsupported network values/types and decoded NUL -> exit 2 ==="
sed '1a "network": "open",' "$WORK/spec.json" > "$WORK/spec-net-bad.json"
run_cap "$BIN" apply --spec "$WORK/spec-net-bad.json" --exec "$TP" socket inet || true
assert_exit "network: unsupported open -> exit 2" "2" "$RC"
sed '1a "network": true,' "$WORK/spec.json" > "$WORK/spec-net-type.json"
run_cap "$BIN" apply --spec "$WORK/spec-net-type.json" --exec /bin/true || true
assert_exit "network: true -> exit 2" "2" "$RC"
sed '1a "network": "ip-family\\u0000junk",' "$WORK/spec.json" > "$WORK/spec-net-nul.json"
run_cap "$BIN" apply --spec "$WORK/spec-net-nul.json" --exec /bin/true || true
assert_exit "network: decoded NUL suffix -> exit 2" "2" "$RC"
sed '1a "network\\u0000junk": "ip-family",' "$WORK/spec.json" > "$WORK/spec-key-nul.json"
run_cap "$BIN" apply --spec "$WORK/spec-key-nul.json" --exec /bin/true || true
assert_exit "native field key: decoded NUL suffix -> exit 2" "2" "$RC"
sed 's/"READ_FILE"/"READ_FILE\\u0000junk"/' "$WORK/spec.json" > "$WORK/spec-flag-nul.json"
run_cap "$BIN" apply --spec "$WORK/spec-flag-nul.json" --exec /bin/true || true
assert_exit "ordinary flag: decoded NUL suffix -> exit 2" "2" "$RC"
sed 's#"/usr"#"/usr\\u0000junk"#' "$WORK/spec.json" > "$WORK/spec-path-nul.json"
run_cap "$BIN" apply --spec "$WORK/spec-path-nul.json" --exec /bin/true || true
assert_exit "ordinary path: decoded NUL suffix -> exit 2" "2" "$RC"
# The native parser ignores unknown fields; this checks literal backslash-u and
# an escaped newline stay representable, without claiming strict-key parity.
sed '1a "ignored_native_control": "literal\\\\u0000text\\ncontinued",' "$WORK/spec.json" > "$WORK/spec-string-control.json"
run_cap "$BIN" apply --spec "$WORK/spec-string-control.json" --exec /bin/true || true
assert_exit "native string control: literal backslash-u and escaped newline -> exit 0" "0" "$RC"

echo "=== test 44: IP-family permission — actual IPv4/IPv6 allowed; Unix/Netlink denied ==="
# This field permits IP families, not destinations. Namespace/route isolation is
# a separate caller responsibility; these tests create no addressed channels.
sed '1a "network": "ip-family",' "$WORK/spec.json" > "$WORK/spec-ip-family.json"
run_cap "$BIN" apply --spec "$WORK/spec-ip-family.json" --exec "$TP" socket inet || true
assert_exit "IP-family: IPv4 socket exits 0" "0" "$RC"
if [[ "$OUT" == "OK:AF_INET" ]]; then pass "IP-family: actual AF_INET"; else fail "IP-family: expected actual AF_INET (out=$OUT)"; fi
run_cap "$BIN" apply --spec "$WORK/spec-ip-family.json" --exec "$TP" socket inet6 || true
assert_exit "IP-family: IPv6 socket exits 0" "0" "$RC"
if [[ "$OUT" == "OK:AF_INET6" ]]; then pass "IP-family: actual AF_INET6"; else fail "IP-family: expected actual AF_INET6 (out=$OUT)"; fi
for SOCKET_FAMILY in unix netlink; do
  run_cap "$BIN" apply --spec "$WORK/spec-ip-family.json" --exec "$TP" socket "$SOCKET_FAMILY" || true
  assert_exit "IP-family: $SOCKET_FAMILY socket exits 1" "1" "$RC"
  assert_contains "IP-family: $SOCKET_FAMILY socket -> EACCES" "EACCES:" "$OUT"
done

echo "=== test 45: owned Unix socketpair roundtrip remains usable in every network mode ==="
for SOCKETPAIR_SPEC in spec.json spec-net.json spec-ip-family.json; do
  run_cap "$BIN" apply --spec "$WORK/$SOCKETPAIR_SPEC" --exec "$TP" socketpair unix || true
  assert_exit "socketpair under $SOCKETPAIR_SPEC exits 0" "0" "$RC"
  if [[ "$OUT" == "OK" ]]; then pass "socketpair under $SOCKETPAIR_SPEC: two-way bytes match"; else fail "socketpair under $SOCKETPAIR_SPEC: roundtrip failed (out=$OUT)"; fi
done

echo "=== test 45b: actual Unix STREAM flags, valid non-STREAM controls and governed creation denial ==="
SOCKETPAIR_DGRAM_EXPECTED=""
for SOCKETPAIR_TYPE in stream dgram seqpacket; do
  case "$SOCKETPAIR_TYPE" in
    stream) SOCKETPAIR_TYPE_NAME="SOCK_STREAM"; SOCKETPAIR_FLAG_CASES=(none cloexec nonblock both) ;;
    dgram) SOCKETPAIR_TYPE_NAME="SOCK_DGRAM"; SOCKETPAIR_FLAG_CASES=(none) ;;
    seqpacket) SOCKETPAIR_TYPE_NAME="SOCK_SEQPACKET"; SOCKETPAIR_FLAG_CASES=(none) ;;
  esac
  for SOCKETPAIR_FLAGS in "${SOCKETPAIR_FLAG_CASES[@]}"; do
    case "$SOCKETPAIR_FLAGS" in
      none) SOCKETPAIR_CLOEXEC=0; SOCKETPAIR_NONBLOCK=0 ;;
      cloexec) SOCKETPAIR_CLOEXEC=1; SOCKETPAIR_NONBLOCK=0 ;;
      nonblock) SOCKETPAIR_CLOEXEC=0; SOCKETPAIR_NONBLOCK=1 ;;
      both) SOCKETPAIR_CLOEXEC=1; SOCKETPAIR_NONBLOCK=1 ;;
    esac
    SOCKETPAIR_EXPECTED="OK:AF_UNIX:$SOCKETPAIR_TYPE_NAME:fd0(FD_CLOEXEC=$SOCKETPAIR_CLOEXEC,O_NONBLOCK=$SOCKETPAIR_NONBLOCK):fd1(FD_CLOEXEC=$SOCKETPAIR_CLOEXEC,O_NONBLOCK=$SOCKETPAIR_NONBLOCK)"
    if [[ "$SOCKETPAIR_TYPE" == "dgram" ]]; then SOCKETPAIR_DGRAM_EXPECTED="$SOCKETPAIR_EXPECTED"; fi
    # The absent-mode positive precedes each governed control; an outer/host
    # refusal cannot replace the owned valid-type roundtrip.
    for SOCKETPAIR_SPEC in spec.json spec-net.json spec-ip-family.json; do
      run_cap "$BIN" apply --spec "$WORK/$SOCKETPAIR_SPEC" --exec "$TP" socketpair unix "$SOCKETPAIR_TYPE" "$SOCKETPAIR_FLAGS" || true
      if [[ "$SOCKETPAIR_TYPE" == "stream" || "$SOCKETPAIR_SPEC" == "spec.json" ]]; then
        assert_exit "socketpair $SOCKETPAIR_TYPE/$SOCKETPAIR_FLAGS under $SOCKETPAIR_SPEC exits 0" "0" "$RC"
        if [[ "$OUT" == "$SOCKETPAIR_EXPECTED" ]]; then pass "socketpair $SOCKETPAIR_TYPE/$SOCKETPAIR_FLAGS under $SOCKETPAIR_SPEC: actual properties and two-way bytes match"; else fail "socketpair $SOCKETPAIR_TYPE/$SOCKETPAIR_FLAGS under $SOCKETPAIR_SPEC: expected $SOCKETPAIR_EXPECTED (out=$OUT)"; fi
      else
        assert_exit "socketpair $SOCKETPAIR_TYPE under $SOCKETPAIR_SPEC exits 1" "1" "$RC"
        if [[ "$OUT" =~ ^EACCES:[0-9]+$ ]]; then pass "socketpair $SOCKETPAIR_TYPE under $SOCKETPAIR_SPEC: creation EACCES"; else fail "socketpair $SOCKETPAIR_TYPE under $SOCKETPAIR_SPEC: expected one EACCES line (out=$OUT)"; fi
      fi
    done
  done
done

echo "=== test 45c: raw invalid family, type and isolated flag have distinct governed EACCES ==="
for SOCKETPAIR_INVALID in family type flag; do
  case "$SOCKETPAIR_INVALID" in
    family) SOCKETPAIR_FAMILY=unspec; SOCKETPAIR_TYPE=stream; SOCKETPAIR_FLAGS=none ;;
    type) SOCKETPAIR_FAMILY=unix; SOCKETPAIR_TYPE=invalid; SOCKETPAIR_FLAGS=none ;;
    flag) SOCKETPAIR_FAMILY=unix; SOCKETPAIR_TYPE=stream; SOCKETPAIR_FLAGS=invalid ;;
  esac
  # The fixture selects AF_UNSPEC, INT_MAX, or STREAM|INT_MIN from headers.
  # The default kernel error is not claimed to be a usable channel.
  run_cap "$BIN" apply --spec "$WORK/spec.json" --exec "$TP" socketpair "$SOCKETPAIR_FAMILY" "$SOCKETPAIR_TYPE" "$SOCKETPAIR_FLAGS" || true
  assert_exit "raw invalid socketpair $SOCKETPAIR_INVALID: absent mode exits 2" "2" "$RC"
  if [[ "$OUT" =~ ^ERROR:[0-9]+$ ]]; then pass "raw invalid socketpair $SOCKETPAIR_INVALID: absent kernel-error baseline"; else fail "raw invalid socketpair $SOCKETPAIR_INVALID: expected one ERROR line (out=$OUT)"; fi
  for SOCKETPAIR_SPEC in spec-net.json spec-ip-family.json; do
    run_cap "$BIN" apply --spec "$WORK/$SOCKETPAIR_SPEC" --exec "$TP" socketpair "$SOCKETPAIR_FAMILY" "$SOCKETPAIR_TYPE" "$SOCKETPAIR_FLAGS" || true
    assert_exit "raw invalid socketpair $SOCKETPAIR_INVALID under $SOCKETPAIR_SPEC exits 1" "1" "$RC"
    if [[ "$OUT" =~ ^EACCES:[0-9]+$ ]]; then pass "raw invalid socketpair $SOCKETPAIR_INVALID under $SOCKETPAIR_SPEC: creation EACCES"; else fail "raw invalid socketpair $SOCKETPAIR_INVALID under $SOCKETPAIR_SPEC: expected one EACCES line (out=$OUT)"; fi
  done
done

echo "=== test 45d: unknown socketpair selector names fail without a fallback ==="
for SOCKETPAIR_UNKNOWN in family type flag; do
  case "$SOCKETPAIR_UNKNOWN" in
    family) SOCKETPAIR_FAMILY=unix-typo; SOCKETPAIR_TYPE=stream; SOCKETPAIR_FLAGS=none ;;
    type) SOCKETPAIR_FAMILY=unix; SOCKETPAIR_TYPE=stream-typo; SOCKETPAIR_FLAGS=none ;;
    flag) SOCKETPAIR_FAMILY=unix; SOCKETPAIR_TYPE=stream; SOCKETPAIR_FLAGS=both-typo ;;
  esac
  run_cap "$BIN" apply --spec "$WORK/spec.json" --exec "$TP" socketpair "$SOCKETPAIR_FAMILY" "$SOCKETPAIR_TYPE" "$SOCKETPAIR_FLAGS" || true
  assert_exit "unknown socketpair $SOCKETPAIR_UNKNOWN selector exits 2" "2" "$RC"
  if [[ "$OUT" =~ ^ERROR:[0-9]+$ ]]; then pass "unknown socketpair $SOCKETPAIR_UNKNOWN selector: parser error"; else fail "unknown socketpair $SOCKETPAIR_UNKNOWN selector: expected one ERROR line (out=$OUT)"; fi
done

echo "=== test 46: fork then exec inherits IP-family permission and denial ==="
run_cap "$BIN" apply --spec "$WORK/spec-ip-family.json" --exec "$TP" fork-exec inet6 || true
assert_exit "inherited IP-family: IPv6 socket exits 0" "0" "$RC"
if [[ "$OUT" == "OK:AF_INET6" ]]; then pass "inherited IP-family: actual AF_INET6"; else fail "inherited IP-family: expected actual AF_INET6 (out=$OUT)"; fi
run_cap "$BIN" apply --spec "$WORK/spec-ip-family.json" --exec "$TP" fork-exec unix || true
assert_exit "inherited IP-family: Unix socket exits 1" "1" "$RC"
assert_contains "inherited IP-family: Unix socket -> EACCES" "EACCES:" "$OUT"

echo "=== test 47: governed io_uring_setup -> ENOSYS; invalid-argument baseline is visible ==="
# No ring can be allocated with these invalid arguments. If this ungoverned
# baseline already returns ENOSYS, it cannot prove a removal-mutant distinction.
run_cap "$BIN" apply --spec "$WORK/spec.json" --exec "$TP" io-uring - || true
printf 'io_uring ungoverned baseline: exit=%s output=%s\n' "$RC" "$OUT"
if [[ "$RC" == "1" && "$OUT" == ENOSYS:* ]] || [[ "$RC" == "2" && "$OUT" == ERROR:* ]]; then
  pass "io_uring invalid-argument baseline returned an error without a ring"
else
  fail "io_uring invalid-argument baseline was unexpected (exit=$RC out=$OUT)"
fi
for IO_URING_SPEC in spec-net.json spec-ip-family.json; do
  run_cap "$BIN" apply --spec "$WORK/$IO_URING_SPEC" --exec "$TP" io-uring - || true
  assert_exit "io_uring under $IO_URING_SPEC exits 1" "1" "$RC"
  assert_contains "io_uring under $IO_URING_SPEC -> ENOSYS" "ENOSYS:" "$OUT"
done
echo "=== test 40: cpu_seconds — a spinning payload is ended by the kernel, by CPU work ==="
sed '1a "cpu_seconds": 1,' "$WORK/spec.json" > "$WORK/spec-cpu.json"
run_cap "$BIN" apply --spec "$WORK/spec-cpu.json" --exec "$TP" spin - || true
# SIGXCPU (24) or SIGKILL (9) ends it: a shell reports 128 + the signal.
if [[ "$RC" == "152" || "$RC" == "137" ]]; then pass "cpu_seconds: the spin ended by signal (exit=$RC)"; else fail "cpu_seconds: the spin was not ended by its CPU ceiling (exit=$RC)"; fi
echo "=== test 41 (hostile): cpu_seconds out of range -> exit 2 ==="
sed '1a "cpu_seconds": 0,' "$WORK/spec.json" > "$WORK/spec-cpu-bad.json"
run_cap "$BIN" apply --spec "$WORK/spec-cpu-bad.json" --exec "$TP" socket inet || true
assert_exit "cpu_seconds: 0 -> exit 2" "2"

echo "=== test 42: signals refused — a signal to any other process is EPERM (seccomp, every kernel); not governed, the control reaches it ==="
sleep 60 & OUTSIDE=$!
sed '1a "signals": "refused",' "$WORK/spec.json" > "$WORK/spec-signals.json"
# Signals alone must not acquire the network-governed pair restriction.
run_cap "$BIN" apply --spec "$WORK/spec-signals.json" --exec "$TP" socketpair unix dgram none || true
assert_exit "absent network plus signals refused: owned DGRAM exits 0" "0" "$RC"
if [[ "$OUT" == "$SOCKETPAIR_DGRAM_EXPECTED" ]]; then pass "absent network plus signals refused: actual DGRAM pair remains usable"; else fail "signals-only DGRAM: expected $SOCKETPAIR_DGRAM_EXPECTED (out=$OUT)"; fi
run_cap "$BIN" apply --spec "$WORK/spec-signals.json" --exec "$TP" signal "$OUTSIDE" || true
if [[ "$OUT" == *"EPERM"* ]] && kill -0 "$OUTSIDE" 2>/dev/null; then pass "signals refused: SIGTERM to an outside process -> EPERM, and it lives"; else fail "signals refused: the signal was not refused (out=$OUT, rc=$RC)"; fi
sed '1a "network": "ip-family",' "$WORK/spec-signals.json" > "$WORK/spec-ip-signals.json"
run_cap "$BIN" apply --spec "$WORK/spec-ip-signals.json" --exec "$TP" signal "$OUTSIDE" || true
assert_exit "IP-family plus signals refused: SIGTERM exits 1" "1" "$RC"
if [[ "$OUT" == *"EPERM"* ]] && kill -0 "$OUTSIDE" 2>/dev/null; then pass "IP-family plus signals refused: SIGTERM -> EPERM, and owned sleeper lives"; else fail "IP-family plus signals refused: signal was not refused (out=$OUT, rc=$RC)"; fi
run_cap "$BIN" apply --spec "$WORK/spec.json" --exec "$TP" signal "$OUTSIDE" || true
sleep 0.2
if [[ "$OUT" == *"OK"* ]] && ! kill -0 "$OUTSIDE" 2>/dev/null; then pass "not governed (control): the same signal reaches it"; else fail "control: the signal did not reach the outside process (out=$OUT)"; fi
kill "$OUTSIDE" 2>/dev/null || true; wait "$OUTSIDE" 2>/dev/null || true
echo "=== test 43 (hostile): signals with any value but \"refused\" -> exit 2 ==="
sed '1a "signals": "scoped",' "$WORK/spec.json" > "$WORK/spec-signals-bad.json"
run_cap "$BIN" apply --spec "$WORK/spec-signals-bad.json" --exec "$TP" socket inet || true
assert_exit "signals: \"scoped\" -> exit 2" "2"

if [ -n "$UNSHARE" ]; then
  ALIAS="$WORK/alias"; mkdir -p "$ALIAS"
  cat > "$WORK/spec-alias-under.json" <<EOF
{"abi_version_hint":0,"handled_access_fs":["READ_FILE","READ_DIR"],"allow_rules":[{"path":"$ALIAS/sub","access":["READ_FILE"]}],"protected_subtrees":["$PROTECT"]}
EOF
  cat > "$WORK/spec-alias-contains.json" <<EOF
{"abi_version_hint":0,"handled_access_fs":["READ_FILE","READ_DIR"],"allow_rules":[{"path":"$ALIAS","access":["READ_FILE"]}],"protected_subtrees":["$PROTECT/sub"]}
EOF
  echo "=== test 35 (hostile): an allow-rule under a protected subtree by a bind-mount alias -> exit 4 ==="
  run_cap $UNSHARE sh -c 'mount --bind "$1" "$2" && exec "$3" apply --spec "$4" --exec /bin/true' sh "$PROTECT" "$ALIAS" "$BIN" "$WORK/spec-alias-under.json" || true
  assert_exit "alias under protected -> exit 4" "4" "$RC"
  assert_contains "alias under protected names the refusal" "is under protected_subtree"
  echo "=== test 36 (hostile): an allow-rule containing a protected subtree by a bind-mount alias -> exit 4 ==="
  run_cap $UNSHARE sh -c 'mount --bind "$1" "$2" && exec "$3" apply --spec "$4" --exec /bin/true' sh "$PROTECT" "$ALIAS" "$BIN" "$WORK/spec-alias-contains.json" || true
  assert_exit "alias containing protected -> exit 4" "4" "$RC"
  assert_contains "alias containing protected names the refusal" "contains protected_subtree"
else
  # One skip per test that did not run, not one for the pair: the denominator
  # has to count what the script would have run.
  skip "test 35 (bind-mount alias under a protected subtree) needs a mount namespace"
  skip "test 36 (bind-mount alias containing a protected subtree) needs a mount namespace"
fi

echo ""
echo "================ SUMMARY ================"
if summary; then
  exit 0
fi
exit 1
