# Engine kernel

The engine's trusted kernel: the typed error hierarchy, canonical integrity and hashing, the root policy invariants, and the verification, schema, and protocol contracts every other engine domain builds on. Nothing here depends on a feature; the features depend on these.

## What each file does

- `architecture-external-commands.ts` — the external-command inventory the architecture manifest declares (blocked Python/shell commands with their qualified source digests), kept beside the manifest so the hash-binding registry can derive the published source pins without importing the generated manifest into the measured surface.
- `config-write-lock.ts` — THE CONFIG FILE'S CROSS-PROCESS WRITE LOCK.
- `contracts.ts` — the contracts module.
- `engine-root.ts` — THE engine checkout's root (`engineRoot`, `pinnedRepositoryRoot`: above the root-policy owner's declared location), asked by the config document's location and the key home's admission.
- `errors.ts` — the errors module.
- `execution-closure.ts` — the execution-closure module.
- `integrity.ts` — the canonical owner of hashing and random bytes: `sha256`, the canonical JSON hashes, `gitBlobId` (the id git gives a blob, SHA-1 or SHA-256), the id generators, `deepFreeze`; the only engine module that imports `createHash`, `randomUUID` or `randomBytes` from `node:crypto`.
- `json-integrity.ts` — JSON integrity primitives: duplicate-key refusal and
  `parseJsonExact`, the one never-throwing exact parse (the value boxed, so
  JSON `null` stays distinct from "not JSON"; the parser's message, which
  quotes the input, never surfaces).
- `language-extensions.ts` — Canonical TypeScript/JavaScript file-extension sets.
- `ledger-canonical.ts` — the ledger-canonical module.
- `lexical-policy.ts` — dependency-free canonical ceilings for immutable lexical reuse, shared by the full root policy and scanner.
- `ordered.ts` — the ordered module.
- `preflight.ts` — the preflight module.
- `product-identity.ts` — the product-identity owner: the single source of truth for the product name, schema-namespace prefix, config-file basename, state-directory name, and crypto domain prefix, plus the schemaId/cryptoDomain/statePath derivers.
- `protocol-projections.ts` — the protocol-projections module.
- `requirements.ts` — the requirements module.
- `root-policy.ts` — the root-policy module.
- `safe-structural.ts` — the safe-structural module.
- `schema-subset.ts` — the schema-subset module.
- `test-surface-manifest.ts` — the test-surface-manifest module.
- `config.ts` — the engine configuration owner: the resolved values the engine reads.
- `command-names.ts` — the names no `execute_command` may run and no `tools.allowedCommands` may hold: git and every program launcher (the pure half of `src/tools/command-reach.ts`).
- `config-contracts.ts` — the config schema contracts: types and validation for the configuration document.
- `verification-paths.ts` — the verification-paths module.
- `web-performance-budgets.ts` — THE WEB-UI PERFORMANCE BUDGETS, ONE LIST (a module of its own: the root policy's literal holds only imports before it, so its static reading stays whole — S1's freeze boundary): each budget's name in the config section `webUi.performance` with the kind of…

## Where it lives

The folder lives at `engine/src/kernel/`.
