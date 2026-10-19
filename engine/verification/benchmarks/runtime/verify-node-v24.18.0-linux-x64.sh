#!/usr/bin/bash

set -euo pipefail
IFS=$'\n\t'
export LC_ALL=C
export TZ=UTC
umask 077

readonly BASH_BIN=/usr/bin/bash
readonly CURL=/usr/bin/curl
readonly SQ=/usr/bin/sq
readonly SHA256SUM=/usr/bin/sha256sum
readonly OPENSSL=/usr/bin/openssl
readonly TAR=/usr/bin/tar
readonly CMP=/usr/bin/cmp
readonly STAT=/usr/bin/stat
readonly AWK=/usr/bin/awk
readonly READLINK=/usr/bin/readlink
readonly MKTEMP=/usr/bin/mktemp
readonly MKDIR=/usr/bin/mkdir
readonly CHMOD=/usr/bin/chmod
readonly RM=/usr/bin/rm
readonly DATE=/usr/bin/date
readonly ID=/usr/bin/id

readonly RELEASE_VERSION=v24.18.0
readonly PLATFORM=linux
readonly ARCHITECTURE=x64
readonly ARCHIVE_NAME=node-v24.18.0-linux-x64.tar.xz
readonly ARCHIVE_MEMBER=node-v24.18.0-linux-x64/bin/node
readonly INSTALLED_NODE=/home/example/.nvm/versions/node/v24.18.0/bin/node

readonly RELEASE_KEYS_COMMIT=b28073028e6d6855cfb53bf7fa0137599c01f967
readonly SIGNER_FINGERPRINT=C82FA3AE1CBEDC6BE46B9360C43CEC45C17AB93C
readonly SIGNATURE_REFERENCE_TIME=2026-06-24T00:00:00Z
readonly CLEARTEXT_SIGNATURE_TIME='2026-06-23 23:07:58 UTC'
readonly DETACHED_SIGNATURE_TIME='2026-06-23 23:07:59 UTC'

readonly RELEASE_KEYS_README_SHA256=a211a86a4e6561c730a0f007952510661e4178040f0f427e7a241e87736b2509
readonly RELEASE_KEYS_README_BYTES=6069
readonly ACTIVE_KEYS_LIST_SHA256=d1ed2bc5c8874fbc826213e751a6dfca45143d026029640f5aced1be1cac4f20
readonly ACTIVE_KEYS_LIST_BYTES=1189
readonly ACTIVE_KEYRING_SHA256=8e6f89521a0694e445f42decd022f48369c634f1b5bcb5975135b69c88629ae8
readonly ACTIVE_KEYRING_BYTES=24268
readonly SIGNER_CERT_SHA256=84b1ca614406f341cb86e72920f5a64687a13ab67ab84038bcf2abba97898a84
readonly SIGNER_CERT_BYTES=5613

readonly SHASUMS_SHA256=3927bab574a00ca0560c9583fe19655ba19603a1c5851414e4325d34ac50e469
readonly SHASUMS_BYTES=2967
readonly SHASUMS_CLEARTEXT_SIGNATURE_SHA256=2f70f136714c94decfcc3a6f47e8550375e934c956fb4df9e5a69fafd1e58fcf
readonly SHASUMS_CLEARTEXT_SIGNATURE_BYTES=3849
readonly SHASUMS_DETACHED_SIGNATURE_SHA256=d771440acfe010e7510a3c01d248525f771daa9cf75dae5784c97ea2b08d9393
readonly SHASUMS_DETACHED_SIGNATURE_BYTES=566
readonly VERIFIED_CLEARTEXT_SHA256=fc257b57db9b22f9baccacb453db25f030e0cf0b6c9f8b40feed0e62e464cb86
readonly VERIFIED_CLEARTEXT_BYTES=2966

readonly ARCHIVE_SHA256=55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742
readonly ARCHIVE_BYTES=31511588
readonly ARCHIVE_LINE='55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742  node-v24.18.0-linux-x64.tar.xz'
readonly ARCHIVE_LISTING_SHA256=43542b2665c6e7c6dacab04b3c85eaf97f52586de87b3449427797cffb4071e6
readonly ARCHIVE_LISTING_BYTES=523541
readonly ARCHIVE_ENTRY_COUNT=5774
readonly MEMBER_VERBOSE_LISTING='-rwxr-xr-x 1001/1001 123655872 2026-06-23 17:48:53 node-v24.18.0-linux-x64/bin/node'
readonly NODE_SHA256=41a74efb34cbde5c7632cdac0cf8bd1a14d0b8d73dc1e82755014d9a9ce70f5c
readonly NODE_BYTES=123655872
readonly NODE_MODE=755

