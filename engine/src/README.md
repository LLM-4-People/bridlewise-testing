# Engine source

The harness engine's source root: the CLI entry points, the public API
barrel, the generated architecture manifest, and the domain folders. Every
domain is documented by its own README; the consumer lists are generated
from the import graph.

## What each file does

- `cli.ts` — the engine CLI entry point: preflight, harness, quality, and
  chat commands, plus the self-protection bootstrap that re-execs under the
  Landlock guardian in production mode.
- `cli.mjs` — the bash-friendly long-task-runner CLI: start, check, status,
  kill, list, and probe for tasks running as transient systemd user units.
- `index.ts` — the public API barrel: the key factory functions and their
  option/result types, so the harness can be embedded as a library.
- `bundle-entry.ts` — the bundle entry point for the Landlock
  self-protection production payload (`dist/bundle.js`).
- `architecture-manifest.ts` — the architecture manifest: its policies,
  layers, external commands and findings, with the modules built from
  `architecture-modules.ts`. Nothing in it is generated.
- `architecture-modules.ts` — the authored module entries, one per line,
  sorted by path (realm, layer, owner, roles, effects, ports): two branches
  touching different modules merge. A module's exports and imports are
  derived by the architecture check, never committed (#221); `harness sync`
  adds, removes and marks entries (`workflow/module-registrar.ts`).

## The domains

- `kernel/` — the trusted kernel: typed errors, integrity and hashing, the
  root policy, and the contracts every other domain builds on.
- `agents/` — agent types, the agent runtime, and the orchestrator.
- `awareness/` — the codebase-awareness engine: language adapters and the
  signal library.
- `editor/` — the transactional editor and edit tools.
- `evaluation/` — scenario matrices, execution, and results.
- `extensions/` — the extension lifecycle, manifests, and validation.
- `filesystem/` — durable filesystem operations, path boundaries, and the
  repository-root capability.
- `forensics/` — offline forensic contracts and cryptographic primitives.
- `git/` — git operations behind the single runner.
- `intelligence/` — code intelligence: search, repository maps, dependency
  graphs.
- `mcp/` — the Model Context Protocol client and its transports.
- `memory/` — the memory subsystems: the unified store and the scale store.
- `modules/` — the layered feature modules (effect-boundary, tasks-agents).
- `performance/` — the performance module and benchmarks.
- `privacy/` — the redaction engine and PII classification.
- `process/` — process lifecycle primitives.
- `quality/` — the multi-language quality pack: parsers, checks, signals,
  scoring.
- `quality-packs/` — the quality-pack CLI and the prevention detectors.
- `repository-path/` — repository path policy.
- `runtime/` — the runtime event state and interactive session.
- `safety/` — the safety layer: bias, hallucination, and pause/ask gates.
- `self-improving/` — the self-improvement loops.
- `shared/` — the agnostic helpers every engine domain consumes, owned once.
- `text/` — text processing primitives.
- `timeline/` — the durable audit timeline ledger.
- `tools/` — the tool registry, adapters, and concurrent dispatch.
- `workflow/` — the harness commands: register, regenerate, check, sync.

## Where it lives

The folder lives at `engine/src/`.
