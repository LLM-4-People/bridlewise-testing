# Traceability

The engine's runtime-pinned registries and evidence: the canonical
requirements ledger, the slice traces, the contract and forensic schema
artifacts, the test inventory, and the vendored primary sources the slices
bind. These are live artifacts — the verifiers read them on every run, and
the generators re-derive the pinned ones rather than hand-editing them.

## What each file does

- `requirements.json` — the canonical requirement-definition authority; the
  slice traces are derived projections whose links must resolve through it.
- `s1.json` — the S1 slice trace: requirement/control IDs and the twelve
  registered behaviors.
- `s1-test-inventory.json` — the complete S1 test inventory: every test
  name bound to its source ID and source hash.
- `s2.json` — the S2.3 slice trace, pinning the official OpenAI and MCP
  source revisions, retrieval date, and digests.
- `s2.4.json` — the S2.4 slice trace for the canonical requirements
  registry.
- `s2-contract-schemas.json` — the checked artifact of the generated S2.3
  protocol schemas.
- `s2.4-requirements-schema.json` — the generated schema the requirements
  registry validates through.
- `s3.1.json` — the S3.1 slice trace binding the hostile forensic behaviors.
- `s3.1-forensic-schemas.json` — the frozen generated forensic schemas.
- `config-document-schema.json` — the generated schema artifact for the
  configuration document.
- `test-surface-dispositions.json` — the test-surface disposition manifest.

## The subfolders

- `artifacts/` — small generated manifests.
- `canonical/` — the canonical projections derived from the runtime
  authorities.
- `self-protection/` — the published guardian spec schema.
- `sources/` — the vendored primary sources (licenses, upstream revisions,
  reference vectors) the slices bind, with their digests.

## Where it lives and what consumes it

The folder lives at `engine/traceability/`. The verification gates under
`engine/scripts/verification/`, the workflow hash-binding registry, and the
runtime's pinned readers consume these artifacts; the paths are named once
in `engine/src/kernel/verification-paths.ts`.