fail() {
  printf 'node runtime qualification failed: %s\n' "$1" >&2
  exit 1
}

assert_equal() {
  local expected=$1
  local actual=$2
  local label=$3
  [[ "$actual" == "$expected" ]] || fail "$label: expected '$expected', observed '$actual'"
}

json_escape() {
  local value=$1
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//$'\n'/\\n}
  value=${value//$'\r'/\\r}
  value=${value//$'\t'/\\t}
  printf '%s' "$value"
}

hash_file() {
  local path=$1
  local coreutils_hash openssl_hash openssl_line
  coreutils_hash=$($SHA256SUM -- "$path")
  coreutils_hash=${coreutils_hash%% *}
  openssl_line=$($OPENSSL dgst -sha256 -r "$path")
  openssl_hash=${openssl_line%% *}
  [[ "$coreutils_hash" =~ ^[0-9a-f]{64}$ ]] || fail "invalid sha256sum output for $path"
  assert_equal "$coreutils_hash" "$openssl_hash" "cross-implementation SHA-256 for $path"
  printf '%s' "$coreutils_hash"
}

verify_file() {
  local path=$1
  local expected_hash=$2
  local expected_bytes=$3
  local label=$4
  local actual_hash actual_bytes
  [[ -f "$path" && ! -L "$path" ]] || fail "$label is not a regular non-symlink file"
  actual_hash=$(hash_file "$path")
  actual_bytes=$($STAT -c '%s' -- "$path")
  assert_equal "$expected_hash" "$actual_hash" "$label SHA-256"
  assert_equal "$expected_bytes" "$actual_bytes" "$label byte length"
}

fetch() {
  local url=$1
  local destination=$2
  $CURL --disable \
    --fail \
    --silent \
    --show-error \
    --proto '=https' \
    --proto-redir '=https' \
    --tlsv1.2 \
    --max-redirs 0 \
    --header 'Accept-Encoding: identity' \
    --output "$destination" \
    "$url"
}

contains_exact_line_once() {
  local path=$1
  local expected=$2
  $AWK -v expected="$expected" '
    $0 == expected { count += 1 }
    END { if (count != 1) exit 1 }
  ' "$path"
}

append_json_object() {
  local current=$1
  local object=$2
  if [[ -n "$current" ]]; then
    printf '%s,%s' "$current" "$object"
  else
    printf '%s' "$object"
  fi
}

readonly -a TOOL_LOCKS=(
  '/usr/bin/bash|/usr/bin/bash|223fe8564b60636bc738b6178d3ba9a50ef7d791266b0efae6363bb716e4c47f|1298416|755'
  '/usr/bin/curl|/usr/bin/curl|3fed7b3e269822926d4b93911fb45d1156bf43cea85f12b58acbdab802c574bc|321880|755'
  '/usr/bin/sq|/usr/bin/sq|d1fbf31268312959a764cb68b2fc38379059d327ec0b83f0a92b4f3ee79b551b|22079056|755'
  '/usr/bin/sha256sum|/usr/bin/sha256sum|89f8c1d1ba3c76138f3771e1a91e2796ade6180b1c1e4258c04698ff32787c97|55752|755'
  '/usr/bin/openssl|/usr/bin/openssl|38633817061f9d161c8b14c1ff72c9f223e8208d977a4c15d843010611a5dded|1103304|755'
  '/usr/bin/tar|/usr/bin/tar|38adf50825f773d353d6bda1a7cd70c22f8877823e44821c1d2bd0a52ddc3871|458280|755'
  '/usr/bin/cmp|/usr/bin/cmp|751322036db972a763a66a5564b857707db53efedb6c96d12b19138bf0ec1b58|56272|755'
  '/usr/bin/stat|/usr/bin/stat|128754b37ab743a539d889a91441c440f9b52df77f4e008b345ff221ce1daeaa|104904|755'
  '/usr/bin/awk|/usr/bin/mawk|eff9f2b711eb5bee1b58d4d33b891e8da8f6534655d3854a45bd10217dbb28e6|170664|755'
  '/usr/bin/readlink|/usr/bin/readlink|1dcaf494f4dec175292b1684b3e978d18a4c3c703c52f81606d9e8eea30eb6db|55720|755'
  '/usr/bin/mktemp|/usr/bin/mktemp|61f09af83b1ccbd744d424ba5ad19b2af4edb5ad67c367cc092f58422b7bbb7c|47528|755'
  '/usr/bin/mkdir|/usr/bin/mkdir|bd3d9b36a1cc1c63b8dca7967003f4e5b0bb8556c87cbb7c1916aa358bf3f053|88488|755'
  '/usr/bin/chmod|/usr/bin/chmod|7e37f672db75ae783260e7565d26218d25cebbc5a6d61118284c9719d246a90e|72136|755'
  '/usr/bin/rm|/usr/bin/rm|c959a237e7b95d229eea44764b2246fcb61a95dc679a10ad0cc97ad84c2316c1|76232|755'
  '/usr/bin/date|/usr/bin/date|c45e250696f9acab00814e8a0b21ce6666fe212a9e78a14f9917552546d7b389|100808|755'
  '/usr/bin/id|/usr/bin/id|50629fa0ab5c003b538d4ccf7de34e85d2df4e799a79eb2dd4c2f7b1e0d7ca59|51656|755'
)

run_id=${RUN_ID:-manual}
[[ "$run_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || fail 'RUN_ID must be 1-64 safe identifier characters'

script_path=$($READLINK -f -- "${BASH_SOURCE[0]}")
script_dir=${script_path%/*}
repo_root=${script_dir%/verification/benchmarks/runtime}
[[ "$repo_root" != "$script_dir" && -d "$repo_root/.git" ]] || fail 'cannot resolve repository root'

private_root=${CODE_HARNESS_PRIVATE_TMP_ROOT:-$repo_root/.bridlewise/private}
[[ "$private_root" == /* ]] || fail 'private temp root must be absolute'
if [[ ! -e "$private_root" ]]; then
  $MKDIR -p -- "$private_root"
fi
[[ -d "$private_root" && ! -L "$private_root" ]] || fail 'private temp root must be a non-symlink directory'
private_root_mode=$($STAT -c '%a' -- "$private_root")
case "$private_root_mode" in
  700) ;;
  *) fail "private temp root must have mode 0700, observed $private_root_mode" ;;
esac

scratch=$($MKTEMP -d -- "$private_root/node-runtime-v24.18.0-$run_id.XXXXXX")
$CHMOD 700 -- "$scratch"
cleanup() {
  if [[ -n "${scratch:-}" && "$scratch" == "$private_root"/node-runtime-v24.18.0-"$run_id".* && -d "$scratch" ]]; then
    $RM -rf -- "$scratch"
  fi
}
trap cleanup EXIT HUP INT TERM

tool_json=''
for lock in "${TOOL_LOCKS[@]}"; do
  IFS='|' read -r lexical expected_real expected_hash expected_bytes expected_mode <<<"$lock"
  [[ -e "$lexical" ]] || fail "missing external tool $lexical"
  actual_real=$($READLINK -f -- "$lexical")
  assert_equal "$expected_real" "$actual_real" "$lexical resolved path"
  verify_file "$actual_real" "$expected_hash" "$expected_bytes" "external tool $lexical"
  actual_mode=$($STAT -Lc '%a' -- "$actual_real")
  assert_equal "$expected_mode" "$actual_mode" "$lexical executable mode"
  object=$(printf '{"path":"%s","resolvedPath":"%s","sha256":"%s","byteLength":%s,"mode":"0%s"}' \
    "$(json_escape "$lexical")" \
    "$(json_escape "$actual_real")" \
    "$expected_hash" \
    "$expected_bytes" \
    "$expected_mode")
  tool_json=$(append_json_object "$tool_json" "$object")
done

verifier_sha256=$(hash_file "$script_path")
verifier_bytes=$($STAT -c '%s' -- "$script_path")
verifier_mode=$($STAT -c '%a' -- "$script_path")

readonly release_keys_raw=https://raw.githubusercontent.com/nodejs/release-keys/$RELEASE_KEYS_COMMIT
readonly node_dist=https://nodejs.org/dist/$RELEASE_VERSION

fetch "$release_keys_raw/README.md" "$scratch/release-keys.README.md"
fetch "$release_keys_raw/keys.list" "$scratch/keys.list"
fetch "$release_keys_raw/gpg-only-active-keys/pubring.kbx" "$scratch/active-pubring.kbx"
fetch "$release_keys_raw/keys/$SIGNER_FINGERPRINT.asc" "$scratch/signer.asc"
verify_file "$scratch/release-keys.README.md" "$RELEASE_KEYS_README_SHA256" "$RELEASE_KEYS_README_BYTES" 'release-keys README'
verify_file "$scratch/keys.list" "$ACTIVE_KEYS_LIST_SHA256" "$ACTIVE_KEYS_LIST_BYTES" 'active release key list'
verify_file "$scratch/active-pubring.kbx" "$ACTIVE_KEYRING_SHA256" "$ACTIVE_KEYRING_BYTES" 'active release keyring'
verify_file "$scratch/signer.asc" "$SIGNER_CERT_SHA256" "$SIGNER_CERT_BYTES" 'release signer certificate'
contains_exact_line_once "$scratch/keys.list" "$SIGNER_FINGERPRINT" || fail 'signer is not present exactly once in the pinned active key list'

signer_inspection=$($SQ --cert-store=none --key-store=none inspect "$scratch/signer.asc")
[[ "$signer_inspection" == *"Fingerprint: $SIGNER_FINGERPRINT"* ]] || fail 'signer certificate fingerprint mismatch'
[[ "$signer_inspection" == *'OpenPGP Certificate.'* ]] || fail 'signer input is not a public OpenPGP certificate'

fetch "$node_dist/SHASUMS256.txt" "$scratch/SHASUMS256.txt"
fetch "$node_dist/SHASUMS256.txt.asc" "$scratch/SHASUMS256.txt.asc"
fetch "$node_dist/SHASUMS256.txt.sig" "$scratch/SHASUMS256.txt.sig"
verify_file "$scratch/SHASUMS256.txt" "$SHASUMS_SHA256" "$SHASUMS_BYTES" 'official SHASUMS256.txt'
verify_file "$scratch/SHASUMS256.txt.asc" "$SHASUMS_CLEARTEXT_SIGNATURE_SHA256" "$SHASUMS_CLEARTEXT_SIGNATURE_BYTES" 'official cleartext-signed SHASUMS'
verify_file "$scratch/SHASUMS256.txt.sig" "$SHASUMS_DETACHED_SIGNATURE_SHA256" "$SHASUMS_DETACHED_SIGNATURE_BYTES" 'official detached SHASUMS signature'

$SQ --time "$SIGNATURE_REFERENCE_TIME" --cert-store=none --key-store=none verify \
  --cleartext \
  --signer-file "$scratch/signer.asc" \
  --output "$scratch/verified-cleartext.txt" \
  "$scratch/SHASUMS256.txt.asc" \
  2>"$scratch/cleartext-verification.log"
$SQ --time "$SIGNATURE_REFERENCE_TIME" --cert-store=none --key-store=none verify \
  --signature-file "$scratch/SHASUMS256.txt.sig" \
  --signer-file "$scratch/signer.asc" \
  "$scratch/SHASUMS256.txt" \
  2>"$scratch/detached-verification.log"
verify_file "$scratch/verified-cleartext.txt" "$VERIFIED_CLEARTEXT_SHA256" "$VERIFIED_CLEARTEXT_BYTES" 'verified cleartext SHASUMS payload'

cleartext_packets=$($SQ --cert-store=none --key-store=none packet dump "$scratch/SHASUMS256.txt.asc")
detached_packets=$($SQ --cert-store=none --key-store=none packet dump "$scratch/SHASUMS256.txt.sig")
[[ "$cleartext_packets" == *'Type: Text'* ]] || fail 'cleartext signature packet type mismatch'
[[ "$cleartext_packets" == *'Hash algo: SHA256'* ]] || fail 'cleartext signature hash algorithm mismatch'
[[ "$cleartext_packets" == *"Issuer Fingerprint: $SIGNER_FINGERPRINT"* ]] || fail 'cleartext signature issuer mismatch'
[[ "$cleartext_packets" == *"Signature creation time: $CLEARTEXT_SIGNATURE_TIME"* ]] || fail 'cleartext signature time mismatch'
[[ "$detached_packets" == *'Type: Binary'* ]] || fail 'detached signature packet type mismatch'
[[ "$detached_packets" == *'Hash algo: SHA256'* ]] || fail 'detached signature hash algorithm mismatch'
[[ "$detached_packets" == *"Issuer Fingerprint: $SIGNER_FINGERPRINT"* ]] || fail 'detached signature issuer mismatch'
[[ "$detached_packets" == *"Signature creation time: $DETACHED_SIGNATURE_TIME"* ]] || fail 'detached signature time mismatch'

$CMP --silent "$scratch/SHASUMS256.txt" <($BASH_BIN -c 'source=$1; bytes=$(<"$source"); printf "%s\n" "$bytes"' _ "$scratch/verified-cleartext.txt") \
  || fail 'standalone SHASUMS does not equal verified cleartext payload plus one LF'
contains_exact_line_once "$scratch/verified-cleartext.txt" "$ARCHIVE_LINE" || fail 'archive checksum line is not unique in signed payload'

fetch "$node_dist/$ARCHIVE_NAME" "$scratch/$ARCHIVE_NAME"
verify_file "$scratch/$ARCHIVE_NAME" "$ARCHIVE_SHA256" "$ARCHIVE_BYTES" 'Node linux-x64 archive'

$TAR --list --quoting-style=c --file "$scratch/$ARCHIVE_NAME" >"$scratch/archive-listing.txt"
verify_file "$scratch/archive-listing.txt" "$ARCHIVE_LISTING_SHA256" "$ARCHIVE_LISTING_BYTES" 'quoted archive member listing'
archive_entry_count=$($AWK 'END { print NR + 0 }' "$scratch/archive-listing.txt")
assert_equal "$ARCHIVE_ENTRY_COUNT" "$archive_entry_count" 'archive entry count'
unsafe_entry_count=$($AWK '
  BEGIN { bad = 0 }
  $0 !~ /^"node-v24\.18\.0-linux-x64\// { bad += 1; next }
  $0 ~ /(^|\/)\.\.($|\/)/ { bad += 1 }
  $0 ~ /^"\// { bad += 1 }
  END { print bad + 0 }
' "$scratch/archive-listing.txt")
assert_equal 0 "$unsafe_entry_count" 'quoted archive unsafe-path count'

member_count=$($TAR --list --quoting-style=literal --file "$scratch/$ARCHIVE_NAME" "$ARCHIVE_MEMBER" \
  | $AWK -v member="$ARCHIVE_MEMBER" '$0 == member { count += 1 } END { print count + 0 }')
assert_equal 1 "$member_count" 'exact archive node member occurrence count'
member_listing=$($TAR --list --verbose --numeric-owner --full-time --quoting-style=literal \
  --file "$scratch/$ARCHIVE_NAME" "$ARCHIVE_MEMBER")
assert_equal "$MEMBER_VERBOSE_LISTING" "$member_listing" 'archive node member metadata'

$MKDIR -- "$scratch/extract"
$CHMOD 700 -- "$scratch/extract"
$TAR --extract \
  --file "$scratch/$ARCHIVE_NAME" \
  --directory "$scratch/extract" \
  --no-same-owner \
  --same-permissions \
  --no-overwrite-dir \
  --occurrence=1 \
  "$ARCHIVE_MEMBER"
extracted_node=$scratch/extract/$ARCHIVE_MEMBER
[[ -f "$extracted_node" && ! -L "$extracted_node" ]] || fail 'extracted node is not a regular non-symlink file'
assert_equal 'regular file' "$($STAT -c '%F' -- "$extracted_node")" 'extracted node type'
assert_equal 1 "$($STAT -c '%h' -- "$extracted_node")" 'extracted node link count'
assert_equal "$NODE_MODE" "$($STAT -c '%a' -- "$extracted_node")" 'extracted node mode'
verify_file "$extracted_node" "$NODE_SHA256" "$NODE_BYTES" 'extracted node executable'

[[ -f "$INSTALLED_NODE" && ! -L "$INSTALLED_NODE" ]] || fail 'installed node path is not a regular non-symlink file'
installed_lexical_before=$($STAT -c '%d|%i|%u|%g|%a|%s|%h|%F' -- "$INSTALLED_NODE")
exec {installed_fd}<"$INSTALLED_NODE"
installed_fd_path=/proc/self/fd/$installed_fd
installed_descriptor_before=$($STAT -Lc '%d|%i|%u|%g|%a|%s|%h|%F' -- "$installed_fd_path")
assert_equal "$installed_lexical_before" "$installed_descriptor_before" 'installed lexical path to held descriptor identity'

installed_sha256_before=$(hash_file "$installed_fd_path")
assert_equal "$NODE_SHA256" "$installed_sha256_before" 'installed descriptor SHA-256 before comparison'
$CMP --silent "$extracted_node" "$installed_fd_path" || fail 'installed descriptor is not byte-identical to archive node'
installed_sha256_after=$(hash_file "$installed_fd_path")
assert_equal "$installed_sha256_before" "$installed_sha256_after" 'installed descriptor SHA-256 stability'
installed_descriptor_after=$($STAT -Lc '%d|%i|%u|%g|%a|%s|%h|%F' -- "$installed_fd_path")
installed_lexical_after=$($STAT -c '%d|%i|%u|%g|%a|%s|%h|%F' -- "$INSTALLED_NODE")
assert_equal "$installed_descriptor_before" "$installed_descriptor_after" 'held descriptor stat stability'
assert_equal "$installed_lexical_before" "$installed_lexical_after" 'installed lexical lstat stability'

IFS='|' read -r installed_dev installed_ino installed_uid installed_gid installed_mode installed_bytes installed_links installed_type <<<"$installed_descriptor_after"
assert_equal "$NODE_MODE" "$installed_mode" 'installed descriptor mode'
assert_equal "$NODE_BYTES" "$installed_bytes" 'installed descriptor byte length'
assert_equal 1 "$installed_links" 'installed descriptor link count'
assert_equal 'regular file' "$installed_type" 'installed descriptor type'

readonly -a INSTALLED_COMPONENTS=(
  '/'
  '/home'
  '/home/example'
  '/home/example/.nvm'
  '/home/example/.nvm/versions'
  '/home/example/.nvm/versions/node'
  '/home/example/.nvm/versions/node/v24.18.0'
  '/home/example/.nvm/versions/node/v24.18.0/bin'
  '/home/example/.nvm/versions/node/v24.18.0/bin/node'
)

component_json=''
for component in "${INSTALLED_COMPONENTS[@]}"; do
  [[ ! -L "$component" ]] || fail "installed path component is a symlink: $component"
  component_stat=$($STAT -c '%d|%i|%u|%g|%a|%s|%h|%F' -- "$component")
  IFS='|' read -r c_dev c_ino c_uid c_gid c_mode c_bytes c_links c_type <<<"$component_stat"
  writable=false
  [[ -w "$component" ]] && writable=true
  object=$(printf '{"path":"%s","device":"%s","inode":"%s","uid":"%s","gid":"%s","mode":"0%s","byteLength":%s,"linkCount":%s,"type":"%s","writableByVerifierProcess":%s}' \
    "$(json_escape "$component")" \
    "$c_dev" \
    "$c_ino" \
    "$c_uid" \
    "$c_gid" \
    "$c_mode" \
    "$c_bytes" \
    "$c_links" \
    "$(json_escape "$c_type")" \
    "$writable")
  component_json=$(append_json_object "$component_json" "$object")
done

observed_at=$($DATE -u '+%Y-%m-%dT%H:%M:%SZ')
verifier_uid=$($ID -u)
verifier_gid=$($ID -g)

printf '{\n'
printf '  "schemaVersion": "bridlewise-node-runtime-qualification-run/v1",\n'
printf '  "runId": "%s",\n' "$(json_escape "$run_id")"
printf '  "observedAt": "%s",\n' "$observed_at"
printf '  "subject": {"version":"%s","platform":"%s","architecture":"%s","installedLexicalPath":"%s"},\n' \
  "$RELEASE_VERSION" "$PLATFORM" "$ARCHITECTURE" "$(json_escape "$INSTALLED_NODE")"
printf '  "releaseKeys": {"repository":"https://github.com/nodejs/release-keys","commit":"%s","readme":{"sha256":"%s","byteLength":%s},"activeKeysList":{"sha256":"%s","byteLength":%s},"activeKeyring":{"sha256":"%s","byteLength":%s},"signerCertificate":{"primaryFingerprint":"%s","signingFingerprint":"%s","sha256":"%s","byteLength":%s,"activeListOccurrenceCount":1}},\n' \
  "$RELEASE_KEYS_COMMIT" \
  "$RELEASE_KEYS_README_SHA256" "$RELEASE_KEYS_README_BYTES" \
  "$ACTIVE_KEYS_LIST_SHA256" "$ACTIVE_KEYS_LIST_BYTES" \
  "$ACTIVE_KEYRING_SHA256" "$ACTIVE_KEYRING_BYTES" \
  "$SIGNER_FINGERPRINT" "$SIGNER_FINGERPRINT" "$SIGNER_CERT_SHA256" "$SIGNER_CERT_BYTES"
printf '  "signedChecksums": {"standalone":{"sha256":"%s","byteLength":%s},"cleartextSigned":{"sha256":"%s","byteLength":%s,"signatureTime":"%s","verificationReferenceTime":"%s","authenticatedSignatureCount":1,"verifiedPayloadSha256":"%s","verifiedPayloadByteLength":%s},"detachedSignature":{"sha256":"%s","byteLength":%s,"signatureTime":"%s","verificationReferenceTime":"%s","authenticatedSignatureCount":1},"standaloneEqualsVerifiedPayloadPlusLf":true},\n' \
  "$SHASUMS_SHA256" "$SHASUMS_BYTES" \
  "$SHASUMS_CLEARTEXT_SIGNATURE_SHA256" "$SHASUMS_CLEARTEXT_SIGNATURE_BYTES" "$CLEARTEXT_SIGNATURE_TIME" "$SIGNATURE_REFERENCE_TIME" "$VERIFIED_CLEARTEXT_SHA256" "$VERIFIED_CLEARTEXT_BYTES" \
  "$SHASUMS_DETACHED_SIGNATURE_SHA256" "$SHASUMS_DETACHED_SIGNATURE_BYTES" "$DETACHED_SIGNATURE_TIME" "$SIGNATURE_REFERENCE_TIME"
printf '  "archive": {"name":"%s","signedLine":"%s","sha256":"%s","byteLength":%s,"quotedListingSha256":"%s","quotedListingByteLength":%s,"entryCount":%s,"unsafePathCount":0,"retainedAfterRun":false},\n' \
  "$ARCHIVE_NAME" "$ARCHIVE_LINE" "$ARCHIVE_SHA256" "$ARCHIVE_BYTES" "$ARCHIVE_LISTING_SHA256" "$ARCHIVE_LISTING_BYTES" "$ARCHIVE_ENTRY_COUNT"
printf '  "extraction": {"strategy":"authenticated-exact-member-only-fresh-private-directory","member":"%s","memberOccurrenceCount":1,"archiveMetadata":"%s","type":"regular file","linkCount":1,"mode":"0%s","sha256":"%s","byteLength":%s,"candidateExecuted":false},\n' \
  "$ARCHIVE_MEMBER" "$(json_escape "$MEMBER_VERBOSE_LISTING")" "$NODE_MODE" "$NODE_SHA256" "$NODE_BYTES"
printf '  "installedDescriptor": {"lexicalPath":"%s","device":"%s","inode":"%s","uid":"%s","gid":"%s","mode":"0%s","byteLength":%s,"linkCount":%s,"type":"%s","sha256":"%s","lexicalLstatMatchesHeldDescriptor":true,"descriptorStableAcrossHashAndCompare":true,"exactByteEqualityWithExtractedMember":true},\n' \
  "$(json_escape "$INSTALLED_NODE")" "$installed_dev" "$installed_ino" "$installed_uid" "$installed_gid" "$installed_mode" "$installed_bytes" "$installed_links" "$(json_escape "$installed_type")" "$installed_sha256_after"
printf '  "installedPathComponents": [%s],\n' "$component_json"
printf '  "verifier": {"path":"%s","sha256":"%s","byteLength":%s,"mode":"0%s","candidateNodeUsed":false,"toolIdentityAuthority":"host-observation-only","externalTools":[%s]},\n' \
  "$(json_escape "$script_path")" "$verifier_sha256" "$verifier_bytes" "$verifier_mode" "$tool_json"
printf '  "principalAssessment": {"modeledRuntimePrincipalAuthority":"missing","verifierProcess":{"uid":"%s","gid":"%s"},"claim":"Per-component observations are recorded; no authoritative modeled-principal writability conclusion is made."},\n' \
  "$verifier_uid" "$verifier_gid"
printf '  "decision": {"status":"provisional-blocked","qualifiedObservations":["official-release-signatures-authenticated","archive-digest-matches-signed-checksums","safe-exact-member-extraction","installed-held-descriptor-byte-equality"],"blockers":["nonwritable-separate-principal-runtime-staging-not-established","modeled-runtime-principal-and-tool-policy-authority-missing","central-admission-record-locator-and-digest-authority-missing","external-bootstrap-toolchain-unadmitted"]}\n'
printf '}\n'
