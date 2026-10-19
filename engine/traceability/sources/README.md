# Traceability sources

The vendored primary sources the slices bind: upstream revisions, licenses,
and reference vectors, each with its digest. Verification is entirely
offline — these bytes are the pinned evidence, retrieved once and bound by
hash.

## The subfolders

- `path-policy/` — the path-policy sources: git's `path.c` and the Unicode
  data files the repository-path policy derives from.
- `runtime/` — the pinned Node.js runtime manifests.
- `s2/` — the S2.3 sources: the OpenAI and MCP specification fragments and
  their licenses.
- `s3.1/` — the S3.1 sources: the JCS reference vectors and license.

## Where it lives and what consumes it

The folder lives at `engine/traceability/sources/`. The slice-source
contracts and the generation scripts under `engine/scripts/` read and
re-derive these; each subfolder's manifest pins the digests.
