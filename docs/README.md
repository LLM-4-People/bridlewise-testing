---
title: "Documentation map"
description: "Every documentation collection in the repository, with what each one covers."
---

# Documentation

This is the curated documentation set of the Bridlewise development floor. It is published as a record, not as a stable specification.

> [!WARNING]
> Bridlewise is a developer preview. It is not production-ready and must not be used with sensitive, proprietary, regulated, or production codebases.

## Start here

| Document | What it covers |
|---|---|
| [../README.md](../README.md) | What this repository is, the fresh-clone gate, and the full-suite prerequisites |
| [testing.md](testing.md) | The test map, commands, prerequisites, and how to add a test |
| [cli.md](cli.md) | The CLI, dev lifecycle, ledger inspection, database keys, and guardian |
| [extending.md](extending.md) | Blocks, tools, providers, MCP, embedding, and quality packs |
| [shipping.md](shipping.md) | Build outputs, verification, release assets, and rollback |

## Records

| Collection | Contents |
|---|---|
| [decisions/](decisions/) | The decision records, one file per rule, with status and implementation state (the index is generated) |
| [floor/](floor/) | The generated development-floor site: atlas, status, promotion contract, and evidence |
| [design/](design/) | Selected cockpit, performance, structure, and guard-universe essays |
| [Product architecture](architecture.md) | The public architecture page |

Some records are historical. They may name the private development branches (`testing`, `master`), files that are not in the public snapshot, or measurements taken on a different machine. They are published as evidence of the reasoning, not as a description of the public release topology.

## Maintaining published pages

Write page links relative to their source files, as they resolve on GitHub. Navigation names the same source files through `page` keys. The [publish plan](../scripts/floor/site-pages.mjs) resolves navigation before Jekyll and resolves actual page links after it renders. The finalizer refuses missing pages, URL collisions and literal page URLs. Assets can retain their build-relative paths.

The [route declaration](_data/page-routes.json) names the live pages and the documentation home. The repository identity supplies the documentation prefix. Release snapshots contain documentation and assets; links to live pages continue to the current site. The versions index and JSON live under the documentation prefix's `v` directory. A source `docs/v` directory is reserved for these generated outputs.

Before a placement change, capture the previous plan with `node scripts/build-site.mjs capture-urls`. The command creates a new history file and refuses to overwrite an existing one. Preserve the [captured history](_data/site-url-history.json): one generated map supplies the legacy aliases and repository redirect targets. Removing or hiding a recorded page refuses publication until its source identity is reconciled; silently dropping old URLs is not supported.

Build into a new output directory. The builder refuses existing output and source-input directories so a build cannot delete previous results or authored work. After Jekyll renders, the finish step verifies the generated source-ID projection, resolves real link attributes, and crawls the complete site, including release snapshots, and checks each page's declared policies. A missing live destination therefore fails even when its link comes from a snapshot.

## What is not here

- The private trackers, working session state, and round history.
- The private evidence corpus and frozen records.
- The internal process manuals and agent operating instructions.
- A hosted demo or a stable API reference.
