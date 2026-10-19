# Node runtime provenance verifier

`verify-node-v24.18.0-linux-x64.sh` is a research-only verifier for the exact
Node v24.18.0 linux-x64 bytes currently installed at
`/home/example/.nvm/versions/node/v24.18.0/bin/node`.

The verifier does not execute Node. It uses a locked host Bash/toolchain to:

1. retrieve commit-addressed release-key material from the official
   `nodejs/release-keys` repository;
2. authenticate both the official cleartext-signed `SHASUMS256.txt.asc` and
   detached `SHASUMS256.txt.sig` with the pinned active signer certificate;
3. retrieve the release archive from `nodejs.org`, cross-check its SHA-256
   using both GNU `sha256sum` and OpenSSL, and require the unique signed digest
   line;
4. inspect the authenticated archive and extract only the exact regular-file
   `node-v24.18.0-linux-x64/bin/node` member into fresh private scratch;
5. open the installed executable once, hash and compare it through
   `/proc/self/fd/<held-fd>`, and recheck descriptor/path identity and bytes;
6. emit one JSON observation to standard output and remove all downloaded raw
   material on exit.

The default scratch parent is `.bridlewise/private`, which must be a
non-symlink mode-0700 directory. The script writes no versioned artifact. A
single reproduction run is:

```text
RUN_ID=manual verification/benchmarks/runtime/verify-node-v24.18.0-linux-x64.sh > /private/mode-0700/location/run.json
```

The verifier intentionally locks exact external tool bytes. An operating
system tool update therefore fails closed and requires a new qualification.
Those byte observations are not admission of the bootstrap toolchain.

This executable is effectful: it performs HTTPS reads and ephemeral private
scratch writes. Generic executable/shebang discovery and its exact central
registration are now present. The registration pins this script's frozen
SHA-256 and classifies it as `blocked-unqualified`, shell-language,
research-only and non-model-facing with child-process, cryptography,
filesystem-read, filesystem-write, network and process-status effects. This
resolves the discovery/registration coordination gap only. The author effect
suite passed 17/17 tests in each of three repetitions, including generic
shell/shebang discovery and this exact registration, but that result is not
independent qualification. Central effect qualification and the dependent
migration-write-authority/secret-span cascade remain pending, so
repository-wide command-effect closure is still not claimed.

The record schema only accepts a `provisional-blocked` candidate. Neither this
script, its outputs, nor schema validation can create `AdmittedNodeRuntime`.
The central authority must independently select a record locator and expected
record digest, establish a modeled runtime principal/tool policy, and verify a
separately staged nonwritable installation before any runtime can be returned.

The closed record schema enforces canonical whole-second UTC RFC 3339 values by
both `format` and a calendar-aware pattern, so offsets, fractions and invalid
dates fail even when a validator ignores `format`. Repository artifact paths
use a strict normalized relative-path definition that excludes absolute paths,
backslashes, empty/dot/dotdot segments, traversal, non-ASCII confusables,
encoded traversal and trailing-dot ambiguity. The data-only negative-control
fixture exercises these cases; it introduces no new executable surface.

Any future consumer must start from a centrally authorized held repository-root
descriptor, prove component-by-component containment without a path-based
reopen, and recompute both SHA-256 and byte length for the candidate record and
every referenced artifact before trusting content.

The three checked research observations and the candidate record are under
`traceability/evidence/research/runtime/node-v24.18.0-linux-x64/`. They remain
unregistered and unadmitted pending the repository-wide evidence cascade.
